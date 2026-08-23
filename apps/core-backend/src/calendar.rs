use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use chrono::{DateTime, SecondsFormat, Utc};
use reqwest::Client;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::broadcast,
    time::timeout,
};
use uuid::Uuid;

use crate::settings::SettingsStore;

pub const GOOGLE: &str = "google";
pub const MICROSOFT: &str = "microsoft";

const CONSENT_TIMEOUT: Duration = Duration::from_secs(300);
const REFRESH_MARGIN_SECS: i64 = 60;

struct Spec {
    id: &'static str,
    label: &'static str,
    auth_url: &'static str,
    token_url: &'static str,
    scope: &'static str,
    redirect_host: &'static str,
    extra_auth: &'static [(&'static str, &'static str)],
}

const SPECS: [Spec; 2] = [
    Spec {
        id: GOOGLE,
        label: "Google Calendar",
        auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
        token_url: "https://oauth2.googleapis.com/token",
        scope: "openid email https://www.googleapis.com/auth/calendar.events.readonly",
        redirect_host: "127.0.0.1",
        extra_auth: &[("access_type", "offline"), ("prompt", "consent")],
    },
    Spec {
        id: MICROSOFT,
        label: "Microsoft Outlook",
        auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        scope: "openid email offline_access https://graph.microsoft.com/Calendars.Read",
        redirect_host: "localhost",
        extra_auth: &[("response_mode", "query")],
    },
];

fn spec_for(provider: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|spec| spec.id == provider)
}

pub fn is_provider(value: &str) -> bool {
    spec_for(value).is_some()
}

fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    B64URL.encode(bytes)
}

fn challenge_for(verifier: &str) -> String {
    B64URL.encode(Sha256::digest(verifier.as_bytes()))
}

fn credential_key(provider: &str) -> String {
    format!("{provider}CalendarToken")
}

fn client_id_key(provider: &str) -> String {
    format!("{provider}CalendarClientId")
}

fn client_secret_key(provider: &str) -> String {
    format!("{provider}CalendarClientSecret")
}

fn env_key(provider: &str, suffix: &str) -> String {
    format!("ALPHA_{}_CALENDAR_{suffix}", provider.to_uppercase())
}

fn rfc3339(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}

const CLOSE_PAGE: &str = "<!doctype html><meta charset=\"utf-8\"><title>Alpha</title>\
<style>body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;color:#1D1D1F;background:#fff;\
padding:40px;max-width:680px;margin:auto;line-height:1.4}h1{font-size:28px;font-weight:600;letter-spacing:-0.02em;margin:0 0 8px}\
p{color:#6E6E73;font-size:15px;margin:0}</style>\
<h1>Calendar connected</h1><p>You can close this tab and go back to Alpha.</p>";

struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: i64,
    account: Option<String>,
}

impl Tokens {
    fn from_response(body: &Value, previous_refresh: Option<String>, previous_account: Option<String>) -> Result<Self, String> {
        let access_token = body
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or_else(|| "the provider did not return an access token".to_string())?
            .to_string();
        let expires_in = body.get("expires_in").and_then(Value::as_i64).unwrap_or(3600);
        let refresh_token = body
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or(previous_refresh);
        let account = account_from_id_token(body.get("id_token").and_then(Value::as_str)).or(previous_account);
        Ok(Self {
            access_token,
            refresh_token,
            expires_at: Utc::now().timestamp() + expires_in,
            account,
        })
    }

    fn to_value(&self) -> Value {
        json!({
            "accessToken": self.access_token,
            "refreshToken": self.refresh_token,
            "expiresAt": self.expires_at,
            "account": self.account,
        })
    }

    fn from_value(value: &Value) -> Option<Self> {
        Some(Self {
            access_token: value.get("accessToken").and_then(Value::as_str).unwrap_or_default().to_string(),
            refresh_token: value.get("refreshToken").and_then(Value::as_str).map(str::to_string),
            expires_at: value.get("expiresAt").and_then(Value::as_i64).unwrap_or(0),
            account: value.get("account").and_then(Value::as_str).map(str::to_string),
        })
    }

    fn is_fresh(&self) -> bool {
        !self.access_token.is_empty() && self.expires_at - REFRESH_MARGIN_SECS > Utc::now().timestamp()
    }
}

fn account_from_id_token(id_token: Option<&str>) -> Option<String> {
    let payload = id_token?.split('.').nth(1)?;
    let decoded = B64URL.decode(payload).ok()?;
    let claims: Value = serde_json::from_slice(&decoded).ok()?;
    claims
        .get("email")
        .or_else(|| claims.get("preferred_username"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub struct CalendarService {
    http: Client,
    settings: Arc<SettingsStore>,
    events: broadcast::Sender<String>,
}

impl CalendarService {
    pub fn new(settings: Arc<SettingsStore>, events: broadcast::Sender<String>) -> Self {
        Self {
            http: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            settings,
            events,
        }
    }

    async fn client_id(&self, provider: &str) -> Option<String> {
        if let Ok(value) = std::env::var(env_key(provider, "CLIENT_ID")) {
            let trimmed = value.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
        self.settings
            .credential(&client_id_key(provider))
            .await
            .filter(|value| !value.trim().is_empty())
    }

    async fn client_secret(&self, provider: &str) -> Option<String> {
        if let Ok(value) = std::env::var(env_key(provider, "CLIENT_SECRET")) {
            let trimmed = value.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
        self.settings
            .credential(&client_secret_key(provider))
            .await
            .filter(|value| !value.trim().is_empty())
    }

    async fn stored(&self, provider: &str) -> Option<Tokens> {
        let raw = self.settings.credential(&credential_key(provider)).await?;
        let value: Value = serde_json::from_str(&raw).ok()?;
        Tokens::from_value(&value)
    }

    async fn save(&self, provider: &str, tokens: &Tokens) -> Result<(), String> {
        self.settings
            .set_credential(&credential_key(provider), Some(&tokens.to_value().to_string()))
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub async fn status(&self) -> Value {
        let mut providers = Vec::new();
        for spec in SPECS.iter() {
            let tokens = self.stored(spec.id).await;
            providers.push(json!({
                "provider": spec.id,
                "label": spec.label,
                "connected": tokens.is_some(),
                "account": tokens.and_then(|token| token.account),
                "configured": self.client_id(spec.id).await.is_some(),
            }));
        }
        json!({ "providers": providers })
    }

    pub async fn disconnect(&self, provider: &str) -> Result<(), String> {
        if !is_provider(provider) {
            return Err(format!("unknown calendar provider: {provider}"));
        }
        self.settings
            .set_credential(&credential_key(provider), None)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub async fn begin(self: &Arc<Self>, provider: &str) -> Result<Value, String> {
        let spec = spec_for(provider).ok_or_else(|| format!("unknown calendar provider: {provider}"))?;
        let client_id = self.client_id(provider).await.ok_or_else(|| {
            format!(
                "{} needs an OAuth client id. Set {} or save {} in settings.",
                spec.label,
                env_key(provider, "CLIENT_ID"),
                client_id_key(provider)
            )
        })?;

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| format!("could not open the sign-in listener: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let redirect = format!("http://{}:{port}", spec.redirect_host);

        let verifier = random_secret();
        let state = random_secret();
        let mut url = format!(
            "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
            spec.auth_url,
            encode(&client_id),
            encode(&redirect),
            encode(spec.scope),
            encode(&state),
            encode(&challenge_for(&verifier))
        );
        for (key, value) in spec.extra_auth {
            url.push_str(&format!("&{}={}", encode(key), encode(value)));
        }

        let service = Arc::clone(self);
        let provider = provider.to_string();
        let announced = provider.clone();
        tokio::spawn(async move {
            let outcome = service.finish(&provider, listener, state, verifier, redirect).await;
            let data = match outcome {
                Ok(account) => json!({ "provider": provider, "connected": true, "account": account }),
                Err(error) => json!({ "provider": provider, "connected": false, "error": error }),
            };
            let _ = service.events.send(
                json!({
                    "type": "calendar_connection",
                    "data": data,
                    "timestamp": Utc::now().timestamp_millis(),
                })
                .to_string(),
            );
        });

        Ok(json!({ "authUrl": url, "provider": announced }))
    }

    async fn finish(
        &self,
        provider: &str,
        listener: TcpListener,
        state: String,
        verifier: String,
        redirect: String,
    ) -> Result<Option<String>, String> {
        let code = wait_for_code(listener, state).await?;
        let spec = spec_for(provider).ok_or("unknown calendar provider")?;
        let client_id = self.client_id(provider).await.ok_or("the OAuth client id went missing")?;

        let mut form = vec![
            ("client_id", client_id),
            ("code", code),
            ("code_verifier", verifier),
            ("grant_type", "authorization_code".to_string()),
            ("redirect_uri", redirect),
        ];
        if let Some(secret) = self.client_secret(provider).await {
            form.push(("client_secret", secret));
        }

        let body = self.post_form(spec.token_url, &form).await?;
        let tokens = Tokens::from_response(&body, None, None)?;
        if tokens.refresh_token.is_none() {
            return Err("the provider did not return a refresh token, so the connection would not survive a restart".into());
        }
        let account = tokens.account.clone();
        self.save(provider, &tokens).await?;
        Ok(account)
    }

    async fn post_form(&self, url: &str, form: &[(&str, String)]) -> Result<Value, String> {
        let response = self
            .http
            .post(url)
            .form(form)
            .send()
            .await
            .map_err(|error| format!("the token request failed: {error}"))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|error| format!("the token response was not JSON: {error}"))?;
        if !status.is_success() {
            let detail = body
                .get("error_description")
                .or_else(|| body.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("the provider rejected the request");
            return Err(detail.to_string());
        }
        Ok(body)
    }

    async fn access_token(&self, provider: &str) -> Result<String, String> {
        let stored = self
            .stored(provider)
            .await
            .ok_or_else(|| format!("{provider} is not connected"))?;
        if stored.is_fresh() {
            return Ok(stored.access_token);
        }

        let spec = spec_for(provider).ok_or("unknown calendar provider")?;
        let refresh = stored
            .refresh_token
            .clone()
            .ok_or_else(|| format!("{provider} has no refresh token; reconnect it"))?;
        let client_id = self.client_id(provider).await.ok_or("the OAuth client id went missing")?;

        let mut form = vec![
            ("client_id", client_id),
            ("refresh_token", refresh.clone()),
            ("grant_type", "refresh_token".to_string()),
        ];
        if spec.id == MICROSOFT {
            form.push(("scope", spec.scope.to_string()));
        }
        if let Some(secret) = self.client_secret(provider).await {
            form.push(("client_secret", secret));
        }

        let body = self.post_form(spec.token_url, &form).await?;
        let tokens = Tokens::from_response(&body, Some(refresh), stored.account)?;
        let access = tokens.access_token.clone();
        self.save(provider, &tokens).await?;
        Ok(access)
    }

    pub async fn events(&self, minutes_back: i64, minutes_ahead: i64) -> Value {
        let now = Utc::now();
        let start = now - chrono::Duration::minutes(minutes_back.max(0));
        let end = now + chrono::Duration::minutes(minutes_ahead.max(1));

        let mut events = Vec::new();
        let mut warnings = Vec::new();

        for spec in SPECS.iter() {
            if self.stored(spec.id).await.is_none() {
                continue;
            }
            match self.fetch(spec.id, start, end).await {
                Ok(mut found) => events.append(&mut found),
                Err(error) => warnings.push(json!({ "provider": spec.id, "error": error })),
            }
        }

        events.sort_by(|a, b| {
            a.get("start")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .cmp(b.get("start").and_then(Value::as_str).unwrap_or_default())
        });

        json!({ "events": events, "warnings": warnings })
    }

    async fn fetch(&self, provider: &str, start: DateTime<Utc>, end: DateTime<Utc>) -> Result<Vec<Value>, String> {
        let token = self.access_token(provider).await?;
        let request = match provider {
            GOOGLE => self
                .http
                .get("https://www.googleapis.com/calendar/v3/calendars/primary/events")
                .query(&[
                    ("timeMin", rfc3339(start)),
                    ("timeMax", rfc3339(end)),
                    ("singleEvents", "true".into()),
                    ("orderBy", "startTime".into()),
                    ("maxResults", "25".into()),
                ]),
            _ => self
                .http
                .get("https://graph.microsoft.com/v1.0/me/calendarView")
                .header("Prefer", "outlook.timezone=\"UTC\"")
                .query(&[
                    ("startDateTime", rfc3339(start)),
                    ("endDateTime", rfc3339(end)),
                    ("$orderby", "start/dateTime".into()),
                    ("$top", "25".into()),
                ]),
        };

        let response = request
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| format!("the calendar request failed: {error}"))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|error| format!("the calendar response was not JSON: {error}"))?;
        if !status.is_success() {
            let detail = body
                .pointer("/error/message")
                .or_else(|| body.pointer("/error/error_description"))
                .and_then(Value::as_str)
                .unwrap_or("the calendar rejected the request");
            return Err(detail.to_string());
        }

        let items = body
            .get("items")
            .or_else(|| body.get("value"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        Ok(items
            .iter()
            .filter_map(|item| normalize(provider, item))
            .collect())
    }
}

fn normalize(provider: &str, item: &Value) -> Option<Value> {
    if provider == GOOGLE {
        if item.get("status").and_then(Value::as_str) == Some("cancelled") {
            return None;
        }
        let start = item.pointer("/start/dateTime").or_else(|| item.pointer("/start/date"))?.as_str()?;
        let end = item
            .pointer("/end/dateTime")
            .or_else(|| item.pointer("/end/date"))
            .and_then(Value::as_str)
            .unwrap_or(start);
        let attendees: Vec<Value> = item
            .get("attendees")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter(|person| person.get("resource").and_then(Value::as_bool) != Some(true))
                    .map(|person| {
                        json!({
                            "name": person.get("displayName").and_then(Value::as_str),
                            "email": person.get("email").and_then(Value::as_str),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Some(json!({
            "id": item.get("id").and_then(Value::as_str),
            "provider": GOOGLE,
            "title": item.get("summary").and_then(Value::as_str).unwrap_or("Untitled event"),
            "start": start,
            "end": end,
            "location": item.get("location").and_then(Value::as_str),
            "joinUrl": item.get("hangoutLink").and_then(Value::as_str)
                .or_else(|| item.pointer("/conferenceData/entryPoints/0/uri").and_then(Value::as_str)),
            "organizer": item.pointer("/organizer/email").and_then(Value::as_str),
            "attendees": attendees,
        }))
    } else {
        if item.get("isCancelled").and_then(Value::as_bool) == Some(true) {
            return None;
        }
        let start = item.pointer("/start/dateTime")?.as_str()?;
        let end = item.pointer("/end/dateTime").and_then(Value::as_str).unwrap_or(start);
        let attendees: Vec<Value> = item
            .get("attendees")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .map(|person| {
                        json!({
                            "name": person.pointer("/emailAddress/name").and_then(Value::as_str),
                            "email": person.pointer("/emailAddress/address").and_then(Value::as_str),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Some(json!({
            "id": item.get("id").and_then(Value::as_str),
            "provider": MICROSOFT,
            "title": item.get("subject").and_then(Value::as_str).unwrap_or("Untitled event"),
            "start": normalize_graph_time(start),
            "end": normalize_graph_time(end),
            "location": item.pointer("/location/displayName").and_then(Value::as_str),
            "joinUrl": item.pointer("/onlineMeeting/joinUrl").and_then(Value::as_str),
            "organizer": item.pointer("/organizer/emailAddress/address").and_then(Value::as_str),
            "attendees": attendees,
        }))
    }
}

fn normalize_graph_time(value: &str) -> String {
    if value.ends_with('Z') || value.contains('+') {
        value.to_string()
    } else {
        format!("{value}Z")
    }
}

async fn wait_for_code(listener: TcpListener, expected_state: String) -> Result<String, String> {
    let accepted = timeout(CONSENT_TIMEOUT, listener.accept())
        .await
        .map_err(|_| "the browser did not come back within five minutes".to_string())?
        .map_err(|error| format!("the sign-in listener failed: {error}"))?;
    let (mut stream, _) = accepted;

    let mut buffer = vec![0u8; 8192];
    let read = stream
        .read(&mut buffer)
        .await
        .map_err(|error| format!("could not read the sign-in response: {error}"))?;
    let head = String::from_utf8_lossy(&buffer[..read]);
    let target = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or_default();

    let mut params: HashMap<String, String> = HashMap::new();
    if let Some((_, query)) = target.split_once('?') {
        for pair in query.split('&') {
            if let Some((key, value)) = pair.split_once('=') {
                params.insert(key.to_string(), decode(value));
            }
        }
    }

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        CLOSE_PAGE.len(),
        CLOSE_PAGE
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;

    if params.get("state").map(String::as_str) != Some(expected_state.as_str()) {
        return Err("the sign-in response did not match this request".into());
    }
    if let Some(error) = params.get("error") {
        return Err(params.get("error_description").unwrap_or(error).clone());
    }
    params
        .get("code")
        .cloned()
        .ok_or_else(|| "no authorization code came back".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_matches_rfc7636_example() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(challenge_for(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn decode_handles_escapes_and_plus() {
        assert_eq!(decode("a%40b.com+x"), "a@b.com x");
    }

    #[test]
    fn encode_leaves_unreserved_alone() {
        assert_eq!(encode("aZ0-_.~"), "aZ0-_.~");
        assert_eq!(encode("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn graph_time_gets_utc_marker() {
        assert_eq!(normalize_graph_time("2026-08-30T10:00:00.0000000"), "2026-08-30T10:00:00.0000000Z");
        assert_eq!(normalize_graph_time("2026-08-30T10:00:00Z"), "2026-08-30T10:00:00Z");
    }

    #[test]
    fn google_event_normalizes() {
        let item = json!({
            "id": "abc",
            "summary": "Standup",
            "start": { "dateTime": "2026-08-30T10:00:00Z" },
            "end": { "dateTime": "2026-08-30T10:15:00Z" },
            "hangoutLink": "https://meet.google.com/xyz",
            "attendees": [{ "email": "a@b.com", "displayName": "A B" }]
        });
        let event = normalize(GOOGLE, &item).expect("event");
        assert_eq!(event["title"], "Standup");
        assert_eq!(event["joinUrl"], "https://meet.google.com/xyz");
        assert_eq!(event["attendees"][0]["email"], "a@b.com");
    }

    #[test]
    fn cancelled_events_are_dropped() {
        let google = json!({ "status": "cancelled", "start": { "dateTime": "2026-08-30T10:00:00Z" } });
        assert!(normalize(GOOGLE, &google).is_none());
        let microsoft = json!({ "isCancelled": true, "start": { "dateTime": "2026-08-30T10:00:00" } });
        assert!(normalize(MICROSOFT, &microsoft).is_none());
    }
}
