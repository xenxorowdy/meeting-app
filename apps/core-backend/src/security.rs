//! Security boundary for a private, single-workspace backend.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io, net::IpAddr};
use subtle::ConstantTimeEq;

pub const MAX_HEADER_BYTES: usize = 16 * 1024;
pub const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_WS_BYTES: usize = 2 * 1024 * 1024;

const OPAQUE_ORIGINS: [&str; 2] = ["null", "file://"];

// Deliberately no Debug: tokens must never end up in logs.
pub struct SecurityConfig {
    pub hosted: bool,
    token_hash: Option<[u8; 32]>,
    origins: Vec<String>,
    allow_null_origin: bool,
}

impl SecurityConfig {
    pub fn from_env(host: &str) -> io::Result<Self> {
        Self::new(
            host,
            kesami_core_backend::env_compat::var("KESAMI_BACKEND_TOKEN").ok().as_deref(),
            kesami_core_backend::env_compat::var("KESAMI_ALLOWED_ORIGINS").ok().as_deref(),
            kesami_core_backend::env_compat::var("KESAMI_ALLOW_NULL_ORIGIN").ok().as_deref(),
        )
    }

    pub(crate) fn new(host: &str, token: Option<&str>, origins: Option<&str>, allow_null: Option<&str>) -> io::Result<Self> {
        let hosted = !is_loopback_host(host);
        let token = token.filter(|value| !value.is_empty());
        if hosted && token.is_none() {
            return Err(io::Error::other("Non-loopback binding requires KESAMI_BACKEND_TOKEN (at least 32 characters)"));
        }
        if token.is_some_and(|value| value.len() < 32 || value.len() > 512 || !value.bytes().all(|b| b.is_ascii_graphic())) {
            return Err(io::Error::other("KESAMI_BACKEND_TOKEN must contain 32 to 512 printable ASCII characters without spaces"));
        }
        let origins = origins.unwrap_or("http://localhost:5173,http://127.0.0.1:5173")
            .split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect::<Vec<_>>();
        for origin in &origins {
            let parsed = reqwest::Url::parse(origin).map_err(|_| io::Error::other("KESAMI_ALLOWED_ORIGINS must contain exact HTTP(S) origins"))?;
            if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none()
                || parsed.origin().ascii_serialization() != *origin || origin.contains('*') {
                return Err(io::Error::other("KESAMI_ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths or wildcards"));
            }
        }
        let allow_null_origin = match allow_null {
            None => !hosted,
            Some("true" | "1") => true,
            Some("false" | "0") => false,
            _ => return Err(io::Error::other("KESAMI_ALLOW_NULL_ORIGIN must be true or false")),
        };
        Ok(Self { hosted, token_hash: token.map(|value| Sha256::digest(value.as_bytes()).into()), origins, allow_null_origin })
    }

    pub fn origin_allowed(&self, origin: Option<&str>) -> bool {
        match origin {
            None => true, // Native clients do not send Origin; bearer validation still applies.
            Some(value) if OPAQUE_ORIGINS.contains(&value) => self.allow_null_origin,
            Some(value) => self.origins.iter().any(|origin| origin == value),
        }
    }

    pub fn authorized(&self, headers: &HashMap<String, String>, websocket: bool) -> bool {
        let Some(expected) = self.token_hash else { return true; };
        bearer_or_protocol_token(headers, websocket).is_some_and(|token| {
            let supplied: [u8; 32] = Sha256::digest(token).into();
            bool::from(expected.ct_eq(&supplied))
        })
    }

    pub fn host_allowed(&self, host_header: Option<&str>) -> bool {
        if self.hosted { return host_header.is_some(); }
        host_header.and_then(|host| reqwest::Url::parse(&format!("http://{host}")).ok())
            .and_then(|url| url.host_str().map(str::to_string))
            .is_some_and(|host| is_loopback_host(host.trim_matches(['[', ']'])))
    }
}

/// The candidate access token a client presented: the bearer header, or —
/// for websocket upgrades, where browsers cannot set headers — the token
/// smuggled through the subprotocol list. Callers decide what it is worth.
pub fn bearer_or_protocol_token(headers: &HashMap<String, String>, websocket: bool) -> Option<String> {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string)
        .filter(|token| !token.is_empty());
    let protocol_token = if websocket {
        headers
            .get("sec-websocket-protocol")
            .and_then(|value| value.split(',').map(str::trim)
                .find_map(|protocol| protocol.strip_prefix("kesami-token.").or_else(|| protocol.strip_prefix("alpha-token."))))
            .and_then(|value| URL_SAFE_NO_PAD.decode(value).ok())
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .filter(|token| !token.is_empty())
    } else {
        None
    };
    bearer.or(protocol_token)
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;
    const TOKEN: &str = "test-only-token-with-at-least-32-characters";
    fn hosted() -> SecurityConfig { SecurityConfig::new("0.0.0.0", Some(TOKEN), Some("https://app.example.com"), None).unwrap() }

    #[test]
    fn public_bind_fails_closed_without_a_strong_token() {
        for host in ["0.0.0.0", "::", "192.168.1.2", "backend.example.com"] {
            assert!(SecurityConfig::new(host, None, None, None).is_err());
            assert!(SecurityConfig::new(host, Some("short"), None, None).is_err());
        }
        for host in ["127.0.0.1", "::1", "localhost"] {
            assert!(SecurityConfig::new(host, None, None, None).is_ok());
        }
    }

    #[test]
    fn bearer_is_required_and_websocket_tokens_are_scoped_to_upgrades() {
        let config = hosted();
        let mut headers = HashMap::new();
        assert!(!config.authorized(&headers, false));
        headers.insert("authorization".into(), "Bearer wrong".into());
        assert!(!config.authorized(&headers, true));
        headers.insert("authorization".into(), format!("Bearer {TOKEN}"));
        assert!(config.authorized(&headers, false));
        headers.remove("authorization");
        headers.insert("sec-websocket-protocol".into(), format!("kesami, kesami-token.{}", URL_SAFE_NO_PAD.encode(TOKEN)));
        assert!(config.authorized(&headers, true));
        assert!(!config.authorized(&headers, false));
        headers.insert("sec-websocket-protocol".into(), "kesami, kesami-token.%%%".into());
        assert!(!config.authorized(&headers, true));
    }

    #[test]
    fn the_token_extractor_prefers_bearer_and_scopes_protocols_to_upgrades() {
        let mut headers = HashMap::new();
        assert_eq!(bearer_or_protocol_token(&headers, false), None);
        headers.insert("authorization".into(), "Bearer tok-1".into());
        assert_eq!(bearer_or_protocol_token(&headers, false).as_deref(), Some("tok-1"));
        assert_eq!(bearer_or_protocol_token(&headers, true).as_deref(), Some("tok-1"));
        headers.remove("authorization");
        headers.insert(
            "sec-websocket-protocol".into(),
            format!("kesami, kesami-token.{}", URL_SAFE_NO_PAD.encode("tok-2")),
        );
        assert_eq!(bearer_or_protocol_token(&headers, true).as_deref(), Some("tok-2"));
        headers.insert(
            "sec-websocket-protocol".into(),
            format!("alpha, alpha-token.{}", URL_SAFE_NO_PAD.encode("tok-legacy")),
        );
        assert_eq!(bearer_or_protocol_token(&headers, true).as_deref(), Some("tok-legacy"));
        assert_eq!(bearer_or_protocol_token(&headers, false), None);
        headers.insert("sec-websocket-protocol".into(), "kesami, kesami-token.%%%".into());
        assert_eq!(bearer_or_protocol_token(&headers, true), None);
    }

    #[test]
    fn origins_are_exact_and_null_requires_hosted_opt_in() {
        let config = hosted();
        assert!(config.origin_allowed(Some("https://app.example.com")));
        for origin in ["null", "file://", "https://app.example.com.evil.test", "http://app.example.com", "https://evil.test"] {
            assert!(!config.origin_allowed(Some(origin)));
        }
        assert!(config.origin_allowed(None));
        assert!(SecurityConfig::new("0.0.0.0", Some(TOKEN), Some("*"), None).is_err());
        assert!(SecurityConfig::new("0.0.0.0", Some(TOKEN), Some("https://app.example.com/path"), None).is_err());
        let opted_in = SecurityConfig::new("0.0.0.0", Some(TOKEN), None, Some("true")).unwrap();
        assert!(opted_in.origin_allowed(Some("null")));
        assert!(opted_in.origin_allowed(Some("file://")));
    }

    #[test]
    fn a_local_backend_accepts_both_spellings_of_a_file_origin() {
        let local = SecurityConfig::new("127.0.0.1", None, None, None).unwrap();
        assert!(local.origin_allowed(Some("null")));
        assert!(local.origin_allowed(Some("file://")));
        assert!(!local.origin_allowed(Some("https://evil.test")));

        let closed = SecurityConfig::new("127.0.0.1", None, None, Some("false")).unwrap();
        assert!(!closed.origin_allowed(Some("null")));
        assert!(!closed.origin_allowed(Some("file://")));
    }

    #[test]
    fn local_service_rejects_dns_rebinding_hosts() {
        let config = SecurityConfig::new("127.0.0.1", None, None, None).unwrap();
        for host in ["localhost:48900", "127.0.0.1:48900", "[::1]:48900"] {
            assert!(config.host_allowed(Some(host)));
        }
        assert!(!config.host_allowed(Some("evil.test:48900")));
    }
}
