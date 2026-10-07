use serde_json::{json, Map, Value};
use std::{io, path::PathBuf};
use tokio::sync::Mutex;

pub const ORIGIN: &str = "https://api.openai.com";
pub const DEFAULT_MODEL: &str = "gpt-5-nano";
pub const DEFAULT_DAILY_BUDGET_USD: f64 = 3.0;

fn price_per_million(model: &str) -> (f64, f64, f64) {
    let model = model.trim().to_ascii_lowercase();
    if model.starts_with("gpt-5-nano") {
        (0.05, 0.005, 0.40)
    } else if model.starts_with("gpt-5-mini") {
        (0.25, 0.025, 2.00)
    } else {
        (2.50, 0.25, 15.00)
    }
}

pub fn cost_usd(model: &str, usage: &Value) -> f64 {
    let tokens = |value: Option<&Value>| value.and_then(Value::as_f64).unwrap_or(0.0).max(0.0);
    let prompt = tokens(usage.get("prompt_tokens"));
    let cached = tokens(usage.pointer("/prompt_tokens_details/cached_tokens")).min(prompt);
    let completion = tokens(usage.get("completion_tokens"));
    let (input, cached_input, output) = price_per_million(model);
    ((prompt - cached) * input + cached * cached_input + completion * output) / 1_000_000.0
}

fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

pub struct DailyBudget {
    cap_usd: f64,
    path: Option<PathBuf>,
    spent: Mutex<(String, f64)>,
}

impl DailyBudget {
    pub fn new(cap_usd: f64, path: Option<PathBuf>) -> Self {
        let saved = path
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let day = saved.as_ref().and_then(|value| value["day"].as_str()).unwrap_or_default().to_string();
        let usd = saved.as_ref().and_then(|value| value["usd"].as_f64()).unwrap_or(0.0);
        Self { cap_usd, path, spent: Mutex::new((day, usd)) }
    }

    pub fn cap_from(raw: Option<String>) -> f64 {
        raw.and_then(|raw| raw.trim().parse::<f64>().ok())
            .filter(|cap| cap.is_finite() && *cap > 0.0)
            .unwrap_or(DEFAULT_DAILY_BUDGET_USD)
    }

    pub fn cap_usd(&self) -> f64 {
        self.cap_usd
    }

    pub async fn spent_today(&self) -> f64 {
        let spent = self.spent.lock().await;
        if spent.0 == today() {
            spent.1
        } else {
            0.0
        }
    }

    pub async fn check(&self) -> Result<(), String> {
        if self.spent_today().await >= self.cap_usd {
            return Err(format!("OpenAI daily budget of ${:.2} is used up; it resets at 00:00 UTC", self.cap_usd));
        }
        Ok(())
    }

    pub async fn record(&self, model: &str, response: &Value) -> f64 {
        let cost = response.get("usage").map_or(0.0, |usage| cost_usd(model, usage));
        let mut spent = self.spent.lock().await;
        let today = today();
        if spent.0 != today {
            *spent = (today, 0.0);
        }
        spent.1 += cost;
        if let Some(path) = &self.path {
            if let Err(cause) = save(path, &spent.0, spent.1).await {
                eprintln!("[Kesami] could not save OpenAI usage to {}: {cause}", path.display());
            }
        }
        cost
    }
}

async fn save(path: &std::path::Path, day: &str, usd: f64) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, json!({ "day": day, "usd": usd }).to_string()).await?;
    tokio::fs::rename(&tmp, path).await
}

pub fn is_model(model: &str) -> bool {
    let model = model.trim().to_ascii_lowercase();
    model.starts_with("gpt-")
        || model.starts_with("chatgpt-")
        || model.strip_prefix('o').and_then(|rest| rest.chars().next()).is_some_and(|c| c.is_ascii_digit())
}

pub fn reasons(model: &str) -> bool {
    let model = model.trim().to_ascii_lowercase();
    is_model(&model) && !model.contains("chat") && (model.starts_with("gpt-5") || model.starts_with('o'))
}

pub fn strict_schema(schema: &Value) -> Value {
    let Some(fields) = schema.as_object() else {
        return schema.clone();
    };
    let mut out = Map::new();
    for (key, value) in fields {
        let converted = match key.as_str() {
            "propertyOrdering" => continue,
            "properties" => Value::Object(
                value
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(name, field)| (name.clone(), strict_schema(field)))
                    .collect(),
            ),
            "items" => strict_schema(value),
            "anyOf" => Value::Array(value.as_array().into_iter().flatten().map(strict_schema).collect()),
            _ => value.clone(),
        };
        out.insert(key.clone(), converted);
    }
    let required = out.get("properties").and_then(Value::as_object).map(|properties| {
        let listed: Vec<String> = out
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|name| properties.contains_key(*name))
            .map(str::to_string)
            .collect();
        let missing: Vec<String> = properties.keys().filter(|name| !listed.contains(name)).cloned().collect();
        listed.into_iter().chain(missing).map(Value::String).collect::<Vec<_>>()
    });
    if let Some(required) = required {
        out.insert("required".into(), Value::Array(required));
        out.insert("additionalProperties".into(), Value::Bool(false));
    }
    Value::Object(out)
}

pub fn chat_request(model: &str, system: &str, user: &str, schema: &Value, max_tokens: Option<i64>) -> Value {
    let mut body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": "kesami_response", "strict": true, "schema": strict_schema(schema) },
        },
    });
    if reasons(model) {
        body["reasoning_effort"] = json!("low");
    } else {
        body["temperature"] = json!(0.2);
    }
    if let Some(tokens) = max_tokens {
        body["max_completion_tokens"] = json!(tokens);
    }
    body
}

pub struct Reply {
    pub text: String,
    pub finish_reason: String,
    pub refusal: Option<String>,
}

pub fn reply(response: &Value) -> Option<Reply> {
    let choice = response.get("choices")?.as_array()?.first()?;
    let message = choice.get("message")?;
    Some(Reply {
        text: message.get("content").and_then(Value::as_str).unwrap_or_default().to_string(),
        finish_reason: choice.get("finish_reason").and_then(Value::as_str).unwrap_or("stop").to_string(),
        refusal: message
            .get("refusal")
            .and_then(Value::as_str)
            .filter(|refusal| !refusal.trim().is_empty())
            .map(str::to_string),
    })
}

pub fn error_message(payload: &str) -> Option<String> {
    serde_json::from_str::<Value>(payload).ok()?.get("error")?.get("message")?.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_openai_model_names() {
        for model in ["gpt-5-mini", "  GPT-4.1 ", "o3", "o4-mini", "chatgpt-4o-latest"] {
            assert!(is_model(model), "{model}");
        }
        for model in ["gemini-2.5-flash", "sonnet", "opus", "claude-haiku-4-5", ""] {
            assert!(!is_model(model), "{model}");
        }
    }

    #[test]
    fn only_reasoning_models_get_a_reasoning_effort() {
        let schema = json!({ "type": "object", "properties": { "answer": { "type": "string" } } });
        let reasoning = chat_request("gpt-5-mini", "s", "u", &schema, None);
        assert_eq!(reasoning["reasoning_effort"], "low");
        assert!(reasoning.get("temperature").is_none());
        assert!(reasoning.get("max_completion_tokens").is_none());
        let classic = chat_request("gpt-4.1-mini", "s", "u", &schema, Some(2000));
        assert!(classic.get("reasoning_effort").is_none());
        assert_eq!(classic["temperature"], 0.2);
        assert_eq!(classic["max_completion_tokens"], 2000);
        assert!(!reasons("gpt-5-chat-latest"));
        assert!(reasons("o3"));
    }

    #[test]
    fn a_gemini_schema_becomes_a_strict_one() {
        let gemini = json!({
            "type": "object",
            "properties": {
                "answer": { "type": "string" },
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": { "task": { "type": "string" }, "owner": { "type": "string" } },
                        "required": ["task"],
                        "propertyOrdering": ["task", "owner"]
                    }
                }
            },
            "propertyOrdering": ["answer", "items"]
        });
        let strict = strict_schema(&gemini);
        assert!(!strict.to_string().contains("propertyOrdering"));
        assert_eq!(strict["additionalProperties"], false);
        assert_eq!(strict["required"], json!(["answer", "items"]));
        let item = &strict["properties"]["items"]["items"];
        assert_eq!(item["additionalProperties"], false);
        assert_eq!(item["required"], json!(["task", "owner"]));
        assert_eq!(strict["properties"]["answer"], json!({ "type": "string" }));
    }

    #[test]
    fn reads_the_first_choice_and_its_refusal() {
        let answered = json!({ "choices": [{ "message": { "content": "{\"a\":1}", "refusal": null }, "finish_reason": "stop" }] });
        let reply = reply(&answered).unwrap();
        assert_eq!(reply.text, "{\"a\":1}");
        assert_eq!(reply.finish_reason, "stop");
        assert!(reply.refusal.is_none());
        let refused = json!({ "choices": [{ "message": { "content": null, "refusal": "No." }, "finish_reason": "stop" }] });
        assert_eq!(super::reply(&refused).unwrap().refusal.as_deref(), Some("No."));
        assert!(super::reply(&json!({ "choices": [] })).is_none());
        assert_eq!(
            error_message(r#"{"error":{"message":"Incorrect API key provided"}}"#).as_deref(),
            Some("Incorrect API key provided")
        );
        assert!(error_message("502 Bad Gateway").is_none());
    }

    #[test]
    fn costs_follow_the_model_price_and_discount_cached_input() {
        let usage = json!({ "prompt_tokens": 1_000_000, "completion_tokens": 1_000_000, "prompt_tokens_details": { "cached_tokens": 200_000 } });
        assert!((cost_usd("gpt-5-nano", &usage) - 0.441).abs() < 1e-9);
        assert!((cost_usd("gpt-5-nano-2025-08-07", &json!({ "prompt_tokens": 10_000, "completion_tokens": 2_000 })) - 0.0013).abs() < 1e-9);
        assert!(cost_usd("gpt-5-mini", &usage) > cost_usd("gpt-5-nano", &usage));
        assert!(cost_usd("gpt-9-unknown", &usage) > cost_usd("gpt-5-mini", &usage));
        assert_eq!(cost_usd("gpt-5-nano", &json!({})), 0.0);
    }

    #[test]
    fn the_cap_defaults_to_three_dollars() {
        assert_eq!(DailyBudget::cap_from(None), 3.0);
        assert_eq!(DailyBudget::cap_from(Some(" 0.5 ".into())), 0.5);
        for invalid in ["0", "-1", "lots", "NaN", "inf"] {
            assert_eq!(DailyBudget::cap_from(Some(invalid.into())), 3.0, "{invalid}");
        }
    }

    #[tokio::test]
    async fn the_budget_stops_calls_once_todays_spend_reaches_the_cap() {
        let budget = DailyBudget::new(0.002, None);
        budget.check().await.unwrap();
        let response = json!({ "usage": { "prompt_tokens": 10_000, "completion_tokens": 2_000 } });
        assert!((budget.record("gpt-5-nano", &response).await - 0.0013).abs() < 1e-9);
        budget.check().await.unwrap();
        budget.record("gpt-5-nano", &response).await;
        let refused = budget.check().await.unwrap_err();
        assert!(refused.contains("$0.00"), "{refused}");
        assert!(refused.contains("resets at 00:00 UTC"));
        assert!((budget.spent_today().await - 0.0026).abs() < 1e-9);
    }

    #[tokio::test]
    async fn spend_survives_a_restart_and_resets_on_a_new_day() {
        let dir = std::env::temp_dir().join(format!("kesami-openai-budget-{}", uuid::Uuid::new_v4()));
        let path = dir.join("openai-usage.json");
        let budget = DailyBudget::new(3.0, Some(path.clone()));
        budget.record("gpt-5-nano", &json!({ "usage": { "completion_tokens": 1_000_000 } })).await;
        let reloaded = DailyBudget::new(3.0, Some(path.clone()));
        assert!((reloaded.spent_today().await - 0.40).abs() < 1e-9);

        std::fs::write(&path, json!({ "day": "2000-01-01", "usd": 99.0 }).to_string()).unwrap();
        let stale = DailyBudget::new(3.0, Some(path.clone()));
        assert_eq!(stale.spent_today().await, 0.0);
        stale.check().await.unwrap();
        stale.record("gpt-5-nano", &json!({ "usage": { "completion_tokens": 1_000_000 } })).await;
        let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["day"], today());
        assert!((saved["usd"].as_f64().unwrap() - 0.40).abs() < 1e-9);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
