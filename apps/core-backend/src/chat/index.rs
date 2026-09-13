//! Rebuildable passage index. All calls run on blocking workers, outside Store locks.
use crate::Meeting;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

pub type Result<T> = std::result::Result<T, String>;
pub const MAX_EVIDENCE_BYTES: usize = 6000;
pub const MAX_PASSAGES: usize = 12;
pub use super::embeddings::MODEL_ID;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Passage {
    pub chunk_id: String,
    pub meeting_id: String,
    pub title: String,
    pub started_at: i64,
    pub source_revision: String,
    pub source_kind: String,
    pub turn_ids: Vec<String>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub excerpt: String,
}

pub fn revision(m: &Meeting) -> String {
    if m.ended_at.is_none() {
        return live_revision(m, m.transcript.len(), m.notes.len());
    }
    fingerprint(m)
}

// A live source identifies the captured prefix, so appended speech does not
// invalidate an answer. Edits, deletion and replacement still invalidate it.
fn live_revision(m: &Meeting, turns: usize, notes: usize) -> String {
    let mut snapshot = m.clone();
    snapshot.transcript.truncate(turns);
    snapshot.notes.truncate(notes);
    snapshot.ended_at = None;
    snapshot.summary_markdown.clear();
    snapshot.action_items.clear();
    snapshot.key_decisions.clear();
    format!("live:{turns}:{notes}:{}", fingerprint(&snapshot))
}

pub fn source_matches(m: &Meeting, expected: &str) -> bool {
    if let Some(rest) = expected.strip_prefix("live:") {
        let parts: Vec<_> = rest.split(':').collect();
        if parts.len() != 3 { return false; }
        let (Ok(turns), Ok(notes)) = (parts[0].parse::<usize>(), parts[1].parse::<usize>()) else { return false; };
        return turns <= m.transcript.len() && notes <= m.notes.len()
            && live_revision(m, turns, notes) == expected;
    }
    revision(m) == expected
}

fn fingerprint(m: &Meeting) -> String {
    let data = json!([
        m.title,
        m.started_at,
        m.ended_at,
        m.metadata.get("collectionId"),
        m.transcript,
        m.notes,
        m.summary_markdown,
        m.action_items,
        m.key_decisions
    ]);
    format!("{:x}", Sha256::digest(data.to_string().as_bytes()))
}

// Byte bounds are conservative token bounds and also protect non-Latin text.
fn slices(text: &str, maximum: usize) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + maximum).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        if end < text.len() {
            if let Some(boundary) = text[start..end].rfind(['\n', '.', ' ']) {
                if boundary > maximum / 2 {
                    end = start + boundary + 1;
                }
            }
        }
        parts.push(&text[start..end]);
        if end == text.len() {
            break;
        }
        let mut next = end.saturating_sub(120).max(start + 1);
        while !text.is_char_boundary(next) {
            next += 1;
        }
        start = next;
    }
    parts
}

pub fn chunks(m: &Meeting) -> Vec<Passage> {
    let rev = revision(m);
    let mut result = Vec::new();
    let mut add = |kind: &str, text: String, ids: Vec<String>, start, end| {
        for (part, excerpt) in slices(&text, 1100).into_iter().enumerate() {
            if excerpt.trim().is_empty() {
                continue;
            }
            let key = format!("{}:{rev}:{kind}:{}:{part}", m.id, result.len());
            result.push(Passage {
                chunk_id: format!("{:x}", Sha256::digest(key.as_bytes())),
                meeting_id: m.id.clone(),
                title: m.title.clone(),
                started_at: m.started_at,
                source_revision: rev.clone(),
                source_kind: kind.into(),
                turn_ids: ids.clone(),
                start_ms: start,
                end_ms: end,
                excerpt: excerpt.into(),
            });
        }
    };
    // Small overlapping groups preserve question/answer and correction context.
    let mut i = 0;
    while i < m.transcript.len() {
        let mut text = String::new();
        let mut end = i;
        while end < m.transcript.len() && (text.len() < 650 || end == i) {
            let t = &m.transcript[end];
            text.push_str(&format!("[{}ms] {}: {}\n", t.start_ms, t.speaker, t.text));
            end += 1;
        }
        let turns = &m.transcript[i..end];
        add(
            "transcript",
            text,
            turns.iter().map(|t| t.id.clone()).collect(),
            Some(turns[0].start_ms),
            Some(turns[turns.len() - 1].end_ms),
        );
        i = if end > i + 1 { end - 1 } else { end };
    }
    for note in &m.notes {
        if let Some(text) = note.get("text").and_then(Value::as_str) {
            add(
                "note",
                text.into(),
                vec![],
                note.get("atMs").and_then(Value::as_i64),
                None,
            );
        }
    }
    if m.ended_at.is_some() {
        add("summary", m.summary_markdown.clone(), vec![], None, None);
        for text in &m.key_decisions {
            add("decision", text.clone(), vec![], None, None);
        }
        for action in &m.action_items {
            add("action", action.to_string(), vec![], None, None);
        }
    }
    result
}

pub struct Index {
    pub db: Connection,
}

impl Index {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.busy_timeout(std::time::Duration::from_secs(3))
            .map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS meetings(id TEXT PRIMARY KEY, revision TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, passage TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS chunks_meeting ON chunks(meeting_id);
            CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(id UNINDEXED, meeting_id UNINDEXED, text, title, tokenize='unicode61');
            CREATE TABLE IF NOT EXISTS vectors(id TEXT PRIMARY KEY, model TEXT NOT NULL, vector BLOB NOT NULL);
            PRAGMA user_version=1;").map_err(|e| e.to_string())?;
        Ok(Self { db })
    }

    pub fn sync(&mut self, meetings: &[Meeting], prune: bool) -> Result<()> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        let known: HashMap<String, String> = tx
            .prepare("SELECT id, revision FROM meetings")
            .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
            .map_err(|e| e.to_string())?;
        let current: HashSet<_> = meetings.iter().map(|m| m.id.as_str()).collect();
        let changed: Vec<_> = meetings
            .iter()
            .filter(|m| known.get(&m.id) != Some(&revision(m)))
            .collect();
        let remove: HashSet<_> = known
            .keys()
            .filter(|id| prune && !current.contains(id.as_str()))
            .chain(changed.iter().map(|m| &m.id))
            .collect();
        for id in remove {
            tx.execute(
                "DELETE FROM vectors WHERE id IN (SELECT id FROM chunks WHERE meeting_id=?1)",
                [id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM chunks WHERE meeting_id=?1", [id])
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM chunk_fts WHERE meeting_id=?1", [id])
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM meetings WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
        }
        for m in changed {
            tx.execute(
                "INSERT INTO meetings VALUES(?1, ?2)",
                params![m.id, revision(m)],
            )
            .map_err(|e| e.to_string())?;
            for p in chunks(m) {
                tx.execute(
                    "INSERT INTO chunks VALUES(?1, ?2, ?3)",
                    params![p.chunk_id, p.meeting_id, serde_json::to_string(&p).unwrap()],
                )
                .map_err(|e| e.to_string())?;
                tx.execute(
                    "INSERT INTO chunk_fts VALUES(?1, ?2, ?3, ?4)",
                    params![p.chunk_id, p.meeting_id, p.excerpt, p.title],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn pending_vectors(&self, limit: usize) -> Result<Vec<Passage>> {
        let mut s = self.db.prepare("SELECT passage FROM chunks WHERE id NOT IN (SELECT id FROM vectors WHERE model=?1) LIMIT ?2").map_err(|e| e.to_string())?;
        let rows = s
            .query_map(params![MODEL_ID, limit as i64], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }

    pub fn save_vectors(&mut self, passages: &[Passage], vectors: &[Vec<f32>]) -> Result<()> {
        if passages.len() != vectors.len() {
            return Err("Embedding count mismatch".into());
        }
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        for (p, v) in passages.iter().zip(vectors) {
            if v.len() != 384 || v.iter().any(|x| !x.is_finite()) {
                return Err("Invalid embedding".into());
            }
            let blob: Vec<u8> = v.iter().flat_map(|n| n.to_le_bytes()).collect();
            // A deleted/replaced chunk cannot be revived by a slow embedding job.
            tx.execute("INSERT OR REPLACE INTO vectors SELECT ?1, ?2, ?3 WHERE EXISTS(SELECT 1 FROM chunks WHERE id=?1)", params![p.chunk_id,MODEL_ID,blob]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn retrieve(
        &self,
        query: &str,
        meetings: &[Meeting],
        vector: Option<&[f32]>,
        overview: bool,
    ) -> Result<Vec<Passage>> {
        let allowed: HashMap<_, _> = meetings
            .iter()
            .map(|m| (m.id.clone(), revision(m)))
            .collect();
        // A TEMP scope table filters BEFORE rank/limit, including libraries >200 meetings.
        self.db
            .execute_batch(
                "CREATE TEMP TABLE IF NOT EXISTS scope(id TEXT PRIMARY KEY); DELETE FROM scope;",
            )
            .map_err(|e| e.to_string())?;
        for id in allowed.keys() {
            self.db
                .execute("INSERT INTO scope VALUES(?1)", [id])
                .map_err(|e| e.to_string())?;
        }
        let mut passages = HashMap::new();
        let mut lexical = Vec::new();
        let terms = search_terms(query);
        if !terms.is_empty() {
            let expression = terms
                .iter()
                .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" OR ");
            let mut s = self.db.prepare("SELECT c.passage FROM chunk_fts JOIN chunks c ON c.id=chunk_fts.id WHERE chunk_fts MATCH ?1 AND c.meeting_id IN (SELECT id FROM scope) ORDER BY bm25(chunk_fts,0,0,1,0.15) LIMIT 80").map_err(|e| e.to_string())?;
            for row in s
                .query_map([&expression], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
            {
                let p: Passage = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                if allowed.get(&p.meeting_id) == Some(&p.source_revision) {
                    lexical.push(p.chunk_id.clone());
                    passages.insert(p.chunk_id.clone(), p);
                }
            }
            // Small comparison scopes need candidates from every meeting before
            // fusion; global top-k alone can be dominated by one long meeting.
            if meetings.len() <= 12 {
                let mut s=self.db.prepare("SELECT c.passage FROM chunk_fts JOIN chunks c ON c.id=chunk_fts.id WHERE chunk_fts MATCH ?1 AND c.meeting_id=?2 ORDER BY bm25(chunk_fts,0,0,1,0.15) LIMIT 8").map_err(|e|e.to_string())?;
                for meeting in meetings {
                    for row in s
                        .query_map(params![expression, meeting.id], |r| r.get::<_, String>(0))
                        .map_err(|e| e.to_string())?
                    {
                        let p: Passage = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                            .map_err(|e| e.to_string())?;
                        if allowed.get(&p.meeting_id) == Some(&p.source_revision)
                            && !passages.contains_key(&p.chunk_id)
                        {
                            lexical.push(p.chunk_id.clone());
                            passages.insert(p.chunk_id.clone(), p);
                        }
                    }
                }
            }
        }
        let mut semantic = Vec::new();
        if let Some(q) = vector {
            let mut s = self.db.prepare("SELECT c.passage, v.vector FROM chunks c JOIN vectors v ON c.id=v.id WHERE v.model=?1 AND c.meeting_id IN (SELECT id FROM scope)").map_err(|e| e.to_string())?;
            let rows = s
                .query_map([MODEL_ID], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (text, blob) = row.map_err(|e| e.to_string())?;
                let v: Vec<f32> = blob
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                    .collect();
                let score = cosine(q, &v);
                // E5 scores cluster high. This is a conservative initial gate, not confidence.
                if score < 0.75 {
                    continue;
                }
                let p: Passage = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                if allowed.get(&p.meeting_id) == Some(&p.source_revision) {
                    semantic.push((p.chunk_id.clone(), score));
                    passages.insert(p.chunk_id.clone(), p);
                }
            }
            semantic.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            semantic.truncate(80);
        }
        if overview {
            let mut s = self.db.prepare("SELECT passage FROM chunks WHERE meeting_id IN (SELECT id FROM scope) ORDER BY meeting_id,id").map_err(|e| e.to_string())?;
            for row in s
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
            {
                let p: Passage = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                if allowed.get(&p.meeting_id) == Some(&p.source_revision)
                    && matches!(p.source_kind.as_str(), "summary" | "decision" | "action")
                {
                    lexical.push(p.chunk_id.clone());
                    passages.insert(p.chunk_id.clone(), p);
                }
            }
        }
        let mut scores: HashMap<String, f32> = HashMap::new();
        for list in [lexical, semantic.into_iter().map(|(id, _)| id).collect()] {
            for (rank, id) in list.into_iter().enumerate() {
                *scores.entry(id).or_default() += 1.0 / (60.0 + rank as f32);
            }
        }
        let mut ranked: Vec<_> = scores.into_iter().collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let mut result: Vec<Passage> = Vec::new();
        let mut bytes = 0;
        // First give each matching meeting representation, then fill remaining slots.
        for diverse in [true, false] {
            for (id, _) in &ranked {
                let p = &passages[id];
                if result.iter().any(|old| {
                    old.chunk_id == *id
                        || (old.meeting_id == p.meeting_id
                            && (diverse || (!p.turn_ids.is_empty() && old.turn_ids == p.turn_ids)))
                }) {
                    continue;
                }
                let cost = serde_json::to_vec(p).unwrap().len();
                if result.len() == MAX_PASSAGES || bytes + cost > MAX_EVIDENCE_BYTES {
                    continue;
                }
                bytes += cost;
                result.push(p.clone());
            }
        }
        Ok(result)
    }
}

pub fn search_terms(query: &str) -> Vec<String> {
    const STOP: &[&str] = &[
        "what", "when", "where", "who", "how", "why", "did", "does", "the", "a", "an", "we", "i",
        "you", "our", "was", "were", "is", "are", "to", "of", "in", "on", "and", "or", "about",
        "tell", "me", "please", "meeting", "meetings", "that", "it", "this", "with", "for", "do",
        "can", "could",
    ];
    let mut seen = HashSet::new();
    query
        .split(|c: char| !c.is_alphanumeric() && !matches!(c, '\u{0900}'..='\u{097f}'))
        .map(str::to_lowercase)
        .filter(|t| t.chars().count() > 1 && !STOP.contains(&t.as_str()) && seen.insert(t.clone()))
        .take(32)
        .collect()
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b).map(|(a, b)| a * b).sum();
    let norm =
        a.iter().map(|x| x * x).sum::<f32>().sqrt() * b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        dot / norm
    } else {
        0.0
    }
}
