//! Sarvam Saaras batch transcription with speaker diarization.
//!
//! This is deliberately separate from the live WhisperKit service. Sarvam sees
//! the completed mixed recording once, returns timestamped speaker turns, and
//! only then does the normal meeting-summary pipeline run.

use reqwest::{header, Client, RequestBuilder, Response};
use serde_json::{json, Value};
use std::{collections::HashMap, env, path::Path, time::Duration};
use tokio::{fs::File, sync::RwLock, time::Instant};
use tokio_util::io::ReaderStream;

const DEFAULT_BASE_URL: &str = "https://api.sarvam.ai";
const DEFAULT_MODEL: &str = "saaras:v3";
const DEFAULT_TIMEOUT_SECS: u64 = 900;
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const MIC_ATTRIBUTION_MIN_MS: i64 = 3_000;
const MIC_ATTRIBUTION_MIN_SHARE: f64 = 0.6;

#[derive(Clone, Debug)]
pub struct BatchConfig {
    pub language: String,
    pub mode: String,
    pub num_speakers: Option<u8>,
}

impl Default for BatchConfig {
    fn default() -> Self {
        Self {
            language: "unknown".into(),
            mode: "transcribe".into(),
            num_speakers: None,
        }
    }
}

impl BatchConfig {
    pub fn validate(mut self) -> Result<Self, String> {
        self.language = self.language.trim().to_string();
        self.mode = self.mode.trim().to_ascii_lowercase();
        if self.language.is_empty() {
            self.language = "unknown".into();
        }
        if !matches!(
            self.mode.as_str(),
            "transcribe" | "translate" | "verbatim" | "translit" | "codemix"
        ) {
            return Err(format!(
                "'{}' is not a Sarvam transcription mode",
                self.mode
            ));
        }
        if self
            .num_speakers
            .is_some_and(|count| !(1..=20).contains(&count))
        {
            return Err("Sarvam speaker count must be between 1 and 20".into());
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct BatchTurn {
    pub speaker_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub language: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct BatchTranscript {
    pub turns: Vec<BatchTurn>,
    pub language: Option<String>,
}

pub struct SarvamService {
    key: RwLock<Option<String>>,
    client: Client,
    base_url: String,
    timeout: Duration,
}

impl SarvamService {
    pub fn detect() -> Self {
        let timeout = Duration::from_secs(
            env::var("ALPHA_SARVAM_TIMEOUT_SECS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(DEFAULT_TIMEOUT_SECS),
        );
        Self {
            key: RwLock::new(
                env::var("ALPHA_SARVAM_API_KEY")
                    .ok()
                    .map(|key| key.trim().to_string())
                    .filter(|key| !key.is_empty()),
            ),
            client: Client::builder()
                .connect_timeout(Duration::from_secs(20))
                .timeout(timeout)
                .build()
                .expect("reqwest client configuration is valid"),
            base_url: env::var("ALPHA_SARVAM_BASE_URL")
                .unwrap_or_else(|_| DEFAULT_BASE_URL.into())
                .trim_end_matches('/')
                .to_string(),
            timeout,
        }
    }

    pub async fn set_api_key(&self, key: Option<String>) {
        *self.key.write().await = key
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty());
    }

    pub async fn has_key(&self) -> bool {
        self.key.read().await.is_some()
    }

    pub async fn api_key(&self) -> Option<String> {
        self.key.read().await.clone()
    }

    pub async fn status_value(&self) -> Value {
        json!({
            "provider": "sarvam",
            "model": DEFAULT_MODEL,
            "apiKeySet": self.has_key().await,
            "mode": "batch",
            "diarization": true,
        })
    }

    fn authed(&self, request: RequestBuilder, key: &str) -> RequestBuilder {
        request.header("api-subscription-key", key)
    }

    pub async fn transcribe(
        &self,
        path: &Path,
        config: BatchConfig,
    ) -> Result<BatchTranscript, String> {
        let config = config.validate()?;
        let key = self
            .key
            .read()
            .await
            .clone()
            .ok_or_else(|| "Sarvam API key is not configured".to_string())?;
        let metadata = tokio::fs::metadata(path)
            .await
            .map_err(|cause| format!("could not read the batch recording: {cause}"))?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err("the batch recording is empty".into());
        }

        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("webm");
        let upload_name = format!(
            "meeting.{}",
            extension.replace(|ch: char| !ch.is_ascii_alphanumeric(), "")
        );
        let mut parameters = json!({
            "model": DEFAULT_MODEL,
            "mode": config.mode,
            "language_code": config.language,
            "with_diarization": true,
        });
        if let Some(count) = config.num_speakers {
            parameters["num_speakers"] = json!(count);
        }

        let initiated = checked_json(
            self.authed(
                self.client
                    .post(format!("{}/speech-to-text/job/v1", self.base_url)),
                &key,
            )
            .json(&json!({"job_parameters": parameters}))
            .send()
            .await
            .map_err(|cause| format!("could not create the Sarvam batch job: {cause}"))?,
            "create Sarvam batch job",
        )
        .await?;
        let job_id = initiated["job_id"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Sarvam created a job without an id".to_string())?;

        let upload_links = checked_json(
            self.authed(
                self.client.post(format!(
                    "{}/speech-to-text/job/v1/upload-files",
                    self.base_url
                )),
                &key,
            )
            .json(&json!({"job_id": job_id, "files": [upload_name]}))
            .send()
            .await
            .map_err(|cause| format!("could not request the Sarvam upload URL: {cause}"))?,
            "request Sarvam upload URL",
        )
        .await?;
        let upload_url = file_url(&upload_links["upload_urls"], &upload_name)
            .ok_or_else(|| "Sarvam did not return an upload URL".to_string())?;

        let file = File::open(path)
            .await
            .map_err(|cause| format!("could not open the batch recording: {cause}"))?;
        let mut upload = self
            .client
            .put(upload_url.clone())
            .header(header::CONTENT_LENGTH, metadata.len())
            .header(header::CONTENT_TYPE, content_type(path))
            .body(reqwest::Body::wrap_stream(ReaderStream::new(file)));
        if upload_url.contains("blob.core.windows.net") {
            upload = upload.header("x-ms-blob-type", "BlockBlob");
        }
        checked_empty(
            upload
                .send()
                .await
                .map_err(|cause| format!("could not upload the recording to Sarvam: {cause}"))?,
            "upload recording to Sarvam",
        )
        .await?;

        checked_json(
            self.authed(
                self.client.post(format!(
                    "{}/speech-to-text/job/v1/{}/start",
                    self.base_url, job_id
                )),
                &key,
            )
            .json(&json!({}))
            .send()
            .await
            .map_err(|cause| format!("could not start the Sarvam batch job: {cause}"))?,
            "start Sarvam batch job",
        )
        .await?;

        let deadline = Instant::now() + self.timeout;
        let status = loop {
            if Instant::now() >= deadline {
                return Err(format!(
                    "Sarvam batch transcription timed out after {} seconds",
                    self.timeout.as_secs()
                ));
            }
            let status = checked_json(
                self.authed(
                    self.client.get(format!(
                        "{}/speech-to-text/job/v1/{}/status",
                        self.base_url, job_id
                    )),
                    &key,
                )
                .send()
                .await
                .map_err(|cause| format!("could not poll the Sarvam batch job: {cause}"))?,
                "poll Sarvam batch job",
            )
            .await?;
            match status["job_state"]
                .as_str()
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str()
            {
                "completed" | "partiallycompleted" | "partially_completed" => break status,
                "failed" => {
                    return Err(format!(
                        "Sarvam batch transcription failed: {}",
                        status["error_message"]
                            .as_str()
                            .filter(|value| !value.is_empty())
                            .unwrap_or("unknown error")
                    ));
                }
                _ => tokio::time::sleep(POLL_INTERVAL).await,
            }
        };

        let output_names = output_files(&status);
        if output_names.is_empty() {
            return Err("Sarvam completed the batch job without an output file".into());
        }
        let download_links = checked_json(
            self.authed(
                self.client.post(format!(
                    "{}/speech-to-text/job/v1/download-files",
                    self.base_url
                )),
                &key,
            )
            .json(&json!({"job_id": job_id, "files": output_names}))
            .send()
            .await
            .map_err(|cause| format!("could not request the Sarvam result URL: {cause}"))?,
            "request Sarvam result URL",
        )
        .await?;
        let output_name = output_names.first().expect("checked above");
        let download_url = file_url(&download_links["download_urls"], output_name)
            .ok_or_else(|| "Sarvam did not return a result URL".to_string())?;
        let result = checked_json(
            self.client
                .get(download_url)
                .send()
                .await
                .map_err(|cause| format!("could not download the Sarvam transcript: {cause}"))?,
            "download Sarvam transcript",
        )
        .await?;

        parse_transcript(&result)
    }
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" | "mp4" => "audio/mp4",
        "ogg" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "webm" => "audio/webm",
        _ => "application/octet-stream",
    }
}

fn file_url(container: &Value, name: &str) -> Option<String> {
    let value = container
        .get(name)
        .or_else(|| container.as_object()?.values().next())?;
    value
        .get("file_url")
        .and_then(Value::as_str)
        .or_else(|| value.as_str())
        .map(str::to_string)
}

fn output_files(status: &Value) -> Vec<String> {
    status["job_details"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|detail| detail["outputs"].as_array().into_iter().flatten())
        .filter_map(|output| output["file_name"].as_str().map(str::to_string))
        .collect()
}

async fn checked_empty(response: Response, action: &str) -> Result<(), String> {
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(format!(
        "could not {action} ({status}): {}",
        api_error(&body)
    ))
}

async fn checked_json(response: Response, action: &str) -> Result<Value, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|cause| format!("could not read Sarvam's response: {cause}"))?;
    if !status.is_success() {
        return Err(format!(
            "could not {action} ({status}): {}",
            api_error(&body)
        ));
    }
    serde_json::from_str(&body)
        .map_err(|_| format!("Sarvam returned invalid JSON while trying to {action}"))
}

fn api_error(body: &str) -> String {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    parsed
        .pointer("/error/message")
        .or_else(|| parsed.get("error_message"))
        .or_else(|| parsed.get("message"))
        .or_else(|| parsed.get("detail"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| body.chars().take(300).collect::<String>())
}

fn parse_transcript(payload: &Value) -> Result<BatchTranscript, String> {
    let language = payload["language_code"].as_str().map(str::to_string);
    let mut turns: Vec<BatchTurn> = payload
        .pointer("/diarized_transcript/entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let text = entry
                .get("transcript")
                .or_else(|| entry.get("text"))
                .and_then(Value::as_str)?
                .trim();
            if text.is_empty() {
                return None;
            }
            Some(BatchTurn {
                speaker_id: entry
                    .get("speaker_id")
                    .or_else(|| entry.get("speaker"))
                    .and_then(|value| {
                        value
                            .as_str()
                            .map(str::to_string)
                            .or_else(|| value.as_i64().map(|id| id.to_string()))
                    })
                    .unwrap_or_else(|| "0".into()),
                start_ms: seconds_to_ms(entry.get("start_time_seconds")),
                end_ms: seconds_to_ms(entry.get("end_time_seconds")),
                text: text.to_string(),
                language: language.clone(),
            })
        })
        .collect();

    if turns.is_empty() {
        let timestamps = &payload["timestamps"];
        let chunks = timestamps
            .get("chunks")
            .or_else(|| timestamps.get("words"))
            .and_then(Value::as_array);
        let starts = timestamps
            .get("start_time_seconds")
            .and_then(Value::as_array);
        let ends = timestamps.get("end_time_seconds").and_then(Value::as_array);
        if let (Some(chunks), Some(starts), Some(ends)) = (chunks, starts, ends) {
            for (index, chunk) in chunks.iter().enumerate() {
                let text = chunk.as_str().unwrap_or("").trim();
                if text.is_empty() {
                    continue;
                }
                turns.push(BatchTurn {
                    speaker_id: "0".into(),
                    start_ms: seconds_to_ms(starts.get(index)),
                    end_ms: seconds_to_ms(ends.get(index)),
                    text: text.into(),
                    language: language.clone(),
                });
            }
        }
    }

    if turns.is_empty() {
        let text = payload["transcript"].as_str().unwrap_or("").trim();
        if !text.is_empty() {
            turns.push(BatchTurn {
                speaker_id: "0".into(),
                start_ms: 0,
                end_ms: 0,
                text: text.into(),
                language: language.clone(),
            });
        }
    }
    if turns.is_empty() {
        return Err("Sarvam returned an empty transcript".into());
    }
    turns.sort_by_key(|turn| turn.start_ms);
    Ok(BatchTranscript { turns, language })
}

fn seconds_to_ms(value: Option<&Value>) -> i64 {
    value
        .and_then(Value::as_f64)
        .map(|seconds| (seconds * 1000.0).round() as i64)
        .unwrap_or(0)
}

pub fn identify_mic_speaker(turns: &[BatchTurn], mic_speech: &[(i64, i64)]) -> Option<String> {
    if mic_speech.is_empty() {
        return None;
    }

    let mut totals: HashMap<&str, (i64, i64)> = HashMap::new();
    for turn in turns {
        let duration = (turn.end_ms - turn.start_ms).max(0);
        if duration == 0 {
            continue;
        }
        let overlap: i64 = mic_speech
            .iter()
            .map(|(start, end)| (turn.end_ms.min(*end) - turn.start_ms.max(*start)).max(0))
            .sum();
        let entry = totals.entry(turn.speaker_id.as_str()).or_insert((0, 0));
        entry.0 += duration;
        entry.1 += overlap.min(duration);
    }

    let mut ranked: Vec<(&str, f64)> = totals
        .iter()
        .filter(|(_, (spoken, _))| *spoken >= MIC_ATTRIBUTION_MIN_MS)
        .map(|(id, (spoken, overlap))| (*id, *overlap as f64 / *spoken as f64))
        .collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));

    let (best, share) = *ranked.first()?;
    let runner_up = ranked.get(1).map(|(_, share)| *share).unwrap_or(0.0);
    if share < MIC_ATTRIBUTION_MIN_SHARE || runner_up > share / 2.0 {
        return None;
    }
    Some(best.to_string())
}

pub fn label_speakers(turns: &[BatchTurn], mic_speaker: Option<&str>) -> HashMap<String, String> {
    let mut labels = HashMap::new();
    if let Some(speaker_id) = mic_speaker {
        labels.insert(speaker_id.to_string(), "You".to_string());
    }
    let mut numbered = 0;
    for turn in turns {
        if labels.contains_key(&turn.speaker_id) {
            continue;
        }
        numbered += 1;
        labels.insert(turn.speaker_id.clone(), format!("Speaker {numbered}"));
    }
    labels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_orders_diarized_speaker_turns() {
        let payload = json!({
            "language_code": "hi-IN",
            "diarized_transcript": {"entries": [
                {"transcript":"Second", "start_time_seconds":2.8, "end_time_seconds":4.2, "speaker_id":"1"},
                {"transcript":"First", "start_time_seconds":0.01, "end_time_seconds":2.5, "speaker_id":"0"}
            ]}
        });
        let parsed = parse_transcript(&payload).unwrap();
        assert_eq!(parsed.language.as_deref(), Some("hi-IN"));
        assert_eq!(parsed.turns[0].text, "First");
        assert_eq!(parsed.turns[0].start_ms, 10);
        assert_eq!(parsed.turns[1].speaker_id, "1");
    }

    #[test]
    fn falls_back_to_chunk_timestamps_when_diarization_is_absent() {
        let payload = json!({
            "transcript":"Hello world",
            "timestamps": {
                "chunks":["Hello", "world"],
                "start_time_seconds":[0.0, 1.25],
                "end_time_seconds":[1.0, 2.0]
            }
        });
        let parsed = parse_transcript(&payload).unwrap();
        assert_eq!(parsed.turns.len(), 2);
        assert_eq!(parsed.turns[1].start_ms, 1250);
    }

    fn turn(speaker_id: &str, start_ms: i64, end_ms: i64) -> BatchTurn {
        BatchTurn {
            speaker_id: speaker_id.into(),
            start_ms,
            end_ms,
            text: "spoken".into(),
            language: None,
        }
    }

    #[test]
    fn assigns_stable_human_speaker_labels() {
        let turns = vec![turn("7", 0, 1), turn("2", 1, 2), turn("7", 2, 3)];
        let labels = label_speakers(&turns, None);
        assert_eq!(labels["7"], "Speaker 1");
        assert_eq!(labels["2"], "Speaker 2");
    }

    #[test]
    fn the_microphone_speaker_is_named_and_the_rest_stay_sequential() {
        let turns = vec![turn("7", 0, 1), turn("2", 1, 2), turn("5", 2, 3)];
        let labels = label_speakers(&turns, Some("2"));
        assert_eq!(labels["2"], "You");
        assert_eq!(labels["7"], "Speaker 1");
        assert_eq!(labels["5"], "Speaker 2");
    }

    #[test]
    fn identifies_the_diarized_speaker_the_microphone_was_open_for() {
        let turns = vec![
            turn("0", 0, 4_000),
            turn("1", 4_000, 9_000),
            turn("0", 9_000, 13_000),
        ];
        let mic_speech = [(0, 4_100), (8_900, 13_000)];
        assert_eq!(
            identify_mic_speaker(&turns, &mic_speech).as_deref(),
            Some("0")
        );
        assert_eq!(identify_mic_speaker(&turns, &[]), None);
    }

    #[test]
    fn declines_to_name_anyone_when_the_microphone_heard_the_room() {
        let turns = vec![turn("0", 0, 5_000), turn("1", 5_000, 10_000)];
        let bleed = [(0, 10_000)];
        assert_eq!(identify_mic_speaker(&turns, &bleed), None);

        let brief = vec![turn("0", 0, 900), turn("1", 900, 6_000)];
        assert_eq!(identify_mic_speaker(&brief, &[(0, 900)]), None);
    }
}
