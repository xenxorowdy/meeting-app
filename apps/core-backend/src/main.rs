use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env, io,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{broadcast, mpsc, Mutex, RwLock},
};
use uuid::Uuid;

use alpha_core_backend::{
    audio::{self, AudioPacket, PacketParser, STREAM_MIC, STREAM_SYSTEM},
    transcript::strip_non_speech,
    vad::{SpeechDetector, Utterance},
};

mod stt;
use stt::SttService;

mod summarizer;
use summarizer::{MeetingSummary, SummaryRequest, SummaryService, SummaryTurn};

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
    transcript: Vec<TranscriptTurn>,
    created_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize)]
enum SessionState {
    #[serde(rename = "IDLE")]
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
}

impl Default for SessionState {
    fn default() -> Self {
        Self::Idle
    }
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
            .cloned()
            .filter(|m| {
                query.is_empty()
                    || m.title.to_lowercase().contains(&query)
                    || m.summary_markdown.to_lowercase().contains(&query)
                    || m.transcript
                        .iter()
                        .any(|t| t.text.to_lowercase().contains(&query))
            })
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

#[derive(Clone)]
struct AppState {
    started_at: i64,
    session: Arc<Mutex<Session>>,
    store: Store,
    events: broadcast::Sender<String>,
    stt: Arc<SttService>,
    summarizer: Arc<SummaryService>,
    transcriptions: mpsc::UnboundedSender<TranscriptionJob>,
    pending_transcriptions: Arc<AtomicUsize>,
}

impl AppState {
    async fn status(&self) -> Value {
        let session = self.session.lock().await;
        let turns = session.current.as_ref().map(|m| m.transcript.len()).unwrap_or(0);
        let state = json!({ "state": session.state.as_str(), "meetingId": session.current.as_ref().map(|m| &m.id), "meetingTitle": session.current.as_ref().map(|m| &m.title), "durationSeconds": session.current.as_ref().map(|m| (now_ms() - m.started_at).max(0) / 1000).unwrap_or(0), "turnsCount": turns, "audioLevels": { "mic": session.mic_rms * 100.0, "system": session.system_rms * 100.0 } });
        drop(session);

        let mut status = state;
        status["stt"] = self.stt.status_value().await;
        status["stt"]["pending"] = json!(self.pending_transcriptions.load(Ordering::SeqCst));
        status["summary"] = self.summarizer.status_value().await;
        status
    }

    async fn emit(&self, kind: &str, data: Value) {
        let _ = self
            .events
            .send(json!({"type": kind, "data": data, "timestamp": now_ms()}).to_string());
    }

    async fn start(&self, payload: &Value) -> Result<Meeting, String> {
        let mut session = self.session.lock().await;
        if matches!(
            session.state,
            SessionState::Recording
                | SessionState::Paused
                | SessionState::Starting
                | SessionState::Summarizing
        ) {
            return Err("A meeting session is already in progress.".into());
        }
        session.state = SessionState::Starting;
        session.mic_vad.reset();
        session.system_vad.reset();
        let now = now_ms();

        // Warm the model while the first sentences are still being spoken.
        let stt = self.stt.clone();
        tokio::spawn(async move { stt.ensure_ready().await });
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
            metadata: payload
                .get("metadata")
                .cloned()
                .unwrap_or_else(|| json!({})),
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
        // Close whatever speech is still buffered and give the engine a moment to
        // return it, so the last sentence spoken is in the stored transcript.
        let tail = {
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

            let mut jobs = Vec::new();
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
            jobs
        };

        self.queue_transcriptions(tail).await;
        self.drain_transcriptions(TRANSCRIPTION_DRAIN_BUDGET).await;

        let mut session = self.session.lock().await;
        let mut meeting = session
            .current
            .clone()
            .ok_or("No meeting session is active")?;

        // Turns the engine produced win; a posted transcript is only a fallback
        // for when no transcription engine was available.
        if meeting.transcript.is_empty() {
            if let Some(turns) = payload.get("transcript").and_then(Value::as_array) {
            meeting.transcript = turns
                .iter()
                .enumerate()
                .filter_map(|(i, t)| {
                    Some(TranscriptTurn {
                        id: t
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or(&format!("turn-{i}"))
                            .to_string(),
                        channel: t
                            .get("channel")
                            .or_else(|| t.get("stream"))
                            .and_then(Value::as_str)
                            .unwrap_or("system")
                            .to_string(),
                        speaker: {
                            let channel = t
                                .get("channel")
                                .or_else(|| t.get("stream"))
                                .and_then(Value::as_str)
                                .unwrap_or("system");
                            let supplied = t.get("speaker").and_then(Value::as_str);
                            if channel == "mic" {
                                "You".to_string()
                            } else if supplied == Some("You") || supplied.is_none() {
                                "Others".to_string()
                            } else {
                                supplied.unwrap().to_string()
                            }
                        },
                        start_ms: t.get("startMs").and_then(Value::as_i64).unwrap_or(0),
                        end_ms: t.get("endMs").and_then(Value::as_i64).unwrap_or(0),
                        text: t
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim()
                            .to_string(),
                        confidence: t.get("confidence").and_then(Value::as_f64).unwrap_or(1.0)
                            as f32,
                    })
                })
                .filter(|t| !t.text.is_empty())
                .collect();
            }
        }
        let ended = now_ms();
        meeting.ended_at = Some(ended);
        meeting.duration_seconds = ((ended - meeting.started_at).max(0)) / 1000;
        session.current = Some(meeting.clone());
        session.state = SessionState::Summarizing;
        drop(session);
        self.emit(
            "state_change",
            json!({"newState":"SUMMARIZING","oldState":"PROCESSING_STT"}),
        )
        .await;

        let summary = self.summarize_into(&mut meeting).await;

        self.store
            .put(meeting.clone())
            .await
            .map_err(|e| e.to_string())?;

        let mut session = self.session.lock().await;
        session.current = Some(meeting.clone());
        session.state = SessionState::Completed;
        drop(session);
        self.emit(
            "summary_generated",
            json!({"meetingId": meeting.id, "provider": summary.provider, "warning": summary.warning}),
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
            if let (true, Some(id)) = (recording, meeting_id.as_ref()) {
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
        while self.pending_transcriptions.load(Ordering::SeqCst) > 0 && SystemTime::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Attach a transcribed utterance to the meeting it belongs to and tell the
    /// clients about it.
    async fn commit_turn(&self, job: &TranscriptionJob, text: String) {
        let turn = TranscriptTurn {
            id: Uuid::new_v4().to_string(),
            channel: channel_name(job.stream_id).to_string(),
            // The core has no diarization yet, so remote audio is one voice.
            speaker: if job.stream_id == STREAM_MIC { "You" } else { "Others" }.to_string(),
            start_ms: job.utterance.start_ms,
            end_ms: job.utterance.end_ms,
            text,
            confidence: 1.0,
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
    let summarizer = Arc::new(SummaryService::detect());
    let state = AppState {
        started_at: now_ms(),
        session: Arc::new(Mutex::new(Session::default())),
        store: Store::load().await,
        events,
        stt: stt.clone(),
        summarizer: summarizer.clone(),
        transcriptions,
        pending_transcriptions: Arc::new(AtomicUsize::new(0)),
    };

    // One worker drains the queue, so a long utterance's parts are transcribed
    // and emitted in the order they were spoken.
    let worker_state = state.clone();
    tokio::spawn(async move {
        while let Some(job) = transcription_queue.recv().await {
            let wav = audio::encode_wav(&job.utterance.pcm, 16_000);
            match worker_state.stt.transcribe(wav).await {
                Ok(text) => {
                    if let Some(speech) = strip_non_speech(&text) {
                        worker_state.commit_turn(&job, speech).await;
                    }
                }
                Err(cause) => eprintln!("[Alpha Core Backend] transcription failed: {cause}"),
            }
            worker_state.pending_transcriptions.fetch_sub(1, Ordering::SeqCst);
        }
    });

    // Load the model at boot rather than on the first meeting, so the very first
    // sentence of a recording is transcribed instead of being spent on warm-up.
    let warm_stt = stt.clone();
    tokio::spawn(async move { warm_stt.ensure_ready().await });

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
    let response = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nConnection: close\r\n\r\n", body.as_bytes().len());
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
            json!({"status":"ok","version":VERSION,"uptimeSeconds":((now_ms()-state.started_at).max(0)/1000),"state":state.session.lock().await.state.as_str(),"stt":state.stt.status_value().await}),
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
            let stt = state.stt.status_value().await;
            json_response(
                200,
                json!({"settings": {"whisperModel": stt["model"], "sttLanguage": stt["language"]}}),
            )
        }
        ("POST", "/api/settings") => {
            let settings = body.get("settings").cloned().unwrap_or_else(|| body.clone());
            let mut warnings = Vec::new();

            if let Some(language) = settings.get("sttLanguage").and_then(Value::as_str) {
                if let Err(cause) = state.stt.set_language(language).await {
                    warnings.push(cause);
                }
            }
            if let Some(model) = settings.get("whisperModel").and_then(Value::as_str) {
                if let Err(cause) = state.stt.set_model(model).await {
                    warnings.push(cause);
                }
            }

            json_response(
                200,
                json!({"success": warnings.is_empty(), "warnings": warnings, "stt": state.stt.status_value().await}),
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
            json_response(200, json!({"success": true, "stt": state.stt.status_value().await}))
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
        ("GET", "/api/search") => {
            let q = req.query.get("q").map(String::as_str).unwrap_or("");
            json_response(
                200,
                json!({"results":state.store.list(q,req.query.get("limit").and_then(|v|v.parse().ok()).unwrap_or(50),0).await}),
            )
        }
        _ => route_meeting(req, state, &body).await,
    }
}

async fn route_meeting(
    req: &HttpRequest,
    state: &AppState,
    body: &Value,
) -> (u16, &'static str, String) {
    let parts: Vec<_> = req.path.trim_matches('/').split('/').collect();
    if parts.len() >= 3 && parts[0] == "api" && parts[1] == "meetings" {
        let id = parts[2];
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
            if !meeting.transcript.is_empty() && (regenerate || meeting.summary_markdown.is_empty()) {
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
            let owner = item.get("owner").and_then(Value::as_str).unwrap_or("Unassigned");
            let deadline = item.get("deadline").and_then(Value::as_str).unwrap_or("TBD");
            out.push_str(&format!("- **{owner}** — {task} ({deadline})\n"));
        }
        out.push('\n');
    }
    if !meeting.email_draft.is_empty() {
        out.push_str(&format!("## Follow-Up Email\n\n{}\n\n", meeting.email_draft));
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
