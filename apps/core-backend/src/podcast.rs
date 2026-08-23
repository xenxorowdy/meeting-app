//! Podcast script and multi-speaker speech generation.
//!
//! Electron owns podcast project manifests and media. The backend receives one
//! trusted root at startup, resolves project ids beneath it, and performs the two
//! operations that need the private Gemini credential. Results are written by
//! atomic rename so a provider failure never corrupts an existing project.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{fs, sync::RwLock};

const GEMINI_ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_SCRIPT_MODEL: &str = "gemini-2.5-flash";
const DEFAULT_TTS_MODEL: &str = "gemini-2.5-flash-preview-tts";
const SCRIPT_CHUNK_CHARS: usize = 80_000;
const TTS_CHUNK_CHARS: usize = 3_800;

const SCRIPT_SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "description": { "type": "string" },
    "detectedLanguage": { "type": "string" },
    "chapters": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "sourceTurnIds": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["title", "sourceTurnIds"],
        "propertyOrdering": ["title", "sourceTurnIds"]
      }
    },
    "turns": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "speakerId": { "type": "string", "enum": ["host-a", "host-b"] },
          "text": { "type": "string" },
          "sourceTurnIds": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["speakerId", "text", "sourceTurnIds"],
        "propertyOrdering": ["speakerId", "text", "sourceTurnIds"]
      }
    }
  },
  "required": ["title", "description", "detectedLanguage", "chapters", "turns"],
  "propertyOrdering": ["title", "description", "detectedLanguage", "chapters", "turns"]
}"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTurn {
    pub id: String,
    pub speaker: String,
    #[serde(default)]
    pub start_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    pub voice: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRequest {
    pub project_id: String,
    pub title: String,
    #[serde(default = "automatic")]
    pub language: String,
    pub hosts: Vec<Host>,
    pub transcript: Vec<SourceTurn>,
}

fn automatic() -> String {
    "auto".into()
}

pub struct PodcastService {
    root: Option<PathBuf>,
    gemini_key: RwLock<Option<String>>,
    script_model: String,
    tts_model: String,
    http: reqwest::Client,
    timeout: Duration,
}

impl PodcastService {
    pub fn detect() -> Self {
        Self {
            root: env::var_os("ALPHA_PODCASTS_DIR").map(PathBuf::from),
            gemini_key: RwLock::new(
                env::var("ALPHA_GEMINI_API_KEY")
                    .ok()
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty()),
            ),
            script_model: env::var("ALPHA_PODCAST_SCRIPT_MODEL")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_SCRIPT_MODEL.into()),
            tts_model: env::var("ALPHA_PODCAST_TTS_MODEL")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_TTS_MODEL.into()),
            http: reqwest::Client::new(),
            timeout: Duration::from_secs(
                env::var("ALPHA_PODCAST_TIMEOUT_SECS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(300),
            ),
        }
    }

    pub async fn set_gemini_key(&self, key: Option<String>) {
        *self.gemini_key.write().await =
            key.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    }

    pub async fn status_value(&self) -> Value {
        json!({
            "available": self.root.is_some(),
            "geminiKeySet": self.gemini_key.read().await.is_some(),
            "scriptModel": self.script_model,
            "ttsModel": self.tts_model,
        })
    }

    fn project_dir(&self, project_id: &str) -> Result<PathBuf, String> {
        if project_id.is_empty()
            || !project_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("invalid podcast project id".into());
        }
        let root = self
            .root
            .as_ref()
            .ok_or("Podcast generation requires the Alpha desktop app")?;
        let dir = root.join(project_id);
        if !dir.is_dir() {
            return Err("Podcast project not found".into());
        }
        let canonical_root =
            std::fs::canonicalize(root).map_err(|e| format!("could not open podcast root: {e}"))?;
        let canonical = std::fs::canonicalize(&dir)
            .map_err(|e| format!("could not open podcast project: {e}"))?;
        if !canonical.starts_with(canonical_root) {
            return Err("podcast project is outside the trusted root".into());
        }
        Ok(canonical)
    }

    pub fn resolve_asset(&self, project_id: &str, relative: &str) -> Result<PathBuf, String> {
        let root = self.project_dir(project_id)?;
        let relative = Path::new(relative);
        if relative.is_absolute() {
            return Err("podcast asset path must be relative".into());
        }
        let candidate = root.join(relative);
        let canonical = std::fs::canonicalize(&candidate)
            .map_err(|e| format!("could not open podcast asset: {e}"))?;
        if !canonical.starts_with(&root) || !canonical.is_file() {
            return Err("podcast asset is outside its project".into());
        }
        Ok(canonical)
    }

    async fn key(&self) -> Result<String, String> {
        self.gemini_key.read().await.clone().ok_or_else(|| {
            "Add a Gemini API key in Transcription settings before generating a podcast.".into()
        })
    }

    async fn gemini_json(&self, model: &str, body: &Value) -> Result<Value, String> {
        let response = self
            .http
            .post(format!("{GEMINI_ENDPOINT}/{model}:generateContent"))
            .header("x-goog-api-key", self.key().await?)
            .json(body)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    format!("Gemini timed out after {} seconds", self.timeout.as_secs())
                } else {
                    format!("could not reach Gemini: {e}")
                }
            })?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| format!("could not read Gemini response: {e}"))?;
        if !status.is_success() {
            let message = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| {
                    v.pointer("/error/message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| {
                    text.lines()
                        .next()
                        .unwrap_or("unknown provider error")
                        .to_string()
                });
            return Err(format!("Gemini returned {}: {message}", status.as_u16()));
        }
        serde_json::from_str(&text).map_err(|e| format!("Gemini returned invalid JSON: {e}"))
    }

    fn candidate_text(envelope: &Value) -> Result<String, String> {
        let candidate = envelope
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
            .ok_or("Gemini returned no podcast content")?;
        if let Some(reason) = candidate
            .get("finishReason")
            .and_then(Value::as_str)
            .filter(|r| *r != "STOP")
        {
            return Err(format!(
                "Gemini stopped podcast generation early ({reason})"
            ));
        }
        let parts = candidate
            .pointer("/content/parts")
            .and_then(Value::as_array)
            .ok_or("Gemini podcast response contained no parts")?;
        Ok(parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""))
    }

    async fn script_chunk(
        &self,
        request: &ScriptRequest,
        turns: &[SourceTurn],
        index: usize,
        total: usize,
    ) -> Result<Value, String> {
        let schema: Value =
            serde_json::from_str(SCRIPT_SCHEMA).expect("podcast script schema is valid");
        let transcript = turns
            .iter()
            .map(|turn| {
                format!(
                    "[{} @ {}ms] {}: {}",
                    turn.id, turn.start_ms, turn.speaker, turn.text
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let host_names = request
            .hosts
            .iter()
            .take(2)
            .map(|h| format!("{} ({})", h.name, h.id))
            .collect::<Vec<_>>()
            .join(" and ");
        let language = if request.language.trim().is_empty() || request.language == "auto" {
            "Detect the transcript language and write in that language.".to_string()
        } else {
            format!("Write in {}.", request.language)
        };
        let prompt = format!("Create section {} of {} of a natural, useful two-host podcast based only on this source. Hosts are {}. {} Preserve facts and uncertainty. Do not invent quotes, events, people, numbers, or conclusions. Every dialogue turn must cite one or more source ids from square brackets. Avoid repetitive introductions between sections. Let semantic density determine length; do not pad or arbitrarily shorten.\n\nSOURCE TITLE: {}\n\n{}", index + 1, total, host_names, language, request.title, transcript);
        let body = json!({
            "systemInstruction": { "parts": [{ "text": "You are Alpha Podcast Studio. Produce engaging but strictly source-grounded spoken dialogue. Return only the requested JSON object." }] },
            "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
            "generationConfig": { "responseMimeType": "application/json", "responseSchema": schema, "temperature": 0.45 }
        });
        let envelope = self.gemini_json(&self.script_model, &body).await?;
        let text = Self::candidate_text(&envelope)?;
        serde_json::from_str(&text)
            .map_err(|e| format!("Gemini podcast script did not match its schema: {e}"))
    }

    pub async fn generate_script(&self, request: &ScriptRequest) -> Result<Value, String> {
        if request.transcript.is_empty() {
            return Err("A podcast script needs a transcript or caption source.".into());
        }
        if request.hosts.len() != 2 {
            return Err("Choose exactly two podcast hosts.".into());
        }
        let chunks = chunk_source(&request.transcript, SCRIPT_CHUNK_CHARS);
        let valid_sources: HashSet<&str> = request
            .transcript
            .iter()
            .map(|turn| turn.id.as_str())
            .collect();
        let valid_hosts: HashSet<&str> =
            request.hosts.iter().map(|host| host.id.as_str()).collect();
        let mut title = request.title.clone();
        let mut description = String::new();
        let mut detected_language = request.language.clone();
        let mut chapters = Vec::new();
        let mut turns = Vec::new();
        for (index, chunk) in chunks.iter().enumerate() {
            let section = self
                .script_chunk(request, chunk, index, chunks.len())
                .await?;
            if index == 0 {
                title = section
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|v| !v.trim().is_empty())
                    .unwrap_or(&title)
                    .to_string();
                description = section
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                detected_language = section
                    .get("detectedLanguage")
                    .and_then(Value::as_str)
                    .unwrap_or(&request.language)
                    .to_string();
            }
            chapters.extend(
                section
                    .get("chapters")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|mut chapter| {
                        if let Some(ids) = chapter
                            .get_mut("sourceTurnIds")
                            .and_then(Value::as_array_mut)
                        {
                            ids.retain(|id| {
                                id.as_str().is_some_and(|id| valid_sources.contains(id))
                            });
                        }
                        chapter
                    }),
            );
            turns.extend(
                section
                    .get("turns")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|mut turn| {
                        let speaker = turn.get("speakerId").and_then(Value::as_str)?;
                        let text = turn.get("text").and_then(Value::as_str)?.trim();
                        if !valid_hosts.contains(speaker) || text.is_empty() {
                            return None;
                        }
                        let ids = turn.get_mut("sourceTurnIds")?.as_array_mut()?;
                        ids.retain(|id| id.as_str().is_some_and(|id| valid_sources.contains(id)));
                        if ids.is_empty() {
                            return None;
                        }
                        Some(turn)
                    }),
            );
        }
        if turns.is_empty() {
            return Err("Gemini did not return any dialogue with valid source references.".into());
        }
        let words: usize = turns
            .iter()
            .filter_map(|t| t.get("text").and_then(Value::as_str))
            .map(|text| text.split_whitespace().count())
            .sum();
        let script = json!({
            "status": "ready",
            "hosts": request.hosts,
            "detectedLanguage": detected_language,
            "estimatedDurationSeconds": ((words as f64 / 2.5).ceil() as u64),
            "turns": turns,
            "chapters": chapters,
            "generatedAt": now_ms(),
            "provider": "gemini",
            "model": self.script_model,
        });
        self.patch_project(&request.project_id, |project| {
            project["title"] = json!(title);
            project["description"] = json!(description);
            project["script"] = script.clone();
        })
        .await?;
        Ok(script)
    }

    async fn tts_chunk(&self, hosts: &[Host], text: &str) -> Result<(Vec<u8>, u32), String> {
        let speaker_configs: Vec<Value> = hosts
            .iter()
            .map(|host| {
                json!({
                    "speaker": host.name,
                    "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": host.voice } }
                })
            })
            .collect();
        let body = json!({
            "contents": [{ "role": "user", "parts": [{ "text": format!("Perform this podcast dialogue naturally. Read only the dialogue.\n\n{text}") }] }],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": { "multiSpeakerVoiceConfig": { "speakerVoiceConfigs": speaker_configs } }
            }
        });
        let envelope = self.gemini_json(&self.tts_model, &body).await?;
        let part = envelope
            .pointer("/candidates/0/content/parts")
            .and_then(Value::as_array)
            .and_then(|parts| parts.iter().find(|part| part.get("inlineData").is_some()))
            .ok_or("Gemini returned no podcast audio")?;
        let inline = part.get("inlineData").unwrap();
        let data = inline
            .get("data")
            .and_then(Value::as_str)
            .ok_or("Gemini podcast audio was empty")?;
        let mime = inline
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("audio/L16;rate=24000");
        let rate = mime
            .split("rate=")
            .nth(1)
            .and_then(|v| v.split(';').next())
            .and_then(|v| v.parse().ok())
            .unwrap_or(24_000);
        Ok((
            BASE64
                .decode(data)
                .map_err(|e| format!("Gemini returned invalid audio: {e}"))?,
            rate,
        ))
    }

    pub async fn generate_audio(&self, project_id: &str) -> Result<Value, String> {
        let dir = self.project_dir(project_id)?;
        let project: Value = serde_json::from_slice(
            &fs::read(dir.join("project.json"))
                .await
                .map_err(|e| format!("could not read podcast project: {e}"))?,
        )
        .map_err(|e| format!("podcast project is invalid: {e}"))?;
        let hosts: Vec<Host> = serde_json::from_value(
            project
                .pointer("/script/hosts")
                .cloned()
                .unwrap_or(json!([])),
        )
        .map_err(|e| format!("podcast hosts are invalid: {e}"))?;
        let turns = project
            .pointer("/script/turns")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if hosts.len() != 2 || turns.is_empty() {
            return Err("Generate a two-host script before generating audio.".into());
        }
        let original_hosts = project
            .pointer("/script/hosts")
            .cloned()
            .unwrap_or_else(|| json!([]));
        let original_turns = project
            .pointer("/script/turns")
            .cloned()
            .unwrap_or_else(|| json!([]));
        fs::create_dir_all(dir.join("generated"))
            .await
            .map_err(|e| format!("could not create podcast output folder: {e}"))?;
        let sections = chunk_dialogue(&turns, &hosts, TTS_CHUNK_CHARS);
        let mut generated_assets = Vec::new();
        let mut clips = Vec::new();
        let mut start_ms = 0u64;
        for (index, text) in sections.iter().enumerate() {
            let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
            let filename = format!("tts-{index:04}-{}.wav", &digest[..12]);
            let final_path = dir.join("generated").join(&filename);
            if !final_path.is_file() {
                let (pcm, rate) = self.tts_chunk(&hosts, text).await?;
                let wav = pcm_wav(&pcm, rate, 1, 16);
                atomic_bytes(&final_path, &wav).await?;
            }
            let bytes = fs::metadata(&final_path)
                .await
                .map_err(|e| format!("could not inspect generated audio: {e}"))?
                .len();
            let duration_ms = wav_duration_ms(
                &fs::read(&final_path)
                    .await
                    .map_err(|e| format!("could not read generated audio: {e}"))?,
            )
            .unwrap_or(0);
            let asset_id = format!("tts-{index:04}");
            generated_assets.push(json!({
                "id": asset_id, "name": format!("Generated section {}", index + 1), "kind": "audio",
                "relativePath": format!("generated/{filename}"), "mimeType": "audio/wav", "durationMs": duration_ms,
                "sizeBytes": bytes, "hasAudio": true, "hasVideo": false, "sampleRate": 24000, "channels": 1,
                "createdAt": now_ms(), "provenance": { "kind": "gemini-tts", "model": self.tts_model, "section": index }
            }));
            clips.push(json!({
                "id": format!("tts-clip-{index:04}"), "assetId": asset_id, "sourceStartMs": 0, "sourceEndMs": duration_ms,
                "timelineStartMs": start_ms, "durationMs": duration_ms, "gainDb": 0, "fadeInMs": 10, "fadeOutMs": 20
            }));
            start_ms += duration_ms;
        }
        let mut latest: Value = serde_json::from_slice(
            &fs::read(dir.join("project.json"))
                .await
                .map_err(|e| format!("could not refresh podcast project: {e}"))?,
        )
        .map_err(|e| format!("podcast project is invalid: {e}"))?;
        if latest.pointer("/script/hosts") != Some(&original_hosts)
            || latest.pointer("/script/turns") != Some(&original_turns)
        {
            return Err("The podcast script changed while voices were being generated. Start voice generation again to use the edited script.".into());
        }
        let generated_ids: HashSet<String> = generated_assets
            .iter()
            .filter_map(|asset| asset.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();
        let mut assets = latest
            .get("assets")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assets.retain(|asset| {
            asset
                .get("id")
                .and_then(Value::as_str)
                .is_none_or(|id| !generated_ids.contains(id))
        });
        assets.extend(generated_assets);
        latest["assets"] = Value::Array(assets);
        if let Some(tracks) = latest
            .pointer_mut("/timeline/tracks")
            .and_then(Value::as_array_mut)
        {
            if let Some(speech) = tracks
                .iter_mut()
                .find(|track| track.get("id").and_then(Value::as_str) == Some("speech"))
            {
                speech["clips"] = Value::Array(clips);
            }
        }
        latest["timeline"]["durationMs"] = json!(start_ms);
        latest["timeline"]["revision"] = json!(
            latest
                .pointer("/timeline/revision")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                + 1
        );
        latest["script"]["status"] = json!("voiced");
        latest["script"]["audioGeneratedAt"] = json!(now_ms());
        latest["updatedAt"] = json!(now_ms());
        atomic_json(&dir.join("project.json"), &latest).await?;
        Ok(
            json!({ "success": true, "sections": sections.len(), "durationMs": start_ms, "project": latest }),
        )
    }

    pub async fn save_transcript(
        &self,
        project_id: &str,
        turns: &[SourceTurn],
    ) -> Result<(), String> {
        let dir = self.project_dir(project_id)?;
        atomic_json(
            &dir.join("transcript.json"),
            &serde_json::to_value(turns)
                .map_err(|e| format!("could not encode podcast transcript: {e}"))?,
        )
        .await?;
        self.patch_project(project_id, |project| {
            project["transcript"] = serde_json::to_value(turns).unwrap_or_else(|_| json!([]));
        })
        .await
    }

    async fn patch_project<F>(&self, project_id: &str, change: F) -> Result<(), String>
    where
        F: FnOnce(&mut Value),
    {
        let dir = self.project_dir(project_id)?;
        let file = dir.join("project.json");
        let mut project: Value = serde_json::from_slice(
            &fs::read(&file)
                .await
                .map_err(|e| format!("could not read podcast project: {e}"))?,
        )
        .map_err(|e| format!("podcast project is invalid: {e}"))?;
        change(&mut project);
        project["updatedAt"] = json!(now_ms());
        atomic_json(&file, &project).await
    }
}

fn chunk_source(turns: &[SourceTurn], budget: usize) -> Vec<Vec<SourceTurn>> {
    let mut chunks = vec![Vec::new()];
    let mut used = 0usize;
    for turn in turns {
        let size = turn.text.len() + turn.speaker.len() + turn.id.len() + 32;
        if used + size > budget && !chunks.last().unwrap().is_empty() {
            chunks.push(Vec::new());
            used = 0;
        }
        chunks.last_mut().unwrap().push(turn.clone());
        used += size;
    }
    chunks
}

fn chunk_dialogue(turns: &[Value], hosts: &[Host], budget: usize) -> Vec<String> {
    let mut chunks = vec![String::new()];
    for turn in turns {
        let id = turn
            .get("speakerId")
            .and_then(Value::as_str)
            .unwrap_or("host-a");
        let name = hosts
            .iter()
            .find(|host| host.id == id)
            .map(|host| host.name.as_str())
            .unwrap_or(&hosts[0].name);
        let line = format!(
            "{}: {}\n",
            name,
            turn.get("text").and_then(Value::as_str).unwrap_or("")
        );
        if chunks.last().unwrap().len() + line.len() > budget && !chunks.last().unwrap().is_empty()
        {
            chunks.push(String::new());
        }
        chunks.last_mut().unwrap().push_str(&line);
    }
    chunks
}

fn pcm_wav(pcm: &[u8], sample_rate: u32, channels: u16, bits: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(44 + pcm.len());
    let byte_rate = sample_rate * channels as u32 * bits as u32 / 8;
    let block = channels * bits / 8;
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36u32 + pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block.to_le_bytes());
    out.extend_from_slice(&bits.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

fn wav_duration_ms(wav: &[u8]) -> Option<u64> {
    if wav.len() < 44 {
        return None;
    }
    let rate = u32::from_le_bytes(wav[24..28].try_into().ok()?);
    let channels = u16::from_le_bytes(wav[22..24].try_into().ok()?) as u64;
    let bits = u16::from_le_bytes(wav[34..36].try_into().ok()?) as u64;
    let data = wav.len().saturating_sub(44) as u64;
    Some(data * 8 * 1000 / (rate as u64 * channels * bits).max(1))
}

async fn atomic_bytes(file: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = file.with_extension("tmp");
    fs::write(&temp, bytes)
        .await
        .map_err(|e| format!("could not write podcast output: {e}"))?;
    fs::rename(&temp, file)
        .await
        .map_err(|e| format!("could not finish podcast output: {e}"))
}

async fn atomic_json(file: &Path, value: &Value) -> Result<(), String> {
    atomic_bytes(
        file,
        &serde_json::to_vec_pretty(value)
            .map_err(|e| format!("could not encode podcast project: {e}"))?,
    )
    .await
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_chunks_keep_every_turn_and_respect_boundaries() {
        let turns: Vec<SourceTurn> = (0..10)
            .map(|i| SourceTurn {
                id: format!("t{i}"),
                speaker: "A".into(),
                start_ms: i * 1000,
                text: "word ".repeat(20),
            })
            .collect();
        let chunks = chunk_source(&turns, 300);
        assert!(chunks.len() > 1);
        assert_eq!(chunks.into_iter().flatten().count(), 10);
    }

    #[test]
    fn dialogue_uses_configured_host_names_and_chunks() {
        let hosts = vec![
            Host {
                id: "host-a".into(),
                name: "Avery".into(),
                voice: "Kore".into(),
            },
            Host {
                id: "host-b".into(),
                name: "Riley".into(),
                voice: "Puck".into(),
            },
        ];
        let turns = vec![
            json!({"speakerId":"host-a","text":"Hello"}),
            json!({"speakerId":"host-b","text":"World"}),
        ];
        let chunks = chunk_dialogue(&turns, &hosts, 20);
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].starts_with("Avery:"));
        assert!(chunks[1].starts_with("Riley:"));
    }

    #[test]
    fn wav_wrapper_has_a_valid_duration() {
        let wav = pcm_wav(&vec![0; 48_000], 24_000, 1, 16);
        assert_eq!(wav_duration_ms(&wav), Some(1000));
        assert_eq!(&wav[..4], b"RIFF");
    }
}
