//! The AI track, host side: the app is the broker.
//!
//! The node never talks to a model. The main window asks the host for a
//! topic (`balance`, `payments`, …); the host reads it through the closed read
//! broker (`jarvis::broker`) with the paired token and returns the broker's
//! allowlisted projection plus how old it is. The window composes the answer
//! locally. Nothing leaves the machine for that.
//!
//! A remote model is optional and off by default. Its endpoint and key come
//! from a host-only file the window cannot write (`ai-providers.json` in the
//! app config dir; the key from an environment variable the file names).
//! Sending is two steps, and the second can only send what the first showed:
//!
//! 1. `disclose`: the host re-reads the topic, narrows it by a preset, and
//!    builds the exact request body. The body is kept in host memory under a
//!    random id and returned to the window verbatim for the owner to read.
//! 2. `send`: the owner's tap passes the id back. The host sends those stored
//!    bytes, once. The window cannot supply or edit them, and nothing is ever
//!    approved ahead of time.
//!
//! Presets only narrow: `exact` is the broker's projection unchanged,
//! `rounded` coarsens amounts and days and withholds node ids, and `counts`
//! keeps counts only. Each is a function of the broker output alone.

pub mod assistants;
pub mod threads;
pub mod tool_loop;
pub mod watches;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::jarvis::assistant_source::NodeAuth;
use crate::jarvis::broker::{
    AuditSink, BalanceInput, Broker, ChannelsInput, FreshnessState, HealthInput, LocalNodeRead,
    LocalPricesInput, MessageCountsInput, PaymentsInput, ReadRoute, RouteFreshness, Snapshot,
    ToolCall, ToolOutput,
};

/// The pairing scope that allows reads.
const READ_SCOPE: &str = "read";
/// A question sent out is at most this long.
pub const MAX_QUESTION_CHARS: usize = 500;
/// A disclosure the owner has not sent in this time is dropped.
pub const DISCLOSURE_TTL: Duration = Duration::from_secs(300);
/// Most pending disclosures kept at once. The oldest goes first.
const MAX_PENDING: usize = 8;
/// A remote answer is cut to this many characters.
pub const MAX_ANSWER_CHARS: usize = 4000;
/// A remote answer body larger than this is refused unread.
pub(crate) const MAX_REMOTE_BYTES: usize = 256 * 1024;
const REMOTE_TIMEOUT: Duration = Duration::from_secs(60);

// ---- topics ------------------------------------------------------------------

/// What the window may ask the host to read. Each maps to broker tool calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Topic {
    Balance,
    Channels,
    Node,
    Inbox,
    Prices,
    Payments,
}

impl Topic {
    fn calls(self, since_ms: Option<u64>) -> Vec<ToolCall> {
        match self {
            Self::Balance => vec![ToolCall::Balance {
                input: BalanceInput {},
            }],
            Self::Channels => vec![ToolCall::Channels {
                input: ChannelsInput {},
            }],
            Self::Node => vec![ToolCall::Health {
                input: HealthInput {},
            }],
            Self::Inbox => vec![ToolCall::MessageCounts {
                input: MessageCountsInput::default(),
            }],
            Self::Prices => vec![ToolCall::LocalPrices {
                input: LocalPricesInput {},
            }],
            Self::Payments => vec![ToolCall::Payments {
                input: PaymentsInput { since_ms },
            }],
        }
    }
}

// ---- freshness -----------------------------------------------------------------

/// How old the reads behind one answer are, as one worst case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Freshness {
    /// `fresh`, `stale` or `unknown`.
    pub state: &'static str,
    /// The oldest read's age when the host answered. `None` when unknown.
    pub age_ms: Option<u64>,
    /// Time left until the first route expires, independent of the oldest age.
    /// `None` when unknown, zero when already stale.
    pub fresh_for_ms: Option<u64>,
    /// Some age came from the node's `BitSov-Data-As-Of`, not only the read.
    pub node_as_of: bool,
    /// The node itself said `BitSov-Data-Stale: 1`.
    pub node_stale: bool,
    pub clock_skew: bool,
}

/// Worst case wins: any stale route (by age, or the node's own `Stale: 1`) is
/// stale; otherwise any route without node as-of evidence leaves the answer
/// unknown; only when every route has a known, in-bound age is it fresh.
pub fn summarize(routes: &[RouteFreshness], now: Instant) -> Freshness {
    let ages: Vec<Option<Duration>> = routes.iter().map(|route| route.age(now)).collect();
    let stale = routes
        .iter()
        .any(|route| route.state(now) == FreshnessState::Stale);
    let unknown = routes.is_empty() || ages.iter().any(Option::is_none);
    let state = if stale {
        FreshnessState::Stale
    } else if unknown {
        FreshnessState::Unknown
    } else {
        FreshnessState::Fresh
    };
    let age = ages.iter().flatten().max().copied();
    let fresh_for = match state {
        FreshnessState::Unknown => None,
        FreshnessState::Stale => Some(Duration::ZERO),
        FreshnessState::Fresh => routes
            .iter()
            .zip(&ages)
            .filter_map(|(route, age)| {
                age.map(|age| crate::jarvis::broker::stale_after(route.route).saturating_sub(age))
            })
            .min(),
    };
    Freshness {
        state: state.code(),
        age_ms: age
            .filter(|_| state != FreshnessState::Unknown)
            .map(|age| u64::try_from(age.as_millis()).unwrap_or(u64::MAX)),
        fresh_for_ms: fresh_for.map(|left| u64::try_from(left.as_millis()).unwrap_or(u64::MAX)),
        node_as_of: routes.iter().any(|route| route.as_of_ms.is_some()),
        node_stale: routes.iter().any(|route| route.node_stale),
        clock_skew: routes.iter().any(|route| route.clock_skew),
    }
}

// ---- reads ---------------------------------------------------------------------

/// Why the host did not read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoRead {
    /// No paired session with the `read` scope, or the node refused it.
    NotPaired,
    /// The node has no pairing routes (rc7). The broker does not read with
    /// the full-access `/auth/local` token.
    Rc7Fallback,
    NodeUnreachable,
}

/// One topic, read through the broker.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TopicRead {
    Live {
        topic: Topic,
        /// The broker's allowlisted outputs. Nothing else from the node.
        outputs: Vec<ToolOutput>,
        freshness: Freshness,
        /// The reads made, as `GET <path>`. Peer threads are collapsed.
        routes: Vec<String>,
    },
    Unavailable {
        topic: Topic,
        reason: NoRead,
    },
}

/// Collapse the routes read into display lines. No peer id is written.
fn route_lines(routes: &[ReadRoute]) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let threads = routes
        .iter()
        .filter(|route| matches!(route, ReadRoute::PeerMessages { .. }))
        .count();
    for route in routes {
        let line = match route {
            ReadRoute::PeerMessages { .. } => format!(
                "GET {}?peer=… ({threads} {})",
                route.target().path,
                if threads == 1 { "contact" } else { "contacts" }
            ),
            other => format!("GET {}", other.target().uri()),
        };
        if !lines.contains(&line) {
            lines.push(line);
        }
    }
    lines
}

/// Read `topic` from the local node with the paired token. Blocking (plain
/// `std::net` on loopback); callers keep it off the async runtime.
pub fn read_topic(
    auth: NodeAuth,
    base_url: &str,
    audit: Arc<dyn AuditSink>,
    topic: Topic,
    since_ms: Option<u64>,
) -> TopicRead {
    read_topic_with_proxy_auth(auth, base_url, audit, topic, since_ms, None)
}

/// Read a topic through the process-authenticated remote loopback proxy.
pub fn read_topic_with_proxy_auth(
    auth: NodeAuth,
    base_url: &str,
    audit: Arc<dyn AuditSink>,
    topic: Topic,
    since_ms: Option<u64>,
    proxy_auth: Option<Arc<str>>,
) -> TopicRead {
    let unavailable = |reason| TopicRead::Unavailable { topic, reason };
    let token = match auth {
        NodeAuth::NotPaired => return unavailable(NoRead::NotPaired),
        NodeAuth::Rc7Fallback => return unavailable(NoRead::Rc7Fallback),
        NodeAuth::Paired { token, scopes } => {
            if !scopes.iter().any(|scope| scope == READ_SCOPE) {
                return unavailable(NoRead::NotPaired);
            }
            token
        }
    };
    let Ok(node) = LocalNodeRead::new(base_url, token, audit) else {
        return unavailable(NoRead::NodeUnreachable);
    };
    let node = node.with_proxy_auth(proxy_auth);
    let Ok(broker) = Broker::new() else {
        return unavailable(NoRead::NodeUnreachable);
    };
    let snapshot = Snapshot::new(&node);
    let mut outputs = Vec::new();
    for call in topic.calls(since_ms) {
        match broker.dispatch(&snapshot, call) {
            Ok(done) => outputs.push(done.output().clone()),
            Err(_) => return unavailable(NoRead::NodeUnreachable),
        }
    }
    if snapshot.unauthorized() {
        return unavailable(NoRead::NotPaired);
    }
    if snapshot.transport_failed() && snapshot.freshness().is_empty() {
        return unavailable(NoRead::NodeUnreachable);
    }
    TopicRead::Live {
        topic,
        outputs,
        freshness: summarize(&snapshot.freshness(), Instant::now()),
        routes: route_lines(&snapshot.routes()),
    }
}

// ---- presets -------------------------------------------------------------------

/// What a disclosure keeps of the broker's output. Ordered widest first; each
/// is a narrowing of the one before.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Preset {
    /// The broker's allowlisted projection, unchanged.
    Exact,
    /// Amounts to two significant figures in whole sats, times to the day,
    /// node ids withheld.
    Rounded,
    /// Counts only. Every amount, time and id withheld; lists become their length.
    Counts,
}

const DAY_MS: u64 = 86_400_000;

/// Whole sats, rounded to two significant figures. 482,500 → 480,000; 7 → 7.
fn round_sats(msat: u64) -> u64 {
    let sats = (msat + 500) / 1000;
    let digits = sats.checked_ilog10().unwrap_or(0) + 1;
    if digits <= 2 {
        return sats;
    }
    let step = 10u64.pow(digits - 2);
    (sats + step / 2) / step * step
}

/// A node id, hash or other long hex token.
fn looks_like_id(text: &str) -> bool {
    text.len() >= 16 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn withheld(map: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    out.insert("state".into(), json!("withheld"));
    for key in ["unit", "source_field"] {
        if let Some(value) = map.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    Value::Object(out)
}

/// Narrow one broker output (as JSON) to `preset`. Pure; the result never
/// holds a value the input did not, other than a coarser number.
pub fn narrow(value: &Value, preset: Preset) -> Value {
    if preset == Preset::Exact {
        return value.clone();
    }
    match value {
        Value::Object(map) => {
            // `Amount`: {state, value?, unit, source_field, reason?}.
            if map.contains_key("unit") && map.contains_key("source_field") {
                return match (
                    map.get("state").and_then(Value::as_str),
                    map.get("unit").and_then(Value::as_str),
                ) {
                    (Some("available"), Some("count")) => value.clone(),
                    (Some("available"), Some("msat")) if preset == Preset::Rounded => {
                        match map.get("value").and_then(Value::as_u64) {
                            Some(msat) => {
                                let mut out = map.clone();
                                out.insert("state".into(), json!("rounded"));
                                out.remove("value");
                                out.insert("sats".into(), json!(round_sats(msat)));
                                Value::Object(out)
                            }
                            None => withheld(map),
                        }
                    }
                    (Some("available"), _) | (Some("rounded"), _) if preset == Preset::Rounded => {
                        value.clone()
                    }
                    (Some("available"), _) | (Some("rounded"), _) => withheld(map),
                    // Unavailable or already withheld: no figure to narrow.
                    _ => value.clone(),
                };
            }
            // `CopiedId`: {state: value, value}.
            if map.get("state").and_then(Value::as_str) == Some("value")
                && map.contains_key("value")
            {
                return json!({"state": "withheld"});
            }
            let mut out = Map::new();
            for (key, inner) in map {
                let narrowed = match (key.as_str(), inner) {
                    ("at_ms", Value::Number(number)) => match preset {
                        Preset::Rounded => json!(number.as_u64().map(|ms| ms / DAY_MS * DAY_MS)),
                        _ => json!({"state": "withheld"}),
                    },
                    ("at_ms", Value::Object(_)) | ("withheld_items", _) => inner.clone(),
                    _ => narrow(inner, preset),
                };
                out.insert(key.clone(), narrowed);
            }
            Value::Object(out)
        }
        Value::Array(items) => {
            let objects = items.iter().any(Value::is_object);
            if preset == Preset::Counts && objects {
                json!({ "withheld_items": items.len() })
            } else {
                Value::Array(items.iter().map(|item| narrow(item, preset)).collect())
            }
        }
        Value::String(text) if looks_like_id(text) => json!("withheld"),
        Value::Number(_) if preset == Preset::Counts => json!("withheld"),
        other => other.clone(),
    }
}

// ---- providers -----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    /// In the app: answers composed from the broker read. Nothing leaves.
    Local,
    /// A shared open-model endpoint.
    Shared,
    /// An optional frontier model.
    Frontier,
}

/// One remote entry in `ai-providers.json`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteConfig {
    pub label: String,
    /// Full URL of an OpenAI-compatible chat completions endpoint.
    pub endpoint: String,
    pub model: String,
    /// Environment variable holding the API key. The key is never in this
    /// file, never in the repo, and never reaches the window.
    #[serde(default)]
    pub key_env: Option<String>,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProvidersFile {
    #[serde(default)]
    pub shared: Option<RemoteConfig>,
    #[serde(default)]
    pub frontier: Option<RemoteConfig>,
}

/// A remote provider the host may send to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remote {
    pub kind: ProviderKind,
    pub label: String,
    pub endpoint: String,
    pub host: String,
    pub model: String,
    pub key_env: Option<String>,
}

/// How a provider is paid for, as far as this app knows. The app itself never
/// pays anyone: there is no spend path to a model, and no AI holds spend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PayRail {
    /// Nobody is paid through this app.
    None,
    /// The owner's own API key account with the provider, billed off-app.
    Fiat,
}

/// Who gets paid when the owner uses a provider. Derived from the kind and the
/// settings file only; the window cannot set it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Pays {
    /// The host whose operator bills the key. `None` when nobody is paid.
    pub to: Option<String>,
    pub rail: PayRail,
}

impl Pays {
    const NOBODY: Pays = Pays {
        to: None,
        rail: PayRail::None,
    };
}

/// A preview always starts at the narrowest preset. The owner may widen it for
/// one question in the preview, which shows the exact bytes before Send.
pub const DEFAULT_PRESET: Preset = Preset::Counts;

/// What the window sees of a provider: no endpoint path, no key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProviderView {
    pub kind: ProviderKind,
    pub label: String,
    pub enabled: bool,
    /// The host a disclosure would go to. `None` for local.
    pub host: Option<String>,
    pub model: Option<String>,
    /// Why it is off, in one line, when it is.
    pub note: Option<String>,
    /// Who gets paid when this provider answers.
    pub pays: Pays,
    /// What leaves the node: `None` means nothing (local, or off). Otherwise
    /// the preset a preview starts at; only the previewed bytes ever leave,
    /// and only after the owner presses Send.
    pub data_leaves: Option<Preset>,
}

/// Who is paid for a remote that is on: the host's operator when a key is
/// sent (billed to the owner's own account, off-app), otherwise nobody.
fn remote_pays(host: &str, key_env: Option<&str>) -> Pays {
    match key_env {
        Some(_) => Pays {
            to: Some(host.to_string()),
            rail: PayRail::Fiat,
        },
        None => Pays::NOBODY,
    }
}

/// `https://host[:port]/path`, or plain `http` to a loopback IP literal (a
/// model server on this machine). No credentials in the URL. Returns the host.
pub fn endpoint_host(endpoint: &str) -> Option<String> {
    let (scheme, rest) = endpoint.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() || authority.contains('@') || endpoint.chars().any(char::is_whitespace)
    {
        return None;
    }
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if !host.ends_with(']') && !host.contains(':') => {
            port.parse::<u16>().ok().filter(|port| *port != 0)?;
            host
        }
        Some((host, port)) if host.ends_with(']') => {
            port.parse::<u16>().ok().filter(|port| *port != 0)?;
            host
        }
        _ => authority,
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let loopback = bare
        .parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false);
    match scheme {
        "https" if !bare.is_empty() => Some(bare.to_ascii_lowercase()),
        "http" if loopback => Some(bare.to_string()),
        _ => None,
    }
}

const DEFAULT_LABELS: [(ProviderKind, &str); 2] = [
    (ProviderKind::Shared, "Shared open model"),
    (ProviderKind::Frontier, "Frontier model"),
];

/// Every provider, local first. Remote ones are off unless the file enables
/// them with a valid endpoint. A missing or unreadable file means local only.
///
/// `own_model` is the owner's picked loopback model (Own tier). It never
/// becomes a remote provider: chat stays on loopback via [`local::ask`], the
/// badge stays Own, and nothing is paid.
pub fn providers(
    file: Option<&ProvidersFile>,
    own_model: Option<&str>,
) -> (Vec<ProviderView>, Vec<Remote>) {
    let mut views = vec![ProviderView {
        kind: ProviderKind::Local,
        label: "On this computer".into(),
        enabled: true,
        host: None,
        model: own_model.and_then(|name| short(name, 80)),
        note: None,
        pays: Pays::NOBODY,
        data_leaves: None,
    }];
    let mut remotes = Vec::new();
    for (kind, default_label) in DEFAULT_LABELS {
        let entry = file.and_then(|file| match kind {
            ProviderKind::Shared => file.shared.as_ref(),
            _ => file.frontier.as_ref(),
        });
        let Some(entry) = entry else {
            views.push(ProviderView {
                kind,
                label: default_label.into(),
                enabled: false,
                host: None,
                model: None,
                note: Some("Off. Not set up on this computer.".into()),
                pays: Pays::NOBODY,
                data_leaves: None,
            });
            continue;
        };
        let host = endpoint_host(&entry.endpoint);
        let key_ok = entry.key_env.as_deref().is_none_or(valid_env_name);
        let note = if !entry.enabled {
            Some("Off in this computer's settings.".to_string())
        } else if host.is_none() {
            Some("Off. Its address is not https.".to_string())
        } else if !key_ok {
            Some("Off. Its key setting is not a variable name.".to_string())
        } else {
            None
        };
        let enabled = note.is_none();
        // Off means nothing can leave and nobody is paid.
        let (pays, data_leaves) = match (enabled, host.as_deref()) {
            (true, Some(host)) => (
                remote_pays(host, entry.key_env.as_deref()),
                Some(DEFAULT_PRESET),
            ),
            _ => (Pays::NOBODY, None),
        };
        views.push(ProviderView {
            kind,
            label: short(&entry.label, 60).unwrap_or_else(|| default_label.into()),
            enabled,
            host: host.clone(),
            model: short(&entry.model, 80),
            note,
            pays,
            data_leaves,
        });
        if let (true, Some(host)) = (enabled, host) {
            remotes.push(Remote {
                kind,
                label: short(&entry.label, 60).unwrap_or_else(|| default_label.into()),
                endpoint: entry.endpoint.clone(),
                host,
                model: entry.model.clone(),
                key_env: entry.key_env.clone(),
            });
        }
    }
    (views, remotes)
}

fn valid_env_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

pub fn short(text: &str, max: usize) -> Option<String> {
    let clean: String = text.chars().filter(|c| !c.is_control()).take(max).collect();
    let clean = clean.trim().to_string();
    (!clean.is_empty()).then_some(clean)
}

/// Read `ai-providers.json`. Missing, unreadable or invalid means none.
pub fn load_providers_file(path: &Path) -> Option<ProvidersFile> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

// ---- disclosure ----------------------------------------------------------------

/// The fixed instructions sent with every disclosure. Public, in source.
pub const SYSTEM_PROMPT: &str = "You answer a person's question about their own BitSov node, \
using only the JSON they send. Amounts are millisatoshis unless a field says sats. \
\"withheld\" and \"rounded\" mean the person chose not to share the exact value: do not guess it. \
If the data does not answer the question, say so in one sentence. Do not ask for more data, \
keys or passwords. Do not tell them to send or pay anything; the app does that only when they ask it to. \
Answer in at most four short sentences.";

/// What the owner is shown before anything leaves, and what is sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Disclosure {
    pub id: String,
    pub provider: ProviderKind,
    pub label: String,
    pub host: String,
    pub model: String,
    pub preset: Preset,
    /// The exact HTTP request body, byte for byte.
    pub body: String,
    pub bytes: usize,
    /// `Authorization` is sent from this variable, if set. Its value is not shown.
    pub key_env: Option<String>,
    pub expires_in_ms: u64,
}

/// Build the request body for `question` over `read`. `None` when the topic
/// was not read live: nothing is disclosed about a node the app cannot read.
pub fn request_body(
    remote: &Remote,
    question: &str,
    read: &TopicRead,
    preset: Preset,
) -> Option<String> {
    let TopicRead::Live {
        topic,
        outputs,
        freshness,
        ..
    } = read
    else {
        return None;
    };
    let data: Vec<Value> = outputs
        .iter()
        .map(|output| narrow(&serde_json::to_value(output).unwrap_or(Value::Null), preset))
        .collect();
    let user = json!({
        "question": question,
        "topic": topic,
        "shared": preset,
        "freshness": {
            "state": freshness.state,
            "age_seconds": freshness.age_ms.map(|ms| ms / 1000),
            "node_stale": freshness.node_stale,
        },
        "data": data,
    });
    let body = json!({
        "model": remote.model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": serde_json::to_string_pretty(&user).ok()?},
        ],
    });
    serde_json::to_string_pretty(&body).ok()
}

/// A question as it may leave: trimmed, controls dropped, capped.
pub fn clean_question(text: &str) -> Option<String> {
    let clean: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_QUESTION_CHARS)
        .collect();
    let clean = clean.trim().to_string();
    (!clean.is_empty()).then_some(clean)
}

struct Pending {
    remote: Remote,
    body: String,
    at: Instant,
}

/// Disclosures shown and not yet sent. Host memory only; single use.
#[derive(Default)]
pub struct Disclosures {
    pending: Mutex<HashMap<String, Pending>>,
}

fn new_id() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(hex::encode(bytes))
}

impl Disclosures {
    /// Keep `body` for `remote` and describe it. The body in the result is the
    /// stored body.
    pub fn hold(
        &self,
        remote: &Remote,
        preset: Preset,
        body: String,
        now: Instant,
    ) -> Option<Disclosure> {
        let id = new_id()?;
        let mut pending = self.pending.lock().unwrap();
        pending.retain(|_, held| now.saturating_duration_since(held.at) < DISCLOSURE_TTL);
        while pending.len() >= MAX_PENDING {
            let oldest = pending
                .iter()
                .min_by_key(|(_, held)| held.at)
                .map(|(id, _)| id.clone())?;
            pending.remove(&oldest);
        }
        let view = Disclosure {
            id: id.clone(),
            provider: remote.kind,
            label: remote.label.clone(),
            host: remote.host.clone(),
            model: remote.model.clone(),
            preset,
            bytes: body.len(),
            body: body.clone(),
            key_env: remote.key_env.clone(),
            expires_in_ms: DISCLOSURE_TTL.as_millis() as u64,
        };
        pending.insert(
            id,
            Pending {
                remote: remote.clone(),
                body,
                at: now,
            },
        );
        Some(view)
    }

    /// Take a disclosure to send it. Gone afterwards, sent or not.
    pub fn take(&self, id: &str, now: Instant) -> Option<(Remote, String)> {
        let held = self.pending.lock().unwrap().remove(id)?;
        (now.saturating_duration_since(held.at) < DISCLOSURE_TTL)
            .then_some((held.remote, held.body))
    }

    /// Drop a disclosure without sending it.
    pub fn cancel(&self, id: &str) -> bool {
        self.pending.lock().unwrap().remove(id).is_some()
    }
}

// ---- remote send ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteAnswer {
    pub provider: ProviderKind,
    pub label: String,
    pub host: String,
    pub model: String,
    /// Plain text. The window renders it as text and never acts on it.
    pub text: String,
    pub sent_bytes: usize,
}

/// First choice's message content, cleaned: controls other than newlines
/// dropped, capped at [`MAX_ANSWER_CHARS`].
pub fn answer_text(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let content = value
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()?;
    let clean: String = content
        .chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .take(MAX_ANSWER_CHARS)
        .collect();
    let clean = clean.trim().to_string();
    (!clean.is_empty()).then_some(clean)
}

/// Send the stored body once. The error text never quotes the response.
pub async fn send(
    remote: &Remote,
    body: String,
    key: Option<String>,
) -> Result<RemoteAnswer, String> {
    let https = remote.endpoint.starts_with("https://");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .https_only(https)
        .timeout(REMOTE_TIMEOUT)
        .build()
        .map_err(|_| "Could not start the request.".to_string())?;
    let sent_bytes = body.len();
    let mut request = client
        .post(&remote.endpoint)
        .header("content-type", "application/json")
        .body(body);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| format!("{} did not answer.", remote.label))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "{} refused the request (http {}).",
            remote.label,
            status.as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_REMOTE_BYTES as u64)
    {
        return Err(format!("{}'s answer was too large to show.", remote.label));
    }
    // Bound accumulation before appending, including chunked/unknown-length
    // responses. Parse only once the complete, bounded body has arrived.
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| format!("{} did not finish answering.", remote.label))?
    {
        if chunk.len() > MAX_REMOTE_BYTES.saturating_sub(bytes.len()) {
            return Err(format!("{}'s answer was too large to show.", remote.label));
        }
        bytes.extend_from_slice(&chunk);
    }
    let text =
        answer_text(&bytes).ok_or_else(|| format!("{}'s answer had no text.", remote.label))?;
    Ok(RemoteAnswer {
        provider: remote.kind,
        label: remote.label.clone(),
        host: remote.host.clone(),
        model: remote.model.clone(),
        text,
        sent_bytes,
    })
}

pub mod local;

#[cfg(test)]
mod tests;
