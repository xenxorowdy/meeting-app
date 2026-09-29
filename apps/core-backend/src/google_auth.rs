//! Verify Google OpenID Connect identity before it can mint a local session.
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Deserialize)]
struct GoogleKey { kid: String, kty: String, #[serde(rename = "use")] key_use: Option<String>, alg: Option<String>, n: String, e: String }
#[derive(Debug, Deserialize)]
struct GoogleKeys { keys: Vec<GoogleKey> }
#[derive(Debug, Deserialize)]
struct Claims { sub: String, email: Option<String>, email_verified: Option<bool>, name: Option<String>, nonce: Option<String>, iss: String, aud: String, exp: usize }

pub struct GoogleIdentity { pub sub: String, pub email: String, pub name: String }

pub async fn exchange_code(code: &str, verifier: &str, redirect: &str, client_id: &str, client_secret: Option<&str>) -> Result<Value, String> {
    if code.is_empty() || code.len() > 2_048 || !(43..=128).contains(&verifier.len()) || !verifier.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-._~".contains(&byte)) {
        return Err("Google sign-in authorization is invalid.".into());
    }
    let redirect_url = reqwest::Url::parse(redirect).map_err(|_| "Google sign-in redirect is invalid.")?;
    if redirect_url.scheme() != "http" || redirect_url.host_str() != Some("127.0.0.1") || redirect_url.port().is_none() || redirect_url.path() != "/" || redirect_url.query().is_some() || redirect_url.fragment().is_some() {
        return Err("Google sign-in redirect is invalid.".into());
    }
    let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|_| "Could not prepare Google sign-in.")?;
    let mut form = vec![("client_id", client_id), ("code", code), ("code_verifier", verifier), ("grant_type", "authorization_code"), ("redirect_uri", redirect)];
    if let Some(secret) = client_secret { form.push(("client_secret", secret)); }
    let response = http.post("https://oauth2.googleapis.com/token").form(&form).send().await.map_err(|_| "Could not exchange Google authorization.")?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|_| "Google token response was invalid.")?;
    if !status.is_success() {
        return Err(body.get("error_description").and_then(Value::as_str).unwrap_or("Google rejected the authorization.").to_string());
    }
    if body.get("id_token").and_then(Value::as_str).is_none() { return Err("Google did not return an ID token.".into()); }
    Ok(body)
}

pub async fn verify_id_token(token: &str, client_id: &str, expected_nonce: &str) -> Result<GoogleIdentity, String> {
    if token.is_empty() || token.len() > 16_384 { return Err("Google did not return a valid ID token.".into()); }
    let header = decode_header(token).map_err(|_| "Google ID token is malformed.")?;
    if header.alg != Algorithm::RS256 { return Err("Google ID token uses an unexpected signing algorithm.".into()); }
    let kid = header.kid.ok_or("Google ID token has no signing key identifier.")?;
    let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|_| "Could not prepare Google identity verification.")?;
    let keys: GoogleKeys = http.get("https://www.googleapis.com/oauth2/v3/certs")
        .send().await.map_err(|_| "Could not fetch Google's signing keys.")?
        .error_for_status().map_err(|_| "Google's signing keys are unavailable.")?
        .json().await.map_err(|_| "Google's signing keys are invalid.")?;
    let key = keys.keys.into_iter().find(|key| key.kid == kid && key.kty == "RSA" && key.key_use.as_deref().is_none_or(|value| value == "sig") && key.alg.as_deref().is_none_or(|value| value == "RS256"))
        .ok_or("Google ID token uses an unknown signing key.")?;
    let decoding = DecodingKey::from_rsa_components(&key.n, &key.e).map_err(|_| "Google's signing key is invalid.")?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[client_id]);
    validation.set_issuer(&["https://accounts.google.com", "accounts.google.com"]);
    let claims = decode::<Claims>(token, &decoding, &validation).map_err(|_| "Google ID token could not be verified.")?.claims;
    if claims.iss != "https://accounts.google.com" && claims.iss != "accounts.google.com" { return Err("Google ID token has an unexpected issuer.".into()); }
    if claims.aud != client_id || claims.exp == 0 || claims.sub.is_empty() || claims.email_verified != Some(true) || claims.nonce.as_deref() != Some(expected_nonce) { return Err("Google did not verify this account's identity and email.".into()); }
    let email = claims.email.ok_or("Google did not provide an email address.")?;
    Ok(GoogleIdentity { sub: claims.sub, name: claims.name.unwrap_or_default(), email })
}
