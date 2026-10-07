//! Post-meeting domain. Suggestions and confirmation are local; providers are ports.
use crate::{commitments, memory, Meeting};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::future::Future;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Destination {
    LocalTask,
    LocalDraft,
    GoogleCalendar,
    Jira,
    Slack,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub person: String,
    pub due_date: String,
    pub destination: Destination,
    pub classification: String,
    pub source_turn_ids: Vec<String>,
    pub excerpt: String,
    pub start_ms: Option<i64>,
    pub revision: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Review {
    pub confirmed: bool,
    pub revision: String,
    pub destination: Destination,
    pub title: String,
    #[serde(default)]
    pub person: String,
    #[serde(default)]
    pub due_date: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub recipients: Vec<String>,
    #[serde(default)]
    pub start: String,
    #[serde(default)]
    pub end: String,
    #[serde(default)]
    pub provider_revision: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub uncertain: bool,
}
impl ActionError {
    pub fn permission(message: &str) -> Self {
        Self {
            code: "permission_required".into(),
            message: message.into(),
            retryable: true,
            uncertain: false,
        }
    }
    pub fn uncertain() -> Self {
        Self { code: "outcome_unknown".into(), message: "The provider may have created this action. Check the provider before taking further action; Kesami will not resend it.".into(), retryable: false, uncertain: true }
    }
    pub fn response(status: u16) -> Self {
        match status {
            401 | 403 => Self::permission("The provider denied access. Reconnect or update permissions in Settings, then review and confirm again."),
            429 => Self { code: "rate_limited".into(), message: "The provider is rate limiting requests. Wait, then review and confirm again.".into(), retryable: true, uncertain: false },
            400 | 404 | 422 => Self { code: "invalid_request".into(), message: "The provider rejected this action. Check the reviewed fields and integration destination, then confirm again.".into(), retryable: true, uncertain: false },
            _ => Self::uncertain(),
        }
    }
}

pub fn target_revision(target: &Value) -> String {
    hash(target)
}

pub trait ActionProvider {
    fn execute(&self, review: &Review) -> impl Future<Output = Result<Value, ActionError>> + Send;
}

fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
fn inferred_kind<'a>(title: &str, fallback: &'a str) -> (&'a str, Destination) {
    let t = memory::normalize(title);
    let starts = |verbs: &[&str]| verbs.iter().any(|verb| t.starts_with(verb));
    let words: Vec<_> = t.split(|c: char| !c.is_alphanumeric()).collect();
    if starts(&["create ", "file ", "open "])
        && words.contains(&"jira")
        && (words.contains(&"ticket") || words.contains(&"issue"))
    {
        ("jira", Destination::Jira)
    } else if starts(&["schedule ", "book "])
        || (starts(&["send ", "create ", "add "])
            && (words.contains(&"calendar") || t.contains("cal invite")))
    {
        ("calendar", Destination::GoogleCalendar)
    } else if starts(&["email ", "send ", "share ", "draft ", "write "])
        && (words.contains(&"email")
            || words.contains(&"proposal")
            || t.contains("follow-up")
            || t.contains("follow up"))
    {
        ("email", Destination::LocalDraft)
    } else if t.contains("follow-up") || t.contains("follow up") || t.starts_with("check with ") {
        ("follow_up", Destination::LocalTask)
    } else {
        (fallback, Destination::LocalTask)
    }
}

struct SuggestionSeed<'a> {
    key: Value,
    title: &'a str,
    person: &'a str,
    date: &'a str,
    classification: &'a str,
    ids: Vec<String>,
    quote: &'a str,
    fallback: &'a str,
    body: &'a str,
}
fn make(
    meeting: &Meeting,
    transcript_revision: &str,
    turns: &std::collections::HashMap<&str, &crate::TranscriptTurn>,
    seed: SuggestionSeed<'_>,
) -> Suggestion {
    let SuggestionSeed {
        key,
        title,
        person,
        date,
        classification,
        ids,
        quote,
        fallback,
        body,
    } = seed;
    let (kind, destination) = inferred_kind(title, fallback);
    let ids: Vec<_> = ids
        .into_iter()
        .take(20)
        .filter(|id| turns.contains_key(id.as_str()))
        .collect();
    let excerpt = if quote.is_empty() {
        ids.first()
            .and_then(|id| turns.get(id.as_str()))
            .map(|t| t.text.chars().take(1000).collect())
            .unwrap_or_default()
    } else if quote.len() <= 4000
        && ids.iter().any(|id| {
            turns
                .get(id.as_str())
                .is_some_and(|t| t.text.contains(quote))
        })
    {
        quote.into()
    } else {
        String::new()
    };
    let excerpt: String = excerpt.chars().take(1000).collect();
    let ids = if excerpt.is_empty() { vec![] } else { ids };
    let start_ms = ids
        .first()
        .and_then(|id| turns.get(id.as_str()))
        .map(|t| t.start_ms);
    let id = format!("action-{}", hash(&json!([meeting.id, key])));
    let revision = hash(&json!([
        transcript_revision,
        meeting.title,
        title,
        person,
        date,
        classification,
        ids,
        excerpt,
        body
    ]));
    Suggestion {
        id,
        kind: kind.into(),
        title: title.into(),
        person: person.into(),
        due_date: date.into(),
        destination,
        classification: classification.into(),
        source_turn_ids: ids,
        excerpt,
        start_ms,
        revision,
        body: body.into(),
    }
}

pub fn suggestions(meeting: &Meeting) -> Vec<Suggestion> {
    if meeting.ended_at.is_none() {
        return vec![];
    }
    let transcript_revision = memory::transcript_revision(meeting);
    let turns = meeting
        .transcript
        .iter()
        .map(|t| (t.id.as_str(), t))
        .collect();
    let mut result = Vec::new();
    let mut linked = std::collections::HashSet::new();
    if commitments::current(meeting) {
        for c in commitments::candidates(meeting).into_iter().take(100) {
            if c.status == "dismissed"
                || !matches!(
                    c.classification.as_str(),
                    "explicit_commitment" | "other_person_commitment" | "suggested_action"
                )
            {
                continue;
            }
            linked.insert(c.id.clone());
            if c.action_item_id.as_ref().is_some_and(|id| {
                meeting
                    .action_items
                    .iter()
                    .any(|t| t["id"].as_str() == Some(id) && t["completed"] == true)
            }) {
                continue;
            }
            let title = c.reviewed_action.as_deref().unwrap_or(&c.target_action);
            result.push(make(
                meeting,
                &transcript_revision,
                &turns,
                SuggestionSeed {
                    key: json!(["commitment", c.id]),
                    title,
                    person: c.reviewed_person.as_deref().unwrap_or(&c.person),
                    date: &c.due_date,
                    classification: &c.classification,
                    ids: c.source_turn_ids,
                    quote: &c.commitment,
                    fallback: "commitment",
                    body: "",
                },
            ));
        }
    }
    for (index, task) in meeting.action_items.iter().take(100).enumerate() {
        if task["completed"] == true
            || task["workflowActionId"].is_string()
            || task["commitmentId"]
                .as_str()
                .is_some_and(|id| linked.contains(id))
        {
            continue;
        }
        let title = task["task"]
            .as_str()
            .or_else(|| task.as_str())
            .unwrap_or("")
            .trim();
        if title.is_empty() {
            continue;
        }
        let source_current = task["sourceTranscriptRevision"]
            .as_str()
            .is_none_or(|r| r == transcript_revision);
        let ids = if source_current {
            task["sourceTurnIds"]
                .as_array()
                .map(|v| {
                    v.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        } else {
            vec![]
        };
        result.push(make(
            meeting,
            &transcript_revision,
            &turns,
            SuggestionSeed {
                key: json!([
                    "task",
                    task["id"]
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("legacy-{index}"))
                ]),
                title,
                person: task["owner"].as_str().unwrap_or(""),
                date: task["deadline"].as_str().unwrap_or(""),
                classification: "extracted_action",
                ids,
                quote: task["sourceQuote"].as_str().unwrap_or(""),
                fallback: "action_item",
                body: "",
            },
        ));
    }
    if !meeting.email_draft.trim().is_empty() {
        let mut email = make(
            meeting,
            &transcript_revision,
            &turns,
            SuggestionSeed {
                key: json!(["email_draft"]),
                title: &format!("Follow up: {}", meeting.title),
                person: "",
                date: "",
                classification: "generated_draft",
                ids: vec![],
                quote: "",
                fallback: "email",
                body: &meeting.email_draft,
            },
        );
        email.kind = "email".into();
        email.destination = Destination::LocalDraft;
        result.push(email);
    }
    let mut seen = std::collections::HashSet::new();
    result.retain(|s| {
        seen.insert((
            s.destination as u8,
            memory::normalize(&s.title),
            memory::normalize(&s.person),
        ))
    });
    result.truncate(200);
    // Sharing is a review suggestion, never an effect of summary generation.
    // Stable per-provider IDs retain success/unknown receipts across regeneration.
    if !meeting.summary_markdown.trim().is_empty() {
        let date = chrono::DateTime::from_timestamp_millis(meeting.started_at)
            .map(|date| date.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|| "Date unavailable".into());
        let body = format!(
            "Meeting: {}\nDate: {} (UTC)\n\n{}\n\nAI-generated recap. Review important details.",
            meeting.title,
            date,
            meeting.summary_markdown.trim()
        );
        for (provider, destination) in [("slack", Destination::Slack), ("jira", Destination::Jira)]
        {
            let mut summary = make(
                meeting,
                &transcript_revision,
                &turns,
                SuggestionSeed {
                    key: json!(["summary", provider]),
                    title: &meeting.title,
                    person: "",
                    date: "",
                    classification: "generated_summary",
                    ids: vec![],
                    quote: "",
                    fallback: "summary",
                    body: &body,
                },
            );
            summary.kind = format!("summary_{provider}");
            summary.destination = destination;
            result.push(summary);
        }
    }
    result
}

pub fn validate(review: &Review) -> Result<(), (u16, String)> {
    let bad = |message: &str| Err((400, message.into()));
    if !review.confirmed {
        return bad("Review and explicitly confirm this action first.");
    }
    if review.title.trim().is_empty()
        || review.title.len() > 250
        || review.body.len() > 20_000
        || review.person.len() > 120
        || review.due_date.len() > 100
    {
        return bad("Check the title and field lengths.");
    }
    if matches!(
        review.destination,
        Destination::GoogleCalendar | Destination::Jira | Destination::Slack
    ) && (review.provider_revision.is_empty() || review.provider_revision.len() > 64)
    {
        return bad("Reload and review the external provider destination before confirmation.");
    }
    if review.recipients.len() > 50 || review.recipients.iter().any(|s| !valid_email(s)) {
        return bad("Enter valid recipient email addresses; Kesami does not infer recipients.");
    }
    match review.destination {
        Destination::LocalTask => {
            let owner = memory::normalize(&review.person);
            if owner.is_empty()
                || owner.starts_with("speaker")
                || ["unknown", "others", "other", "unassigned", "we", "they"]
                    .contains(&owner.as_str())
            {
                return bad("Review a specific task owner before confirmation.");
            }
        }
        Destination::LocalDraft => {
            if review.body.trim().is_empty() || review.recipients.is_empty() {
                return bad(
                    "Review the recipient, subject and email body before creating a local draft.",
                );
            }
        }
        Destination::GoogleCalendar => {
            let (Ok(start), Ok(end)) = (
                chrono::DateTime::parse_from_rfc3339(&review.start),
                chrono::DateTime::parse_from_rfc3339(&review.end),
            ) else {
                return bad("Choose explicit calendar start/end times with a timezone.");
            };
            if end <= start {
                return bad("The calendar event must end after it starts.");
            }
        }
        Destination::Jira => {}
        Destination::Slack => {
            if review.body.trim().is_empty() {
                return bad("Review the summary text before posting to Slack.");
            }
        }
    }
    Ok(())
}
fn valid_email(email: &str) -> bool {
    email.len() <= 254
        && !email
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || [',', ';', '<', '>'].contains(&c))
        && email.split_once('@').is_some_and(|(a, b)| {
            !a.is_empty()
                && !b.contains('@')
                && b.contains('.')
                && !b.starts_with('.')
                && !b.ends_with('.')
        })
}

pub fn ledger(meeting: &Meeting) -> Vec<Value> {
    meeting.metadata["postMeetingActions"]["items"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}
fn save_ledger(meeting: &mut Meeting, items: Vec<Value>) {
    if !meeting.metadata.is_object() {
        meeting.metadata = json!({});
    }
    meeting.metadata["postMeetingActions"] = json!({"version":1,"items":items});
}

/// Reserve under Store::update before any external call. Success repeats are reads.
pub fn reserve(meeting: &mut Meeting, id: &str, review: &Review) -> Result<(), (u16, String)> {
    if meeting.ended_at.is_none() {
        return Err((409, "Finish processing this meeting first.".into()));
    }
    validate(review)?;
    let mut items = ledger(meeting);
    if let Some(previous) = items.iter().find(|i| i["id"] == id) {
        if previous["status"] == "succeeded" {
            if previous["review"] == serde_json::to_value(review).unwrap() {
                return Ok(());
            }
            return Err((
                409,
                "This action was already completed. Its confirmed payload cannot be changed."
                    .into(),
            ));
        }
        if previous["status"] == "failed" && previous["error"]["retryable"] != true {
            return Err((
                409,
                "This action cannot be retried safely. Check the saved outcome first.".into(),
            ));
        }
        if previous["status"] == "executing" || previous["status"] == "unknown" {
            return Err((
                409,
                "This action may already exist. Check the provider; Kesami will not resend it."
                    .into(),
            ));
        }
    }
    let source = suggestions(meeting)
        .into_iter()
        .find(|s| s.id == id)
        .ok_or((404, "This suggestion is no longer available.".into()))?;
    if source.revision != review.revision {
        return Err((
            409,
            "Meeting sources changed. Reload and review the latest suggestion.".into(),
        ));
    }
    if source.kind.starts_with("summary_")
        && (source.destination != review.destination || review.body.trim().is_empty())
    {
        return Err((
            400,
            "Review the summary text and its displayed destination.".into(),
        ));
    }
    let old = items.iter().position(|i| i["id"] == id);
    if old.is_none() && items.len() >= 500 {
        return Err((
            409,
            "This meeting has reached its action history limit.".into(),
        ));
    }
    let item = json!({"id":id,"status":"executing","review":review,"source":source,"attempts":old.map(|i| items[i]["attempts"].as_u64().unwrap_or(0)).unwrap_or(0)+1,"confirmedAt":chrono::Utc::now().timestamp_millis()});
    if let Some(i) = old {
        items[i] = item;
    } else {
        items.push(item);
    }
    save_ledger(meeting, items);
    if matches!(
        review.destination,
        Destination::LocalTask | Destination::LocalDraft
    ) {
        let result = if review.destination == Destination::LocalTask {
            let existing = meeting.action_items.iter().position(|t| {
                memory::normalize(t["task"].as_str().unwrap_or(""))
                    == memory::normalize(&review.title)
                    && memory::normalize(t["owner"].as_str().unwrap_or(""))
                        == memory::normalize(&review.person)
            });
            let task = json!({"id":format!("task-{id}"),"task":review.title.trim(),"owner":review.person.trim(),"deadline":review.due_date.trim(),"completed":false,"confirmation":"human_reviewed","workflowActionId":id,"sourceTurnIds":source.source_turn_ids,"sourceQuote":source.excerpt,"sourceTranscriptRevision":memory::transcript_revision(meeting)});
            if let Some(i) = existing {
                // Keep the task ID and user completion, add human-reviewed provenance.
                let mut task = task;
                if meeting.action_items[i]["id"].is_string() {
                    task["id"] = meeting.action_items[i]["id"].clone();
                }
                if meeting.action_items[i]["completed"].is_boolean() {
                    task["completed"] = meeting.action_items[i]["completed"].clone();
                }
                let mut preserved = meeting.action_items[i].clone();
                if let Some(fields) = preserved.as_object_mut() {
                    for (key, value) in task.as_object().unwrap() {
                        fields.insert(key.clone(), value.clone());
                    }
                } else {
                    preserved = task;
                }
                meeting.action_items[i] = preserved;
                json!({"taskId":meeting.action_items[i]["id"]})
            } else {
                let result = json!({"taskId":task["id"]});
                meeting.action_items.push(task);
                result
            }
        } else {
            json!({"draft": {"subject":review.title.trim(),"body":review.body,"recipients":review.recipients},"local":true,"sent":false})
        };
        finish(meeting, id, Ok(result))?;
    }
    Ok(())
}

pub fn finish(
    meeting: &mut Meeting,
    id: &str,
    result: Result<Value, ActionError>,
) -> Result<(), (u16, String)> {
    let mut items = ledger(meeting);
    let item = items
        .iter_mut()
        .find(|i| i["id"] == id)
        .ok_or((409, "Action reservation is missing.".into()))?;
    if item["status"] != "executing" {
        return Err((409, "Action reservation has already finished.".into()));
    }
    match result {
        Ok(receipt) => {
            item["status"] = json!("succeeded");
            item["result"] = receipt;
        }
        Err(error) => {
            item["status"] = json!(if error.uncertain { "unknown" } else { "failed" });
            item["error"] = serde_json::to_value(error).unwrap();
        }
    }
    item["finishedAt"] = json!(chrono::Utc::now().timestamp_millis());
    save_ledger(meeting, items);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn meeting() -> Meeting {
        serde_json::from_value(json!({"id":"m","title":"Review","startedAt":0,"endedAt":1,"durationSeconds":1,"summaryMarkdown":"","keyDecisions":[],"actionItems":[],"metadata":{},"createdAt":0,"transcript":[{"id":"t","speaker":"Riyam","channel":"mic","startMs":0,"endMs":10,"confidence":1,"text":"I'll check with engineering tomorrow. Let's schedule a follow-up next Tuesday. I'll create the Jira ticket. I'll send the proposal tomorrow."}]})).unwrap()
    }
    fn review(s: &Suggestion, destination: Destination) -> Review {
        Review {
            confirmed: true,
            revision: s.revision.clone(),
            destination,
            title: s.title.clone(),
            person: "Riyam".into(),
            due_date: s.due_date.clone(),
            body: "Reviewed email".into(),
            recipients: vec!["user@example.com".into()],
            start: "2026-10-13T10:00:00+05:30".into(),
            end: "2026-10-13T10:30:00+05:30".into(),
            provider_revision: "test-target".into(),
        }
    }
    #[test]
    fn all_action_types_and_false_positives() {
        let mut m = meeting();
        let mut extra = m.transcript[0].clone();
        extra.id = "extra".into();
        extra.text = "I will review the documentation.".into();
        m.transcript.push(extra);
        commitments::detect(&mut m);
        m.action_items = vec![
            json!({"id":"a","task":"Review API","owner":"Riyam","sourceTurnIds":["t"]}),
            json!({"id":"b","task":"Follow up with engineering","owner":"Riyam"}),
        ];
        m.email_draft = "Subject: Review\nBody: Existing draft".into();
        let s = suggestions(&m);
        for kind in [
            "commitment",
            "calendar",
            "jira",
            "email",
            "action_item",
            "follow_up",
        ] {
            assert!(s.iter().any(|s| s.kind == kind), "{kind}");
        }
        m.transcript[0].text = "I'll review the API.".into();
        commitments::detect(&mut m);
        let s = suggestions(&m);
        assert!(s.iter().any(|s| s.kind == "commitment"));
        assert!(!s.iter().any(|s| s.kind == "jira"));
        assert!(m.metadata["postMeetingActions"].is_null());
    }
    #[test]
    fn local_task_and_email_draft_are_confirmed_idempotent_and_durable() {
        for destination in [Destination::LocalTask, Destination::LocalDraft] {
            let mut m = meeting();
            commitments::detect(&mut m);
            let source = suggestions(&m).remove(0);
            let r = review(&source, destination);
            reserve(&mut m, &source.id, &r).unwrap();
            reserve(&mut m, &source.id, &r).unwrap();
            assert_eq!(ledger(&m).len(), 1);
            assert_eq!(ledger(&m)[0]["status"], "succeeded");
            if destination == Destination::LocalDraft {
                assert_eq!(ledger(&m)[0]["result"]["sent"], false);
            } else {
                assert_eq!(m.action_items.len(), 1);
                m.action_items[0]["completed"] = json!(true);
                reserve(&mut m, &source.id, &r).unwrap();
                assert_eq!(m.action_items[0]["completed"], true);
            }
            let restored: Meeting =
                serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
            assert_eq!(ledger(&restored), ledger(&m));
        }
    }
    #[test]
    fn calendar_and_jira_reservations_guard_retries_and_stale_sources() {
        for destination in [Destination::GoogleCalendar, Destination::Jira] {
            let mut m = meeting();
            commitments::detect(&mut m);
            let s = suggestions(&m).remove(0);
            let r = review(&s, destination);
            let mut stale = r.clone();
            stale.revision = "stale".into();
            assert_eq!(reserve(&mut m, &s.id, &stale).unwrap_err().0, 409);
            reserve(&mut m, &s.id, &r).unwrap();
            assert_eq!(reserve(&mut m, &s.id, &r).unwrap_err().0, 409);
            finish(&mut m, &s.id, Err(ActionError::permission("Connect"))).unwrap();
            reserve(&mut m, &s.id, &r).unwrap();
            assert_eq!(ledger(&m)[0]["attempts"], 2);
            finish(&mut m, &s.id, Err(ActionError::uncertain())).unwrap();
            assert_eq!(reserve(&mut m, &s.id, &r).unwrap_err().0, 409);
        }
    }
    #[test]
    fn validation_requires_confirmation_owner_dates_recipients_and_bounded_fields() {
        let mut m = meeting();
        commitments::detect(&mut m);
        let s = suggestions(&m).remove(0);
        let mut r = review(&s, Destination::LocalTask);
        r.confirmed = false;
        assert!(validate(&r).is_err());
        r.confirmed = true;
        r.person = "Speaker 1".into();
        assert!(validate(&r).is_err());
        r.destination = Destination::GoogleCalendar;
        r.start = "next Tuesday".into();
        assert!(validate(&r).is_err());
        r.start = r.end.clone();
        assert!(validate(&r).is_err());
        r.destination = Destination::LocalDraft;
        r.recipients = vec![];
        assert!(validate(&r).is_err());
        r.recipients = vec!["fake@example.com\r\nBcc:private@example.com".into()];
        assert!(validate(&r).is_err());
        r.destination = Destination::Jira;
        r.recipients.clear();
        r.title = "x".repeat(251);
        assert!(validate(&r).is_err());
        assert!(ActionError::response(429).retryable);
        assert!(!ActionError::response(503).retryable);
    }
    #[test]
    fn provider_names_in_discussion_tasks_do_not_imply_creation() {
        for title in [
            "Review the onboarding handbook",
            "Check Jira ticket API-123",
            "Review the Google Calendar API",
            "Improve email parsing",
        ] {
            assert_eq!(
                inferred_kind(title, "action_item"),
                ("action_item", Destination::LocalTask)
            );
        }
    }

    #[test]
    fn interrupted_dispatch_and_non_retryable_rejections_cannot_resend() {
        let mut m = meeting();
        commitments::detect(&mut m);
        let s = suggestions(&m).remove(0);
        let r = review(&s, Destination::Jira);
        reserve(&mut m, &s.id, &r).unwrap();
        let mut restored: Meeting =
            serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(reserve(&mut restored, &s.id, &r).unwrap_err().0, 409);
        finish(
            &mut restored,
            &s.id,
            Err(ActionError {
                code: "unsupported".into(),
                message: "Cannot retry".into(),
                retryable: false,
                uncertain: false,
            }),
        )
        .unwrap();
        assert_eq!(reserve(&mut restored, &s.id, &r).unwrap_err().0, 409);
    }

    #[test]
    fn summary_merge_preserves_workflow_task_state_and_provenance() {
        let mut m = meeting();
        commitments::detect(&mut m);
        let s = suggestions(&m).remove(0);
        let r = review(&s, Destination::LocalTask);
        reserve(&mut m, &s.id, &r).unwrap();
        m.action_items[0]["completed"] = json!(true);
        let merged = memory::merge_actions(
            &m.action_items,
            &[json!({"task":r.title,"owner":r.person,"deadline":"different","completed":false})],
        );
        assert_eq!(merged[0], m.action_items[0]);
        assert_eq!(ledger(&m)[0]["status"], "succeeded");
    }

    #[test]
    fn receipts_survive_source_edits_and_different_review_cannot_repeat_success() {
        let mut m = meeting();
        commitments::detect(&mut m);
        let s = suggestions(&m).remove(0);
        let mut r = review(&s, Destination::LocalTask);
        reserve(&mut m, &s.id, &r).unwrap();
        m.transcript[0].speaker = "Changed".into();
        m.email_draft = "Changed draft".into();
        assert_eq!(ledger(&m).len(), 1);
        reserve(&mut m, &s.id, &r).unwrap();
        r.title = "Different task".into();
        assert_eq!(reserve(&mut m, &s.id, &r).unwrap_err().0, 409);
    }

    #[test]
    fn summary_actions_require_current_review_and_keep_durable_receipts() {
        for destination in [Destination::Slack, Destination::Jira] {
            let mut m = meeting();
            assert!(suggestions(&m).is_empty());
            m.summary_markdown = "We discussed pricing; no decision was made.".into();
            m.email_draft = "private email draft".into();
            m.notes = vec![json!({"text":"private note"})];
            let s = suggestions(&m)
                .into_iter()
                .find(|s| s.destination == destination)
                .unwrap();
            assert!(s.body.contains("1970-01-01"));
            assert!(s.body.contains(&m.summary_markdown));
            assert!(!s.body.contains("private") && !s.body.contains("engineering"));
            assert!(s.source_turn_ids.is_empty() && s.excerpt.is_empty());
            assert!(ledger(&m).is_empty(), "preview has no effects");
            let mut r = review(&s, destination);
            r.body = s.body.clone();
            r.confirmed = false;
            assert_eq!(reserve(&mut m, &s.id, &r).unwrap_err().0, 400);
            r.confirmed = true;
            let mut wrong = r.clone();
            wrong.destination = Destination::LocalTask;
            assert_eq!(reserve(&mut m, &s.id, &wrong).unwrap_err().0, 400);
            wrong = r.clone();
            wrong.body.clear();
            assert_eq!(reserve(&mut m, &s.id, &wrong).unwrap_err().0, 400);
            wrong = r.clone();
            wrong.provider_revision.clear();
            assert_eq!(reserve(&mut m, &s.id, &wrong).unwrap_err().0, 400);
            m.summary_markdown = "Revised recap".into();
            assert_eq!(reserve(&mut m, &s.id, &r).unwrap_err().0, 409);
            let latest = suggestions(&m)
                .into_iter()
                .find(|s| s.destination == destination)
                .unwrap();
            assert_eq!(s.id, latest.id);
            assert_ne!(s.revision, latest.revision);
            r = review(&latest, destination);
            r.body = "Human-reviewed summary only".into();
            reserve(&mut m, &s.id, &r).unwrap();
            assert_eq!(ledger(&m)[0]["review"]["body"], r.body);
            assert_eq!(reserve(&mut m, &s.id, &r).unwrap_err().0, 409);
            finish(&mut m, &s.id, Ok(json!({"posted":true}))).unwrap();
            m.summary_markdown = "Regenerated again".into();
            reserve(&mut m, &s.id, &r).unwrap();
            assert_eq!(ledger(&m).len(), 1);
            let mut newer = r.clone();
            newer.revision = suggestions(&m)
                .into_iter()
                .find(|s| s.id == latest.id)
                .unwrap()
                .revision;
            assert_eq!(reserve(&mut m, &s.id, &newer).unwrap_err().0, 409);
            m.ended_at = None;
            assert!(suggestions(&m).is_empty());
        }
    }

    #[test]
    fn summary_preview_does_not_silently_truncate_and_unknown_attempts_block() {
        let mut m = meeting();
        m.summary_markdown = "界".repeat(8000);
        let s = suggestions(&m)
            .into_iter()
            .find(|s| s.destination == Destination::Slack)
            .unwrap();
        let mut r = review(&s, Destination::Slack);
        r.body = s.body.clone();
        assert!(s.body.contains(&m.summary_markdown));
        assert!(reserve(&mut m, &s.id, &r).is_err());
        r.body = "Explicitly shortened by user".into();
        reserve(&mut m, &s.id, &r).unwrap();
        finish(&mut m, &s.id, Err(ActionError::uncertain())).unwrap();
        m.summary_markdown = "Changed after unknown outcome".into();
        assert_eq!(reserve(&mut m, &s.id, &r).unwrap_err().0, 409);
    }
}
