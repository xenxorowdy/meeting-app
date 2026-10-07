//! Subscription billing. Stripe Checkout serves the global/USD price and
//! Razorpay Subscriptions the India/INR price. Publishing a price never
//! grants an entitlement: a paid tier is granted only when a
//! signature-verified provider webhook, or the provider's own API read with
//! this backend's secret, reports an active subscription, and every webhook
//! event is applied at most once.
use crate::plans;
use chrono::Datelike;
use hmac::{Hmac, Mac};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::Sha256;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use subtle::ConstantTimeEq;
use tokio::task::spawn_blocking;

type HmacSha256 = Hmac<Sha256>;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

const STRIPE_API: &str = "https://api.stripe.com/v1";
const RAZORPAY_API: &str = "https://api.razorpay.com/v1";
/// Stripe rejects stale signatures; five minutes matches its own tooling.
const STRIPE_TIMESTAMP_TOLERANCE_MS: i64 = 5 * 60 * 1000;

/// Provider secrets. Read from the environment (or the launcher's credential
/// file environment overrides) and never exposed through any API response.
#[derive(Debug, Clone, Default)]
pub struct ProviderConfig {
    pub stripe_secret_key: Option<String>,
    pub stripe_price_usd: Option<String>,
    pub stripe_webhook_secret: Option<String>,
    pub razorpay_key_id: Option<String>,
    pub razorpay_key_secret: Option<String>,
    pub razorpay_plan_inr: Option<String>,
    pub razorpay_webhook_secret: Option<String>,
    pub razorpay_api: Option<String>,
}

impl ProviderConfig {
    pub fn from_env() -> Self {
        let var = |name: &str| {
            crate::env_compat::var(name)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        Self {
            stripe_secret_key: var("KESAMI_STRIPE_SECRET_KEY"),
            stripe_price_usd: var("KESAMI_STRIPE_PRICE_USD"),
            stripe_webhook_secret: var("KESAMI_STRIPE_WEBHOOK_SECRET"),
            razorpay_key_id: var("KESAMI_RAZORPAY_KEY_ID"),
            razorpay_key_secret: var("KESAMI_RAZORPAY_KEY_SECRET"),
            razorpay_plan_inr: var("KESAMI_RAZORPAY_PLAN_INR"),
            razorpay_webhook_secret: var("KESAMI_RAZORPAY_WEBHOOK_SECRET"),
            razorpay_api: None,
        }
    }

    pub fn stripe_ready(&self) -> bool {
        self.stripe_secret_key.is_some()
            && self.stripe_price_usd.is_some()
            && self.stripe_webhook_secret.is_some()
    }

    pub fn razorpay_ready(&self) -> bool {
        self.razorpay_key_id.is_some()
            && self.razorpay_key_secret.is_some()
            && self.razorpay_plan_inr.is_some()
            && self.razorpay_webhook_secret.is_some()
    }

    pub fn billing_enabled(&self) -> bool {
        self.stripe_ready() || self.razorpay_ready()
    }

    /// Safe to publish: presence flags only, never secret material.
    pub fn public_status(&self) -> Value {
        json!({
            "billingEnabled": self.billing_enabled(),
            "stripe": self.stripe_ready(),
            "razorpay": self.razorpay_ready(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct Subscription {
    pub account_id: String,
    pub plan: String,
    pub provider: String,
    pub provider_subscription_id: String,
    pub customer_id: Option<String>,
    pub status: String,
    pub currency: String,
    pub amount_minor: i64,
    pub current_period_end: Option<i64>,
}

pub struct BillingStore {
    db: Arc<Mutex<Connection>>,
}

fn store_error(_: impl std::fmt::Display) -> (u16, String) {
    (
        503,
        "Billing storage is unavailable. Please try again.".into(),
    )
}

impl BillingStore {
    pub async fn load(path: PathBuf) -> io::Result<Self> {
        spawn_blocking(move || Self::open(path))
            .await
            .map_err(|cause| io::Error::other(cause))?
    }

    pub fn open(path: PathBuf) -> io::Result<Self> {
        std::fs::create_dir_all(
            path.parent()
                .ok_or_else(|| io::Error::other("Missing billing database directory"))?,
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
        let db = Connection::open(&path).map_err(io::Error::other)?;
        db.busy_timeout(Duration::from_secs(5))
            .map_err(io::Error::other)?;
        db.execute_batch(
            "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS subscriptions (
                provider_subscription_id TEXT PRIMARY KEY,
                account_id TEXT NOT NULL,
                plan TEXT NOT NULL,
                provider TEXT NOT NULL,
                customer_id TEXT,
                status TEXT NOT NULL,
                currency TEXT NOT NULL,
                amount_minor INTEGER NOT NULL,
                current_period_end INTEGER,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS subscriptions_account
                ON subscriptions(account_id, status);
            CREATE TABLE IF NOT EXISTS billing_events (
                provider TEXT NOT NULL,
                event_id TEXT NOT NULL,
                received_at INTEGER NOT NULL,
                PRIMARY KEY (provider, event_id)
            );
            CREATE TABLE IF NOT EXISTS free_ai_uses (
                month TEXT NOT NULL,
                request_key TEXT NOT NULL,
                PRIMARY KEY (month, request_key)
            );",
        )
        .map_err(io::Error::other)?;
        for table in ["subscriptions", "billing_events"] {
            let mirrored: bool = db
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name='mirrored_at')"),
                    [],
                    |row| row.get(0),
                )
                .map_err(io::Error::other)?;
            if !mirrored {
                db.execute_batch(&format!(
                    "ALTER TABLE {table} ADD COLUMN mirrored_at INTEGER"
                ))
                .map_err(io::Error::other)?;
            }
        }
        Ok(Self {
            db: Arc::new(Mutex::new(db)),
        })
    }

    async fn query<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, (u16, String)> + Send + 'static,
    ) -> Result<T, (u16, String)> {
        let db = self.db.clone();
        spawn_blocking(move || {
            let connection = db.lock().map_err(store_error)?;
            f(&connection)
        })
        .await
        .map_err(store_error)?
    }

    fn ai_month() -> String {
        let now = chrono::Local::now();
        format!("{:04}-{:02}", now.year(), now.month())
    }

    /// Reserve before generating so concurrent requests cannot exceed the cap.
    /// Call release_free_ai_use if generation or persistence fails.
    pub async fn reserve_free_ai_use(&self, request_key: String) -> Result<bool, (u16, String)> {
        let month = Self::ai_month();
        self.query(move |db| {
            let exists: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM free_ai_uses WHERE month=?1 AND request_key=?2)",
                params![month, request_key], |row| row.get(0),
            ).map_err(store_error)?;
            if exists { return Ok(true); }
            let inserted = db.execute(
                "INSERT INTO free_ai_uses(month, request_key) SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM free_ai_uses WHERE month=?1) < ?3",
                params![month, request_key, plans::FREE_MONTHLY_AI_USES],
            ).map_err(store_error)?;
            Ok(inserted == 1)
        }).await
    }

    pub async fn release_free_ai_use(&self, request_key: String) {
        let _ = self
            .query(move |db| {
                db.execute(
                    "DELETE FROM free_ai_uses WHERE request_key=?1",
                    [request_key],
                )
                .map_err(store_error)?;
                Ok(())
            })
            .await;
    }

    pub async fn free_ai_uses(&self) -> Result<i64, (u16, String)> {
        let month = Self::ai_month();
        self.query(move |db| {
            db.query_row(
                "SELECT COUNT(*) FROM free_ai_uses WHERE month=?1",
                [month],
                |row| row.get(0),
            )
            .map_err(store_error)
        })
        .await
    }

    fn row_subscription(row: &rusqlite::Row<'_>) -> rusqlite::Result<Subscription> {
        Ok(Subscription {
            account_id: row.get(0)?,
            plan: row.get(1)?,
            provider: row.get(2)?,
            provider_subscription_id: row.get(3)?,
            customer_id: row.get(4)?,
            status: row.get(5)?,
            currency: row.get(6)?,
            amount_minor: row.get(7)?,
            current_period_end: row.get(8)?,
        })
    }

    const SUBSCRIPTION_COLUMNS: &'static str = "account_id, plan, provider, provider_subscription_id, customer_id, status, currency, amount_minor, current_period_end";

    /// The account's active subscription, if any. The entitlement question is
    /// exactly this query: an active row means the paid tier.
    pub async fn active_subscription(&self, account_id: &str) -> Option<Subscription> {
        let account_id = account_id.to_string();
        self.query(move |db| {
            db.query_row(
                &format!(
                    "SELECT {} FROM subscriptions
                     WHERE account_id=?1 AND status='active' AND plan='pro'
                       AND (current_period_end IS NULL OR current_period_end > ?2)
                     ORDER BY updated_at DESC LIMIT 1",
                    Self::SUBSCRIPTION_COLUMNS
                ),
                params![account_id, now_ms()],
                Self::row_subscription,
            )
            .optional()
            .map_err(store_error)
        })
        .await
        .ok()
        .flatten()
    }

    pub async fn account_for_subscription(
        &self,
        provider: &str,
        provider_subscription_id: &str,
    ) -> Option<String> {
        let provider = provider.to_string();
        let provider_subscription_id = provider_subscription_id.to_string();
        self.query(move |db| {
            db.query_row(
                "SELECT account_id FROM subscriptions WHERE provider=?1 AND provider_subscription_id=?2",
                params![provider, provider_subscription_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(store_error)
        })
        .await
        .ok()
        .flatten()
    }

    /// Inserts or refreshes a subscription row keyed by the provider's own
    /// subscription id. Missing optional fields never erase earlier values.
    pub async fn apply_subscription(
        &self,
        subscription: Subscription,
    ) -> Result<(), (u16, String)> {
        self.query(move |db| Self::write_subscription(db, &subscription))
            .await
    }

    fn write_subscription(
        db: &Connection,
        subscription: &Subscription,
    ) -> Result<(), (u16, String)> {
        let updated_at = now_ms();
        db.execute(
                "INSERT INTO subscriptions (
                    account_id, plan, provider, provider_subscription_id, customer_id,
                    status, currency, amount_minor, current_period_end, updated_at
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
                ON CONFLICT(provider_subscription_id) DO UPDATE SET
                    plan=excluded.plan,
                    customer_id=COALESCE(excluded.customer_id, subscriptions.customer_id),
                    status=excluded.status,
                    current_period_end=COALESCE(excluded.current_period_end, subscriptions.current_period_end),
                    updated_at=MAX(excluded.updated_at, subscriptions.updated_at+1),
                    mirrored_at=NULL
                WHERE subscriptions.account_id=excluded.account_id AND subscriptions.provider=excluded.provider
                  AND subscriptions.status <> 'canceled' AND excluded.status <> 'incomplete'",
                params![
                    subscription.account_id,
                    subscription.plan,
                    subscription.provider,
                    subscription.provider_subscription_id,
                    subscription.customer_id,
                    subscription.status,
                    subscription.currency,
                    subscription.amount_minor,
                    subscription.current_period_end,
                    updated_at,
                ],
            )
            .map(|_| ())
            .map_err(store_error)
    }

    pub async fn latest_subscription(
        &self,
        account_id: &str,
    ) -> Result<Option<Subscription>, (u16, String)> {
        let account_id = account_id.to_string();
        self.query(move |db| db.query_row(
            &format!("SELECT {} FROM subscriptions WHERE account_id=?1 ORDER BY (status='active' AND (current_period_end IS NULL OR current_period_end > ?2)) DESC, updated_at DESC LIMIT 1", Self::SUBSCRIPTION_COLUMNS),
            params![account_id, now_ms()], Self::row_subscription,
        ).optional().map_err(store_error)).await
    }

    /// A cloud response replaces the cache, including downgrades and canceled plans.
    pub async fn cache_subscription(
        &self,
        account_id: &str,
        subscription: Option<Subscription>,
    ) -> Result<(), (u16, String)> {
        let account_id = account_id.to_string();
        self.query(move |db| {
            let tx = db.unchecked_transaction().map_err(store_error)?;
            tx.execute(
                "DELETE FROM subscriptions WHERE account_id=?1",
                [&account_id],
            )
            .map_err(store_error)?;
            if let Some(subscription) = subscription {
                if subscription.account_id != account_id {
                    return Err((502, "Unexpected subscription owner.".into()));
                }
                Self::write_subscription(&tx, &subscription)?;
            }
            tx.commit().map_err(store_error)
        })
        .await
    }

    /// Records a provider event id. Returns false when the event was already
    /// processed, so webhook retries never double-apply.
    pub async fn record_event(
        &self,
        provider: &str,
        event_id: &str,
    ) -> Result<bool, (u16, String)> {
        let received_at = now_ms();
        let provider = provider.to_string();
        let event_id = event_id.to_string();
        self.query(move |db| {
            let inserted = db
                .execute(
                    "INSERT OR IGNORE INTO billing_events (provider, event_id, received_at) VALUES (?1,?2,?3)",
                    params![provider, event_id, received_at],
                )
                .map_err(store_error)?;
            Ok(inserted > 0)
        })
        .await
    }

    pub async fn unmirrored_events(&self) -> Result<Vec<(String, String, i64)>, (u16, String)> {
        self.query(|db| {
            let mut statement = db
                .prepare(
                    "SELECT provider, event_id, received_at FROM billing_events
                     WHERE mirrored_at IS NULL ORDER BY received_at LIMIT 200",
                )
                .map_err(store_error)?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(store_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(store_error)
        })
        .await
    }

    pub async fn mark_event_mirrored(
        &self,
        provider: &str,
        event_id: &str,
    ) -> Result<(), (u16, String)> {
        let (provider, event_id, mirrored_at) =
            (provider.to_string(), event_id.to_string(), now_ms());
        self.query(move |db| {
            db.execute(
                "UPDATE billing_events SET mirrored_at=?1 WHERE provider=?2 AND event_id=?3",
                params![mirrored_at, provider, event_id],
            )
            .map(|_| ())
            .map_err(store_error)
        })
        .await
    }

    pub async fn unmirrored_subscriptions(
        &self,
    ) -> Result<Vec<(Subscription, i64)>, (u16, String)> {
        self.query(|db| {
            let mut statement = db
                .prepare(&format!(
                    "SELECT {}, updated_at FROM subscriptions
                     WHERE mirrored_at IS NULL ORDER BY updated_at LIMIT 200",
                    Self::SUBSCRIPTION_COLUMNS
                ))
                .map_err(store_error)?;
            let rows = statement
                .query_map([], |row| Ok((Self::row_subscription(row)?, row.get(9)?)))
                .map_err(store_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(store_error)
        })
        .await
    }

    pub async fn mark_subscription_mirrored(
        &self,
        provider_subscription_id: &str,
        updated_at: i64,
    ) -> Result<(), (u16, String)> {
        let (provider_subscription_id, mirrored_at) =
            (provider_subscription_id.to_string(), now_ms());
        self.query(move |db| {
            db.execute(
                "UPDATE subscriptions SET mirrored_at=?1 WHERE provider_subscription_id=?2 AND updated_at=?3",
                params![mirrored_at, provider_subscription_id, updated_at],
            )
            .map(|_| ())
            .map_err(store_error)
        })
        .await
    }

    pub fn subscription_value(subscription: &Subscription) -> Value {
        json!({
            "plan": subscription.plan,
            "providerSubscriptionId": subscription.provider_subscription_id,
            "provider": subscription.provider,
            "status": subscription.status,
            "currency": subscription.currency,
            "amountMinor": subscription.amount_minor,
            "currentPeriodEnd": subscription.current_period_end,
        })
    }
}

/// What the rest of the backend may do: "pro" unlocks recording and AI, and
/// everything else — including anonymous local use — is the free tier.
pub fn tier_for(subscription: Option<&Subscription>) -> &'static str {
    match subscription {
        Some(subscription)
            if subscription.status == "active"
                && subscription.plan == "pro"
                && subscription
                    .current_period_end
                    .is_none_or(|end| end > now_ms()) =>
        {
            "pro"
        }
        _ => "free",
    }
}

/// Creates a provider checkout session for one Pro seat./// `origin` seeds the Stripe success/cancel redirects back into the UI.
pub async fn create_checkout(
    config: &ProviderConfig,
    plan: &str,
    currency: &str,
    account_id: &str,
    account_email: &str,
    origin: &str,
) -> Result<Value, (u16, String)> {
    if plan != "pro" {
        return Err((
            400,
            "Only the Pro plan supports self-serve checkout. Contact sales for Enterprise.".into(),
        ));
    }
    match currency.to_ascii_uppercase().as_str() {
        "USD" => stripe_checkout(config, account_id, account_email, origin).await,
        "INR" => razorpay_checkout(config, account_id, account_email).await,
        _ => Err((400, "Choose a supported currency: INR or USD.".into())),
    }
}

fn provider_client() -> Result<&'static reqwest::Client, (u16, String)> {
    static CLIENT: std::sync::OnceLock<Option<reqwest::Client>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .ok()
        })
        .as_ref()
        .ok_or_else(|| (503, "Could not reach the payment provider.".into()))
}

async fn stripe_checkout(
    config: &ProviderConfig,
    account_id: &str,
    account_email: &str,
    origin: &str,
) -> Result<Value, (u16, String)> {
    let (Some(secret_key), Some(price_id)) = (
        config.stripe_secret_key.as_deref(),
        config.stripe_price_usd.as_deref(),
    ) else {
        return Err((
            503,
            "Stripe billing is not configured on this backend.".into(),
        ));
    };
    let configured_return = crate::env_compat::var("KESAMI_BILLING_RETURN_URL").ok();
    let redirect = reqwest::Url::parse(configured_return.as_deref().unwrap_or(origin))
        .ok()
        .filter(|url| {
            url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && (url.scheme() == "https"
                    || (url.scheme() == "http"
                        && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))))
        })
        .ok_or((
            503,
            "Stripe checkout needs a valid KESAMI_BILLING_RETURN_URL on the service.".into(),
        ))?;
    let base = redirect.as_str().trim_end_matches('/');
    let form = [
        ("mode", "subscription"),
        ("line_items[0][price]", price_id),
        ("line_items[0][quantity]", "1"),
        ("client_reference_id", account_id),
        ("customer_email", account_email),
        ("metadata[accountId]", account_id),
        ("subscription_data[metadata][accountId]", account_id),
        ("success_url", &format!("{base}/?billing=success")),
        ("cancel_url", &format!("{base}/?billing=cancelled")),
    ];
    let response = provider_client()?
        .post(format!("{STRIPE_API}/checkout/sessions"))
        .bearer_auth(secret_key)
        .form(&form)
        .send()
        .await
        .map_err(|_| (502, "Could not reach Stripe. Please try again.".into()))?;
    let success = response.status().is_success();
    let payload: Value = response
        .json()
        .await
        .map_err(|_| (502, "Stripe returned an unreadable response.".into()))?;
    if success {
        if let Some(url) = payload.get("url").and_then(Value::as_str) {
            return Ok(json!({"provider": "stripe", "checkoutUrl": url}));
        }
    }
    Err(provider_error("Stripe", &payload))
}

async fn razorpay_checkout(
    config: &ProviderConfig,
    account_id: &str,
    account_email: &str,
) -> Result<Value, (u16, String)> {
    let (Some(key_id), Some(key_secret), Some(plan_id), Some(_webhook_secret)) = (
        config.razorpay_key_id.as_deref(),
        config.razorpay_key_secret.as_deref(),
        config.razorpay_plan_inr.as_deref(),
        config.razorpay_webhook_secret.as_deref(),
    ) else {
        return Err((
            503,
            "Razorpay billing is not configured on this backend.".into(),
        ));
    };
    let body = json!({
        "plan_id": plan_id,
        "quantity": 1,
        "total_count": 12,
        "customer_notify": 1,
        "notes": {"accountId": account_id, "email": account_email},
    });
    let response = provider_client()?
        .post(format!(
            "{}/subscriptions",
            config.razorpay_api.as_deref().unwrap_or(RAZORPAY_API)
        ))
        .basic_auth(key_id, Some(key_secret))
        .json(&body)
        .send()
        .await
        .map_err(|_| (502, "Could not reach Razorpay. Please try again.".into()))?;
    let success = response.status().is_success();
    let payload: Value = response
        .json()
        .await
        .map_err(|_| (502, "Razorpay returned an unreadable response.".into()))?;
    if success {
        if let Some(id) = payload
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| is_razorpay_subscription_id(id))
        {
            return Ok(json!({
                "provider": "razorpay",
                "subscriptionId": id,
                "keyId": key_id,
                "shortUrl": payload.get("short_url").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    Err(provider_error("Razorpay", &payload))
}

fn provider_error(provider: &str, payload: &Value) -> (u16, String) {
    let detail = payload
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
                .or_else(|| error.get("description").and_then(Value::as_str))
        })
        .unwrap_or("the payment provider rejected the request");
    // Surface the provider's message without echoing credentials or payloads.
    (502, format!("{provider} checkout failed: {detail}"))
}

/// Verifies the `stripe-signature` header against the raw request body.
pub fn verify_stripe_signature(
    secret: &str,
    header: &str,
    raw_body: &[u8],
    now: i64,
) -> Result<(), String> {
    let mut timestamp = None;
    let mut signatures = Vec::new();
    for part in header.split(',') {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        match key.trim() {
            "t" => timestamp = value.trim().parse::<i64>().ok(),
            "v1" => signatures.push(value.trim().to_string()),
            _ => {}
        }
    }
    let Some(timestamp) = timestamp else {
        return Err("the Stripe signature is missing its timestamp".into());
    };
    // Stripe's `t` is seconds; callers pass a milliseconds clock.
    let timestamp_ms = timestamp
        .checked_mul(1000)
        .ok_or_else(|| "the Stripe signature timestamp is invalid".to_string())?;
    if (now - timestamp_ms).abs() > STRIPE_TIMESTAMP_TOLERANCE_MS {
        return Err("the Stripe signature is too old".into());
    }
    if signatures.is_empty() {
        return Err("the Stripe signature carries no v1 hash".into());
    }
    let expected = hmac_hex(secret, &format!("{timestamp}.").as_bytes(), raw_body);
    if signatures
        .iter()
        .any(|signature| constant_time_eq_hex(signature, &expected))
    {
        Ok(())
    } else {
        Err("the Stripe signature does not match the payload".into())
    }
}

/// Verifies the `X-Razorpay-Signature` header against the raw request body.
pub fn verify_razorpay_signature(
    secret: &str,
    signature: &str,
    raw_body: &[u8],
) -> Result<(), String> {
    let expected = hmac_hex(secret, b"", raw_body);
    if constant_time_eq_hex(signature.trim(), &expected) {
        Ok(())
    } else {
        Err("the Razorpay signature does not match the payload".into())
    }
}

pub fn verify_razorpay_checkout(
    config: &ProviderConfig,
    subscription_id: &str,
    payment_id: &str,
    signature: &str,
) -> Result<(), (u16, String)> {
    if !is_razorpay_subscription_id(subscription_id)
        || !payment_id.strip_prefix("pay_").is_some_and(|id| {
            !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_alphanumeric())
        })
    {
        return Err((400, "The payment confirmation is incomplete.".into()));
    }
    let secret = config
        .razorpay_key_secret
        .as_deref()
        .ok_or((503, "Razorpay billing is unavailable.".into()))?;
    verify_razorpay_signature(
        secret,
        signature,
        format!("{payment_id}|{subscription_id}").as_bytes(),
    )
    .map_err(|_| (400, "The payment confirmation signature is invalid.".into()))
}

fn hmac_hex(secret: &str, prefix: &[u8], body: &[u8]) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(prefix);
    mac.update(body);
    let digest = mac.finalize().into_bytes();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn constant_time_eq_hex(a: &str, b: &str) -> bool {
    let Ok(a) = hex_decode(a) else { return false };
    let Ok(b) = hex_decode(b) else { return false };
    a.len() == b.len() && a.ct_eq(&b).into()
}

fn hex_decode(value: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(2) || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("not a hex string".into());
    }
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

/// Maps a Razorpay subscription status onto the statuses this backend
/// understands. Only `active` grants the paid tier.
fn map_razorpay_status(status: &str) -> &'static str {
    match status {
        "active" => "active",
        "cancelled" | "completed" | "expired" => "canceled",
        "halted" => "halted",
        "pending" => "pending",
        "authenticated" | "created" => "incomplete",
        _ => "pending",
    }
}

/// Normalizes a Stripe event into `(event_type, event_id, subscription payload)`.
/// `checkout.session.completed` wraps a checkout session; the subscription
/// fields live one level down, so they are lifted into the same shape as
/// `customer.subscription.*` events.
pub fn parse_stripe_event(event: &Value) -> Result<(String, String, Value), String> {
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .ok_or("the Stripe event has no type")?
        .to_string();
    let event_id = event
        .get("id")
        .and_then(Value::as_str)
        .ok_or("the Stripe event has no id")?
        .to_string();
    let object = event
        .get("data")
        .and_then(|data| data.get("object"))
        .cloned()
        .ok_or("the Stripe event carries no object")?;
    if !matches!(
        event_type.as_str(),
        "checkout.session.completed"
            | "customer.subscription.created"
            | "customer.subscription.updated"
            | "customer.subscription.deleted"
    ) {
        return Ok((event_type, event_id, json!({})));
    }
    let payload = if event_type == "checkout.session.completed" {
        let subscription_id = object
            .get("subscription")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or("the completed Stripe checkout session has no subscription")?;
        let account_id = object
            .get("client_reference_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .or_else(|| {
                object
                    .get("metadata")
                    .and_then(|metadata| metadata.get("accountId"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
        json!({
            "id": subscription_id,
            "status": if object["payment_status"] == "paid" { "active" } else { "incomplete" },
            "customer_id": object.get("customer").cloned().unwrap_or(Value::Null),
            "metadata": {"accountId": account_id},
        })
    } else {
        object
    };
    Ok((event_type, event_id, payload))
}

pub fn razorpay_subscription_entity(event: &Value) -> Value {
    event
        .pointer("/payload/subscription/entity")
        .cloned()
        .unwrap_or_else(|| json!({}))
}

/// Applies one verified webhook event. Returns the JSON acknowledgement.
/// Unrecognized event types are acknowledged without effect so the provider
/// does not retry them forever.
pub async fn apply_webhook(
    store: &BillingStore,
    provider: &str,
    event_id: &str,
    payload: &Value,
) -> Result<Value, (u16, String)> {
    let (provider, event_id, payload) =
        (provider.to_string(), event_id.to_string(), payload.clone());
    store.query(move |db| {
        let tx = db.unchecked_transaction().map_err(store_error)?;
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO billing_events(provider,event_id,received_at) VALUES (?1,?2,?3)",
            params![provider, event_id, now_ms()],
        ).map_err(store_error)?;
        if inserted == 0 { return Ok(json!({"received":true,"duplicate":true})); }
        if let (Some(id), Some(status)) = (payload["id"].as_str(), payload["status"].as_str()) {
            let existing: Option<String> = tx.query_row(
                "SELECT account_id FROM subscriptions WHERE provider=?1 AND provider_subscription_id=?2",
                params![provider,id], |row| row.get(0),
            ).optional().map_err(store_error)?;
            let owner = existing.or_else(|| payload.pointer("/notes/accountId").or_else(|| payload.pointer("/metadata/accountId")).and_then(Value::as_str).map(str::to_string));
            let Some(owner) = owner else { return Err((503, "Subscription owner is not available yet. Retry the webhook.".into())); };
            BillingStore::write_subscription(&tx, &subscription_from_payload(&provider, owner, id, status, &payload))?;
        }
        tx.commit().map_err(store_error)?;
        Ok(json!({"received":true}))
    }).await
}

pub fn subscription_from_payload(
    provider: &str,
    account_id: String,
    subscription_id: &str,
    raw_status: &str,
    payload: &Value,
) -> Subscription {
    let status = if provider == "razorpay" {
        map_razorpay_status(raw_status).to_string()
    } else {
        raw_status.to_string()
    };
    let current_period_end = payload
        .get("current_period_end")
        .and_then(Value::as_i64)
        .or_else(|| payload.get("current_end").and_then(Value::as_i64))
        .and_then(|seconds| seconds.checked_mul(1000));
    Subscription {
        account_id,
        plan: "pro".into(),
        provider: provider.to_string(),
        provider_subscription_id: subscription_id.to_string(),
        customer_id: payload
            .get("customer_id")
            .or_else(|| payload.get("customer"))
            .and_then(Value::as_str)
            .map(str::to_string),
        status,
        currency: if provider == "razorpay" { "INR" } else { "USD" }.into(),
        amount_minor: if provider == "razorpay" {
            plans::PRO_MONTHLY_MINOR_INR as i64
        } else {
            plans::PRO_MONTHLY_MINOR_USD as i64
        },
        current_period_end,
    }
}

fn is_razorpay_subscription_id(value: &str) -> bool {
    value.strip_prefix("sub_").is_some_and(|rest| {
        (1..=32).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

pub async fn sync_razorpay_subscription(
    config: &ProviderConfig,
    store: &BillingStore,
    account_id: &str,
    subscription_id: &str,
) -> Result<(), (u16, String)> {
    let payload = fetch_razorpay_subscription(config, subscription_id).await?;
    apply_razorpay_snapshot(store, account_id, subscription_id, &payload).await
}

pub async fn fetch_razorpay_subscription(
    config: &ProviderConfig,
    subscription_id: &str,
) -> Result<Value, (u16, String)> {
    let (Some(key_id), Some(key_secret)) = (
        config.razorpay_key_id.as_deref(),
        config.razorpay_key_secret.as_deref(),
    ) else {
        return Err((
            503,
            "Razorpay billing is not configured on this backend.".into(),
        ));
    };
    if !is_razorpay_subscription_id(subscription_id) {
        return Err((400, "That is not a Razorpay subscription id.".into()));
    }
    let response = provider_client()?
        .get(format!(
            "{}/subscriptions/{subscription_id}",
            config.razorpay_api.as_deref().unwrap_or(RAZORPAY_API)
        ))
        .basic_auth(key_id, Some(key_secret))
        .send()
        .await
        .map_err(|_| (502, "Could not reach Razorpay. Please try again.".into()))?;
    if !response.status().is_success() {
        return Err((
            502,
            "Razorpay could not confirm the subscription. Please try again.".into(),
        ));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| (502, "Razorpay returned an unreadable response.".into()))?;
    if payload["id"].as_str() != Some(subscription_id) || payload["status"].as_str().is_none() {
        return Err((502, "Razorpay returned an unexpected subscription.".into()));
    }
    if config
        .razorpay_plan_inr
        .as_deref()
        .is_some_and(|plan| payload["plan_id"].as_str() != Some(plan))
    {
        return Err((
            400,
            "That subscription uses a different billing plan.".into(),
        ));
    }
    Ok(payload)
}

async fn apply_razorpay_snapshot(
    store: &BillingStore,
    account_id: &str,
    subscription_id: &str,
    payload: &Value,
) -> Result<(), (u16, String)> {
    let Some(raw_status) = payload
        .get("status")
        .and_then(Value::as_str)
        .filter(|_| payload.get("id").and_then(Value::as_str) == Some(subscription_id))
    else {
        return Err((502, "Razorpay returned an unexpected subscription.".into()));
    };
    let stored_owner = store
        .account_for_subscription("razorpay", subscription_id)
        .await;
    let owned = match stored_owner.as_deref() {
        Some(owner) => owner == account_id,
        None => payload.pointer("/notes/accountId").and_then(Value::as_str) == Some(account_id),
    };
    if !owned {
        return Err((
            404,
            "That subscription does not belong to this account.".into(),
        ));
    }
    store
        .apply_subscription(subscription_from_payload(
            "razorpay",
            account_id.to_string(),
            subscription_id,
            raw_status,
            payload,
        ))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn checkout_proof_is_bound_to_the_server_subscription_and_secret() {
        let config = ProviderConfig {
            razorpay_key_secret: Some("test-secret".into()),
            ..Default::default()
        };
        let signature = hmac_hex("test-secret", b"", b"pay_Test|sub_Test");
        assert!(verify_razorpay_checkout(&config, "sub_Test", "pay_Test", &signature).is_ok());
        assert!(verify_razorpay_checkout(&config, "sub_Other", "pay_Test", &signature).is_err());
        assert!(verify_razorpay_checkout(&config, "sub_Test", "pay_Other", &signature).is_err());
        assert!(verify_razorpay_checkout(&config, "sub_Test", "pay_Test", "bad").is_err());
    }

    #[tokio::test]
    async fn expired_subscriptions_do_not_keep_pro_and_cloud_downgrades_clear_the_cache() {
        let store = scratch();
        let mut expired = subscription("active");
        expired.current_period_end = Some(now_ms() - 1);
        store.apply_subscription(expired.clone()).await.unwrap();
        assert_eq!(tier_for(Some(&expired)), "free");
        assert!(store.active_subscription("acc-1").await.is_none());
        let paid = subscription("active");
        store.cache_subscription("acc-1", Some(paid)).await.unwrap();
        assert!(store.active_subscription("acc-1").await.is_some());
        store.cache_subscription("acc-1", None).await.unwrap();
        assert!(store.active_subscription("acc-1").await.is_none());
    }

    #[tokio::test]
    async fn unmatched_webhooks_and_storage_failures_remain_retryable() {
        let store = scratch();
        let orphan = json!({"id":"sub_Orphan","status":"active"});
        assert_eq!(
            apply_webhook(&store, "razorpay", "evt_orphan", &orphan)
                .await
                .unwrap_err()
                .0,
            503
        );
        assert!(store.unmirrored_events().await.unwrap().is_empty());
        let matched = json!({"id":"sub_Orphan","status":"active","notes":{"accountId":"acc-1"}});
        apply_webhook(&store, "razorpay", "evt_orphan", &matched)
            .await
            .unwrap();
        assert!(store.active_subscription("acc-1").await.is_some());
        store
            .db
            .lock()
            .unwrap()
            .execute_batch("DROP TABLE billing_events")
            .unwrap();
        assert_eq!(
            apply_webhook(&store, "razorpay", "evt_new", &matched)
                .await
                .unwrap_err()
                .0,
            503
        );
    }

    #[tokio::test]
    async fn a_restored_subscription_can_sync_on_a_new_installation_without_changing_owners() {
        let store = scratch();
        let mut restored = subscription_from_payload(
            "razorpay",
            "new-local-account".into(),
            "sub_Restored",
            "active",
            &json!({}),
        );
        restored.current_period_end = Some(now_ms() + 60000);
        store.apply_subscription(restored).await.unwrap();
        let snapshot = json!({"id":"sub_Restored","status":"active","notes":{"accountId":"old-local-account"}});
        apply_razorpay_snapshot(&store, "new-local-account", "sub_Restored", &snapshot)
            .await
            .unwrap();
        assert_eq!(
            apply_razorpay_snapshot(&store, "intruder", "sub_Restored", &snapshot)
                .await
                .unwrap_err()
                .0,
            404
        );
        assert!(store
            .active_subscription("new-local-account")
            .await
            .is_some());
        assert!(store.active_subscription("intruder").await.is_none());
    }

    #[test]
    fn unpaid_stripe_checkouts_and_unrelated_events_do_not_grant_pro() {
        let event = json!({"id":"evt_x","type":"checkout.session.completed","data":{"object":{"subscription":"sub_x","client_reference_id":"acc-1","payment_status":"unpaid"}}});
        assert_eq!(
            parse_stripe_event(&event).unwrap().2["status"],
            "incomplete"
        );
        let unrelated = json!({"id":"evt_x","type":"invoice.paid","data":{"object":{"id":"in_x","status":"active","metadata":{"accountId":"acc-1"}}}});
        assert_eq!(parse_stripe_event(&unrelated).unwrap().2, json!({}));
    }

    fn scratch() -> BillingStore {
        let path = std::env::temp_dir().join(format!("kesami-billing-test-{}", Uuid::new_v4()));
        BillingStore::open(path).expect("temporary billing store")
    }

    fn subscription(status: &str) -> Subscription {
        // One stable provider id: re-apply with a new status must update the
        // same row, not create a second subscription.
        Subscription {
            account_id: "acc-1".into(),
            plan: "pro".into(),
            provider: "stripe".into(),
            provider_subscription_id: "sub_stripe_fixed".into(),
            customer_id: Some("cus_1".into()),
            status: status.into(),
            currency: "USD".into(),
            amount_minor: plans::PRO_MONTHLY_MINOR_USD as i64,
            current_period_end: None,
        }
    }

    #[tokio::test]
    async fn free_ai_allowance_is_shared_idempotent_and_releasable() {
        let store = scratch();
        assert_eq!(store.free_ai_uses().await.unwrap(), 0);
        for key in ["summary:auto:one", "chat:thread:one", "summary:manual:two"] {
            assert!(store.reserve_free_ai_use(key.into()).await.unwrap());
        }
        assert_eq!(
            store.free_ai_uses().await.unwrap(),
            plans::FREE_MONTHLY_AI_USES
        );
        assert!(!store
            .reserve_free_ai_use("chat:thread:extra".into())
            .await
            .unwrap());
        assert!(store
            .reserve_free_ai_use("chat:thread:one".into())
            .await
            .unwrap());
        store.release_free_ai_use("chat:thread:one".into()).await;
        assert_eq!(store.free_ai_uses().await.unwrap(), 2);
        assert!(store
            .reserve_free_ai_use("chat:thread:extra".into())
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn only_an_active_pro_subscription_grants_the_paid_tier() {
        let store = scratch();
        assert_eq!(
            tier_for(store.active_subscription("acc-1").await.as_ref()),
            "free"
        );
        store
            .apply_subscription(subscription("active"))
            .await
            .unwrap();
        assert_eq!(
            tier_for(store.active_subscription("acc-1").await.as_ref()),
            "pro"
        );
        store
            .apply_subscription(subscription("canceled"))
            .await
            .unwrap();
        assert_eq!(
            tier_for(store.active_subscription("acc-1").await.as_ref()),
            "free"
        );
    }

    #[tokio::test]
    async fn webhook_events_are_applied_exactly_once() {
        let store = scratch();
        let payload = json!({
            "id": "sub_razorpay1",
            "status": "active",
            "notes": {"accountId": "acc-2"},
            "current_end": 1_800_000_000i64,
        });
        apply_webhook(&store, "razorpay", "evt_1", &payload)
            .await
            .unwrap();
        // The provider retries the same event id: acknowledged, not re-applied.
        apply_webhook(&store, "razorpay", "evt_1", &payload)
            .await
            .unwrap();
        let sub = store.active_subscription("acc-2").await.expect("active");
        assert_eq!(sub.status, "active");
        assert_eq!(sub.currency, "INR");
        assert_eq!(sub.current_period_end, Some(1_800_000_000_000));
    }

    #[tokio::test]
    async fn razorpay_statuses_map_onto_entitlement_statuses() {
        assert_eq!(map_razorpay_status("active"), "active");
        assert_eq!(map_razorpay_status("activated"), "pending");
        assert_eq!(map_razorpay_status("expired"), "canceled");
        assert_eq!(map_razorpay_status("cancelled"), "canceled");
        assert_eq!(map_razorpay_status("halted"), "halted");
        assert_eq!(map_razorpay_status("pending"), "pending");
        assert_eq!(map_razorpay_status("authenticated"), "incomplete");
        assert_eq!(map_razorpay_status("created"), "incomplete");
    }

    fn razorpay_entity(status: &str) -> Value {
        json!({"id": "sub_Order1", "status": status, "notes": {"accountId": "acc-order"}})
    }

    #[tokio::test]
    async fn a_real_razorpay_activation_webhook_grants_pro() {
        let store = scratch();
        let event = json!({
            "entity": "event",
            "event": "subscription.activated",
            "contains": ["subscription"],
            "payload": {"subscription": {"entity": {
                "id": "sub_E2eTest0001",
                "entity": "subscription",
                "plan_id": "plan_fake",
                "customer_id": "cust_E2e",
                "status": "active",
                "current_end": 1_800_000_000i64,
                "notes": {"accountId": "acc-real", "email": "e2e@example.com"},
            }}},
            "created_at": 1_790_000_000i64,
        });
        let payload = razorpay_subscription_entity(&event);
        apply_webhook(&store, "razorpay", "evt_real", &payload)
            .await
            .unwrap();
        let sub = store.active_subscription("acc-real").await.expect("active");
        assert_eq!(tier_for(Some(&sub)), "pro");
        assert_eq!(sub.customer_id.as_deref(), Some("cust_E2e"));
        assert_eq!(
            razorpay_subscription_entity(&json!({"event": "payment.captured"})),
            json!({})
        );
    }

    #[tokio::test]
    async fn a_late_authentication_event_never_revokes_an_active_subscription() {
        let store = scratch();
        apply_webhook(&store, "razorpay", "evt_act", &razorpay_entity("active"))
            .await
            .unwrap();
        apply_webhook(
            &store,
            "razorpay",
            "evt_auth",
            &razorpay_entity("authenticated"),
        )
        .await
        .unwrap();
        assert_eq!(
            tier_for(store.active_subscription("acc-order").await.as_ref()),
            "pro"
        );
    }

    #[tokio::test]
    async fn a_stale_charge_never_revives_a_cancelled_subscription() {
        let store = scratch();
        apply_webhook(&store, "razorpay", "evt_act", &razorpay_entity("active"))
            .await
            .unwrap();
        apply_webhook(
            &store,
            "razorpay",
            "evt_cancel",
            &razorpay_entity("cancelled"),
        )
        .await
        .unwrap();
        apply_webhook(&store, "razorpay", "evt_charge", &razorpay_entity("active"))
            .await
            .unwrap();
        assert_eq!(
            tier_for(store.active_subscription("acc-order").await.as_ref()),
            "free"
        );
    }

    #[tokio::test]
    async fn a_failed_charge_after_activation_still_suspends_the_paid_tier() {
        let store = scratch();
        apply_webhook(&store, "razorpay", "evt_act", &razorpay_entity("active"))
            .await
            .unwrap();
        apply_webhook(
            &store,
            "razorpay",
            "evt_pending",
            &razorpay_entity("pending"),
        )
        .await
        .unwrap();
        assert_eq!(
            tier_for(store.active_subscription("acc-order").await.as_ref()),
            "free"
        );
        apply_webhook(
            &store,
            "razorpay",
            "evt_charged",
            &razorpay_entity("active"),
        )
        .await
        .unwrap();
        assert_eq!(
            tier_for(store.active_subscription("acc-order").await.as_ref()),
            "pro"
        );
    }

    #[tokio::test]
    async fn an_event_that_fails_to_apply_is_left_for_the_provider_retry() {
        let store = scratch();
        store
            .db
            .lock()
            .unwrap()
            .execute_batch("DROP TABLE subscriptions")
            .unwrap();
        assert!(
            apply_webhook(&store, "razorpay", "evt_retry", &razorpay_entity("active"))
                .await
                .is_err()
        );
        assert!(store.record_event("razorpay", "evt_retry").await.unwrap());
    }

    #[tokio::test]
    async fn a_razorpay_snapshot_grants_pro_only_to_the_subscribing_account() {
        let store = scratch();
        let entity = json!({"id": "sub_Snap1", "status": "active", "notes": {"accountId": "acc-owner"}, "current_end": 1_800_000_000i64});
        let (status, _) = apply_razorpay_snapshot(&store, "acc-other", "sub_Snap1", &entity)
            .await
            .unwrap_err();
        assert_eq!(status, 404);
        assert_eq!(
            tier_for(store.active_subscription("acc-other").await.as_ref()),
            "free"
        );
        assert!(
            apply_razorpay_snapshot(&store, "acc-owner", "sub_Other", &entity)
                .await
                .is_err()
        );
        apply_razorpay_snapshot(&store, "acc-owner", "sub_Snap1", &entity)
            .await
            .unwrap();
        let sub = store
            .active_subscription("acc-owner")
            .await
            .expect("synced");
        assert_eq!(sub.currency, "INR");
        assert_eq!(sub.current_period_end, Some(1_800_000_000_000));
    }

    #[tokio::test]
    async fn every_new_event_and_subscription_change_waits_to_be_mirrored() {
        let store = scratch();
        apply_webhook(&store, "razorpay", "evt_act", &razorpay_entity("active"))
            .await
            .unwrap();
        let events = store.unmirrored_events().await.unwrap();
        assert_eq!(
            events
                .iter()
                .map(|(_, id, _)| id.as_str())
                .collect::<Vec<_>>(),
            ["evt_act"]
        );
        let pending = store.unmirrored_subscriptions().await.unwrap();
        assert_eq!(pending.len(), 1);
        let (subscription, updated_at) = &pending[0];
        assert_eq!(subscription.status, "active");

        store
            .mark_event_mirrored("razorpay", "evt_act")
            .await
            .unwrap();
        store
            .mark_subscription_mirrored(&subscription.provider_subscription_id, updated_at - 1)
            .await
            .unwrap();
        assert_eq!(store.unmirrored_subscriptions().await.unwrap().len(), 1);
        store
            .mark_subscription_mirrored(&subscription.provider_subscription_id, *updated_at)
            .await
            .unwrap();
        assert!(store.unmirrored_events().await.unwrap().is_empty());
        assert!(store.unmirrored_subscriptions().await.unwrap().is_empty());

        apply_webhook(
            &store,
            "razorpay",
            "evt_stale",
            &razorpay_entity("authenticated"),
        )
        .await
        .unwrap();
        assert!(store.unmirrored_subscriptions().await.unwrap().is_empty());
        assert_eq!(store.unmirrored_events().await.unwrap().len(), 1);

        apply_webhook(
            &store,
            "razorpay",
            "evt_cancel",
            &razorpay_entity("cancelled"),
        )
        .await
        .unwrap();
        let pending = store.unmirrored_subscriptions().await.unwrap();
        assert_eq!(
            pending
                .iter()
                .map(|(sub, _)| sub.status.as_str())
                .collect::<Vec<_>>(),
            ["canceled"]
        );
    }

    #[test]
    fn a_billing_database_from_before_mirroring_is_upgraded_in_place() {
        let path = std::env::temp_dir().join(format!("kesami-billing-legacy-{}", Uuid::new_v4()));
        let legacy = Connection::open(&path).unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE subscriptions (
                    provider_subscription_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, plan TEXT NOT NULL,
                    provider TEXT NOT NULL, customer_id TEXT, status TEXT NOT NULL, currency TEXT NOT NULL,
                    amount_minor INTEGER NOT NULL, current_period_end INTEGER, updated_at INTEGER NOT NULL);
                CREATE TABLE billing_events (provider TEXT NOT NULL, event_id TEXT NOT NULL,
                    received_at INTEGER NOT NULL, PRIMARY KEY (provider, event_id));
                INSERT INTO subscriptions VALUES ('sub_Legacy1','acc-legacy','pro','razorpay',NULL,'active','INR',59900,NULL,1);
                INSERT INTO billing_events VALUES ('razorpay','evt_legacy',1);",
            )
            .unwrap();
        drop(legacy);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let store = BillingStore::open(path.clone()).unwrap();
            assert_eq!(store.unmirrored_subscriptions().await.unwrap().len(), 1);
            assert_eq!(store.unmirrored_events().await.unwrap().len(), 1);
            assert_eq!(
                tier_for(store.active_subscription("acc-legacy").await.as_ref()),
                "pro"
            );
        });
        drop(BillingStore::open(path.clone()).unwrap());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn only_well_formed_razorpay_subscription_ids_reach_the_provider_url() {
        assert!(is_razorpay_subscription_id("sub_NYDbmFzLTAFR4Q"));
        assert!(!is_razorpay_subscription_id("sub_"));
        assert!(!is_razorpay_subscription_id("sub_../plans"));
        assert!(!is_razorpay_subscription_id("plan_NYDbmFzLTAFR4Q"));
        assert!(!is_razorpay_subscription_id(""));
    }

    #[test]
    fn a_completed_stripe_checkout_lifts_the_subscription_fields() {
        let event = json!({
            "id": "evt_checkout_1",
            "type": "checkout.session.completed",
            "data": {"object": {
                "id": "cs_test_1",
                "subscription": "sub_stripe_1",
                "client_reference_id": "acc-stripe",
                "customer": "cus_stripe_1",
                "status": "complete",
                "payment_status": "paid",
            }},
        });
        let (event_type, event_id, payload) = parse_stripe_event(&event).unwrap();
        assert_eq!(event_type, "checkout.session.completed");
        assert_eq!(event_id, "evt_checkout_1");
        assert_eq!(payload["id"], "sub_stripe_1");
        assert_eq!(payload["status"], "active");
        assert_eq!(payload["customer_id"], "cus_stripe_1");
        assert_eq!(payload["metadata"]["accountId"], "acc-stripe");
    }

    #[test]
    fn subscription_events_pass_through_with_their_own_shape() {
        let event = json!({
            "id": "evt_sub_1",
            "type": "customer.subscription.updated",
            "data": {"object": {
                "id": "sub_stripe_1",
                "status": "past_due",
                "current_period_end": 1_800_000_000i64,
                "metadata": {"accountId": "acc-stripe"},
            }},
        });
        let (event_type, _, payload) = parse_stripe_event(&event).unwrap();
        assert_eq!(event_type, "customer.subscription.updated");
        assert_eq!(payload["id"], "sub_stripe_1");
        assert_eq!(payload["status"], "past_due");
        assert_eq!(payload["current_period_end"], 1_800_000_000i64);
        assert!(parse_stripe_event(&json!({"id": "evt_x"})).is_err());
    }

    #[tokio::test]
    async fn a_stripe_cancellation_event_deactivates_the_subscription() {
        let store = scratch();
        let activated =
            json!({"id": "sub_stripe_x", "status": "active", "metadata": {"accountId": "acc-3"}});
        apply_webhook(&store, "stripe", "evt_a", &activated)
            .await
            .unwrap();
        assert_eq!(
            tier_for(store.active_subscription("acc-3").await.as_ref()),
            "pro"
        );
        let cancelled =
            json!({"id": "sub_stripe_x", "status": "canceled", "metadata": {"accountId": "acc-3"}});
        apply_webhook(&store, "stripe", "evt_b", &cancelled)
            .await
            .unwrap();
        assert_eq!(
            tier_for(store.active_subscription("acc-3").await.as_ref()),
            "free"
        );
    }

    #[test]
    fn stripe_signatures_reject_replays_and_tampering() {
        let secret = "whsec_test";
        let body = br#"{"id":"evt_1"}"#;
        let now = 1_700_000_000_000i64;
        let timestamp = now / 1000;
        let good = hmac_hex(secret, format!("{timestamp}.").as_bytes(), body);
        let header = format!("t={timestamp},v1={good}");
        assert!(verify_stripe_signature(secret, &header, body, now).is_ok());

        let tampered = br#"{"id":"evt_2"}"#;
        assert!(verify_stripe_signature(secret, &header, tampered, now).is_err());
        assert!(verify_stripe_signature("whsec_other", &header, body, now).is_err());

        let stale = format!("t={},v1={good}", timestamp - 600);
        assert!(verify_stripe_signature(secret, &stale, body, now).is_err());
        assert!(verify_stripe_signature(secret, "v1=deadbeef", body, now).is_err());
        assert!(verify_stripe_signature(
            secret,
            &format!("t={timestamp},v1=zz,v1={good}"),
            body,
            now
        )
        .is_ok());
    }

    #[test]
    fn razorpay_signatures_verify_the_raw_body() {
        let secret = "rzp_webhook_secret";
        let body = br#"{"event":"subscription.activated"}"#;
        let good = hmac_hex(secret, b"", body);
        assert!(verify_razorpay_signature(secret, &good, body).is_ok());
        // Hex digits are case-insensitive; any other difference is rejected.
        assert!(verify_razorpay_signature(secret, "00", body).is_err());
        assert!(verify_razorpay_signature(secret, &hmac_hex(secret, b"", b"other"), body).is_err());
        assert!(verify_razorpay_signature("other_secret", &good, body).is_err());
    }

    #[test]
    fn provider_status_never_leaks_secret_material() {
        let config = ProviderConfig {
            stripe_secret_key: Some("sk_live_dont_leak".into()),
            stripe_price_usd: Some("price_1".into()),
            stripe_webhook_secret: Some("whsec_dont_leak".into()),
            ..Default::default()
        };
        let status = config.public_status().to_string();
        assert!(config.billing_enabled());
        assert!(config.stripe_ready());
        assert!(!config.razorpay_ready());
        assert!(!status.contains("sk_live"));
        assert!(!status.contains("whsec"));
    }

    #[test]
    fn razorpay_checkout_requires_a_webhook_for_subscription_activation() {
        let mut config = ProviderConfig {
            razorpay_key_id: Some("rzp_test_public".into()),
            razorpay_key_secret: Some("private_test_secret".into()),
            razorpay_plan_inr: Some("plan_test".into()),
            ..Default::default()
        };
        assert!(!config.razorpay_ready());
        config.razorpay_webhook_secret = Some("webhook_test_secret".into());
        assert!(config.razorpay_ready());
    }
}
