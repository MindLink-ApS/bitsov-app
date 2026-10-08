//! In-memory mock of the #77 pairing ceremony and identity-free bootstrap probe.
//!
//! Shapes follow BitSov-bitsov `56c0ee0` (#77, not in any tag):
//! `crates/konsensus-api/src/handlers/pairing_routes.rs`, `bootstrap.rs` and
//! `pairing.rs`. The historical `v0.3.0-rc7` node has none of these routes;
//! [`PairRoutes::Absent`] models that node.
//!
//! No socket and no crypto dependency: callers pass request parts to
//! [`PairingMock::handle`] and supply signatures, short codes and randomness
//! through [`PairCrypto`]. The one side effect is the challenge file, written
//! `0600` under the caller's temp data dir exactly as the node writes it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::ids::NODE_ID;

/// Pending ceremony lifetime (`PENDING_PAIRING_TTL`).
pub const PENDING_TTL_SECS: i64 = 120;

/// Crypto the mock needs, injected so this crate stays dependency-free.
pub trait PairCrypto: Send + Sync {
    /// Fill `out` with random bytes.
    fn random(&self, out: &mut [u8]);
    /// Verify a hex signature by `pubkey_hex` over `message`.
    fn verify(&self, pubkey_hex: &str, message: &[u8], signature_hex: &str) -> bool;
    /// The code the node prints to stdout for a challenge.
    fn short_code(&self, challenge: &[u8]) -> String;
    /// Stable client id for a public key.
    fn client_id(&self, pubkey_hex: &str) -> String;
}

/// Which router the mock node exposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairRoutes {
    /// `v0.3.0-rc7`: no `/pair/*`; `/auth/local` mints.
    Absent,
    /// #77 live router: pairing routes plus the unchanged `/auth/local`.
    Live,
    /// #77 identity-free bootstrap router: probe + ceremony only.
    Bootstrap,
}

/// Mock construction parameters.
#[derive(Debug, Clone)]
pub struct PairingMockConfig {
    /// Stand-in for the node's `data_dir` (a test temp dir).
    pub data_dir: PathBuf,
    /// Which router to expose.
    pub routes: PairRoutes,
    /// Paired token lifetime (`PAIRED_TOKEN_VALIDITY_SECS` = 600).
    pub token_ttl_secs: i64,
    /// Mock clock, Unix seconds.
    pub now: i64,
}

struct Pending {
    pubkey: String,
    challenge: Vec<u8>,
    expires_at: i64,
}

struct Client {
    pubkey: String,
    scopes: Vec<&'static str>,
}

#[derive(Default)]
struct Inner {
    now: i64,
    pending: HashMap<String, Pending>,
    clients: HashMap<String, Client>,
    token_challenges: HashMap<String, String>,
    tokens: HashMap<String, i64>,
    local_tokens: Vec<String>,
    calls: HashMap<String, usize>,
    stdout: Vec<String>,
    tokens_issued: usize,
    window_until: i64,
}

/// The mock node.
pub struct PairingMock {
    config: PairingMockConfig,
    crypto: Box<dyn PairCrypto>,
    inner: Mutex<Inner>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestBody {
    client_name: String,
    client_pubkey: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfirmBody {
    pair_id: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenBody {
    client_id: String,
    challenge: String,
    signature: String,
}

type Reply = (u16, String);

fn ok(value: Value) -> Reply {
    (200, value.to_string())
}

/// `ApiError` body: `{"error": ..., "code": ...}`.
fn err(code: u16, message: &str) -> Reply {
    (code, json!({ "error": message, "code": code }).to_string())
}

/// An unrouted path: axum's bare 404, no JSON.
fn unrouted() -> Reply {
    (404, String::new())
}

fn parse<T: for<'de> Deserialize<'de>>(body: &[u8]) -> Result<T, Reply> {
    // axum's `Json` rejects a well-formed body with the wrong fields as 422.
    serde_json::from_slice(body).map_err(|e| (422, e.to_string()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl PairingMock {
    /// Build a mock node.
    pub fn new(config: PairingMockConfig, crypto: Box<dyn PairCrypto>) -> Self {
        let inner = Inner {
            now: config.now,
            ..Inner::default()
        };
        Self {
            config,
            crypto,
            inner: Mutex::new(inner),
        }
    }

    /// Advance or rewind the mock clock.
    pub fn set_now(&self, now: i64) {
        self.inner.lock().unwrap().now = now;
    }

    /// Current mock clock.
    pub fn now(&self) -> i64 {
        self.inner.lock().unwrap().now
    }

    /// Lines the node printed to its own stdout.
    pub fn stdout_lines(&self) -> Vec<String> {
        self.inner.lock().unwrap().stdout.clone()
    }

    /// How many times `path` (no query) was called.
    pub fn calls(&self, path: &str) -> usize {
        *self.inner.lock().unwrap().calls.get(path).unwrap_or(&0)
    }

    /// Paired tokens issued so far.
    pub fn tokens_issued(&self) -> usize {
        self.inner.lock().unwrap().tokens_issued
    }

    /// Forget every paired client (models an owner-side revoke).
    pub fn revoke_all(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.clients.clear();
        inner.tokens.clear();
    }

    /// Owner-console pairing window; used by multi-client ceremony tests.
    pub fn open_pairing_window(&self, seconds: i64) {
        let mut inner = self.inner.lock().unwrap();
        inner.window_until = inner.now.saturating_add(seconds.max(0));
    }

    fn pairing_dir(&self) -> PathBuf {
        self.config.data_dir.join("pairing")
    }

    /// Handle one request. `target` is the path plus optional `?query`.
    pub fn handle(&self, method: &str, target: &str, bearer: Option<&str>, body: &[u8]) -> Reply {
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        *self
            .inner
            .lock()
            .unwrap()
            .calls
            .entry(path.to_string())
            .or_default() += 1;

        let routes = self.config.routes;
        let pairing = routes != PairRoutes::Absent;
        match (method, path) {
            ("GET", "/livez") if routes == PairRoutes::Bootstrap => (200, "ok".into()),
            ("GET", "/api/v1/health") if routes != PairRoutes::Bootstrap => {
                ok(json!({ "status": "ok" }))
            }
            ("POST", "/api/v1/auth/local") if routes != PairRoutes::Bootstrap => self.auth_local(),
            ("GET", "/api/v1/identity") if routes != PairRoutes::Bootstrap => self.identity(bearer),
            ("GET", "/api/v1/bootstrap/state") if routes == PairRoutes::Bootstrap => ok(json!({
                "state": "bootstrap",
                "can_restore": true,
                "can_create": true,
            })),
            ("POST", "/api/v1/pair/request") if pairing => self.request(body),
            ("POST", "/api/v1/pair/confirm") if pairing => self.confirm(body),
            ("GET", "/api/v1/pair/challenge") if pairing => self.token_challenge(query),
            ("POST", "/api/v1/pair/token") if pairing => self.token(body),
            _ => unrouted(),
        }
    }

    fn auth_local(&self) -> Reply {
        let mut inner = self.inner.lock().unwrap();
        let token = format!("local-{}", inner.local_tokens.len() + 1);
        inner.local_tokens.push(token.clone());
        ok(json!({ "token": token, "expires_in": 86_400 }))
    }

    fn identity(&self, bearer: Option<&str>) -> Reply {
        let inner = self.inner.lock().unwrap();
        let Some(token) = bearer else {
            return err(401, "missing bearer token");
        };
        let valid = inner.local_tokens.iter().any(|t| t == token)
            || inner.tokens.get(token).is_some_and(|exp| *exp > inner.now);
        if valid {
            ok(json!({ "node_id": NODE_ID }))
        } else {
            err(401, "invalid or expired token")
        }
    }

    fn request(&self, body: &[u8]) -> Reply {
        let body: RequestBody = match parse(body) {
            Ok(b) => b,
            Err(reply) => return reply,
        };
        let _ = body.client_name;
        if body.client_pubkey.is_empty() || !body.client_pubkey.bytes().all(|b| b.is_ascii_hexdigit()) {
            return err(400, "invalid client public key");
        }
        let mut challenge = vec![0u8; 32];
        self.crypto.random(&mut challenge);
        let mut id = [0u8; 16];
        self.crypto.random(&mut id);
        let pair_id = hex(&id);

        let mut inner = self.inner.lock().unwrap();
        // Without a window, pairing is accepted only while no client is paired.
        if !inner.clients.is_empty() && inner.window_until <= inner.now {
            return err(409, "pairing is closed: a client is already paired and no pairing window is open");
        }
        let expires_at = inner.now + PENDING_TTL_SECS;
        let dir = self.pairing_dir();
        let path = dir.join(format!("challenge-{pair_id}"));
        if let Err(e) = write_protected(&dir, &path, &challenge) {
            return err(500, &e.to_string());
        }
        let code = self.crypto.short_code(&challenge);
        inner
            .stdout
            .push(format!("bitsov pairing code for \"{pair_id}\": {code}"));
        inner.pending.insert(
            pair_id.clone(),
            Pending {
                pubkey: body.client_pubkey.to_ascii_lowercase(),
                challenge,
                expires_at,
            },
        );
        ok(json!({
            "pair_id": pair_id,
            "expires_at": expires_at,
            "challenge_path": path.display().to_string(),
        }))
    }

    fn confirm(&self, body: &[u8]) -> Reply {
        let body: ConfirmBody = match parse(body) {
            Ok(b) => b,
            Err(reply) => return reply,
        };
        let mut inner = self.inner.lock().unwrap();
        // Single use: consumed before the signature is checked.
        let Some(pending) = inner.pending.remove(&body.pair_id) else {
            return err(401, "unknown or expired pairing request");
        };
        let _ = std::fs::remove_file(self.pairing_dir().join(format!("challenge-{}", body.pair_id)));
        if pending.expires_at <= inner.now {
            return err(401, "unknown or expired pairing request");
        }
        let mut msg = body.pair_id.as_bytes().to_vec();
        msg.extend_from_slice(pending.pubkey.as_bytes());
        msg.extend_from_slice(&pending.challenge);
        if !self.crypto.verify(&pending.pubkey, &msg, &body.signature) {
            return err(401, "pairing proof did not verify");
        }
        let scopes = if self.config.routes == PairRoutes::Bootstrap {
            vec!["read", "receive", "identity"]
        } else {
            vec!["read", "receive"]
        };
        let client_id = self.crypto.client_id(&pending.pubkey);
        inner.clients.insert(
            client_id.clone(),
            Client {
                pubkey: pending.pubkey,
                scopes: scopes.clone(),
            },
        );
        ok(json!({ "client_id": client_id, "scopes": scopes }))
    }

    fn token_challenge(&self, query: &str) -> Reply {
        let Some(client_id) = query
            .split('&')
            .find_map(|kv| kv.strip_prefix("client_id="))
        else {
            return err(400, "missing client_id");
        };
        let mut nonce = [0u8; 32];
        self.crypto.random(&mut nonce);
        let mut inner = self.inner.lock().unwrap();
        if !inner.clients.contains_key(client_id) {
            return err(404, "unknown client");
        }
        let challenge = format!("bitsov-pair-token-v1:{}", hex(&nonce));
        inner
            .token_challenges
            .insert(challenge.clone(), client_id.to_string());
        ok(json!({ "challenge": challenge }))
    }

    fn token(&self, body: &[u8]) -> Reply {
        let body: TokenBody = match parse(body) {
            Ok(b) => b,
            Err(reply) => return reply,
        };
        let mut inner = self.inner.lock().unwrap();
        match inner.token_challenges.remove(&body.challenge) {
            Some(owner) if owner == body.client_id => {}
            _ => return err(401, "unknown or expired token challenge"),
        }
        let Some(client) = inner.clients.get(&body.client_id) else {
            return err(404, "unknown client");
        };
        if !self
            .crypto
            .verify(&client.pubkey, body.challenge.as_bytes(), &body.signature)
        {
            return err(401, "pairing proof did not verify");
        }
        let scopes = client.scopes.clone();
        inner.tokens_issued += 1;
        let token = format!("paired-{}", inner.tokens_issued);
        let expires_at = inner.now + self.config.token_ttl_secs;
        inner.tokens.insert(token.clone(), expires_at);
        ok(json!({ "token": token, "expires_at": expires_at, "scopes": scopes }))
    }
}

/// Write `bytes` at `0600` in a `0700` directory, as the node does.
fn write_protected(dir: &Path, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        std::io::Write::write_all(&mut f, bytes)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    std::fs::write(path, bytes)?;
    Ok(())
}
