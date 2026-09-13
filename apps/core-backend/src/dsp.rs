use std::f32::consts::PI;

pub const SAMPLE_RATE: u32 = 16_000;
pub const FRAME_LEN: usize = 512;
pub const HOP_LEN: usize = 256;
pub const BINS: usize = FRAME_LEN / 2 + 1;

pub fn samples_from_pcm(pcm: &[u8]) -> Vec<f32> {
    pcm.chunks_exact(2)
        .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32768.0)
        .collect()
}

pub fn pcm_from_samples(samples: &[f32]) -> Vec<u8> {
    let mut pcm = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let scaled = if clamped < 0.0 {
            clamped * 32768.0
        } else {
            clamped * 32767.0
        };
        pcm.extend_from_slice(&(scaled as i16).to_le_bytes());
    }
    pcm
}

pub fn sqrt_hann(len: usize) -> Vec<f32> {
    (0..len)
        .map(|index| {
            let hann = 0.5 - 0.5 * (2.0 * PI * index as f32 / len as f32).cos();
            hann.max(0.0).sqrt()
        })
        .collect()
}

pub struct Fft {
    size: usize,
    levels: u32,
    cos: Vec<f32>,
    sin: Vec<f32>,
}

impl Fft {
    pub fn new(size: usize) -> Self {
        assert!(size.is_power_of_two() && size >= 2);
        Self {
            size,
            levels: size.trailing_zeros(),
            cos: (0..size / 2)
                .map(|index| (2.0 * PI * index as f32 / size as f32).cos())
                .collect(),
            sin: (0..size / 2)
                .map(|index| (2.0 * PI * index as f32 / size as f32).sin())
                .collect(),
        }
    }

    pub fn forward(&self, re: &mut [f32], im: &mut [f32]) {
        self.transform(re, im, false);
    }

    pub fn inverse(&self, re: &mut [f32], im: &mut [f32]) {
        self.transform(re, im, true);
        let scale = 1.0 / self.size as f32;
        for value in re.iter_mut().chain(im.iter_mut()) {
            *value *= scale;
        }
    }

    fn transform(&self, re: &mut [f32], im: &mut [f32], inverse: bool) {
        assert_eq!(re.len(), self.size);
        assert_eq!(im.len(), self.size);

        for index in 0..self.size {
            let mirrored = ((index as u32).reverse_bits() >> (32 - self.levels)) as usize;
            if mirrored > index {
                re.swap(index, mirrored);
                im.swap(index, mirrored);
            }
        }

        let mut span = 2;
        while span <= self.size {
            let half = span / 2;
            let stride = self.size / span;
            for block in (0..self.size).step_by(span) {
                let mut twiddle = 0;
                for low in block..block + half {
                    let high = low + half;
                    let cos = self.cos[twiddle];
                    let sin = if inverse {
                        self.sin[twiddle]
                    } else {
                        -self.sin[twiddle]
                    };
                    let rotated_re = re[high] * cos - im[high] * sin;
                    let rotated_im = re[high] * sin + im[high] * cos;
                    re[high] = re[low] - rotated_re;
                    im[high] = im[low] - rotated_im;
                    re[low] += rotated_re;
                    im[low] += rotated_im;
                    twiddle += stride;
                }
            }
            span *= 2;
        }
    }
}

pub fn power_spectrum(re: &[f32], im: &[f32], power: &mut [f32]) {
    for (bin, slot) in power.iter_mut().enumerate() {
        *slot = re[bin] * re[bin] + im[bin] * im[bin];
    }
}

fn hz_to_mel(hz: f32) -> f32 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

fn mel_to_hz(mel: f32) -> f32 {
    700.0 * (10f32.powf(mel / 2595.0) - 1.0)
}

pub struct MelBank {
    filters: Vec<Vec<f32>>,
}

impl MelBank {
    pub fn new(bands: usize, bins: usize, sample_rate: u32, low_hz: f32, high_hz: f32) -> Self {
        let nyquist = sample_rate as f32 / 2.0;
        let high_hz = high_hz.min(nyquist);
        let low_mel = hz_to_mel(low_hz);
        let high_mel = hz_to_mel(high_hz);
        let edges: Vec<f32> = (0..bands + 2)
            .map(|index| {
                let mel = low_mel + (high_mel - low_mel) * index as f32 / (bands + 1) as f32;
                mel_to_hz(mel) * (bins - 1) as f32 * 2.0 / sample_rate as f32
            })
            .collect();

        let filters = (0..bands)
            .map(|band| {
                let (left, centre, right) = (edges[band], edges[band + 1], edges[band + 2]);
                (0..bins)
                    .map(|bin| {
                        let position = bin as f32;
                        if position <= left || position >= right {
                            0.0
                        } else if position <= centre {
                            (position - left) / (centre - left).max(f32::EPSILON)
                        } else {
                            (right - position) / (right - centre).max(f32::EPSILON)
                        }
                    })
                    .collect()
            })
            .collect();

        Self { filters }
    }

    pub fn log_energies(&self, power: &[f32]) -> Vec<f32> {
        self.filters
            .iter()
            .map(|weights| {
                let energy: f32 = weights
                    .iter()
                    .zip(power)
                    .map(|(weight, value)| weight * value)
                    .sum();
                (energy + 1e-10).ln()
            })
            .collect()
    }
}

pub fn dct2(input: &[f32], outputs: usize) -> Vec<f32> {
    let len = input.len() as f32;
    (0..outputs)
        .map(|order| {
            input
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    value * (PI * order as f32 * (index as f32 + 0.5) / len).cos()
                })
                .sum()
        })
        .collect()
}

pub const PITCH_MIN_HZ: f32 = 60.0;
pub const PITCH_MAX_HZ: f32 = 400.0;
const PITCH_CLARITY: f32 = 0.35;

pub fn pitch_hz(samples: &[f32], sample_rate: u32) -> Option<f32> {
    let min_lag = (sample_rate as f32 / PITCH_MAX_HZ).floor() as usize;
    let max_lag = (sample_rate as f32 / PITCH_MIN_HZ).ceil() as usize;
    if min_lag == 0 || samples.len() < max_lag * 2 {
        return None;
    }

    let mut best_lag = 0;
    let mut best_score = 0.0f32;
    for lag in min_lag..=max_lag {
        let window = samples.len() - lag;
        let mut dot = 0.0f32;
        let mut head = 0.0f32;
        let mut tail = 0.0f32;
        for index in 0..window {
            let early = samples[index];
            let late = samples[index + lag];
            dot += early * late;
            head += early * early;
            tail += late * late;
        }
        let magnitude = (head * tail).sqrt();
        if magnitude <= f32::EPSILON {
            continue;
        }
        let score = dot / magnitude;
        if score > best_score {
            best_score = score;
            best_lag = lag;
        }
    }

    (best_score >= PITCH_CLARITY && best_lag > 0).then(|| sample_rate as f32 / best_lag as f32)
}

pub fn envelope(pcm: &[u8], bucket_ms: usize, sample_rate: u32) -> Vec<f32> {
    let bucket_samples = (sample_rate as usize / 1000) * bucket_ms.max(1);
    if bucket_samples == 0 {
        return Vec::new();
    }
    let bucket_bytes = bucket_samples * 2;
    pcm.chunks_exact(bucket_bytes)
        .map(|bucket| crate::audio::rms(bucket))
        .collect()
}

pub fn cosine(left: &[f32], right: &[f32]) -> f32 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut head = 0.0f32;
    let mut tail = 0.0f32;
    for (a, b) in left.iter().zip(right) {
        dot += a * b;
        head += a * a;
        tail += b * b;
    }
    let magnitude = (head * tail).sqrt();
    if magnitude <= f32::EPSILON {
        return 0.0;
    }
    (dot / magnitude).clamp(-1.0, 1.0)
}

pub fn normalize(vector: &mut [f32]) {
    let magnitude = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if magnitude > f32::EPSILON {
        for value in vector.iter_mut() {
            *value /= magnitude;
        }
    }
}
