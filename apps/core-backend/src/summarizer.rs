use serde::Serialize;
use serde_json::{json, Value};
use std::{env, path::PathBuf, process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command, sync::RwLock, time::timeout};

const DEFAULT_CLAUDE_MODEL: &str = "sonnet";
const DEFAULT_GEMINI_MODEL: &str = "gemini-2.5-flash";
const GEMINI_ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_TRANSCRIPT_CHARS: usize = 120_000;
const TRIM_MARKER: &str = "\n\n[... middle of the transcript omitted for length ...]\n\n";
const DISALLOWED_TOOLS: &str =
    "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit";

const SYSTEM_PROMPT: &str = "You are a meeting intelligence engine inside a desktop meeting assistant. \
You turn speaker-diarized meeting transcripts into precise, executive-ready notes.

Rules:
- Ground every sentence in what was actually said. Never invent attendees, dates, numbers or commitments.
- \"You\" is the local user of the app; other labels are the remote participants.
- A calendar invite list, when given, is who was invited, not who spoke. Use it to spell names \
correctly and to address the follow-up email. Never claim someone attended or said anything on the \
strength of the invite alone.
- Attribute each action item to the speaker who committed to it, or to the person it was asked of.
- Use \"TBD\" when a deadline was never stated. Never guess one.
- Prefer specifics over praise: no filler, no meta-commentary about the transcript.
- Notes typed by the local user during the meeting mark what they thought mattered. Weight those points \
heavily and keep their wording where it is already precise, but never treat a note as something that was \
said aloud, and never let a note introduce a fact the transcript does not support.
- Reply with the requested JSON object only.";

const INSTRUCTION: &str = "Summarize the meeting transcript on stdin. \
Return the executive summary, the decisions that were actually agreed, every action item with its owner, \
the discussion topics, and a short follow-up email the local user could send to the other participants.";

const OUTPUT_SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "executiveSummary": { "type": "string" },
    "keyDecisions": { "type": "array", "items": { "type": "string" } },
    "actionItems": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "task": { "type": "string" },
          "owner": { "type": "string" },
          "deadline": { "type": "string" },
          "priority": { "type": "string", "enum": ["High", "Medium", "Low"] }
        },
        "required": ["task", "owner", "deadline", "priority"],
        "additionalProperties": false
      }
    },
    "topics": { "type": "array", "items": { "type": "string" } },
    "followUpEmail": {
      "type": "object",
      "properties": {
        "subject": { "type": "string" },
        "body": { "type": "string" }
      },
      "required": ["subject", "body"],
      "additionalProperties": false
    }
  },
  "required": ["executiveSummary", "keyDecisions", "actionItems", "topics", "followUpEmail"],
  "additionalProperties": false
}"#;

/// The same contract as OUTPUT_SCHEMA, in the dialect Gemini accepts: its schema
/// support is an OpenAPI subset that rejects `additionalProperties`, and it needs
/// `propertyOrdering` to return fields in a stable order. `schemas_agree` in the
/// tests below is what keeps the two from drifting apart.
const GEMINI_SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "executiveSummary": { "type": "string" },
    "keyDecisions": { "type": "array", "items": { "type": "string" } },
    "actionItems": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "task": { "type": "string" },
          "owner": { "type": "string" },
          "deadline": { "type": "string" },
          "priority": { "type": "string", "enum": ["High", "Medium", "Low"] }
        },
        "required": ["task", "owner", "deadline", "priority"],
        "propertyOrdering": ["task", "owner", "deadline", "priority"]
      }
    },
    "topics": { "type": "array", "items": { "type": "string" } },
    "followUpEmail": {
      "type": "object",
      "properties": {
        "subject": { "type": "string" },
        "body": { "type": "string" }
      },
      "required": ["subject", "body"],
      "propertyOrdering": ["subject", "body"]
    }
  },
  "required": ["executiveSummary", "keyDecisions", "actionItems", "topics", "followUpEmail"],
  "propertyOrdering": ["executiveSummary", "keyDecisions", "actionItems", "topics", "followUpEmail"]
}"#;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Provider {
    Gemini,
    ClaudeCli,
    Heuristic,
}

impl Provider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Gemini => "gemini",
            Self::ClaudeCli => "claude-cli",
            Self::Heuristic => "heuristic",
        }
    }
}

pub struct SummaryTurn {
    pub speaker: String,
    pub start_ms: i64,
    pub text: String,
}

pub struct SummaryRequest {
    pub title: String,
    pub started_at: i64,
    pub duration_seconds: i64,
    pub turns: Vec<SummaryTurn>,
    pub notes: Vec<SummaryNote>,
    pub attendees: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SummaryNote {
    pub at_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSummary {
    pub summary_markdown: String,
    pub key_decisions: Vec<String>,
    pub action_items: Vec<Value>,
    pub topics: Vec<String>,
    pub email_draft: String,
    pub provider: String,
    pub warning: Option<String>,
}

pub struct SummaryService {
    binary: Option<PathBuf>,
    /// `None` means "use whatever is available"; a value pins the provider. Behind
    /// a lock because the settings screen can change it without a restart.
    preference: RwLock<Option<Provider>>,
    model: RwLock<String>,
    request_timeout: Duration,
    safe_mode: bool,
    max_budget_usd: Option<String>,
    gemini_key: RwLock<Option<String>>,
    /// Gemini 2.5 Flash reasons before answering by default. The output here is
    /// already pinned by a response schema, so thinking mostly buys latency on a
    /// call the user is waiting on at the end of a meeting.
    thinking_budget: i64,
    http: reqwest::Client,
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let paths = env::var_os("PATH")?;
    env::split_paths(&paths)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn find_claude_binary() -> Option<PathBuf> {
    if let Some(configured) = env::var_os("ALPHA_CLAUDE_BIN") {
        let path = PathBuf::from(configured);
        return path.is_file().then_some(path);
    }
    if let Some(found) = find_in_path("claude") {
        return Some(found);
    }
    let home = env::var_os("HOME").map(PathBuf::from)?;
    let mut candidates = vec![
        home.join(".claude/local/claude"),
        home.join(".local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
        home.join(".npm-global/bin/claude"),
        home.join(".volta/bin/claude"),
        home.join(".bun/bin/claude"),
        home.join(".config/yarn/global/node_modules/.bin/claude"),
    ];

    if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        for entry in entries.filter_map(Result::ok) {
            candidates.push(entry.path().join("bin/claude"));
        }
    }

    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn env_flag(name: &str, default: bool) -> bool {
    match env::var(name) {
        Ok(value) => !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
        Err(_) => default,
    }
}

fn clock(ms: i64) -> String {
    let total = (ms.max(0)) / 1000;
    format!("{:02}:{:02}", total / 60, total % 60)
}

impl SummaryService {
    pub fn detect() -> Self {
        // `None` means "decide from what is actually available"; an explicit value
        // pins the provider even if that means falling back to the heuristic.
        let preference = match env::var("ALPHA_SUMMARY_PROVIDER")
            .unwrap_or_else(|_| "auto".into())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "heuristic" | "offline" | "none" | "off" => Some(Provider::Heuristic),
            "gemini" | "google" => Some(Provider::Gemini),
            "claude" | "claude-cli" | "cli" => Some(Provider::ClaudeCli),
            _ => None,
        };

        let gemini_key = env::var("ALPHA_GEMINI_API_KEY")
            .ok()
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty());

        // Probe for the Claude CLI unless something else was asked for by name.
        // It stays discovered either way so a later switch in the settings screen
        // does not need a restart to find it.
        let wants_claude = !matches!(
            preference,
            Some(Provider::Heuristic) | Some(Provider::Gemini)
        );

        let default_model = if matches!(preference, Some(Provider::Gemini)) || gemini_key.is_some()
        {
            DEFAULT_GEMINI_MODEL
        } else {
            DEFAULT_CLAUDE_MODEL
        };

        Self {
            binary: if wants_claude {
                find_claude_binary()
            } else {
                None
            },
            preference: RwLock::new(preference),
            gemini_key: RwLock::new(gemini_key),
            thinking_budget: env::var("ALPHA_SUMMARY_THINKING_BUDGET")
                .ok()
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(0),
            http: reqwest::Client::new(),
            model: RwLock::new(
                env::var("ALPHA_SUMMARY_MODEL")
                    .ok()
                    .map(|m| m.trim().to_string())
                    .filter(|m| !m.is_empty())
                    .unwrap_or_else(|| default_model.into()),
            ),
            request_timeout: env::var("ALPHA_SUMMARY_TIMEOUT_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .map(Duration::from_secs)
                .unwrap_or(DEFAULT_TIMEOUT),
            safe_mode: env_flag("ALPHA_SUMMARY_SAFE_MODE", true),
            max_budget_usd: env::var("ALPHA_SUMMARY_MAX_BUDGET_USD")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty()),
        }
    }

    /// Resolve what will actually run. An explicit preference is honoured when it
    /// can be; otherwise the order is Gemini, then the Claude CLI, then the
    /// offline heuristic — a summary always comes back.
    pub async fn active_provider(&self) -> Provider {
        let has_key = self.gemini_key.read().await.is_some();
        match *self.preference.read().await {
            Some(Provider::Heuristic) => Provider::Heuristic,
            Some(Provider::Gemini) if has_key => Provider::Gemini,
            Some(Provider::ClaudeCli) if self.binary.is_some() => Provider::ClaudeCli,
            Some(_) => Provider::Heuristic,
            None if has_key => Provider::Gemini,
            None if self.binary.is_some() => Provider::ClaudeCli,
            None => Provider::Heuristic,
        }
    }

    /// One `model` setting is shared by every provider, so a model chosen for one
    /// is meaningless to another — handing `gemini-2.5-flash` to the Claude CLI
    /// makes it exit with `unrecognized_model`. Use the configured model only when
    /// it belongs to the provider about to run, and otherwise that provider's
    /// default.
    async fn model_for(&self, provider: Provider) -> String {
        let configured = self.model.read().await.clone();
        let (belongs, fallback) = match provider {
            Provider::Gemini => (is_gemini_model(&configured), DEFAULT_GEMINI_MODEL),
            Provider::ClaudeCli => (!is_gemini_model(&configured), DEFAULT_CLAUDE_MODEL),
            Provider::Heuristic => return configured,
        };
        if belongs {
            configured
        } else {
            fallback.to_string()
        }
    }

    /// Pin the provider, or pass "auto" to go back to picking by availability.
    /// Reports what will actually run, which may differ from what was asked for —
    /// selecting Gemini without a key resolves to the heuristic, and the caller
    /// needs to be able to say so.
    pub async fn set_preference(&self, provider: &str) -> Result<Provider, String> {
        let parsed = match provider.trim().to_ascii_lowercase().as_str() {
            "auto" | "" => None,
            "gemini" | "google" => Some(Provider::Gemini),
            "claude-cli" | "claude" | "cli" => Some(Provider::ClaudeCli),
            "heuristic" | "offline" | "none" | "off" => Some(Provider::Heuristic),
            other => return Err(format!("'{other}' is not a summary provider")),
        };
        *self.preference.write().await = parsed;
        Ok(self.active_provider().await)
    }

    /// Store a key supplied at runtime rather than through the environment.
    pub async fn set_gemini_key(&self, key: Option<String>) {
        *self.gemini_key.write().await =
            key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    }

    pub async fn status_value(&self) -> Value {
        // Served unauthenticated on /health and /api/status, so this reports only
        // whether a key exists — never the key, and never any part of it.
        json!({
            "provider": self.active_provider().await.as_str(),
            // What was asked for, as distinct from what resolved: the UI needs to
            // show a pinned choice that could not be honoured.
            "preference": match *self.preference.read().await {
                Some(provider) => provider.as_str(),
                None => "auto",
            },
            "claudeCliAvailable": self.binary.is_some(),
            "binary": self.binary.as_ref().map(|p| p.to_string_lossy().to_string()),
            "model": self.model.read().await.clone(),
            "geminiKeySet": self.gemini_key.read().await.is_some(),
            "timeoutSeconds": self.request_timeout.as_secs(),
        })
    }

    pub async fn set_model(&self, model: &str) -> Result<(), String> {
        let model = model.trim();
        if model.is_empty() {
            return Err("Summary model cannot be empty".into());
        }
        *self.model.write().await = model.to_string();
        Ok(())
    }

    pub async fn summarize(&self, request: &SummaryRequest) -> MeetingSummary {
        let provider = self.active_provider().await;

        if request.turns.is_empty() {
            return MeetingSummary {
                summary_markdown: "No speech recorded during this meeting.".into(),
                provider: provider.as_str().into(),
                ..Default::default()
            };
        }

        match provider {
            Provider::Heuristic => heuristic_summary(request, None),
            Provider::Gemini => match self.run_gemini(request).await {
                Ok(structured) => from_structured(&structured, request, Provider::Gemini),
                Err(cause) => {
                    eprintln!("[Alpha Core Backend] Gemini summary failed: {cause}");
                    // A configured Claude CLI is a better answer than the keyword
                    // heuristic, so try it before giving up on a real summary.
                    if self.binary.is_some() {
                        match self.run_cli(request).await {
                            Ok(structured) => {
                                return from_structured(&structured, request, Provider::ClaudeCli)
                            }
                            Err(second) => eprintln!(
                                "[Alpha Core Backend] Claude CLI fallback also failed: {second}"
                            ),
                        }
                    }
                    heuristic_summary(request, Some(cause))
                }
            },
            Provider::ClaudeCli => match self.run_cli(request).await {
                Ok(structured) => from_structured(&structured, request, Provider::ClaudeCli),
                Err(cause) => {
                    eprintln!("[Alpha Core Backend] Claude CLI summary failed: {cause}");
                    heuristic_summary(request, Some(cause))
                }
            },
        }
    }

    async fn run_gemini(&self, request: &SummaryRequest) -> Result<Value, String> {
        let key = self
            .gemini_key
            .read()
            .await
            .clone()
            .ok_or("no Gemini API key is configured")?;
        let model = self.model_for(Provider::Gemini).await;
        let body = build_gemini_request(request, &model, self.thinking_budget);

        let response = self
            .http
            .post(format!("{GEMINI_ENDPOINT}/{model}:generateContent"))
            // The key travels as a header, never in the URL: request URLs end up
            // in logs, error strings and crash reports.
            .header("x-goog-api-key", key)
            .json(&body)
            .timeout(self.request_timeout)
            .send()
            .await
            .map_err(|cause| {
                if cause.is_timeout() {
                    format!("Gemini timed out after {}s", self.request_timeout.as_secs())
                } else {
                    format!("could not reach Gemini: {cause}")
                }
            })?;

        let status = response.status();
        let payload = response
            .text()
            .await
            .map_err(|cause| format!("could not read the Gemini response: {cause}"))?;

        if !status.is_success() {
            return Err(format!(
                "Gemini returned {}: {}",
                status.as_u16(),
                gemini_error(&payload)
            ));
        }

        parse_gemini_response(&payload)
    }

    async fn run_cli(&self, request: &SummaryRequest) -> Result<Value, String> {
        let binary = self.binary.as_ref().ok_or("Claude CLI is not installed")?;
        let model = self.model_for(Provider::ClaudeCli).await;

        let mut command = Command::new(binary);
        command
            .arg("--print")
            .arg(INSTRUCTION)
            .arg("--output-format")
            .arg("json")
            .arg("--json-schema")
            .arg(OUTPUT_SCHEMA)
            .arg("--system-prompt")
            .arg(SYSTEM_PROMPT)
            .arg("--model")
            .arg(&model)
            .arg("--disallowedTools")
            .arg(DISALLOWED_TOOLS)
            .arg("--no-session-persistence");

        if self.safe_mode {
            command.arg("--safe-mode");
        }
        if let Some(budget) = &self.max_budget_usd {
            command.arg("--max-budget-usd").arg(budget);
        }

        let mut child = command
            .current_dir(env::temp_dir())
            .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
            .env("MAX_THINKING_TOKENS", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", binary.to_string_lossy()))?;

        let prompt = render_transcript(request);
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .await
                .map_err(|e| format!("could not send the transcript to the CLI: {e}"))?;
            stdin
                .shutdown()
                .await
                .map_err(|e| format!("could not close the CLI input stream: {e}"))?;
        }

        let output = match timeout(self.request_timeout, child.wait_with_output()).await {
            Ok(result) => result.map_err(|e| format!("CLI did not run: {e}"))?,
            Err(_) => {
                return Err(format!(
                    "CLI timed out after {}s",
                    self.request_timeout.as_secs()
                ))
            }
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "CLI exited with {}: {}",
                output.status.code().unwrap_or(-1),
                first_line(&stderr)
            ));
        }

        parse_cli_output(&String::from_utf8_lossy(&output.stdout))
    }
}

fn first_line(text: &str) -> String {
    let line = text.trim().lines().next().unwrap_or("no output").trim();
    if line.len() > 300 {
        format!("{}…", &line[..300])
    } else {
        line.to_string()
    }
}

fn parse_cli_output(stdout: &str) -> Result<Value, String> {
    let envelope: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("CLI returned unparseable output: {e}"))?;

    if envelope.get("is_error").and_then(Value::as_bool) == Some(true) {
        return Err(format!(
            "CLI reported an error: {}",
            envelope
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        ));
    }

    if let Some(structured) = envelope.get("structured_output").filter(|v| v.is_object()) {
        return Ok(structured.clone());
    }

    let text = envelope
        .get("result")
        .and_then(Value::as_str)
        .ok_or("CLI returned no result text")?;

    extract_json_object(text).ok_or_else(|| "CLI result contained no JSON object".to_string())
}

fn extract_json_object(text: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        if value.is_object() {
            return Some(value);
        }
    }
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Value>(&text[start..=end])
        .ok()
        .filter(Value::is_object)
}

fn render_transcript(request: &SummaryRequest) -> String {
    let mut lines = String::new();
    for turn in &request.turns {
        lines.push_str(&format!(
            "[{}] {}: {}\n",
            clock(turn.start_ms),
            turn.speaker,
            turn.text
        ));
    }

    let transcript = trim_middle(&lines, MAX_TRANSCRIPT_CHARS);
    let duration = if request.duration_seconds > 0 {
        format!("{} minutes", (request.duration_seconds + 30) / 60)
    } else {
        "unknown".to_string()
    };

    let notes = if request.notes.is_empty() {
        String::new()
    } else {
        let mut block = String::from("\n--- NOTES THE USER TYPED DURING THE MEETING ---\n");
        for note in &request.notes {
            block.push_str(&format!("[{}] {}\n", clock(note.at_ms), note.text));
        }
        block.push_str("--- END NOTES ---\n");
        block
    };

    let invited = if request.attendees.is_empty() {
        String::new()
    } else {
        format!("Calendar invite list: {}\n", request.attendees.join(", "))
    };

    format!(
        "Meeting title: {}\nStarted at (epoch ms): {}\nDuration: {}\nSpoken turns: {}\nUser notes: {}\n{}{}\n--- TRANSCRIPT ---\n{}--- END TRANSCRIPT ---\n",
        request.title,
        request.started_at,
        duration,
        request.turns.len(),
        request.notes.len(),
        invited,
        notes,
        transcript
    )
}

fn trim_middle(text: &str, budget: usize) -> String {
    if text.len() <= budget {
        return text.to_string();
    }
    let head_budget = budget * 2 / 5;
    let tail_budget = budget - head_budget;
    let head_end = floor_char_boundary(text, head_budget);
    let tail_start = ceil_char_boundary(text, text.len() - tail_budget);
    format!(
        "{}{}{}",
        &text[..head_end],
        TRIM_MARKER,
        &text[tail_start..]
    )
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(text: &str, mut index: usize) -> usize {
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn from_structured(
    structured: &Value,
    request: &SummaryRequest,
    provider: Provider,
) -> MeetingSummary {
    let executive = structured
        .get("executiveSummary")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();

    let topics: Vec<String> = structured
        .get("topics")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let key_decisions: Vec<String> = structured
        .get("keyDecisions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let action_items: Vec<Value> = structured
        .get("actionItems")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    item.get("task")
                        .and_then(Value::as_str)
                        .map(|task| !task.trim().is_empty())
                        .unwrap_or(false)
                })
                .map(|item| {
                    json!({
                        "task": item.get("task").and_then(Value::as_str).unwrap_or("").trim(),
                        "owner": item.get("owner").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).unwrap_or("Unassigned").trim(),
                        "deadline": item.get("deadline").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).unwrap_or("TBD").trim(),
                        "priority": item.get("priority").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).unwrap_or("Medium").trim(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let email = structured.get("followUpEmail");
    let email_draft = match (
        email.and_then(|e| e.get("subject")).and_then(Value::as_str),
        email.and_then(|e| e.get("body")).and_then(Value::as_str),
    ) {
        (Some(subject), Some(body)) => format!("Subject: {}\n\n{}", subject.trim(), body.trim()),
        (None, Some(body)) => body.trim().to_string(),
        (Some(subject), None) => format!("Subject: {}", subject.trim()),
        _ => String::new(),
    };

    let mut summary_markdown = if executive.is_empty() {
        fallback_headline(request)
    } else {
        executive
    };
    if !topics.is_empty() {
        summary_markdown.push_str("\n\n### Discussion topics\n");
        for topic in &topics {
            summary_markdown.push_str(&format!("- {topic}\n"));
        }
    }

    MeetingSummary {
        summary_markdown: summary_markdown.trim_end().to_string(),
        key_decisions,
        action_items,
        topics,
        email_draft,
        provider: provider.as_str().into(),
        warning: None,
    }
}

fn fallback_headline(request: &SummaryRequest) -> String {
    let mut speakers: Vec<&str> = Vec::new();
    for turn in &request.turns {
        if !speakers.contains(&turn.speaker.as_str()) {
            speakers.push(&turn.speaker);
        }
    }
    format!(
        "Meeting **{}** completed with {} spoken turns across {}.",
        request.title,
        request.turns.len(),
        speakers.join(", ")
    )
}

fn heuristic_summary(request: &SummaryRequest, warning: Option<String>) -> MeetingSummary {
    let key_decisions: Vec<String> = request
        .turns
        .iter()
        .filter(|t| {
            let text = t.text.to_lowercase();
            text.contains("decided") || text.contains("agreed") || text.contains("we will")
        })
        .take(5)
        .map(|t| t.text.clone())
        .collect();

    let action_items: Vec<Value> = request
        .turns
        .iter()
        .filter(|t| {
            let text = t.text.to_lowercase();
            text.contains("will ")
                || text.contains("action item")
                || text.contains("need to")
                || text.contains("todo")
        })
        .take(10)
        .map(|t| json!({"task": t.text, "owner": t.speaker, "deadline": "TBD", "priority": "Medium"}))
        .collect();

    MeetingSummary {
        summary_markdown: fallback_headline(request),
        key_decisions,
        action_items,
        topics: Vec::new(),
        email_draft: String::new(),
        provider: Provider::Heuristic.as_str().into(),
        warning,
    }
}

/// Google's model names are the one family that is unambiguous by prefix, which
/// is enough to keep a model from being sent to the wrong provider.
fn is_gemini_model(model: &str) -> bool {
    model.trim().to_ascii_lowercase().starts_with("gemini")
}

/// Whether a model will accept `thinkingBudget: 0`.
///
/// Flash and Flash-Lite can turn thinking off; Pro cannot — it rejects a budget
/// below its minimum outright, so asking for 0 there fails the whole request and
/// the summary silently falls through to the heuristic. For Pro the field is left
/// off entirely and the API's own default applies.
fn can_disable_thinking(model: &str) -> bool {
    !model.trim().to_ascii_lowercase().contains("pro")
}

/// The `thinkingConfig` to send, or `None` to leave it to the API.
fn thinking_config(model: &str, budget: i64) -> Option<Value> {
    if budget > 0 {
        return Some(json!({ "thinkingBudget": budget }));
    }
    can_disable_thinking(model).then(|| json!({ "thinkingBudget": 0 }))
}

/// Build the request body. Kept pure and separate from the call so the shape can
/// be asserted in tests without a network or a key.
fn build_gemini_request(request: &SummaryRequest, model: &str, thinking_budget: i64) -> Value {
    let schema: Value = serde_json::from_str(GEMINI_SCHEMA).expect("GEMINI_SCHEMA is valid JSON");

    let mut generation_config = json!({
        "responseMimeType": "application/json",
        "responseSchema": schema,
        // The transcript is the only permitted source, so leave no room for
        // creative paraphrase.
        "temperature": 0.2,
    });

    if let Some(thinking) = thinking_config(model, thinking_budget) {
        generation_config["thinkingConfig"] = thinking;
    }

    json!({
        "systemInstruction": { "parts": [{ "text": SYSTEM_PROMPT }] },
        "contents": [{
            "role": "user",
            "parts": [{ "text": format!("{INSTRUCTION}\n\n{}", render_transcript(request)) }],
        }],
        "generationConfig": generation_config,
    })
}

/// Pull the human-readable reason out of a Gemini error envelope, falling back to
/// a clipped body when it is not the shape we expect.
fn gemini_error(payload: &str) -> String {
    serde_json::from_str::<Value>(payload)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| first_line(payload))
}

fn parse_gemini_response(payload: &str) -> Result<Value, String> {
    let envelope: Value = serde_json::from_str(payload)
        .map_err(|cause| format!("Gemini returned unparseable output: {cause}"))?;

    let candidate = envelope
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .ok_or_else(|| {
            // No candidate at all usually means the prompt itself was blocked.
            let reason = envelope
                .get("promptFeedback")
                .and_then(|f| f.get("blockReason"))
                .and_then(Value::as_str)
                .unwrap_or("no candidates");
            format!("Gemini returned no summary ({reason})")
        })?;

    // A truncated or filtered answer parses as broken JSON otherwise, which would
    // be reported as a parse bug rather than the real cause.
    match candidate.get("finishReason").and_then(Value::as_str) {
        Some("STOP") | None => {}
        Some("MAX_TOKENS") => {
            return Err("Gemini hit its output limit before finishing the summary".into())
        }
        Some(other) => return Err(format!("Gemini stopped early ({other})")),
    }

    let text = candidate
        .get("content")
        .and_then(|c| c.get("parts"))
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<&str>>()
                .join("")
        })
        .filter(|text| !text.trim().is_empty())
        .ok_or("Gemini returned an empty summary")?;

    extract_json_object(&text).ok_or_else(|| "Gemini result contained no JSON object".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> SummaryRequest {
        SummaryRequest {
            notes: vec![],
            attendees: vec![],
            title: "Release Sync".into(),
            started_at: 1_700_000_000_000,
            duration_seconds: 630,
            turns: vec![
                SummaryTurn {
                    speaker: "You".into(),
                    start_ms: 1_000,
                    text: "We agreed to ship the beta on Friday.".into(),
                },
                SummaryTurn {
                    speaker: "Others".into(),
                    start_ms: 65_000,
                    text: "I will send the release notes.".into(),
                },
            ],
        }
    }

    #[test]
    fn typed_notes_reach_the_prompt_and_are_marked_as_notes() {
        let mut with_notes = request();
        with_notes.notes = vec![
            SummaryNote {
                at_ms: 5_000,
                text: "pricing page is the blocker".into(),
            },
            SummaryNote {
                at_ms: 92_000,
                text: "ask legal about the BAA".into(),
            },
        ];

        let prompt = render_transcript(&with_notes);

        assert!(prompt.contains("--- NOTES THE USER TYPED DURING THE MEETING ---"));
        assert!(prompt.contains("[00:05] pricing page is the blocker"));
        assert!(prompt.contains("[01:32] ask legal about the BAA"));
        assert!(prompt.contains("User notes: 2"));
        assert!(prompt.find("--- NOTES").unwrap() < prompt.find("--- TRANSCRIPT ---").unwrap());
    }

    #[test]
    fn a_meeting_without_notes_gets_no_notes_block() {
        let prompt = render_transcript(&request());
        assert!(!prompt.contains("--- NOTES"));
        assert!(prompt.contains("User notes: 0"));
    }

    #[test]
    fn renders_transcript_with_clock_and_header() {
        let prompt = render_transcript(&request());
        assert!(prompt.contains("Meeting title: Release Sync"));
        assert!(prompt.contains("Duration: 11 minutes"));
        assert!(prompt.contains("[00:01] You: We agreed to ship the beta on Friday."));
        assert!(prompt.contains("[01:05] Others: I will send the release notes."));
    }

    #[test]
    fn the_calendar_invite_list_reaches_the_prompt() {
        let mut invited = request();
        invited.attendees = vec![
            "Asha Rao <asha@example.com>".into(),
            "ben@example.com".into(),
        ];
        let prompt = render_transcript(&invited);
        assert!(
            prompt.contains("Calendar invite list: Asha Rao <asha@example.com>, ben@example.com")
        );
    }

    #[test]
    fn an_ad_hoc_meeting_gets_no_invite_line() {
        assert!(!render_transcript(&request()).contains("Calendar invite list"));
    }

    #[test]
    fn trims_the_middle_of_an_oversized_transcript() {
        let long = "x".repeat(1000);
        let trimmed = trim_middle(&long, 200);
        assert!(trimmed.contains(TRIM_MARKER));
        assert!(trimmed.len() < long.len());
        assert!(trimmed.starts_with("xxx"));
        assert!(trimmed.ends_with("xxx"));
    }

    #[test]
    fn trims_on_character_boundaries() {
        let long = "é".repeat(500);
        let trimmed = trim_middle(&long, 101);
        assert!(trimmed.contains(TRIM_MARKER));
    }

    #[test]
    fn reads_structured_output_from_the_envelope() {
        let stdout = json!({
            "is_error": false,
            "subtype": "success",
            "result": "ignored when structured output is present",
            "structured_output": { "executiveSummary": "Shipped." }
        })
        .to_string();
        let parsed = parse_cli_output(&stdout).unwrap();
        assert_eq!(parsed["executiveSummary"], "Shipped.");
    }

    #[test]
    fn falls_back_to_json_inside_the_result_text() {
        let stdout = json!({
            "is_error": false,
            "result": "Here you go:\n```json\n{\"executiveSummary\":\"Shipped.\"}\n```"
        })
        .to_string();
        let parsed = parse_cli_output(&stdout).unwrap();
        assert_eq!(parsed["executiveSummary"], "Shipped.");
    }

    #[test]
    fn surfaces_cli_errors() {
        let stdout = json!({"is_error": true, "result": "Credit balance is too low"}).to_string();
        assert!(parse_cli_output(&stdout)
            .unwrap_err()
            .contains("Credit balance"));
        assert!(parse_cli_output("not json")
            .unwrap_err()
            .contains("unparseable"));
    }

    #[test]
    fn normalizes_structured_summary_fields() {
        let structured = json!({
            "executiveSummary": "The team locked the beta date.",
            "keyDecisions": ["Ship the beta on Friday", "   "],
            "actionItems": [
                { "task": "Send release notes", "owner": "Others", "deadline": "", "priority": "" },
                { "task": "   " }
            ],
            "topics": ["Beta readiness"],
            "followUpEmail": { "subject": "Beta ships Friday", "body": "Hi team," }
        });

        let summary = from_structured(&structured, &request(), Provider::ClaudeCli);
        assert_eq!(summary.provider, "claude-cli");
        assert_eq!(summary.key_decisions, vec!["Ship the beta on Friday"]);
        assert_eq!(summary.action_items.len(), 1);
        assert_eq!(summary.action_items[0]["deadline"], "TBD");
        assert_eq!(summary.action_items[0]["priority"], "Medium");
        assert!(summary
            .summary_markdown
            .starts_with("The team locked the beta date."));
        assert!(summary.summary_markdown.contains("### Discussion topics"));
        assert!(summary
            .email_draft
            .starts_with("Subject: Beta ships Friday"));
    }

    #[test]
    fn heuristic_summary_only_repeats_spoken_text() {
        let summary = heuristic_summary(&request(), Some("CLI missing".into()));
        assert_eq!(summary.provider, "heuristic");
        assert_eq!(
            summary.key_decisions,
            vec!["We agreed to ship the beta on Friday."]
        );
        assert_eq!(summary.action_items.len(), 1);
        assert_eq!(summary.action_items[0]["owner"], "Others");
        assert_eq!(summary.warning.as_deref(), Some("CLI missing"));
    }

    #[tokio::test]
    async fn empty_transcript_short_circuits() {
        let service = SummaryService::detect();
        let summary = service
            .summarize(&SummaryRequest {
                notes: vec![],
                attendees: vec![],
                title: "Quiet".into(),
                started_at: 0,
                duration_seconds: 0,
                turns: vec![],
            })
            .await;
        assert_eq!(
            summary.summary_markdown,
            "No speech recorded during this meeting."
        );
        assert!(summary.action_items.is_empty());
    }

    fn required_keys(schema: &str) -> Vec<String> {
        let value: Value = serde_json::from_str(schema).expect("schema is valid JSON");
        let mut keys: Vec<String> = value["required"]
            .as_array()
            .expect("schema declares required")
            .iter()
            .map(|k| k.as_str().unwrap().to_string())
            .collect();
        keys.sort();
        keys
    }

    #[test]
    fn both_schemas_demand_the_same_fields() {
        // The two exist only because Gemini's dialect differs; if they ever ask
        // for different fields, one provider silently returns a poorer summary.
        assert_eq!(required_keys(OUTPUT_SCHEMA), required_keys(GEMINI_SCHEMA));
    }

    #[test]
    fn the_gemini_schema_avoids_unsupported_keywords() {
        // Gemini rejects the whole request if the schema carries this.
        assert!(!GEMINI_SCHEMA.contains("additionalProperties"));
        assert!(GEMINI_SCHEMA.contains("propertyOrdering"));
        // And it must still be parseable, since build_gemini_request unwraps it.
        let _ = build_gemini_request(&request(), DEFAULT_GEMINI_MODEL, 0);
    }

    #[test]
    fn the_request_carries_the_transcript_and_no_credentials() {
        let body = build_gemini_request(&request(), DEFAULT_GEMINI_MODEL, 0);
        let serialized = body.to_string();

        assert!(serialized.contains("We agreed to ship the beta on Friday."));
        assert!(serialized.contains("Release Sync"));
        assert_eq!(
            body["generationConfig"]["responseMimeType"],
            "application/json"
        );
        assert!(body["generationConfig"]["responseSchema"].is_object());
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            0
        );
        assert!(body["systemInstruction"]["parts"][0]["text"]
            .as_str()
            .unwrap()
            .contains("meeting intelligence engine"));

        // Nothing that looks like a key or an endpoint belongs in the body.
        for forbidden in ["x-goog-api-key", "key=", "AIza"] {
            assert!(!serialized.contains(forbidden), "body leaked {forbidden}");
        }
    }

    #[test]
    fn honours_a_non_zero_thinking_budget() {
        let body = build_gemini_request(&request(), DEFAULT_GEMINI_MODEL, 512);
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            512
        );
    }

    #[test]
    fn reads_structured_json_out_of_a_gemini_candidate() {
        let payload = json!({
            "candidates": [{
                "finishReason": "STOP",
                "content": { "parts": [{ "text": "{\"executiveSummary\":\"Shipped.\"}" }] }
            }]
        })
        .to_string();
        assert_eq!(
            parse_gemini_response(&payload).unwrap()["executiveSummary"],
            "Shipped."
        );
    }

    #[test]
    fn joins_multi_part_and_fenced_gemini_answers() {
        let payload = json!({
            "candidates": [{
                "content": { "parts": [
                    { "text": "```json\n{\"executiveSummary\":" },
                    { "text": "\"Shipped.\"}\n```" }
                ] }
            }]
        })
        .to_string();
        assert_eq!(
            parse_gemini_response(&payload).unwrap()["executiveSummary"],
            "Shipped."
        );
    }

    #[test]
    fn names_the_real_cause_when_gemini_stops_early() {
        let truncated = json!({
            "candidates": [{ "finishReason": "MAX_TOKENS", "content": { "parts": [{ "text": "{\"a\":" }] } }]
        })
        .to_string();
        assert!(parse_gemini_response(&truncated)
            .unwrap_err()
            .contains("output limit"));

        let filtered = json!({
            "candidates": [{ "finishReason": "SAFETY", "content": { "parts": [] } }]
        })
        .to_string();
        assert!(parse_gemini_response(&filtered)
            .unwrap_err()
            .contains("SAFETY"));

        let blocked = json!({ "promptFeedback": { "blockReason": "OTHER" } }).to_string();
        assert!(parse_gemini_response(&blocked)
            .unwrap_err()
            .contains("OTHER"));

        let empty =
            json!({ "candidates": [{ "content": { "parts": [{ "text": "   " }] } }] }).to_string();
        assert!(parse_gemini_response(&empty).unwrap_err().contains("empty"));
    }

    #[test]
    fn surfaces_the_gemini_error_message() {
        let payload = json!({ "error": { "code": 429, "message": "Quota exceeded for requests" } })
            .to_string();
        assert_eq!(gemini_error(&payload), "Quota exceeded for requests");
        // A non-JSON body still produces something a user can act on.
        assert!(gemini_error("502 Bad Gateway").contains("Bad Gateway"));
    }

    #[test]
    fn labels_the_summary_with_the_provider_that_produced_it() {
        let structured = json!({ "executiveSummary": "Shipped." });
        assert_eq!(
            from_structured(&structured, &request(), Provider::Gemini).provider,
            "gemini"
        );
        assert_eq!(
            from_structured(&structured, &request(), Provider::ClaudeCli).provider,
            "claude-cli"
        );
    }

    #[tokio::test]
    async fn gemini_wins_when_a_key_is_present_and_the_heuristic_is_the_floor() {
        let service = SummaryService::detect();
        service.set_gemini_key(Some("test-key".into())).await;
        assert_eq!(service.active_provider().await, Provider::Gemini);

        // A blank key must not count as configured.
        service.set_gemini_key(Some("   ".into())).await;
        assert_ne!(service.active_provider().await, Provider::Gemini);

        service.set_gemini_key(None).await;
        assert_ne!(service.active_provider().await, Provider::Gemini);
    }

    #[tokio::test]
    async fn the_status_never_exposes_the_key() {
        let service = SummaryService::detect();
        service
            .set_gemini_key(Some("AIzaSUPERSECRETVALUE".into()))
            .await;
        let status = service.status_value().await.to_string();
        assert!(status.contains("\"geminiKeySet\":true"));
        assert!(!status.contains("AIzaSUPERSECRETVALUE"));
        assert!(!status.contains("SUPERSECRET"));
    }

    #[tokio::test]
    async fn a_model_is_never_handed_to_the_wrong_provider() {
        let service = SummaryService::detect();

        service.set_model("gemini-2.5-pro").await.unwrap();
        assert_eq!(service.model_for(Provider::Gemini).await, "gemini-2.5-pro");
        // Falling back from Gemini to the CLI must not pass a Gemini model along,
        // or the CLI exits with `unrecognized_model` and the fallback is wasted.
        assert_eq!(
            service.model_for(Provider::ClaudeCli).await,
            DEFAULT_CLAUDE_MODEL
        );

        service.set_model("sonnet").await.unwrap();
        assert_eq!(service.model_for(Provider::ClaudeCli).await, "sonnet");
        assert_eq!(
            service.model_for(Provider::Gemini).await,
            DEFAULT_GEMINI_MODEL
        );
    }

    #[test]
    fn recognises_gemini_model_names() {
        assert!(is_gemini_model("gemini-2.5-flash"));
        assert!(is_gemini_model("  GEMINI-2.5-PRO "));
        assert!(!is_gemini_model("sonnet"));
        assert!(!is_gemini_model("claude-haiku-4-5"));
    }

    #[tokio::test]
    async fn pinning_a_provider_reports_what_can_actually_run() {
        let service = SummaryService::detect();
        service.set_gemini_key(None).await;

        // Gemini without a key cannot run, and the caller is told which provider
        // it fell back to rather than being left to assume Gemini worked.
        let resolved = service.set_preference("gemini").await.unwrap();
        assert_ne!(resolved, Provider::Gemini);

        service.set_gemini_key(Some("k".into())).await;
        assert_eq!(
            service.set_preference("gemini").await.unwrap(),
            Provider::Gemini
        );

        // The heuristic is always available, so pinning it always holds.
        assert_eq!(
            service.set_preference("heuristic").await.unwrap(),
            Provider::Heuristic
        );

        // "auto" goes back to picking by availability, which is Gemini here.
        assert_eq!(
            service.set_preference("auto").await.unwrap(),
            Provider::Gemini
        );

        assert!(service.set_preference("gpt-9").await.is_err());
    }

    #[test]
    fn pro_never_receives_a_zero_thinking_budget() {
        // 2.5 Pro rejects a budget below its minimum, which would fail the whole
        // request and drop the summary to the heuristic. Omitting the field lets
        // its own default apply.
        let pro = build_gemini_request(&request(), "gemini-2.5-pro", 0);
        assert!(pro["generationConfig"].get("thinkingConfig").is_none());

        // An explicit budget is still honoured for Pro.
        let pro_budgeted = build_gemini_request(&request(), "gemini-2.5-pro", 256);
        assert_eq!(
            pro_budgeted["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            256
        );

        // Flash can turn thinking off, and does by default.
        let flash = build_gemini_request(&request(), "gemini-2.5-flash", 0);
        assert_eq!(
            flash["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            0
        );

        assert!(can_disable_thinking("gemini-2.5-flash"));
        assert!(can_disable_thinking("gemini-2.5-flash-lite"));
        assert!(!can_disable_thinking("gemini-2.5-pro"));
        assert!(!can_disable_thinking("  GEMINI-2.5-PRO  "));
    }
}
