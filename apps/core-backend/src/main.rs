use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env, io,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{broadcast, mpsc, Mutex, Notify, RwLock, Semaphore},
};
use uuid::Uuid;

use kesami_core_backend::{
    audio::{self, AudioPacket, PacketParser, STREAM_MIC, STREAM_SYSTEM},
    denoise::NoiseSuppressor,
    dsp,
    echo::EchoWindow,
    transcript::strip_non_speech,
    vad::SpeechDetector,
    voiceprint::{VoiceRoster, Voiceprint},
};

mod calendar;
use calendar::CalendarService;
mod connectors;
mod mcp;
use connectors::ConnectorService;

mod security;
use futures_util::{SinkExt, StreamExt};
use security::{
    bearer_or_protocol_token, SecurityConfig, MAX_BODY_BYTES, MAX_HEADER_BYTES, MAX_WS_BYTES,
};
use tokio_tungstenite::{
    tungstenite::{
        protocol::{Role, WebSocketConfig},
        Message,
    },
    WebSocketStream,
};

mod accounts;
mod billing;
mod google_auth;
mod plans;
mod supabase;
mod supabase_auth;
use accounts::AccountStore;
use supabase::SupabaseDb;

mod chat;
mod library;
mod podcast;
mod sarvam;
mod sarvam_live;
mod settings;
mod speakers;
mod summarizer;
mod workspace;
use library::Library;
use podcast::{
    Host as PodcastHost, PodcastService, ScriptRequest as PodcastScriptRequest,
    SourceTurn as PodcastSourceTurn,
};
use sarvam::{identify_mic_speaker, label_speakers, BatchConfig, SarvamService};
use sarvam_live::{LiveConfig, LiveEvent, LiveTranscriber};
use settings::SettingsStore;
use speakers::{clean_name, clean_names, DiarizedSpan, NumberedSpeakers, SpeechLog};
use summarizer::{MeetingSummary, SummaryNote, SummaryRequest, SummaryService, SummaryTurn};

const VERSION: &str = "2.0.0-rust";
const DEFAULT_PORT: u16 = 48900;
/// How long a stopping meeting waits for Sarvam to return the transcripts it
/// still owes for audio already streamed to it.
const LIVE_FLUSH_BUDGET: Duration = Duration::from_secs(10);
/// After the meeting client reports the meeting ended (or we left it), wait
/// this long for a rejoin or the UI's own stop before finishing the meeting
/// here, so an accidental leave click does not kill the recording.
const MEETING_END_GRACE: Duration = Duration::from_secs(8);
/// The meeting client is expected to report every couple of seconds; when its
/// reports stop arriving mid-recording the tab was closed or the machine lost
/// the meeting, which counts as the meeting ending.
const CLIENT_DROPOUT: Duration = Duration::from_secs(15);
/// One unscheduled-call notice per meeting URL per cooldown, no matter how
/// often the browser re-reports the same call.
const UNSCHEDULED_COOLDOWN_MS: i64 = 10 * 60 * 1000;
const BILLING_MIRROR_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Whether an idle observation warrants an unscheduled-call notice: the first
/// one for a key, a different meeting, or the same one after the cooldown.
fn unscheduled_notice_due(last: &Option<(String, i64)>, key: &str, now_ms: i64) -> bool {
    match last {
        Some((last_key, at)) => *last_key != key || now_ms - *at > UNSCHEDULED_COOLDOWN_MS,
        None => true,
    }
}

/// A report from the meeting client that the call is over, waiting out the
/// rejoin grace before the meeting is finished here. `deadline` is `None` when
/// auto-stop is disabled: the fact is recorded but nothing acts on it.
struct PendingClientEnd {
    source: String,
    reason: String,
    deadline: Option<Instant>,
}

fn speaker_name(stream_id: u32) -> &'static str {
    if stream_id == STREAM_MIC {
        "You"
    } else {
        "Speaker 1"
    }
}

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

/// Local-time start of the current calendar month, for the free tier's
/// monthly recording allowance.
fn month_start_ms() -> i64 {
    use chrono::{Datelike, TimeZone};
    let now = chrono::Local::now();
    chrono::Local
        .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .single()
        .map(|month_start| month_start.timestamp_millis())
        .unwrap_or(0)
}

fn invited_names(metadata: &Value) -> Vec<String> {
    let mut names = calendar_attendees(metadata);
    for observed in clean_names(metadata.get("participants")) {
        if !names.iter().any(|known| known.contains(&observed)) {
            names.push(observed);
        }
    }
    names
}

fn calendar_attendees(metadata: &Value) -> Vec<String> {
    metadata
        .pointer("/calendarEvent/attendees")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|person| {
                    let field = |key: &str| {
                        person
                            .get(key)
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                    };
                    match (field("name"), field("email")) {
                        (Some(name), Some(email)) => Some(format!("{name} <{email}>")),
                        (Some(name), None) => Some(name.to_string()),
                        (None, Some(email)) => Some(email.to_string()),
                        (None, None) => None,
                    }
                })
                .collect()
        })
        .unwrap_or_default()
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
    #[serde(default)]
    summary_sections: Vec<Value>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    folder: Option<String>,
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
    live: Option<LiveTranscriber>,
    mic_speech: Vec<(i64, i64)>,
    participants: SpeechLog,
    speaker_labels: NumberedSpeakers,
    voices: VoiceRoster,
    mic_epoch_ms: Option<i64>,
    system_epoch_ms: Option<i64>,
    denoiser: Option<NoiseSuppressor>,
    echo: EchoWindow,
    echo_suppression: bool,
    system_samples: i64,
    mic_samples: i64,
    // Meeting-client signals from the browser extension (see
    // observe_participants): whether the local mic is muted in the call, when
    // its reports last arrived, a pending end waiting out the rejoin grace,
    // and the last unscheduled-call notice for the idle prompt.
    client_mic_muted: Option<bool>,
    client_last_seen: Option<Instant>,
    client_end: Option<PendingClientEnd>,
    last_unscheduled_notice: Option<(String, i64)>,
    /// Entitlement tier decided when this meeting started. `finish` reads it
    /// because the stop can arrive from routes, the socket, or the watchdog —
    /// none of which carry the account's session token.
    meeting_tier: String,
}

#[derive(Clone)]
struct Store {
    library: Arc<RwLock<Library>>,
    meetings: Arc<RwLock<HashMap<String, Meeting>>>,
}

impl Store {
    async fn load() -> Self {
        let mut library = Library::new(library::root_from_env());
        let mut meetings = library.load().await;
        meetings.extend(library.import_from(&library::legacy_file()).await);
        println!(
            "[Kesami Core Backend] meeting library: {} ({} meeting folders)",
            library.root().display(),
            meetings.len()
        );
        Self {
            library: Arc::new(RwLock::new(library)),
            meetings: Arc::new(RwLock::new(
                meetings
                    .into_iter()
                    .map(|meeting| (meeting.id.clone(), meeting))
                    .collect(),
            )),
        }
    }

    async fn put(&self, mut meeting: Meeting) -> io::Result<Meeting> {
        self.library.write().await.save(&mut meeting).await?;
        self.meetings
            .write()
            .await
            .insert(meeting.id.clone(), meeting.clone());
        Ok(meeting)
    }

    async fn put_documents(&self, meeting: &Meeting) -> io::Result<()> {
        self.library.read().await.save_documents(meeting).await
    }

    async fn adopt_recording(&self, meeting: &mut Meeting) -> io::Result<bool> {
        let root = kesami_core_backend::env_compat::var_os("KESAMI_RECORDINGS_DIR").map(PathBuf::from);
        self.library
            .read()
            .await
            .adopt_recording(meeting, root.as_deref())
            .await
    }
    async fn get(&self, id: &str) -> Option<Meeting> {
        self.meetings.read().await.get(id).cloned()
    }
    async fn delete(&self, id: &str) -> io::Result<bool> {
        let removed = self.meetings.write().await.remove(id).is_some();
        let discarded = self.library.write().await.remove(id).await?;
        Ok(removed || discarded)
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
                } else if (channel == "system" && supplied == Some("You"))
                    || matches!(supplied, None | Some("") | Some("Others") | Some("Speaker"))
                {
                    "Speaker 1".into()
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

fn remote_identity(participants: &SpeechLog, start_ms: i64, end_ms: i64) -> Option<String> {
    participants
        .speaker_during(start_ms, end_ms)
        .filter(|name| Some(name.as_str()) != participants.self_name())
}

fn remember_speech(intervals: &mut Vec<(i64, i64)>, start_ms: i64, end_ms: i64) {
    if end_ms <= start_ms {
        return;
    }
    match intervals.last_mut() {
        Some(last) if start_ms <= last.1 => last.1 = last.1.max(end_ms),
        _ => intervals.push((start_ms, end_ms)),
    }
}

fn shift_intervals(intervals: &[(i64, i64)], offset_ms: i64) -> Vec<(i64, i64)> {
    intervals
        .iter()
        .map(|(start, end)| (start - offset_ms, end - offset_ms))
        .collect()
}

async fn deliver_to_connector(
    connectors: &ConnectorService,
    store: &Store,
    events: &broadcast::Sender<String>,
    meeting_id: &str,
    meeting: &Value,
    provider: &str,
) -> Result<Value, String> {
    let delivery = connectors.send(provider, meeting).await;
    record_deliveries(store, events, meeting_id, &[(provider, delivery.clone())], false).await?;
    Ok(delivery)
}

async fn record_deliveries(
    store: &Store,
    events: &broadcast::Sender<String>,
    meeting_id: &str,
    deliveries: &[(&str, Value)],
    automatic: bool,
) -> Result<(), String> {
    if let Some(mut latest) = store.get(meeting_id).await {
        let mut recorded = latest
            .metadata
            .get("connectorDeliveries")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        for (provider, delivery) in deliveries {
            recorded[*provider] = delivery.clone();
        }
        set_meeting_metadata(&mut latest, "connectorDeliveries", recorded);
        store.put(latest).await.map_err(|error| error.to_string())?;
    }
    for (_, delivery) in deliveries {
        let _ = events.send(
            json!({
                "type": "connector_delivery",
                "data": {"meetingId": meeting_id, "delivery": delivery, "automatic": automatic},
                "timestamp": now_ms(),
            })
            .to_string(),
        );
    }
    Ok(())
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
    let root = kesami_core_backend::env_compat::var_os("KESAMI_RECORDINGS_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| {
            "Sarvam batch transcription is available from the Kesami desktop app".to_string()
        })?;
    resolve_batch_recording(&root, relative)
}

fn resolve_batch_recording(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    if relative.is_absolute() {
        return Err("the recording path must be relative to Kesami's recording directory".into());
    }
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|cause| format!("could not open Kesami's recording directory: {cause}"))?;
    let candidate = std::fs::canonicalize(root.join(relative))
        .map_err(|cause| format!("could not open the completed meeting recording: {cause}"))?;
    if !candidate.starts_with(&canonical_root) || !candidate.is_file() {
        return Err("the meeting recording is outside Kesami's recording directory".into());
    }
    Ok(candidate)
}

#[derive(Clone)]
struct AppState {
    started_at: i64,
    session: Arc<Mutex<Session>>,
    store: Store,
    events: broadcast::Sender<String>,
    security: Arc<SecurityConfig>,
    sarvam: Arc<SarvamService>,
    summarizer: Arc<SummaryService>,
    settings: Arc<SettingsStore>,
    calendar: Arc<CalendarService>,
    connectors: Arc<ConnectorService>,
    podcast: Arc<PodcastService>,
    chat: Arc<chat::ChatService>,
    accounts: Arc<AccountStore>,
    billing: Arc<billing::BillingStore>,
    billing_config: billing::ProviderConfig,
    supabase: Arc<SupabaseDb>,
    supabase_auth: Arc<supabase_auth::SupabaseAuth>,
    billing_mirror: Arc<Notify>,
}

impl AppState {
    async fn stt_status(&self, active_provider: Option<&str>) -> Value {
        let configured = match active_provider.filter(|value| !value.is_empty()) {
            Some(provider) => provider.to_string(),
            None => self
                .settings
                .get_str("transcriptionProvider")
                .await
                .unwrap_or_else(|| "sarvam-realtime".into()),
        };
        let mut status = json!({
            "engine": "sarvam", "status": if self.sarvam.has_key().await { "ready" } else { "unavailable" },
            "available": self.sarvam.has_key().await, "model": sarvam_live::model_name(),
            "language": self.settings.get_str("sarvamLanguage").await.unwrap_or_else(|| "unknown".into()),
            "pending": 0,
        });
        status["provider"] = json!(configured);
        status["sarvam"] = self.sarvam.status_value().await;
        if configured == "sarvam-realtime" {
            let diarize = self
                .settings
                .get_bool("sarvamDiarizeAfterMeeting")
                .await
                .unwrap_or(true)
                && !self.security.hosted;
            status["sarvam"]["mode"] = json!("realtime");
            status["sarvam"]["model"] = json!(sarvam_live::model_name());
            status["sarvam"]["diarization"] = json!(diarize);
            status["sarvam"]["diarizationAfterMeeting"] = json!(diarize);
        }
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
        let participants = json!({
            "source": session.participants.source(),
            "names": session.participants.roster(),
            "observations": session.participants.observations(),
        });
        let state = json!({ "state": session.state.as_str(), "meetingId": session.current.as_ref().map(|m| &m.id), "meetingTitle": session.current.as_ref().map(|m| &m.title), "durationSeconds": session.current.as_ref().map(|m| (now_ms() - m.started_at).max(0) / 1000).unwrap_or(0), "turnsCount": turns, "audioLevels": { "mic": session.mic_rms * 100.0, "system": session.system_rms * 100.0 }, "clientMicMuted": session.client_mic_muted, "meetingEndPending": session.client_end.as_ref().map(|end| json!({"source": end.source, "reason": end.reason})) });
        drop(session);

        let mut status = state;
        status["participants"] = participants;
        status["stt"] = self.stt_status(Some(&session_provider)).await;
        status["summary"] = self.summarizer.status_value().await;
        status["podcast"] = json!({"enabled":false,"status":"disabled"});
        status["supabase"] = self.supabase.status_value().await;
        status
    }

    async fn emit(&self, kind: &str, data: Value) {
        let _ = self
            .events
            .send(json!({"type": kind, "data": data, "timestamp": now_ms()}).to_string());
    }

    async fn session_account(&self, req: &HttpRequest) -> Option<accounts::AccountPublic> {
        let token = bearer_or_protocol_token(&req.headers, false)?;
        self.accounts.session_account(&token).await
    }

    /// The entitlement tier of the request's account session. Anonymous and
    /// unrecognized callers are the free tier.
    async fn session_tier(&self, req: &HttpRequest) -> &'static str {
        let Some(account) = self.session_account(req).await else {
            return "free";
        };
        let subscription = self.billing.active_subscription(&account.id).await;
        billing::tier_for(subscription.as_ref())
    }

    async fn mirror_billing_to_supabase(&self) {
        loop {
            if let Err(error) = self.supabase.mirror_billing(&self.billing, &self.accounts).await {
                eprintln!("[Kesami Core Backend] Supabase billing: {error}");
            }
            tokio::select! {
                _ = self.billing_mirror.notified() => {}
                _ = tokio::time::sleep(BILLING_MIRROR_INTERVAL) => {}
            }
        }
    }

    /// Recording minutes already stored in the current calendar month. Every
    /// account on one backend shares the meeting library, so the free
    /// allowance is per backend rather than per account.
    async fn month_minutes_used(&self) -> i64 {
        let month_start = month_start_ms();
        self.store
            .meetings
            .read()
            .await
            .values()
            .filter(|meeting| meeting.started_at >= month_start)
            .map(|meeting| meeting.duration_seconds.max(0))
            .sum::<i64>()
            / 60
    }

    async fn start(&self, payload: &Value, tier: &'static str) -> Result<Meeting, String> {
        let provider = self
            .settings
            .get_str("transcriptionProvider")
            .await
            .unwrap_or_else(|| "sarvam-realtime".into())
            .trim()
            .to_ascii_lowercase();
        if !matches!(provider.as_str(), "sarvam" | "sarvam-realtime") {
            return Err(format!("Unknown transcription provider '{provider}'"));
        }
        if self.security.hosted && provider == "sarvam" {
            return Err("Hosted meetings require Sarvam realtime; batch transcription needs a recording on the backend machine.".into());
        }
        if provider.starts_with("sarvam") && !self.sarvam.has_key().await {
            return Err(if self.security.hosted {
                "Transcription is unavailable because this Kesami service has no Sarvam API key. Contact the workspace administrator."
            } else {
                "Transcription is unavailable because this Mac's Kesami backend has no Sarvam API key. Configure KESAMI_SARVAM_API_KEY in the backend's .env.local and restart Kesami."
            }
            .into());
        }
        let live_config = match provider.as_str() {
            "sarvam-realtime" => Some(
                LiveConfig {
                    language: self
                        .settings
                        .get_str("sarvamLanguage")
                        .await
                        .unwrap_or_default(),
                    mode: self
                        .settings
                        .get_str("sarvamMode")
                        .await
                        .unwrap_or_else(|| "transcribe".into()),
                    ..LiveConfig::default()
                }
                .validate()?,
            ),
            _ => None,
        };

        let noise_suppression = self.settings.get_bool("noiseSuppression").await != Some(false);
        let echo_suppression = self.settings.get_bool("echoSuppression").await != Some(false);

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
        session.mic_speech.clear();
        session.participants = SpeechLog::default();
        // A new meeting starts with no meeting-client knowledge: the browser
        // has to report again before dropout watching or client mute apply.
        session.client_mic_muted = None;
        session.client_last_seen = None;
        session.client_end = None;
        session.speaker_labels = NumberedSpeakers::default();
        session.voices = VoiceRoster::default();
        session.mic_epoch_ms = None;
        session.system_epoch_ms = None;
        session.denoiser = noise_suppression.then(NoiseSuppressor::new);
        session.echo = EchoWindow::default();
        session.echo_suppression = echo_suppression;
        session.system_samples = 0;
        session.mic_samples = 0;
        session.transcription_provider = provider.clone();
        session.meeting_tier = tier.to_string();
        let now = now_ms();

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
            summary_sections: vec![],
            action_items: vec![],
            key_decisions: vec![],
            topics: vec![],
            email_draft: String::new(),
            metadata,
            recording: None,
            notes: vec![],
            transcript: vec![],
            created_at: now,
            folder: None,
        };
        self.store
            .put(meeting.clone())
            .await
            .map_err(|e| e.to_string())?;
        session.current = Some(meeting.clone());
        if let Some(config) = live_config {
            let (sender, receiver) = mpsc::unbounded_channel();
            let key = self.sarvam.api_key().await.unwrap_or_default();
            session.live = Some(LiveTranscriber::start(
                key,
                config,
                &[STREAM_MIC, STREAM_SYSTEM],
                sender,
            ));
            let consumer = self.clone();
            let meeting_id = meeting.id.clone();
            tokio::spawn(async move { consumer.consume_live_events(meeting_id, receiver).await });
        }
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
        // Realtime closes its sockets; batch waits for the complete recording.
        let mut tail_voice = None;
        let (provider, live, mic_speech, participants) = {
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
                "sarvam-realtime".to_string()
            } else {
                session.transcription_provider.clone()
            };

            let mic_epoch = session.mic_epoch_ms.unwrap_or(0);
            let system_epoch = session.system_epoch_ms.unwrap_or(0);

            if let Some(mut utterance) = session.mic_vad.flush() {
                utterance.start_ms += mic_epoch;
                utterance.end_ms += mic_epoch;
                remember_speech(
                    &mut session.mic_speech,
                    utterance.start_ms,
                    utterance.end_ms,
                );
            }
            if let Some(mut utterance) = session.system_vad.flush() {
                utterance.start_ms += system_epoch;
                utterance.end_ms += system_epoch;
                tail_voice = Some((utterance.start_ms, utterance.end_ms, utterance.pcm.clone()));
            }
            let mic_speech = std::mem::take(&mut session.mic_speech);
            let started_at = session
                .current
                .as_ref()
                .map(|meeting| meeting.started_at)
                .unwrap_or_else(now_ms);
            let mut participants = std::mem::take(&mut session.participants);
            participants.close((now_ms() - started_at).max(0));
            let mic_tail = session.echo.flush_microphone();
            let live = session.live.take();
            if let Some(live) = live.as_ref() {
                if !mic_tail.is_empty() {
                    live.feed(STREAM_MIC, &mic_tail);
                }
            }
            (provider, live, mic_speech, participants)
        };

        self.emit(
            "state_change",
            json!({"newState":"PROCESSING_STT","oldState":"RECORDING","provider":provider}),
        )
        .await;

        self.learn_voices(tail_voice.into_iter().collect()).await;
        if let Some(live) = live {
            live.finish(LIVE_FLUSH_BUDGET).await;
        }

        let mut session = self.session.lock().await;
        let mut meeting = session
            .current
            .clone()
            .ok_or("No meeting session is active")?;

        // The shell reports where it wrote the screen recording, if it made one.
        // It owns those files; the meeting record only needs to be able to find them.
        if let Some(recording) = payload.get("recording").filter(|_| !self.security.hosted) {
            meeting.recording = recording.as_object().map(|_| recording.clone());
        }

        // Live backend turns win; retain the renderer fallback for older clients.
        if meeting.transcript.is_empty() {
            meeting.transcript = posted_transcript(payload);
        }
        let ended = now_ms();
        meeting.ended_at = Some(ended);
        meeting.duration_seconds = ((ended - meeting.started_at).max(0)) / 1000;
        session.current = Some(meeting.clone());
        drop(session);

        let mut transcription_warning = None;
        let diarize_recording = !self.security.hosted
            && (provider == "sarvam"
                || (provider == "sarvam-realtime"
                    && self.settings.get_bool("sarvamDiarizeAfterMeeting").await != Some(false)));
        if diarize_recording {
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
                    let spans: Vec<DiarizedSpan> = batch
                        .turns
                        .iter()
                        .map(|turn| DiarizedSpan {
                            speaker_id: turn.speaker_id.clone(),
                            start_ms: recording_offset + turn.start_ms,
                            end_ms: recording_offset + turn.end_ms,
                        })
                        .collect();
                    let self_name = participants.self_name().map(str::to_string);
                    let observed = participants.attribute(&spans, &[], &[]);
                    let mic_speaker = identify_mic_speaker(
                        &batch.turns,
                        &shift_intervals(&mic_speech, recording_offset),
                    )
                    .or_else(|| {
                        // A confident active-speaker match from the meeting client
                        // can identify self when the microphone timing is ambiguous.
                        observed.iter().find_map(|(id, name)| {
                            (Some(name.as_str()) == self_name.as_deref()).then(|| id.clone())
                        })
                    });
                    let mut labels = label_speakers(&batch.turns, mic_speaker.as_deref());
                    let named = participants.attribute(
                        &spans,
                        &mic_speaker.as_deref().into_iter().collect::<Vec<_>>(),
                        &self_name.as_deref().into_iter().collect::<Vec<_>>(),
                    );
                    for (speaker_id, name) in named.iter() {
                        labels.insert(speaker_id.clone(), name.clone());
                    }
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
                    set_meeting_metadata(&mut meeting, "transcriptionProvider", json!(provider));
                    set_meeting_metadata(&mut meeting, "diarized", json!(true));
                    set_meeting_metadata(
                        &mut meeting,
                        "micSpeakerIdentified",
                        json!(mic_speaker.is_some()),
                    );
                    set_meeting_metadata(&mut meeting, "namedSpeakers", json!(named.len()));
                    self.emit(
                        "transcript_replaced",
                        json!({
                            "meetingId": meeting.id,
                            "turns": serde_json::to_value(&meeting.transcript)
                                .unwrap_or_else(|_| json!([])),
                        }),
                    )
                    .await;
                }
                Err(cause) => {
                    let cause = if provider == "sarvam-realtime" {
                        format!(
                            "{cause} — the live transcript was kept, without speaker separation"
                        )
                    } else {
                        cause
                    };
                    set_meeting_metadata(&mut meeting, "transcriptionWarning", json!(cause));
                    transcription_warning = Some(cause);
                }
            }
        }

        if !participants.is_empty() {
            for turn in meeting.transcript.iter_mut() {
                if turn.channel != "system" {
                    continue;
                }
                if let Some(name) = participants.speaker_during(turn.start_ms, turn.end_ms) {
                    if Some(name.as_str()) != participants.self_name() {
                        turn.speaker = name;
                    }
                }
            }
        }
        if !participants.roster().is_empty() {
            set_meeting_metadata(&mut meeting, "participants", json!(participants.roster()));
        }

        let mut session = self.session.lock().await;
        session.current = Some(meeting.clone());
        session.state = SessionState::Summarizing;
        // The lock is dropped for the (slow) summarize call below, so the
        // tier decided at meeting start is read out here.
        let meeting_tier = session.meeting_tier.clone();
        drop(session);
        self.emit(
            "state_change",
            json!({"newState":"SUMMARIZING","oldState":"PROCESSING_STT"}),
        )
        .await;

        // `autoSummarize: false` means "keep everything on device" — so do not
        // send the transcript anywhere, and do not fabricate notes either.
        // A free workspace can spend one of its shared monthly AI uses here.
        let mut free_auto_key = None;
        let summary = if self.settings.get_bool("autoSummarize").await == Some(false) {
            MeetingSummary {
                summary_markdown: String::new(),
                provider: "disabled".into(),
                ..Default::default()
            }
        } else if meeting_tier != "pro" {
            let key = format!("summary:auto:{}", meeting.id);
            match self.billing.reserve_free_ai_use(key.clone()).await {
                Ok(true) => {
                    let summary = self.summarize_into(&mut meeting).await;
                    if summary.summary_markdown.is_empty() {
                        self.billing.release_free_ai_use(key).await;
                    } else {
                        free_auto_key = Some(key);
                    }
                    summary
                }
                Ok(false) => MeetingSummary {
                    provider: "unavailable".into(),
                    warning: Some(plans::free_ai_limit_message()),
                    ..Default::default()
                },
                Err(_) => MeetingSummary {
                    provider: "unavailable".into(),
                    warning: Some("AI usage storage is unavailable. Please try again.".into()),
                    ..Default::default()
                },
            }
        } else {
            self.summarize_into(&mut meeting).await
        };

        let mut meeting = match self.store.put(meeting).await {
            Ok(meeting) => meeting,
            Err(error) => {
                if let Some(key) = free_auto_key { self.billing.release_free_ai_use(key).await; }
                return Err(error.to_string());
            }
        };
        if self
            .store
            .adopt_recording(&mut meeting)
            .await
            .unwrap_or(false)
        {
            meeting = self.store.put(meeting).await.map_err(|e| e.to_string())?;
        }
        if let Err(cause) = self.store.put_documents(&meeting).await {
            eprintln!("[Kesami Core Backend] could not write the meeting documents: {cause}");
        }

        let mut session = self.session.lock().await;
        session.current = Some(meeting.clone());
        session.state = SessionState::Completed;
        // Whatever the meeting client was reporting belongs to the finished
        // meeting, not to whatever the user records next.
        session.client_end = None;
        session.client_mic_muted = None;
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
        self.auto_push(&meeting).await;
        Ok(meeting)
    }

    async fn auto_push(&self, meeting: &Meeting) {
        let mut targets = self.connectors.auto_push_targets().await;
        if targets.is_empty() {
            return;
        }
        let Ok(value) = serde_json::to_value(meeting) else {
            return;
        };
        let notes = connectors::MeetingNotes::from_meeting(&value);
        targets.retain(|provider| notes.wants(provider));
        if targets.is_empty() {
            return;
        }
        let connectors = self.connectors.clone();
        let store = self.store.clone();
        let events = self.events.clone();
        let meeting_id = meeting.id.clone();
        tokio::spawn(async move {
            let sends = targets
                .iter()
                .map(|provider| async { (*provider, connectors.send(provider, &value).await) });
            let deliveries = futures_util::future::join_all(sends).await;
            if let Err(cause) = record_deliveries(&store, &events, &meeting_id, &deliveries, true).await {
                eprintln!("[Kesami Core Backend] auto-push to {targets:?} failed: {cause}");
            }
        });
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
                    id: t.id.clone(),
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
            attendees: invited_names(&meeting.metadata),
        };

        let summary = self.summarizer.summarize(&request).await;
        meeting.summary_markdown = summary.summary_markdown.clone();
        meeting.summary_sections = summary.summary_sections.clone();
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
        let provider = session.transcription_provider.clone();
        let live_sarvam = provider == "sarvam-realtime";
        let separate_voices = live_sarvam;
        // The meeting client has the ground truth on the local mic: while it
        // reports the mic muted, nothing from the mic stream may reach the
        // transcriber, the voiceprints or the speech log, whatever still
        // arrives over the socket.
        let client_mic_muted = session.client_mic_muted == Some(true);
        let meeting = session
            .current
            .as_ref()
            .map(|meeting| (meeting.id.clone(), meeting.started_at));
        let mut heard = Vec::new();

        for AudioPacket {
            stream_id,
            timestamp_ms,
            pcm,
        } in packets
        {
            let pcm = match session.denoiser.as_mut() {
                Some(denoiser) if stream_id == STREAM_MIC => denoiser.process(&pcm),
                _ => pcm,
            };

            let level = audio::rms(&pcm);
            if stream_id == STREAM_MIC {
                session.mic_rms = level;
            } else {
                session.system_rms = level;
            }

            if recording && live_sarvam && stream_id != STREAM_MIC {
                if let Some(live) = session.live.as_ref() {
                    live.feed(stream_id, &pcm);
                }
            }

            // Audio is metered whenever it arrives, but only a live meeting is
            // segmented and transcribed.
            if let (true, Some((_id, started_at))) = (recording, meeting.as_ref()) {
                let arrived = (timestamp_ms - started_at).max(0);
                let epoch = if stream_id == STREAM_MIC {
                    *session.mic_epoch_ms.get_or_insert(arrived)
                } else {
                    *session.system_epoch_ms.get_or_insert(arrived)
                };

                if stream_id != STREAM_MIC {
                    if session.echo_suppression {
                        let played_at =
                            epoch + session.system_samples * 1000 / dsp::SAMPLE_RATE as i64;
                        session.echo.append_played(played_at, &pcm);
                    }
                    session.system_samples += pcm.len() as i64 / 2;
                } else if live_sarvam && !client_mic_muted {
                    let heard_at = epoch + session.mic_samples * 1000 / dsp::SAMPLE_RATE as i64;
                    session.mic_samples += pcm.len() as i64 / 2;
                    if session.echo_suppression {
                        for window in session.echo.gate_microphone(heard_at, &pcm) {
                            if let Some(live) = session.live.as_ref() {
                                live.feed(STREAM_MIC, &window);
                            }
                        }
                    } else if let Some(live) = session.live.as_ref() {
                        live.feed(STREAM_MIC, &pcm);
                    }
                }

                let utterances = if stream_id == STREAM_MIC {
                    if client_mic_muted {
                        // Dropping the open utterance keeps the mute from
                        // gluing pre- and post-mute speech into one turn.
                        session.mic_vad.reset();
                        Vec::new()
                    } else {
                        session.mic_vad.feed(&pcm)
                    }
                } else if separate_voices {
                    session.system_vad.feed(&pcm)
                } else {
                    Vec::new()
                };

                for mut utterance in utterances {
                    utterance.start_ms += epoch;
                    utterance.end_ms += epoch;

                    if stream_id == STREAM_MIC {
                        if session.echo_suppression
                            && session.echo.is_echo(utterance.start_ms, &utterance.pcm)
                        {
                            continue;
                        }
                        remember_speech(
                            &mut session.mic_speech,
                            utterance.start_ms,
                            utterance.end_ms,
                        );
                    } else {
                        heard.push((utterance.start_ms, utterance.end_ms, utterance.pcm.clone()));
                    }
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
        self.learn_voices(heard).await;
    }

    async fn learn_voices(&self, heard: Vec<(i64, i64, Vec<u8>)>) {
        if heard.is_empty() {
            return;
        }
        let printed = tokio::task::spawn_blocking(move || {
            heard
                .into_iter()
                .filter_map(|(start_ms, end_ms, pcm)| {
                    Voiceprint::from_pcm(&pcm).map(|print| (start_ms, end_ms, print))
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();

        if printed.is_empty() {
            return;
        }
        let mut session = self.session.lock().await;
        for (start_ms, end_ms, print) in printed {
            session.voices.observe(&print, start_ms, end_ms);
        }
    }

    async fn observe_participants(&self, payload: &Value) -> Value {
        let roster = clean_names(payload.get("participants"));
        let speaking = clean_names(payload.get("speaking"));
        let source = payload
            .get("source")
            .and_then(Value::as_str)
            .and_then(clean_name);
        let self_name = payload
            .get("self")
            .and_then(Value::as_str)
            .and_then(clean_name);
        let mic_muted = payload.get("micMuted").and_then(Value::as_bool);
        let ended = payload.get("ended").and_then(Value::as_bool) == Some(true);
        let reason = payload
            .get("reason")
            .and_then(Value::as_str)
            .map(str::to_string);
        let url = payload
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        let mut session = self.session.lock().await;
        let state = session.state.as_str();

        // No meeting is running: a browser sitting in a call anyway is an
        // unscheduled call the record prompt should know about. One notice per
        // meeting URL per cooldown, so the heartbeat cannot spam it.
        if !matches!(
            session.state,
            SessionState::Starting
                | SessionState::Recording
                | SessionState::Paused
                | SessionState::ProcessingStt
                | SessionState::Summarizing
        ) {
            if !roster.is_empty() {
                let key = format!("{}|{url}", source.as_deref().unwrap_or_default());
                let now = now_ms();
                if unscheduled_notice_due(&session.last_unscheduled_notice, &key, now) {
                    session.last_unscheduled_notice = Some((key, now));
                    self.emit(
                        "unscheduled_call",
                        json!({"source": source, "url": url, "participants": roster}),
                    )
                    .await;
                }
            }
            return json!({"accepted": false, "state": state});
        }

        let Some((meeting_id, started_at)) = session
            .current
            .as_ref()
            .map(|meeting| (meeting.id.clone(), meeting.started_at))
        else {
            return json!({"accepted": false, "state": state});
        };

        session.client_last_seen = Some(Instant::now());

        // The meeting client is the source of truth for the local mic while
        // the call is running in it; the renderer hears this as `mic_muted`.
        if let Some(muted) = mic_muted {
            if session.client_mic_muted != Some(muted) {
                session.client_mic_muted = Some(muted);
                self.emit(
                    "mic_muted",
                    json!({"meetingId": meeting_id.clone(), "source": source.clone(), "muted": muted}),
                )
                .await;
            }
        }

        // A live observation without the end flag means the call carried on:
        // whatever ended-report is waiting out its grace is stale.
        if session.client_end.is_some() && !ended {
            session.client_end = None;
        }

        session.participants.set_source(source.clone());
        session.participants.set_self_name(self_name);
        session.participants.extend_roster(&roster);
        let recording = matches!(session.state, SessionState::Recording);
        if recording {
            session
                .participants
                .observe(&speaking, (now_ms() - started_at).max(0));
        }

        // The call itself is over (or we left it). Report it once and, if
        // auto-stop is on, wait out the rejoin grace before finishing here —
        // the UI will usually call the stop itself within the grace.
        let mut ended_report = None;
        if ended
            && matches!(
                session.state,
                SessionState::Recording | SessionState::Paused
            )
        {
            if session.client_end.is_none() {
                let reason = reason.clone().unwrap_or_else(|| "ended".into());
                let auto_stop = self.settings.get_bool("autoStopOnMeetingEnd").await != Some(false);
                session.client_end = Some(PendingClientEnd {
                    source: source.clone().unwrap_or_else(|| "meeting-client".into()),
                    reason: reason.clone(),
                    deadline: auto_stop.then(|| Instant::now() + MEETING_END_GRACE),
                });
                ended_report = Some(reason);
            }
        }

        let names = session.participants.roster().to_vec();
        let source = session.participants.source().map(str::to_string);
        if let Some(meeting) = session.current.as_mut() {
            set_meeting_metadata(meeting, "participants", json!(names));
            if let Some(participant_source) = source.as_deref() {
                set_meeting_metadata(meeting, "participantSource", json!(participant_source));
            }
        }
        drop(session);

        if let Some(reason) = ended_report {
            self.emit(
                "meeting_ended",
                json!({"meetingId": meeting_id.clone(), "source": source, "reason": reason}),
            )
            .await;
        }

        json!({
            "accepted": recording,
            "state": state,
            "meetingId": meeting_id,
            "participants": names,
        })
    }

    /// Watches the meeting-client signals while a recording is live: the
    /// dropout timeout on its reports, and the rejoin grace on a pending end
    /// report, finishing the meeting here when neither is cancelled in time.
    /// A meeting that never received a client report is never touched, so
    /// recordings made without the extension always run to their own stop.
    async fn watch_client_end(&self) {
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            let mut session = self.session.lock().await;
            if !matches!(
                session.state,
                SessionState::Recording | SessionState::Paused
            ) {
                session.client_end = None;
                session.client_mic_muted = None;
                continue;
            }

            // Reports stopped arriving mid-recording: the meeting is gone as
            // far as this machine is concerned.
            if session.client_end.is_none() {
                if matches!(session.state, SessionState::Recording) {
                    let dropped = session
                        .client_last_seen
                        .is_some_and(|seen| seen.elapsed() > CLIENT_DROPOUT);
                    if dropped {
                        let meeting_id = session
                            .current
                            .as_ref()
                            .map(|meeting| meeting.id.clone())
                            .unwrap_or_default();
                        let auto_stop =
                            self.settings.get_bool("autoStopOnMeetingEnd").await != Some(false);
                        session.client_end = Some(PendingClientEnd {
                            source: session
                                .participants
                                .source()
                                .unwrap_or("meeting-client")
                                .to_string(),
                            reason: "dropout".into(),
                            deadline: auto_stop.then(|| Instant::now() + MEETING_END_GRACE),
                        });
                        self.emit(
                            "meeting_ended",
                            json!({"meetingId": meeting_id, "source": session.client_end.as_ref().unwrap().source, "reason": "dropout"}),
                        )
                        .await;
                    }
                }
                continue;
            }

            let expired = session
                .client_end
                .as_ref()
                .and_then(|end| end.deadline)
                .is_some_and(|deadline| deadline <= Instant::now());
            if !expired {
                continue;
            }
            drop(session);
            // The rejoin grace ran out with the meeting still recording: end
            // it here the same way the UI's stop would. If the UI managed the
            // stop first, `finish` sees a session already processing and
            // returns the current meeting without doing anything.
            let _ = self.finish(&json!({})).await;
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
            .map(|_| ())
            .map_err(|cause| cause.to_string())
    }

    async fn commit_live_turn(
        &self,
        meeting_id: &str,
        stream_id: u32,
        start_ms: i64,
        end_ms: i64,
        text: String,
        language: Option<String>,
    ) {
        let mut turn = TranscriptTurn {
            id: Uuid::new_v4().to_string(),
            channel: channel_name(stream_id).to_string(),
            // The microphone is always the local user. Meeting audio is resolved
            // below, from the meeting client's active speaker when there is one,
            // and otherwise stays one provisional speaker until the post-meeting
            // pass separates the voices.
            speaker: speaker_name(stream_id).to_string(),
            start_ms,
            end_ms,
            text,
            confidence: 1.0,
            language,
        };

        let snapshot = {
            let mut session = self.session.lock().await;
            if session.current.as_ref().map(|meeting| meeting.id.as_str()) != Some(meeting_id) {
                return;
            }
            let epoch = if stream_id == STREAM_MIC {
                session.mic_epoch_ms
            } else {
                session.system_epoch_ms
            }
            .unwrap_or(0);
            turn.start_ms = start_ms + epoch;
            turn.end_ms = end_ms + epoch;

            if stream_id == STREAM_MIC {
                if session.echo_suppression
                    && session
                        .echo
                        .repeats_meeting_audio(turn.start_ms, &turn.text)
                {
                    return;
                }
            } else {
                let identity = remote_identity(&session.participants, turn.start_ms, turn.end_ms);
                turn.speaker = identity.unwrap_or_else(|| session.speaker_labels.label(None));
                if session.echo_suppression {
                    session.echo.remember_text(turn.start_ms, &turn.text);
                }
            }
            match session.current.as_mut() {
                Some(meeting) if meeting.id == meeting_id => {
                    meeting.transcript.push(turn.clone());
                    Some(meeting.clone())
                }
                _ => None,
            }
        };

        if let Some(meeting) = snapshot {
            let _ = self.store.put(meeting).await;
        }

        let mut event = serde_json::to_value(&turn).unwrap_or_else(|_| json!({}));
        event["meetingId"] = json!(meeting_id);
        self.emit("transcript_turn", event).await;
    }

    async fn remember_meeting_partial(&self, meeting_id: &str, text: &str) {
        let mut session = self.session.lock().await;
        if !session.echo_suppression {
            return;
        }
        let started_at = match session.current.as_ref() {
            Some(meeting) if meeting.id == meeting_id => meeting.started_at,
            _ => return,
        };
        let at_ms = (now_ms() - started_at).max(0);
        session.echo.remember_partial(at_ms, text);
    }

    async fn live_speaker(&self, stream_id: u32) -> String {
        if stream_id == STREAM_MIC {
            return speaker_name(stream_id).to_string();
        }
        let session = self.session.lock().await;
        if let Some(current) = session.participants.current_speaker() {
            return current;
        }
        session
            .speaker_labels
            .peek(None)
            .unwrap_or_else(|| speaker_name(stream_id))
            .to_string()
    }

    async fn consume_live_events(
        &self,
        meeting_id: String,
        mut events: mpsc::UnboundedReceiver<LiveEvent>,
    ) {
        while let Some(event) = events.recv().await {
            match event {
                LiveEvent::Partial { stream_id, text } => {
                    if stream_id != STREAM_MIC {
                        self.remember_meeting_partial(&meeting_id, &text).await;
                    }
                    let speaker = self.live_speaker(stream_id).await;
                    self.emit(
                        "transcript_interim",
                        json!({
                            "meetingId": meeting_id,
                            "channel": channel_name(stream_id),
                            "speaker": speaker,
                            "text": text,
                        }),
                    )
                    .await;
                }
                LiveEvent::Final {
                    stream_id,
                    text,
                    language,
                    start_ms,
                    end_ms,
                } => {
                    if let Some(speech) = strip_non_speech(&text) {
                        self.commit_live_turn(
                            &meeting_id,
                            stream_id,
                            start_ms,
                            end_ms,
                            speech,
                            language,
                        )
                        .await;
                    }
                }
                LiveEvent::Notice {
                    stream_id,
                    message,
                    fatal,
                } => {
                    eprintln!(
                        "[Kesami Core Backend] Sarvam realtime {}: {message}",
                        channel_name(stream_id)
                    );
                    if fatal {
                        self.emit(
                            "warning",
                            json!({"message": format!("Sarvam realtime transcription stopped: {message}")}),
                        )
                        .await;
                    }
                }
            }
        }
    }
}

#[tokio::main]
async fn main() -> io::Result<()> {
    // Local development configuration is intentionally opt-in and ignored by
    // Git. Existing process environment variables still win, which keeps
    // deployed secret injection and Electron's recording-path overrides intact.
    let _ = dotenvy::from_filename(".env.local")
        .or_else(|_| dotenvy::from_filename("apps/core-backend/.env.local"));
    settings::adopt_legacy_data_dir();
    library::adopt_legacy_root();
    if env::args().any(|arg| arg == "--migrate-users" || arg == "--migrate-billing") {
        // Only this explicit operator command reads development DB credentials.
        // Normal desktop startup never loads the owner connection from .env.
        let _ = dotenvy::from_filename(".env")
            .or_else(|_| dotenvy::from_filename("apps/core-backend/.env"));
        let database = SupabaseDb::detect();
        if env::args().any(|arg| arg == "--migrate-users") {
            database.migrate_users().await.map_err(io::Error::other)?;
            println!("Supabase public.users migration is applied.");
        }
        if env::args().any(|arg| arg == "--migrate-billing") {
            database.migrate_billing().await.map_err(io::Error::other)?;
            println!("Supabase public.billing and public.billing_events migration is applied.");
        }
        return Ok(());
    }
    let port = env::var("CORE_BACKEND_PORT")
        .or_else(|_| env::var("PORT"))
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let host = env::var("CORE_BACKEND_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let security = Arc::new(SecurityConfig::from_env(&host)?);
    let listener = TcpListener::bind((host.as_str(), port)).await?;
    let (events, _) = broadcast::channel(256);
    let sarvam = Arc::new(SarvamService::detect());
    let summarizer = Arc::new(SummaryService::detect());
    let podcast = Arc::new(PodcastService::detect());
    let settings = Arc::new(SettingsStore::load().await);
    let calendar = Arc::new(CalendarService::new(settings.clone(), events.clone()));

    // Saved choices have to be applied before the first request, or the engine
    // runs its defaults while the UI shows what the user picked last time.
    if let Some(model) = settings.get_str("aiModel").await {
        if let Err(cause) = summarizer.set_model(&model).await {
            eprintln!("[Kesami Core Backend] stored aiModel ignored: {cause}");
        }
    }
    // An explicit KESAMI_SUMMARY_PROVIDER is a deliberate override, so a stored
    // preference must not quietly replace it.
    if kesami_core_backend::env_compat::var("KESAMI_SUMMARY_PROVIDER").is_err() {
        if let Some(provider) = settings.get_str("summaryProvider").await {
            if let Err(cause) = summarizer.set_preference(&provider).await {
                eprintln!("[Kesami Core Backend] stored summaryProvider ignored: {cause}");
            }
        }
    }
    // An env key wins over a stored one, so a launcher can override without
    // rewriting the user's file.
    if kesami_core_backend::env_compat::var("KESAMI_GEMINI_API_KEY").is_err() {
        if let Some(key) = settings.gemini_key().await {
            summarizer.set_gemini_key(Some(key.clone())).await;
            podcast.set_gemini_key(Some(key)).await;
        }
    }
    if kesami_core_backend::env_compat::var("KESAMI_SARVAM_API_KEY").is_err() {
        if let Some(key) = settings.sarvam_key().await {
            sarvam.set_api_key(Some(key)).await;
        }
    }

    let store = Store::load().await;
    let chat = chat::ChatService::new(store.library.read().await.root().to_path_buf());
    let session = Arc::new(Mutex::new(Session::default()));
    chat.start(store.clone(), session.clone());
    let accounts = Arc::new(AccountStore::load().await?);
    let billing = Arc::new(billing::BillingStore::load().await?);
    let billing_config = billing::ProviderConfig::from_env();
    let supabase = Arc::new(SupabaseDb::detect());
    let state = AppState {
        started_at: now_ms(),
        session,
        store,
        chat,
        events,
        security,
        sarvam: sarvam.clone(),
        summarizer: summarizer.clone(),
        settings: settings.clone(),
        calendar: calendar.clone(),
        connectors: Arc::new(ConnectorService::new(settings.clone(), calendar.clone())),
        podcast: podcast.clone(),
        accounts,
        billing,
        billing_config,
        supabase: supabase.clone(),
        supabase_auth: Arc::new(supabase_auth::SupabaseAuth::from_env()),
        billing_mirror: Arc::new(Notify::new()),
    };

    println!("[Kesami Core Backend] Rust API listening on http://{host}:{port}");
    println!(
        "[Kesami Core Backend] transcription engine: {}",
        state.stt_status(None).await
    );
    println!(
        "[Kesami Core Backend] summary engine: {}",
        summarizer.status_value().await
    );

    match supabase.endpoint() {
        None => println!("[Kesami Core Backend] Supabase: not configured (local storage only)"),
        Some(endpoint) => {
            println!(
                "[Kesami Core Backend] Supabase: connecting to {}:{}/{} as {}",
                endpoint.host, endpoint.port, endpoint.database, endpoint.username
            );
            let probe = supabase.clone();
            tokio::spawn(async move {
                let check = probe.check().await;
                match check.error {
                    None => println!(
                        "[Kesami Core Backend] Supabase: connected in {}ms ({})",
                        check.latency_ms,
                        check
                            .server_version
                            .unwrap_or_else(|| "unknown version".into())
                    ),
                    Some(error) => {
                        eprintln!("[Kesami Core Backend] Supabase: unavailable — {error}")
                    }
                }
            });
            let mirror = state.clone();
            tokio::spawn(async move { mirror.mirror_billing_to_supabase().await });
        }
    }

    // Meeting-client supervision lives here rather than in a per-session task,
    // so it needs no start/stop plumbing and cannot outlive its session.
    let supervisor = state.clone();
    tokio::spawn(async move { supervisor.watch_client_end().await });

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
    let request = match read_http_request(&mut stream).await {
        Ok(request) => request,
        Err(ReadRequestError::Io(cause)) => return Err(cause),
        Err(ReadRequestError::Rejected(status, message)) => {
            write_http_response(
                &mut stream,
                status,
                "application/json; charset=utf-8",
                &json!({"error": message}).to_string(),
                &[],
            )
            .await?;
            return Ok(());
        }
    };
    let websocket = request
        .headers
        .get("upgrade")
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
        && request.path == "/ws";
    let denial = access_decision(&request, &state.security, websocket);
    // A session token minted by /api/auth/login is an alternative to the static
    // deployment token, so a 401 gets one more chance through the account store.
    let denial = match denial {
        Some((401, _)) => {
            let valid_session = match bearer_or_protocol_token(&request.headers, websocket) {
                Some(token) => state.accounts.session_account(&token).await.is_some(),
                None => false,
            };
            if valid_session {
                None
            } else {
                denial
            }
        }
        denial => denial,
    };
    if let Some((status, message)) = denial {
        write_http_response(
            &mut stream,
            status,
            "application/json; charset=utf-8",
            &json!({"error": message}).to_string(),
            &cors_headers(&request, &state.security),
        )
        .await?;
        return Ok(());
    }
    if websocket {
        let tier = state.session_tier(&request).await;
        return websocket_session(
            stream,
            request
                .headers
                .get("sec-websocket-key")
                .map(String::as_str)
                .unwrap_or(""),
            offered_protocol(request.headers.get("sec-websocket-protocol").map(String::as_str)),
            state,
            tier,
        )
        .await;
    }
    let (status, content_type, body) = route(&request, &state).await;
    let mut extra = cors_headers(&request, &state.security);
    if request.method == "OPTIONS" {
        extra.extend([
            (
                "Access-Control-Allow-Methods".to_string(),
                "GET, POST, PATCH, DELETE, OPTIONS".to_string(),
            ),
            (
                "Access-Control-Allow-Headers".to_string(),
                "Content-Type, Authorization".to_string(),
            ),
            ("Access-Control-Max-Age".to_string(), "86400".to_string()),
        ]);
    }
    write_http_response(&mut stream, status, content_type, &body, &extra).await
}

/// Reject a request before it reaches routing. Distinct from an `io::Error`,
/// which closes the connection without a response.
async fn write_http_response<W: AsyncWriteExt + Unpin>(
    stream: &mut W,
    status: u16,
    content_type: &str,
    body: &str,
    extra_headers: &[(String, String)],
) -> io::Result<()> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (name, value) in extra_headers {
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str("Connection: close\r\n\r\n");
    stream.write_all(response.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await
}

/// Paths that must be reachable before any credential exists: the health probe
/// and the endpoints that mint credentials in the first place.
fn is_public_path(path: &str) -> bool {
    matches!(path, "/health" | "/api/auth/register" | "/api/auth/login" | "/api/auth/google" | "/api/auth/supabase/google" | "/api/plans" | "/api/auth/config")
        // Provider webhooks authenticate with their own HMAC signatures.
        || path == "/api/billing/webhook/stripe" || path == "/api/billing/webhook/razorpay"
}

/// The gate every request passes before routing: the Host header (DNS
/// rebinding), the browser origin, and — except for public paths — the
/// workspace token. Returns the failure to answer with.
fn access_decision(
    req: &HttpRequest,
    security: &SecurityConfig,
    websocket: bool,
) -> Option<(u16, String)> {
    if !security.host_allowed(req.headers.get("host").map(String::as_str)) {
        return Some((403, "Unrecognized Host header".into()));
    }
    if !security.origin_allowed(req.headers.get("origin").map(String::as_str)) {
        return Some((
            403,
            "This origin is not allowed to connect to this backend".into(),
        ));
    }
    if req.method == "OPTIONS" {
        return None; // Preflights carry no credentials by design.
    }
    if !websocket && is_public_path(&req.path) {
        return None; // Health probes and sign-in cannot present a token yet.
    }
    if !security.authorized(&req.headers, websocket) {
        return Some((
            401,
            "A valid access token is required. Send it as 'Authorization: Bearer …'.".into(),
        ));
    }
    None
}

/// CORS for allowed browser origins only. Native clients send no Origin and
/// get no header at all; a hosted deployment never answers with '*'.
fn cors_headers(req: &HttpRequest, security: &SecurityConfig) -> Vec<(String, String)> {
    match req
        .headers
        .get("origin")
        .filter(|origin| security.origin_allowed(Some(origin)))
    {
        Some(origin) => vec![
            ("Access-Control-Allow-Origin".into(), origin.clone()),
            ("Vary".into(), "Origin".into()),
        ],
        None => Vec::new(),
    }
}

struct HttpRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

enum ReadRequestError {
    Io(io::Error),
    Rejected(u16, String),
}

impl From<io::Error> for ReadRequestError {
    fn from(cause: io::Error) -> Self {
        Self::Io(cause)
    }
}

async fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, ReadRequestError> {
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
        if buffer.len() > MAX_HEADER_BYTES {
            return Err(ReadRequestError::Rejected(
                431,
                "Request headers are too large".into(),
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
    if content_length > MAX_BODY_BYTES {
        return Err(ReadRequestError::Rejected(
            413,
            "The request body is too large".into(),
        ));
    }
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
/// The payload a successful register or login returns. The token is shown once
/// here and never again — the backend only stores its hash.
fn auth_grant_json(grant: accounts::AuthGrant) -> Value {
    json!({
        "success": true,
        "token": grant.token,
        "expiresAt": grant.expires_at,
        "account": grant.account,
    })
}

async fn google_sign_in_client_id(settings: &SettingsStore) -> Option<String> {
    for key in [
        "KESAMI_GOOGLE_OAUTH_CLIENT_ID",
        "KESAMI_GOOGLE_CALENDAR_CLIENT_ID",
    ] {
        if let Ok(value) = kesami_core_backend::env_compat::var(key) {
            let value = value.trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    settings
        .credential("googleCalendarClientId")
        .await
        .filter(|value| !value.trim().is_empty())
}

async fn google_sign_in_client_secret(settings: &SettingsStore) -> Option<String> {
    for key in [
        "KESAMI_GOOGLE_OAUTH_CLIENT_SECRET",
        "KESAMI_GOOGLE_CALENDAR_CLIENT_SECRET",
    ] {
        if let Ok(value) = kesami_core_backend::env_compat::var(key) {
            let value = value.trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    settings
        .credential("googleCalendarClientSecret")
        .await
        .filter(|value| !value.trim().is_empty())
}

fn build_stamp() -> &'static Value {
    static STAMP: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    STAMP.get_or_init(|| {
        let executable = env::current_exe().ok();
        let modified_ms = executable
            .as_ref()
            .and_then(|path| std::fs::metadata(path).ok())
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|since| since.as_millis() as i64);
        json!({
            "executable": executable.map(|path| path.to_string_lossy().into_owned()),
            "modifiedMs": modified_ms,
        })
    })
}

fn json_response(status: u16, value: Value) -> (u16, &'static str, String) {
    (status, "application/json; charset=utf-8", value.to_string())
}

fn podcast_path(path: &str) -> bool {
    path == "/api/podcast"
        || path.starts_with("/api/podcast/")
        || path == "/api/podcasts"
        || path.starts_with("/api/podcasts/")
}

async fn route(req: &HttpRequest, state: &AppState) -> (u16, &'static str, String) {
    if req.method == "OPTIONS" {
        return (204, "text/plain", String::new());
    }
    if podcast_path(&req.path) {
        return json_response(
            403,
            json!({"error":"Podcast is disabled.","code":"FEATURE_DISABLED"}),
        );
    }
    let body: Value = serde_json::from_slice(&req.body).unwrap_or_else(|_| json!({}));
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/health") => json_response(
            200,
            json!({
                "status": "ok",
                "version": VERSION,
                "uptimeSeconds": ((now_ms() - state.started_at).max(0) / 1000),
                "build": build_stamp(),
                "supabase": state.supabase.public_status().await,
            }),
        ),
        ("POST", "/api/auth/register") => {
            // Accounts share this workspace. Never allow anonymous registration
            // to bypass a deployment token and expose existing meetings.
            if !state.security.authorized(&req.headers, false) {
                return json_response(
                    403,
                    json!({"error": "Account creation requires the workspace owner's access token. You can still use the app locally without an account."}),
                );
            }
            match state
                .accounts
                .register(
                    body.get("name").and_then(Value::as_str).unwrap_or_default(),
                    body.get("email")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    body.get("password")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )
                .await
            {
                Ok(grant) => json_response(200, auth_grant_json(grant)),
                Err((status, error)) => json_response(status, json!({"error": error})),
            }
        }
        ("POST", "/api/auth/login") => {
            match state
                .accounts
                .login(
                    body.get("email")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    body.get("password")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )
                .await
            {
                Ok(grant) => json_response(200, auth_grant_json(grant)),
                Err((status, error)) => json_response(status, json!({"error": error})),
            }
        }
        ("POST", "/api/auth/google") => {
            let Some(client_id) = google_sign_in_client_id(&state.settings).await else {
                return json_response(
                    503,
                    json!({"error":"Google sign-in needs a Desktop app OAuth client ID in Calendar settings or KESAMI_GOOGLE_OAUTH_CLIENT_ID."}),
                );
            };
            let code = body.get("code").and_then(Value::as_str).unwrap_or_default();
            let verifier = body
                .get("verifier")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let redirect = body
                .get("redirectUri")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let nonce = body
                .get("nonce")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if nonce.is_empty() || nonce.len() > 128 {
                return json_response(400, json!({"error":"Google sign-in nonce is invalid."}));
            }
            if let Err((status, error)) = state.accounts.throttle_google_attempt() {
                return json_response(status, json!({"error":error}));
            }
            let secret = google_sign_in_client_secret(&state.settings).await;
            let tokens = match google_auth::exchange_code(
                code,
                verifier,
                redirect,
                &client_id,
                secret.as_deref(),
            )
            .await
            {
                Ok(tokens) => tokens,
                Err(error) => return json_response(401, json!({"error":error})),
            };
            let id_token = tokens.get("id_token").and_then(Value::as_str).unwrap_or_default();
            let identity = match google_auth::verify_id_token(id_token, &client_id, nonce).await {
                Ok(identity) => identity,
                Err(error) => return json_response(401, json!({"error":error})),
            };
            if !state.security.hosted && state.calendar.shares_google_sign_in(&client_id).await {
                if let Err(cause) = state.calendar.adopt_google_sign_in(&tokens).await {
                    eprintln!("[Kesami Core Backend] Google sign-in did not connect the calendar: {cause}");
                }
            }
            match state
                .accounts
                .google_sign_in(
                    &identity.sub,
                    &identity.email,
                    &identity.name,
                    state.security.authorized(&req.headers, false),
                )
                .await
            {
                Ok(grant) => json_response(200, auth_grant_json(grant)),
                Err((status, error)) => json_response(status, json!({"error":error})),
            }
        }
        ("POST", "/api/auth/supabase/google") => {
            if let Err((status, error)) = state.accounts.throttle_google_attempt() {
                return json_response(status, json!({"error": error}));
            }
            let identity = match state
                .supabase_auth
                .exchange_google_code(
                    body.get("code").and_then(Value::as_str).unwrap_or_default(),
                    body.get("verifier")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )
                .await
            {
                Ok(identity) => identity,
                Err((status, error)) => return json_response(status, json!({"error": error})),
            };
            // Preserve the Google subject mapping when moving an existing local
            // account to Supabase. Matching email alone never links accounts.
            match state
                .accounts
                .google_sign_in(
                    &identity.sub,
                    &identity.email,
                    &identity.name,
                    state.security.authorized(&req.headers, false),
                )
                .await
            {
                Ok(grant) => json_response(200, auth_grant_json(grant)),
                Err((status, error)) => json_response(status, json!({"error": error})),
            }
        }
        ("POST", "/api/auth/logout") => {
            if let Some(token) = bearer_or_protocol_token(&req.headers, false) {
                if let Err((status, error)) = state.accounts.logout(&token).await {
                    return json_response(status, json!({"error": error}));
                }
            }
            json_response(200, json!({"success": true}))
        }
        ("GET", "/api/auth/config") => {
            let google_client_id = google_sign_in_client_id(&state.settings).await;
            let google_calendar = match google_client_id.as_deref() {
                Some(client_id) if !state.security.hosted => state.calendar.wants_google_sign_in(client_id).await,
                _ => false,
            };
            json_response(
                200,
                json!({
                    "registrationAllowed": state.security.authorized(&req.headers, false),
                    "localAccess": !state.security.hosted,
                    "workspaceScope": "shared",
                    "googleClientId": google_client_id,
                    "googleCalendar": google_calendar,
                    "googleAuth": state.supabase_auth.public_config()
                }),
            )
        }
        ("GET", "/api/plans") => {
            let mut catalog = plans::catalog(state.billing_config.billing_enabled());
            catalog["billing"] = state.billing_config.public_status();
            json_response(200, catalog)
        }
        ("POST", "/api/billing/checkout") => {
            if !state.billing_config.billing_enabled() {
                return json_response(503, json!({"error": "Billing is not configured on this backend."}));
            }
            let Some(account) = state.session_account(&req).await else {
                return json_response(401, json!({"error": "Sign in to start a subscription."}));
            };
            if state.billing.active_subscription(&account.id).await.is_some() {
                return json_response(409, json!({"error": "Your Pro subscription is already active."}));
            }
            let plan = body.get("plan").and_then(Value::as_str).unwrap_or_default();
            let currency = body
                .get("currency")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let origin = req.headers.get("origin").cloned().unwrap_or_default();
            match billing::create_checkout(
                &state.billing_config,
                plan,
                currency,
                &account.id,
                &account.email,
                &origin,
            )
            .await
            {
                Ok(value) => json_response(200, value),
                Err((status, error)) => json_response(status, json!({"error": error})),
            }
        }
        ("POST", "/api/billing/razorpay/sync") => {
            let Some(account) = state.session_account(&req).await else {
                return json_response(401, json!({"error": "Sign in to confirm your subscription."}));
            };
            let subscription_id = body
                .get("subscriptionId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if let Err((status, error)) = billing::sync_razorpay_subscription(
                &state.billing_config,
                &state.billing,
                &account.id,
                subscription_id,
            )
            .await
            {
                return json_response(status, json!({"error": error}));
            }
            state.billing_mirror.notify_one();
            let subscription = state.billing.active_subscription(&account.id).await;
            json_response(
                200,
                json!({
                    "tier": billing::tier_for(subscription.as_ref()),
                    "subscription": subscription.as_ref().map(billing::BillingStore::subscription_value),
                }),
            )
        }
        // Webhooks authenticate by their HMAC signatures, not by the workspace
        // token, so they are exempt from it (see is_public_path) and must
        // never be treated as account sessions.
        ("POST", "/api/billing/webhook/stripe") => {
            let Some(secret) = state.billing_config.stripe_webhook_secret.as_deref() else {
                return json_response(
                    503,
                    json!({"error": "Stripe billing is not configured on this backend."}),
                );
            };
            let signature = req
                .headers
                .get("stripe-signature")
                .map(String::as_str)
                .unwrap_or_default();
            if let Err(error) =
                billing::verify_stripe_signature(secret, signature, &req.body, now_ms())
            {
                return json_response(400, json!({"error": error}));
            }
            let Ok(event) = serde_json::from_slice::<Value>(&req.body) else {
                return json_response(
                    400,
                    json!({"error": "The webhook payload is not valid JSON."}),
                );
            };
            match billing::parse_stripe_event(&event) {
                Ok((_, event_id, payload)) => {
                    match billing::apply_webhook(
                        &state.billing,
                        "stripe",
                        &event_id,
                        &payload,
                    )
                    .await
                    {
                        Ok(value) => {
                            state.billing_mirror.notify_one();
                            json_response(200, value)
                        }
                        Err((status, error)) => json_response(status, json!({"error": error})),
                    }
                }
                Err(error) => json_response(400, json!({"error": error})),
            }
        }
        ("POST", "/api/billing/webhook/razorpay") => {
            let Some(secret) = state.billing_config.razorpay_webhook_secret.as_deref() else {
                return json_response(
                    503,
                    json!({"error": "Razorpay billing is not configured on this backend."}),
                );
            };
            let signature = req
                .headers
                .get("x-razorpay-signature")
                .map(String::as_str)
                .unwrap_or_default();
            if let Err(error) = billing::verify_razorpay_signature(secret, signature, &req.body) {
                return json_response(400, json!({"error": error}));
            }
            let Ok(event) = serde_json::from_slice::<Value>(&req.body) else {
                return json_response(
                    400,
                    json!({"error": "The webhook payload is not valid JSON."}),
                );
            };
            let event_id = req
                .headers
                .get("x-razorpay-event-id")
                .cloned()
                .unwrap_or_default();
            if event_id.is_empty() {
                return json_response(
                    400,
                    json!({"error": "The Razorpay webhook carries no event id."}),
                );
            }
            let payload = billing::razorpay_subscription_entity(&event);
            match billing::apply_webhook(
                &state.billing,
                "razorpay",
                &event_id,
                &payload,
            )
            .await
            {
                Ok(value) => {
                    state.billing_mirror.notify_one();
                    json_response(200, value)
                }
                Err((status, error)) => json_response(status, json!({"error": error})),
            }
        }
        ("GET", "/api/billing/subscription") => {
            let Some(account) = state.session_account(&req).await else {
                return json_response(401, json!({"error": "Sign in to read your subscription."}));
            };
            let subscription = state.billing.active_subscription(&account.id).await;
            let tier = billing::tier_for(subscription.as_ref());
            let minutes_used = state.month_minutes_used().await;
            let ai_uses = match state.billing.free_ai_uses().await {
                Ok(uses) => uses,
                Err((status, error)) => return json_response(status, json!({"error":error})),
            };
            json_response(
                200,
                json!({
                    "tier": tier,
                    "subscription": subscription.as_ref().map(billing::BillingStore::subscription_value),
                    "billing": state.billing_config.public_status(),
                    "usage": {
                        "minutesUsed": minutes_used,
                        "freeMonthlyMinutes": plans::FREE_MONTHLY_MINUTES,
                        "canRecord": plans::can_record(tier, minutes_used),
                        "aiUses": ai_uses,
                        "freeMonthlyAiUses": plans::FREE_MONTHLY_AI_USES,
                        "canUseAi": tier == "pro" || ai_uses < plans::FREE_MONTHLY_AI_USES,
                    }
                }),
            )
        }
        ("POST", "/api/auth/password") => {
            let token = bearer_or_protocol_token(&req.headers, false).unwrap_or_default();
            match state
                .accounts
                .change_password(
                    &token,
                    body.get("currentPassword")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    body.get("password")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )
                .await
            {
                Ok(grant) => json_response(200, auth_grant_json(grant)),
                Err((status, error)) => json_response(status, json!({"error": error})),
            }
        }
        ("GET", "/api/auth/session") => {
            json_response(200, json!({"account": state.session_account(&req).await}))
        }
        ("GET", "/api/folders") | ("POST", "/api/folders") => {
            match workspace::folders(&state.store, (req.method == "POST").then_some(&body)).await {
                Ok(result) => json_response(200, result),
                Err(error) => json_response(400, json!({"error":error})),
            }
        }
        (_, path) if path == "/api/chat" || path.starts_with("/api/chat/") => {
            chat::route(req, state, &body).await
        }
        ("GET", "/api/status") => json_response(200, state.status().await),
        ("GET", "/api/supabase/status") => json_response(200, state.supabase.status_value().await),
        ("POST", "/api/supabase/check") => {
            if state.supabase.configured() {
                let check = state.supabase.check().await;
                json_response(
                    if check.ok { 200 } else { 503 },
                    state.supabase.status_value().await,
                )
            } else {
                json_response(503, state.supabase.status_value().await)
            }
        }
        ("POST", "/api/supabase/secret-check") => match supabase_auth::check_secret_key().await {
            Ok(result) => json_response(200, result),
            Err((status, error)) => json_response(status, json!({ "ok": false, "error": error })),
        },
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
        ("POST", "/api/meetings/start") => {
            // The free tier buys one hour of recording per calendar month;
            // Pro records without limits. Anonymous local use is free tier.
            let tier = state.session_tier(&req).await;
            if tier != "pro" {
                let used = 0;
                if used >= plans::FREE_MONTHLY_MINUTES {
                    return json_response(
                        402,
                        json!({
                            "error": format!(
                                "Monthly free limit reached ({used} of {limit} recording minutes this month). Upgrade to Pro for unlimited recording.",
                                used = used.min(plans::FREE_MONTHLY_MINUTES),
                                limit = plans::FREE_MONTHLY_MINUTES,
                            ),
                            "code": "FREE_MONTHLY_LIMIT",
                        }),
                    );
                }
            }
            match state.start(&body, tier).await {
                Ok(m) => json_response(200, json!({"success":true,"meeting":m})),
                Err(e) => json_response(409, json!({"error":e})),
            }
        }
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
        ("POST", "/api/session/participants") => {
            json_response(200, state.observe_participants(&body).await)
        }
        ("POST", "/api/meetings/stop") => match state.finish(&body).await {
            Ok(m) => json_response(200, json!({"success":true,"meeting":m})),
            Err(e) => json_response(409, json!({"error":e})),
        },
        ("GET", "/api/license/status") => {
            let tier = state.session_tier(&req).await;
            let minutes_used = state.month_minutes_used().await;
            json_response(
                200,
                json!({
                    "tier": tier,
                    "status": "active",
                    "canRecord": plans::can_record(tier, minutes_used),
                    "requiresAccount": false,
                    "billingEnabled": state.billing_config.billing_enabled(),
                    "licenseActivationSupported": false,
                    "usage": {
                        "minutesUsed": minutes_used,
                        "freeMonthlyMinutes": plans::FREE_MONTHLY_MINUTES,
                    }
                }),
            )
        }
        ("POST", "/api/license/activate") => json_response(
            200,
            json!({"success":false,"error":"License verification is not implemented in the Rust core yet."}),
        ),
        ("GET", "/api/settings") => {
            let mut settings = state.settings.public_value().await;
            settings["deploymentMode"] = json!(if state.security.hosted {
                "hosted"
            } else {
                "local"
            });
            settings["supportsLocalRecording"] = json!(!state.security.hosted);
            settings["calendarConnectSupported"] = json!(!state.security.hosted);
            settings["geminiApiKeySet"] =
                state.summarizer.status_value().await["geminiKeySet"].clone();
            settings["sarvamApiKeySet"] = json!(state.sarvam.has_key().await);
            if state.security.hosted {
                settings["sarvamDiarizeAfterMeeting"] = json!(false);
            }
            if settings.get("sarvamLanguage").is_none() {
                settings["sarvamLanguage"] = json!("unknown");
            }
            if settings.get("sarvamMode").is_none() {
                settings["sarvamMode"] = json!("transcribe");
            }
            if settings.get("sarvamDiarizeAfterMeeting").is_none() {
                settings["sarvamDiarizeAfterMeeting"] = json!(true);
            }
            if settings.get("autoStopOnMeetingEnd").is_none() {
                settings["autoStopOnMeetingEnd"] = json!(true);
            }
            if settings.get("promptForUnscheduledCalls").is_none() {
                settings["promptForUnscheduledCalls"] = json!(true);
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
            // Hosted users share one provider configuration. An account session
            // may change preferences, but only the deployment owner may replace
            // the server's provider credentials.
            if state.security.hosted
                && (object.contains_key("sarvamApiKey") || object.contains_key("geminiApiKey"))
                && !state.security.authorized(&req.headers, false)
            {
                return json_response(403, json!({"error": "Only the workspace administrator can update provider credentials."}));
            }
            let mut warnings = Vec::new();

            if let Some(provider) = object.get("transcriptionProvider").and_then(Value::as_str) {
                if !matches!(
                    provider.trim().to_ascii_lowercase().as_str(),
                    "sarvam" | "sarvam-realtime"
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
            if let Some(value) = object.get("sarvamDiarizeAfterMeeting") {
                if !value.is_boolean() {
                    return json_response(
                        400,
                        json!({"error": "Sarvam post-meeting diarization must be true or false"}),
                    );
                }
            }
            for key in ["noiseSuppression", "echoSuppression"] {
                if object.get(key).is_some_and(|value| !value.is_boolean()) {
                    return json_response(
                        400,
                        json!({"error": format!("{key} must be true or false")}),
                    );
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

            if let Some(model) = object.get("aiModel").and_then(Value::as_str) {
                if let Err(cause) = state.summarizer.set_model(model).await {
                    warnings.push(cause);
                }
            }
            {
                let mut session = state.session.lock().await;
                if let Some(enabled) = object.get("noiseSuppression").and_then(Value::as_bool) {
                    if enabled != session.denoiser.is_some() {
                        session.denoiser = enabled.then(NoiseSuppressor::new);
                    }
                }
                if let Some(enabled) = object.get("echoSuppression").and_then(Value::as_bool) {
                    session.echo_suppression = enabled;
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
                        if let Err(cause) = state.settings.set_credential(&field, Some(value)).await
                        {
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
        ("POST", "/api/stt/config") => json_response(
            410,
            json!({
                "error": "Local Whisper has been removed. Configure Sarvam in Transcription settings.",
            }),
        ),
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
        ("GET", "/api/podcast/status") => json_response(200, state.podcast.status_value().await),
        ("POST", "/mcp") => {
            let library = state.store.meetings.read().await;
            let load_meetings = || {
                let mut meetings: Vec<&Meeting> = library.values().collect();
                meetings.sort_by_key(|m| std::cmp::Reverse(m.started_at));
                meetings
                    .into_iter()
                    .filter_map(|meeting| serde_json::to_value(meeting).ok())
                    .collect()
            };
            let reply = mcp::handle(&req.body, load_meetings, VERSION, now_ms());
            drop(library);
            match reply {
                Some(reply) => json_response(200, reply),
                None => (202, "application/json", String::new()),
            }
        }
        ("GET", "/mcp") | ("DELETE", "/mcp") => json_response(
            405,
            json!({"error": "This MCP server is stateless: send JSON-RPC messages with POST."}),
        ),
        ("GET", "/api/connectors") => {
            let mut status = state.connectors.status().await;
            status["mcp"] = json!({"path": "/mcp", "hosted": state.security.hosted});
            json_response(200, status)
        }
        ("POST", "/api/connectors/save") => {
            let provider = body.get("provider").and_then(Value::as_str).unwrap_or_default();
            let config = body.get("config").cloned().unwrap_or_else(|| json!({}));
            match state.connectors.save(provider, &config).await {
                Ok(connector) => json_response(200, json!({"success": true, "connector": connector})),
                Err(cause) => json_response(400, json!({"error": cause})),
            }
        }
        ("POST", "/api/connectors/connect") => {
            if state.security.hosted {
                return json_response(
                    409,
                    json!({"error": "Google sign-in requires the local backend. Hosted OAuth is not configured."}),
                );
            }
            let provider = body.get("provider").and_then(Value::as_str).unwrap_or_default();
            match state.connectors.connect(provider).await {
                Ok(value) => json_response(200, value),
                Err(cause) => json_response(400, json!({"error": cause})),
            }
        }
        ("POST", "/api/connectors/disconnect") => {
            let provider = body.get("provider").and_then(Value::as_str).unwrap_or_default();
            match state.connectors.disconnect(provider).await {
                Ok(()) => json_response(200, json!({"success": true, "provider": provider})),
                Err(cause) => json_response(400, json!({"error": cause})),
            }
        }
        ("POST", "/api/connectors/test") => {
            let provider = body.get("provider").and_then(Value::as_str).unwrap_or_default();
            match state.connectors.test(provider).await {
                Ok(message) => json_response(200, json!({"success": true, "message": message})),
                Err(cause) => json_response(400, json!({"error": cause})),
            }
        }
        ("POST", "/api/connectors/send") => {
            let provider = body.get("provider").and_then(Value::as_str).unwrap_or_default();
            let meeting_id = body.get("meetingId").and_then(Value::as_str).unwrap_or_default();
            let force = body.get("force").and_then(Value::as_bool).unwrap_or(false);
            if connectors::spec_for(provider).is_none() {
                return json_response(400, json!({"error": format!("unknown connector: {provider}")}));
            }
            let Some(meeting) = state.store.get(meeting_id).await else {
                return json_response(404, json!({"error": "Meeting not found"}));
            };
            let value = serde_json::to_value(&meeting).unwrap_or_else(|_| json!({}));
            if !force && connectors::delivered_ok(&value, provider) {
                return json_response(
                    409,
                    json!({"error": "Already sent. Send again to create another copy.", "code": "ALREADY_SENT"}),
                );
            }
            match deliver_to_connector(&state.connectors, &state.store, &state.events, meeting_id, &value, provider).await {
                Ok(delivery) => json_response(
                    if delivery["ok"] == json!(true) { 200 } else { 502 },
                    json!({"delivery": delivery, "error": delivery.get("error")}),
                ),
                Err(cause) => json_response(500, json!({"error": cause})),
            }
        }
        ("GET", "/api/calendar/status") => json_response(200, state.calendar.status().await),
        ("POST", "/api/calendar/connect") => {
            if state.security.hosted {
                return json_response(
                    409,
                    json!({"error": "Calendar sign-in requires the local backend. Hosted OAuth is not configured."}),
                );
            }
            let provider = body
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match state.calendar.begin(provider).await {
                Ok(value) => json_response(200, value),
                Err(cause) => json_response(400, json!({"error": cause})),
            }
        }
        ("POST", "/api/calendar/disconnect") => {
            let provider = body
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or_default();
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
                .unwrap_or(2880);
            json_response(200, state.calendar.events(back, ahead).await)
        }
        ("POST", "/api/calendar/events") => {
            let provider = body
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or(calendar::GOOGLE);
            if !calendar::is_provider(provider) {
                return json_response(400, json!({"error": "unknown calendar provider"}));
            }
            match state.calendar.create_event(provider, &body).await {
                Ok(event) => json_response(200, json!({"event": event})),
                Err(cause) => json_response(400, json!({"error": cause})),
            }
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
                        meeting
                            .transcript
                            .into_iter()
                            .map(|turn| PodcastSourceTurn {
                                id: turn.id,
                                speaker: turn.speaker,
                                start_ms: turn.start_ms,
                                text: turn.text,
                            })
                            .collect::<Vec<_>>(),
                    )
                    .unwrap_or_else(|_| json!([])),
                    None => {
                        return json_response(404, json!({"error": "Source meeting not found"}))
                    }
                }
            } else {
                json!([])
            };
            let transcript: Vec<PodcastSourceTurn> = match serde_json::from_value(transcript_value)
            {
                Ok(value) => value,
                Err(cause) => {
                    return json_response(
                        400,
                        json!({"error": format!("Podcast transcript is invalid: {cause}")}),
                    )
                }
            };
            let hosts: Vec<PodcastHost> =
                match serde_json::from_value(body.get("hosts").cloned().unwrap_or_else(|| {
                    json!([
                        {"id":"host-a","name":"Avery","voice":"Kore"},
                        {"id":"host-b","name":"Riley","voice":"Puck"}
                    ])
                })) {
                    Ok(value) => value,
                    Err(cause) => {
                        return json_response(
                            400,
                            json!({"error": format!("Podcast hosts are invalid: {cause}")}),
                        )
                    }
                };
            let request = PodcastScriptRequest {
                project_id: project_id.to_string(),
                title: body
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Untitled podcast")
                    .to_string(),
                language: body
                    .get("language")
                    .and_then(Value::as_str)
                    .unwrap_or("auto")
                    .to_string(),
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
    let batch = state
        .sarvam
        .transcribe(
            source,
            BatchConfig {
                language: state
                    .settings
                    .get_str("sarvamLanguage")
                    .await
                    .unwrap_or_else(|| "unknown".into()),
                mode: state
                    .settings
                    .get_str("sarvamMode")
                    .await
                    .unwrap_or_else(|| "transcribe".into()),
                ..Default::default()
            },
        )
        .await?;
    let labels = label_speakers(&batch.turns, None);
    let turns = batch
        .turns
        .into_iter()
        .enumerate()
        .filter_map(|(index, turn)| {
            strip_non_speech(&turn.text).map(|text| PodcastSourceTurn {
                id: format!("import-{index:05}"),
                speaker: labels
                    .get(&turn.speaker_id)
                    .cloned()
                    .unwrap_or_else(|| "Speaker 1".into()),
                start_ms: turn.start_ms,
                text,
            })
        })
        .collect::<Vec<_>>();
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
        if req.method == "PATCH" && parts.len() == 4 && parts[3] == "folder" {
            return match workspace::move_meeting(&state.store, id, body).await {
                Ok(meeting) => json_response(200, json!({"meeting":meeting})),
                Err(error) => json_response(400, json!({"error":error})),
            };
        }
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
            let meeting = match state.store.put(meeting).await {
                Ok(meeting) => meeting,
                Err(cause) => return json_response(500, json!({"error": cause.to_string()})),
            };
            let _ = state.store.put_documents(&meeting).await;
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

            // Stored summaries are free to read; only a new generation counts.
            let wants_ai = !meeting.transcript.is_empty()
                && (regenerate || meeting.summary_markdown.is_empty());
            let free_use_key = if wants_ai && state.session_tier(req).await != "pro" {
                let key = format!("summary:manual:{}", Uuid::new_v4());
                match state.billing.reserve_free_ai_use(key.clone()).await {
                    Ok(true) => Some(key),
                    Ok(false) => return json_response(402, json!({"error":plans::free_ai_limit_message(),"code":"FREE_AI_LIMIT"})),
                    Err((status, error)) => return json_response(status, json!({"error":error})),
                }
            } else { None };
            let mut provider = "stored".to_string();
            let mut warning = None;
            if !meeting.transcript.is_empty() && (regenerate || meeting.summary_markdown.is_empty())
            {
                let summary = state.summarize_into(&mut meeting).await;
                provider = summary.provider;
                warning = summary.warning;
                if meeting.summary_markdown.is_empty() {
                    if let Some(key) = &free_use_key { state.billing.release_free_ai_use(key.clone()).await; }
                }
                match state.store.put(meeting.clone()).await {
                    Ok(stored) => {
                        let _ = state.store.put_documents(&stored).await;
                    }
                    Err(cause) => {
                        if let Some(key) = free_use_key { state.billing.release_free_ai_use(key).await; }
                        return json_response(500, json!({"error": cause.to_string()}));
                    }
                }
            }

            return json_response(
                200,
                json!({"success":true,"summary":{"rawMarkdown":meeting.summary_markdown,"sections":meeting.summary_sections,"actionItems":meeting.action_items,"keyDecisions":meeting.key_decisions,"topics":meeting.topics,"emailDraft":meeting.email_draft,"provider":provider,"warning":warning}}),
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
    let mut out = library::summary_document(meeting);
    if !meeting.transcript.is_empty() {
        out.push_str("## Transcript\n\n");
        for t in &meeting.transcript {
            out.push_str(&format!("**{}**: {}\n\n", t.speaker, t.text));
        }
    }
    out
}

fn offered_protocol(header: Option<&str>) -> Option<&'static str> {
    let offered: Vec<&str> = header.unwrap_or_default().split(',').map(str::trim).collect();
    ["kesami", "alpha"].into_iter().find(|protocol| offered.contains(protocol))
}

async fn websocket_session(
    stream: TcpStream,
    key: &str,
    app_protocol: Option<&'static str>,
    state: AppState,
    tier: &'static str,
) -> io::Result<()> {
    let (mut reader, mut writer) = stream.into_split();
    let accept = websocket_accept(key);
    // Echoing a protocol the client never offered makes browsers fail the
    // handshake, so only confirm the one the client asked for.
    let protocol = app_protocol
        .map(|name| format!("\r\nSec-WebSocket-Protocol: {name}"))
        .unwrap_or_default();
    let response=format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}{protocol}\r\n\r\n");
    writer.write_all(response.as_bytes()).await?;
    let mut receiver = state.events.subscribe();
    let initial =
        json!({"type":"connection_established","status":state.status().await}).to_string();
    write_ws_text(&mut writer, &initial).await?;

    let (pongs, mut pong_queue) = mpsc::unbounded_channel::<Vec<u8>>();
    let outbound = tokio::spawn(async move {
        loop {
            let written = tokio::select! {
                event = receiver.recv() => match event {
                    Ok(event) => write_ws_text(&mut writer, &event).await,
                    Err(broadcast::error::RecvError::Lagged(_)) => Ok(()),
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                payload = pong_queue.recv() => match payload {
                    Some(payload) => write_ws_pong(&mut writer, &payload).await,
                    None => break,
                },
            };
            if written.is_err() {
                break;
            }
        }
    });

    loop {
        match read_ws_frame(&mut reader).await {
            Ok(Some(WsFrame::Binary(bytes))) => state.feed_audio(&bytes).await,
            Ok(Some(WsFrame::Text(text))) => handle_ws_message(&state, &text, tier).await,
            Ok(Some(WsFrame::Ping(payload))) => {
                if pongs.send(payload).is_err() {
                    break;
                }
            }
            Ok(Some(WsFrame::Close)) | Ok(None) => break,
            Err(_) => break,
        }
    }

    drop(pongs);
    outbound.abort();
    Ok(())
}

async fn handle_ws_message(state: &AppState, text: &str, tier: &'static str) {
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
                let _ = state.start(&payload, tier).await;
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
async fn read_ws_frame<R: AsyncReadExt + Unpin>(stream: &mut R) -> io::Result<Option<WsFrame>> {
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
        if len > MAX_WS_BYTES {
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
async fn write_ws_text<W: AsyncWriteExt + Unpin>(stream: &mut W, text: &str) -> io::Result<()> {
    write_ws_frame(stream, 1, text.as_bytes()).await
}
async fn write_ws_pong<W: AsyncWriteExt + Unpin>(stream: &mut W, data: &[u8]) -> io::Result<()> {
    write_ws_frame(stream, 10, data).await
}
async fn write_ws_frame<W: AsyncWriteExt + Unpin>(
    stream: &mut W,
    opcode: u8,
    data: &[u8],
) -> io::Result<()> {
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

    #[test]
    fn meeting_audio_stays_one_provisional_speaker_when_no_meeting_client_is_attached() {
        let silent = SpeechLog::default();
        let mut labels = NumberedSpeakers::default();

        for (start_ms, end_ms) in [(0, 3_000), (10_000, 13_000), (40_000, 44_000)] {
            let identity = remote_identity(&silent, start_ms, end_ms);
            assert_eq!(identity, None);
            assert_eq!(labels.label(identity.as_deref()), "Speaker 1");
        }
    }

    #[test]
    fn a_meeting_client_reporting_names_is_what_names_meeting_audio() {
        let mut participants = SpeechLog::default();
        participants.set_self_name(Some("Riyam".into()));
        participants.observe(&["Aditi".to_string()], 0);
        participants.observe(&["Riyam".to_string()], 10_000);
        participants.close(13_000);

        assert_eq!(
            remote_identity(&participants, 0, 3_000).as_deref(),
            Some("Aditi")
        );
        assert_eq!(remote_identity(&participants, 10_000, 13_000), None);
    }

    #[test]
    fn diarized_speakers_adopt_proper_participant_names_and_you_for_mic() {
        use sarvam::BatchTurn;

        let mut participants = SpeechLog::default();
        participants.set_self_name(Some("Riyam".into()));
        participants.observe(&["Aditi".to_string()], 0);
        participants.observe(&["Riyam".to_string()], 10_000);
        participants.close(20_000);

        let spans = vec![
            DiarizedSpan {
                speaker_id: "0".into(),
                start_ms: 0,
                end_ms: 9_000,
            },
            DiarizedSpan {
                speaker_id: "1".into(),
                start_ms: 10_000,
                end_ms: 19_000,
            },
        ];

        let mic_speaker = Some("1");
        let self_name = Some("Riyam");
        let mut labels = label_speakers(
            &[
                BatchTurn {
                    speaker_id: "0".into(),
                    start_ms: 0,
                    end_ms: 9000,
                    text: "Hi".into(),
                    language: None,
                },
                BatchTurn {
                    speaker_id: "1".into(),
                    start_ms: 10000,
                    end_ms: 19000,
                    text: "Hello".into(),
                    language: None,
                },
            ],
            mic_speaker,
        );

        let named = participants.attribute(
            &spans,
            &mic_speaker.into_iter().collect::<Vec<_>>(),
            &self_name.into_iter().collect::<Vec<_>>(),
        );
        for (speaker_id, name) in named.iter() {
            labels.insert(speaker_id.clone(), name.clone());
        }

        assert_eq!(labels.get("1").map(String::as_str), Some("You"));
        assert_eq!(labels.get("0").map(String::as_str), Some("Aditi"));
    }

    #[test]
    fn a_speaker_number_can_be_read_back_without_claiming_the_next_one() {
        let mut labels = NumberedSpeakers::default();
        assert_eq!(labels.peek(Some("voice-1")), None);

        labels.label(Some("voice-1"));
        assert_eq!(labels.peek(Some("voice-1")), Some("Speaker 1"));
        assert_eq!(labels.label(Some("voice-2")), "Speaker 2");
    }

    #[test]
    fn invited_names_prefer_a_name_and_fall_back_to_the_address() {
        let metadata = json!({
            "calendarEvent": {
                "attendees": [
                    { "name": "Asha Rao", "email": "asha@example.com" },
                    { "name": "", "email": "ben@example.com" },
                    { "name": "Chen", "email": null },
                    { "name": null, "email": null }
                ]
            }
        });
        assert_eq!(
            invited_names(&metadata),
            vec![
                "Asha Rao <asha@example.com>".to_string(),
                "ben@example.com".to_string(),
                "Chen".to_string()
            ]
        );
    }

    #[test]
    fn the_websocket_protocol_prefers_kesami_and_still_accepts_alpha() {
        assert_eq!(offered_protocol(Some("kesami, kesami-token.abc")), Some("kesami"));
        assert_eq!(offered_protocol(Some("alpha, alpha-token.abc")), Some("alpha"));
        assert_eq!(offered_protocol(Some("alpha, kesami")), Some("kesami"));
        assert_eq!(offered_protocol(Some("chat")), None);
        assert_eq!(offered_protocol(None), None);
    }

    #[test]
    fn a_meeting_without_a_calendar_event_has_no_invited_names() {
        assert!(invited_names(&json!({})).is_empty());
        assert!(invited_names(&json!({ "calendarEvent": { "title": "Ad hoc" } })).is_empty());
    }

    /// A real record from `.kesami/meetings.json`, written before
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
    fn microphone_speech_merges_segments_that_run_together() {
        let mut intervals = Vec::new();
        remember_speech(&mut intervals, 0, 15_000);
        remember_speech(&mut intervals, 15_000, 21_400);
        remember_speech(&mut intervals, 30_000, 32_000);
        remember_speech(&mut intervals, 33_000, 33_000);
        assert_eq!(intervals, vec![(0, 21_400), (30_000, 32_000)]);
        assert_eq!(
            shift_intervals(&intervals, 4_000),
            vec![(-4_000, 17_400), (26_000, 28_000)]
        );
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
        let scratch = env::temp_dir().join(format!("kesami-sarvam-path-{}", Uuid::new_v4()));
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
        let path = std::path::Path::new(".kesami/meetings.json");
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

    #[test]
    fn the_same_unscheduled_call_is_noticed_once_and_then_lies_quiet() {
        let now = 1_000_000;
        let key = "google-meet|https://meet.google.com/abc-defg-hij";

        // The first sighting anywhere always prompts.
        assert!(unscheduled_notice_due(&None, key, now));
        let last = Some((key.to_string(), now));

        // The heartbeat re-reports the same call for as long as it runs.
        for seconds in [1, 30, UNSCHEDULED_COOLDOWN_MS / 1000 - 1] {
            assert!(
                !unscheduled_notice_due(&last, key, now + seconds * 1000),
                "a repeat within the cooldown must not re-prompt"
            );
        }

        // A different meeting, or the same one long after, prompts again.
        assert!(unscheduled_notice_due(
            &last,
            "zoom|https://zoom.us/wc/123",
            now + 5_000
        ));
        assert!(unscheduled_notice_due(
            &last,
            key,
            now + UNSCHEDULED_COOLDOWN_MS + 1_000
        ));
    }

    mod access {
        use super::super::{access_decision, cors_headers, HttpRequest};
        use crate::security::SecurityConfig;
        use std::collections::HashMap;

        const TOKEN: &str = "test-only-token-with-at-least-32-characters";

        fn request(method: &str, path: &str, headers: &[(&str, &str)]) -> HttpRequest {
            HttpRequest {
                method: method.into(),
                path: path.into(),
                query: HashMap::new(),
                headers: headers
                    .iter()
                    .map(|(key, value)| (key.to_string(), value.to_string()))
                    .collect(),
                body: Vec::new(),
            }
        }

        fn hosted() -> SecurityConfig {
            SecurityConfig::new(
                "0.0.0.0",
                Some(TOKEN),
                Some("https://app.example.com"),
                None,
            )
            .unwrap()
        }

        #[test]
        fn a_hosted_backend_requires_the_token_for_every_route_except_health_and_preflight() {
            let security = hosted();
            let host = [("host", "backend.example.com")];
            assert_eq!(
                access_decision(&request("GET", "/api/status", &host), &security, false)
                    .map(|(status, _)| status),
                Some(401)
            );
            assert_eq!(
                access_decision(&request("GET", "/health", &host), &security, false),
                None
            );
            assert_eq!(
                access_decision(&request("OPTIONS", "/api/status", &host), &security, false),
                None
            );
            let authorized = [
                ("host", "backend.example.com"),
                ("authorization", &format!("Bearer {TOKEN}")),
            ];
            assert_eq!(
                access_decision(
                    &request("GET", "/api/status", &authorized),
                    &security,
                    false
                ),
                None
            );
        }

        #[test]
        fn a_websocket_needs_the_token_even_though_it_is_not_a_health_route() {
            use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
            let security = hosted();
            let host = [("host", "backend.example.com")];
            assert_eq!(
                access_decision(&request("GET", "/ws", &host), &security, true)
                    .map(|(status, _)| status),
                Some(401)
            );
            let subprotocol = (
                "sec-websocket-protocol",
                format!("kesami, kesami-token.{}", URL_SAFE_NO_PAD.encode(TOKEN)),
            );
            let authorized = [
                ("host", "backend.example.com"),
                (subprotocol.0, subprotocol.1.as_str()),
            ];
            assert_eq!(
                access_decision(&request("GET", "/ws", &authorized), &security, true),
                None
            );
        }

        #[test]
        fn disallowed_origins_and_rebinding_hosts_are_refused_before_auth() {
            let security = hosted();
            let evil_origin = [
                ("host", "backend.example.com"),
                ("authorization", &format!("Bearer {TOKEN}")),
                ("origin", "https://evil.test"),
            ];
            assert_eq!(
                access_decision(
                    &request("GET", "/api/status", &evil_origin),
                    &security,
                    false
                )
                .map(|(status, _)| status),
                Some(403)
            );

            // A local backend is the one that must refuse a non-loopback Host,
            // since a rebinding attack targets services bound to 127.0.0.1.
            let local = SecurityConfig::new("127.0.0.1", None, None, None).unwrap();
            assert_eq!(
                access_decision(
                    &request("GET", "/api/status", &[("host", "evil.test:48900")]),
                    &local,
                    false
                )
                .map(|(status, _)| status),
                Some(403)
            );
            assert_eq!(
                access_decision(
                    &request("GET", "/api/status", &[("host", "127.0.0.1:48900")]),
                    &local,
                    false
                ),
                None
            );
        }

        #[test]
        fn cors_only_ever_allows_an_origin_on_the_list() {
            let security = hosted();
            let allowed = request(
                "GET",
                "/api/status",
                &[
                    ("host", "backend.example.com"),
                    ("origin", "https://app.example.com"),
                ],
            );
            let headers = cors_headers(&allowed, &security);
            assert!(headers.contains(&(
                "Access-Control-Allow-Origin".to_string(),
                "https://app.example.com".to_string()
            )));
            assert!(headers.contains(&("Vary".to_string(), "Origin".to_string())));

            // Native clients send no Origin; a response for them must not widen
            // access for somebody else.
            let native = request("GET", "/api/status", &[("host", "backend.example.com")]);
            assert!(cors_headers(&native, &security).is_empty());
        }
    }
}
