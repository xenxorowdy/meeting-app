//! Performance-sensitive primitives for the Rust core backend.

pub mod audio {
    pub const HEADER_SIZE: usize = 16;
    pub const STREAM_MIC: u32 = 0;
    pub const STREAM_SYSTEM: u32 = 1;

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct AudioPacket {
        pub stream_id: u32,
        pub timestamp_ms: i64,
        pub pcm: Vec<u8>,
    }

    /// Incremental parser for the native helper's 16-byte little-endian packet protocol.
    #[derive(Default)]
    pub struct PacketParser {
        buffer: Vec<u8>,
    }

    impl PacketParser {
        pub fn feed(&mut self, chunk: &[u8]) -> Vec<AudioPacket> {
            self.buffer.extend_from_slice(chunk);
            let mut packets = Vec::new();

            loop {
                if self.buffer.len() < HEADER_SIZE {
                    break;
                }
                let stream_id = u32::from_le_bytes(self.buffer[0..4].try_into().unwrap());
                let timestamp_ms = i64::from_le_bytes(self.buffer[4..12].try_into().unwrap());
                let payload_len =
                    u32::from_le_bytes(self.buffer[12..16].try_into().unwrap()) as usize;

                // Prevent a corrupt native process from making the parser reserve unbounded memory.
                if payload_len > 16 * 1024 * 1024 {
                    self.buffer.clear();
                    break;
                }
                let total = HEADER_SIZE + payload_len;
                if self.buffer.len() < total {
                    break;
                }

                let pcm = self.buffer[HEADER_SIZE..total].to_vec();
                self.buffer.drain(..total);
                packets.push(AudioPacket {
                    stream_id,
                    timestamp_ms,
                    pcm,
                });
            }
            packets
        }

        pub fn reset(&mut self) {
            self.buffer.clear();
        }
    }

    pub fn encode_packet(stream_id: u32, timestamp_ms: i64, pcm: &[u8]) -> Vec<u8> {
        let mut packet = Vec::with_capacity(HEADER_SIZE + pcm.len());
        packet.extend_from_slice(&stream_id.to_le_bytes());
        packet.extend_from_slice(&timestamp_ms.to_le_bytes());
        packet.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        packet.extend_from_slice(pcm);
        packet
    }

    /// Fast integer RMS over signed 16-bit little-endian PCM.
    pub fn rms(pcm: &[u8]) -> f32 {
        let sample_count = pcm.len() / 2;
        if sample_count == 0 {
            return 0.0;
        }
        let mut sum: f64 = 0.0;
        for bytes in pcm[..sample_count * 2].chunks_exact(2) {
            let sample = i16::from_le_bytes([bytes[0], bytes[1]]) as f64;
            sum += sample * sample;
        }
        (sum / sample_count as f64).sqrt() as f32 / 32768.0
    }


    /// RIFF/WAVE container around signed 16-bit little-endian mono PCM, which is
    /// what every Whisper front end on this machine expects to be handed.
    pub fn encode_wav(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
        let data_len = pcm.len() as u32;
        let mut wav = Vec::with_capacity(44 + pcm.len());

        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        wav.extend_from_slice(pcm);

        wav
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_fragmented_packets() {
            let encoded = encode_packet(STREAM_MIC, 1234, &[0, 1, 2, 3]);
            let mut parser = PacketParser::default();
            assert!(parser.feed(&encoded[..7]).is_empty());
            let packets = parser.feed(&encoded[7..]);
            assert_eq!(packets.len(), 1);
            assert_eq!(
                packets[0],
                AudioPacket {
                    stream_id: STREAM_MIC,
                    timestamp_ms: 1234,
                    pcm: vec![0, 1, 2, 3]
                }
            );
        }

        #[test]
        fn calculates_rms_without_float_sample_conversion() {
            let pcm: Vec<u8> = (0..1600).flat_map(|_| 16384i16.to_le_bytes()).collect();
            let value = rms(&pcm);
            assert!((value - 0.5).abs() < 0.001);
        }

        #[test]
        fn wraps_pcm_in_a_wav_container() {
            let pcm: Vec<u8> = (0..320u16).flat_map(|v| (v as i16).to_le_bytes()).collect();
            let wav = encode_wav(&pcm, 16_000);

            assert_eq!(&wav[0..4], b"RIFF");
            assert_eq!(&wav[8..12], b"WAVE");
            assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
            assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
            assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16);
            assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()) as usize, pcm.len());
            assert_eq!(wav.len(), 44 + pcm.len());
        }
    }
}

/// Voice activity detection and utterance segmentation.
///
/// Whisper is an utterance-level model: handing it arbitrary 20 ms frames wastes
/// the Neural Engine and produces nothing useful, so speech has to be gathered
/// into segments first. Frames before the trigger are kept in a pre-roll ring
/// because the onset of a word is usually below the speech threshold, and a
/// trailing hangover keeps a brief pause inside one segment instead of chopping
/// a sentence in half.
pub mod vad {
    use crate::audio::rms;
    use std::collections::VecDeque;

    pub const FRAME_MS: usize = 20;

    #[derive(Debug, Clone)]
    pub struct VadConfig {
        pub sample_rate: u32,
        /// Normalised RMS (0.0 - 1.0) a frame must reach to count as speech.
        pub speech_rms: f32,
        /// Silence tolerated inside one utterance before it is closed.
        pub hangover_ms: usize,
        /// Audio kept ahead of the trigger so word onsets are not clipped.
        pub pre_roll_ms: usize,
        /// Segments shorter than this are treated as clicks and dropped.
        pub min_speech_ms: usize,
        /// Continuous speech is force-split here so transcripts stay live.
        pub max_segment_ms: usize,
    }

    fn env_f32(key: &str, fallback: f32) -> f32 {
        std::env::var(key).ok().and_then(|value| value.parse().ok()).unwrap_or(fallback)
    }

    fn env_usize(key: &str, fallback: usize) -> usize {
        std::env::var(key).ok().and_then(|value| value.parse().ok()).unwrap_or(fallback)
    }

    impl Default for VadConfig {
        fn default() -> Self {
            Self {
                sample_rate: 16_000,
                // Room noise sits well under this; speech at a normal distance is
                // comfortably above it. Too low and the recogniser is handed
                // near-silence, which it answers with confident nonsense.
                speech_rms: env_f32("CORE_BACKEND_VAD_RMS", 0.03),
                hangover_ms: env_usize("CORE_BACKEND_VAD_HANGOVER_MS", 600),
                pre_roll_ms: env_usize("CORE_BACKEND_VAD_PREROLL_MS", 400),
                min_speech_ms: env_usize("CORE_BACKEND_VAD_MIN_SPEECH_MS", 500),
                max_segment_ms: env_usize("CORE_BACKEND_VAD_MAX_SEGMENT_MS", 15_000),
            }
        }
    }

    #[derive(Debug, Clone, PartialEq)]
    pub struct Utterance {
        pub start_ms: i64,
        pub end_ms: i64,
        pub pcm: Vec<u8>,
    }

    pub struct SpeechDetector {
        config: VadConfig,
        frame_bytes: usize,
        residual: Vec<u8>,
        pre_roll: VecDeque<Vec<u8>>,
        pre_roll_frames: usize,
        speech: Vec<u8>,
        in_speech: bool,
        voiced_ms: usize,
        silence_ms: usize,
        segment_start_ms: i64,
        clock_ms: i64,
    }

    impl Default for SpeechDetector {
        fn default() -> Self {
            Self::new(VadConfig::default())
        }
    }

    impl SpeechDetector {
        pub fn new(config: VadConfig) -> Self {
            let frame_bytes = (config.sample_rate as usize / 1000) * FRAME_MS * 2;
            let pre_roll_frames = config.pre_roll_ms / FRAME_MS;
            Self {
                config,
                frame_bytes,
                residual: Vec::new(),
                pre_roll: VecDeque::new(),
                pre_roll_frames,
                speech: Vec::new(),
                in_speech: false,
                voiced_ms: 0,
                silence_ms: 0,
                segment_start_ms: 0,
                clock_ms: 0,
            }
        }

        pub fn is_in_speech(&self) -> bool {
            self.in_speech
        }

        /// Position of the audio clock, in milliseconds of audio consumed.
        pub fn clock_ms(&self) -> i64 {
            self.clock_ms
        }

        pub fn reset(&mut self) {
            self.residual.clear();
            self.pre_roll.clear();
            self.speech.clear();
            self.in_speech = false;
            self.voiced_ms = 0;
            self.silence_ms = 0;
            self.segment_start_ms = 0;
            self.clock_ms = 0;
        }

        fn ms_of(&self, bytes: usize) -> usize {
            let bytes_per_ms = (self.config.sample_rate as usize / 1000) * 2;
            bytes / bytes_per_ms.max(1)
        }

        fn take_segment(&mut self) -> Option<Utterance> {
            if self.speech.is_empty() {
                return None;
            }
            let pcm = std::mem::take(&mut self.speech);
            let duration = self.ms_of(pcm.len()) as i64;
            let start_ms = self.segment_start_ms;
            let voiced_ms = std::mem::take(&mut self.voiced_ms);

            // The threshold applies to voiced audio, not to the pre-roll and
            // hangover padding wrapped around it.
            if voiced_ms < self.config.min_speech_ms {
                return None;
            }

            Some(Utterance {
                start_ms,
                end_ms: start_ms + duration,
                pcm,
            })
        }

        pub fn feed(&mut self, pcm: &[u8]) -> Vec<Utterance> {
            self.residual.extend_from_slice(pcm);
            let mut finished = Vec::new();

            while self.residual.len() >= self.frame_bytes {
                let frame: Vec<u8> = self.residual.drain(..self.frame_bytes).collect();
                let level = rms(&frame);
                let is_speech = level >= self.config.speech_rms;
                let frame_start_ms = self.clock_ms;
                self.clock_ms += FRAME_MS as i64;

                if is_speech {
                    if !self.in_speech {
                        self.in_speech = true;
                        self.silence_ms = 0;
                        let pre_roll_ms = self.ms_of(self.pre_roll.iter().map(Vec::len).sum()) as i64;
                        self.segment_start_ms = (frame_start_ms - pre_roll_ms).max(0);
                        while let Some(buffered) = self.pre_roll.pop_front() {
                            self.speech.extend_from_slice(&buffered);
                        }
                    } else {
                        self.silence_ms = 0;
                    }
                    self.speech.extend_from_slice(&frame);
                    self.voiced_ms += FRAME_MS;
                } else if self.in_speech {
                    self.speech.extend_from_slice(&frame);
                    self.silence_ms += FRAME_MS;

                    if self.silence_ms >= self.config.hangover_ms {
                        self.in_speech = false;
                        self.silence_ms = 0;
                        if let Some(utterance) = self.take_segment() {
                            finished.push(utterance);
                        } else {
                            self.speech.clear();
                            self.voiced_ms = 0;
                        }
                    }
                } else {
                    self.pre_roll.push_back(frame);
                    while self.pre_roll.len() > self.pre_roll_frames {
                        self.pre_roll.pop_front();
                    }
                }

                if self.in_speech && self.ms_of(self.speech.len()) >= self.config.max_segment_ms {
                    let segment_end = self.clock_ms;
                    if let Some(utterance) = self.take_segment() {
                        finished.push(utterance);
                    } else {
                        self.speech.clear();
                        self.voiced_ms = 0;
                    }
                    // Speech is still going: continue the next segment from here.
                    self.segment_start_ms = segment_end;
                }
            }

            finished
        }

        /// Close whatever is buffered, for use when a meeting stops.
        pub fn flush(&mut self) -> Option<Utterance> {
            let residual: Vec<u8> = std::mem::take(&mut self.residual);
            if self.in_speech && !residual.is_empty() {
                self.speech.extend_from_slice(&residual);
                self.clock_ms += self.ms_of(residual.len()) as i64;
            }
            self.in_speech = false;
            self.silence_ms = 0;
            let segment = self.take_segment();
            self.speech.clear();
            self.voiced_ms = 0;
            self.pre_roll.clear();
            segment
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn silence(ms: usize) -> Vec<u8> {
            vec![0u8; (16 * ms) * 2]
        }

        fn tone(ms: usize, amplitude: i16) -> Vec<u8> {
            (0..(16 * ms))
                .flat_map(|i| {
                    let sample = if i % 8 < 4 { amplitude } else { -amplitude };
                    sample.to_le_bytes()
                })
                .collect()
        }

        #[test]
        fn silence_never_produces_an_utterance() {
            let mut detector = SpeechDetector::new(VadConfig::default());
            assert!(detector.feed(&silence(5_000)).is_empty());
            assert!(detector.flush().is_none());
        }

        #[test]
        fn segments_one_utterance_with_pre_roll_and_hangover() {
            let mut detector = SpeechDetector::new(VadConfig::default());

            assert!(detector.feed(&silence(1_000)).is_empty());
            assert!(detector.feed(&tone(1_000, 8_000)).is_empty());
            let finished = detector.feed(&silence(1_000));

            assert_eq!(finished.len(), 1);
            let utterance = &finished[0];
            // Speech starts at 1000 ms; the 400 ms pre-roll must be included.
            assert_eq!(utterance.start_ms, 600);
            let duration = utterance.end_ms - utterance.start_ms;
            // 400 pre-roll + 1000 speech + 600 hangover.
            assert!((duration - 2_000).abs() <= FRAME_MS as i64, "duration was {duration}");
        }

        #[test]
        fn force_splits_continuous_speech() {
            let config = VadConfig {
                max_segment_ms: 2_000,
                ..VadConfig::default()
            };
            let mut detector = SpeechDetector::new(config);

            let finished = detector.feed(&tone(9_000, 8_000));
            assert!(finished.len() >= 4, "expected several segments, got {}", finished.len());
            for pair in finished.windows(2) {
                assert!(pair[1].start_ms >= pair[0].end_ms - FRAME_MS as i64);
            }
        }

        #[test]
        fn drops_clicks_shorter_than_the_minimum() {
            let config = VadConfig {
                pre_roll_ms: 0,
                min_speech_ms: 300,
                ..VadConfig::default()
            };
            let mut detector = SpeechDetector::new(config);

            detector.feed(&silence(200));
            detector.feed(&tone(40, 12_000));
            let finished = detector.feed(&silence(1_000));
            assert!(finished.is_empty());
        }

        #[test]
        fn flush_closes_speech_that_never_fell_silent() {
            let mut detector = SpeechDetector::new(VadConfig::default());
            detector.feed(&tone(1_200, 8_000));

            let flushed = detector.flush().expect("speech should be flushed");
            assert!(flushed.end_ms > flushed.start_ms);
            assert!(detector.flush().is_none());
        }
    }
}

/// Post-processing for recogniser output.
pub mod transcript {
    /// Whisper marks non-speech audio with bracketed tags — `[BLANK_AUDIO]`,
    /// `(silence)`, `[Music]` — and a VAD that triggered on room noise will
    /// produce exactly those. They are not turns, so a segment whose text is
    /// nothing but tags is dropped, and tags around real speech are stripped.
    pub fn strip_non_speech(text: &str) -> Option<String> {
        let mut cleaned = String::with_capacity(text.len());
        let mut depth_square = 0usize;
        let mut depth_round = 0usize;

        for character in text.chars() {
            match character {
                '[' => depth_square += 1,
                ']' => depth_square = depth_square.saturating_sub(1),
                '(' => depth_round += 1,
                ')' => depth_round = depth_round.saturating_sub(1),
                _ if depth_square == 0 && depth_round == 0 => cleaned.push(character),
                _ => {}
            }
        }

        let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
        collapsed
            .chars()
            .any(|character| character.is_alphanumeric())
            .then_some(collapsed)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn drops_segments_that_are_only_non_speech_tags() {
            assert_eq!(strip_non_speech("[BLANK_AUDIO]"), None);
            assert_eq!(strip_non_speech("   [ Silence ]  "), None);
            assert_eq!(strip_non_speech("(silence)"), None);
            assert_eq!(strip_non_speech("[Music]"), None);
            assert_eq!(strip_non_speech(""), None);
            assert_eq!(strip_non_speech("  "), None);
        }

        #[test]
        fn keeps_speech_and_removes_tags_around_it() {
            assert_eq!(
                strip_non_speech("[BLANK_AUDIO] Good morning everyone."),
                Some("Good morning everyone.".to_string())
            );
            assert_eq!(
                strip_non_speech("Ship it on Friday. (laughs)"),
                Some("Ship it on Friday.".to_string())
            );
            assert_eq!(
                strip_non_speech("Let's   lock  down the plan."),
                Some("Let's lock down the plan.".to_string())
            );
        }
    }
}
