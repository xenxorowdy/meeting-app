use crate::Meeting;
use chrono::{Local, TimeZone};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    env, io,
    path::{Path, PathBuf},
};

const MARKER: &str = ".alpha-library.json";
const RECORDING_STEM: &str = "recording";
const MAX_TITLE_CHARS: usize = 60;
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

pub fn root_from_env() -> PathBuf {
    if let Some(root) = env::var_os("ALPHA_LIBRARY_DIR") {
        return PathBuf::from(root);
    }
    if let Some(root) = env::var_os("ALPHA_RECORDINGS_DIR") {
        return PathBuf::from(root);
    }
    let base = env::var_os("ALPHA_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    base.join("Alpha Meetings")
}

pub fn legacy_file() -> PathBuf {
    if let Some(path) = env::var_os("CORE_BACKEND_DATA_FILE") {
        return PathBuf::from(path);
    }
    let base = env::var_os("ALPHA_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    base.join(".alpha-meeting-assistant").join("meetings.json")
}

pub fn sanitize_title(title: &str) -> String {
    let mut cleaned: String = title
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            ch if (ch as u32) < 0x20 => ' ',
            ch => ch,
        })
        .collect();
    cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    cleaned = cleaned
        .trim_matches(|ch: char| ch == '.' || ch == '-')
        .to_string();
    if cleaned.chars().count() > MAX_TITLE_CHARS {
        cleaned = cleaned.chars().take(MAX_TITLE_CHARS).collect::<String>();
        cleaned = cleaned.trim_end().to_string();
    }
    if cleaned.is_empty() || RESERVED.contains(&cleaned.to_ascii_uppercase().as_str()) {
        return "Untitled Meeting".into();
    }
    cleaned
}

pub fn folder_name(meeting: &Meeting, taken: &HashSet<String>) -> String {
    let date = Local
        .timestamp_millis_opt(meeting.started_at)
        .single()
        .map(|stamp| stamp.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "0000-00-00".into());
    let base = format!("{date} {}", sanitize_title(&meeting.title));
    if !taken.contains(&base) {
        return base;
    }
    let short: String = meeting.id.chars().take(8).collect();
    let unique = format!("{base} ({short})");
    if !taken.contains(&unique) {
        return unique;
    }
    format!("{base} ({})", meeting.id)
}

fn timecode(ms: i64) -> String {
    let total = (ms.max(0)) / 1000;
    let (hours, minutes, seconds) = (total / 3600, (total % 3600) / 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

pub fn summary_document(meeting: &Meeting) -> String {
    let mut out = format!("# {}\n\n", meeting.title);
    out.push_str(&format!(
        "**Duration:** {} seconds\n\n",
        meeting.duration_seconds
    ));
    if !meeting.summary_markdown.is_empty() {
        out.push_str(&format!("## Summary\n\n{}\n\n", meeting.summary_markdown));
    }
    if !meeting.key_decisions.is_empty() {
        out.push_str("## Key Decisions\n\n");
        for decision in &meeting.key_decisions {
            out.push_str(&format!("- {decision}\n"));
        }
        out.push('\n');
    }
    if !meeting.action_items.is_empty() {
        out.push_str("## Action Items\n\n");
        for item in &meeting.action_items {
            let task = item.get("task").and_then(Value::as_str).unwrap_or("");
            let owner = item
                .get("owner")
                .and_then(Value::as_str)
                .unwrap_or("Unassigned");
            let deadline = item
                .get("deadline")
                .and_then(Value::as_str)
                .unwrap_or("TBD");
            out.push_str(&format!("- **{owner}** — {task} ({deadline})\n"));
        }
        out.push('\n');
    }
    if !meeting.email_draft.is_empty() {
        out.push_str(&format!(
            "## Follow-Up Email\n\n{}\n\n",
            meeting.email_draft
        ));
    }
    out
}

pub fn transcript_document(meeting: &Meeting) -> String {
    let started = Local
        .timestamp_millis_opt(meeting.started_at)
        .single()
        .map(|stamp| stamp.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default();
    let mut out = format!("# {} — transcript\n\n", meeting.title);
    out.push_str(&format!(
        "{started} · {} seconds · {} turns\n\n",
        meeting.duration_seconds,
        meeting.transcript.len()
    ));
    for turn in &meeting.transcript {
        out.push_str(&format!(
            "**[{}] {}:** {}\n\n",
            timecode(turn.start_ms),
            turn.speaker,
            turn.text
        ));
    }
    out
}

pub struct Library {
    root: PathBuf,
    folders: HashMap<String, String>,
}

impl Library {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            folders: HashMap::new(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn folder_of(&self, id: &str) -> Option<&str> {
        self.folders.get(id).map(String::as_str)
    }

    pub fn path_of(&self, id: &str) -> Option<PathBuf> {
        self.folders.get(id).map(|name| self.root.join(name))
    }

    fn taken(&self, except: &str) -> HashSet<String> {
        self.folders
            .iter()
            .filter(|(id, _)| id.as_str() != except)
            .map(|(_, name)| name.clone())
            .collect()
    }

    pub async fn load(&mut self) -> Vec<Meeting> {
        if let Err(cause) = tokio::fs::create_dir_all(&self.root).await {
            eprintln!(
                "[Alpha Core Backend] could not open the meeting library at {}: {cause}",
                self.root.display()
            );
            return Vec::new();
        }

        let mut meetings = Vec::new();
        if let Ok(mut entries) = tokio::fs::read_dir(&self.root).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                if !entry.path().is_dir() {
                    continue;
                }
                let Ok(bytes) = tokio::fs::read(entry.path().join("meeting.json")).await else {
                    continue;
                };
                match serde_json::from_slice::<Meeting>(&bytes) {
                    Ok(mut meeting) => {
                        meeting.folder = Some(name.clone());
                        self.folders.insert(meeting.id.clone(), name);
                        meetings.push(meeting);
                    }
                    Err(cause) => eprintln!(
                        "[Alpha Core Backend] {} does not hold a readable meeting: {cause}",
                        entry.path().display()
                    ),
                }
            }
        }

        meetings
    }

    pub async fn import_from(&mut self, legacy: &Path) -> Vec<Meeting> {
        let Ok(bytes) = tokio::fs::read(legacy).await else {
            return Vec::new();
        };
        let Ok(stored) = serde_json::from_slice::<Vec<Meeting>>(&bytes) else {
            eprintln!(
                "[Alpha Core Backend] {} could not be read for import",
                legacy.display()
            );
            return Vec::new();
        };

        let marker = self.root.join(MARKER);
        let mut imported: HashSet<String> = tokio::fs::read(&marker)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .as_ref()
            .and_then(|value| value.get("importedIds"))
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        let mut adopted = Vec::new();
        for mut meeting in stored {
            if imported.contains(&meeting.id) || self.folders.contains_key(&meeting.id) {
                continue;
            }
            match self.save(&mut meeting).await {
                Ok(()) => {
                    let _ = self.save_documents(&meeting).await;
                    imported.insert(meeting.id.clone());
                    adopted.push(meeting);
                }
                Err(cause) => eprintln!(
                    "[Alpha Core Backend] could not import meeting {}: {cause}",
                    meeting.id
                ),
            }
        }

        if !adopted.is_empty() || !marker.exists() {
            let mut ids: Vec<&String> = imported.iter().collect();
            ids.sort();
            let record = json!({
                "version": 1,
                "importedFrom": legacy.to_string_lossy(),
                "importedIds": ids,
            });
            let _ = tokio::fs::write(
                &marker,
                serde_json::to_vec_pretty(&record).unwrap_or_default(),
            )
            .await;
        }
        if !adopted.is_empty() {
            println!(
                "[Alpha Core Backend] imported {} meeting(s) from {} into {}",
                adopted.len(),
                legacy.display(),
                self.root.display()
            );
        }
        adopted
    }

    pub async fn save(&mut self, meeting: &mut Meeting) -> io::Result<()> {
        let desired = folder_name(meeting, &self.taken(&meeting.id));
        let current = self.folders.get(&meeting.id).cloned();
        let folder = match current {
            Some(name) if name == desired => name,
            Some(name) => {
                let from = self.root.join(&name);
                let to = self.root.join(&desired);
                if from.exists() && !to.exists() && tokio::fs::rename(&from, &to).await.is_ok() {
                    desired
                } else {
                    name
                }
            }
            None => desired,
        };

        let directory = self.root.join(&folder);
        tokio::fs::create_dir_all(&directory).await?;
        meeting.folder = Some(folder.clone());
        self.folders.insert(meeting.id.clone(), folder);

        let bytes = serde_json::to_vec_pretty(meeting).map_err(io::Error::other)?;
        write_atomically(&directory.join("meeting.json"), &bytes).await
    }

    pub async fn save_documents(&self, meeting: &Meeting) -> io::Result<()> {
        let Some(directory) = self.path_of(&meeting.id) else {
            return Ok(());
        };
        tokio::fs::create_dir_all(&directory).await?;
        write_atomically(
            &directory.join("transcript.md"),
            transcript_document(meeting).as_bytes(),
        )
        .await?;
        write_atomically(
            &directory.join("summary.md"),
            summary_document(meeting).as_bytes(),
        )
        .await
    }

    pub async fn remove(&mut self, id: &str) -> io::Result<bool> {
        let Some(folder) = self.folders.remove(id) else {
            return Ok(false);
        };
        let directory = self.root.join(&folder);
        if !directory.starts_with(&self.root) || !directory.is_dir() {
            return Ok(false);
        }
        tokio::fs::remove_dir_all(directory).await?;
        Ok(true)
    }

    pub async fn adopt_recording(
        &self,
        meeting: &mut Meeting,
        recordings_root: Option<&Path>,
    ) -> io::Result<bool> {
        let recordings_root = match recordings_root {
            Some(root) if same_directory(root, &self.root) => root.to_path_buf(),
            _ => return Ok(false),
        };
        let Some(directory) = self.path_of(&meeting.id) else {
            return Ok(false);
        };
        let Some(relative) = meeting
            .recording
            .as_ref()
            .and_then(|value| value.get("videoPath"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|value| !value.is_empty())
        else {
            return Ok(false);
        };

        let source = recordings_root.join(&relative);
        if !source.is_file() {
            return Ok(false);
        }
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("webm")
            .to_string();
        let destination = directory.join(format!("{RECORDING_STEM}.{extension}"));
        if same_directory(&source, &destination) {
            return Ok(false);
        }

        tokio::fs::create_dir_all(&directory).await?;
        if tokio::fs::rename(&source, &destination).await.is_err() {
            tokio::fs::copy(&source, &destination).await?;
            tokio::fs::remove_file(&source).await?;
        }
        prune_recording_dir(source.parent()).await;

        let folder = self.folder_of(&meeting.id).unwrap_or_default().to_string();
        let stored = format!("{folder}/{RECORDING_STEM}.{extension}");
        if let Some(recording) = meeting.recording.as_mut() {
            recording["videoPath"] = json!(stored);
        }
        Ok(true)
    }
}

fn same_directory(left: &Path, right: &Path) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    left == right
}

async fn prune_recording_dir(directory: Option<&Path>) {
    let Some(directory) = directory else {
        return;
    };
    let Ok(mut entries) = tokio::fs::read_dir(directory).await else {
        return;
    };
    let mut leftovers = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        leftovers.push(entry.file_name().to_string_lossy().to_string());
    }
    if leftovers.iter().all(|name| name == "recording.json") {
        let _ = tokio::fs::remove_dir_all(directory).await;
    }
}

async fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension("tmp");
    tokio::fs::write(&temporary, bytes).await?;
    tokio::fs::rename(temporary, path).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meeting(id: &str, title: &str, started_at: i64) -> Meeting {
        serde_json::from_value(json!({
            "id": id,
            "title": title,
            "startedAt": started_at,
            "endedAt": started_at + 60_000,
            "durationSeconds": 60,
            "summaryMarkdown": "It went well.",
            "actionItems": [],
            "keyDecisions": ["Ship on Friday"],
            "metadata": {},
            "transcript": [{
                "id": "t1",
                "channel": "mic",
                "speaker": "You",
                "startMs": 1_500,
                "endMs": 4_000,
                "text": "morning",
                "confidence": 1.0
            }],
            "createdAt": started_at
        }))
        .expect("the fixture matches the meeting record")
    }

    fn scratch(name: &str) -> PathBuf {
        let root = env::temp_dir().join(format!("alpha-library-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn a_title_becomes_a_folder_name_every_filesystem_accepts() {
        assert_eq!(sanitize_title("Design review"), "Design review");
        assert_eq!(
            sanitize_title("Q3 / roadmap: planning"),
            "Q3 - roadmap- planning"
        );
        assert_eq!(sanitize_title("  ...  "), "Untitled Meeting");
        assert_eq!(sanitize_title(""), "Untitled Meeting");
        assert_eq!(sanitize_title("con"), "Untitled Meeting");
        assert_eq!(sanitize_title(&"a".repeat(200)).chars().count(), 60);
    }

    #[test]
    fn two_meetings_on_one_day_with_one_title_get_separate_folders() {
        let first = meeting(
            "11111111-2222-3333-4444-555555555555",
            "Standup",
            1_757_030_400_000,
        );
        let mut taken = HashSet::new();
        let name = folder_name(&first, &taken);
        assert!(name.ends_with(" Standup"), "{name}");
        taken.insert(name.clone());
        let second = folder_name(&first, &taken);
        assert_eq!(second, format!("{name} (11111111)"));
    }

    #[tokio::test]
    async fn a_meeting_round_trips_through_its_own_folder() {
        let root = scratch("round-trip");
        let mut library = Library::new(root.clone());
        let mut record = meeting("abc", "Design review", 1_757_030_400_000);
        library.save(&mut record).await.unwrap();
        library.save_documents(&record).await.unwrap();

        let folder = root.join(record.folder.clone().unwrap());
        assert!(folder.join("meeting.json").is_file());
        let transcript = std::fs::read_to_string(folder.join("transcript.md")).unwrap();
        assert!(
            transcript.contains("**[00:01] You:** morning"),
            "{transcript}"
        );
        let summary = std::fs::read_to_string(folder.join("summary.md")).unwrap();
        assert!(summary.contains("It went well."));
        assert!(summary.contains("Ship on Friday"));

        let mut reopened = Library::new(root.clone());
        let loaded = reopened.load().await;
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "abc");
        assert_eq!(loaded[0].folder, record.folder);

        assert!(reopened.remove("abc").await.unwrap());
        assert!(!folder.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn renaming_a_meeting_carries_its_folder_along() {
        let root = scratch("rename");
        let mut library = Library::new(root.clone());
        let mut record = meeting("abc", "Untitled Meeting", 1_757_030_400_000);
        library.save(&mut record).await.unwrap();
        let first = root.join(record.folder.clone().unwrap());

        record.title = "Board sync".into();
        library.save(&mut record).await.unwrap();
        let second = root.join(record.folder.clone().unwrap());

        assert!(!first.exists());
        assert!(second.join("meeting.json").is_file());
        assert!(second.to_string_lossy().ends_with("Board sync"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn the_old_meetings_file_is_imported_once_and_deletions_stick() {
        let root = scratch("import");
        let legacy = root.join("meetings.json");
        std::fs::write(
            &legacy,
            serde_json::to_vec(&vec![meeting("abc", "Design review", 1_757_030_400_000)]).unwrap(),
        )
        .unwrap();

        let mut library = Library::new(root.join("library"));
        tokio::fs::create_dir_all(library.root()).await.unwrap();
        let imported = library.import_from(&legacy).await;
        assert_eq!(imported.len(), 1);
        assert!(library.path_of("abc").unwrap().join("summary.md").is_file());

        assert!(library.remove("abc").await.unwrap());
        let mut reopened = Library::new(library.root().to_path_buf());
        assert!(reopened.load().await.is_empty());
        assert!(reopened.import_from(&legacy).await.is_empty());
        assert!(legacy.is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_finished_recording_moves_in_beside_the_transcript() {
        let root = scratch("recording");
        let mut library = Library::new(root.clone());
        let mut record = meeting("abc", "Design review", 1_757_030_400_000);
        library.save(&mut record).await.unwrap();

        let in_progress = root.join(".in-progress").join("abc");
        std::fs::create_dir_all(&in_progress).unwrap();
        std::fs::write(in_progress.join("screen.webm"), b"video").unwrap();
        std::fs::write(in_progress.join("recording.json"), b"{}").unwrap();
        record.recording = Some(json!({"videoPath": ".in-progress/abc/screen.webm"}));

        assert!(library
            .adopt_recording(&mut record, Some(&root))
            .await
            .unwrap());
        let folder = root.join(record.folder.clone().unwrap());
        assert!(folder.join("recording.webm").is_file());
        assert!(!in_progress.exists());
        assert_eq!(
            record.recording.as_ref().unwrap()["videoPath"],
            json!(format!("{}/recording.webm", record.folder.clone().unwrap()))
        );

        let elsewhere = scratch("elsewhere");
        assert!(!library
            .adopt_recording(&mut record, Some(&elsewhere))
            .await
            .unwrap());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(elsewhere).unwrap();
    }
}
