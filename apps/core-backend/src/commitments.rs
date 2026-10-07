//! Conservative, local commitment candidates. Detection is never confirmation.
use crate::{memory, Meeting};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MAX_CANDIDATES: usize = 100;
const MAX_BYTES: usize = 2_000_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub classification: String,
    pub person: String,
    pub speaker: String,
    pub commitment: String,
    pub target_action: String,
    pub due_date: String,
    pub references: Vec<Value>,
    pub confidence: String,
    pub confidence_reason: String,
    pub source_turn_ids: Vec<String>,
    pub start_ms: i64,
    pub status: String,
    #[serde(default)]
    pub action_item_id: Option<String>,
    #[serde(default)]
    pub reviewed_person: Option<String>,
    #[serde(default)]
    pub reviewed_action: Option<String>,
}

/// Return a source slice after a cue, never offsets into Unicode-normalized text.
fn after_cue<'a>(text: &'a str, cues: &[&str]) -> Option<&'a str> {
    let lower = text.to_ascii_lowercase();
    cues.iter()
        .filter_map(|cue| {
            lower.match_indices(cue).find_map(|(at, _)| {
                let boundary = at == 0 || !lower[..at].chars().next_back()?.is_alphanumeric();
                boundary.then_some((at, cue.len()))
            })
        })
        .min_by_key(|(at, _)| *at)
        .map(|(at, len)| text[at + len..].trim())
}

fn concrete_action(action: &str) -> bool {
    let lower = action.to_ascii_lowercase();
    if ["get ", "look ", "take "]
        .iter()
        .any(|cue| lower.starts_with(cue))
    {
        return [
            "get back ",
            "get approval ",
            "look into ",
            "look at ",
            "take ownership ",
            "take responsibility ",
        ]
        .iter()
        .any(|cue| lower.starts_with(cue));
    }
    let first = action
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        first.as_str(),
        "send"
            | "check"
            | "schedule"
            | "create"
            | "review"
            | "follow"
            | "call"
            | "share"
            | "deliver"
            | "update"
            | "investigate"
            | "confirm"
            | "prepare"
            | "book"
            | "contact"
            | "ask"
            | "fix"
            | "test"
            | "submit"
            | "write"
            | "provide"
            | "arrange"
            | "discuss"
            | "research"
            | "build"
            | "implement"
            | "publish"
            | "email"
            | "reach"
            | "organize"
            | "coordinate"
            | "upload"
            | "complete"
            | "verify"
            | "connect"
            | "sign"
            | "draft"
            | "set"
            | "look"
            | "take"
            | "handle"
            | "get"
    ) && action.split_whitespace().count() > 1
}

fn has_word(text: &str, words: &[&str]) -> bool {
    text.split(|c: char| !c.is_alphanumeric() && c != '\'')
        .any(|word| words.contains(&word))
}

fn contains_label(text: &str, label: &str) -> bool {
    let text = memory::normalize(text);
    let label = memory::normalize(label);
    !label.is_empty()
        && text.match_indices(&label).any(|(i, _)| {
            (i == 0
                || !text[..i]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_alphanumeric))
                && !text[i + label.len()..]
                    .chars()
                    .next()
                    .is_some_and(char::is_alphanumeric)
        })
}

/// Dates stay exactly as spoken; no timezone or relative-date guesses.
fn due_date(action: &str) -> String {
    let words: Vec<_> = action.split_whitespace().collect();
    for (i, word) in words.iter().enumerate() {
        let token = word
            .trim_matches(|c: char| matches!(c, '.' | ',' | '!' | '?' | ';'))
            .to_ascii_lowercase();
        let previous = i
            .checked_sub(1)
            .and_then(|n| words.get(n))
            .map(|s| s.to_ascii_lowercase());
        if previous
            .as_deref()
            .is_some_and(|s| matches!(s, "from" | "last" | "about" | "since" | "of" | "dated"))
        {
            continue;
        }
        let tail = i + 1 == words.len();
        let temporal = previous
            .as_deref()
            .is_some_and(|s| matches!(s, "by" | "on" | "before" | "until"));
        if matches!(token.as_str(), "tomorrow" | "today" | "tonight") {
            if tail || temporal {
                return word.trim_end_matches(['.', ',', '!', '?', ';']).into();
            }
            if words.get(i + 1).is_some_and(|s| {
                matches!(
                    s.trim_end_matches(['.', ',', '!', '?', ';'])
                        .to_ascii_lowercase()
                        .as_str(),
                    "morning" | "afternoon" | "evening"
                )
            }) {
                return format!(
                    "{} {}",
                    word,
                    words[i + 1].trim_end_matches(['.', ',', '!', '?', ';'])
                );
            }
        }
        let next = words.get(i + 1).map(|s| {
            s.trim_end_matches(['.', ',', '!', '?', ';'])
                .to_ascii_lowercase()
        });
        let weekday = |s: &str| {
            matches!(
                s,
                "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday"
            )
        };
        if matches!(token.as_str(), "next" | "this")
            && next
                .as_deref()
                .is_some_and(|s| weekday(s) || matches!(s, "week" | "month"))
        {
            return format!(
                "{} {}",
                word,
                words[i + 1].trim_end_matches(['.', ',', '!', '?', ';'])
            );
        }
        if weekday(&token) && (tail || temporal) {
            return word.trim_end_matches(['.', ',', '!', '?', ';']).into();
        }
        if matches!(
            token.as_str(),
            "january"
                | "february"
                | "march"
                | "april"
                | "may"
                | "june"
                | "july"
                | "august"
                | "september"
                | "october"
                | "november"
                | "december"
        ) {
            let day = next.as_deref().unwrap_or("");
            let digits: String = day.chars().take_while(char::is_ascii_digit).collect();
            let suffix = &day[digits.len()..];
            if digits.parse::<u8>().is_ok_and(|n| (1..=31).contains(&n))
                && matches!(suffix, "" | "st" | "nd" | "rd" | "th")
            {
                let year = words
                    .get(i + 2)
                    .map(|s| s.trim_end_matches(['.', ',', '!', '?', ';']));
                let has_year =
                    year.is_some_and(|s| s.len() == 4 && s.chars().all(|c| c.is_ascii_digit()));
                if temporal || i + if has_year { 3 } else { 2 } == words.len() {
                    return words[i..i + if has_year { 3 } else { 2 }]
                        .join(" ")
                        .trim_end_matches(['.', ',', '!', '?', ';'])
                        .into();
                }
            }
        }
        if token == "in"
            && words.get(i + 2).is_some_and(|s| {
                matches!(
                    s.trim_end_matches(['.', ',', '!', '?', ';'])
                        .to_ascii_lowercase()
                        .as_str(),
                    "hours" | "days" | "weeks"
                )
            })
            && next.as_deref().is_some_and(|s| {
                matches!(s, "two" | "three" | "four" | "five" | "six" | "seven")
                    || s.parse::<u16>().is_ok()
            })
        {
            return words[i..i + 3]
                .join(" ")
                .trim_end_matches(['.', ',', '!', '?', ';'])
                .into();
        }
        // Explicit ISO dates are unambiguous lexical dates, still not inferred.
        if (tail || temporal)
            && token.len() == 10
            && token.as_bytes()[4] == b'-'
            && token.as_bytes()[7] == b'-'
            && token
                .chars()
                .enumerate()
                .all(|(n, c)| n == 4 || n == 7 || c.is_ascii_digit())
        {
            return word.trim_end_matches(['.', ',', '!', '?', ';']).into();
        }
    }
    String::new()
}

/// Classification is intentionally conservative. Reported commitments do not
/// establish that the named third party actually agreed in this meeting.
fn classify(text: &str, speaker: &str) -> Option<(String, String, String, String, String)> {
    let lower = text.to_ascii_lowercase().replace('’', "'");
    let own = after_cue(
        text,
        &["i'll ", "i’ll ", "i will ", "i commit to ", "i promise to "],
    );
    let suggestion = after_cue(
        text,
        &[
            "let's ",
            "let’s ",
            "we should ",
            "we could ",
            "you should ",
            "could you ",
            "can you ",
        ],
    );
    let tentative = after_cue(
        text,
        &[
            "i might ",
            "i may ",
            "i could ",
            "i should ",
            "i'll try to ",
            "i’ll try to ",
            "i will try to ",
        ],
    );
    let unresolved = after_cue(
        text,
        &[
            "we will ",
            "we'll ",
            "we’ll ",
            "he will ",
            "she will ",
            "they will ",
        ],
    );
    let (reported_person, reported_action) = [" will ", " promised to ", " committed to "]
        .iter()
        .find_map(|cue| {
            let at = text.to_ascii_lowercase().find(cue)?;
            let subject = text[..at].trim();
            // A bare named subject; never resolve he/she/we to an identity.
            if subject.is_empty()
                || subject.split_whitespace().count() > 4
                || matches!(
                    subject.to_ascii_lowercase().as_str(),
                    "i" | "we" | "he" | "she" | "they" | "it" | "you"
                )
                || subject.split_whitespace().next().is_some_and(|s| {
                    matches!(
                        s.to_ascii_lowercase().as_str(),
                        "the" | "a" | "this" | "that" | "our" | "your"
                    )
                })
                || !subject.chars().next()?.is_uppercase()
            {
                return None;
            }
            Some((subject.to_string(), text[at + cue.len()..].trim()))
        })
        .unwrap_or_default();
    let action = own
        .or(suggestion)
        .or(tentative)
        .or(unresolved)
        .or((!reported_action.is_empty()).then_some(reported_action))?;
    let quoted = text.contains(['"', '“', '”', '‘', '`'])
        || lower.contains("'i'll ")
        || lower.contains("'i will ")
        || lower.contains("for example")
        || lower.contains("e.g.")
        || has_word(&lower, &["said", "says", "example"]);
    let hypothetical = has_word(
        &lower,
        &[
            "if",
            "unless",
            "maybe",
            "perhaps",
            "hypothetically",
            "assuming",
            "would",
        ],
    ) || lower.contains("not sure")
        || lower.contains("depending on")
        || lower.contains("as long as");
    let negative = lower.contains("won't")
        || lower.contains("will not")
        || lower.contains("can't")
        || lower.contains("cannot")
        || lower.contains("don't")
        || lower.contains("not going to");
    let action = action
        .trim_end_matches(['.', '!', '?', ';'])
        .trim()
        .to_string();
    if hypothetical || negative || quoted {
        return Some((
            "discussion".into(),
            String::new(),
            action,
            "low".into(),
            "Conditional, negated, quoted or hypothetical speech does not establish a promise."
                .into(),
        ));
    }
    if text.contains('?') || suggestion.is_some() {
        return Some((
            "suggested_action".into(),
            String::new(),
            action,
            "medium".into(),
            "A suggestion or request has no accepted owner yet.".into(),
        ));
    }
    if tentative.is_some()
        || unresolved.is_some()
        || !concrete_action(&action)
        || lower.contains("i think")
        || lower.contains("i guess")
        || lower.contains("i hope")
        || lower.contains("i wish")
        || lower.contains("i suppose")
        || lower.contains("i predict")
        || has_word(&lower, &["probably", "possibly", "hopefully"])
        || lower.contains("not saying")
        || lower.contains("not promising")
    {
        return Some((
            "unclear".into(),
            String::new(),
            action,
            "low".into(),
            "Future language lacks an unambiguous promise to perform a concrete action.".into(),
        ));
    }
    if own.is_some() {
        let unknown = speaker.trim().is_empty()
            || matches!(memory::normalize(speaker).as_str(), "others" | "unknown")
            || memory::normalize(speaker).starts_with("speaker");
        return Some((
            "explicit_commitment".into(),
            speaker.into(),
            action,
            if unknown { "medium" } else { "high" }.into(),
            if unknown {
                "Explicit first-person promise; speaker identity needs review."
            } else {
                "Explicit first-person promise with a concrete action; review the speaker label."
            }
            .into(),
        ));
    }
    Some(("other_person_commitment".into(), reported_person, action, "medium".into(),
        "A speaker reports another person's promise; their agreement is not independently established.".into()))
}

pub fn current(meeting: &Meeting) -> bool {
    meeting.metadata["meetingCommitments"]["transcriptRevision"].as_str()
        == Some(memory::transcript_revision(meeting).as_str())
        && meeting.metadata["meetingCommitments"]["version"] == 1
}

pub fn candidates(meeting: &Meeting) -> Vec<Candidate> {
    if !current(meeting) {
        return vec![];
    }
    serde_json::from_value(meeting.metadata["meetingCommitments"]["candidates"].clone())
        .unwrap_or_default()
}

pub fn detect(meeting: &mut Meeting) {
    let old = candidates(meeting);
    let entities = memory::entities(meeting);
    let mut result = vec![];
    let mut bytes = 0;
    let mut partial = false;
    'turns: for turn in &meeting.transcript {
        if turn.text.len() > MAX_BYTES {
            partial = true;
            continue;
        }
        let contextual_discussion =
            classify(&turn.text, &turn.speaker).is_some_and(|v| v.0 == "discussion");
        for sentence in turn.text.split_inclusive(['.', '!', '?', ';', '\n']) {
            bytes += sentence.len();
            if bytes > MAX_BYTES || result.len() >= MAX_CANDIDATES {
                partial = true;
                break 'turns;
            }
            let quote = sentence.trim();
            if quote.len() > 1000 {
                partial = true;
                continue;
            }
            let Some((mut classification, mut person, action, mut confidence, mut reason)) =
                classify(quote, &turn.speaker)
            else {
                continue;
            };
            // Keep surrounding utterance context: sentence splitting must not
            // turn a quoted example or preceding condition into a real promise.
            if contextual_discussion {
                classification = "discussion".into();
                person.clear();
                confidence = "low".into();
                reason = "Surrounding utterance is conditional, negated or quoted; review the full transcript.".into();
            }
            if classification == "other_person_commitment"
                && !entities.iter().any(|(kind, name)| {
                    kind == "person" && memory::normalize(name) == memory::normalize(&person)
                })
                && !quote.to_ascii_lowercase().contains("promised to")
                && !quote.to_ascii_lowercase().contains("committed to")
            {
                classification = "unclear".into();
                person.clear();
                confidence = "low".into();
                reason = "A future statement about an unidentified subject does not establish a person's promise.".into();
            }
            let id = format!(
                "commitment-{:x}",
                Sha256::digest(json!([turn.id, turn.speaker, quote]).to_string().as_bytes())
            );
            if result.iter().any(|c: &Candidate| c.id == id) {
                continue;
            }
            let date = due_date(&action);
            let mut target_action = action.clone();
            // Strip a trailing date from the task label only, retaining the full quote.
            if !date.is_empty() && action.ends_with(&date) {
                target_action = action[..action.len() - date.len()].trim_end().to_string();
                for preposition in [" on", " by"] {
                    if target_action.ends_with(preposition) {
                        target_action.truncate(target_action.len() - preposition.len());
                    }
                }
            }
            let references = entities
                .iter()
                .filter(|(kind, name)| {
                    matches!(kind.as_str(), "company" | "project") && contains_label(quote, name)
                })
                .map(|(kind, name)| json!({"kind":kind,"name":name}))
                .collect();
            let mut candidate = Candidate {
                id,
                classification,
                person,
                speaker: turn.speaker.clone(),
                commitment: quote.into(),
                target_action,
                due_date: date,
                references,
                confidence,
                confidence_reason: reason,
                source_turn_ids: vec![turn.id.clone()],
                start_ms: turn.start_ms,
                status: "pending".into(),
                action_item_id: None,
                reviewed_person: None,
                reviewed_action: None,
            };
            if let Some(previous) = old.iter().find(|c| c.id == candidate.id) {
                candidate.status = previous.status.clone();
                candidate.action_item_id = previous.action_item_id.clone();
                candidate.reviewed_person = previous.reviewed_person.clone();
                candidate.reviewed_action = previous.reviewed_action.clone();
            }
            result.push(candidate);
        }
    }
    if !meeting.metadata.is_object() {
        meeting.metadata = json!({});
    }
    meeting.metadata["meetingCommitments"] = json!({
        "version":1, "detectorVersion":1, "transcriptRevision":memory::transcript_revision(meeting),
        "coverage":if partial { "partial" } else { "complete" }, "candidates":result,
    });
}

pub fn review(meeting: &mut Meeting, id: &str, body: &Value) -> Result<(), (u16, String)> {
    if !current(meeting)
        || body["transcriptRevision"].as_str()
            != Some(memory::transcript_revision(meeting).as_str())
    {
        return Err((
            409,
            "The transcript changed. Detect commitments again before reviewing.".into(),
        ));
    }
    let mut values = candidates(meeting);
    let candidate = values
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or((404, "Commitment not found".into()))?;
    let status = body["status"]
        .as_str()
        .ok_or((400, "Choose confirm or dismiss".into()))?;
    if candidate.status != "pending" {
        if candidate.status == status {
            return Ok(());
        }
        return Err((409, "This statement was already reviewed.".into()));
    }
    match status {
        "dismissed" => candidate.status = "dismissed".into(),
        "confirmed" => {
            if !matches!(
                candidate.classification.as_str(),
                "explicit_commitment" | "other_person_commitment" | "suggested_action"
            ) {
                return Err((
                    400,
                    "Discussion and unclear statements cannot be confirmed as commitments.".into(),
                ));
            }
            let person = body["person"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty() && s.len() <= 200)
                .ok_or((400, "Review and name the person responsible.".into()))?;
            let label = memory::normalize(person);
            if matches!(
                label.as_str(),
                "others" | "unknown" | "we" | "they" | "unassigned"
            ) || label.starts_with("speaker")
            {
                return Err((
                    400,
                    "Replace the provisional speaker label with a reviewed owner.".into(),
                ));
            }
            let action = body["targetAction"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty() && s.len() <= 1000)
                .ok_or((400, "Review the target action.".into()))?;
            let task_id = candidate.id.clone();
            let revision = memory::transcript_revision(meeting);
            let existing = meeting.action_items.iter_mut().find(|v| {
                v["commitmentId"] == id
                    || (memory::normalize(v["task"].as_str().unwrap_or(""))
                        == memory::normalize(action)
                        && memory::normalize(v["owner"].as_str().unwrap_or(""))
                            == memory::normalize(person))
            });
            let mut task = json!({"id":task_id,"task":action,"owner":person,"deadline":candidate.due_date,
                "completed":false,"commitmentId":id,"sourceTurnIds":candidate.source_turn_ids,
                "sourceQuote":candidate.commitment,"sourceTranscriptRevision":revision,
                "confirmation":"human_reviewed","commitmentClassification":candidate.classification});
            if let Some(existing) = existing {
                if let Some(id) = existing.get("id").filter(|v| v.is_string()) {
                    task["id"] = id.clone();
                }
                if let Some(completed) = existing.get("completed").filter(|v| v.is_boolean()) {
                    task["completed"] = completed.clone();
                }
                *existing = task.clone();
            } else {
                meeting.action_items.push(task.clone());
            }
            candidate.action_item_id = task["id"].as_str().map(str::to_string);
            candidate.reviewed_person = Some(person.into());
            candidate.reviewed_action = Some(action.into());
            candidate.status = "confirmed".into();
        }
        _ => return Err((400, "Choose confirmed or dismissed".into())),
    }
    meeting.metadata["meetingCommitments"]["candidates"] = json!(values);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_promises_and_dates() {
        for (text, expected) in [
            ("I'll send the proposal tomorrow.", "tomorrow"),
            ("I’ll check this with engineering.", ""),
            ("I'll create the Jira ticket.", ""),
            ("I will send the API proposal on Friday.", "Friday"),
            (
                "I promise to submit the proposal by 2026-10-10.",
                "2026-10-10",
            ),
            (
                "I'll send the proposal by October 10, 2026.",
                "October 10, 2026",
            ),
            ("I will check this on October 10th.", "October 10th"),
            ("I'll send the proposal in two days.", "in two days"),
        ] {
            let (kind, person, action, confidence, _) = classify(text, "Riyam").unwrap();
            assert_eq!(kind, "explicit_commitment", "{text}");
            assert_eq!(person, "Riyam");
            assert_eq!(confidence, "high");
            assert_eq!(due_date(&action), expected);
        }
    }

    #[test]
    fn suggestions_reports_and_unknown_speakers_are_distinct() {
        for text in [
            "Let's schedule a follow-up next Tuesday.",
            "We should create a Jira ticket.",
            "Can you send the proposal?",
            "I'll send the proposal?",
        ] {
            let (kind, person, _, _, _) = classify(text, "Riyam").unwrap();
            assert_eq!(kind, "suggested_action", "{text}");
            assert!(person.is_empty());
        }
        assert_eq!(
            due_date("schedule a follow-up next Tuesday"),
            "next Tuesday"
        );
        let (kind, person, _, confidence, _) =
            classify("John will send the proposal tomorrow.", "Riyam").unwrap();
        assert_eq!(kind, "other_person_commitment");
        assert_eq!(person, "John");
        assert_eq!(confidence, "medium");
        assert_eq!(
            classify("I'll send the proposal.", "Speaker 2").unwrap().3,
            "medium"
        );
    }

    #[test]
    fn false_positives_and_ambiguous_language_never_become_promises() {
        for text in [
            "If they agree, I'll send the proposal.",
            "I'll send the proposal if approved.",
            "Maybe I will create the ticket.",
            "I'll send it unless engineering objects.",
            "I'll send it, but I can't promise.",
            "I will not send the proposal.",
            "For example, I'll send a proposal tomorrow.",
            "John said I'll create the ticket.",
            "The example says: ‘I'll send the proposal’.",
            "\"I'll send the proposal\" is a useful example.",
            "'I'll send the proposal.'",
            "‘I'll send the proposal.’",
            "I might send the proposal.",
            "I'll try to send the proposal.",
            "I will be on holiday tomorrow.",
            "I will think about it.",
            "I will rain tomorrow.",
            "I think I'll send the proposal.",
            "I hope I will create the ticket.",
            "I'm not promising I'll send it.",
            "I'll get a raise tomorrow.",
            "I'll look younger next week.",
            "I'll send the proposal, hopefully.",
        ] {
            assert!(
                classify(text, "Riyam").is_none_or(|v| !matches!(
                    v.0.as_str(),
                    "explicit_commitment" | "other_person_commitment"
                )),
                "{text}"
            );
        }
        for text in [
            "The API will be faster next week.",
            "We will probably need more engineers.",
            "The customer might complain.",
            "He will send it.",
            "Je vais envoyer le document.",
        ] {
            assert!(
                classify(text, "Riyam").is_none_or(|v| v.0 == "unclear"),
                "{text}"
            );
        }
        assert_eq!(due_date("send tomorrow's meeting notes"), "");
        assert_eq!(due_date("check with engineering soon"), "");
        assert_eq!(due_date("send the Friday report"), "");
        assert_eq!(due_date("send the report from Friday"), "");
        assert_eq!(due_date("send the report dated October 10"), "");
    }

    fn meeting(text: &str) -> Meeting {
        serde_json::from_value(json!({"id":"test","title":"Test","startedAt":0,"endedAt":1,
            "durationSeconds":1,"summaryMarkdown":"","keyDecisions":[],"actionItems":[],"metadata":{},"createdAt":0,
            "transcript":[{"id":"t1","speaker":"Riyam","channel":"mic","startMs":500,"endMs":1000,"confidence":1,"text":text}]})).unwrap()
    }

    fn confirm(meeting: &mut Meeting, item: &Candidate) -> Result<(), (u16, String)> {
        review(
            meeting,
            &item.id,
            &json!({"status":"confirmed","transcriptRevision":memory::transcript_revision(meeting),"person":"Riyam","targetAction":item.target_action}),
        )
    }

    #[test]
    fn source_grounding_review_idempotency_and_completion_survive_redetection() {
        let mut m = meeting("I'll send the proposal tomorrow.");
        detect(&mut m);
        let item = candidates(&m).remove(0);
        assert_eq!(item.source_turn_ids, ["t1"]);
        assert_eq!(item.start_ms, 500);
        assert!(m.transcript[0].text.contains(&item.commitment));
        assert_eq!(item.target_action, "send the proposal");
        assert_eq!(item.due_date, "tomorrow");
        assert!(m.action_items.is_empty());
        confirm(&mut m, &item).unwrap();
        confirm(&mut m, &item).unwrap();
        assert_eq!(m.action_items.len(), 1);
        assert_eq!(m.action_items[0]["confirmation"], "human_reviewed");
        assert_eq!(m.action_items[0]["sourceTurnIds"], json!(["t1"]));
        m.action_items[0]["completed"] = json!(true);
        detect(&mut m);
        assert_eq!(candidates(&m)[0].status, "confirmed");
        assert_eq!(m.action_items[0]["completed"], true);
        let regenerated = memory::merge_actions(
            &m.action_items,
            &[json!({"task":"Send the proposal","owner":"Riyam","deadline":"Monday"})],
        );
        assert_eq!(regenerated[0], m.action_items[0]);
        m.transcript[0].speaker = "John".into();
        assert!(candidates(&m).is_empty());
        assert_eq!(confirm(&mut m, &item).unwrap_err().0, 409);
        detect(&mut m);
        assert_eq!(candidates(&m)[0].person, "John");
        assert_eq!(candidates(&m)[0].status, "pending");
        assert_eq!(
            m.action_items.len(),
            1,
            "confirmed user tasks survive source edits"
        );
    }

    #[test]
    fn review_requires_an_owner_and_rejects_discussion_and_unclear_statements() {
        for text in [
            "If approved, I'll send the proposal.",
            "I might send the proposal.",
        ] {
            let mut m = meeting(text);
            detect(&mut m);
            let item = candidates(&m).remove(0);
            assert_eq!(confirm(&mut m, &item).unwrap_err().0, 400);
            assert!(m.action_items.is_empty());
        }
        let mut m = meeting("Let's schedule a follow-up next Tuesday.");
        detect(&mut m);
        let item = candidates(&m).remove(0);
        assert!(item.person.is_empty());
        for owner in ["", "Others", "Speaker 2", "we"] {
            let revision = memory::transcript_revision(&m);
            assert_eq!(review(&mut m, &item.id, &json!({"status":"confirmed","transcriptRevision":revision,"person":owner,"targetAction":item.target_action})).unwrap_err().0, 400);
        }
        confirm(&mut m, &item).unwrap();
        assert_eq!(
            m.action_items[0]["commitmentClassification"],
            "suggested_action"
        );
        assert_eq!(m.action_items[0]["deadline"], "next Tuesday");
    }

    #[test]
    fn dismissals_persist_and_only_source_supported_entities_are_used() {
        let mut m = meeting("I'll send the API proposal to Acme tomorrow.");
        let fact = memory::Fact {
            id: "company".into(),
            kind: "company".into(),
            name: "Acme".into(),
            quote: m.transcript[0].text.clone(),
            source_turn_ids: vec!["t1".into()],
            owner: String::new(),
            date: String::new(),
        };
        memory::persist(&mut m, &[fact], "gemini");
        detect(&mut m);
        let item = candidates(&m).remove(0);
        assert_eq!(item.references, [json!({"kind":"company","name":"Acme"})]);
        let revision = memory::transcript_revision(&m);
        review(
            &mut m,
            &item.id,
            &json!({"status":"dismissed","transcriptRevision":revision}),
        )
        .unwrap();
        detect(&mut m);
        assert_eq!(candidates(&m)[0].status, "dismissed");
        assert!(m.action_items.is_empty());
        assert_eq!(confirm(&mut m, &item).unwrap_err().0, 409);
    }

    #[test]
    fn sentence_boundaries_keep_hypothetical_context_and_detection_is_bounded() {
        for text in [
            "If approved; I'll send the proposal.",
            "For example. I'll create the Jira ticket.",
        ] {
            let mut m = meeting(text);
            detect(&mut m);
            assert!(candidates(&m)
                .iter()
                .all(|c| c.classification == "discussion"));
        }
        let mut m = meeting("I'll send José the proposal tomorrow.");
        detect(&mut m);
        assert_eq!(candidates(&m)[0].target_action, "send José the proposal");
        m.transcript[0].text = (0..102)
            .map(|i| format!("I'll create ticket {i}. "))
            .collect();
        detect(&mut m);
        assert_eq!(candidates(&m).len(), 100);
        assert_eq!(m.metadata["meetingCommitments"]["coverage"], "partial");
        let mut m = meeting("Kesami will send a report tomorrow.");
        detect(&mut m);
        assert_eq!(
            candidates(&m)[0].classification,
            "unclear",
            "software is not a person promising work"
        );
        assert!(contains_label("Send it to Acme.", "Acme"));
        assert!(!contains_label("Send it to AcmeLabs.", "Acme"));
    }
}
