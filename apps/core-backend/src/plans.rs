//! Public plan catalog. Publishing a price never grants an entitlement:
//! paid plans activate only through verified provider webhooks (billing.rs).
use serde_json::{json, Value};

/// Free tier recording allowance, minutes per calendar month.
pub const FREE_MONTHLY_MINUTES: i64 = 120;
/// Summaries and AI chat replies share this monthly workspace allowance.
pub const FREE_MONTHLY_AI_USES: i64 = 3;
/// Pro monthly prices per region, minor currency units.
pub const PRO_MONTHLY_MINOR_INR: u32 = 49_900;
pub const PRO_MONTHLY_MINOR_USD: u32 = 1_000;

pub fn can_record(tier: &str, minutes_used: i64) -> bool {
    tier == "pro" || minutes_used < FREE_MONTHLY_MINUTES
}

pub fn free_ai_limit_message() -> String {
    format!("Your {FREE_MONTHLY_AI_USES} free AI uses for this month are used. Upgrade to Pro for unlimited summaries and chat.")
}

pub fn catalog(billing_enabled: bool) -> Value {
    catalog_with(
        billing_enabled,
        kesami_core_backend::env_compat::var("KESAMI_PRO_MONTHLY_MINOR").ok().as_deref(),
        kesami_core_backend::env_compat::var("KESAMI_BILLING_CURRENCY").ok().as_deref(),
    )
}

fn catalog_with(billing_enabled: bool, amount: Option<&str>, currency: Option<&str>) -> Value {
    let mut pro_prices = vec![
        json!({"amountMinor":PRO_MONTHLY_MINOR_INR,"currency":"INR","interval":"month","provider":"razorpay"}),
        json!({"amountMinor":PRO_MONTHLY_MINOR_USD,"currency":"USD","interval":"month","provider":"stripe"}),
    ];
    // Optional single-region override, e.g. a launch discount. An invalid or
    // unknown-currency override is ignored rather than breaking the catalog.
    let override_amount = amount
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|n| *n > 0 && *n <= 100_000_000);
    let override_currency = currency.map(|c| c.to_ascii_uppercase());
    if let (Some(amount), Some(currency)) = (override_amount, override_currency) {
        for price in pro_prices.iter_mut() {
            if price["currency"] == currency.as_str() {
                price["amountMinor"] = json!(amount);
            }
        }
    }
    json!({
        "billingEnabled": billing_enabled,
        "freeMonthlyMinutes": FREE_MONTHLY_MINUTES,
        "freeMonthlyAiUses": FREE_MONTHLY_AI_USES,
        "plans": [
            {"id":"free","name":"Free","status":"available","requiresAccount":false,
             "prices":[{"amountMinor":0,"currency":"USD","interval":null}],
             "description":"Your meetings, on your device.",
             "features":[format!("{} hours of meeting recording per month", FREE_MONTHLY_MINUTES / 60),format!("{FREE_MONTHLY_AI_USES} shared AI summaries or chat replies per month"),"Keep and export your meeting library","Search and transcripts on your device"],
             "note":"Provider API usage for local transcription may still be billed separately by your chosen provider."},
            {"id":"pro","name":"Pro","status":"available","requiresAccount":true,
             "prices":pro_prices,
             "description":"Unlimited recording and AI summaries, per user.",
             "features":["Unlimited meeting recording","AI meeting summaries and action items","AI chat over your meetings","All export formats","Priority email support"],
             "note":"Billed per user. India is billed in INR via Razorpay; the rest of the world is billed in USD via Stripe."},
            {"id":"enterprise","name":"Enterprise","status":"contact","requiresAccount":true,
             "prices":[],
             "description":"Custom pricing for teams and organizations.",
             "features":["Volume and multi-workspace licensing","Custom contracts, invoicing, and procurement","Deployment and integration support","Dedicated support channel"],
             "note":"Contact sales for a quote tailored to your team."}
        ]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_matches_the_published_pricing() {
        let catalog = catalog_with(false, None, None);
        assert_eq!(catalog["billingEnabled"], false);
        assert_eq!(catalog["freeMonthlyMinutes"], FREE_MONTHLY_MINUTES);
        let plans = catalog["plans"].as_array().unwrap();
        assert_eq!(plans.len(), 3);
        let [free, pro, enterprise] = plans.as_slice() else {
            panic!("three plans")
        };
        assert_eq!(free["id"], "free");
        assert_eq!(free["requiresAccount"], false);
        assert_eq!(free["prices"][0]["amountMinor"], 0);
        assert_eq!(pro["id"], "pro");
        assert_eq!(pro["prices"][0]["amountMinor"], 49_900);
        assert_eq!(pro["prices"][0]["currency"], "INR");
        assert_eq!(pro["prices"][0]["provider"], "razorpay");
        assert_eq!(pro["prices"][1]["amountMinor"], 1_000);
        assert_eq!(pro["prices"][1]["currency"], "USD");
        assert_eq!(pro["prices"][1]["provider"], "stripe");
        assert_eq!(enterprise["id"], "enterprise");
        assert_eq!(enterprise["status"], "contact");
        assert!(enterprise["prices"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_region_override_only_touches_its_own_price() {
        let catalog = catalog_with(true, Some("70000"), Some("inr"));
        assert_eq!(catalog["billingEnabled"], true);
        let prices = catalog["plans"][1]["prices"].as_array().unwrap();
        assert_eq!(prices[0]["amountMinor"], 70_000);
        assert_eq!(prices[0]["currency"], "INR");
        assert_eq!(prices[1]["amountMinor"], 1_000);
        for (amount, currency) in [
            ("-1", "INR"),
            ("0", "USD"),
            ("123", "XXX"),
            ("hello", "USD"),
        ] {
            let catalog = catalog_with(false, Some(amount), Some(currency));
            let prices = catalog["plans"][1]["prices"].as_array().unwrap();
            assert_eq!(
                prices[0]["amountMinor"], 49_900,
                "{amount}/{currency} ignored"
            );
            assert_eq!(
                prices[1]["amountMinor"], 1_000,
                "{amount}/{currency} ignored"
            );
        }
    }

    #[test]
    fn the_free_plan_never_requires_an_account_or_billing() {
        let catalog = catalog_with(true, None, None);
        assert_eq!(catalog["plans"][0]["requiresAccount"], false);
        assert_eq!(catalog["plans"][0]["prices"][0]["amountMinor"], 0);
    }
}
