//! Named UI folders are a catalog; on-disk meeting folders retain their format.
use crate::{Meeting, Store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io, path::Path};

#[derive(Clone, Serialize, Deserialize)]
pub struct Folder {
    id: String,
    name: String,
}

async fn read_folders(root: &Path) -> io::Result<Vec<Folder>> {
    match tokio::fs::read(root.join(".folders.json")).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

pub async fn folders(store: &Store, body: Option<&Value>) -> Result<Value, String> {
    // Serializes catalog reads and writes with all library changes.
    let library = store.library.write().await;
    let mut folders = read_folders(library.root()).await.map_err(|e| e.to_string())?;
    if let Some(body) = body {
        let name = body.get("name").and_then(Value::as_str).unwrap_or_default().trim();
        if name.is_empty() || name.chars().count() > 60 || name.chars().any(char::is_control) {
            return Err("Choose a folder name between 1 and 60 characters.".into());
        }
        let existing_id = body.get("id").and_then(Value::as_str);
        if folders.iter().any(|folder| folder.name.to_lowercase() == name.to_lowercase() && Some(folder.id.as_str()) != existing_id) {
            return Err("A folder with that name already exists.".into());
        }
        if let Some(id) = existing_id {
            let folder = folders.iter_mut().find(|folder| folder.id == id).ok_or("Folder not found")?;
            folder.name = name.into();
        } else {
            folders.push(Folder { id: uuid::Uuid::new_v4().to_string(), name: name.into() });
        }
        tokio::fs::create_dir_all(library.root()).await.map_err(|e| e.to_string())?;
        let temp = library.root().join(".folders.tmp");
        tokio::fs::write(&temp, serde_json::to_vec_pretty(&folders).map_err(|e| e.to_string())?).await.map_err(|e| e.to_string())?;
        tokio::fs::rename(temp, library.root().join(".folders.json")).await.map_err(|e| e.to_string())?;
    }
    Ok(json!({"folders": folders}))
}

pub async fn move_meeting(store: &Store, id: &str, body: &Value) -> Result<Meeting, String> {
    let value = body.get("folderId").ok_or("folderId is required (or null for unfiled)")?;
    if !value.is_null() {
        let folder_id = value.as_str().ok_or("folderId must be a string or null")?;
        let catalog = folders(store, None).await?;
        if !catalog["folders"].as_array().unwrap().iter().any(|folder| folder["id"] == folder_id) {
            return Err("Folder not found".into());
        }
    }
    let mut meeting = store.get(id).await.ok_or("Meeting not found")?;
    if meeting.ended_at.is_none() {
        return Err("Finish this meeting before moving it to a folder.".into());
    }
    if !meeting.metadata.is_object() { meeting.metadata = json!({}); }
    meeting.metadata["collectionId"] = value.clone();
    store.put(meeting).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::Library;
    use std::{collections::HashMap, sync::Arc};
    use tokio::sync::RwLock;

    #[tokio::test]
    async fn folders_persist_rename_and_move_without_changing_meeting_paths() {
        let root = std::env::temp_dir().join(format!("alpha-folders-{}", uuid::Uuid::new_v4()));
        let store = Store { library: Arc::new(RwLock::new(Library::new(root.clone()))), meetings: Arc::new(RwLock::new(HashMap::new())) };
        let result = folders(&store, Some(&json!({"name":"Product"}))).await.unwrap();
        let id = &result["folders"][0]["id"];
        assert!(folders(&store, Some(&json!({"name":" product "}))).await.is_err());
        assert!(folders(&store, Some(&json!({"name":" "}))).await.is_err());
        folders(&store, Some(&json!({"id":id,"name":"Design"}))).await.unwrap();
        assert_eq!(read_folders(&root).await.unwrap()[0].name, "Design");
        let meeting: Meeting = serde_json::from_value(json!({"id":"m1","title":"Sync","startedAt":1000,"endedAt":2000,"durationSeconds":1,"summaryMarkdown":"","actionItems":[],"keyDecisions":[],"metadata":{"calendarEvent":{"id":"event"}},"transcript":[],"createdAt":1000})).unwrap();
        let before = store.put(meeting).await.unwrap();
        let moved = move_meeting(&store, "m1", &json!({"folderId":id})).await.unwrap();
        assert_eq!(moved.folder, before.folder);
        assert_eq!(moved.metadata["collectionId"], *id);
        assert_eq!(moved.metadata["calendarEvent"]["id"], "event");
        assert!(move_meeting(&store, "m1", &json!({"folderId":"missing"})).await.is_err());
        let unfiled = move_meeting(&store, "m1", &json!({"folderId":null})).await.unwrap();
        assert!(unfiled.metadata["collectionId"].is_null());
        let mut reopened = Library::new(root.clone());
        assert!(reopened.load().await[0].metadata["collectionId"].is_null());
        std::fs::remove_dir_all(root).unwrap();
    }

}
