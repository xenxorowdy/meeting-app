use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgSslMode};
use sqlx::Row;
use std::{
    env,
    str::FromStr,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{OnceCell, RwLock};

const DEFAULT_MAX_CONNECTIONS: u32 = 5;
const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 10;
const TRANSACTION_POOLER_PORT: u16 = 6543;
const UNCONFIGURED: &str =
    "Supabase is not configured. Set ALPHA_SUPABASE_DB_URL, or ALPHA_SUPABASE_URL plus ALPHA_SUPABASE_DB_PASSWORD.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub transaction_pooler: bool,
}

struct Config {
    options: PgConnectOptions,
    endpoint: Endpoint,
    max_connections: u32,
    connect_timeout: Duration,
    source: &'static str,
}

#[derive(Clone, Debug)]
pub struct Check {
    pub ok: bool,
    pub latency_ms: u64,
    pub server_version: Option<String>,
    pub error: Option<String>,
    pub checked_at: i64,
}

pub struct SupabaseDb {
    config: Option<Config>,
    secret: Option<String>,
    pool: OnceCell<PgPool>,
    last: RwLock<Option<Check>>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn env_value(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_number<T: FromStr>(key: &str, fallback: T) -> T {
    env_value(key)
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

pub(crate) fn project_ref_from_url(value: &str) -> Option<String> {
    let host = value
        .trim()
        .rsplit("://")
        .next()?
        .split('/')
        .next()?
        .split('@')
        .next_back()?
        .split(':')
        .next()?;
    let reference = host
        .strip_suffix(".supabase.co")
        .or_else(|| host.strip_suffix(".supabase.in"))?;
    let reference = reference.strip_prefix("db.").unwrap_or(reference);
    if reference.is_empty() || reference.contains('.') {
        return None;
    }
    Some(reference.to_string())
}

pub(crate) fn encode_password(password: &str) -> String {
    let mut encoded = String::with_capacity(password.len());
    for byte in password.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(*byte as char)
            }
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

pub(crate) fn redact(message: &str, secret: Option<&str>) -> String {
    let mut cleaned = message.to_string();
    if let Some(secret) = secret.filter(|value| !value.is_empty()) {
        cleaned = cleaned.replace(secret, "***");
        cleaned = cleaned.replace(&encode_password(secret), "***");
    }
    let mut search = 0;
    while let Some(offset) = cleaned[search..].find("://") {
        let rest = search + offset + 3;
        let Some(at) = cleaned[rest..].find('@') else { break };
        let end = rest + at;
        match cleaned[rest..end].find(':') {
            Some(colon) if !cleaned[rest..rest + colon].contains('/') => {
                let start = rest + colon + 1;
                cleaned.replace_range(start..end, "***");
                search = start + 3;
            }
            _ => search = rest,
        }
    }
    cleaned
}

fn configured_url() -> Option<(String, &'static str)> {
    if let Some(url) = env_value("ALPHA_SUPABASE_DB_URL") {
        return Some((url, "ALPHA_SUPABASE_DB_URL"));
    }
    let (reference, source) = match env_value("ALPHA_SUPABASE_PROJECT_REF") {
        Some(reference) => (reference, "ALPHA_SUPABASE_PROJECT_REF"),
        None => (
            env_value("ALPHA_SUPABASE_URL")
                .as_deref()
                .and_then(project_ref_from_url)?,
            "ALPHA_SUPABASE_URL",
        ),
    };
    let Some(password) = env_value("ALPHA_SUPABASE_DB_PASSWORD") else {
        eprintln!("[Alpha Core Backend] Supabase: {source} is set but ALPHA_SUPABASE_DB_PASSWORD is empty");
        return None;
    };
    let url = format!(
        "postgres://postgres:{}@db.{reference}.supabase.co:5432/postgres?sslmode=require",
        encode_password(&password)
    );
    Some((url, source))
}

fn password_from_url(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    let credentials = rest.split('/').next()?.rsplit_once('@')?.0;
    let (_, password) = credentials.split_once(':')?;
    if password.is_empty() {
        return None;
    }
    Some(decode_password(password))
}

fn decode_password(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                decoded.push(byte);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).unwrap_or_else(|_| value.to_string())
}

impl SupabaseDb {
    pub fn detect() -> Self {
        let Some((url, source)) = configured_url() else {
            return Self::unconfigured(None);
        };
        let secret = password_from_url(&url);
        let options = match PgConnectOptions::from_str(&url) {
            Ok(options) => options,
            Err(cause) => {
                eprintln!(
                    "[Alpha Core Backend] Supabase connection string ignored: {}",
                    redact(&cause.to_string(), secret.as_deref())
                );
                return Self::unconfigured(secret);
            }
        };
        let options = if url.contains("sslmode=") {
            options
        } else {
            options.ssl_mode(PgSslMode::Require)
        };
        let host = options.get_host().to_string();
        let port = options.get_port();
        let transaction_pooler = port == TRANSACTION_POOLER_PORT;
        let options = if transaction_pooler {
            options.statement_cache_capacity(0)
        } else {
            options
        };
        let endpoint = Endpoint {
            host,
            port,
            database: options.get_database().unwrap_or("postgres").to_string(),
            username: options.get_username().to_string(),
            transaction_pooler,
        };
        Self {
            config: Some(Config {
                options,
                endpoint,
                max_connections: env_number("ALPHA_SUPABASE_MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS)
                    .max(1),
                connect_timeout: Duration::from_secs(
                    env_number(
                        "ALPHA_SUPABASE_CONNECT_TIMEOUT_SECS",
                        DEFAULT_CONNECT_TIMEOUT_SECS,
                    )
                    .max(1),
                ),
                source,
            }),
            secret,
            pool: OnceCell::new(),
            last: RwLock::new(None),
        }
    }

    fn unconfigured(secret: Option<String>) -> Self {
        Self {
            config: None,
            secret,
            pool: OnceCell::new(),
            last: RwLock::new(None),
        }
    }

    pub fn configured(&self) -> bool {
        self.config.is_some()
    }

    pub fn endpoint(&self) -> Option<&Endpoint> {
        self.config.as_ref().map(|config| &config.endpoint)
    }

    pub async fn pool(&self) -> Result<&PgPool, String> {
        let config = self.config.as_ref().ok_or_else(|| UNCONFIGURED.to_string())?;
        self.pool
            .get_or_try_init(|| async {
                PgPoolOptions::new()
                    .max_connections(config.max_connections)
                    .acquire_timeout(config.connect_timeout)
                    .connect_with(config.options.clone())
                    .await
                    .map_err(|cause| redact(&cause.to_string(), self.secret.as_deref()))
            })
            .await
    }

    pub async fn check(&self) -> Check {
        let started = Instant::now();
        let outcome = match self.pool().await {
            Ok(pool) => sqlx::query("select version()")
                .fetch_one(pool)
                .await
                .map_err(|cause| redact(&cause.to_string(), self.secret.as_deref()))
                .and_then(|row| {
                    row.try_get::<String, _>(0)
                        .map_err(|cause| redact(&cause.to_string(), self.secret.as_deref()))
                }),
            Err(cause) => Err(cause),
        };
        let check = Check {
            ok: outcome.is_ok(),
            latency_ms: started.elapsed().as_millis() as u64,
            server_version: outcome.as_ref().ok().map(|version| short_version(version)),
            error: outcome.err(),
            checked_at: now_ms(),
        };
        *self.last.write().await = Some(check.clone());
        check
    }

    pub async fn status_value(&self) -> Value {
        let last = self.last.read().await.clone();
        let Some(config) = self.config.as_ref() else {
            return json!({
                "configured": false,
                "status": "unconfigured",
                "hint": UNCONFIGURED,
            });
        };
        json!({
            "configured": true,
            "status": status_label(last.as_ref()),
            "source": config.source,
            "host": config.endpoint.host,
            "port": config.endpoint.port,
            "database": config.endpoint.database,
            "user": config.endpoint.username,
            "transactionPooler": config.endpoint.transaction_pooler,
            "maxConnections": config.max_connections,
            "connectTimeoutSeconds": config.connect_timeout.as_secs(),
            "lastCheckedAt": last.as_ref().map(|check| check.checked_at),
            "latencyMs": last.as_ref().filter(|check| check.ok).map(|check| check.latency_ms),
            "serverVersion": last.as_ref().and_then(|check| check.server_version.clone()),
            "error": last.as_ref().and_then(|check| check.error.clone()),
        })
    }

    pub async fn public_status(&self) -> Value {
        json!({
            "configured": self.configured(),
            "status": if self.configured() {
                status_label(self.last.read().await.as_ref())
            } else {
                "unconfigured"
            },
        })
    }
}

fn status_label(last: Option<&Check>) -> &'static str {
    match last {
        None => "unknown",
        Some(check) if check.ok => "ok",
        Some(_) => "error",
    }
}

fn short_version(version: &str) -> String {
    version
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_project_ref_from_every_supabase_url_shape() {
        assert_eq!(project_ref_from_url("https://abcdefgh.supabase.co").as_deref(), Some("abcdefgh"));
        assert_eq!(project_ref_from_url("https://abcdefgh.supabase.co/").as_deref(), Some("abcdefgh"));
        assert_eq!(project_ref_from_url("abcdefgh.supabase.co").as_deref(), Some("abcdefgh"));
        assert_eq!(
            project_ref_from_url("postgres://postgres:pw@db.abcdefgh.supabase.co:5432/postgres").as_deref(),
            Some("abcdefgh")
        );
        assert_eq!(project_ref_from_url("https://example.com"), None);
    }

    #[test]
    fn percent_encodes_password_specials() {
        assert_eq!(encode_password("simple-pass_1.0~"), "simple-pass_1.0~");
        assert_eq!(encode_password("p@ss:w/rd?#[]"), "p%40ss%3Aw%2Frd%3F%23%5B%5D");
    }

    #[test]
    fn round_trips_an_encoded_password_out_of_a_url() {
        let url = format!(
            "postgres://postgres:{}@db.ref.supabase.co:5432/postgres",
            encode_password("p@ss:word/1")
        );
        assert_eq!(password_from_url(&url).as_deref(), Some("p@ss:word/1"));
        assert_eq!(password_from_url("postgres://postgres@host:5432/postgres"), None);
    }

    #[test]
    fn redacts_the_password_in_plain_and_encoded_form() {
        let message = redact("auth failed for p@ssw0rd and p%40ssw0rd", Some("p@ssw0rd"));
        assert!(!message.contains("p@ssw0rd"), "{message}");
        assert!(!message.contains("p%40ssw0rd"), "{message}");
    }

    #[test]
    fn redacts_credentials_embedded_in_a_connection_string() {
        let message = redact(
            "error connecting to postgres://postgres:secret@db.ref.supabase.co:5432/postgres",
            None,
        );
        assert!(!message.contains("secret"), "{message}");
        assert!(message.contains("db.ref.supabase.co"), "{message}");
    }

    #[test]
    fn redacts_every_connection_string_in_one_message() {
        let message = redact(
            "tried postgres://postgres:first@a.supabase.co:5432/postgres then postgres://postgres:second@b.supabase.co:5432/postgres",
            None,
        );
        assert!(!message.contains("first"), "{message}");
        assert!(!message.contains("second"), "{message}");
        assert_eq!(message.matches("***").count(), 2, "{message}");
    }

    #[test]
    fn terminates_on_an_at_sign_that_is_not_a_credential() {
        assert_eq!(redact("see https://x.test/a@b", None), "see https://x.test/a@b");
    }

    #[test]
    fn leaves_ordinary_urls_alone() {
        assert_eq!(redact("see https://supabase.com/docs", None), "see https://supabase.com/docs");
    }

    #[test]
    fn shortens_the_reported_server_version() {
        assert_eq!(
            short_version("PostgreSQL 15.8 on aarch64-unknown-linux-gnu, compiled by gcc"),
            "PostgreSQL 15.8"
        );
    }
}
