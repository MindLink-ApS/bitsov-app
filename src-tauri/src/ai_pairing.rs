//! A5 authority preparation only. This module has no payment transport and
//! never accepts, exposes, or replaces the owner's token/grant. Console
//! approval/revocation remains the node's authority; status is read live.
use crate::{
    act,
    pairing::{self, ClientKey, Established, PairError, PairingClient, PrintedCodes},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::BTreeSet, path::Path};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Status,
    Create,
    RequestGrant { payees: Vec<String> },
}

#[derive(Clone, Serialize)]
pub struct Pending {
    #[serde(skip)]
    op_id: String,
    pub owner_action: String,
    pub expires_at_ms: u64,
}
#[derive(Serialize)]
pub struct Grant {
    pub budget_msat: u64,
    pub remaining_msat: u64,
    pub per_call_max_msat: u64,
    pub expires_at_ms: u64,
    pub payees: BTreeSet<String>,
    pub paused: bool,
}
#[derive(Serialize)]
pub struct View {
    pub pair_window: Option<String>,
    pub state: &'static str,
    pub client_id: Option<String>,
    pub grant: Option<Grant>,
    pub pending: Option<Pending>,
    pub grant_revoke: Option<String>,
    pub pair_revoke: Option<String>,
}
impl View {
    fn empty() -> Self {
        Self {
            pair_window: None,
            state: "none",
            client_id: None,
            grant: None,
            pending: None,
            grant_revoke: None,
            pair_revoke: None,
        }
    }
    fn paired(id: String, config: &str) -> Self {
        Self {
            state: "paired",
            grant_revoke: Some(format!("konsensus grant-revoke --client-id {id}{config}")),
            pair_revoke: Some(format!("konsensus pair-revoke --client-id {id}{config}")),
            pair_window: Some(format!("konsensus pair-window --seconds 300{config}")),
            client_id: Some(id),
            ..Self::empty()
        }
    }
}
#[derive(Default)]
pub struct AiPairing {
    pending: Option<Pending>,
}

fn id_valid(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}
fn payees(input: Vec<String>) -> Result<BTreeSet<String>, String> {
    if input.is_empty() || input.len() > 256 {
        return Err("Choose 1–256 AI payees.".into());
    }
    input
        .into_iter()
        .map(|p| {
            if !matches!(p.len(), 64 | 66) || !p.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("Use full hexadecimal payee IDs.".into());
            }
            Ok(p.to_ascii_lowercase())
        })
        .collect()
}
fn budget(payees: &BTreeSet<String>) -> serde_json::Value {
    // #290 installs its default breakers on every new grant. The proposal
    // schema does not accept breaker fields; the owner command pins them.
    json!({"budget_msat":1_000_000, "per_call_max_msat":55_000, "ttl_secs":86400,
        "payee_allowlist":payees, "allow_liquidity_fees":false})
}
fn config_suffix(config: Option<&Path>) -> Result<String, String> {
    match config {
        Some(p) => act::config_arg(p)
            .map(|p| format!(" --config {p}"))
            .ok_or_else(|| "Cannot safely display this node's configuration path.".into()),
        None => Ok(String::new()),
    }
}

impl AiPairing {
    /// Caller serializes this operation and supplies the host-resolved node
    /// and AI-only store (never renderer paths, keys, ids, tokens or commands).
    pub async fn update(
        &mut self,
        request: Request,
        client: &PairingClient,
        store: &Path,
        codes: &PrintedCodes,
        config: Option<&Path>,
        now: i64,
    ) -> Result<View, String> {
        let chosen_payees = match &request {
            Request::RequestGrant { payees: p } => Some(payees(p.clone())?),
            _ => None,
        };
        let config = config_suffix(config)?;
        if !store.join(pairing::RECORD_FILE).exists() && !matches!(request, Request::Create) {
            return if matches!(request, Request::Status) {
                Ok(View {
                    pair_window: Some(format!("konsensus pair-window --seconds 300{config}")),
                    ..View::empty()
                })
            } else {
                Err("Request an AI pairing first.".into())
            };
        }
        let key = ClientKey::load_or_create(store).map_err(|e| e.to_string())?;
        let stored = pairing::stored_client_id(store, &key).map_err(|e| e.to_string())?;
        if stored.as_ref().is_some_and(|id| !id_valid(id)) {
            return Err("Invalid AI client id.".into());
        }
        let mut result = pairing::establish_ai(client, &key, store, codes).await;
        // Only an explicit Create after a confirmed unknown client can replace
        // the AI record. A status poll never silently recreates revoked authority.
        if matches!(
            &result,
            Err(PairError::Refused {
                step: "/pair/challenge" | "/pair/token",
                status: 404,
                ..
            })
        ) {
            self.pending = None;
            if matches!(request, Request::Create) {
                pairing::forget_pairing(store);
                result = pairing::establish_ai(client, &key, store, codes).await;
            } else {
                let mut view = View::paired(stored.ok_or("Missing AI pairing record.")?, &config);
                view.state = "revoked";
                return Ok(view);
            }
        }
        let Established::Paired { session, .. } = result
            .map_err(|_| "AI pairing status could not be verified with your node.".to_string())?
        else {
            return Err("AI pairing cannot use local-owner authentication.".into());
        };
        if !id_valid(&session.client_id)
            || session
                .scopes
                .iter()
                .any(|s| !matches!(s.as_str(), "read" | "receive" | "spend"))
        {
            return Err(
                "AI pairing returned unexpected authority. No AI operation is available.".into(),
            );
        }
        let mut view = View::paired(session.client_id, &config);
        if matches!(request, Request::Create) && stored.is_none() {
            return Ok(view);
        }
        let (status, body) = client
            .ai_grant(&session.token)
            .await
            .map_err(|_| "AI grant status is unavailable.")?;
        if status != 200 {
            return Err("AI grant status is unavailable.".into());
        }
        let raw: serde_json::Value =
            serde_json::from_str(&body).map_err(|_| "AI grant status is unreadable.")?;
        let raw = raw.get("grant").ok_or("AI grant status is unreadable.")?;
        if !raw.is_null() {
            let live: NodeGrant = serde_json::from_value(raw.clone())
                .map_err(|_| "AI grant status is unreadable.")?;
            if live.client_id != view.client_id.as_deref().unwrap() {
                return Err("The node returned a grant for another client.".into());
            }
            if live.expires_at > now {
                view.state = if !live.safe(now) {
                    "unsafe"
                } else if live.breakers.as_ref().is_some_and(|b| b.paused) {
                    "paused"
                } else {
                    "active"
                };
                view.grant = Some(live.summary());
                self.pending = None;
                // Never replace an active/unsafe grant implicitly.
                if chosen_payees.is_some() {
                    return Err("Revoke the existing AI grant before requesting another.".into());
                }
                return Ok(view);
            }
        }
        if self
            .pending
            .as_ref()
            .is_some_and(|p| p.expires_at_ms <= (now.max(0) as u64).saturating_mul(1000))
        {
            self.pending = None;
        }
        if let Some(pending) = &self.pending {
            let (status, body) = client
                .ai_elevation_status(&session.token, &pending.op_id)
                .await
                .map_err(|_| "AI approval status is unavailable.")?;
            if status != 200 {
                return Err("AI approval status is unavailable.".into());
            }
            let reply: act::ElevationStatusReply =
                serde_json::from_str(&body).map_err(|_| "AI approval status is unreadable.")?;
            match reply.status.as_str() {
                "pending" => {}
                "granted" | "expired" | "lost" | "absent" => self.pending = None,
                _ => return Err("AI approval status is unreadable.".into()),
            }
        }
        if let Some(payees) = chosen_payees.filter(|_| self.pending.is_none()) {
            let (status, body) = client
                .ai_elevation(&session.token, budget(&payees))
                .await
                .map_err(|_| "AI grant request did not finish. Check status before retrying.")?;
            if status != 200 && status != 202 {
                return Err("Your node refused the AI grant request.".into());
            }
            let reply: act::ElevationReply =
                serde_json::from_str(&body).map_err(|_| "AI grant request reply is unreadable.")?;
            if reply.op_id.is_empty()
                || reply.op_id.len() > 64
                || !reply.op_id.bytes().all(|b| b.is_ascii_hexdigit())
                || reply.expires_at <= now
            {
                return Err("AI grant request reply is invalid.".into());
            }
            if !reply
                .owner_action
                .trim_start()
                .starts_with("konsensus grant --op ")
            {
                return Err("This node has no owner-console grant approval.".into());
            }
            // Construct from validated data. Never turn node-provided prose into
            // a command the owner might paste into their shell.
            let payee_flags = payees
                .iter()
                .map(|p| format!(" --payee {p}"))
                .collect::<String>();
            self.pending = Some(Pending { op_id: reply.op_id.clone(), expires_at_ms: (reply.expires_at as u64).saturating_mul(1000),
                owner_action: format!("konsensus grant --op {} --budget 1000 --for 24h --per-call 55{payee_flags} --max-payments-per-minute 10 --max-payments-per-hour 60 --max-consecutive-failures 5 --max-sats-per-10-minutes 1000{config}", reply.op_id) });
        }
        view.pending = self.pending.clone();
        if view.pending.is_some() {
            view.state = "pending";
        }
        Ok(view)
    }
}

#[derive(Deserialize)]
struct Limits {
    max_payments_per_minute: u64,
    max_payments_per_hour: u64,
    max_consecutive_failures: u64,
    max_msat_per_10_minutes: u64,
}
#[derive(Deserialize)]
struct Breakers {
    limits: Limits,
    paused: bool,
}
#[derive(Deserialize)]
struct NodeGrant {
    client_id: String,
    expires_at: i64,
    budget_msat: u64,
    remaining_msat: u64,
    per_call_max_msat: u64,
    payee_allowlist: Option<BTreeSet<String>>,
    breakers: Option<Breakers>,
    #[serde(default)]
    allow_liquidity_fees: bool,
}
impl NodeGrant {
    fn safe(&self, now: i64) -> bool {
        self.budget_msat > 0
            && self.budget_msat <= 1_000_000
            && self.remaining_msat <= self.budget_msat
            && self.per_call_max_msat > 0
            && self.per_call_max_msat <= 55_000
            && self.expires_at > now
            && self.expires_at <= now.saturating_add(86400)
            && !self.allow_liquidity_fees
            && self
                .payee_allowlist
                .as_ref()
                .is_some_and(|p| payees(p.iter().cloned().collect()).is_ok())
            && self.breakers.as_ref().is_some_and(|b| {
                let l = &b.limits;
                (1..=10).contains(&l.max_payments_per_minute)
                    && (1..=60).contains(&l.max_payments_per_hour)
                    && (1..=5).contains(&l.max_consecutive_failures)
                    && (1..=1_000_000).contains(&l.max_msat_per_10_minutes)
            })
    }
    fn summary(self) -> Grant {
        Grant {
            budget_msat: self.budget_msat,
            remaining_msat: self.remaining_msat,
            per_call_max_msat: self.per_call_max_msat,
            expires_at_ms: (self.expires_at.max(0) as u64).saturating_mul(1000),
            payees: self.payee_allowlist.unwrap_or_default(),
            paused: self.breakers.is_some_and(|b| b.paused),
        }
    }
}
