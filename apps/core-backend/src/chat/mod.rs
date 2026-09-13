//! Scoped RAG and persistent conversations. Provider input is constructed only
//! from selected passages, never by serializing whole meeting records.
mod embeddings;
pub mod index;
#[cfg(test)]
mod tests;
mod threads;

use crate::{json_response, AppState, HttpRequest, Meeting, Store};
use fastembed::TextEmbedding;
use index::{revision, source_matches, Index, Passage, Result};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub struct ChatService {
    root: PathBuf,
    index: Mutex<Option<Index>>,
    model: Mutex<Option<TextEmbedding>>,
    model_status: Mutex<String>,
    active: Mutex<HashMap<String, (String, CancellationToken)>>,
    cancelled: Mutex<HashMap<(String, String), i64>>,
    permits: Arc<Semaphore>,
}

fn private_directory(path: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn private_file(path: &std::path::Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl ChatService {
    pub fn new(library: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            root: library.join(".alpha-chat"),
            index: Mutex::new(None),
            model: Mutex::new(None),
            model_status: Mutex::new("loading".into()),
            active: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashMap::new()),
            permits: Arc::new(Semaphore::new(2)),
        })
    }
    fn with_index<T>(&self, f: impl FnOnce(&mut Index) -> Result<T>) -> Result<T> {
        let mut index = self.index.lock().map_err(|_| "Search worker unavailable")?;
        if index.is_none() {
            private_directory(&self.root)?;
            let path = self.root.join("search.sqlite");
            *index = Some(Index::open(&path)?);
            private_file(&path)?;
        }
        f(index.as_mut().unwrap())
    }
    async fn db<T: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(&mut threads::Threads) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || {
            private_directory(&root)?;
            let path = root.join("threads.sqlite");
            let mut db = threads::Threads::open(&path)?;
            private_file(&path)?;
            f(&mut db)
        })
        .await
        .map_err(|_| "Conversation worker stopped".to_string())?
    }
    pub fn start(self: &Arc<Self>, store: Store, session: Arc<tokio::sync::Mutex<crate::Session>>) {
        let this = self.clone();
        // Loading/download is independent of keyword indexing and recording.
        tokio::spawn(async move {
            let result = if std::env::var("ALPHA_CHAT_EMBEDDINGS").as_deref() == Ok("off") {
                Err("disabled".to_string())
            } else {
                embeddings::load(&this.root.join("models")).await
            };
            match result {
                Ok(model) => {
                    *this.model.lock().unwrap() = Some(model);
                    *this.model_status.lock().unwrap() = "ready".into();
                }
                Err(_) => {
                    *this.model_status.lock().unwrap() = "unavailable".into();
                }
            }
        });
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                if !matches!(
                    session.lock().await.state,
                    crate::SessionState::Idle | crate::SessionState::Completed
                ) {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    continue;
                }
                let meetings: Vec<_> = store
                    .meetings
                    .read()
                    .await
                    .values()
                    .filter(|m| m.ended_at.is_some())
                    .cloned()
                    .collect();
                let service = this.clone();
                let _ = tokio::task::spawn_blocking(move || -> Result<()> {
                    service.with_index(|i| i.sync(&meetings, true))?;
                    // One bounded batch per sweep lets queries/recording make progress.
                    let pending = service.with_index(|i| i.pending_vectors(16))?;
                    if !pending.is_empty() {
                        let mut guard = service
                            .model
                            .lock()
                            .map_err(|_| "Embedding worker unavailable")?;
                        if let Some(model) = guard.as_mut() {
                            let docs: Vec<_> = pending
                                .iter()
                                .map(|p| format!("passage: {}", p.excerpt))
                                .collect();
                            let vectors = embeddings::embed(model, docs)?;
                            drop(guard);
                            service.with_index(|i| i.save_vectors(&pending, &vectors))?;
                        }
                    }
                    Ok(())
                })
                .await;
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        });
    }
}

pub fn validate_question(body: &Value) -> Result<String> {
    let question = body
        .get("question")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if question.is_empty() || question.chars().count() > 4000 || question.len() > 5000 {
        return Err("Ask a question up to 4,000 characters (5,000 UTF-8 bytes).".into());
    }
    Ok(question.into())
}

pub async fn resolve_scope(store: &Store, scope: &Value) -> Result<Vec<Meeting>> {
    let kind = scope["type"]
        .as_str()
        .ok_or("Choose a meeting, folder, or all meetings")?;
    let ids: HashSet<String> = if kind == "meetings" {
        let values = scope["meetingIds"]
            .as_array()
            .ok_or("meetingIds is required")?;
        if values.is_empty() || values.len() > 500 {
            return Err("Select between 1 and 500 meetings".into());
        }
        values
            .iter()
            .map(|v| {
                v.as_str()
                    .filter(|s| s.len() <= 200)
                    .map(str::to_string)
                    .ok_or("Invalid meeting ID".to_string())
            })
            .collect::<Result<_>>()?
    } else {
        HashSet::new()
    };
    if !matches!(kind, "meetings" | "folder" | "all") {
        return Err("Invalid chat scope".into());
    }
    if kind == "folder" {
        let folder = scope
            .get("folderId")
            .ok_or("folderId is required (null for unfiled)")?;
        if !folder.is_null() {
            let catalog = crate::workspace::folders(store, None).await?;
            if !folder.is_string()
                || !catalog["folders"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|f| f["id"] == *folder)
            {
                return Err("Folder not found".into());
            }
        }
    }
    let from = scope
        .get("fromMs")
        .map(|v| v.as_i64().ok_or("Invalid start date"))
        .transpose()?;
    let to = scope
        .get("toMs")
        .map(|v| v.as_i64().ok_or("Invalid end date"))
        .transpose()?;
    if from.zip(to).is_some_and(|(a, b)| a > b) {
        return Err("Start date must precede end date".into());
    }
    let source = store.meetings.read().await;
    if ids.iter().any(|id| !source.contains_key(id)) {
        return Err("A selected meeting no longer exists".into());
    }
    let mut meetings: Vec<_> = source
        .values()
        .filter(|m| {
            (m.ended_at.is_some() || kind == "meetings")
                && (kind != "meetings" || ids.contains(&m.id))
                && (kind != "folder"
                    || m.metadata.get("collectionId").unwrap_or(&Value::Null) == &scope["folderId"])
                && from.is_none_or(|n| m.started_at >= n)
                && to.is_none_or(|n| m.started_at <= n)
        })
        .cloned()
        .collect();
    meetings.sort_by(|a, b| {
        b.started_at
            .cmp(&a.started_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(meetings)
}

pub struct EvidencePacket {
    pub prompt: String,
    pub passages: Vec<Passage>,
}
impl EvidencePacket {
    pub fn build(
        question: &str,
        history: &[Value],
        passages: Vec<Passage>,
        coverage: &Value,
    ) -> Result<Self> {
        let mut conversation = Vec::new();
        let mut bytes = 0;
        // User turns resolve conversational references; old model answers are not evidence.
        for m in history.iter().rev().filter(|m| m["role"] == "user").take(4) {
            let text = m["content"].as_str().unwrap_or_default();
            let msg = json!({"role":"user","content":text});
            let cost = msg.to_string().len();
            if bytes + cost > 1500 {
                continue;
            }
            bytes += cost;
            conversation.push(msg);
        }
        conversation.reverse();
        let sources:Vec<_> = passages.iter().enumerate().map(|(i,p)|json!({"source":i+1,"meetingId":p.meeting_id,"title":p.title,"startedAt":p.started_at,"kind":p.source_kind,"startMs":p.start_ms,"content":p.excerpt})).collect();
        let scope_note = if coverage["live"] == true { "This meeting is in progress. Answer only from the captured transcript and notes; newer speech is not included. Say 'so far' rather than implying the meeting is complete." } else { "Use the supplied meeting evidence." };
        let mut prompt = json!({"question":question,"conversation":conversation,"sources":sources,"coverage":coverage,"scopeNote":scope_note}).to_string();
        // UTF-8 bytes conservatively upper-bound common provider tokenizers. Reserve
        // 2,000 bytes/tokens for the fixed system/schema/envelope, never split evidence.
        while prompt.len() > 8000 && !conversation.is_empty() {
            conversation.remove(0);
            prompt = json!({"question":question,"conversation":conversation,"sources":sources,"coverage":coverage,"scopeNote":scope_note}).to_string();
        }
        if prompt.len() > 8000 {
            return Err(
                "Question and evidence exceed the context budget. Shorten the question.".into(),
            );
        }
        Ok(Self { prompt, passages })
    }
    pub fn validate_answer(&self, answer: &Value) -> Result<Vec<Value>> {
        let text = answer["answer"]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.len() <= 16000)
            .ok_or("Invalid answer")?;
        let refs = answer["citations"].as_array().ok_or("Missing citations")?;
        if refs.is_empty() && answer["status"] != "insufficient_evidence" {
            return Err("The answer did not cite its evidence".into());
        }
        let mut numbers = HashSet::new();
        let mut result = Vec::new();
        for value in refs {
            let number = value
                .as_u64()
                .filter(|n| *n > 0 && *n <= self.passages.len() as u64)
                .ok_or("Invalid source reference")?;
            if !numbers.insert(number) {
                continue;
            }
            let mut citation = serde_json::to_value(&self.passages[number as usize - 1]).unwrap();
            citation["number"] = json!(number);
            citation["available"] = json!(true);
            result.push(citation);
        }
        let mut inline = HashSet::new();
        for part in text.split('[').skip(1) {
            if let Some((label, _)) = part.split_once(']') {
                if label.chars().all(|c| c.is_ascii_digit()) && !label.is_empty() {
                    let number = label
                        .parse::<u64>()
                        .map_err(|_| "Invalid inline citation")?;
                    if !numbers.contains(&number) {
                        return Err("Inline citation was not supplied".into());
                    }
                    inline.insert(number);
                }
            }
        }
        if inline != numbers {
            return Err("Every citation must appear in the answer as [1], [2], etc.".into());
        }
        Ok(result)
    }
}

async fn current(store: &Store, scope: &Value, snapshot: &[Meeting]) -> bool {
    let Ok(now) = resolve_scope(store, scope).await else {
        return false;
    };
    now.len() == snapshot.len()
        && now
            .iter()
            .zip(snapshot)
            .all(|(a, b)| a.id == b.id && source_matches(a, &revision(b)))
}

async fn answer(
    state: &AppState,
    scope: &Value,
    question: &str,
    history: &[Value],
) -> Result<Value> {
    let meetings = resolve_scope(&state.store, scope).await?;
    let live = meetings.iter().any(|meeting| meeting.ended_at.is_none());
    if meetings.is_empty() {
        return Ok(
            json!({"answer":"There are no completed meetings in this scope yet.","citations":[],"status":"insufficient_evidence","coverage":{"eligibleMeetings":0,"retrievedMeetings":0}}),
        );
    }
    let lower = question.to_lowercase();
    // Exhaustive lists are answered directly from structured records, without an LLM.
    if !live && (lower.contains("every") || lower.contains("all"))
        && (lower.contains("action item") || lower.contains("action items"))
    {
        let mut lines = vec![
            "Recorded action items (completion status is unknown unless explicitly recorded):"
                .to_string(),
        ];
        let page = lower
            .rsplit_once("page ")
            .and_then(|(_, rest)| rest.split_whitespace().next())
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(1)
            .clamp(1, 10_000);
        let offset = (page - 1) * 100;
        let mut citations = Vec::new();
        let mut total = 0;
        let mut shown = 0;
        for m in &meetings {
            for item in &m.action_items {
                total += 1;
                if total <= offset || shown >= 100 {
                    continue;
                }
                shown += 1;
                lines.push(format!("- {} [{}]", item, shown));
                citations.push(json!({"number":shown,"meetingId":m.id,"title":m.title,"sourceKind":"action","excerpt":item.to_string(),"sourceRevision":revision(m),"available":true}));
            }
        }
        if total == 0 {
            lines.push("No action items are stored in these meetings. This does not establish that none were discussed.".into());
        }
        let next_page = (total > offset + shown).then_some(page + 1);
        if offset > 0 || next_page.is_some() {
            lines.push(format!(
                "Page {page}: showing {shown} of {total} recorded items."
            ));
        }
        if !current(&state.store, scope, &meetings).await {
            return Err("Sources changed. Please retry.".into());
        }
        return Ok(
            json!({"answer":lines.join("\n\n"),"citations":citations,"status":if offset>0 || next_page.is_some() {"partial"} else {"answered"},"retrievalMode":"structured","coverage":{"eligibleMeetings":meetings.len(),"totalItems":total,"shownItems":shown,"page":page,"nextPage":next_page,"truncated":offset>0 || next_page.is_some()}}),
        );
    }
    let mut query = question.to_string();
    // Resolve short/anaphoric follow-ups from recent user context, then re-retrieve.
    if index::search_terms(question).is_empty()
        || lower.starts_with("and ")
        || ["that", "it", "they", "those"]
            .iter()
            .any(|word| lower.split_whitespace().any(|w| w == *word))
    {
        if let Some(previous) = history
            .iter()
            .rev()
            .find(|m| m["role"] == "user" && m["content"] != question)
        {
            query.push(' ');
            query.extend(
                previous["content"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .take(500),
            );
        }
    }
    let overview = ["summar", "overview", "decisions", "follow up", "follow-up"]
        .iter()
        .any(|s| lower.contains(s));
    let snapshot = meetings.clone();
    let service = state.chat.clone();
    let (passages,mode) = tokio::task::spawn_blocking(move || ->Result<_> {
        if live {
            // Live snapshots are short-lived and never compete with the
            // background completed-meeting index or its embedding jobs.
            let mut index = Index::open(std::path::Path::new(":memory:"))?;
            index.sync(&snapshot, true)?;
            return Ok((index.retrieve(&query, &snapshot, None, overview)?, "keyword"));
        }
        service.with_index(|i|i.sync(&snapshot,false))?;
        let vector = {
            let mut guard=service.model.lock().map_err(|_|"Embedding worker unavailable")?;
            guard.as_mut().and_then(|model|embeddings::embed(model,vec![format!("query: {query}")]).ok()).and_then(|mut vs|vs.pop())
        };
        let passages=service.with_index(|i|i.retrieve(&query,&snapshot,vector.as_deref(),overview))?;
        let has_vectors=service.with_index(|i|i.db.query_row("SELECT EXISTS(SELECT 1 FROM vectors v JOIN chunks c ON c.id=v.id WHERE v.model=?1 AND c.meeting_id IN (SELECT id FROM scope))",[index::MODEL_ID],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string()))?;
        let mode=if vector.is_some()&&has_vectors{"hybrid"}else{"keyword"};
        Ok((passages,mode))
    }).await.map_err(|_|"Search worker stopped")??;
    let retrieved: HashSet<_> = passages.iter().map(|p| &p.meeting_id).collect();
    let missing: Vec<_> = meetings
        .iter()
        .filter(|m| !retrieved.contains(&m.id))
        .map(|m| m.id.clone())
        .collect();
    let coverage = json!({"eligibleMeetings":meetings.len(),"retrievedMeetings":retrieved.len(),"missingMeetingIds":missing,"truncated":!missing.is_empty(),"passages":passages.len(),"live":live,"capturedThroughMs":if live { meetings.iter().flat_map(|m| m.transcript.iter()).map(|t|t.end_ms).max() } else { None }});
    if !current(&state.store, scope, &meetings).await {
        return Err("Sources changed. Please retry.".into());
    }
    if passages.is_empty() {
        return Ok(
            json!({"answer":if live { "I couldn't find that in the transcript captured so far. Ask again after more speech is transcribed. Batch transcription becomes available after recording ends." } else { "I couldn't find supporting passages in these meetings. Try naming the topic, person, or decision more specifically." },"citations":[],"status":"insufficient_evidence","coverage":coverage,"retrievalMode":mode}),
        );
    }
    let packet = EvidencePacket::build(question, history, passages, &coverage)?;
    let mut response = state
        .summarizer
        .answer_evidence(&packet, None)
        .await
        .map_err(|_| {
            "The answer provider could not complete this request. Check AI settings and retry."
        })?;
    let citations = match packet.validate_answer(&response) {
        Ok(citations) => citations,
        Err(error) => {
            // One corrective attempt remains inside the request's existing
            // timeout and cancellation guard. Never fabricate citation markers.
            response = state.summarizer.answer_evidence(&packet, Some(&error)).await
                .map_err(|_| "The answer provider could not complete this request. Check AI settings and retry.")?;
            packet.validate_answer(&response)
                .map_err(|_| "The AI couldn't produce an answer with valid source references. Please try again.")?
        }
    };
    if !current(&state.store, scope, &meetings).await {
        return Err("Sources changed. Please retry.".into());
    }
    Ok(
        json!({"answer":response["answer"],"citations":citations,"status":if response["status"]=="insufficient_evidence"{"insufficient_evidence"}else if missing.is_empty(){"answered"}else{"partial"},"coverage":coverage,"retrievalMode":mode}),
    )
}

struct ActiveRequest {
    service: Arc<ChatService>,
    thread: String,
}
impl Drop for ActiveRequest {
    fn drop(&mut self) {
        self.service.active.lock().unwrap().remove(&self.thread);
    }
}

async fn send(state: &AppState, thread: &str, body: &Value) -> Result<Value> {
    let question = validate_question(body)?;
    let request = body["requestId"]
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .ok_or("requestId must be a UUID")?
        .to_string();
    let cancel = CancellationToken::new();
    {
        let mut active = state.chat.active.lock().unwrap();
        let mut cancelled = state.chat.cancelled.lock().unwrap();
        cancelled.retain(|_, at| crate::now_ms() - *at < 120_000);
        if cancelled.contains_key(&(thread.into(), request.clone())) {
            return Err("Question cancelled".into());
        }
        if active.contains_key(thread) {
            return Err("A question is already running in this conversation".into());
        }
        active.insert(thread.into(), (request.clone(), cancel.clone()));
    }
    let _guard = ActiveRequest {
        service: state.chat.clone(),
        thread: thread.into(),
    };
    let _permit = state
        .chat
        .permits
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Chat is busy. Please retry shortly.")?;
    let id = thread.to_string();
    let q = question.clone();
    let r = request.clone();
    let (scope, history, cached) = state
        .chat
        .db(move |db| {
            let scope = db.get(&id)?["scope"].clone();
            let history = db.messages(&id, i64::MAX)?["messages"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let cached = db.begin(&id, &r, &q)?;
            Ok((scope, history, cached))
        })
        .await?;
    if let Some(mut cached) = cached {
        mark_citations(&state.store, &mut cached).await;
        return Ok(cached);
    }
    let response = tokio::select! {
        _=cancel.cancelled()=>return Err("Question cancelled".into()),
        result=tokio::time::timeout(Duration::from_secs(60),answer(state,&scope,&question,&history))=>result.map_err(|_|"Question timed out. Try a narrower scope.")??,
    };
    if cancel.is_cancelled() {
        return Err("Question cancelled".into());
    }
    let id = thread.to_string();
    let saved = response.clone();
    let service = state.chat.clone();
    state
        .chat
        .db(move |db| {
            // Serialize the final commit with cancellation, including a cancel that
            // arrived while the DB worker was queued.
            let _active = service.active.lock().unwrap();
            if cancel.is_cancelled() {
                return Err("Question cancelled".into());
            }
            db.finish(&id, &request, &saved)
        })
        .await?;
    Ok(response)
}

async fn mark_citations(store: &Store, message: &mut Value) {
    if let Some(citations) = message.get_mut("citations").and_then(Value::as_array_mut) {
        for c in citations {
            let meeting = store.get(c["meetingId"].as_str().unwrap_or_default()).await;
            c["available"] = json!(meeting
                .as_ref()
                .is_some_and(|m| c["sourceRevision"].as_str().is_some_and(|expected| source_matches(m, expected))));
            if c["available"] == false {
                c["unavailableReason"] = if meeting.is_none() {
                    json!("Source unavailable")
                } else {
                    json!("Source changed")
                };
            } else if let Some(object) = c.as_object_mut() {
                object.remove("unavailableReason");
            }
        }
    }
}

pub async fn route(
    req: &HttpRequest,
    state: &AppState,
    body: &Value,
) -> (u16, &'static str, String) {
    let result = route_inner(req, state, body).await;
    match result {
        Ok(value) => json_response(200, value),
        Err(error) => {
            let code = if error.contains("cancelled") {
                "cancelled"
            } else if error.contains("timed out") {
                "timeout"
            } else if error.contains("Sources changed") {
                "sources_changed"
            } else if error.contains("busy") || error.contains("already running") {
                "busy"
            } else if error.contains("provider") {
                "provider_unavailable"
            } else if error.contains("not found")
                || error.contains("no longer exists")
                || error == "Source unavailable"
            {
                "not_found"
            } else {
                "chat_error"
            };
            json_response(
                if code == "busy" {
                    429
                } else if code == "sources_changed" {
                    409
                } else if code == "provider_unavailable" {
                    502
                } else if code == "not_found" {
                    404
                } else if code == "timeout" {
                    504
                } else {
                    400
                },
                json!({"error":error,"code":code}),
            )
        }
    }
}
async fn route_inner(req: &HttpRequest, state: &AppState, body: &Value) -> Result<Value> {
    let parts: Vec<_> = req.path.trim_matches('/').split('/').collect();
    let method = req.method.as_str();
    let offset = req
        .query
        .get("offset")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0)
        .min(1_000_000);
    if parts.len() == 4 && parts[2] == "sources" && method == "GET" {
        let meeting = state
            .store
            .get(parts[3])
            .await
            .ok_or("Source unavailable")?;
        if !req.query.get("revision").is_some_and(|expected| source_matches(&meeting, expected)) {
            return Err("Sources changed. Please ask again for current evidence.".into());
        }
        return Ok(json!({"meeting":meeting}));
    }
    if req.path == "/api/chat" && method == "POST" {
        let q = validate_question(body)?;
        let ids = body["meetingIds"]
            .as_array()
            .ok_or("Select meetings to ask about")?;
        if ids.is_empty() || ids.len() > 12 {
            return Err("Select between 1 and 12 meetings".into());
        }
        let history = body
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if history.len() > 12
            || history.iter().any(|m| {
                !matches!(m["role"].as_str(), Some("user" | "assistant"))
                    || m["content"].as_str().is_none_or(|s| s.len() > 8000)
            })
        {
            return Err("Invalid conversation history".into());
        }
        let _permit = state
            .chat
            .permits
            .clone()
            .try_acquire_owned()
            .map_err(|_| "Chat is busy")?;
        return tokio::time::timeout(
            Duration::from_secs(60),
            answer(
                state,
                &json!({"type":"meetings","meetingIds":ids}),
                &q,
                &history,
            ),
        )
        .await
        .map_err(|_| "Question timed out")?;
    }
    if req.path == "/api/chat/index/status" && method == "GET" {
        let status = state.chat.model_status.lock().unwrap().clone();
        let service = state.chat.clone();
        let counts = tokio::task::spawn_blocking(move || {
            service.with_index(|i| {
                let chunks: i64 =
                    i.db.query_row("SELECT count(*) FROM chunks", [], |r| r.get(0))
                        .map_err(|e| e.to_string())?;
                let vectors: i64 =
                    i.db.query_row(
                        "SELECT count(*) FROM vectors WHERE model=?1",
                        [index::MODEL_ID],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                Ok((chunks, vectors))
            })
        })
        .await
        .map_err(|_| "Search worker stopped")??;
        return Ok(
            json!({"modelStatus":status,"mode":if status=="ready"&&counts.1>0{"hybrid"}else{"keyword"},"chunks":counts.0,"embeddedChunks":counts.1,"pendingChunks":counts.0-counts.1}),
        );
    }
    if req.path == "/api/chat/threads" {
        if method == "GET" {
            return state.chat.db(move |db| db.list(offset)).await;
        }
        if method == "POST" {
            let scope = body["scope"].clone();
            let meetings = resolve_scope(&state.store, &scope).await?;
            let title = if scope["type"] == "all" {
                "All meetings".into()
            } else if scope["type"] == "folder" {
                "Folder conversation".into()
            } else if meetings.len() == 1 {
                meetings[0].title.clone()
            } else {
                format!("{} meetings", meetings.len())
            };
            let mut thread = state.chat.db(move |db| db.create(&scope, &title)).await?;
            thread["eligibleMeetings"] = json!(meetings.len());
            return Ok(thread);
        }
    }
    if parts.len() >= 4 && parts[2] == "threads" {
        let id = parts[3].to_string();
        if method == "DELETE" && parts.len() == 4 {
            if let Some((_, cancel)) = state.chat.active.lock().unwrap().get(&id) {
                cancel.cancel();
            }
            return state.chat.db(move |db| db.delete(&id)).await;
        }
        if parts.len() == 5 && parts[4] == "messages" {
            if method == "POST" {
                return send(state, &id, body).await;
            }
            if method == "GET" {
                let before = req
                    .query
                    .get("before")
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(i64::MAX);
                let mut result = state
                    .chat
                    .db(move |db| {
                        let mut v = db.messages(&id, before)?;
                        v["thread"] = db.get(&id)?;
                        Ok(v)
                    })
                    .await?;
                for m in result["messages"].as_array_mut().unwrap() {
                    mark_citations(&state.store, m).await;
                }
                return Ok(result);
            }
        }
        if parts.len() == 7 && parts[4] == "requests" && parts[6] == "cancel" && method == "POST" {
            let active = state.chat.active.lock().unwrap();
            let mut cancelled = state.chat.cancelled.lock().unwrap();
            cancelled.retain(|_, at| crate::now_ms() - *at < 120_000);
            if cancelled.len() > 1024 {
                return Err("Chat is busy".into());
            }
            cancelled.insert((id.clone(), parts[5].into()), crate::now_ms());
            if let Some((request, cancel)) = active.get(&id) {
                if request == parts[5] {
                    cancel.cancel();
                }
            }
            return Ok(json!({"success":true}));
        }
    }
    Err("Chat route not found".into())
}
