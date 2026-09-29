use chrono::{TimeZone, Utc};
use serde_json::{json, Value};

use crate::connectors::{turn_offset_ms, MeetingNotes};
use crate::library::timecode as clock;

pub const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 100;
const SNIPPET_RADIUS: usize = 120;

fn tools() -> Value {
    json!([
        {
            "name": "list_meetings",
            "description": "List recorded Kesami meetings, newest first. Optionally filter by a search query that matches titles, summaries and transcripts.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Text to match. Omit to list everything."},
                    "limit": {"type": "integer", "minimum": 1, "maximum": MAX_LIMIT}
                }
            },
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "get_meeting",
            "description": "Get a meeting's notes: date, participants, summary, decisions and action items.",
            "inputSchema": {
                "type": "object",
                "properties": {"id": {"type": "string", "description": "Meeting id from list_meetings."}},
                "required": ["id"]
            },
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "get_transcript",
            "description": "Get a meeting's full transcript with speakers and timestamps.",
            "inputSchema": {
                "type": "object",
                "properties": {"id": {"type": "string", "description": "Meeting id from list_meetings."}},
                "required": ["id"]
            },
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "search_transcripts",
            "description": "Find what was said across all meetings. Returns matching passages with the meeting, speaker and timestamp.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": MAX_LIMIT}
                },
                "required": ["query"]
            },
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "list_action_items",
            "description": "List action items from recent meetings, with owner, due date and source meeting.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "days": {"type": "integer", "minimum": 1, "description": "Only meetings from the last N days. Default 14."},
                    "owner": {"type": "string", "description": "Only items whose owner contains this text."}
                }
            },
            "annotations": {"readOnlyHint": true}
        }
    ])
}

fn date_of(meeting: &Value) -> String {
    meeting
        .get("startedAt")
        .and_then(Value::as_i64)
        .and_then(|ms| Utc.timestamp_millis_opt(ms).single())
        .map(|at| at.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_default()
}

fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn limit_arg(args: &Value) -> usize {
    args.get("limit")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT)
}

fn find<'a>(meetings: &'a [Value], args: &Value) -> Result<&'a Value, String> {
    let id = str_of(args, "id");
    if id.is_empty() {
        return Err("id is required".into());
    }
    meetings
        .iter()
        .find(|m| str_of(m, "id") == id)
        .ok_or_else(|| format!("No meeting with id {id}"))
}

fn matches(meeting: &Value, query: &str) -> bool {
    query.is_empty()
        || str_of(meeting, "title").to_lowercase().contains(query)
        || str_of(meeting, "summaryMarkdown")
            .to_lowercase()
            .contains(query)
        || meeting
            .get("transcript")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|turn| str_of(turn, "text").to_lowercase().contains(query))
}

fn list_meetings(meetings: &[Value], args: &Value) -> String {
    let query = str_of(args, "query").trim().to_lowercase();
    let rows: Vec<String> = meetings
        .iter()
        .filter(|m| matches(m, &query))
        .take(limit_arg(args))
        .map(|m| {
            let notes = MeetingNotes::from_meeting(m);
            format!(
                "- {} — {} ({}, {} min, {} action items) id: {}",
                date_of(m),
                notes.title,
                if notes.participants.is_empty() {
                    "no participants recorded".into()
                } else {
                    notes.participants.join(", ")
                },
                notes.duration_minutes,
                notes.action_items.len(),
                notes.id
            )
        })
        .collect();
    if rows.is_empty() {
        "No meetings found.".into()
    } else {
        rows.join("\n")
    }
}

fn meeting_notes(meeting: &Value) -> String {
    let notes = MeetingNotes::from_meeting(meeting);
    let mut out = format!(
        "# {}\n\nDate: {}\nDuration: {} min\n",
        notes.title,
        date_of(meeting),
        notes.duration_minutes
    );
    if !notes.participants.is_empty() {
        out.push_str(&format!(
            "Participants: {}\n",
            notes.participants.join(", ")
        ));
    }
    out.push_str(&format!("Meeting id: {}\n", notes.id));
    if notes.summary_markdown.is_empty() {
        out.push_str("\nNo summary was generated for this meeting.\n");
    } else {
        out.push_str(&format!("\n## Summary\n\n{}\n", notes.summary_markdown));
    }
    if !notes.key_decisions.is_empty() {
        out.push_str("\n## Decisions\n\n");
        for decision in &notes.key_decisions {
            out.push_str(&format!("- {decision}\n"));
        }
    }
    if !notes.action_items.is_empty() {
        out.push_str("\n## Action items\n\n");
        for item in &notes.action_items {
            out.push_str(&format!(
                "- {} (owner: {}, due: {})\n",
                item.task,
                item.owner.as_deref().unwrap_or("unassigned"),
                item.deadline.as_deref().unwrap_or("none")
            ));
        }
    }
    let email = str_of(meeting, "emailDraft");
    if !email.trim().is_empty() {
        out.push_str(&format!("\n## Follow-up email draft\n\n{}\n", email.trim()));
    }
    out
}

fn transcript(meeting: &Value) -> String {
    let turns: Vec<String> = meeting
        .get("transcript")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|turn| {
            let offset = turn_offset_ms(meeting, turn);
            format!(
                "[{}] {}: {}",
                clock(offset),
                str_of(turn, "speaker"),
                str_of(turn, "text").trim()
            )
        })
        .collect();
    if turns.is_empty() {
        return format!("“{}” has no transcript.", str_of(meeting, "title"));
    }
    format!(
        "# Transcript — {} ({})\n\n{}",
        str_of(meeting, "title"),
        date_of(meeting),
        turns.join("\n")
    )
}

fn snippet(text: &str, at: usize, len: usize) -> String {
    let start = text[..at]
        .char_indices()
        .rev()
        .nth(SNIPPET_RADIUS)
        .map(|(i, _)| i)
        .unwrap_or(0);
    let end = text[at + len..]
        .char_indices()
        .nth(SNIPPET_RADIUS)
        .map(|(i, _)| at + len + i)
        .unwrap_or(text.len());
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        text[start..end].trim(),
        if end < text.len() { "…" } else { "" }
    )
}

fn search_transcripts(meetings: &[Value], args: &Value) -> Result<String, String> {
    let query = str_of(args, "query").trim().to_lowercase();
    if query.is_empty() {
        return Err("query is required".into());
    }
    let limit = limit_arg(args);
    let mut hits = Vec::new();
    'outer: for meeting in meetings {
        for turn in meeting
            .get("transcript")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let text = str_of(turn, "text");
            let lower = text.to_lowercase();
            if let Some(at) = lower
                .find(&query)
                .filter(|at| text.is_char_boundary(*at) && text.is_char_boundary(at + query.len()))
            {
                hits.push(format!(
                    "- {} — {} · {}: “{}” (meeting id: {})",
                    date_of(meeting),
                    str_of(meeting, "title"),
                    str_of(turn, "speaker"),
                    snippet(text, at, query.len()),
                    str_of(meeting, "id")
                ));
                if hits.len() >= limit {
                    break 'outer;
                }
            }
        }
    }
    Ok(if hits.is_empty() {
        format!("Nothing in any transcript matches “{query}”.")
    } else {
        hits.join("\n")
    })
}

fn list_action_items(meetings: &[Value], args: &Value, now_ms: i64) -> String {
    let days = args
        .get("days")
        .and_then(Value::as_i64)
        .filter(|d| *d > 0)
        .unwrap_or(14);
    let since = now_ms - days * 86_400_000;
    let owner = str_of(args, "owner").trim().to_lowercase();
    let mut rows = Vec::new();
    for meeting in meetings
        .iter()
        .filter(|m| m.get("startedAt").and_then(Value::as_i64).unwrap_or(0) >= since)
    {
        let notes = MeetingNotes::from_meeting(meeting);
        for item in &notes.action_items {
            let who = item.owner.as_deref().unwrap_or("unassigned");
            if !owner.is_empty() && !who.to_lowercase().contains(&owner) {
                continue;
            }
            rows.push(format!(
                "- {} (owner: {who}, due: {}) — from “{}” on {}",
                item.task,
                item.deadline.as_deref().unwrap_or("none"),
                notes.title,
                notes.date
            ));
        }
    }
    if rows.is_empty() {
        format!("No action items in the last {days} days.")
    } else {
        rows.join("\n")
    }
}

fn call_tool(params: &Value, meetings: &[Value], now_ms: i64) -> Value {
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let result = match str_of(params, "name") {
        "list_meetings" => Ok(list_meetings(meetings, &args)),
        "get_meeting" => find(meetings, &args).map(meeting_notes),
        "get_transcript" => find(meetings, &args).map(transcript),
        "search_transcripts" => search_transcripts(meetings, &args),
        "list_action_items" => Ok(list_action_items(meetings, &args, now_ms)),
        other => Err(format!("Unknown tool: {other}")),
    };
    match result {
        Ok(text) => json!({"content": [{"type": "text", "text": text}], "isError": false}),
        Err(text) => json!({"content": [{"type": "text", "text": text}], "isError": true}),
    }
}

fn reply(id: &Value, result: Result<Value, (i64, String)>) -> Value {
    match result {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err((code, message)) => {
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
        }
    }
}

pub fn handle_message(
    message: &Value,
    meetings: &[Value],
    version: &str,
    now_ms: i64,
) -> Option<Value> {
    let id = message.get("id").cloned()?;
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = match str_of(message, "method") {
        "initialize" => {
            let asked = str_of(&params, "protocolVersion");
            let protocol = if PROTOCOL_VERSIONS.contains(&asked) {
                asked
            } else {
                PROTOCOL_VERSIONS[0]
            };
            Ok(json!({
                "protocolVersion": protocol,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": "kesami", "title": "Kesami meetings", "version": version},
                "instructions": "Read-only access to the user's recorded Kesami meetings. Use list_meetings or search_transcripts to find a meeting, then get_meeting for notes or get_transcript for the full conversation."
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools()})),
        "tools/call" => Ok(call_tool(&params, meetings, now_ms)),
        "resources/list" => Ok(json!({"resources": []})),
        "prompts/list" => Ok(json!({"prompts": []})),
        method => Err((-32601, format!("Method not found: {method}"))),
    };
    Some(reply(&id, result))
}

pub fn handle(
    body: &[u8],
    load_meetings: impl FnOnce() -> Vec<Value>,
    version: &str,
    now_ms: i64,
) -> Option<Value> {
    let parsed: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => return Some(reply(&Value::Null, Err((-32700, "Parse error".into())))),
    };
    let calls_tool = |message: &Value| str_of(message, "method") == "tools/call";
    let wants_meetings = match &parsed {
        Value::Array(batch) => batch.iter().any(calls_tool),
        message => calls_tool(message),
    };
    let meetings = if wants_meetings { load_meetings() } else { Vec::new() };
    let meetings = meetings.as_slice();
    match parsed {
        Value::Array(batch) => {
            let replies: Vec<Value> = batch
                .iter()
                .filter_map(|m| handle_message(m, meetings, version, now_ms))
                .collect();
            (!replies.is_empty()).then_some(Value::Array(replies))
        }
        message if message.is_object() => handle_message(&message, meetings, version, now_ms),
        _ => Some(reply(&Value::Null, Err((-32600, "Invalid Request".into())))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_789_100_000_000;

    fn meetings() -> Vec<Value> {
        vec![
            json!({
                "id": "m2",
                "title": "Pricing review",
                "startedAt": NOW - 86_400_000,
                "durationSeconds": 1200,
                "summaryMarkdown": "Pro stays at ₹599.",
                "keyDecisions": ["Keep ₹599"],
                "actionItems": [{"task": "Update the pricing page", "owner": "Riyam", "deadline": "TBD"}],
                "metadata": {},
                "transcript": [
                    {"speaker": "Riyam", "startMs": 5000, "text": "I think the Razorpay checkout is fine."},
                    {"speaker": "Aditi", "startMs": 65000, "text": "Let's keep ₹599 for Pro."}
                ]
            }),
            json!({
                "id": "m1",
                "title": "Old sync",
                "startedAt": NOW - 40 * 86_400_000,
                "durationSeconds": 600,
                "summaryMarkdown": "",
                "actionItems": [{"task": "Archive the old deck", "owner": "Aditi"}],
                "metadata": {},
                "transcript": []
            }),
        ]
    }

    fn call(name: &str, arguments: Value) -> Value {
        let message = json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": name, "arguments": arguments}});
        handle(message.to_string().as_bytes(), meetings, "test", NOW).unwrap()["result"].clone()
    }

    fn text(result: &Value) -> String {
        result["content"][0]["text"].as_str().unwrap().to_string()
    }

    #[test]
    fn initialize_negotiates_a_supported_version() {
        let init = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}});
        let out = handle(init.to_string().as_bytes(), Vec::new, "2.0.0", NOW).unwrap();
        assert_eq!(out["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(out["result"]["serverInfo"]["name"], "kesami");
        let future = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2099-01-01"}});
        assert_eq!(
            handle(future.to_string().as_bytes(), Vec::new, "2.0.0", NOW).unwrap()["result"]
                ["protocolVersion"],
            PROTOCOL_VERSIONS[0]
        );
    }

    #[test]
    fn notifications_get_no_reply_and_unknown_methods_error() {
        let note = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        assert!(handle(note.to_string().as_bytes(), Vec::new, "t", NOW).is_none());
        let unknown = json!({"jsonrpc": "2.0", "id": 2, "method": "sampling/createMessage"});
        assert_eq!(
            handle(unknown.to_string().as_bytes(), Vec::new, "t", NOW).unwrap()["error"]["code"],
            -32601
        );
        assert_eq!(
            handle(b"{not json", Vec::new, "t", NOW).unwrap()["error"]["code"],
            -32700
        );
    }

    #[test]
    fn tools_are_listed() {
        let list = json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list"});
        let out = handle(list.to_string().as_bytes(), Vec::new, "t", NOW).unwrap();
        let names: Vec<&str> = out["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "list_meetings",
                "get_meeting",
                "get_transcript",
                "search_transcripts",
                "list_action_items"
            ]
        );
    }

    #[test]
    fn meetings_can_be_listed_filtered_and_read() {
        assert!(text(&call("list_meetings", json!({}))).contains("id: m1"));
        let filtered = text(&call("list_meetings", json!({"query": "razorpay"})));
        assert!(filtered.contains("Pricing review") && !filtered.contains("Old sync"));
        let notes = text(&call("get_meeting", json!({"id": "m2"})));
        assert!(
            notes.contains("## Decisions")
                && notes.contains("Update the pricing page (owner: Riyam, due: none)")
        );
        let missing = call("get_meeting", json!({"id": "nope"}));
        assert_eq!(missing["isError"], true);
    }

    #[test]
    fn transcripts_are_timestamped_and_searchable() {
        let transcript = text(&call("get_transcript", json!({"id": "m2"})));
        assert!(transcript.contains("[01:05] Aditi: Let's keep ₹599 for Pro."));
        let hits = text(&call("search_transcripts", json!({"query": "₹599"})));
        assert!(hits.contains("Aditi") && hits.contains("meeting id: m2"));
        assert_eq!(call("search_transcripts", json!({}))["isError"], true);
    }

    #[test]
    fn action_items_respect_the_window_and_owner() {
        let recent = text(&call("list_action_items", json!({})));
        assert!(recent.contains("Update the pricing page") && !recent.contains("Archive"));
        let all = text(&call(
            "list_action_items",
            json!({"days": 60, "owner": "aditi"}),
        ));
        assert!(all.contains("Archive the old deck") && !all.contains("pricing page"));
    }
}
