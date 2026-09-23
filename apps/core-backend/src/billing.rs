//! Subscription billing. Stripe Checkout serves the global/USD price and
//! Razorpay Subscriptions the India/INR price. Publishing a price never
//! grants an entitlement: a paid tier is granted only when a
//! signature-verified provider webhook reports an active subscription, and
//! every webhook event is applied at most once.
use crate::plans;
use crate::settings::data_dir;
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
}

impl ProviderConfig {
    pub fn from_env() -> Self {
        let var = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        Self {
            stripe_secret_key: var("ALPHA_STRIPE_SECRET_KEY"),
            stripe_price_usd: var("ALPHA_STRIPE_PRICE_USD"),
            stripe_webhook_secret: var("ALPHA_STRIPE_WEBHOOK_SECRET"),
            razorpay_key_id: var("ALPHA_RAZORPAY_KEY_ID"),
            razorpay_key_secret: var("ALPHA_RAZORPAY_KEY_SECRET"),
            razorpay_plan_inr: var("ALPHA_RAZORPAY_PLAN_INR"),
            razorpay_webhook_secret: var("ALPHA_RAZORPAY_WEBHOOK_SECRET"),
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn store_error(_: impl std::fmt::Display) -> (u16, String) {
    (
        503,
        "Billing storage is unavailable. Please try again.".into(),
    )
}

impl BillingStore {
    pub async fn load() -> io::Result<Self> {
        let path = data_dir().join("billing.sqlite3");
        spawn_blocking(|| Self::open(path))
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
            );",
        )
        .map_err(io::Error::other)?;
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
                     WHERE account_id=?1 AND status='active'
                     ORDER BY updated_at DESC LIMIT 1",
                    Self::SUBSCRIPTION_COLUMNS
                ),
                params![account_id],
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
    pub async fn apply_subscription(&self, subscription: Subscription) -> Result<(), (u16, String)> {
        let updated_at = now_ms();
        self.query(move |db| {
            db.execute(
                "INSERT INTO subscriptions (
                    account_id, plan, provider, provider_subscription_id, customer_id,
                    status, currency, amount_minor, current_period_end, updated_at
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
                ON CONFLICT(provider_subscription_id) DO UPDATE SET
                    account_id=excluded.account_id,
                    plan=excluded.plan,
                    customer_id=COALESCE(excluded.customer_id, subscriptions.customer_id),
                    status=excluded.status,
                    current_period_end=COALESCE(excluded.current_period_end, subscriptions.current_period_end),
                    updated_at=excluded.updated_at",
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
        })
        .await
    }

    /// Records a provider event id. Returns false when the event was already
    /// processed, so webhook retries never double-apply.
    pub async fn record_event(&self, provider: &str, event_id: &str) -> bool {
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
        .unwrap_or(false)
    }

    pub fn subscription_value(subscription: &Subscription) -> Value {
        json!({
            "plan": subscription.plan,
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
        Some(subscription) if subscription.status == "active" && subscription.plan == "pro" => "pro",
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

async fn stripe_checkout(
    config: &ProviderConfig,
    account_id: &str,
    account_email: &str,
    origin: &str,
) -> Result<Value, (u16, String)> {
    let (Some(secret_key), Some(price_id), _) = (
        config.stripe_secret_key.as_deref(),
        config.stripe_price_usd.as_deref(),
        config.stripe_webhook_secret.as_deref(),
    ) else {
        return Err((503, "Stripe billing is not configured on this backend.".into()));
    };
    let base = origin.trim_end_matches('/');
    let form = [
        ("mode", "subscription"),
        ("line_items[0][price]", price_id),
        ("line_items[0][quantity]", "1"),
        ("client_reference_id", account_id),
        ("customer_email", account_email),
        ("metadata[accountId]", account_id),
        ("success_url", &format!("{base}/?billing=success")),
        ("cancel_url", &format!("{base}/?billing=cancelled")),
    ];
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| (503, "Could not reach the payment provider.".into()))?;
    let response = client
        .post(format!("{STRIPE_API}/checkout/sessions"))
        .bearer_auth(secret_key)
        .form(&form)
        .send()
        .await
        .map_err(|_| (502, "Could not reach Stripe. Please try again.".into()))?;
    let payload: Value = response
        .json()
        .await
        .map_err(|_| (502, "Stripe returned an unreadable response.".into()))?;
    if let Some(url) = payload.get("url").and_then(Value::as_str) {
        return Ok(json!({"provider": "stripe", "checkoutUrl": url}));
    }
    Err(provider_error("Stripe", &payload))
}

async fn razorpay_checkout(
    config: &ProviderConfig,
    account_id: &str,
    account_email: &str,
) -> Result<Value, (u16, String)> {
    let (Some(key_id), Some(key_secret), Some(plan_id)) = (
        config.razorpay_key_id.as_deref(),
        config.razorpay_key_secret.as_deref(),
        config.razorpay_plan_inr.as_deref(),
    ) else {
        return Err((503, "Razorpay billing is not configured on this backend.".into()));
    };
    let body = json!({
        "plan_id": plan_id,
        "quantity": 1,
        "total_count": 12,
        "customer_notify": 1,
        "notes": {"accountId": account_id, "email": account_email},
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| (503, "Could not reach the payment provider.".into()))?;
    let response = client
        .post(format!("{RAZORPAY_API}/subscriptions"))
        .basic_auth(key_id, Some(key_secret))
        .json(&body)
        .send()
        .await
        .map_err(|_| (502, "Could not reach Razorpay. Please try again.".into()))?;
    let payload: Value = response
        .json()
        .await
        .map_err(|_| (502, "Razorpay returned an unreadable response.".into()))?;
    if let Some(id) = payload.get("id").and_then(Value::as_str) {
        return Ok(json!({
            "provider": "razorpay",
            "subscriptionId": id,
            "keyId": key_id,
            "shortUrl": payload.get("short_url").cloned().unwrap_or(Value::Null),
        }));
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
pub fn verify_razorpay_signature(secret: &str, signature: &str, raw_body: &[u8]) -> Result<(), String> {
    let expected = hmac_hex(secret, b"", raw_body);
    if constant_time_eq_hex(signature.trim(), &expected) {
        Ok(())
    } else {
        Err("the Razorpay signature does not match the payload".into())
    }
}

fn hmac_hex(secret: &str, prefix: &[u8], body: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts any key length");
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
        "activated" | "charged" | "resumed" => "active",
        "cancelled" | "completed" => "canceled",
        "halted" => "halted",
        "pending" | "authenticated" | "created" => "pending",
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
            "status": "active",
            "customer_id": object.get("customer").cloned().unwrap_or(Value::Null),
            "metadata": {"accountId": account_id},
        })
    } else {
        object
    };
    Ok((event_type, event_id, payload))
}

/// Applies one verified webhook event. Returns the JSON acknowledgement.
/// Unrecognized event types are acknowledged without effect so the provider
/// does not retry them forever.
pub async fn apply_webhook(
    store: &BillingStore,
    provider: &str,
    event_type: &str,
    event_id: &str,
    payload: &Value,
) -> Result<Value, (u16, String)> {
    if !store.record_event(provider, event_id).await {
        return Ok(json!({"received": true, "duplicate": true}));
    }
    let (Some(subscription_id), Some(raw_status)) = (
        payload.get("id").and_then(Value::as_str),
        payload.get("status").and_then(Value::as_str),
    ) else {
        return Ok(json!({"received": true}));
    };
    let status = if provider == "razorpay" {
        map_razorpay_status(raw_status).to_string()
    } else {
        raw_status.to_string()
    };
    let account_id = payload
        .get("notes")
        .and_then(|notes| notes.get("accountId"))
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .get("metadata")
                .and_then(|metadata| metadata.get("accountId"))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
        .or_else(|| {
            // Without an account reference (or before checkout completes for
            // it), an existing row is the only other way to find the account.
            // Futures that reference neither are dropped until one arrives.
            None
        });
    let account_id = match account_id {
        Some(account_id) => account_id,
        None => match store.account_for_subscription(provider, subscription_id).await {
            Some(account_id) => account_id,
            None => return Ok(json!({"received": true, "unmatched": true})),
        },
    };
    let current_period_end = payload
        .get("current_period_end")
        .and_then(Value::as_i64)
        .or_else(|| payload.get("current_end").and_then(Value::as_i64))
        .map(|seconds| seconds * 1000);
    store
        .apply_subscription(Subscription {
            account_id,
            plan: "pro".into(),
            provider: provider.to_string(),
            provider_subscription_id: subscription_id.to_string(),
            customer_id: payload
                .get("customer_id")
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
        })
        .await?;
    let _ = event_type;
    Ok(json!({"received": true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn scratch() -> BillingStore {
        let path = std::env::temp_dir().join(format!("alpha-billing-test-{}", Uuid::new_v4()));
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
    async fn only_an_active_pro_subscription_grants_the_paid_tier() {
        let store = scratch();
        assert_eq!(tier_for(store.active_subscription("acc-1").await.as_ref()), "free");
        store.apply_subscription(subscription("active")).await.unwrap();
        assert_eq!(tier_for(store.active_subscription("acc-1").await.as_ref()), "pro");
        store.apply_subscription(subscription("canceled")).await.unwrap();
        assert_eq!(tier_for(store.active_subscription("acc-1").await.as_ref()), "free");
    }

    #[tokio::test]
    async fn webhook_events_are_applied_exactly_once() {
        let store = scratch();
        let payload = json!({
            "id": "sub_razorpay1",
            "status": "activated",
            "notes": {"accountId": "acc-2"},
            "current_end": 1_800_000_000i64,
        });
        apply_webhook(&store, "razorpay", "subscription.activated", "evt_1", &payload).await.unwrap();
        // The provider retries the same event id: acknowledged, not re-applied.
        apply_webhook(&store, "razorpay", "subscription.activated", "evt_1", &payload).await.unwrap();
        let sub = store.active_subscription("acc-2").await.expect("activated");
        assert_eq!(sub.status, "active");
        assert_eq!(sub.currency, "INR");
        assert_eq!(sub.current_period_end, Some(1_800_000_000_000));
    }

    #[tokio::test]
    async fn razorpay_statuses_map_onto_entitlement_statuses() {
        assert_eq!(map_razorpay_status("activated"), "active");
        assert_eq!(map_razorpay_status("charged"), "active");
        assert_eq!(map_razorpay_status("cancelled"), "canceled");
        assert_eq!(map_razorpay_status("halted"), "halted");
        assert_eq!(map_razorpay_status("pending"), "pending");
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
        let activated = json!({"id": "sub_stripe_x", "status": "active", "metadata": {"accountId": "acc-3"}});
        apply_webhook(&store, "stripe", "customer.subscription.created", "evt_a", &activated).await.unwrap();
        assert_eq!(tier_for(store.active_subscription("acc-3").await.as_ref()), "pro");
        let cancelled = json!({"id": "sub_stripe_x", "status": "canceled", "metadata": {"accountId": "acc-3"}});
        apply_webhook(&store, "stripe", "customer.subscription.deleted", "evt_b", &cancelled).await.unwrap();
        assert_eq!(tier_for(store.active_subscription("acc-3").await.as_ref()), "free");
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
        assert!(verify_stripe_signature(secret, &format!("t={timestamp},v1=zz,v1={good}"), body, now).is_ok());
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
}
