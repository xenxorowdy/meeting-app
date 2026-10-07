//! Billing endpoints on the hosted relay. All writes follow server-verified provider state.
use super::*;
use kesami_core_backend::{
    billing::{self, ProviderConfig, Subscription},
    billing_db, plans,
};
use sqlx::postgres::PgPool;

pub struct Billing {
    pub config: ProviderConfig,
    pub pool: Option<PgPool>,
    pub checkout_lock: tokio::sync::Mutex<()>,
}

impl Billing {
    pub fn from_env() -> Self {
        Self {
            config: ProviderConfig::from_env(),
            pool: billing_db::configured_pool(),
            checkout_lock: tokio::sync::Mutex::new(()),
        }
    }
    fn available_config(&self) -> ProviderConfig {
        if self.pool.is_some() {
            self.config.clone()
        } else {
            ProviderConfig::default()
        }
    }
}

impl Relay {
    pub async fn billing_request(&self, req: Request<Incoming>) -> Response<Body> {
        match self.billing_response(req).await {
            Ok(value) => json_response(StatusCode::OK, value),
            Err((code, message)) => error(
                StatusCode::from_u16(code).unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
                &message,
            ),
        }
    }

    async fn billing_response(&self, req: Request<Incoming>) -> Result<Value, (u16, String)> {
        let path = req.uri().path().to_string();
        if req.method() == Method::GET && path == "/v1/plans" {
            if let Some(pool) = self.billing.pool.as_ref() {
                sqlx::query("SELECT provider_subscription_id FROM public.billing LIMIT 0")
                    .persistent(false)
                    .execute(pool)
                    .await
                    .map_err(|_| storage_unavailable())?;
            }
            let config = self.billing.available_config();
            let mut catalog = plans::catalog_for(config.billing_enabled(), true);
            catalog["billing"] = config.public_status();
            return Ok(catalog);
        }
        let pool = self.billing.pool.as_ref().ok_or_else(storage_unavailable)?;
        if path.starts_with("/v1/billing/webhook/") {
            let provider = path.rsplit('/').next().unwrap_or_default();
            let header = if provider == "razorpay" {
                "x-razorpay-signature"
            } else {
                "stripe-signature"
            };
            let signature = req
                .headers()
                .get(header)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string();
            let event_id = req
                .headers()
                .get("x-razorpay-event-id")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string();
            let bytes = limited_body(req).await?;
            let secret = if provider == "razorpay" {
                self.billing.config.razorpay_webhook_secret.as_deref()
            } else {
                self.billing.config.stripe_webhook_secret.as_deref()
            }
            .ok_or((503, "Payment webhooks are not configured.".into()))?;
            if provider == "razorpay" {
                billing::verify_razorpay_signature(secret, &signature, &bytes)
                    .map_err(|message| (400, message))?;
                if event_id.is_empty() {
                    return Err((400, "The webhook has no event id.".into()));
                }
            } else {
                billing::verify_stripe_signature(
                    secret,
                    &signature,
                    &bytes,
                    chrono::Utc::now().timestamp_millis(),
                )
                .map_err(|message| (400, message))?;
            }
            let event: Value = serde_json::from_slice(&bytes)
                .map_err(|_| (400, "Invalid webhook JSON.".into()))?;
            let _mutation_lock = self.billing.checkout_lock.lock().await;
            let (event_id, payload) = if provider == "razorpay" {
                if !event["event"]
                    .as_str()
                    .is_some_and(|name| name.starts_with("subscription."))
                {
                    return Ok(json!({"received":true}));
                }
                let id = event
                    .pointer("/payload/subscription/entity/id")
                    .and_then(Value::as_str)
                    .ok_or((400, "The webhook has no subscription.".into()))?;
                // Delayed and reordered events never replace the provider's current state.
                (
                    event_id,
                    billing::fetch_razorpay_subscription(&self.billing.config, id).await?,
                )
            } else {
                let (_, id, payload) =
                    billing::parse_stripe_event(&event).map_err(|message| (400, message))?;
                (id, payload)
            };
            let Some(id) = payload["id"].as_str() else {
                return Ok(json!({"received":true}));
            };
            let existing = billing_db::by_id(pool, provider, id)
                .await
                .map_err(|_| storage_unavailable())?;
            let user = existing
                .as_ref()
                .map(|sub| sub.account_id.as_str())
                .or_else(|| {
                    payload
                        .pointer("/notes/accountId")
                        .or_else(|| payload.pointer("/metadata/accountId"))
                        .and_then(Value::as_str)
                })
                .ok_or((
                    503,
                    "The subscription owner is not available yet. Retry the webhook.".into(),
                ))?;
            let status = payload["status"]
                .as_str()
                .ok_or((400, "The webhook has no subscription status.".into()))?;
            let sub = billing::subscription_from_payload(
                provider,
                user.to_string(),
                id,
                status,
                &payload,
            );
            billing_db::save_subscription(pool, user, &sub, Some((provider, &event_id)))
                .await
                .map_err(|_| storage_unavailable())?;
            return Ok(json!({"received":true,"accountSynced":true}));
        }
        let user = self
            .identity(req.headers())
            .await
            .map_err(|_| (503, "Sign-in service unavailable.".into()))?
            .ok_or((401, "Sign in with Google again.".into()))?;
        if path == "/v1/billing/subscription" {
            let sub = billing_db::subscription(pool, &user)
                .await
                .map_err(|_| storage_unavailable())?;
            return Ok(billing_db::value(sub.as_ref()));
        }
        let body: Value = serde_json::from_slice(&limited_body(req).await?)
            .map_err(|_| (400, "Invalid billing request.".into()))?;
        let _mutation_lock = self.billing.checkout_lock.lock().await;
        if path == "/v1/billing/checkout" {
            let existing = billing_db::subscription(pool, &user)
                .await
                .map_err(|_| storage_unavailable())?;
            if billing::tier_for(existing.as_ref()) == "pro" {
                return Err((409, "Your Pro subscription is already active.".into()));
            }
            let currency = body["currency"].as_str().unwrap_or_default();
            if body["plan"] != "pro" {
                return Err((400, "Choose the Pro plan.".into()));
            }
            if currency == "INR" {
                if let Some(sub) =
                    existing.filter(|sub| sub.provider == "razorpay" && sub.status == "incomplete")
                {
                    let snapshot = billing::fetch_razorpay_subscription(
                        &self.billing.config,
                        &sub.provider_subscription_id,
                    )
                    .await?;
                    if matches!(
                        snapshot["status"].as_str(),
                        Some("created" | "authenticated")
                    ) {
                        return Ok(
                            json!({"provider":"razorpay","keyId":self.billing.config.razorpay_key_id,"subscriptionId":sub.provider_subscription_id}),
                        );
                    }
                    let latest = verified_snapshot(&sub, &snapshot)?;
                    billing_db::save_subscription(pool, &user, &latest, None)
                        .await
                        .map_err(|_| storage_unavailable())?;
                    if billing::tier_for(Some(&latest)) == "pro" {
                        return Err((409, "Your Pro subscription is already active.".into()));
                    }
                }
            }
            // Auth supplies the user id; a renderer cannot choose whose plan it changes.
            let email: Option<String> =
                sqlx::query_scalar("SELECT email FROM auth.users WHERE id=$1::uuid")
                    .bind(&user)
                    .persistent(false)
                    .fetch_optional(pool)
                    .await
                    .map_err(|_| storage_unavailable())?
                    .flatten();
            let checkout = billing::create_checkout(
                &self.billing.config,
                "pro",
                currency,
                &user,
                email.as_deref().unwrap_or_default(),
                &env_compat::var("KESAMI_BILLING_RETURN_URL").unwrap_or_default(),
            )
            .await?;
            if checkout["provider"] == "razorpay" {
                let id = checkout["subscriptionId"]
                    .as_str()
                    .ok_or((502, "Invalid checkout response.".into()))?;
                let pending = billing::subscription_from_payload(
                    "razorpay",
                    user.clone(),
                    id,
                    "created",
                    &json!({}),
                );
                billing_db::save_subscription(pool, &user, &pending, None)
                    .await
                    .map_err(|_| storage_unavailable())?;
            }
            return Ok(checkout);
        }
        let id = body["subscriptionId"].as_str().unwrap_or_default();
        let existing = billing_db::by_id(pool, "razorpay", id)
            .await
            .map_err(|_| storage_unavailable())?
            .filter(|sub| sub.account_id == user)
            .ok_or((
                404,
                "That subscription does not belong to this account.".into(),
            ))?;
        let payment_id = body["paymentId"].as_str().unwrap_or_default();
        if path == "/v1/billing/razorpay/confirm" {
            billing::verify_razorpay_checkout(
                &self.billing.config,
                &existing.provider_subscription_id,
                payment_id,
                body["signature"].as_str().unwrap_or_default(),
            )?;
        }
        let payload = billing::fetch_razorpay_subscription(
            &self.billing.config,
            &existing.provider_subscription_id,
        )
        .await?;
        let sub = verified_snapshot(&existing, &payload)?;
        let event = format!("checkout:{payment_id}");
        billing_db::save_subscription(
            pool,
            &user,
            &sub,
            (path == "/v1/billing/razorpay/confirm").then_some(("razorpay", event.as_str())),
        )
        .await
        .map_err(|_| storage_unavailable())?;
        let sub = billing_db::subscription(pool, &user)
            .await
            .map_err(|_| storage_unavailable())?;
        Ok(billing_db::value(sub.as_ref()))
    }
}

fn verified_snapshot(
    existing: &Subscription,
    payload: &Value,
) -> Result<Subscription, (u16, String)> {
    // Callers have checked the authenticated user against the durable owner.
    // Older desktop checkouts store a local account id in provider notes, while
    // their mirrored Supabase row uses the Auth user id. Keep that verified
    // ownership when the customer later signs in from a hosted client.
    if payload["id"].as_str() != Some(&existing.provider_subscription_id) {
        return Err((502, "Invalid subscription response.".into()));
    }
    Ok(billing::subscription_from_payload(
        "razorpay",
        existing.account_id.clone(),
        &existing.provider_subscription_id,
        payload["status"].as_str().unwrap_or_default(),
        payload,
    ))
}

async fn limited_body(req: Request<Incoming>) -> Result<Bytes, (u16, String)> {
    timeout(
        REQUEST_TIMEOUT,
        Limited::new(req.into_body(), 64 * 1024).collect(),
    )
    .await
    .map_err(|_| (408, "The billing request timed out.".into()))?
    .map(|body| body.to_bytes())
    .map_err(|_| (413, "The billing request is too large.".into()))
}

fn storage_unavailable() -> (u16, String) {
    (
        503,
        "Account billing storage is unavailable. Please try again.".into(),
    )
}
