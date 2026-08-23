//! On-device speech-to-text.
//!
//! Inference runs in a WhisperKit sidecar (`whisperkit-cli serve`) rather than
//! in-process: the Core ML models are Swift-side, and serve mode keeps them warm
//! on the Neural Engine so each utterance costs one HTTP round trip instead of a
//! fresh model load. The sidecar speaks the OpenAI transcription API, which is
//! the same contract the Electron app's own sidecar uses, so a machine set up for
//! one is set up for both.
//!
//! When no engine is installed the service reports `unavailable` and transcribes
//! nothing. It never invents text.

use serde_json::{json, Value};
use std::{
    env, io,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    process::{Child, Command},
    sync::{Mutex, RwLock},
    time::{sleep, timeout, Instant},
};

const DEFAULT_PORT: u16 = 50862;
const DEFAULT_MODEL: &str = "small";
/// "auto" lets Whisper detect the language per utterance, which is what a
/// meeting that mixes languages needs.
const DEFAULT_LANGUAGE: &str = "auto";
const MODEL_PREFIX: &str = "openai_whisper-";
/// Every WhisperKit model directory needs these three compiled Core ML bundles;
/// a partial download loads as far as the server and then fails.
const REQUIRED_MODEL_PARTS: [&str; 3] = ["MelSpectrogram.mlmodelc", "AudioEncoder.mlmodelc", "TextDecoder.mlmodelc"];
const CACHED_MODEL_ROOT: &str = "Documents/huggingface/models/argmaxinc/whisperkit-coreml";

/// A cold sidecar has to load (or download) Core ML weights before it answers.
const READY_TIMEOUT: Duration = Duration::from_secs(300);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(400);
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Clone, Debug, PartialEq)]
pub enum EngineStatus {
    Unavailable,
    Stopped,
    Starting,
    Ready,
    Failed(String),
}

impl EngineStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Failed(_) => "failed",
        }
    }
}

#[derive(Clone, Debug)]
struct EngineConfig {
    model: String,
    model_path: Option<PathBuf>,
    language: String,
}

pub struct SttService {
    binary: Option<PathBuf>,
    config: RwLock<EngineConfig>,
    host: String,
    port: u16,
    status: Mutex<EngineStatus>,
    child: Mutex<Option<Child>>,
    start_lock: Mutex<()>,
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let paths = env::var_os("PATH")?;
    env::split_paths(&paths)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn model_root() -> Option<PathBuf> {
    let home = env::var_os("HOME")?;
    Some(Path::new(&home).join(CACHED_MODEL_ROOT))
}

fn cached_model_path(model: &str) -> Option<PathBuf> {
    let candidate = model_root()?.join(format!("{MODEL_PREFIX}{model}"));
    candidate.is_dir().then_some(candidate)
}

/// A model directory only counts as usable when each Core ML bundle carries its
/// compiled payload. This is what tells a half-downloaded model apart from a
/// working one before it is ever selected.
fn model_is_usable(path: &Path) -> bool {
    REQUIRED_MODEL_PARTS
        .iter()
        .all(|part| path.join(part).join("coremldata.bin").is_file())
}

/// Models present on this machine, so the UI can offer only what can load.
pub fn available_models() -> Vec<Value> {
    let Some(root) = model_root() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&root) else { return Vec::new() };

    let mut models: Vec<Value> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let model = name.strip_prefix(MODEL_PREFIX)?.to_string();
            Some(json!({
                "model": model,
                "usable": model_is_usable(&entry.path()),
                "path": entry.path().display().to_string(),
            }))
        })
        .collect();

    models.sort_by(|a, b| a["model"].as_str().unwrap_or("").cmp(b["model"].as_str().unwrap_or("")));
    models
}

impl SttService {
    pub fn detect() -> Self {
        let binary = env::var_os("CORE_BACKEND_WHISPER_BIN")
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .or_else(|| find_in_path("whisperkit-cli"))
            .or_else(|| find_in_path("argmax-cli"));

        let model = env::var("CORE_BACKEND_STT_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into());
        let model_path = env::var_os("CORE_BACKEND_STT_MODEL_PATH")
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .or_else(|| cached_model_path(&model));

        let status = if binary.is_some() {
            EngineStatus::Stopped
        } else {
            EngineStatus::Unavailable
        };

        Self {
            binary,
            config: RwLock::new(EngineConfig {
                model,
                model_path,
                language: env::var("CORE_BACKEND_STT_LANGUAGE").unwrap_or_else(|_| DEFAULT_LANGUAGE.into()),
            }),
            host: env::var("CORE_BACKEND_STT_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            port: env::var("CORE_BACKEND_STT_PORT")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(DEFAULT_PORT),
            status: Mutex::new(status),
            child: Mutex::new(None),
            start_lock: Mutex::new(()),
        }
    }

    pub fn engine(&self) -> &'static str {
        if self.binary.is_some() {
            "whisperkit"
        } else {
            "unavailable"
        }
    }

    pub fn is_available(&self) -> bool {
        self.binary.is_some()
    }

    pub async fn status_value(&self) -> Value {
        let status = self.status.lock().await.clone();
        let config = self.config.read().await.clone();
        json!({
            "engine": self.engine(),
            "status": status.as_str(),
            "error": match &status { EngineStatus::Failed(message) => Some(message.clone()), _ => None },
            "model": config.model,
            "modelPath": config.model_path.as_ref().map(|path| path.display().to_string()),
            "language": config.language,
            "availableModels": available_models(),
            "endpoint": format!("http://{}:{}", self.host, self.port),
        })
    }

    /// Switch decoding language. Whisper takes this per request, so this costs
    /// nothing and takes effect on the next utterance.
    pub async fn set_language(&self, language: &str) -> Result<(), String> {
        let normalised = language.trim().to_lowercase();
        let valid = normalised == "auto" || (normalised.len() >= 2 && normalised.len() <= 8 && normalised.chars().all(|c| c.is_ascii_alphabetic()));
        if !valid {
            return Err(format!("'{language}' is not a language code"));
        }
        self.config.write().await.language = normalised;
        Ok(())
    }

    /// Switch model. The sidecar loads one model at a time, so this tears it down
    /// and brings it back up; callers should watch the status rather than wait,
    /// because a large model can take minutes to compile for the Neural Engine.
    pub async fn set_model(self: &std::sync::Arc<Self>, model: &str) -> Result<(), String> {
        let requested = model.trim();
        if requested.is_empty() {
            return Err("no model given".into());
        }

        if self.config.read().await.model == requested {
            return Ok(());
        }

        let path = cached_model_path(requested).ok_or_else(|| format!("model '{requested}' is not downloaded on this machine"))?;
        if !model_is_usable(&path) {
            return Err(format!("model '{requested}' is present but incomplete — re-download it"));
        }

        self.shutdown().await;
        {
            let mut config = self.config.write().await;
            config.model = requested.to_string();
            config.model_path = Some(path);
        }

        let service = self.clone();
        tokio::spawn(async move { service.ensure_ready().await });
        Ok(())
    }

    async fn set_status(&self, next: EngineStatus) {
        *self.status.lock().await = next;
    }

    /// Bring the sidecar up if it isn't already. Safe to call repeatedly; only
    /// the first caller does the work.
    pub async fn ensure_ready(&self) {
        if !self.is_available() {
            return;
        }

        let _guard = self.start_lock.lock().await;
        if matches!(*self.status.lock().await, EngineStatus::Ready) {
            return;
        }

        // A sidecar someone else already started on this port is fine to reuse.
        if self.probe_health().await {
            self.set_status(EngineStatus::Ready).await;
            return;
        }

        self.set_status(EngineStatus::Starting).await;

        let binary = self.binary.clone().expect("availability checked above");
        let config = self.config.read().await.clone();
        let mut command = Command::new(binary);
        command.arg("serve");

        match &config.model_path {
            Some(path) => {
                command.arg("--model-path").arg(path);
            }
            None => {
                command.arg("--model").arg(&config.model);
            }
        }

        // With "auto" the language is left off so Whisper detects it; a fixed
        // language is still sent per request, so this only sets the default.
        if config.language != "auto" {
            command.arg("--language").arg(&config.language);
        }

        command
            // Whisper's own gates: a segment the model considers silence, or
            // decodes with low confidence, comes back empty instead of
            // hallucinated. This is the second line of defence after the VAD.
            .arg("--no-speech-threshold")
            .arg("0.6")
            // A negative value has to use the `flag=value` form, or the argument
            // parser reads "-1.0" as another flag and exits with a usage error.
            .arg("--logprob-threshold=-1.0")
            .arg("--temperature")
            .arg("0.0")
            .arg("--host")
            .arg(&self.host)
            .arg("--port")
            .arg(self.port.to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);

        match command.spawn() {
            Ok(child) => {
                *self.child.lock().await = Some(child);
            }
            Err(cause) => {
                self.set_status(EngineStatus::Failed(format!("could not start the transcription sidecar: {cause}")))
                    .await;
                return;
            }
        }

        let deadline = Instant::now() + READY_TIMEOUT;
        while Instant::now() < deadline {
            if self.probe_health().await {
                self.set_status(EngineStatus::Ready).await;
                println!(
                    "[Alpha Core Backend] transcription ready on http://{}:{} (model {}, language {})",
                    self.host, self.port, config.model, config.language
                );
                return;
            }

            // A sidecar that exits during model load will never answer /health.
            let mut child = self.child.lock().await;
            if let Some(handle) = child.as_mut() {
                if let Ok(Some(exit)) = handle.try_wait() {
                    *child = None;
                    drop(child);
                    self.set_status(EngineStatus::Failed(format!(
                        "transcription sidecar exited during startup ({exit})"
                    )))
                    .await;
                    return;
                }
            }
            drop(child);

            sleep(HEALTH_POLL_INTERVAL).await;
        }

        self.set_status(EngineStatus::Failed("transcription sidecar did not become ready in time".into()))
            .await;
    }

    async fn probe_health(&self) -> bool {
        matches!(
            timeout(Duration::from_millis(1200), http_get(&self.host, self.port, "/health")).await,
            Ok(Ok((status, _))) if status < 500
        )
    }

    /// Transcribe one utterance. Returns the recognised text, which may be empty
    /// when the segment held no speech after all.
    pub async fn transcribe(&self, wav: Vec<u8>) -> Result<String, String> {
        if !self.is_available() {
            return Err("no transcription engine is installed".into());
        }

        if !matches!(*self.status.lock().await, EngineStatus::Ready) {
            self.ensure_ready().await;
            if !matches!(*self.status.lock().await, EngineStatus::Ready) {
                return Err("the transcription engine is not ready".into());
            }
        }

        let config = self.config.read().await.clone();
        let boundary = format!("----AlphaCore{}", std::process::id());
        let mut body = Vec::with_capacity(wav.len() + 512);

        let mut field = |name: &str, value: &str| {
            body.extend_from_slice(
                format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes(),
            );
        };
        // The server rejects a request without `model`; `language` is honoured per
        // request, so "auto" simply leaves it out and lets Whisper decide.
        field("model", &config.model);
        if config.language != "auto" {
            field("language", &config.language);
        }
        field("response_format", "json");

        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"utterance.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(&wav);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

        let content_type = format!("multipart/form-data; boundary={boundary}");
        let request = timeout(
            TRANSCRIBE_TIMEOUT,
            http_post(&self.host, self.port, "/v1/audio/transcriptions", &content_type, body),
        );

        let (status, payload) = match request.await {
            Ok(Ok(response)) => response,
            Ok(Err(cause)) => {
                self.set_status(EngineStatus::Failed(format!("transcription request failed: {cause}")))
                    .await;
                return Err(format!("transcription request failed: {cause}"));
            }
            Err(_) => return Err("transcription timed out".into()),
        };

        if status != 200 {
            return Err(format!(
                "transcription engine returned {status}: {}",
                payload.chars().take(200).collect::<String>()
            ));
        }

        let parsed: Value =
            serde_json::from_str(&payload).map_err(|cause| format!("transcription engine returned invalid JSON: {cause}"))?;

        Ok(parsed
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string())
    }

    pub async fn shutdown(&self) {
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }
        if self.is_available() {
            self.set_status(EngineStatus::Stopped).await;
        }
    }
}

async fn http_get(host: &str, port: u16, path: &str) -> io::Result<(u16, String)> {
    let mut stream = TcpStream::connect((host, port)).await?;
    let request = format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await?;
    read_response(stream).await
}

async fn http_post(host: &str, port: u16, path: &str, content_type: &str, body: Vec<u8>) -> io::Result<(u16, String)> {
    let mut stream = TcpStream::connect((host, port)).await?;
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&body).await?;
    stream.flush().await?;
    read_response(stream).await
}

async fn read_response(mut stream: TcpStream) -> io::Result<(u16, String)> {
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await?;
    let text = String::from_utf8_lossy(&raw).to_string();

    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);

    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default();

    Ok((status, body))
}
