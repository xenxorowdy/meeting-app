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
pub const GOOGLE_DOCS: &str = "googledocs";

const CONSENT_TIMEOUT: Duration = Duration::from_secs(300);
const REFRESH_MARGIN_SECS: i64 = 60;

struct Spec {
    id: &'static str,
    client: &'static str,
    calendar: bool,
    label: &'static str,
    auth_url: &'static str,
    token_url: &'static str,
    scope: &'static str,
    redirect_host: &'static str,
    extra_auth: &'static [(&'static str, &'static str)],
}

const SPECS: [Spec; 3] = [
    Spec {
        id: GOOGLE,
        client: GOOGLE,
        calendar: true,
        label: "Google Calendar",
        auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
        token_url: "https://oauth2.googleapis.com/token",
        scope: "openid email https://www.googleapis.com/auth/calendar.events",
        redirect_host: "127.0.0.1",
        extra_auth: &[("access_type", "offline"), ("prompt", "consent")],
    },
    Spec {
        id: MICROSOFT,
        client: MICROSOFT,
        calendar: true,
        label: "Microsoft Outlook",
        auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        scope: "openid email offline_access https://graph.microsoft.com/Calendars.Read",
        redirect_host: "localhost",
        extra_auth: &[("response_mode", "query")],
    },
    Spec {
        id: GOOGLE_DOCS,
        client: GOOGLE,
        calendar: false,
        label: "Google Docs",
        auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
        token_url: "https://oauth2.googleapis.com/token",
        scope: "openid email https://www.googleapis.com/auth/drive.file",
        redirect_host: "127.0.0.1",
        extra_auth: &[("access_type", "offline"), ("prompt", "consent")],
    },
];

fn spec_for(provider: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|spec| spec.id == provider)
}

pub fn is_provider(value: &str) -> bool {
    spec_for(value).is_some_and(|spec| spec.calendar)
}

fn client_of(provider: &str) -> &str {
    spec_for(provider).map(|spec| spec.client).unwrap_or(provider)
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
    format!("KESAMI_{}_CALENDAR_{suffix}", provider.to_uppercase())
}

fn rfc3339(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn close_page(label: &str) -> String {
    format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Kesami</title>\
<style>body{{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;color:#1D1D1F;background:#fff;\
padding:40px;max-width:680px;margin:auto;line-height:1.4}}h1{{font-size:28px;font-weight:600;letter-spacing:-0.02em;margin:0 0 8px}}\
p{{color:#6E6E73;font-size:15px;margin:0}}</style>\
<h1>{label} connected</h1><p>You can close this tab and go back to Kesami.</p>"
    )
}

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

fn grant_was_revoked(body: &Value) -> bool {
    body.get("error").and_then(Value::as_str) == Some("invalid_grant")
}

const GOOGLE_CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar.events";

fn sign_in_calendar_tokens(body: &Value) -> Result<Option<Tokens>, String> {
    let granted = body.get("scope").and_then(Value::as_str).unwrap_or_default();
    if !granted.split_whitespace().any(|scope| scope == GOOGLE_CALENDAR_SCOPE) {
        return Ok(None);
    }
    let tokens = Tokens::from_response(body, None, None)?;
    if tokens.refresh_token.is_none() {
        return Err("Google did not return a refresh token with calendar access".into());
    }
    Ok(Some(tokens))
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
        let provider = client_of(provider);
        if let Ok(value) = kesami_core_backend::env_compat::var(&env_key(provider, "CLIENT_ID")) {
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
        let provider = client_of(provider);
        if let Ok(value) = kesami_core_backend::env_compat::var(&env_key(provider, "CLIENT_SECRET")) {
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
        for spec in SPECS.iter().filter(|spec| spec.calendar) {
            let mut status = self.oauth_status(spec.id).await;
            status["provider"] = json!(spec.id);
            status["label"] = json!(spec.label);
            providers.push(status);
        }
        json!({ "providers": providers })
    }

    pub async fn oauth_status(&self, provider: &str) -> Value {
        let tokens = self.stored(provider).await;
        json!({
            "connected": tokens.is_some(),
            "account": tokens.and_then(|token| token.account),
            "configured": self.client_id(provider).await.is_some(),
        })
    }

    pub async fn disconnect(&self, provider: &str) -> Result<(), String> {
        if spec_for(provider).is_none() {
            return Err(format!("unknown calendar provider: {provider}"));
        }
        self.settings
            .set_credential(&credential_key(provider), None)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub async fn shares_google_sign_in(&self, sign_in_client_id: &str) -> bool {
        self.client_id(GOOGLE).await.as_deref() == Some(sign_in_client_id)
    }

    pub async fn wants_google_sign_in(&self, sign_in_client_id: &str) -> bool {
        self.stored(GOOGLE).await.is_none() && self.shares_google_sign_in(sign_in_client_id).await
    }

    pub async fn adopt_google_sign_in(&self, body: &Value) -> Result<Option<String>, String> {
        let Some(tokens) = sign_in_calendar_tokens(body)? else {
            return Ok(None);
        };
        let account = tokens.account.clone();
        self.save(GOOGLE, &tokens).await?;
        let _ = self.events.send(
            json!({
                "type": "calendar_connection",
                "data": { "provider": GOOGLE, "connected": true, "account": account },
                "timestamp": Utc::now().timestamp_millis(),
            })
            .to_string(),
        );
        Ok(account)
    }

    pub async fn begin(self: &Arc<Self>, provider: &str) -> Result<Value, String> {
        let spec = spec_for(provider).ok_or_else(|| format!("unknown calendar provider: {provider}"))?;
        let client_id = self.client_id(provider).await.ok_or_else(|| {
            format!(
                "{} needs an OAuth client id. Set {} or save {} in settings.",
                spec.label,
                env_key(client_of(provider), "CLIENT_ID"),
                client_id_key(client_of(provider))
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
        let event_type = if spec.calendar { "calendar_connection" } else { "connector_connection" };
        tokio::spawn(async move {
            let outcome = service.finish(&provider, listener, state, verifier, redirect).await;
            let data = match outcome {
                Ok(account) => json!({ "provider": provider, "connected": true, "account": account }),
                Err(error) => json!({ "provider": provider, "connected": false, "error": error }),
            };
            let _ = service.events.send(
                json!({
                    "type": event_type,
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
        let spec = spec_for(provider).ok_or("unknown calendar provider")?;
        let code = wait_for_code(listener, state, spec.label).await?;
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
        self.post_token_form(url, form).await.map_err(|(_, detail)| detail)
    }

    async fn post_token_form(&self, url: &str, form: &[(&str, String)]) -> Result<Value, (bool, String)> {
        let response = self
            .http
            .post(url)
            .form(form)
            .send()
            .await
            .map_err(|error| (false, format!("the token request failed: {error}")))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|error| (false, format!("the token response was not JSON: {error}")))?;
        if !status.is_success() {
            let detail = body
                .get("error_description")
                .or_else(|| body.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("the provider rejected the request");
            return Err((grant_was_revoked(&body), detail.to_string()));
        }
        Ok(body)
    }

    pub async fn access_token(&self, provider: &str) -> Result<String, String> {
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

        let body = match self.post_token_form(spec.token_url, &form).await {
            Ok(body) => body,
            Err((true, detail)) => {
                self.disconnect(provider).await?;
                return Err(format!("{} access expired or was revoked; reconnect it ({detail})", spec.label));
            }
            Err((false, detail)) => return Err(detail),
        };
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

        for spec in SPECS.iter().filter(|spec| spec.calendar) {
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

    pub async fn create_event(&self, provider: &str, draft: &Value) -> Result<Value, String> {
        if provider != GOOGLE {
            return Err(
                "Outlook is connected read-only. Kesami can create events on Google Calendar; \
                 Microsoft support needs a wider permission than the one this account granted."
                    .to_string(),
            );
        }

        let body = google_event_body(draft)?;
        let token = self.access_token(provider).await?;
        let response = self
            .http
            .post("https://www.googleapis.com/calendar/v3/calendars/primary/events")
            .query(&[("conferenceDataVersion", "1"), ("sendUpdates", "all")])
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("the calendar request failed: {error}"))?;

        let status = response.status();
        let created: Value = response
            .json()
            .await
            .map_err(|error| format!("the calendar response was not JSON: {error}"))?;
        if !status.is_success() {
            let detail = created
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("the calendar rejected the new event");
            return Err(detail.to_string());
        }

        normalize(provider, &created).ok_or_else(|| "the calendar returned an event Kesami could not read".to_string())
    }

    /// One reviewed event, using existing consent/refresh credentials. No retries.
    pub async fn create_reviewed_event(
        &self,
        expected_target: &str,
        draft: &Value,
    ) -> Result<Value, crate::actions::ActionError> {
        use crate::actions::ActionError;
        let mut target = self.oauth_status(GOOGLE).await;
        target["label"] = json!("Google Calendar · primary calendar");
        if crate::actions::target_revision(&target) != expected_target {
            return Err(ActionError { code:"destination_changed".into(),message:"The Google Calendar connection changed. Reload actions and review the updated destination.".into(),retryable:true,uncertain:false });
        }
        let body = google_event_body(draft).map_err(|_| ActionError::response(400))?;
        let token = self.access_token(GOOGLE).await.map_err(|_| ActionError::permission("Connect Google Calendar in Settings and grant event write access, then review and confirm again."))?;
        let created = crate::action_providers::dispatch(
            self.http
                .post("https://www.googleapis.com/calendar/v3/calendars/primary/events")
                .query(&[("sendUpdates", "all")])
                .bearer_auth(token)
                .json(&body),
        )
        .await?;
        let event = normalize(GOOGLE, &created).ok_or_else(ActionError::uncertain)?;
        if created["id"].as_str().is_none() {
            return Err(ActionError::uncertain());
        }
        Ok(json!({"event":event,"id":created["id"],"url":created["htmlLink"]}))
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

pub(crate) fn google_event_body(draft: &Value) -> Result<Value, String> {
    let title = draft
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("a meeting needs a title")?;
    let start = draft.get("start").and_then(Value::as_str).ok_or("a meeting needs a start time")?;
    let end = draft.get("end").and_then(Value::as_str).ok_or("a meeting needs an end time")?;
    let start_at = DateTime::parse_from_rfc3339(start).map_err(|_| "the start time is not a valid timestamp")?;
    let end_at = DateTime::parse_from_rfc3339(end).map_err(|_| "the end time is not a valid timestamp")?;
    if end_at <= start_at {
        return Err("the meeting has to end after it starts".to_string());
    }

    let attendees: Vec<Value> = draft
        .get("attendees")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|email| email.contains('@'))
                .map(|email| json!({ "email": email }))
                .collect()
        })
        .unwrap_or_default();

    let mut body = json!({
        "summary": title,
        "start": { "dateTime": start },
        "end": { "dateTime": end },
        "attendees": attendees,
    });
    if let Some(description) = draft
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body["description"] = json!(description);
    }
    if draft.get("addConference").and_then(Value::as_bool) == Some(true) {
        body["conferenceData"] = json!({
            "createRequest": {
                "requestId": Uuid::new_v4().to_string(),
                "conferenceSolutionKey": { "type": "hangoutsMeet" },
            }
        });
    }

    Ok(body)
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
        let join_url = item
            .get("hangoutLink")
            .and_then(Value::as_str)
            .filter(|url| is_http_url(url))
            .or_else(|| conference_url(item));
        let links = supplied_links([
            item.get("description").and_then(Value::as_str),
            item.get("location").and_then(Value::as_str),
        ]);
        Some(json!({
            "id": item.get("id").and_then(Value::as_str),
            "provider": GOOGLE,
            "title": item.get("summary").and_then(Value::as_str).unwrap_or("Untitled event"),
            "start": start,
            "end": end,
            "location": item.get("location").and_then(Value::as_str),
            "joinUrl": join_url,
            "links": links,
            "eventUrl": item.get("htmlLink").and_then(Value::as_str).filter(|url| is_http_url(url)),
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
        let join_url = item
            .pointer("/onlineMeeting/joinUrl")
            .or_else(|| item.get("onlineMeetingUrl"))
            .and_then(Value::as_str)
            .filter(|url| is_http_url(url));
        let links = supplied_links([
            item.pointer("/body/content").and_then(Value::as_str),
            item.get("bodyPreview").and_then(Value::as_str),
            item.pointer("/location/displayName").and_then(Value::as_str),
        ]);
        Some(json!({
            "id": item.get("id").and_then(Value::as_str),
            "provider": MICROSOFT,
            "title": item.get("subject").and_then(Value::as_str).unwrap_or("Untitled event"),
            "start": normalize_graph_time(start),
            "end": normalize_graph_time(end),
            "location": item.pointer("/location/displayName").and_then(Value::as_str),
            "joinUrl": join_url,
            "links": links,
            "eventUrl": item.get("webLink").and_then(Value::as_str).filter(|url| is_http_url(url)),
            "organizer": item.pointer("/organizer/emailAddress/address").and_then(Value::as_str),
            "attendees": attendees,
        }))
    }
}

fn is_http_url(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}

fn conference_url(item: &Value) -> Option<&str> {
    let entries = item.pointer("/conferenceData/entryPoints")?.as_array()?;
    entries
        .iter()
        .find(|entry| entry.get("entryPointType").and_then(Value::as_str) == Some("video"))
        .and_then(|entry| entry.get("uri").and_then(Value::as_str))
        .filter(|url| is_http_url(url))
        .or_else(|| {
            entries
                .iter()
                .filter_map(|entry| entry.get("uri").and_then(Value::as_str))
                .find(|url| is_http_url(url))
        })
}

fn supplied_links<const N: usize>(fields: [Option<&str>; N]) -> Vec<String> {
    let mut links = Vec::new();
    for field in fields.into_iter().flatten() {
        let mut rest = field;
        while let Some(offset) = [rest.find("http://"), rest.find("https://")]
            .into_iter()
            .flatten()
            .min()
        {
            rest = &rest[offset..];
            let end = rest
                .find(|character: char| character.is_whitespace() || matches!(character, '"' | '\'' | '<' | '>'))
                .unwrap_or(rest.len());
            let url = rest[..end]
                .trim_end_matches(|character| matches!(character, '.' | ',' | ';' | ':' | ')' | ']' | '}'))
                .replace("&amp;", "&");
            if !url.is_empty() && !links.contains(&url) {
                links.push(url);
            }
            rest = &rest[end..];
        }
    }
    links
}

fn normalize_graph_time(value: &str) -> String {
    if value.ends_with('Z') || value.contains('+') {
        value.to_string()
    } else {
        format!("{value}Z")
    }
}

async fn wait_for_code(listener: TcpListener, expected_state: String, label: &str) -> Result<String, String> {
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

    let page = close_page(label);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        page.len(),
        page
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
    fn google_requests_event_write_access_with_fresh_offline_consent() {
        let spec = spec_for(GOOGLE).unwrap();
        let scopes: Vec<_> = spec.scope.split_whitespace().collect();
        assert_eq!(scopes, vec!["openid", "email", "https://www.googleapis.com/auth/calendar.events"]);
        assert!(spec.extra_auth.contains(&("access_type", "offline")));
        assert!(spec.extra_auth.contains(&("prompt", "consent")));
    }

    fn id_token_for(email: &str) -> String {
        format!("h.{}.s", B64URL.encode(json!({ "email": email }).to_string()))
    }

    #[test]
    fn a_sign_in_that_granted_calendar_becomes_a_connection() {
        let body = json!({
            "access_token": "ya29.a",
            "refresh_token": "1//r",
            "expires_in": 3599,
            "scope": "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events",
            "id_token": id_token_for("asha@example.com"),
        });
        let tokens = sign_in_calendar_tokens(&body).unwrap().expect("tokens");
        assert_eq!(tokens.access_token, "ya29.a");
        assert_eq!(tokens.refresh_token.as_deref(), Some("1//r"));
        assert_eq!(tokens.account.as_deref(), Some("asha@example.com"));
        assert!(tokens.is_fresh());
    }

    #[test]
    fn a_sign_in_without_calendar_scope_stores_nothing() {
        let body = json!({ "access_token": "ya29.a", "refresh_token": "1//r", "scope": "openid email profile" });
        assert!(sign_in_calendar_tokens(&body).unwrap().is_none());
        let readonly = json!({ "access_token": "ya29.a", "refresh_token": "1//r", "scope": "https://www.googleapis.com/auth/calendar.events.readonly" });
        assert!(sign_in_calendar_tokens(&readonly).unwrap().is_none());
    }

    #[test]
    fn a_sign_in_with_calendar_but_no_refresh_token_is_refused() {
        let body = json!({ "access_token": "ya29.a", "scope": "openid https://www.googleapis.com/auth/calendar.events" });
        assert!(sign_in_calendar_tokens(&body).is_err());
    }

    #[test]
    fn only_an_invalid_grant_forgets_the_stored_connection() {
        assert!(grant_was_revoked(&json!({ "error": "invalid_grant", "error_description": "Token has been expired or revoked." })));
        assert!(!grant_was_revoked(&json!({ "error": "invalid_client" })));
        assert!(!grant_was_revoked(&json!({ "error": "temporarily_unavailable" })));
    }

    #[test]
    fn microsoft_is_read_only_and_says_why() {
        let spec = spec_for(MICROSOFT).unwrap();
        assert!(spec.scope.contains("Calendars.Read"));
        assert!(!spec.scope.contains("Calendars.ReadWrite"));
    }

    #[test]
    fn a_google_draft_becomes_a_calendar_insert_body() {
        let body = google_event_body(&json!({
            "title": "  Design review  ",
            "start": "2026-08-31T17:00:00Z",
            "end": "2026-08-31T17:45:00Z",
            "attendees": ["asha@example.com", "  ben@example.com ", "not-an-address", ""],
            "description": " Bring the mocks ",
            "addConference": true
        }))
        .expect("body");

        assert_eq!(body["summary"], "Design review");
        assert_eq!(body["start"]["dateTime"], "2026-08-31T17:00:00Z");
        assert_eq!(body["end"]["dateTime"], "2026-08-31T17:45:00Z");
        assert_eq!(body["description"], "Bring the mocks");
        assert_eq!(
            body["attendees"],
            json!([{ "email": "asha@example.com" }, { "email": "ben@example.com" }])
        );
        assert_eq!(body["conferenceData"]["createRequest"]["conferenceSolutionKey"]["type"], "hangoutsMeet");
        assert!(!body["conferenceData"]["createRequest"]["requestId"].as_str().unwrap().is_empty());
    }

    #[test]
    fn a_draft_without_a_conference_asks_google_for_no_link() {
        let body = google_event_body(&json!({
            "title": "Solo hold",
            "start": "2026-08-31T17:00:00Z",
            "end": "2026-08-31T17:45:00Z"
        }))
        .expect("body");

        assert_eq!(body.get("conferenceData"), None);
        assert_eq!(body.get("description"), None);
        assert_eq!(body["attendees"], json!([]));
    }

    #[test]
    fn a_draft_missing_a_title_or_ending_before_it_starts_is_refused() {
        let slot = |extra: Value| {
            let mut draft = json!({ "start": "2026-08-31T17:00:00Z", "end": "2026-08-31T17:45:00Z" });
            for (key, value) in extra.as_object().unwrap() {
                draft[key] = value.clone();
            }
            draft
        };

        assert!(google_event_body(&slot(json!({ "title": "   " }))).is_err());
        assert!(google_event_body(&slot(json!({}))).is_err());
        assert!(google_event_body(&json!({ "title": "Backwards", "start": "2026-08-31T17:45:00Z", "end": "2026-08-31T17:00:00Z" })).is_err());
        assert!(google_event_body(&json!({ "title": "Same", "start": "2026-08-31T17:00:00Z", "end": "2026-08-31T17:00:00Z" })).is_err());
        assert!(google_event_body(&json!({ "title": "Broken", "start": "not a date", "end": "2026-08-31T17:00:00Z" })).is_err());
    }

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
            "description": "Agenda: https://docs.example/agenda. Backup: https://call.example/room?x=1&amp;y=2",
            "htmlLink": "https://calendar.google.com/event/abc",
            "attendees": [{ "email": "a@b.com", "displayName": "A B" }]
        });
        let event = normalize(GOOGLE, &item).expect("event");
        assert_eq!(event["title"], "Standup");
        assert_eq!(event["joinUrl"], "https://meet.google.com/xyz");
        assert_eq!(event["links"], json!(["https://docs.example/agenda", "https://call.example/room?x=1&y=2"]));
        assert_eq!(event["eventUrl"], "https://calendar.google.com/event/abc");
        assert_eq!(event["attendees"][0]["email"], "a@b.com");
    }

    #[test]
    fn provider_links_use_video_conferences_and_supplied_urls() {
        let google = json!({
            "id": "g",
            "start": { "dateTime": "2026-08-30T10:00:00Z" },
            "conferenceData": { "entryPoints": [
                { "entryPointType": "phone", "uri": "tel:+123" },
                { "entryPointType": "video", "uri": "https://meet.example/google" }
            ] }
        });
        assert_eq!(normalize(GOOGLE, &google).unwrap()["joinUrl"], "https://meet.example/google");

        let microsoft = json!({
            "id": "m",
            "start": { "dateTime": "2026-08-30T10:00:00" },
            "onlineMeetingUrl": "https://teams.example/join",
            "bodyPreview": "Read https://docs.example/pre-read before joining",
            "webLink": "https://outlook.example/event"
        });
        let event = normalize(MICROSOFT, &microsoft).unwrap();
        assert_eq!(event["joinUrl"], "https://teams.example/join");
        assert_eq!(event["links"], json!(["https://docs.example/pre-read"]));
        assert_eq!(event["eventUrl"], "https://outlook.example/event");
    }

    #[test]
    fn cancelled_events_are_dropped() {
        let google = json!({ "status": "cancelled", "start": { "dateTime": "2026-08-30T10:00:00Z" } });
        assert!(normalize(GOOGLE, &google).is_none());
        let microsoft = json!({ "isCancelled": true, "start": { "dateTime": "2026-08-30T10:00:00" } });
        assert!(normalize(MICROSOFT, &microsoft).is_none());
    }
}
