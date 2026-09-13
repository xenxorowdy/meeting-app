use crate::dsp::{self, Fft, MelBank, BINS, FRAME_LEN, HOP_LEN, SAMPLE_RATE};

const MEL_BANDS: usize = 26;
const CEPSTRA: usize = 13;
const TIMBRE_DIMS: usize = CEPSTRA - 1;
const TIMBRE_SCALE: f32 = 4.0;
const HOP_MS: i64 = (HOP_LEN * 1000 / SAMPLE_RATE as usize) as i64;
const VOICED_FRACTION: f32 = 0.35;
const SILENCE_ENERGY: f32 = 1e-6;
const PITCH_WINDOW: usize = 1024;
const PITCH_SAMPLES: usize = 24;
const PITCH_WEIGHT: f32 = 4.0;
const MIN_VOICED_MS: i64 = 400;
const MIN_NEW_SPEAKER_MS: i64 = 1_500;
const CONTINUITY_MS: i64 = 1_500;
const CONTINUITY_MARGIN: f32 = 0.15;
const MAX_SPEAKERS: usize = 8;
const MATCH_SLACK_MS: i64 = 400;
const MIN_SHARE: f64 = 0.5;

fn split_threshold() -> f32 {
    std::env::var("CORE_BACKEND_VOICE_SPLIT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1.15)
}

#[derive(Clone, Debug)]
pub struct Voiceprint {
    timbre: Vec<f32>,
    log_pitch: Option<f32>,
    pub voiced_ms: i64,
}

struct Analyzer {
    fft: Fft,
    window: Vec<f32>,
    mel: MelBank,
}

impl Analyzer {
    fn new() -> Self {
        Self {
            fft: Fft::new(FRAME_LEN),
            window: dsp::sqrt_hann(FRAME_LEN),
            mel: MelBank::new(MEL_BANDS, BINS, SAMPLE_RATE, 60.0, 7_600.0),
        }
    }

    fn cepstra(&self, samples: &[f32]) -> Vec<(f32, Vec<f32>)> {
        let mut re = vec![0.0; FRAME_LEN];
        let mut im = vec![0.0; FRAME_LEN];
        let mut power = vec![0.0; BINS];
        let mut frames = Vec::new();

        let mut offset = 0;
        while offset + FRAME_LEN <= samples.len() {
            let frame = &samples[offset..offset + FRAME_LEN];
            let energy = frame.iter().map(|value| value * value).sum::<f32>() / FRAME_LEN as f32;
            for index in 0..FRAME_LEN {
                re[index] = frame[index] * self.window[index];
                im[index] = 0.0;
            }
            self.fft.forward(&mut re, &mut im);
            dsp::power_spectrum(&re, &im, &mut power);
            let coefficients = dsp::dct2(&self.mel.log_energies(&power), CEPSTRA);
            frames.push((energy, coefficients[1..].to_vec()));
            offset += HOP_LEN;
        }
        frames
    }
}

fn median_log_pitch(samples: &[f32]) -> Option<f32> {
    if samples.len() < PITCH_WINDOW {
        return None;
    }
    let wanted = (samples.len() / PITCH_WINDOW).clamp(1, PITCH_SAMPLES);
    let stride = (samples.len() / wanted).max(PITCH_WINDOW);

    let mut detected: Vec<f32> = Vec::new();
    let mut offset = 0;
    while offset + PITCH_WINDOW <= samples.len() && detected.len() < PITCH_SAMPLES {
        let decimated: Vec<f32> = samples[offset..offset + PITCH_WINDOW]
            .chunks_exact(2)
            .map(|pair| (pair[0] + pair[1]) * 0.5)
            .collect();
        if let Some(hertz) = dsp::pitch_hz(&decimated, SAMPLE_RATE / 2) {
            detected.push(hertz.ln());
        }
        offset += stride;
    }

    if detected.len() < 3 {
        return None;
    }
    detected.sort_by(f32::total_cmp);
    Some(detected[detected.len() / 2])
}

impl Voiceprint {
    pub fn from_pcm(pcm: &[u8]) -> Option<Self> {
        let samples = dsp::samples_from_pcm(pcm);
        let frames = Analyzer::new().cepstra(&samples);
        if frames.is_empty() {
            return None;
        }

        let loudest = frames
            .iter()
            .map(|(energy, _)| *energy)
            .fold(0.0f32, f32::max);
        let floor = (loudest * VOICED_FRACTION * VOICED_FRACTION).max(SILENCE_ENERGY);
        let voiced: Vec<&Vec<f32>> = frames
            .iter()
            .filter(|(energy, _)| *energy >= floor)
            .map(|(_, coefficients)| coefficients)
            .collect();

        let voiced_ms = voiced.len() as i64 * HOP_MS;
        if voiced_ms < MIN_VOICED_MS {
            return None;
        }

        let mut timbre = vec![0.0f32; TIMBRE_DIMS];
        for coefficients in &voiced {
            for (slot, value) in timbre.iter_mut().zip(coefficients.iter()) {
                *slot += value;
            }
        }
        for slot in timbre.iter_mut() {
            *slot /= voiced.len() as f32;
        }

        Some(Self {
            timbre,
            log_pitch: median_log_pitch(&samples),
            voiced_ms,
        })
    }
}

struct Cluster {
    key: String,
    timbre: Vec<f32>,
    log_pitch: Option<f32>,
    weight: f32,
}

impl Cluster {
    fn distance(&self, print: &Voiceprint) -> f32 {
        let timbre = self
            .timbre
            .iter()
            .zip(&print.timbre)
            .map(|(mine, theirs)| {
                let delta = (mine - theirs) / TIMBRE_SCALE;
                delta * delta
            })
            .sum::<f32>()
            / TIMBRE_DIMS as f32;

        let pitch = match (self.log_pitch, print.log_pitch) {
            (Some(mine), Some(theirs)) => (mine - theirs).abs(),
            _ => 0.0,
        };

        timbre.sqrt() + PITCH_WEIGHT * pitch
    }

    fn absorb(&mut self, print: &Voiceprint) {
        let weight = print.voiced_ms as f32;
        let total = self.weight + weight;
        for (slot, value) in self.timbre.iter_mut().zip(&print.timbre) {
            *slot = (*slot * self.weight + value * weight) / total;
        }
        self.log_pitch = match (self.log_pitch, print.log_pitch) {
            (Some(mine), Some(theirs)) => Some((mine * self.weight + theirs * weight) / total),
            (None, theirs) => theirs,
            (mine, None) => mine,
        };
        self.weight = total;
    }
}

#[derive(Default)]
pub struct VoiceRoster {
    clusters: Vec<Cluster>,
    spans: Vec<(usize, i64, i64)>,
    last: Option<(usize, i64)>,
}

impl VoiceRoster {
    pub fn observe(&mut self, print: &Voiceprint, start_ms: i64, end_ms: i64) -> String {
        let mut ranked: Vec<(usize, f32)> = self
            .clusters
            .iter()
            .enumerate()
            .map(|(index, cluster)| (index, cluster.distance(print)))
            .collect();
        ranked.sort_by(|left, right| left.1.total_cmp(&right.1));

        let nearest = ranked.first().copied();
        let recent = self
            .last
            .filter(|(_, ended_ms)| start_ms - *ended_ms <= CONTINUITY_MS)
            .and_then(|(index, _)| {
                ranked
                    .iter()
                    .find(|(candidate, _)| *candidate == index)
                    .copied()
            });

        let closest = match (nearest, recent) {
            (Some((_, best)), Some((index, score))) if score - best <= CONTINUITY_MARGIN => {
                Some((index, score))
            }
            (nearest, _) => nearest,
        };
        let splittable =
            print.voiced_ms >= MIN_NEW_SPEAKER_MS && self.clusters.len() < MAX_SPEAKERS;
        let matched = closest.filter(|(_, score)| *score <= split_threshold());

        let index = match (matched, closest) {
            (Some((index, _)), _) => {
                self.clusters[index].absorb(print);
                index
            }
            (None, Some((index, _))) if !splittable => index,
            _ => {
                self.clusters.push(Cluster {
                    key: format!("voice-{}", self.clusters.len() + 1),
                    timbre: print.timbre.clone(),
                    log_pitch: print.log_pitch,
                    weight: print.voiced_ms as f32,
                });
                self.clusters.len() - 1
            }
        };

        self.spans.push((index, start_ms, end_ms));
        self.last = Some((index, end_ms));
        self.clusters[index].key.clone()
    }

    pub fn key_during(&self, start_ms: i64, end_ms: i64) -> Option<String> {
        let duration = (end_ms - start_ms).max(0);
        if duration == 0 {
            return None;
        }

        let mut totals: Vec<i64> = vec![0; self.clusters.len()];
        for (index, span_start, span_end) in &self.spans {
            let overlap = (end_ms.min(span_end + MATCH_SLACK_MS)
                - start_ms.max(span_start - MATCH_SLACK_MS))
            .max(0);
            totals[*index] += overlap.min(duration);
        }

        let (index, overlap) = totals
            .iter()
            .enumerate()
            .max_by_key(|(_, overlap)| **overlap)?;
        ((*overlap as f64 / duration as f64) >= MIN_SHARE).then(|| self.clusters[index].key.clone())
    }

    pub fn latest_key(&self) -> Option<String> {
        self.last.map(|(index, _)| self.clusters[index].key.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voice(ms: usize, fundamental: f32, formants: [f32; 3]) -> Vec<u8> {
        let harmonics = (7_000.0 / fundamental) as usize;
        let resonance = |frequency: f32| -> f32 {
            formants
                .iter()
                .map(|centre| {
                    let ratio = frequency / centre;
                    let real = 1.0 - ratio * ratio;
                    let imaginary = ratio / 8.0;
                    1.0 / (real * real + imaginary * imaginary).sqrt()
                })
                .sum::<f32>()
        };

        let samples: Vec<f32> = (0..(SAMPLE_RATE as usize / 1000 * ms))
            .map(|index| {
                let time = index as f32 / SAMPLE_RATE as f32;
                (1..=harmonics)
                    .map(|harmonic| {
                        let frequency = fundamental * harmonic as f32;
                        resonance(frequency) / harmonic as f32
                            * (2.0 * std::f32::consts::PI * frequency * time).sin()
                    })
                    .sum::<f32>()
            })
            .collect();

        let peak = samples
            .iter()
            .fold(0.0f32, |peak, value| peak.max(value.abs()));
        dsp::pcm_from_samples(
            &samples
                .iter()
                .map(|value| value / peak.max(f32::EPSILON) * 0.6)
                .collect::<Vec<_>>(),
        )
    }

    fn low() -> Vec<u8> {
        voice(3_000, 110.0, [520.0, 1_100.0, 2_400.0])
    }

    fn high() -> Vec<u8> {
        voice(3_000, 215.0, [780.0, 1_900.0, 3_100.0])
    }

    fn print_of(pcm: &[u8]) -> Voiceprint {
        Voiceprint::from_pcm(pcm).expect("a three second vowel is a usable voiceprint")
    }

    #[test]
    fn one_person_speaking_three_times_stays_one_numbered_speaker() {
        let mut roster = VoiceRoster::default();
        let spoken = low();
        let keys: Vec<String> = (0..3)
            .map(|turn| {
                let start = turn * 10_000;
                roster.observe(&print_of(&spoken), start, start + 3_000)
            })
            .collect();

        assert_eq!(keys, ["voice-1", "voice-1", "voice-1"]);
    }

    #[test]
    fn two_voices_are_numbered_apart_and_each_is_recognised_again() {
        let mut roster = VoiceRoster::default();
        assert_eq!(roster.observe(&print_of(&low()), 0, 3_000), "voice-1");
        assert_eq!(
            roster.observe(&print_of(&high()), 10_000, 13_000),
            "voice-2"
        );
        assert_eq!(roster.observe(&print_of(&low()), 20_000, 23_000), "voice-1");
        assert_eq!(
            roster.observe(&print_of(&high()), 30_000, 33_000),
            "voice-2"
        );
    }

    #[test]
    fn taking_the_turn_straight_after_someone_else_still_opens_a_new_speaker() {
        let mut roster = VoiceRoster::default();
        assert_eq!(roster.observe(&print_of(&low()), 0, 3_000), "voice-1");
        assert_eq!(roster.observe(&print_of(&high()), 3_200, 6_200), "voice-2");
        assert_eq!(roster.observe(&print_of(&low()), 6_400, 9_400), "voice-1");
    }

    #[test]
    fn a_brief_interjection_is_never_promoted_to_a_new_speaker() {
        let mut roster = VoiceRoster::default();
        roster.observe(&print_of(&low()), 0, 3_000);

        let brief = voice(700, 215.0, [780.0, 1_900.0, 3_100.0]);
        assert_eq!(roster.observe(&print_of(&brief), 10_000, 10_700), "voice-1");
    }

    #[test]
    fn a_forced_short_match_does_not_drag_the_cluster_it_was_parked_on() {
        let mut roster = VoiceRoster::default();
        assert_eq!(roster.observe(&print_of(&low()), 0, 3_000), "voice-1");

        let brief = voice(700, 215.0, [780.0, 1_900.0, 3_100.0]);
        for turn in 0..6 {
            let start = 10_000 + turn * 5_000;
            assert_eq!(
                roster.observe(&print_of(&brief), start, start + 700),
                "voice-1"
            );
        }

        assert_eq!(roster.observe(&print_of(&low()), 50_000, 53_000), "voice-1");
        assert_eq!(roster.observe(&print_of(&high()), 60_000, 63_000), "voice-2");
    }

    #[test]
    fn a_turn_takes_the_voice_that_covered_it_and_nothing_else() {
        let mut roster = VoiceRoster::default();
        roster.observe(&print_of(&low()), 0, 3_000);
        roster.observe(&print_of(&high()), 10_000, 13_000);

        assert_eq!(roster.key_during(0, 3_000).as_deref(), Some("voice-1"));
        assert_eq!(
            roster.key_during(10_100, 12_900).as_deref(),
            Some("voice-2")
        );
        assert_eq!(roster.key_during(40_000, 44_000), None);
        assert_eq!(roster.latest_key().as_deref(), Some("voice-2"));
    }

    #[test]
    fn near_silence_yields_no_voiceprint_at_all() {
        assert!(Voiceprint::from_pcm(&vec![0u8; 16_000 * 2]).is_none());
        assert!(Voiceprint::from_pcm(&[]).is_none());
    }
}
