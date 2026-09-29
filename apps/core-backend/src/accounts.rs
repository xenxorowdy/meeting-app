//! Optional accounts for one private workspace. SQLite stores only password
//! hashes and session hashes. This is not a multi-tenant meeting service.
use crate::settings::data_dir;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    io,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;
use uuid::Uuid;

pub(crate) const PBKDF2_ITERATIONS: u32 = 600_000;
const SALT_BYTES: usize = 16;
const SESSION_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const PASSWORD_MIN_CHARS: usize = 8;
const MAX_SESSIONS_PER_ACCOUNT: usize = 20;
const GOOGLE_ONLY_PASSWORD: &str = "!google-only";
type AuthResult<T> = Result<T, (u16, String)>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPublic {
    pub id: String,
    pub name: String,
    pub email: String,
    pub created_at: i64,
    pub auth_provider: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthGrant {
    pub account: AccountPublic,
    pub token: String,
    pub expires_at: i64,
}

pub struct AccountStore {
    db: Arc<Mutex<Connection>>,
    iterations: u32,
    hashing: Arc<Semaphore>,
    attempts: Mutex<VecDeque<i64>>,
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn db_error(_: impl std::fmt::Display) -> (u16, String) {
    (
        503,
        "Account storage is unavailable. Please try again.".into(),
    )
}
fn public_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AccountPublic> {
    Ok(AccountPublic {
        id: row.get(0)?,
        name: row.get(1)?,
        email: row.get(2)?,
        created_at: row.get(3)?,
        auth_provider: if row.get::<_, String>(4)? == GOOGLE_ONLY_PASSWORD { "google" } else { "password" }.into(),
    })
}

impl AccountStore {
    pub async fn load() -> io::Result<Self> {
        tokio::task::spawn_blocking(|| {
            Self::open(data_dir().join("accounts.sqlite3"), configured_iterations())
        })
        .await
        .map_err(io::Error::other)?
    }

    pub(crate) fn open(path: PathBuf, iterations: u32) -> io::Result<Self> {
        std::fs::create_dir_all(
            path.parent()
                .ok_or_else(|| io::Error::other("Missing database directory"))?,
        )?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(0o600);
            options.open(&path)?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        #[cfg(not(unix))]
        {
            options.open(&path)?;
        }
        let mut db = Connection::open(&path).map_err(io::Error::other)?;
        db.busy_timeout(Duration::from_secs(5))
            .map_err(io::Error::other)?;
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
            CREATE TABLE IF NOT EXISTS accounts (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id, expires_at);
            CREATE TABLE IF NOT EXISTS google_identities (
                google_sub TEXT PRIMARY KEY,
                account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);")
            .map_err(io::Error::other)?;
        let tx = db.transaction().map_err(io::Error::other)?;
        let migrated: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM migrations WHERE name='legacy-json-v1')",
                [],
                |row| row.get(0),
            )
            .map_err(io::Error::other)?;
        if !migrated {
            let legacy = path.with_file_name("accounts.json");
            match std::fs::read(&legacy) {
                Ok(bytes) => {
                    let stored: Value = serde_json::from_slice(&bytes).map_err(|_| {
                        io::Error::other("Invalid legacy account store; original preserved")
                    })?;
                    let accounts = stored
                        .get("accounts")
                        .and_then(Value::as_array)
                        .ok_or_else(|| io::Error::other("Invalid legacy accounts"))?;
                    let sessions = stored
                        .get("sessions")
                        .and_then(Value::as_array)
                        .ok_or_else(|| io::Error::other("Invalid legacy sessions"))?;
                    for account in accounts {
                        let field = |key| {
                            account
                                .get(key)
                                .and_then(Value::as_str)
                                .ok_or_else(|| io::Error::other("Invalid legacy account field"))
                        };
                        let created = account
                            .get("createdAt")
                            .and_then(Value::as_i64)
                            .ok_or_else(|| io::Error::other("Invalid legacy account timestamp"))?;
                        tx.execute(
                            "INSERT INTO accounts VALUES (?1,?2,?3,?4,?5)",
                            params![
                                field("id")?,
                                field("name")?,
                                field("email")?,
                                field("passwordHash")?,
                                created
                            ],
                        )
                        .map_err(io::Error::other)?;
                    }
                    for session in sessions {
                        let field = |key| {
                            session
                                .get(key)
                                .and_then(Value::as_str)
                                .ok_or_else(|| io::Error::other("Invalid legacy session field"))
                        };
                        let expires = session
                            .get("expiresAt")
                            .and_then(Value::as_i64)
                            .ok_or_else(|| io::Error::other("Invalid legacy session expiry"))?;
                        if expires > now_ms() {
                            tx.execute(
                                "INSERT INTO sessions VALUES (?1,?2,?3)",
                                params![field("tokenHash")?, field("accountId")?, expires],
                            )
                            .map_err(io::Error::other)?;
                        }
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            tx.execute("INSERT INTO migrations VALUES ('legacy-json-v1')", [])
                .map_err(io::Error::other)?;
        }
        tx.execute("DELETE FROM sessions WHERE expires_at <= ?1", [now_ms()])
            .map_err(io::Error::other)?;
        tx.commit().map_err(io::Error::other)?;
        Ok(Self {
            db: Arc::new(Mutex::new(db)),
            iterations,
            hashing: Arc::new(Semaphore::new(2)),
            attempts: Mutex::new(VecDeque::new()),
        })
    }

    async fn query<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> AuthResult<T> + Send + 'static,
    ) -> AuthResult<T> {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = db.lock().map_err(db_error)?;
            f(&mut connection)
        })
        .await
        .map_err(db_error)?
    }

    fn throttle(&self) -> AuthResult<()> {
        let now = now_ms();
        let mut attempts = self.attempts.lock().map_err(db_error)?;
        while attempts.front().is_some_and(|t| *t <= now - 60_000) {
            attempts.pop_front();
        }
        if attempts.len() >= 30 {
            return Err((
                429,
                "Too many sign-in attempts. Try again in a minute.".into(),
            ));
        }
        attempts.push_back(now);
        Ok(())
    }

    pub fn throttle_google_attempt(&self) -> AuthResult<()> { self.throttle() }

    async fn hash_work<T: Send + 'static>(
        &self,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> AuthResult<T> {
        let permit = self
            .hashing
            .clone()
            .try_acquire_owned()
            .map_err(|_| (429, "Sign-in is busy. Try again shortly.".into()))?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            f()
        })
        .await
        .map_err(db_error)
    }

    pub async fn register(&self, name: &str, email: &str, password: &str) -> AuthResult<AuthGrant> {
        self.throttle()?;
        let name = name.trim().to_string();
        if name.is_empty() || name.chars().count() > 80 {
            return Err((400, "Provide a name of 1 to 80 characters.".into()));
        }
        let email = normalize_email(email).ok_or((
            400,
            "Enter a valid email address, such as you@work.com.".into(),
        ))?;
        if let Some(error) = password_problem(password) {
            return Err((400, error));
        }
        let password = password.to_string();
        let iterations = self.iterations;
        let hash = self
            .hash_work(move || {
                encode_password_hash(password.as_bytes(), &rand_bytes::<SALT_BYTES>(), iterations)
            })
            .await?;
        self.query(move |db| {
            let tx = db.transaction().map_err(db_error)?;
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM accounts WHERE email=?1)",
                    [&email],
                    |r| r.get(0),
                )
                .map_err(db_error)?;
            if exists {
                return Err((
                    409,
                    "An account with this email already exists. Try signing in instead.".into(),
                ));
            }
            let account = AccountPublic {
                id: Uuid::new_v4().to_string(),
                name,
                email,
                created_at: now_ms(),
                auth_provider: "password".into(),
            };
            tx.execute(
                "INSERT INTO accounts VALUES (?1,?2,?3,?4,?5)",
                params![
                    account.id,
                    account.name,
                    account.email,
                    hash,
                    account.created_at
                ],
            )
            .map_err(db_error)?;
            let grant = grant_session(&tx, account)?;
            tx.commit().map_err(db_error)?;
            Ok(grant)
        })
        .await
    }

    pub async fn login(&self, email: &str, password: &str) -> AuthResult<AuthGrant> {
        self.throttle()?;
        let email = normalize_email(email).ok_or((400, "Enter a valid email address.".into()))?;
        if password.is_empty() || password.len() > 512 {
            return Err((400, "Enter a password of at most 512 bytes.".into()));
        }
        let record = self
            .query(move |db| {
                db.query_row(
                    "SELECT id,name,email,created_at,password_hash FROM accounts WHERE email=?1",
                    [email],
                    |r| Ok((public_row(r)?, r.get::<_, String>(4)?)),
                )
                .optional()
                .map_err(db_error)
            })
            .await?;
        let stored = record.as_ref().and_then(|(_, hash)| (hash != GOOGLE_ONLY_PASSWORD).then(|| hash.clone()));
        let password = password.to_string();
        let valid = self
            .hash_work(move || {
                verify_password(
                    &password,
                    stored.as_deref().unwrap_or_else(|| dummy_password_hash()),
                )
            })
            .await?;
        let Some((account, original_hash)) = record.filter(|(_, hash)| hash != GOOGLE_ONLY_PASSWORD && valid) else {
            return Err((401, "Email or password is incorrect.".into()));
        };
        self.query(move |db| {
            let tx = db.transaction().map_err(db_error)?;
            // A concurrent password change must invalidate the old login attempt.
            let unchanged: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM accounts WHERE id=?1 AND password_hash=?2)",
                    params![account.id, original_hash],
                    |r| r.get(0),
                )
                .map_err(db_error)?;
            if !unchanged {
                return Err((401, "Email or password is incorrect.".into()));
            }
            let grant = grant_session(&tx, account)?;
            tx.commit().map_err(db_error)?;
            Ok(grant)
        })
        .await
    }

    /// A Google identity is bound by its stable subject, never by email alone.
    /// Existing password accounts require a separate, explicit linking flow.
    pub async fn google_sign_in(&self, sub: &str, email: &str, name: &str, allow_create: bool) -> AuthResult<AuthGrant> {
        if sub.is_empty() || sub.len() > 255 { return Err((401, "Google did not return a valid account identifier.".into())); }
        let email = normalize_email(email).ok_or((401, "Google did not return a valid email address.".into()))?;
        let name = name.trim().chars().take(80).collect::<String>();
        let sub = sub.to_string();
        self.query(move |db| {
            let tx = db.transaction().map_err(db_error)?;
            let linked = tx.query_row(
                "SELECT a.id,a.name,a.email,a.created_at,a.password_hash FROM accounts a JOIN google_identities g ON g.account_id=a.id WHERE g.google_sub=?1",
                [&sub], public_row,
            ).optional().map_err(db_error)?;
            let account = if let Some(account) = linked { account } else {
                if !allow_create { return Err((403, "Google account creation requires the workspace owner's access token.".into())); }
                let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM accounts WHERE email=?1)", [&email], |r| r.get(0)).map_err(db_error)?;
                if exists { return Err((409, "This email already has a password account. Sign in with its password; Google linking is not enabled yet.".into())); }
                let account = AccountPublic { id: Uuid::new_v4().to_string(), name: if name.is_empty() { email.clone() } else { name }, email, created_at: now_ms(), auth_provider: "google".into() };
                tx.execute("INSERT INTO accounts VALUES (?1,?2,?3,?4,?5)", params![account.id, account.name, account.email, GOOGLE_ONLY_PASSWORD, account.created_at]).map_err(db_error)?;
                tx.execute("INSERT INTO google_identities VALUES (?1,?2)", params![sub, account.id]).map_err(db_error)?;
                account
            };
            let grant = grant_session(&tx, account)?;
            tx.commit().map_err(db_error)?;
            Ok(grant)
        }).await
    }

    pub async fn session_account(&self, token: &str) -> Option<AccountPublic> {
        if token.is_empty() || token.len() > 512 {
            return None;
        }
        let hash = token_hash(token);
        self.query(move |db| db.query_row("SELECT a.id,a.name,a.email,a.created_at,a.password_hash FROM accounts a JOIN sessions s ON s.account_id=a.id WHERE s.token_hash=?1 AND s.expires_at>?2", params![hash, now_ms()], public_row).optional().map_err(db_error)).await.ok().flatten()
    }

    pub async fn google_sub(&self, account_id: &str) -> AuthResult<Option<String>> {
        let account_id = account_id.to_string();
        self.query(move |db| {
            db.query_row("SELECT google_sub FROM google_identities WHERE account_id=?1", [account_id], |row| row.get(0))
                .optional()
                .map_err(db_error)
        })
        .await
    }

    pub async fn logout(&self, token: &str) -> AuthResult<bool> {
        let hash = token_hash(token);
        self.query(move |db| {
            db.execute("DELETE FROM sessions WHERE token_hash=?1", [hash])
                .map(|count| count > 0)
                .map_err(db_error)
        })
        .await
    }

    pub async fn change_password(
        &self,
        token: &str,
        current: &str,
        password: &str,
    ) -> AuthResult<AuthGrant> {
        self.throttle()?;
        if let Some(error) = password_problem(password) {
            return Err((400, error));
        }
        if current.len() > 512 {
            return Err((400, "Current password is too long.".into()));
        }
        let account = self
            .session_account(token)
            .await
            .ok_or((401, "Sign in to change your password.".into()))?;
        let id = account.id.clone();
        let hash: String = self
            .query(move |db| {
                db.query_row(
                    "SELECT password_hash FROM accounts WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .map_err(db_error)
            })
            .await?;
        let original = hash.clone();
        let current = current.to_string();
        let password = password.to_string();
        let iterations = self.iterations;
        let updated = self
            .hash_work(move || {
                verify_password(&current, &hash).then(|| {
                    encode_password_hash(
                        password.as_bytes(),
                        &rand_bytes::<SALT_BYTES>(),
                        iterations,
                    )
                })
            })
            .await?
            .ok_or((401, "Current password is incorrect.".into()))?;
        let session_hash = token_hash(token);
        self.query(move |db| {
            let tx = db.transaction().map_err(db_error)?;
            let changed = tx.execute("UPDATE accounts SET password_hash=?1 WHERE id=?2 AND password_hash=?3 AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=?4 AND account_id=?2 AND expires_at>?5)", params![updated, account.id, original, session_hash, now_ms()]).map_err(db_error)?;
            if changed != 1 { return Err((401, "Your session changed. Please sign in again.".into())); }
            tx.execute("DELETE FROM sessions WHERE account_id=?1", [&account.id]).map_err(db_error)?;
            let grant = grant_session(&tx, account)?;
            tx.commit().map_err(db_error)?;
            Ok(grant)
        }).await
    }
}

fn grant_session(db: &Connection, account: AccountPublic) -> AuthResult<AuthGrant> {
    let expires_at = now_ms() + SESSION_TTL.as_millis() as i64;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    db.execute("DELETE FROM sessions WHERE expires_at<=?1", [now_ms()])
        .map_err(db_error)?;
    db.execute("DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE account_id=?1 ORDER BY expires_at DESC, rowid DESC LIMIT -1 OFFSET ?2)", params![account.id, (MAX_SESSIONS_PER_ACCOUNT - 1) as i64]).map_err(db_error)?;
    db.execute(
        "INSERT INTO sessions VALUES (?1,?2,?3)",
        params![token_hash(&token), account.id, expires_at],
    )
    .map_err(db_error)?;
    Ok(AuthGrant {
        account,
        token,
        expires_at,
    })
}

fn password_problem(password: &str) -> Option<String> {
    let length = password.chars().count();
    if length < PASSWORD_MIN_CHARS {
        return Some(format!(
            "Passwords need at least {PASSWORD_MIN_CHARS} characters."
        ));
    }
    if password.len() > 512 {
        return Some("Passwords are limited to 512 characters.".into());
    }
    if password.chars().any(|c| c.is_ascii_control()) {
        return Some("Passwords cannot contain control characters.".into());
    }
    None
}

/// Lowercased for lookup; structural checks a mistaken keystroke should fail.
fn normalize_email(email: &str) -> Option<String> {
    let email = email.trim().to_ascii_lowercase();
    if email.len() > 254 || email.chars().any(char::is_whitespace) {
        return None;
    }
    if email.matches('@').count() != 1 {
        return None;
    }
    let (local, domain) = email.split_once('@')?;
    if local.is_empty()
        || local.len() > 64
        || local.starts_with('.')
        || local.ends_with('.')
        || local.contains("..")
    {
        return None;
    }
    if domain.is_empty()
        || !domain.contains('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
        || domain.contains("..")
    {
        return None;
    }
    if !domain
        .split('.')
        .all(|label| !label.is_empty() && !label.starts_with('-') && !label.ends_with('-'))
    {
        return None;
    }
    Some(email)
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    // Four UUIDs are 128 bits of os randomness each; enough for a 16-byte salt.
    let mut bytes = [0u8; N];
    let mut filled = 0;
    while filled < N {
        let uuid = Uuid::new_v4();
        let raw = uuid.as_bytes();
        let take = (N - filled).min(raw.len());
        bytes[filled..filled + take].copy_from_slice(&raw[..take]);
        filled += take;
    }
    bytes
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let ipad: [u8; 64] = std::array::from_fn(|i| block[i] ^ 0x36);
    let opad: [u8; 64] = std::array::from_fn(|i| block[i] ^ 0x5c);
    let mut inner = Sha256::new();
    inner.update(&ipad);
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(&opad);
    outer.update(inner.finalize());
    outer.finalize().into()
}

/// PBKDF2 for a 32-byte derived key: exactly one hash-output block, so the
/// generic multi-block loop collapses to a single XI iteration.
fn pbkdf2_sha256(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut block = salt.to_vec();
    block.extend_from_slice(&1u32.to_be_bytes());
    let mut u = hmac_sha256(password, &block);
    let mut out = u;
    for _ in 1..iterations.max(1) {
        u = hmac_sha256(password, &u);
        for (acc, part) in out.iter_mut().zip(u.iter()) {
            *acc ^= part;
        }
    }
    out
}

/// `pbkdf2-sha256$<iterations>$<salt>$<hash>`, both binary parts base64.
fn encode_password_hash(password: &[u8], salt: &[u8], iterations: u32) -> String {
    let hash = pbkdf2_sha256(password, salt, iterations);
    format!(
        "pbkdf2-sha256${iterations}${}${}",
        BASE64.encode(salt),
        BASE64.encode(hash)
    )
}

fn verify_password(password: &str, stored: &str) -> bool {
    let Some((scheme, rest)) = stored.split_once('$') else {
        return false;
    };
    if scheme != "pbkdf2-sha256" {
        return false;
    }
    let Some((iterations, rest)) = rest.split_once('$') else {
        return false;
    };
    let Ok(iterations) = iterations.parse::<u32>() else {
        return false;
    };
    let Some((salt, expected)) = rest.split_once('$') else {
        return false;
    };
    let (Ok(salt), Ok(expected)) = (BASE64.decode(salt), BASE64.decode(expected)) else {
        return false;
    };
    let Ok(expected) = <[u8; 32]>::try_from(expected) else {
        return false;
    };
    if !(1_000..=2_000_000).contains(&iterations) || salt.len() > 64 {
        return false;
    }
    let computed = pbkdf2_sha256(password.as_bytes(), &salt, iterations);
    bool::from(computed.ct_eq(&expected))
}

/// A fixed stored hash used to equalize login timing when the email is unknown.
fn dummy_password_hash() -> &'static String {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| {
        encode_password_hash(
            b"kesami-timing-equalizer",
            b"kesami-dummy-salt-16b",
            configured_iterations(),
        )
    })
}

/// The deployment can lower the work factor deliberately (test binaries and
/// unoptimized debug builds make 600k iterations crawl); anything unset or out
/// of a sane range keeps the default.
fn configured_iterations() -> u32 {
    if !cfg!(debug_assertions) {
        return PBKDF2_ITERATIONS;
    }
    kesami_core_backend::env_compat::var("KESAMI_PBKDF2_ITERATIONS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|count| (1_000..=2_000_000).contains(count))
        .unwrap_or(PBKDF2_ITERATIONS)
}

fn token_hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Scratch {
        store: AccountStore,
        dir: PathBuf,
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    fn scratch() -> Scratch {
        let dir = std::env::temp_dir().join(format!("kesami-account-db-{}", Uuid::new_v4()));
        let store = AccountStore::open(dir.join("accounts.sqlite3"), 1_000).unwrap();
        Scratch { store, dir }
    }
    #[test]
    fn pbkdf2_matches_published_vectors() {
        assert_eq!(
            hex(&pbkdf2_sha256(b"password", b"salt", 1)),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
        assert_eq!(
            hex(&pbkdf2_sha256(b"password", b"salt", 4096)),
            "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"
        );
    }
    #[test]
    fn registration_validation_and_malformed_hashes() {
        for email in [
            "",
            "no-at-sign",
            "two@@work.com",
            "@work.com",
            "a@",
            "a@localhost",
            "a@.work.com",
            "a@work.com.",
            "a@ba..com",
            "a b@work.com",
            "a@-work.com",
            ".a@work.com",
        ] {
            assert!(normalize_email(email).is_none());
        }
        for email in ["a@b.co", "first.last@sub.work.com", "odd+tag@work.io"] {
            assert!(normalize_email(email).is_some());
        }
        assert!(password_problem("short").is_some());
        assert!(password_problem("bad\u{7}password").is_some());
        assert!(password_problem(&"a".repeat(513)).is_some());
        assert!(!verify_password("password", "mangled"));
        assert!(!verify_password(
            "password",
            "pbkdf2-sha256$4294967295$c2FsdA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        ));
    }
    #[tokio::test]
    async fn google_identity_creates_only_with_owner_access_and_signs_in_by_subject() {
        let scratch = scratch();
        let denied = scratch.store.google_sign_in("google-sub-1", "new@work.com", "New User", false).await.unwrap_err();
        assert_eq!(denied.0, 403);
        let created = scratch.store.google_sign_in("google-sub-1", "new@work.com", "New User", true).await.unwrap();
        assert_eq!(created.account.auth_provider, "google");
        assert!(scratch.store.session_account(&created.token).await.is_some());
        let returned = scratch.store.google_sign_in("google-sub-1", "changed@work.com", "Changed Name", false).await.unwrap();
        assert_eq!(returned.account.id, created.account.id);
        assert_eq!(returned.account.email, "new@work.com");
        assert_eq!(scratch.store.login("new@work.com", "anything valid").await.unwrap_err().0, 401);
        let other_subject = scratch.store.google_sign_in("google-sub-2", "new@work.com", "Someone Else", true).await.unwrap_err();
        assert_eq!(other_subject.0, 409);
        scratch.store.register("Password User", "password@work.com", "correct horse battery").await.unwrap();
        let collision = scratch.store.google_sign_in("google-sub-3", "password@work.com", "Password User", true).await.unwrap_err();
        assert_eq!(collision.0, 409);
    }
    #[tokio::test]
    async fn only_google_accounts_resolve_to_a_google_subject() {
        let scratch = scratch();
        let google = scratch.store.google_sign_in("google-sub-billing", "payer@work.com", "Payer", true).await.unwrap();
        let password = scratch.store.register("Password User", "password@work.com", "correct horse battery").await.unwrap();
        assert_eq!(scratch.store.google_sub(&google.account.id).await.unwrap().as_deref(), Some("google-sub-billing"));
        assert_eq!(scratch.store.google_sub(&password.account.id).await.unwrap(), None);
        assert_eq!(scratch.store.google_sub("missing-account").await.unwrap(), None);
    }
    #[tokio::test]
    async fn register_login_logout_restart_and_no_plaintext() {
        let scratch = scratch();
        let store = &scratch.store;
        let grant = store
            .register("Asha", "Asha@Work.com", "the-secret-password")
            .await
            .unwrap();
        assert_eq!(grant.account.email, "asha@work.com");
        assert_eq!(
            store
                .register("Again", "ASHA@WORK.COM", "different password")
                .await
                .unwrap_err()
                .0,
            409
        );
        let login = store
            .login("asha@work.com", "the-secret-password")
            .await
            .unwrap();
        assert!(store.logout(&grant.token).await.unwrap());
        let reloaded = AccountStore::open(scratch.dir.join("accounts.sqlite3"), 1_000).unwrap();
        assert!(reloaded.session_account(&grant.token).await.is_none());
        assert_eq!(
            reloaded.session_account(&login.token).await.unwrap().id,
            grant.account.id
        );
        let bytes = std::fs::read(scratch.dir.join("accounts.sqlite3")).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("the-secret-password"));
        assert!(!text.contains(&login.token));
        assert!(text.contains("pbkdf2-sha256$"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(scratch.dir.join("accounts.sqlite3"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
    #[tokio::test]
    async fn wrong_credentials_and_password_change_revoke_all_previous_sessions() {
        let scratch = scratch();
        let store = &scratch.store;
        let grant = store
            .register("Asha", "asha@work.com", "first password")
            .await
            .unwrap();
        let other = store
            .login("asha@work.com", "first password")
            .await
            .unwrap();
        for (email, password) in [
            ("asha@work.com", "incorrect"),
            ("nobody@work.com", "first password"),
        ] {
            assert_eq!(
                store.login(email, password).await.unwrap_err(),
                (401, "Email or password is incorrect.".into())
            );
        }
        assert_eq!(
            store
                .change_password(&grant.token, "wrong", "second password")
                .await
                .unwrap_err()
                .0,
            401
        );
        let changed = store
            .change_password(&grant.token, "first password", "second password")
            .await
            .unwrap();
        assert!(store.session_account(&grant.token).await.is_none());
        assert!(store.session_account(&other.token).await.is_none());
        assert!(store.session_account(&changed.token).await.is_some());
        assert!(store
            .login("asha@work.com", "first password")
            .await
            .is_err());
        assert!(store
            .login("asha@work.com", "second password")
            .await
            .is_ok());
    }
    #[tokio::test]
    async fn migration_is_atomic_preserves_original_and_does_not_resurrect_logout() {
        let dir = std::env::temp_dir().join(format!("kesami-account-migrate-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = json!({"accounts":[{"id":"a1","name":"Asha","email":"asha@work.com","passwordHash":encode_password_hash(b"first password", b"test-salt-1234567", 1_000),"createdAt":now_ms()}],"sessions":[{"tokenHash":token_hash("legacy-session"),"accountId":"a1","expiresAt":now_ms()+100_000}]});
        let bytes = serde_json::to_vec(&legacy).unwrap();
        std::fs::write(dir.join("accounts.json"), &bytes).unwrap();
        let store = AccountStore::open(dir.join("accounts.sqlite3"), 1_000).unwrap();
        let scratch = Scratch { store, dir };
        assert!(scratch
            .store
            .session_account("legacy-session")
            .await
            .is_some());
        assert!(scratch
            .store
            .login("asha@work.com", "first password")
            .await
            .is_ok());
        scratch.store.logout("legacy-session").await.unwrap();
        let reloaded = AccountStore::open(scratch.dir.join("accounts.sqlite3"), 1_000).unwrap();
        assert!(reloaded.session_account("legacy-session").await.is_none());
        assert_eq!(
            std::fs::read(scratch.dir.join("accounts.json")).unwrap(),
            bytes
        );
    }
    #[test]
    fn corrupt_migration_fails_without_partial_accounts() {
        let scratch = scratch();
        scratch
            .store
            .db
            .lock()
            .unwrap()
            .execute("DELETE FROM migrations", [])
            .unwrap();
        std::fs::write(scratch.dir.join("accounts.json"), r#"{"accounts":[{"id":"a1","name":"A","email":"a@b.co","passwordHash":"hash","createdAt":1},{}],"sessions":[]}"#).unwrap();
        assert!(AccountStore::open(scratch.dir.join("accounts.sqlite3"), 1_000).is_err());
        let count: i64 = scratch
            .store
            .db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
    #[tokio::test]
    async fn expiry_session_cap_and_concurrent_duplicate_registration() {
        let scratch = scratch();
        let store = &scratch.store;
        let (a, b) = tokio::join!(
            store.register("A", "a@b.co", "password one"),
            store.register("A", "a@b.co", "password two")
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        let (grant, password) = if let Ok(grant) = a {
            (grant, "password one")
        } else {
            (b.unwrap(), "password two")
        };
        for _ in 0..20 {
            store.login("a@b.co", password).await.unwrap();
        }
        assert!(store.session_account(&grant.token).await.is_none());
        let count: i64 = store
            .db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 20);
        let latest = store.login("a@b.co", password).await.unwrap();
        store
            .db
            .lock()
            .unwrap()
            .execute("UPDATE sessions SET expires_at=0", [])
            .unwrap();
        assert!(store.session_account(&latest.token).await.is_none());
    }
    #[test]
    fn rate_limit_bounds_password_work() {
        let scratch = scratch();
        for _ in 0..30 {
            scratch.store.throttle().unwrap();
        }
        assert_eq!(scratch.store.throttle().unwrap_err().0, 429);
    }
    #[tokio::test]
    async fn failed_writes_do_not_issue_sessions_or_report_logout_success() {
        let scratch = scratch();
        let store = &scratch.store;
        let grant = store.register("A", "a@b.co", "password one").await.unwrap();
        store
            .db
            .lock()
            .unwrap()
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert_eq!(store.logout(&grant.token).await.unwrap_err().0, 503);
        assert!(store.session_account(&grant.token).await.is_some());
        assert_eq!(
            store
                .register("B", "b@b.co", "password two")
                .await
                .unwrap_err()
                .0,
            503
        );
        let count: i64 = store
            .db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
