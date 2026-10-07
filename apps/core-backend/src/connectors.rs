use chrono::{TimeZone, Utc};
use reqwest::{Client, RequestBuilder};
use serde_json::{json, Map, Value};
use std::{sync::Arc, time::Duration};

use crate::calendar::{self, CalendarService};
use crate::library::timecode as clock;
use crate::settings::SettingsStore;

pub const SLACK: &str = "slack";
pub const NOTION: &str = "notion";
pub const LINEAR: &str = "linear";
pub const JIRA: &str = "jira";
pub const ASANA: &str = "asana";
pub use crate::calendar::GOOGLE_DOCS;
pub const CLICKUP: &str = "clickup";

const NOTION_VERSION: &str = "2022-06-28";
const NOTION_TEXT_LIMIT: usize = 1900;
const NOTION_BLOCK_LIMIT: usize = 100;
const SLACK_TEXT_LIMIT: usize = 38000;
const DOCS_FOLDER_NAME: &str = "Kesami Meetings";
const DRIVE_FOLDER_MIME: &str = "application/vnd.google-apps.folder";
const DRIVE_DOC_MIME: &str = "application/vnd.google-apps.document";

pub struct Field {
    pub key: &'static str,
    pub label: &'static str,
    pub secret: bool,
    pub required: bool,
    pub placeholder: &'static str,
}

pub struct Spec {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: &'static str,
    pub help: &'static str,
    pub fields: &'static [Field],
    pub oauth: Option<&'static str>,
}

const fn field(
    key: &'static str,
    label: &'static str,
    secret: bool,
    required: bool,
    placeholder: &'static str,
) -> Field {
    Field {
        key,
        label,
        secret,
        required,
        placeholder,
    }
}

pub const SPECS: [Spec; 7] = [
    Spec {
        id: SLACK,
        label: "Slack",
        kind: "notes",
        help: "Create an incoming webhook for the channel at api.slack.com/apps → Incoming Webhooks, then paste its URL.",
        fields: &[
            field("webhookUrl", "Webhook URL", true, true, "https://hooks.slack.com/services/…"),
            field("channelLabel", "Channel label (display only)", false, false, "#meeting-recaps"),
        ],
        oauth: None,
    },
    Spec {
        id: NOTION,
        label: "Notion",
        kind: "notes",
        help: "Create an internal integration at notion.so/my-integrations, share the parent page with it (••• → Connections), then paste the token and the page link.",
        fields: &[
            field("token", "Integration token", true, true, "ntn_…"),
            field("parentPageId", "Parent page link or ID", false, true, "https://www.notion.so/Meeting-notes-…"),
        ],
        oauth: None,
    },
    Spec {
        id: GOOGLE_DOCS,
        label: "Google Docs",
        kind: "notes",
        help: "Sign in with Google. Each meeting becomes a Google Doc — notes plus the full transcript — in a “Kesami Meetings” folder in your Drive. Kesami can only see the files it creates.",
        fields: &[],
        oauth: Some(calendar::GOOGLE_DOCS),
    },
    Spec {
        id: LINEAR,
        label: "Linear",
        kind: "tasks",
        help: "Create a personal API key in Linear → Settings → Security & access, and enter the team key shown in issue IDs (for example ENG).",
        fields: &[
            field("apiKey", "API key", true, true, "lin_api_…"),
            field("teamKey", "Team key", false, true, "ENG"),
        ],
        oauth: None,
    },
    Spec {
        id: JIRA,
        label: "Jira",
        kind: "tasks",
        help: "Create an API token at id.atlassian.com/manage-profile/security/api-tokens. Issues are created in the project you name.",
        fields: &[
            field("siteUrl", "Site URL", false, true, "https://your-team.atlassian.net"),
            field("email", "Atlassian email", false, true, "you@company.com"),
            field("apiToken", "API token", true, true, ""),
            field("projectKey", "Project key", false, true, "OPS"),
            field("issueType", "Issue type", false, false, "Task"),
        ],
        oauth: None,
    },
    Spec {
        id: ASANA,
        label: "Asana",
        kind: "tasks",
        help: "Create a personal access token in Asana → My settings → Apps → Developer apps, and paste the project link.",
        fields: &[
            field("token", "Personal access token", true, true, ""),
            field("projectId", "Project link or ID", false, true, "https://app.asana.com/0/1200000000000000/list"),
        ],
        oauth: None,
    },
    Spec {
        id: CLICKUP,
        label: "ClickUp",
        kind: "tasks",
        help: "Generate a personal API token in ClickUp → Settings → Apps, then paste the link of the list tasks should go to.",
        fields: &[
            field("token", "Personal API token", true, true, "pk_…"),
            field("listId", "List link or ID", false, true, "https://app.clickup.com/9012345678/v/li/901234567890"),
        ],
        oauth: None,
    },
];

pub fn spec_for(provider: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|spec| spec.id == provider)
}

fn credential_key(provider: &str) -> String {
    format!("connector.{provider}")
}

fn text(config: &Map<String, Value>, key: &str) -> String {
    config
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

pub fn allows_automatic_delivery(provider: &str) -> bool {
    spec_for(provider).is_some_and(|spec| spec.kind != "tasks")
}

pub fn is_connected(spec: &Spec, config: &Map<String, Value>) -> bool {
    spec.oauth.is_none()
        && spec
            .fields
            .iter()
            .filter(|field| field.required)
            .all(|field| !text(config, field.key).is_empty())
}

pub fn public_config(spec: &Spec, config: &Map<String, Value>, oauth: Option<&Value>) -> Value {
    let mut out = Map::new();
    for field in spec.fields {
        let value = text(config, field.key);
        if field.secret {
            out.insert(format!("{}Set", field.key), Value::Bool(!value.is_empty()));
        } else {
            out.insert(field.key.to_string(), Value::String(value));
        }
    }
    json!({
        "provider": spec.id,
        "label": spec.label,
        "kind": spec.kind,
        "help": spec.help,
        "connected": oauth
            .map(|status| status["connected"] == json!(true))
            .unwrap_or_else(|| is_connected(spec, config)),
        "oauth": spec.oauth.is_some(),
        "configured": oauth.map(|status| status["configured"] == json!(true)).unwrap_or(true),
        "account": oauth.and_then(|status| status.get("account")).cloned().unwrap_or(Value::Null),
        "autoPush": config.get("autoPush").and_then(Value::as_bool).unwrap_or(false),
        "config": out,
        "fields": spec.fields.iter().map(|field| json!({
            "key": field.key,
            "label": field.label,
            "secret": field.secret,
            "required": field.required,
            "placeholder": field.placeholder,
        })).collect::<Vec<_>>(),
    })
}

pub fn merge_config(
    spec: &Spec,
    current: &Map<String, Value>,
    incoming: &Value,
) -> Result<Map<String, Value>, String> {
    let mut next = current.clone();
    for field in spec.fields {
        let Some(value) = incoming.get(field.key) else {
            continue;
        };
        let Some(value) = value.as_str() else {
            return Err(format!("{} must be text", field.label));
        };
        let value = value.trim();
        if field.secret && value.is_empty() {
            continue;
        }
        next.insert(field.key.to_string(), Value::String(value.to_string()));
    }
    if let Some(value) = incoming.get("autoPush") {
        let Some(enabled) = value.as_bool() else {
            return Err("autoPush must be true or false".into());
        };
        next.insert("autoPush".into(), Value::Bool(enabled));
    }
    validate(spec, &next)?;
    Ok(next)
}

fn valid_slack_webhook(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("hooks.slack.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path().starts_with("/services/")
            && url.path().len() > 10
    })
}

fn validate(spec: &Spec, config: &Map<String, Value>) -> Result<(), String> {
    match spec.id {
        SLACK => {
            let url = text(config, "webhookUrl");
            if !url.is_empty() && !valid_slack_webhook(&url) {
                return Err(
                    "Use a Slack incoming webhook URL starting with https://hooks.slack.com/services/".into(),
                );
            }
        }
        NOTION => {
            let page = text(config, "parentPageId");
            if !page.is_empty() && notion_page_id(&page).is_none() {
                return Err("That doesn’t look like a Notion page link or ID.".into());
            }
        }
        JIRA => {
            let site = text(config, "siteUrl");
            if !site.is_empty() && !site.starts_with("https://") {
                return Err("The Jira site URL should start with https://".into());
            }
        }
        ASANA => {
            let project = text(config, "projectId");
            if !project.is_empty() && asana_project_id(&project).is_none() {
                return Err("That doesn’t look like an Asana project link or ID.".into());
            }
        }
        CLICKUP => {
            let list = text(config, "listId");
            if !list.is_empty() && clickup_list_id(&list).is_none() {
                return Err("That doesn’t look like a ClickUp list link or ID. Open the list from the sidebar and copy its link, or paste the list ID.".into());
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn notion_page_id(value: &str) -> Option<String> {
    let path = value.trim().split(['?', '#']).next().unwrap_or_default();
    let hex: String = path.chars().filter(char::is_ascii_hexdigit).collect();
    let tail = path
        .rsplit(['/', '-'])
        .next()
        .unwrap_or_default()
        .replace('-', "");
    let candidate = if tail.len() == 32 && tail.chars().all(|c| c.is_ascii_hexdigit()) {
        tail
    } else if path.contains('-') && path.len() == 36 && hex.len() == 32 {
        hex
    } else {
        return None;
    };
    let id = candidate.to_ascii_lowercase();
    Some(format!(
        "{}-{}-{}-{}-{}",
        &id[0..8],
        &id[8..12],
        &id[12..16],
        &id[16..20],
        &id[20..32]
    ))
}

pub fn asana_project_id(value: &str) -> Option<String> {
    let value = value.trim();
    if !value.is_empty() && value.chars().all(|c| c.is_ascii_digit()) {
        return Some(value.to_string());
    }
    let path = value.split(['?', '#']).next().unwrap_or_default();
    let segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if let Some(index) = segments.iter().position(|segment| *segment == "project") {
        return segments
            .get(index + 1)
            .filter(|id| id.chars().all(|c| c.is_ascii_digit()))
            .map(|id| id.to_string());
    }
    if let Some(index) = segments.iter().position(|segment| *segment == "0") {
        return segments
            .get(index + 1)
            .filter(|id| id.len() > 3 && id.chars().all(|c| c.is_ascii_digit()))
            .map(|id| id.to_string());
    }
    None
}

pub fn clickup_list_id(value: &str) -> Option<String> {
    let value = value.trim();
    if !value.is_empty() && value.chars().all(|c| c.is_ascii_digit()) {
        return Some(value.to_string());
    }
    let path = value.split(['?', '#']).next().unwrap_or_default();
    let segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if let Some(id) = segments
        .iter()
        .position(|segment| *segment == "li")
        .and_then(|index| segments.get(index + 1))
        .filter(|id| id.chars().all(|c| c.is_ascii_digit()))
    {
        return Some(id.to_string());
    }
    segments.iter().find_map(|segment| {
        let mut parts = segment.split('-');
        let (Some("6"), Some(id), Some(view), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return None;
        };
        let digits = |value: &str| !value.is_empty() && value.chars().all(|c| c.is_ascii_digit());
        (digits(id) && digits(view)).then(|| id.to_string())
    })
}

pub fn turn_offset_ms(meeting: &Value, turn: &Value) -> i64 {
    let start = turn.get("startMs").and_then(Value::as_i64).unwrap_or(0);
    if start > 1_000_000_000_000 {
        start
            - meeting
                .get("startedAt")
                .and_then(Value::as_i64)
                .unwrap_or(start)
    } else {
        start
    }
}

#[derive(Debug, Clone, Default)]
pub struct TranscriptLine {
    pub speaker: String,
    pub offset_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, Default)]
pub struct ActionItem {
    pub task: String,
    pub owner: Option<String>,
    pub deadline: Option<String>,
    pub due_date: Option<String>,
    pub priority: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct MeetingNotes {
    pub id: String,
    pub title: String,
    pub date: String,
    pub duration_minutes: i64,
    pub participants: Vec<String>,
    pub summary_markdown: String,
    pub key_decisions: Vec<String>,
    pub action_items: Vec<ActionItem>,
    pub transcript: Vec<TranscriptLine>,
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
}

fn meaningful(value: Option<&str>, placeholders: &[&str]) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| {
            !value.is_empty() && !placeholders.iter().any(|p| value.eq_ignore_ascii_case(p))
        })
        .map(str::to_string)
}

impl MeetingNotes {
    pub fn from_meeting(meeting: &Value) -> Self {
        let started = meeting
            .get("startedAt")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let date = Utc
            .timestamp_millis_opt(started)
            .single()
            .map(|at| at.format("%Y-%m-%d").to_string())
            .unwrap_or_default();
        let mut participants: Vec<String> = meeting
            .pointer("/metadata/participants")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|p| p.as_str().or_else(|| p.get("name").and_then(Value::as_str)))
            .map(str::to_string)
            .collect();
        if participants.is_empty() {
            for turn in meeting
                .get("transcript")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(speaker) = turn.get("speaker").and_then(Value::as_str) {
                    if !participants.iter().any(|p| p == speaker) {
                        participants.push(speaker.to_string());
                    }
                }
            }
        }
        let action_items = meeting
            .get("actionItems")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| {
                if let Some(task) = item.as_str() {
                    return Some(ActionItem {
                        task: task.trim().to_string(),
                        ..Default::default()
                    });
                }
                let task = item.get("task").and_then(Value::as_str)?.trim().to_string();
                let deadline = meaningful(
                    item.get("deadline").and_then(Value::as_str),
                    &["TBD", "none", "n/a"],
                );
                Some(ActionItem {
                    task,
                    owner: meaningful(item.get("owner").and_then(Value::as_str), &["Unassigned"]),
                    due_date: deadline.clone().filter(|d| is_iso_date(d)),
                    deadline,
                    priority: meaningful(item.get("priority").and_then(Value::as_str), &[]),
                })
            })
            .filter(|item| !item.task.is_empty())
            .collect();
        Self {
            id: meeting
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            title: meaningful(meeting.get("title").and_then(Value::as_str), &[])
                .unwrap_or_else(|| "Untitled meeting".into()),
            date,
            duration_minutes: (meeting
                .get("durationSeconds")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                + 30)
                / 60,
            participants,
            summary_markdown: meeting
                .get("summaryMarkdown")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
            key_decisions: meeting
                .get("keyDecisions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .map(str::to_string)
                .collect(),
            action_items,
            transcript: meeting
                .get("transcript")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|turn| {
                    let text = turn.get("text").and_then(Value::as_str)?.trim();
                    (!text.is_empty()).then(|| TranscriptLine {
                        speaker: turn
                            .get("speaker")
                            .and_then(Value::as_str)
                            .unwrap_or("Speaker")
                            .to_string(),
                        offset_ms: turn_offset_ms(meeting, turn),
                        text: text.to_string(),
                    })
                })
                .collect(),
        }
    }

    pub fn has_content(&self) -> bool {
        !self.summary_markdown.is_empty()
            || !self.action_items.is_empty()
            || !self.key_decisions.is_empty()
    }

    pub fn wants(&self, provider: &str) -> bool {
        match spec_for(provider).map(|spec| spec.kind) {
            Some("tasks") => !self.action_items.is_empty(),
            _ => self.has_content(),
        }
    }

    fn meta_line(&self) -> String {
        let mut parts = vec![self.date.clone(), format!("{} min", self.duration_minutes)];
        if !self.participants.is_empty() {
            parts.push(self.participants.join(", "));
        }
        parts
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join(" · ")
    }

    fn task_description(&self, item: &ActionItem) -> String {
        let mut lines = Vec::new();
        if let Some(owner) = &item.owner {
            lines.push(format!("Owner: {owner}"));
        }
        if let Some(deadline) = &item.deadline {
            lines.push(format!("Due: {deadline}"));
        }
        lines.push(format!(
            "From the meeting “{}” ({}).",
            self.title,
            self.meta_line()
        ));
        let summary = first_paragraph(&self.summary_markdown);
        if !summary.is_empty() {
            lines.push(String::new());
            lines.push(summary);
        }
        lines.push(String::new());
        lines.push("Created by Kesami.".into());
        lines.join("\n")
    }
}

fn first_paragraph(markdown: &str) -> String {
    markdown
        .split("\n\n")
        .map(str::trim)
        .find(|block| !block.is_empty() && !block.starts_with('#'))
        .unwrap_or_default()
        .to_string()
}

fn truncate(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut out: String = value.chars().take(limit.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn markdown_to_slack(markdown: &str) -> String {
    markdown
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            let indent = line.len() - trimmed.len();
            let body = if let Some(heading) = trimmed
                .strip_prefix("## ")
                .or_else(|| trimmed.strip_prefix("# "))
            {
                format!("*{}*", heading.trim())
            } else if let Some(bullet) = trimmed
                .strip_prefix("- ")
                .or_else(|| trimmed.strip_prefix("* "))
            {
                format!("{}• {}", if indent > 0 { "    " } else { "" }, bullet)
            } else {
                trimmed.to_string()
            };
            body.replace("**", "*")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn slack_payload(notes: &MeetingNotes) -> Value {
    let mut text = format!("*{}*\n_{}_\n", notes.title, notes.meta_line());
    if !notes.summary_markdown.is_empty() {
        text.push('\n');
        text.push_str(&markdown_to_slack(&notes.summary_markdown));
        text.push('\n');
    }
    if !notes.key_decisions.is_empty() {
        text.push_str("\n*Decisions*\n");
        for decision in &notes.key_decisions {
            text.push_str(&format!("• {decision}\n"));
        }
    }
    if !notes.action_items.is_empty() && !notes.summary_markdown.contains("## Next steps") {
        text.push_str("\n*Action items*\n");
        for item in &notes.action_items {
            let owner = item
                .owner
                .as_deref()
                .map(|o| format!(" — {o}"))
                .unwrap_or_default();
            text.push_str(&format!("☐ {}{owner}\n", item.task));
        }
    }
    json!({ "text": truncate(text.trim_end(), SLACK_TEXT_LIMIT), "mrkdwn": true })
}

fn notion_text(content: &str) -> Value {
    let mut spans = Vec::new();
    let chars: Vec<char> = content.chars().collect();
    for chunk in chars.chunks(NOTION_TEXT_LIMIT) {
        spans.push(json!({"type": "text", "text": {"content": chunk.iter().collect::<String>()}}));
    }
    Value::Array(spans)
}

fn notion_block(kind: &str, content: &str) -> Value {
    let plain = content.replace("**", "");
    json!({"object": "block", "type": kind, kind: {"rich_text": notion_text(&plain)}})
}

fn notion_todo(content: &str) -> Value {
    json!({"object": "block", "type": "to_do", "to_do": {"rich_text": notion_text(content), "checked": false}})
}

pub fn notion_blocks(notes: &MeetingNotes) -> Vec<Value> {
    let mut blocks = vec![notion_block("paragraph", &notes.meta_line())];
    let mut in_next_steps = false;
    for line in notes.summary_markdown.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(heading) = trimmed
            .strip_prefix("## ")
            .or_else(|| trimmed.strip_prefix("# "))
        {
            in_next_steps = heading.trim().eq_ignore_ascii_case("next steps");
            if !in_next_steps {
                blocks.push(notion_block("heading_2", heading.trim()));
            }
        } else if in_next_steps {
            continue;
        } else if let Some(bullet) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            blocks.push(notion_block("bulleted_list_item", bullet));
        } else {
            blocks.push(notion_block("paragraph", trimmed));
        }
    }
    if !notes.key_decisions.is_empty() {
        blocks.push(notion_block("heading_2", "Decisions"));
        blocks.extend(
            notes
                .key_decisions
                .iter()
                .map(|d| notion_block("bulleted_list_item", d)),
        );
    }
    if !notes.action_items.is_empty() {
        blocks.push(notion_block("heading_2", "Action items"));
        for item in &notes.action_items {
            let mut line = item.task.clone();
            if let Some(owner) = &item.owner {
                line.push_str(&format!(" — {owner}"));
            }
            if let Some(deadline) = &item.deadline {
                line.push_str(&format!(" (due {deadline})"));
            }
            blocks.push(notion_todo(&line));
        }
    }
    blocks.truncate(NOTION_BLOCK_LIMIT);
    blocks
}

pub fn notion_page(notes: &MeetingNotes, parent_page_id: &str) -> Value {
    json!({
        "parent": {"page_id": parent_page_id},
        "properties": {"title": {"title": notion_text(&format!("{} — {}", notes.title, notes.date))}},
        "children": notion_blocks(notes),
    })
}

fn linear_priority(priority: Option<&str>) -> i64 {
    match priority.map(str::to_ascii_lowercase).as_deref() {
        Some("high") => 2,
        Some("medium") => 3,
        Some("low") => 4,
        _ => 0,
    }
}

pub fn linear_issue_input(notes: &MeetingNotes, item: &ActionItem, team_id: &str) -> Value {
    let mut input = json!({
        "teamId": team_id,
        "title": truncate(&item.task, 250),
        "description": notes.task_description(item),
        "priority": linear_priority(item.priority.as_deref()),
    });
    if let Some(due) = &item.due_date {
        input["dueDate"] = json!(due);
    }
    input
}

fn adf_document(text: &str) -> Value {
    let content: Vec<Value> = text
        .split("\n\n")
        .filter(|block| !block.trim().is_empty())
        .map(|block| {
            let mut spans = Vec::new();
            for (index, line) in block.lines().enumerate() {
                if index > 0 {
                    spans.push(json!({"type": "hardBreak"}));
                }
                if !line.is_empty() {
                    spans.push(json!({"type": "text", "text": line}));
                }
            }
            json!({"type": "paragraph", "content": spans})
        })
        .collect();
    json!({"type": "doc", "version": 1, "content": content})
}

fn jira_target(config: &Map<String, Value>) -> Value {
    let mut target = json!({"label":"Jira","connected":is_connected(spec_for(JIRA).unwrap(),config),"siteUrl":text(config,"siteUrl"),"projectKey":text(config,"projectKey"),"issueType":if text(config,"issueType").is_empty() { "Task".to_string() } else { text(config,"issueType") },"account":text(config,"email")});
    target["revision"] = json!(crate::actions::target_revision(&target));
    target
}

fn slack_target(config: &Map<String, Value>) -> Value {
    let mut target = json!({"label":"Slack · configured webhook channel","connected":is_connected(spec_for(SLACK).unwrap(),config),"channelLabel":text(config,"channelLabel"),"autoPush":config.get("autoPush").and_then(Value::as_bool).unwrap_or(false)});
    // Include a digest privately in revision calculation, never return the webhook.
    target["revision"] = json!(crate::actions::target_revision(&json!([
        target,
        text(config, "webhookUrl")
    ])));
    target
}

pub(crate) fn reviewed_slack_body(title: &str, body: &str) -> Value {
    // Disable mrkdwn/automatic parsing so transcript-derived mentions cannot ping
    // channels/users. Plain-text blocks preserve exactly the reviewed content.
    let content = format!("{}\n\n{}", title.trim(), body);
    let chars: Vec<_> = content.chars().collect();
    let blocks: Vec<_> = chars.chunks(2500).map(|chunk| json!({"type":"section","text":{"type":"plain_text","text":chunk.iter().collect::<String>(),"emoji":false}})).collect();
    json!({"text":content,"mrkdwn":false,"link_names":false,"unfurl_links":false,"unfurl_media":false,"blocks":blocks})
}

pub(crate) fn reviewed_jira_body(
    config: &Map<String, Value>,
    title: &str,
    description: &str,
) -> Value {
    json!({"fields":{
        "project":{"key":text(config,"projectKey")},
        "issuetype":{"name":if text(config,"issueType").is_empty() { "Task".to_string() } else { text(config,"issueType") }},
        "summary":title.trim(),"description":adf_document(description)
    }})
}

pub fn jira_issue(
    notes: &MeetingNotes,
    item: &ActionItem,
    project_key: &str,
    issue_type: &str,
    labelled: bool,
) -> Value {
    let mut issue = json!({
        "fields": {
            "project": {"key": project_key},
            "summary": truncate(&item.task.replace('\n', " "), 250),
            "issuetype": {"name": if issue_type.is_empty() { "Task" } else { issue_type }},
            "description": adf_document(&notes.task_description(item)),
        }
    });
    if labelled {
        issue["fields"]["labels"] = json!(["kesami"]);
    }
    issue
}

pub fn jira_rejected_labels(body: &Value) -> bool {
    body.pointer("/errors/labels").is_some()
}

pub fn asana_task(notes: &MeetingNotes, item: &ActionItem, project_id: &str) -> Value {
    let mut data = json!({
        "name": truncate(&item.task, 1000),
        "notes": notes.task_description(item),
        "projects": [project_id],
    });
    if let Some(due) = &item.due_date {
        data["due_on"] = json!(due);
    }
    json!({ "data": data })
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn inline_html(value: &str) -> String {
    let escaped = escape_html(value);
    let parts: Vec<&str> = escaped.split("**").collect();
    if parts.len() % 2 == 0 {
        return escaped.replace("**", "");
    }
    parts
        .iter()
        .enumerate()
        .map(|(index, part)| {
            if index % 2 == 1 {
                format!("<b>{part}</b>")
            } else {
                part.to_string()
            }
        })
        .collect()
}

fn html_list(items: &[(bool, String)]) -> String {
    let mut out = String::from("<ul>");
    let mut index = 0;
    while index < items.len() {
        let (nested, text) = &items[index];
        index += 1;
        out.push_str(&format!("<li>{}", inline_html(text)));
        if !nested {
            let children: Vec<&String> = items[index..]
                .iter()
                .take_while(|(n, _)| *n)
                .map(|(_, t)| t)
                .collect();
            if !children.is_empty() {
                out.push_str("<ul>");
                for child in &children {
                    out.push_str(&format!("<li>{}</li>", inline_html(child)));
                }
                out.push_str("</ul>");
                index += children.len();
            }
        }
        out.push_str("</li>");
    }
    out.push_str("</ul>");
    out
}

pub fn google_doc_html(notes: &MeetingNotes) -> String {
    let mut body = format!(
        "<h1>{}</h1><p style=\"color:#6E6E73\">{}</p>",
        escape_html(&notes.title),
        escape_html(&notes.meta_line())
    );
    let mut bullets: Vec<(bool, String)> = Vec::new();
    let mut skipping = false;
    let flush = |bullets: &mut Vec<(bool, String)>, body: &mut String| {
        if !bullets.is_empty() {
            body.push_str(&html_list(bullets));
            bullets.clear();
        }
    };
    for line in notes.summary_markdown.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(heading) = trimmed
            .strip_prefix("## ")
            .or_else(|| trimmed.strip_prefix("# "))
        {
            flush(&mut bullets, &mut body);
            skipping = heading.trim().eq_ignore_ascii_case("next steps");
            if !skipping {
                body.push_str(&format!("<h2>{}</h2>", escape_html(heading.trim())));
            }
        } else if skipping {
            continue;
        } else if let Some(bullet) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            bullets.push((line.len() > trimmed.len(), bullet.to_string()));
        } else {
            flush(&mut bullets, &mut body);
            body.push_str(&format!("<p>{}</p>", inline_html(trimmed)));
        }
    }
    flush(&mut bullets, &mut body);
    if !notes.key_decisions.is_empty() {
        body.push_str("<h2>Decisions</h2>");
        body.push_str(&html_list(
            &notes
                .key_decisions
                .iter()
                .map(|d| (false, d.clone()))
                .collect::<Vec<_>>(),
        ));
    }
    if !notes.action_items.is_empty() {
        body.push_str("<h2>Action items</h2><ul>");
        for item in &notes.action_items {
            let mut line = format!("☐ {}", escape_html(&item.task));
            if let Some(owner) = &item.owner {
                line.push_str(&format!(" — <b>{}</b>", escape_html(owner)));
            }
            if let Some(deadline) = &item.deadline {
                line.push_str(&format!(" (due {})", escape_html(deadline)));
            }
            body.push_str(&format!("<li>{line}</li>"));
        }
        body.push_str("</ul>");
    }
    if !notes.transcript.is_empty() {
        body.push_str("<h2>Transcript</h2>");
        for line in &notes.transcript {
            body.push_str(&format!(
                "<p><b>{}</b> <span style=\"color:#6E6E73\">[{}]</span> {}</p>",
                escape_html(&line.speaker),
                clock(line.offset_ms),
                escape_html(&line.text)
            ));
        }
    }
    body.push_str("<p style=\"color:#6E6E73\">Created by Kesami.</p>");
    format!("<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title></head><body>{body}</body></html>", escape_html(&notes.title))
}

pub fn drive_multipart(boundary: &str, metadata: &Value, html: &str) -> String {
    format!(
        "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n{html}\r\n--{boundary}--\r\n"
    )
}

pub fn clickup_task(notes: &MeetingNotes, item: &ActionItem) -> Value {
    let mut task = json!({
        "name": truncate(&item.task, 1000),
        "description": notes.task_description(item),
        "tags": ["kesami"],
    });
    let priority = linear_priority(item.priority.as_deref());
    if priority > 0 {
        task["priority"] = json!(priority);
    }
    if let Some(due) = item
        .due_date
        .as_deref()
        .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .and_then(|d| d.and_hms_opt(12, 0, 0))
    {
        task["due_date"] = json!(due.and_utc().timestamp_millis());
        task["due_date_time"] = json!(false);
    }
    task
}

pub fn delivered_ok(meeting: &Value, provider: &str) -> bool {
    meeting
        .pointer(&format!("/metadata/connectorDeliveries/{provider}/ok"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn error_detail(status: reqwest::StatusCode, body: &Value, raw: &str) -> String {
    let message = body
        .get("message")
        .or_else(|| body.pointer("/errors/0/message"))
        .or_else(|| body.pointer("/errorMessages/0"))
        .or_else(|| {
            body.get("errors")
                .and_then(|e| e.as_object())
                .and_then(|e| e.values().next())
        })
        .or_else(|| body.pointer("/errors/0/help"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| truncate(raw.trim(), 200));
    match status.as_u16() {
        401 | 403 => format!("the credentials were rejected ({status}): {message}"),
        404 => format!("the target wasn’t found ({status}) — check the ID and that the integration has access: {message}"),
        _ => format!("{status}: {message}"),
    }
}

pub struct ConnectorService {
    http: Client,
    settings: Arc<SettingsStore>,
    calendar: Arc<CalendarService>,
}

impl ConnectorService {
    pub fn new(settings: Arc<SettingsStore>, calendar: Arc<CalendarService>) -> Self {
        Self {
            http: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            settings,
            calendar,
        }
    }

    async fn oauth_status(&self, spec: &Spec) -> Option<Value> {
        match spec.oauth {
            Some(provider) => Some(self.calendar.oauth_status(provider).await),
            None => None,
        }
    }

    async fn connected(&self, spec: &Spec, config: &Map<String, Value>) -> bool {
        match self.oauth_status(spec).await {
            Some(status) => status["connected"] == json!(true),
            None => is_connected(spec, config),
        }
    }

    async fn store_config(
        &self,
        provider: &str,
        config: &Map<String, Value>,
    ) -> Result<(), String> {
        self.settings
            .set_credential(
                &credential_key(provider),
                Some(&Value::Object(config.clone()).to_string()),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub async fn connect(self: &Arc<Self>, provider: &str) -> Result<Value, String> {
        let spec = spec_for(provider).ok_or_else(|| format!("unknown connector: {provider}"))?;
        let oauth = spec
            .oauth
            .ok_or_else(|| format!("{} connects with a token, not a sign-in.", spec.label))?;
        self.calendar.begin(oauth).await
    }

    async fn config(&self, provider: &str) -> Map<String, Value> {
        self.settings
            .credential(&credential_key(provider))
            .await
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default()
    }

    pub async fn status(&self) -> Value {
        let mut providers = Vec::new();
        for spec in SPECS.iter() {
            let oauth = self.oauth_status(spec).await;
            providers.push(public_config(
                spec,
                &self.config(spec.id).await,
                oauth.as_ref(),
            ));
        }
        json!({ "providers": providers })
    }

    pub async fn save(&self, provider: &str, incoming: &Value) -> Result<Value, String> {
        let spec = spec_for(provider).ok_or_else(|| format!("unknown connector: {provider}"))?;
        let next = merge_config(spec, &self.config(provider).await, incoming)?;
        self.store_config(provider, &next).await?;
        let oauth = self.oauth_status(spec).await;
        Ok(public_config(spec, &next, oauth.as_ref()))
    }

    pub async fn disconnect(&self, provider: &str) -> Result<(), String> {
        let spec = spec_for(provider).ok_or_else(|| format!("unknown connector: {provider}"))?;
        if let Some(oauth) = spec.oauth {
            self.calendar.disconnect(oauth).await?;
        }
        self.settings
            .set_credential(&credential_key(provider), None)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub async fn auto_push_targets(&self) -> Vec<&'static str> {
        let mut targets = Vec::new();
        for spec in SPECS.iter() {
            let config = self.config(spec.id).await;
            if self.connected(spec, &config).await
                && config.get("autoPush").and_then(Value::as_bool) == Some(true)
            {
                targets.push(spec.id);
            }
        }
        targets
    }

    async fn connected_config(
        &self,
        provider: &str,
    ) -> Result<(&'static Spec, Map<String, Value>), String> {
        let spec = spec_for(provider).ok_or_else(|| format!("unknown connector: {provider}"))?;
        let config = self.config(provider).await;
        if !self.connected(spec, &config).await {
            return Err(format!(
                "{} isn’t connected yet. Set it up in Settings → Connectors.",
                spec.label
            ));
        }
        Ok((spec, config))
    }

    async fn exchange(
        &self,
        request: RequestBuilder,
        what: &str,
    ) -> Result<(reqwest::StatusCode, Value, String), String> {
        let response = request
            .send()
            .await
            .map_err(|error| format!("{what}: could not reach the service ({error})"))?;
        let status = response.status();
        let raw = response.text().await.unwrap_or_default();
        let body = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
        Ok((status, body, raw))
    }

    async fn call(&self, request: RequestBuilder, what: &str) -> Result<Value, String> {
        let (status, body, raw) = self.exchange(request, what).await?;
        if !status.is_success() {
            return Err(format!("{what}: {}", error_detail(status, &body, &raw)));
        }
        Ok(if body.is_null() {
            Value::String(raw)
        } else {
            body
        })
    }

    fn notion(&self, request: RequestBuilder, token: &str) -> RequestBuilder {
        request
            .bearer_auth(token)
            .header("Notion-Version", NOTION_VERSION)
    }

    fn jira(&self, request: RequestBuilder, config: &Map<String, Value>) -> RequestBuilder {
        request
            .basic_auth(text(config, "email"), Some(text(config, "apiToken")))
            .header("Accept", "application/json")
    }

    fn jira_base(config: &Map<String, Value>) -> String {
        text(config, "siteUrl").trim_end_matches('/').to_string()
    }

    async fn create_jira_issue(
        &self,
        config: &Map<String, Value>,
        notes: &MeetingNotes,
        item: &ActionItem,
        labelled: &mut bool,
    ) -> Result<(Option<String>, Option<String>), String> {
        let base = Self::jira_base(config);
        loop {
            let issue = jira_issue(
                notes,
                item,
                &text(config, "projectKey"),
                &text(config, "issueType"),
                *labelled,
            );
            let (status, body, raw) = self
                .exchange(
                    self.jira(self.http.post(format!("{base}/rest/api/3/issue")), config)
                        .json(&issue),
                    "Jira",
                )
                .await?;
            if status.is_success() {
                let key = body.get("key").and_then(Value::as_str).map(str::to_string);
                let url = key.as_ref().map(|key| format!("{base}/browse/{key}"));
                return Ok((key, url));
            }
            if *labelled && jira_rejected_labels(&body) {
                *labelled = false;
                continue;
            }
            return Err(format!("Jira: {}", error_detail(status, &body, &raw)));
        }
    }

    async fn google_token(&self) -> Result<String, String> {
        self.calendar
            .access_token(calendar::GOOGLE_DOCS)
            .await
            .map_err(|error| {
                format!("Google Docs: {error}. Sign in again in Settings → Connectors.")
            })
    }

    async fn docs_folder(
        &self,
        token: &str,
        config: &mut Map<String, Value>,
    ) -> Result<String, String> {
        let known = text(config, "folderId");
        if !known.is_empty() {
            let existing = self
                .call(
                    self.http
                        .get(format!(
                            "https://www.googleapis.com/drive/v3/files/{known}?fields=id,trashed"
                        ))
                        .bearer_auth(token),
                    "Google Drive",
                )
                .await;
            if matches!(&existing, Ok(file) if file["trashed"] != json!(true)) {
                return Ok(known);
            }
        }
        let folder = self
            .call(
                self.http
                    .post("https://www.googleapis.com/drive/v3/files?fields=id")
                    .bearer_auth(token)
                    .json(&json!({"name": DOCS_FOLDER_NAME, "mimeType": DRIVE_FOLDER_MIME})),
                "Google Drive",
            )
            .await?;
        let id = folder
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Google Drive: the folder was created without an id")?
            .to_string();
        config.insert("folderId".into(), Value::String(id.clone()));
        self.store_config(GOOGLE_DOCS, config).await?;
        Ok(id)
    }

    async fn create_google_doc(
        &self,
        config: &mut Map<String, Value>,
        notes: &MeetingNotes,
    ) -> Result<Value, String> {
        let token = self.google_token().await?;
        let folder = self.docs_folder(&token, config).await?;
        let boundary = format!("kesami-{}", uuid::Uuid::new_v4().simple());
        let metadata = json!({
            "name": format!("{} — {}", notes.title, notes.date),
            "mimeType": DRIVE_DOC_MIME,
            "parents": [folder],
        });
        self.call(
            self.http
                .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink")
                .bearer_auth(&token)
                .header("Content-Type", format!("multipart/related; boundary={boundary}"))
                .body(drive_multipart(&boundary, &metadata, &google_doc_html(notes))),
            "Google Docs",
        )
        .await
    }

    async fn linear(
        &self,
        config: &Map<String, Value>,
        query: &str,
        variables: Value,
    ) -> Result<Value, String> {
        let body = self
            .call(
                self.http
                    .post("https://api.linear.app/graphql")
                    .header("Authorization", text(config, "apiKey"))
                    .json(&json!({"query": query, "variables": variables})),
                "Linear",
            )
            .await?;
        if let Some(message) = body.pointer("/errors/0/message").and_then(Value::as_str) {
            return Err(format!("Linear: {message}"));
        }
        Ok(body.get("data").cloned().unwrap_or(Value::Null))
    }

    async fn linear_team_id(&self, config: &Map<String, Value>) -> Result<String, String> {
        let wanted = text(config, "teamKey");
        let data = self
            .linear(
                config,
                "query { teams(first: 250) { nodes { id key name } } }",
                json!({}),
            )
            .await?;
        let teams = data
            .pointer("/teams/nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        teams
            .iter()
            .find(|team| {
                ["key", "id", "name"].iter().any(|field| {
                    team.get(*field)
                        .and_then(Value::as_str)
                        .is_some_and(|v| v.eq_ignore_ascii_case(&wanted))
                })
            })
            .and_then(|team| team.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .ok_or_else(|| {
                let keys: Vec<&str> = teams
                    .iter()
                    .filter_map(|t| t.get("key").and_then(Value::as_str))
                    .collect();
                format!(
                    "Linear: no team “{wanted}”. Teams this key can see: {}",
                    keys.join(", ")
                )
            })
    }

    pub async fn test(&self, provider: &str) -> Result<String, String> {
        let (spec, config) = self.connected_config(provider).await?;
        match spec.id {
            SLACK => {
                self.call(
                    self.http.post(text(&config, "webhookUrl")).json(
                        &json!({"text": "Kesami is connected. Meeting notes will be posted here."}),
                    ),
                    "Slack",
                )
                .await?;
                Ok("Posted a test message to the channel.".into())
            }
            NOTION => {
                let page = notion_page_id(&text(&config, "parentPageId")).unwrap_or_default();
                self.call(
                    self.notion(
                        self.http
                            .get(format!("https://api.notion.com/v1/pages/{page}")),
                        &text(&config, "token"),
                    ),
                    "Notion",
                )
                .await?;
                Ok("Kesami can write under that page.".into())
            }
            LINEAR => {
                self.linear_team_id(&config).await?;
                Ok(format!("Found team {}.", text(&config, "teamKey")))
            }
            JIRA => {
                let project = text(&config, "projectKey");
                let body = self
                    .call(
                        self.jira(
                            self.http.get(format!(
                                "{}/rest/api/3/project/{project}",
                                Self::jira_base(&config)
                            )),
                            &config,
                        ),
                        "Jira",
                    )
                    .await?;
                Ok(format!(
                    "Found project {}.",
                    body.get("name").and_then(Value::as_str).unwrap_or(&project)
                ))
            }
            ASANA => {
                let project = asana_project_id(&text(&config, "projectId")).unwrap_or_default();
                let body = self
                    .call(
                        self.http
                            .get(format!("https://app.asana.com/api/1.0/projects/{project}"))
                            .bearer_auth(text(&config, "token")),
                        "Asana",
                    )
                    .await?;
                Ok(format!(
                    "Found project {}.",
                    body.pointer("/data/name")
                        .and_then(Value::as_str)
                        .unwrap_or(&project)
                ))
            }
            GOOGLE_DOCS => {
                let token = self.google_token().await?;
                let about = self
                    .call(
                        self.http
                            .get("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)")
                            .bearer_auth(&token),
                        "Google Drive",
                    )
                    .await?;
                Ok(format!(
                    "Signed in as {}. Docs go to “{DOCS_FOLDER_NAME}” in your Drive.",
                    about
                        .pointer("/user/emailAddress")
                        .and_then(Value::as_str)
                        .unwrap_or("your Google account")
                ))
            }
            CLICKUP => {
                let list = clickup_list_id(&text(&config, "listId")).unwrap_or_default();
                let body = self
                    .call(
                        self.http
                            .get(format!("https://api.clickup.com/api/v2/list/{list}"))
                            .header("Authorization", text(&config, "token")),
                        "ClickUp",
                    )
                    .await?;
                Ok(format!(
                    "Found list {}.",
                    body.get("name").and_then(Value::as_str).unwrap_or(&list)
                ))
            }
            _ => Err(format!("unknown connector: {provider}")),
        }
    }

    pub async fn reviewed_jira_target(&self) -> Value {
        jira_target(&self.config(JIRA).await)
    }

    pub async fn reviewed_slack_target(&self) -> Value {
        slack_target(&self.config(SLACK).await)
    }

    pub async fn post_reviewed_slack_summary(
        &self,
        expected_target: &str,
        title: &str,
        body: &str,
    ) -> Result<Value, crate::actions::ActionError> {
        use crate::actions::ActionError;
        let config = self.config(SLACK).await;
        if !is_connected(spec_for(SLACK).unwrap(), &config) {
            return Err(ActionError::permission(
                "Connect a Slack incoming webhook in Settings, then review and confirm again.",
            ));
        }
        if slack_target(&config)["revision"] != expected_target {
            return Err(ActionError::permission(
                "The Slack destination changed. Reload, review and confirm the new destination.",
            ));
        }
        let url = text(&config, "webhookUrl");
        if !valid_slack_webhook(&url) {
            return Err(ActionError::permission(
                "Update the Slack incoming webhook in Settings, then review and confirm again.",
            ));
        }
        crate::action_providers::dispatch_slack(
            self.http.post(url).json(&reviewed_slack_body(title, body)),
        )
        .await
    }

    /// Create exactly one reviewed issue. Never export meeting notes/tasks here.
    pub async fn create_reviewed_jira_issue(
        &self,
        expected_target: &str,
        title: &str,
        description: &str,
    ) -> Result<Value, crate::actions::ActionError> {
        use crate::actions::ActionError;
        let (_, config) = self.connected_config(JIRA).await.map_err(|_| {
            ActionError::permission(
                "Connect Jira in Settings → Connectors, then review and confirm again.",
            )
        })?;
        if jira_target(&config)["revision"] != expected_target {
            return Err(ActionError { code:"destination_changed".into(),message:"The Jira destination changed. Reload actions and review the updated destination.".into(),retryable:true,uncertain:false });
        }
        let body = reviewed_jira_body(&config, title, description);
        let created = crate::action_providers::dispatch(
            self.jira(
                self.http
                    .post(format!("{}/rest/api/3/issue", Self::jira_base(&config))),
                &config,
            )
            .json(&body),
        )
        .await?;
        let key = created["key"]
            .as_str()
            .filter(|key| !key.is_empty())
            .ok_or_else(ActionError::uncertain)?;
        Ok(
            json!({"id":created["id"],"key":key,"url":format!("{}/browse/{key}",Self::jira_base(&config))}),
        )
    }

    pub async fn send(&self, provider: &str, meeting: &Value) -> Value {
        let notes = MeetingNotes::from_meeting(meeting);
        let at = Utc::now().timestamp_millis();
        let result = if notes.has_content() {
            self.deliver(provider, &notes).await
        } else {
            Err("This meeting has no summary or action items to send yet.".into())
        };
        match result {
            Ok((items, url)) => {
                json!({"provider": provider, "ok": true, "at": at, "url": url, "items": items})
            }
            Err(error) => json!({"provider": provider, "ok": false, "at": at, "error": error}),
        }
    }

    async fn deliver(
        &self,
        provider: &str,
        notes: &MeetingNotes,
    ) -> Result<(Vec<Value>, Option<String>), String> {
        let (spec, mut config) = self.connected_config(provider).await?;
        match spec.id {
            GOOGLE_DOCS => {
                let file = self.create_google_doc(&mut config, notes).await?;
                let url = file
                    .get("webViewLink")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                Ok((vec![json!({"title": notes.title, "url": url})], url))
            }
            SLACK => {
                self.call(
                    self.http
                        .post(text(&config, "webhookUrl"))
                        .json(&slack_payload(notes)),
                    "Slack",
                )
                .await?;
                Ok((vec![], None))
            }
            NOTION => {
                let page = notion_page_id(&text(&config, "parentPageId")).unwrap_or_default();
                let body = self
                    .call(
                        self.notion(
                            self.http.post("https://api.notion.com/v1/pages"),
                            &text(&config, "token"),
                        )
                        .json(&notion_page(notes, &page)),
                        "Notion",
                    )
                    .await?;
                let url = body.get("url").and_then(Value::as_str).map(str::to_string);
                Ok((vec![json!({"title": notes.title, "url": url})], url))
            }
            LINEAR | JIRA | ASANA | CLICKUP => self.deliver_tasks(spec, &config, notes).await,
            _ => Err(format!("unknown connector: {provider}")),
        }
    }

    async fn deliver_tasks(
        &self,
        spec: &Spec,
        config: &Map<String, Value>,
        notes: &MeetingNotes,
    ) -> Result<(Vec<Value>, Option<String>), String> {
        if notes.action_items.is_empty() {
            return Err("This meeting has no action items to create tasks from.".into());
        }
        let linear_team = if spec.id == LINEAR {
            Some(self.linear_team_id(config).await?)
        } else {
            None
        };
        let mut jira_labelled = true;
        let mut created = Vec::new();
        let mut failures = Vec::new();
        for item in &notes.action_items {
            let outcome = match spec.id {
                LINEAR => {
                    let input =
                        linear_issue_input(notes, item, linear_team.as_deref().unwrap_or_default());
                    self.linear(
                        config,
                        "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
                        json!({"input": input}),
                    )
                    .await
                    .map(|data| {
                        let issue = data.pointer("/issueCreate/issue").cloned().unwrap_or(Value::Null);
                        (issue.get("identifier").and_then(Value::as_str).map(str::to_string), issue.get("url").and_then(Value::as_str).map(str::to_string))
                    })
                }
                JIRA => {
                    self.create_jira_issue(config, notes, item, &mut jira_labelled)
                        .await
                }
                CLICKUP => {
                    let list = clickup_list_id(&text(config, "listId")).unwrap_or_default();
                    self.call(
                        self.http
                            .post(format!("https://api.clickup.com/api/v2/list/{list}/task"))
                            .header("Authorization", text(config, "token"))
                            .json(&clickup_task(notes, item)),
                        "ClickUp",
                    )
                    .await
                    .map(|body| {
                        (
                            body.get("custom_id")
                                .and_then(Value::as_str)
                                .or_else(|| body.get("id").and_then(Value::as_str))
                                .map(str::to_string),
                            body.get("url").and_then(Value::as_str).map(str::to_string),
                        )
                    })
                }
                ASANA => {
                    let project = asana_project_id(&text(config, "projectId")).unwrap_or_default();
                    self.call(
                        self.http
                            .post("https://app.asana.com/api/1.0/tasks")
                            .bearer_auth(text(config, "token"))
                            .json(&asana_task(notes, item, &project)),
                        "Asana",
                    )
                    .await
                    .map(|body| {
                        (
                            body.pointer("/data/gid")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            body.pointer("/data/permalink_url")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                        )
                    })
                }
                _ => Err(format!("unknown connector: {}", spec.id)),
            };
            match outcome {
                Ok((key, url)) => created.push(json!({"title": item.task, "key": key, "url": url})),
                Err(error) => {
                    if created.is_empty() && failures.is_empty() {
                        return Err(error);
                    }
                    failures.push(error);
                }
            }
        }
        if !failures.is_empty() {
            return Err(format!(
                "created {} of {} tasks; {}",
                created.len(),
                notes.action_items.len(),
                failures[0]
            ));
        }
        Ok((created, None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meeting() -> Value {
        json!({
            "id": "m1",
            "title": "Launch plan sync",
            "startedAt": 1_789_000_000_000i64,
            "durationSeconds": 1800,
            "summaryMarkdown": "We agreed to ship on Friday.\n\n## Timeline\n- Beta on Wednesday\n  - QA sign-off first\n\n## Next steps\n- **Write the changelog** (Aditi)",
            "keyDecisions": ["Ship Friday"],
            "actionItems": [
                {"task": "Write the changelog", "owner": "Aditi", "deadline": "2026-10-02", "priority": "High"},
                {"task": "Book the demo room", "owner": "Unassigned", "deadline": "TBD", "priority": "Low"}
            ],
            "metadata": {"participants": ["Riyam", "Aditi"]},
            "transcript": []
        })
    }

    #[test]
    fn actions_reviewed_jira_target_tracks_destination_without_exposing_credentials() {
        let mut config=json!({"siteUrl":"https://example.atlassian.net","projectKey":"API","email":"user@example.com","apiToken":"private-secret"}).as_object().unwrap().clone();
        let before = jira_target(&config);
        assert!(!before.to_string().contains("private-secret"));
        config.insert("projectKey".into(), json!("OTHER"));
        assert_ne!(before["revision"], jira_target(&config)["revision"]);
        let payload =
            reviewed_jira_body(&config, "One reviewed issue", "Only reviewed description");
        assert_eq!(payload["fields"]["summary"], "One reviewed issue");
        assert_eq!(payload["fields"]["project"]["key"], "OTHER");
        assert_eq!(payload["fields"]["description"]["type"], "doc");
        assert!(!payload.to_string().contains("private-secret"));
    }

    #[test]
    fn actions_external_tasks_require_manual_confirmation_even_with_legacy_auto_push() {
        for provider in [JIRA, LINEAR, ASANA, CLICKUP] {
            assert!(!allows_automatic_delivery(provider));
        }
        for provider in [SLACK, NOTION, GOOGLE_DOCS] {
            assert!(allows_automatic_delivery(provider));
        }
    }

    #[test]
    fn actions_slack_summary_destination_is_private_and_tracks_webhook_changes() {
        let mut config = json!({"webhookUrl":"https://hooks.slack.com/services/T/B/private-token","channelLabel":"#recaps","autoPush":true}).as_object().unwrap().clone();
        let target = slack_target(&config);
        assert_eq!(target["channelLabel"], "#recaps");
        assert_eq!(target["connected"], true);
        assert_eq!(target["autoPush"], true);
        assert!(
            !target.to_string().contains("private-token")
                && !target.to_string().contains("webhookUrl")
        );
        config.insert(
            "webhookUrl".into(),
            json!("https://hooks.slack.com/services/T/B/changed-token"),
        );
        assert_ne!(target["revision"], slack_target(&config)["revision"]);
        assert!(valid_slack_webhook(&text(&config, "webhookUrl")));
        for url in [
            "https://hooks.slack.com.evil.example/services/T/B/x",
            "https://hooks.slack.com@evil.example/services/T/B/x",
            "http://hooks.slack.com/services/T/B/x",
            "https://hooks.slack.com/services/T/B/x?redirect=evil",
            "https://hooks.slack.com/other",
        ] {
            assert!(!valid_slack_webhook(url), "{url}");
        }
    }

    #[test]
    fn actions_slack_summary_payload_is_plain_text_bounded_and_complete() {
        let body = format!("Reviewed recap <!channel> <@U123> {}", "界".repeat(5000));
        let payload = reviewed_slack_body("Pricing recap", &body);
        assert_eq!(payload["mrkdwn"], false);
        assert_eq!(payload["unfurl_links"], false);
        assert_eq!(payload["link_names"], false);
        let blocks = payload["blocks"].as_array().unwrap();
        let rebuilt: String = blocks
            .iter()
            .map(|b| {
                assert_eq!(b["text"]["type"], "plain_text");
                let text = b["text"]["text"].as_str().unwrap();
                assert!(text.chars().count() <= 2500);
                text
            })
            .collect();
        assert_eq!(rebuilt, format!("Pricing recap\n\n{body}"));
        assert!(!payload.to_string().contains("webhookUrl"));
    }

    #[test]
    fn notes_drop_placeholder_owners_and_deadlines() {
        let notes = MeetingNotes::from_meeting(&meeting());
        assert_eq!(notes.duration_minutes, 30);
        assert_eq!(notes.participants, vec!["Riyam", "Aditi"]);
        assert_eq!(
            notes.action_items[0].due_date.as_deref(),
            Some("2026-10-02")
        );
        assert_eq!(notes.action_items[1].owner, None);
        assert_eq!(notes.action_items[1].deadline, None);
    }

    #[test]
    fn slack_message_uses_mrkdwn_and_does_not_repeat_next_steps() {
        let text = slack_payload(&MeetingNotes::from_meeting(&meeting()))["text"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(text.starts_with("*Launch plan sync*"));
        assert!(text.contains("*Timeline*"));
        assert!(text.contains("• Beta on Wednesday"));
        assert!(text.contains("*Write the changelog* (Aditi)"));
        assert!(!text.contains("*Action items*"));
    }

    #[test]
    fn notion_page_turns_next_steps_into_todos_once() {
        let page = notion_page(&MeetingNotes::from_meeting(&meeting()), "abc");
        let blocks = page["children"].as_array().unwrap();
        let todos = blocks.iter().filter(|b| b["type"] == "to_do").count();
        assert_eq!(todos, 2);
        assert!(!blocks.iter().any(|b| b["type"] == "heading_2"
            && b["heading_2"]["rich_text"][0]["text"]["content"] == "Next steps"));
        assert_eq!(page["parent"]["page_id"], "abc");
    }

    #[test]
    fn notion_splits_long_text_and_caps_blocks() {
        let mut notes = MeetingNotes::from_meeting(&meeting());
        notes.summary_markdown = (0..150)
            .map(|i| format!("- point {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        notes
            .summary_markdown
            .push_str(&format!("\n\n{}", "x".repeat(4000)));
        let blocks = notion_blocks(&notes);
        assert_eq!(blocks.len(), NOTION_BLOCK_LIMIT);
        let long = notion_block("paragraph", &"y".repeat(4000));
        assert_eq!(long["paragraph"]["rich_text"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn notion_ids_are_read_from_links() {
        assert_eq!(
            notion_page_id(
                "https://www.notion.so/acme/Meeting-notes-1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6?pvs=4"
            )
            .as_deref(),
            Some("1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6")
        );
        assert_eq!(
            notion_page_id("1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6").as_deref(),
            Some("1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6")
        );
        assert_eq!(
            notion_page_id("https://www.notion.so/acme/Meeting-notes"),
            None
        );
    }

    #[test]
    fn asana_ids_are_read_from_links() {
        assert_eq!(
            asana_project_id("1209876543210").as_deref(),
            Some("1209876543210")
        );
        assert_eq!(
            asana_project_id("https://app.asana.com/0/1209876543210/list").as_deref(),
            Some("1209876543210")
        );
        assert_eq!(
            asana_project_id("https://app.asana.com/1/111/project/1209876543210/list/222")
                .as_deref(),
            Some("1209876543210")
        );
        assert_eq!(asana_project_id("https://app.asana.com/"), None);
    }

    #[test]
    fn task_payloads_carry_owner_due_date_and_source() {
        let notes = MeetingNotes::from_meeting(&meeting());
        let item = &notes.action_items[0];
        let linear = linear_issue_input(&notes, item, "team-1");
        assert_eq!(linear["priority"], 2);
        assert_eq!(linear["dueDate"], "2026-10-02");
        assert!(linear["description"]
            .as_str()
            .unwrap()
            .contains("Owner: Aditi"));
        let jira = jira_issue(&notes, item, "OPS", "", true);
        assert_eq!(jira["fields"]["issuetype"]["name"], "Task");
        assert_eq!(jira["fields"]["description"]["type"], "doc");
        assert_eq!(jira["fields"]["labels"][0], "kesami");
        assert!(jira_issue(&notes, item, "OPS", "Bug", false)["fields"]
            .get("labels")
            .is_none());
        let asana = asana_task(&notes, &notes.action_items[1], "42");
        assert!(asana["data"].get("due_on").is_none());
        assert_eq!(asana["data"]["projects"][0], "42");
    }

    #[test]
    fn saving_keeps_secrets_when_left_blank_and_validates() {
        let spec = spec_for(SLACK).unwrap();
        let first = merge_config(
            spec,
            &Map::new(),
            &json!({"webhookUrl": "https://hooks.slack.com/services/T/B/x", "autoPush": true}),
        )
        .unwrap();
        let second =
            merge_config(spec, &first, &json!({"webhookUrl": "", "autoPush": false})).unwrap();
        assert_eq!(
            text(&second, "webhookUrl"),
            "https://hooks.slack.com/services/T/B/x"
        );
        assert!(merge_config(
            spec,
            &Map::new(),
            &json!({"webhookUrl": "https://evil.example/hook"})
        )
        .is_err());
        let public = public_config(spec, &second, None);
        assert_eq!(public["config"]["webhookUrlSet"], true);
        assert!(public["config"].get("webhookUrl").is_none());
        assert_eq!(public["autoPush"], false);
    }

    #[test]
    fn clickup_list_ids_are_read_from_links() {
        assert_eq!(
            clickup_list_id("901234567890").as_deref(),
            Some("901234567890")
        );
        assert_eq!(
            clickup_list_id("https://app.clickup.com/9012345678/v/li/901234567890?pr=1").as_deref(),
            Some("901234567890")
        );
        assert_eq!(
            clickup_list_id("https://app.clickup.com/9012345678/v/l/li/901234567890").as_deref(),
            Some("901234567890")
        );
        assert_eq!(
            clickup_list_id("https://app.clickup.com/9012345678/v/l/6-901234567890-1").as_deref(),
            Some("901234567890")
        );
        assert_eq!(
            clickup_list_id("https://app.clickup.com/9012345678/v/b/6-901234567890-2?pr=9")
                .as_deref(),
            Some("901234567890")
        );
        assert_eq!(
            clickup_list_id("https://app.clickup.com/9012345678/v/l/5-90123456-1"),
            None
        );
        assert_eq!(
            clickup_list_id("https://app.clickup.com/9012345678/v/l/8cjz3-1234"),
            None
        );
        assert_eq!(
            clickup_list_id("https://app.clickup.com/9012345678/home"),
            None
        );
    }

    #[test]
    fn jira_label_rejections_are_recognised() {
        assert!(jira_rejected_labels(&json!({
            "errorMessages": [],
            "errors": {"labels": "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown."}
        })));
        assert!(!jira_rejected_labels(&json!({
            "errorMessages": [],
            "errors": {"issuetype": "Specify a valid issue type"}
        })));
        assert!(!jira_rejected_labels(&Value::Null));
    }

    #[test]
    fn clickup_tasks_map_priority_and_real_due_dates_only() {
        let notes = MeetingNotes::from_meeting(&meeting());
        let first = clickup_task(&notes, &notes.action_items[0]);
        assert_eq!(first["priority"], 2);
        assert_eq!(first["due_date"], 1_790_942_400_000i64);
        assert_eq!(first["due_date_time"], false);
        let second = clickup_task(&notes, &notes.action_items[1]);
        assert!(second.get("due_date").is_none());
        assert_eq!(second["priority"], 4);
    }

    #[test]
    fn google_doc_has_notes_nested_bullets_tasks_and_transcript() {
        let mut value = meeting();
        value["title"] = json!("Q3 <plan> & budget");
        value["transcript"] = json!([
            {"speaker": "Aditi", "startMs": 65_000, "text": "Ship on Friday."},
            {"speaker": "Riyam", "startMs": 70_000, "text": "   "}
        ]);
        let html = google_doc_html(&MeetingNotes::from_meeting(&value));
        assert!(html.contains("<h1>Q3 &lt;plan&gt; &amp; budget</h1>"));
        assert!(html.contains("<h2>Timeline</h2><ul><li>Beta on Wednesday<ul><li>QA sign-off first</li></ul></li></ul>"));
        assert!(!html.contains("Next steps"));
        assert!(html.contains("☐ Write the changelog — <b>Aditi</b> (due 2026-10-02)"));
        assert!(html
            .contains("<b>Aditi</b> <span style=\"color:#6E6E73\">[01:05]</span> Ship on Friday."));
        assert_eq!(html.matches("<p><b>").count(), 1);
    }

    #[test]
    fn drive_upload_is_a_two_part_related_body() {
        let body = drive_multipart("b1", &json!({"name": "x"}), "<p>hi</p>");
        assert!(body.starts_with("--b1\r\nContent-Type: application/json"));
        assert!(
            body.contains("\r\n--b1\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n<p>hi</p>")
        );
        assert!(body.ends_with("--b1--\r\n"));
    }

    #[test]
    fn oauth_connectors_report_the_sign_in_not_the_fields() {
        let spec = spec_for(GOOGLE_DOCS).unwrap();
        assert!(!is_connected(spec, &Map::new()));
        let status = json!({"connected": true, "account": "riyam@example.com", "configured": true});
        let public = public_config(spec, &Map::new(), Some(&status));
        assert_eq!(public["connected"], true);
        assert_eq!(public["oauth"], true);
        assert_eq!(public["account"], "riyam@example.com");
    }

    #[test]
    fn task_connectors_only_want_meetings_with_action_items() {
        let mut value = meeting();
        let notes = MeetingNotes::from_meeting(&value);
        assert!(notes.wants(LINEAR) && notes.wants(SLACK));
        value["actionItems"] = json!([]);
        let notes = MeetingNotes::from_meeting(&value);
        for provider in [LINEAR, JIRA, ASANA, CLICKUP] {
            assert!(!notes.wants(provider));
        }
        assert!(notes.wants(SLACK) && notes.wants(NOTION) && notes.wants(GOOGLE_DOCS));
        value["summaryMarkdown"] = json!("");
        value["keyDecisions"] = json!([]);
        assert!(!MeetingNotes::from_meeting(&value).wants(SLACK));
    }

    #[test]
    fn a_successful_delivery_is_remembered_per_provider() {
        let mut value = meeting();
        assert!(!delivered_ok(&value, LINEAR));
        value["metadata"]["connectorDeliveries"] = json!({"linear": {"ok": true}});
        assert!(delivered_ok(&value, LINEAR));
        assert!(!delivered_ok(&value, ASANA));
    }
}
