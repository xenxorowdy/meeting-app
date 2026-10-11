use crate::{audio::rms, dsp};
use std::{collections::VecDeque, sync::OnceLock};

const BUCKET_MS: i64 = 20;
const HISTORY_MS: i64 = 12_000;
const MAX_DELAY_MS: i64 = 600;
const REFERENCE_LAG_MS: i64 = 300;
const MIN_OVERLAP_BUCKETS: usize = 15;
const CORRELATION: f32 = 0.7;
const LOUDER_THAN_SOURCE: f32 = 2.5;
const RESYNC_MS: i64 = 200;
const DUPLICATE_WINDOW_MS: i64 = 10_000;
const DUPLICATE_SHARE: f64 = 0.7;
const MIN_TOKENS: usize = 3;
const PAIR_SHARE: f64 = 0.6;
const MIN_PAIRS: usize = 3;

const GATE_MS: i64 = 400;
const CONTEXT_MS: i64 = 1_200;
const MAX_HOLD_MS: i64 = 800;

fn debugging() -> bool {
    static DEBUG: OnceLock<bool> = OnceLock::new();
    *DEBUG.get_or_init(|| {
        crate::env_compat::var("KESAMI_ECHO_DEBUG").is_ok_and(|value| !matches!(value.trim(), "" | "0" | "false" | "off"))
    })
}

fn bucket_bytes() -> usize {
    (dsp::SAMPLE_RATE as i64 / 1000 * BUCKET_MS) as usize * 2
}

fn gate_bytes() -> usize {
    (dsp::SAMPLE_RATE as i64 / 1000 * GATE_MS) as usize * 2
}

fn context_bytes() -> usize {
    (dsp::SAMPLE_RATE as i64 / 1000 * CONTEXT_MS) as usize * 2
}

fn alignments() -> impl Iterator<Item = i64> {
    (0..=MAX_DELAY_MS / BUCKET_MS).chain(-(REFERENCE_LAG_MS / BUCKET_MS)..0)
}

fn span_ms(pcm: &[u8]) -> i64 {
    (pcm.len() as i64 / 2) * 1000 / dsp::SAMPLE_RATE as i64
}

fn pearson(left: &[f32], right: &[f32]) -> f32 {
    if left.len() != right.len() || left.len() < 2 {
        return 0.0;
    }
    let count = left.len() as f32;
    let left_mean = left.iter().sum::<f32>() / count;
    let right_mean = right.iter().sum::<f32>() / count;

    let mut covariance = 0.0f32;
    let mut left_variance = 0.0f32;
    let mut right_variance = 0.0f32;
    for (a, b) in left.iter().zip(right) {
        let a = a - left_mean;
        let b = b - right_mean;
        covariance += a * b;
        left_variance += a * a;
        right_variance += b * b;
    }

    let spread = (left_variance * right_variance).sqrt();
    if spread <= f32::EPSILON {
        return 0.0;
    }
    (covariance / spread).clamp(-1.0, 1.0)
}

fn level_of(envelope: &[f32]) -> f32 {
    if envelope.is_empty() {
        return 0.0;
    }
    (envelope.iter().map(|value| value * value).sum::<f32>() / envelope.len() as f32).sqrt()
}

fn tokens(text: &str) -> Vec<String> {
    text.split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn pairs(tokens: &[String]) -> std::collections::HashSet<(&str, &str)> {
    tokens
        .windows(2)
        .map(|pair| (pair[0].as_str(), pair[1].as_str()))
        .collect()
}

fn jaccard(left: &[String], right: &[String]) -> f64 {
    let left: std::collections::HashSet<&String> = left.iter().collect();
    let right: std::collections::HashSet<&String> = right.iter().collect();
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let shared = left.intersection(&right).count() as f64;
    let union = (left.len() + right.len()) as f64 - shared;
    if union <= 0.0 {
        return 0.0;
    }
    shared / union
}

#[derive(Default)]
pub struct EchoWindow {
    origin_ms: i64,
    next_ms: i64,
    envelope: Vec<f32>,
    residual: Vec<u8>,
    playing: bool,
    spoken: Vec<(i64, Vec<String>)>,
    partials: Vec<(i64, Vec<String>)>,
    pending: Vec<u8>,
    pending_ms: i64,
    heard_ms: i64,
    queued: VecDeque<(i64, Vec<u8>)>,
    context: Vec<u8>,
    bleeding: bool,
}

impl EchoWindow {
    pub fn append_played(&mut self, start_ms: i64, pcm: &[u8]) {
        let gap_ms = start_ms - self.next_ms;
        if !self.playing || gap_ms < -RESYNC_MS || gap_ms > HISTORY_MS {
            self.origin_ms = start_ms;
            self.next_ms = start_ms;
            self.envelope.clear();
            self.residual.clear();
            self.playing = true;
        } else if gap_ms > RESYNC_MS {
            let silence = (gap_ms * dsp::SAMPLE_RATE as i64 / 1000) as usize * 2;
            self.residual.resize(self.residual.len() + silence, 0);
        }

        self.residual.extend_from_slice(pcm);
        self.next_ms = start_ms + (pcm.len() as i64 / 2) * 1000 / dsp::SAMPLE_RATE as i64;
        while self.residual.len() >= bucket_bytes() {
            let bucket: Vec<u8> = self.residual.drain(..bucket_bytes()).collect();
            self.envelope.push(rms(&bucket));
        }

        let cutoff = self.next_ms - HISTORY_MS;
        if cutoff > self.origin_ms {
            let stale = (((cutoff - self.origin_ms) / BUCKET_MS) as usize).min(self.envelope.len());
            self.envelope.drain(..stale);
            self.origin_ms += stale as i64 * BUCKET_MS;
        }
    }

    pub fn gate_microphone(&mut self, at_ms: i64, pcm: &[u8]) -> Vec<Vec<u8>> {
        if self.pending.is_empty() {
            self.pending_ms = at_ms;
        }
        self.pending.extend_from_slice(pcm);
        self.heard_ms = at_ms + span_ms(pcm);

        while self.pending.len() >= gate_bytes() {
            let window: Vec<u8> = self.pending.drain(..gate_bytes()).collect();
            self.queued.push_back((self.pending_ms, window));
            self.pending_ms += GATE_MS;
        }
        self.release_microphone()
    }

    pub fn release_microphone(&mut self) -> Vec<Vec<u8>> {
        let mut released = Vec::new();
        while let Some(&(window_ms, _)) = self.queued.front() {
            let ends_ms = window_ms + GATE_MS;
            let covered = !self.playing || self.next_ms >= ends_ms + REFERENCE_LAG_MS;
            let overdue = self.heard_ms >= ends_ms + MAX_HOLD_MS;
            if !covered && !overdue {
                break;
            }
            if let Some((window_ms, window)) = self.queued.pop_front() {
                released.push(self.judge(window_ms, window));
            }
        }
        released
    }

    fn judge(&mut self, window_ms: i64, window: Vec<u8>) -> Vec<u8> {
        self.context.extend_from_slice(&window);
        if self.context.len() > context_bytes() {
            let stale = self.context.len() - context_bytes();
            self.context.drain(..stale);
        }

        self.bleeding = self.bleeds(window_ms, &window);
        if self.bleeding {
            vec![0u8; window.len()]
        } else {
            window
        }
    }

    fn bleeds(&self, window_ms: i64, window: &[u8]) -> bool {
        if !self.playing || self.context.len() < context_bytes() {
            return false;
        }
        let context_ms = window_ms + GATE_MS - span_ms(&self.context);
        let context = dsp::envelope(&self.context, BUCKET_MS as usize, dsp::SAMPLE_RATE);
        let heard = dsp::envelope(window, BUCKET_MS as usize, dsp::SAMPLE_RATE);
        if heard.len() < MIN_OVERLAP_BUCKETS {
            return false;
        }
        let context_level = rms(&self.context);
        let level = rms(window);

        let bleeds = alignments().any(|steps| {
            self.matches_at(window_ms, &heard, level, steps)
                && self.matches_at(context_ms, &context, context_level, steps)
        });
        if debugging() {
            self.report(window_ms, &heard, level, context_ms, &context, bleeds);
        }
        bleeds
    }

    fn report(&self, window_ms: i64, heard: &[f32], level: f32, context_ms: i64, context: &[f32], bleeds: bool) {
        let best = alignments()
            .filter_map(|steps| {
                let (correlation, played) = self.compare_at(window_ms, heard, steps)?;
                Some((steps, correlation, played))
            })
            .max_by(|left, right| left.1.total_cmp(&right.1));
        match best {
            Some((steps, correlation, played)) => {
                let context_correlation = self
                    .compare_at(context_ms, context, steps)
                    .map_or(f32::NAN, |(correlation, _)| correlation);
                let ratio = if played > f32::EPSILON { level / played } else { f32::INFINITY };
                eprintln!(
                    "[Kesami Core Backend] echo gate {window_ms} ms: lag {} ms, window r {correlation:.2}, context r {context_correlation:.2}, level {ratio:.2}x, reference to {} ms, {}",
                    steps * BUCKET_MS,
                    self.next_ms,
                    if bleeds { "silenced" } else { "passed" }
                );
            }
            None => eprintln!(
                "[Kesami Core Backend] echo gate {window_ms} ms: no reference overlap (reference {}..{} ms), passed",
                self.origin_ms, self.next_ms
            ),
        }
    }

    fn drain_queued(&mut self) -> (Vec<u8>, usize) {
        let mut passed = Vec::new();
        let mut kept = 0;
        while let Some((window_ms, window)) = self.queued.pop_front() {
            passed.extend(self.judge(window_ms, window));
            if !self.bleeding {
                kept = passed.len();
            }
        }
        (passed, kept)
    }

    pub fn drain_microphone(&mut self) -> Vec<u8> {
        let (mut passed, _) = self.drain_queued();
        let tail = std::mem::take(&mut self.pending);
        if self.bleeding {
            passed.resize(passed.len() + tail.len(), 0);
        } else {
            passed.extend(tail);
        }
        self.context.clear();
        self.bleeding = false;
        passed
    }

    pub fn flush_microphone(&mut self) -> Vec<u8> {
        let (mut passed, mut kept) = self.drain_queued();
        let tail = std::mem::take(&mut self.pending);
        if !self.bleeding {
            passed.extend(tail);
            kept = passed.len();
        }
        passed.truncate(kept);
        passed
    }

    pub fn remember_text(&mut self, at_ms: i64, text: &str) {
        let tokens = tokens(text);
        if !tokens.is_empty() {
            self.spoken.push((at_ms, tokens));
        }
        self.forget_before(at_ms - HISTORY_MS);
    }

    fn forget_before(&mut self, cutoff_ms: i64) {
        self.spoken.retain(|(said_at_ms, _)| *said_at_ms >= cutoff_ms);
        self.partials.retain(|(said_at_ms, _)| *said_at_ms >= cutoff_ms);
    }

    fn compare_at(&self, start_ms: i64, heard: &[f32], steps: i64) -> Option<(f32, f32)> {
        let shift = (start_ms - steps * BUCKET_MS - self.origin_ms) / BUCKET_MS;
        let (heard_from, played_from) = if shift >= 0 {
            (0usize, shift as usize)
        } else {
            ((-shift) as usize, 0usize)
        };
        if heard_from >= heard.len() || played_from >= self.envelope.len() {
            return None;
        }

        let span = (heard.len() - heard_from).min(self.envelope.len() - played_from);
        if span < MIN_OVERLAP_BUCKETS {
            return None;
        }
        let heard = &heard[heard_from..heard_from + span];
        let played = &self.envelope[played_from..played_from + span];
        Some((pearson(heard, played), level_of(played)))
    }

    fn matches_at(&self, start_ms: i64, heard: &[f32], level: f32, steps: i64) -> bool {
        self.compare_at(start_ms, heard, steps)
            .is_some_and(|(correlation, played)| level <= played * LOUDER_THAN_SOURCE && correlation >= CORRELATION)
    }

    pub fn is_echo(&self, start_ms: i64, pcm: &[u8]) -> bool {
        let heard = dsp::envelope(pcm, BUCKET_MS as usize, dsp::SAMPLE_RATE);
        if !self.playing || heard.len() < MIN_OVERLAP_BUCKETS {
            return false;
        }
        let level = rms(pcm);

        alignments().any(|steps| self.matches_at(start_ms, &heard, level, steps))
    }

    pub fn remember_partial(&mut self, at_ms: i64, text: &str) {
        let tokens = tokens(text);
        if !tokens.is_empty() {
            self.partials.push((at_ms, tokens));
        }
        self.forget_before(at_ms - HISTORY_MS);
    }

    pub fn repeats_meeting_audio(&self, at_ms: i64, text: &str) -> bool {
        let heard = tokens(text);
        if heard.len() < MIN_TOKENS {
            return false;
        }
        let recent: Vec<&Vec<String>> = self
            .spoken
            .iter()
            .chain(self.partials.iter())
            .filter(|(said_at_ms, _)| (at_ms - said_at_ms).abs() <= DUPLICATE_WINDOW_MS)
            .map(|(_, said)| said)
            .collect();
        if recent
            .iter()
            .any(|said| said.len() >= MIN_TOKENS && jaccard(&heard, said) >= DUPLICATE_SHARE)
        {
            return true;
        }

        let heard_pairs = pairs(&heard);
        if heard_pairs.len() < MIN_PAIRS {
            return false;
        }
        let said_pairs: std::collections::HashSet<(&str, &str)> =
            recent.iter().flat_map(|said| pairs(said)).collect();
        let shared = heard_pairs.intersection(&said_pairs).count();
        shared as f64 >= heard_pairs.len() as f64 * PAIR_SHARE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(samples: &[f32]) -> Vec<u8> {
        dsp::pcm_from_samples(samples)
    }

    fn sentence(ms: usize, seed: u64, amplitude: f32) -> Vec<f32> {
        let mut state = seed | 1;
        let mut syllable = 0.0f32;
        (0..(16 * ms))
            .map(|index| {
                if index % 1_600 == 0 {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    syllable = 0.3 + (state >> 40) as f32 / 16_777_216.0;
                }
                let time = index as f32 / 16_000.0;
                let wave = (2.0 * std::f32::consts::PI * 160.0 * time).sin() * 0.7
                    + (2.0 * std::f32::consts::PI * 480.0 * time).sin() * 0.3;
                wave * syllable * amplitude
            })
            .collect()
    }

    fn silence(ms: usize) -> Vec<f32> {
        vec![0.0; 16 * ms]
    }

    fn delayed(samples: &[f32], delay_ms: usize, attenuation: f32) -> Vec<f32> {
        let mut out = silence(delay_ms);
        out.extend(samples.iter().map(|value| value * attenuation));
        out
    }

    fn gated(window: &mut EchoWindow, pcm: &[u8]) -> Vec<u8> {
        let mut passed = Vec::new();
        let mut at_ms = 0;
        for block in pcm.chunks(256) {
            for gate in window.gate_microphone(at_ms, block) {
                passed.extend_from_slice(&gate);
            }
            at_ms += span_ms(block);
        }
        passed
    }

    fn ms_bytes(ms: i64) -> usize {
        (dsp::SAMPLE_RATE as i64 / 1000 * ms) as usize * 2
    }

    fn lockstep(window: &mut EchoWindow, played: &[u8], heard: &[u8]) -> Vec<u8> {
        let step = ms_bytes(BUCKET_MS);
        let slice = |pcm: &[u8], index: usize| pcm[(index * step).min(pcm.len())..((index + 1) * step).min(pcm.len())].to_vec();
        let mut passed = Vec::new();
        for index in 0..heard.len().max(played.len()).div_ceil(step) {
            let at_ms = index as i64 * BUCKET_MS;
            let reference = slice(played, index);
            if !reference.is_empty() {
                window.append_played(at_ms, &reference);
                for gate in window.release_microphone() {
                    passed.extend(gate);
                }
            }
            let microphone = slice(heard, index);
            if !microphone.is_empty() {
                for gate in window.gate_microphone(at_ms, &microphone) {
                    passed.extend(gate);
                }
            }
        }
        passed
    }

    fn warmup_bytes() -> usize {
        context_bytes() - gate_bytes()
    }

    fn playing(start_ms: i64, samples: &[f32]) -> EchoWindow {
        let mut window = EchoWindow::default();
        window.append_played(start_ms, &encode(samples));
        window
    }

    #[test]
    fn meeting_audio_coming_back_through_the_microphone_is_recognised() {
        let played = sentence(2_000, 7, 0.5);
        let window = playing(10_000, &played);

        assert!(window.is_echo(10_000, &encode(&delayed(&played, 120, 0.3))));
    }

    #[test]
    fn a_speaker_feed_timestamped_later_than_the_microphone_still_matches() {
        let played = sentence(2_000, 7, 0.5);
        let window = playing(10_106, &played);

        assert!(window.is_echo(10_000, &encode(&delayed(&played, 0, 0.3))));
    }

    #[test]
    fn a_speaker_feed_lagging_further_than_the_search_is_not_forced_to_match() {
        let played = sentence(2_000, 7, 0.5);
        let window = playing(11_000, &played);

        assert!(!window.is_echo(10_000, &encode(&delayed(&played, 0, 0.3))));
    }

    #[test]
    fn the_user_talking_while_the_speaker_feed_lags_is_still_left_alone() {
        let window = playing(10_106, &sentence(2_000, 7, 0.5));

        assert!(!window.is_echo(10_000, &encode(&sentence(2_000, 991, 0.4))));
    }

    #[test]
    fn live_bleed_is_silenced_even_when_the_speaker_feed_lags() {
        let played = sentence(12_000, 7, 0.5);
        let mut window = playing(106, &played);
        let heard = encode(&delayed(&played, 0, 0.3));

        let passed = gated(&mut window, &heard);

        assert!(rms(&passed[warmup_bytes()..]) < rms(&heard) * 0.05);
    }

    #[test]
    fn the_user_answering_over_the_same_audio_is_left_alone() {
        let window = playing(10_000, &sentence(2_000, 7, 0.5));

        assert!(!window.is_echo(10_000, &encode(&sentence(2_000, 991, 0.4))));
    }

    #[test]
    fn speaking_loudly_over_quiet_playback_is_never_treated_as_bleed() {
        let played = sentence(2_000, 7, 0.05);
        let window = playing(10_000, &played);

        assert!(!window.is_echo(10_000, &encode(&delayed(&played, 120, 8.0))));
    }

    #[test]
    fn playback_from_a_different_part_of_the_meeting_is_not_matched() {
        let played = sentence(2_000, 7, 0.5);
        let window = playing(0, &played);

        assert!(!window.is_echo(60_000, &encode(&delayed(&played, 120, 0.3))));
    }

    #[test]
    fn a_stream_that_stopped_and_came_back_restarts_its_timeline() {
        let played = sentence(2_000, 7, 0.5);
        let mut window = playing(0, &played);
        window.append_played(90_000, &encode(&played));

        assert!(!window.is_echo(120, &encode(&delayed(&played, 120, 0.3))));
        assert!(window.is_echo(90_000, &encode(&delayed(&played, 120, 0.3))));
    }

    #[test]
    fn a_silent_microphone_and_silent_playback_never_correlate() {
        let window = playing(0, &silence(3_000));

        assert!(!window.is_echo(0, &encode(&silence(3_000))));
    }

    #[test]
    fn live_microphone_bleed_is_silenced_before_it_reaches_the_recogniser() {
        let played = sentence(12_000, 7, 0.5);
        let mut window = playing(0, &played);
        let heard = encode(&delayed(&played, 120, 0.3));

        let passed = gated(&mut window, &heard);

        assert!(rms(&passed[warmup_bytes()..]) < rms(&heard) * 0.05);
    }

    #[test]
    fn the_user_speaking_over_the_meeting_still_reaches_the_recogniser() {
        let mut window = playing(0, &sentence(12_000, 7, 0.5));
        let mine = encode(&sentence(12_000, 991, 0.4));

        let mut passed = gated(&mut window, &mine);
        passed.extend(window.flush_microphone());

        assert_eq!(passed, mine);
    }

    #[test]
    fn the_user_answering_once_the_bleed_stops_is_not_clipped() {
        let played = sentence(12_000, 7, 0.5);
        let mut window = playing(0, &played);
        let mut heard = delayed(&played[..16 * 6_000], 120, 0.3);
        heard.extend(sentence(6_000, 991, 0.4));
        let heard = encode(&heard);

        let passed = gated(&mut window, &heard);

        let answer = 16 * 6_000 * 2;
        assert_eq!(&passed[answer..], &heard[answer..passed.len()]);
    }

    #[test]
    fn a_microphone_that_never_filled_a_window_is_handed_over_on_flush() {
        let mut window = EchoWindow::default();
        let mine = encode(&sentence(100, 991, 0.4));

        assert!(window.gate_microphone(0, &mine).is_empty());
        assert_eq!(window.flush_microphone(), mine);
        assert!(window.flush_microphone().is_empty());
    }

    #[test]
    fn a_tail_left_over_from_bleed_is_not_handed_over_on_flush() {
        let played = sentence(12_000, 7, 0.5);
        let mut window = playing(0, &played);
        let heard = encode(&delayed(&played, 120, 0.3));

        gated(&mut window, &heard[..heard.len() - 4_000]);

        assert!(window.flush_microphone().is_empty());
    }

    #[test]
    fn a_microphone_turn_repeating_the_meetings_interim_text_is_a_duplicate() {
        let mut window = EchoWindow::default();
        window.remember_partial(30_000, "Let us ship the release on Friday");

        assert!(window.repeats_meeting_audio(30_400, "let us ship the release on friday"));
        assert!(!window.repeats_meeting_audio(30_400, "Friday works for me"));
        assert!(!window.repeats_meeting_audio(60_000, "let us ship the release on friday"));
    }

    #[test]
    fn a_microphone_turn_repeating_what_the_room_just_heard_is_a_duplicate() {
        let mut window = EchoWindow::default();
        window.remember_text(30_000, "Let us ship the release on Friday");

        assert!(window.repeats_meeting_audio(30_400, "let us ship the release on friday"));
        assert!(!window.repeats_meeting_audio(30_400, "Friday works for me"));
        assert!(!window.repeats_meeting_audio(60_000, "Let us ship the release on Friday"));
        assert!(!window.repeats_meeting_audio(30_400, "Sure"));
    }

    #[test]
    fn bleed_is_held_until_a_late_speaker_feed_catches_up() {
        for lag_ms in [106, 250] {
            let played = sentence(12_000, 7, 0.5);
            let mut window = EchoWindow::default();
            let reference = encode(&delayed(&played, lag_ms, 1.0));
            let heard = encode(&delayed(&played, 0, 0.3));

            let passed = lockstep(&mut window, &reference, &heard);

            assert!(passed.len() > warmup_bytes() + ms_bytes(8_000), "lag {lag_ms} ms released too little");
            assert!(
                rms(&passed[warmup_bytes()..]) < rms(&heard) * 0.05,
                "lag {lag_ms} ms let bleed through"
            );
        }
    }

    #[test]
    fn the_user_is_not_held_back_once_the_speaker_feed_stalls() {
        let mut window = playing(0, &sentence(2_000, 7, 0.5));
        let mine = encode(&sentence(5_000, 991, 0.4));

        let passed = gated(&mut window, &mine);

        assert!(passed.len() >= ms_bytes(5_000 - GATE_MS - MAX_HOLD_MS));
        assert_eq!(passed.as_slice(), &mine[..passed.len()]);
    }

    #[test]
    fn a_microphone_gap_hands_over_held_audio_and_gates_bleed_after_it() {
        let played = sentence(12_000, 7, 0.5);
        let mut window = playing(0, &played);
        let mine = encode(&sentence(1_000, 991, 0.4));

        let mut before = gated(&mut window, &mine);
        before.extend(window.drain_microphone());
        assert_eq!(before, mine);

        let resumed_ms = 5_000;
        let bleed = encode(&delayed(&played[16 * resumed_ms..], 0, 0.3));
        let mut after = Vec::new();
        let mut at_ms = resumed_ms as i64;
        for block in bleed.chunks(256) {
            for gate in window.gate_microphone(at_ms, block) {
                after.extend(gate);
            }
            at_ms += span_ms(block);
        }

        assert!(after.len() > warmup_bytes() + ms_bytes(4_000));
        assert!(rms(&after[warmup_bytes()..]) < rms(&bleed) * 0.05);
    }

    #[test]
    fn a_short_pause_in_the_speaker_feed_keeps_its_history() {
        let first = sentence(2_000, 7, 0.5);
        let second = sentence(2_000, 13, 0.5);
        let mut window = playing(0, &first);
        window.append_played(5_000, &encode(&second));

        assert!(window.is_echo(0, &encode(&delayed(&first, 120, 0.3))));
        assert!(window.is_echo(5_000, &encode(&delayed(&second, 120, 0.3))));
    }

    #[test]
    fn a_microphone_fragment_of_a_longer_meeting_sentence_is_a_duplicate() {
        let mut window = EchoWindow::default();
        window.remember_text(30_000, "We should move the launch to next Friday because the vendor is late");

        assert!(window.repeats_meeting_audio(31_000, "move the launch to next Friday"));
    }

    #[test]
    fn a_reply_reusing_some_of_the_meetings_words_is_kept() {
        let mut window = EchoWindow::default();
        window.remember_text(30_000, "Can you send the report by Friday");

        assert!(!window.repeats_meeting_audio(31_000, "Yes I will send the report by Friday"));
        assert!(!window.repeats_meeting_audio(31_000, "Friday is fine and the report is nearly done"));
    }

    #[test]
    fn every_meeting_interim_in_the_window_is_consulted() {
        let mut window = EchoWindow::default();
        window.remember_partial(30_000, "We should move the launch");
        window.remember_partial(30_500, "Something else entirely now");

        assert!(window.repeats_meeting_audio(31_000, "we should move the launch"));
    }

    #[test]
    fn text_older_than_the_window_stops_being_consulted() {
        let mut window = EchoWindow::default();
        window.remember_text(0, "Let us ship the release on Friday");
        window.remember_text(40_000, "Anything else before we close");

        assert!(!window.repeats_meeting_audio(200, "let us ship the release on friday"));
    }
}
