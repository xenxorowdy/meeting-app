use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    env,
    process::ExitCode,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, MutexGuard, PoisonError,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bytes::Bytes;
use futures_util::{stream::SplitStream, Sink, SinkExt, Stream, StreamExt};
use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::{
    body::Incoming,
    header::{self, HeaderMap, HeaderValue},
    server::conn::http1,
    service::service_fn,
    upgrade::Upgraded,
    Method, Request, Response, StatusCode, Uri,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use kesami_core_backend::{env_compat, openai};
use reqwest::Url;
use serde_json::{json, Value};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{mpsc, watch},
    task::{JoinHandle, JoinSet},
    time::{sleep, timeout},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest,
        handshake::derive_accept_key,
        protocol::{Role, WebSocketConfig},
        Message,
    },
    MaybeTlsStream, WebSocketStream,
};

const MAX_STREAM: Duration = Duration::from_secs(2 * 60 * 60);
const MAX_AUDIO_BYTES: u64 = 16_000 * 2 * 60 * 60 * 2;
const MAX_DAILY_AUDIO_BYTES: u64 = MAX_AUDIO_BYTES * 4;
const MAX_BUFFERED_BYTES: usize = 1024 * 1024;
const MAX_PENDING_MESSAGES: usize = 100;
const MAX_CLIENT_MESSAGE: usize = 96 * 1024;
const MAX_AUDIO_CHARS: usize = 48_000;
const MAX_STREAMS: usize = 64;
const MAX_USER_STREAMS: usize = 2;
const MAX_AUTH_REQUESTS: usize = 64;
const MAX_AI_REQUESTS: usize = 16;
const MAX_AI_BODY: usize = 1024 * 1024;
const MAX_TEXT_PART: usize = 200_000;
const MAX_OUTPUT_TOKENS: f64 = 8192.0;
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const AUTH_TIMEOUT: Duration = Duration::from_secs(8);
const PROVIDER_HANDSHAKE: Duration = Duration::from_secs(10);
const AI_TIMEOUT: Duration = Duration::from_secs(180);
const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(10);
const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);
const DEFAULT_SARVAM_ENDPOINT: &str = "wss://api.sarvam.ai/speech-to-text-realtime/ws";
const DEFAULT_SARVAM_MODEL: &str = "saaras:v3-realtime";
const DEFAULT_SUMMARY_MODEL: &str = "gemini-2.5-flash";
const DEFAULT_DAILY_AI_LIMIT: u64 = 100;
const GEMINI_ORIGIN: &str = "https://generativelanguage.googleapis.com";
const GOOGLE_TOKEN_PATH: &str = "/v1/calendar/google/token";
const MAX_CALENDAR_BODY: usize = 16 * 1024;
const REALTIME_PATH: &str = "/v1/transcription/realtime";
const MODES: [&str; 5] = ["transcribe", "translate", "verbatim", "translit", "codemix"];
const AI_UNAVAILABLE: &str = "Meeting AI is unavailable. Try again.";

#[path = "../cloud_billing_server.rs"]
mod cloud_billing_server;

type Body = Full<Bytes>;
type ClientSocket = WebSocketStream<TokioIo<Upgraded>>;
type ProviderSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Clone)]
struct Config {
    auth_origin: Url,
    publishable_key: String,
    sarvam_key: String,
    sarvam_endpoint: Url,
    sarvam_model: String,
    gemini_key: Option<String>,
    gemini_origin: String,
    openai_key: Option<String>,
    openai_origin: String,
    openai_daily_budget_usd: f64,
    openai_usage_file: Option<std::path::PathBuf>,
    summary_model: String,
    daily_ai_limit: u64,
    google_calendar: Option<GoogleCalendarApp>,
}

#[derive(Clone)]
struct GoogleCalendarApp {
    client_id: String,
    client_secret: String,
    token_url: String,
}

impl GoogleCalendarApp {
    fn from_env(value: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let client_id = value("KESAMI_GOOGLE_CALENDAR_CLIENT_ID")?.trim().to_owned();
        let client_secret = value("KESAMI_GOOGLE_CALENDAR_CLIENT_SECRET")?.trim().to_owned();
        if client_id.is_empty() || client_secret.is_empty() { return None; }
        Some(Self { client_id, client_secret, token_url: "https://oauth2.googleapis.com/token".into() })
    }

    fn fields(&self, body: &Value) -> Option<Vec<(&'static str, String)>> {
        let object = body.as_object()?;
        let text = |key: &str, max: usize| -> Option<String> {
            let value = object.get(key)?.as_str()?;
            (!value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)).then(|| value.to_owned())
        };
        if text("client_id", 256)? != self.client_id { return None; }
        let grant = text("grant_type", 32)?;
        let mut fields = vec![("client_id", self.client_id.clone()), ("client_secret", self.client_secret.clone()), ("grant_type", grant.clone())];
        match grant.as_str() {
            "authorization_code" => {
                let verifier = text("code_verifier", 128)?;
                if verifier.len() < 43 || !verifier.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b)) { return None; }
                let redirect = text("redirect_uri", 256)?;
                let url = Url::parse(&redirect).ok()?;
                if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none_or(|port| port == 0)
                    || url.path() != "/" || !bare(&url) || url.query().is_some() { return None; }
                fields.extend([("code", text("code", 2048)?), ("code_verifier", verifier), ("redirect_uri", redirect)]);
            }
            "refresh_token" => fields.push(("refresh_token", text("refresh_token", 8192)?)),
            _ => return None,
        }
        Some(fields)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Upstream {
    Gemini,
    OpenAi,
}

#[derive(Debug)]
struct ConfigError;

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Kesami cloud relay needs a Supabase HTTPS origin, publishable key, and server-side Sarvam key.")
    }
}

impl Config {
    fn from_env(var: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let value = |name: &str| var(name).filter(|value| !value.is_empty());
        let auth_origin = value("KESAMI_SUPABASE_URL")
            .and_then(|raw| Url::parse(&raw).ok())
            .filter(|url| {
                url.scheme() == "https"
                    && url.path() == "/"
                    && bare(url)
                    && url.query().map_or(true, str::is_empty)
            })
            .ok_or(ConfigError)?;
        let publishable_key = value("KESAMI_SUPABASE_PUBLISHABLE_KEY")
            .filter(|key| {
                key.strip_prefix("sb_publishable_").is_some_and(|rest| {
                    !rest.is_empty()
                        && rest
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                })
            })
            .ok_or(ConfigError)?;
        let sarvam_key = value("KESAMI_SARVAM_API_KEY")
            .filter(|key| !key.trim().is_empty())
            .ok_or(ConfigError)?;
        let sarvam_endpoint = Url::parse(
            &value("KESAMI_SARVAM_REALTIME_URL").unwrap_or_else(|| DEFAULT_SARVAM_ENDPOINT.into()),
        )
        .ok()
        .filter(|url| url.scheme() == "wss" && bare(url))
        .ok_or(ConfigError)?;
        Ok(Self {
            auth_origin,
            publishable_key,
            sarvam_key,
            sarvam_endpoint,
            sarvam_model: value("KESAMI_SARVAM_REALTIME_MODEL")
                .unwrap_or_else(|| DEFAULT_SARVAM_MODEL.into()),
            gemini_key: value("KESAMI_GEMINI_API_KEY"),
            gemini_origin: GEMINI_ORIGIN.into(),
            openai_key: value("KESAMI_OPENAI_API_KEY").filter(|key| !key.trim().is_empty()),
            openai_origin: openai::ORIGIN.into(),
            openai_daily_budget_usd: openai::DailyBudget::cap_from(value("KESAMI_OPENAI_DAILY_BUDGET_USD")),
            openai_usage_file: value("KESAMI_OPENAI_USAGE_FILE").map(std::path::PathBuf::from),
            summary_model: value("KESAMI_SUMMARY_MODEL")
                .unwrap_or_else(|| DEFAULT_SUMMARY_MODEL.into()),
            google_calendar: GoogleCalendarApp::from_env(&value),
            daily_ai_limit: value("KESAMI_CLOUD_DAILY_AI_LIMIT")
                .and_then(|raw| positive_integer(&raw))
                .unwrap_or(DEFAULT_DAILY_AI_LIMIT),
        })
    }

}

fn bare(url: &Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.fragment().map_or(true, str::is_empty)
}

fn positive_integer(raw: &str) -> Option<u64> {
    raw.trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.fract() == 0.0 && *value > 0.0 && *value <= 9_007_199_254_740_991.0)
        .map(|value| value as u64)
}

fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

struct Unavailable;

#[derive(Default)]
struct Ledger {
    streams: usize,
    user_streams: HashMap<String, usize>,
    audio: HashMap<String, (String, u64)>,
    ai: HashMap<String, (String, u64)>,
    ai_active: HashSet<String>,
    calendar_requests: HashMap<String, (String, u64)>,
}

impl Ledger {
    fn audio_allowance(&mut self, user: &str, extra: u64) -> bool {
        let today = today();
        let used = self
            .audio
            .get(user)
            .filter(|(day, _)| *day == today)
            .map_or(0, |(_, bytes)| *bytes);
        if extra == 0 {
            return used < MAX_DAILY_AUDIO_BYTES;
        }
        if used + extra > MAX_DAILY_AUDIO_BYTES {
            return false;
        }
        self.audio.insert(user.to_owned(), (today, used + extra));
        true
    }
}

struct Relay {
    config: Config,
    http: reqwest::Client,
    stopping: AtomicBool,
    authenticating: AtomicUsize,
    calendar_active: AtomicUsize,
    ledger: Mutex<Ledger>,
    shutdown: watch::Sender<bool>,
    billing: cloud_billing_server::Billing,
    openai_budget: openai::DailyBudget,
}

struct InFlight<'a>(&'a AtomicUsize);

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct StreamSlot {
    relay: Arc<Relay>,
    user: String,
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        let mut ledger = self.relay.ledger();
        ledger.streams -= 1;
        if let Some(count) = ledger.user_streams.get_mut(&self.user) {
            *count -= 1;
            if *count == 0 {
                ledger.user_streams.remove(&self.user);
            }
        }
    }
}

struct AiSlot<'a> {
    relay: &'a Relay,
    user: String,
}

impl Drop for AiSlot<'_> {
    fn drop(&mut self) {
        self.relay.ledger().ai_active.remove(&self.user);
    }
}

enum Route {
    Health,
    Generate,
    Capabilities,
    GoogleCalendarToken,
    Missing,
}

impl Relay {
    fn new(config: Config) -> Arc<Self> {
        Self::with_billing(config, cloud_billing_server::Billing::from_env())
    }

    fn with_billing(config: Config, billing: cloud_billing_server::Billing) -> Arc<Self> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .expect("the HTTPS client uses only bundled TLS roots");
        let openai_budget =
            openai::DailyBudget::new(config.openai_daily_budget_usd, config.openai_usage_file.clone());
        Arc::new(Self {
            config,
            http,
            stopping: AtomicBool::new(false),
            authenticating: AtomicUsize::new(0),
            calendar_active: AtomicUsize::new(0),
            ledger: Mutex::default(),
            shutdown: watch::Sender::new(false),
            billing,
            openai_budget,
        })
    }

    fn ledger(&self) -> MutexGuard<'_, Ledger> {
        self.ledger.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    fn close(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.shutdown.send_replace(true);
    }

    fn forget_past_days(&self) {
        let today = today();
        let mut ledger = self.ledger();
        ledger.audio.retain(|_, (day, _)| *day == today);
        ledger.ai.retain(|_, (day, _)| *day == today);
        ledger.calendar_requests.retain(|_, (day, _)| *day == today);
    }

    async fn serve(self: Arc<Self>, listener: TcpListener) {
        let mut stopping = self.shutdown.subscribe();
        let mut connections = JoinSet::new();
        let mut sweep = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            tokio::select! {
                _ = stopped(&mut stopping) => break,
                _ = sweep.tick() => self.forget_past_days(),
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else {
                        sleep(Duration::from_millis(50)).await;
                        continue;
                    };
                    let relay = self.clone();
                    let mut stop = self.shutdown.subscribe();
                    connections.spawn(async move {
                        let service = service_fn(move |req| relay.clone().handle(req));
                        let connection = http1::Builder::new()
                            .timer(TokioTimer::new())
                            .header_read_timeout(HEADER_TIMEOUT)
                            .serve_connection(TokioIo::new(stream), service)
                            .with_upgrades();
                        tokio::pin!(connection);
                        tokio::select! {
                            _ = connection.as_mut() => {}
                            _ = stopped(&mut stop) => {
                                connection.as_mut().graceful_shutdown();
                                let _ = connection.await;
                            }
                        }
                    });
                    while connections.try_join_next().is_some() {}
                }
            }
        }
        drop(listener);
        while connections.join_next().await.is_some() {}
    }

    async fn handle(self: Arc<Self>, req: Request<Incoming>) -> Result<Response<Body>, Infallible> {
        if req.uri().query().is_none() && matches!((req.method(), req.uri().path()),
            (&Method::GET, "/v1/plans" | "/v1/billing/subscription") |
            (&Method::POST, "/v1/billing/checkout" | "/v1/billing/razorpay/sync" | "/v1/billing/razorpay/confirm" | "/v1/billing/webhook/razorpay" | "/v1/billing/webhook/stripe")) {
            return Ok(self.billing_request(req).await);
        }
        if wants_upgrade(req.headers()) {
            return Ok(self.upgrade(req).await);
        }
        let route = match (req.method(), req.uri().path(), req.uri().query()) {
            (&Method::GET, "/health", None) => Route::Health,
            (&Method::POST, GOOGLE_TOKEN_PATH, None) => Route::GoogleCalendarToken,
            (&Method::POST, "/v1/ai/generate", None) => Route::Generate,
            (&Method::GET, "/v1/capabilities", None) => Route::Capabilities,
            _ => Route::Missing,
        };
        Ok(match route {
            Route::Health if self.stopping() => json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "status": "stopping" }),
            ),
            Route::Health => json_response(StatusCode::OK, json!({ "status": "ok" })),
            Route::GoogleCalendarToken => self.google_calendar_token(req).await,
            Route::Generate => self.generate(req).await,
            Route::Capabilities => self.capabilities(req.headers()).await,
            Route::Missing => error(StatusCode::NOT_FOUND, "Not found"),
        })
    }


    async fn google_calendar_token(&self, req: Request<Incoming>) -> Response<Body> {
        // Limit simultaneous exchanges as well as daily requests for each authenticated user.
        if self.calendar_active.fetch_add(1, Ordering::SeqCst) >= 32 {
            self.calendar_active.fetch_sub(1, Ordering::SeqCst);
            return error(StatusCode::TOO_MANY_REQUESTS, "Calendar service is busy. Try again.");
        }
        let _active = InFlight(&self.calendar_active);
        let user = match self.identity(req.headers()).await {
            Ok(Some(user)) => user,
            Ok(None) => return error(StatusCode::UNAUTHORIZED, "Sign in with Google again to connect Calendar."),
            Err(_) => return error(StatusCode::SERVICE_UNAVAILABLE, "Sign-in service is unavailable. Try again."),
        };
        let Some(app) = &self.config.google_calendar else {
            return error(StatusCode::SERVICE_UNAVAILABLE, "Google Calendar is not configured on the Kesami server.");
        };
        {
            let mut ledger = self.ledger();
            let day = today();
            let entry = ledger.calendar_requests.entry(user).or_insert((day.clone(), 0));
            if entry.0 != day { *entry = (day, 0); }
            if entry.1 >= 500 { return error(StatusCode::TOO_MANY_REQUESTS, "Calendar request limit reached. Try again later."); }
            entry.1 += 1;
        }
        let bytes = match timeout(REQUEST_TIMEOUT, Limited::new(req.into_body(), MAX_CALENDAR_BODY).collect()).await {
            Ok(Ok(body)) => body.to_bytes(),
            _ => return error(StatusCode::BAD_REQUEST, "Invalid Calendar authorization request."),
        };
        let fields = serde_json::from_slice::<Value>(&bytes).ok().and_then(|body| app.fields(&body));
        let Some(fields) = fields else {
            return error(StatusCode::BAD_REQUEST, "Invalid Calendar authorization request or mismatched client ID.");
        };
        let response = match self.http.post(&app.token_url).form(&fields).timeout(REQUEST_TIMEOUT).send().await {
            Ok(response) => response,
            Err(_) => return error(StatusCode::SERVICE_UNAVAILABLE, "Google Calendar is unreachable. Try again."),
        };
        let status = response.status();
        let body = response.json::<Value>().await.unwrap_or(Value::Null);
        if !status.is_success() {
            if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS {
                return error(StatusCode::SERVICE_UNAVAILABLE, "Google Calendar is busy. Try again.");
            }
            let revoked = body["error"].as_str() == Some("invalid_grant");
            return json_response(StatusCode::BAD_REQUEST, json!({
                "error": if revoked { "invalid_grant" } else { "calendar_authorization_failed" },
                "error_description": if revoked { "Google Calendar access expired or was revoked. Reconnect Calendar." }
                    else { "Google Calendar authorization failed. Check the server OAuth configuration." }
            }));
        }
        if body["access_token"].as_str().is_none_or(str::is_empty) {
            return error(StatusCode::BAD_GATEWAY, "Google returned an invalid Calendar token response.");
        }
        // Return only the token fields the local backend stores; never echo server credentials.
        let mut granted = json!({});
        for key in ["access_token", "refresh_token", "expires_in", "id_token", "scope", "token_type"] {
            if let Some(value) = body.get(key) { granted[key] = value.clone(); }
        }
        json_response(StatusCode::OK, granted)
    }

    async fn identity(&self, headers: &HeaderMap) -> Result<Option<String>, Unavailable> {
        if self.stopping() || self.authenticating.load(Ordering::SeqCst) >= MAX_AUTH_REQUESTS {
            return Err(Unavailable);
        }
        let Some(token) = bearer_token(headers) else {
            return Ok(None);
        };
        self.authenticating.fetch_add(1, Ordering::SeqCst);
        let _in_flight = InFlight(&self.authenticating);
        let url = self
            .config
            .auth_origin
            .join("/auth/v1/user")
            .map_err(|_| Unavailable)?;
        let response = self
            .http
            .get(url)
            .header("apikey", &self.config.publishable_key)
            .bearer_auth(token)
            .timeout(AUTH_TIMEOUT)
            .send()
            .await
            .map_err(|_| Unavailable)?;
        if !response.status().is_success() {
            return Ok(None);
        }
        let user: Value = response.json().await.map_err(|_| Unavailable)?;
        Ok(verified_user(&user))
    }

    async fn capabilities(&self, headers: &HeaderMap) -> Response<Body> {
        match self.identity(headers).await {
            Err(Unavailable) => error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Sign-in service unavailable",
            ),
            Ok(None) => error(StatusCode::UNAUTHORIZED, "Sign in with Google again"),
            Ok(Some(user)) if !self.ledger().audio_allowance(&user, 0) => error(
                StatusCode::TOO_MANY_REQUESTS,
                "Daily transcription limit reached",
            ),
            Ok(Some(_)) => json_response(
                StatusCode::OK,
                json!({ "realtimeTranscription": true, "meetingAi": self.config.gemini_key.is_some() }),
            ),
        }
    }

    fn upstream_url(&self, uri: &Uri) -> Option<Url> {
        if uri.path() != REALTIME_PATH {
            return None;
        }
        let mut request = Url::parse("http://localhost/").ok()?;
        request.set_query(uri.query());
        let param = |name: &str| {
            request
                .query_pairs()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.into_owned())
                .filter(|value| !value.is_empty())
        };
        let language = param("language_code").unwrap_or_else(|| "auto".into());
        let mode = param("mode").unwrap_or_else(|| "transcribe".into());
        let valid = (2..=24).contains(&language.len())
            && language
                .bytes()
                .all(|b| b.is_ascii_alphabetic() || b == b'-')
            && MODES.contains(&mode.as_str())
            && param("encoding").as_deref() == Some("linear16")
            && param("sample_rate").as_deref() == Some("16000")
            && param("model").as_deref() == Some(self.config.sarvam_model.as_str());
        if !valid {
            return None;
        }
        let fields = [
            ("model", self.config.sarvam_model.as_str()),
            ("language_code", language.as_str()),
            ("mode", mode.as_str()),
            ("encoding", "linear16"),
            ("sample_rate", "16000"),
            ("return_timestamps", "true"),
        ];
        let mut url = self.config.sarvam_endpoint.clone();
        let kept: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(key, _)| !fields.iter().any(|(field, _)| field == key))
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        url.query_pairs_mut()
            .clear()
            .extend_pairs(kept)
            .extend_pairs(fields);
        Some(url)
    }

    fn reserve_stream(self: &Arc<Self>, user: &str) -> Result<StreamSlot, Response<Body>> {
        let mut ledger = self.ledger();
        if self.stopping() || ledger.streams >= MAX_STREAMS {
            return Err(rejection(
                StatusCode::SERVICE_UNAVAILABLE,
                "Transcription service busy",
            ));
        }
        if ledger.user_streams.get(user).copied().unwrap_or(0) >= MAX_USER_STREAMS {
            return Err(rejection(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many live transcription streams",
            ));
        }
        if !ledger.audio_allowance(user, 0) {
            return Err(rejection(
                StatusCode::TOO_MANY_REQUESTS,
                "Daily transcription limit reached",
            ));
        }
        ledger.streams += 1;
        *ledger.user_streams.entry(user.to_owned()).or_default() += 1;
        Ok(StreamSlot {
            relay: self.clone(),
            user: user.to_owned(),
        })
    }

    async fn upgrade(self: Arc<Self>, req: Request<Incoming>) -> Response<Body> {
        let Some(provider_url) = self.upstream_url(req.uri()) else {
            return rejection(StatusCode::BAD_REQUEST, "Invalid transcription request");
        };
        let user = match self.identity(req.headers()).await {
            Err(Unavailable) => {
                return rejection(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Sign-in service unavailable",
                )
            }
            Ok(None) => return rejection(StatusCode::UNAUTHORIZED, "Sign in with Google again"),
            Ok(Some(user)) => user,
        };
        let slot = match self.reserve_stream(&user) {
            Ok(slot) => slot,
            Err(response) => return response,
        };
        let Some(accept) = handshake_accept(&req) else {
            return rejection(StatusCode::BAD_REQUEST, "Invalid transcription request");
        };
        tokio::spawn(async move {
            let Ok(upgraded) = hyper::upgrade::on(req).await else {
                return;
            };
            let client = WebSocketStream::from_raw_socket(
                TokioIo::new(upgraded),
                Role::Server,
                Some(socket_config(MAX_CLIENT_MESSAGE)),
            )
            .await;
            relay_stream(slot, client, provider_url).await;
        });
        let mut response = Response::new(Body::default());
        *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        let headers = response.headers_mut();
        headers.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        headers.insert(header::SEC_WEBSOCKET_ACCEPT, accept);
        response
    }

    fn reserve_ai(&self, user: &str) -> Option<AiSlot<'_>> {
        let today = today();
        let mut ledger = self.ledger();
        ledger.ai.retain(|_, (day, _)| *day == today);
        ledger.calendar_requests.retain(|_, (day, _)| *day == today);
        let used = ledger.ai.get(user).map_or(0, |(_, count)| *count);
        if ledger.ai_active.contains(user)
            || used >= self.config.daily_ai_limit
            || ledger.ai_active.len() >= MAX_AI_REQUESTS
        {
            return None;
        }
        ledger.ai_active.insert(user.to_owned());
        Some(AiSlot {
            relay: self,
            user: user.to_owned(),
        })
    }

    fn count_ai_use(&self, user: &str) {
        let today = today();
        let mut ledger = self.ledger();
        let entry = ledger
            .ai
            .entry(user.to_owned())
            .or_insert_with(|| (today.clone(), 0));
        if entry.0 != today {
            *entry = (today, 0);
        }
        entry.1 += 1;
    }

    async fn generate(&self, req: Request<Incoming>) -> Response<Body> {
        let user = match self.identity(req.headers()).await {
            Err(Unavailable) => {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Sign-in service unavailable. Try again.",
                )
            }
            Ok(None) => return error(StatusCode::UNAUTHORIZED, "Sign in with Google again."),
            Ok(Some(user)) => user,
        };
        let Some(key) = self.config.gemini_key.as_deref() else {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Meeting AI is unavailable. Contact Kesami support.",
            );
        };
        let Some(_slot) = self.reserve_ai(&user) else {
            return error(
                StatusCode::TOO_MANY_REQUESTS,
                "Meeting AI limit reached. Try again later.",
            );
        };
        let body = match timeout(
            REQUEST_TIMEOUT,
            Limited::new(req.into_body(), MAX_AI_BODY).collect(),
        )
        .await
        {
            Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "Meeting AI request timed out."),
            Ok(Err(failure)) if failure.downcast_ref::<LengthLimitError>().is_some() => {
                return error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Meeting AI request is too large.",
                )
            }
            Ok(Err(_)) => return error(StatusCode::SERVICE_UNAVAILABLE, AI_UNAVAILABLE),
            Ok(Ok(collected)) => collected.to_bytes(),
        };
        let Some(payload) = serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|body| gemini_payload(&body, &self.config.summary_model))
        else {
            return error(StatusCode::BAD_REQUEST, "Invalid meeting AI request.");
        };
        self.count_ai_use(&user);
        let url = format!(
            "{}/v1beta/models/{}:generateContent",
            self.config.gemini_origin,
            encode_component(&self.config.summary_model)
        );
        let mut upstream = Upstream::Gemini;
        let mut sent = self
            .http
            .post(url)
            .header("x-goog-api-key", key)
            .json(&payload)
            .timeout(AI_TIMEOUT)
            .send()
            .await;
        if sent.as_ref().is_ok_and(|response| response.status() == StatusCode::TOO_MANY_REQUESTS) {
            if let Some(openai_key) = self.config.openai_key.as_deref() {
                if self.openai_budget.check().await.is_ok() {
                    upstream = Upstream::OpenAi;
                    sent = self
                        .http
                        .post(format!("{}/v1/chat/completions", self.config.openai_origin))
                        .bearer_auth(openai_key)
                        .json(&openai_payload(&payload, openai::DEFAULT_MODEL))
                        .timeout(AI_TIMEOUT)
                        .send()
                        .await;
                }
            }
        }
        let Ok(response) = sent else {
            return error(StatusCode::SERVICE_UNAVAILABLE, AI_UNAVAILABLE);
        };
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            return error(
                StatusCode::TOO_MANY_REQUESTS,
                "Meeting AI is busy. Try again later.",
            );
        }
        if !response.status().is_success() {
            return error(StatusCode::SERVICE_UNAVAILABLE, AI_UNAVAILABLE);
        }
        let result = response.json::<Value>().await.ok();
        if let (Upstream::OpenAi, Some(result)) = (upstream, &result) {
            self.openai_budget.record(openai::DEFAULT_MODEL, result).await;
        }
        match result
            .and_then(|result| match upstream {
                Upstream::Gemini => generated_content(&result),
                Upstream::OpenAi => openai_content(&result),
            })
        {
            Some(content) => json_response(StatusCode::OK, content),
            None => error(StatusCode::SERVICE_UNAVAILABLE, AI_UNAVAILABLE),
        }
    }
}

fn wants_upgrade(headers: &HeaderMap) -> bool {
    headers.contains_key(header::UPGRADE)
        && headers
            .get_all(header::CONNECTION)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
}

fn handshake_accept(req: &Request<Incoming>) -> Option<HeaderValue> {
    let headers = req.headers();
    let header = |name| {
        headers
            .get(name)
            .and_then(|value: &HeaderValue| value.to_str().ok())
            .map(str::trim)
    };
    let valid = req.method() == Method::GET
        && header(header::UPGRADE).is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
        && matches!(header(header::SEC_WEBSOCKET_VERSION), Some("13" | "8"));
    let key = header(header::SEC_WEBSOCKET_KEY).filter(|_| valid)?;
    let decoded = BASE64.decode(key).ok()?;
    (decoded.len() == 16).then(|| HeaderValue::from_str(&derive_accept_key(key.as_bytes())).ok())?
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let token = headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")?;
    let usable = !token.is_empty()
        && token.len() <= 16_384
        && !token.bytes().any(|b| b.is_ascii_whitespace() || b == 0x0b);
    usable.then_some(token)
}

fn verified_user(user: &Value) -> Option<String> {
    let id = user.get("id")?.as_str()?;
    let groups: Vec<&str> = id.split('-').collect();
    let uuid = groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()));
    (uuid && user.get("is_anonymous") == Some(&Value::Bool(false))).then(|| id.to_owned())
}

fn base64_len(audio: &str) -> Option<u64> {
    let len = audio.len();
    if len == 0 || len > MAX_AUDIO_CHARS || len % 4 != 0 {
        return None;
    }
    let padding = audio.bytes().rev().take_while(|b| *b == b'=').count();
    let alphabet = |b: u8| b.is_ascii_alphanumeric() || b == b'+' || b == b'/';
    (padding <= 2
        && audio.as_bytes()[..len - padding]
            .iter()
            .all(|b| alphabet(*b)))
    .then(|| (len / 4 * 3 - padding) as u64)
}

fn client_payload(text: &str, relay: &Relay, user: &str, streamed: &mut u64) -> Option<String> {
    let Value::Object(event) = serde_json::from_str::<Value>(text).ok()? else {
        return None;
    };
    match event.get("event")?.as_str()? {
        "audio_input" => {
            let audio = event.get("audio")?.as_str()?;
            let bytes = base64_len(audio)?;
            *streamed += bytes;
            let accepted = bytes % 2 == 0
                && *streamed <= MAX_AUDIO_BYTES
                && relay.ledger().audio_allowance(user, bytes);
            accepted.then(|| json!({ "event": "audio_input", "audio": audio }).to_string())
        }
        kind @ ("end" | "ping") => Some(json!({ "event": kind }).to_string()),
        _ => None,
    }
}

fn socket_config(limit: usize) -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(limit))
        .max_frame_size(Some(limit))
}

async fn connect_provider(url: Url, key: String) -> Result<ProviderSocket, ()> {
    let mut request = url.as_str().into_client_request().map_err(|_| ())?;
    request.headers_mut().insert(
        "api-subscription-key",
        HeaderValue::from_str(&key).map_err(|_| ())?,
    );
    let connecting =
        connect_async_with_config(request, Some(socket_config(MAX_BUFFERED_BYTES)), true);
    let (socket, _) = timeout(PROVIDER_HANDSHAKE, connecting)
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    Ok(socket)
}

struct Outbox {
    messages: mpsc::UnboundedSender<String>,
    queued: Arc<AtomicUsize>,
    writer: JoinHandle<()>,
}

impl Outbox {
    fn spawn<S>(mut sink: S) -> Self
    where
        S: Sink<Message> + Unpin + Send + 'static,
    {
        let (messages, mut receiver) = mpsc::unbounded_channel::<String>();
        let queued = Arc::new(AtomicUsize::new(0));
        let written = queued.clone();
        let writer = tokio::spawn(async move {
            while let Some(text) = receiver.recv().await {
                let size = text.len();
                let delivered = sink.send(Message::text(text)).await.is_ok();
                written.fetch_sub(size, Ordering::SeqCst);
                if !delivered {
                    break;
                }
            }
        });
        Self {
            messages,
            queued,
            writer,
        }
    }

    fn push(&self, text: String) -> bool {
        let size = text.len();
        if self.queued.load(Ordering::SeqCst) + size > MAX_BUFFERED_BYTES {
            return false;
        }
        self.queued.fetch_add(size, Ordering::SeqCst);
        self.messages.send(text).is_ok()
    }
}

impl Drop for Outbox {
    fn drop(&mut self) {
        self.writer.abort();
    }
}

async fn stopped(signal: &mut watch::Receiver<bool>) {
    let _ = signal.wait_for(|stop| *stop).await;
}

async fn next_message<S: Stream + Unpin>(provider: &mut Option<(Outbox, S)>) -> Option<S::Item> {
    match provider {
        Some((_, stream)) => stream.next().await,
        None => std::future::pending().await,
    }
}

async fn relay_stream(slot: StreamSlot, client: ClientSocket, provider_url: Url) {
    let relay = slot.relay.clone();
    let mut stopping = relay.shutdown.subscribe();
    let (client_sink, mut client_rx) = client.split();
    let client_out = Outbox::spawn(client_sink);
    let connect = connect_provider(provider_url, relay.config.sarvam_key.clone());
    let deadline = sleep(MAX_STREAM);
    tokio::pin!(connect, deadline);
    let mut provider: Option<(Outbox, SplitStream<ProviderSocket>)> = None;
    let mut pending: Vec<String> = Vec::new();
    let mut pending_bytes = 0;
    let mut streamed = 0;
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            _ = stopped(&mut stopping) => break,
            connected = &mut connect, if provider.is_none() => {
                let Ok(socket) = connected else { break };
                let (sink, stream) = socket.split();
                let outbox = Outbox::spawn(sink);
                if !pending.drain(..).all(|message| outbox.push(message)) {
                    break;
                }
                pending_bytes = 0;
                provider = Some((outbox, stream));
            }
            message = client_rx.next() => {
                let text = match message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                    _ => break,
                };
                let Some(payload) = client_payload(text.as_str(), &relay, &slot.user, &mut streamed) else { break };
                match &provider {
                    Some((outbox, _)) => {
                        if !outbox.push(payload) {
                            break;
                        }
                    }
                    None if pending.len() < MAX_PENDING_MESSAGES && pending_bytes + payload.len() <= MAX_BUFFERED_BYTES => {
                        pending_bytes += payload.len();
                        pending.push(payload);
                    }
                    None => break,
                }
            }
            message = next_message(&mut provider) => match message {
                Some(Ok(Message::Text(text))) => {
                    if !client_out.push(text.as_str().to_owned()) {
                        break;
                    }
                }
                Some(Ok(_)) => {}
                _ => break,
            }
        }
    }
    drop(slot);
    drop(provider);
    drop(client_out);
    drop(client_rx);
}

fn text_parts(parts: Option<&Value>) -> Option<&Value> {
    let list = parts?.as_array()?;
    let valid = !list.is_empty()
        && list.len() <= 8
        && list.iter().all(|part| {
            part.as_object().is_some_and(|fields| {
                fields.len() == 1
                    && fields
                        .get("text")
                        .and_then(Value::as_str)
                        .is_some_and(|text| text.encode_utf16().count() <= MAX_TEXT_PART)
            })
        });
    valid.then_some(parts?)
}

fn gemini_payload(body: &Value, model: &str) -> Option<Value> {
    let contents = body.get("contents")?.as_array()?;
    let [turn] = contents.as_slice() else {
        return None;
    };
    if turn.get("role")?.as_str()? != "user" {
        return None;
    }
    let parts = text_parts(turn.get("parts"))?;
    let system = text_parts(
        body.get("systemInstruction")
            .and_then(|instruction| instruction.get("parts")),
    )?;
    let config = body.get("generationConfig")?;
    if config.get("responseMimeType")?.as_str()? != "application/json" {
        return None;
    }
    let schema = config
        .get("responseSchema")
        .filter(|schema| schema.is_object())?;
    let max_output_tokens = config
        .get("maxOutputTokens")
        .and_then(Value::as_f64)
        .filter(|tokens| tokens.fract() == 0.0)
        .map_or(MAX_OUTPUT_TOKENS, |tokens| {
            tokens.clamp(1.0, MAX_OUTPUT_TOKENS)
        }) as i64;
    let mut generation = json!({
        "responseMimeType": "application/json",
        "responseSchema": schema,
        "maxOutputTokens": max_output_tokens,
    });
    if !model.to_lowercase().contains("pro") {
        generation["thinkingConfig"] = json!({ "thinkingBudget": 0 });
    }
    Some(json!({
        "systemInstruction": { "parts": system },
        "contents": [{ "role": "user", "parts": parts }],
        "generationConfig": generation,
    }))
}

fn openai_payload(payload: &Value, model: &str) -> Value {
    let text = |parts: &Value| {
        parts
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<String>()
    };
    let config = &payload["generationConfig"];
    openai::chat_request(
        model,
        &text(&payload["systemInstruction"]["parts"]),
        &text(&payload["contents"][0]["parts"]),
        &config["responseSchema"],
        config["maxOutputTokens"].as_i64(),
    )
}

fn openai_content(result: &Value) -> Option<Value> {
    let reply = openai::reply(result)?;
    let (parts, finish) = match reply.refusal {
        Some(_) => (json!([]), "SAFETY".to_owned()),
        None => (
            json!([{ "text": reply.text }]),
            match reply.finish_reason.as_str() {
                "stop" => "STOP".to_owned(),
                "length" => "MAX_TOKENS".to_owned(),
                "content_filter" => "SAFETY".to_owned(),
                other => other.to_ascii_uppercase(),
            },
        ),
    };
    Some(json!({ "candidates": [{ "content": { "parts": parts }, "finishReason": finish }] }))
}

fn generated_content(result: &Value) -> Option<Value> {
    if !result.is_object() {
        return None;
    }
    let candidates = match result.get("candidates") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(list)) => list
            .iter()
            .take(1)
            .map(generated_candidate)
            .collect::<Option<Vec<_>>>()?,
        Some(_) => return None,
    };
    Some(json!({ "candidates": candidates }))
}

fn generated_candidate(candidate: &Value) -> Option<Value> {
    if candidate.is_null() {
        return None;
    }
    let parts: Vec<Value> = match candidate
        .get("content")
        .and_then(|content| content.get("parts"))
    {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .map(|text| json!({ "text": text }))
            .collect(),
        Some(_) => return None,
    };
    let mut generated = json!({ "content": { "parts": parts } });
    if let Some(reason) = candidate.get("finishReason") {
        generated["finishReason"] = reason.clone();
    }
    Some(generated)
}

fn encode_component(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn json_response(status: StatusCode, body: Value) -> Response<Body> {
    let mut response = Response::new(Body::new(Bytes::from(body.to_string())));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn error(status: StatusCode, message: &str) -> Response<Body> {
    json_response(status, json!({ "error": message }))
}

fn rejection(status: StatusCode, message: &str) -> Response<Body> {
    let mut response = error(status, message);
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
    response
}

async fn stop_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

#[tokio::main]
async fn main() -> ExitCode {
    let Ok(config) = Config::from_env(|name| env_compat::var(name).ok()) else {
        eprintln!("Cannot start Kesami cloud relay: check the HTTPS origins, Supabase publishable key and server-side Sarvam key.");
        return ExitCode::FAILURE;
    };
    let host = env::var("HOST")
        .ok()
        .filter(|host| !host.is_empty())
        .unwrap_or_else(|| "127.0.0.1".into());
    let Some(port) = env::var("PORT")
        .ok()
        .filter(|port| !port.is_empty())
        .map_or(Some(48901), |port| port.parse::<u16>().ok())
    else {
        eprintln!("Cannot start Kesami cloud relay: PORT must be a TCP port number.");
        return ExitCode::FAILURE;
    };
    let listener = match TcpListener::bind((host.as_str(), port)).await {
        Ok(listener) => listener,
        Err(failure) => {
            eprintln!("Cannot start Kesami cloud relay on {host}:{port}: {failure}");
            return ExitCode::FAILURE;
        }
    };
    println!("Kesami cloud relay listening on {host}:{port}");
    let relay = Relay::new(config);
    let server = tokio::spawn(relay.clone().serve(listener));
    stop_signal().await;
    relay.close();
    match timeout(SHUTDOWN_DEADLINE, server).await {
        Ok(_) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        sync::oneshot,
    };
    use tokio_tungstenite::{accept_hdr_async, connect_async, tungstenite};

    const ROUTE: &str =
        "/v1/transcription/realtime?model=saaras%3Av3-realtime&encoding=linear16&sample_rate=16000";
    const USER: &str = r#"{"id":"12345678-1234-1234-1234-123456789012","is_anonymous":false}"#;
    const GENERATED: &str = r#"{"candidates":[{"content":{"parts":[{"text":"{\"answer\":\"Ship Friday\"}"}]},"finishReason":"STOP"}]}"#;
    const WAIT: Duration = Duration::from_secs(5);

    #[tokio::test]
    #[ignore = "needs KESAMI_DISPOSABLE_POSTGRES_URL"]
    async fn hosted_payment_confirms_pro_in_postgres_and_survives_retries_and_restarts() {
        use kesami_core_backend::{billing::{ProviderConfig, tier_for}, billing_db};
        use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
        use hmac::{Hmac, Mac};
        use sha2::Sha256;
        let options: PgConnectOptions = env::var("KESAMI_DISPOSABLE_POSTGRES_URL").unwrap().parse().unwrap();
        assert!(matches!(options.get_host(), "localhost"|"127.0.0.1") || options.get_host().starts_with('/'), "test requires a local disposable database");
        let admin = PgPoolOptions::new().connect_with(options.clone()).await.unwrap();
        let name = format!("kesami_payment_{}",uuid::Uuid::new_v4().simple());
        sqlx::raw_sql(&format!("CREATE DATABASE {name}")).execute(&admin).await.unwrap();
        let pool = PgPoolOptions::new().connect_with(options.database(&name)).await.unwrap();
        sqlx::raw_sql("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$;
            CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text);
            CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
            INSERT INTO auth.users VALUES ('12345678-1234-1234-1234-123456789012','payer@example.com');")
            .execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/002_supabase_billing.sql")).execute(&pool).await.unwrap();
        let snapshot = Arc::new(Mutex::new(json!({"id":"sub_Payer","status":"created","plan_id":"plan_Test","notes":{"accountId":"12345678-1234-1234-1234-123456789012"},"current_end":2_000_000_000i64})));
        let provider_snapshot = snapshot.clone();
        let (provider, log) = fake_http(Arc::new(move |_| (StatusCode::OK,provider_snapshot.lock().unwrap().to_string()))).await;
        let billing = cloud_billing_server::Billing {
            config:ProviderConfig { razorpay_key_id:Some("rzp_test_public".into()),razorpay_key_secret:Some("secret".into()),razorpay_webhook_secret:Some("secret".into()),razorpay_plan_inr:Some("plan_Test".into()),razorpay_api:Some(provider),..Default::default() },
            pool:Some(pool.clone()),checkout_lock:tokio::sync::Mutex::new(()),
        };
        let app = Fixture::with_billing(signed_in(),gemini_ok(), |_| {},Some(billing)).await;
        let post = |path: &str, body: Value| app.http.post(app.url(path)).bearer_auth("valid-session").json(&body).send();
        let read = || app.http.get(app.url("/v1/billing/subscription")).bearer_auth("valid-session").send();
        let user = "12345678-1234-1234-1234-123456789012";
        let catalog: Value = app.http.get(app.url("/v1/plans")).send().await.unwrap().json().await.unwrap();
        assert_eq!(catalog["billing"]["razorpay"],true);
        assert!(!catalog.to_string().contains("secret"));
        assert_eq!(read().await.unwrap().json::<Value>().await.unwrap()["tier"],"free");
        let checkout = post("/v1/billing/checkout",json!({"plan":"pro","currency":"INR","accountId":"someone-else"})).await.unwrap();
        assert_eq!(checkout.status(),200);
        let checkout: Value = checkout.json().await.unwrap();
        assert_eq!(checkout["subscriptionId"],"sub_Payer");
        assert_eq!(billing_db::subscription(&pool,user).await.unwrap().unwrap().status,"incomplete");
        assert_eq!(post("/v1/billing/checkout",json!({"plan":"pro","currency":"INR"})).await.unwrap().status(),200);
        assert_eq!(log.all().iter().filter(|request| !request.body.is_empty()).count(),1,"reopening checkout reuses the subscription");
        let sign = |message: &[u8]| {
            let mut mac = Hmac::<Sha256>::new_from_slice(b"secret").unwrap(); mac.update(message);
            mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect::<String>()
        };
        let mut confirmation = json!({"subscriptionId":"sub_Payer","paymentId":"pay_Payer","signature":"forged"});
        assert_eq!(post("/v1/billing/razorpay/confirm",confirmation.clone()).await.unwrap().status(),400);
        confirmation["signature"]=json!(sign(b"pay_Payer|sub_Payer"));
        snapshot.lock().unwrap()["status"]=json!("active");
        let activated: Value = post("/v1/billing/razorpay/confirm",confirmation.clone()).await.unwrap().json().await.unwrap();
        assert_eq!(activated["tier"],"pro"); assert_eq!(activated["accountSynced"],true);
        assert_eq!(tier_for(billing_db::subscription(&pool,user).await.unwrap().as_ref()),"pro");
        assert_eq!(post("/v1/billing/razorpay/confirm",confirmation).await.unwrap().status(),200);
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM public.billing_events").fetch_one(&pool).await.unwrap(); assert_eq!(count,1);
        assert_eq!(post("/v1/billing/checkout",json!({"plan":"pro","currency":"INR"})).await.unwrap().status(),409);
        assert_eq!(post("/v1/billing/razorpay/sync",json!({"subscriptionId":"sub_Other"})).await.unwrap().status(),404);
        snapshot.lock().unwrap()["notes"]["accountId"]=json!("legacy-local-account");
        let restored: Value = post("/v1/billing/razorpay/sync",json!({"subscriptionId":"sub_Payer"})).await.unwrap().json().await.unwrap();
        assert_eq!(restored["tier"],"pro","persisted ownership survives migration from a local checkout");
        assert_eq!(app.http.get(app.url("/v1/billing/subscription")).bearer_auth("wrong-session").send().await.unwrap().status(),401);
        let webhook = |id: &str, event: Value| {
            let raw = event.to_string();
            app.http.post(app.url("/v1/billing/webhook/razorpay")).header("x-razorpay-event-id",id)
                .header("x-razorpay-signature",sign(raw.as_bytes())).body(raw).send()
        };
        snapshot.lock().unwrap()["current_end"]=json!(2_100_000_000i64);
        let event = json!({"event":"subscription.charged","payload":{"subscription":{"entity":{"id":"sub_Payer","status":"active"}}}});
        assert_eq!(webhook("evt_renewal",event.clone()).await.unwrap().status(),200);
        assert_eq!(billing_db::subscription(&pool,user).await.unwrap().unwrap().current_period_end,Some(2_100_000_000_000));
        sqlx::raw_sql("ALTER TABLE public.billing RENAME TO billing_offline").execute(&pool).await.unwrap();
        assert_eq!(webhook("evt_outage",event.clone()).await.unwrap().status(),503);
        let failed_recorded: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM public.billing_events WHERE event_id='evt_outage')").fetch_one(&pool).await.unwrap(); assert!(!failed_recorded);
        sqlx::raw_sql("ALTER TABLE public.billing_offline RENAME TO billing").execute(&pool).await.unwrap();
        assert_eq!(webhook("evt_outage",event.clone()).await.unwrap().status(),200);
        snapshot.lock().unwrap()["status"]=json!("cancelled");
        assert_eq!(webhook("evt_cancel",event.clone()).await.unwrap().status(),200);
        assert_eq!(read().await.unwrap().json::<Value>().await.unwrap()["tier"],"free");
        assert_eq!(webhook("evt_late_charge",event).await.unwrap().status(),200);
        assert_eq!(billing_db::subscription(&pool,user).await.unwrap().unwrap().status,"canceled");
        // A new connection sees the plan; no process-local cache is authoritative.
        let fresh = PgPoolOptions::new().connect_with(pool.connect_options().as_ref().clone()).await.unwrap();
        assert_eq!(billing_db::subscription(&fresh,user).await.unwrap().unwrap().status,"canceled");
        fresh.close().await;
        drop(app); pool.close().await;
        sqlx::raw_sql(&format!("DROP DATABASE {name} WITH (FORCE)")).execute(&admin).await.unwrap();
        admin.close().await;
    }

    type Responder = Arc<dyn Fn(&Seen) -> (StatusCode, String) + Send + Sync>;
    type TestSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

    #[derive(Clone)]
    struct Seen {
        uri: Uri,
        headers: HeaderMap,
        body: Bytes,
    }

    #[derive(Clone, Default)]
    struct Log(Arc<Mutex<Vec<Seen>>>);

    impl Log {
        fn all(&self) -> Vec<Seen> {
            self.0.lock().unwrap().clone()
        }
    }

    async fn fake_http(respond: Responder) -> (String, Log) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let log = Log::default();
        let seen = log.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let respond = respond.clone();
                let seen = seen.clone();
                let service = service_fn(move |req: Request<Incoming>| {
                    let respond = respond.clone();
                    let seen = seen.clone();
                    async move {
                        let (parts, body) = req.into_parts();
                        let body = body
                            .collect()
                            .await
                            .map(|body| body.to_bytes())
                            .unwrap_or_default();
                        let request = Seen {
                            uri: parts.uri,
                            headers: parts.headers,
                            body,
                        };
                        let (status, text) = respond(&request);
                        seen.0.lock().unwrap().push(request);
                        let mut response = Response::new(Body::new(Bytes::from(text)));
                        *response.status_mut() = status;
                        Ok::<_, Infallible>(response)
                    }
                });
                tokio::spawn(http1::Builder::new().serve_connection(TokioIo::new(stream), service));
            }
        });
        (origin, log)
    }

    struct Provider {
        uri: String,
        headers: HeaderMap,
        received: mpsc::UnboundedReceiver<String>,
        reply: mpsc::UnboundedSender<String>,
        hang_up: Option<oneshot::Sender<()>>,
    }

    struct Sarvam {
        url: String,
        connections: mpsc::UnboundedReceiver<Provider>,
        stall: Arc<AtomicBool>,
    }

    async fn fake_sarvam() -> Sarvam {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/ws", listener.local_addr().unwrap());
        let (found, connections) = mpsc::unbounded_channel();
        let stall = Arc::new(AtomicBool::new(false));
        let stalled = stall.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (seen, request) = oneshot::channel();
                let callback = move |req: &tungstenite::handshake::server::Request, response| {
                    let _ = seen.send((req.uri().to_string(), req.headers().clone()));
                    Ok(response)
                };
                let Ok(mut socket) = accept_hdr_async(stream, callback).await else {
                    continue;
                };
                let (uri, headers) = request.await.unwrap();
                let (received_tx, received) = mpsc::unbounded_channel();
                let (reply, mut replies) = mpsc::unbounded_channel::<String>();
                let (hang_up, mut hung_up) = oneshot::channel::<()>();
                let stalled = stalled.load(Ordering::SeqCst);
                tokio::spawn(async move {
                    if stalled {
                        let _held = (socket, received_tx, hung_up);
                        std::future::pending::<()>().await;
                        return;
                    }
                    loop {
                        tokio::select! {
                            _ = &mut hung_up => break,
                            Some(text) = replies.recv() => {
                                if socket.send(Message::text(text)).await.is_err() {
                                    break;
                                }
                            }
                            message = socket.next() => match message {
                                Some(Ok(Message::Text(text))) => {
                                    let _ = received_tx.send(text.as_str().to_owned());
                                }
                                Some(Ok(_)) => {}
                                _ => break,
                            }
                        }
                    }
                });
                let _ = found.send(Provider {
                    uri,
                    headers,
                    received,
                    reply,
                    hang_up: Some(hang_up),
                });
            }
        });
        Sarvam {
            url,
            connections,
            stall,
        }
    }

    fn signed_in() -> Responder {
        Arc::new(|seen: &Seen| {
            if seen
                .headers
                .get("authorization")
                .is_some_and(|value| value == "Bearer valid-session")
            {
                (StatusCode::OK, USER.into())
            } else {
                (StatusCode::UNAUTHORIZED, "{}".into())
            }
        })
    }

    fn gemini_ok() -> Responder {
        Arc::new(|_: &Seen| {
            let mut generated: Value = serde_json::from_str(GENERATED).unwrap();
            generated["diagnostics"] = json!("private-provider-info");
            (StatusCode::OK, generated.to_string())
        })
    }

    fn openai_ok() -> Responder {
        Arc::new(|_: &Seen| {
            let completion = json!({
                "id": "private-provider-info",
                "choices": [{
                    "message": { "role": "assistant", "content": "{\"answer\":\"Ship Friday\"}", "refusal": null },
                    "finish_reason": "stop"
                }],
                "usage": { "prompt_tokens": 10_000, "completion_tokens": 2_000, "total_tokens": 12_000 }
            });
            (StatusCode::OK, completion.to_string())
        })
    }

    fn with_openai(config: &mut Config) {
        config.openai_key = Some("server-openai-key".into());
    }

    fn gemini_exhausted_then(openai: Responder) -> Responder {
        Arc::new(move |seen: &Seen| {
            if seen.uri.path().starts_with("/v1beta/") {
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}"#.to_owned(),
                )
            } else {
                openai(seen)
            }
        })
    }

    fn test_config(supabase: &str, sarvam: &str, gemini: &str) -> Config {
        Config {
            auth_origin: Url::parse(supabase).unwrap(),
            publishable_key: "sb_publishable_test".into(),
            sarvam_key: "private-provider-key".into(),
            sarvam_endpoint: Url::parse(sarvam).unwrap(),
            sarvam_model: DEFAULT_SARVAM_MODEL.into(),
            gemini_key: Some("server-provider-key".into()),
            gemini_origin: gemini.into(),
            openai_key: None,
            openai_origin: gemini.into(),
            openai_daily_budget_usd: openai::DEFAULT_DAILY_BUDGET_USD,
            openai_usage_file: None,
            summary_model: DEFAULT_SUMMARY_MODEL.into(),
            daily_ai_limit: DEFAULT_DAILY_AI_LIMIT,
            google_calendar: None,
        }
    }


    fn calendar_request() -> Value {
        json!({"client_id": "desktop.apps.googleusercontent.com", "grant_type": "authorization_code",
            "code": "one-time-code", "code_verifier": "v".repeat(43), "redirect_uri": "http://127.0.0.1:12345"})
    }

    #[tokio::test]
    async fn calendar_exchange_and_refresh_use_server_secret_and_preserve_revocation() {
        let responder: Responder = Arc::new(|seen: &Seen| {
            let fields: HashMap<_, _> = {
                let mut url = Url::parse("http://localhost").unwrap();
                url.set_query(std::str::from_utf8(&seen.body).ok());
                url.query_pairs().into_owned().collect()
            };
            assert_eq!(fields["client_secret"], "server-only-secret");
            assert_eq!(fields["client_id"], "desktop.apps.googleusercontent.com");
            if fields.get("refresh_token").is_some_and(|value| value == "revoked") {
                return (StatusCode::BAD_REQUEST, json!({"error":"invalid_grant", "error_description":"private detail"}).to_string());
            }
            (StatusCode::OK, json!({"access_token":"calendar-access", "refresh_token":"calendar-refresh",
                "expires_in":3600, "client_secret":"must-not-escape", "diagnostics":"private"}).to_string())
        });
        let (origin, log) = fake_http(responder).await;
        let app = Fixture::with(signed_in(), gemini_ok(), |config| {
            config.google_calendar = Some(GoogleCalendarApp {client_id:"desktop.apps.googleusercontent.com".into(),
                client_secret:"server-only-secret".into(), token_url:origin});
        }).await;
        let post = |body| app.http.post(app.url(GOOGLE_TOKEN_PATH)).bearer_auth("valid-session").json(&body).send();
        let exchange = post(calendar_request()).await.unwrap();
        assert_eq!(exchange.status(), StatusCode::OK);
        let granted: Value = exchange.json().await.unwrap();
        assert_eq!(granted["access_token"], "calendar-access");
        assert!(granted.get("client_secret").is_none());
        assert!(granted.get("diagnostics").is_none());
        let refresh = json!({"client_id":"desktop.apps.googleusercontent.com", "grant_type":"refresh_token", "refresh_token":"calendar-refresh"});
        assert_eq!(post(refresh.clone()).await.unwrap().status(), StatusCode::OK);
        let mut revoked = refresh; revoked["refresh_token"] = json!("revoked");
        let rejection = post(revoked).await.unwrap();
        assert_eq!(rejection.status(), StatusCode::BAD_REQUEST);
        assert_eq!(rejection.json::<Value>().await.unwrap()["error"], "invalid_grant");
        assert_eq!(log.all().len(), 3);
        assert_eq!(app.relay.calendar_active.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn calendar_rejects_unsigned_mismatched_and_unsafe_requests_before_google() {
        let (origin, log) = fake_http(gemini_ok()).await;
        let app = Fixture::with(signed_in(), gemini_ok(), |config| {
            config.google_calendar = Some(GoogleCalendarApp {client_id:"desktop.apps.googleusercontent.com".into(),
                client_secret:"server-only-secret".into(), token_url:origin});
        }).await;
        assert_eq!(app.http.post(app.url(GOOGLE_TOKEN_PATH)).json(&calendar_request()).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
        for (key, value) in [("client_id", "foreign-client"), ("code_verifier", "short"), ("redirect_uri", "https://attacker.example/"),
            ("redirect_uri", "http://user:pass@127.0.0.1:12345"), ("redirect_uri", "http://127.0.0.1:12345/foreign"), ("grant_type", "password")] {
            let mut body = calendar_request(); body[key] = json!(value);
            assert_eq!(app.http.post(app.url(GOOGLE_TOKEN_PATH)).bearer_auth("valid-session").json(&body).send().await.unwrap().status(), StatusCode::BAD_REQUEST);
        }
        assert_eq!(app.http.post(app.url(GOOGLE_TOKEN_PATH)).bearer_auth("valid-session").body("x".repeat(MAX_CALENDAR_BODY + 1)).send().await.unwrap().status(), StatusCode::BAD_REQUEST);
        assert!(log.all().is_empty());
    }

    fn ai_body() -> Value {
        json!({
            "systemInstruction": { "parts": [{ "text": "Use only the meeting." }] },
            "contents": [{ "role": "user", "parts": [{ "text": "Summarize the launch decision." }] }],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": { "type": "object", "properties": { "answer": { "type": "string" } } },
                "maxOutputTokens": 2000
            }
        })
    }

    struct Fixture {
        relay: Arc<Relay>,
        addr: SocketAddr,
        server: JoinHandle<()>,
        sarvam: Sarvam,
        supabase: Log,
        gemini: Log,
        http: reqwest::Client,
    }

    impl Fixture {
        async fn start() -> Self {
            Self::with(signed_in(), gemini_ok(), |_| {}).await
        }

        async fn with(
            supabase: Responder,
            gemini: Responder,
            tweak: impl FnOnce(&mut Config),
        ) -> Self {
            Self::with_billing(supabase, gemini, tweak, None).await
        }

        async fn with_billing(supabase: Responder, gemini: Responder, tweak: impl FnOnce(&mut Config), billing: Option<cloud_billing_server::Billing>) -> Self {
            let (supabase_origin, supabase) = fake_http(supabase).await;
            let (gemini_origin, gemini) = fake_http(gemini).await;
            let sarvam = fake_sarvam().await;
            let mut config = test_config(&supabase_origin, &sarvam.url, &gemini_origin);
            tweak(&mut config);
            let relay = match billing { Some(billing) => Relay::with_billing(config,billing), None => Relay::new(config) };
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(relay.clone().serve(listener));
            let http = reqwest::Client::builder().no_proxy().build().unwrap();
            Self {
                relay,
                addr,
                server,
                sarvam,
                supabase,
                gemini,
                http,
            }
        }

        fn url(&self, path: &str) -> String {
            format!("http://{}{path}", self.addr)
        }

        async fn health(&self) -> StatusCode {
            self.http
                .get(self.url("/health"))
                .send()
                .await
                .unwrap()
                .status()
        }

        async fn capabilities(&self, token: &str) -> reqwest::Response {
            self.http
                .get(self.url("/v1/capabilities"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
        }

        async fn generate(&self, body: impl Into<reqwest::Body>, token: &str) -> reqwest::Response {
            self.http
                .post(self.url("/v1/ai/generate"))
                .bearer_auth(token)
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .unwrap()
        }

        async fn connect(&self, token: &str) -> Result<TestSocket, tungstenite::Error> {
            let mut request = format!("ws://{}{ROUTE}", self.addr)
                .into_client_request()
                .unwrap();
            request.headers_mut().insert(
                "authorization",
                HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
            );
            connect_async(request).await.map(|(socket, _)| socket)
        }

        async fn provider(&mut self) -> Provider {
            timeout(WAIT, self.sarvam.connections.recv())
                .await
                .expect("the relay never dialled Sarvam")
                .unwrap()
        }

        async fn raw_upgrade(&self, target: &str) -> String {
            let mut stream = TcpStream::connect(self.addr).await.unwrap();
            let request = format!(
                "GET {target} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer valid-session\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: invalid\r\n\r\n"
            );
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut text = String::new();
            timeout(WAIT, stream.read_to_string(&mut text))
                .await
                .unwrap()
                .unwrap();
            text
        }
    }

    fn rejected_with(result: Result<TestSocket, tungstenite::Error>) -> u16 {
        match result {
            Err(tungstenite::Error::Http(response)) => response.status().as_u16(),
            Err(other) => panic!("unexpected handshake failure: {other}"),
            Ok(_) => panic!("the relay accepted the stream"),
        }
    }

    async fn closed(socket: &mut TestSocket) -> bool {
        let ended = async {
            loop {
                match socket.next().await {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                    Some(Ok(_)) => {}
                }
            }
        };
        timeout(WAIT, ended).await.is_ok()
    }

    #[test]
    fn configuration_errors_never_echo_credentials() {
        let base = [
            ("KESAMI_SUPABASE_URL", "https://project.supabase.co"),
            ("KESAMI_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test"),
            ("KESAMI_SARVAM_API_KEY", "private-provider-key"),
        ];
        let load = |overrides: &[(&str, &str)]| {
            let vars: HashMap<&str, &str> = base.iter().chain(overrides).copied().collect();
            Config::from_env(|name| vars.get(name).map(|value| value.to_string()))
        };
        let config = load(&[]).unwrap();
        assert_eq!(config.daily_ai_limit, DEFAULT_DAILY_AI_LIMIT);
        assert!(config.gemini_key.is_none());
        assert!(config.openai_key.is_none());
        assert!(load(&[("KESAMI_OPENAI_API_KEY", "   ")]).unwrap().openai_key.is_none());
        let openai = load(&[("KESAMI_OPENAI_API_KEY", "sk-server")]).unwrap();
        assert_eq!(openai.openai_key.as_deref(), Some("sk-server"));
        assert_eq!(openai.openai_daily_budget_usd, 3.0);
        assert!(openai.openai_usage_file.is_none());
        let capped = load(&[("KESAMI_OPENAI_DAILY_BUDGET_USD", "0.5"), ("KESAMI_OPENAI_USAGE_FILE", "/data/openai-usage.json")]).unwrap();
        assert_eq!(capped.openai_daily_budget_usd, 0.5);
        assert_eq!(capped.openai_usage_file.as_deref(), Some(std::path::Path::new("/data/openai-usage.json")));
        assert_eq!(
            load(&[("KESAMI_CLOUD_DAILY_AI_LIMIT", "7")])
                .unwrap()
                .daily_ai_limit,
            7
        );
        assert_eq!(
            load(&[("KESAMI_CLOUD_DAILY_AI_LIMIT", "1.5")])
                .unwrap()
                .daily_ai_limit,
            DEFAULT_DAILY_AI_LIMIT
        );
        for invalid in [
            (
                "KESAMI_SUPABASE_URL",
                "https://private-key@project.supabase.co",
            ),
            ("KESAMI_SUPABASE_URL", "http://project.supabase.co"),
            ("KESAMI_SUPABASE_URL", "https://project.supabase.co/rest/v1"),
            (
                "KESAMI_SUPABASE_URL",
                "https://project.supabase.co/?private-key",
            ),
            ("KESAMI_SUPABASE_PUBLISHABLE_KEY", "sb_secret_private-key"),
            ("KESAMI_SARVAM_API_KEY", "   "),
            ("KESAMI_SARVAM_REALTIME_URL", "ws://api.sarvam.ai/ws"),
            (
                "KESAMI_SARVAM_REALTIME_URL",
                "wss://private-key@api.sarvam.ai/ws",
            ),
        ] {
            let failure = load(&[invalid])
                .err()
                .unwrap_or_else(|| panic!("{invalid:?} was accepted"));
            assert!(!failure.to_string().contains("private-key"));
        }
    }

    #[test]
    fn upstream_requests_are_validated_and_rebuilt_server_side() {
        let relay = Relay::new(test_config(
            "https://project.supabase.co",
            "wss://api.sarvam.ai/speech-to-text-realtime/ws?region=in&model=stale",
            GEMINI_ORIGIN,
        ));
        let uri = |target: &str| target.parse::<Uri>().unwrap();
        let url = relay
            .upstream_url(&uri(&format!(
                "{ROUTE}&language_code=hi-IN&mode=codemix&key=client-key"
            )))
            .unwrap();
        let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
        let expected: HashMap<String, String> = [
            ("region", "in"),
            ("model", "saaras:v3-realtime"),
            ("language_code", "hi-IN"),
            ("mode", "codemix"),
            ("encoding", "linear16"),
            ("sample_rate", "16000"),
            ("return_timestamps", "true"),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect();
        assert_eq!(query, expected);
        assert_eq!(url.host_str(), Some("api.sarvam.ai"));
        for invalid in [
            format!("{ROUTE}&mode=shell"),
            format!("{ROUTE}&language_code=x"),
            format!("{ROUTE}&language_code=hi_IN"),
            "/v1/transcription/realtime?model=saaras%3Av3-realtime&encoding=linear16".to_owned(),
            "/v1/transcription/realtime?model=attacker&encoding=linear16&sample_rate=16000"
                .to_owned(),
            "/v1/transcription/realtime?model=saaras%3Av3-realtime&encoding=opus&sample_rate=16000"
                .to_owned(),
            ROUTE.replace(REALTIME_PATH, "/v1/other"),
        ] {
            assert!(
                relay.upstream_url(&uri(&invalid)).is_none(),
                "{invalid} was accepted"
            );
        }
    }

    #[test]
    fn audio_must_be_strict_padded_base64() {
        assert_eq!(base64_len("AAAAAA=="), Some(4));
        assert_eq!(base64_len("AAA="), Some(2));
        assert_eq!(base64_len("AAAA"), Some(3));
        for invalid in [
            "",
            "x",
            "AAA",
            "====",
            "A===",
            "AA=A",
            "AA-_",
            "AAAAAA==AAAA",
        ] {
            assert_eq!(base64_len(invalid), None, "{invalid} was accepted");
        }
        assert_eq!(base64_len(&"A".repeat(MAX_AUDIO_CHARS)), Some(36_000));
        assert_eq!(base64_len(&"A".repeat(MAX_AUDIO_CHARS + 4)), None);
    }

    #[tokio::test]
    async fn anonymous_or_malformed_identities_are_rejected() {
        for user in [
            "null",
            r#"{"id":"garbage","is_anonymous":false}"#,
            r#"{"id":"12345678-1234-1234-1234-123456789012","is_anonymous":true}"#,
        ] {
            let app = Fixture::with(
                Arc::new(move |_: &Seen| (StatusCode::OK, user.to_owned())),
                gemini_ok(),
                |_| {},
            )
            .await;
            assert_eq!(
                app.capabilities("candidate").await.status(),
                401,
                "{user} was accepted"
            );
        }
        let mut app = Fixture::start().await;
        assert_eq!(rejected_with(app.connect("bad-session").await), 401);
        assert!(app.sarvam.connections.try_recv().is_err());
        let capabilities: Value = app
            .capabilities("valid-session")
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(
            capabilities,
            json!({ "realtimeTranscription": true, "meetingAi": true })
        );
        let lookups = app.supabase.all();
        assert!(!lookups.is_empty());
        assert!(lookups.iter().all(|seen| seen.uri.path() == "/auth/v1/user"
            && seen.headers["apikey"] == "sb_publishable_test"));
        assert_eq!(app.capabilities("two words").await.status(), 401);
    }

    #[tokio::test]
    async fn invalid_websocket_handshakes_do_not_consume_a_users_streams() {
        let mut app = Fixture::start().await;
        for _ in 0..3 {
            assert!(app.raw_upgrade(ROUTE).await.starts_with("HTTP/1.1 400"));
        }
        assert!(app
            .raw_upgrade("http://[")
            .await
            .starts_with("HTTP/1.1 400"));
        assert!(app
            .raw_upgrade("/v1/other")
            .await
            .starts_with("HTTP/1.1 400"));
        let _first = app.connect("valid-session").await.unwrap();
        let _first_provider = app.provider().await;
        let _second = app.connect("valid-session").await.unwrap();
        let _second_provider = app.provider().await;
    }

    #[tokio::test]
    async fn malformed_client_events_close_only_their_stream() {
        let mut app = Fixture::start().await;
        for value in [
            "null",
            "[]",
            "{",
            "\"hello\"",
            r#"{"event":"unknown"}"#,
            r#"{"event":"audio_input","audio":"x"}"#,
            r#"{"event":"audio_input","audio":"AA=="}"#,
        ] {
            let mut client = app.connect("valid-session").await.unwrap();
            let _provider = app.provider().await;
            client.send(Message::text(value)).await.unwrap();
            assert!(closed(&mut client).await, "{value} kept the stream open");
        }
        let mut client = app.connect("valid-session").await.unwrap();
        let _provider = app.provider().await;
        client.send(Message::binary(vec![0u8; 4])).await.unwrap();
        assert!(
            closed(&mut client).await,
            "binary frames kept the stream open"
        );
        assert_eq!(app.health().await, 200);
    }

    #[tokio::test]
    async fn only_supported_audio_fields_reach_sarvam() {
        let mut app = Fixture::start().await;
        let mut client = app.connect("valid-session").await.unwrap();
        let mut provider = app.provider().await;
        assert_eq!(
            provider.headers["api-subscription-key"],
            "private-provider-key"
        );
        assert!(provider.headers.get("authorization").is_none());
        let query: HashMap<String, String> = Url::parse(&format!("ws://sarvam{}", provider.uri))
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect();
        assert_eq!(query["model"], "saaras:v3-realtime");
        assert_eq!(query["language_code"], "auto");
        assert_eq!(query["mode"], "transcribe");
        assert_eq!(query["return_timestamps"], "true");
        let audio = json!({ "event": "audio_input", "audio": "AAAAAA==", "model": "attacker-model", "key": "client-key" });
        client.send(Message::text(audio.to_string())).await.unwrap();
        client
            .send(Message::text(r#"{"event":"end","flush":true}"#))
            .await
            .unwrap();
        for expected in [
            json!({ "event": "audio_input", "audio": "AAAAAA==" }),
            json!({ "event": "end" }),
        ] {
            let forwarded = timeout(WAIT, provider.received.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(serde_json::from_str::<Value>(&forwarded).unwrap(), expected);
        }
        provider
            .reply
            .send(r#"{"type":"data","data":{"transcript":"hello"}}"#.into())
            .unwrap();
        let reply = timeout(WAIT, client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.into_text().unwrap().as_str(),
            r#"{"type":"data","data":{"transcript":"hello"}}"#
        );
    }

    #[tokio::test]
    async fn a_stalled_provider_closes_the_stream_instead_of_buffering() {
        let mut app = Fixture::start().await;
        app.sarvam.stall.store(true, Ordering::SeqCst);
        let mut client = app.connect("valid-session").await.unwrap();
        let _provider = app.provider().await;
        let chunk =
            json!({ "event": "audio_input", "audio": "A".repeat(MAX_AUDIO_CHARS) }).to_string();
        let flood = async {
            for _ in 0..4_000 {
                if client.send(Message::text(chunk.clone())).await.is_err() {
                    break;
                }
            }
        };
        timeout(Duration::from_secs(30), flood).await.unwrap();
        assert!(closed(&mut client).await);
    }

    #[tokio::test]
    async fn provider_failures_release_slots_and_leave_the_relay_healthy() {
        let mut app = Fixture::start().await;
        for _ in 0..3 {
            let mut client = app.connect("valid-session").await.unwrap();
            let mut provider = app.provider().await;
            provider.hang_up.take().unwrap().send(()).unwrap();
            assert!(closed(&mut client).await);
        }
        let _client = app.connect("valid-session").await.unwrap();
        assert_eq!(app.health().await, 200);
    }

    #[tokio::test]
    async fn per_user_stream_limits_and_shutdown_close_every_provider() {
        let mut app = Fixture::start().await;
        let mut first = app.connect("valid-session").await.unwrap();
        let mut first_provider = app.provider().await;
        let mut second = app.connect("valid-session").await.unwrap();
        let mut second_provider = app.provider().await;
        assert_eq!(rejected_with(app.connect("valid-session").await), 429);
        app.relay.close();
        assert!(closed(&mut first).await);
        assert!(closed(&mut second).await);
        for provider in [&mut first_provider, &mut second_provider] {
            assert!(timeout(WAIT, provider.received.recv())
                .await
                .unwrap()
                .is_none());
        }
        timeout(WAIT, app.server).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn ai_requires_a_verified_sign_in_before_spending_usage() {
        let app = Fixture::start().await;
        assert_eq!(
            app.generate(ai_body().to_string(), "invalid-session")
                .await
                .status(),
            401
        );
        assert!(app.gemini.all().is_empty());
    }

    #[tokio::test]
    async fn ai_keeps_secrets_model_selection_and_limits_server_side() {
        let app = Fixture::start().await;
        let mut body = ai_body();
        body["tools"] = json!(["unsafe-tool"]);
        body["model"] = json!("client-model");
        body["key"] = json!("client-key");
        body["generationConfig"]["maxOutputTokens"] = json!(100_000);
        let response = app.generate(body.to_string(), "valid-session").await;
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            serde_json::from_str::<Value>(GENERATED).unwrap()
        );
        let calls = app.gemini.all();
        assert_eq!(calls.len(), 1);
        let call = &calls[0];
        assert_eq!(
            call.uri.path(),
            "/v1beta/models/gemini-2.5-flash:generateContent"
        );
        assert!(call.uri.query().is_none());
        assert_eq!(call.headers["x-goog-api-key"], "server-provider-key");
        assert!(call.headers.get("authorization").is_none());
        let forwarded: Value = serde_json::from_slice(&call.body).unwrap();
        assert_eq!(forwarded["generationConfig"]["maxOutputTokens"], 8192);
        assert_eq!(
            forwarded["generationConfig"]["thinkingConfig"],
            json!({ "thinkingBudget": 0 })
        );
        for field in ["tools", "model", "key"] {
            assert!(forwarded.get(field).is_none(), "{field} was forwarded");
        }
    }

    #[tokio::test]
    async fn malformed_non_text_and_oversized_ai_requests_never_reach_gemini() {
        let app = Fixture::start().await;
        assert_eq!(app.generate("{", "valid-session").await.status(), 400);
        let mut file = ai_body();
        file["contents"][0]["parts"] =
            json!([{ "fileData": { "fileUri": "https://example.com" } }]);
        assert_eq!(
            app.generate(file.to_string(), "valid-session")
                .await
                .status(),
            400
        );
        assert_eq!(
            app.generate("x".repeat(MAX_AI_BODY + 1), "valid-session")
                .await
                .status(),
            413
        );
        assert!(app.gemini.all().is_empty());
    }

    #[tokio::test]
    async fn provider_failures_and_missing_configuration_do_not_disclose_credentials() {
        let failing = Arc::new(|_: &Seen| {
            (
                StatusCode::FORBIDDEN,
                r#"{"error":"server-provider-key"}"#.to_owned(),
            )
        });
        let app = Fixture::with(signed_in(), failing, |_| {}).await;
        let response = app.generate(ai_body().to_string(), "valid-session").await;
        assert_eq!(response.status(), 503);
        assert!(!response
            .text()
            .await
            .unwrap()
            .contains("server-provider-key"));
        let unconfigured =
            Fixture::with(signed_in(), gemini_ok(), |config| config.gemini_key = None).await;
        let missing = unconfigured
            .generate(ai_body().to_string(), "valid-session")
            .await;
        assert_eq!(missing.status(), 503);
        assert!(!missing.text().await.unwrap().contains("API key"));
    }

    #[tokio::test]
    async fn openai_never_runs_while_gemini_has_quota_or_without_a_gemini_key() {
        let app = Fixture::with(signed_in(), gemini_ok(), with_openai).await;
        assert_eq!(app.generate(ai_body().to_string(), "valid-session").await.status(), 200);
        let calls = app.gemini.all();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].uri.path().starts_with("/v1beta/"));

        let broken = Arc::new(|seen: &Seen| {
            if seen.uri.path().starts_with("/v1beta/") {
                (StatusCode::INTERNAL_SERVER_ERROR, "{}".to_owned())
            } else {
                (StatusCode::OK, "{}".to_owned())
            }
        });
        let app = Fixture::with(signed_in(), broken, with_openai).await;
        assert_eq!(app.generate(ai_body().to_string(), "valid-session").await.status(), 503);
        assert_eq!(app.gemini.all().len(), 1);

        let app = Fixture::with(signed_in(), openai_ok(), |config| {
            with_openai(config);
            config.gemini_key = None;
        })
        .await;
        assert_eq!(app.capabilities("valid-session").await.json::<Value>().await.unwrap()["meetingAi"], false);
        assert_eq!(app.generate(ai_body().to_string(), "valid-session").await.status(), 503);
        assert!(app.gemini.all().is_empty());
    }

    #[tokio::test]
    async fn an_exhausted_gemini_hands_the_request_to_gpt_5_nano_in_the_gemini_shape() {
        let app = Fixture::with(signed_in(), gemini_exhausted_then(openai_ok()), with_openai).await;
        let mut body = ai_body();
        body["model"] = json!("client-model");
        body["key"] = json!("client-key");
        body["generationConfig"]["maxOutputTokens"] = json!(100_000);
        let response = app.generate(body.to_string(), "valid-session").await;
        assert_eq!(response.status(), 200);
        let text = response.text().await.unwrap();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), serde_json::from_str::<Value>(GENERATED).unwrap());
        assert!(!text.contains("private-provider-info"));
        let calls = app.gemini.all();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].uri.path(), "/v1beta/models/gemini-2.5-flash:generateContent");
        let call = &calls[1];
        assert_eq!(call.uri.path(), "/v1/chat/completions");
        assert_eq!(call.headers["authorization"], "Bearer server-openai-key");
        assert!(call.headers.get("x-goog-api-key").is_none());
        let forwarded: Value = serde_json::from_slice(&call.body).unwrap();
        assert_eq!(forwarded["model"], "gpt-5-nano");
        assert_eq!(forwarded["max_completion_tokens"], 8192);
        assert_eq!(forwarded["messages"][0], json!({ "role": "system", "content": "Use only the meeting." }));
        assert_eq!(forwarded["messages"][1], json!({ "role": "user", "content": "Summarize the launch decision." }));
        let schema = &forwarded["response_format"]["json_schema"];
        assert_eq!(schema["strict"], true);
        assert_eq!(schema["schema"]["required"], json!(["answer"]));
        assert_eq!(schema["schema"]["additionalProperties"], false);
        assert!(!call.body.windows(10).any(|window| window == b"client-key"));
        assert!(!forwarded.to_string().contains("client-model"));
    }

    #[tokio::test]
    async fn the_three_dollar_daily_openai_budget_is_shared_by_every_user() {
        let tiny = |config: &mut Config| {
            with_openai(config);
            config.openai_daily_budget_usd = 0.001;
        };
        let app = Fixture::with(signed_in(), gemini_exhausted_then(openai_ok()), tiny).await;
        assert_eq!(app.generate(ai_body().to_string(), "valid-session").await.status(), 200);
        let refused = app.generate(ai_body().to_string(), "valid-session").await;
        assert_eq!(refused.status(), 429);
        assert!(refused.text().await.unwrap().contains("busy"));
        let paths: Vec<String> = app.gemini.all().iter().map(|call| call.uri.path().to_owned()).collect();
        assert_eq!(
            paths,
            [
                "/v1beta/models/gemini-2.5-flash:generateContent",
                "/v1/chat/completions",
                "/v1beta/models/gemini-2.5-flash:generateContent",
            ]
        );
    }

    #[tokio::test]
    async fn openai_refusals_and_failures_stay_inside_the_relay() {
        let refusing = Arc::new(|_: &Seen| {
            let completion = json!({ "choices": [{ "message": { "content": null, "refusal": "private-refusal" }, "finish_reason": "stop" }] });
            (StatusCode::OK, completion.to_string())
        });
        let app = Fixture::with(signed_in(), gemini_exhausted_then(refusing), with_openai).await;
        let response = app.generate(ai_body().to_string(), "valid-session").await;
        assert_eq!(response.status(), 200);
        let refused: Value = response.json().await.unwrap();
        assert_eq!(refused, json!({ "candidates": [{ "content": { "parts": [] }, "finishReason": "SAFETY" }] }));

        let failing = Arc::new(|_: &Seen| {
            (StatusCode::UNAUTHORIZED, r#"{"error":{"message":"server-openai-key is invalid"}}"#.to_owned())
        });
        let app = Fixture::with(signed_in(), gemini_exhausted_then(failing), with_openai).await;
        let response = app.generate(ai_body().to_string(), "valid-session").await;
        assert_eq!(response.status(), 503);
        assert!(!response.text().await.unwrap().contains("server-openai-key"));
    }

    #[tokio::test]
    async fn daily_ai_allowance_is_enforced_per_verified_user() {
        let app = Fixture::with(signed_in(), gemini_ok(), |config| config.daily_ai_limit = 1).await;
        assert_eq!(
            app.generate(ai_body().to_string(), "valid-session")
                .await
                .status(),
            200
        );
        assert_eq!(
            app.generate(ai_body().to_string(), "valid-session")
                .await
                .status(),
            429
        );
    }
}
