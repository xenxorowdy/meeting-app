use super::index::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

pub struct Threads {
    db: Connection,
}
impl Threads {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.busy_timeout(std::time::Duration::from_secs(3))
            .map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL, updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, request_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, response TEXT, UNIQUE(thread_id,request_id,role));
            PRAGMA user_version=1;").map_err(|e|e.to_string())?;
        Ok(Self { db })
    }
    pub fn create(&self, scope: &Value, title: &str) -> Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        self.db
            .execute(
                "INSERT INTO threads VALUES(?1,?2,?3,?4)",
                params![id, scope.to_string(), title, crate::now_ms()],
            )
            .map_err(|e| e.to_string())?;
        Ok(json!({"id":id,"scope":scope,"title":title}))
    }
    pub fn get(&self, id: &str) -> Result<Value> {
        self.db.query_row("SELECT scope,title FROM threads WHERE id=?1",[id],|r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))
            .optional().map_err(|e|e.to_string())?.map(|(scope,title)| json!({"id":id,"scope":serde_json::from_str::<Value>(&scope).unwrap_or(Value::Null),"title":title})).ok_or("Thread not found".into())
    }
    pub fn list(&self, offset: usize) -> Result<Value> {
        let mut s = self.db.prepare("SELECT id,scope,title,updated_at FROM threads ORDER BY updated_at DESC,id LIMIT 50 OFFSET ?1").map_err(|e|e.to_string())?;
        let rows = s
            .query_map([offset as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut threads = Vec::new();
        for row in rows {
            let (id, scope, title, at) = row.map_err(|e| e.to_string())?;
            threads.push(json!({"id":id,"scope":serde_json::from_str::<Value>(&scope).unwrap_or(Value::Null),"title":title,"updatedAt":at}));
        }
        Ok(
            json!({"threads":threads,"nextOffset":if threads.len()==50 {Some(offset+50)} else {None}}),
        )
    }
    pub fn messages(&self, id: &str, before: i64) -> Result<Value> {
        self.get(id)?;
        let mut s = self.db.prepare("SELECT id,request_id,role,content,response FROM messages WHERE thread_id=?1 AND id<?2 ORDER BY id DESC LIMIT 50").map_err(|e|e.to_string())?;
        let rows = s
            .query_map(params![id, before], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut messages = Vec::new();
        for row in rows {
            let (id, request, role, content, response) = row.map_err(|e| e.to_string())?;
            let mut value = response
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .unwrap_or(json!({}));
            value["id"] = json!(id);
            value["requestId"] = json!(request);
            value["role"] = json!(role);
            value["content"] = json!(content);
            messages.push(value);
        }
        messages.reverse();
        Ok(
            json!({"before":if messages.len()==50 {messages.first().map(|v|v["id"].clone())} else {None},"messages":messages}),
        )
    }
    pub fn begin(&self, id: &str, request: &str, question: &str) -> Result<Option<Value>> {
        self.get(id)?;
        let existing: Option<String> = self
            .db
            .query_row(
                "SELECT content FROM messages WHERE thread_id=?1 AND request_id=?2 AND role='user'",
                params![id, request],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if existing.as_deref().is_some_and(|text| text != question) {
            return Err("Request ID was already used for another question".into());
        }
        self.db.execute("INSERT OR IGNORE INTO messages(thread_id,request_id,role,content) VALUES(?1,?2,'user',?3)",params![id,request,question]).map_err(|e|e.to_string())?;
        let cached:Option<String> = self.db.query_row("SELECT response FROM messages WHERE thread_id=?1 AND request_id=?2 AND role='assistant'",params![id,request],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        Ok(cached.and_then(|s| serde_json::from_str(&s).ok()))
    }
    pub fn finish(&mut self, id: &str, request: &str, answer: &Value) -> Result<()> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO messages(thread_id,request_id,role,content,response) VALUES(?1,?2,'assistant',?3,?4)",params![id,request,answer["answer"].as_str().unwrap_or_default(),answer.to_string()]).map_err(|e|e.to_string())?;
        tx.execute(
            "UPDATE threads SET updated_at=?2 WHERE id=?1",
            params![id, crate::now_ms()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn delete(&self, id: &str) -> Result<Value> {
        self.db
            .execute("DELETE FROM threads WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(json!({"success":true}))
    }
}
