//! HTTP calls for the #77 pairing ceremony, token issuance and bootstrap probe.
//!
//! Shapes: BitSov-bitsov `56c0ee0`, `konsensus-api/src/handlers/pairing_routes.rs`.
//! The node declares `deny_unknown_fields` on every body, so each body carries
//! exactly the documented fields.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::json;

use super::{ClientKey, PairError};

/// Prefix of a node-issued token challenge. The client refuses to sign
/// anything else on the token path.
const TOKEN_CHALLENGE_PREFIX: &str = "bitsov-pair-token-v1:";

/// Challenge width (`CHALLENGE_LEN`).
const CHALLENGE_LEN: usize = 32;

/// Loopback client for the pairing routes.
#[derive(Clone)]
pub struct PairingClient {
    http: reqwest::Client,
    base: String,
    challenge_dir: Option<PathBuf>,
    code_wait: Duration,
}

#[derive(Deserialize)]
pub(crate) struct RequestReply {
    pub pair_id: String,
    #[allow(dead_code)]
    pub expires_at: i64,
    pub challenge_path: String,
}

#[derive(Deserialize)]
pub(crate) struct ConfirmReply {
    pub client_id: String,
    pub scopes: Vec<String>,
}

#[derive(Deserialize)]
pub(crate) struct TokenReply {
    pub token: String,
    pub expires_at: i64,
    pub scopes: Vec<String>,
}

impl PairingClient {
    /// `base` is the loopback API root, e.g. the app's `API_BASE`.
    pub fn new(http: reqwest::Client, base: impl Into<String>) -> Self {
        Self {
            http,
            base: base.into(),
            challenge_dir: None,
            code_wait: Duration::from_secs(2),
        }
    }

    /// Only read challenge files directly inside `dir` (the node's
    /// `<data_dir>/pairing`). The node names the path; this bounds it.
    pub fn expect_challenge_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.challenge_dir = Some(dir.into());
        self
    }

    /// How long to wait for the node's printed short code.
    pub fn with_code_wait(mut self, wait: Duration) -> Self {
        self.code_wait = wait;
        self
    }

    pub(crate) fn code_wait(&self) -> Duration {
        self.code_wait
    }

    async fn send(
        &self,
        step: &'static str,
        request: reqwest::RequestBuilder,
    ) -> Result<(u16, String), PairError> {
        let response = request.send().await.map_err(|e| PairError::Transport {
            step,
            detail: e.to_string(),
        })?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(|e| PairError::Transport {
            step,
            detail: e.to_string(),
        })?;
        Ok((status, body))
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    /// `POST /pair/request`. `Ok(None)` means the node has no pairing routes
    /// (404 — an older `v0.3.0-rc7` node). Every other non-2xx is a refusal.
    pub(crate) async fn request(
        &self,
        key: &ClientKey,
        client_name: &str,
    ) -> Result<Option<RequestReply>, PairError> {
        const STEP: &str = "/pair/request";
        let body = json!({ "client_name": client_name, "client_pubkey": key.public_hex() });
        let (status, text) = self
            .send(STEP, self.http.post(self.url(STEP)).json(&body))
            .await?;
        if status == 404 {
            return Ok(None);
        }
        decode(STEP, status, &text).map(Some)
    }

    /// Read the `0600` challenge file the node named.
    pub(crate) fn read_challenge(&self, reply: &RequestReply) -> Result<Vec<u8>, PairError> {
        let path = Path::new(&reply.challenge_path);
        let expected_name = format!("challenge-{}", reply.pair_id);
        if path.file_name().and_then(|n| n.to_str()) != Some(expected_name.as_str()) {
            return Err(PairError::Local(
                "the node named an unexpected challenge file".into(),
            ));
        }
        if let Some(dir) = &self.challenge_dir {
            let parent = path.parent().and_then(|p| p.canonicalize().ok());
            if parent.is_none() || parent != dir.canonicalize().ok() {
                return Err(PairError::Local(
                    "the challenge file is not in this node's data directory".into(),
                ));
            }
        }
        super::key::check_owner_only(path, "challenge file")?;
        let bytes = std::fs::read(path)
            .map_err(|e| PairError::Local(format!("cannot read the challenge file: {e}")))?;
        if bytes.len() != CHALLENGE_LEN {
            return Err(PairError::Local("the challenge file has the wrong length".into()));
        }
        Ok(bytes)
    }

    /// `POST /pair/confirm` with a signature over `pair_id || client_pubkey || challenge`.
    pub(crate) async fn confirm(
        &self,
        key: &ClientKey,
        pair_id: &str,
        challenge: &[u8],
    ) -> Result<ConfirmReply, PairError> {
        const STEP: &str = "/pair/confirm";
        let mut message = Vec::with_capacity(pair_id.len() + 64 + challenge.len());
        message.extend_from_slice(pair_id.as_bytes());
        message.extend_from_slice(key.public_hex().as_bytes());
        message.extend_from_slice(challenge);
        let body = json!({ "pair_id": pair_id, "signature": key.sign_hex(&message) });
        let (status, text) = self
            .send(STEP, self.http.post(self.url(STEP)).json(&body))
            .await?;
        decode(STEP, status, &text)
    }

    /// `GET /pair/challenge` then `POST /pair/token`.
    pub(crate) async fn token(&self, key: &ClientKey, client_id: &str, local: bool) -> Result<TokenReply, PairError> {
        const CHALLENGE: &str = "/pair/challenge";
        const TOKEN: &str = "/pair/token";
        #[derive(Deserialize)]
        struct Challenge {
            challenge: String,
        }
        // Share across clones and reconstructed clients. Retain timestamps for
        // the process lifetime, even after an exchange fails or is cancelled.
        // The per-node/client guard stays held through POST /pair/token.
        type History = HashMap<(String, String), Arc<tokio::sync::Mutex<Option<u64>>>>;
        static HISTORY: OnceLock<tokio::sync::Mutex<History>> = OnceLock::new();
        let mut local_exchange = if local {
            let state = {
                let mut history = HISTORY.get_or_init(Default::default).lock().await;
                history.entry((self.base.clone(), client_id.to_owned())).or_default().clone()
            };
            Some(state.lock_owned().await)
        } else {
            None
        };
        let mut request = self.http.get(self.url(CHALLENGE)).query(&[("client_id", client_id)]);
        if let Some(last) = local_exchange.as_mut() {
            // PR #379: Unix seconds, +/-30 s, Ed25519 over this exact UTF-8
            // domain + client id + timestamp. Reuse the paired client key.
            let timestamp = loop {
                let now = SystemTime::now().duration_since(UNIX_EPOCH)
                    .map_err(|_| PairError::Local("the device clock is before the Unix epoch".into()))?;
                let timestamp = now.as_secs();
                if last.is_none_or(|previous| timestamp > previous) {
                    **last = Some(timestamp);
                    break timestamp;
                }
                // Wait locally, without sending or retrying a request. Recheck
                // the wall clock after waking, including after a clock rollback.
                tokio::time::sleep(Duration::from_secs(1)
                    - Duration::from_nanos(now.subsec_nanos() as u64)).await;
            };
            let message = format!("bitsov-pair-challenge-v1:{client_id}:{timestamp}");
            let mut authorization = reqwest::header::HeaderValue::from_str(
                &format!("PairChallenge {timestamp}:{}", key.sign_hex(message.as_bytes())),
            ).map_err(|_| PairError::Local("cannot encode pairing challenge authorization".into()))?;
            authorization.set_sensitive(true);
            request = request.header(reqwest::header::AUTHORIZATION, authorization);
        }
        let (status, text) = self.send(CHALLENGE, request).await?;
        if local && status == 401 {
            // Do not echo a response that could contain the authentication proof.
            return Err(PairError::Refused {
                step: CHALLENGE,
                status,
                reason: "paired client authentication failed; check the device clock and pairing with this node before reconnecting".into(),
            });
        }
        let Challenge { challenge } = decode(CHALLENGE, status, &text)?;
        if !challenge.starts_with(TOKEN_CHALLENGE_PREFIX) {
            return Err(PairError::Malformed {
                step: CHALLENGE,
                detail: "not a pairing token challenge".into(),
            });
        }
        let body = json!({
            "client_id": client_id,
            "signature": key.sign_hex(challenge.as_bytes()),
            "challenge": challenge,
        });
        let (status, text) = self
            .send(TOKEN, self.http.post(self.url(TOKEN)).json(&body))
            .await?;
        decode(TOKEN, status, &text)
    }

    /// `POST /auth/local` — the unchanged rc7 path, used only when the node
    /// has no pairing routes.
    pub(crate) async fn auth_local(&self) -> Result<String, PairError> {
        const STEP: &str = "/auth/local";
        #[derive(Deserialize)]
        struct Local {
            token: String,
        }
        let (status, text) = self.send(STEP, self.http.post(self.url(STEP))).await?;
        decode::<Local>(STEP, status, &text).map(|l| l.token)
    }

    /// `GET /bootstrap/state`. `None` when the node is not in bootstrap mode
    /// (the live router does not route it).
    pub(crate) async fn bootstrap_state(&self) -> Result<Option<String>, PairError> {
        const STEP: &str = "/bootstrap/state";
        #[derive(Deserialize)]
        struct State {
            state: String,
        }
        let (status, text) = self.send(STEP, self.http.get(self.url(STEP))).await?;
        if status == 404 {
            return Ok(None);
        }
        decode::<State>(STEP, status, &text).map(|s| Some(s.state))
    }
}

/// Decode a 2xx body, or turn anything else into a refusal carrying the
/// node's own `{"error": ...}` text, bounded.
fn decode<T: for<'de> Deserialize<'de>>(
    step: &'static str,
    status: u16,
    body: &str,
) -> Result<T, PairError> {
    if !(200..300).contains(&status) {
        // These are process-local proxy states, not a refusal by the node.
        if status == 503 && serde_json::from_str::<serde_json::Value>(body).ok()
            .is_some_and(|v| matches!(v["code"].as_str(),
                Some("remote_handshake_unavailable" | "remote_proxy_busy" | "remote_proxy_auth_busy"))) {
            return Err(PairError::Transport { step, detail: "connecting to your node".into() });
        }
        let reason = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned))
            .unwrap_or_else(|| body.trim().to_string());
        return Err(PairError::Refused {
            step,
            status,
            reason: reason.chars().take(160).collect(),
        });
    }
    serde_json::from_str(body).map_err(|e| PairError::Malformed {
        step,
        detail: e.to_string(),
    })
}

#[cfg(test)]
mod resilience_tests {
    use super::*;

    #[test]
    fn only_typed_proxy_unavailability_is_retryable_transport() {
        for code in ["remote_handshake_unavailable", "remote_proxy_busy"] {
            let body = serde_json::json!({ "code": code, "message": "connecting" }).to_string();
            assert!(matches!(decode::<serde_json::Value>("/pair/challenge", 503, &body), Err(PairError::Transport { .. })));
        }
        for status in [401, 403, 404, 503] {
            assert!(matches!(decode::<serde_json::Value>("/pair/challenge", status,
                r#"{"code":"pairing_refused","error":"no"}"#), Err(PairError::Refused { .. })));
        }
    }
}
