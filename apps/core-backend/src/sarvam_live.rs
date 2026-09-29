
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    sync::mpsc,
    task::JoinHandle,
    time::{interval_at, sleep, timeout, Instant},
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};

const DEFAULT_URL: &str = "wss://api.sarvam.ai/speech-to-text-realtime/ws";
const DEFAULT_MODEL: &str = "saaras:v3-realtime";
const SAMPLE_RATE: u32 = 16_000;
const BYTES_PER_MS: i64 = (SAMPLE_RATE as i64 / 1000) * 2;
const MIN_CHUNK_BYTES: usize = 3_200;
const MAX_CHUNK_BYTES: usize = 32_000;
const PING_INTERVAL: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const END_DRAIN: Duration = Duration::from_secs(6);
const RECONNECT_BACKOFF_MS: [u64; 4] = [500, 1_000, 2_000, 5_000];

#[derive(Clone, Debug)]
pub struct LiveConfig {
    pub language: String,
    pub mode: String,
    pub endpoint: String,
}

impl Default for LiveConfig {
    fn default() -> Self {
        Self {
            language: "auto".into(),
            mode: "transcribe".into(),
            endpoint: kesami_core_backend::env_compat::var("KESAMI_SARVAM_REALTIME_URL").unwrap_or_else(|_| DEFAULT_URL.into()),
        }
    }
}

impl LiveConfig {
    pub fn validate(mut self) -> Result<Self, String> {
        self.language = self.language.trim().to_string();
        self.endpoint = self.endpoint.trim().to_string();
        if self.endpoint.is_empty() {
            self.endpoint = DEFAULT_URL.into();
        }
        self.mode = self.mode.trim().to_ascii_lowercase();
        if self.language.is_empty() || self.language.eq_ignore_ascii_case("unknown") {
            self.language = "auto".into();
        }
        if !matches!(
            self.mode.as_str(),
            "transcribe" | "translate" | "verbatim" | "translit" | "codemix"
        ) {
            return Err(format!("'{}' is not a Sarvam transcription mode", self.mode));
        }
        Ok(self)
    }

    fn url(&self) -> String {
        let base = &self.endpoint;
        let model = kesami_core_backend::env_compat::var("KESAMI_SARVAM_REALTIME_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into());
        let separator = if base.contains('?') { '&' } else { '?' };
        format!(
            "{base}{separator}model={model}&language_code={}&mode={}&encoding=linear16&sample_rate={SAMPLE_RATE}&return_timestamps=true",
            self.language, self.mode
        )
    }
}

pub fn model_name() -> String {
    kesami_core_backend::env_compat::var("KESAMI_SARVAM_REALTIME_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into())
}

#[derive(Clone, Debug, PartialEq)]
pub enum LiveEvent {
    Partial {
        stream_id: u32,
        text: String,
    },
    Final {
        stream_id: u32,
        text: String,
        language: Option<String>,
        start_ms: i64,
        end_ms: i64,
    },
    Notice {
        stream_id: u32,
        message: String,
        fatal: bool,
    },
}

#[derive(Debug, PartialEq)]
enum ServerEvent {
    Partial {
        text: String,
    },
    Final {
        text: String,
        language: Option<String>,
        start_s: Option<f64>,
        end_s: Option<f64>,
    },
    Failed {
        message: String,
        fatal: bool,
    },
    Ended,
    Ignored,
}

fn parse_server_event(payload: &Value) -> ServerEvent {
    let event = payload
        .get("event")
        .or_else(|| payload.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let text = || {
        payload
            .get("text")
            .or_else(|| payload.get("transcript"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    match event {
        "transcript.partial" => {
            let text = text();
            if text.is_empty() {
                ServerEvent::Ignored
            } else {
                ServerEvent::Partial { text }
            }
        }
        "transcript.final" => {
            let text = text();
            if text.is_empty() {
                ServerEvent::Ignored
            } else {
                ServerEvent::Final {
                    text,
                    language: payload
                        .get("language")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .filter(|value| !value.is_empty()),
                    start_s: payload.get("start_s").and_then(Value::as_f64),
                    end_s: payload.get("end_s").and_then(Value::as_f64),
                }
            }
        }
        "error" => ServerEvent::Failed {
            message: payload
                .get("message")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("Sarvam reported an error")
                .to_string(),
            fatal: payload
                .get("is_fatal")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || payload.get("status_code").is_some(),
        },
        "session.end" => ServerEvent::Ended,
        _ => ServerEvent::Ignored,
    }
}

fn handshake_is_fatal(cause: &str) -> bool {
    ["401", "403", "404", "422"]
        .iter()
        .any(|status| cause.contains(status))
}

struct StreamHandle {
    stream_id: u32,
    audio: Option<mpsc::UnboundedSender<(i64, Vec<u8>)>>,
    fed_ms: Arc<AtomicI64>,
    task: JoinHandle<()>,
}

pub struct LiveTranscriber {
    streams: Vec<StreamHandle>,
}

impl LiveTranscriber {
    pub fn start(
        key: String,
        config: LiveConfig,
        stream_ids: &[u32],
        events: mpsc::UnboundedSender<LiveEvent>,
    ) -> Self {
        let streams = stream_ids
            .iter()
            .map(|stream_id| {
                let (audio, audio_rx) = mpsc::unbounded_channel();
                let fed_ms = Arc::new(AtomicI64::new(0));
                let task = tokio::spawn(supervise(
                    key.clone(),
                    config.clone(),
                    *stream_id,
                    audio_rx,
                    fed_ms.clone(),
                    events.clone(),
                ));
                StreamHandle {
                    stream_id: *stream_id,
                    audio: Some(audio),
                    fed_ms,
                    task,
                }
            })
            .collect();
        Self { streams }
    }

    pub fn feed(&self, stream_id: u32, pcm: &[u8]) {
        let Some(stream) = self
            .streams
            .iter()
            .find(|stream| stream.stream_id == stream_id)
        else {
            return;
        };
        let offset_ms = stream
            .fed_ms
            .fetch_add(pcm.len() as i64 / BYTES_PER_MS, Ordering::SeqCst);
        if let Some(audio) = stream.audio.as_ref() {
            let _ = audio.send((offset_ms, pcm.to_vec()));
        }
    }

    pub async fn finish(mut self, budget: Duration) {
        for stream in self.streams.iter_mut() {
            stream.audio.take();
        }
        let deadline = Instant::now() + budget;
        for mut stream in self.streams {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if timeout(remaining, &mut stream.task).await.is_err() {
                stream.task.abort();
                let _ = stream.task.await;
            }
        }
    }
}

enum Pump {
    Finished,
    Fatal(String),
    Dropped(String),
}

async fn supervise(
    key: String,
    config: LiveConfig,
    stream_id: u32,
    mut audio_rx: mpsc::UnboundedReceiver<(i64, Vec<u8>)>,
    fed_ms: Arc<AtomicI64>,
    events: mpsc::UnboundedSender<LiveEvent>,
) {
    let notice = |message: String, fatal: bool| {
        let _ = events.send(LiveEvent::Notice {
            stream_id,
            message,
            fatal,
        });
    };
    let mut attempt = 0usize;
    loop {
        let outcome = match connect(&key, &config).await {
            Ok(socket) => {
                attempt = 0;
                pump(socket, &mut audio_rx, stream_id, &fed_ms, &events).await
            }
            Err(cause) => {
                if handshake_is_fatal(&cause) {
                    Pump::Fatal(cause)
                } else {
                    Pump::Dropped(cause)
                }
            }
        };
        match outcome {
            Pump::Finished => return,
            Pump::Fatal(message) => {
                notice(message, true);
                return;
            }
            Pump::Dropped(message) => notice(message, false),
        }

        let wait = RECONNECT_BACKOFF_MS[attempt.min(RECONNECT_BACKOFF_MS.len() - 1)];
        attempt += 1;
        if !discard_audio_for(&mut audio_rx, Duration::from_millis(wait)).await {
            return;
        }
    }
}

type Socket = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn connect(key: &str, config: &LiveConfig) -> Result<Socket, String> {
    let mut request = config
        .url()
        .into_client_request()
        .map_err(|cause| format!("Sarvam realtime URL is not usable: {cause}"))?;
    let header = HeaderValue::from_str(key)
        .map_err(|_| "the Sarvam API key contains characters a header cannot carry".to_string())?;
    request
        .headers_mut()
        .insert("api-subscription-key", header);
    let (socket, _) = timeout(CONNECT_TIMEOUT, connect_async(request))
        .await
        .map_err(|_| "the Sarvam realtime connection timed out".to_string())?
        .map_err(|cause| format!("could not open the Sarvam realtime socket: {cause}"))?;
    Ok(socket)
}

async fn pump(
    socket: Socket,
    audio_rx: &mut mpsc::UnboundedReceiver<(i64, Vec<u8>)>,
    stream_id: u32,
    fed_ms: &Arc<AtomicI64>,
    events: &mpsc::UnboundedSender<LiveEvent>,
) -> Pump {
    let (mut sink, mut stream) = socket.split();
    let mut pending: Vec<u8> = Vec::with_capacity(MAX_CHUNK_BYTES);
    let mut base_ms = fed_ms.load(Ordering::SeqCst);
    let mut opened = false;
    let mut last_end_ms = base_ms;
    let mut ping = interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);

    loop {
        tokio::select! {
            chunk = audio_rx.recv() => match chunk {
                Some((offset_ms, pcm)) => {
                    if !opened {
                        opened = true;
                        base_ms = offset_ms;
                        last_end_ms = offset_ms;
                    }
                    pending.extend_from_slice(&pcm);
                    while pending.len() >= MIN_CHUNK_BYTES {
                        let take = pending.len().min(MAX_CHUNK_BYTES);
                        let payload: Vec<u8> = pending.drain(..take).collect();
                        if let Err(cause) = send_audio(&mut sink, &payload).await {
                            return Pump::Dropped(cause);
                        }
                    }
                }
                None => {
                    if !pending.is_empty() {
                        let payload = std::mem::take(&mut pending);
                        let _ = send_audio(&mut sink, &payload).await;
                    }
                    let _ = sink.send(Message::text(json!({"event": "end"}).to_string())).await;
                    drain_after_end(&mut stream, stream_id, base_ms, fed_ms, &mut last_end_ms, events).await;
                    let _ = sink.close().await;
                    return Pump::Finished;
                }
            },
            message = stream.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    match handle_text(text.as_str(), stream_id, base_ms, fed_ms, &mut last_end_ms, events) {
                        Some(Pump::Fatal(cause)) => return Pump::Fatal(cause),
                        Some(other) => return other,
                        None => {}
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    return close_outcome(frame.as_ref().map(|frame| u16::from(frame.code)));
                }
                None => return Pump::Dropped("the Sarvam realtime socket closed".into()),
                Some(Ok(_)) => {}
                Some(Err(cause)) => {
                    return Pump::Dropped(format!("the Sarvam realtime socket failed: {cause}"));
                }
            },
            _ = ping.tick() => {
                if sink.send(Message::text(json!({"event": "ping"}).to_string())).await.is_err() {
                    return Pump::Dropped("the Sarvam realtime socket stopped accepting messages".into());
                }
            }
        }
    }
}

// Sarvam documents 1003 for subscription/quota failures and 4000 for
// invalid configuration; retrying these indefinitely cannot recover them.
fn close_outcome(code: Option<u16>) -> Pump {
    match code {
        Some(1003) => Pump::Fatal("Sarvam rejected the subscription or usage limit. Check the API key and account quota in Settings.".into()),
        Some(4000) => Pump::Fatal("Sarvam rejected the transcription configuration. Check the model, language and account access.".into()),
        _ => Pump::Dropped("the Sarvam realtime socket closed; reconnecting".into()),
    }
}

async fn send_audio<S>(sink: &mut S, pcm: &[u8]) -> Result<(), String>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::fmt::Display,
{
    let message = json!({"event": "audio_input", "audio": BASE64.encode(pcm)}).to_string();
    sink.send(Message::text(message))
        .await
        .map_err(|cause| format!("could not send audio to Sarvam: {cause}"))
}

fn handle_text(
    text: &str,
    stream_id: u32,
    base_ms: i64,
    fed_ms: &Arc<AtomicI64>,
    last_end_ms: &mut i64,
    events: &mpsc::UnboundedSender<LiveEvent>,
) -> Option<Pump> {
    let payload: Value = serde_json::from_str(text).ok()?;
    match parse_server_event(&payload) {
        ServerEvent::Partial { text } => {
            let _ = events.send(LiveEvent::Partial { stream_id, text });
            None
        }
        ServerEvent::Final {
            text,
            language,
            start_s,
            end_s,
        } => {
            let (start_ms, end_ms) = turn_bounds(base_ms, *last_end_ms, fed_ms, start_s, end_s);
            *last_end_ms = end_ms;
            let _ = events.send(LiveEvent::Final {
                stream_id,
                text,
                language,
                start_ms,
                end_ms,
            });
            None
        }
        ServerEvent::Failed { message, fatal } => {
            if fatal {
                Some(Pump::Fatal(message))
            } else {
                let _ = events.send(LiveEvent::Notice {
                    stream_id,
                    message,
                    fatal: false,
                });
                None
            }
        }
        ServerEvent::Ended => Some(Pump::Dropped("Sarvam ended the realtime session".into())),
        ServerEvent::Ignored => None,
    }
}

fn turn_bounds(
    base_ms: i64,
    last_end_ms: i64,
    fed_ms: &Arc<AtomicI64>,
    start_s: Option<f64>,
    end_s: Option<f64>,
) -> (i64, i64) {
    match (start_s, end_s) {
        (Some(start), Some(end)) => {
            let start_ms = base_ms + (start * 1000.0).round() as i64;
            let end_ms = base_ms + (end * 1000.0).round() as i64;
            (start_ms, end_ms.max(start_ms))
        }
        _ => {
            let end_ms = fed_ms.load(Ordering::SeqCst).max(last_end_ms);
            (last_end_ms, end_ms)
        }
    }
}

async fn drain_after_end<S>(
    stream: &mut S,
    stream_id: u32,
    base_ms: i64,
    fed_ms: &Arc<AtomicI64>,
    last_end_ms: &mut i64,
    events: &mpsc::UnboundedSender<LiveEvent>,
) where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let deadline = Instant::now() + END_DRAIN;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return;
        }
        match timeout(remaining, stream.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                if handle_text(
                    text.as_str(),
                    stream_id,
                    base_ms,
                    fed_ms,
                    last_end_ms,
                    events,
                )
                .is_some()
                {
                    return;
                }
            }
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Err(_) => return,
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) => return,
        }
    }
}

async fn discard_audio_for(
    audio_rx: &mut mpsc::UnboundedReceiver<(i64, Vec<u8>)>,
    wait: Duration,
) -> bool {
    let deadline = Instant::now() + wait;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return true;
        }
        tokio::select! {
            chunk = audio_rx.recv() => {
                if chunk.is_none() {
                    return false;
                }
            }
            _ = sleep(remaining) => return true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn automatic_detection_uses_the_realtime_spelling() {
        let config = LiveConfig {
            language: " unknown ".into(),
            mode: "Transcribe".into(),
            ..LiveConfig::default()
        }
        .validate()
        .unwrap();
        assert_eq!(config.language, "auto");
        assert_eq!(config.mode, "transcribe");
        assert!(config.url().contains("language_code=auto"));
        assert!(config.url().contains("encoding=linear16"));
        assert!(config.url().contains("sample_rate=16000"));
    }

    #[test]
    fn an_unknown_mode_is_rejected_before_a_socket_is_opened() {
        let config = LiveConfig {
            language: "hi-IN".into(),
            mode: "summarize".into(),
            ..LiveConfig::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn parses_partial_and_final_transcripts() {
        assert_eq!(
            parse_server_event(&json!({"event":"transcript.partial","text":" hello "})),
            ServerEvent::Partial {
                text: "hello".into()
            }
        );
        assert_eq!(
            parse_server_event(&json!({
                "event":"transcript.final","text":"hello there","language":"hi-IN",
                "start_s":1.5,"end_s":3.25
            })),
            ServerEvent::Final {
                text: "hello there".into(),
                language: Some("hi-IN".into()),
                start_s: Some(1.5),
                end_s: Some(3.25),
            }
        );
        assert_eq!(
            parse_server_event(&json!({"event":"vad.speech_start","utterance_idx":1})),
            ServerEvent::Ignored
        );
        assert_eq!(
            parse_server_event(&json!({"event":"transcript.final","text":"   "})),
            ServerEvent::Ignored
        );
    }

    #[test]
    fn a_rejected_key_is_fatal_but_a_dropped_socket_is_not() {
        assert_eq!(
            parse_server_event(&json!({"event":"error","message":"bad key","status_code":401})),
            ServerEvent::Failed {
                message: "bad key".into(),
                fatal: true
            }
        );
        assert_eq!(
            parse_server_event(&json!({"event":"error","message":"slow down","is_fatal":false})),
            ServerEvent::Failed {
                message: "slow down".into(),
                fatal: false
            }
        );
        assert!(handshake_is_fatal("HTTP error: 401 Unauthorized"));
        assert!(!handshake_is_fatal("connection reset by peer"));
    }

    #[test]
    fn timestamps_fall_back_to_the_fed_audio_clock() {
        let fed = Arc::new(AtomicI64::new(9_000));
        assert_eq!(
            turn_bounds(2_000, 2_000, &fed, Some(0.5), Some(1.25)),
            (2_500, 3_250)
        );
        assert_eq!(turn_bounds(2_000, 4_000, &fed, None, None), (4_000, 9_000));
    }

    async fn scripted_server(script: Vec<Value>) -> (String, JoinHandle<Vec<Value>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/ws", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
            let mut received = Vec::new();
            while let Some(Ok(message)) = socket.next().await {
                let Message::Text(text) = message else {
                    continue;
                };
                let payload: Value = serde_json::from_str(text.as_str()).unwrap();
                let event = payload["event"].as_str().unwrap_or("").to_string();
                received.push(payload);
                if event == "audio_input" && received.len() == 1 {
                    for reply in &script {
                        socket
                            .send(Message::text(reply.to_string()))
                            .await
                            .unwrap();
                    }
                }
                if event == "end" {
                    let _ = socket.send(Message::text(json!({"event":"session.end"}).to_string())).await;
                    break;
                }
            }
            received
        });
        (url, task)
    }

    #[tokio::test]
    async fn reconnects_when_the_socket_drops_mid_meeting() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/ws", listener.local_addr().unwrap());
        tokio::spawn(async move {
            for connection in 0..2u32 {
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
                while let Some(Ok(message)) = socket.next().await {
                    let Message::Text(text) = message else {
                        continue;
                    };
                    if serde_json::from_str::<Value>(text.as_str()).unwrap()["event"] != "audio_input" {
                        continue;
                    }
                    if connection == 0 {
                        let _ = socket.close(None).await;
                        break;
                    }
                    socket
                        .send(Message::text(
                            json!({"event":"transcript.final","text":"back"}).to_string(),
                        ))
                        .await
                        .unwrap();
                }
            }
        });
        let (events, mut received) = mpsc::unbounded_channel();
        let transcriber = Arc::new(LiveTranscriber::start(
            "test-key".into(),
            LiveConfig {
                endpoint: url,
                ..LiveConfig::default()
            },
            &[1],
            events,
        ));
        let feeder = transcriber.clone();
        let feeding = tokio::spawn(async move {
            loop {
                feeder.feed(1, &vec![0u8; MIN_CHUNK_BYTES]);
                sleep(Duration::from_millis(50)).await;
            }
        });

        let mut recovered = None;
        while let Ok(Some(event)) = timeout(Duration::from_secs(10), received.recv()).await {
            if let LiveEvent::Final { text, .. } = &event {
                recovered = Some(text.clone());
                break;
            }
        }
        feeding.abort();
        assert_eq!(recovered.as_deref(), Some("back"));
    }

    #[tokio::test]
    async fn streams_audio_and_reports_the_turns_it_gets_back() {
        let (url, server) = scripted_server(vec![
            json!({"event":"transcript.partial","text":"hel"}),
            json!({"event":"transcript.final","text":"hello","language":"en-IN","start_s":0.0,"end_s":0.4}),
        ])
        .await;
        let (events, mut received) = mpsc::unbounded_channel();
        let transcriber = LiveTranscriber::start(
            "test-key".into(),
            LiveConfig {
                endpoint: url,
                ..LiveConfig::default()
            },
            &[0],
            events,
        );
        transcriber.feed(0, &vec![0u8; MIN_CHUNK_BYTES]);

        let partial = timeout(Duration::from_secs(5), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            partial,
            LiveEvent::Partial {
                stream_id: 0,
                text: "hel".into()
            }
        );
        let final_turn = timeout(Duration::from_secs(5), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            final_turn,
            LiveEvent::Final {
                stream_id: 0,
                text: "hello".into(),
                language: Some("en-IN".into()),
                start_ms: 0,
                end_ms: 400,
            }
        );

        transcriber.finish(Duration::from_secs(5)).await;
        let sent = server.await.unwrap();
        assert_eq!(sent[0]["event"], "audio_input");
        assert_eq!(
            BASE64.decode(sent[0]["audio"].as_str().unwrap()).unwrap().len(),
            MIN_CHUNK_BYTES
        );
        assert_eq!(sent.last().unwrap()["event"], "end");
    }
    #[test]
    fn subscription_and_configuration_close_codes_do_not_retry_forever() {
        assert!(matches!(close_outcome(Some(1003)), Pump::Fatal(_)));
        assert!(matches!(close_outcome(Some(4000)), Pump::Fatal(_)));
        assert!(matches!(close_outcome(Some(1011)), Pump::Dropped(_)));
        assert!(matches!(close_outcome(Some(1008)), Pump::Dropped(_)));
    }

    #[tokio::test]
    async fn finish_aborts_a_provider_task_that_exceeds_the_drain_budget() {
        let (audio, _receiver) = mpsc::unbounded_channel();
        let (events, mut received) = mpsc::unbounded_channel::<()>();
        let task = tokio::spawn(async move {
            let _hold = events;
            std::future::pending::<()>().await;
        });
        let live = LiveTranscriber { streams: vec![StreamHandle {
            stream_id: 0, audio: Some(audio), fed_ms: Arc::new(AtomicI64::new(0)), task,
        }] };
        live.finish(Duration::from_millis(10)).await;
        assert_eq!(timeout(Duration::from_millis(100), received.recv()).await.unwrap(), None);
    }

}
