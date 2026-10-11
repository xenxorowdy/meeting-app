//! Named UI folders are a catalog; on-disk meeting folders retain their format.
use crate::{Meeting, Store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, io, path::Path};

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

#[derive(Default, Serialize, Deserialize)]
pub struct FolderRules {
    #[serde(default)]
    events: BTreeMap<String, Option<String>>,
    #[serde(default)]
    series: BTreeMap<String, String>,
}

impl FolderRules {
    fn folder_for(&self, event_key: &str, series_key: Option<&str>) -> Option<String> {
        match self.events.get(event_key) {
            Some(choice) => choice.clone(),
            None => series_key.and_then(|key| self.series.get(key).cloned()),
        }
    }
}

async fn read_rules(root: &Path) -> io::Result<FolderRules> {
    match tokio::fs::read(root.join(".folder-rules.json")).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(FolderRules::default()),
        Err(error) => Err(error),
    }
}

async fn write_rules(root: &Path, rules: &FolderRules) -> Result<(), String> {
    tokio::fs::create_dir_all(root).await.map_err(|e| e.to_string())?;
    let temp = root.join(".folder-rules.tmp");
    tokio::fs::write(&temp, serde_json::to_vec_pretty(rules).map_err(|e| e.to_string())?).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(temp, root.join(".folder-rules.json")).await.map_err(|e| e.to_string())
}

fn calendar_keys(metadata: &Value) -> Option<(String, Option<String>)> {
    let event = metadata.get("calendarEvent")?;
    let text = |key: &str| event.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
    let provider = text("provider").unwrap_or("calendar");
    let id = text("id")?;
    Some((format!("{provider}:{id}"), text("seriesId").map(|series| format!("{provider}:{series}"))))
}

pub async fn folder_for_event(store: &Store, metadata: &Value) -> Option<String> {
    let (event_key, series_key) = calendar_keys(metadata)?;
    let library = store.library.read().await;
    let folder = read_rules(library.root()).await.ok()?.folder_for(&event_key, series_key.as_deref())?;
    let catalog = read_folders(library.root()).await.ok()?;
    catalog.iter().any(|known| known.id == folder).then_some(folder)
}

pub async fn folder_rules(store: &Store, body: Option<&Value>) -> Result<Value, String> {
    let Some(body) = body else {
        let library = store.library.read().await;
        let rules = read_rules(library.root()).await.map_err(|e| e.to_string())?;
        return Ok(json!({"rules": rules, "filed": []}));
    };
    let text = |key: &str| body.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty() && value.len() <= 1024);
    let provider = text("provider").unwrap_or("calendar");
    let event_key = format!("{provider}:{}", text("eventId").ok_or("eventId is required")?);
    let series_key = text("seriesId").map(|series| format!("{provider}:{series}"));
    let apply_to_series = body.get("applyToSeries").and_then(Value::as_bool) == Some(true);
    if apply_to_series && series_key.is_none() {
        return Err("This event does not repeat.".into());
    }
    let folder_id = match body.get("folderId") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) => Some(id.clone()),
        Some(_) => return Err("folderId must be a string or null".into()),
    };

    let mut library = store.library.write().await;
    let root = library.root().to_path_buf();
    if let Some(id) = &folder_id {
        let catalog = read_folders(&root).await.map_err(|e| e.to_string())?;
        if !catalog.iter().any(|folder| &folder.id == id) {
            return Err("Folder not found".into());
        }
    }
    let mut rules = read_rules(&root).await.map_err(|e| e.to_string())?;
    match (&folder_id, &series_key, apply_to_series) {
        (Some(id), Some(series), true) => {
            rules.series.insert(series.clone(), id.clone());
            rules.events.remove(&event_key);
        }
        (None, Some(series), true) => {
            rules.series.remove(series);
            rules.events.remove(&event_key);
        }
        (Some(id), _, _) => {
            rules.events.insert(event_key.clone(), Some(id.clone()));
        }
        (None, series, _) => {
            if series.as_ref().is_some_and(|key| rules.series.contains_key(key)) {
                rules.events.insert(event_key.clone(), None);
            } else {
                rules.events.remove(&event_key);
            }
        }
    }
    write_rules(&root, &rules).await?;

    let mut filed = Vec::new();
    if let Some(id) = &folder_id {
        let mut meetings = store.meetings.write().await;
        let targets: Vec<String> = meetings
            .values()
            .filter(|meeting| meeting.ended_at.is_some() && meeting.metadata.get("collectionId").map_or(true, Value::is_null))
            .filter(|meeting| {
                calendar_keys(&meeting.metadata).is_some_and(|(event, series)| {
                    event == event_key || (apply_to_series && series.is_some() && series == series_key)
                })
            })
            .map(|meeting| meeting.id.clone())
            .collect();
        for target in targets {
            let Some(mut meeting) = meetings.get(&target).cloned() else { continue };
            if !meeting.metadata.is_object() {
                meeting.metadata = json!({});
            }
            meeting.metadata["collectionId"] = json!(id);
            library.save(&mut meeting).await.map_err(|e| e.to_string())?;
            meetings.insert(target.clone(), meeting);
            filed.push(target);
        }
    }
    Ok(json!({"rules": rules, "filed": filed}))
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
    store.update(id, |meeting| {
        if meeting.ended_at.is_none() {
            return Err((409, "Finish this meeting before moving it to a folder.".into()));
        }
        if !meeting.metadata.is_object() { meeting.metadata = json!({}); }
        meeting.metadata["collectionId"] = value.clone();
        Ok(())
    }).await.map_err(|(_, cause)| cause)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::Library;
    use std::{collections::HashMap, sync::Arc};
    use tokio::sync::RwLock;

    #[tokio::test]
    async fn folders_persist_rename_and_move_without_changing_meeting_paths() {
        let root = std::env::temp_dir().join(format!("kesami-folders-{}", uuid::Uuid::new_v4()));
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

    fn calendar_meeting(id: &str, event: &str, series: Option<&str>, ended: bool) -> Meeting {
        serde_json::from_value(json!({
            "id": id, "title": "Daily Scrum", "startedAt": 1000, "endedAt": if ended { json!(2000) } else { Value::Null },
            "durationSeconds": 1, "summaryMarkdown": "", "actionItems": [], "keyDecisions": [],
            "metadata": {"calendarEvent": {"provider": "google", "id": event, "seriesId": series}},
            "transcript": [], "createdAt": 1000
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn calendar_folder_rules_file_one_event_or_a_whole_series() {
        let root = std::env::temp_dir().join(format!("kesami-folder-rules-{}", uuid::Uuid::new_v4()));
        let store = Store { library: Arc::new(RwLock::new(Library::new(root.clone()))), meetings: Arc::new(RwLock::new(HashMap::new())) };
        let scrum = folders(&store, Some(&json!({"name":"Scrum | Lab Module"}))).await.unwrap()["folders"][0]["id"].as_str().unwrap().to_string();
        let monday = json!({"calendarEvent": {"provider": "google", "id": "scrum_mon", "seriesId": "scrum"}});
        let tuesday = json!({"calendarEvent": {"provider": "google", "id": "scrum_tue", "seriesId": "scrum"}});
        assert_eq!(folder_for_event(&store, &monday).await, None);

        store.put(calendar_meeting("past", "scrum_fri", Some("scrum"), true)).await.unwrap();
        store.put(calendar_meeting("live", "scrum_mon", Some("scrum"), false)).await.unwrap();
        let only_monday = folder_rules(&store, Some(&json!({"provider":"google","eventId":"scrum_mon","seriesId":"scrum","folderId":scrum}))).await.unwrap();
        assert_eq!(folder_for_event(&store, &monday).await.as_deref(), Some(scrum.as_str()));
        assert_eq!(folder_for_event(&store, &tuesday).await, None, "one event does not file the rest of the series");
        assert_eq!(only_monday["filed"], json!([]), "a meeting still recording is filed when it finishes, not here");

        let series = folder_rules(&store, Some(&json!({"provider":"google","eventId":"scrum_mon","seriesId":"scrum","folderId":scrum,"applyToSeries":true}))).await.unwrap();
        assert_eq!(folder_for_event(&store, &tuesday).await.as_deref(), Some(scrum.as_str()), "future instances follow the series");
        assert_eq!(series["filed"], json!(["past"]), "finished, unfiled meetings from the series move into the folder");
        assert_eq!(store.get("past").await.unwrap().metadata["collectionId"], json!(scrum));

        folder_rules(&store, Some(&json!({"provider":"google","eventId":"scrum_tue","seriesId":"scrum","folderId":null}))).await.unwrap();
        assert_eq!(folder_for_event(&store, &tuesday).await, None, "one instance can opt out of its series");
        assert_eq!(folder_for_event(&store, &monday).await.as_deref(), Some(scrum.as_str()));

        assert!(folder_rules(&store, Some(&json!({"provider":"google","eventId":"once","folderId":scrum,"applyToSeries":true}))).await.is_err());
        assert!(folder_rules(&store, Some(&json!({"provider":"google","eventId":"once","folderId":"missing"}))).await.is_err());
        let reread = folder_rules(&store, None).await.unwrap();
        assert_eq!(reread["rules"]["series"]["google:scrum"], json!(scrum));
        std::fs::remove_dir_all(root).unwrap();
    }
}
