use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env, io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::{broadcast, mpsc, Mutex, RwLock},
};
use uuid::Uuid;

use alpha_core_backend::{
    audio::{self, AudioPacket, PacketParser, STREAM_MIC, STREAM_SYSTEM},
    transcript::strip_non_speech,
    vad::{SpeechDetector, Utterance},
};

mod calendar;
use calendar::CalendarService;

mod stt;
use stt::SttService;

mod sarvam;
mod settings;
mod podcast;
mod summarizer;
use podcast::{Host as PodcastHost, PodcastService, ScriptRequest as PodcastScriptRequest, SourceTurn as PodcastSourceTurn};
use sarvam::{label_speakers, BatchConfig, SarvamService};
use settings::SettingsStore;
use summarizer::{MeetingSummary, SummaryNote, SummaryRequest, SummaryService, SummaryTurn};

const VERSION: &str = "2.0.0-rust";
const DEFAULT_PORT: u16 = 48900;
/// How long a stopping meeting waits for queued utterances to come back from the
/// transcription engine before the summary is written.
const TRANSCRIPTION_DRAIN_BUDGET: Duration = Duration::from_secs(12);

fn channel_name(stream_id: u32) -> &'static str {
    if stream_id == STREAM_MIC {
        "mic"
    } else {
        "system"
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptTurn {
    id: String,
    channel: String,
    speaker: String,
    start_ms: i64,
    end_ms: i64,
    text: String,
    confidence: f32,
    /// What the engine reported decoding this turn in. Absent on every record
    /// stored before detection was surfaced, hence the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meeting {
    id: String,
    title: String,
    started_at: i64,
    ended_at: Option<i64>,
    duration_seconds: i64,
    summary_markdown: String,
    action_items: Vec<Value>,
    key_decisions: Vec<String>,
    #[serde(default)]
    topics: Vec<String>,
    #[serde(default)]
    email_draft: String,
    metadata: Value,
    /// Where the screen recording for this meeting lives, when there is one.
    /// Written by the Electron shell (which owns the files) and stored here only
    /// so the player can find them. Absent on every meeting recorded before this
    /// existed, hence the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recording: Option<Value>,
    #[serde(default)]
    notes: Vec<Value>,
    transcript: Vec<TranscriptTurn>,
    created_at: i64,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
enum SessionState {
    #[serde(rename = "IDLE")]
    #[default]
    Idle,
    #[serde(rename = "STARTING")]
    Starting,
    #[serde(rename = "RECORDING")]
    Recording,
    #[serde(rename = "PAUSED")]
    Paused,
    #[serde(rename = "PROCESSING_STT")]
    ProcessingStt,
    #[serde(rename = "SUMMARIZING")]
    Summarizing,
    #[serde(rename = "COMPLETED")]
    Completed,
}

impl SessionState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "IDLE",
            Self::Starting => "STARTING",
            Self::Recording => "RECORDING",
            Self::Paused => "PAUSED",
            Self::ProcessingStt => "PROCESSING_STT",
            Self::Summarizing => "SUMMARIZING",
            Self::Completed => "COMPLETED",
        }
    }
}

#[derive(Default)]
struct Session {
    state: SessionState,
    current: Option<Meeting>,
    parser: PacketParser,
    mic_rms: f32,
    system_rms: f32,
    mic_vad: SpeechDetector,
    system_vad: SpeechDetector,
    transcription_provider: String,
}

#[derive(Clone)]
struct Store {
    path: Arc<PathBuf>,
    meetings: Arc<RwLock<HashMap<String, Meeting>>>,
}

impl Store {
    async fn load() -> Self {
        let path = env::var_os("CORE_BACKEND_DATA_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let base = env::var_os("ALPHA_DATA_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
                base.join(".alpha-meeting-assistant").join("meetings.json")
            });
        let mut meetings = HashMap::new();
        if let Ok(bytes) = tokio::fs::read(&path).await {
            if let Ok(values) = serde_json::from_slice::<Vec<Meeting>>(&bytes) {
                meetings.extend(values.into_iter().map(|m| (m.id.clone(), m)));
            }
        }
        Self {
            path: Arc::new(path),
            meetings: Arc::new(RwLock::new(meetings)),
        }
    }

    async fn persist(&self) -> io::Result<()> {
        let values: Vec<Meeting> = self.meetings.read().await.values().cloned().collect();
        let bytes = serde_json::to_vec_pretty(&values).map_err(io::Error::other)?;
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let tmp = self.path.with_extension("json.tmp");
        tokio::fs::write(&tmp, bytes).await?;
        tokio::fs::rename(tmp, &*self.path).await
    }

    async fn put(&self, meeting: Meeting) -> io::Result<()> {
        self.meetings
            .write()
            .await
            .insert(meeting.id.clone(), meeting);
        self.persist().await
    }
    async fn get(&self, id: &str) -> Option<Meeting> {
        self.meetings.read().await.get(id).cloned()
    }
    async fn delete(&self, id: &str) -> io::Result<bool> {
        let removed = self.meetings.write().await.remove(id).is_some();
        if removed {
            self.persist().await?;
        }
        Ok(removed)
    }
    async fn list(&self, search: &str, limit: usize, offset: usize) -> Vec<Meeting> {
        let query = search.trim().to_lowercase();
        let mut values: Vec<_> = self
            .meetings
            .read()
            .await
            .values()
            .filter(|m| {
                query.is_empty()
                    || m.title.to_lowercase().contains(&query)
                    || m.summary_markdown.to_lowercase().contains(&query)
                    || m.transcript
                        .iter()
                        .any(|t| t.text.to_lowercase().contains(&query))
            })
            .cloned()
            .collect();
        values.sort_by_key(|m| std::cmp::Reverse(m.started_at));
        values.into_iter().skip(offset).take(limit).collect()
    }
}

/// One utterance waiting to be transcribed. Jobs run through a single worker so
/// the parts of a long sentence stay in order.
struct TranscriptionJob {
    meeting_id: String,
    stream_id: u32,
    utterance: Utterance,
}

fn posted_transcript(payload: &Value) -> Vec<TranscriptTurn> {
    payload
        .get("transcript")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, turn)| {
            let channel = turn
                .get("channel")
                .or_else(|| turn.get("stream"))
                .and_then(Value::as_str)
                .unwrap_or("system");
            let text = turn
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if text.is_empty() {
                return None;
            }
            let supplied = turn.get("speaker").and_then(Value::as_str);
            Some(TranscriptTurn {
                id: turn
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("turn-{index}")),
                channel: channel.to_string(),
                speaker: if channel == "mic" {
                    "You".into()
                } else if supplied == Some("You") || supplied.is_none() {
                    "Others".into()
                } else {
                    supplied.unwrap().to_string()
                },
                start_ms: turn.get("startMs").and_then(Value::as_i64).unwrap_or(0),
                end_ms: turn.get("endMs").and_then(Value::as_i64).unwrap_or(0),
                text: text.to_string(),
                confidence: turn
                    .get("confidence")
                    .and_then(Value::as_f64)
                    .unwrap_or(1.0) as f32,
                language: turn
                    .get("language")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect()
}

fn set_meeting_metadata(meeting: &mut Meeting, key: &str, value: Value) {
    if !meeting.metadata.is_object() {
        meeting.metadata = json!({});
    }
    meeting.metadata[key] = value;
}

fn rename_meeting_speakers(
    meeting: &mut Meeting,
    renames: &serde_json::Map<String, Value>,
) -> Result<usize, String> {
    let mut cleaned = HashMap::new();
    for (current, next) in renames {
        let current = current.trim();
        let next = next
            .as_str()
            .ok_or_else(|| "speaker names must be strings".to_string())?
            .trim();
        if current.is_empty() || next.is_empty() {
            return Err("speaker names cannot be empty".into());
        }
        if next.chars().count() > 80 {
            return Err("speaker names cannot exceed 80 characters".into());
        }
        cleaned.insert(current.to_string(), next.to_string());
    }
    if cleaned.is_empty() {
        return Err("provide at least one speaker name to change".into());
    }

    let mut changed = 0;
    for turn in &mut meeting.transcript {
        if let Some(next) = cleaned.get(&turn.speaker) {
            turn.speaker = next.clone();
            changed += 1;
        }
    }
    Ok(changed)
}

/// The renderer only sends a relative recording path. Resolve it under the one
/// directory the Electron parent explicitly handed to this process, then
/// canonicalize both sides so `..` and symlinks cannot turn batch STT into an
/// arbitrary local-file uploader.
fn batch_recording_path(recording: Option<&Value>) -> Result<PathBuf, String> {
    if recording
        .and_then(|value| value.get("durationMs"))
        .and_then(Value::as_i64)
        .is_some_and(|duration| duration > 2 * 60 * 60 * 1000)
    {
        return Err("Sarvam batch transcription supports recordings up to two hours".into());
    }
    let relative = recording
        .and_then(|value| value.get("videoPath"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Sarvam batch transcription needs a completed meeting recording".to_string()
        })?;
    let relative = Path::new(relative);
    let root = env::var_os("ALPHA_RECORDINGS_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| {
            "Sarvam batch transcription is available from the Alpha desktop app".to_string()
        })?;
    resolve_batch_recording(&root, relative)
}

fn resolve_batch_recording(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    if relative.is_absolute() {
        return Err("the recording path must be relative to Alpha's recording directory".into());
    }
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|cause| format!("could not open Alpha's recording directory: {cause}"))?;
    let candidate = std::fs::canonicalize(root.join(relative))
        .map_err(|cause| format!("could not open the completed meeting recording: {cause}"))?;
    if !candidate.starts_with(&canonical_root) || !candidate.is_file() {
        return Err("the meeting recording is outside Alpha's recording directory".into());
    }
    Ok(candidate)
}

#[derive(Clone)]
struct AppState {
    started_at: i64,
    session: Arc<Mutex<Session>>,
    store: Store,
    events: broadcast::Sender<String>,
    stt: Arc<SttService>,
    sarvam: Arc<SarvamService>,
    summarizer: Arc<SummaryService>,
    transcriptions: mpsc::UnboundedSender<TranscriptionJob>,
    pending_transcriptions: Arc<AtomicUsize>,
    settings: Arc<SettingsStore>,
    calendar: Arc<CalendarService>,
    podcast: Arc<PodcastService>,
}

impl AppState {
    async fn stt_status(&self, active_provider: Option<&str>) -> Value {
        let configured = match active_provider.filter(|value| !value.is_empty()) {
            Some(provider) => provider.to_string(),
            None => self
                .settings
                .get_str("transcriptionProvider")
                .await
                .unwrap_or_else(|| "whisper".into()),
        };
        let mut status = self.stt.status_value().await;
        status["provider"] = json!(configured);
        status["sarvam"] = self.sarvam.status_value().await;
        status
    }

    async fn status(&self) -> Value {
        let session = self.session.lock().await;
        let turns = session
            .current
            .as_ref()
            .map(|m| m.transcript.len())
            .unwrap_or(0);
        let session_provider = if matches!(
            session.state,
            SessionState::Starting
                | SessionState::Recording
                | SessionState::Paused
                | SessionState::ProcessingStt
                | SessionState::Summarizing
        ) {
            session.transcription_provider.clone()
        } else {
            String::new()
        };
        let state = json!({ "state": session.state.as_str(), "meetingId": session.current.as_ref().map(|m| &m.id), "meetingTitle": session.current.as_ref().map(|m| &m.title), "durationSeconds": session.current.as_ref().map(|m| (now_ms() - m.started_at).max(0) / 1000).unwrap_or(0), "turnsCount": turns, "audioLevels": { "mic": session.mic_rms * 100.0, "system": session.system_rms * 100.0 } });
        drop(session);

        let mut status = state;
        status["stt"] = self.stt_status(Some(&session_provider)).await;
        status["stt"]["pending"] = json!(self.pending_transcriptions.load(Ordering::SeqCst));
        status["summary"] = self.summarizer.status_value().await;
        status["podcast"] = self.podcast.status_value().await;
        status
    }

    async fn emit(&self, kind: &str, data: Value) {
        let _ = self
            .events
            .send(json!({"type": kind, "data": data, "timestamp": now_ms()}).to_string());
    }

    async fn start(&self, payload: &Value) -> Result<Meeting, String> {
        let provider = self
            .settings
            .get_str("transcriptionProvider")
            .await
            .unwrap_or_else(|| "whisper".into())
            .trim()
            .to_ascii_lowercase();
        if !matches!(provider.as_str(), "whisper" | "sarvam") {
            return Err(format!("Unknown transcription provider '{provider}'"));
        }
        if provider == "sarvam" && !self.sarvam.has_key().await {
            return Err("Add a Sarvam API key in Transcription settings before starting batch transcription.".into());
        }

        let mut session = self.session.lock().await;
        if matches!(
            session.state,
            SessionState::Recording
                | SessionState::Paused
                | SessionState::Starting
                | SessionState::ProcessingStt
                | SessionState::Summarizing
        ) {
            return Err("A meeting session is already in progress.".into());
        }
        session.state = SessionState::Starting;
        session.mic_vad.reset();
        session.system_vad.reset();
        session.transcription_provider = provider.clone();
        let now = now_ms();

        // Warm the model while the first sentences are still being spoken.
        // The language readout describes one meeting, so clear the previous
        // meeting's tally before this one starts producing turns.
        if provider == "whisper" {
            self.stt.reset_language_stats().await;
            let stt = self.stt.clone();
            tokio::spawn(async move { stt.ensure_ready().await });
        }
        let mut metadata = payload
            .get("metadata")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if !metadata.is_object() {
            metadata = json!({});
        }
        metadata["transcriptionProvider"] = json!(provider);
        let meeting = Meeting {
            id: Uuid::new_v4().to_string(),
            title: payload
                .get("title")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("Untitled Meeting")
                .to_string(),
            started_at: now,
            ended_at: None,
            duration_seconds: 0,
            summary_markdown: String::new(),
            action_items: vec![],
            key_decisions: vec![],
            topics: vec![],
            email_draft: String::new(),
            metadata,
            recording: None,
            notes: vec![],
            transcript: vec![],
            created_at: now,
        };
        self.store
            .put(meeting.clone())
            .await
            .map_err(|e| e.to_string())?;
        session.current = Some(meeting.clone());
        session.state = SessionState::Recording;
        drop(session);
        self.emit(
            "state_change",
            json!({"newState":"RECORDING","oldState":"STARTING"}),
        )
        .await;
        self.emit("meeting_started", serde_json::to_value(&meeting).unwrap())
            .await;
        Ok(meeting)
    }

    async fn finish(&self, payload: &Value) -> Result<Meeting, String> {
        // Whisper closes its live VAD buffers here. Sarvam deliberately has no
        // live jobs: it waits for the complete mixed recording below.
        let (provider, tail) = {
            let mut session = self.session.lock().await;
            let meeting_id = match session.current.as_ref() {
                Some(meeting) => meeting.id.clone(),
                None => return Err("No meeting session is active".into()),
            };
            if matches!(
                session.state,
                SessionState::ProcessingStt | SessionState::Summarizing
            ) {
                return session
                    .current
                    .clone()
                    .ok_or_else(|| "No meeting session is active".to_string());
            }
            session.state = SessionState::ProcessingStt;
            let provider = if session.transcription_provider.is_empty() {
                "whisper".to_string()
            } else {
                session.transcription_provider.clone()
            };

            let mut jobs = Vec::new();
            if provider == "whisper" {
                if let Some(utterance) = session.mic_vad.flush() {
                    jobs.push(TranscriptionJob {
                        meeting_id: meeting_id.clone(),
                        stream_id: STREAM_MIC,
                        utterance,
                    });
                }
                if let Some(utterance) = session.system_vad.flush() {
                    jobs.push(TranscriptionJob {
                        meeting_id,
                        stream_id: STREAM_SYSTEM,
                        utterance,
                    });
                }
            }
            (provider, jobs)
        };

        self.emit(
            "state_change",
            json!({"newState":"PROCESSING_STT","oldState":"RECORDING","provider":provider}),
        )
        .await;

        if provider == "whisper" {
            self.queue_transcriptions(tail).await;
            self.drain_transcriptions(TRANSCRIPTION_DRAIN_BUDGET).await;
        }

        let mut session = self.session.lock().await;
        let mut meeting = session
            .current
            .clone()
            .ok_or("No meeting session is active")?;

        // The shell reports where it wrote the screen recording, if it made one.
        // It owns those files; the meeting record only needs to be able to find them.
        if let Some(recording) = payload.get("recording") {
            meeting.recording = recording.as_object().map(|_| recording.clone());
        }

        // Live backend turns win. The renderer copy is a compatibility fallback
        // when local Whisper was not installed, and a last-resort fallback if a
        // Sarvam job later fails without producing any text.
        if meeting.transcript.is_empty() {
            meeting.transcript = posted_transcript(payload);
        }
        let ended = now_ms();
        meeting.ended_at = Some(ended);
        meeting.duration_seconds = ((ended - meeting.started_at).max(0)) / 1000;
        session.current = Some(meeting.clone());
        drop(session);

        let mut transcription_warning = None;
        if provider == "sarvam" {
            let recording_offset = meeting
                .recording
                .as_ref()
                .and_then(|value| value.get("startedAtMs"))
                .and_then(Value::as_i64)
                .map(|started| (started - meeting.started_at).max(0))
                .unwrap_or(0);
            let config = BatchConfig {
                language: self
                    .settings
                    .get_str("sarvamLanguage")
                    .await
                    .unwrap_or_else(|| "unknown".into()),
                mode: self
                    .settings
                    .get_str("sarvamMode")
                    .await
                    .unwrap_or_else(|| "transcribe".into()),
                num_speakers: self
                    .settings
                    .get_i64("sarvamNumSpeakers")
                    .await
                    .and_then(|value| u8::try_from(value).ok()),
            };

            let result = match batch_recording_path(meeting.recording.as_ref()) {
                Ok(path) => self.sarvam.transcribe(&path, config).await,
                Err(cause) => Err(cause),
            };
            match result {
                Ok(batch) => {
                    let labels = label_speakers(&batch.turns);
                    meeting.transcript = batch
                        .turns
                        .into_iter()
                        .map(|turn| TranscriptTurn {
                            id: Uuid::new_v4().to_string(),
                            channel: "mixed".into(),
                            speaker: labels
                                .get(&turn.speaker_id)
                                .cloned()
                                .unwrap_or_else(|| "Speaker 1".into()),
                            start_ms: recording_offset + turn.start_ms,
                            end_ms: recording_offset + turn.end_ms,
                            text: turn.text,
                            confidence: 1.0,
                            language: turn.language.or_else(|| batch.language.clone()),
                        })
                        .collect();
                    set_meeting_metadata(&mut meeting, "transcriptionProvider", json!("sarvam"));
                    set_meeting_metadata(&mut meeting, "diarized", json!(true));
                    for turn in &meeting.transcript {
                        self.emit(
                            "transcript_turn",
                            serde_json::to_value(turn).unwrap_or_else(|_| json!({})),
                        )
                        .await;
                    }
                }
                Err(cause) => {
                    set_meeting_metadata(&mut meeting, "transcriptionWarning", json!(cause));
                    transcription_warning = Some(cause);
                }
            }
        }

        let mut session = self.session.lock().await;
        session.current = Some(meeting.clone());
        session.state = SessionState::Summarizing;
        drop(session);
        self.emit(
            "state_change",
            json!({"newState":"SUMMARIZING","oldState":"PROCESSING_STT"}),
        )
        .await;

        // `autoSummarize: false` means "keep everything on device" — so do not
        // send the transcript anywhere, and do not fabricate notes either.
        let summary = if self.settings.get_bool("autoSummarize").await == Some(false) {
            MeetingSummary {
                summary_markdown: String::new(),
                provider: "disabled".into(),
                ..Default::default()
            }
        } else {
            self.summarize_into(&mut meeting).await
        };

        self.store
            .put(meeting.clone())
            .await
            .map_err(|e| e.to_string())?;

        let mut session = self.session.lock().await;
        session.current = Some(meeting.clone());
        session.state = SessionState::Completed;
        drop(session);
        if let Some(warning) = &transcription_warning {
            self.emit(
                "warning",
                json!({"message": warning, "stage": "transcription"}),
            )
            .await;
        }
        self.emit(
            "summary_generated",
            json!({"meetingId": meeting.id, "provider": summary.provider, "warning": summary.warning, "transcriptionWarning": transcription_warning}),
        )
        .await;
        self.emit(
            "state_change",
            json!({"newState":"COMPLETED","oldState":"SUMMARIZING"}),
        )
        .await;
        self.emit("meeting_completed", serde_json::to_value(&meeting).unwrap())
            .await;
        Ok(meeting)
    }

    async fn summarize_into(&self, meeting: &mut Meeting) -> MeetingSummary {
        let request = SummaryRequest {
            title: meeting.title.clone(),
            started_at: meeting.started_at,
            duration_seconds: meeting.duration_seconds,
            turns: meeting
                .transcript
                .iter()
                .map(|t| SummaryTurn {
                    speaker: t.speaker.clone(),
                    start_ms: t.start_ms,
                    text: t.text.clone(),
                })
                .collect(),
            notes: meeting
                .notes
                .iter()
                .map(|note| SummaryNote {
                    at_ms: note.get("atMs").and_then(Value::as_i64).unwrap_or(0),
                    text: note
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                })
                .collect(),
        };

        let summary = self.summarizer.summarize(&request).await;
        meeting.summary_markdown = summary.summary_markdown.clone();
        meeting.key_decisions = summary.key_decisions.clone();
        meeting.action_items = summary.action_items.clone();
        meeting.topics = summary.topics.clone();
        meeting.email_draft = summary.email_draft.clone();
        summary
    }

    async fn feed_audio(&self, bytes: &[u8]) {
        let mut session = self.session.lock().await;
        let packets = session.parser.feed(bytes);
        let recording = matches!(session.state, SessionState::Recording);
        let live_whisper = session.transcription_provider != "sarvam";
        let meeting_id = session.current.as_ref().map(|m| m.id.clone());
        let mut jobs = Vec::new();

        for AudioPacket { stream_id, pcm, .. } in packets {
            let level = audio::rms(&pcm);
            if stream_id == STREAM_MIC {
                session.mic_rms = level;
            } else {
                session.system_rms = level;
            }

            // Audio is metered whenever it arrives, but only a live meeting is
            // segmented and transcribed.
            if let (true, true, Some(id)) = (recording, live_whisper, meeting_id.as_ref()) {
                let utterances = if stream_id == STREAM_MIC {
                    session.mic_vad.feed(&pcm)
                } else {
                    session.system_vad.feed(&pcm)
                };
                for utterance in utterances {
                    jobs.push(TranscriptionJob {
                        meeting_id: id.clone(),
                        stream_id,
                        utterance,
                    });
                }
            }
        }

        let mic = session.mic_rms;
        let system = session.system_rms;
        drop(session);

        self.emit(
            "audio_level",
            json!({"mic":mic*100.0,"system":system*100.0}),
        )
        .await;
        self.queue_transcriptions(jobs).await;
    }

    async fn queue_transcriptions(&self, jobs: Vec<TranscriptionJob>) {
        for job in jobs {
            let channel = channel_name(job.stream_id);
            let (start_ms, end_ms) = (job.utterance.start_ms, job.utterance.end_ms);

            self.pending_transcriptions.fetch_add(1, Ordering::SeqCst);
            if self.transcriptions.send(job).is_err() {
                self.pending_transcriptions.fetch_sub(1, Ordering::SeqCst);
                continue;
            }

            self.emit(
                "speech_segment",
                json!({"channel": channel, "startMs": start_ms, "endMs": end_ms}),
            )
            .await;
        }
    }

    async fn drain_transcriptions(&self, budget: Duration) {
        let deadline = SystemTime::now() + budget;
        while self.pending_transcriptions.load(Ordering::SeqCst) > 0 && SystemTime::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Attach a transcribed utterance to the meeting it belongs to and tell the
    /// clients about it.
    async fn add_note(&self, meeting_id: &str, text: &str) -> Result<Value, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("A note needs some text".into());
        }
        if trimmed.chars().count() > 4000 {
            return Err("A note is limited to 4000 characters".into());
        }

        let created_at = now_ms();
        let mut note = json!({
            "id": Uuid::new_v4().to_string(),
            "text": trimmed,
            "createdAt": created_at,
            "atMs": 0,
        });

        {
            let mut session = self.session.lock().await;
            if let Some(meeting) = session.current.as_mut() {
                if meeting.id == meeting_id {
                    note["atMs"] = json!((created_at - meeting.started_at).max(0));
                    meeting.notes.push(note.clone());
                    let snapshot = meeting.clone();
                    drop(session);
                    self.emit("note_added", json!({"meetingId": meeting_id, "note": note}))
                        .await;
                    let _ = self.store.put(snapshot).await;
                    return Ok(note);
                }
            }
        }

        let mut meeting = self
            .store
            .get(meeting_id)
            .await
            .ok_or_else(|| "Meeting not found".to_string())?;
        note["atMs"] = json!((created_at - meeting.started_at).max(0));
        meeting.notes.push(note.clone());
        self.store
            .put(meeting)
            .await
            .map_err(|cause| cause.to_string())?;
        self.emit("note_added", json!({"meetingId": meeting_id, "note": note}))
            .await;
        Ok(note)
    }

    async fn remove_note(&self, meeting_id: &str, note_id: &str) -> Result<(), String> {
        {
            let mut session = self.session.lock().await;
            if let Some(meeting) = session.current.as_mut() {
                if meeting.id == meeting_id {
                    meeting
                        .notes
                        .retain(|note| note.get("id").and_then(Value::as_str) != Some(note_id));
                    let snapshot = meeting.clone();
                    drop(session);
                    let _ = self.store.put(snapshot).await;
                    return Ok(());
                }
            }
        }

        let mut meeting = self
            .store
            .get(meeting_id)
            .await
            .ok_or_else(|| "Meeting not found".to_string())?;
        meeting
            .notes
            .retain(|note| note.get("id").and_then(Value::as_str) != Some(note_id));
        self.store
            .put(meeting)
            .await
            .map_err(|cause| cause.to_string())
    }

    async fn commit_turn(&self, job: &TranscriptionJob, text: String, language: Option<String>) {
        let turn = TranscriptTurn {
            id: Uuid::new_v4().to_string(),
            channel: channel_name(job.stream_id).to_string(),
            // The core has no diarization yet, so remote audio is one voice.
            speaker: if job.stream_id == STREAM_MIC {
                "You"
            } else {
                "Others"
            }
            .to_string(),
            start_ms: job.utterance.start_ms,
            end_ms: job.utterance.end_ms,
            text,
            confidence: 1.0,
            language,
        };

        let snapshot = {
            let mut session = self.session.lock().await;
            match session.current.as_mut() {
                Some(meeting) if meeting.id == job.meeting_id => {
                    meeting.transcript.push(turn.clone());
                    Some(meeting.clone())
                }
                _ => None,
            }
        };

        if let Some(meeting) = snapshot {
            let _ = self.store.put(meeting).await;
        }

        self.emit(
            "transcript_turn",
            serde_json::to_value(&turn).unwrap_or_else(|_| json!({})),
        )
        .await;
    }
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let port = env::var("CORE_BACKEND_PORT")
        .or_else(|_| env::var("PORT"))
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let host = env::var("CORE_BACKEND_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let listener = TcpListener::bind((host.as_str(), port)).await?;
    let (events, _) = broadcast::channel(256);
    let (transcriptions, mut transcription_queue) = mpsc::unbounded_channel::<TranscriptionJob>();
    let stt = Arc::new(SttService::detect());
    let sarvam = Arc::new(SarvamService::detect());
    let summarizer = Arc::new(SummaryService::detect());
    let podcast = Arc::new(PodcastService::detect());
    let settings = Arc::new(SettingsStore::load().await);
    let calendar = Arc::new(CalendarService::new(settings.clone(), events.clone()));

    // Saved choices have to be applied before the first request, or the engine
    // runs its defaults while the UI shows what the user picked last time.
    if let Some(language) = settings.get_str("sttLanguage").await {
        if let Err(cause) = stt.set_language(&language).await {
            eprintln!("[Alpha Core Backend] stored sttLanguage ignored: {cause}");
        }
    }
    if let Some(model) = settings.get_str("whisperModel").await {
        if let Err(cause) = stt.set_model(&model).await {
            eprintln!("[Alpha Core Backend] stored whisperModel ignored: {cause}");
        }
    }
    if let Some(model) = settings.get_str("aiModel").await {
        if let Err(cause) = summarizer.set_model(&model).await {
            eprintln!("[Alpha Core Backend] stored aiModel ignored: {cause}");
        }
    }
    // An explicit ALPHA_SUMMARY_PROVIDER is a deliberate override, so a stored
    // preference must not quietly replace it.
    if env::var("ALPHA_SUMMARY_PROVIDER").is_err() {
        if let Some(provider) = settings.get_str("summaryProvider").await {
            if let Err(cause) = summarizer.set_preference(&provider).await {
                eprintln!("[Alpha Core Backend] stored summaryProvider ignored: {cause}");
            }
        }
    }
    // An env key wins over a stored one, so a launcher can override without
    // rewriting the user's file.
    if env::var("ALPHA_GEMINI_API_KEY").is_err() {
        if let Some(key) = settings.gemini_key().await {
            summarizer.set_gemini_key(Some(key.clone())).await;
            podcast.set_gemini_key(Some(key)).await;
        }
    }
    if env::var("ALPHA_SARVAM_API_KEY").is_err() {
        if let Some(key) = settings.sarvam_key().await {
            sarvam.set_api_key(Some(key)).await;
        }
    }

    let state = AppState {
        started_at: now_ms(),
        session: Arc::new(Mutex::new(Session::default())),
        store: Store::load().await,
        events,
        stt: stt.clone(),
        sarvam: sarvam.clone(),
        summarizer: summarizer.clone(),
        transcriptions,
        pending_transcriptions: Arc::new(AtomicUsize::new(0)),
        settings: settings.clone(),
        calendar: calendar.clone(),
        podcast: podcast.clone(),
    };

    // One worker drains the queue, so a long utterance's parts are transcribed
    // and emitted in the order they were spoken.
    let worker_state = state.clone();
    tokio::spawn(async move {
        while let Some(job) = transcription_queue.recv().await {
            let wav = audio::encode_wav(&job.utterance.pcm, 16_000);
            match worker_state.stt.transcribe(wav).await {
                Ok(transcription) => {
                    if let Some(speech) = strip_non_speech(&transcription.text) {
                        worker_state
                            .commit_turn(&job, speech, transcription.language)
                            .await;
                    }
                }
                Err(cause) => eprintln!("[Alpha Core Backend] transcription failed: {cause}"),
            }
            worker_state
                .pending_transcriptions
                .fetch_sub(1, Ordering::SeqCst);
        }
    });

    // Load the model at boot rather than on the first meeting, so the very first
    // sentence of a recording is transcribed instead of being spent on warm-up.
    if settings.get_str("transcriptionProvider").await.as_deref() != Some("sarvam") {
        let warm_stt = stt.clone();
        tokio::spawn(async move { warm_stt.ensure_ready().await });
    }

    let shutdown_stt = stt.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            shutdown_stt.shutdown().await;
            std::process::exit(0);
        }
    });

    println!("[Alpha Core Backend] Rust API listening on http://{host}:{port}");
    println!(
        "[Alpha Core Backend] transcription engine: {}",
        stt.status_value().await
    );
    println!(
        "[Alpha Core Backend] summary engine: {}",
        summarizer.status_value().await
    );
    loop {
        let (stream, _) = listener.accept().await?;
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(err) = handle_connection(stream, state).await {
                eprintln!("[Rust Core Backend] connection error: {err}");
            }
        });
    }
}

async fn handle_connection(mut stream: TcpStream, state: AppState) -> io::Result<()> {
    let request = read_http_request(&mut stream).await?;
    if request
        .headers
        .get("upgrade")
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
        && request.path == "/ws"
    {
        return websocket_session(
            stream,
            request
                .headers
                .get("sec-websocket-key")
                .map(String::as_str)
                .unwrap_or(""),
            state,
        )
        .await;
    }
    let (status, content_type, body) = route(&request, &state).await;
    let response = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nAccess-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS\r\nConnection: close\r\n\r\n", body.len());
    stream.write_all(response.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await
}

struct HttpRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn read_http_request(stream: &mut TcpStream) -> io::Result<HttpRequest> {
    let mut buffer = Vec::with_capacity(4096);
    let mut header_end = None;
    loop {
        let mut chunk = [0u8; 2048];
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = Some(pos + 4);
            break;
        }
        if buffer.len() > 1024 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request headers too large",
            ));
        }
    }
    let header_end = header_end
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "incomplete request"))?;
    let header_text = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/");
    let mut headers = HashMap::new();
    for line in lines.filter(|l| !l.is_empty()) {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_lowercase(), value.trim().to_string());
        }
    }
    let content_length = headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let mut chunk = vec![0u8; content_length - body.len()];
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let (path, query) = parse_target(target);
    Ok(HttpRequest {
        method,
        path,
        query,
        headers,
        body: body[..body.len().min(content_length)].to_vec(),
    })
}

fn parse_target(target: &str) -> (String, HashMap<String, String>) {
    let (path, query_text) = target.split_once('?').unwrap_or((target, ""));
    let query = query_text
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| (k.to_string(), percent_decode(v)))
        .collect();
    (path.to_string(), query)
}
fn percent_decode(value: &str) -> String {
    value
        .replace('+', " ")
        .split('%')
        .enumerate()
        .map(|(i, part)| {
            if i == 0 {
                part.to_string()
            } else {
                u8::from_str_radix(&part[..2.min(part.len())], 16)
                    .ok()
                    .map(|b| (b as char).to_string())
                    .unwrap_or_default()
                    + &part[2.min(part.len())..]
            }
        })
        .collect()
}
fn json_response(status: u16, value: Value) -> (u16, &'static str, String) {
    (status, "application/json; charset=utf-8", value.to_string())
}

async fn route(req: &HttpRequest, state: &AppState) -> (u16, &'static str, String) {
    if req.method == "OPTIONS" {
        return (204, "text/plain", String::new());
    }
    let body: Value = serde_json::from_slice(&req.body).unwrap_or_else(|_| json!({}));
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/health") => json_response(
            200,
            json!({"status":"ok","version":VERSION,"uptimeSeconds":((now_ms()-state.started_at).max(0)/1000),"state":state.session.lock().await.state.as_str(),"stt":state.stt_status(None).await,"podcast":state.podcast.status_value().await}),
        ),
        ("GET", "/api/status") => json_response(200, state.status().await),
        ("GET", "/api/meetings") => {
            let limit = req
                .query
                .get("limit")
                .and_then(|v| v.parse().ok())
                .unwrap_or(50);
            let offset = req
                .query
                .get("offset")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            json_response(
                200,
                json!({"meetings":state.store.list(req.query.get("search").map(String::as_str).unwrap_or(""),limit,offset).await}),
            )
        }
        ("POST", "/api/meetings/start") => match state.start(&body).await {
            Ok(m) => json_response(200, json!({"success":true,"meeting":m})),
            Err(e) => json_response(409, json!({"error":e})),
        },
        ("POST", "/api/meetings/pause") => {
            let mut s = state.session.lock().await;
            if matches!(s.state, SessionState::Recording) {
                s.state = SessionState::Paused;
            }
            json_response(200, json!({"success":true,"state":s.state.as_str()}))
        }
        ("POST", "/api/meetings/resume") => {
            let mut s = state.session.lock().await;
            if matches!(s.state, SessionState::Paused) {
                s.state = SessionState::Recording;
            }
            json_response(200, json!({"success":true,"state":s.state.as_str()}))
        }
        ("POST", "/api/meetings/stop") => match state.finish(&body).await {
            Ok(m) => json_response(200, json!({"success":true,"meeting":m})),
            Err(e) => json_response(409, json!({"error":e})),
        },
        ("GET", "/api/license/status") => json_response(
            200,
            json!({"tier":"free","status":"active","canRecord":true,"usage":{"meetingsThisMonth":0}}),
        ),
        ("POST", "/api/license/activate") => json_response(
            200,
            json!({"success":false,"error":"License verification is not implemented in the Rust core yet."}),
        ),
        ("GET", "/api/settings") => {
            // The stored settings are the answer; the live engine fills in the two
            // it owns so a first run (nothing saved yet) still reports the truth.
            let stt = state.stt.status_value().await;
            let mut settings = state.settings.public_value().await;
            for (key, value) in [
                ("whisperModel", &stt["model"]),
                ("sttLanguage", &stt["language"]),
            ] {
                if settings.get(key).is_none() {
                    settings[key] = value.clone();
                }
            }
            if settings.get("transcriptionProvider").is_none() {
                settings["transcriptionProvider"] = json!("whisper");
            }
            if settings.get("sarvamLanguage").is_none() {
                settings["sarvamLanguage"] = json!("unknown");
            }
            if settings.get("sarvamMode").is_none() {
                settings["sarvamMode"] = json!("transcribe");
            }
            json_response(200, json!({"settings": settings}))
        }
        ("POST", "/api/settings") => {
            let incoming = body
                .get("settings")
                .cloned()
                .unwrap_or_else(|| body.clone());
            let Some(object) = incoming.as_object() else {
                return json_response(400, json!({"error": "settings must be an object"}));
            };
            let mut warnings = Vec::new();

            if let Some(provider) = object.get("transcriptionProvider").and_then(Value::as_str) {
                if !matches!(
                    provider.trim().to_ascii_lowercase().as_str(),
                    "whisper" | "sarvam"
                ) {
                    return json_response(
                        400,
                        json!({"error": format!("Unknown transcription provider '{provider}'")}),
                    );
                }
            }
            if let Some(mode) = object.get("sarvamMode").and_then(Value::as_str) {
                if let Err(cause) = (BatchConfig {
                    mode: mode.into(),
                    ..Default::default()
                })
                .validate()
                {
                    return json_response(400, json!({"error": cause}));
                }
            }
            if let Some(value) = object.get("sarvamNumSpeakers") {
                if !value.is_null() {
                    let Some(count) = value.as_i64() else {
                        return json_response(
                            400,
                            json!({"error": "Sarvam speaker count must be a number or automatic"}),
                        );
                    };
                    if !(1..=20).contains(&count) {
                        return json_response(
                            400,
                            json!({"error": "Sarvam speaker count must be between 1 and 20"}),
                        );
                    }
                }
            }

            // Apply to the running engine first: a value it rejects should not be
            // stored, or the next restart would fail the same way with no warning.
            if let Some(language) = object.get("sttLanguage").and_then(Value::as_str) {
                if let Err(cause) = state.stt.set_language(language).await {
                    warnings.push(cause);
                }
            }
            if let Some(model) = object.get("whisperModel").and_then(Value::as_str) {
                if let Err(cause) = state.stt.set_model(model).await {
                    warnings.push(cause);
                }
            }
            if let Some(model) = object.get("aiModel").and_then(Value::as_str) {
                if let Err(cause) = state.summarizer.set_model(model).await {
                    warnings.push(cause);
                }
            }
            if let Some(provider) = object.get("summaryProvider").and_then(Value::as_str) {
                match state.summarizer.set_preference(provider).await {
                    // Asking for a provider that cannot run is worth saying out
                    // loud, rather than silently summarising some other way.
                    Ok(resolved) => {
                        let asked = provider.trim().to_ascii_lowercase();
                        if asked != "auto" && resolved.as_str() != asked {
                            warnings.push(format!(
                                "'{provider}' cannot run here, so summaries will use {} instead",
                                resolved.as_str()
                            ));
                        }
                    }
                    Err(cause) => warnings.push(cause),
                }
            }

            for provider in ["google", "microsoft"] {
                for suffix in ["ClientId", "ClientSecret"] {
                    let field = format!("{provider}Calendar{suffix}");
                    if let Some(value) = object.get(&field).and_then(Value::as_str) {
                        if let Err(cause) = state.settings.set_credential(&field, Some(value)).await {
                            warnings.push(format!("could not store {field}: {cause}"));
                        }
                    }
                }
            }

            if let Some(key) = object.get("geminiApiKey").and_then(Value::as_str) {
                match state.settings.set_gemini_key(Some(key)).await {
                    Ok(stored) => {
                        state.summarizer.set_gemini_key(stored.clone()).await;
                        state.podcast.set_gemini_key(stored).await;
                    }
                    Err(cause) => warnings.push(format!("could not store the Gemini key: {cause}")),
                }
            }
            if let Some(key) = object.get("sarvamApiKey").and_then(Value::as_str) {
                match state.settings.set_sarvam_key(Some(key)).await {
                    Ok(stored) => state.sarvam.set_api_key(stored).await,
                    Err(cause) => warnings.push(format!("could not store the Sarvam key: {cause}")),
                }
            }

            let (rejected, written) = state.settings.merge(object).await;
            for key in rejected {
                warnings.push(format!("'{key}' is not a setting this backend stores"));
            }
            if let Err(cause) = written {
                warnings.push(format!("could not save settings: {cause}"));
            }

            json_response(
                200,
                json!({
                    "success": warnings.is_empty(),
                    "warnings": warnings,
                    "settings": state.settings.public_value().await,
                    "stt": state.stt_status(None).await,
                    "summary": state.summarizer.status_value().await,
                }),
            )
        }
        ("POST", "/api/stt/config") => {
            if let Some(language) = body.get("language").and_then(Value::as_str) {
                if let Err(cause) = state.stt.set_language(language).await {
                    return json_response(400, json!({"error": cause}));
                }
            }
            if let Some(model) = body.get("model").and_then(Value::as_str) {
                if let Err(cause) = state.stt.set_model(model).await {
                    return json_response(400, json!({"error": cause}));
                }
            }
            json_response(
                200,
                json!({"success": true, "stt": state.stt.status_value().await}),
            )
        }
        ("POST", "/api/summary/config") => {
            if let Some(model) = body.get("model").and_then(Value::as_str) {
                if let Err(cause) = state.summarizer.set_model(model).await {
                    return json_response(400, json!({"error": cause}));
                }
            }
            json_response(
                200,
                json!({"success": true, "summary": state.summarizer.status_value().await}),
            )
        }
        ("GET", "/api/podcast/status") => {
            json_response(200, state.podcast.status_value().await)
        }
        ("GET", "/api/calendar/status") => json_response(200, state.calendar.status().await),
        ("POST", "/api/calendar/connect") => {
            let provider = body.get("provider").and_then(Value::as_str).unwrap_or_default();
            match state.calendar.begin(provider).await {
                Ok(value) => json_response(200, value),
                Err(cause) => json_response(400, json!({"error": cause})),
            }
        }
        ("POST", "/api/calendar/disconnect") => {
            let provider = body.get("provider").and_then(Value::as_str).unwrap_or_default();
            match state.calendar.disconnect(provider).await {
                Ok(()) => json_response(200, json!({"success": true, "provider": provider})),
                Err(cause) => json_response(400, json!({"error": cause})),
            }
        }
        ("GET", "/api/calendar/events") => {
            let back = req
                .query
                .get("minutesBack")
                .and_then(|v| v.parse().ok())
                .unwrap_or(15);
            let ahead = req
                .query
                .get("minutesAhead")
                .and_then(|v| v.parse().ok())
                .unwrap_or(720);
            json_response(200, state.calendar.events(back, ahead).await)
        }
        ("GET", "/api/search") => {
            let q = req.query.get("q").map(String::as_str).unwrap_or("");
            json_response(
                200,
                json!({"results":state.store.list(q,req.query.get("limit").and_then(|v|v.parse().ok()).unwrap_or(50),0).await}),
            )
        }
        _ if req.path.starts_with("/api/podcasts/") => route_podcast(req, state, &body).await,
        _ => route_meeting(req, state, &body).await,
    }
}

async fn route_podcast(
    req: &HttpRequest,
    state: &AppState,
    body: &Value,
) -> (u16, &'static str, String) {
    let parts: Vec<_> = req.path.trim_matches('/').split('/').collect();
    if parts.len() != 4 || parts[0] != "api" || parts[1] != "podcasts" {
        return json_response(404, json!({"error": "Not found"}));
    }
    let project_id = parts[2];
    match (req.method.as_str(), parts[3]) {
        ("POST", "script") => {
            let transcript_value = if let Some(transcript) = body.get("transcript") {
                transcript.clone()
            } else if let Some(meeting_id) = body.get("meetingId").and_then(Value::as_str) {
                match state.store.get(meeting_id).await {
                    Some(meeting) => serde_json::to_value(
                        meeting.transcript.into_iter().map(|turn| PodcastSourceTurn {
                            id: turn.id,
                            speaker: turn.speaker,
                            start_ms: turn.start_ms,
                            text: turn.text,
                        }).collect::<Vec<_>>()
                    ).unwrap_or_else(|_| json!([])),
                    None => return json_response(404, json!({"error": "Source meeting not found"})),
                }
            } else {
                json!([])
            };
            let transcript: Vec<PodcastSourceTurn> = match serde_json::from_value(transcript_value) {
                Ok(value) => value,
                Err(cause) => return json_response(400, json!({"error": format!("Podcast transcript is invalid: {cause}")})),
            };
            let hosts: Vec<PodcastHost> = match serde_json::from_value(body.get("hosts").cloned().unwrap_or_else(|| json!([
                {"id":"host-a","name":"Avery","voice":"Kore"},
                {"id":"host-b","name":"Riley","voice":"Puck"}
            ]))) {
                Ok(value) => value,
                Err(cause) => return json_response(400, json!({"error": format!("Podcast hosts are invalid: {cause}")})),
            };
            let request = PodcastScriptRequest {
                project_id: project_id.to_string(),
                title: body.get("title").and_then(Value::as_str).unwrap_or("Untitled podcast").to_string(),
                language: body.get("language").and_then(Value::as_str).unwrap_or("auto").to_string(),
                hosts,
                transcript,
            };
            state.emit("podcast_job_progress", json!({"projectId":project_id,"job":"script","status":"running","progress":0.05})).await;
            match state.podcast.generate_script(&request).await {
                Ok(script) => {
                    state.emit("podcast_job_progress", json!({"projectId":project_id,"job":"script","status":"completed","progress":1.0})).await;
                    json_response(200, json!({"success":true,"script":script}))
                }
                Err(cause) => {
                    state.emit("podcast_job_progress", json!({"projectId":project_id,"job":"script","status":"failed","error":cause})).await;
                    json_response(502, json!({"error":cause}))
                }
            }
        }
        ("POST", "voice") => {
            state.emit("podcast_job_progress", json!({"projectId":project_id,"job":"voice","status":"running","progress":0.05})).await;
            match state.podcast.generate_audio(project_id).await {
                Ok(value) => {
                    state.emit("podcast_job_progress", json!({"projectId":project_id,"job":"voice","status":"completed","progress":1.0})).await;
                    json_response(200, value)
                }
                Err(cause) => {
                    state.emit("podcast_job_progress", json!({"projectId":project_id,"job":"voice","status":"failed","error":cause})).await;
                    json_response(502, json!({"error":cause}))
                }
            }
        }
        ("POST", "transcribe") => {
            let Some(relative) = body.get("assetPath").and_then(Value::as_str) else {
                return json_response(400, json!({"error":"assetPath is required"}));
            };
            let source = match state.podcast.resolve_asset(project_id, relative) {
                Ok(path) => path,
                Err(cause) => return json_response(400, json!({"error":cause})),
            };
            state.emit("podcast_job_progress", json!({"projectId":project_id,"job":"transcribe","status":"running","progress":0.02})).await;
            match transcribe_podcast_asset(state, project_id, &source).await {
                Ok(turns) => {
                    state.emit("podcast_job_progress", json!({"projectId":project_id,"job":"transcribe","status":"completed","progress":1.0})).await;
                    json_response(200, json!({"success":true,"transcript":turns}))
                }
                Err(cause) => {
                    state.emit("podcast_job_progress", json!({"projectId":project_id,"job":"transcribe","status":"failed","error":cause})).await;
                    json_response(502, json!({"error":cause}))
                }
            }
        }
        _ => json_response(404, json!({"error": "Podcast route not found"})),
    }
}

async fn transcribe_podcast_asset(
    state: &AppState,
    project_id: &str,
    source: &Path,
) -> Result<Vec<PodcastSourceTurn>, String> {
    let scratch = env::temp_dir().join(format!("alpha-podcast-transcribe-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&scratch)
        .await
        .map_err(|cause| format!("could not create transcription workspace: {cause}"))?;
    let pattern = scratch.join("chunk-%05d.wav");
    let ffmpeg = env::var("ALPHA_FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".into());
    let output = Command::new(ffmpeg)
        .args(["-y", "-v", "error", "-i"])
        .arg(source)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "segment", "-segment_time", "60", "-reset_timestamps", "1"])
        .arg(&pattern)
        .output()
        .await
        .map_err(|cause| format!("could not start FFmpeg for transcription: {cause}"))?;
    if !output.status.success() {
        let _ = tokio::fs::remove_dir_all(&scratch).await;
        return Err(format!("FFmpeg could not prepare the podcast audio: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let mut entries = tokio::fs::read_dir(&scratch)
        .await
        .map_err(|cause| format!("could not read transcription chunks: {cause}"))?;
    let mut chunks = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|cause| cause.to_string())? {
        if entry.path().extension().and_then(|value| value.to_str()) == Some("wav") {
            chunks.push(entry.path());
        }
    }
    chunks.sort();
    let total = chunks.len().max(1);
    let mut turns = Vec::new();
    for (index, chunk) in chunks.iter().enumerate() {
        let wav = tokio::fs::read(chunk).await.map_err(|cause| format!("could not read podcast audio chunk: {cause}"))?;
        let result = state.stt.transcribe(wav).await?;
        if let Some(text) = strip_non_speech(&result.text) {
            turns.push(PodcastSourceTurn {
                id: format!("import-{index:05}"),
                speaker: "Speaker".into(),
                start_ms: index as i64 * 60_000,
                text,
            });
        }
        state.emit("podcast_job_progress", json!({"projectId":project_id,"job":"transcribe","status":"running","progress":(index + 1) as f64 / total as f64})).await;
    }
    let _ = tokio::fs::remove_dir_all(&scratch).await;
    state.podcast.save_transcript(project_id, &turns).await?;
    Ok(turns)
}

async fn route_meeting(
    req: &HttpRequest,
    state: &AppState,
    body: &Value,
) -> (u16, &'static str, String) {
    let parts: Vec<_> = req.path.trim_matches('/').split('/').collect();
    if parts.len() >= 3 && parts[0] == "api" && parts[1] == "meetings" {
        let id = parts[2];
        if req.method == "POST" && parts.len() == 4 && parts[3] == "notes" {
            let text = body.get("text").and_then(Value::as_str).unwrap_or_default();
            return match state.add_note(id, text).await {
                Ok(note) => json_response(200, json!({"success": true, "note": note})),
                Err(cause) => json_response(400, json!({"error": cause})),
            };
        }
        if req.method == "DELETE" && parts.len() == 5 && parts[3] == "notes" {
            return match state.remove_note(id, parts[4]).await {
                Ok(()) => json_response(200, json!({"success": true})),
                Err(cause) => json_response(404, json!({"error": cause})),
            };
        }
        if req.method == "PATCH" && parts.len() == 3 {
            let Some(mut meeting) = state.store.get(id).await else {
                return json_response(404, json!({"error":"Meeting not found"}));
            };
            let Some(renames) = body.get("speakerRenames").and_then(Value::as_object) else {
                return json_response(400, json!({"error":"speakerRenames must be an object"}));
            };
            let changed = match rename_meeting_speakers(&mut meeting, renames) {
                Ok(changed) => changed,
                Err(cause) => return json_response(400, json!({"error": cause})),
            };
            if let Err(cause) = state.store.put(meeting.clone()).await {
                return json_response(500, json!({"error": cause.to_string()}));
            }
            return json_response(
                200,
                json!({"success":true,"changedTurns":changed,"meeting":meeting}),
            );
        }
        if req.method == "DELETE" && parts.len() == 3 {
            return match state.store.delete(id).await {
                Ok(_) => json_response(200, json!({"success":true})),
                Err(e) => json_response(500, json!({"error":e.to_string()})),
            };
        }
        if req.method == "GET" && parts.len() == 3 {
            return match state.store.get(id).await {
                Some(m) => json_response(
                    200,
                    json!({"meeting":m,"transcriptTurns":m.transcript,"actionItems":m.action_items}),
                ),
                None => json_response(404, json!({"error":"Meeting not found"})),
            };
        }
        if req.method == "POST" && parts.get(3) == Some(&"summarize") {
            let Some(mut meeting) = state.store.get(id).await else {
                return json_response(404, json!({"error":"Meeting not found"}));
            };

            let regenerate = body
                .get("regenerate")
                .and_then(Value::as_bool)
                .or_else(|| {
                    req.query
                        .get("regenerate")
                        .map(|v| !matches!(v.as_str(), "0" | "false" | "no"))
                })
                .unwrap_or(false);

            let mut provider = "stored".to_string();
            let mut warning = None;
            if !meeting.transcript.is_empty() && (regenerate || meeting.summary_markdown.is_empty())
            {
                let summary = state.summarize_into(&mut meeting).await;
                provider = summary.provider;
                warning = summary.warning;
                if let Err(cause) = state.store.put(meeting.clone()).await {
                    return json_response(500, json!({"error": cause.to_string()}));
                }
            }

            return json_response(
                200,
                json!({"success":true,"summary":{"rawMarkdown":meeting.summary_markdown,"actionItems":meeting.action_items,"keyDecisions":meeting.key_decisions,"topics":meeting.topics,"emailDraft":meeting.email_draft,"provider":provider,"warning":warning}}),
            );
        }
        if req.method == "GET" && parts.get(3) == Some(&"export") {
            if let Some(m) = state.store.get(id).await {
                let format = req
                    .query
                    .get("format")
                    .map(String::as_str)
                    .unwrap_or("json");
                let text = if format == "md" {
                    export_markdown(&m)
                } else {
                    serde_json::to_string_pretty(&m).unwrap_or_default()
                };
                return (
                    200,
                    if format == "md" {
                        "text/markdown; charset=utf-8"
                    } else {
                        "application/json; charset=utf-8"
                    },
                    text,
                );
            }
        }
    }
    json_response(404, json!({"error":"Not Found"}))
}

fn export_markdown(meeting: &Meeting) -> String {
    let mut out = format!("# {}\n\n", meeting.title);
    out.push_str(&format!(
        "**Duration:** {} seconds\n\n",
        meeting.duration_seconds
    ));
    if !meeting.summary_markdown.is_empty() {
        out.push_str(&format!("## Summary\n\n{}\n\n", meeting.summary_markdown));
    }
    if !meeting.key_decisions.is_empty() {
        out.push_str("## Key Decisions\n\n");
        for decision in &meeting.key_decisions {
            out.push_str(&format!("- {decision}\n"));
        }
        out.push('\n');
    }
    if !meeting.action_items.is_empty() {
        out.push_str("## Action Items\n\n");
        for item in &meeting.action_items {
            let task = item.get("task").and_then(Value::as_str).unwrap_or("");
            let owner = item
                .get("owner")
                .and_then(Value::as_str)
                .unwrap_or("Unassigned");
            let deadline = item
                .get("deadline")
                .and_then(Value::as_str)
                .unwrap_or("TBD");
            out.push_str(&format!("- **{owner}** — {task} ({deadline})\n"));
        }
        out.push('\n');
    }
    if !meeting.email_draft.is_empty() {
        out.push_str(&format!(
            "## Follow-Up Email\n\n{}\n\n",
            meeting.email_draft
        ));
    }
    if !meeting.transcript.is_empty() {
        out.push_str("## Transcript\n\n");
        for t in &meeting.transcript {
            out.push_str(&format!("**{}**: {}\n\n", t.speaker, t.text));
        }
    }
    out
}

async fn websocket_session(mut stream: TcpStream, key: &str, state: AppState) -> io::Result<()> {
    let accept = websocket_accept(key);
    let response=format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n");
    stream.write_all(response.as_bytes()).await?;
    let mut receiver = state.events.subscribe();
    let initial =
        json!({"type":"connection_established","status":state.status().await}).to_string();
    write_ws_text(&mut stream, &initial).await?;
    loop {
        tokio::select! { event=receiver.recv()=>{if let Ok(event)=event {write_ws_text(&mut stream,&event).await?;}}, frame=read_ws_frame(&mut stream)=>{match frame? { Some(WsFrame::Close)=>break,Some(WsFrame::Binary(bytes))=>state.feed_audio(&bytes).await,Some(WsFrame::Text(text))=>handle_ws_message(&state,&text).await,Some(WsFrame::Ping(payload))=>write_ws_pong(&mut stream,&payload).await?,None=>break}} }
    }
    Ok(())
}

async fn handle_ws_message(state: &AppState, text: &str) {
    if let Ok(mut msg) = serde_json::from_str::<Value>(text) {
        let action = msg
            .get("action")
            .or_else(|| msg.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let payload = msg
            .get_mut("payload")
            .cloned()
            .unwrap_or_else(|| msg.clone());
        match action.as_str() {
            "start_meeting" => {
                let _ = state.start(&payload).await;
            }
            "pause_meeting" => {
                let mut s = state.session.lock().await;
                if matches!(s.state, SessionState::Recording) {
                    s.state = SessionState::Paused;
                }
            }
            "resume_meeting" => {
                let mut s = state.session.lock().await;
                if matches!(s.state, SessionState::Paused) {
                    s.state = SessionState::Recording;
                }
            }
            "stop_meeting" => {
                let _ = state.finish(&payload).await;
            }
            "get_status" => {
                state.emit("status_update", state.status().await).await;
            }
            _ => {}
        }
    }
}

enum WsFrame {
    Text(String),
    Binary(Vec<u8>),
    Ping(Vec<u8>),
    Close,
}
async fn read_ws_frame(stream: &mut TcpStream) -> io::Result<Option<WsFrame>> {
    let mut head = [0u8; 2];
    if stream.read_exact(&mut head).await.is_err() {
        return Ok(None);
    };
    let opcode = head[0] & 0x0f;
    let masked = head[1] & 0x80 != 0;
    let mut len = (head[1] & 0x7f) as usize;
    if len == 126 {
        let mut b = [0u8; 2];
        stream.read_exact(&mut b).await?;
        len = u16::from_be_bytes(b) as usize
    } else if len == 127 {
        let mut b = [0u8; 8];
        stream.read_exact(&mut b).await?;
        len = u64::from_be_bytes(b) as usize;
        if len > 16 * 1024 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "websocket frame too large",
            ));
        }
    }
    let mut mask = [0u8; 4];
    if masked {
        stream.read_exact(&mut mask).await?;
    }
    let mut data = vec![0u8; len];
    stream.read_exact(&mut data).await?;
    if masked {
        for (i, b) in data.iter_mut().enumerate() {
            *b ^= mask[i % 4];
        }
    }
    Ok(Some(match opcode {
        1 => WsFrame::Text(String::from_utf8_lossy(&data).into()),
        2 => WsFrame::Binary(data),
        8 => WsFrame::Close,
        9 => WsFrame::Ping(data),
        _ => return Ok(None),
    }))
}
async fn write_ws_text(stream: &mut TcpStream, text: &str) -> io::Result<()> {
    write_ws_frame(stream, 1, text.as_bytes()).await
}
async fn write_ws_pong(stream: &mut TcpStream, data: &[u8]) -> io::Result<()> {
    write_ws_frame(stream, 10, data).await
}
async fn write_ws_frame(stream: &mut TcpStream, opcode: u8, data: &[u8]) -> io::Result<()> {
    let mut frame = Vec::with_capacity(data.len() + 10);
    frame.push(0x80 | opcode);
    match data.len() {
        0..=125 => frame.push(data.len() as u8),
        126..=65535 => {
            frame.push(126);
            frame.extend_from_slice(&(data.len() as u16).to_be_bytes())
        }
        _ => {
            frame.push(127);
            frame.extend_from_slice(&(data.len() as u64).to_be_bytes())
        }
    }
    frame.extend_from_slice(data);
    stream.write_all(&frame).await
}

fn websocket_accept(key: &str) -> String {
    let mut input = key.as_bytes().to_vec();
    input.extend_from_slice(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    BASE64.encode(sha1(&input))
}
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut msg = data.to_vec();
    let bit_len = (msg.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0)
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    let mut h = [
        0x67452301u32,
        0xEFCDAB89,
        0x98BADCFE,
        0x10325476,
        0xC3D2E1F0,
    ];
    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 80];
        for (i, b) in chunk.chunks_exact(4).enumerate().take(16) {
            w[i] = u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1)
        }
        let (a0, b0, c0, d0, e0) = (h[0], h[1], h[2], h[3], h[4]);
        let (mut a, mut b, mut c, mut d, mut e) = (a0, b0, c0, d0, e0);
        for (i, &word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e)
    }
    let mut out = [0u8; 20];
    for (i, v) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes())
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real record from `.alpha-meeting-assistant/meetings.json`, written before
    /// turns carried a language and before meetings carried a recording. There are
    /// 24 of these on the author's machine; if they stop deserialising, the whole
    /// history silently loads as empty.
    const LEGACY_MEETING: &str = r#"{
        "id": "bb6f2d56-0000-0000-0000-000000000000",
        "title": "probe",
        "startedAt": 1787232456163,
        "endedAt": 1787232497817,
        "durationSeconds": 41,
        "summaryMarkdown": "Meeting **probe** completed with 6 spoken turns across You.",
        "actionItems": [{"deadline": "TBD", "owner": "You", "task": "I will do a bully, yes."}],
        "keyDecisions": [],
        "topics": [],
        "emailDraft": "",
        "metadata": {},
        "transcript": [{
            "id": "69b4b928-0000-0000-0000-000000000000",
            "channel": "mic",
            "speaker": "You",
            "startMs": 8280,
            "endMs": 11580,
            "text": "Gracias.",
            "confidence": 1.0
        }],
        "createdAt": 1787232456163
    }"#;

    #[test]
    fn legacy_meetings_still_load() {
        let meeting: Meeting =
            serde_json::from_str(LEGACY_MEETING).expect("a stored meeting must still parse");
        assert_eq!(meeting.title, "probe");
        assert_eq!(meeting.transcript.len(), 1);
        assert_eq!(meeting.transcript[0].text, "Gracias.");
        // The new fields are absent, not zero-valued nonsense.
        assert!(meeting.recording.is_none());
        assert!(meeting.transcript[0].language.is_none());
    }

    #[test]
    fn a_record_without_the_newer_optional_fields_round_trips() {
        let meeting: Meeting = serde_json::from_str(LEGACY_MEETING).unwrap();
        let written = serde_json::to_string(&meeting).unwrap();

        // `skip_serializing_if` keeps absent fields absent rather than writing
        // nulls back into every stored record.
        assert!(!written.contains("\"recording\""));
        assert!(!written.contains("\"language\""));

        let reparsed: Meeting = serde_json::from_str(&written).unwrap();
        assert_eq!(reparsed.id, meeting.id);
        assert_eq!(reparsed.transcript.len(), 1);
    }

    #[test]
    fn a_recording_descriptor_survives_a_round_trip() {
        let mut meeting: Meeting = serde_json::from_str(LEGACY_MEETING).unwrap();
        meeting.recording = Some(json!({
            "videoPath": "abc/screen.webm",
            "startedAtMs": 1787232457000i64,
            "durationMs": 40000,
            "bytes": 211199,
            "hasSystemAudio": true
        }));
        meeting.transcript[0].language = Some("es".into());

        let reparsed: Meeting =
            serde_json::from_str(&serde_json::to_string(&meeting).unwrap()).unwrap();
        assert_eq!(
            reparsed.recording.as_ref().unwrap()["videoPath"],
            "abc/screen.webm"
        );
        assert_eq!(reparsed.recording.as_ref().unwrap()["hasSystemAudio"], true);
        assert_eq!(reparsed.transcript[0].language.as_deref(), Some("es"));
    }

    #[test]
    fn speaker_renames_update_every_matching_turn_and_reject_blank_names() {
        let mut meeting: Meeting = serde_json::from_str(LEGACY_MEETING).unwrap();
        meeting.transcript.push(TranscriptTurn {
            id: "second".into(),
            channel: "mixed".into(),
            speaker: "Speaker 1".into(),
            start_ms: 12_000,
            end_ms: 13_000,
            text: "Hello".into(),
            confidence: 1.0,
            language: None,
        });
        meeting.transcript.push(TranscriptTurn {
            id: "third".into(),
            channel: "mixed".into(),
            speaker: "Speaker 1".into(),
            start_ms: 14_000,
            end_ms: 15_000,
            text: "Again".into(),
            confidence: 1.0,
            language: None,
        });

        let renames = json!({"Speaker 1":"Riya"}).as_object().unwrap().clone();
        assert_eq!(rename_meeting_speakers(&mut meeting, &renames).unwrap(), 2);
        assert_eq!(meeting.transcript[1].speaker, "Riya");
        assert_eq!(meeting.transcript[2].speaker, "Riya");

        let blank = json!({"Riya":"  "}).as_object().unwrap().clone();
        assert!(rename_meeting_speakers(&mut meeting, &blank).is_err());
    }

    #[test]
    fn sarvam_can_only_read_recordings_under_the_trusted_root() {
        let scratch = env::temp_dir().join(format!("alpha-sarvam-path-{}", Uuid::new_v4()));
        let root = scratch.join("recordings");
        let meeting = root.join("meeting-id");
        let outside = scratch.join("outside.webm");
        std::fs::create_dir_all(&meeting).unwrap();
        std::fs::write(meeting.join("screen.webm"), b"recording").unwrap();
        std::fs::write(&outside, b"private").unwrap();

        let resolved = resolve_batch_recording(&root, Path::new("meeting-id/screen.webm")).unwrap();
        assert_eq!(
            resolved,
            std::fs::canonicalize(meeting.join("screen.webm")).unwrap()
        );
        assert!(resolve_batch_recording(&root, Path::new("../outside.webm")).is_err());
        assert!(resolve_batch_recording(&root, &outside).is_err());

        std::fs::remove_dir_all(scratch).unwrap();
    }

    #[test]
    fn every_stored_meeting_in_the_repo_data_file_parses() {
        // Guards against a schema change that would drop real history. Skipped
        // when the file is absent, so a clean checkout still passes.
        let path = std::path::Path::new(".alpha-meeting-assistant/meetings.json");
        let Ok(bytes) = std::fs::read(path) else {
            return;
        };
        let meetings: Vec<Meeting> = serde_json::from_slice(&bytes)
            .expect("every stored meeting must parse with the current schema");
        assert!(!meetings.is_empty());
        for meeting in &meetings {
            assert!(!meeting.id.is_empty());
        }
    }
}
