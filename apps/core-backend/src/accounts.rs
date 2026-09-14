//! Workspace accounts and sessions.
//!
//! The backend is a private, single-workspace service: accounts identify people
//! to it, they do not scope the data. Every account lives in
//! `accounts.json` next to the other stores — written `0600` because it holds
//! password hashes and session-token hashes, though never a password or a token
//! itself. Sessions are bearer tokens the UI presents like the deployment
//! token, so signing in and staying signed in ride the existing connection
//! plumbing.
//!
//! Passwords use PBKDF2-HMAC-SHA256, implemented here on the `sha2` crate the
//! backend already depends on rather than pulling in another stack.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    env,
    path::PathBuf,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::settings::{data_dir, read_object, write_object};

/// OWASP's floor for PBKDF2-HMAC-SHA256 is 600k; a native desktop backend that
/// hashes once per sign-in can afford it without anyone noticing.
pub(crate) const PBKDF2_ITERATIONS: u32 = 600_000;
const SALT_BYTES: usize = 16;
const SESSION_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const PASSWORD_MIN_CHARS: usize = 8;
/// Bounded so one account cannot grow the store forever.
const MAX_SESSIONS_PER_ACCOUNT: usize = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPublic {
    pub id: String,
    pub name: String,
    pub email: String,
    pub created_at: i64,
}

/// What a successful register or login hands to the client: the account, a
/// bearer token, and when that token stops working.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthGrant {
    pub account: AccountPublic,
    pub token: String,
    pub expires_at: i64,
}

#[derive(Clone)]
struct Account {
    id: String,
    name: String,
    email: String,
    password_hash: String,
    created_at: i64,
}

#[derive(Clone)]
struct Session {
    token_hash: String,
    account_id: String,
    expires_at: i64,
}

#[derive(Default)]
struct Inner {
    accounts: Vec<Account>,
    sessions: Vec<Session>,
}

pub struct AccountStore {
    path: PathBuf,
    iterations: u32,
    /// One lock for reads and writes: a registration must not commit over a
    /// concurrent one that read the same starting state.
    inner: Mutex<Inner>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

impl AccountStore {
    pub async fn load() -> Self {
        let path = data_dir().join("accounts.json");
        let stored = read_object(&path).await;
        let mut inner = Inner {
            accounts: stored
                .get("accounts")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(account_from_json).collect())
                .unwrap_or_default(),
            sessions: stored
                .get("sessions")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(session_from_json).collect())
                .unwrap_or_default(),
        };
        inner.sessions.retain(|session| session.expires_at > now_ms());
        Self {
            path,
            iterations: configured_iterations(),
            inner: Mutex::new(inner),
        }
    }

    #[cfg(test)]
    fn scratch(path: PathBuf, iterations: u32) -> Self {
        Self {
            path,
            iterations,
            inner: Mutex::new(Inner::default()),
        }
    }

    async fn persist(&self, inner: &Inner) -> Result<(), (u16, String)> {
        let mut object = Map::new();
        object.insert(
            "accounts".into(),
            json!(inner.accounts.iter().map(account_json).collect::<Vec<_>>()),
        );
        object.insert(
            "sessions".into(),
            json!(inner.sessions.iter().map(session_json).collect::<Vec<_>>()),
        );
        write_object(&self.path, &object, true)
            .await
            .map_err(|cause| (500, format!("could not store the account: {cause}")))
    }

    pub async fn register(&self, name: &str, email: &str, password: &str) -> Result<AuthGrant, (u16, String)> {
        let name = name.trim();
        if name.is_empty() {
            return Err((400, "Please provide a name for the account.".into()));
        }
        if name.chars().count() > 80 {
            return Err((400, "Names are limited to 80 characters.".into()));
        }
        let Some(email) = normalize_email(email) else {
            return Err((400, "Enter a valid email address, such as you@work.com.".into()));
        };
        if let Some(cause) = password_problem(password) {
            return Err((400, cause));
        }

        let mut inner = self.inner.lock().await;
        if inner.accounts.iter().any(|account| account.email == email) {
            return Err((
                409,
                "An account with this email already exists. Try signing in instead.".into(),
            ));
        }
        let salt: [u8; SALT_BYTES] = rand_bytes();
        let account = Account {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            email: email.clone(),
            password_hash: encode_password_hash(password.as_bytes(), &salt, self.iterations),
            created_at: now_ms(),
        };
        let grant = self.grant_session(&mut inner, &account);
        inner.accounts.push(account);
        self.persist(&inner).await?;
        Ok(grant)
    }

    pub async fn login(&self, email: &str, password: &str) -> Result<AuthGrant, (u16, String)> {
        let Some(email) = normalize_email(email) else {
            return Err((400, "Enter a valid email address.".into()));
        };
        if password.is_empty() {
            return Err((400, "Enter your password.".into()));
        }

        let mut inner = self.inner.lock().await;
        let Some(account) = inner
            .accounts
            .iter()
            .find(|account| account.email == email)
            .cloned()
        else {
            // Burn the same hashing work a real account would, so response
            // timing does not reveal which emails exist.
            let _ = verify_password(password, dummy_password_hash());
            return Err((401, "Email or password is incorrect.".into()));
        };
        if !verify_password(password, &account.password_hash) {
            return Err((401, "Email or password is incorrect.".into()));
        }
        let grant = self.grant_session(&mut inner, &account);
        self.persist(&inner).await?;
        Ok(grant)
    }

    /// Mint a session for `account` and prune expired and surplus ones. Caller
    /// holds the lock and persists afterwards.
    fn grant_session(&self, inner: &mut Inner, account: &Account) -> AuthGrant {
        let expires_at = now_ms() + SESSION_TTL.as_millis() as i64;
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        inner.sessions.retain(|session| session.expires_at > now_ms());
        // Keep at most MAX_SESSIONS_PER_ACCOUNT per account by dropping its
        // oldest sessions; other accounts are untouched.
        while inner
            .sessions
            .iter()
            .filter(|session| session.account_id == account.id)
            .count()
            >= MAX_SESSIONS_PER_ACCOUNT
        {
            let oldest = inner
                .sessions
                .iter()
                .enumerate()
                .filter(|(_, session)| session.account_id == account.id)
                .min_by_key(|(_, session)| session.expires_at)
                .map(|(index, _)| index);
            match oldest {
                Some(index) => {
                    inner.sessions.remove(index);
                }
                None => break,
            }
        }
        inner.sessions.push(Session {
            token_hash: token_hash(&token),
            account_id: account.id.clone(),
            expires_at,
        });
        AuthGrant {
            account: AccountPublic {
                id: account.id.clone(),
                name: account.name.clone(),
                email: account.email.clone(),
                created_at: account.created_at,
            },
            token,
            expires_at,
        }
    }

    pub async fn session_account(&self, token: &str) -> Option<AccountPublic> {
        if token.is_empty() {
            return None;
        }
        let token_hash = token_hash(token);
        let inner = self.inner.lock().await;
        let session = inner
            .sessions
            .iter()
            .find(|session| session.token_hash == token_hash && session.expires_at > now_ms())?;
        inner
            .accounts
            .iter()
            .find(|account| account.id == session.account_id)
            .map(|account| AccountPublic {
                id: account.id.clone(),
                name: account.name.clone(),
                email: account.email.clone(),
                created_at: account.created_at,
            })
    }

    pub async fn logout(&self, token: &str) -> bool {
        if token.is_empty() {
            return false;
        }
        let token_hash = token_hash(token);
        let mut inner = self.inner.lock().await;
        let before = inner.sessions.len();
        inner.sessions.retain(|session| session.token_hash != token_hash);
        let removed = inner.sessions.len() != before;
        if removed {
            // Best effort: if the write fails the token still works from memory
            // until the next successful persist. The UI treats logout as
            // "drop the local token" regardless.
            let _ = self.persist(&inner).await;
        }
        removed
    }
}

fn password_problem(password: &str) -> Option<String> {
    let length = password.chars().count();
    if length < PASSWORD_MIN_CHARS {
        return Some(format!("Passwords need at least {PASSWORD_MIN_CHARS} characters."));
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
    if local.is_empty() || local.len() > 64 || local.starts_with('.') || local.ends_with('.') || local.contains("..") {
        return None;
    }
    if domain.is_empty() || !domain.contains('.') || domain.starts_with('.') || domain.ends_with('.') || domain.contains("..") {
        return None;
    }
    if !domain.split('.').all(|label| {
        !label.is_empty() && !label.starts_with('-') && !label.ends_with('-')
    }) {
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
    let computed = pbkdf2_sha256(password.as_bytes(), &salt, iterations);
    bool::from(computed.ct_eq(&expected))
}

/// A fixed stored hash used to equalize login timing when the email is unknown.
fn dummy_password_hash() -> &'static String {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| {
        encode_password_hash(
            b"alpha-timing-equalizer",
            b"alpha-dummy-salt-16b",
            configured_iterations(),
        )
    })
}

/// The deployment can lower the work factor deliberately (test binaries and
/// unoptimized debug builds make 600k iterations crawl); anything unset or out
/// of a sane range keeps the default.
fn configured_iterations() -> u32 {
    env::var("ALPHA_PBKDF2_ITERATIONS")
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

fn account_json(account: &Account) -> Value {
    json!({
        "id": account.id,
        "name": account.name,
        "email": account.email,
        "passwordHash": account.password_hash,
        "createdAt": account.created_at,
    })
}

fn account_from_json(value: &Value) -> Option<Account> {
    Some(Account {
        id: value.get("id")?.as_str()?.to_string(),
        name: value.get("name")?.as_str()?.to_string(),
        email: value.get("email")?.as_str()?.to_string(),
        password_hash: value.get("passwordHash")?.as_str()?.to_string(),
        created_at: value.get("createdAt")?.as_i64()?,
    })
}

fn session_json(session: &Session) -> Value {
    json!({
        "tokenHash": session.token_hash,
        "accountId": session.account_id,
        "expiresAt": session.expires_at,
    })
}

fn session_from_json(value: &Value) -> Option<Session> {
    Some(Session {
        token_hash: value.get("tokenHash")?.as_str()?.to_string(),
        account_id: value.get("accountId")?.as_str()?.to_string(),
        expires_at: value.get("expiresAt")?.as_i64()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn scratch(name: &str) -> (AccountStore, PathBuf) {
        let dir = env::temp_dir().join(format!("alpha-accounts-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A small iteration count keeps tests fast; correctness does not depend on it.
        (AccountStore::scratch(dir.join("accounts.json"), 1_000), dir)
    }

    fn hex_of_pbkdf2(password: &str, salt: &str, iterations: u32) -> String {
        hex(&pbkdf2_sha256(password.as_bytes(), salt.as_bytes(), iterations))
    }

    #[test]
    fn pbkdf2_matches_the_published_test_vectors() {
        assert_eq!(
            hex_of_pbkdf2("password", "salt", 1),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
        assert_eq!(
            hex_of_pbkdf2("password", "salt", 2),
            "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"
        );
        assert_eq!(
            hex_of_pbkdf2("password", "salt", 4096),
            "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"
        );
    }

    #[tokio::test]
    async fn register_then_login_round_trips_and_issues_working_sessions() {
        let (store, _dir) = scratch("round-trip");
        let grant = store
            .register("Asha Verma", "Asha@Work.com", "correct horse battery")
            .await
            .unwrap();
        assert_eq!(grant.account.email, "asha@work.com");
        assert_eq!(grant.account.name, "Asha Verma");
        assert_eq!(store.session_account(&grant.token).await.unwrap().email, "asha@work.com");

        let login = store.login("asha@work.com", "correct horse battery").await.unwrap();
        assert_eq!(login.account.id, grant.account.id);
        assert!(store.session_account(&login.token).await.is_some());
        assert!(login.expires_at > now_ms());

        // The two sessions are independent; revoking one keeps the other.
        assert!(store.logout(&grant.token).await);
        assert!(store.session_account(&grant.token).await.is_none());
        assert!(store.session_account(&login.token).await.is_some());
    }

    #[tokio::test]
    async fn wrong_passwords_and_unknown_emails_fail_the_same_way() {
        let (store, _dir) = scratch("wrong-password");
        store.register("Asha", "asha@work.com", "correct horse battery").await.unwrap();
        for (email, password) in [
            ("asha@work.com", "wrong password entirely"),
            ("nobody@work.com", "correct horse battery"),
        ] {
            let Err((status, message)) = store.login(email, password).await else {
                panic!("login must reject {email}");
            };
            assert_eq!(status, 401);
            assert_eq!(message, "Email or password is incorrect.");
        }
    }

    #[tokio::test]
    async fn duplicate_emails_are_refused_regardless_of_case() {
        let (store, _dir) = scratch("duplicate");
        store.register("Asha", "asha@work.com", "correct horse battery").await.unwrap();
        let Err((status, _)) = store
            .register("Someone Else", "ASHA@WORK.COM", "another fine password")
            .await
        else {
            panic!("duplicate registration must be refused");
        };
        assert_eq!(status, 409);
    }

    #[test]
    fn registration_input_is_validated() {
        assert_eq!(
            password_problem("short"),
            Some("Passwords need at least 8 characters.".into())
        );
        assert!(password_problem("ok password").is_none());
        assert!(password_problem("bad\u{7}password").is_some());

        for good in ["a@b.co", "first.last@sub.work.com", "odd+tag@work.io"] {
            assert!(normalize_email(good).is_some(), "{good} should be valid");
        }
        for bad in [
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
            assert!(normalize_email(bad).is_none(), "{bad} should be invalid");
        }
    }

    #[tokio::test]
    async fn expired_sessions_stop_working_after_a_reload() {
        let (store, dir) = scratch("expiry");
        let grant = store.register("Asha", "asha@work.com", "correct horse battery").await.unwrap();
        assert!(store.session_account(&grant.token).await.is_some());

        // Age every session past its expiry on disk, then reload the store the
        // way a restart would (never via `load()`, which reads the real data dir).
        let mut stored = read_object(&dir.join("accounts.json")).await;
        let sessions = stored.get_mut("sessions").unwrap().as_array_mut().unwrap();
        for session in sessions {
            session["expiresAt"] = json!(now_ms() - 1_000);
        }
        write_object(&dir.join("accounts.json"), &stored, true).await.unwrap();
        let reloaded = AccountStore::scratch(dir.join("accounts.json"), 1_000);
        let reloaded = reload_with_disk_state(reloaded).await;
        assert!(reloaded.session_account(&grant.token).await.is_none());
    }

    #[tokio::test]
    async fn the_store_never_holds_a_password_or_a_token() {
        let (store, dir) = scratch("no-secrets");
        let grant = store
            .register("Asha", "asha@work.com", "the-secret-password")
            .await
            .unwrap();
        let _ = store.login("asha@work.com", "the-secret-password").await.unwrap();
        let file = std::fs::read_to_string(dir.join("accounts.json")).unwrap();
        assert!(!file.contains("the-secret-password"));
        assert!(!file.contains(&grant.token));
        assert!(file.contains("pbkdf2-sha256$"));
        assert!(file.contains("tokenHash"));
    }

    #[tokio::test]
    async fn accounts_and_sessions_survive_a_restart() {
        let (store, dir) = scratch("persist");
        let grant = store.register("Asha", "asha@work.com", "correct horse battery").await.unwrap();
        drop(store);
        let reloaded = AccountStore::scratch(dir.join("accounts.json"), PBKDF2_ITERATIONS);
        let reloaded = reload_with_disk_state(reloaded).await;
        let restored = reloaded.session_account(&grant.token).await.unwrap();
        assert_eq!(restored.email, "asha@work.com");
        let login = reloaded.login("asha@work.com", "correct horse battery").await.unwrap();
        assert_eq!(login.account.id, grant.account.id);
    }

    async fn reload_with_disk_state(store: AccountStore) -> AccountStore {
        // `load()` derives its path from the environment; tests point a scratch
        // store at the file directly instead.
        let stored = read_object(&store.path).await;
        *store.inner.lock().await = Inner {
            accounts: stored
                .get("accounts")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(account_from_json).collect())
                .unwrap_or_default(),
            sessions: stored
                .get("sessions")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(session_from_json).collect())
                .unwrap_or_default(),
        };
        store
    }

    #[tokio::test]
    async fn a_mangled_stored_hash_fails_closed() {
        let (store, _dir) = scratch("mangled");
        store.register("Asha", "asha@work.com", "correct horse battery").await.unwrap();
        {
            let mut inner = store.inner.lock().await;
            inner.accounts[0].password_hash = "not-a-real-hash".into();
        }
        let Err((status, _)) = store.login("asha@work.com", "correct horse battery").await else {
            panic!("a mangled hash must not authenticate");
        };
        assert_eq!(status, 401);
    }
}
