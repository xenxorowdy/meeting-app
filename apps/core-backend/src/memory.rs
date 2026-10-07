//! Local, rebuildable meeting memory. JSON is authoritative; SQLite is an index.
use crate::{summarizer::SummaryRequest, Meeting};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub quote: String,
    pub source_turn_ids: Vec<String>,
    pub owner: String,
    pub date: String,
}

pub fn normalize(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn transcript_revision(meeting: &Meeting) -> String {
    let turns: Vec<_> = meeting
        .transcript
        .iter()
        .map(|t| json!([t.id, t.speaker, t.start_ms, t.text]))
        .collect();
    format!("{:x}", Sha256::digest(json!(turns).to_string().as_bytes()))
}

pub fn summary_revision(meeting: &Meeting) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            json!([transcript_revision(meeting), meeting.title, meeting.notes])
                .to_string()
                .as_bytes()
        )
    )
}

/// Model labels are candidates, never proof. Require valid references and an
/// exact quote from an individual source turn; names/owners/dates must occur there.
pub fn extract(values: &Value, request: &SummaryRequest) -> Vec<Fact> {
    let Some(items) = values.as_array() else {
        return vec![];
    };
    let mut seen = HashSet::new();
    items
        .iter()
        .take(40)
        .filter_map(|v| {
            let kind = v["kind"].as_str()?;
            if !matches!(
                kind,
                "person" | "company" | "topic" | "decision" | "commitment" | "project" | "date"
            ) {
                return None;
            }
            let name = v["name"].as_str()?.trim();
            let quote = v["quote"].as_str()?.trim();
            if name.is_empty()
                || name.len() > 300
                || quote.chars().count() < 5
                || quote.len() > 1000
            {
                return None;
            }
            let indices = v["sourceTurns"].as_array()?;
            if indices.is_empty() || indices.len() > 20 {
                return None;
            }
            let turns: Option<Vec<_>> = indices
                .iter()
                .map(|n| request.turns.get(usize::try_from(n.as_i64()?).ok()?))
                .collect();
            let turns = turns?;
            if !turns.iter().any(|t| t.text.contains(quote)) {
                return None;
            }
            let supported = |label: &str| {
                turns.iter().any(|t| {
                    normalize(&t.text).contains(&normalize(label))
                        || normalize(&t.speaker) == normalize(label)
                })
            };
            if matches!(kind, "person" | "company" | "topic" | "project" | "date")
                && !supported(name)
            {
                return None;
            }
            let owner = v["owner"].as_str().unwrap_or("").trim();
            let date = v["date"].as_str().unwrap_or("").trim();
            if owner.len() > 200
                || date.len() > 100
                || (!owner.is_empty() && !supported(owner))
                || (!date.is_empty() && !turns.iter().any(|t| t.text.contains(date)))
            {
                return None;
            }
            let source_turn_ids: Vec<_> = turns
                .iter()
                .map(|t| t.id.clone())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            let mut source_turn_ids = source_turn_ids;
            source_turn_ids.sort();
            let id = format!(
                "{:x}",
                Sha256::digest(
                    json!([kind, normalize(name), quote, owner, date, source_turn_ids])
                        .to_string()
                        .as_bytes()
                )
            );
            if !seen.insert(id.clone()) {
                return None;
            }
            Some(Fact {
                id,
                kind: kind.into(),
                name: name.into(),
                quote: quote.into(),
                source_turn_ids,
                owner: owner.into(),
                date: date.into(),
            })
        })
        .collect()
}

pub fn persist(meeting: &mut Meeting, facts: &[Fact], provider: &str) {
    let data = json!({"version":1,"transcriptRevision":transcript_revision(meeting),"status":if provider == "heuristic" { "not_extracted" } else { "extracted" },"facts":facts});
    if !meeting.metadata.is_object() {
        meeting.metadata = json!({});
    }
    meeting.metadata["meetingMemory"] = data;
}

pub fn facts(meeting: &Meeting) -> Vec<Fact> {
    let memory = &meeting.metadata["meetingMemory"];
    if memory["version"] != 1
        || memory["transcriptRevision"].as_str() != Some(transcript_revision(meeting).as_str())
    {
        return vec![];
    }
    serde_json::from_value(memory["facts"].clone()).unwrap_or_default()
}

/// Known speaker labels, not calendar invitees. Never infer a company from a name.
pub fn entities(meeting: &Meeting) -> Vec<(String, String)> {
    let mut result: Vec<_> = meeting
        .transcript
        .iter()
        .filter(|t| {
            let label = normalize(&t.speaker);
            !label.is_empty()
                && label != "others"
                && !label.starts_with("speaker ")
                && !label.starts_with("speaker_")
        })
        .map(|t| ("person".into(), t.speaker.clone()))
        .collect();
    result.extend(
        facts(meeting)
            .into_iter()
            .filter(|f| {
                matches!(
                    f.kind.as_str(),
                    "person" | "company" | "topic" | "project" | "date"
                )
            })
            .map(|f| (f.kind, f.name)),
    );
    // Topic sections from older summaries can be searched without an AI backfill.
    result.extend(meeting.topics.iter().map(|t| ("topic".into(), t.clone())));
    let mut seen = HashSet::new();
    result.retain(|(kind, name)| {
        !name.trim().is_empty() && seen.insert((kind.clone(), normalize(name)))
    });
    result
}

pub fn matches_entity(meeting: &Meeting, kind: &str, name: &str) -> bool {
    entities(meeting)
        .iter()
        .any(|(k, n)| k == kind && normalize(n) == normalize(name))
}

pub fn task_status(item: &Value) -> &'static str {
    match item["completed"].as_bool() {
        Some(true) => "completed",
        Some(false) => "open",
        None => "unknown",
    }
}

/// Preserve user-controlled completion and IDs when the same extracted task is
/// regenerated. Unmatched existing tasks remain; the user must explicitly delete them.
pub fn merge_actions(existing: &[Value], generated: &[Value]) -> Vec<Value> {
    let key = |v: &Value| {
        (
            normalize(v["task"].as_str().unwrap_or("")),
            normalize(v["owner"].as_str().unwrap_or("")),
        )
    };
    let mut result = generated.to_vec();
    for item in &mut result {
        if let Some(old) = existing.iter().find(|old| key(old) == key(item)) {
            if old["confirmation"] == "human_reviewed" {
                *item = old.clone();
                continue;
            }
            for field in ["id", "completed"] {
                if let Some(value) = old.get(field) {
                    item[field] = value.clone();
                }
            }
        }
    }
    for old in existing {
        if !result.iter().any(|new| key(new) == key(old)) {
            result.push(old.clone());
        }
    }
    for item in &mut result {
        if item.is_object() && item.get("id").is_none() {
            item["id"] = json!(format!(
                "memory-action:{:x}",
                Sha256::digest(json!(key(item)).to_string().as_bytes())
            ));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::summarizer::SummaryTurn;

    fn request() -> SummaryRequest {
        SummaryRequest {
            title: "Test".into(),
            started_at: 0,
            duration_seconds: 1,
            notes: vec![],
            attendees: vec![],
            turns: vec![SummaryTurn {
                id: "t1".into(),
                speaker: "John".into(),
                start_ms: 0,
                text: "I will send the API proposal to Acme on Friday.".into(),
            }],
        }
    }

    #[test]
    fn extraction_rejects_fabricated_quotes_entities_owners_dates_and_indices() {
        let good = json!({"kind":"commitment","name":"Send proposal","quote":"I will send the API proposal to Acme on Friday.","owner":"John","date":"Friday","sourceTurns":[0]});
        assert_eq!(
            extract(&json!([good.clone(), good.clone()]), &request()).len(),
            1
        );
        for (field, value) in [
            ("quote", json!("I will sign the contract.")),
            ("owner", json!("Alice")),
            ("date", json!("Monday")),
            ("sourceTurns", json!([99])),
            ("sourceTurns", json!([-1])),
            ("sourceTurns", json!([0, 99])),
        ] {
            let mut bad = good.clone();
            bad[field] = value;
            assert!(extract(&json!([bad]), &request()).is_empty());
        }
        let mut company = good;
        company["kind"] = json!("company");
        company["name"] = json!("Imaginary Ltd");
        assert!(extract(&json!([company.clone()]), &request()).is_empty());
        company["name"] = json!("Acme");
        assert_eq!(extract(&json!([company]), &request()).len(), 1);
    }

    #[test]
    fn regenerated_actions_preserve_completion_ids_and_manual_tasks() {
        assert_eq!(merge_actions(&[json!("Legacy task")], &[]), vec![json!("Legacy task")]);
        let old = vec![
            json!({"id":"stable","task":"Send proposal","owner":"John","completed":true}),
            json!({"id":"manual","task":"Call customer","owner":"You","completed":false}),
        ];
        let merged = merge_actions(
            &old,
            &[json!({"task":"Send proposal","owner":"John","deadline":"Friday"})],
        );
        assert_eq!(merged[0]["completed"], true);
        assert_eq!(merged[0]["id"], "stable");
        assert_eq!(merged.len(), 2);
        assert_eq!(task_status(&merged[0]), "completed");
        assert_eq!(task_status(&merged[1]), "open");
        assert_eq!(task_status(&json!({"task":"Legacy"})), "unknown");
    }
}
