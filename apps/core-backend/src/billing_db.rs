//! Server-only, durable subscription state. Clients can only read their own rows through RLS.
use crate::billing::{self, Subscription};
use sqlx::{
    postgres::{PgPool, PgPoolOptions},
    Row,
};
use std::time::Duration;

pub fn configured_pool() -> Option<PgPool> {
    let url = crate::env_compat::var("KESAMI_SUPABASE_DB_URL").ok()?;
    let options: sqlx::postgres::PgConnectOptions = url.parse().ok()?;
    PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(10))
        .connect_lazy_with(options.statement_cache_capacity(0))
        .into()
}

const COLUMNS: &str = "user_id::text AS account_id, plan, provider, provider_subscription_id, customer_id, status, currency, amount_minor, (extract(epoch FROM current_period_end)*1000)::bigint AS period_end";

fn from_row(row: sqlx::postgres::PgRow) -> Result<Subscription, sqlx::Error> {
    Ok(Subscription {
        account_id: row.try_get("account_id")?,
        plan: row.try_get("plan")?,
        provider: row.try_get("provider")?,
        provider_subscription_id: row.try_get("provider_subscription_id")?,
        customer_id: row.try_get("customer_id")?,
        status: row.try_get("status")?,
        currency: row.try_get("currency")?,
        amount_minor: row.try_get("amount_minor")?,
        current_period_end: row.try_get("period_end")?,
    })
}

pub async fn subscription(pool: &PgPool, user: &str) -> Result<Option<Subscription>, sqlx::Error> {
    sqlx::query(&format!("SELECT {COLUMNS} FROM public.billing WHERE user_id=$1::uuid ORDER BY (status='active' AND (current_period_end IS NULL OR current_period_end>now())) DESC, updated_at DESC LIMIT 1"))
        .bind(user).persistent(false).fetch_optional(pool).await?.map(from_row).transpose()
}

pub async fn by_id(
    pool: &PgPool,
    provider: &str,
    id: &str,
) -> Result<Option<Subscription>, sqlx::Error> {
    sqlx::query(&format!(
        "SELECT {COLUMNS} FROM public.billing WHERE provider=$1 AND provider_subscription_id=$2"
    ))
    .bind(provider)
    .bind(id)
    .persistent(false)
    .fetch_optional(pool)
    .await?
    .map(from_row)
    .transpose()
}

const SAVE: &str = "INSERT INTO public.billing AS existing \
    (provider,provider_subscription_id,user_id,plan,customer_id,status,currency,amount_minor,current_period_end) \
    VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,to_timestamp($9)) \
    ON CONFLICT(provider,provider_subscription_id) DO UPDATE SET \
    plan=EXCLUDED.plan,customer_id=COALESCE(EXCLUDED.customer_id,existing.customer_id),status=EXCLUDED.status, \
    currency=EXCLUDED.currency,amount_minor=EXCLUDED.amount_minor, \
    current_period_end=COALESCE(EXCLUDED.current_period_end,existing.current_period_end),updated_at=now() \
    WHERE existing.user_id=EXCLUDED.user_id AND existing.status<>'canceled' AND EXCLUDED.status<>'incomplete'";

pub async fn save_subscription(
    pool: &PgPool,
    user: &str,
    sub: &Subscription,
    event: Option<(&str, &str)>,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    if let Some((provider, id)) = event {
        let inserted = sqlx::query("INSERT INTO public.billing_events(provider,event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING")
            .bind(provider).bind(id).persistent(false).execute(&mut *tx).await?;
        if inserted.rows_affected() == 0 {
            return tx.commit().await;
        }
    }
    sqlx::query(SAVE)
        .bind(&sub.provider)
        .bind(&sub.provider_subscription_id)
        .bind(user)
        .bind(&sub.plan)
        .bind(&sub.customer_id)
        .bind(&sub.status)
        .bind(&sub.currency)
        .bind(sub.amount_minor)
        .bind(sub.current_period_end.map(|ms| ms as f64 / 1000.0))
        .persistent(false)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

pub fn value(sub: Option<&Subscription>) -> serde_json::Value {
    serde_json::json!({"tier":billing::tier_for(sub), "subscription":sub.map(billing::BillingStore::subscription_value), "accountSynced":true})
}
