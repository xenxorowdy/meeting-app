//! Desktop-to-service billing transport. Only the renewable user's access token leaves this process.
use crate::{
    settings::SettingsStore,
    supabase_auth::{self, SupabaseAuth},
};
use kesami_core_backend::billing::Subscription;
use serde_json::Value;
use std::time::Duration;

pub async fn request(
    auth: &SupabaseAuth,
    settings: &SettingsStore,
    account: Option<&str>,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, (u16, String)> {
    let origin = supabase_auth::cloud_origin()
        .ok_or((503, "The billing service is not configured.".into()))?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| unavailable())?;
    let mut request = http.request(method, format!("{origin}{path}"));
    if let Some(account) = account {
        let token = auth
            .cloud_access_token(settings, account)
            .await
            .map_err(|message| (401, message))?;
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await.map_err(|_| unavailable())?;
    let status = response.status().as_u16();
    let payload: Value = response.json().await.map_err(|_| unavailable())?;
    if !(200..300).contains(&status) {
        return Err((
            status,
            payload["error"]
                .as_str()
                .unwrap_or("The billing service is unavailable. Try again.")
                .to_string(),
        ));
    }
    Ok(payload)
}

fn unavailable() -> (u16, String) {
    (
        503,
        "Could not reach the billing service. Check your connection and try again.".into(),
    )
}

pub fn subscription(account: &str, value: &Value) -> Result<Option<Subscription>, (u16, String)> {
    let sub = &value["subscription"];
    if sub.is_null() && value["tier"] == "free" {
        return Ok(None);
    }
    let field = |name: &str| {
        sub[name]
            .as_str()
            .map(str::to_string)
            .ok_or_else(unavailable)
    };
    let subscription = Subscription {
        account_id: account.to_string(),
        plan: field("plan")?,
        provider: field("provider")?,
        provider_subscription_id: field("providerSubscriptionId")?,
        status: field("status")?,
        currency: field("currency")?,
        amount_minor: sub["amountMinor"].as_i64().ok_or_else(unavailable)?,
        current_period_end: sub["currentPeriodEnd"].as_i64(),
        customer_id: None,
    };
    if value["tier"].as_str() != Some(kesami_core_backend::billing::tier_for(Some(&subscription))) {
        return Err(unavailable());
    }
    Ok(Some(subscription))
}
