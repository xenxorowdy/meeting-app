//! Supabase brokers Google sign-in; the desktop keeps its existing local session.
//! Provider tokens never reach the renderer or the on-disk account store.
use crate::google_auth::GoogleIdentity;
use crate::settings::SettingsStore;
use reqwest::Url;
use serde_json::{json, Value};
use std::{sync::OnceLock, time::Duration};
use tokio::sync::Mutex;

const CLOUD_SESSION: &str = "supabaseCloudSession";
static REFRESH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub struct SupabaseGrant {
    pub identity: GoogleIdentity,
    access_token: String,
    refresh_token: String,
    expires_at: i64,
}

pub fn cloud_origin() -> Option<String> {
    let raw = kesami_core_backend::env_compat::var("KESAMI_CLOUD_URL").ok()?;
    let url = Url::parse(raw.trim()).ok()?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty()
        || url.password().is_some() || url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

pub fn cloud_realtime_url() -> Option<String> {
    Some(format!("{}/v1/transcription/realtime", cloud_origin()?.replacen("https://", "wss://", 1)))
}

impl std::ops::Deref for SupabaseGrant {
    type Target = GoogleIdentity;
    fn deref(&self) -> &Self::Target { &self.identity }
}

pub struct SupabaseAuth {
    enabled: bool,
    config: Option<Config>,
}

struct Config {
    url: Url,
    key: String,
    sync_users: bool,
}

impl SupabaseAuth {
    pub fn from_env() -> Self {
        let enabled = kesami_core_backend::env_compat::var("KESAMI_AUTH_PROVIDER").is_ok_and(|value| value.trim() == "supabase");
        let config = kesami_core_backend::env_compat::var("KESAMI_SUPABASE_URL").ok().and_then(|url| {
            let key = kesami_core_backend::env_compat::var("KESAMI_SUPABASE_PUBLISHABLE_KEY").ok()?;
            let mut config = Config::parse(&url, &key)?;
            config.sync_users = kesami_core_backend::env_compat::var("KESAMI_SUPABASE_SYNC_USERS").is_ok_and(|value| matches!(value.trim(), "true" | "1"));
            Some(config)
        });
        Self { enabled, config }
    }

    pub fn public_config(&self) -> Value {
        if !self.enabled { return Value::Null; }
        json!({
            "provider": "supabase",
            "configured": self.config.is_some(),
            "url": self.config.as_ref().map(|config| config.url.as_str().trim_end_matches('/')),
        })
    }

    pub async fn exchange_google_code(&self, code: &str, verifier: &str) -> Result<SupabaseGrant, (u16, String)> {
        let config = self.config.as_ref().filter(|_| self.enabled).ok_or((503,
            "Supabase Google sign-in needs KESAMI_AUTH_PROVIDER=supabase, KESAMI_SUPABASE_URL, and KESAMI_SUPABASE_PUBLISHABLE_KEY in the backend configuration.".into()))?;
        if code.is_empty() || code.len() > 2_048 || !(43..=128).contains(&verifier.len())
            || !verifier.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-._~".contains(&byte)) {
            return Err((400, "Google sign-in authorization is invalid. Please start sign-in again.".into()));
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build().map_err(|_| unavailable())?;
        let response = http.post(config.url.join("auth/v1/token?grant_type=pkce").map_err(|_| unavailable())?)
            .header("apikey", &config.key)
            .json(&json!({ "auth_code": code, "code_verifier": verifier }))
            .send().await.map_err(|_| unavailable())?;
        if !response.status().is_success() {
            return Err(if response.status().is_server_error() { unavailable() } else {
                (401, "Supabase rejected Google sign-in. Please start sign-in again.".into())
            });
        }
        let tokens: Value = response.json().await.map_err(|_| unavailable())?;
        let token = tokens.get("access_token").and_then(Value::as_str)
            .filter(|token| !token.is_empty() && token.len() <= 16_384)
            .ok_or_else(invalid_identity)?;
        // Ask the configured Auth server to verify its token. Never accept an
        // identity or decoded JWT supplied by the renderer as proof of identity.
        let response = http.get(config.url.join("auth/v1/user").map_err(|_| unavailable())?)
            .header("apikey", &config.key).bearer_auth(token)
            .send().await.map_err(|_| unavailable())?;
        if !response.status().is_success() {
            return Err(if response.status().is_server_error() { unavailable() } else { invalid_identity() });
        }
        let user = response.json::<Value>().await.map_err(|_| unavailable())?;
        let identity = google_identity(&user)?;
        if config.sync_users {
            // Use the verified Supabase user ID, not the local account ID or
            // Google subject. The user's access token enforces auth.uid() RLS.
            let response = http.post(config.url.join("rest/v1/users?on_conflict=id").map_err(|_| unavailable())?)
                .header("apikey", &config.key).bearer_auth(token)
                .header("Prefer", "resolution=merge-duplicates,return=minimal")
                .json(&json!({
                    "id": user["id"], "name": identity.name, "email": identity.email,
                    "updated_at": chrono::Utc::now().to_rfc3339(),
                }))
                .send().await.map_err(|_| profile_unavailable())?;
            if !response.status().is_success() { return Err(profile_unavailable()); }
        }
        Ok(SupabaseGrant {
            identity,
            access_token: token.to_string(),
            refresh_token: tokens.get("refresh_token").and_then(Value::as_str).unwrap_or_default().to_string(),
            expires_at: chrono::Utc::now().timestamp() + tokens.get("expires_in").and_then(Value::as_i64).unwrap_or(3600),
        })
    }

    pub async fn store_cloud_grant(&self, settings: &SettingsStore, grant: &SupabaseGrant, account_id: &str) -> Result<(), String> {
        if grant.refresh_token.is_empty() { return Err("Google sign-in did not return a renewable session.".into()); }
        let value = json!({"accountId": account_id, "accessToken": grant.access_token,
            "refreshToken": grant.refresh_token, "expiresAt": grant.expires_at});
        settings.set_credential(CLOUD_SESSION, Some(&value.to_string())).await
            .map(|_| ()).map_err(|_| "Could not save the sign-in session on this Mac.".to_string())
    }

    pub async fn clear_cloud_grant(&self, settings: &SettingsStore) {
        let _ = settings.set_credential(CLOUD_SESSION, None).await;
    }

    pub async fn cloud_access_token(&self, settings: &SettingsStore, account_id: &str) -> Result<String, String> {
        let _guard = REFRESH_LOCK.get_or_init(|| Mutex::new(())).lock().await;
        let saved = settings.credential(CLOUD_SESSION).await.ok_or("Sign in with Google to use hosted transcription.")?;
        let session: Value = serde_json::from_str(&saved).map_err(|_| "Sign in with Google again to use hosted transcription.")?;
        if session["accountId"].as_str() != Some(account_id) {
            return Err("Sign in with Google to use hosted transcription.".into());
        }
        if session["expiresAt"].as_i64().unwrap_or(0) > chrono::Utc::now().timestamp() + 120 {
            return session["accessToken"].as_str().map(str::to_string).ok_or("Sign in with Google again.".into());
        }
        let config = self.config.as_ref().filter(|_| self.enabled).ok_or("Google sign-in is unavailable.".to_string())?;
        let refresh = session["refreshToken"].as_str().ok_or("Sign in with Google again.".to_string())?;
        let response = reqwest::Client::builder().timeout(Duration::from_secs(15)).build()
            .map_err(|_| "Google sign-in is unavailable.".to_string())?
            .post(config.url.join("auth/v1/token?grant_type=refresh_token").map_err(|_| "Google sign-in is unavailable.")?)
            .header("apikey", &config.key).json(&json!({"refresh_token": refresh}))
            .send().await.map_err(|_| "Could not renew Google sign-in. Try again.")?;
        if !response.status().is_success() { return Err("Google sign-in expired. Sign in again.".into()); }
        let tokens: Value = response.json().await.map_err(|_| "Could not renew Google sign-in.")?;
        let access = tokens["access_token"].as_str().filter(|value| !value.is_empty()).ok_or("Could not renew Google sign-in.")?.to_string();
        let next_refresh = tokens["refresh_token"].as_str().filter(|value| !value.is_empty()).ok_or("Could not renew Google sign-in.")?;
        let next = json!({"accountId": account_id, "accessToken": access,
            "refreshToken": next_refresh, "expiresAt": chrono::Utc::now().timestamp() + tokens["expires_in"].as_i64().unwrap_or(3600)});
        settings.set_credential(CLOUD_SESSION, Some(&next.to_string())).await.map_err(|_| "Could not save renewed Google sign-in.")?;
        Ok(access)
    }

    pub async fn cloud_transcription_ready(&self, token: &str) -> Result<(), String> {
        let origin = cloud_origin().ok_or("This Kesami build has no transcription service.")?;
        let response = reqwest::Client::builder().timeout(Duration::from_secs(8)).build()
            .map_err(|_| "Transcription service is unavailable. Try again.")?
            .get(format!("{origin}/v1/capabilities")).bearer_auth(token)
            .send().await.map_err(|_| "Transcription service is offline. Try again.")?;
        match response.status().as_u16() {
            200 => Ok(()),
            401 | 403 => Err("Google sign-in expired. Sign in again.".into()),
            429 => Err("Your transcription limit is currently reached. Try again later.".into()),
            _ => Err("Transcription service is unavailable. Try again.".into()),
        }
    }
}

impl Config {
    fn parse(url: &str, key: &str) -> Option<Self> {
        let url = Url::parse(url.trim()).ok()?;
        if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty()
            || url.password().is_some() || url.path() != "/" || url.query().is_some()
            || url.fragment().is_some() || key.trim().is_empty() {
            return None;
        }
        Some(Self { url, key: key.trim().to_string(), sync_users: false })
    }
}

/// Confirms KESAMI_SUPABASE_SECRET_KEY is a live secret key by calling an
/// admin-only Auth endpoint. Independent of KESAMI_AUTH_PROVIDER/`SupabaseAuth`
/// (Google sign-in) — this only needs the project URL and the secret key.
pub async fn check_secret_key() -> Result<Value, (u16, String)> {
    let url = kesami_core_backend::env_compat::var("KESAMI_SUPABASE_URL").ok().filter(|value| !value.trim().is_empty())
        .ok_or((503, "KESAMI_SUPABASE_URL is not configured.".into()))?;
    let secret = kesami_core_backend::env_compat::var("KESAMI_SUPABASE_SECRET_KEY").ok().filter(|value| !value.trim().is_empty())
        .ok_or((503, "KESAMI_SUPABASE_SECRET_KEY is not configured.".into()))?;
    let config = Config::parse(&url, &secret)
        .ok_or((503, "KESAMI_SUPABASE_URL must be a bare https origin, e.g. https://<ref>.supabase.co".into()))?;
    let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|_| unavailable())?;
    let response = http
        .get(config.url.join("auth/v1/admin/users?page=1&per_page=1").map_err(|_| unavailable())?)
        .header("apikey", &config.key).bearer_auth(&config.key)
        .send().await.map_err(|_| unavailable())?;
    let status = response.status();
    if status.is_success() {
        return Ok(json!({ "ok": true, "status": status.as_u16() }));
    }
    Err(if status == 401 || status == 403 {
        (status.as_u16(), "Supabase rejected KESAMI_SUPABASE_SECRET_KEY. Check it is a current project secret key, not a publishable/anon key.".into())
    } else if status.is_server_error() {
        unavailable()
    } else {
        (status.as_u16(), "Supabase admin API check failed.".into())
    })
}

fn unavailable() -> (u16, String) {
    (503, "Supabase sign-in is unavailable. Check your connection and try again.".into())
}

fn profile_unavailable() -> (u16, String) {
    (503, "Could not save your user profile. Check that the backend users migration is applied, then try signing in again.".into())
}

fn invalid_identity() -> (u16, String) {
    (401, "Supabase did not verify a Google identity and email for this account.".into())
}

fn google_identity(user: &Value) -> Result<GoogleIdentity, (u16, String)> {
    if user.get("id").and_then(Value::as_str).and_then(|id| uuid::Uuid::parse_str(id).ok()).is_none()
        || user.get("is_anonymous").and_then(Value::as_bool) == Some(true) {
        return Err(invalid_identity());
    }
    // identity_data is populated by the provider. user_metadata is editable by
    // the user and must not be used for a Google subject or verified email.
    let identities = user.get("identities").and_then(Value::as_array).ok_or_else(invalid_identity)?;
    let mut google = identities.iter().filter(|identity| identity.get("provider").and_then(Value::as_str) == Some("google"));
    let identity = google.next().ok_or_else(invalid_identity)?;
    if google.next().is_some() { return Err(invalid_identity()); }
    let data = identity.get("identity_data").ok_or_else(invalid_identity)?;
    let sub = data.get("sub").and_then(Value::as_str).filter(|sub| !sub.is_empty() && sub.len() <= 255).ok_or_else(invalid_identity)?;
    let email = data.get("email").and_then(Value::as_str).filter(|email| !email.is_empty()).ok_or_else(invalid_identity)?;
    if data.get("email_verified").and_then(Value::as_bool) != Some(true) { return Err(invalid_identity()); }
    Ok(GoogleIdentity {
        sub: sub.into(), email: email.into(),
        name: data.get("full_name").or_else(|| data.get("name")).and_then(Value::as_str).unwrap_or_default().into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn user() -> Value {
        json!({ "id": "12345678-1234-4234-8234-123456789012", "identities": [{
            "provider": "google", "identity_data": { "sub": "google-stable-sub", "email": "person@example.com", "email_verified": true, "full_name": "Person" }
        }] })
    }

    #[test]
    fn only_provider_verified_google_identity_is_accepted() {
        let mut valid = user();
        valid["user_metadata"] = json!({"sub": "attacker", "email": "attacker@example.com", "email_verified": true});
        assert_eq!(google_identity(&valid).unwrap().sub, "google-stable-sub");
        for field in ["sub", "email", "email_verified"] {
            let mut invalid = valid.clone();
            invalid["identities"][0]["identity_data"][field] = Value::Null;
            assert!(google_identity(&invalid).is_err());
        }
        valid["identities"][0]["provider"] = json!("email");
        assert!(google_identity(&valid).is_err());
        valid["identities"] = json!([user()["identities"][0], user()["identities"][0]]);
        assert!(google_identity(&valid).is_err());
    }

    #[test]
    fn config_requires_https_origin_and_never_exposes_key() {
        for url in ["http://example.com", "https://secret@example.com", "https://example.com/auth/v1", "https://example.com?key=value", "https://example.com#fragment"] {
            assert!(Config::parse(url, "test-key").is_none());
        }
        assert!(Config::parse("https://example.com", "").is_none());
        let auth = SupabaseAuth { enabled: true, config: Config::parse("https://example.com", "test-key") };
        assert_eq!(auth.public_config(), json!({"provider":"supabase", "configured":true, "url":"https://example.com"}));
        assert!(!auth.public_config().to_string().contains("test-key"));
    }

    // Exercise the real HTTP exchange against a local fake Auth server. HTTP is
    // injected only here; production configuration requires HTTPS.
    async fn auth_server(responses: Vec<(u16, Value)>) -> (SupabaseAuth, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            let mut requests = vec![];
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut chunk = [0u8; 4096];
                    let read = stream.read(&mut chunk).await.unwrap();
                    if read == 0 { break; }
                    bytes.extend_from_slice(&chunk[..read]);
                    if let Some(end) = bytes.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length: usize = headers.lines().find_map(|line| line.strip_prefix("content-length: ").and_then(|value| value.parse().ok())).unwrap_or(0);
                        if bytes.len() >= end + 4 + length { break; }
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let body = body.to_string();
                stream.write_all(format!("HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
            requests
        });
        (SupabaseAuth { enabled: true, config: Some(Config { url, key: "test-key".into(), sync_users: false }) }, server)
    }

    #[tokio::test]
    async fn exchanges_pkce_and_verifies_access_token_with_auth_server() {
        let (auth, server) = auth_server(vec![(200, json!({"access_token":"test-access-token", "user":{"id":"untrusted"}})), (200, user())]).await;
        let identity = auth.exchange_google_code("one-time-code", &"v".repeat(64)).await.unwrap();
        assert_eq!(identity.sub, "google-stable-sub");
        assert_eq!(identity.email, "person@example.com");
        let requests = server.await.unwrap();
        assert!(requests[0].starts_with("POST /auth/v1/token?grant_type=pkce "));
        assert!(requests[0].contains("apikey: test-key"));
        let body: Value = serde_json::from_str(requests[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body, json!({"auth_code":"one-time-code", "code_verifier":"v".repeat(64)}));
        assert!(requests[1].starts_with("GET /auth/v1/user "));
        assert!(requests[1].contains("authorization: Bearer test-access-token"));
    }

    #[tokio::test]
    async fn failed_exchange_or_verification_cannot_issue_identity_or_leak_provider_errors() {
        for responses in [
            vec![(400, json!({"error":"sensitive provider response"}))],
            vec![(200, json!({"access_token":"test-token"})), (401, json!({"error":"sensitive provider response"}))],
            vec![(200, json!({"user":user()}))],
        ] {
            let (auth, server) = auth_server(responses).await;
            let error = auth.exchange_google_code("code", &"v".repeat(64)).await.err().unwrap();
            assert_eq!(error.0, 401);
            assert!(!error.1.contains("sensitive"));
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn invalid_proof_is_rejected_before_network_access() {
        let auth = SupabaseAuth { enabled: true, config: Config::parse("https://example.invalid", "test-key") };
        for (code, verifier) in [("", "v".repeat(64)), ("code", "short".into()), ("code", "!".repeat(64)), ("code", "v".repeat(129))] {
            assert_eq!(auth.exchange_google_code(code, &verifier).await.err().unwrap().0, 400);
        }
    }

    #[tokio::test]
    async fn verified_google_sign_in_upserts_profile_with_the_users_own_token() {
        for _ in 0..2 {
            let (mut auth, server) = auth_server(vec![(200, json!({"access_token":"user-token"})), (200, user()), (201, Value::Null)]).await;
            auth.config.as_mut().unwrap().sync_users = true;
            assert!(auth.exchange_google_code("code", &"v".repeat(64)).await.is_ok());
            let requests = server.await.unwrap();
            let request = &requests[2];
            assert!(request.starts_with("POST /rest/v1/users?on_conflict=id "));
            assert!(request.contains("authorization: Bearer user-token"));
            assert!(request.contains("resolution=merge-duplicates,return=minimal"));
            let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            assert_eq!(body["id"], user()["id"]);
            assert_eq!(body["email"], "person@example.com");
            assert_eq!(body["name"], "Person");
            assert!(body.get("created_at").is_none(), "repeat sign-in preserves creation time");
            assert!(body.get("access_token").is_none());
        }
    }

    #[tokio::test]
    async fn profile_failure_is_reported_without_minting_a_local_session() {
        let (mut auth, server) = auth_server(vec![(200, json!({"access_token":"user-token"})), (200, user()), (403, json!({"message":"sensitive database details"}))]).await;
        auth.config.as_mut().unwrap().sync_users = true;
        assert_eq!(auth.exchange_google_code("code", &"v".repeat(64)).await.err().unwrap(), profile_unavailable());
        assert_eq!(server.await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn unverified_identity_never_writes_a_profile() {
        let mut invalid = user();
        invalid["identities"][0]["identity_data"]["email_verified"] = json!(false);
        let (mut auth, server) = auth_server(vec![(200, json!({"access_token":"user-token"})), (200, invalid)]).await;
        auth.config.as_mut().unwrap().sync_users = true;
        assert_eq!(auth.exchange_google_code("code", &"v".repeat(64)).await.err().unwrap().0, 401);
        assert_eq!(server.await.unwrap().len(), 2);
    }
}
