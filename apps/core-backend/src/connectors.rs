use chrono::{TimeZone, Utc};
use reqwest::{Client, RequestBuilder};
use serde_json::{json, Map, Value};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};
use tokio::{
    sync::{broadcast, Mutex},
    time::Instant,
};

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
const ONE_CLICK_POLL: Duration = Duration::from_secs(2);
const ONE_CLICK_WINDOW: Duration = Duration::from_secs(10 * 60);
const ONE_CLICK_CACHE: Duration = Duration::from_secs(10 * 60);
const ONE_CLICK_RETRY: Duration = Duration::from_secs(60);
const REFRESH_MARGIN_MS: i64 = 60_000;
const DESTINATION_NAME: &str = "Kesami Meetings";
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
    pub destination: &'static [&'static str],
}

fn authorize_prefix(provider: &str) -> Option<&'static str> {
    Some(match provider {
        SLACK => "https://slack.com/oauth/v2/authorize?",
        NOTION => "https://api.notion.com/v1/oauth/authorize?",
        LINEAR => "https://linear.app/oauth/authorize?",
        JIRA => "https://auth.atlassian.com/authorize?",
        ASANA => "https://app.asana.com/-/oauth_authorize?",
        CLICKUP => "https://app.clickup.com/api?",
        _ => return None,
    })
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
        destination: &[],
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
        destination: &["parentPageId"],
    },
    Spec {
        id: GOOGLE_DOCS,
        label: "Google Docs",
        kind: "notes",
        help: "Sign in with Google. Each meeting becomes a Google Doc — notes plus the full transcript — in a “Kesami Meetings” folder in your Drive. Kesami can only see the files it creates.",
        fields: &[],
        oauth: Some(calendar::GOOGLE_DOCS),
        destination: &[],
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
        destination: &["teamKey"],
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
        destination: &["cloudId", "projectKey"],
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
        destination: &["projectId"],
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
        destination: &["listId"],
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

fn signed_in(config: &Map<String, Value>) -> Option<&Map<String, Value>> {
    config
        .get("oauth")
        .and_then(Value::as_object)
        .filter(|oauth| !text(oauth, "accessToken").is_empty())
}

pub fn is_connected(spec: &Spec, config: &Map<String, Value>) -> bool {
    if spec.oauth.is_some() {
        return false;
    }
    if signed_in(config).is_some() {
        return spec.destination.iter().all(|key| !text(config, key).is_empty());
    }
    spec.fields
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
        "account": oauth
            .and_then(|status| status.get("account").cloned())
            .or_else(|| signed_in(config).map(|tokens| json!(text(tokens, "account"))).filter(|account| account != ""))
            .unwrap_or(Value::Null),
        "signedIn": signed_in(config).is_some(),
        "autoPush": config.get("autoPush").and_then(Value::as_bool).unwrap_or(false),
        "config": out,
        "fields": spec.fields.iter().map(|field| json!({
            "key": field.key,
            "label": field.label,
            "secret": field.secret,
            "required": field.required,
            "placeholder": field.placeholder,
        })).collect::<Vec<_>>(),
        "destination": text(config, "destinationLabel"),
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
        if field.secret {
            next.remove("oauth");
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
    pub completed: bool,
    pub commitment: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DoneAction {
    pub label: String,
    pub title: String,
    pub url: Option<String>,
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
    pub commitments: Vec<ActionItem>,
    pub done_actions: Vec<DoneAction>,
    pub notes_url: Option<String>,
    pub transcript: Vec<TranscriptLine>,
}

const COMMITMENT_KINDS: [&str; 3] = ["explicit_commitment", "other_person_commitment", "suggested_action"];

fn normalized(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches('.')
        .to_lowercase()
}

fn meeting_commitments(meeting: &Value, tasks: &[ActionItem]) -> Vec<ActionItem> {
    let raw_tasks = meeting.get("actionItems").and_then(Value::as_array).cloned().unwrap_or_default();
    let task_ids: Vec<&str> = raw_tasks.iter().filter_map(|task| task["id"].as_str()).collect();
    let linked: Vec<&str> = raw_tasks.iter().filter_map(|task| task["commitmentId"].as_str()).collect();
    let mut seen: Vec<String> = tasks.iter().map(|task| normalized(&task.task)).collect();
    let mut out = Vec::new();
    for candidate in meeting
        .pointer("/metadata/meetingCommitments/candidates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let field = |key: &str| candidate[key].as_str().map(str::trim).filter(|value| !value.is_empty());
        if field("status") == Some("dismissed")
            || !field("classification").is_some_and(|kind| COMMITMENT_KINDS.contains(&kind))
            || field("actionItemId").is_some_and(|id| task_ids.contains(&id))
            || field("id").is_some_and(|id| linked.contains(&id))
        {
            continue;
        }
        let Some(action) = field("reviewedAction").or_else(|| field("targetAction")) else {
            continue;
        };
        let key = normalized(action);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let deadline = meaningful(field("dueDate"), &["TBD", "none", "n/a"]);
        out.push(ActionItem {
            task: action.to_string(),
            owner: meaningful(field("reviewedPerson").or_else(|| field("person")), &["Unknown", "Unassigned"]),
            due_date: deadline.clone().filter(|due| is_iso_date(due)),
            deadline,
            priority: None,
            completed: false,
            commitment: Some(field("commitment").unwrap_or(action).to_string()),
        });
    }
    out
}

fn meeting_done_actions(meeting: &Value) -> Vec<DoneAction> {
    meeting
        .pointer("/metadata/postMeetingActions/items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item["status"] == "succeeded")
        .filter_map(|item| {
            let title = item.pointer("/review/title").and_then(Value::as_str).unwrap_or_default().trim().to_string();
            let url = item.pointer("/result/url").and_then(Value::as_str).filter(|url| url.starts_with("https://")).map(str::to_string);
            let label = match item.pointer("/review/destination").and_then(Value::as_str)? {
                "google_calendar" => "Calendar event".to_string(),
                "jira" => match item.pointer("/result/key").and_then(Value::as_str) {
                    Some(key) => format!("Jira issue {key}"),
                    None => "Jira issue".to_string(),
                },
                "slack" => "Summary posted to Slack".to_string(),
                _ => return None,
            };
            Some(DoneAction { label, title, url })
        })
        .collect()
}

pub fn delivery_value(meeting: &crate::Meeting) -> Value {
    let mut value = serde_json::to_value(meeting).unwrap_or_else(|_| json!({}));
    if !crate::commitments::current(meeting) {
        if let Some(metadata) = value.get_mut("metadata").and_then(Value::as_object_mut) {
            metadata.remove("meetingCommitments");
        }
    }
    value
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
                let completed = item.get("completed").and_then(Value::as_bool).unwrap_or(false);
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
                    completed,
                    commitment: None,
                })
            })
            .filter(|item| !item.task.is_empty())
            .collect::<Vec<_>>();
        let commitments = meeting_commitments(meeting, &action_items);
        let notes_url = [NOTION, GOOGLE_DOCS].iter().find_map(|provider| {
            let delivery = meeting.pointer(&format!("/metadata/connectorDeliveries/{provider}"))?;
            (delivery["ok"] == json!(true)).then(|| delivery["url"].as_str().map(str::to_string)).flatten()
        });
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
            commitments,
            done_actions: meeting_done_actions(meeting),
            notes_url,
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
            || !self.commitments.is_empty()
            || !self.key_decisions.is_empty()
    }

    pub fn wants(&self, provider: &str) -> bool {
        match spec_for(provider).map(|spec| spec.kind) {
            Some("tasks") => !self.follow_ups().is_empty(),
            _ => self.has_content(),
        }
    }

    pub fn follow_ups(&self) -> Vec<&ActionItem> {
        self.action_items
            .iter()
            .filter(|item| !item.completed)
            .chain(self.commitments.iter())
            .collect()
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
        if let Some(said) = &item.commitment {
            lines.push(format!("Commitment made in the meeting: “{said}”"));
        }
        lines.push(format!(
            "From the meeting “{}” ({}).",
            self.title,
            self.meta_line()
        ));
        if let Some(url) = &self.notes_url {
            lines.push(format!("Meeting notes: {url}"));
        }
        let summary = first_paragraph(&self.summary_markdown);
        if !summary.is_empty() {
            lines.push(String::new());
            lines.push(format!("Summary: {summary}"));
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
        text.push_str("\n*Tasks*\n");
        for item in &notes.action_items {
            text.push_str(&format!("{} {}\n", if item.completed { "☑" } else { "☐" }, item_line(item)));
        }
    }
    if !notes.commitments.is_empty() {
        text.push_str("\n*Commitments*\n");
        for item in &notes.commitments {
            text.push_str(&format!("☐ {}\n", item_line(item)));
        }
    }
    if !notes.done_actions.is_empty() {
        text.push_str("\n*Done after the meeting*\n");
        for done in &notes.done_actions {
            let title = match &done.url {
                Some(url) => format!("<{url}|{}>", done.title.replace(['<', '>', '|'], " ")),
                None => done.title.clone(),
            };
            text.push_str(&format!("✓ {}: {title}\n", done.label));
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

fn notion_todo(content: &str, checked: bool) -> Value {
    json!({"object": "block", "type": "to_do", "to_do": {"rich_text": notion_text(content), "checked": checked}})
}

fn notion_link(label: &str, title: &str, url: Option<&str>) -> Value {
    let mut spans = vec![json!({"type": "text", "text": {"content": format!("{label}: ")}})];
    let mut text = json!({"content": truncate(title, NOTION_TEXT_LIMIT)});
    if let Some(url) = url {
        text["link"] = json!({"url": url});
    }
    spans.push(json!({"type": "text", "text": text}));
    json!({"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": spans}})
}

fn item_line(item: &ActionItem) -> String {
    let mut line = item.task.clone();
    if let Some(owner) = &item.owner {
        line.push_str(&format!(" — {owner}"));
    }
    if let Some(deadline) = &item.deadline {
        line.push_str(&format!(" (due {deadline})"));
    }
    line
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
        blocks.push(notion_block("heading_2", "Tasks"));
        for item in &notes.action_items {
            blocks.push(notion_todo(&item_line(item), item.completed));
        }
    }
    if !notes.commitments.is_empty() {
        blocks.push(notion_block("heading_2", "Commitments"));
        for item in &notes.commitments {
            blocks.push(notion_todo(&item_line(item), false));
        }
    }
    if !notes.done_actions.is_empty() {
        blocks.push(notion_block("heading_2", "Done after the meeting"));
        for done in &notes.done_actions {
            blocks.push(notion_link(&done.label, &done.title, done.url.as_deref()));
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

fn slack_grant_config(
    current: &Map<String, Value>,
    grant: &Value,
) -> Result<(Map<String, Value>, String), String> {
    let url = grant["webhookUrl"]
        .as_str()
        .map(str::trim)
        .filter(|url| valid_slack_webhook(url))
        .ok_or("Slack didn’t return a usable webhook. Try again.")?;
    let channel = grant["channel"].as_str().unwrap_or_default().trim();
    let workspace = grant["workspace"].as_str().unwrap_or_default().trim();
    let label = match (channel.is_empty(), workspace.is_empty()) {
        (false, false) => format!("{channel} · {workspace}"),
        (false, true) => channel.to_string(),
        (true, false) => workspace.to_string(),
        (true, true) => String::new(),
    };
    let next = merge_config(
        spec_for(SLACK).ok_or("unknown connector: slack")?,
        current,
        &json!({ "webhookUrl": url, "channelLabel": label }),
    )?;
    Ok((next, label))
}

fn oauth_grant_config(
    spec: &Spec,
    current: &Map<String, Value>,
    grant: &Value,
    now_ms: i64,
) -> Result<Map<String, Value>, String> {
    let present = |key: &str| grant[key].as_str().map(str::trim).filter(|value| !value.is_empty());
    let access = present("accessToken")
        .ok_or_else(|| format!("{} didn’t return an access token. Try again.", spec.label))?;
    let mut oauth = Map::new();
    oauth.insert("accessToken".into(), json!(access));
    for key in ["refreshToken", "account", "workspace"] {
        if let Some(value) = present(key) {
            oauth.insert(key.into(), json!(value));
        }
    }
    if let Some(seconds) = grant["expiresIn"].as_i64().filter(|seconds| *seconds > 0) {
        oauth.insert("expiresAt".into(), json!(now_ms + seconds * 1000));
    }
    let mut next = current.clone();
    for field in spec.fields.iter().filter(|field| field.secret) {
        next.remove(field.key);
    }
    next.insert("oauth".into(), Value::Object(oauth));
    Ok(next)
}

fn refreshed_oauth(oauth: &Map<String, Value>, tokens: &Value, now_ms: i64) -> Option<Map<String, Value>> {
    let access = tokens["accessToken"].as_str().map(str::trim).filter(|value| !value.is_empty())?;
    let mut next = oauth.clone();
    next.insert("accessToken".into(), json!(access));
    if let Some(refresh) = tokens["refreshToken"].as_str().map(str::trim).filter(|value| !value.is_empty()) {
        next.insert("refreshToken".into(), json!(refresh));
    }
    match tokens["expiresIn"].as_i64().filter(|seconds| *seconds > 0) {
        Some(seconds) => next.insert("expiresAt".into(), json!(now_ms + seconds * 1000)),
        None => next.remove("expiresAt"),
    };
    Some(next)
}

fn needs_refresh(oauth: &Map<String, Value>, now_ms: i64) -> bool {
    oauth
        .get("expiresAt")
        .and_then(Value::as_i64)
        .is_some_and(|expires_at| expires_at - REFRESH_MARGIN_MS <= now_ms)
}

fn setup_failure(spec: &Spec, error: &str) -> String {
    let what = if spec.kind == "tasks" { "tasks" } else { "notes" };
    format!("Signed in to {}, but Kesami couldn’t set up where to send {what}: {error}", spec.label)
}

fn disconnect_message(spec: &Spec, revoked: Option<bool>) -> String {
    match (spec.id, revoked) {
        (_, Some(true)) => format!("Disconnected and revoked Kesami’s access to {}.", spec.label),
        (SLACK, _) => "Disconnected. To stop the webhook entirely, remove the Kesami app from the channel’s Integrations in Slack.".into(),
        (JIRA, Some(false)) => "Disconnected. To remove Kesami’s access completely, open your Atlassian account settings → Connected apps.".into(),
        (CLICKUP, Some(false)) => "Disconnected. To remove Kesami’s access completely, remove it from your ClickUp workspace’s connected apps.".into(),
        (_, Some(false)) => format!(
            "Disconnected, but Kesami couldn’t revoke its access just now. Remove Kesami from {}’s connected apps to revoke it.",
            spec.label
        ),
        (_, None) => "Disconnected.".into(),
    }
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
    for (heading, items) in [("Tasks", &notes.action_items), ("Commitments", &notes.commitments)] {
        if items.is_empty() {
            continue;
        }
        body.push_str(&format!("<h2>{heading}</h2><ul>"));
        for item in items {
            let mut line = format!("{} {}", if item.completed { "☑" } else { "☐" }, escape_html(&item.task));
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
    if !notes.done_actions.is_empty() {
        body.push_str("<h2>Done after the meeting</h2><ul>");
        for done in &notes.done_actions {
            let title = match &done.url {
                Some(url) => format!("<a href=\"{}\">{}</a>", escape_html(url), escape_html(&done.title)),
                None => escape_html(&done.title),
            };
            body.push_str(&format!("<li>✓ {}: {title}</li>", escape_html(&done.label)));
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

#[derive(Clone)]
pub(crate) struct Endpoints {
    cloud: Option<String>,
    notion: String,
    linear: String,
    atlassian: String,
    asana: String,
    clickup: String,
    poll: Duration,
}

impl Endpoints {
    fn live() -> Self {
        Self {
            cloud: crate::supabase_auth::cloud_origin(),
            notion: "https://api.notion.com".into(),
            linear: "https://api.linear.app".into(),
            atlassian: "https://api.atlassian.com".into(),
            asana: "https://app.asana.com".into(),
            clickup: "https://api.clickup.com".into(),
            poll: ONE_CLICK_POLL,
        }
    }
}

pub struct ConnectorService {
    endpoints: Endpoints,
    http: Client,
    settings: Arc<SettingsStore>,
    calendar: Arc<CalendarService>,
    events: broadcast::Sender<String>,
    attempts: StdMutex<HashMap<&'static str, u64>>,
    one_click: Mutex<Option<(Instant, Vec<String>)>>,
    refreshing: Mutex<()>,
}

fn id_of(value: &Value) -> Option<String> {
    match value {
        Value::String(id) if !id.is_empty() => Some(id.clone()),
        Value::Number(id) => Some(id.to_string()),
        _ => None,
    }
}

impl ConnectorService {
    pub fn new(
        settings: Arc<SettingsStore>,
        calendar: Arc<CalendarService>,
        events: broadcast::Sender<String>,
    ) -> Self {
        Self::with_endpoints(settings, calendar, events, Endpoints::live())
    }

    fn with_endpoints(
        settings: Arc<SettingsStore>,
        calendar: Arc<CalendarService>,
        events: broadcast::Sender<String>,
        endpoints: Endpoints,
    ) -> Self {
        Self {
            endpoints,
            http: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            settings,
            calendar,
            events,
            attempts: StdMutex::default(),
            one_click: Mutex::new(None),
            refreshing: Mutex::new(()),
        }
    }

    async fn one_click_providers(&self) -> Vec<String> {
        let Some(origin) = self.endpoints.cloud.clone() else {
            return Vec::new();
        };
        let mut cached = self.one_click.lock().await;
        if let Some((until, providers)) = cached.as_ref() {
            if Instant::now() < *until {
                return providers.clone();
            }
        }
        let fetched = match self
            .http
            .get(format!("{origin}/v1/connectors"))
            .timeout(Duration::from_secs(4))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => response.json::<Value>().await.ok(),
            _ => None,
        };
        let (ttl, providers) = match fetched.as_ref().and_then(|body| body["providers"].as_array()) {
            Some(list) => (
                ONE_CLICK_CACHE,
                list.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>(),
            ),
            None => (ONE_CLICK_RETRY, Vec::new()),
        };
        *cached = Some((Instant::now() + ttl, providers.clone()));
        providers
    }

    fn present(
        &self,
        spec: &Spec,
        config: &Map<String, Value>,
        oauth: Option<&Value>,
        one_click: &[String],
    ) -> Value {
        let mut connector = public_config(spec, config, oauth);
        connector["oneClick"] = json!(spec.oauth.is_none() && one_click.iter().any(|id| id == spec.id));
        connector
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
        match spec.oauth {
            Some(oauth) => self.calendar.begin(oauth).await,
            None => self.begin_one_click(spec).await,
        }
    }

    fn next_attempt(&self, provider: &'static str) -> u64 {
        let mut attempts = self.attempts.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let attempt = attempts.entry(provider).or_default();
        *attempt += 1;
        *attempt
    }

    fn current_attempt(&self, provider: &str) -> u64 {
        let attempts = self.attempts.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        attempts.get(provider).copied().unwrap_or_default()
    }

    async fn begin_one_click(self: &Arc<Self>, spec: &'static Spec) -> Result<Value, String> {
        let paste = if spec.id == SLACK { "Paste a webhook URL instead." } else { "Paste a token instead." };
        let origin = self
            .endpoints
            .cloud
            .clone()
            .ok_or_else(|| format!("One-click {} needs the Kesami cloud. {paste}", spec.label))?;
        let started = self
            .http
            .post(format!("{origin}/v1/connectors/{}/start", spec.id))
            .send()
            .await
            .map_err(|_| {
                format!(
                    "Couldn’t reach Kesami to start {} sign-in. Check your connection and try again.",
                    spec.label
                )
            })?;
        let ok = started.status().is_success();
        let body: Value = started.json().await.unwrap_or(Value::Null);
        if !ok {
            return Err(body["error"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("{} sign-in is unavailable right now. {paste}", spec.label)));
        }
        let prefix = authorize_prefix(spec.id).unwrap_or("https://");
        let auth_url = body["authUrl"].as_str().filter(|url| url.starts_with(prefix));
        let ticket = body["ticket"].as_str().filter(|ticket| !ticket.is_empty());
        let (Some(auth_url), Some(ticket)) = (auth_url, ticket) else {
            return Err("Kesami sent an unexpected sign-in response. Try again.".into());
        };
        let service = Arc::clone(self);
        let claim = format!("{origin}/v1/connectors/{}/claim", spec.id);
        let ticket = ticket.to_string();
        let attempt = self.next_attempt(spec.id);
        tokio::spawn(async move {
            let data = match service.await_grant(spec, &claim, &ticket).await {
                Ok(account) => json!({ "provider": spec.id, "connected": true, "account": account }),
                Err(_) if service.current_attempt(spec.id) != attempt => return,
                Err(error) => json!({ "provider": spec.id, "connected": false, "error": error }),
            };
            let _ = service.events.send(
                json!({
                    "type": "connector_connection",
                    "data": data,
                    "timestamp": Utc::now().timestamp_millis(),
                })
                .to_string(),
            );
        });
        Ok(json!({ "authUrl": auth_url, "provider": spec.id }))
    }

    async fn await_grant(&self, spec: &'static Spec, claim: &str, ticket: &str) -> Result<Option<String>, String> {
        let deadline = Instant::now() + ONE_CLICK_WINDOW;
        while Instant::now() < deadline {
            tokio::time::sleep(self.endpoints.poll).await;
            let Ok(response) = self.http.post(claim).json(&json!({ "ticket": ticket })).send().await else {
                continue;
            };
            let status = response.status();
            if status == reqwest::StatusCode::ACCEPTED || status.is_server_error() {
                continue;
            }
            let body: Value = response.json().await.unwrap_or(Value::Null);
            if !status.is_success() {
                return Err(body["error"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("{} didn’t finish connecting. Try again.", spec.label)));
            }
            return self.adopt_grant(spec, &body).await;
        }
        Err(format!("{} sign-in timed out. Try again.", spec.label))
    }

    async fn adopt_grant(&self, spec: &'static Spec, grant: &Value) -> Result<Option<String>, String> {
        if spec.id == SLACK {
            let (next, label) = slack_grant_config(&self.config(SLACK).await, grant)?;
            self.store_config(SLACK, &next).await?;
            return Ok(Some(label).filter(|label| !label.is_empty()));
        }
        let mut config =
            oauth_grant_config(spec, &self.config(spec.id).await, grant, Utc::now().timestamp_millis())?;
        self.store_config(spec.id, &config).await?;
        let setup = self.setup_destination(spec, &mut config).await;
        if signed_in(&config).is_some_and(|oauth| text(oauth, "account").is_empty()) {
            self.identify(spec, &mut config).await;
        }
        self.store_config(spec.id, &config).await?;
        setup.map_err(|error| setup_failure(spec, &error))?;
        Ok(signed_in(&config).map(|oauth| text(oauth, "account")).filter(|account| !account.is_empty()))
    }

    async fn identify(&self, spec: &Spec, config: &mut Map<String, Value>) {
        let account = match spec.id {
            LINEAR => self
                .linear(config, "query { viewer { name email } }", json!({}))
                .await
                .ok()
                .and_then(|data| {
                    data.pointer("/viewer/email")
                        .or_else(|| data.pointer("/viewer/name"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                }),
            CLICKUP => self
                .authed_call(spec, config, "ClickUp", |auth| {
                    self.http.get(format!("{}/api/v2/user", self.endpoints.clickup)).header("Authorization", auth)
                })
                .await
                .ok()
                .and_then(|body| {
                    body.pointer("/user/email")
                        .or_else(|| body.pointer("/user/username"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                }),
            JIRA if !text(config, "cloudId").is_empty() => {
                let base = self.jira_base(config);
                self.authed_call(spec, config, "Jira", |auth| {
                    self.jira(self.http.get(format!("{base}/rest/api/3/myself")), auth)
                })
                .await
                .ok()
                .and_then(|me| {
                    me.get("emailAddress")
                        .or_else(|| me.get("displayName"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
            }
            _ => None,
        };
        let Some(account) = account.filter(|account| !account.trim().is_empty()) else {
            return;
        };
        if let Some(oauth) = config.get_mut("oauth").and_then(Value::as_object_mut) {
            oauth.insert("account".into(), json!(account.trim()));
        }
    }

    async fn refresh(&self, spec: &Spec, config: &mut Map<String, Value>) -> Result<(), String> {
        let reconnect = format!("Sign in to {} again in Settings → Connectors.", spec.label);
        let _renewing = self.refreshing.lock().await;
        let now = Utc::now().timestamp_millis();
        let before = signed_in(config).map(|oauth| text(oauth, "accessToken"));
        let stored = self.config(spec.id).await;
        if let Some(latest) = signed_in(&stored) {
            if Some(text(latest, "accessToken")) != before && !needs_refresh(latest, now) {
                config.insert("oauth".into(), Value::Object(latest.clone()));
                return Ok(());
            }
        }
        let oauth = signed_in(config).cloned().ok_or_else(|| reconnect.clone())?;
        let refresh_token = text(&oauth, "refreshToken");
        let origin = self.endpoints.cloud.clone().filter(|_| !refresh_token.is_empty());
        let Some(origin) = origin else {
            return Err(format!("{}: {reconnect}", spec.label));
        };
        let response = self
            .http
            .post(format!("{origin}/v1/connectors/{}/refresh", spec.id))
            .json(&json!({ "refreshToken": refresh_token }))
            .send()
            .await
            .map_err(|_| format!("{}: couldn’t reach Kesami to renew the sign-in. Try again.", spec.label))?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        let renewed = refreshed_oauth(&oauth, &body, now).filter(|_| status.is_success());
        let Some(renewed) = renewed else {
            let fallback = if status == reqwest::StatusCode::UNAUTHORIZED {
                reconnect.as_str()
            } else {
                "couldn’t renew the sign-in. Try again."
            };
            return Err(format!("{}: {}", spec.label, body["error"].as_str().unwrap_or(fallback)));
        };
        config.insert("oauth".into(), Value::Object(renewed.clone()));
        let mut latest = self.config(spec.id).await;
        if signed_in(&latest).is_some() {
            latest.insert("oauth".into(), Value::Object(renewed));
            self.store_config(spec.id, &latest).await?;
        }
        Ok(())
    }

    async fn authorization(
        &self,
        spec: &Spec,
        config: &mut Map<String, Value>,
        renew: bool,
    ) -> Result<String, String> {
        let stale = match signed_in(config) {
            Some(oauth) => renew || needs_refresh(oauth, Utc::now().timestamp_millis()),
            None => {
                return Ok(match spec.id {
                    NOTION | ASANA => format!("Bearer {}", text(config, "token")),
                    LINEAR => text(config, "apiKey"),
                    CLICKUP => text(config, "token"),
                    JIRA => format!(
                        "Basic {}",
                        BASE64.encode(format!("{}:{}", text(config, "email"), text(config, "apiToken")))
                    ),
                    _ => String::new(),
                })
            }
        };
        if stale {
            self.refresh(spec, config).await?;
        }
        Ok(format!(
            "Bearer {}",
            signed_in(config).map(|oauth| text(oauth, "accessToken")).unwrap_or_default()
        ))
    }

    async fn authed(
        &self,
        spec: &Spec,
        config: &mut Map<String, Value>,
        what: &str,
        build: impl Fn(&str) -> RequestBuilder,
    ) -> Result<(reqwest::StatusCode, Value, String), String> {
        let auth = self.authorization(spec, config, false).await?;
        let first = self.exchange(build(&auth), what).await?;
        let renewable = signed_in(config).is_some_and(|oauth| !text(oauth, "refreshToken").is_empty());
        if first.0 != reqwest::StatusCode::UNAUTHORIZED || !renewable {
            return Ok(first);
        }
        let auth = self.authorization(spec, config, true).await?;
        self.exchange(build(&auth), what).await
    }

    async fn authed_call(
        &self,
        spec: &Spec,
        config: &mut Map<String, Value>,
        what: &str,
        build: impl Fn(&str) -> RequestBuilder,
    ) -> Result<Value, String> {
        let (status, body, raw) = self.authed(spec, config, what, build).await?;
        if !status.is_success() {
            return Err(format!("{what}: {}", error_detail(status, &body, &raw)));
        }
        Ok(if body.is_null() { Value::String(raw) } else { body })
    }

    async fn jira_sites(&self, config: &mut Map<String, Value>) -> Result<Vec<Value>, String> {
        let spec = spec_for(JIRA).ok_or("unknown connector: jira")?;
        let api = self.endpoints.atlassian.clone();
        let body = self
            .authed_call(spec, config, "Jira", |auth| {
                self.jira(self.http.get(format!("{api}/oauth/token/accessible-resources")), auth)
            })
            .await?;
        let mut seen = std::collections::HashSet::new();
        Ok(body
            .as_array()
            .into_iter()
            .flatten()
            .filter(|site| {
                site["scopes"]
                    .as_array()
                    .is_some_and(|scopes| scopes.iter().any(|scope| scope.as_str().is_some_and(|scope| scope.ends_with(":jira-work"))))
            })
            .filter(|site| seen.insert(site["id"].as_str().unwrap_or_default().to_string()))
            .cloned()
            .collect())
    }

    async fn setup_destination(&self, spec: &Spec, config: &mut Map<String, Value>) -> Result<(), String> {
        match spec.id {
            NOTION => self.setup_notion(spec, config).await,
            LINEAR => self.setup_linear(config).await,
            JIRA => self.setup_jira(spec, config).await,
            ASANA => self.setup_asana(spec, config).await,
            CLICKUP => self.setup_clickup(spec, config).await,
            _ => Ok(()),
        }
    }

    async fn setup_notion(&self, spec: &Spec, config: &mut Map<String, Value>) -> Result<(), String> {
        let api = self.endpoints.notion.clone();
        if let Some(page) = notion_page_id(&text(config, "parentPageId")) {
            let existing = self
                .authed_call(spec, config, "Notion", |auth| {
                    self.notion(self.http.get(format!("{api}/v1/pages/{page}")), auth)
                })
                .await;
            if existing.is_ok_and(|page| page["archived"] != json!(true) && page["in_trash"] != json!(true)) {
                return Ok(());
            }
        }
        let title = json!({"title": [{"type": "text", "text": {"content": DESTINATION_NAME}}]});
        let private = json!({"parent": {"type": "workspace", "workspace": true}, "properties": {"title": title}});
        let created = match self
            .authed_call(spec, config, "Notion", |auth| {
                self.notion(self.http.post(format!("{api}/v1/pages")), auth).json(&private)
            })
            .await
        {
            Ok(page) => page,
            Err(_) => {
                let search = json!({
                    "filter": {"property": "object", "value": "page"},
                    "sort": {"timestamp": "last_edited_time", "direction": "descending"},
                    "page_size": 1
                });
                let shared = self
                    .authed_call(spec, config, "Notion", |auth| {
                        self.notion(self.http.post(format!("{api}/v1/search")), auth).json(&search)
                    })
                    .await?;
                let parent = shared
                    .pointer("/results/0/id")
                    .and_then(Value::as_str)
                    .ok_or("share at least one page with Kesami when you sign in to Notion")?
                    .to_string();
                let nested = json!({"parent": {"page_id": parent}, "properties": {"title": title}});
                self.authed_call(spec, config, "Notion", |auth| {
                    self.notion(self.http.post(format!("{api}/v1/pages")), auth).json(&nested)
                })
                .await?
            }
        };
        let id = created["id"].as_str().ok_or("Notion created the page without an id")?;
        config.insert("parentPageId".into(), json!(id));
        config.insert("destinationLabel".into(), json!(DESTINATION_NAME));
        Ok(())
    }

    async fn setup_linear(&self, config: &mut Map<String, Value>) -> Result<(), String> {
        let data = self
            .linear(
                config,
                "query { viewer { teams(first: 50) { nodes { id key name } } } teams(first: 50) { nodes { id key name } } }",
                json!({}),
            )
            .await?;
        let teams: Vec<Value> = [data.pointer("/viewer/teams/nodes"), data.pointer("/teams/nodes")]
            .into_iter()
            .flatten()
            .filter_map(Value::as_array)
            .flatten()
            .cloned()
            .collect();
        let known = text(config, "teamKey");
        let team = teams
            .iter()
            .find(|team| !known.is_empty() && team["key"] == json!(known))
            .or_else(|| teams.first())
            .ok_or("this Linear account can’t see any teams")?;
        let key = team["key"].as_str().ok_or("Linear returned a team without a key")?;
        config.insert("teamKey".into(), json!(key));
        config.insert(
            "destinationLabel".into(),
            json!(format!("{} ({key})", team["name"].as_str().unwrap_or(key))),
        );
        Ok(())
    }

    async fn setup_jira(&self, spec: &Spec, config: &mut Map<String, Value>) -> Result<(), String> {
        let sites = self.jira_sites(config).await?;
        let known = text(config, "cloudId");
        let site = sites
            .iter()
            .find(|site| site["id"] == json!(known))
            .or_else(|| sites.first())
            .ok_or("this Atlassian account has no Jira sites")?
            .clone();
        let cloud = site["id"].as_str().unwrap_or_default();
        if cloud != known {
            config.remove("projectKey");
            config.remove("issueType");
        }
        config.insert("cloudId".into(), json!(cloud));
        if let Some(url) = site["url"].as_str().filter(|url| url.starts_with("https://")) {
            config.insert("siteUrl".into(), json!(url.trim_end_matches('/')));
        }
        let site_name = site["name"].as_str().unwrap_or("Jira").to_string();
        let base = self.jira_base(config);
        let valid_key = |key: &str| !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        let known_project = text(config, "projectKey");
        let mut project = Value::Null;
        if valid_key(&known_project) {
            project = self
                .authed_call(spec, config, "Jira", |auth| {
                    self.jira(self.http.get(format!("{base}/rest/api/3/project/{known_project}")), auth)
                })
                .await
                .unwrap_or(Value::Null);
        }
        if project["key"].as_str().is_none() {
            let found = self
                .authed_call(spec, config, "Jira", |auth| {
                    self.jira(
                        self.http.get(format!(
                            "{base}/rest/api/3/project/search?action=create&orderBy=-lastIssueUpdatedTime&maxResults=1"
                        )),
                        auth,
                    )
                })
                .await?;
            project = found.pointer("/values/0").cloned().unwrap_or(Value::Null);
        }
        let key = project["key"]
            .as_str()
            .filter(|key| valid_key(key))
            .ok_or_else(|| format!("you can’t create issues in any project on {site_name}"))?
            .to_string();
        let types = self
            .authed_call(spec, config, "Jira", |auth| {
                self.jira(
                    self.http.get(format!("{base}/rest/api/3/issue/createmeta/{key}/issuetypes?maxResults=200")),
                    auth,
                )
            })
            .await
            .unwrap_or(Value::Null);
        let names: Vec<&str> = types["issueTypes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|kind| kind["subtask"] != json!(true))
            .filter_map(|kind| kind["name"].as_str())
            .collect();
        let kind = names
            .iter()
            .find(|name| name.eq_ignore_ascii_case("Task"))
            .or_else(|| names.first())
            .copied()
            .unwrap_or("Task");
        config.insert("projectKey".into(), json!(key));
        config.insert("issueType".into(), json!(kind));
        config.insert(
            "destinationLabel".into(),
            json!(format!("{} ({key}) · {site_name}", project["name"].as_str().unwrap_or(&key))),
        );
        Ok(())
    }

    async fn setup_asana(&self, spec: &Spec, config: &mut Map<String, Value>) -> Result<(), String> {
        let api = format!("{}/api/1.0", self.endpoints.asana);
        if let Some(project) = asana_project_id(&text(config, "projectId")) {
            let existing = self
                .authed_call(spec, config, "Asana", |auth| {
                    self.http
                        .get(format!("{api}/projects/{project}?opt_fields=name,archived"))
                        .header("Authorization", auth)
                })
                .await;
            if existing.is_ok_and(|body| body.pointer("/data/archived") != Some(&json!(true))) {
                return Ok(());
            }
        }
        let me = self
            .authed_call(spec, config, "Asana", |auth| {
                self.http
                    .get(format!("{api}/users/me?opt_fields=workspaces.name,workspaces.is_organization"))
                    .header("Authorization", auth)
            })
            .await?;
        let workspace = me
            .pointer("/data/workspaces/0")
            .cloned()
            .ok_or("this Asana account has no workspaces")?;
        let workspace_id = workspace["gid"]
            .as_str()
            .filter(|gid| gid.chars().all(|c| c.is_ascii_digit()))
            .ok_or("Asana returned a workspace without an id")?
            .to_string();
        let workspace_name = workspace["name"].as_str().unwrap_or("Asana").to_string();
        let existing = self
            .authed_call(spec, config, "Asana", |auth| {
                self.http
                    .get(format!("{api}/workspaces/{workspace_id}/projects?archived=false&limit=100&opt_fields=name"))
                    .header("Authorization", auth)
            })
            .await
            .unwrap_or(Value::Null);
        let reused = existing["data"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|project| project["name"] == json!(DESTINATION_NAME))
            .and_then(|project| project["gid"].as_str())
            .map(str::to_string);
        let project = match reused {
            Some(project) => project,
            None => {
                let target = if workspace["is_organization"] == json!(true) {
                    let teams = self
                        .authed_call(spec, config, "Asana", |auth| {
                            self.http
                                .get(format!("{api}/users/me/teams?organization={workspace_id}&opt_fields=name"))
                                .header("Authorization", auth)
                        })
                        .await?;
                    let team = teams
                        .pointer("/data/0/gid")
                        .and_then(Value::as_str)
                        .filter(|gid| gid.chars().all(|c| c.is_ascii_digit()))
                        .ok_or_else(|| format!("join a team in {workspace_name} so Kesami can create its project"))?
                        .to_string();
                    format!("{api}/teams/{team}/projects")
                } else {
                    format!("{api}/workspaces/{workspace_id}/projects")
                };
                let body = json!({"data": {"name": DESTINATION_NAME, "notes": "Tasks and commitments from your meetings, created by Kesami."}});
                let created = self
                    .authed_call(spec, config, "Asana", |auth| {
                        self.http.post(&target).header("Authorization", auth).json(&body)
                    })
                    .await?;
                created
                    .pointer("/data/gid")
                    .and_then(Value::as_str)
                    .ok_or("Asana created the project without an id")?
                    .to_string()
            }
        };
        config.insert("projectId".into(), json!(project));
        config.insert("destinationLabel".into(), json!(format!("{DESTINATION_NAME} · {workspace_name}")));
        Ok(())
    }

    async fn setup_clickup(&self, spec: &Spec, config: &mut Map<String, Value>) -> Result<(), String> {
        let api = format!("{}/api/v2", self.endpoints.clickup);
        if let Some(list) = clickup_list_id(&text(config, "listId")) {
            let existing = self
                .authed_call(spec, config, "ClickUp", |auth| {
                    self.http.get(format!("{api}/list/{list}")).header("Authorization", auth)
                })
                .await;
            if existing.is_ok_and(|list| list["archived"] != json!(true)) {
                return Ok(());
            }
        }
        let teams = self
            .authed_call(spec, config, "ClickUp", |auth| self.http.get(format!("{api}/team")).header("Authorization", auth))
            .await?;
        let team = teams
            .pointer("/teams/0/id")
            .and_then(id_of)
            .ok_or("this ClickUp account has no workspaces")?;
        let spaces = self
            .authed_call(spec, config, "ClickUp", |auth| {
                self.http.get(format!("{api}/team/{team}/space?archived=false")).header("Authorization", auth)
            })
            .await?;
        let space = spaces.pointer("/spaces/0").cloned().ok_or("create a Space in ClickUp first")?;
        let space_id = id_of(&space["id"]).ok_or("ClickUp returned a Space without an id")?;
        let space_name = space["name"].as_str().unwrap_or("ClickUp").to_string();
        let lists = self
            .authed_call(spec, config, "ClickUp", |auth| {
                self.http.get(format!("{api}/space/{space_id}/list?archived=false")).header("Authorization", auth)
            })
            .await
            .unwrap_or(Value::Null);
        let reused = lists["lists"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|list| list["name"] == json!(DESTINATION_NAME))
            .and_then(|list| id_of(&list["id"]));
        let list = match reused {
            Some(list) => list,
            None => {
                let body = json!({"name": DESTINATION_NAME, "content": "Tasks and commitments from your meetings, created by Kesami."});
                let created = self
                    .authed_call(spec, config, "ClickUp", |auth| {
                        self.http
                            .post(format!("{api}/space/{space_id}/list"))
                            .header("Authorization", auth)
                            .json(&body)
                    })
                    .await?;
                id_of(&created["id"]).ok_or("ClickUp created the list without an id")?
            }
        };
        config.insert("listId".into(), json!(list));
        config.insert("destinationLabel".into(), json!(format!("{DESTINATION_NAME} · {space_name}")));
        Ok(())
    }

    pub async fn setup(&self, provider: &str) -> Result<Value, String> {
        let spec = spec_for(provider).ok_or_else(|| format!("unknown connector: {provider}"))?;
        let mut config = self.config(provider).await;
        if signed_in(&config).is_none() {
            return Err(format!("Sign in to {} first.", spec.label));
        }
        let outcome = self.setup_destination(spec, &mut config).await;
        if signed_in(&config).is_some_and(|oauth| text(oauth, "account").is_empty()) {
            self.identify(spec, &mut config).await;
        }
        self.store_config(provider, &config).await?;
        outcome.map_err(|error| setup_failure(spec, &error))?;
        let oauth = self.oauth_status(spec).await;
        Ok(self.present(spec, &config, oauth.as_ref(), &self.one_click_providers().await))
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
        let one_click = self.one_click_providers().await;
        let mut providers = Vec::new();
        for spec in SPECS.iter() {
            let oauth = self.oauth_status(spec).await;
            providers.push(self.present(spec, &self.config(spec.id).await, oauth.as_ref(), &one_click));
        }
        json!({ "providers": providers })
    }

    pub async fn save(&self, provider: &str, incoming: &Value) -> Result<Value, String> {
        let spec = spec_for(provider).ok_or_else(|| format!("unknown connector: {provider}"))?;
        let next = merge_config(spec, &self.config(provider).await, incoming)?;
        self.store_config(provider, &next).await?;
        let oauth = self.oauth_status(spec).await;
        Ok(self.present(spec, &next, oauth.as_ref(), &self.one_click_providers().await))
    }

    pub async fn disconnect(&self, provider: &str) -> Result<String, String> {
        let spec = spec_for(provider).ok_or_else(|| format!("unknown connector: {provider}"))?;
        if let Some(oauth) = spec.oauth {
            self.calendar.disconnect(oauth).await?;
        }
        let config = self.config(provider).await;
        let revoked = match signed_in(&config) {
            Some(oauth) => Some(self.revoke(spec, oauth).await),
            None => None,
        };
        self.settings
            .set_credential(&credential_key(provider), None)
            .await
            .map_err(|error| error.to_string())?;
        Ok(disconnect_message(spec, revoked))
    }

    async fn revoke(&self, spec: &Spec, oauth: &Map<String, Value>) -> bool {
        let Some(origin) = self.endpoints.cloud.clone() else {
            return false;
        };
        let tokens = json!({
            "accessToken": text(oauth, "accessToken"),
            "refreshToken": text(oauth, "refreshToken"),
        });
        let Ok(response) = self
            .http
            .post(format!("{origin}/v1/connectors/{}/revoke", spec.id))
            .timeout(Duration::from_secs(10))
            .json(&tokens)
            .send()
            .await
        else {
            return false;
        };
        response.status().is_success()
            && response.json::<Value>().await.is_ok_and(|body| body["revoked"] == json!(true))
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

    fn notion(&self, request: RequestBuilder, auth: &str) -> RequestBuilder {
        request
            .header("Authorization", auth)
            .header("Notion-Version", NOTION_VERSION)
    }

    fn jira(&self, request: RequestBuilder, auth: &str) -> RequestBuilder {
        request
            .header("Authorization", auth)
            .header("Accept", "application/json")
    }

    fn jira_base(&self, config: &Map<String, Value>) -> String {
        if signed_in(config).is_some() {
            return format!("{}/ex/jira/{}", self.endpoints.atlassian, text(config, "cloudId"));
        }
        Self::jira_browse(config)
    }

    fn jira_browse(config: &Map<String, Value>) -> String {
        text(config, "siteUrl").trim_end_matches('/').to_string()
    }

    fn jira_link(config: &Map<String, Value>, key: &str) -> Option<String> {
        let browse = Self::jira_browse(config);
        (!browse.is_empty()).then(|| format!("{browse}/browse/{key}"))
    }

    async fn create_jira_issue(
        &self,
        spec: &Spec,
        config: &mut Map<String, Value>,
        notes: &MeetingNotes,
        item: &ActionItem,
        labelled: &mut bool,
    ) -> Result<(Option<String>, Option<String>), String> {
        let base = self.jira_base(config);
        loop {
            let issue = jira_issue(
                notes,
                item,
                &text(config, "projectKey"),
                &text(config, "issueType"),
                *labelled,
            );
            let (status, body, raw) = self
                .authed(spec, config, "Jira", |auth| {
                    self.jira(self.http.post(format!("{base}/rest/api/3/issue")), auth)
                        .json(&issue)
                })
                .await?;
            if status.is_success() {
                let key = body.get("key").and_then(Value::as_str).map(str::to_string);
                let url = key.as_deref().and_then(|key| Self::jira_link(config, key));
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
        config: &mut Map<String, Value>,
        query: &str,
        variables: Value,
    ) -> Result<Value, String> {
        let spec = spec_for(LINEAR).ok_or("unknown connector: linear")?;
        let request = json!({"query": query, "variables": variables});
        let body = self
            .authed_call(spec, config, "Linear", |auth| {
                self.http
                    .post(format!("{}/graphql", self.endpoints.linear))
                    .header("Authorization", auth)
                    .json(&request)
            })
            .await?;
        if let Some(message) = body.pointer("/errors/0/message").and_then(Value::as_str) {
            return Err(format!("Linear: {message}"));
        }
        Ok(body.get("data").cloned().unwrap_or(Value::Null))
    }

    async fn linear_team_id(&self, config: &mut Map<String, Value>) -> Result<String, String> {
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
        let (spec, mut config) = self.connected_config(provider).await?;
        let config = &mut config;
        match spec.id {
            SLACK => {
                self.call(
                    self.http.post(text(config, "webhookUrl")).json(
                        &json!({"text": "Kesami is connected. Meeting notes will be posted here."}),
                    ),
                    "Slack",
                )
                .await?;
                Ok("Posted a test message to the channel.".into())
            }
            NOTION => {
                let page = notion_page_id(&text(config, "parentPageId")).unwrap_or_default();
                self.authed_call(spec, config, "Notion", |auth| {
                    self.notion(self.http.get(format!("{}/v1/pages/{page}", self.endpoints.notion)), auth)
                })
                .await?;
                Ok("Kesami can write under that page.".into())
            }
            LINEAR => {
                self.linear_team_id(config).await?;
                Ok(format!("Found team {}.", text(config, "teamKey")))
            }
            JIRA => {
                let project = text(config, "projectKey");
                let base = self.jira_base(config);
                let body = self
                    .authed_call(spec, config, "Jira", |auth| {
                        self.jira(self.http.get(format!("{base}/rest/api/3/project/{project}")), auth)
                    })
                    .await?;
                Ok(format!(
                    "Found project {}.",
                    body.get("name").and_then(Value::as_str).unwrap_or(&project)
                ))
            }
            ASANA => {
                let project = asana_project_id(&text(config, "projectId")).unwrap_or_default();
                let body = self
                    .authed_call(spec, config, "Asana", |auth| {
                        self.http
                            .get(format!("{}/api/1.0/projects/{project}", self.endpoints.asana))
                            .header("Authorization", auth)
                    })
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
                let list = clickup_list_id(&text(config, "listId")).unwrap_or_default();
                let body = self
                    .authed_call(spec, config, "ClickUp", |auth| {
                        self.http
                            .get(format!("{}/api/v2/list/{list}", self.endpoints.clickup))
                            .header("Authorization", auth)
                    })
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
        let (spec, mut config) = self.connected_config(JIRA).await.map_err(|_| {
            ActionError::permission(
                "Connect Jira in Settings → Connectors, then review and confirm again.",
            )
        })?;
        if jira_target(&config)["revision"] != expected_target {
            return Err(ActionError { code:"destination_changed".into(),message:"The Jira destination changed. Reload actions and review the updated destination.".into(),retryable:true,uncertain:false });
        }
        let body = reviewed_jira_body(&config, title, description);
        let auth = self
            .authorization(spec, &mut config, false)
            .await
            .map_err(|message| ActionError::permission(&message))?;
        let created = crate::action_providers::dispatch(
            self.jira(
                self.http
                    .post(format!("{}/rest/api/3/issue", self.jira_base(&config))),
                &auth,
            )
            .json(&body),
        )
        .await?;
        let key = created["key"]
            .as_str()
            .filter(|key| !key.is_empty())
            .ok_or_else(ActionError::uncertain)?;
        Ok(
            json!({"id":created["id"],"key":key,"url":Self::jira_link(&config, key)}),
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
                let created = notion_page(notes, &page);
                let body = self
                    .authed_call(spec, &mut config, "Notion", |auth| {
                        self.notion(self.http.post(format!("{}/v1/pages", self.endpoints.notion)), auth)
                            .json(&created)
                    })
                    .await?;
                let url = body.get("url").and_then(Value::as_str).map(str::to_string);
                Ok((vec![json!({"title": notes.title, "url": url})], url))
            }
            LINEAR | JIRA | ASANA | CLICKUP => self.deliver_tasks(spec, &mut config, notes).await,
            _ => Err(format!("unknown connector: {provider}")),
        }
    }

    async fn deliver_tasks(
        &self,
        spec: &Spec,
        config: &mut Map<String, Value>,
        notes: &MeetingNotes,
    ) -> Result<(Vec<Value>, Option<String>), String> {
        let follow_ups = notes.follow_ups();
        if follow_ups.is_empty() {
            return Err("This meeting has no open tasks or commitments to create.".into());
        }
        let linear_team = if spec.id == LINEAR {
            Some(self.linear_team_id(config).await?)
        } else {
            None
        };
        let mut jira_labelled = true;
        let mut created = Vec::new();
        let mut failures = Vec::new();
        for item in follow_ups.iter().copied() {
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
                    self.create_jira_issue(spec, config, notes, item, &mut jira_labelled)
                        .await
                }
                CLICKUP => {
                    let list = clickup_list_id(&text(config, "listId")).unwrap_or_default();
                    let task = clickup_task(notes, item);
                    self.authed_call(spec, config, "ClickUp", |auth| {
                        self.http
                            .post(format!("{}/api/v2/list/{list}/task", self.endpoints.clickup))
                            .header("Authorization", auth)
                            .json(&task)
                    })
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
                    let task = asana_task(notes, item, &project);
                    self.authed_call(spec, config, "Asana", |auth| {
                        self.http
                            .post(format!("{}/api/1.0/tasks", self.endpoints.asana))
                            .header("Authorization", auth)
                            .json(&task)
                    })
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
                "created {} of {} items; {}",
                created.len(),
                follow_ups.len(),
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

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn signed_in_connectors_need_a_destination_and_never_expose_tokens() {
        let notion = spec_for(NOTION).unwrap();
        let mut config = object(json!({"oauth": {"accessToken": "secret-access", "refreshToken": "secret-refresh", "account": "riyam@example.com"}}));
        assert!(!is_connected(notion, &config));
        config.insert("parentPageId".into(), json!("0123456789abcdef0123456789abcdef"));
        config.insert("destinationLabel".into(), json!("Kesami Meetings"));
        assert!(is_connected(notion, &config));

        let public = public_config(notion, &config, None);
        assert_eq!(public["signedIn"], true);
        assert_eq!(public["account"], "riyam@example.com");
        assert_eq!(public["destination"], "Kesami Meetings");
        assert!(!public.to_string().contains("secret-"));
        assert_eq!(public["config"]["tokenSet"], false);

        let jira = spec_for(JIRA).unwrap();
        let mut config = object(json!({"oauth": {"accessToken": "a"}, "cloudId": "site-1"}));
        assert!(!is_connected(jira, &config), "a site alone is not a destination");
        config.insert("projectKey".into(), json!("OPS"));
        assert!(is_connected(jira, &config), "issue type is optional and email/token are not needed");
        assert!(!is_connected(jira, &object(json!({"oauth": {"accessToken": ""}, "cloudId": "site-1", "projectKey": "OPS"}))));
    }

    #[test]
    fn a_sign_in_replaces_pasted_secrets_and_a_pasted_token_replaces_the_sign_in() {
        let asana = spec_for(ASANA).unwrap();
        let current = object(json!({"token": "pasted-pat", "projectId": "1200", "autoPush": false}));
        let grant = json!({"accessToken": "access", "refreshToken": "refresh", "expiresIn": 3600, "account": "riyam@example.com"});
        let next = oauth_grant_config(asana, &current, &grant, 1_000).unwrap();
        assert!(next.get("token").is_none());
        assert_eq!(next["projectId"], "1200");
        assert_eq!(next["oauth"], json!({"accessToken": "access", "refreshToken": "refresh", "account": "riyam@example.com", "expiresAt": 3_601_000}));
        assert!(oauth_grant_config(asana, &current, &json!({"refreshToken": "r"}), 0).is_err());

        let pasted = merge_config(asana, &next, &json!({"token": "new-pat"})).unwrap();
        assert!(pasted.get("oauth").is_none());
        let kept = merge_config(asana, &next, &json!({"token": ""})).unwrap();
        assert!(kept.get("oauth").is_some(), "a blank secret keeps the sign-in");
    }

    #[test]
    fn refresh_keeps_rotated_tokens_and_tracks_expiry() {
        let oauth = object(json!({"accessToken": "old", "refreshToken": "r1", "expiresAt": 10_000, "account": "a@example.com"}));
        assert!(needs_refresh(&oauth, 10_000 - REFRESH_MARGIN_MS));
        assert!(!needs_refresh(&oauth, 10_000 - REFRESH_MARGIN_MS - 1));
        assert!(!needs_refresh(&object(json!({"accessToken": "never-expires"})), i64::MAX));

        let rotated = refreshed_oauth(&oauth, &json!({"accessToken": "new", "refreshToken": "r2", "expiresIn": 60}), 5_000).unwrap();
        assert_eq!(rotated, object(json!({"accessToken": "new", "refreshToken": "r2", "expiresAt": 65_000, "account": "a@example.com"})));
        let kept = refreshed_oauth(&oauth, &json!({"accessToken": "new"}), 5_000).unwrap();
        assert_eq!(kept["refreshToken"], "r1");
        assert!(kept.get("expiresAt").is_none());
        assert!(refreshed_oauth(&oauth, &json!({"error": "invalid_grant"}), 0).is_none());
    }

    #[test]
    fn provider_ids_may_be_numbers_or_strings() {
        assert_eq!(id_of(&json!(901234)), Some("901234".into()));
        assert_eq!(id_of(&json!("9012")), Some("9012".into()));
        assert_eq!(id_of(&json!("")), None);
    }

    fn meeting_with_commitments() -> Value {
        let mut meeting = meeting();
        meeting["actionItems"] = json!([
            {"id": "t1", "task": "Write the changelog", "owner": "Aditi", "deadline": "2026-10-02", "priority": "High"},
            {"id": "t2", "task": "Book the demo room", "owner": "Unassigned", "deadline": "TBD", "completed": true},
            {"id": "t3", "task": "Send the pricing sheet", "owner": "Riyam", "commitmentId": "c-linked"}
        ]);
        meeting["metadata"]["meetingCommitments"] = json!({"candidates": [
            {"id": "c1", "classification": "explicit_commitment", "person": "Riyam", "commitment": "I'll share the beta build with design by Thursday.", "targetAction": "share the beta build with design", "dueDate": "2026-10-09", "status": "candidate"},
            {"id": "c2", "classification": "other_person_commitment", "person": "Speaker 2", "reviewedPerson": "Mei", "commitment": "Mei said she'd check with legal.", "targetAction": "check with legal", "reviewedAction": "Check the contract with legal", "dueDate": "", "status": "reviewed"},
            {"id": "c3", "classification": "explicit_commitment", "person": "Riyam", "commitment": "I'll write the changelog.", "targetAction": "Write the changelog.", "status": "candidate"},
            {"id": "c4", "classification": "explicit_commitment", "person": "Riyam", "commitment": "I'll call the vendor.", "targetAction": "call the vendor", "status": "dismissed"},
            {"id": "c5", "classification": "explicit_commitment", "person": "Riyam", "commitment": "I'll update the deck.", "targetAction": "update the deck", "actionItemId": "t1", "status": "candidate"},
            {"id": "c-linked", "classification": "explicit_commitment", "person": "Riyam", "commitment": "I'll send the pricing sheet.", "targetAction": "send the pricing sheet", "status": "candidate"},
            {"id": "c6", "classification": "speculation", "person": "Riyam", "commitment": "Maybe we could rebrand.", "targetAction": "rebrand", "status": "candidate"}
        ]});
        meeting["metadata"]["postMeetingActions"] = json!({"version": 1, "items": [
            {"id": "a1", "status": "succeeded", "review": {"destination": "jira", "title": "Pricing recap"}, "result": {"key": "OPS-12", "url": "https://acme.atlassian.net/browse/OPS-12"}},
            {"id": "a2", "status": "succeeded", "review": {"destination": "google_calendar", "title": "Pricing follow-up"}, "result": {"url": "https://calendar.google.com/event?eid=1"}},
            {"id": "a3", "status": "failed", "review": {"destination": "slack", "title": "Launch plan sync"}},
            {"id": "a4", "status": "succeeded", "review": {"destination": "local_task", "title": "Already a task"}}
        ]});
        meeting["metadata"]["connectorDeliveries"] = json!({"notion": {"ok": true, "url": "https://www.notion.so/Launch-plan-sync-123"}});
        meeting
    }

    #[test]
    fn commitments_join_tasks_once_and_actions_already_taken_are_listed() {
        let notes = MeetingNotes::from_meeting(&meeting_with_commitments());
        let commitments: Vec<(&str, Option<&str>, Option<&str>)> = notes
            .commitments
            .iter()
            .map(|item| (item.task.as_str(), item.owner.as_deref(), item.due_date.as_deref()))
            .collect();
        assert_eq!(
            commitments,
            vec![("share the beta build with design", Some("Riyam"), Some("2026-10-09")), ("Check the contract with legal", Some("Mei"), None)]
        );
        assert_eq!(notes.commitments[0].commitment.as_deref(), Some("I'll share the beta build with design by Thursday."));
        let follow_ups: Vec<&str> = notes.follow_ups().iter().map(|item| item.task.as_str()).collect();
        assert_eq!(
            follow_ups,
            ["Write the changelog", "Send the pricing sheet", "share the beta build with design", "Check the contract with legal"],
            "completed tasks are not re-created; linked, dismissed, duplicate and speculative commitments are left out"
        );
        assert_eq!(notes.done_actions.len(), 2);
        assert_eq!(notes.done_actions[0].label, "Jira issue OPS-12");
        assert_eq!(notes.notes_url.as_deref(), Some("https://www.notion.so/Launch-plan-sync-123"));
        assert!(notes.wants(LINEAR));

        let slack = slack_payload(&notes)["text"].as_str().unwrap().to_string();
        assert!(slack.contains("*Commitments*\n☐ share the beta build with design — Riyam (due 2026-10-09)"));
        assert!(slack.contains("✓ Jira issue OPS-12: <https://acme.atlassian.net/browse/OPS-12|Pricing recap>"));
        assert!(!slack.contains("Launch plan sync>"), "failed actions are not reported as done");

        let blocks = Value::Array(notion_blocks(&notes)).to_string();
        assert!(blocks.contains("\"Commitments\"") && blocks.contains("\"Done after the meeting\""));
        assert!(blocks.contains("\"checked\":true"), "a completed task stays checked in the notes");
        assert!(blocks.contains("\"url\":\"https://calendar.google.com/event?eid=1\""));

        let doc = google_doc_html(&notes);
        assert!(doc.contains("<h2>Commitments</h2>") && doc.contains("☑ Book the demo room"));

        let description = notes.task_description(notes.follow_ups()[2]);
        assert!(description.contains("Commitment made in the meeting: “I'll share the beta build with design by Thursday.”"));
        assert!(description.contains("Meeting notes: https://www.notion.so/Launch-plan-sync-123"));
        assert!(description.contains("Summary: We agreed to ship on Friday."));
    }

    #[test]
    fn a_meeting_with_only_commitments_still_creates_tasks() {
        let mut meeting = meeting_with_commitments();
        meeting["actionItems"] = json!([]);
        let notes = MeetingNotes::from_meeting(&meeting);
        assert!(notes.wants(ASANA));
        assert_eq!(notes.follow_ups().len(), 5);
        meeting["metadata"].as_object_mut().unwrap().remove("meetingCommitments");
        assert!(!MeetingNotes::from_meeting(&meeting).wants(ASANA));
    }

    #[test]
    fn slack_one_click_grant_replaces_the_webhook_and_keeps_preferences() {
        let current = json!({"webhookUrl":"https://hooks.slack.com/services/T/B/old","channelLabel":"#old","autoPush":true})
            .as_object()
            .unwrap()
            .clone();
        let grant = json!({"webhookUrl":"https://hooks.slack.com/services/T/B/new","channel":"#recaps","workspace":"Acme"});
        let (next, label) = slack_grant_config(&current, &grant).unwrap();
        assert_eq!(label, "#recaps · Acme");
        assert_eq!(text(&next, "webhookUrl"), "https://hooks.slack.com/services/T/B/new");
        assert_eq!(text(&next, "channelLabel"), "#recaps · Acme");
        assert_eq!(next["autoPush"], true);
        assert!(is_connected(spec_for(SLACK).unwrap(), &next));

        let (_, label) = slack_grant_config(
            &Map::new(),
            &json!({"webhookUrl":"https://hooks.slack.com/services/T/B/new","channel":"","workspace":"Acme"}),
        )
        .unwrap();
        assert_eq!(label, "Acme");

        for bad in [
            json!({"channel":"#recaps"}),
            json!({"webhookUrl":"","channel":"#recaps"}),
            json!({"webhookUrl":"https://evil.example/services/T/B/x"}),
        ] {
            assert!(slack_grant_config(&current, &bad).is_err(), "{bad}");
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

    mod live {
        use super::*;
        use bytes::Bytes;
        use http_body_util::{BodyExt, Full};
        use hyper::{server::conn::http1, service::service_fn, Request, Response};
        use hyper_util::rt::TokioIo;
        use std::path::PathBuf;

        #[derive(Clone, Debug)]
        struct Seen {
            method: String,
            path: String,
            auth: String,
            body: Value,
        }

        type Handler = Arc<dyn Fn(&Seen) -> (u16, Value) + Send + Sync>;
        type Log = Arc<StdMutex<Vec<Seen>>>;

        async fn fake_server(handler: Handler) -> (String, Log) {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let log: Log = Arc::default();
            let seen_log = log.clone();
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let handler = handler.clone();
                    let log = seen_log.clone();
                    tokio::spawn(async move {
                        let service = service_fn(move |req: Request<hyper::body::Incoming>| {
                            let handler = handler.clone();
                            let log = log.clone();
                            async move {
                                let method = req.method().to_string();
                                let path = req.uri().path_and_query().map(|path| path.to_string()).unwrap_or_default();
                                let auth = req
                                    .headers()
                                    .get("authorization")
                                    .and_then(|value| value.to_str().ok())
                                    .unwrap_or_default()
                                    .to_string();
                                let bytes = req.into_body().collect().await.map(|body| body.to_bytes()).unwrap_or_default();
                                let seen = Seen { method, path, auth, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
                                let (status, reply) = handler(&seen);
                                log.lock().unwrap().push(seen);
                                let mut response = Response::new(Full::new(Bytes::from(reply.to_string())));
                                *response.status_mut() = hyper::StatusCode::from_u16(status).unwrap();
                                Ok::<_, std::convert::Infallible>(response)
                            }
                        });
                        let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
                    });
                }
            });
            (origin, log)
        }

        struct Harness {
            service: Arc<ConnectorService>,
            settings: Arc<SettingsStore>,
            events: broadcast::Sender<String>,
            log: Log,
            dir: PathBuf,
        }

        impl Drop for Harness {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }

        impl Harness {
            async fn start(handler: Handler) -> Self {
                let (origin, log) = fake_server(handler).await;
                let dir = std::env::temp_dir().join(format!("kesami-connectors-{}", uuid::Uuid::new_v4().simple()));
                std::fs::create_dir_all(&dir).unwrap();
                let settings = Arc::new(SettingsStore::at(&dir));
                let (events, _) = broadcast::channel(16);
                let calendar = Arc::new(CalendarService::new(settings.clone(), events.clone()));
                let endpoints = Endpoints {
                    cloud: Some(origin.clone()),
                    notion: format!("{origin}/notion"),
                    linear: format!("{origin}/linear"),
                    atlassian: format!("{origin}/atlassian"),
                    asana: format!("{origin}/asana"),
                    clickup: format!("{origin}/clickup"),
                    poll: Duration::from_millis(20),
                };
                let service = Arc::new(ConnectorService::with_endpoints(settings.clone(), calendar, events.clone(), endpoints));
                Self { service, settings, events, log, dir }
            }

            async fn store(&self, provider: &str, config: Value) {
                self.settings.set_credential(&credential_key(provider), Some(&config.to_string())).await.unwrap();
            }

            async fn stored(&self, provider: &str) -> Map<String, Value> {
                self.service.config(provider).await
            }

            fn seen(&self, path: &str) -> Vec<Seen> {
                self.log.lock().unwrap().iter().filter(|seen| seen.path.starts_with(path)).cloned().collect()
            }

            async fn next_connection(&self, events: &mut broadcast::Receiver<String>) -> Value {
                loop {
                    let raw = tokio::time::timeout(Duration::from_secs(5), events.recv()).await.unwrap().unwrap();
                    let event: Value = serde_json::from_str(&raw).unwrap();
                    if event["type"] == "connector_connection" {
                        return event["data"].clone();
                    }
                }
            }
        }

        fn provider<'a>(status: &'a Value, id: &str) -> &'a Value {
            status["providers"].as_array().unwrap().iter().find(|entry| entry["provider"] == id).unwrap()
        }

        const PAGE: &str = "01234567-89ab-cdef-0123-456789abcdef";

        #[tokio::test]
        async fn notion_one_click_creates_a_private_kesami_page_and_hides_tokens() {
            let claims = Arc::new(StdMutex::new(0));
            let counter = claims.clone();
            let harness = Harness::start(Arc::new(move |seen: &Seen| match (seen.method.as_str(), seen.path.as_str()) {
                ("GET", "/v1/connectors") => (200, json!({"providers": ["notion", "linear"]})),
                ("POST", "/v1/connectors/notion/start") => (
                    200,
                    json!({"authUrl": "https://api.notion.com/v1/oauth/authorize?client_id=x&state=s", "ticket": "ticket-1"}),
                ),
                ("POST", "/v1/connectors/notion/claim") if seen.body["ticket"] == "ticket-1" => {
                    let mut count = counter.lock().unwrap();
                    *count += 1;
                    if *count < 3 {
                        (202, json!({"pending": true}))
                    } else {
                        (200, json!({"accessToken": "notion-access", "refreshToken": "notion-refresh", "account": "riyam@example.com", "workspace": "Acme"}))
                    }
                }
                ("POST", "/notion/v1/pages") if seen.auth == "Bearer notion-access" && seen.body["parent"]["workspace"] == true => {
                    (200, json!({"id": PAGE, "url": "https://www.notion.so/Kesami-Meetings"}))
                }
                ("GET", path) if path == format!("/notion/v1/pages/{PAGE}") && seen.auth == "Bearer notion-access" => (200, json!({})),
                _ => (404, json!({"message": "unexpected"})),
            }))
            .await;
            let mut events = harness.events.subscribe();

            let started = harness.service.connect(NOTION).await.unwrap();
            assert!(started["authUrl"].as_str().unwrap().starts_with("https://api.notion.com/v1/oauth/authorize?"));
            let connected = harness.next_connection(&mut events).await;
            assert_eq!(connected, json!({"provider": "notion", "connected": true, "account": "riyam@example.com"}));
            assert_eq!(*claims.lock().unwrap(), 3);
            let created = harness.seen("/notion/v1/pages");
            assert_eq!(created[0].body["properties"]["title"]["title"][0]["text"]["content"], DESTINATION_NAME);

            let status = harness.service.status().await;
            let notion = provider(&status, NOTION);
            assert_eq!((notion["connected"].as_bool(), notion["signedIn"].as_bool()), (Some(true), Some(true)));
            assert_eq!(notion["oneClick"], true);
            assert_eq!(notion["destination"], DESTINATION_NAME);
            assert_eq!(provider(&status, LINEAR)["oneClick"], true);
            assert_eq!(provider(&status, JIRA)["oneClick"], false);
            assert_eq!(provider(&status, GOOGLE_DOCS)["oneClick"], false);
            assert!(!status.to_string().contains("notion-access") && !status.to_string().contains("notion-refresh"));

            assert_eq!(harness.service.test(NOTION).await.unwrap(), "Kesami can write under that page.");
            harness.service.status().await;
            assert_eq!(harness.seen("/v1/connectors").iter().filter(|seen| seen.method == "GET").count(), 1, "the provider list is cached");

            harness.service.setup(NOTION).await.unwrap();
            assert_eq!(harness.seen("/notion/v1/pages").iter().filter(|seen| seen.method == "POST").count(), 1, "an existing page is reused");
        }

        #[tokio::test]
        async fn notion_falls_back_to_a_shared_page_when_it_cannot_create_a_private_one() {
            let harness = Harness::start(Arc::new(|seen: &Seen| match (seen.method.as_str(), seen.path.as_str()) {
                ("POST", "/notion/v1/pages") if seen.body["parent"]["workspace"] == true => (400, json!({"message": "workspace parent not allowed"})),
                ("POST", "/notion/v1/pages") if seen.body["parent"]["page_id"] == "shared-page" => (200, json!({"id": PAGE})),
                ("POST", "/notion/v1/search") => (200, json!({"results": [{"id": "shared-page"}]})),
                _ => (404, json!({})),
            }))
            .await;
            harness.store(NOTION, json!({"oauth": {"accessToken": "a"}})).await;
            let ready = harness.service.setup(NOTION).await.unwrap();
            assert_eq!(ready["connected"], true);
            assert_eq!(harness.stored(NOTION).await["parentPageId"], PAGE);
        }

        #[tokio::test]
        async fn a_cancelled_sign_in_reaches_the_app_and_keeps_pasted_settings() {
            let harness = Harness::start(Arc::new(|seen: &Seen| match seen.path.as_str() {
                "/v1/connectors/linear/start" => (200, json!({"authUrl": "https://linear.app/oauth/authorize?x=1", "ticket": "t"})),
                "/v1/connectors/linear/claim" => (400, json!({"error": "Linear connection was cancelled."})),
                "/v1/connectors/asana/start" => (200, json!({"authUrl": "https://evil.example/authorize", "ticket": "t"})),
                _ => (404, json!({})),
            }))
            .await;
            harness.store(LINEAR, json!({"apiKey": "lin_api_pasted", "teamKey": "ENG"})).await;
            let mut events = harness.events.subscribe();
            harness.service.connect(LINEAR).await.unwrap();
            let outcome = harness.next_connection(&mut events).await;
            assert_eq!(outcome["connected"], false);
            assert_eq!(outcome["error"], "Linear connection was cancelled.");
            assert_eq!(harness.stored(LINEAR).await["apiKey"], "lin_api_pasted");
            assert!(harness.service.connect(ASANA).await.unwrap_err().contains("unexpected sign-in response"));
        }

        #[tokio::test]
        async fn linear_tokens_renew_before_expiry_and_after_a_401_then_ask_to_sign_in_again() {
            let revoked = Arc::new(StdMutex::new(Vec::<String>::new()));
            let rejected = revoked.clone();
            let teams = json!({"data": {"teams": {"nodes": [{"id": "team-1", "key": "ENG", "name": "Engineering"}]}}});
            let harness = Harness::start(Arc::new(move |seen: &Seen| match seen.path.as_str() {
                "/v1/connectors/linear/refresh" => match seen.body["refreshToken"].as_str() {
                    Some("r1") => (200, json!({"accessToken": "fresh", "refreshToken": "r2", "expiresIn": 86_400})),
                    Some("r2") => (200, json!({"accessToken": "fresher", "refreshToken": "r3", "expiresIn": 86_400})),
                    _ => (401, json!({"error": "Sign in to Linear again in Settings → Connectors."})),
                },
                "/linear/graphql" => {
                    let token = seen.auth.trim_start_matches("Bearer ").to_string();
                    if ["fresh", "fresher"].contains(&token.as_str()) && !rejected.lock().unwrap().contains(&token) {
                        (200, teams.clone())
                    } else {
                        (401, json!({"errors": [{"message": "Authentication required"}]}))
                    }
                }
                _ => (404, json!({})),
            }))
            .await;
            harness.store(LINEAR, json!({"oauth": {"accessToken": "expired", "refreshToken": "r1", "expiresAt": 1_000}, "teamKey": "ENG"})).await;

            assert_eq!(harness.service.test(LINEAR).await.unwrap(), "Found team ENG.");
            let oauth = harness.stored(LINEAR).await["oauth"].clone();
            assert_eq!((oauth["accessToken"].as_str(), oauth["refreshToken"].as_str()), (Some("fresh"), Some("r2")));
            assert!(oauth["expiresAt"].as_i64().unwrap() > Utc::now().timestamp_millis());
            assert!(harness.seen("/linear/graphql").iter().all(|seen| seen.auth != "Bearer expired"), "an expired token is renewed before use");

            revoked.lock().unwrap().push("fresh".into());
            assert_eq!(harness.service.test(LINEAR).await.unwrap(), "Found team ENG.");
            assert_eq!(harness.stored(LINEAR).await["oauth"]["refreshToken"], "r3");
            assert_eq!(harness.seen("/v1/connectors/linear/refresh").len(), 2);

            revoked.lock().unwrap().push("fresher".into());
            let failure = harness.service.test(LINEAR).await.unwrap_err();
            assert!(failure.contains("Sign in to Linear again"), "{failure}");
        }

        #[tokio::test]
        async fn jira_sets_itself_up_and_files_tasks_and_commitments_through_the_gateway() {
            let created = Arc::new(StdMutex::new(0));
            let next = created.clone();
            let projects = Arc::new(StdMutex::new(json!([])));
            let available = projects.clone();
            let harness = Harness::start(Arc::new(move |seen: &Seen| {
                if seen.path.starts_with("/v1/connectors/jira/") {
                    return match seen.path.as_str() {
                        "/v1/connectors/jira/start" => (200, json!({"authUrl": "https://auth.atlassian.com/authorize?x=1", "ticket": "t"})),
                        "/v1/connectors/jira/claim" => (200, json!({"accessToken": "jira-access", "expiresIn": 3600})),
                        _ => (404, json!({})),
                    };
                }
                if seen.auth != "Bearer jira-access" {
                    return (401, json!({}));
                }
                match (seen.method.as_str(), seen.path.as_str()) {
                    ("GET", "/atlassian/oauth/token/accessible-resources") => (
                        200,
                        json!([
                            {"id": "wiki-1", "name": "Acme wiki", "url": "https://acme.atlassian.net", "scopes": ["read:confluence-content.all"]},
                            {"id": "cloud-1", "name": "Acme", "url": "https://acme.atlassian.net/", "scopes": ["read:jira-work", "write:jira-work"]}
                        ]),
                    ),
                    ("GET", "/atlassian/ex/jira/cloud-1/rest/api/3/project/search?action=create&orderBy=-lastIssueUpdatedTime&maxResults=1") => {
                        (200, json!({"values": available.lock().unwrap().clone()}))
                    }
                    ("GET", "/atlassian/ex/jira/cloud-1/rest/api/3/issue/createmeta/OPS/issuetypes?maxResults=200") => {
                        (200, json!({"issueTypes": [{"name": "Sub-task", "subtask": true}, {"name": "Story"}, {"name": "Task"}]}))
                    }
                    ("GET", "/atlassian/ex/jira/cloud-1/rest/api/3/myself") => (200, json!({"emailAddress": "riyam@acme.com"})),
                    ("GET", "/atlassian/ex/jira/cloud-1/rest/api/3/project/OPS") => (200, json!({"key": "OPS", "name": "Operations"})),
                    ("POST", "/atlassian/ex/jira/cloud-1/rest/api/3/issue") => {
                        let mut count = next.lock().unwrap();
                        *count += 1;
                        (201, json!({"id": "1", "key": format!("OPS-{count}")}))
                    }
                    _ => (404, json!({})),
                }
            }))
            .await;
            let mut events = harness.events.subscribe();

            harness.service.connect(JIRA).await.unwrap();
            let failed = harness.next_connection(&mut events).await;
            assert_eq!(failed["connected"], false);
            assert_eq!(
                failed["error"],
                "Signed in to Jira, but Kesami couldn’t set up where to send tasks: you can’t create issues in any project on Acme"
            );
            let status = harness.service.status().await;
            assert_eq!((provider(&status, JIRA)["signedIn"].as_bool(), provider(&status, JIRA)["connected"].as_bool()), (Some(true), Some(false)));

            *projects.lock().unwrap() = json!([{"key": "OPS", "name": "Operations"}]);
            let ready = harness.service.setup(JIRA).await.unwrap();
            assert_eq!(ready["connected"], true);
            assert_eq!(ready["account"], "riyam@acme.com");
            assert_eq!(ready["destination"], "Operations (OPS) · Acme");
            let stored = harness.stored(JIRA).await;
            assert_eq!((stored["siteUrl"].as_str(), stored["issueType"].as_str()), (Some("https://acme.atlassian.net"), Some("Task")));
            assert_eq!(harness.service.test(JIRA).await.unwrap(), "Found project Operations.");

            let delivery = harness.service.send(JIRA, &meeting_with_commitments()).await;
            assert_eq!(delivery["ok"], true, "{delivery}");
            let issues: Vec<Seen> = harness
                .seen("/atlassian/ex/jira/cloud-1/rest/api/3/issue")
                .into_iter()
                .filter(|seen| seen.method == "POST")
                .collect();
            let titles: Vec<&str> = issues.iter().filter_map(|seen| seen.body["fields"]["summary"].as_str()).collect();
            assert_eq!(titles, ["Write the changelog", "Send the pricing sheet", "share the beta build with design", "Check the contract with legal"]);
            assert!(issues[2].body["fields"]["description"].to_string().contains("Commitment made in the meeting"));
            assert_eq!(delivery["items"][0]["url"], "https://acme.atlassian.net/browse/OPS-1");
        }

        #[tokio::test]
        async fn linear_asana_and_clickup_set_up_a_home_for_tasks_without_asking() {
            let harness = Harness::start(Arc::new(|seen: &Seen| match (seen.method.as_str(), seen.path.as_str()) {
                ("POST", "/linear/graphql") => (
                    200,
                    json!({"data": {"viewer": {"teams": {"nodes": [{"id": "t2", "key": "DES", "name": "Design"}]}}, "teams": {"nodes": [{"id": "t1", "key": "ENG", "name": "Engineering"}, {"id": "t2", "key": "DES", "name": "Design"}]}}}),
                ),
                ("GET", "/asana/api/1.0/users/me?opt_fields=workspaces.name,workspaces.is_organization") => {
                    (200, json!({"data": {"workspaces": [{"gid": "1", "name": "Acme", "is_organization": true}]}}))
                }
                ("GET", "/asana/api/1.0/workspaces/1/projects?archived=false&limit=100&opt_fields=name") => (200, json!({"data": [{"gid": "5", "name": "Roadmap"}]})),
                ("GET", "/asana/api/1.0/users/me/teams?organization=1&opt_fields=name") => (200, json!({"data": [{"gid": "77", "name": "Product"}]})),
                ("POST", "/asana/api/1.0/teams/77/projects") => (201, json!({"data": {"gid": "900", "name": DESTINATION_NAME}})),
                ("GET", "/clickup/api/v2/team") => (200, json!({"teams": [{"id": "9001", "name": "Acme"}]})),
                ("GET", "/clickup/api/v2/team/9001/space?archived=false") => (200, json!({"spaces": [{"id": 77, "name": "Product"}]})),
                ("GET", "/clickup/api/v2/space/77/list?archived=false") => {
                    (200, json!({"lists": [{"id": "501", "name": "Inbox"}, {"id": "502", "name": DESTINATION_NAME}]}))
                }
                _ => (404, json!({})),
            }))
            .await;
            for provider in [LINEAR, ASANA, CLICKUP] {
                harness.store(provider, json!({"oauth": {"accessToken": format!("{provider}-access"), "account": "riyam@acme.com"}})).await;
            }

            let linear = harness.service.setup(LINEAR).await.unwrap();
            assert_eq!((linear["connected"].as_bool(), linear["destination"].as_str()), (Some(true), Some("Design (DES)")), "the user's own team wins");

            let asana = harness.service.setup(ASANA).await.unwrap();
            assert_eq!(asana["destination"], format!("{DESTINATION_NAME} · Acme"));
            assert_eq!(harness.stored(ASANA).await["projectId"], "900");
            assert_eq!(harness.seen("/asana/api/1.0/teams/77/projects")[0].body["data"]["name"], DESTINATION_NAME);

            let clickup = harness.service.setup(CLICKUP).await.unwrap();
            assert_eq!(clickup["destination"], format!("{DESTINATION_NAME} · Product"));
            assert_eq!(harness.stored(CLICKUP).await["listId"], "502");
            assert!(harness.seen("/clickup").iter().all(|seen| seen.method == "GET" && seen.auth == "Bearer clickup-access"), "an existing Kesami list is reused");
        }

        #[tokio::test]
        async fn disconnect_revokes_signed_in_access_and_says_what_is_left_to_do() {
            let harness = Harness::start(Arc::new(|seen: &Seen| match seen.path.as_str() {
                "/v1/connectors/asana/revoke" => (200, json!({"revoked": true})),
                "/v1/connectors/jira/revoke" => (200, json!({"revoked": false})),
                _ => (404, json!({})),
            }))
            .await;
            harness.store(ASANA, json!({"oauth": {"accessToken": "a", "refreshToken": "r"}, "projectId": "11"})).await;
            harness.store(JIRA, json!({"oauth": {"accessToken": "j", "refreshToken": "jr"}, "cloudId": "c"})).await;
            harness.store(NOTION, json!({"token": "ntn_pasted", "parentPageId": PAGE})).await;

            assert_eq!(harness.service.disconnect(ASANA).await.unwrap(), "Disconnected and revoked Kesami’s access to Asana.");
            assert_eq!(harness.seen("/v1/connectors/asana/revoke")[0].body, json!({"accessToken": "a", "refreshToken": "r"}));
            assert!(harness.stored(ASANA).await.is_empty());

            assert!(harness.service.disconnect(JIRA).await.unwrap().contains("Connected apps"));
            assert!(harness.stored(JIRA).await.is_empty());

            assert_eq!(harness.service.disconnect(NOTION).await.unwrap(), "Disconnected.");
            assert!(harness.seen("/v1/connectors/notion").is_empty(), "pasted tokens are not sent to Kesami");
            assert!(harness.service.disconnect(SLACK).await.unwrap().contains("Integrations"));
        }
    }
}
