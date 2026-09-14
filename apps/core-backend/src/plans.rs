//! Public plan catalog. Publishing a price never grants an entitlement or
//! enables checkout: payments need a provider and verified subscription events.
use serde_json::{json, Value};

pub fn catalog() -> Value {
    catalog_with(
        std::env::var("ALPHA_PRO_MONTHLY_MINOR").ok().as_deref(),
        std::env::var("ALPHA_BILLING_CURRENCY").ok().as_deref(),
    )
}

fn catalog_with(amount: Option<&str>, currency: Option<&str>) -> Value {
    let currency = currency.unwrap_or("").to_ascii_uppercase();
    let amount = amount
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|n| *n > 0 && *n <= 100_000_000);
    // Explicit supported currencies avoid ambiguous minor-unit formatting.
    let price = match (amount, currency.as_str()) {
        (Some(amount), "INR" | "USD" | "EUR" | "GBP") => {
            json!({"amountMinor":amount,"currency":currency,"interval":"month"})
        }
        _ => Value::Null,
    };
    json!({
        "billingEnabled": false,
        "plans": [
            {"id":"free","name":"Local","status":"available","requiresAccount":false,
             "price":{"amountMinor":0,"currency":"USD","interval":null},
             "description":"Your meetings, on your device. No account required.",
             "features":["Record meetings on your device","Keep and export your meeting library","Use your own transcription and AI providers"],
             "note":"Provider API usage may be billed separately by your chosen provider."},
            {"id":"pro","name":"Pro","status":"coming_soon","requiresAccount":true,
             "price":price,"description":"Optional paid services are in development.",
             "features":["Planned: managed AI usage","Planned: account billing and subscription management"],
             "note":"Not available for purchase. No paid features or cloud sync are enabled."}
        ]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_is_free_and_never_requires_an_account() {
        let catalog = catalog_with(None, None);
        assert_eq!(catalog["plans"][0]["requiresAccount"], false);
        assert_eq!(catalog["plans"][0]["price"]["amountMinor"], 0);
        assert!(catalog["plans"][1]["price"].is_null());
        assert_eq!(catalog["billingEnabled"], false);
    }
    #[test]
    fn a_configured_price_does_not_enable_payments() {
        let catalog = catalog_with(Some("99900"), Some("inr"));
        assert_eq!(catalog["plans"][1]["price"]["amountMinor"], 99900);
        assert_eq!(catalog["plans"][1]["price"]["currency"], "INR");
        assert_eq!(catalog["billingEnabled"], false);
        for (amount, currency) in [
            ("-1", "INR"),
            ("0", "USD"),
            ("123", "XXX"),
            ("hello", "USD"),
        ] {
            assert!(catalog_with(Some(amount), Some(currency))["plans"][1]["price"].is_null());
        }
    }
}
