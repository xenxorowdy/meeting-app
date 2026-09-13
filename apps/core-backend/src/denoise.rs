use crate::dsp::{self, Fft, BINS, FRAME_LEN, HOP_LEN};

const SUBWINDOW_FRAMES: usize = 94;
const WARMUP_FRAMES: usize = SUBWINDOW_FRAMES / 2;
const POWER_SMOOTHING: f32 = 0.7;
const NOISE_BIAS: f32 = 1.8;
const DECISION_DIRECTED: f32 = 0.96;
const GAIN_FLOOR: f32 = 0.1;

pub struct NoiseSuppressor {
    fft: Fft,
    window: Vec<f32>,
    pending: Vec<f32>,
    overlap: Vec<f32>,
    smoothed: Vec<f32>,
    short_minimum: Vec<f32>,
    previous_minimum: Vec<f32>,
    clean_power: Vec<f32>,
    frames: usize,
    re: Vec<f32>,
    im: Vec<f32>,
    power: Vec<f32>,
    gain: Vec<f32>,
}

impl Default for NoiseSuppressor {
    fn default() -> Self {
        Self::new()
    }
}

impl NoiseSuppressor {
    pub fn new() -> Self {
        Self {
            fft: Fft::new(FRAME_LEN),
            window: dsp::sqrt_hann(FRAME_LEN),
            pending: Vec::new(),
            overlap: vec![0.0; HOP_LEN],
            smoothed: vec![0.0; BINS],
            short_minimum: vec![f32::MAX; BINS],
            previous_minimum: vec![f32::MAX; BINS],
            clean_power: vec![0.0; BINS],
            frames: 0,
            re: vec![0.0; FRAME_LEN],
            im: vec![0.0; FRAME_LEN],
            power: vec![0.0; BINS],
            gain: vec![1.0; BINS],
        }
    }

    pub fn process(&mut self, pcm: &[u8]) -> Vec<u8> {
        self.pending.extend(dsp::samples_from_pcm(pcm));
        let mut output = Vec::with_capacity(self.pending.len());

        while self.pending.len() >= FRAME_LEN {
            for index in 0..FRAME_LEN {
                self.re[index] = self.pending[index] * self.window[index];
                self.im[index] = 0.0;
            }
            self.fft.forward(&mut self.re, &mut self.im);
            dsp::power_spectrum(&self.re, &self.im, &mut self.power);
            self.update_gain();

            for bin in 0..BINS {
                self.re[bin] *= self.gain[bin];
                self.im[bin] *= self.gain[bin];
                if bin > 0 && bin < BINS - 1 {
                    let mirror = FRAME_LEN - bin;
                    self.re[mirror] = self.re[bin];
                    self.im[mirror] = -self.im[bin];
                }
            }
            self.fft.inverse(&mut self.re, &mut self.im);

            for index in 0..HOP_LEN {
                output.push(self.overlap[index] + self.re[index] * self.window[index]);
            }
            for index in 0..HOP_LEN {
                self.overlap[index] = self.re[HOP_LEN + index] * self.window[HOP_LEN + index];
            }
            self.pending.drain(..HOP_LEN);
        }

        dsp::pcm_from_samples(&output)
    }

    fn update_gain(&mut self) {
        let boundary = self.frames > 0 && self.frames % SUBWINDOW_FRAMES == 0;
        self.frames += 1;

        for bin in 0..BINS {
            let power = self.power[bin];
            self.smoothed[bin] = if self.frames == 1 {
                power
            } else {
                POWER_SMOOTHING * self.smoothed[bin] + (1.0 - POWER_SMOOTHING) * power
            };

            if boundary {
                self.previous_minimum[bin] = self.short_minimum[bin];
                self.short_minimum[bin] = self.smoothed[bin];
            } else {
                self.short_minimum[bin] = self.short_minimum[bin].min(self.smoothed[bin]);
            }

            let noise =
                (self.short_minimum[bin].min(self.previous_minimum[bin]) * NOISE_BIAS).max(1e-12);
            let posterior = power / noise;
            let instant = (posterior - 1.0).max(0.0);
            let prior = DECISION_DIRECTED * (self.clean_power[bin] / noise)
                + (1.0 - DECISION_DIRECTED) * instant;
            let gain = (prior / (1.0 + prior)).max(GAIN_FLOOR);
            self.clean_power[bin] = gain * gain * power;
            self.gain[bin] = if self.frames <= WARMUP_FRAMES { 1.0 } else { gain };
        }

        let raw = self.gain.clone();
        for bin in 1..BINS - 1 {
            self.gain[bin] = 0.25 * raw[bin - 1] + 0.5 * raw[bin] + 0.25 * raw[bin + 1];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::rms;

    fn encode(samples: impl Iterator<Item = f32>) -> Vec<u8> {
        samples
            .flat_map(|sample| ((sample.clamp(-1.0, 1.0) * 32_767.0) as i16).to_le_bytes())
            .collect()
    }

    fn hiss(ms: usize, amplitude: f32) -> Vec<u8> {
        let mut state = 0x2545_f491_4f6c_dd1du64;
        encode((0..(16 * ms)).map(move |_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            ((state >> 40) as f32 / 8_388_608.0 - 1.0) * amplitude
        }))
    }

    fn speech(ms: usize, amplitude: f32) -> Vec<u8> {
        encode((0..(16 * ms)).map(move |index| {
            let time = index as f32 / 16_000.0;
            let wave = (2.0 * std::f32::consts::PI * 180.0 * time).sin() * 0.6
                + (2.0 * std::f32::consts::PI * 540.0 * time).sin() * 0.3
                + (2.0 * std::f32::consts::PI * 900.0 * time).sin() * 0.1;
            wave * amplitude
        }))
    }

    #[test]
    fn steady_background_noise_is_pushed_far_below_its_input_level() {
        let mut suppressor = NoiseSuppressor::new();
        let input = hiss(3_000, 0.05);
        let cleaned = suppressor.process(&input);
        let settled = &cleaned[cleaned.len() / 2 & !1..];

        assert!(
            rms(settled) < rms(&input) * 0.35,
            "noise settled at {} against an input of {}",
            rms(settled),
            rms(&input)
        );
    }

    #[test]
    fn speech_survives_the_same_filter_that_removes_the_noise() {
        let mut suppressor = NoiseSuppressor::new();
        suppressor.process(&hiss(2_000, 0.02));

        let spoken = speech(1_000, 0.4);
        let cleaned = suppressor.process(&spoken);
        assert!(
            rms(&cleaned) > rms(&spoken) * 0.6,
            "speech dropped from {} to {}",
            rms(&spoken),
            rms(&cleaned)
        );
    }

    #[test]
    fn speech_from_the_very_first_sample_is_not_swallowed_by_a_cold_filter() {
        let mut suppressor = NoiseSuppressor::new();
        let spoken = speech(1_000, 0.4);
        let cleaned = suppressor.process(&spoken);
        let opening = &cleaned[..(HOP_LEN * WARMUP_FRAMES).min(cleaned.len() / 2) * 2];

        assert!(
            rms(opening) > rms(&spoken[..opening.len()]) * 0.6,
            "the first words dropped from {} to {}",
            rms(&spoken[..opening.len()]),
            rms(opening)
        );
    }

    #[test]
    fn the_stream_keeps_its_length_and_stays_aligned_across_calls() {
        let mut suppressor = NoiseSuppressor::new();
        let block = speech(100, 0.3);
        let mut produced = 0;
        for _ in 0..20 {
            produced += suppressor.process(&block).len();
        }

        assert_eq!(20 * block.len() - produced, (FRAME_LEN - HOP_LEN) * 2);
    }
}
