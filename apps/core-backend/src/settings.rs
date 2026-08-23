//! Persisted user settings and credentials.
//!
//! Two files, because they have different handling: `settings.json` holds ordinary
//! preferences and is safe to read, log and ship in a bug report, while
//! `credentials.json` holds API keys and is written `0600` and never leaves this
//! process. Before this existed `POST /api/settings` accepted a write, applied two
//! of the keys to the running engine, dropped the rest and stored nothing — so the
//! UI's "Saved" message was not true and no key could survive a restart.
//!
//! Keys are checked against an allowlist so an unknown field from a newer UI does
//! not silently accumulate in the file forever.

use serde_json::{json, Map, Value};
use std::{
    env, io,
    path::{Path, PathBuf},
};
use tokio::sync::RwLock;

/// Settings the backend understands. Anything else is rejected with a warning so
/// the UI finds out rather than believing a write landed.
const KNOWN_SETTINGS: [&str; 15] = [
    "transcriptionProvider",
    "whisperModel",
    "sttLanguage",
    "sarvamLanguage",
    "sarvamMode",
    "sarvamNumSpeakers",
    "aiModel",
    "summaryProvider",
    "autoSummarize",
    "echoSuppression",
    "micDeviceId",
    "systemDeviceId",
    "recordScreen",
    "recordingSource",
    "recordingBitsPerSecond",
];

const GEMINI_KEY: &str = "geminiApiKey";
const SARVAM_KEY: &str = "sarvamApiKey";

/// Computed fields the UI reads back and then sends again on the next save. They
/// are not settings, but they are not mistakes either, so accept them silently
/// rather than warning the user about their own round trip.
const IGNORED_ON_WRITE: [&str; 4] = [GEMINI_KEY, "geminiApiKeySet", SARVAM_KEY, "sarvamApiKeySet"];

/// Where both files live. Deliberately derived the same way as the meeting store
/// so a single `ALPHA_DATA_DIR` moves everything together.
pub fn data_dir() -> PathBuf {
    if let Some(file) = env::var_os("CORE_BACKEND_DATA_FILE").map(PathBuf::from) {
        if let Some(parent) = file.parent() {
            return parent.to_path_buf();
        }
    }
    let base = env::var_os("ALPHA_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    base.join(".alpha-meeting-assistant")
}

pub struct SettingsStore {
    settings_path: PathBuf,
    credentials_path: PathBuf,
    settings: RwLock<Map<String, Value>>,
    credentials: RwLock<Map<String, Value>>,
}

async fn read_object(path: &Path) -> Map<String, Value> {
    tokio::fs::read(path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

/// Write-then-rename, so a crash mid-write cannot leave a truncated file where a
/// valid one used to be.
async fn write_object(path: &Path, object: &Map<String, Value>, private: bool) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let bytes =
        serde_json::to_vec_pretty(&Value::Object(object.clone())).map_err(io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, bytes).await?;

    // Set the mode on the temp file: after the rename the permissions are already
    // correct, so the key is never briefly world-readable.
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).await?;
    }
    #[cfg(not(unix))]
    let _ = private;

    tokio::fs::rename(tmp, path).await
}

impl SettingsStore {
    pub async fn load() -> Self {
        let dir = data_dir();
        let settings_path = dir.join("settings.json");
        let credentials_path = dir.join("credentials.json");
        Self {
            settings: RwLock::new(read_object(&settings_path).await),
            credentials: RwLock::new(read_object(&credentials_path).await),
            settings_path,
            credentials_path,
        }
    }

    /// The stored settings, plus whether each private key exists. Never the keys:
    /// this is served to any local process that asks.
    pub async fn public_value(&self) -> Value {
        let mut out = self.settings.read().await.clone();
        let credentials = self.credentials.read().await;
        out.insert(
            "geminiApiKeySet".into(),
            Value::Bool(credentials.contains_key(GEMINI_KEY)),
        );
        out.insert(
            "sarvamApiKeySet".into(),
            Value::Bool(credentials.contains_key(SARVAM_KEY)),
        );
        for provider in ["google", "microsoft"] {
            out.insert(
                format!("{provider}CalendarConnected"),
                Value::Bool(credentials.contains_key(&format!("{provider}CalendarToken"))),
            );
            out.insert(
                format!("{provider}CalendarClientIdSet"),
                Value::Bool(credentials.contains_key(&format!("{provider}CalendarClientId"))),
            );
        }
        Value::Object(out)
    }

    pub async fn get_str(&self, key: &str) -> Option<String> {
        self.settings
            .read()
            .await
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    pub async fn get_bool(&self, key: &str) -> Option<bool> {
        self.settings.read().await.get(key).and_then(Value::as_bool)
    }

    pub async fn get_i64(&self, key: &str) -> Option<i64> {
        self.settings.read().await.get(key).and_then(Value::as_i64)
    }

    pub async fn gemini_key(&self) -> Option<String> {
        self.credential(GEMINI_KEY).await
    }

    pub async fn sarvam_key(&self) -> Option<String> {
        self.credential(SARVAM_KEY).await
    }

    pub async fn credential(&self, name: &str) -> Option<String> {
        self.credentials
            .read()
            .await
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|key| !key.is_empty())
    }

    /// Merge a batch of settings. Returns the keys it refused, so the caller can
    /// report them instead of pretending everything was stored.
    pub async fn merge(&self, incoming: &Map<String, Value>) -> (Vec<String>, io::Result<()>) {
        let mut rejected = Vec::new();
        {
            let mut settings = self.settings.write().await;
            for (key, value) in incoming {
                if IGNORED_ON_WRITE.contains(&key.as_str()) {
                    continue;
                }
                if KNOWN_SETTINGS.contains(&key.as_str()) {
                    settings.insert(key.clone(), value.clone());
                } else {
                    rejected.push(key.clone());
                }
            }
        }
        let snapshot = self.settings.read().await.clone();
        (
            rejected,
            write_object(&self.settings_path, &snapshot, false).await,
        )
    }

    /// An empty or whitespace-only value clears the key rather than storing a
    /// blank one that would read as "configured".
    pub async fn set_gemini_key(&self, key: Option<&str>) -> io::Result<Option<String>> {
        self.set_credential(GEMINI_KEY, key).await
    }

    pub async fn set_sarvam_key(&self, key: Option<&str>) -> io::Result<Option<String>> {
        self.set_credential(SARVAM_KEY, key).await
    }

    pub async fn set_credential(&self, name: &str, key: Option<&str>) -> io::Result<Option<String>> {
        let cleaned = key
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(str::to_string);
        {
            let mut credentials = self.credentials.write().await;
            match &cleaned {
                Some(value) => credentials.insert(name.into(), json!(value)),
                None => credentials.remove(name),
            };
        }
        let snapshot = self.credentials.read().await.clone();
        write_object(&self.credentials_path, &snapshot, true).await?;
        Ok(cleaned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn store_in(dir: &Path) -> SettingsStore {
        SettingsStore {
            settings_path: dir.join("settings.json"),
            credentials_path: dir.join("credentials.json"),
            settings: RwLock::new(Map::new()),
            credentials: RwLock::new(Map::new()),
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("alpha-settings-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn round_trips_known_settings_and_rejects_unknown_ones() {
        let dir = scratch("round-trip");
        let store = store_in(&dir).await;

        let mut incoming = Map::new();
        incoming.insert("sttLanguage".into(), json!("auto"));
        incoming.insert("autoSummarize".into(), json!(false));
        incoming.insert("somethingInvented".into(), json!("x"));

        let (rejected, result) = store.merge(&incoming).await;
        result.unwrap();
        assert_eq!(rejected, vec!["somethingInvented"]);
        assert_eq!(store.get_str("sttLanguage").await.as_deref(), Some("auto"));
        assert_eq!(store.get_bool("autoSummarize").await, Some(false));

        // Reload from disk to prove it actually persisted.
        let reloaded = SettingsStore {
            settings: RwLock::new(read_object(&dir.join("settings.json")).await),
            credentials: RwLock::new(Map::new()),
            settings_path: dir.join("settings.json"),
            credentials_path: dir.join("credentials.json"),
        };
        assert_eq!(
            reloaded.get_str("sttLanguage").await.as_deref(),
            Some("auto")
        );
        assert_eq!(reloaded.get_bool("autoSummarize").await, Some(false));
        assert!(reloaded.get_str("somethingInvented").await.is_none());
    }

    #[tokio::test]
    async fn the_public_value_reports_keys_without_revealing_them() {
        let dir = scratch("public-value");
        let store = store_in(&dir).await;
        store.set_gemini_key(Some("AIzaSUPERSECRET")).await.unwrap();
        store.set_sarvam_key(Some("sk_SARVAMSECRET")).await.unwrap();

        let public = store.public_value().await.to_string();
        assert!(public.contains("\"geminiApiKeySet\":true"));
        assert!(public.contains("\"sarvamApiKeySet\":true"));
        assert!(!public.contains("AIzaSUPERSECRET"));
        assert!(!public.contains("sk_SARVAMSECRET"));
        assert_eq!(store.gemini_key().await.as_deref(), Some("AIzaSUPERSECRET"));
        assert_eq!(store.sarvam_key().await.as_deref(), Some("sk_SARVAMSECRET"));
    }

    #[tokio::test]
    async fn a_blank_key_clears_rather_than_stores_an_empty_one() {
        let dir = scratch("blank-key");
        let store = store_in(&dir).await;

        store.set_gemini_key(Some("  real-key  ")).await.unwrap();
        assert_eq!(store.gemini_key().await.as_deref(), Some("real-key"));

        store.set_gemini_key(Some("   ")).await.unwrap();
        assert!(store.gemini_key().await.is_none());
        assert!(store
            .public_value()
            .await
            .to_string()
            .contains("\"geminiApiKeySet\":false"));
    }

    #[tokio::test]
    async fn a_key_never_leaks_into_the_settings_file() {
        let dir = scratch("no-leak");
        let store = store_in(&dir).await;

        let mut incoming = Map::new();
        incoming.insert("geminiApiKey".into(), json!("AIzaLEAKED"));
        incoming.insert("geminiApiKeySet".into(), json!(true));
        incoming.insert("sarvamApiKey".into(), json!("sk_LEAKED"));
        incoming.insert("sarvamApiKeySet".into(), json!(true));
        incoming.insert("sttLanguage".into(), json!("hi"));
        let (rejected, result) = store.merge(&incoming).await;
        result.unwrap();

        // It is neither stored as a setting nor reported as an unknown key.
        assert!(rejected.is_empty());
        let written = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        assert!(!written.contains("AIzaLEAKED"));
        assert!(!written.contains("geminiApiKey"));
        assert!(!written.contains("geminiApiKeySet"));
        assert!(!written.contains("sk_LEAKED"));
        assert!(!written.contains("sarvamApiKey"));
        assert!(!written.contains("sarvamApiKeySet"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_credentials_file_is_not_world_readable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("perms");
        let store = store_in(&dir).await;
        store.set_gemini_key(Some("k")).await.unwrap();

        let mode = std::fs::metadata(dir.join("credentials.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "credentials must be owner-only");
    }
}
