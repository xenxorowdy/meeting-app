use crate::accounts::AccountStore;
use crate::billing::{BillingStore, Subscription};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgSslMode};
use sqlx::Row;
use std::{
    str::FromStr,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, OnceCell, RwLock};

const DEFAULT_MAX_CONNECTIONS: u32 = 5;
const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 10;
const TRANSACTION_POOLER_PORT: u16 = 6543;
const UNCONFIGURED: &str =
    "Supabase is not configured. Set KESAMI_SUPABASE_DB_URL, or KESAMI_SUPABASE_URL plus KESAMI_SUPABASE_DB_PASSWORD.";

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
    billing_lock: Mutex<()>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

const MIGRATIONS_SCHEMA_SQL: &str = "DO $$ BEGIN \
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'alpha_migrations') \
       AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'kesami_migrations') THEN \
        ALTER SCHEMA alpha_migrations RENAME TO kesami_migrations; \
    END IF; \
END $$; \
CREATE SCHEMA IF NOT EXISTS kesami_migrations; \
CREATE TABLE IF NOT EXISTS kesami_migrations.applied (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())";

fn env_value(key: &str) -> Option<String> {
    kesami_core_backend::env_compat::var(key)
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
        let Some(at) = cleaned[rest..].find('@') else {
            break;
        };
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
    if let Some(url) = env_value("KESAMI_SUPABASE_DB_URL") {
        return Some((url, "KESAMI_SUPABASE_DB_URL"));
    }
    let (reference, source) = match env_value("KESAMI_SUPABASE_PROJECT_REF") {
        Some(reference) => (reference, "KESAMI_SUPABASE_PROJECT_REF"),
        None => (
            env_value("KESAMI_SUPABASE_URL")
                .as_deref()
                .and_then(project_ref_from_url)?,
            "KESAMI_SUPABASE_URL",
        ),
    };
    let Some(password) = env_value("KESAMI_SUPABASE_DB_PASSWORD") else {
        eprintln!("[Kesami Core Backend] Supabase: {source} is set but KESAMI_SUPABASE_DB_PASSWORD is empty");
        return None;
    };
    let url = supabase_url(
        &reference,
        &password,
        env_value("KESAMI_SUPABASE_POOLER_REGION").as_deref(),
    );
    Some((url, source))
}

fn supabase_url(reference: &str, password: &str, pooler_region: Option<&str>) -> String {
    let encoded = encode_password(password);
    match pooler_region {
        Some(region) => format!(
            "postgres://postgres.{reference}:{encoded}@aws-0-{region}.pooler.supabase.com:5432/postgres?sslmode=require"
        ),
        None => format!(
            "postgres://postgres:{encoded}@db.{reference}.supabase.co:5432/postgres?sslmode=require"
        ),
    }
}

fn pooler_host(host: &str) -> bool {
    host.ends_with(".pooler.supabase.com") || host.ends_with(".pooler.supabase.in")
}

fn direct_host_hint(endpoint: &Endpoint) -> Option<String> {
    let direct = endpoint.host.starts_with("db.")
        && (endpoint.host.ends_with(".supabase.co") || endpoint.host.ends_with(".supabase.in"));
    if !direct {
        return None;
    }
    Some(format!(
        "{} is the direct database host, which resolves to IPv6 only on current Supabase projects, so a machine without IPv6 egress can never open a connection to it. Set KESAMI_SUPABASE_POOLER_REGION to the project's region (Project Settings > Database > Connection pooling, e.g. ap-south-1) to route through the pooler instead, or set KESAMI_SUPABASE_DB_URL to the full pooler URI.",
        endpoint.host
    ))
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
                    "[Kesami Core Backend] Supabase connection string ignored: {}",
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
        let options = if transaction_pooler
            || pooler_host(&host)
            || host.ends_with(".supabase.co")
            || host.ends_with(".supabase.in")
        {
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
                max_connections: env_number(
                    "KESAMI_SUPABASE_MAX_CONNECTIONS",
                    DEFAULT_MAX_CONNECTIONS,
                )
                .max(1),
                connect_timeout: Duration::from_secs(
                    env_number(
                        "KESAMI_SUPABASE_CONNECT_TIMEOUT_SECS",
                        DEFAULT_CONNECT_TIMEOUT_SECS,
                    )
                    .max(1),
                ),
                source,
            }),
            secret,
            pool: OnceCell::new(),
            last: RwLock::new(None),
            billing_lock: Mutex::new(()),
        }
    }

    fn unconfigured(secret: Option<String>) -> Self {
        Self {
            config: None,
            secret,
            pool: OnceCell::new(),
            last: RwLock::new(None),
            billing_lock: Mutex::new(()),
        }
    }

    pub fn configured(&self) -> bool {
        self.config.is_some()
    }

    pub fn endpoint(&self) -> Option<&Endpoint> {
        self.config.as_ref().map(|config| &config.endpoint)
    }

    pub async fn pool(&self) -> Result<&PgPool, String> {
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| UNCONFIGURED.to_string())?;
        self.pool
            .get_or_try_init(|| async {
                PgPoolOptions::new()
                    .max_connections(config.max_connections)
                    .acquire_timeout(config.connect_timeout)
                    .connect_with(config.options.clone())
                    .await
                    .map_err(|cause| {
                        let masked = matches!(cause, sqlx::Error::PoolTimedOut);
                        let message = redact(&cause.to_string(), self.secret.as_deref());
                        match direct_host_hint(&config.endpoint).filter(|_| masked) {
                            Some(hint) => format!("{message} — {hint}"),
                            None => message,
                        }
                    })
            })
            .await
    }

    pub async fn check(&self) -> Check {
        let started = Instant::now();
        let outcome = match self.pool().await {
            Ok(pool) => sqlx::query("select version()")
                .persistent(false)
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

    fn step_failure(&self, message: &str, cause: sqlx::Error) -> String {
        format!(
            "{message} {}",
            redact(&cause.to_string(), self.secret.as_deref())
        )
    }

    /// Explicit operator action, never run on desktop startup. Serialize setup
    /// and preserve any pre-existing public.users table we do not own.
    pub async fn migrate_users(&self) -> Result<(), String> {
        let pool = self.pool().await?;
        let mut tx = pool
            .begin()
            .await
            .map_err(|cause| self.step_failure("Could not start users migration.", cause))?;
        sqlx::query("SELECT pg_advisory_xact_lock(48900, 1)")
            .persistent(false)
            .execute(&mut *tx)
            .await
            .map_err(|cause| self.step_failure("Could not lock users migration.", cause))?;
        sqlx::raw_sql(MIGRATIONS_SCHEMA_SQL)
            .execute(&mut *tx).await.map_err(|cause| self.step_failure("Could not prepare migration tracking.", cause))?;
        let applied: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM kesami_migrations.applied WHERE name = '001_supabase_users')")
            .persistent(false)
            .fetch_one(&mut *tx).await.map_err(|cause| self.step_failure("Could not read migration tracking.", cause))?;
        let exists: bool = sqlx::query_scalar("SELECT to_regclass('public.users') IS NOT NULL")
            .persistent(false)
            .fetch_one(&mut *tx)
            .await
            .map_err(|cause| self.step_failure("Could not inspect public.users.", cause))?;
        if exists && !applied {
            return Err("public.users already exists and was not created by this migration. Its data and access rules were left unchanged; review its schema before integrating it.".into());
        }
        if !exists {
            sqlx::raw_sql(include_str!("../migrations/001_supabase_users.sql")).execute(&mut *tx).await
                .map_err(|cause| self.step_failure("Could not create public.users. Use an owner connection to the Supabase database; no changes were committed.", cause))?;
            if !applied {
                sqlx::query(
                    "INSERT INTO kesami_migrations.applied (name) VALUES ('001_supabase_users')",
                )
                .persistent(false)
                .execute(&mut *tx)
                .await
                .map_err(|cause| self.step_failure("Could not record users migration.", cause))?;
            }
        }
        // Existing Supabase Google accounts may predate this profile table.
        // Fill missing profiles and blank names from Google's identity data;
        // preserve names already set on application profiles.
        sqlx::query("INSERT INTO public.users (id, email, name) \
            SELECT users.id, users.email, \
                COALESCE(NULLIF(btrim(identity.identity_data->>'full_name'), ''), \
                         NULLIF(btrim(identity.identity_data->>'name'), ''), '') \
            FROM auth.users AS users \
            JOIN LATERAL (SELECT identity_data FROM auth.identities \
                WHERE user_id = users.id AND provider = 'google' \
                ORDER BY created_at DESC LIMIT 1) AS identity ON true \
            WHERE users.email IS NOT NULL AND users.email <> '' \
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now() \
            WHERE btrim(public.users.name) = '' AND EXCLUDED.name <> ''")
            .persistent(false)
            .execute(&mut *tx).await
            .map_err(|cause| self.step_failure("Could not backfill Google user profiles and missing names; no changes were committed.", cause))?;
        tx.commit()
            .await
            .map_err(|cause| self.step_failure("Could not commit users migration.", cause))
    }

    /// Explicit operator action. Refuse to adopt pre-existing billing tables
    /// because their constraints and access rules may differ from ours.
    pub async fn migrate_billing(&self) -> Result<(), String> {
        let pool = self.pool().await?;
        let mut tx = pool
            .begin()
            .await
            .map_err(|cause| self.step_failure("Could not start billing migration.", cause))?;
        sqlx::query("SELECT pg_advisory_xact_lock(48900, 2)")
            .persistent(false)
            .execute(&mut *tx)
            .await
            .map_err(|cause| self.step_failure("Could not lock billing migration.", cause))?;
        sqlx::raw_sql(MIGRATIONS_SCHEMA_SQL)
            .execute(&mut *tx).await.map_err(|cause| self.step_failure("Could not prepare migration tracking.", cause))?;
        let applied: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM kesami_migrations.applied WHERE name = '002_supabase_billing')")
            .persistent(false)
            .fetch_one(&mut *tx).await.map_err(|cause| self.step_failure("Could not read migration tracking.", cause))?;
        let tables: (bool, bool) = sqlx::query_as("SELECT to_regclass('public.billing') IS NOT NULL, to_regclass('public.billing_events') IS NOT NULL")
            .persistent(false)
            .fetch_one(&mut *tx).await.map_err(|cause| self.step_failure("Could not inspect billing tables.", cause))?;
        if applied {
            if !tables.0 || !tables.1 {
                return Err("Billing migration is recorded, but one or both tables are missing. Review the database before continuing.".into());
            }
        } else {
            if tables.0 || tables.1 {
                return Err("A billing table already exists and was not created by this migration. Its data and access rules were left unchanged; review its schema before integrating it.".into());
            }
            sqlx::raw_sql(include_str!("../migrations/002_supabase_billing.sql"))
                .execute(&mut *tx).await.map_err(|cause| self.step_failure("Could not create billing tables. Use an owner connection to the Supabase database; no changes were committed.", cause))?;
            sqlx::query("INSERT INTO kesami_migrations.applied (name) VALUES ('002_supabase_billing')")
                .persistent(false)
                .execute(&mut *tx).await
                .map_err(|cause| self.step_failure("Could not record billing migration.", cause))?;
        }
        let access_ok: bool = sqlx::query_scalar("SELECT \
            (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.billing'::regclass) \
            AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.billing_events'::regclass) \
            AND has_table_privilege('authenticated', 'public.billing', 'SELECT') \
            AND NOT has_table_privilege('authenticated', 'public.billing', 'INSERT') \
            AND NOT has_table_privilege('anon', 'public.billing', 'SELECT') \
            AND NOT has_table_privilege('authenticated', 'public.billing_events', 'SELECT') \
            AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'billing' AND policyname = 'billing_select_own')")
            .persistent(false)
            .fetch_one(&mut *tx).await
            .map_err(|cause| self.step_failure("Could not verify billing access rules.", cause))?;
        if !access_ok {
            return Err("Billing tables exist, but their RLS or grants differ from the expected access rules. Review the database before continuing.".into());
        }
        tx.commit()
            .await
            .map_err(|cause| self.step_failure("Could not commit billing migration.", cause))
    }

    async fn save_subscription(&self, google_sub: &str, subscription: &Subscription) -> Result<bool, String> {
        let pool = self.pool().await?;
        let users: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT user_id::text FROM auth.identities \
             WHERE provider = 'google' AND (provider_id = $1 OR identity_data->>'sub' = $1) LIMIT 2",
        )
        .bind(google_sub)
        .persistent(false)
        .fetch_all(pool)
        .await
        .map_err(|cause| self.step_failure("Could not find the Supabase user for a subscription.", cause))?;
        let [user_id] = users.as_slice() else {
            return Ok(false);
        };
        kesami_core_backend::billing_db::save_subscription(pool, user_id, subscription, None)
            .await.map_err(|cause| self.step_failure("Could not save a subscription to Supabase.", cause))?;
        Ok(true)
    }

    pub async fn subscription_for_google(&self, google_sub: &str, account_id: &str) -> Result<Option<Subscription>, String> {
        let pool = self.pool().await?;
        let users: Vec<String> = sqlx::query_scalar("SELECT DISTINCT user_id::text FROM auth.identities WHERE provider='google' AND (provider_id=$1 OR identity_data->>'sub'=$1) LIMIT 2")
            .bind(google_sub).persistent(false).fetch_all(pool).await
            .map_err(|cause| self.step_failure("Could not find the subscription user.",cause))?;
        let [user] = users.as_slice() else { return Ok(None); };
        let mut sub = kesami_core_backend::billing_db::subscription(pool,user).await
            .map_err(|cause| self.step_failure("Could not read the account subscription.",cause))?;
        if let Some(sub) = sub.as_mut() { sub.account_id=account_id.to_string(); }
        Ok(sub)
    }

    pub async fn mirror_billing(&self, billing: &BillingStore, accounts: &AccountStore) -> Result<(), String> {
        let _lock = self.billing_lock.lock().await;
        for (provider, event_id, received_at) in billing.unmirrored_events().await.map_err(|(_, message)| message)? {
            let pool = self.pool().await?;
            sqlx::query(
                "INSERT INTO public.billing_events (provider, event_id, received_at) \
                 VALUES ($1, $2, to_timestamp($3)) ON CONFLICT DO NOTHING",
            )
            .bind(&provider)
            .bind(&event_id)
            .bind(received_at as f64 / 1000.0)
            .persistent(false)
            .execute(pool)
            .await
            .map_err(|cause| self.step_failure("Could not save a billing event to Supabase.", cause))?;
            billing
                .mark_event_mirrored(&provider, &event_id)
                .await
                .map_err(|(_, message)| message)?;
        }
        for (subscription, updated_at) in billing.unmirrored_subscriptions().await.map_err(|(_, message)| message)? {
            let saved = match accounts
                .google_sub(&subscription.account_id)
                .await
                .map_err(|(_, message)| message)?
            {
                Some(google_sub) => self.save_subscription(&google_sub, &subscription).await?,
                None => false,
            };
            if !saved {
                eprintln!(
                    "[Kesami Core Backend] Supabase billing: account {} has no matched Supabase Google user yet; subscription {} will be retried.",
                    subscription.account_id, subscription.provider_subscription_id
                );
                continue;
            }
            billing
                .mark_subscription_mirrored(&subscription.provider_subscription_id, updated_at)
                .await
                .map_err(|(_, message)| message)?;
        }
        Ok(())
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
        assert_eq!(
            project_ref_from_url("https://abcdefgh.supabase.co").as_deref(),
            Some("abcdefgh")
        );
        assert_eq!(
            project_ref_from_url("https://abcdefgh.supabase.co/").as_deref(),
            Some("abcdefgh")
        );
        assert_eq!(
            project_ref_from_url("abcdefgh.supabase.co").as_deref(),
            Some("abcdefgh")
        );
        assert_eq!(
            project_ref_from_url("postgres://postgres:pw@db.abcdefgh.supabase.co:5432/postgres")
                .as_deref(),
            Some("abcdefgh")
        );
        assert_eq!(project_ref_from_url("https://example.com"), None);
    }

    #[test]
    fn builds_a_pooler_url_when_a_region_is_configured() {
        assert_eq!(
            supabase_url("abcdefgh", "p@ss/word", Some("ap-south-1")),
            "postgres://postgres.abcdefgh:p%40ss%2Fword@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require"
        );
        assert_eq!(
            supabase_url("abcdefgh", "p@ss/word", None),
            "postgres://postgres:p%40ss%2Fword@db.abcdefgh.supabase.co:5432/postgres?sslmode=require"
        );
    }

    #[test]
    fn keeps_the_pooler_url_parseable_with_a_hostile_password() {
        let url = supabase_url("abcdefgh", "p@ss:w/rd?#[]", Some("ap-south-1"));
        let options = PgConnectOptions::from_str(&url).expect("pooler url should parse");
        assert_eq!(options.get_host(), "aws-0-ap-south-1.pooler.supabase.com");
        assert_eq!(options.get_port(), 5432);
        assert_eq!(options.get_username(), "postgres.abcdefgh");
        assert_eq!(password_from_url(&url).as_deref(), Some("p@ss:w/rd?#[]"));
    }

    #[test]
    fn hints_at_the_pooler_only_for_the_direct_host() {
        let direct = Endpoint {
            host: "db.abcdefgh.supabase.co".into(),
            port: 5432,
            database: "postgres".into(),
            username: "postgres".into(),
            transaction_pooler: false,
        };
        let hint = direct_host_hint(&direct).expect("direct host should hint");
        assert!(hint.contains("KESAMI_SUPABASE_POOLER_REGION"));
        assert!(hint.contains("KESAMI_SUPABASE_DB_URL"));

        let pooler = Endpoint {
            host: "aws-0-ap-south-1.pooler.supabase.com".into(),
            port: 6543,
            database: "postgres".into(),
            username: "postgres.abcdefgh".into(),
            transaction_pooler: true,
        };
        assert_eq!(direct_host_hint(&pooler), None);
    }

    #[test]
    fn treats_every_pooler_host_as_sharing_backends() {
        assert!(pooler_host("aws-0-ap-south-1.pooler.supabase.com"));
        assert!(pooler_host("aws-1-us-east-2.pooler.supabase.com"));
        assert!(!pooler_host("db.abcdefgh.supabase.co"));
        assert!(!pooler_host("pooler.supabase.com.evil.example"));
    }

    #[test]
    fn percent_encodes_password_specials() {
        assert_eq!(encode_password("simple-pass_1.0~"), "simple-pass_1.0~");
        assert_eq!(
            encode_password("p@ss:w/rd?#[]"),
            "p%40ss%3Aw%2Frd%3F%23%5B%5D"
        );
    }

    #[test]
    fn round_trips_an_encoded_password_out_of_a_url() {
        let url = format!(
            "postgres://postgres:{}@db.ref.supabase.co:5432/postgres",
            encode_password("p@ss:word/1")
        );
        assert_eq!(password_from_url(&url).as_deref(), Some("p@ss:word/1"));
        assert_eq!(
            password_from_url("postgres://postgres@host:5432/postgres"),
            None
        );
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
        assert_eq!(
            redact("see https://x.test/a@b", None),
            "see https://x.test/a@b"
        );
    }

    #[test]
    fn leaves_ordinary_urls_alone() {
        assert_eq!(
            redact("see https://supabase.com/docs", None),
            "see https://supabase.com/docs"
        );
    }

    fn disposable_db() -> SupabaseDb {
        let url = std::env::var("KESAMI_DISPOSABLE_POSTGRES_URL")
            .expect("set KESAMI_DISPOSABLE_POSTGRES_URL to a throwaway Postgres database");
        let options = PgConnectOptions::from_str(&url).expect("a valid Postgres URL");
        let host = options.get_host().to_string();
        assert!(
            !pooler_host(&host) && !host.ends_with(".supabase.co") && !host.ends_with(".supabase.in"),
            "refusing to reset billing tables on a Supabase host"
        );
        SupabaseDb {
            config: Some(Config {
                endpoint: Endpoint {
                    host,
                    port: options.get_port(),
                    database: options.get_database().unwrap_or("postgres").to_string(),
                    username: options.get_username().to_string(),
                    transaction_pooler: false,
                },
                options,
                max_connections: 2,
                connect_timeout: Duration::from_secs(5),
                source: "test",
            }),
            secret: None,
            pool: OnceCell::new(),
            last: RwLock::new(None),
            billing_lock: Mutex::new(()),
        }
    }

    const PAYER: &str = "5f0c7d8e-1c2b-4a3d-9e8f-0a1b2c3d4e5f";

    async fn billing_rows(pool: &PgPool) -> Vec<(String, String, String, String, i64, Option<String>, f64)> {
        sqlx::query_as(
            "SELECT provider_subscription_id, user_id::text, plan, status, amount_minor, customer_id, \
                    extract(epoch FROM current_period_end)::float8 \
             FROM public.billing ORDER BY provider_subscription_id",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    async fn billing_events(pool: &PgPool) -> Vec<String> {
        sqlx::query_scalar("SELECT event_id FROM public.billing_events ORDER BY event_id")
            .fetch_all(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    #[ignore = "needs KESAMI_DISPOSABLE_POSTGRES_URL"]
    async fn paid_subscriptions_reach_supabase_for_the_paying_google_user() {
        use crate::billing::apply_webhook;

        let db = disposable_db();
        let pool = db.pool().await.unwrap().clone();
        sqlx::raw_sql(&format!(
            "DROP TABLE IF EXISTS public.billing, public.billing_events, public.billing_events_offline; \
             DROP SCHEMA IF EXISTS kesami_migrations CASCADE; \
             DROP SCHEMA IF EXISTS auth CASCADE; \
             DO $$ BEGIN \
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; \
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; \
             END $$; \
             CREATE SCHEMA auth; \
             CREATE TABLE auth.users (id uuid PRIMARY KEY, email text); \
             CREATE TABLE auth.identities ( \
                provider_id text NOT NULL, \
                user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, \
                identity_data jsonb NOT NULL, \
                provider text NOT NULL, \
                UNIQUE (provider_id, provider)); \
             CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid'; \
             INSERT INTO auth.users VALUES ('{PAYER}', 'payer@example.com'); \
             INSERT INTO auth.identities VALUES ('google-sub-payer', '{PAYER}', \
                '{{\"sub\": \"google-sub-payer\", \"email\": \"payer@example.com\"}}', 'google');"
        ))
        .execute(&pool)
        .await
        .unwrap();
        db.migrate_billing().await.unwrap();

        let dir = std::env::temp_dir().join(format!("kesami-mirror-{}", uuid::Uuid::new_v4()));
        let accounts = AccountStore::open(dir.join("accounts.sqlite3"), 1_000).unwrap();
        let billing = BillingStore::open(dir.join("billing.sqlite3")).unwrap();
        let payer = accounts.google_sign_in("google-sub-payer", "payer@example.com", "Payer", true).await.unwrap().account.id;
        let local = accounts.register("Local User", "local@example.com", "correct horse battery").await.unwrap().account.id;
        let entity = |id: &str, account: &str, status: &str| {
            json!({"id": id, "status": status, "customer_id": "cust_Payer", "current_end": 1_800_000_000i64, "notes": {"accountId": account}})
        };

        apply_webhook(&billing, "razorpay", "evt_authenticated", &entity("sub_Payer1", &payer, "authenticated")).await.unwrap();
        apply_webhook(&billing, "razorpay", "evt_activated", &entity("sub_Payer1", &payer, "active")).await.unwrap();
        apply_webhook(&billing, "razorpay", "evt_local", &entity("sub_Local1", &local, "active")).await.unwrap();
        let received_at = billing
            .unmirrored_events()
            .await
            .unwrap()
            .into_iter()
            .find(|(_, id, _)| id == "evt_activated")
            .unwrap()
            .2;
        db.mirror_billing(&billing, &accounts).await.unwrap();

        assert_eq!(
            billing_rows(&pool).await,
            [(
                "sub_Payer1".into(),
                PAYER.into(),
                "pro".into(),
                "active".into(),
                crate::plans::PRO_MONTHLY_MINOR_INR as i64,
                Some("cust_Payer".into()),
                1_800_000_000.0
            )]
        );
        assert_eq!(billing_events(&pool).await, ["evt_activated", "evt_authenticated", "evt_local"]);
        let mirrored_at: i64 = sqlx::query_scalar(
            "SELECT (extract(epoch FROM received_at) * 1000)::bigint FROM public.billing_events WHERE event_id = 'evt_activated'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(mirrored_at, received_at);
        assert!(billing.unmirrored_events().await.unwrap().is_empty());
        assert_eq!(billing.unmirrored_subscriptions().await.unwrap().len(), 1);

        db.mirror_billing(&billing, &accounts).await.unwrap();
        apply_webhook(&billing, "razorpay", "evt_cancelled", &entity("sub_Payer1", &payer, "cancelled")).await.unwrap();
        db.mirror_billing(&billing, &accounts).await.unwrap();
        assert_eq!(billing_rows(&pool).await[0].3, "canceled");

        sqlx::raw_sql("ALTER TABLE public.billing_events RENAME TO billing_events_offline").execute(&pool).await.unwrap();
        apply_webhook(&billing, "razorpay", "evt_while_offline", &entity("sub_Payer2", &payer, "active")).await.unwrap();
        assert!(db.mirror_billing(&billing, &accounts).await.is_err());
        assert_eq!(billing.unmirrored_events().await.unwrap().len(), 1);
        assert_eq!(billing.unmirrored_subscriptions().await.unwrap().len(), 2);
        sqlx::raw_sql("ALTER TABLE public.billing_events_offline RENAME TO billing_events").execute(&pool).await.unwrap();
        db.mirror_billing(&billing, &accounts).await.unwrap();
        assert!(billing.unmirrored_events().await.unwrap().is_empty());
        assert_eq!(billing.unmirrored_subscriptions().await.unwrap().len(), 1);
        let rows = billing_rows(&pool).await;
        assert_eq!(rows.iter().map(|row| (row.0.as_str(), row.3.as_str())).collect::<Vec<_>>(), [("sub_Payer1", "canceled"), ("sub_Payer2", "active")]);
        assert!(billing_events(&pool).await.contains(&"evt_while_offline".to_string()));

        let restored = db.subscription_for_google("google-sub-payer","new-installation").await.unwrap().unwrap();
        assert_eq!(restored.account_id,"new-installation");
        assert_eq!(restored.provider_subscription_id,"sub_Payer2");
        assert_eq!(crate::billing::tier_for(Some(&restored)),"pro");
        let late=accounts.google_sign_in("google-sub-late","late@example.com","Late",true).await.unwrap().account.id;
        apply_webhook(&billing,"razorpay","evt_late_identity",&entity("sub_Late",&late,"active")).await.unwrap();
        db.mirror_billing(&billing,&accounts).await.unwrap();
        assert_eq!(billing.unmirrored_subscriptions().await.unwrap().len(),2);
        sqlx::raw_sql("INSERT INTO auth.users VALUES ('11111111-1111-1111-1111-111111111111','late@example.com'); INSERT INTO auth.identities VALUES ('google-sub-late','11111111-1111-1111-1111-111111111111','{\"sub\":\"google-sub-late\"}','google');")
            .execute(&pool).await.unwrap();
        db.mirror_billing(&billing,&accounts).await.unwrap();
        assert_eq!(billing.unmirrored_subscriptions().await.unwrap().len(),1);
        assert_eq!(db.subscription_for_google("google-sub-late",&late).await.unwrap().unwrap().status,"active");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn shortens_the_reported_server_version() {
        assert_eq!(
            short_version("PostgreSQL 15.8 on aarch64-unknown-linux-gnu, compiled by gcc"),
            "PostgreSQL 15.8"
        );
    }
}
