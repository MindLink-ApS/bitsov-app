//! App pairing client for the #77 ceremony (BitSov-bitsov `56c0ee0`, not in
//! any tag). **Less exposure, not solved local security.**
//!
//! Flow: `POST /pair/request` → read the `0600` challenge file the node named →
//! sign `pair_id || client_pubkey || challenge` → `POST /pair/confirm` →
//! `GET /pair/challenge` + `POST /pair/token` for a 10-minute token, refreshed
//! before expiry.
//!
//! Capability detection is one rule: a **404 on `/pair/request`** means the
//! node has no pairing routes (the pinned `v0.3.0-rc7` sidecar), and only then
//! does the app use `/auth/local`. Any other failure — a refusal, a bad proof,
//! a revoked pairing, an unreachable node, a tripped short code — is an error
//! the user sees. It is never downgraded to `/auth/local`.
//!
//! The short code is a tripwire, not a control: in the sidecar deployment the
//! app owns the node's stdout, so it can read that code by construction.

mod client;
pub(crate) mod key;

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub use client::PairingClient;
pub use key::{ClientKey, KEY_FILE};

/// Persisted pairing record (client id + scopes; no secret) in the store dir.
pub const RECORD_FILE: &str = "pairing.json";

/// Refresh a paired token once it has this little life left. Tokens live
/// 600 s (`PAIRED_TOKEN_VALIDITY_SECS`).
pub const REFRESH_MARGIN_SECS: i64 = 120;

/// Why pairing did not produce a session.
#[derive(Debug)]
pub enum PairError {
    /// The node answered and said no. Never a reason to fall back.
    Refused {
        step: &'static str,
        status: u16,
        reason: String,
    },
    /// The node could not be reached.
    Transport { step: &'static str, detail: String },
    /// The node answered with a body this client does not understand.
    Malformed { step: &'static str, detail: String },
    /// Local file or key problem.
    Local(String),
    /// The node's printed short code differs from the one derived from the
    /// challenge file. Nothing was signed.
    Tripwire { printed: String, derived: String },
}

impl std::fmt::Display for PairError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PairError::Refused {
                step,
                status,
                reason,
            } => write!(f, "the node refused {step} ({status}): {reason}"),
            PairError::Transport { step, detail } => {
                write!(f, "{step} could not reach the node: {detail}")
            }
            PairError::Malformed { step, detail } => {
                write!(f, "{step} returned an unexpected response: {detail}")
            }
            PairError::Local(message) => f.write_str(message),
            PairError::Tripwire { printed, derived } => write!(
                f,
                "pairing stopped: your node printed {printed}, but the challenge file gives \
                 {derived}. Nothing was signed."
            ),
        }
    }
}

impl std::error::Error for PairError {}

/// A paired session. `Debug` never prints the token.
#[derive(Clone)]
pub struct PairedSession {
    pub client_id: String,
    pub scopes: Vec<String>,
    pub token: String,
    /// Unix seconds.
    pub expires_at: i64,
}

impl std::fmt::Debug for PairedSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairedSession")
            .field("client_id", &self.client_id)
            .field("scopes", &self.scopes)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

impl PairedSession {
    /// True once the token is inside the refresh margin (or past expiry).
    pub fn needs_refresh(&self, now: i64) -> bool {
        now >= self.expires_at - REFRESH_MARGIN_SECS
    }
}

/// What the first-run ceremony showed.
#[derive(Debug, Clone)]
pub struct Ceremony {
    /// Short code derived from the challenge file.
    pub short_code: String,
    /// Whether the node's own printed code was captured and matched.
    pub node_printed: bool,
}

/// Result of [`establish`]. `Debug` never prints a token.
pub enum Established {
    /// Paired. `ceremony` is `None` when a stored pairing was reused.
    Paired {
        session: PairedSession,
        ceremony: Option<Ceremony>,
    },
    /// The node has no pairing routes (404 on `/pair/request`); `/auth/local`
    /// minted a token exactly as before.
    LocalFallback { token: String },
}

impl std::fmt::Debug for Established {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Established::Paired { session, ceremony } => f
                .debug_struct("Paired")
                .field("session", session)
                .field("ceremony", ceremony)
                .finish(),
            Established::LocalFallback { .. } => f.write_str("LocalFallback { .. }"),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Record {
    client_id: String,
    client_pubkey: String,
    scopes: Vec<String>,
}

/// Short-code lines the node printed to its own stdout, keyed by `pair_id`.
///
/// The app's stdout drain feeds [`PrintedCodes::record_line`]; the ceremony
/// waits briefly for the line matching its `pair_id`.
#[derive(Clone, Default)]
pub struct PrintedCodes(Arc<Mutex<HashMap<String, String>>>);

impl PrintedCodes {
    /// Parse `bitsov pairing code for "<pair_id>": <CODE>`. Returns whether
    /// the line was a pairing-code line.
    pub fn record_line(&self, line: &str) -> bool {
        let Some(rest) = line.trim().strip_prefix("bitsov pairing code for \"") else {
            return false;
        };
        let Some((pair_id, code)) = rest.split_once("\": ") else {
            return false;
        };
        let mut map = self.0.lock().unwrap();
        if map.len() >= 64 {
            map.clear();
        }
        map.insert(pair_id.to_string(), code.trim().to_string());
        true
    }

    async fn wait_for(&self, pair_id: &str, wait: Duration) -> Option<String> {
        let deadline = Instant::now() + wait;
        loop {
            if let Some(code) = self.0.lock().unwrap().remove(pair_id) {
                return Some(code);
            }
            if Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

/// The node's short code for a challenge (`konsensus-api` `short_code`).
pub fn short_code(challenge: &[u8]) -> String {
    const ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    let digest = blake3::keyed_hash(
        blake3::hash(b"bitsov-pair-shortcode-v1").as_bytes(),
        challenge,
    );
    let mut out = String::with_capacity(9);
    for (i, b) in digest.as_bytes().iter().take(8).enumerate() {
        if i == 4 {
            out.push('-');
        }
        out.push(ALPHABET[(*b as usize) % ALPHABET.len()] as char);
    }
    out
}

fn load_record(store: &Path, key: &ClientKey) -> Result<Option<Record>, PairError> {
    let path = store.join(RECORD_FILE);
    if !path.exists() {
        return Ok(None);
    }
    key::check_owner_only(&path, "pairing record")?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| PairError::Local(format!("cannot read the pairing record: {e}")))?;
    let record: Record = serde_json::from_str(&text)
        .map_err(|_| PairError::Local("the pairing record is corrupt".into()))?;
    if record.client_pubkey != key.public_hex() {
        return Err(PairError::Local(
            "the stored pairing belongs to a different client key".into(),
        ));
    }
    Ok(Some(record))
}

fn save_record(store: &Path, record: &Record) -> Result<(), PairError> {
    let path = store.join(RECORD_FILE);
    let tmp = store.join(format!("{RECORD_FILE}.tmp"));
    let _ = std::fs::remove_file(&tmp);
    let mut file = key::create_new_protected(&tmp)
        .map_err(|e| PairError::Local(format!("cannot write the pairing record: {e}")))?;
    let text = serde_json::to_vec(record).expect("record serializes");
    file.write_all(&text)
        .and_then(|()| file.sync_all())
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| PairError::Local(format!("cannot write the pairing record: {e}")))
}

/// Persist the ordinary pairing record returned by the encrypted remote
/// ingress authentication. This is the same record the local ceremony writes,
/// so token issuance and refresh stay on the existing pairing path.
pub fn save_remote_record(
    store: &Path,
    key: &ClientKey,
    client_id: String,
    scopes: Vec<String>,
) -> Result<(), PairError> {
    if client_id.is_empty() || client_id.len() > 256 {
        return Err(PairError::Local(
            "remote pairing returned an invalid client id".into(),
        ));
    }
    key::restrict_dir(store)?;
    save_record(
        store,
        &Record {
            client_id,
            client_pubkey: key.public_hex().to_string(),
            scopes,
        },
    )
}

/// Repair the narrow crash window after the remote one-time code was durably
/// removed but before its pairing record was saved. Ordinary returning
/// connections only validate the existing owner-only record and perform no
/// disk write.
pub fn save_remote_record_once(
    store: &Path,
    key: &ClientKey,
    client_id: String,
    scopes: Vec<String>,
) -> Result<(), PairError> {
    if load_record(store, key)?.is_some() {
        return Ok(());
    }
    save_remote_record(store, key, client_id, scopes)
}

/// Drop the stored pairing so the next [`establish`] runs the ceremony again.
pub fn forget_pairing(store: &Path) {
    let _ = std::fs::remove_file(store.join(RECORD_FILE));
}

/// Get a session: reuse a stored pairing, run the ceremony, or — only on a
/// 404 from `/pair/request` — fall back to `/auth/local`.
pub async fn establish(
    client: &PairingClient,
    key: &ClientKey,
    store: &Path,
    client_name: &str,
    codes: &PrintedCodes,
) -> Result<Established, PairError> {
    if let Some(record) = load_record(store, key)? {
        let issued = client.token(key, &record.client_id).await?;
        return Ok(Established::Paired {
            session: PairedSession {
                client_id: record.client_id,
                scopes: issued.scopes,
                token: issued.token,
                expires_at: issued.expires_at,
            },
            ceremony: None,
        });
    }

    let Some(request) = client.request(key, client_name).await? else {
        let token = client.auth_local().await?;
        return Ok(Established::LocalFallback { token });
    };

    let challenge = client.read_challenge(&request)?;
    let derived = short_code(&challenge);
    let printed = codes.wait_for(&request.pair_id, client.code_wait()).await;
    if let Some(printed) = &printed {
        if *printed != derived {
            return Err(PairError::Tripwire {
                printed: printed.clone(),
                derived,
            });
        }
    }

    let confirmed = client.confirm(key, &request.pair_id, &challenge).await?;
    save_record(
        store,
        &Record {
            client_id: confirmed.client_id.clone(),
            client_pubkey: key.public_hex().to_string(),
            scopes: confirmed.scopes,
        },
    )?;
    let issued = client.token(key, &confirmed.client_id).await?;
    Ok(Established::Paired {
        session: PairedSession {
            client_id: confirmed.client_id,
            scopes: issued.scopes,
            token: issued.token,
            expires_at: issued.expires_at,
        },
        ceremony: Some(Ceremony {
            short_code: derived,
            node_printed: printed.is_some(),
        }),
    })
}

/// Reuse a pairing established by the encrypted remote ingress.
///
/// Unlike [`establish`], absence of a record is an error. Remote mode must
/// never probe `/pair/request` and can therefore never downgrade to
/// `/auth/local`.
pub async fn establish_remote(
    client: &PairingClient,
    key: &ClientKey,
    store: &Path,
) -> Result<Established, PairError> {
    let record = load_record(store, key)?.ok_or_else(|| {
        PairError::Local(
            "remote transport authenticated but no paired client record was saved".into(),
        )
    })?;
    let issued = crate::connection_retry::while_connecting(
        || client.token(key, &record.client_id),
        |error| matches!(error, PairError::Transport { .. }),
        || PairError::Transport { step: "/pair/challenge", detail: "timed out connecting to your node after 30 seconds".into() },
    ).await?;
    Ok(Established::Paired {
        session: PairedSession {
            client_id: record.client_id,
            scopes: issued.scopes,
            token: issued.token,
            expires_at: issued.expires_at,
        },
        ceremony: None,
    })
}

/// Mint a fresh paired token for `session`, unconditionally.
pub async fn refresh(
    session: &mut PairedSession,
    client: &PairingClient,
    key: &ClientKey,
) -> Result<(), PairError> {
    let issued = client.token(key, &session.client_id).await?;
    session.token = issued.token;
    session.expires_at = issued.expires_at;
    session.scopes = issued.scopes;
    Ok(())
}

/// Refresh when inside [`REFRESH_MARGIN_SECS`] of expiry. Returns whether a
/// new token was minted.
pub async fn refresh_if_needed(
    session: &mut PairedSession,
    client: &PairingClient,
    key: &ClientKey,
    now: i64,
) -> Result<bool, PairError> {
    if !session.needs_refresh(now) {
        return Ok(false);
    }
    refresh(session, client, key).await?;
    Ok(true)
}

/// `GET /bootstrap/state`: `Some("bootstrap")` on an identity-free #77 node,
/// `None` on a live node (the route is not mounted there) or on rc7.
pub async fn bootstrap_state(client: &PairingClient) -> Result<Option<String>, PairError> {
    client.bootstrap_state().await
}

/// What the renderer learns about pairing. Carries no token and no key.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PairingView {
    /// The host is attached through the pinned remote transport.
    pub remote: bool,
    /// `starting` | `pending` | `paired` | `failed` | `fallback`.
    pub state: &'static str,
    pub scopes: Vec<String>,
    pub short_code: Option<String>,
    /// The code was read from the node's own stdout and matched.
    pub code_from_node: bool,
    pub reason: Option<String>,
    /// `bootstrap` on an identity-free node, else `None`.
    pub bootstrap: Option<String>,
}

impl PairingView {
    fn with_state(state: &'static str) -> Self {
        Self {
            remote: false,
            state,
            scopes: Vec::new(),
            short_code: None,
            code_from_node: false,
            reason: None,
            bootstrap: None,
        }
    }

    /// The node is not up yet.
    pub fn starting() -> Self {
        Self::with_state("starting")
    }

    /// The ceremony is in flight.
    pub fn pending() -> Self {
        Self::with_state("pending")
    }

    /// Map an [`establish`] result.
    pub fn from_outcome(outcome: &Result<Established, PairError>) -> Self {
        match outcome {
            Ok(Established::Paired { session, ceremony }) => Self {
                scopes: session.scopes.clone(),
                short_code: ceremony.as_ref().map(|c| c.short_code.clone()),
                code_from_node: ceremony.as_ref().is_some_and(|c| c.node_printed),
                ..Self::with_state("paired")
            },
            Ok(Established::LocalFallback { .. }) => Self::with_state("fallback"),
            Err(e) => Self {
                reason: Some(e.to_string()),
                ..Self::with_state("failed")
            },
        }
    }
}
