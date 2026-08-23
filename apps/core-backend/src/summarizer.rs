use serde::Serialize;
use serde_json::{json, Value};
use std::{env, path::PathBuf, process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command, sync::RwLock, time::timeout};

const DEFAULT_MODEL: &str = "sonnet";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_TRANSCRIPT_CHARS: usize = 120_000;
const TRIM_MARKER: &str = "\n\n[... middle of the transcript omitted for length ...]\n\n";
const DISALLOWED_TOOLS: &str = "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit";

const SYSTEM_PROMPT: &str = "You are a meeting intelligence engine inside a desktop meeting assistant. \
You turn speaker-diarized meeting transcripts into precise, executive-ready notes.

Rules:
- Ground every sentence in what was actually said. Never invent attendees, dates, numbers or commitments.
- \"You\" is the local user of the app; other labels are the remote participants.
- Attribute each action item to the speaker who committed to it, or to the person it was asked of.
- Use \"TBD\" when a deadline was never stated. Never guess one.
- Prefer specifics over praise: no filler, no meta-commentary about the transcript.
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

#[derive(Debug, Clone, PartialEq)]
pub enum Provider {
    ClaudeCli,
    Heuristic,
}

impl Provider {
    fn as_str(&self) -> &'static str {
        match self {
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
    preference: Provider,
    model: RwLock<String>,
    request_timeout: Duration,
    safe_mode: bool,
    max_budget_usd: Option<String>,
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
        Ok(value) => !matches!(value.trim().to_ascii_lowercase().as_str(), "0" | "false" | "no" | "off"),
        Err(_) => default,
    }
}

fn clock(ms: i64) -> String {
    let total = (ms.max(0)) / 1000;
    format!("{:02}:{:02}", total / 60, total % 60)
}

impl SummaryService {
    pub fn detect() -> Self {
        let preference = match env::var("ALPHA_SUMMARY_PROVIDER")
            .unwrap_or_else(|_| "auto".into())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "heuristic" | "offline" | "none" | "off" => Provider::Heuristic,
            _ => Provider::ClaudeCli,
        };

        Self {
            binary: if preference == Provider::ClaudeCli {
                find_claude_binary()
            } else {
                None
            },
            preference,
            model: RwLock::new(
                env::var("ALPHA_SUMMARY_MODEL")
                    .ok()
                    .map(|m| m.trim().to_string())
                    .filter(|m| !m.is_empty())
                    .unwrap_or_else(|| DEFAULT_MODEL.into()),
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

    pub fn active_provider(&self) -> Provider {
        if self.preference == Provider::ClaudeCli && self.binary.is_some() {
            Provider::ClaudeCli
        } else {
            Provider::Heuristic
        }
    }

    pub async fn status_value(&self) -> Value {
        json!({
            "provider": self.active_provider().as_str(),
            "binary": self.binary.as_ref().map(|p| p.to_string_lossy().to_string()),
            "model": self.model.read().await.clone(),
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
        if request.turns.is_empty() {
            return MeetingSummary {
                summary_markdown: "No speech recorded during this meeting.".into(),
                provider: self.active_provider().as_str().into(),
                ..Default::default()
            };
        }

        if self.active_provider() == Provider::Heuristic {
            return heuristic_summary(request, None);
        }

        match self.run_cli(request).await {
            Ok(structured) => from_structured(&structured, request),
            Err(cause) => {
                eprintln!("[Alpha Core Backend] Claude CLI summary failed: {cause}");
                heuristic_summary(request, Some(cause))
            }
        }
    }

    async fn run_cli(&self, request: &SummaryRequest) -> Result<Value, String> {
        let binary = self.binary.as_ref().ok_or("Claude CLI is not installed")?;
        let model = self.model.read().await.clone();

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
    let envelope: Value =
        serde_json::from_str(stdout.trim()).map_err(|e| format!("CLI returned unparseable output: {e}"))?;

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

    format!(
        "Meeting title: {}\nStarted at (epoch ms): {}\nDuration: {}\nSpoken turns: {}\n\n--- TRANSCRIPT ---\n{}--- END TRANSCRIPT ---\n",
        request.title,
        request.started_at,
        duration,
        request.turns.len(),
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
    format!("{}{}{}", &text[..head_end], TRIM_MARKER, &text[tail_start..])
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

fn from_structured(structured: &Value, request: &SummaryRequest) -> MeetingSummary {
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
        provider: Provider::ClaudeCli.as_str().into(),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> SummaryRequest {
        SummaryRequest {
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
    fn renders_transcript_with_clock_and_header() {
        let prompt = render_transcript(&request());
        assert!(prompt.contains("Meeting title: Release Sync"));
        assert!(prompt.contains("Duration: 11 minutes"));
        assert!(prompt.contains("[00:01] You: We agreed to ship the beta on Friday."));
        assert!(prompt.contains("[01:05] Others: I will send the release notes."));
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
        assert!(parse_cli_output("not json").unwrap_err().contains("unparseable"));
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

        let summary = from_structured(&structured, &request());
        assert_eq!(summary.provider, "claude-cli");
        assert_eq!(summary.key_decisions, vec!["Ship the beta on Friday"]);
        assert_eq!(summary.action_items.len(), 1);
        assert_eq!(summary.action_items[0]["deadline"], "TBD");
        assert_eq!(summary.action_items[0]["priority"], "Medium");
        assert!(summary.summary_markdown.starts_with("The team locked the beta date."));
        assert!(summary.summary_markdown.contains("### Discussion topics"));
        assert!(summary.email_draft.starts_with("Subject: Beta ships Friday"));
    }

    #[test]
    fn heuristic_summary_only_repeats_spoken_text() {
        let summary = heuristic_summary(&request(), Some("CLI missing".into()));
        assert_eq!(summary.provider, "heuristic");
        assert_eq!(summary.key_decisions, vec!["We agreed to ship the beta on Friday."]);
        assert_eq!(summary.action_items.len(), 1);
        assert_eq!(summary.action_items[0]["owner"], "Others");
        assert_eq!(summary.warning.as_deref(), Some("CLI missing"));
    }

    #[tokio::test]
    async fn empty_transcript_short_circuits() {
        let service = SummaryService::detect();
        let summary = service
            .summarize(&SummaryRequest {
                title: "Quiet".into(),
                started_at: 0,
                duration_seconds: 0,
                turns: vec![],
            })
            .await;
        assert_eq!(summary.summary_markdown, "No speech recorded during this meeting.");
        assert!(summary.action_items.is_empty());
    }
}
