// bitsov-app — CS-1 desktop shell + CS-2 first-run fund flow.
//
// BOUNDARY (charter Gate G1): this app CONSUMES the public BitSov node API over
// loopback. It bundles the released `konsensus` node BINARY as a Tauri sidecar and
// supervises it as a subprocess. It does NOT link the `konsensus-*` crates and does
// NOT fork protocol logic. See docs/ARCHITECTURE_BOUNDARY.md and docs/API_READINESS.md.
//
// Scope: app shell -> bundle/spawn node -> loopback auth -> identity
// screen -> first-run funding (onboarding/start, funding address + QR, poll to
// funding-seen, balance) and mnemonic restore; then the control center: reads
// (peers, rooms + members, messages, pricing, balance + channels, node status,
// `/ws` live events bridged to the main window) and actions (compose incl. paid
// first contact, invoice, pay, keysend, invite create/redeem, file send), every
// spending one behind the owner's short-lived spend window (`bitsov_app::act`).
// No channel opening, on-chain send, mobile, calls, hosted, or AI runtime.
//
// A dev-only `assistant` window can display text. It is not a model, it has no
// network, and it cannot call privileged commands (capability ACL + the
// window-label check below). With `--features sit-mock` and BITSOV_ASSISTANT=1
// (`npm run tauri:assistant`) startup is assistant-only: sealed window, no
// NodeState, no wallet commands, no bootstrap_node / konsensus. Release and
// normal debug startup are unchanged.
//
// AUTH: the host pairs with the node (#77 ceremony, `bitsov_app::pairing`) and
// falls back to `/auth/local` ONLY when `/pair/request` is 404 — the pinned rc7
// sidecar. A pairing refusal is shown as an error, never downgraded.
//
// KEYS (charter invariant A.3): the node is the identity anchor. This host never
// holds, derives, or displays node key material. It holds one key of its own: the
// pairing client key (0600 under the app data dir), which proves nothing beyond
// read access to that dir. The loopback JWT lives in `NodeState` and is attached
// to requests here — it is never returned to the renderer, and no command response
// type carries a token, a mnemonic, or a private key.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bitsov_app::act::{self, ActionError};
use bitsov_app::budget::{self, Book};
use bitsov_app::grant::{self, NodeGrant};
use bitsov_app::ai;
use bitsov_app::control;
use bitsov_app::spend_journal::{self, Journal, Target};
use bitsov_app::jarvis::assistant_source::{Feed, MockReason, NodeAuth};
use bitsov_app::jarvis::broker::BearerToken;
use bitsov_app::pairing::{
    self, ClientKey, Established, PairError, PairedSession, PairingClient, PairingView,
    PrintedCodes,
};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use shared_child::unix::SharedChildExt;
use shared_child::SharedChild;
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow};
use tauri_plugin_shell::ShellExt;

// macOS model launcher. The implementation is `cfg(target_os = "macos")`; the
// module is always parsed so a syntax error still fails the Linux Build job.
#[allow(dead_code)]
mod model_launch;

// DEV ONLY: run a locally built genome-`main` node instead of the verified sidecar.
// Compiled out of release builds (compile error with the feature). See the module.
mod dev_node;
// Secure Enclave device key bridge (the only FFI `unsafe`; lib crate forbids it).
mod device_key;
// This Mac as a paired device: registration, signed envelopes, persisted approvals.
mod device;
mod owner_contact;

/// Node API bind — konsensus ApiConfig `default_api_addr()` = 127.0.0.1:3141.
/// Loopback ONLY (Gate G2): never point this at a non-loopback host until a
/// confidential remote transport + delegated auth exist. Release builds always use
/// this; only a debug `dev-node` build may move the port (`dev_node::api_base`).
const API_BASE: &str = "http://127.0.0.1:3141/api/v1";

/// Pinned onboarding contract (BitSov-bitsov `v0.3.0-rc7` / `958e399`): the funding
/// state machine moves to this step once the node has observed the required deposit
/// in its own wallet. Kept host-side so the renderer never re-implements the contract.
const FUNDING_SEEN: &str = "funding-seen";

/// The node throttles `/auth/local` to 5 mints per minute (SEC1). Only the 401
/// refresh path is rate-limited here — a persistent 401 must not grind that budget.
const REMINT_COOLDOWN: Duration = Duration::from_secs(30);

/// Graceful-shutdown budget for the supervised node on quit (app #16).
/// Must exceed the node's own shutdown cost: it allows up to 15s for the
/// Lightning backend alone so LDK can flush ChannelMonitor persistence.
/// Name of the bundled node binary, used to prove a pid is still our own child
/// before any raw signal is sent (app #16 review, finding 1).
const SIDECAR_BIN: &str = "konsensus";

/// Must exceed the node's own shutdown cost: it allows up to 15s for the Lightning
/// backend alone so LDK can flush ChannelMonitor persistence.
const NODE_SHUTDOWN_BUDGET: Duration = Duration::from_secs(30);

/// App-owned pairing store under the app data dir: the client key and the
/// pairing record. Separate from the node's own `<data_dir>/pairing`.
const PAIRING_STORE_DIR: &str = "app-client";

/// Name the node shows the owner for this client.
const PAIRING_CLIENT_NAME: &str = "BitSov app";

/// How the current token was obtained.
enum AuthMode {
    Unauthenticated,
    /// rc7 node without pairing routes: `/auth/local`, unchanged.
    Local,
    /// #77 pairing. The session's token mirrors `NodeState::token`.
    Paired(PairedSession),
}

struct PairingCtx {
    client: PairingClient,
    key: ClientKey,
    store: PathBuf,
    data_dir: PathBuf,
}

struct NodeState {
    ready: Mutex<bool>,
    node_id: Mutex<Option<String>>,
    error: Mutex<Option<String>>,
    /// Supervised node process; killed on app exit so no orphan node is left running.
    /// The supervised node, owned through `SharedChild` so signalling stays
    /// synchronised with reaping (app #16 review). A node being stopped for a restart
    /// stays registered here until it has exited, so a quit meanwhile still finds it.
    child: Mutex<Option<Arc<SharedChild>>>,
    /// Set by the exit handler, under the `child` lock, before it takes the node. Once
    /// set, no node is spawned again (see `NodeState::spawn_child`).
    quitting: AtomicBool,
    /// The loopback JWT lives here and nowhere else (see the KEYS note above).
    token: Mutex<Option<String>>,
    /// The supervised node's `konsensus.toml`. Captured at bootstrap so a restore can
    /// restart the SAME data dir without re-running `init`.
    config: Mutex<Option<PathBuf>>,
    /// Fee policy from the configuration handed to the supervised node at start.
    /// No room quote guesses a policy if this snapshot is unavailable.
    room_routing_policy: Mutex<Option<(String, act::RoutingFeePolicy)>>,
    /// The LDK network from that same configuration (`mainnet`, `regtest`, …).
    /// Display only: a chat invoice for another network is shown as text.
    configured_network: Mutex<Option<String>>,
    /// DEV ONLY (`dev_node`): an unverified node binary to run instead of the bundled
    /// sidecar. Always `None` in release builds.
    dev_sidecar: Mutex<Option<PathBuf>>,
    /// DEV ONLY (`dev_node::resolve_external`): the data dir of a node the owner
    /// runs. While set, the app never inits, starts, restarts or stops a node, and
    /// only reads this dir (pairing challenges). Always `None` in release builds.
    external_node: Mutex<Option<PathBuf>>,
    /// Where the app keeps its own files (spend journal, budgets). `None` means
    /// next to the supervised node's config, as before external mode.
    app_dir: Mutex<Option<PathBuf>>,
    /// Last throttled re-mint attempt, for `REMINT_COOLDOWN`.
    last_remint: Mutex<Option<Instant>>,
    /// Set by the wait thread when the supervised node exits.
    sidecar_terminated: AtomicBool,
    /// The `/ws` link as the bridge's socket last reported it (`live_link`).
    live_link: control::LiveLink,
    http: reqwest::Client,
    /// `API_BASE` in the app; an ephemeral loopback port in tests.
    api_base: String,
    auth: Mutex<AuthMode>,
    pairing: Mutex<Option<Arc<PairingCtx>>>,
    pairing_view: Mutex<PairingView>,
    /// Short codes the node printed to its stdout (the tripwire).
    printed_codes: PrintedCodes,
    /// The node answered 404 for this client's stored pairing (revoked or
    /// forgotten). A user retry may then run a fresh ceremony.
    stale_pairing: AtomicBool,
    /// The owner's spend window. Memory only: never persisted, gone on quit.
    spend: Mutex<act::SpendGate>,
    spend_timeout: Duration,
    /// The owner's budget approval (B2). Memory only, like `spend`.
    autopay: Mutex<budget::Autopay>,
    /// What the owner's pending elevation request should open once granted.
    wants: Mutex<Wants>,
    /// The G1 node grant (`GET /pair/grant`) this run's approvals were opened
    /// under, as last read. `Some` means every paid request re-reads it first.
    /// Memory only, like `spend`.
    node_grant: Mutex<Option<NodeGrant>>,
    /// This run observed the fee-aware quote contract for this node identity.
    all_in_caps_node: Mutex<Option<String>>,
    /// The contact's re-admission quote the owner was last asked about
    /// (`readmission_quoted`), for this node identity. Memory only.
    readmission_ask: Mutex<Option<ReadmissionAsk>>,
    /// Serializes this process's budget-file read-modify-write.
    budget_io: Mutex<()>,
    /// Serializes every money action: each money POST (send, retry, payment,
    /// file) from journal check to final save, pending-result reconcile, and
    /// stopping a retry. A reconcile never reads a record a live POST is
    /// still going to rewrite. Held across awaits, hence async.
    money: tokio::sync::Mutex<()>,
    owner_contact: Mutex<Option<owner_contact::Pending>>,
    /// The pending owner request for `front_door` (publish the front-door
    /// card only), so repeated Publish presses reuse one request. Memory only.
    front_door_ask: Mutex<Option<act::Elevation>>,
    /// Who must approve each device-key signature. Always Touch ID outside
    /// tests; tests use enclave keys that sign without a prompt.
    device_policy: Mutex<device_key::Policy>,
    /// The last device registration lapsed (expired or cancelled at the node).
    device_lapsed: AtomicBool,
    /// A pending console approval saved by an earlier run was loaded once.
    approvals_restored: AtomicBool,
}

/// The owner asked for these while an elevation request is pending.
/// A contact's signed re-admission quote shown to the owner. A send of exactly
/// its total to exactly that contact, before it expires, is the owner's OK for
/// it: that send carries the quote's routing ceilings for both payments.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ReadmissionAsk {
    node_id: String,
    peer: String,
    total_msat: u64,
    max_routing_fee_msat: u64,
    expires_at_ms: u64,
}

#[derive(Default, Clone, Copy, Debug)]
struct Wants {
    window: bool,
    budget: Option<u64>,
}

#[derive(Clone, Copy, Debug)]
enum Want {
    Window,
    Budget(u64),
}

impl Default for NodeState {
    fn default() -> Self {
        // Release builds: always API_BASE; the environment is not read (see `dev_node`).
        // A bad dev override stops here rather than fall back to a pilot on 3141.
        let api_base = dev_node::api_base(API_BASE).unwrap_or_else(|e| {
            eprintln!("[dev-node] {e}");
            std::process::exit(2)
        });
        Self::for_api(api_base)
    }
}

impl NodeState {
    fn for_api(api_base: impl Into<String>) -> Self {
        Self {
            api_base: api_base.into(),
            auth: Mutex::new(AuthMode::Unauthenticated),
            pairing: Mutex::new(None),
            pairing_view: Mutex::new(PairingView::starting()),
            printed_codes: PrintedCodes::default(),
            stale_pairing: AtomicBool::new(false),
            spend: Mutex::new(act::SpendGate::default()),
            spend_timeout: Duration::from_secs(120),
            autopay: Mutex::new(budget::Autopay::default()),
            wants: Mutex::new(Wants::default()),
            owner_contact: Mutex::new(None),
            front_door_ask: Mutex::new(None),
            device_policy: Mutex::new(device_key::Policy::Biometry),
            device_lapsed: AtomicBool::new(false),
            approvals_restored: AtomicBool::new(false),
            node_grant: Mutex::new(None),
            all_in_caps_node: Mutex::new(None),
            readmission_ask: Mutex::new(None),
            budget_io: Mutex::new(()),
            money: tokio::sync::Mutex::new(()),
            ready: Mutex::new(false),
            node_id: Mutex::new(None),
            error: Mutex::new(None),
            child: Mutex::new(None),
            quitting: AtomicBool::new(false),
            token: Mutex::new(None),
            config: Mutex::new(None),
            room_routing_policy: Mutex::new(None),
            configured_network: Mutex::new(None),
            dev_sidecar: Mutex::new(None),
            external_node: Mutex::new(None),
            app_dir: Mutex::new(None),
            last_remint: Mutex::new(None),
            sidecar_terminated: AtomicBool::new(false),
            live_link: control::LiveLink::default(),
            // Bounded so a hung loopback /health or /auth/local cannot pin restoring().
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(5))
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("reqwest client"),
        }
    }
}

#[derive(Serialize, Clone)]
struct Status {
    ready: bool,
    node_id: Option<String>,
    error: Option<String>,
}

/// `GET /onboarding/state` / `POST /onboarding/start` (OnboardingStateResponse).
/// Optional members are omitted rather than null by the node, hence `default`.
#[derive(Serialize, Deserialize, Clone)]
struct FundState {
    current_step: String,
    #[serde(default)]
    tier: Option<String>,
    #[serde(default)]
    funding_address: Option<String>,
    #[serde(default)]
    funding_amount_sats_required: Option<u32>,
    #[serde(default)]
    funding_amount_sats_received: u32,
    #[serde(default)]
    funding_evidence: Option<String>,
    /// Derived from `current_step` here so the pinned step literal has one home.
    #[serde(skip_deserializing)]
    funded: bool,
}

/// `GET /payments/funding-address`.
#[derive(Serialize, Deserialize)]
struct FundingAddress {
    address: String,
    #[serde(default)]
    network: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

/// `GET /payments/balance`.
#[derive(Serialize, Deserialize)]
struct Balance {
    balance_msat: u64,
}

/// `POST /identity/restore` (RestoreResponse) — node-side shape.
#[derive(Deserialize)]
struct RestoreResponse {
    node_id: String,
    restart_required: bool,
}

/// What the renderer learns about a restore. Carries no key material.
#[derive(Serialize)]
struct RestoreOutcome {
    node_id: String,
    restart_required: bool,
    restarted: bool,
}

fn set_error(state: &NodeState, msg: impl Into<String>) {
    *state.error.lock().unwrap() = Some(msg.into());
}

// ---- node supervision -----------------------------------------------------

/// First run only: `konsensus init` generates identity + config (tier full = fund-your-node).
async fn init_node(
    app: &AppHandle,
    data_dir: &Path,
    dev_sidecar: Option<&Path>,
) -> Result<(), String> {
    let cmd = match dev_sidecar {
        Some(program) => app.shell().command(program),
        None => app
            .shell()
            .sidecar("konsensus")
            .map_err(|e| format!("cannot resolve node sidecar: {e}"))?,
    };
    let cmd = cmd.args([
            "init",
            "--dir",
            &data_dir.to_string_lossy(),
            "--non-interactive",
            "--tier",
            "full",
        ]);
    match cmd.output().await {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => Err(format!(
            "node init failed (exit {:?}): {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        )),
        Err(e) => Err(format!("node init could not run: {e}")),
    }
}

/// Start + supervise `konsensus start`. Never re-inits: the caller guarantees the
/// config (and therefore the identity) already exists. The config is started exactly
/// as `init` wrote it — this host never edits it.
/// Resolve the bundled sidecar exactly as `tauri-plugin-shell` does, so the path is
/// identical in dev and in a bundle: next to the current executable, stepping out of
/// `deps/` when running under a test harness.
fn sidecar_path(name: &str) -> Result<PathBuf, String> {
    let exe = tauri::utils::platform::current_exe()
        .map_err(|e| format!("cannot resolve current exe: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "current exe has no parent".to_string())?;
    let base = if dir.ends_with("deps") {
        dir.parent().unwrap_or(dir)
    } else {
        dir
    };
    let mut path = base.join(name);
    if cfg!(windows) && path.extension().is_none() {
        path.set_extension("exe");
    }
    Ok(path)
}

/// Start the node and take ownership of the process.
///
/// We spawn through `SharedChild` rather than the shell plugin (app #16 review). The
/// plugin hands back only a pid and a SIGKILL, and it reaps on its own thread — so a
/// graceful `kill -TERM <pid>` from us could land on a reused pid. `SharedChild` waits
/// with POSIX `waitid`, which does NOT free the pid for reuse, making `send_signal`
/// safe by construction rather than by a check we race against.
///
/// Everything the plugin gave us is preserved explicitly: stdout/stderr are drained to
/// the app log, and a wait thread records termination for the health fail-fast.
fn spawn_node(app: &AppHandle<impl tauri::Runtime>, config: &Path) -> Result<(), String> {
    let state = app.state::<NodeState>();
    let dev_sidecar = state.dev_sidecar.lock().unwrap().clone();
    let dev = dev_sidecar.is_some();
    let program = match dev_sidecar {
        Some(program) => program,
        None => sidecar_path(SIDECAR_BIN)?,
    };
    let mut cmd = std::process::Command::new(&program);
    cmd.args(node_start_args(config, dev))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    state.sidecar_terminated.store(false, Ordering::SeqCst);
    *state.all_in_caps_node.lock().unwrap() = None;
    *state.readmission_ask.lock().unwrap() = None;
    let routing_policy = configured_routing_policy(config);
    let network = configured_network(config);
    let child = state.spawn_child(&mut cmd)?;
    *state.room_routing_policy.lock().unwrap() = routing_policy;
    *state.configured_network.lock().unwrap() = network;

    // Drain node output to the app log — never render node plaintext in the UI.
    // The one exception is parsed, not rendered: the pairing short code the node
    // prints to stdout, kept for the tripwire comparison.
    for (label, pipe) in [
        ("out", child.take_stdout().map(PipeKind::Out)),
        ("err", child.take_stderr().map(PipeKind::Err)),
    ] {
        if let Some(pipe) = pipe {
            let codes = (label == "out").then(|| state.printed_codes.clone());
            std::thread::spawn(move || {
                let reader: Box<dyn std::io::Read + Send> = match pipe {
                    PipeKind::Out(p) => Box::new(p),
                    PipeKind::Err(p) => Box::new(p),
                };
                let reader = std::io::BufReader::new(reader);
                for line in std::io::BufRead::lines(reader).map_while(Result::ok) {
                    if let Some(codes) = &codes {
                        codes.record_line(&line);
                    }
                    eprintln!("[node/{label}] {line}");
                }
            });
        }
    }

    // Exit detection: the fail-fast signal for wait_for_health, so a dead child does
    // not burn the full health budget.
    let handle = app.clone();
    let waiter = child.clone();
    std::thread::spawn(move || {
        let status = waiter.wait();
        eprintln!("[node] terminated: {status:?}");
        handle
            .state::<NodeState>()
            .sidecar_terminated
            .store(true, Ordering::SeqCst);
    });
    Ok(())
}

/// `konsensus start` arguments. The dev-node path (a node the developer built
/// and runs as its owner, `dev_node`) adds `--owner-control`, so the owner can
/// grant a spend budget with `konsensus grant --op …` from the terminal that
/// started the app. Without it the node answers every elevation request with
/// "unavailable in this deployment" and the dev path can never spend. The
/// bundled sidecar (every release build) never gets the flag.
fn node_start_args(config: &Path, dev_node: bool) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec!["start".into(), "--config".into(), config.into()];
    if dev_node {
        args.push("--owner-control".into());
    }
    args
}

enum PipeKind {
    Out(std::process::ChildStdout),
    Err(std::process::ChildStderr),
}

async fn health_ok(state: &NodeState) -> bool {
    state
        .http
        .get(format!("{}/health", state.api_base))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

async fn wait_for_health(state: &NodeState) -> Result<(), String> {
    for _ in 0..60 {
        if health_ok(state).await {
            return Ok(());
        }
        if state.sidecar_terminated.load(Ordering::SeqCst) {
            return Err("node sidecar terminated before becoming healthy".into());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Err("node did not become healthy within 60s".into())
}

/// The port of a loopback `http://127.0.0.1:<port>/api/v1` base; `None` otherwise.
fn loopback_api_port(api_base: &str) -> Option<u16> {
    let port = api_base.strip_prefix("http://127.0.0.1:")?.strip_suffix("/api/v1")?;
    port.parse().ok().filter(|p| *p != 0)
}

/// PIDs listening on the loopback control plane (3141, or the dev override's port).
/// POST /identity/restore only writes files; whoever still answers the API port keeps
/// the old id until that process is replaced.
fn loopback_listener_pids(port: u16) -> Vec<u32> {
    let mut pids = Vec::new();
    if let Ok(out) = std::process::Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output()
    {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Ok(pid) = line.trim().parse::<u32>() {
                pids.push(pid);
            }
        }
    }
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// Stop the process that holds the API port so a restart can bind the restored
/// identity. Only this app's own API base names the port: a dev run moved off 3141
/// never signals a pilot node there.
fn stop_loopback_listener(api_base: &str) {
    let Some(port) = loopback_api_port(api_base) else {
        return;
    };
    let our_pid = std::process::id();
    for pid in loopback_listener_pids(port) {
        if pid == our_pid {
            continue;
        }
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
}

/// Re-auth and mark ready only when GET /identity equals `expected_node_id`.
/// A random healthy loopback process is never adopted.
async fn adopt_matching_identity(
    state: &NodeState,
    expected_node_id: &str,
) -> Result<bool, String> {
    if !health_ok(state).await {
        return Ok(false);
    }
    reauthenticate(state).await?;
    let live = fetch_node_id(state).await?;
    if live != expected_node_id {
        *state.token.lock().unwrap() = None;
        return Ok(false);
    }
    *state.node_id.lock().unwrap() = Some(live);
    *state.error.lock().unwrap() = None;
    *state.ready.lock().unwrap() = true;
    Ok(true)
}

/// Restart whoever answers 3141 onto `expected_node_id` (the id POST /identity/restore
/// just wrote). Adopt that listener only when GET /identity already matches; a still-
/// running node keeps the old id until it is actually replaced.
///
/// Returns whether the process answering 3141 restarted onto the restored identity.
/// `RestoreOutcome.restarted` must stay false unless that happened.
async fn restart_node(
    app: &AppHandle<impl tauri::Runtime>,
    expected_node_id: &str,
) -> Result<bool, String> {
    let state = app.state::<NodeState>();
    refuse_external(&state)?;
    *state.ready.lock().unwrap() = false;
    *state.node_id.lock().unwrap() = None;
    *state.all_in_caps_node.lock().unwrap() = None;
    *state.readmission_ask.lock().unwrap() = None;
    *state.token.lock().unwrap() = None;

    if state.stop_for_restart(NODE_SHUTDOWN_BUDGET) {
        for _ in 0..4 {
            if !health_ok(&state).await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    if health_ok(&state).await {
        if adopt_matching_identity(&state, expected_node_id).await? {
            return Ok(false);
        }
        // Wrong identity: actually restart the listener that holds 3141.
        stop_loopback_listener(&state.api_base);
        for _ in 0..20 {
            if !health_ok(&state).await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        if health_ok(&state).await {
            return Err(format!("could not free {} after identity restore", state.api_base));
        }
    }

    let config = state
        .config
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "node config path is unknown".to_string())?;
    if let Err(e) = spawn_node(app, &config) {
        if adopt_matching_identity(&state, expected_node_id).await? {
            return Ok(false);
        }
        return Err(e);
    }
    wait_for_health(&state).await?;
    if !adopt_matching_identity(&state, expected_node_id).await? {
        return Err("node came back as a different identity than the one just restored".into());
    }
    Ok(true)
}

/// External mode: the owner runs the node, so nothing here may stop, restart or
/// replace it.
fn refuse_external(state: &NodeState) -> Result<(), String> {
    if state.external_node.lock().unwrap().is_some() {
        return Err("BitSov is attached to a node you run yourself; it never restarts, \
                    stops or restores that node. Do that at the node."
            .into());
    }
    Ok(())
}

/// DEV ONLY: attach to a node the owner already runs on 127.0.0.1:3141. Nothing is
/// initialised, started or supervised. App files go under the app's own data dir;
/// the node's data dir is only read.
async fn attach_external(app: &AppHandle, app_data_dir: &Path, node: dev_node::ExternalNode) {
    let state = app.state::<NodeState>();
    eprintln!(
        "[dev-node] EXTERNAL node on {}, data dir {} (not started or stopped by the app)",
        state.api_base,
        node.data_dir.display()
    );
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.set_title(dev_node::EXTERNAL_WINDOW_TITLE);
    }
    let app_dir = app_data_dir.join("external-node");
    if let Err(e) = std::fs::create_dir_all(&app_dir) {
        return set_error(&state, format!("cannot create the app dir: {e}"));
    }
    *state.external_node.lock().unwrap() = Some(node.data_dir.clone());
    *state.app_dir.lock().unwrap() = Some(app_dir.clone());
    *state.room_routing_policy.lock().unwrap() = configured_routing_policy(&node.config);
    *state.configured_network.lock().unwrap() = configured_network(&node.config);
    if !health_ok(&state).await {
        return set_error(
            &state,
            format!(
                "no node answers on {}. Start your node, then reopen BitSov; \
                 it never starts one in external mode.",
                state.api_base
            ),
        );
    }
    finish_auth(&state, &app_dir).await;
}

/// Ensure a node config exists (first run), then start + supervise the node,
/// wait for /health, pair (or fall back to /auth/local on rc7), and read /identity.
async fn bootstrap_node(app: AppHandle) {
    let state = app.state::<NodeState>();
    let app_data_dir: PathBuf = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => return set_error(&state, format!("no app data dir: {e}")),
    };
    // Release builds: always `Ok(None)` (see `dev_node`).
    match dev_node::resolve_external(&app_data_dir) {
        Ok(Some(node)) => return attach_external(&app, &app_data_dir, node).await,
        Ok(None) => {}
        Err(e) => return set_error(&state, format!("external node: {e}")),
    }
    let (data_dir, dev_sidecar) = match dev_node::resolve(&app_data_dir) {
        Ok(None) => (app_data_dir, None),
        Ok(Some(dev)) => {
            eprintln!(
                "[dev-node] UNVERIFIED node binary {} on data dir {} (dev only, sidecar verification bypassed)",
                dev.sidecar.display(),
                dev.data_dir.display()
            );
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = window.set_title(dev_node::WINDOW_TITLE);
            }
            (dev.data_dir, Some(dev.sidecar))
        }
        Err(e) => return set_error(&state, format!("dev node: {e}")),
    };
    *state.dev_sidecar.lock().unwrap() = dev_sidecar.clone();
    let _ = std::fs::create_dir_all(&data_dir);
    let config = data_dir.join("konsensus.toml");

    if !config.exists() {
        if let Err(e) = init_node(&app, &data_dir, dev_sidecar.as_deref()).await {
            return set_error(&state, e);
        }
    }

    *state.config.lock().unwrap() = Some(config.clone());

    if let Err(e) = spawn_node(&app, &config) {
        return set_error(&state, e);
    }
    if let Err(e) = wait_for_health(&state).await {
        return set_error(&state, e);
    }
    finish_auth(&state, &data_dir).await;
}

/// Pair, then read /identity. A pairing failure stays in the pairing view (the
/// onboarding screen shows it with a retry); it is not a node-start error.
async fn finish_auth(state: &NodeState, data_dir: &Path) {
    if authenticate(state, data_dir).await.is_err() {
        return;
    }
    // An identity-free #77 node has no /identity route; first-run create/restore
    // waits on a genome tag (docs/ONBOARDING_PAIRING.md).
    if state.pairing_view.lock().unwrap().bootstrap.is_some() {
        return;
    }
    match fetch_node_id(state).await {
        Ok(node_id) => {
            *state.node_id.lock().unwrap() = Some(node_id);
            *state.ready.lock().unwrap() = true;
        }
        Err(e) => set_error(state, e),
    }
}

// ---- pairing ----------------------------------------------------------------

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Load (first run: create) the client key and the pairing client for `data_dir`.
/// The node writes its challenge files under its own data dir: `data_dir` for a
/// supervised node, the owner's node dir in external mode.
fn pairing_ctx(state: &NodeState, data_dir: &Path) -> Result<Arc<PairingCtx>, PairError> {
    if let Some(ctx) = state.pairing.lock().unwrap().as_ref() {
        return Ok(ctx.clone());
    }
    let store = data_dir.join(PAIRING_STORE_DIR);
    let key = ClientKey::load_or_create(&store)?;
    let node_dir = state
        .external_node
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| data_dir.to_path_buf());
    let client = PairingClient::new(state.http.clone(), state.api_base.clone())
        .expect_challenge_dir(node_dir.join("pairing"));
    let ctx = Arc::new(PairingCtx {
        client,
        key,
        store,
        data_dir: data_dir.to_path_buf(),
    });
    *state.pairing.lock().unwrap() = Some(ctx.clone());
    Ok(ctx)
}

/// Pair with the node, reuse a stored pairing, or — only when `/pair/request`
/// is 404 — mint via `/auth/local`. Records the outcome in the pairing view.
async fn authenticate(state: &NodeState, data_dir: &Path) -> Result<(), String> {
    *state.pairing_view.lock().unwrap() = PairingView::pending();
    *state.auth.lock().unwrap() = AuthMode::Unauthenticated;
    *state.token.lock().unwrap() = None;
    let outcome = match pairing_ctx(state, data_dir) {
        Ok(ctx) => {
            pairing::establish(
                &ctx.client,
                &ctx.key,
                &ctx.store,
                PAIRING_CLIENT_NAME,
                &state.printed_codes,
            )
            .await
        }
        Err(e) => Err(e),
    };
    let mut view = PairingView::from_outcome(&outcome);
    match outcome {
        Ok(Established::Paired { session, .. }) => {
            *state.token.lock().unwrap() = Some(session.token.clone());
            *state.auth.lock().unwrap() = AuthMode::Paired(session);
            let ctx = state.pairing.lock().unwrap().clone();
            if let Some(ctx) = ctx {
                view.bootstrap = pairing::bootstrap_state(&ctx.client).await.ok().flatten();
            }
            *state.pairing_view.lock().unwrap() = view;
            Ok(())
        }
        Ok(Established::LocalFallback { token }) => {
            *state.token.lock().unwrap() = Some(token);
            *state.auth.lock().unwrap() = AuthMode::Local;
            *state.pairing_view.lock().unwrap() = view;
            Ok(())
        }
        Err(e) => {
            let unknown_client = matches!(
                e,
                PairError::Refused { step: "/pair/challenge" | "/pair/token", status: 404, .. }
            );
            state.stale_pairing.store(unknown_client, Ordering::SeqCst);
            *state.pairing_view.lock().unwrap() = view;
            Err(e.to_string())
        }
    }
}

/// Mint a fresh paired token and install it. No fallback on failure.
async fn refresh_paired(state: &NodeState) -> Result<(), String> {
    let session = match &*state.auth.lock().unwrap() {
        AuthMode::Paired(session) => session.clone(),
        _ => return Err("not paired".into()),
    };
    let ctx = state
        .pairing
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "pairing is not set up".to_string())?;
    let mut session = session;
    pairing::refresh(&mut session, &ctx.client, &ctx.key)
        .await
        .map_err(|e| e.to_string())?;
    *state.token.lock().unwrap() = Some(session.token.clone());
    *state.auth.lock().unwrap() = AuthMode::Paired(session);
    Ok(())
}

/// Before a call: refresh a paired token that is inside the refresh margin.
async fn ensure_fresh_token(state: &NodeState) {
    let due = matches!(
        &*state.auth.lock().unwrap(),
        AuthMode::Paired(session) if session.needs_refresh(now_unix())
    );
    if due {
        if let Err(e) = refresh_paired(state).await {
            eprintln!("[pairing] token refresh failed: {e}");
        }
    }
}

/// Re-auth in the mode already established: paired stays paired, and only a
/// node already found to lack pairing routes is re-minted via `/auth/local`.
async fn reauthenticate(state: &NodeState) -> Result<(), String> {
    let paired = match &*state.auth.lock().unwrap() {
        AuthMode::Paired(_) => true,
        AuthMode::Local => false,
        AuthMode::Unauthenticated => return Err("the node is not authenticated yet".into()),
    };
    if paired {
        refresh_paired(state).await
    } else {
        mint_token(state).await
    }
}

// ---- loopback control plane ----------------------------------------------

/// POST /auth/local (loopback, no signature) -> JWT, stored in the host state.
/// Reached only on a node without pairing routes (rc7); see `authenticate`.
async fn mint_token(state: &NodeState) -> Result<(), String> {
    let token = state
        .http
        .post(format!("{}/auth/local", state.api_base))
        .send()
        .await
        .map_err(|e| format!("auth/local request failed: {e}"))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("auth/local decode failed: {e}"))?
        .get("token")
        .and_then(|t| t.as_str())
        .map(str::to_owned)
        .ok_or_else(|| "auth/local returned no token".to_string())?;
    *state.token.lock().unwrap() = Some(token);
    Ok(())
}

/// Re-auth after a 401, no more often than `REMINT_COOLDOWN`. A paired session
/// refreshes through pairing; it is never re-minted via `/auth/local`.
async fn remint_throttled(state: &NodeState) -> Result<(), String> {
    {
        let mut last = state.last_remint.lock().unwrap();
        if let Some(at) = *last {
            if at.elapsed() < REMINT_COOLDOWN {
                return Err("too soon to request another local token".into());
            }
        }
        *last = Some(Instant::now());
    }
    reauthenticate(state).await
}

/// One authenticated call to the loopback control plane.
///
/// The bearer token is attached here and goes no further: it is not part of any
/// return value, and error strings carry only the loopback path, the status, and
/// the node's own error text.
async fn call_api(
    state: &NodeState,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<(reqwest::StatusCode, String), String> {
    // This channel holds the app's delegated (or legacy loopback) credential,
    // never independent owner authority. Do not send it to an owner-only route,
    // including after a refresh or an elevation to budget-scoped spend.
    if path == "/pair/first-contact-grant" {
        return Err("First-contact approval requires independent owner authority at the node. This app cannot issue it with its paired spend grant.".into());
    }
    ensure_fresh_token(state).await;
    let mut refreshed = false;
    loop {
        let token = state
            .token
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "the node is not authenticated yet".to_string())?;
        let mut request = state
            .http
            .request(method.clone(), format!("{}{path}", state.api_base))
            .bearer_auth(token);
        if let Some(ref json) = body {
            request = request.json(json);
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("{path} request failed: {e}"))?;
        let status = response.status();

        // A token is good for 24h and the app may outlive it; refresh once.
        if status == reqwest::StatusCode::UNAUTHORIZED && !refreshed {
            refreshed = true;
            if remint_throttled(state).await.is_ok() {
                continue;
            }
        }
        let text = response
            .text()
            .await
            .map_err(|e| format!("{path} response read failed: {e}"))?;
        return Ok((status, text));
    }
}

/// The node reports failures as `{"error": "..."}`; surface that, bounded.
fn api_error(path: &str, status: reqwest::StatusCode, body: &str) -> String {
    if act::readiness_refusal(status.as_u16(), body) { return act::MONEY_NOT_READY.into(); }
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned))
        .unwrap_or_else(|| body.trim().to_string());
    let detail: String = detail.chars().take(160).collect();
    if detail.is_empty() {
        format!("{path} failed ({})", status.as_u16())
    } else {
        format!("{path} failed ({}): {detail}", status.as_u16())
    }
}

fn decode<T: serde::de::DeserializeOwned>(
    path: &str,
    status: reqwest::StatusCode,
    body: &str,
) -> Result<T, String> {
    if !status.is_success() {
        return Err(api_error(path, status, body));
    }
    serde_json::from_str(body).map_err(|e| format!("{path} decode failed: {e}"))
}

async fn fetch_node_id(state: &NodeState) -> Result<String, String> {
    let (status, body) = call_api(state, reqwest::Method::GET, "/identity", None).await?;
    if !status.is_success() {
        return Err(api_error("/identity", status, &body));
    }
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("node_id").and_then(|n| n.as_str()).map(str::to_owned))
        .ok_or_else(|| "identity returned no node_id".to_string())
}

// ---- assistant source (host-side) ------------------------------------------
//
// The host alone decides whether the sealed window shows rows read from the
// local node or mock rows. No command selects it, and the window gets the
// result only as frozen init-script globals.

/// `BITSOV_ASSISTANT=node` (debug + `sit-mock`): the full app — node, pairing,
/// wallet — plus the Assistant menu, so the window can show live rows.
/// `BITSOV_ASSISTANT=1` stays the node-free assistant-only path.
const ASSISTANT_NODE_MODE: &str = "node";

fn assistant_node_enabled_from(debug_build: bool, sit_mock: bool, flag: Option<&str>) -> bool {
    debug_build && sit_mock && flag == Some(ASSISTANT_NODE_MODE)
}

fn assistant_node_enabled() -> bool {
    let flag = std::env::var(ASSISTANT_DEV_FLAG).ok();
    assistant_node_enabled_from(
        cfg!(debug_assertions),
        cfg!(feature = "sit-mock"),
        flag.as_deref(),
    )
}

/// F1's auth state as the assistant feed and the AI track see it. Only a
/// paired token is handed over; the rc7 `/auth/local` token never is.
fn node_auth(state: &NodeState) -> NodeAuth {
    match &*state.auth.lock().unwrap() {
        AuthMode::Unauthenticated => NodeAuth::NotPaired,
        AuthMode::Local => NodeAuth::Rc7Fallback,
        AuthMode::Paired(session) => match BearerToken::new(session.token.clone()) {
            Some(token) => NodeAuth::Paired {
                token,
                scopes: session.scopes.clone(),
            },
            None => NodeAuth::NotPaired,
        },
    }
}

/// The sealed window's source, as an init script. Reads host state only. It
/// may read the node over loopback, so callers keep it off the UI thread.
/// Builds without `sit-mock` have no fixture reader and are always mock.
fn assistant_source_script(app: &AppHandle) -> String {
    #[cfg(all(debug_assertions, feature = "sit-mock"))]
    if let Some(state) = app.try_state::<NodeState>() {
        use bitsov_app::jarvis::assistant_feed;
        tauri::async_runtime::block_on(ensure_fresh_token(&state));
        let audit = Arc::new(bitsov_app::jarvis::broker::StderrAudit);
        let feed = assistant_feed::build(node_auth(&state), &state.api_base, audit);
        return feed.init_script();
    }
    let _ = app;
    Feed::mock(MockReason::NotPaired).init_script()
}

// ---- sealed assistant window ----------------------------------------------

/// Label of the display-only window. Privileged commands refuse this label.
const ASSISTANT_WINDOW_LABEL: &str = "assistant";

/// Dev builds open the window only when this variable is exactly `1`.
const ASSISTANT_DEV_FLAG: &str = "BITSOV_ASSISTANT";

/// Privileged commands run only in the main window. Every other label is refused.
const MAIN_WINDOW_LABEL: &str = "main";

fn window_may_run_privileged_command(label: &str) -> bool {
    label == MAIN_WINDOW_LABEL
}

/// Refuse every caller except the main window. `window` is the Tauri caller,
/// not a name the frontend supplied.
fn reject_sealed_window(window: &WebviewWindow<impl tauri::Runtime>) -> Result<(), String> {
    if window_may_run_privileged_command(window.label()) {
        Ok(())
    } else {
        Err("this command is only available to the main window".into())
    }
}

fn assistant_dev_enabled_from(debug_build: bool, flag: Option<&str>) -> bool {
    debug_build && flag == Some("1")
}

fn assistant_dev_enabled() -> bool {
    let flag = std::env::var(ASSISTANT_DEV_FLAG).ok();
    assistant_dev_enabled_from(cfg!(debug_assertions), flag.as_deref())
}

/// `build.devUrl` in tauri.conf.json. Debug builds may open the assistant there.
const ASSISTANT_DEV_SCHEME: &str = "http";
const ASSISTANT_DEV_HOST: &str = "localhost";
const ASSISTANT_DEV_PORT: u16 = 1420;

/// The bundled assistant document, plus the dev server in debug builds.
///
/// The canonical bundled origin has no explicit port: `tauri` on `localhost`
/// for Linux, macOS, and iOS; `http` on `tauri.localhost` for Windows and
/// Android (`useHttpsScheme` is off). An explicit `:80` or `:443` is rejected.
/// Debug builds also allow exactly `devUrl` + `/assistant.html`.
fn assistant_document_allowed(
    debug_build: bool,
    scheme: &str,
    host: Option<&str>,
    port: Option<u16>,
    path: &str,
) -> bool {
    if path != "/assistant.html" {
        return false;
    }
    if debug_build
        && scheme == ASSISTANT_DEV_SCHEME
        && host == Some(ASSISTANT_DEV_HOST)
        && port == Some(ASSISTANT_DEV_PORT)
    {
        return true;
    }
    if port.is_some() {
        return false;
    }
    bundled_assistant_origin(scheme, host)
}

fn bundled_assistant_origin(scheme: &str, host: Option<&str>) -> bool {
    #[cfg(any(windows, target_os = "android"))]
    {
        scheme == "http" && host == Some("tauri.localhost")
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        scheme == "tauri" && host == Some("localhost")
    }
}

/// Initialization script that hands the sealed window its rows.
///
/// With `sit-mock` the rows come from the in-process mock broker over the
/// 50-question fixture: no node, no socket. Without it the script still defines
/// the global, as an empty list, and the page says how to get rows.
#[cfg(all(debug_assertions, feature = "sit-mock"))]
fn assistant_rows_script() -> String {
    use bitsov_app::jarvis::sit_mock;
    sit_mock::assistant_init_script(&sit_mock::rows())
}

#[cfg(not(all(debug_assertions, feature = "sit-mock")))]
fn assistant_rows_script() -> String {
    // Same shape as `sit_mock::assistant_init_script`, which is not compiled here.
    "Object.defineProperty(window, '__BITSOV_SIT_ROWS__', \
     { value: Object.freeze([]), writable: false, configurable: false });"
        .to_string()
}

/// Create the sealed assistant window. Called from the menu in a normal debug
/// build, and at startup on the sit-mock assistant-only path. `source_script`
/// comes from the host (`assistant_source_script` or a fixed mock feed).
fn open_assistant_window(app: &AppHandle, source_script: String) -> Result<(), String> {
    if !assistant_dev_enabled() && !assistant_node_enabled() {
        return Err("the assistant window is unavailable".into());
    }
    if let Some(existing) = app.get_webview_window(ASSISTANT_WINDOW_LABEL) {
        existing.show().map_err(|e| e.to_string())?;
        let _ = existing.set_focus();
        return Ok(());
    }
    let _window = tauri::WebviewWindowBuilder::new(
        app,
        ASSISTANT_WINDOW_LABEL,
        tauri::WebviewUrl::App("assistant.html".into()),
    )
    .title("Assistant")
    .inner_size(420.0, 640.0)
    .min_inner_size(320.0, 240.0)
    .resizable(true)
    .incognito(true)
    .initialization_script(assistant_rows_script())
    .initialization_script(source_script)
    .on_navigation(|url| {
        assistant_document_allowed(
            cfg!(debug_assertions),
            url.scheme(),
            url.host_str(),
            url.port(),
            url.path(),
        )
    })
    .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Menu item present only when the dev flag is set. Release builds never install it.
fn install_assistant_menu(app: &tauri::App) -> tauri::Result<()> {
    let item = MenuItem::with_id(app, "open-assistant", "Assistant", true, None::<&str>)?;
    if let Some(menu) = app.menu() {
        menu.append(&item)?;
    } else {
        let menu = Menu::with_items(app, &[&item])?;
        app.set_menu(menu)?;
    }
    app.on_menu_event(|app, event| {
        if event.id() == "open-assistant" {
            // The source may read the node over loopback: off the UI thread.
            let app = app.clone();
            std::thread::spawn(move || {
                let source = assistant_source_script(&app);
                let _ = open_assistant_window(&app, source);
            });
        }
    });
    Ok(())
}

// ---- commands -------------------------------------------------------------

/// Frontend reads node state here (identity screen). Synchronous — the async
/// bootstrap task populates the state; the command just reflects it.
#[tauri::command]
fn node_status(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<Status, String> {
    reject_sealed_window(&window)?;
    Ok(Status {
        ready: *state.ready.lock().unwrap(),
        node_id: state.node_id.lock().unwrap().clone(),
        error: state.error.lock().unwrap().clone(),
    })
}

/// Pairing state for the onboarding screen. Carries no token and no key.
#[tauri::command]
fn pairing_status(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<PairingView, String> {
    reject_sealed_window(&window)?;
    Ok(state.pairing_view.lock().unwrap().clone())
}

/// Retry after a pairing failure. A no-op unless the last attempt failed. Only
/// when the node said it no longer knows this client is the stored pairing
/// dropped for a fresh ceremony — still gated by the challenge file and the
/// node's own pairing window. Never falls back to `/auth/local` on a failure.
#[tauri::command(rename_all = "snake_case")]
async fn pairing_retry(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<PairingView, String> {
    reject_sealed_window(&window)?;
    drop(window);
    let ctx = state
        .pairing
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "pairing is not available yet: the node has not started".to_string())?;
    if state.pairing_view.lock().unwrap().state != "failed" {
        return Ok(state.pairing_view.lock().unwrap().clone());
    }
    if state.stale_pairing.swap(false, Ordering::SeqCst) {
        pairing::forget_pairing(&ctx.store);
    }
    finish_auth(state.inner(), &ctx.data_dir).await;
    Ok(state.pairing_view.lock().unwrap().clone())
}

/// `GET /onboarding/state`. `None` means the first-run funding flow has not been
/// started yet — the node answers 404 until `/onboarding/start` has run once.
#[tauri::command(rename_all = "snake_case")]
async fn fund_state(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<Option<FundState>, String> {
    reject_sealed_window(&window)?;
    drop(window);
    let (status, body) = call_api(
        state.inner(),
        reqwest::Method::GET,
        "/onboarding/state",
        None,
    )
    .await?;
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let mut fund: FundState = decode("/onboarding/state", status, &body)?;
    fund.funded = fund.current_step == FUNDING_SEEN;
    Ok(Some(fund))
}

/// `POST /onboarding/start` with tier `full` — the fund-your-own-node path. The
/// node declares `deny_unknown_fields`, so the body carries exactly these two.
#[tauri::command(rename_all = "snake_case")]
async fn fund_start(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    funding_amount_sats: u32,
) -> Result<FundState, String> {
    reject_sealed_window(&window)?;
    drop(window);
    if funding_amount_sats == 0 {
        return Err("the funding amount must be at least 1 sat".into());
    }
    let body = serde_json::json!({
        "tier": "full",
        "funding_amount_sats": funding_amount_sats,
    });
    let (status, text) = call_api(
        state.inner(),
        reqwest::Method::POST,
        "/onboarding/start",
        Some(body),
    )
    .await?;
    let mut fund: FundState = decode("/onboarding/start", status, &text)?;
    fund.funded = fund.current_step == FUNDING_SEEN;
    Ok(fund)
}

/// `GET /payments/funding-address` — the deposit address shown as text + QR.
#[tauri::command(rename_all = "snake_case")]
async fn funding_address(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<FundingAddress, String> {
    reject_sealed_window(&window)?;
    drop(window);
    let (status, body) = call_api(
        state.inner(),
        reqwest::Method::GET,
        "/payments/funding-address",
        None,
    )
    .await?;
    decode("/payments/funding-address", status, &body)
}

/// `GET /payments/balance`.
#[tauri::command(rename_all = "snake_case")]
async fn payments_balance(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<Balance, String> {
    reject_sealed_window(&window)?;
    drop(window);
    let (status, body) = call_api(
        state.inner(),
        reqwest::Method::GET,
        "/payments/balance",
        None,
    )
    .await?;
    decode("/payments/balance", status, &body)
}

/// `POST /identity/restore` — hand a recovery phrase to the node, then restart it.
///
/// The phrase is a write-only input: it is passed straight through to the node
/// (which owns key material), is never logged, never persisted by this app, and
/// never echoed back — `RestoreOutcome` carries only the public node_id. The node's
/// own rejection messages identify bad words by index, not by content.
#[tauri::command(rename_all = "snake_case")]
async fn identity_restore(
    window: WebviewWindow<impl tauri::Runtime>,
    app: AppHandle<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    mnemonic: String,
) -> Result<RestoreOutcome, String> {
    reject_sealed_window(&window)?;
    drop(window);
    refuse_external(state.inner())?;
    let phrase = mnemonic.trim();
    let words = phrase.split_whitespace().count();
    if words != 12 && words != 24 {
        return Err("a recovery phrase is 12 or 24 words".into());
    }
    let (status, body) = call_api(
        state.inner(),
        reqwest::Method::POST,
        "/identity/restore",
        Some(serde_json::json!({ "mnemonic": phrase })),
    )
    .await?;
    let restored: RestoreResponse = decode("/identity/restore", status, &body)?;

    // The node writes the phrase to its data dir and reports restart_required; the
    // restored identity only takes effect on the next start. Restart whoever answers
    // 3141 onto that identity — same data dir, no re-init.
    let mut restarted = false;
    if restored.restart_required {
        match restart_node(&app, &restored.node_id).await {
            Ok(did_restart) => restarted = did_restart,
            Err(e) => {
                let message = format!(
                    "the recovery phrase was saved, but the node did not come back: {e}. \
                     Quit and reopen BitSov to finish."
                );
                // Also record it on the node state so the boot screen can show it if
                // IdentityGate is not mounted; the renderer also keeps a restoreError.
                set_error(state.inner(), message.clone());
                return Err(message);
            }
        }
    }

    // Never report success (or restarted) against a random healthy loopback process.
    let live = match fetch_node_id(state.inner()).await {
        Ok(id) => id,
        Err(e) => {
            let message = format!(
                "the recovery phrase was saved, but the restored identity could not be confirmed: {e}.                  Quit and reopen BitSov to finish."
            );
            set_error(state.inner(), message.clone());
            return Err(message);
        }
    };
    if live != restored.node_id {
        let message = "the recovery phrase was saved, but 127.0.0.1:3141 still serves a different identity.              Quit and reopen BitSov to finish."
            .to_string();
        set_error(state.inner(), message.clone());
        return Err(message);
    }

    Ok(RestoreOutcome {
        node_id: restored.node_id,
        restart_required: restored.restart_required,
        restarted,
    })
}

// ---- control center reads (read / receive scope only) -----------------------
//
// Each command is one or two loopback GETs through `call_api`, projected by
// `bitsov_app::control` so no ciphertext, preimage, token or key reaches the
// renderer. Nothing here sends, pays, admits a peer or edits a room; those are
// the actions below, behind the owner's spend window.

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

async fn get_json<T: serde::de::DeserializeOwned>(state: &NodeState, path: &str) -> Result<T, String> {
    let (status, body) = call_api(state, reqwest::Method::GET, path, None).await?;
    // Error text names the route, never the query (which may carry a peer id).
    let route = path.split('?').next().unwrap_or(path);
    decode(route, status, &body)
}

async fn read_node_overview(state: &NodeState) -> Result<control::NodeOverview, String> {
    let status: control::NodeStatusResponse = get_json(state, "/status").await?;
    let mut overview = control::NodeOverview::from_status(status, now_ms());
    // Only while the node answering is the LDK node that config started.
    if overview.lightning_backend.as_deref() == Some("ldk") {
        overview.network = state.configured_network.lock().unwrap().clone();
    }
    Ok(overview)
}

async fn read_room_members(state: &NodeState, room_id: &str) -> Result<Vec<String>, String> {
    get_json(state, &control::room_members_path(room_id)?).await
}

async fn read_messages(
    state: &NodeState,
    peer: &str,
    before: Option<u64>,
    limit: Option<u32>,
) -> Result<Vec<control::Message>, String> {
    let page: Vec<control::Message> =
        get_json(state, &control::messages_path(peer, before, limit)?).await?;
    Ok(control::chronological(page))
}

async fn read_price_quote(state: &NodeState, peer: Option<&str>) -> Result<control::PriceQuote, String> {
    let peer = peer.map(control::node_id).transpose()?;
    let own: control::KindPrice = get_json(state, &control::price_path(control::KIND_CHAT)).await?;
    let tables: Vec<control::PeerPrice> = match peer {
        // An empty table is normal; a failed read is not a usable quote.
        Some(_) => get_json(state, "/pricing/peers").await?,
        None => Vec::new(),
    };
    Ok(control::price_quote(own, &tables, peer.as_deref()))
}

async fn read_wallet(state: &NodeState) -> Result<control::WalletOverview, String> {
    let balance: Balance = get_json(state, "/payments/balance").await?;
    let channels: Vec<control::Channel> = get_json(state, "/payments/channels").await?;
    Ok(control::wallet_overview(balance.balance_msat, channels))
}

/// `GET /status` — the Node panel and the rail's node pill.
#[tauri::command(rename_all = "snake_case")]
async fn node_overview(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<control::NodeOverview, String> {
    reject_sealed_window(&window)?;
    drop(window);
    read_node_overview(state.inner()).await
}

/// `GET /peers` — the private contact list (not an admission list).
#[tauri::command(rename_all = "snake_case")]
async fn peers_list(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<Vec<control::Peer>, String> {
    reject_sealed_window(&window)?;
    drop(window);
    get_json(state.inner(), "/peers").await.map(control::with_meeting_support)
}

/// `GET /rooms`.
#[tauri::command(rename_all = "snake_case")]
async fn rooms_list(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<Vec<control::Room>, String> {
    reject_sealed_window(&window)?;
    drop(window);
    get_json(state.inner(), "/rooms").await
}

/// `GET /rooms/:id/members` — hex node ids. `room_id` must be a UUID.
#[tauri::command(rename_all = "snake_case")]
async fn room_members(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    room_id: String,
) -> Result<Vec<String>, String> {
    reject_sealed_window(&window)?;
    drop(window);
    read_room_members(state.inner(), &room_id).await
}

/// `GET /messages?peer=…` — one track's history, oldest first. `peer` is a node
/// id or a room UUID; `before` pages back from a unix-ms cursor.
#[tauri::command(rename_all = "snake_case")]
async fn messages_list(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    peer: String,
    before: Option<u64>,
    limit: Option<u32>,
) -> Result<Vec<control::Message>, String> {
    reject_sealed_window(&window)?;
    drop(window);
    read_messages(state.inner(), &peer, before, limit).await
}

/// `GET /payments/price/0` + `GET /pricing/peers` — what one text message to
/// `peer` costs. Without a cached peer table the renderer labels the figure as
/// this node's own price, never as the peer's.
#[tauri::command(rename_all = "snake_case")]
async fn price_quote(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    peer: Option<String>,
) -> Result<control::PriceQuote, String> {
    reject_sealed_window(&window)?;
    drop(window);
    read_price_quote(state.inner(), peer.as_deref()).await
}

/// `GET /energy?window=` (genome N1) — node-wide sats in/out per counterparty
/// and per bucket. Only called when `/status` advertises `energy_v1`; an older
/// node answers 404 and the renderer keeps its v1 sums.
#[tauri::command(rename_all = "snake_case")]
async fn energy_read(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    span: String,
) -> Result<control::EnergyRead, String> {
    reject_sealed_window(&window)?;
    drop(window);
    let node: control::NodeEnergy = get_json(state.inner(), &control::energy_path(&span)?).await?;
    Ok(control::EnergyRead::from_node(node))
}

/// `GET /membrane?limit=` (genome N2) — the node's bounded ring of admission
/// decisions, newest first. Read scope; held in memory by the node only.
#[tauri::command(rename_all = "snake_case")]
async fn membrane_read(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    limit: Option<u32>,
) -> Result<control::MembraneRead, String> {
    reject_sealed_window(&window)?;
    drop(window);
    let node: control::NodeMembrane = get_json(state.inner(), &control::membrane_path(limit)).await?;
    Ok(control::MembraneRead::from_node(node, now_ms()))
}

/// `POST /messages/first-contact/quote` — the door card: a stranger's own
/// signed price (admission once, then this message) before anything is paid.
/// Pays and reserves nothing. Only on a node that advertises
/// `first_contact_grant_v1`; the node also needs a live budget grant.
#[tauri::command(rename_all = "snake_case")]
async fn first_contact_quote(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    peer: String,
) -> Result<control::FirstContactQuote, String> {
    reject_sealed_window(&window)?;
    drop(window);
    read_first_contact_quote(state.inner(), &peer).await
}

async fn read_first_contact_quote(state: &NodeState, peer: &str) -> Result<control::FirstContactQuote, String> {
    let peer = control::node_id(peer)?;
    if !node_offers(state, grant::FIRST_CONTACT_CAPABILITY).await {
        return Err("This node cannot quote a first contact before paying.".into());
    }
    let path = "/messages/first-contact/quote";
    let (status, text) = call_api(state, reqwest::Method::POST, path, Some(serde_json::json!({ "recipient": peer }))).await?;
    if !status.is_success() {
        return Err(api_error(path, status, &text));
    }
    let quote: control::FirstContactQuote = serde_json::from_str(&text).map_err(|e| format!("{path} decode failed: {e}"))?;
    if quote.recipient != peer || Some(quote.total_msat) != quote.admission_msat.checked_add(quote.message_msat).and_then(|v| v.checked_add(quote.max_routing_fee_msat)) {
        return Err(format!("{path}: the quote does not match this contact"));
    }
    // #99 added this field with the all-in capped-readmission contract. Older
    // nodes advertise the same paid_send_caps_v1, so that capability alone is
    // insufficient to narrow their conservative admission reservation.
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if value.get("max_routing_fee_msat").and_then(|v| v.as_u64()).is_some() {
        *state.all_in_caps_node.lock().unwrap() = state.node_id.lock().unwrap().clone();
    }
    Ok(quote)
}

fn has_all_in_caps(state: &NodeState) -> bool {
    let node = state.node_id.lock().unwrap().clone();
    node.is_some() && *state.all_in_caps_node.lock().unwrap() == node
}

// ---- K1 introductions (slice 1) -----------------------------------------------
//
// An introduction is never admission. `introduction_read` is local only. The
// app never dials a card's endpoint: `introduction_open` asks the node, which
// verifies the card again, pins its DNS and dials unprivileged (no whitelist,
// nothing stored). The composer's door card then asks the stranger's own
// stateless quote and the owner's one-time OK, exactly as for any stranger.

/// `GET /introduction` — this node's signed door card for the QR: key,
/// reachable peer endpoint and current prices, valid ten minutes. Checked
/// here to be signed by this node's own key before it is shown.
#[tauri::command(rename_all = "snake_case")]
async fn introduction_mine(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<bitsov_app::introduction::DoorCard, String> {
    reject_sealed_window(&window)?;
    drop(window);
    read_own_introduction(state.inner()).await
}

async fn read_own_introduction(state: &NodeState) -> Result<bitsov_app::introduction::DoorCard, String> {
    use bitsov_app::introduction as intro;
    let status: serde_json::Value = get_json(state, "/status").await?;
    let offers = status["api_capabilities"]
        .as_array()
        .is_some_and(|caps| caps.iter().any(|v| v.as_str() == Some(intro::CAPABILITY)));
    if !offers {
        return Err("Your node cannot sign an introduction yet. Share your node id instead.".into());
    }
    let path = "/introduction";
    let (code, text) = call_api(state, reqwest::Method::GET, path, None).await?;
    if !code.is_success() {
        return Err(api_error(path, code, &text));
    }
    #[derive(Deserialize)]
    struct Mine {
        card: intro::Card,
        link: String,
    }
    let mine: Mine = serde_json::from_str(&text).map_err(|e| format!("{path} decode failed: {e}"))?;
    mine.card.verify(now_unix().max(0) as u64)?;
    if Some(mine.card.node_id.as_str()) != status["node_id"].as_str() {
        return Err(format!("{path}: the card is not signed by this node's key"));
    }
    let door = mine.card.door()?;
    if door.link != mine.link {
        return Err(format!("{path}: the link does not match the card"));
    }
    Ok(door)
}

/// Read a scanned, opened or pasted introduction: bounded parse, version,
/// network name, endpoint shape, expiry and node-key signature. Local only:
/// no request is made and nothing is stored.
#[tauri::command(rename_all = "snake_case")]
async fn introduction_read(
    window: WebviewWindow<impl tauri::Runtime>,
    text: String,
) -> Result<bitsov_app::introduction::DoorCard, String> {
    reject_sealed_window(&window)?;
    drop(window);
    // K1 slice 2: an offer of starter bitcoin may ride with the card.
    let (card, offer) = bitsov_app::sponsor::read(&text, now_unix().max(0) as u64)?;
    bitsov_app::sponsor::door(&card, offer.as_ref())
}

/// Continue from a door card: re-verify it here, then `POST
/// /introduction/open` so the node checks it against its own network, pins
/// the endpoint and dials the introduced node unprivileged. Pays nothing,
/// asks no quote and stores no contact.
///
/// `allow_local` is the owner's explicit OK for a local-network address,
/// given on the door card. A card's own signed `reach = local` never grants
/// it (genome #89 `020b05e`), and it is never sent for a public card.
#[tauri::command(rename_all = "snake_case")]
async fn introduction_open(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    text: String,
    allow_local: bool,
) -> Result<bitsov_app::introduction::DoorCard, String> {
    reject_sealed_window(&window)?;
    drop(window);
    open_introduction(state.inner(), &text, allow_local).await
}

async fn open_introduction(state: &NodeState, text: &str, allow_local: bool) -> Result<bitsov_app::introduction::DoorCard, String> {
    use bitsov_app::introduction as intro;
    // Opening uses the card alone; an attached offer is ignored here.
    let (card, _offer) = bitsov_app::sponsor::read(text, now_unix().max(0) as u64)?;
    let door = card.door()?;
    let local = door.reach == intro::Reach::Local;
    if local && !allow_local {
        return Err(format!("This introduction points to a local network address ({}). Allow it on the card first. Nothing was sent.", door.endpoint));
    }
    if !node_offers(state, intro::CAPABILITY).await {
        return Err("Your node cannot open introductions yet.".into());
    }
    let path = "/introduction/open";
    let (code, body) = call_api(state, reqwest::Method::POST, path, Some(serde_json::json!({ "card": door.link, "allow_local": local && allow_local }))).await?;
    if code == reqwest::StatusCode::CONFLICT && body.contains("introduction_closed_mesh") {
        return Err("Your node only connects to peers you added yourself, and an introduction does not add one. Nothing was sent.".into());
    }
    if !code.is_success() {
        return Err(api_error(path, code, &body));
    }
    let opened: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("{path} decode failed: {e}"))?;
    if opened["node_id"].as_str() != Some(door.node_id.as_str()) || opened["connected"] != serde_json::Value::Bool(true) {
        return Err(format!("{path}: the node connected to someone else"));
    }
    // The node pins DNS and applies the reach rules; check what it reports
    // having dialed against the same rules, so a node that skipped them is
    // caught here rather than trusted.
    let dialed = opened["dialed"].as_str().and_then(|d| d.parse::<std::net::SocketAddr>().ok());
    match dialed {
        Some(addr) if intro::dial_allowed(door.reach, addr.ip()) => Ok(door),
        _ => Err(format!("{path}: the node dialed an address this introduction does not allow")),
    }
}

// ---- Front door (doorstep card) ---------------------------------------------------
//
// A front-door card is free to carry: reading is local. Knock dials unprivileged
// (never admission), then the composer uses the existing first-contact quote.

#[tauri::command(rename_all = "snake_case")]
async fn front_door_read(
    window: WebviewWindow<impl tauri::Runtime>,
    text: String,
) -> Result<bitsov_app::front_door::FrontDoor, String> {
    reject_sealed_window(&window)?;
    drop(window);
    bitsov_app::front_door::read(&text, now_unix().max(0) as u64)
}

#[tauri::command(rename_all = "snake_case")]
async fn front_door_mine(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<bitsov_app::front_door::FrontDoor, String> {
    reject_sealed_window(&window)?;
    drop(window);
    read_own_front_door(state.inner()).await
}

async fn read_own_front_door(state: &NodeState) -> Result<bitsov_app::front_door::FrontDoor, String> {
    use bitsov_app::front_door as fd;
    let status: serde_json::Value = get_json(state, "/status").await?;
    if !status["api_capabilities"]
        .as_array()
        .is_some_and(|caps| caps.iter().any(|v| v.as_str() == Some(fd::CAPABILITY)))
    {
        return Err("Your node cannot publish a front door yet.".into());
    }
    let path = "/front-door";
    let (code, text) = call_api(state, reqwest::Method::GET, path, None).await?;
    if code == reqwest::StatusCode::NOT_FOUND {
        return Err("front_door_missing: publish one first".into());
    }
    if !code.is_success() {
        return Err(api_error(path, code, &text));
    }
    #[derive(Deserialize)]
    struct Mine {
        card: fd::Card,
        link: String,
    }
    let mine: Mine = serde_json::from_str(&text).map_err(|e| format!("{path} decode failed: {e}"))?;
    let view = mine.card.view(now_unix().max(0) as u64)?;
    if Some(mine.card.node_id.as_str()) != status["node_id"].as_str() {
        return Err(format!("{path}: the card is not signed by this node's key"));
    }
    if view.link != mine.link {
        return Err(format!("{path}: the link does not match the card"));
    }
    Ok(view)
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct FrontDoorPublishArgs {
    display_name: String,
    #[serde(default)]
    tagline: String,
    #[serde(default)]
    about: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    admission_msat: Option<u64>,
    #[serde(default)]
    message_msat: Option<u64>,
    #[serde(default)]
    page_msat: Option<u64>,
    #[serde(default)]
    avatar: Option<serde_json::Value>,
    #[serde(default)]
    media: Vec<serde_json::Value>,
    #[serde(default)]
    cv: Option<serde_json::Value>,
    #[serde(default)]
    links: Vec<serde_json::Value>,
}

#[tauri::command(rename_all = "snake_case")]
async fn front_door_hash_bytes(
    window: WebviewWindow<impl tauri::Runtime>,
    bytes_b64: String,
) -> Result<String, String> {
    reject_sealed_window(&window)?;
    drop(window);
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    if bytes_b64.len() > 4 * 1024 * 1024 {
        return Err("That file is too large to hash for a front-door card.".into());
    }
    let bytes = STANDARD
        .decode(bytes_b64.trim())
        .map_err(|_| "The image bytes were not readable.".to_string())?;
    Ok(hex::encode(blake3::hash(&bytes).as_bytes()))
}

#[tauri::command(rename_all = "snake_case")]
async fn front_door_publish(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    fields: FrontDoorPublishArgs,
) -> Result<bitsov_app::front_door::FrontDoor, String> {
    reject_sealed_window(&window)?;
    drop(window);
    use bitsov_app::front_door as fd;
    let status: serde_json::Value = get_json(state.inner(), "/status").await?;
    if !status["api_capabilities"]
        .as_array()
        .is_some_and(|caps| caps.iter().any(|v| v.as_str() == Some(fd::CAPABILITY)))
    {
        return Err("Your node cannot publish a front door yet.".into());
    }
    let path = "/front-door";
    let body = serde_json::json!({
        "display_name": fields.display_name,
        "tagline": fields.tagline,
        "about": fields.about,
        "kind": fields.kind,
        "admission_msat": fields.admission_msat,
        "message_msat": fields.message_msat,
        "page_msat": fields.page_msat,
        "avatar": fields.avatar,
        "media": fields.media,
        "cv": fields.cv,
        "links": fields.links,
    });
    let text = put_front_door(state.inner(), body).await?;
    #[derive(Deserialize)]
    struct Resp {
        card: fd::Card,
        link: String,
    }
    let resp: Resp = serde_json::from_str(&text).map_err(|e| format!("{path} decode failed: {e}"))?;
    let view = resp.card.view(now_unix().max(0) as u64)?;
    if Some(resp.card.node_id.as_str()) != status["node_id"].as_str() {
        return Err(format!("{path}: the card is not signed by this node's key"));
    }
    if view.link != resp.link {
        return Err(format!("{path}: the link does not match the card"));
    }
    Ok(view)
}

/// Marks the error that asks the owner for `front_door`; the editor shows it
/// with the owner's command instead of as a plain failure.
const FRONT_DOOR_OWNER: &str = "front_door_owner";

/// `PUT /front-door`. The node demands `front_door` (or `admin`, which a paired
/// app never holds). Without it the app asks the owner once
/// (`POST /pair/elevation-request {"scopes":["front_door"]}`), which carries no
/// authority, and says what the owner must run. After the owner grants, the
/// next Publish re-mints the paired token, which then carries `front_door`.
/// Nothing here can grant it: only the owner's CLI at the node can.
async fn put_front_door(state: &NodeState, body: serde_json::Value) -> Result<String, String> {
    let path = "/front-door";
    let lacks_scope = |code: reqwest::StatusCode, text: &str| {
        code == reqwest::StatusCode::FORBIDDEN && text.contains("front_door")
    };
    let (mut code, mut text) = call_api(state, reqwest::Method::PUT, path, Some(body.clone())).await?;
    let paired = matches!(&*state.auth.lock().unwrap(), AuthMode::Paired(_));
    if paired && lacks_scope(code, &text) {
        // The owner may have granted since this token was issued.
        if refresh_paired(state).await.is_ok() {
            (code, text) = call_api(state, reqwest::Method::PUT, path, Some(body)).await?;
        }
        if lacks_scope(code, &text) {
            return Err(ask_front_door_owner(state).await);
        }
    }
    if !code.is_success() {
        return Err(api_error(path, code, &text));
    }
    *state.front_door_ask.lock().unwrap() = None;
    Ok(text)
}

/// The node's `konsensus.toml` when this app knows it: an attached external
/// node's, else the one it started. Only ever shown in an owner command.
fn owner_config(state: &NodeState) -> Option<PathBuf> {
    let external = state.external_node.lock().unwrap().as_ref().map(|dir| dir.join("konsensus.toml"));
    external.or_else(|| state.config.lock().unwrap().clone())
}

/// Whether the node still waits on this request. A request the node reports
/// over (expired, or lost to a restart) is not reused; an unreadable status
/// keeps the request, since the owner may be approving it right now.
async fn front_door_ask_alive(state: &NodeState, ask: &act::Elevation) -> bool {
    let Ok(path) = act::elevation_status_path(&ask.op_id) else { return false };
    match call_api(state, reqwest::Method::GET, &path, None).await {
        Ok((code, body)) if code.is_success() => decode_act::<act::ElevationStatusReply>("/pair/elevation", &body)
            .map(|r| act::Lapse::from_status(&r.status).is_none())
            .unwrap_or(true),
        _ => true,
    }
}

/// One pending `front_door` request at a time; the owner's words, verbatim.
async fn ask_front_door_owner(state: &NodeState) -> String {
    let mut current = state.front_door_ask.lock().unwrap().clone().filter(|e| e.expires_at_ms > now_ms());
    if let Some(ask) = &current {
        if !front_door_ask_alive(state, ask).await {
            current = None;
        }
    }
    let pending = match current {
        Some(e) => Ok(e),
        None => {
            let ask = serde_json::json!({ "scopes": ["front_door"] });
            match call_api(state, reqwest::Method::POST, "/pair/elevation-request", Some(ask)).await {
                Ok((code, body)) if code.is_success() => decode_act::<act::ElevationReply>("/pair/elevation-request", &body)
                    .and_then(|r| r.into_elevation(owner_config(state).as_deref()))
                    .map_err(|e| e.message),
                Ok((code, body)) => Err(api_error("/pair/elevation-request", code, &body)),
                Err(e) => Err(e),
            }
        }
    };
    match pending {
        Ok(e) => {
            *state.front_door_ask.lock().unwrap() = Some(e.clone());
            if e.owner_can_grant {
                format!(
                    "{FRONT_DOOR_OWNER}: Publishing your front door needs your permission at the node \
                     (it allows the card only: no spending, nothing else). On the node's computer run: \
                     {} It asks for the short code your node's terminal shows. Then press Publish again.",
                    e.owner_action
                )
            } else {
                format!("{FRONT_DOOR_OWNER}: This node cannot let the app publish its front door. {}", e.owner_action)
            }
        }
        Err(e) => format!("Your node refused to publish the front door and could not take a request: {e}"),
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn front_door_open(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    text: String,
    allow_local: bool,
) -> Result<bitsov_app::front_door::FrontDoor, String> {
    reject_sealed_window(&window)?;
    drop(window);
    open_front_door(state.inner(), &text, allow_local).await
}

async fn open_front_door(
    state: &NodeState,
    text: &str,
    allow_local: bool,
) -> Result<bitsov_app::front_door::FrontDoor, String> {
    use bitsov_app::front_door as fd;
    let door = fd::read(text, now_unix().max(0) as u64)?;
    if !door.fresh {
        return Err("This front door has expired. Ask for a fresh one.".into());
    }
    let local = door.reach == bitsov_app::introduction::Reach::Local;
    if local && !allow_local {
        return Err(format!(
            "This front door points to a local network address ({}). Allow it on the card first. Nothing was sent.",
            door.endpoint
        ));
    }
    if !node_offers(state, fd::CAPABILITY).await {
        return Err("Your node cannot open front doors yet.".into());
    }
    let path = "/front-door/open";
    let (code, body) = call_api(
        state,
        reqwest::Method::POST,
        path,
        Some(serde_json::json!({ "card": door.link, "allow_local": local && allow_local })),
    )
    .await?;
    if code == reqwest::StatusCode::CONFLICT && body.contains("front_door_closed_mesh") {
        return Err("Your node only connects to peers you added yourself, and a front door does not add one. Nothing was sent.".into());
    }
    if !code.is_success() {
        return Err(api_error(path, code, &body));
    }
    let opened: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("{path} decode failed: {e}"))?;
    if opened["node_id"].as_str() != Some(door.node_id.as_str())
        || opened["connected"] != serde_json::Value::Bool(true)
    {
        return Err(format!("{path}: the node connected to someone else"));
    }
    let dialed = opened["dialed"]
        .as_str()
        .and_then(|d| d.parse::<std::net::SocketAddr>().ok());
    match dialed {
        Some(addr) if bitsov_app::introduction::dial_allowed(door.reach, addr.ip()) => Ok(door),
        _ => Err(format!(
            "{path}: the node dialed an address this front door does not allow"
        )),
    }
}

// ---- K1 slice 2: sponsor kit ------------------------------------------------------
//
// The inviter's node pays a small, capped gift into the newcomer's own node.
// Offer, candidate review and approval are owner actions: the ten-minute
// spend window must be open (as for invites), and Pause all stops a gift. The
// node enforces the caps, the single candidate and the persisted reservation;
// the app only shows and forwards. The newcomer's side creates the means to
// be paid (receive) and reads its status. Nothing here is admission.

fn sponsor_error(e: ActionError) -> ActionError {
    // Surface the node's own reason code (sponsor_purse_exhausted, …).
    for code in [
        "sponsor_disabled", "sponsor_kit_open", "sponsor_daily_limit", "sponsor_purse_exhausted",
        "sponsor_candidate_exists", "sponsor_kit_closed", "sponsor_kit_expired", "sponsor_code_mismatch",
        "sponsor_kit_not_ready", "sponsor_invalid", "sponsor_kit_unknown", "sponsor_owner_approval_required",
    ] {
        if e.message.contains(code) {
            return ActionError::new(code, e.message);
        }
    }
    e
}

async fn sponsor_node(state: &NodeState) -> Result<(), ActionError> {
    if node_offers(state, bitsov_app::sponsor::CAPABILITY).await {
        Ok(())
    } else {
        Err(ActionError::new("sponsor_unavailable", "Your node cannot run starter-bitcoin kits yet."))
    }
}

async fn read_sponsor_status(state: &NodeState) -> Result<bitsov_app::sponsor::SponsorStatus, String> {
    if !node_offers(state, bitsov_app::sponsor::CAPABILITY).await {
        return Err("Your node cannot run starter-bitcoin kits yet.".into());
    }
    get_json(state, "/sponsor").await
}

/// `GET /sponsor` — whether the owner turned sponsoring on, and the purse.
#[tauri::command(rename_all = "snake_case")]
async fn sponsor_status(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<bitsov_app::sponsor::SponsorStatus, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    read_sponsor_status(state.inner()).await.map_err(|e| sponsor_error(ActionError::node(e)))
}

async fn do_sponsor_offer(state: &NodeState) -> Result<bitsov_app::introduction::DoorCard, ActionError> {
    sponsor_node(state).await?;
    let text = gated_post(state, "/sponsor/offer", serde_json::json!({})).await.map_err(sponsor_error)?;
    let reply: serde_json::Value = decode_act("/sponsor/offer", &text)?;
    let link = reply["link"].as_str().ok_or_else(|| ActionError::node("/sponsor/offer: no link"))?;
    // Our own card and offer must read back as exactly what we show.
    let (card, offer) = bitsov_app::sponsor::read(link, now_unix().max(0) as u64).map_err(ActionError::node)?;
    let own = get_json::<serde_json::Value>(state, "/status").await.map_err(ActionError::node)?;
    if Some(card.node_id.as_str()) != own["node_id"].as_str() || offer.is_none() {
        return Err(ActionError::node("/sponsor/offer: the card is not this node's own offer"));
    }
    bitsov_app::sponsor::door(&card, offer.as_ref()).map_err(ActionError::node)
}

/// `POST /sponsor/offer` — this node's introduction with starter bitcoin.
#[tauri::command(rename_all = "snake_case")]
async fn sponsor_offer(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<bitsov_app::introduction::DoorCard, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_sponsor_offer(state.inner()).await
}

async fn do_sponsor_candidate(state: &NodeState, request: &str) -> Result<bitsov_app::sponsor::Candidate, ActionError> {
    sponsor_node(state).await?;
    let request = request.trim();
    if request.len() > bitsov_app::introduction::MAX_ENCODED_LEN || !request.starts_with(bitsov_app::sponsor::REQUEST_LINK_PREFIX) {
        return Err(ActionError::invalid("That is not a starter-bitcoin request (bitsov://sponsor-request#…)."));
    }
    let text = gated_post(state, "/sponsor/candidate", serde_json::json!({ "request": request })).await.map_err(sponsor_error)?;
    let candidate: bitsov_app::sponsor::Candidate = decode_act("/sponsor/candidate", &text)?;
    candidate.check().map_err(ActionError::node)?;
    Ok(candidate)
}

/// `POST /sponsor/candidate` — review a newcomer's request. Pays nothing.
#[tauri::command(rename_all = "snake_case")]
async fn sponsor_candidate(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    request: String,
) -> Result<bitsov_app::sponsor::Candidate, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_sponsor_candidate(state.inner(), &request).await
}

fn do_sponsor_owner_approval(state: &NodeState, candidate: &bitsov_app::sponsor::Candidate, code: &str) -> Result<bitsov_app::sponsor::OwnerApproval, ActionError> {
    if budget_paused(state)? {
        return Err(ActionError::new("budget_paused", "Payments are paused. Resume them to prepare the gift."));
    }
    bitsov_app::sponsor::owner_approval(candidate, code, now_unix().max(0) as u64)
        .map_err(ActionError::invalid)
}

/// Prepare only. The app never calls the independent owner's approve route.
#[tauri::command(rename_all = "snake_case")]
async fn sponsor_owner_approval(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    candidate: bitsov_app::sponsor::Candidate,
    code: String,
) -> Result<bitsov_app::sponsor::OwnerApproval, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_sponsor_owner_approval(state.inner(), &candidate, &code)
}

/// Read-authorized outcome lookup only. Never approves or dispatches a gift.
async fn do_sponsor_reconcile(state: &NodeState, intro_id: &str) -> Result<(), ActionError> {
    if intro_id.len() != 32 || !intro_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ActionError::invalid("Unknown kit."));
    }
    let path = format!("/sponsor/kits/{intro_id}/reconcile");
    let (status, body) = call_api(state, reqwest::Method::POST, &path, Some(serde_json::json!({}))).await?;
    if !status.is_success() {
        return Err(sponsor_error(ActionError::node(api_error(&path, status, &body))));
    }
    // The renderer rereads status and validates the entire frozen tuple.
    // Do not expose the reconciliation response's invoice to the renderer.
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
async fn sponsor_reconcile(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    intro_id: String,
) -> Result<(), ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_sponsor_reconcile(state.inner(), &intro_id).await
}

/// `POST /sponsor/kits/:id/cancel` — withdraw an offer before any payment.
#[tauri::command(rename_all = "snake_case")]
async fn sponsor_cancel(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    intro_id: String,
) -> Result<(), ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    if intro_id.len() != 32 || !intro_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ActionError::invalid("Unknown kit."));
    }
    gated_post(state.inner(), &format!("/sponsor/kits/{intro_id}/cancel"), serde_json::json!({})).await.map_err(sponsor_error)?;
    Ok(())
}

async fn do_sponsor_request(state: &NodeState, text: &str) -> Result<bitsov_app::sponsor::FundingAsk, ActionError> {
    let (card, offer) = bitsov_app::sponsor::read(text, now_unix().max(0) as u64).map_err(ActionError::invalid)?;
    let offer = offer.ok_or_else(|| ActionError::invalid("This introduction offers no starter bitcoin."))?;
    sponsor_node(state).await?;
    let door = bitsov_app::sponsor::door(&card, Some(&offer)).map_err(ActionError::node)?;
    let link = door.offer_link.unwrap_or_default();
    let path = "/sponsor/request";
    let (status, body) = call_api(state, reqwest::Method::POST, path, Some(serde_json::json!({ "link": link }))).await.map_err(ActionError::node)?;
    if !status.is_success() {
        return Err(sponsor_error(ActionError::node(api_error(path, status, &body))));
    }
    let ask: bitsov_app::sponsor::FundingAsk = decode_act(path, &body)?;
    // What we show must be what we asked for: this sponsor, this gift.
    if ask.sponsor != card.node_id || ask.amount_msat != offer.gift_msat || ask.code.len() != 6
        || !ask.request.starts_with(bitsov_app::sponsor::REQUEST_LINK_PREFIX)
    {
        return Err(ActionError::node("/sponsor/request: the answer does not match this offer"));
    }
    Ok(ask)
}

/// `POST /sponsor/request` — ask for the offered starter bitcoin into one
/// invoice to this node's own wallet (funding-only at the node). Shown to the
/// inviter in person; nothing is sent anywhere.
#[tauri::command(rename_all = "snake_case")]
async fn sponsor_request(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    text: String,
) -> Result<bitsov_app::sponsor::FundingAsk, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_sponsor_request(state.inner(), &text).await
}

/// `GET /sponsor/request/:hash` — has the starter bitcoin arrived?
#[tauri::command(rename_all = "snake_case")]
async fn sponsor_request_status(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    payment_hash: String,
) -> Result<bitsov_app::sponsor::FundingStatus, String> {
    reject_sealed_window(&window)?;
    drop(window);
    if payment_hash.len() != 64 || !payment_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Unknown request.".into());
    }
    get_json(state.inner(), &format!("/sponsor/request/{payment_hash}")).await
}

/// Does `/status` list `capability`? Unreadable counts as no.
async fn node_offers(state: &NodeState, capability: &str) -> bool {
    match get_json::<serde_json::Value>(state, "/status").await {
        Ok(status) => status["api_capabilities"]
            .as_array()
            .is_some_and(|caps| caps.iter().any(|v| v.as_str() == Some(capability))),
        Err(_) => false,
    }
}

/// Renew under the existing node budget without changing its recipient ceiling.
async fn retry_contact_budget(state: &NodeState, recipient: &str, cap: u64) -> Result<u64, ActionError> {
    if state.node_grant.lock().unwrap().is_none() { return Ok(cap); }
    let grant = read_grant(state).await?.ok_or_else(grant::ended)?;
    grant.check(cap, Some(recipient), now_ms())?;
    // Genome forbids changing an existing recipient budget while issuing
    // a one-use approval. The retry price remains the separate per-call cap.
    Ok(grant.per_recipient_msat.get(recipient).copied().unwrap_or(cap))
}

/// Prepare a public owner handoff. A missing contact budget renews the existing
/// node budget; the per-call price remains independently bounded by max_msat.
/// No owner credential enters the app and no owner-only POST is made here.
async fn do_first_contact_request(state: &NodeState, recipient: &str, max_msat: u64, contact_budget_msat: Option<u64>) -> Result<Option<owner_contact::View>, ActionError> {
    let recipient = control::node_id(recipient).map_err(ActionError::invalid)?;
    let contact_budget_msat = match contact_budget_msat {
        Some(chosen) => chosen,
        None => retry_contact_budget(state, &recipient, max_msat).await?,
    };
    let (auth, _) = plan_message(state, &recipient, false, max_msat, Some(contact_budget_msat))?;
    if state.node_grant.lock().unwrap().is_none() || !node_offers(state, grant::FIRST_CONTACT_CAPABILITY).await {
        return Ok(None);
    }
    let fence = approval_fence(state);
    let grant = read_grant(state).await?.ok_or_else(grant::ended)?;
    grant.check(max_msat, Some(&recipient), now_ms())?;
    if contact_budget_msat < max_msat || contact_budget_msat > grant.budget_msat || max_msat > 100_000 {
        return Err(ActionError::invalid("The contact budget must cover this first message within the node's grant."));
    }
    check_auth(state, auth)?;
    if approval_fence(state) != fence { return Err(fence_broken()); }
    // #65 external-node attach: the app already knows this node's konsensus.toml.
    // Include --config (and a PATH hint) only then; production still expects the
    // owner to run from the data dir or add --config themselves.
    let owner_config = state
        .external_node
        .lock()
        .unwrap()
        .as_ref()
        .map(|dir| dir.join("konsensus.toml"));
    let pending = owner_contact::Pending::new(owner_contact::Request {
        client_id: grant.client_id.clone(), grant_op_id: grant.op_id.clone(),
        recipient, max_total_msat: max_msat, contact_budget_msat,
    }, fence, now_ms(), &grant, owner_config.as_deref())?;
    let view = pending.view.clone();
    *state.owner_contact.lock().unwrap() = Some(pending);
    Ok(Some(view))
}

async fn do_first_contact_status(state: &NodeState, id: &str) -> Result<owner_contact::View, ActionError> {
    let grant = read_grant(state).await?.ok_or_else(grant::ended)?;
    let fence = approval_fence(state);
    let pending = state.owner_contact.lock().unwrap();
    let pending = pending.as_ref().filter(|p| p.view.id == id)
        .ok_or_else(|| ActionError::new("owner_only", "This contact approval was cancelled."))?;
    let r = &pending.view.request;
    let (auth, _) = plan_message(state, &r.recipient, false, r.max_total_msat, Some(r.contact_budget_msat))?;
    check_auth(state, auth)?;
    pending.status(&grant, fence, now_ms())
}

fn do_first_contact_cancel(state: &NodeState, id: &str) {
    let mut pending = state.owner_contact.lock().unwrap();
    if pending.as_ref().is_some_and(|p| p.view.id == id) { *pending = None; }
}

/// A receipt only lets the app attempt compose; the node independently checks
/// and consumes the actual single-use grant, under the reviewed budget.
async fn confirm_first_contact(state: &NodeState, recipient: &str, max_msat: u64, contact_budget_msat: u64) -> Result<(), ActionError> {
    if state.node_grant.lock().unwrap().is_none() || !node_offers(state, grant::FIRST_CONTACT_CAPABILITY).await {
        return Ok(());
    }
    let id = state.owner_contact.lock().unwrap().as_ref().filter(|p| {
        let r = &p.view.request;
        r.recipient == recipient && r.max_total_msat == max_msat && r.contact_budget_msat == contact_budget_msat
    }).map(|p| p.view.id.clone()).ok_or_else(|| ActionError::new("owner_only", "Approve this contact at your node first. Nothing was sent."))?;
    let view = do_first_contact_status(state, &id).await?;
    if !view.ready { return Err(ActionError::new("owner_only", "Waiting for your approval at the node. Nothing was sent.")); }
    let mut pending = state.owner_contact.lock().unwrap();
    if pending.as_ref().is_none_or(|p| p.view.id != id) {
        return Err(ActionError::new("owner_only", "This contact approval was cancelled."));
    }
    *pending = None;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
async fn first_contact_request(window: WebviewWindow<impl tauri::Runtime>, state: State<'_, NodeState>, recipient: String, max_msat: u64, contact_budget_msat: Option<u64>) -> Result<Option<owner_contact::View>, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_first_contact_request(state.inner(), &recipient, max_msat, contact_budget_msat).await
}

#[tauri::command(rename_all = "snake_case")]
async fn first_contact_status(window: WebviewWindow<impl tauri::Runtime>, state: State<'_, NodeState>, id: String) -> Result<owner_contact::View, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_first_contact_status(state.inner(), &id).await
}

#[tauri::command(rename_all = "snake_case")]
async fn first_contact_cancel(window: WebviewWindow<impl tauri::Runtime>, state: State<'_, NodeState>, id: String) -> Result<(), ActionError> {
    reject_sealed_window(&window)?;
    do_first_contact_cancel(state.inner(), &id);
    Ok(())
}

/// `GET /payments/balance` + `GET /payments/channels` — the Wallet panel.
#[tauri::command(rename_all = "snake_case")]
async fn payments_overview(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<control::WalletOverview, String> {
    reject_sealed_window(&window)?;
    drop(window);
    read_wallet(state.inner()).await
}

// ---- control center actions (slice B) -----------------------------------------
//
// Every spending or node-changing call checks the owner's spend window FIRST,
// before any request, and goes through `call_api` like the reads. The node still
// decides: a 403 means this token cannot do it, whatever the window says.
// Receiving (an invoice) needs no approval. See `bitsov_app::act`.

/// Parse a 2xx body into an action shape.
fn decode_act<T: serde::de::DeserializeOwned>(path: &str, body: &str) -> Result<T, ActionError> {
    serde_json::from_str(body).map_err(|e| ActionError::node(format!("{path} decode failed: {e}")))
}

/// An admin POST (invites), never a money request. Always needs the spend window.
async fn gated_post(
    state: &NodeState,
    path: &str,
    body: serde_json::Value,
) -> Result<String, ActionError> {
    gated_post_auth(state, Auth::Window(approval_generation(state)?), path, body).await
}

/// Admin POST under the same budget / window authority as a paid send (file upload).
async fn gated_post_auth(
    state: &NodeState,
    auth: Auth,
    path: &str,
    body: serde_json::Value,
) -> Result<String, ActionError> {
    check_auth(state, auth)?;
    let (status, text) = call_api(state, reqwest::Method::POST, path, Some(body)).await?;
    if act::is_scope_refusal(status.as_u16()) {
        return Err(ActionError::new(
                "owner_only",
                "Your node allows this only from the owner's own terminal, not from a paired app.",
            ));
    }
    if !status.is_success() {
        return Err(ActionError::node(api_error(path, status, &text)));
    }
    Ok(text)
}

fn approval_generation(state: &NodeState) -> Result<u64, ActionError> {
    let mut gate = state.spend.lock().unwrap();
    gate.check(now_ms())?;
    Ok(gate.generation())
}

/// The app's own files: `NodeState::app_dir` in external mode, else next to the
/// supervised node's config.
fn app_files_dir(state: &NodeState) -> Option<PathBuf> {
    if let Some(dir) = state.app_dir.lock().unwrap().clone() {
        return Some(dir);
    }
    state.config.lock().unwrap().as_deref()?.parent().map(Path::to_path_buf)
}

fn spend_journal(state: &NodeState) -> Result<Journal, ActionError> {
    let dir = app_files_dir(state)
        .ok_or_else(|| spend_journal::unknown("The app data directory is not ready."))?;
    Journal::open(&dir.join("app-spend"))
}

fn ceiling(price: u64, max_msat: u64) -> Result<(), ActionError> {
    if max_msat == 0 || price > max_msat {
        return Err(ActionError::new("price_changed", format!("The current price is {price} msat, above the confirmed ceiling of {max_msat} msat. Nothing was dispatched; refresh the quote.")));
    }
    Ok(())
}

fn no_pending_spend(state: &NodeState) -> Result<(), ActionError> {
    // A resumable record holds no payment; the next send may replace it.
    if spend_journal(state)?.pending()?.is_some_and(|p| !p.resumable) {
        return Err(spend_journal::unknown("Check the pending result before starting another action."));
    }
    Ok(())
}

// ---- budgets (B2) ---------------------------------------------------------------
//
// Budget numbers and the 24-hour ledger live next to the spend journal. The
// owner's approval does not: it is `NodeState::autopay`, memory only.

/// Which approval a money request runs under, with the generation it was checked at.
#[derive(Clone, Copy, Debug)]
enum Auth {
    Window(u64),
    Budget(u64),
}

fn check_auth(state: &NodeState, auth: Auth) -> Result<(), ActionError> {
    match auth {
        Auth::Window(g) => state.spend.lock().unwrap().check_generation(g, now_ms()),
        Auth::Budget(g) => state.autopay.lock().unwrap().check_generation(g, now_ms()),
    }
}

/// A message send's line in the budget ledger.
struct Charge {
    target: String,
    room: bool,
    /// The owner's first-contact confirmation, with the budget they chose.
    confirm: Option<u64>,
    /// This node may pay admission separately from a message cap.
    readmission_possible: bool,
    /// This call issued a bounded one-time contact confirmation.
    confirmed: bool,
    /// The node keeps durable message operations (`message_operations_v1`):
    /// a 1:1 compose carries a journaled `operation_id`.
    operation: bool,
}

fn budget_dir(state: &NodeState) -> Result<(PathBuf, String), ActionError> {
    let dir = app_files_dir(state)
        .ok_or_else(|| ActionError::new("app_not_ready", "The app data directory is not ready."))?
        .join("app-spend");
    let node_id = state.node_id.lock().unwrap().clone().ok_or_else(|| ActionError::new("app_not_ready", "No node identity."))?;
    Ok((dir, node_id))
}

/// Read the book, let `edit` change it, and write it back only if asked.
fn with_book<T>(state: &NodeState, write: bool, edit: impl FnOnce(&mut Book) -> Result<T, ActionError>) -> Result<T, ActionError> {
    let _io = state.budget_io.lock().unwrap();
    let (dir, node_id) = budget_dir(state)?;
    let mut book = budget::load(&dir, &node_id)?;
    let out = edit(&mut book)?;
    if write {
        let pending = spend_journal::read_pending(&dir)?;
        let keep: Vec<&str> = pending.iter().flat_map(|p| {
            [Some(p.request_hash.as_str()), Some(p.charge_id()), p.rollback_charge_id.as_deref()]
                .into_iter().flatten()
        }).collect();
        book.prune_retaining(now_ms(), &keep);
        budget::save(&dir, &book)?;
    }
    Ok(out)
}

fn refuse_if_paused(state: &NodeState) -> Result<(), ActionError> {
    if budget_paused(state)? {
        return Err(ActionError::new("budget_paused", "Payments are paused. Resume them to send."));
    }
    Ok(())
}

/// Pause-all, where a book exists. Before sign-in there is nothing to pause.
fn budget_paused(state: &NodeState) -> Result<bool, ActionError> {
    if budget_dir(state).is_err() { return Ok(false); }
    with_book(state, false, |b| Ok(b.paused))
}

/// Decide, before any request, whether and under which approval a message pays.
fn plan_message(state: &NodeState, target: &str, room: bool, max_msat: u64, first_contact_msat: Option<u64>) -> Result<(Auth, budget::Plan), ActionError> {
    let now = now_ms();
    let window = approval_generation(state);
    let (ceiling, generation) = {
        let mut autopay = state.autopay.lock().unwrap();
        (autopay.ceiling(now), autopay.generation())
    };
    let plan = with_book(state, false, |book| budget::plan(book, budget::Ask {
        target,
        room,
        max_msat,
        first_contact_msat,
        autopay: ceiling,
        window: window.as_ref().map(|_| ()).map_err(Clone::clone),
        now_ms: now,
    }))?;
    let auth = match plan.route {
        budget::Route::Budget => Auth::Budget(generation),
        budget::Route::Window => Auth::Window(window?),
    };
    Ok((auth, plan))
}

/// The manual window supplies authority, never an exemption from the daily book.
fn plan_manual_charge(state: &NodeState, target: &str, max_msat: u64) -> Result<Charge, ActionError> {
    with_book(state, false, |book| budget::plan(book, budget::Ask {
        target, room: false, max_msat, first_contact_msat: None,
        autopay: None, window: Ok(()), now_ms: now_ms(),
    }))?;
    Ok(Charge {
        target: target.into(), room: false, confirm: None,
        readmission_possible: false, confirmed: false, operation: false,
    })
}

/// Re-plan against the book on disk and reserve the ceiling, under the journal lock.
fn reserve(state: &NodeState, auth: Auth, charge: &Charge, id: &str, max_msat: u64) -> Result<(), ActionError> {
    let now = now_ms();
    let ceiling = match auth {
        Auth::Budget(_) => state.autopay.lock().unwrap().ceiling(now),
        Auth::Window(_) => None,
    };
    with_book(state, true, |book| {
        let plan = budget::plan(book, budget::Ask {
            target: &charge.target,
            room: charge.room,
            max_msat,
            first_contact_msat: charge.confirm,
            autopay: ceiling,
            window: Ok(()),
            now_ms: now,
        })?;
        let expected = if matches!(auth, Auth::Budget(_)) { budget::Route::Budget } else { budget::Route::Window };
        if plan.route != expected {
            return Err(ActionError::new("budget_needed", "Your budget approval changed while sending. Nothing was sent; approve it again."));
        }
        if let Some(limit) = plan.confirm {
            book.set_limit(&charge.target, charge.room, limit)?;
        }
        book.reserve(id, &charge.target, charge.room, max_msat, now);
        Ok(())
    })
}

/// Settle or release durably; callers must retain the journal on I/O failure.
fn close_charge(state: &NodeState, id: &str, paid: Option<u64>, target: Option<&Target>) -> Result<(), ActionError> {
    with_book(state, true, |book| {
        match paid {
            Some(msat) => {
                let entry = book.ledger.iter().rev().find(|entry| entry.id == id)
                    .ok_or_else(|| spend_journal::unknown("The saved payment has no matching budget reservation. Inspect the local budget book."))?;
                if msat > 0 && matches!(entry.target.as_str(), budget::INVOICE_PAYMENTS | budget::KEYSEND_PAYMENTS) {
                    let Some(Target::Payment { hash }) = target else {
                        return Err(spend_journal::unknown("The payment has no canonical identity. The reservation stays held."));
                    };
                    if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
                        return Err(spend_journal::unknown("The payment identity is invalid. The reservation stays held."));
                    }
                    book.settle_payment(id, hash, msat, now_ms());
                } else {
                    book.settle(id, msat, now_ms());
                }
            }
            None => book.release(id),
        }
        Ok(())
    }).map_err(spend_journal::unknown)
}

/// No automatic HTTP retry on a money path. Journal before dispatch, and retain
/// ambiguity on every transport/5xx/decode failure, even across app restarts.
async fn money_post(state: &NodeState, auth: Auth, path: &str, body: serde_json::Value, max_msat: u64, charge: Option<Charge>) -> Result<String, ActionError> {
    money_post_with(state, auth, path, body, max_msat, charge, None).await
}

/// `retry` names the paid, undelivered record a delivery retry reuses. It
/// passes the fence only if the journal holds exactly that record, not in
/// flight. The retry never removes it: the same record is rewritten in place
/// (atomically) as in flight before dispatch, and any refusal before dispatch
/// writes the prior record back. A crash at any point leaves a record.
///
/// A 1:1 compose on a `message_operations_v1` node carries an `operation_id`
/// saved in the journal before the POST. A retry of the same send, or a resend
/// of a message the node holds no payment for, reuses it: the node pays at most
/// once per id and answers 409 if the text changed.
///
/// Holds `NodeState::money` throughout: a reconcile waits for this POST.
async fn money_post_with(state: &NodeState, auth: Auth, path: &str, mut body: serde_json::Value, max_msat: u64, charge: Option<Charge>, retry: Option<&spend_journal::Undelivered>) -> Result<String, ActionError> {
    let _money = state.money.lock().await;
    let journal = spend_journal(state)?;
    let prior = journal.pending()?;
    ensure_fresh_token(state).await;
    let token = state.token.lock().unwrap().clone().ok_or_else(|| ActionError::new("app_not_ready", "Not authenticated."))?;
    let node_id = state.node_id.lock().unwrap().clone().ok_or_else(|| ActionError::new("app_not_ready", "No node identity."))?;
    match (&prior, retry) {
        (None, None) => {}
        // Holds no payment: this action replaces it, or resumes it below.
        (Some(p), None) if p.resumable && p.node_id == node_id => {}
        (Some(p), Some(u)) if u.retry && !u.in_flight && !p.over_budget && p.node_id == node_id && p.undelivered.as_ref() == Some(u) => {}
        _ => return Err(spend_journal::unknown("Check the pending result before sending again.")),
    }
    // Nothing was paid: forget this attempt, keeping a replaced record retryable.
    let abandon = |journal: &Journal| match &prior {
        Some(p) => journal.save(p),
        None => journal.clear(),
    };
    // Pause all binds every money request, whatever window or approval is open.
    refuse_if_paused(state)?;
    check_auth(state, auth)?;
    // A fresh non-paying quote distinguishes #99 from older nodes which use
    // the same capability name but may pay admission beyond the message cap.
    // Probe once per run/identity; an unavailable quote keeps the older bound.
    if !has_all_in_caps(state) && charge.as_ref().is_some_and(|c| c.readmission_possible) {
        let peer = if body["is_room"].as_bool() == Some(true) {
            read_room_members(state, body["recipient"].as_str().unwrap_or_default()).await.ok()
                .and_then(|members| members.into_iter().find(|id| id != &node_id))
        } else { body["recipient"].as_str().map(str::to_string) };
        if let Some(peer) = peer { let _ = read_first_contact_quote(state, &peer).await; }
    }
    let all_in_caps = has_all_in_caps(state);
    let node_grant = check_node_grant(state, path, &body, max_msat).await?;
    let reserve_msat = match (&charge, &node_grant) {
        // A zero cap: the node pays nothing, re-admission included.
        _ if max_msat == 0 => 0,
        (Some(c), Some(g)) if !all_in_caps && (c.readmission_possible || g.recipient_left(&c.target).is_some()) => {
            let limit = if c.room {
                g.remaining_msat
            } else if let Some(left) = g.recipient_left(&c.target) {
                left.min(g.remaining_msat)
            } else if c.confirmed {
                // With no recipient budget, only the one-time confirmation
                // can authorize admission, bounded separately from the message.
                max_msat.saturating_mul(2).min(g.remaining_msat)
            } else {
                return Err(readmission_needs_ok());
            };
            limit.max(max_msat)
        }
        _ => max_msat,
    };
    let op = spend_journal::operation(&body);
    let one_to_one = path == "/messages/compose" && body["is_room"].as_bool() != Some(true);
    // One send, one id. A retry of it, or a resend of the same message the node
    // holds no payment for, reuses the saved id; a legacy record has none.
    let operation_id = match &prior {
        _ if !(one_to_one && charge.as_ref().is_some_and(|c| c.operation)) => None,
        Some(p) if retry.is_some() => p.operation_id.clone(),
        Some(p) if p.op.as_deref() == Some(op.as_str()) && p.operation_id.is_some() => p.operation_id.clone(),
        _ => Some(spend_journal::new_operation_id()?),
    };
    let mut pending = match (&prior, retry) {
        (Some(p), Some(_)) => {
            // Settled when the 502 came back; again here in case that write failed.
            if let (Some(paid), true) = (p.accounting_msat, charge.is_some()) { close_charge(state, p.charge_id(), Some(paid), p.target.as_ref())?; }
            // The same operation, the same record: rewritten in place, never
            // removed before this attempt exists.
            let mut next = p.clone();
            let u = next.undelivered.as_mut().expect("checked above");
            u.in_flight = true;
            u.attempts += 1;
            next.charge_id = Some(format!("{}-retry-{}", p.request_hash, u.attempts));
            next.rollback_charge_id = Some(p.charge_id().to_string());
            next.accounting_msat = None;
            next.max_msat = max_msat;
            next.target = None;
            journal.save(&next)?;
            next
        }
        _ => journal.begin_operation(&node_id, path, &body, max_msat, operation_id.clone().map(|id| (id, op.clone())))?,
    };
    // Durable above; only now may the id leave the app.
    if let Some(id) = &operation_id { body["operation_id"] = serde_json::json!(id); }
    pending.all_in = true;
    let charged = match &charge {
        Some(c) => match reserve(state, auth, c, pending.charge_id(), reserve_msat) {
            Ok(()) => Some(pending.charge_id().to_string()),
            Err(e) => {
                abandon(&journal)?;
                return Err(e);
            }
        },
        None => None,
    };
    if charged.is_some() {
        pending.budgeted = true;
        journal.save(&pending)?;
    }
    let release = |state: &NodeState| match &charged {
        Some(id) => close_charge(state, id, None, None),
        None => Ok(()),
    };
    // Journal I/O can take time. Recheck immediately before issuing the request.
    if let Err(e) = refuse_if_paused(state).and_then(|()| check_auth(state, auth)) {
        release(state)?;
        abandon(&journal)?;
        return Err(e);
    }
    let response = state.http.post(format!("{}{path}", state.api_base))
        .bearer_auth(token).json(&body).timeout(state.spend_timeout).send().await
        .map_err(|_| spend_journal::unknown("The node did not return a complete response."))?;
    let status = response.status();
    // These statuses are rejected by authentication before any handler runs.
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::UNAUTHORIZED {
        release(state)?;
        abandon(&journal)?;
        state.autopay.lock().unwrap().lock();
        *state.node_grant.lock().unwrap() = None;
        return Err(state.spend.lock().unwrap().refused());
    }
    let text = response.text().await.map_err(|_| spend_journal::unknown("The response was interrupted."))?;
    if act::readiness_refusal(status.as_u16(), &text) {
        release(state)?;
        abandon(&journal)?;
        return Err(ActionError::new("not_ready", act::MONEY_NOT_READY));
    }
    // Proven non-dispatch (#115): nothing left the wallet. Clear the journal
    // and release the app reservation; any other error stays spend_unknown.
    if act::not_dispatched_refusal(status.as_u16(), &text) {
        release(state)?;
        abandon(&journal)?;
        return Err(ActionError::new("not_dispatched", act::not_dispatched_message(&text)));
    }
    // G1: the node refused under its grant before reserving or paying anything.
    if let Some(refusal) = grant::refusal(status.as_u16(), &text) {
        release(state)?;
        abandon(&journal)?;
        let known = state.node_grant.lock().unwrap().clone();
        if refusal.ends_grant() { drop_grant(state); }
        return Err(refusal.error(known.as_ref()));
    }
    if status == reqwest::StatusCode::CONFLICT && body.get("max_total_msat").is_some()
        && serde_json::from_str::<serde_json::Value>(&text).ok().is_some_and(|v| v["code"] == "price_cap_exceeded") {
        release(state)?;
        // Not a price change: the contact asks for admission again.
        if act::readmission_capped_refusal(status.as_u16(), &text) {
            if operation_id.is_some() && retry.is_none() {
                // The node holds this operation `prepared`, nothing paid: sending
                // this very message again (under the contact's re-admission
                // quote) reuses its id, so it can never be paid twice.
                pending.resumable = true;
                pending.budgeted = false;
                pending.accounting_msat = None;
                pending.target = None;
                journal.save(&pending)?;
            } else {
                abandon(&journal)?;
            }
            return Err(ActionError::new("readmission_capped", act::READMISSION_CAPPED));
        }
        abandon(&journal)?;
        return Err(ActionError::new("price_cap_exceeded", "The node refused the changed price before any payment. Refresh the quote."));
    }
    // The node compared this operation before paying anything in this call.
    if let Some(code) = operation_id.as_ref().and(act::operation_conflict(status.as_u16(), &text)) {
        match code {
            "operation_mismatch" => {
                release(state)?;
                abandon(&journal)?;
                return Err(ActionError::new("operation_mismatch", act::OPERATION_MISMATCH));
            }
            "failed_paid" => {
                release(state)?;
                journal.clear()?;
                return Err(ActionError::new("failed_paid", act::FAILED_PAID));
            }
            // An earlier attempt's payment is unresolved: keep everything held.
            _ => return Err(ActionError::new("payment_unknown", act::PAYMENT_UNKNOWN).for_pending(&pending.id)),
        }
    }
    let op_error = operation_id.as_deref().and_then(|id| act::operation_error(&text, id));
    let is_room = body["is_room"].as_bool() == Some(true);
    // BUG-PSI: the node paid, the message did not go. Known money, not an
    // unknown outcome, but the fence stays: nothing is paid again on its own.
    if let (false, "/messages/compose", Some(incomplete)) = (is_room, path, act::settled_incomplete(status.as_u16(), &text)) {
        let paid = retry.map_or(0, |u| u.paid_msat).checked_add(incomplete.amount_msat)
            .ok_or_else(|| spend_journal::unknown("The reported total overflows; the reservation stays held."))?;
        pending.over_budget = incomplete.amount_msat > reserve_msat;
        // The node's 502 reports settled principal, without a routing-fee
        // field. Keep the all-in allowance for any positive settlement, as
        // for a legacy success reply. A no-pay probe adds no new allowance.
        let accounted = if incomplete.amount_msat == 0 { 0 } else { reserve_msat.max(incomplete.amount_msat) };
        pending.accounting_msat = Some(accounted);
        // The node holds this operation paid: a retry with its id re-sends, never re-pays.
        let op_retry = op_error.as_ref().is_some_and(|e| e.retry_allowed
            && matches!(spend_journal::outcome(e.state.as_deref().unwrap_or_default()), spend_journal::Outcome::Paid | spend_journal::Outcome::Sent));
        let retry_safe = incomplete.retry_safe || op_retry;
        pending.undelivered = Some(spend_journal::Undelivered {
            peer: body["recipient"].as_str().unwrap_or_default().to_string(),
            paid_msat: paid,
            retry: retry_safe && !pending.over_budget,
            op,
            admission_msat: retry.map_or(incomplete.amount_msat, |u| u.admission_msat),
            in_flight: false,
            attempts: retry.map_or(0, |u| u.attempts + 1),
            payment_hash: op_error.as_ref().and_then(|e| e.payment_hash.clone()).or_else(|| retry.and_then(|u| u.payment_hash.clone())),
        });
        journal.save(&pending)?;
        if pending.over_budget {
            return Err(spend_journal::unknown(format!("The node reports {} msat settled, beyond the reserved total ({reserve_msat}). Funds may already have moved; do not retry.", incomplete.amount_msat)));
        }
        if let Some(id) = &charged { close_charge(state, id, Some(accounted), pending.target.as_ref())?; }
        return Err(ActionError::undelivered(paid, retry_safe).for_pending(&pending.id));
    }
    if !status.is_success() {
        if op_error.as_ref().is_some_and(|e| spend_journal::outcome(e.state.as_deref().unwrap_or_default()) == spend_journal::Outcome::PaymentUnknown) {
            return Err(ActionError::new("payment_unknown", act::PAYMENT_UNKNOWN).for_pending(&pending.id));
        }
        return Err(spend_journal::unknown(api_error(path, status, &text)));
    }
    let mut value: serde_json::Value = serde_json::from_str(&text).map_err(spend_journal::unknown)?;
    let mut room_refused = false;
    // Admission paid again after a reconnect: outside the message's confirmed
    // cap (the node's grant bounds it), but it counts against the contact.
    let mut readmission = 0;
    let mut payment_failed = false;
    let (amount, complete) = if path == "/payments/pay" {
        let receipt: act::PayReply = serde_json::from_value(value.clone()).map_err(spend_journal::unknown)?;
        (receipt.amount_msat, !receipt.preimage.is_empty())
    } else if path == "/payments/keysend" {
        let receipt: act::KeysendReply = serde_json::from_value(value.clone()).map_err(spend_journal::unknown)?;
        payment_failed = receipt.status.eq_ignore_ascii_case("failed");
        (receipt.amount_msat, matches!(receipt.status.to_ascii_lowercase().as_str(), "settled" | "failed"))
    } else {
        let receipt: act::SendReply = serde_json::from_value(value.clone()).map_err(spend_journal::unknown)?;
        if operation_id.is_some() && receipt.operation_id != operation_id {
            return Err(spend_journal::unknown("The node answered for a different operation. Nothing was dispatched again."));
        }
        let complete = if is_room {
            let summary = act::room_result(&value, &body, max_msat)?;
            room_refused = summary.1;
            summary.0
        } else { true };
        readmission = receipt.readmission_msat.unwrap_or(0);
        let mut amount = receipt.amount_msat;
        if let (Some(u), Some(_)) = (retry, &operation_id) {
            // An operation reply reports the whole operation. The same settled
            // payment means this call paid nothing new; otherwise only the increase.
            amount = if receipt.payment_hash.is_some() && receipt.payment_hash == u.payment_hash { 0 }
                else { amount.saturating_add(readmission).saturating_sub(u.paid_msat) };
            readmission = 0;
            value["amount_msat"] = serde_json::json!(amount);
            value["readmission_msat"] = serde_json::Value::Null;
            if amount == 0 { value["max_routing_fee_msat"] = serde_json::json!(0); }
        }
        (amount, complete)
    };
    pending.target = value.get("payment_hash").and_then(|h| h.as_str())
        .filter(|h| h.len() == 64 && h.bytes().all(|c| c.is_ascii_hexdigit()))
        .map(|hash| Target::Payment { hash: hash.to_string() })
        .or_else(|| Some(Target::Message {
            id: control::node_id(value.get("message_id")?.as_str()?).ok()?,
            peer: body.get("recipient")?.as_str()?.to_string(),
        }));
    // A canonical room message proves only one member. It must NEVER reconcile
    // missing/unknown members; current node API has no aggregate lookup.
    if is_room { pending.target = None; }
    // Missing is not zero. Preserve the full approved allowance for legacy
    // replies and show that ceiling instead of inventing a zero network fee.
    let principal = amount.checked_add(readmission)
        .ok_or_else(|| spend_journal::unknown("The reported principal overflows."))?;
    let reported_fee = value.get("max_routing_fee_msat").and_then(|v| v.as_u64());
    let fee = reported_fee.unwrap_or_else(|| reserve_msat.saturating_sub(principal));
    value["max_routing_fee_msat"] = serde_json::json!(fee);
    let paid = if payment_failed { 0 } else {
        principal.checked_add(fee)
            .ok_or_else(|| spend_journal::unknown("The reported total overflows; the reservation stays held."))?
    };
    // A retained legacy allowance is not evidence that those fees were paid.
    let observed = principal.checked_add(reported_fee.unwrap_or(0))
        .ok_or_else(|| spend_journal::unknown("The reported total overflows."))?;
    pending.over_budget = amount > max_msat || ((all_in_caps || readmission == 0) && observed > max_msat) || paid > reserve_msat;
    // Save the aggregate before touching the book. A crash or failed book
    // write is recoverable without another payment or message-only history.
    // Delivered: saved with its accounting below, the record is no longer an
    // unresolved delivery, only accounting to finish, so a crash before
    // `clear` reconciles it like any known result.
    if complete && !is_room {
        pending.undelivered = None;
    }
    if let (Some(id), true) = (&charged, complete) {
        pending.accounting_msat = Some(paid);
        journal.save(&pending)?;
        close_charge(state, id, Some(paid), pending.target.as_ref())?;
    }
    if pending.over_budget || !complete {
        journal.save(&pending)?;
        if pending.over_budget {
            return Err(spend_journal::unknown(format!("The node reports {amount} msat for the message and {readmission} msat for admission, beyond the confirmed message cap ({max_msat}) or reserved total ({reserve_msat}). Funds may already have moved; do not retry.")));
        }
    } else {
        journal.clear()?;
    }
    if is_room && !complete {
        return Err(spend_journal::unknown("At least one room payment is unresolved. Do not retry the room send."));
    }
    if room_refused {
        return Err(ActionError::new("room_partial", "Room send incomplete: a member was refused or a paid message could not be stored. Do not resend the whole room message."));
    }
    serde_json::to_string(&value).map_err(spend_journal::unknown)
}

/// Waits for any money POST in flight (`NodeState::money`), then reads its record.
async fn do_spend_reconcile(state: &NodeState) -> Result<String, ActionError> {
    let _money = state.money.lock().await;
    let journal = spend_journal(state)?;
    let Some(mut pending) = journal.pending()? else { return Ok("No pending spend.".into()); };
    if state.node_id.lock().unwrap().as_deref() != Some(pending.node_id.as_str()) {
        return Err(spend_journal::unknown("The pending action belongs to another identity."));
    }
    if let Some(undelivered) = &pending.undelivered {
        // Paid, not delivered. Accounting it resolves the money, not the
        // message: the record stays until a retry delivers it or the owner
        // stops retrying (`spend_dismiss_undelivered`).
        if pending.over_budget {
            return Err(spend_journal::unknown("The node exceeded its spending bound; inspect the owner node."));
        }
        if undelivered.in_flight {
            if let Some(id) = pending.operation_id.clone() {
                return reconcile_operation(state, &journal, pending, &id).await;
            }
            return Err(spend_journal::unknown("A delivery retry was sent and its result is unknown. Missing history does not prove failure; inspect the owner node. The app will not retry."));
        }
        if let Some(paid) = pending.accounting_msat {
            close_charge(state, pending.charge_id(), Some(paid), pending.target.as_ref())?;
        }
        return Err(ActionError::new("undelivered_pending", format!(
            "Accounted: {} msat paid, and the message is still not delivered. Nothing was dispatched again. Retry delivery from its card, or stop retrying it.",
            undelivered.paid_msat
        )).for_pending(&pending.id));
    }
    if let Some(paid) = pending.accounting_msat {
        if pending.over_budget {
            return Err(spend_journal::unknown("The node exceeded its spending bound; inspect the owner node."));
        }
        close_charge(state, pending.charge_id(), Some(paid), pending.target.as_ref())?;
        journal.clear()?;
        return Ok("Previous action accounted for. Nothing was dispatched again.".into());
    }
    if pending.resumable {
        return Ok(NOTHING_PAID.into());
    }
    if let Some(id) = pending.operation_id.clone() {
        return reconcile_operation(state, &journal, pending, &id).await;
    }
    let path = match &pending.target {
        Some(Target::Payment { .. }) => "/payments?limit=100".to_string(),
        Some(Target::Message { peer, .. }) => control::messages_path(peer, None, Some(200))?,
        None => return Err(spend_journal::unknown("No node-issued receipt ID was returned. Automatic reconciliation is unavailable; inspect the owner node. The app will not retry.")),
    };
    let rows: Vec<serde_json::Value> = get_json(state, &path).await?;
    let terminal = rows.iter().find_map(|row| {
        spend_journal::terminal(&pending, std::slice::from_ref(row)).map(|status| (status, row))
    });
    match terminal {
        Some((status, row)) => {
            // Payment history is sufficient for direct principal, but message
            // history may omit admission. Never shrink a message reservation here.
            if pending.budgeted && matches!(pending.target, Some(Target::Payment { .. })) {
                let paid = if status == "failed" { 0 } else {
                    let principal = row["amount_msat"].as_u64().ok_or_else(|| spend_journal::unknown("The payment record has no principal."))?;
                    if pending.all_in {
                        // History exposes principal, not the charged routing ceiling.
                        // Keep the approved all-in allowance instead of inventing a fee.
                        pending.max_msat.max(principal)
                    } else { principal }
                };
                pending.accounting_msat = Some(paid);
                journal.save(&pending)?;
                close_charge(state, &pending.request_hash, Some(paid), pending.target.as_ref())?;
            }
            journal.clear()?;
            Ok(format!("Previous action {status}. Nothing was dispatched again."))
        }
        None => Err(spend_journal::unknown("No matching terminal record. Missing history does not prove failure.")),
    }
}

const NOTHING_PAID: &str = "Not sent - nothing was paid: your node holds no payment for this message. Sending the same message again reuses its operation, so it can never be paid twice.";

/// Ask the node what became of this send (`GET /messages/operations/{id}`).
/// Never re-sends and never pays: a retry is a separate owner action that
/// reuses the same id. Unknown or unrecognised states keep the fence.
async fn reconcile_operation(state: &NodeState, journal: &Journal, mut pending: spend_journal::Pending, id: &str) -> Result<String, ActionError> {
    use spend_journal::Outcome;
    let path = format!("/messages/operations/{id}");
    let (status, text) = call_api(state, reqwest::Method::GET, &path, None).await
        .map_err(|e| spend_journal::unknown(format!("Your node could not be asked about this send ({e}). Nothing was dispatched again.")))?;
    // The node writes the operation before it pays anything: never recorded is
    // nothing paid. (A node without the route never accepted the id either.)
    let reply = if status == reqwest::StatusCode::NOT_FOUND { None } else {
        if !status.is_success() {
            return Err(spend_journal::unknown(api_error(&path, status, &text)));
        }
        let reply: act::SendReply = serde_json::from_str(&text).map_err(spend_journal::unknown)?;
        if reply.operation_id.as_deref() != Some(id) {
            return Err(spend_journal::unknown("The node answered for a different operation. Nothing was dispatched again."));
        }
        Some(reply)
    };
    // Serialised with every money action; still, never write over a record
    // that another action replaced, or whose retry started or ended, meanwhile.
    let in_flight = |p: &spend_journal::Pending| p.undelivered.as_ref().map(|u| u.in_flight);
    if journal.pending()?.is_none_or(|now| now.id != pending.id || in_flight(&now) != in_flight(&pending)) {
        return Err(spend_journal::unknown("The pending result changed while your node was asked. Nothing was dispatched again; check the pending result again."));
    }
    let outcome = reply.as_ref().map_or(Outcome::NothingPaid, |r| spend_journal::outcome(r.state.as_deref().unwrap_or_default()));
    let retry = pending.undelivered.clone();
    let reply = match (outcome, reply) {
        (Outcome::PaymentUnknown, _) => {
            return Err(ActionError::new("payment_unknown", act::PAYMENT_UNKNOWN).for_pending(&pending.id));
        }
        (Outcome::NothingPaid, _) if retry.is_some() => {
            return Err(spend_journal::unknown("Your node holds no payment for a message it reported paid. Inspect the owner node; the app will not retry."));
        }
        (Outcome::NothingPaid, _) => {
            if pending.budgeted { close_charge(state, pending.charge_id(), None, None)?; }
            pending.resumable = true;
            pending.budgeted = false;
            pending.accounting_msat = None;
            pending.target = None;
            journal.save(&pending)?;
            return Ok(NOTHING_PAID.into());
        }
        (_, Some(reply)) => reply,
        (_, None) => unreachable!("only NothingPaid lacks a reply"),
    };
    // The reply covers the whole operation; a retry accounts only what it added.
    let whole = reply.amount_msat.checked_add(reply.readmission_msat.unwrap_or(0))
        .ok_or_else(|| spend_journal::unknown("The reported principal overflows."))?;
    let principal = match &retry {
        Some(u) if reply.payment_hash.is_some() && reply.payment_hash == u.payment_hash => 0,
        Some(u) => whole.saturating_sub(u.paid_msat),
        None => whole,
    };
    let paid = if principal == 0 { 0 } else {
        principal.checked_add(reply.max_routing_fee_msat)
            .ok_or_else(|| spend_journal::unknown("The reported total overflows."))?
    };
    let message_msat = if retry.is_some() { principal } else { reply.amount_msat };
    if message_msat > pending.max_msat {
        pending.over_budget = true;
        journal.save(&pending)?;
        return Err(spend_journal::unknown(format!("The node reports {message_msat} msat, beyond the confirmed cap ({}). Funds may already have moved; do not retry.", pending.max_msat)));
    }
    pending.accounting_msat = Some(paid);
    journal.save(&pending)?;
    if pending.budgeted { close_charge(state, pending.charge_id(), Some(paid), pending.target.as_ref())?; }
    match outcome {
        Outcome::Accepted | Outcome::Sent => {
            journal.clear()?;
            Ok(if outcome == Outcome::Accepted {
                format!("Accepted: the recipient's node stored it ({whole} msat paid). Nothing was dispatched again.")
            } else {
                format!("Sent: paid ({whole} msat) and handed to the recipient's node, not yet accepted. Your node keeps delivering it; nothing was dispatched again.")
            })
        }
        Outcome::FailedPaid => {
            journal.clear()?;
            Err(ActionError::new("failed_paid", act::FAILED_PAID))
        }
        _ => {
            // Paid, not handed over: the same record, retryable with the same id.
            let paid_msat = retry.as_ref().map_or(whole, |u| u.paid_msat.saturating_add(principal));
            pending.undelivered = Some(spend_journal::Undelivered {
                peer: retry.as_ref().map(|u| u.peer.clone()).or_else(|| pending.peer.clone()).unwrap_or_default(),
                paid_msat,
                retry: reply.retry_allowed,
                op: retry.as_ref().map(|u| u.op.clone()).or_else(|| pending.op.clone()).unwrap_or_default(),
                admission_msat: retry.as_ref().map_or(0, |u| u.admission_msat),
                in_flight: false,
                attempts: retry.as_ref().map_or(0, |u| u.attempts),
                payment_hash: reply.payment_hash.clone(),
            });
            journal.save(&pending)?;
            Err(ActionError::new("undelivered_pending", format!(
                "Accounted: {paid_msat} msat paid, and the message is not delivered yet. Your node keeps resending it; nothing was dispatched again. Retry delivery from its card (it pays nothing new), or stop retrying it."
            )).for_pending(&pending.id))
        }
    }
}

/// The owner stops retrying a paid, undelivered message. Only a record whose
/// money is fully known (no retry in flight, within its bound) is released,
/// after its accounting is written. Nothing is dispatched.
fn do_spend_dismiss_undelivered(state: &NodeState, pending_id: &str) -> Result<String, ActionError> {
    let Ok(_money) = state.money.try_lock() else {
        return Err(ActionError::new("money_busy", "Another payment action is still running. Nothing was changed; try again in a moment."));
    };
    let journal = spend_journal(state)?;
    // Only the record the owner chose: a stale card never releases another message.
    let pending = journal.pending()?.filter(|p| p.id == pending_id)
        .ok_or_else(|| ActionError::new("retry_unavailable", "That message is no longer waiting for delivery. Nothing was changed."))?;
    if state.node_id.lock().unwrap().as_deref() != Some(pending.node_id.as_str()) {
        return Err(spend_journal::unknown("The pending action belongs to another identity."));
    }
    let undelivered = match &pending.undelivered {
        Some(u) if !u.in_flight && !pending.over_budget => u.clone(),
        _ => return Err(spend_journal::unknown("This pending result is not a known paid, undelivered message. Check the pending result.")),
    };
    if let Some(paid) = pending.accounting_msat {
        close_charge(state, pending.charge_id(), Some(paid), pending.target.as_ref())?;
    }
    journal.clear()?;
    Ok(format!("Stopped retrying. {} msat was paid and the message was not delivered; nothing more will be paid for it.", undelivered.paid_msat))
}

// ---- G1 node grants -------------------------------------------------------------
//
// See `grant.rs`. Without `spend_budget_grant_v1` the node keeps the pre-G1
// behaviour. With it, `GET /pair/grant` bounds every approval this app opens.

/// Does the node advertise budget grants? An unreadable `/status` is an error.
async fn node_has_g1(state: &NodeState) -> Result<bool, ActionError> {
    let status: serde_json::Value = get_json(state, "/status").await.map_err(|_| grant::unreadable())?;
    let caps = status["api_capabilities"].as_array().ok_or_else(grant::unreadable)?;
    Ok(caps.iter().any(|v| v.as_str() == Some(grant::CAPABILITY)))
}

async fn read_grant(state: &NodeState) -> Result<Option<NodeGrant>, ActionError> {
    let (status, body) = call_api(state, reqwest::Method::GET, "/pair/grant", None).await.map_err(|_| grant::unreadable())?;
    if !status.is_success() {
        return Err(grant::unreadable());
    }
    grant::parse(&body)
}

/// Before opening anything on a paired node: `Ok(None)` on a pre-G1 node, the
/// live grant on a G1 node, or an error that opens nothing (`grant_ended` when
/// the node holds no live grant, `grant_unknown` when it could not be read).
async fn grant_for_open(state: &NodeState) -> Result<Option<NodeGrant>, ActionError> {
    if !node_has_g1(state).await? {
        return Ok(None);
    }
    match read_grant(state).await? {
        Some(g) if g.live(now_ms()) => Ok(Some(g)),
        _ => Err(grant::ended()),
    }
}

/// Open what was asked, bounded by the node grant when there is one: never past
/// its expiry, and a budget approval never above its total. The caller holds
/// both approval locks and has checked the fence.
fn arm_want(spend: &mut act::SpendGate, autopay: &mut budget::Autopay, want: Want, basis: act::SpendBasis, node: Option<&NodeGrant>) {
    let until = node.map_or(u64::MAX, NodeGrant::expires_at_ms);
    match want {
        Want::Window => spend.arm_until(now_ms(), until, basis),
        Want::Budget(ceiling) => {
            let ceiling = node.map_or(ceiling, |g| ceiling.min(g.budget_msat));
            autopay.arm_until(now_ms(), until, ceiling, basis)
        }
    }
}

/// The owner's cancellation fence: the window's and the budget approval's
/// generations. Lock, Pause all, expiry and a dropped grant each bump one.
fn approval_fence(state: &NodeState) -> (u64, u64) {
    let spend = state.spend.lock().unwrap().generation();
    let autopay = state.autopay.lock().unwrap().generation();
    (spend, autopay)
}

fn fence_broken() -> ActionError {
    ActionError::new(
        "budget_needed",
        "Spending was paused or locked while your approval was being opened. Nothing was opened; approve it again.",
    )
}

/// Open `want` only if payments are not paused and neither approval changed
/// since `fence` was taken, checked and opened under both locks at once. An
/// answer that arrives after the owner paused or locked opens nothing.
fn open_fenced(state: &NodeState, fence: (u64, u64), want: Want, basis: act::SpendBasis, node: Option<&NodeGrant>) -> Result<(), ActionError> {
    // Pause writes the book after bumping both generations, so a pause that
    // lands after this read is caught by the generation check below.
    if budget_paused(state)? {
        return Err(ActionError::new("budget_paused", "Payments are paused. Resume them first."));
    }
    let mut spend = state.spend.lock().unwrap();
    let mut autopay = state.autopay.lock().unwrap();
    if (spend.generation(), autopay.generation()) != fence {
        return Err(fence_broken());
    }
    arm_want(&mut spend, &mut autopay, want, basis, node);
    *state.node_grant.lock().unwrap() = node.cloned();
    Ok(())
}

/// The node grant is gone: close everything that was opened under it.
fn drop_grant(state: &NodeState) {
    state.autopay.lock().unwrap().lock();
    state.spend.lock().unwrap().lock();
    *state.wants.lock().unwrap() = Wants::default();
    *state.node_grant.lock().unwrap() = None;
}

/// Re-read the node grant immediately before a paid request, and refuse what
/// it would refuse. Only when this run opened its approvals under one.
async fn check_node_grant(state: &NodeState, path: &str, body: &serde_json::Value, max_msat: u64) -> Result<Option<NodeGrant>, ActionError> {
    if state.node_grant.lock().unwrap().is_none() {
        return Ok(None);
    }
    let now = now_ms();
    let Some(g) = read_grant(state).await?.filter(|g| g.live(now)) else {
        drop_grant(state);
        return Err(grant::ended());
    };
    // The node keys a peer message or file by node id and a keysend by
    // `dest_pubkey`; rooms and invoices are checked member by member there.
    let recipient = match path {
        "/payments/keysend" => body["dest_pubkey"].as_str(),
        "/payments/pay" => None,
        _ if body["is_room"].as_bool() == Some(true) => None,
        _ => body["recipient"].as_str(),
    };
    let checked = g.check(max_msat, recipient, now);
    *state.node_grant.lock().unwrap() = Some(g.clone());
    checked.map(|()| Some(g))
}

/// The G1 `budget` proposal for an elevation request. Only a suggestion.
fn budget_proposal(state: &NodeState, want: Want) -> Option<serde_json::Value> {
    let book = with_book(state, false, |b| Ok(b.clone())).ok()?;
    Some(match want {
        Want::Budget(ceiling) => grant::proposal(ceiling, grant::MAX_TTL_SECS, &book.contacts),
        Want::Window => grant::proposal(book.ceiling_msat, act::SPEND_WINDOW_MS / 1000, &Default::default()),
    })
}

/// Advance the spend window. `ask` is the owner's tap: on rc7 it opens the
/// app's own window; on a paired node it opens a window over an existing grant
/// or asks the node for one. Without `ask`, only polls a pending request.
async fn spend_advance(state: &NodeState, ask: bool) -> Result<act::SpendView, ActionError> {
    spend_advance_for(state, ask.then_some(Want::Window)).await
}

/// Open what the owner asked for (`want`): the ten-minute window or the budget
/// approval. On a paired node without `spend`, both go through one elevation
/// request, and a grant opens only what was asked.
async fn spend_advance_for(state: &NodeState, want: Option<Want>) -> Result<act::SpendView, ActionError> {
    restore_spend_pending(state);
    let out = spend_advance_for_inner(state, want).await;
    save_spend_pending(state);
    out
}

/// Where this node's pending console approval is saved (step 3).
fn approvals_file(state: &NodeState) -> Option<PathBuf> {
    let (dir, node_id) = budget_dir(state).ok()?;
    Some(device::approvals_path(&dir, &node_id))
}

/// Save the pending request (or its absence) so an app restart resumes it.
fn save_spend_pending(state: &NodeState) {
    let Some(path) = approvals_file(state) else { return };
    let pending = state.spend.lock().unwrap().pending().cloned();
    if let Err(e) = device::save_pending(&path, pending.as_ref()) {
        eprintln!("[spend] could not save the pending approval: {e}");
    }
}

/// Once per run: pick up a request an earlier run was waiting on, if it has
/// not run out. The next poll asks the node where it stands.
fn restore_spend_pending(state: &NodeState) {
    if !matches!(&*state.auth.lock().unwrap(), AuthMode::Paired(_)) {
        return;
    }
    if state.approvals_restored.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(path) = approvals_file(state) else { return };
    let Some(saved) = device::load_pending(&path, now_ms()) else { return };
    let mut gate = state.spend.lock().unwrap();
    let view = gate.view(now_ms());
    if view.pending.is_none() && view.open_until_ms.is_none() {
        gate.set_pending(saved);
    }
}

async fn spend_advance_for_inner(state: &NodeState, want: Option<Want>) -> Result<act::SpendView, ActionError> {
    if want.is_some() && budget_paused(state)? {
        return Err(ActionError::new("budget_paused", "Payments are paused. Resume them first."));
    }
    // Taken before any await: whatever the node answers later opens nothing
    // if the owner paused or locked in the meantime.
    let fence = approval_fence(state);
    enum Mode {
        Local,
        Paired { spend: bool },
    }
    let mode = match &*state.auth.lock().unwrap() {
        AuthMode::Unauthenticated => {
            return Err(ActionError::new("app_not_ready", "Your node is not signed in yet."))
        }
        AuthMode::Local => Mode::Local,
        AuthMode::Paired(session) => Mode::Paired {
            spend: session.scopes.iter().any(|s| s == "spend"),
        },
    };
    // A token that already claims `spend` opens only over a live G1 grant; with
    // none left on the node, ask again as if it had no `spend`.
    let mut held: Option<NodeGrant> = None;
    let mode = match (mode, want) {
        (Mode::Paired { spend: true }, Some(_)) => match grant_for_open(state).await {
            Ok(g) => {
                held = g;
                Mode::Paired { spend: true }
            }
            Err(e) if e.code == "grant_ended" => Mode::Paired { spend: false },
            Err(e) => return Err(e),
        },
        (mode, _) => mode,
    };
    match mode {
        Mode::Local => {
            if let Some(want) = want { open_fenced(state, fence, want, act::SpendBasis::AppLock, None)?; }
        }
        Mode::Paired { spend: true } => {
            if let Some(want) = want { open_fenced(state, fence, want, act::SpendBasis::NodeGrant, held.as_ref())?; }
        }
        Mode::Paired { spend: false } => {
            let (generation, pending) = {
                let mut gate = state.spend.lock().unwrap();
                gate.view(now_ms());
                (gate.generation(), gate.pending().cloned())
            };
            let budget_generation = state.autopay.lock().unwrap().generation();
            if let Some(want) = want {
                let mut wants = state.wants.lock().unwrap();
                // A new request carries only this ask; a pending one gathers them.
                if pending.is_none() { *wants = Wants::default(); }
                match want {
                    Want::Window => wants.window = true,
                    Want::Budget(ceiling) => wants.budget = Some(ceiling),
                }
            }
            if let Some(pending) = pending {
                let path = act::elevation_status_path(&pending.op_id)?;
                let (status, body) = call_api(state, reqwest::Method::GET, &path, None).await?;
                if !status.is_success() {
                    return Err(ActionError::node(api_error("/pair/elevation", status, &body)));
                }
                let reply: act::ElevationStatusReply = decode_act("/pair/elevation", &body)?;
                if !state.spend.lock().unwrap().matches_poll(generation, &pending, now_ms()) {
                    return Ok(state.spend.lock().unwrap().view(now_ms()));
                }
                match reply.status.as_str() {
                    "granted" => {
                        // The grant reaches a token only on re-issue.
                        refresh_paired(state).await?;
                        let has_spend = matches!(
                            &*state.auth.lock().unwrap(),
                            AuthMode::Paired(s) if s.scopes.iter().any(|x| x == "spend")
                        );
                        // On a G1 node the grant's own terms bound what opens.
                        let node = if has_spend { Some(grant_for_open(state).await) } else { None };
                        let mut gate = state.spend.lock().unwrap();
                        if !gate.matches_poll(generation, &pending, now_ms()) {
                            return Ok(gate.view(now_ms()));
                        }
                        let wants = std::mem::take(&mut *state.wants.lock().unwrap());
                        let node = match node {
                            None => {
                                state.autopay.lock().unwrap().lock();
                                return Err(gate.refused());
                            }
                            Some(Err(e)) => {
                                gate.lock();
                                drop(gate);
                                drop_grant(state);
                                return Err(e);
                            }
                            Some(Ok(node)) => node,
                        };
                        // Pause all or a budget lock during the poll: the grant
                        // opens nothing (the window's own generation is checked
                        // above; pause writes the book after bumping both).
                        let mut autopay = state.autopay.lock().unwrap();
                        if autopay.generation() != budget_generation || budget_paused(state)? {
                            gate.lock();
                            autopay.lock();
                            return Err(fence_broken());
                        }
                        // Open only what the owner asked for with this request.
                        if !wants.window { gate.clear_pending(); }
                        if wants.window { arm_want(&mut gate, &mut autopay, Want::Window, act::SpendBasis::NodeGrant, node.as_ref()); }
                        if let Some(ceiling) = wants.budget {
                            arm_want(&mut gate, &mut autopay, Want::Budget(ceiling), act::SpendBasis::NodeGrant, node.as_ref());
                        }
                        *state.node_grant.lock().unwrap() = node.clone();
                    }
                    // Over without a grant: expired, or lost to a node restart
                    // (the node's owner code lived in memory). Never wait out a
                    // request nothing can approve; the owner asks again.
                    status => if let Some(lapse) = act::Lapse::from_status(status) {
                        let mut gate = state.spend.lock().unwrap();
                        if gate.matches_poll(generation, &pending, now_ms()) {
                            gate.pending_expired(lapse);
                            *state.wants.lock().unwrap() = Wants::default();
                        }
                    },
                }
            } else if let Some(want) = want {
                let mut ask = serde_json::json!({ "scopes": ["spend"] });
                // A G1 node shows the owner a budget to approve; the owner's
                // flags override it. Older nodes get the pre-G1 body.
                if node_has_g1(state).await.unwrap_or(false) {
                    if let Some(budget) = budget_proposal(state, want) {
                        ask["budget"] = budget;
                    }
                }
                let (status, body) = call_api(state, reqwest::Method::POST, "/pair/elevation-request", Some(ask)).await?;
                if !status.is_success() {
                    return Err(ActionError::node(api_error("/pair/elevation-request", status, &body)));
                }
                let reply: act::ElevationReply = decode_act("/pair/elevation-request", &body)?;
                let pending = reply.into_elevation(owner_config(state).as_deref())?;
                let mut gate = state.spend.lock().unwrap();
                if gate.generation() == generation && pending.expires_at_ms > now_ms() {
                    gate.set_pending(pending);
                }
            }
        }
    }
    Ok(state.spend.lock().unwrap().view(now_ms()))
}

/// Read only the policy and backend from the SAME config passed to node start.
/// Missing routing_fees/fields have the node's serde defaults; unreadable or
/// malformed config is not evidence of a default policy. Never expose config
/// parse errors (the rest of this file can contain credentials).
fn configured_routing_policy(path: &Path) -> Option<(String, act::RoutingFeePolicy)> {
    #[derive(Deserialize)]
    struct Config {
        lightning: Backend,
        #[serde(default)]
        routing_fees: act::RoutingFeePolicy,
    }
    #[derive(Deserialize)]
    struct Backend { backend: String }
    let text = std::fs::read_to_string(path).ok()?;
    let config: Config = toml::from_str(&text).ok()?;
    Some((config.lightning.backend, config.routing_fees))
}

/// The LDK `network` from the SAME config passed to node start, or none for
/// another backend or an unreadable config. Same rules as the policy read.
fn configured_network(path: &Path) -> Option<String> {
    #[derive(Deserialize)]
    struct Config { lightning: Backend }
    #[derive(Deserialize)]
    struct Backend {
        backend: String,
        // The node's own serde default for LDK.
        #[serde(default = "mainnet")]
        network: String,
    }
    fn mainnet() -> String { "bitcoin".into() }
    let text = std::fs::read_to_string(path).ok()?;
    let config: Config = toml::from_str(&text).ok()?;
    if config.lightning.backend != "ldk" {
        return None;
    }
    control::ldk_network_name(&config.lightning.network).map(str::to_owned)
}

async fn read_room_routing_policy(state: &NodeState) -> Result<act::RoutingFeePolicy, String> {
    let status: serde_json::Value = get_json(state, "/status").await?;
    if state.sidecar_terminated.load(Ordering::SeqCst) {
        return Err("The supervised node stopped. Restart it before quoting a room.".into());
    }
    let backend = status["lightning_backend"].as_str().unwrap_or_default();
    // dac01c8 has no ordinary member fee quote API. Mock providers explicitly
    // use the trait default; LND/LDK load routing_fees from their startup config.
    match backend {
        "mock" | "shared_mock" => Ok(act::RoutingFeePolicy::default()),
        "lnd" | "ldk" => state.room_routing_policy.lock().unwrap().as_ref()
            .filter(|(configured, _)| configured == backend)
            .map(|(_, policy)| *policy)
            .ok_or_else(|| "The node's routing fee policy is unavailable. Restart the supervised node before quoting a room.".into()),
        _ => Err("The node has not reported a supported routing fee policy. Refresh after upgrading the node.".into()),
    }
}

async fn read_room_quote(state: &NodeState, room_id: &str) -> Result<act::RoomQuote, String> {
    let room = control::room_id(room_id)?;
    let own_id = state.node_id.lock().unwrap().clone().unwrap_or_default();
    let own_id = if own_id.is_empty() { fetch_node_id(state).await? } else { own_id };
    let members = read_room_members(state, &room).await?;
    let peers: Vec<control::Peer> = get_json(state, "/peers").await?;
    let own: control::KindPrice = get_json(state, &control::price_path(control::KIND_CHAT)).await?;
    let tables: Vec<control::PeerPrice> = get_json(state, "/pricing/peers").await?;
    let policy = read_room_routing_policy(state).await?;
    act::room_quote(&room, &own_id, own.price_msat, &members, &peers, &tables, policy)
        .map_err(|e| e.message)
}

/// Only an explicit versioned node contract authorizes variable-price sends.
/// What a paid send may rely on at this node.
struct SendCaps {
    /// Admission may be paid separately from a message cap.
    readmission_possible: bool,
    /// Durable, idempotent 1:1 message operations.
    operations: bool,
    /// A capped 1:1 chat may pay a reconnect's re-admission under the
    /// contact's fresh signed quote (genome #111 revived).
    quoted_readmission: bool,
}

async fn require_price_caps(state: &NodeState, room: bool) -> Result<SendCaps, ActionError> {
    let unavailable = || ActionError::new("price_cap_unavailable", "This node cannot enforce your confirmed spending ceiling. Upgrade the node before sending messages or files.");
    let status: serde_json::Value = get_json(state, "/status").await.map_err(|_| unavailable())?;
    let capabilities = status["api_capabilities"].as_array().ok_or_else(unavailable)?;
    let has = |cap: &str| capabilities.iter().any(|v| v.as_str() == Some(cap));
    if !has("paid_send_caps_v1") || (room && !has("room_terminal_outcomes_v1")) {
        return Err(unavailable());
    }
    Ok(SendCaps {
        readmission_possible: has(grant::FIRST_CONTACT_CAPABILITY),
        operations: has(OPERATIONS_CAPABILITY),
        quoted_readmission: has(act::QUOTED_READMISSION_CAPABILITY),
    })
}

/// Genome #113: `operation_id` on 1:1 compose, idempotent POST, `GET /messages/operations/{id}`.
const OPERATIONS_CAPABILITY: &str = "message_operations_v1";

/// Slice B's call shape: no first-contact confirmation. Tests only.
#[cfg_attr(not(test), allow(dead_code))]
async fn do_message_send(
    state: &NodeState,
    recipient: &str,
    is_room: bool,
    plaintext: &str,
    max_msat: u64,
    max_recipient_msat: Option<std::collections::HashMap<String, u64>>,
) -> Result<act::SendReceipt, ActionError> {
    do_message_send_with(state, recipient, is_room, plaintext, max_msat, max_recipient_msat, None).await
}

/// A message pays inside the owner's budget without a prompt, or under the
/// ten-minute window. `first_contact_msat` is the owner's one-time OK for a
/// contact or room not yet in the book, with the budget they chose for it.
async fn do_message_send_with(
    state: &NodeState,
    recipient: &str,
    is_room: bool,
    plaintext: &str,
    max_msat: u64,
    max_recipient_msat: Option<std::collections::HashMap<String, u64>>,
    first_contact_msat: Option<u64>,
) -> Result<act::SendReceipt, ActionError> {
    let target = if is_room { control::room_id(recipient) } else { control::node_id(recipient) }.map_err(ActionError::invalid)?;
    let (auth, plan) = plan_message(state, &target, is_room, max_msat, first_contact_msat)?;
    no_pending_spend(state)?;
    let caps = require_price_caps(state, is_room).await?;
    let readmission_possible = caps.readmission_possible;
    let mut body = act::compose_body(recipient, is_room, plaintext)?;
    body["max_total_msat"] = serde_json::json!(max_msat);
    if is_room {
        let caps = max_recipient_msat.as_ref().ok_or_else(|| ActionError::new("price_changed", "Refresh the room quote before sending."))?;
        body["max_recipient_msat"] = serde_json::json!(caps);
    }
    let node_ok = if is_room { None } else { plan.confirm.or(first_contact_msat) };
    let price = if is_room {
        let quote = read_room_quote(state, recipient).await?;
        act::room_sendable(&quote)?;
        let caps = max_recipient_msat.as_ref().expect("room caps checked above");
        if caps.len() != quote.members.len() || quote.members.iter().any(|member|
            caps.get(&member.node_id).is_none_or(|cap| member.msat > *cap)) {
            return Err(ActionError::new("price_changed", "The room all-in price changed. Review the new quote before sending."));
        }
        // Genome takes min(policy, caller) per member, then checks each all-in
        // amount against its recipient cap BEFORE paying. The largest fee lets
        // each member use its displayed policy allowance; caps remain unchanged.
        let caller_fee = quote.members.iter().map(|m| m.max_routing_fee_msat).max().unwrap_or(0);
        body["max_routing_fee_msat"] = serde_json::json!(caller_fee);
        quote.total_msat
    } else if node_ok.is_some() {
        // The owner confirms the fresh node quote, including its configured
        // fees. A stale table or our ordinary fee estimate cannot replace it.
        max_msat
    } else {
        let quote = read_price_quote(state, Some(recipient)).await?;
        (if quote.peer_stale { quote.own_msat } else { quote.peer_msat.unwrap_or(quote.own_msat) })
            .max(act::MIN_PAYMENT_MSAT).checked_add(quote.max_routing_fee_msat)
            .ok_or_else(|| ActionError::invalid("The all-in quote overflows."))?
    };
    ceiling(price, max_msat)?;
    let recipient = body["recipient"].as_str().unwrap_or_default().to_string();
    // A confirmed first paid message to a contact: the node backs that one OK
    // with a single-use grant for exactly this contact and this cap. The same
    // OK re-admits a known contact the node's grant does not budget yet.
    if node_ok.is_none() && !is_room {
        let quote = read_price_quote(state, Some(&recipient)).await?;
        body["max_routing_fee_msat"] = serde_json::json!(quote.max_routing_fee_msat);
    }
    if let Some(contact_budget) = node_ok {
        confirm_first_contact(state, &recipient, max_msat, contact_budget).await?;
    }
    let quoted_readmission = !is_room && node_ok.is_none() && caps.quoted_readmission;
    // The owner approved the contact's re-admission quote (`readmission_quoted`):
    // that send carries its routing ceilings for both payments, under its total.
    if quoted_readmission {
        if let Some(ask) = take_readmission_ask(state, &recipient, max_msat) {
            body["max_routing_fee_msat"] = serde_json::json!(ask.max_routing_fee_msat);
        }
    }
    let charge = Charge { target: target.clone(), room: is_room, confirm: plan.confirm, readmission_possible, confirmed: node_ok.is_some(), operation: caps.operations && !is_room };
    let sent = money_post(state, auth, "/messages/compose", body.clone(), max_msat, Some(charge)).await;
    let sent = match sent {
        // After a reconnect or restart the contact asks for admission again,
        // and the node kept its signed quote for this connection.
        Err(e) if e.code == "readmission_capped" && quoted_readmission => {
            readmit_under_quote(state, &target, body, max_msat, readmission_possible, caps.operations, e).await
        }
        other => other,
    };
    let text = match sent {
        // After a reconnect the contact asks for admission again. The node pays
        // it from the budget only for a contact its grant budgets; this one it
        // does not, so the owner confirms once, on the door card.
        Err(e) if e.code == "grant_first_contact" && node_ok.is_none() => {
            return Err(readmission_needs_ok());
        }
        other => other?,
    };
    let reply: act::SendReply = decode_act("/messages/compose", &text)?;
    let total_msat = reply.total_msat()?;
    Ok(act::SendReceipt {
        total_msat,
        message_id: reply.message_id,
        recipient,
        is_room,
        delivered: reply.delivered,
        amount_msat: reply.amount_msat,
        max_routing_fee_msat: reply.max_routing_fee_msat,
        sent_at_ms: now_ms(),
        operation_id: reply.operation_id,
        state: reply.state,
        accepted: reply.accepted,
        readmission_msat: reply.readmission_msat.filter(|m| *m > 0),
    })
}

/// Genome `quoted_readmission_v1`: the contact asked for admission again and
/// the node refused this send's cap before paying anything, keeping the
/// contact's fresh signed quote for this connection. The quote's total
/// (admission once, this message, both routing ceilings) is the new all-in
/// price. Inside the contact's existing budget the app sends again under it,
/// with the same operation id, without a prompt; otherwise the owner is asked
/// once (`readmission_quoted`). Anything unexpected keeps the refusal.
async fn readmit_under_quote(
    state: &NodeState,
    target: &str,
    mut body: serde_json::Value,
    max_msat: u64,
    readmission_possible: bool,
    operations: bool,
    refused: ActionError,
) -> Result<String, ActionError> {
    let recipient = body["recipient"].as_str().unwrap_or_default().to_string();
    let Ok(quote) = read_first_contact_quote(state, &recipient).await else { return Err(refused) };
    // A cap that already covered this quote was refused: never loop.
    if quote.total_msat <= max_msat { return Err(refused); }
    let view = act::AdmissionView {
        admission_msat: quote.admission_msat,
        message_msat: quote.message_msat,
        max_routing_fee_msat: quote.max_routing_fee_msat,
        total_msat: quote.total_msat,
        quoted: true,
    };
    let within_budget = match plan_message(state, target, false, quote.total_msat, None) {
        Ok((auth @ Auth::Budget(_), plan)) if plan.confirm.is_none() => Some(auth),
        _ => None,
    };
    let Some(auth) = within_budget else {
        remember_readmission_ask(state, &recipient, &quote);
        return Err(ActionError::readmission_quoted(view));
    };
    body["max_total_msat"] = serde_json::json!(quote.total_msat);
    body["max_routing_fee_msat"] = serde_json::json!(quote.max_routing_fee_msat);
    let charge = Charge { target: target.to_string(), room: false, confirm: None, readmission_possible, confirmed: false, operation: operations };
    money_post(state, auth, "/messages/compose", body, quote.total_msat, Some(charge)).await
}

fn remember_readmission_ask(state: &NodeState, peer: &str, quote: &control::FirstContactQuote) {
    let Some(node_id) = state.node_id.lock().unwrap().clone() else { return };
    *state.readmission_ask.lock().unwrap() = Some(ReadmissionAsk {
        node_id,
        peer: peer.to_string(),
        total_msat: quote.total_msat,
        max_routing_fee_msat: quote.max_routing_fee_msat,
        expires_at_ms: quote.expires_at.saturating_mul(1000),
    });
}

/// The re-admission quote the owner was shown for `peer`, if this send is for
/// exactly its total and it has not expired. Single use.
fn take_readmission_ask(state: &NodeState, peer: &str, max_msat: u64) -> Option<ReadmissionAsk> {
    let node_id = state.node_id.lock().unwrap().clone()?;
    let mut ask = state.readmission_ask.lock().unwrap();
    let matches = ask.as_ref().is_some_and(|a| a.node_id == node_id && a.peer == peer && a.total_msat == max_msat && a.expires_at_ms > now_ms());
    if matches { ask.take() } else { None }
}

fn readmission_needs_ok() -> ActionError {
    ActionError::new(
        "grant_readmission",
        "This contact reconnected and asks to be admitted again. Your node's budget does not cover them yet, so it needs your OK once. Nothing was sent.",
    )
}

/// Retry delivery of a paid, undelivered message: the same operation (this
/// message, this contact), through the journal record it left, never a fresh
/// unjournaled compose.
///
/// - `approved_msat: None` (Retry delivery) never pays anything new. It is a
///   compose with `max_total_msat: 0`: the node checks every payment against
///   that cap before dispatch (the message, a fresh admission, a re-admission),
///   so it can only re-send the proof already paid for. Genome #100: on the
///   connection that holds the proof, or with a proof that never went out, the
///   node re-delivers it; a proof consumed on an earlier connection needs a new
///   admission, which the zero cap refuses. Whatever is still due, the owner
///   gets `retry_needs_admission` with the all-in price and approves it.
/// - `approved_msat: Some(total)`: the owner approved that all-in price under
///   the normal approval, as for any send; the node pays at most that.
async fn do_message_retry(state: &NodeState, recipient: &str, plaintext: &str, approved_msat: Option<u64>) -> Result<act::SendReceipt, ActionError> {
    let target = control::node_id(recipient).map_err(ActionError::invalid)?;
    let mut body = act::compose_body(recipient, false, plaintext)?;
    let op = spend_journal::operation(&body);
    let unavailable = || ActionError::new("retry_unavailable", "There is no paid, undelivered message to retry for this contact. Check the pending result; do not send the message again.");
    let undelivered = spend_journal(state)?.pending()?
        .filter(|p| !p.over_budget)
        .and_then(|p| p.undelivered)
        .filter(|u| u.retry && !u.in_flight && u.peer == target && u.op == op)
        .ok_or_else(unavailable)?;
    let caps = require_price_caps(state, false).await?;
    let readmission_possible = caps.readmission_possible;
    // Zero for Retry delivery: the node refuses any payment before dispatch.
    let cap = approved_msat.unwrap_or(0);
    let (auth, plan) = plan_message(state, &target, false, cap, None)?;
    // A contact not yet in the book needs a first-contact budget: the composer's door card.
    if plan.confirm.is_some() { return Err(unavailable()); }
    body["max_total_msat"] = serde_json::json!(cap);
    if approved_msat.is_some() {
        // A paired first-contact authorization is single-use, including when
        // the previous paid send failed. Renew it for this exact peer and cap.
        let contact_budget = retry_contact_budget(state, &target, cap).await?;
        confirm_first_contact(state, &target, cap, contact_budget).await?;
    }
    // Nothing can be paid under a zero cap, re-admission included.
    let charge = Charge { target: target.clone(), room: false, confirm: None, readmission_possible: readmission_possible && approved_msat.is_some(), confirmed: approved_msat.is_some(), operation: caps.operations };
    let text = match money_post_with(state, auth, "/messages/compose", body, cap, Some(charge), Some(&undelivered)).await {
        // The node pays re-admission under a cap that fits the contact's signed
        // quote: Retry delivery (zero cap) asks the owner for that price.
        Err(e) if e.code == "readmission_capped" && caps.quoted_readmission && approved_msat.is_none() => {
            return Err(needs_admission(state, &target, &undelivered).await);
        }
        // Asking the owner to approve a price cannot help: any cap refuses it.
        Err(e) if e.code == "readmission_capped" => {
            return Err(ActionError::new("readmission_capped", act::READMISSION_CAPPED_RETRY));
        }
        // Refused before paying anything: a payment is still due.
        Err(e) if approved_msat.is_none() && matches!(e.code, "price_cap_exceeded" | "grant_first_contact" | "grant_readmission") => {
            return Err(needs_admission(state, &target, &undelivered).await);
        }
        Err(e) if e.code == "price_cap_exceeded" => {
            return Err(ActionError::new("price_cap_exceeded", "Your node refused before paying: delivering it now costs more than the price you approved, or needs an admission the node pays only on a new send. Nothing was paid. Retry delivery for the current price, or stop retrying."));
        }
        other => other?,
    };
    let reply: act::SendReply = decode_act("/messages/compose", &text)?;
    let total_msat = reply.total_msat()?;
    Ok(act::SendReceipt {
        total_msat,
        max_routing_fee_msat: reply.max_routing_fee_msat,
        message_id: reply.message_id,
        recipient: undelivered.peer,
        is_room: false,
        delivered: reply.delivered,
        amount_msat: reply.amount_msat,
        sent_at_ms: now_ms(),
        operation_id: reply.operation_id,
        state: reply.state,
        accepted: reply.accepted,
        readmission_msat: reply.readmission_msat.filter(|m| *m > 0),
    })
}

/// `retry_needs_admission`, with the contact's own signed quote when the node
/// can give one (it pays and reserves nothing), else an estimate from the
/// admission paid before and the contact's current message price.
async fn needs_admission(state: &NodeState, target: &str, undelivered: &spend_journal::Undelivered) -> ActionError {
    if let Ok(q) = read_first_contact_quote(state, target).await {
        return ActionError::needs_admission(Some(act::AdmissionView {
            admission_msat: q.admission_msat, message_msat: q.message_msat, max_routing_fee_msat: q.max_routing_fee_msat, total_msat: q.total_msat, quoted: true,
        }));
    }
    let message_msat = read_price_quote(state, Some(target)).await.ok()
        .and_then(|q| q.peer_msat.filter(|_| !q.peer_stale))
        .map(|p| p.max(act::MIN_PAYMENT_MSAT));
    let view = message_msat.and_then(|m| {
        let max_routing_fee_msat = act::routing_fee(undelivered.admission_msat).checked_add(act::routing_fee(m))?;
        Some(act::AdmissionView {
            admission_msat: undelivered.admission_msat,
            message_msat: m,
            max_routing_fee_msat,
            total_msat: undelivered.admission_msat.checked_add(m)?.checked_add(max_routing_fee_msat)?,
            quoted: false,
        })
    }).filter(|v| v.admission_msat > 0);
    ActionError::needs_admission(view)
}

async fn do_invoice_create(
    state: &NodeState,
    amount_msat: u64,
    note: &str,
    expiry_secs: u32,
) -> Result<act::InvoiceView, ActionError> {
    let body = act::invoice_body(amount_msat, note, expiry_secs)?;
    let expiry = body["expiry_secs"].as_u64().unwrap_or(3600);
    let (status, text) = call_api(state, reqwest::Method::POST, "/payments/invoice", Some(body)).await?;
    if !status.is_success() {
        return Err(ActionError::node(api_error("/payments/invoice", status, &text)));
    }
    let reply: act::InvoiceReply = decode_act("/payments/invoice", &text)?;
    let note = note.trim();
    Ok(act::InvoiceView {
        bolt11: reply.bolt11,
        amount_msat,
        note: (!note.is_empty()).then(|| note.to_string()),
        expires_at_ms: now_ms() + expiry * 1000,
    })
}

async fn do_payment_pay(state: &NodeState, bolt11: &str, amount_msat: u64, max_msat: u64) -> Result<act::PaymentReceipt, ActionError> {
    let generation = approval_generation(state)?;
    no_pending_spend(state)?;
    let mut body = act::pay_body(bolt11, amount_msat)?;
    let quote = act::payment_quote(amount_msat)?;
    ceiling(quote.total_msat, max_msat)?;
    body["max_routing_fee_msat"] = serde_json::json!(quote.max_routing_fee_msat);
    let charge = plan_manual_charge(state, budget::INVOICE_PAYMENTS, max_msat)?;
    let text = money_post(state, Auth::Window(generation), "/payments/pay", body, max_msat, Some(charge)).await?;
    Ok(decode_act::<act::PayReply>("/payments/pay", &text)?.receipt(now_ms()))
}

async fn do_payment_keysend(
    state: &NodeState,
    dest_pubkey: &str,
    amount_msat: u64,
    memo: Option<&str>,
    max_msat: u64,
) -> Result<act::PaymentReceipt, ActionError> {
    let generation = approval_generation(state)?;
    no_pending_spend(state)?;
    let mut body = act::keysend_body(dest_pubkey, amount_msat, memo)?;
    let quote = act::payment_quote(amount_msat)?;
    ceiling(quote.total_msat, max_msat)?;
    body["max_routing_fee_msat"] = serde_json::json!(quote.max_routing_fee_msat);
    let charge = plan_manual_charge(state, budget::KEYSEND_PAYMENTS, max_msat)?;
    let text = money_post(state, Auth::Window(generation), "/payments/keysend", body, max_msat, Some(charge)).await?;
    Ok(decode_act::<act::KeysendReply>("/payments/keysend", &text)?.receipt(now_ms()))
}

async fn do_invite_create(state: &NodeState, invitee: &str, addr: &str, hours: u64) -> Result<act::InviteView, ActionError> {
    state.spend.lock().unwrap().check(now_ms())?;
    let now = now_ms();
    let body = act::invite_body(invitee, addr, hours, now / 1000)?;
    let invitee = body["invitee_pubkey"].as_str().unwrap_or_default().to_string();
    let expires_at_ms = body["expiry_unix"].as_u64().unwrap_or(0) * 1000;
    let text = gated_post(state, "/invites", body).await?;
    let reply: act::InviteReply = decode_act("/invites", &text)?;
    Ok(act::InviteView {
        invite_id: reply.invite_id,
        invite_link: reply.invite_link,
        invitee,
        expires_at_ms,
    })
}

async fn do_invite_redeem(state: &NodeState, invite: &str) -> Result<act::RedeemView, ActionError> {
    state.spend.lock().unwrap().check(now_ms())?;
    let token = act::invite_token(invite)?;
    let text = gated_post(state, "/invites/accept", serde_json::json!({ "token": token })).await?;
    decode_act("/invites/accept", &text)
}

/// A received voice note's bytes, for the inline player. Read-only: two GETs,
/// never a payment. Anything that is not an audio file is refused.
async fn do_voice_note_fetch(state: &NodeState, message_id: &str) -> Result<act::FileBlob, String> {
    let message_id = control::node_id(message_id).map_err(|_| "expected a 64-character hex message id".to_string())?;
    let mut found = None;
    for limit in act::FILE_LIST_WINDOWS {
        let rows: Vec<act::FileRow> = get_json(state, &format!("/files?limit={limit}")).await?;
        match act::voice_file_for(&rows, &message_id) {
            act::VoiceLookup::Voice(row) => { found = Some(row.id.clone()); break; }
            act::VoiceLookup::NotVoice => return Err(act::NOT_A_VOICE_NOTE.into()),
            // A short page is the whole list: no wider window can hold it.
            act::VoiceLookup::Missing if rows.len() < limit => break,
            act::VoiceLookup::Missing => {}
        }
    }
    let row = found.ok_or_else(|| act::VOICE_NOT_STORED.to_string())?;
    let id = control::room_id(&row).map_err(|_| "the node returned an unexpected file id".to_string())?;
    let blob: act::FileBlob = get_json(state, &format!("/files/{id}")).await?;
    if !act::is_voice_mime(&blob.mime_type) {
        return Err(act::NOT_A_VOICE_NOTE.into());
    }
    Ok(blob)
}

/// Any received kind-200 file by message id. Read-only: list + GET /files/:id,
/// never a payment. Over the app size cap → refused (nothing written).
async fn do_file_fetch(state: &NodeState, message_id: &str) -> Result<act::FileBlob, String> {
    let message_id = control::node_id(message_id).map_err(|_| "expected a 64-character hex message id".to_string())?;
    let mut found = None;
    for limit in act::FILE_LIST_WINDOWS {
        let rows: Vec<act::FileRow> = get_json(state, &format!("/files?limit={limit}")).await?;
        match act::stored_file_for(&rows, &message_id) {
            act::StoredLookup::Found(row) => { found = Some(row.id.clone()); break; }
            act::StoredLookup::Missing if rows.len() < limit => break,
            act::StoredLookup::Missing => {}
        }
    }
    let row = found.ok_or_else(|| act::FILE_NOT_STORED.to_string())?;
    let id = control::room_id(&row).map_err(|_| "the node returned an unexpected file id".to_string())?;
    let blob: act::FileBlob = get_json(state, &format!("/files/{id}")).await?;
    act::blob_within_cap(&blob)?;
    Ok(blob)
}

/// One native save dialog at a time (N6): a second Save click while the first
/// dialog is open gets a clear error instead of stacking dialogs.
static FILE_SAVE_DIALOG: Mutex<()> = Mutex::new(());

/// Fetch then write only where the owner picks in the native save dialog.
/// Cancel → `saved: false`. Never auto-saves or opens the file.
async fn do_file_save(state: &NodeState, message_id: &str) -> Result<act::FileSaveResult, String> {
    let blob = do_file_fetch(state, message_id).await?;
    let _guard = FILE_SAVE_DIALOG
        .try_lock()
        .map_err(|_| "save already in progress".to_string())?;
    let name = act::safe_save_name(&blob.filename);
    // Release builds: always the native dialog (`dev_node::save_dir` is `Ok(None)`).
    let path = match dev_node::save_dir()? {
        Some(dir) => {
            let path = dir.join(&name);
            if path.exists() {
                return Err(format!("{} already exists; the test save dir never overwrites", path.display()));
            }
            Some(path)
        }
        None => rfd::FileDialog::new().set_file_name(&name).save_file(),
    };
    let Some(path) = path else {
        return Ok(act::FileSaveResult {
            saved: false,
            filename: blob.filename,
            mime_type: blob.mime_type,
            size_bytes: blob.size_bytes,
        });
    };
    act::write_file_bytes(&path, &blob.data_b64)?;
    Ok(act::FileSaveResult {
        saved: true,
        filename: blob.filename,
        mime_type: blob.mime_type,
        size_bytes: blob.size_bytes,
    })
}

async fn read_call_quote(state: &NodeState, peer: &str) -> Result<control::CallQuote, String> {
    let peer = control::node_id(peer)?;
    let own: control::KindPrice = get_json(state, &control::price_path(act::KIND_CALL_OFFER + 1)).await?;
    // Genome asks the callee now; a refusal or an older node means no offer price.
    let live: Option<control::PeerCallPrice> = get_json(state, &format!("/pricing/peers/{peer}/call")).await.ok();
    Ok(control::call_quote(live.as_ref(), own.price_msat))
}

/// One paid call signal (offer, answer, ICE or hangup) to one contact.
/// Same authority as a 1:1 message: the owner's budget or the ten-minute
/// window, one journaled spend at a time, a durable operation id when the
/// node keeps them. Calls go to contacts already in the book: a first
/// contact is a message, never a ring.
async fn do_call_signal(
    state: &NodeState,
    peer: &str,
    kind: u16,
    plaintext: &str,
    max_msat: u64,
) -> Result<act::CallReceipt, ActionError> {
    let target = control::node_id(peer).map_err(ActionError::invalid)?;
    let mut body = act::call_body(&target, kind, plaintext)?;
    let needs_contact = || ActionError::new("call_needs_contact", "Calls go to contacts you have already paid. Send them a message first. Nothing was paid.");
    let (auth, plan) = plan_message(state, &target, false, max_msat, None)
        .map_err(|e| if e.code == "first_contact" { needs_contact() } else { e })?;
    if plan.confirm.is_some() {
        return Err(needs_contact());
    }
    no_pending_spend(state)?;
    let caps = require_price_caps(state, false).await?;
    let quote = read_call_quote(state, &target).await.map_err(ActionError::node)?;
    let (principal, fee) = if kind == act::KIND_CALL_OFFER {
        let offer = quote.offer_msat.ok_or_else(|| ActionError::new(
            "call_unsupported", "Their node does not take calls yet (no call price advertised). Nothing was paid."))?;
        (offer, quote.offer_max_routing_fee_msat)
    } else {
        (quote.signal_msat, quote.signal_max_routing_fee_msat)
    };
    ceiling(principal + fee, max_msat)?;
    body["max_total_msat"] = serde_json::json!(max_msat);
    body["max_routing_fee_msat"] = serde_json::json!(fee);
    let charge = Charge {
        target: target.clone(),
        room: false,
        confirm: None,
        readmission_possible: caps.readmission_possible,
        confirmed: false,
        operation: caps.operations,
    };
    let text = money_post(state, auth, "/messages/compose", body, max_msat, Some(charge)).await?;
    let reply: act::SendReply = decode_act("/messages/compose", &text)?;
    Ok(act::CallReceipt {
        total_msat: reply.total_msat()?,
        message_id: reply.message_id,
        kind,
        amount_msat: reply.amount_msat,
        max_routing_fee_msat: reply.max_routing_fee_msat,
        delivered: reply.delivered,
        accepted: reply.accepted,
        sent_at_ms: now_ms(),
    })
}

async fn do_file_send(
    state: &NodeState,
    recipient: &str,
    filename: &str,
    mime_type: &str,
    data_b64: &str,
    max_msat: u64,
    first_contact_msat: Option<u64>,
) -> Result<act::FileReceipt, ActionError> {
    let recipient = control::node_id(recipient).map_err(ActionError::invalid)?;
    // Same budget / ten-minute window rules as a 1:1 message. Genome's file
    // send has no `operation_id` field (`deny_unknown_fields`), so we keep
    // `operation: false`; the spend journal still fences concurrent money posts.
    let (auth, plan) = plan_message(state, &recipient, false, max_msat, first_contact_msat)?;
    no_pending_spend(state)?;
    let caps = require_price_caps(state, false).await?;
    let body = act::file_upload_body(filename, mime_type, data_b64)?;
    let filename = body["filename"].as_str().unwrap_or_default().to_string();
    let quote: control::KindPrice = get_json(state, &control::price_path(act::KIND_FILE_REF)).await?;
    ceiling(act::payment_quote(quote.price_msat.max(act::MIN_PAYMENT_MSAT))?.total_msat, max_msat)?;
    let text = gated_post_auth(state, auth, "/files", body).await?;
    let upload: act::UploadReply = decode_act("/files", &text)?;
    let path = act::file_send_path(&upload.file_id)?;
    // Upload can take time; quote again immediately before the money request.
    let quote: control::KindPrice = get_json(state, &control::price_path(act::KIND_FILE_REF)).await?;
    let principal = quote.price_msat.max(act::MIN_PAYMENT_MSAT);
    ceiling(act::payment_quote(principal)?.total_msat, max_msat)?;
    let node_ok = plan.confirm.or(first_contact_msat);
    if let Some(contact_budget) = node_ok {
        confirm_first_contact(state, &recipient, max_msat, contact_budget).await?;
    }
    let charge = Charge {
        target: recipient.clone(),
        room: false,
        confirm: plan.confirm,
        readmission_possible: caps.readmission_possible,
        confirmed: node_ok.is_some(),
        operation: false,
    };
    let text = money_post(
        state,
        auth,
        &path,
        serde_json::json!({
            "recipient": recipient,
            "max_total_msat": max_msat,
            "max_routing_fee_msat": act::routing_fee(principal),
        }),
        max_msat,
        Some(charge),
    )
    .await?;
    let reply: act::SendReply = decode_act("/files/send", &text)?;
    let total_msat = reply.total_msat()?;
    Ok(act::FileReceipt {
        total_msat,
        message_id: reply.message_id,
        recipient,
        filename,
        size_bytes: upload.size_bytes,
        delivered: reply.delivered,
        amount_msat: reply.amount_msat,
        max_routing_fee_msat: reply.max_routing_fee_msat,
        sent_at_ms: now_ms(),
        operation_id: reply.operation_id,
        state: reply.state,
        accepted: reply.accepted,
    })
}

/// The owner's spend window as it stands; polls a pending elevation request.
#[tauri::command(rename_all = "snake_case")]
async fn spend_status(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<act::SpendView, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    spend_advance(state.inner(), false).await
}

/// The owner's one tap: open a short spend window, or ask the node for spend.
#[tauri::command(rename_all = "snake_case")]
async fn spend_request(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<act::SpendView, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    spend_advance(state.inner(), true).await
}

/// Close the spend window now.
#[tauri::command(rename_all = "snake_case")]
async fn spend_lock(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<act::SpendView, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    let view = {
        let mut gate = state.spend.lock().unwrap();
        gate.lock();
        // The lock also ends a pending request, and with it anything it would have opened.
        *state.wants.lock().unwrap() = Wants::default();
        gate.view(now_ms())
    };
    save_spend_pending(state.inner());
    Ok(view)
}

/// Withdraw the pending request at the node, then forget it here.
#[tauri::command(rename_all = "snake_case")]
async fn spend_cancel(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<act::SpendView, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_spend_cancel(state.inner()).await
}

async fn do_spend_cancel(state: &NodeState) -> Result<act::SpendView, ActionError> {
    let pending = state.spend.lock().unwrap().pending().cloned();
    if let Some(p) = pending {
        // Best effort: an unknown or already-answered request is fine to forget.
        if let Ok(path) = act::elevation_status_path(&p.op_id) {
            let _ = call_api(state, reqwest::Method::DELETE, &path, None).await;
        }
    }
    let view = {
        let mut gate = state.spend.lock().unwrap();
        gate.lock();
        *state.wants.lock().unwrap() = Wants::default();
        gate.view(now_ms())
    };
    save_spend_pending(state);
    Ok(view)
}

// ---- this Mac as a paired device (relation ladder steps 1–2) -------------------

fn device_store(state: &NodeState) -> Result<PathBuf, ActionError> {
    state
        .pairing
        .lock()
        .unwrap()
        .as_ref()
        .map(|ctx| ctx.store.clone())
        .ok_or_else(|| ActionError::new("app_not_ready", "This app is not paired with a node."))
}

fn device_error(e: device_key::DeviceKeyError) -> ActionError {
    match e {
        device_key::DeviceKeyError::Cancelled => ActionError::new("device_cancelled", "Touch ID was cancelled. Nothing was approved."),
        device_key::DeviceKeyError::Unavailable => ActionError::new("device_unavailable", "This Mac has no Secure Enclave the app can use. Approve at the node instead."),
        device_key::DeviceKeyError::Invalid => ActionError::new("device_invalid", "This Mac's approval key no longer works (for example, the enrolled fingerprints changed). Set up Touch ID approvals again."),
        device_key::DeviceKeyError::Other(code) => ActionError::new("device_key", format!("The Secure Enclave refused ({code}). Nothing was approved.")),
    }
}

/// Sign with the enclave off the async runtime: a Touch ID prompt blocks.
async fn device_sign(blob: Vec<u8>, message: String, reason: String) -> Result<String, ActionError> {
    tokio::task::spawn_blocking(move || device_key::sign(&blob, message.as_bytes(), &reason))
        .await
        .map_err(|_| ActionError::new("device_key", "The Touch ID request stopped unexpectedly."))?
        .map(hex::encode)
        .map_err(device_error)
}

/// The node identity and pairing a device signs into every message, as the
/// node itself states them (`GET /pair/device-keys`).
#[derive(Deserialize)]
struct DeviceBinding {
    node: String,
    client_id: String,
    #[serde(default)]
    device_keys: Vec<RegisteredKey>,
}

#[derive(Deserialize)]
struct RegisteredKey {
    key_id: String,
}

async fn device_binding(state: &NodeState) -> Result<DeviceBinding, ActionError> {
    let (status, body) = call_api(state, reqwest::Method::GET, "/pair/device-keys", None).await.map_err(ActionError::node)?;
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(ActionError::new("device_unsupported", "This node version does not take device approvals. Approve at the node instead."));
    }
    if !status.is_success() {
        return Err(ActionError::node(api_error("/pair/device-keys", status, &body)));
    }
    decode_act("/pair/device-keys", &body)
}

fn device_view(state: &NodeState, record: Option<&device::Record>) -> device::DeviceView {
    device::DeviceView::of(device_key::available(), record, state.device_lapsed.load(Ordering::SeqCst), now_ms())
}

#[derive(Deserialize)]
struct DeviceKeyReply {
    op_id: String,
    key_id: String,
    fingerprint: String,
    expires_at: i64,
    owner_action: String,
}

/// Where this Mac's registration stands; asks the node while one is pending,
/// and notices a key the owner revoked.
async fn do_device_key_status(state: &NodeState) -> Result<device::DeviceView, ActionError> {
    let store = device_store(state)?;
    let Some(mut record) = device::load_record(&store) else { return Ok(device_view(state, None)) };
    if let Some(p) = record.pending.clone() {
        let path = format!("/pair/device-key/{}", p.op_id);
        if act::elevation_status_path(&p.op_id).is_err() {
            record.pending = None;
        } else if let Ok((code, body)) = call_api(state, reqwest::Method::GET, &path, None).await {
            if code.is_success() {
                let reply: act::ElevationStatusReply = decode_act("/pair/device-key", &body)?;
                match reply.status.as_str() {
                    "registered" => {
                        record.registered = true;
                        record.pending = None;
                        state.device_lapsed.store(false, Ordering::SeqCst);
                    }
                    "expired" | "lost" | "absent" => {
                        record.pending = None;
                        state.device_lapsed.store(true, Ordering::SeqCst);
                    }
                    _ => {}
                }
                device::save_record(&store, &record)?;
            }
        }
    } else if record.registered {
        // The owner may have revoked it at the node.
        if let (Ok(binding), Some(key_id)) = (device_binding(state).await, record.key_id.clone()) {
            if !binding.device_keys.iter().any(|k| k.key_id == key_id) {
                record.registered = false;
                device::save_record(&store, &record)?;
            }
        }
    }
    Ok(device_view(state, Some(&record)))
}

/// Set up Touch ID approvals: create the enclave key (once), prove it to the
/// node with one Touch ID signature, and wait for the owner's one-time
/// approval at the node. This app cannot approve it.
async fn do_device_key_register(state: &NodeState) -> Result<device::DeviceView, ActionError> {
    if !device_key::available() {
        return Err(device_error(device_key::DeviceKeyError::Unavailable));
    }
    let store = device_store(state)?;
    let existing = device::load_record(&store);
    if existing.as_ref().is_some_and(|r| r.registered) {
        return Ok(device_view(state, existing.as_ref()));
    }
    let (blob, mut record) = match (device::load_blob(&store), existing) {
        (Some(blob), Some(record)) => (blob, record),
        _ => {
            let policy = *state.device_policy.lock().unwrap();
            let (blob, public) = tokio::task::spawn_blocking(move || device_key::create(policy))
                .await
                .map_err(|_| ActionError::new("device_key", "Creating the key stopped unexpectedly."))?
                .map_err(device_error)?;
            device::save_blob(&store, &blob)?;
            let record = device::Record { public_key: hex::encode(public), ..Default::default() };
            device::save_record(&store, &record)?;
            (blob, record)
        }
    };
    let binding = device_binding(state).await?;
    let message = device::registration_message(&binding.node, &binding.client_id, &record.public_key);
    let proof = device_sign(blob, message, "register this Mac with your BitSov node, so it can approve payments with Touch ID".into()).await?;
    let body = serde_json::json!({"public_key": record.public_key, "name": "BitSov app on this Mac", "proof": proof});
    let (status, text) = call_api(state, reqwest::Method::POST, "/pair/device-key", Some(body)).await.map_err(ActionError::node)?;
    if !status.is_success() {
        return Err(ActionError::node(api_error("/pair/device-key", status, &text)));
    }
    let reply: DeviceKeyReply = decode_act("/pair/device-key", &text)?;
    if act::elevation_status_path(&reply.op_id).is_err() {
        return Err(ActionError::node("the node returned an unexpected operation id"));
    }
    record.key_id = Some(reply.key_id);
    record.fingerprint = Some(reply.fingerprint.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(24).collect());
    record.pending = Some(device::PendingRegistration {
        op_id: reply.op_id,
        owner_action: reply.owner_action.chars().take(600).collect(),
        expires_at_ms: (reply.expires_at.max(0) as u64).saturating_mul(1000),
    });
    device::save_record(&store, &record)?;
    state.device_lapsed.store(false, Ordering::SeqCst);
    Ok(device_view(state, Some(&record)))
}

/// Withdraw a registration still waiting for the owner.
async fn do_device_key_cancel(state: &NodeState) -> Result<device::DeviceView, ActionError> {
    let store = device_store(state)?;
    let Some(mut record) = device::load_record(&store) else { return Ok(device_view(state, None)) };
    if let Some(p) = record.pending.take() {
        if act::elevation_status_path(&p.op_id).is_ok() {
            let _ = call_api(state, reqwest::Method::DELETE, &format!("/pair/device-key/{}", p.op_id), None).await;
        }
        device::save_record(&store, &record)?;
    }
    state.device_lapsed.store(false, Ordering::SeqCst);
    Ok(device_view(state, Some(&record)))
}

/// Open (or renew) one contact's spend envelope: the owner signs the exact
/// terms with Touch ID, the node verifies and enforces them, and the app's
/// spend window then opens over that grant as for any node grant.
async fn do_relation_approve(
    state: &NodeState,
    peer: &str,
    label: Option<&str>,
    budget_msat: Option<u64>,
    per_act_max_msat: Option<u64>,
) -> Result<act::SpendView, ActionError> {
    // Contact defaults (research doc): 200 sats a day, the quoted price per act.
    let budget_msat = budget_msat.unwrap_or(device::DEFAULT_BUDGET_MSAT);
    let per_act_max_msat = device::default_per_act(per_act_max_msat, budget_msat);
    if budget_paused(state)? {
        return Err(ActionError::new("budget_paused", "Payments are paused. Resume them first."));
    }
    let store = device_store(state)?;
    let record = device::load_record(&store).filter(|r| r.registered);
    let (Some(record), Some(blob)) = (record, device::load_blob(&store)) else {
        return Err(ActionError::new("device_not_registered", "Set up Touch ID approvals first."));
    };
    let key_id = record.key_id.clone().ok_or_else(|| ActionError::new("device_not_registered", "Set up Touch ID approvals first."))?;
    let intent = device::Intent::contact(&key_id, peer, budget_msat, per_act_max_msat, now_unix())?;
    let binding = device_binding(state).await?;
    let message = device::intent_message(&binding.node, &binding.client_id, &intent);
    let reason = device::intent_reason(&device::contact_name(label, &intent.peer), budget_msat, per_act_max_msat);
    let signature = match device_sign(blob, message, reason).await {
        Ok(signature) => signature,
        Err(e) => {
            // A key the enclave no longer accepts is gone for good: set up again.
            if e.code == "device_invalid" {
                device::forget(&store);
            }
            return Err(e);
        }
    };
    let body = serde_json::json!({"intent": intent, "signature": signature});
    let (status, text) = call_api(state, reqwest::Method::POST, "/pair/relation-intent", Some(body)).await.map_err(ActionError::node)?;
    if !status.is_success() {
        return Err(ActionError::node(api_error("/pair/relation-intent", status, &text)));
    }
    // The grant reaches a token only on re-issue; then open the window over it.
    refresh_paired(state).await.map_err(ActionError::node)?;
    spend_advance_for(state, Some(Want::Window)).await
}

#[tauri::command(rename_all = "snake_case")]
async fn device_key_status(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<device::DeviceView, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_device_key_status(state.inner()).await
}

#[tauri::command(rename_all = "snake_case")]
async fn device_key_register(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<device::DeviceView, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_device_key_register(state.inner()).await
}

#[tauri::command(rename_all = "snake_case")]
async fn device_key_cancel(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<device::DeviceView, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_device_key_cancel(state.inner()).await
}

/// The owner's Touch ID approval of one contact's envelope.
#[tauri::command(rename_all = "snake_case")]
async fn relation_approve(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    peer: String,
    contact_name: Option<String>,
    budget_msat: Option<u64>,
    per_act_max_msat: Option<u64>,
) -> Result<act::SpendView, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_relation_approve(state.inner(), &peer, contact_name.as_deref(), budget_msat, per_act_max_msat).await
}

#[tauri::command(rename_all = "snake_case")]
async fn spend_reconcile(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<String, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_spend_reconcile(state.inner()).await
}

/// `POST /messages/compose` to a peer (paid first contact included) or a room.
#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
async fn message_send(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    recipient: String,
    is_room: bool,
    plaintext: String,
    max_msat: u64,
    max_recipient_msat: Option<std::collections::HashMap<String, u64>>,
    first_contact_msat: Option<u64>,
) -> Result<act::SendReceipt, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_message_send_with(state.inner(), &recipient, is_room, &plaintext, max_msat, max_recipient_msat, first_contact_msat).await
}

/// Retry a paid, undelivered message through its own journal record. Without
/// `approved_msat` it never pays admission; with it, at most that approved price.
#[tauri::command(rename_all = "snake_case")]
async fn message_retry(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    recipient: String,
    plaintext: String,
    approved_msat: Option<u64>,
) -> Result<act::SendReceipt, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_message_retry(state.inner(), &recipient, &plaintext, approved_msat).await
}

/// The owner stops retrying a paid, undelivered message. Dispatches nothing.
#[tauri::command(rename_all = "snake_case")]
async fn spend_dismiss_undelivered(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    pending_id: String,
) -> Result<String, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_spend_dismiss_undelivered(state.inner(), &pending_id)
}

fn budget_view(state: &NodeState) -> Result<budget::BudgetView, ActionError> {
    let now = now_ms();
    let autopay = state.autopay.lock().unwrap().view(now);
    let waiting = state.wants.lock().unwrap().budget.is_some() && state.spend.lock().unwrap().view(now).pending.is_some();
    let node_grant = state.node_grant.lock().unwrap().as_ref().filter(|g| g.live(now)).map(grant::GrantSummary::from);
    with_book(state, false, |book| Ok(budget::BudgetView { node_grant, ..budget::view(book, autopay, waiting, now) }))
}

fn budget_target(target: &str, room: bool) -> Result<String, ActionError> {
    if room { control::room_id(target) } else { control::node_id(target) }.map_err(ActionError::invalid)
}

async fn do_budget_approve(state: &NodeState, ceiling_msat: u64, preset: budget::PresetId) -> Result<budget::BudgetView, ActionError> {
    if !(act::MIN_PAYMENT_MSAT..=budget::MAX_DAILY_MSAT).contains(&ceiling_msat) {
        return Err(ActionError::invalid("A daily total is between 1 and 100,000 sats."));
    }
    with_book(state, true, |book| {
        if book.paused {
            return Err(ActionError::new("budget_paused", "Payments are paused. Resume them first."));
        }
        book.preset = preset;
        book.set_ceiling(ceiling_msat);
        Ok(())
    })?;
    // Lowering an open approval narrows it in place. Anything else is the owner's new tap.
    let narrowed = {
        let mut autopay = state.autopay.lock().unwrap();
        match autopay.ceiling(now_ms()) {
            Some(open) if ceiling_msat <= open => {
                autopay.narrow(ceiling_msat);
                true
            }
            _ => false,
        }
    };
    if !narrowed {
        spend_advance_for(state, Some(Want::Budget(ceiling_msat))).await?;
    }
    budget_view(state)
}

/// Pause-all: every payment stops now, and stays stopped across restarts.
fn do_budget_pause(state: &NodeState) -> Result<budget::BudgetView, ActionError> {
    state.autopay.lock().unwrap().lock();
    state.spend.lock().unwrap().lock();
    *state.wants.lock().unwrap() = Wants::default();
    save_spend_pending(state);
    with_book(state, true, |book| {
        book.paused = true;
        Ok(())
    })?;
    budget_view(state)
}

/// Resume is the owner's tap for the daily total already on the book.
async fn do_budget_resume(state: &NodeState) -> Result<budget::BudgetView, ActionError> {
    let ceiling = with_book(state, true, |book| {
        book.paused = false;
        Ok(book.ceiling_msat)
    })?;
    spend_advance_for(state, Some(Want::Budget(ceiling))).await?;
    budget_view(state)
}

/// Budgets, the running 24-hour tally, and whether automatic payment is on.
#[tauri::command(rename_all = "snake_case")]
async fn budget_status(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<budget::BudgetView, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    // `spend_status` polls a pending elevation; a budget grant lands there.
    budget_view(state.inner())
}

/// The owner's one approval: messages pay automatically up to this daily total.
#[tauri::command(rename_all = "snake_case")]
async fn budget_approve(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    ceiling_msat: u64,
    preset: budget::PresetId,
) -> Result<budget::BudgetView, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_budget_approve(state.inner(), ceiling_msat, preset).await
}

/// Set, lower, or (0) forget one contact's or room's budget, within the daily total.
#[tauri::command(rename_all = "snake_case")]
async fn budget_set(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    target: String,
    room: bool,
    limit_msat: u64,
) -> Result<budget::BudgetView, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    let target = budget_target(&target, room)?;
    with_book(state.inner(), true, |book| book.set_limit(&target, room, limit_msat))?;
    budget_view(state.inner())
}

#[tauri::command(rename_all = "snake_case")]
async fn budget_pause(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<budget::BudgetView, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_budget_pause(state.inner())
}

#[tauri::command(rename_all = "snake_case")]
async fn budget_resume(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<budget::BudgetView, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_budget_resume(state.inner()).await
}

/// What one message to a room costs: each member's own price, summed.
#[tauri::command(rename_all = "snake_case")]
async fn room_quote(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    room_id: String,
) -> Result<act::RoomQuote, String> {
    reject_sealed_window(&window)?;
    drop(window);
    read_room_quote(state.inner(), &room_id).await
}

/// `POST /payments/invoice`. Receiving: no spend approval needed.
#[tauri::command(rename_all = "snake_case")]
async fn invoice_create(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    amount_msat: u64,
    note: String,
    expiry_secs: Option<u32>,
) -> Result<act::InvoiceView, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_invoice_create(state.inner(), amount_msat, &note, expiry_secs.unwrap_or(3600)).await
}

/// The amount an invoice asks for, read locally before anything is paid.
#[tauri::command(rename_all = "snake_case")]
fn invoice_amount(
    window: WebviewWindow<impl tauri::Runtime>,
    bolt11: String,
) -> Result<act::InvoiceAmount, ActionError> {
    reject_sealed_window(&window)?;
    act::invoice_amount(&bolt11)
}

/// `POST /payments/pay`, only for the amount the owner was shown.
#[tauri::command(rename_all = "snake_case")]
async fn payment_pay(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    bolt11: String,
    amount_msat: u64,
    max_msat: u64,
) -> Result<act::PaymentReceipt, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_payment_pay(state.inner(), &bolt11, amount_msat, max_msat).await
}

/// `POST /payments/keysend`.
#[tauri::command(rename_all = "snake_case")]
async fn payment_keysend(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    dest_pubkey: String,
    amount_msat: u64,
    memo: Option<String>,
    max_msat: u64,
) -> Result<act::PaymentReceipt, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_payment_keysend(state.inner(), &dest_pubkey, amount_msat, memo.as_deref(), max_msat).await
}

/// `POST /invites`: an invite bound to one invitee's key.
#[tauri::command(rename_all = "snake_case")]
async fn invite_create(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    invitee: String,
    addr: String,
    hours: u64,
) -> Result<act::InviteView, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_invite_create(state.inner(), &invitee, &addr, hours).await
}

/// `POST /invites/accept`.
#[tauri::command(rename_all = "snake_case")]
async fn invite_redeem(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    invite: String,
) -> Result<act::RedeemView, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_invite_redeem(state.inner(), &invite).await
}

/// `GET /payments/price/200`: this node's price for sending a file.
#[tauri::command(rename_all = "snake_case")]
async fn file_price(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<act::PaymentQuote, String> {
    reject_sealed_window(&window)?;
    drop(window);
    let price: control::KindPrice = get_json(state.inner(), &control::price_path(act::KIND_FILE_REF)).await?;
    act::payment_quote(price.price_msat.max(act::MIN_PAYMENT_MSAT)).map_err(|e| e.to_string())
}

/// What calling a contact costs, before anything is paid. Read-only.
#[tauri::command(rename_all = "snake_case")]
async fn call_quote(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    peer: String,
) -> Result<control::CallQuote, String> {
    reject_sealed_window(&window)?;
    drop(window);
    read_call_quote(state.inner(), &peer).await
}

/// `POST /messages/compose` for one call signal (kinds 400-403).
#[tauri::command(rename_all = "snake_case")]
async fn call_signal(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    peer: String,
    kind: u16,
    plaintext: String,
    max_msat: u64,
) -> Result<act::CallReceipt, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_call_signal(state.inner(), &peer, kind, &plaintext, max_msat).await
}

/// `GET /files` then `GET /files/:id`: a received voice note, for playback.
#[tauri::command(rename_all = "snake_case")]
async fn voice_note_fetch(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    message_id: String,
) -> Result<act::FileBlob, String> {
    reject_sealed_window(&window)?;
    drop(window);
    do_voice_note_fetch(state.inner(), &message_id).await
}

/// `GET /files` then `GET /files/:id`: any received file (for preview / Save meta).
#[tauri::command(rename_all = "snake_case")]
async fn file_fetch(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    message_id: String,
) -> Result<act::FileBlob, String> {
    reject_sealed_window(&window)?;
    drop(window);
    do_file_fetch(state.inner(), &message_id).await
}

/// Fetch a received file and write it only where the owner picks (native save dialog).
#[tauri::command(rename_all = "snake_case")]
async fn file_save(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    message_id: String,
) -> Result<act::FileSaveResult, String> {
    reject_sealed_window(&window)?;
    drop(window);
    do_file_save(state.inner(), &message_id).await
}

/// `POST /files` then `POST /files/:id/send` to one peer.
#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
async fn file_send(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    recipient: String,
    filename: String,
    mime_type: String,
    data_b64: String,
    max_msat: u64,
    first_contact_msat: Option<u64>,
) -> Result<act::FileReceipt, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_file_send(state.inner(), &recipient, &filename, &mime_type, &data_b64, max_msat, first_contact_msat).await
}

// ---- AI track (main window) -------------------------------------------------
// The app is the broker (`bitsov_app::ai`). Reads go through the closed read
// broker with the paired token only; the rc7 `/auth/local` token is never used
// for them. A remote model is off unless this computer's `ai-providers.json`
// turns it on, and a send carries only a body the owner was just shown.

/// Pending disclosures. Host memory only; dropped on quit.
#[derive(Default)]
struct AiState {
    disclosures: ai::Disclosures,
}

fn ai_config_dir(app: &AppHandle<impl tauri::Runtime>) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|_| "Could not find this app's config folder.".to_string())
}

fn ai_local_path(app: &AppHandle<impl tauri::Runtime>) -> Result<std::path::PathBuf, String> {
    Ok(ai_config_dir(app)?.join("ai-local.json"))
}

/// Remotes from `ai-providers.json` (off by default). Own-tier model name is
/// applied only when [`ai_provider_views`] finds a live loopback server.
fn ai_provider_set(app: &AppHandle<impl tauri::Runtime>) -> (Vec<ai::ProviderView>, Vec<ai::Remote>) {
    let dir = app.path().app_config_dir().ok();
    let file = dir
        .as_ref()
        .and_then(|dir| ai::load_providers_file(&dir.join("ai-providers.json")));
    // Do not attach a saved Own model here: a down server must not badge as ready (N2).
    ai::providers(file.as_ref(), None)
}

/// Provider list for the window: remotes from the settings file, plus Own with
/// a model name only when the saved pick resolves on loopback right now.
async fn ai_provider_views(app: &AppHandle<impl tauri::Runtime>) -> Vec<ai::ProviderView> {
    let (mut views, _remotes) = ai_provider_set(app);
    let saved = ai_local_path(app)
        .ok()
        .and_then(|path| ai::local::load_local_file(&path));
    let Some(saved) = saved else {
        return views;
    };
    match ai::local::resolve_saved(Some(&saved)).await {
        Some(choice) => {
            if let Some(local) = views.iter_mut().find(|v| v.kind == ai::ProviderKind::Local) {
                local.model = Some(choice.model);
                local.note = None;
            }
        }
        None => {
            if let Some(local) = views.iter_mut().find(|v| v.kind == ai::ProviderKind::Local) {
                local.model = None;
                local.note = Some(format!(
                    "Local model \"{}\" is unavailable. Start Ollama or llama.cpp on this computer, then Refresh.",
                    saved.model
                ));
            }
        }
    }
    views
}

/// Read one topic through the broker, off the async runtime.
async fn ai_read_topic(state: &NodeState, topic: ai::Topic, since_ms: Option<u64>) -> Result<ai::TopicRead, String> {
    ensure_fresh_token(state).await;
    let auth = node_auth(state);
    let base = state.api_base.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let audit = Arc::new(bitsov_app::jarvis::broker::StderrAudit);
        ai::read_topic(auth, &base, audit, topic, since_ms)
    })
    .await
    .map_err(|_| "The read did not finish.".to_string())
}

/// One topic from the node, as the broker projects it, with its freshness.
#[tauri::command(rename_all = "snake_case")]
async fn ai_read(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    topic: ai::Topic,
    since_ms: Option<u64>,
) -> Result<ai::TopicRead, String> {
    reject_sealed_window(&window)?;
    drop(window);
    ai_read_topic(state.inner(), topic, since_ms).await
}

/// Local first; remote ones say whether they are on and where they would send.
/// Own shows a model name only when the loopback server answers right now.
#[tauri::command(rename_all = "snake_case")]
async fn ai_providers(
    window: WebviewWindow<impl tauri::Runtime>,
) -> Result<Vec<ai::ProviderView>, String> {
    reject_sealed_window(&window)?;
    let app = window.app_handle().clone();
    drop(window);
    Ok(ai_provider_views(&app).await)
}

/// Prepare, never send: re-read the topic, narrow it, build the exact body,
/// and hold it for one send. Own-tier loopback models use the same hold/send
/// path so the owner always sees the exact bytes before anything is posted.
#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
async fn ai_disclose(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    ai_state: State<'_, AiState>,
    provider: ai::ProviderKind,
    topic: ai::Topic,
    since_ms: Option<u64>,
    preset: ai::Preset,
    question: String,
) -> Result<ai::Disclosure, String> {
    reject_sealed_window(&window)?;
    let remote = match provider {
        ai::ProviderKind::Local => {
            let path = ai_local_path(window.app_handle())?;
            let saved = ai::local::load_local_file(&path)
                .ok_or_else(|| ai::local::HOWTO.to_string())?;
            let choice = ai::local::resolve_saved(Some(&saved))
                .await
                .ok_or_else(|| ai::local::HOWTO.to_string())?;
            choice.as_remote()
        }
        other => ai_provider_set(window.app_handle())
            .1
            .into_iter()
            .find(|remote| remote.kind == other)
            .ok_or("That model is off on this computer. Nothing was prepared.")?,
    };
    drop(window);
    let question = ai::clean_question(&question).ok_or("Ask a question first.")?;
    let read = ai_read_topic(state.inner(), topic, since_ms).await?;
    let body = ai::request_body(&remote, &question, &read, preset)
        .ok_or("Your node could not be read, so nothing was prepared.")?;
    ai_state
        .disclosures
        .hold(&remote, preset, body, Instant::now())
        .ok_or_else(|| "Could not prepare the request.".to_string())
}

/// The owner's tap: send the held body, once.
#[tauri::command(rename_all = "snake_case")]
async fn ai_send(
    window: WebviewWindow<impl tauri::Runtime>,
    ai_state: State<'_, AiState>,
    disclosure_id: String,
) -> Result<ai::RemoteAnswer, String> {
    reject_sealed_window(&window)?;
    drop(window);
    let (remote, body) = ai_state
        .disclosures
        .take(&disclosure_id, Instant::now())
        .ok_or("That preview expired or was already used. Nothing was sent.")?;
    let key = remote.key_env.as_deref().and_then(|name| std::env::var(name).ok());
    ai::send(&remote, body, key).await
}

/// Drop a prepared request unsent.
#[tauri::command(rename_all = "snake_case")]
fn ai_cancel(
    window: WebviewWindow<impl tauri::Runtime>,
    ai_state: State<'_, AiState>,
    disclosure_id: String,
) -> Result<bool, String> {
    reject_sealed_window(&window)?;
    Ok(ai_state.disclosures.cancel(&disclosure_id))
}

/// Probe loopback for Ollama / llama.cpp; list models or return a short how-to.
#[tauri::command(rename_all = "snake_case")]
async fn ai_local_status(
    window: WebviewWindow<impl tauri::Runtime>,
    port: Option<u16>,
) -> Result<ai::local::LocalStatus, String> {
    reject_sealed_window(&window)?;
    let saved = ai_local_path(window.app_handle())
        .ok()
        .and_then(|path| ai::local::load_local_file(&path));
    let preferred = port.or_else(|| saved.as_ref().map(|s| s.port));
    let probe = ai::local::probe(preferred).await;
    Ok(ai::local::status_from(probe, saved.as_ref()))
}

/// Remember which loopback model Own should use. Remotes stay off.
#[tauri::command(rename_all = "snake_case")]
async fn ai_local_select(
    window: WebviewWindow<impl tauri::Runtime>,
    model: String,
    port: Option<u16>,
) -> Result<Vec<ai::ProviderView>, String> {
    reject_sealed_window(&window)?;
    let path = ai_local_path(window.app_handle())?;
    let preferred = port.or_else(|| ai::local::load_local_file(&path).map(|s| s.port));
    let probe = ai::local::probe(preferred)
        .await
        .ok_or_else(|| ai::local::HOWTO.to_string())?;
    let model = ai::short(&model, 80).ok_or("Pick a model name.")?;
    if !probe.models.iter().any(|name| name == &model) {
        return Err("That model is not on the local server right now.".into());
    }
    let file = ai::local::LocalFile {
        // Always the port that answered (N1): a dead typed port must not stick.
        port: probe.port,
        model,
        kind: Some(probe.kind),
    };
    ai::local::save_local_file(&path, &file)?;
    Ok(ai_provider_views(window.app_handle()).await)
}

/// Clear the Own model pick; answers fall back to rules on this computer.
#[tauri::command(rename_all = "snake_case")]
async fn ai_local_clear(
    window: WebviewWindow<impl tauri::Runtime>,
) -> Result<Vec<ai::ProviderView>, String> {
    reject_sealed_window(&window)?;
    let path = ai_local_path(window.app_handle())?;
    ai::local::clear_local_file(&path)?;
    Ok(ai_provider_views(window.app_handle()).await)
}

/// Tauri event the main window listens on for `/ws` traffic.
const LIVE_EVENT: &str = "node-live";

/// Forward to the MAIN window only. The sealed assistant window never receives
/// node traffic, which carries decrypted plaintext. Link transitions are
/// recorded on the way, so `live_link` can replay them to a late subscriber.
fn emit_live<R: tauri::Runtime>(app: &AppHandle<R>, event: control::LiveEvent) {
    app.state::<NodeState>().live_link.publish(event, |event| {
        let _ = app.emit_to(MAIN_WINDOW_LABEL, LIVE_EVENT, event);
    });
}

/// Re-send the current `/ws` link state on `node-live`, to the main window only.
///
/// The bridge reports `open` once, when the socket opens, which is usually before
/// the shell has mounted and subscribed. The shell calls this right after it
/// subscribes. The replay goes out on the same channel as live transitions, and
/// under the same lock, so it can never land after a newer one.
#[tauri::command(rename_all = "snake_case")]
fn live_link(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
) -> Result<Option<control::LinkState>, String> {
    reject_sealed_window(&window)?;
    Ok(state.live_link.replay(|event| {
        let _ = window.emit_to(MAIN_WINDOW_LABEL, LIVE_EVENT, event);
    }))
}

/// Bridge the node's loopback `GET /ws` into the main window.
///
/// The HOST holds the socket and the token (presented as `?token=`, which the
/// node accepts alongside the `bitsov.jwt.` subprotocol); the renderer only sees
/// parsed [`control::LiveEvent`]s. Waits for the node to be ready, reconnects
/// with backoff, and stops once the app is quitting.
async fn live_bridge(app: AppHandle) {
    let state = app.state::<NodeState>();
    let mut attempt = 0u32;
    loop {
        if state.quitting.load(Ordering::SeqCst) {
            return;
        }
        let ready = *state.ready.lock().unwrap();
        if !ready {
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }
        ensure_fresh_token(&state).await;
        let token = state.token.lock().unwrap().clone();
        let Some(token) = token else {
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        };
        let url = match control::ws_url(&state.api_base, &token) {
            Ok(url) => url,
            Err(detail) => {
                emit_live(&app, control::LiveEvent::Link {
                    state: control::LinkState::Closed,
                    detail: Some(detail),
                });
                return;
            }
        };
        emit_live(&app, control::LiveEvent::Link {
            state: control::LinkState::Connecting,
            detail: None,
        });
        let emit = |event| emit_live(&app, event);
        let detail = match control::run_ws_session(&url, &emit).await {
            Ok(()) => {
                attempt = 0;
                None
            }
            Err(detail) => {
                attempt = attempt.saturating_add(1);
                Some(detail)
            }
        };
        emit_live(&app, control::LiveEvent::Link {
            state: control::LinkState::Closed,
            detail,
        });
        tokio::time::sleep(control::backoff(attempt)).await;
    }
}

/// What a stop attempt actually did. Returned so the REAL adapter can be asserted
/// against disposable subprocesses, not just an injectable policy (app #16 review).
#[derive(Debug, PartialEq, Eq)]
enum StopOutcome {
    /// The process had already exited — nothing was signalled.
    AlreadyExited,
    /// SIGTERM was sent and the process exited within the budget.
    TermedAndExited,
    /// SIGTERM was sent, the budget elapsed, SIGKILL finished the job.
    Killed,
}

/// Stop the node this app spawned: SIGTERM, bounded wait, SIGKILL as a last resort.
///
/// Ownership is structural, not checked. `SharedChild` waits with POSIX `waitid`,
/// which reaps WITHOUT releasing the pid for reuse, so `send_signal` cannot land on
/// an unrelated process — and it is documented to be a no-op once the child has been
/// waited on. That closes the check-then-signal race a `ps`-based ownership test
/// could only narrow: there is no window between "still ours" and "signal sent",
/// because the pid is not returned to the OS while we hold this handle.
///
/// We never hunt for whoever holds port 3141 — a node the app did not start belongs
/// to someone else and must survive our quit.
///
/// The graceful step matters: the node's own shutdown path (konsensus-node `main.rs`,
/// comment L0e) stops the Lightning backend explicitly because "LDK queues
/// ChannelMonitor persistence calls during shutdown; if we wait for Drop ... those
/// persistence calls can be silently lost — real-fund-loss class on a live channel".
/// It allows itself 15s for that, so the SIGKILL fallback sits beyond it. rc7 installs
/// a real `SignalKind::terminate()` handler, so SIGTERM lands on an orderly path.
///
/// Returns once the process is confirmed gone.
fn stop_supervised_node(child: &SharedChild, budget: Duration) -> StopOutcome {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return StopOutcome::AlreadyExited;
    }

    // Unix: ask politely first. No-op if the child was reaped between the check above
    // and here — the guarantee `ps`-based ownership could not give us.
    #[cfg(unix)]
    {
        let _ = child.send_signal(libc::SIGTERM);
        match child.wait_timeout(budget) {
            Ok(Some(_)) => return StopOutcome::TermedAndExited,
            _ => {
                eprintln!(
                    "[node] pid {} ignored SIGTERM for {budget:?}; escalating",
                    child.id()
                );
            }
        }
    }

    // Windows has no SIGTERM: `TerminateProcess` (what `kill` maps to) is the only
    // stop available, so there is no graceful step to skip — we go straight to it
    // rather than silently doing nothing on that platform. The node therefore does
    // not get to flush LDK ChannelMonitor state on Windows; that is a real gap and
    // belongs to whatever ticket makes Windows a supported target (it is not one
    // today — the Windows sidecar is unsigned and untested). Kept explicit here so
    // it is visible rather than implied by an absent branch.
    #[cfg(not(unix))]
    let _ = budget;

    let _ = child.kill();
    let _ = child.wait(); // confirm completion rather than assume it
    StopOutcome::Killed
}

/// Registration of the supervised node, coordinated with quit (Codex R2G on 3ff4e60e).
///
/// The hazard: the host process ends as soon as the exit handler returns, taking every
/// other thread with it. So whatever the exit handler cannot see — a node deregistered
/// by a restore that is still stopping it, or a node spawned after the handler ran —
/// outlives the app with the user's keys loaded.
impl NodeState {
    /// Spawn the node and register it in one step, unless quit has begun. The check and
    /// the registration happen under the lock the exit handler takes, so either the node
    /// is registered before quit looks (and quit stops it), or quit came first and
    /// nothing is spawned.
    fn spawn_child(&self, cmd: &mut std::process::Command) -> Result<Arc<SharedChild>, String> {
        let mut slot = self.child.lock().unwrap();
        if self.quitting.load(Ordering::SeqCst) {
            return Err("the app is quitting; the node was not started".into());
        }
        let child =
            Arc::new(SharedChild::spawn(cmd).map_err(|e| format!("node start failed: {e}"))?);
        *slot = Some(child.clone());
        Ok(child)
    }

    /// Stop the registered node ahead of a restart. It stays registered for the whole
    /// stop — up to `budget` — and is deregistered only once its exit is confirmed, and
    /// only if the slot still holds it (quit may have taken it meanwhile).
    ///
    /// Returns whether there was a node to stop.
    fn stop_for_restart(&self, budget: Duration) -> bool {
        // A restored/adopted listener may share identity and backend with the
        // old node without sharing its startup configuration.
        *self.room_routing_policy.lock().unwrap() = None;
        *self.configured_network.lock().unwrap() = None;
        let Some(child) = self.child.lock().unwrap().as_ref().cloned() else {
            return false;
        };
        stop_supervised_node(&child, budget);
        let mut slot = self.child.lock().unwrap();
        if slot.as_ref().is_some_and(|c| Arc::ptr_eq(c, &child)) {
            *slot = None;
        }
        true
    }

    /// The exit handler: refuse any further spawn, then stop the registered node —
    /// including one a restore is still stopping — and return only once it is confirmed
    /// gone. `take()` makes a repeated shutdown event a no-op: the second finds `None`.
    fn stop_for_quit(&self, budget: Duration) -> Option<StopOutcome> {
        let child = {
            let mut slot = self.child.lock().unwrap();
            self.quitting.store(true, Ordering::SeqCst);
            slot.take()
        };
        child.map(|child| stop_supervised_node(&child, budget))
    }
}

fn main() {
    // Assistant mock path: sealed window only. Never construct NodeState (that
    // builds a reqwest client), never register wallet commands, never spawn the
    // node. Release and ordinary debug builds take `app_builder` below.
    //
    // One `generate_context!` only: a second expansion duplicates the embedded
    // Info.plist symbol when `--features sit-mock` compiles both paths.
    #[cfg(all(debug_assertions, feature = "sit-mock"))]
    let builder = if assistant_dev_enabled() {
        assistant_mock_builder()
    } else {
        app_builder()
    };
    #[cfg(not(all(debug_assertions, feature = "sit-mock")))]
    let builder = app_builder();

    let app = builder
        .build(tauri::generate_context!())
        .expect("error building bitsov-app");

    #[cfg(all(debug_assertions, feature = "sit-mock"))]
    if assistant_dev_enabled() {
        app.run(|_app, _event| {});
        return;
    }

    app.run(|app, event| {
        // Stop the supervised node on exit — no orphan node with the user's keys.
        //
        // BOTH events are required (app #16). `ExitRequested` fires when the last
        // window closes, which on macOS does NOT quit the app; Cmd-Q goes through
        // NSApplication terminate and emits `Exit`. Matching only `ExitRequested`
        // therefore never ran on macOS: every quit left a mainnet node running with
        // the user's keys loaded, still holding 3141/9735/9736. Reproduced before the
        // fix — the node's ppid went from the GUI's pid to 1 on quit.
        //
        // A repeated shutdown event is a no-op, and a restore in flight can neither
        // hide its old node from this nor start a new one after it (`stop_for_quit`).
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            app.state::<NodeState>().stop_for_quit(NODE_SHUTDOWN_BUDGET);
        }
    });
}

/// Normal CS-1 / CS-2 desktop shell: NodeState, wallet commands, bootstrap.
fn app_builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(NodeState::default())
        .manage(AiState::default())
        .invoke_handler(tauri::generate_handler![
            node_status,
            fund_state,
            fund_start,
            funding_address,
            payments_balance,
            identity_restore,
            pairing_status,
            pairing_retry,
            node_overview,
            live_link,
            peers_list,
            rooms_list,
            room_members,
            messages_list,
            price_quote,
            first_contact_quote,
            introduction_mine,
            introduction_read,
            introduction_open,
            front_door_mine,
            front_door_read,
            front_door_open,
            front_door_publish,
            front_door_hash_bytes,
            sponsor_status,
            sponsor_offer,
            sponsor_candidate,
            sponsor_owner_approval,
            sponsor_reconcile,
            sponsor_cancel,
            sponsor_request,
            sponsor_request_status,
            first_contact_request,
            first_contact_status,
            first_contact_cancel,
            payments_overview,
            energy_read,
            membrane_read,
            spend_status,
            spend_request,
            spend_lock,
            spend_cancel,
            device_key_status,
            device_key_register,
            device_key_cancel,
            relation_approve,
            spend_reconcile,
            budget_status,
            budget_approve,
            budget_set,
            budget_pause,
            budget_resume,
            message_send,
            message_retry,
            spend_dismiss_undelivered,
            room_quote,
            invoice_create,
            invoice_amount,
            payment_pay,
            payment_keysend,
            invite_create,
            invite_redeem,
            file_price,
            file_send,
            voice_note_fetch,
            file_fetch,
            file_save,
            call_quote,
            call_signal,
            ai_read,
            ai_providers,
            ai_disclose,
            ai_send,
            ai_cancel,
            ai_local_status,
            ai_local_select,
            ai_local_clear
        ])
        .setup(|app| {
            if assistant_dev_enabled() || assistant_node_enabled() {
                install_assistant_menu(app)?;
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(bootstrap_node(handle));
            tauri::async_runtime::spawn(live_bridge(app.handle().clone()));
            Ok(())
        })
}

/// Sealed assistant only: mock rows, no node, no wallet, no network client.
///
/// Compiled only for debug + `sit-mock`. Entered from `main` when
/// `BITSOV_ASSISTANT=1`. Must not touch NodeState, bootstrap_node, the shell
/// sidecar plugin, or privileged invoke handlers.
#[cfg(all(debug_assertions, feature = "sit-mock"))]
fn assistant_mock_builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![])
        .setup(|app| {
            // Open the sealed window first so closing the config main window
            // does not leave the process with zero windows.
            let source = Feed::mock(MockReason::NotPaired).init_script();
            open_assistant_window(app.handle(), source).map_err(
                |e| -> Box<dyn std::error::Error> { e.into() },
            )?;
            if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = main.close();
            }
            Ok(())
        })
}

/// Loopback mock harness shared with `tests/pairing.rs` (ephemeral port, test keys).
#[cfg(test)]
#[allow(dead_code)]
#[path = "../tests/support/mod.rs"]
mod test_support;

#[cfg(test)]
mod node_start_args_tests {
    use super::node_start_args;
    use std::path::Path;

    #[test]
    fn only_the_dev_node_path_starts_with_owner_control() {
        let config = Path::new("/tmp/dev/konsensus.toml");
        assert_eq!(node_start_args(config, false), ["start", "--config", "/tmp/dev/konsensus.toml"]);
        assert_eq!(
            node_start_args(config, true),
            ["start", "--config", "/tmp/dev/konsensus.toml", "--owner-control"]
        );
    }
}

#[cfg(test)]
mod api_base_tests {
    use super::{loopback_api_port, API_BASE};

    #[test]
    fn the_app_talks_to_3141_unless_a_dev_build_moves_it() {
        assert_eq!(API_BASE, "http://127.0.0.1:3141/api/v1");
        // `cargo test` builds without `dev-node`: the product base, always.
        #[cfg(not(all(debug_assertions, feature = "dev-node")))]
        assert_eq!(super::NodeState::default().api_base, API_BASE);
    }

    /// The restore path stops only the listener on this app's own API port.
    #[test]
    fn restore_signals_only_the_app_api_port() {
        assert_eq!(loopback_api_port(API_BASE), Some(3141));
        assert_eq!(loopback_api_port("http://127.0.0.1:47123/api/v1"), Some(47123));
        let lan = format!("{}://192.168.1.5:3141/api/v1", "http");
        for other in [
            "http://127.0.0.1:0/api/v1",
            "http://localhost:3141/api/v1",
            "http://127.0.0.1:3141",
            lan.as_str(),
            "http://127.0.0.1:x/api/v1",
        ] {
            assert_eq!(loopback_api_port(other), None, "{other}");
        }
    }
}

#[cfg(test)]
mod pairing_wiring_tests {
    //! The host's auth wiring against mock-node's #77 shapes: which path mints
    //! the token, and that a paired session never re-mints via `/auth/local`.
    use super::test_support::{mock, Server};
    use super::*;
    use bitsov_app::pairing::{self, ClientKey, PrintedCodes};
    use mock_node::pairing::{PairRoutes, PairingMock};

    struct Fixture {
        node: Arc<PairingMock>,
        state: NodeState,
        data_dir: tempfile::TempDir,
        _server: Server,
    }

    fn fixture(routes: PairRoutes) -> Fixture {
        let data_dir = tempfile::tempdir().unwrap();
        let node = mock(data_dir.path(), routes, now_unix());
        let codes = PrintedCodes::default();
        let server = Server::start(node.clone(), codes.clone());
        let mut state = NodeState::for_api(server.api_base());
        state.printed_codes = codes;
        Fixture {
            node,
            state,
            data_dir,
            _server: server,
        }
    }

    /// External mode: challenges are read from the owner's node dir, and the app's
    /// key and pairing record stay in the app's own dir.
    #[tokio::test]
    async fn external_mode_reads_the_node_dir_and_writes_only_the_app_dir() {
        let f = fixture(PairRoutes::Live);
        let app_dir = tempfile::tempdir().unwrap();
        *f.state.external_node.lock().unwrap() = Some(f.data_dir.path().to_path_buf());
        authenticate(&f.state, app_dir.path()).await.expect("paired");
        assert!(matches!(&*f.state.auth.lock().unwrap(), AuthMode::Paired(_)));
        assert!(app_dir.path().join(PAIRING_STORE_DIR).join(pairing::KEY_FILE).exists());
        assert!(!f.data_dir.path().join(PAIRING_STORE_DIR).exists());
    }

    #[tokio::test]
    async fn without_external_mode_the_challenge_must_be_in_the_data_dir() {
        let f = fixture(PairRoutes::Live);
        let elsewhere = tempfile::tempdir().unwrap();
        let err = authenticate(&f.state, elsewhere.path()).await.expect_err("refused");
        assert!(err.contains("data directory"), "{err}");
    }

    #[test]
    fn external_mode_refuses_restart_and_keeps_app_files_out_of_the_node_dir() {
        let state = NodeState::default();
        state.config.lock().unwrap().replace(PathBuf::from("/node/konsensus.toml"));
        assert_eq!(app_files_dir(&state), Some(PathBuf::from("/node")));
        assert!(refuse_external(&state).is_ok());
        state.external_node.lock().unwrap().replace(PathBuf::from("/node"));
        state.app_dir.lock().unwrap().replace(PathBuf::from("/app/external-node"));
        assert_eq!(app_files_dir(&state), Some(PathBuf::from("/app/external-node")));
        assert!(refuse_external(&state).unwrap_err().contains("never restarts"));
    }

    #[tokio::test]
    async fn authenticate_pairs_and_never_calls_auth_local() {
        let f = fixture(PairRoutes::Live);
        authenticate(&f.state, f.data_dir.path()).await.expect("paired");
        let view = f.state.pairing_view.lock().unwrap().clone();
        assert_eq!(view.state, "paired");
        assert_eq!(view.scopes, ["read", "receive"]);
        assert!(view.code_from_node);
        assert!(matches!(*f.state.auth.lock().unwrap(), AuthMode::Paired(_)));
        assert!(f.state.token.lock().unwrap().is_some());
        assert_eq!(fetch_node_id(&f.state).await.unwrap(), mock_node::NODE_ID);
        assert_eq!(f.node.calls("/api/v1/auth/local"), 0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let key = f.data_dir.path().join(PAIRING_STORE_DIR).join(pairing::KEY_FILE);
            let mode = std::fs::metadata(key).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[tokio::test]
    async fn authenticate_on_rc7_falls_back_to_auth_local() {
        let f = fixture(PairRoutes::Absent);
        authenticate(&f.state, f.data_dir.path()).await.expect("fallback");
        assert_eq!(f.state.pairing_view.lock().unwrap().state, "fallback");
        assert!(matches!(*f.state.auth.lock().unwrap(), AuthMode::Local));
        assert_eq!(fetch_node_id(&f.state).await.unwrap(), mock_node::NODE_ID);
        assert_eq!(f.node.calls("/api/v1/auth/local"), 1);
    }

    #[tokio::test]
    async fn authenticate_refusal_leaves_no_token_and_no_fallback() {
        let f = fixture(PairRoutes::Live);
        let other = tempfile::tempdir().unwrap();
        let client = pairing::PairingClient::new(reqwest::Client::new(), f.state.api_base.clone());
        let key = ClientKey::load_or_create(other.path()).unwrap();
        pairing::establish(&client, &key, other.path(), "other", &PrintedCodes::default())
            .await
            .expect("first client pairs");

        let err = authenticate(&f.state, f.data_dir.path()).await.expect_err("refused");
        assert!(err.contains("409"), "{err}");
        let view = f.state.pairing_view.lock().unwrap().clone();
        assert_eq!(view.state, "failed");
        assert!(view.reason.unwrap().contains("closed"));
        assert!(f.state.token.lock().unwrap().is_none());
        assert!(matches!(*f.state.auth.lock().unwrap(), AuthMode::Unauthenticated));
        assert_eq!(f.node.calls("/api/v1/auth/local"), 0);
    }

    #[tokio::test]
    async fn call_api_refreshes_a_paired_token_before_it_expires() {
        let f = fixture(PairRoutes::Live);
        authenticate(&f.state, f.data_dir.path()).await.unwrap();
        let before = f.state.token.lock().unwrap().clone();
        // Age the session into the refresh margin, still before expiry.
        if let AuthMode::Paired(session) = &mut *f.state.auth.lock().unwrap() {
            session.expires_at = now_unix() + 30;
        }
        let (status, _) = call_api(&f.state, reqwest::Method::GET, "/identity", None)
            .await
            .unwrap();
        assert_eq!(status, reqwest::StatusCode::OK);
        assert_eq!(f.node.tokens_issued(), 2);
        assert_ne!(*f.state.token.lock().unwrap(), before);
        assert_eq!(f.node.calls("/api/v1/auth/local"), 0);
    }

    #[tokio::test]
    async fn a_paired_401_is_never_reminted_via_auth_local() {
        let f = fixture(PairRoutes::Live);
        authenticate(&f.state, f.data_dir.path()).await.unwrap();
        f.node.revoke_all();
        let (status, _) = call_api(&f.state, reqwest::Method::GET, "/identity", None)
            .await
            .unwrap();
        assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED);
        assert_eq!(f.node.calls("/api/v1/pair/challenge"), 2, "refresh went through pairing");
        assert_eq!(f.node.calls("/api/v1/auth/local"), 0);
    }

    /// The assistant reads only with a paired token; rc7's `/auth/local`
    /// token and a failed pairing both leave it on mock rows.
    #[tokio::test]
    async fn assistant_auth_follows_the_established_mode() {
        use bitsov_app::jarvis::assistant_source::NodeAuth;

        let f = fixture(PairRoutes::Live);
        assert!(matches!(node_auth(&f.state), NodeAuth::NotPaired));
        authenticate(&f.state, f.data_dir.path()).await.expect("paired");
        match node_auth(&f.state) {
            NodeAuth::Paired { scopes, .. } => assert_eq!(scopes, ["read", "receive"]),
            other => panic!("expected paired, got {other:?}"),
        }

        let rc7 = fixture(PairRoutes::Absent);
        authenticate(&rc7.state, rc7.data_dir.path()).await.expect("fallback");
        assert!(matches!(node_auth(&rc7.state), NodeAuth::Rc7Fallback));
        assert_eq!(rc7.node.calls("/api/v1/auth/local"), 1, "only F1's fallback mints");

        let refused = fixture(PairRoutes::Live);
        let other = tempfile::tempdir().unwrap();
        let client =
            pairing::PairingClient::new(reqwest::Client::new(), refused.state.api_base.clone());
        let key = ClientKey::load_or_create(other.path()).unwrap();
        pairing::establish(&client, &key, other.path(), "other", &PrintedCodes::default())
            .await
            .expect("first client pairs");
        assert!(authenticate(&refused.state, refused.data_dir.path()).await.is_err());
        assert!(matches!(node_auth(&refused.state), NodeAuth::NotPaired));
    }

    #[tokio::test]
    async fn bootstrap_node_is_reported_and_not_marked_ready() {
        let f = fixture(PairRoutes::Bootstrap);
        authenticate(&f.state, f.data_dir.path()).await.unwrap();
        let view = f.state.pairing_view.lock().unwrap().clone();
        assert_eq!(view.state, "paired");
        assert_eq!(view.bootstrap.as_deref(), Some("bootstrap"));
        assert_eq!(view.scopes, ["read", "receive", "identity"]);
    }
}

#[cfg(test)]
mod ai_track_tests {
    //! The AI track's host wiring: it reads only through the broker with the
    //! paired token, and a send takes an id, never a body.

    fn section() -> String {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/main.rs")).unwrap();
        source
            .split("// ---- AI track (main window)")
            .nth(1)
            .and_then(|rest| rest.split("/// Tauri event the main window listens on").next())
            .expect("AI track section")
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn reads_use_the_broker_and_the_paired_token_only() {
        let section = section();
        assert!(section.contains("let auth = node_auth(state);"));
        assert!(section.contains("ai::read_topic(auth, &base, audit, topic, since_ms)"));
        for token in ["call_api", "get_json", "state.token", "auth/local", "gated_post", "reqwest::"] {
            assert!(!section.contains(token), "AI track section uses {token}");
        }
    }

    #[test]
    fn a_send_takes_an_id_and_never_a_body() {
        let section = section();
        let send = section
            .split("async fn ai_send(")
            .nth(1)
            .and_then(|rest| rest.split(") -> Result").next())
            .expect("ai_send signature");
        assert!(send.contains("disclosure_id: String"), "{send}");
        for param in ["body", "payload", "endpoint", "question", "key"] {
            assert!(!send.contains(param), "ai_send takes {param}");
        }
        // The endpoint comes from the host-only file, never from the window.
        let disclose = section
            .split("async fn ai_disclose(")
            .nth(1)
            .and_then(|rest| rest.split(") -> Result").next())
            .expect("ai_disclose signature");
        for param in ["endpoint", "model", "key", "body", "host"] {
            assert!(!disclose.contains(&format!("{param}:")), "ai_disclose takes {param}");
        }
    }
}

#[cfg(test)]
mod control_read_tests {
    //! The control-center read commands against a loopback fake node on an
    //! ephemeral port: which routes they hit, that the bearer rides along, how
    //! bodies are projected, and that bad ids never reach the wire.
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ROOM: &str = "0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
    const TOKEN: &str = "test.read.receive";

    type ReadRequests = Arc<Mutex<Vec<(String, Option<String>)>>>;

    struct FakeNode {
        state: NodeState,
        seen: ReadRequests,
    }

    fn route(target: &str) -> (u16, String) {
        let path = target.strip_prefix("/api/v1").unwrap_or(target);
        let (route, _) = path.split_once('?').unwrap_or((path, ""));
        let body = match route {
            "/status" => serde_json::json!({
                "status": "ok", "node_id": "11".repeat(32), "connected_peers": 2,
                "connected_peer_ids": [A], "e2ee_sessions": 3, "pending_deliveries": 0,
                "lightning_available": true, "lightning_payment_capable": true,
                "uptime_secs": 60, "version": 2, "lightning_backend": "ldk",
                "chain_backend": "esplora", "block_height": 860123,
                "lightning_node_pubkey": "02cd"
            }),
            "/peers" => serde_json::json!([{
                "node_id": A, "addr": "127.0.0.1:9735", "label": "Maya", "connected": true,
                "auto_connect": true, "fingerprint": "aaaaaaaa", "safety_number": "1 2 3"
            }]),
            "/rooms" => serde_json::json!([{
                "id": ROOM, "name": "Mexico", "created_by": A,
                "created_at": "2026-09-27T10:00:00Z", "metadata": {}
            }]),
            r if r == format!("/rooms/{ROOM}/members") => serde_json::json!([A]),
            "/messages" => serde_json::json!([
                {"id": "02", "kind": 0, "sender": A, "recipient": "11", "timestamp": 20,
                 "ciphertext": "ff", "payment_amount_msat": 1000, "payment_hash": "aa", "plaintext": "second"},
                {"id": "01", "kind": 0, "sender": A, "recipient": "11", "timestamp": 10,
                 "ciphertext": "ff", "payment_amount_msat": 1000, "payment_hash": "bb", "plaintext": "first"}
            ]),
            "/payments/price/0" => serde_json::json!({"kind": 0, "price_msat": 1000}),
            "/pricing/peers" => serde_json::json!([]),
            "/payments/balance" => serde_json::json!({"balance_msat": 52_500_000u64}),
            "/payments/channels" => return (502, r#"{"error":"lightning backend unavailable","code":502}"#.into()),
            _ => return (404, r#"{"error":"route","code":404}"#.into()),
        };
        (200, body.to_string())
    }

    fn fake_node() -> FakeNode {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_ne!(port, 3141, "tests must never hold the node port");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let target = line.split_whitespace().nth(1).unwrap_or("").to_string();
                let mut bearer = None;
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).is_err() || header == "\r\n" || header.is_empty() {
                        break;
                    }
                    if let Some(v) = header.strip_prefix("authorization: Bearer ") {
                        bearer = Some(v.trim().to_string());
                    }
                }
                log.lock().unwrap().push((target.clone(), bearer));
                let (status, body) = route(&target);
                let mut out = stream;
                let _ = write!(
                    out,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        let state = NodeState::for_api(format!("http://127.0.0.1:{port}/api/v1"));
        *state.token.lock().unwrap() = Some(TOKEN.into());
        *state.auth.lock().unwrap() = AuthMode::Local;
        FakeNode { state, seen }
    }

    impl FakeNode {
        fn targets(&self) -> Vec<String> {
            self.seen.lock().unwrap().iter().map(|(t, _)| t.clone()).collect()
        }
    }

    #[tokio::test]
    async fn every_read_carries_the_bearer_and_hits_only_get_routes() {
        let node = fake_node();
        let overview = read_node_overview(&node.state).await.unwrap();
        assert_eq!(overview.connected_peers, 2);
        assert_eq!(overview.block_height, Some(860_123));
        assert_eq!(overview.version.as_deref(), Some("api v2"));
        assert!(overview.read_at > 0);

        let peers: Vec<control::Peer> = get_json(&node.state, "/peers").await.unwrap();
        assert_eq!(peers[0].label.as_deref(), Some("Maya"));
        let rooms: Vec<control::Room> = get_json(&node.state, "/rooms").await.unwrap();
        assert_eq!(rooms[0].name, "Mexico");
        assert_eq!(read_room_members(&node.state, ROOM).await.unwrap(), vec![A.to_string()]);

        for (_, bearer) in node.seen.lock().unwrap().iter() {
            assert_eq!(bearer.as_deref(), Some(TOKEN));
        }
    }

    #[tokio::test]
    async fn messages_come_back_oldest_first_for_the_asked_track() {
        let node = fake_node();
        let page = read_messages(&node.state, A, Some(99), None).await.unwrap();
        let texts: Vec<_> = page.iter().map(|m| m.plaintext.clone().unwrap()).collect();
        assert_eq!(texts, ["first", "second"]);
        assert_eq!(node.targets(), [format!("/api/v1/messages?peer={A}&limit=50&before=99")]);
        let json = serde_json::to_string(&page).unwrap();
        assert!(!json.contains("ciphertext") && !json.contains("payment_hash"));
    }

    #[tokio::test]
    async fn bad_ids_are_refused_before_any_request() {
        let node = fake_node();
        assert!(read_messages(&node.state, "../payments/pay", None, None).await.is_err());
        assert!(read_room_members(&node.state, "x/../../identity").await.is_err());
        assert!(read_price_quote(&node.state, Some("not-a-node")).await.is_err());
        assert!(node.targets().is_empty(), "{:?}", node.targets());
    }

    #[tokio::test]
    async fn price_quote_falls_back_to_own_price_when_no_peer_table_is_cached() {
        let node = fake_node();
        let quote = read_price_quote(&node.state, Some(A)).await.unwrap();
        assert_eq!((quote.own_msat, quote.peer_msat), (1000, None));
        assert_eq!(node.targets(), ["/api/v1/payments/price/0", "/api/v1/pricing/peers"]);

        let node = fake_node();
        read_price_quote(&node.state, None).await.unwrap();
        assert_eq!(node.targets(), ["/api/v1/payments/price/0"], "no peer, no table read");
    }

    #[tokio::test]
    async fn a_node_error_surfaces_the_route_and_the_node_text_only() {
        let node = fake_node();
        let err = read_wallet(&node.state).await.unwrap_err();
        assert_eq!(err, "/payments/channels failed (502): lightning backend unavailable");
        assert!(!err.contains(TOKEN));
    }

    /// The bridge is spawned by the normal builder only and emits to the main
    /// window by label, never broadcast to every window.
    #[test]
    fn live_events_go_to_the_main_window_only() {
        let source = include_str!("main.rs");
        let production = source.split("#[cfg(test)]").next().unwrap();
        let emitter = production
            .split("fn emit_live")
            .nth(1)
            .and_then(|rest| rest.split("\n}\n").next())
            .expect("emit_live");
        assert!(emitter.contains("emit_to(MAIN_WINDOW_LABEL"));
        assert!(!production.contains(".emit(LIVE_EVENT"));
        assert!(!production.contains("emit_all"));
        let mock = production
            .split("fn assistant_mock_builder")
            .nth(1)
            .and_then(|rest| rest.split("\n}\n").next())
            .expect("assistant_mock_builder");
        assert!(!mock.contains("live_bridge"));
    }
}

#[cfg(test)]
mod control_act_tests {
    //! Slice B actions against a loopback fake node on an ephemeral port: the
    //! spend window is checked before any request, bodies are exact, a node
    //! refusal locks the window, and the owner-grant path on a paired node.
    #[tokio::test]
    async fn rc7_and_malformed_capabilities_refuse_all_variable_sends() {
        for status in [
            serde_json::json!({"status":"ok","version":2,"node_id":OWN}),
            serde_json::json!({"api_capabilities":null}),
            serde_json::json!({"api_capabilities":"paid_send_caps_v1"}),
            serde_json::json!({"api_capabilities":["paid_send_caps_v0"]}),
        ] {
            let routes: Routes = Arc::new(move |m,p,b| {
                if p == "/status" { return (200, status.to_string()); }
                happy()(m,p,b)
            });
            let node = fake(AuthMode::Local,routes);
            spend_advance(&node.state,true).await.unwrap();
            assert_eq!(do_message_send(&node.state,A,false,"hi",7000,None).await.unwrap_err().code,"price_cap_unavailable");
            assert_eq!(do_message_send(&node.state,ROOM,true,"hi",13000,Some(std::collections::HashMap::from([(A.into(),7000),(C.into(),6000)]))).await.unwrap_err().code,"price_cap_unavailable");
            assert_eq!(do_file_send(&node.state,A,"a.txt","text/plain","aGk=",8000, None).await.unwrap_err().code,"price_cap_unavailable");
            assert!(node.posts().is_empty());
        }
    }

    #[tokio::test]
    async fn caps_unavailable_refuses_message_and_file_before_post() {
        let routes: Routes = Arc::new(|m,p,b| {
            if p == "/status" { return (200, serde_json::json!({"api_capabilities":[]}).to_string()); }
            happy()(m,p,b)
        });
        let node=fake(AuthMode::Local,routes);
        spend_advance(&node.state,true).await.unwrap();
        assert_eq!(do_message_send(&node.state,A,false,"hi",7000, None).await.unwrap_err().code,"price_cap_unavailable");
        assert_eq!(do_file_send(&node.state,A,"a.txt","text/plain","aGk=",8000, None).await.unwrap_err().code,"price_cap_unavailable");
        assert!(node.posts().is_empty());
    }
    #[tokio::test]
    async fn readiness_refusal_clears_journal_and_allows_later_manual_send() {
        let ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let route_ready = ready.clone();
        let routes: Routes = Arc::new(move |m,p,b| {
            if p == "/messages/compose" && !route_ready.load(std::sync::atomic::Ordering::SeqCst) {
                return (503, serde_json::json!({"code":"not_ready","money_ready":false,"error":"offline"}).to_string());
            }
            happy()(m,p,b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        for _ in 0..2 {
            assert_eq!(do_message_send(&node.state,A,false,"hi",7000,None).await.unwrap_err().code, "not_ready");
            assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
        }
        assert_eq!(node.posts().len(), 2);
        ready.store(true, std::sync::atomic::Ordering::SeqCst);
        do_message_send(&node.state,A,false,"hi",7000,None).await.unwrap();
        assert_eq!(node.posts().len(), 3);
    }

    #[tokio::test]
    async fn readiness_refusal_preserves_paid_retry_record_and_accounting_until_manual_recovery() {
        for approved in [None, Some(4000)] {
            let refusal = (503, serde_json::json!({"code":"not_ready","money_ready":false,"error":"offline"}).to_string());
            let node = fake(AuthMode::Local, compose_script(vec![
                psi_502(2000, 0, 2000, PSI_TIMEOUT), refusal.clone(), refusal, delivered("recovered", 0),
            ]));
            let record = psi_first(&node).await;
            let accounted = book(&node);
            for _ in 0..2 {
                assert_eq!(do_message_retry(&node.state, A, "gm", approved).await.unwrap_err().code, "not_ready");
                assert_eq!(serde_json::to_value(pending(&node).expect("paid retry survives refusal")).unwrap(),
                    serde_json::to_value(&record).unwrap(), "restore the entire durable record");
                assert_eq!(book(&node), accounted, "release only the retry reservation");
            }
            assert_eq!(do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err().code, "spend_unknown");
            assert_eq!(compose_bodies(&node).len(), 3, "no automatic replay or new send");
            let restarted = reopen(&node);
            assert_eq!(do_spend_reconcile(&restarted).await.unwrap_err().code, "undelivered_pending");
            assert_eq!(do_message_retry(&node.state, A, "gm", approved).await.unwrap().message_id, "recovered");
            assert!(pending(&node).is_none());
            let bodies = compose_bodies(&node);
            assert_eq!(bodies.len(), 4);
            for body in &bodies[1..] { assert_eq!(body["max_total_msat"], approved.unwrap_or(0)); }
            assert_eq!(book(&node), [(record.request_hash.clone(), 14000, true),
                (format!("{}-retry-1", record.request_hash), 0, true)]);
        }
    }

    #[test]
    fn readiness_mapping_requires_the_explicit_predispatch_contract() {
        let refusal = r#"{"code":"not_ready","money_ready":false}"#;
        assert!(act::readiness_refusal(503, refusal));
        assert_eq!(ActionError::node(api_error("/sponsor/request", reqwest::StatusCode::SERVICE_UNAVAILABLE, refusal)).code, "not_ready");
        for (status, body) in [(500, refusal), (503, "unavailable"), (503, r#"{"code":"not_ready"}"#),
            (503, r#"{"code":"not_ready","money_ready":true}"#), (503, r#"{"code":"unknown","money_ready":false}"#)] {
            assert!(!act::readiness_refusal(status, body));
        }
    }

    #[test]
    fn not_dispatched_mapping_requires_http_400_and_exact_code() {
        let body = r#"{"code":"not_dispatched","max_routing_fee_msat":5000,"error":"fee ceiling"}"#;
        assert!(act::not_dispatched_refusal(400, body));
        assert!(act::not_dispatched_refusal(400, r#"{"code":"not_dispatched"}"#));
        for (status, reply) in [
            (502, body),
            (503, body),
            (409, body),
            (400, r#"{"code":"price_cap_exceeded"}"#),
            (400, r#"{"code":"not_ready","money_ready":false}"#),
            (400, "bad request"),
            (400, r#"{"error":"not_dispatched"}"#),
        ] {
            assert!(!act::not_dispatched_refusal(status, reply), "{status} {reply}");
        }
    }

    #[test]
    fn not_dispatched_copy_is_neutral_unless_reason_is_a_fee_limit() {
        assert_eq!(
            act::not_dispatched_message(r#"{"code":"not_dispatched"}"#),
            act::NOT_DISPATCHED_MESSAGE
        );
        let fresh = act::not_dispatched_message(
            r#"{"code":"not_dispatched","max_routing_fee_msat":5000,"error":"capped payments require a fresh invoice hash"}"#,
        );
        assert!(fresh.starts_with(act::NOT_DISPATCHED_MESSAGE), "{fresh}");
        assert!(fresh.contains("capped payments require a fresh invoice hash"), "{fresh}");
        assert!(
            !fresh.to_ascii_lowercase().contains("network fee would exceed"),
            "non-fee refusal must not blame the fee limit: {fresh}"
        );
        let fee = act::not_dispatched_message(
            r#"{"code":"not_dispatched","max_routing_fee_msat":5000,"error":"fee ceiling exceeded"}"#,
        );
        assert!(fee.starts_with(act::NOT_DISPATCHED_MESSAGE), "{fee}");
        assert!(fee.to_ascii_lowercase().contains("network fee would exceed your limit"), "{fee}");
        assert!(fee.contains("fee ceiling exceeded"), "{fee}");
        let route = act::not_dispatched_message(
            r#"{"code":"not_dispatched","error":"route fee above ceiling"}"#,
        );
        assert!(route.to_ascii_lowercase().contains("network fee would exceed your limit"), "{route}");
    }

    #[tokio::test]
    async fn not_dispatched_pay_and_keysend_release_journal_and_budget() {
        let pk = format!("02{}", "ab".repeat(32));
        // pay: fee-ceiling not_dispatched clears; copy mentions the fee limit
        {
            let routes: Routes = Arc::new(|m, p, b| {
                if p == "/payments/pay" {
                    return (400, serde_json::json!({
                        "code": "not_dispatched",
                        "max_routing_fee_msat": 5000,
                        "error": "fee ceiling exceeded",
                    }).to_string());
                }
                happy()(m, p, b)
            });
            let node = fake(AuthMode::Local, routes);
            spend_advance(&node.state, true).await.unwrap();
            let err = do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 6000).await.unwrap_err();
            assert_eq!(err.code, "not_dispatched");
            assert!(err.message.starts_with(act::NOT_DISPATCHED_MESSAGE), "{}", err.message);
            assert!(err.message.to_ascii_lowercase().contains("network fee would exceed your limit"), "{}", err.message);
            assert!(err.message.contains("fee ceiling exceeded"), "{}", err.message);
            assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
            assert!(book(&node).is_empty(), "reservation released: {:?}", book(&node));
            assert_eq!(budget_now(&node.state).unsettled_msat, 0);
            assert_eq!(budget_now(&node.state).spent_msat, 0);
            // A second attempt still reaches the node (no double-count lock).
            assert_eq!(do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 6000).await.unwrap_err().code, "not_dispatched");
            assert_eq!(node.posts().iter().filter(|(p, _)| p == "/payments/pay").count(), 2);
            assert!(book(&node).is_empty());
        }
        // keysend: non-fee not_dispatched still releases; copy stays neutral
        {
            let routes: Routes = Arc::new(|m, p, b| {
                if p == "/payments/keysend" {
                    return (400, serde_json::json!({
                        "code": "not_dispatched",
                        "max_routing_fee_msat": 5000,
                        "error": "capped payments require a fresh invoice hash",
                    }).to_string());
                }
                happy()(m, p, b)
            });
            let node = fake(AuthMode::Local, routes);
            spend_advance(&node.state, true).await.unwrap();
            let err = do_payment_keysend(&node.state, &pk, 5000, None, 10000).await.unwrap_err();
            assert_eq!(err.code, "not_dispatched");
            assert!(err.message.starts_with(act::NOT_DISPATCHED_MESSAGE), "{}", err.message);
            assert!(err.message.contains("capped payments require a fresh invoice hash"), "{}", err.message);
            assert!(
                !err.message.to_ascii_lowercase().contains("network fee would exceed"),
                "non-fee refusal must not blame the fee limit: {}",
                err.message
            );
            assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
            assert!(book(&node).is_empty());
            assert_eq!(budget_now(&node.state).unsettled_msat, 0);
            assert_eq!(budget_now(&node.state).spent_msat, 0);
            assert_eq!(do_payment_keysend(&node.state, &pk, 5000, None, 10000).await.unwrap_err().code, "not_dispatched");
            assert_eq!(node.posts().iter().filter(|(p, _)| p == "/payments/keysend").count(), 2);
        }
    }

    #[tokio::test]
    async fn pay_and_keysend_502_and_other_400s_stay_unknown_spend() {
        let pk = format!("02{}", "ab".repeat(32));
        for (path, status, body) in [
            ("/payments/pay", 502u16, r#"{"error":"no route","code":502}"#.to_string()),
            ("/payments/pay", 400, r#"{"code":"bad_request","error":"malformed"}"#.to_string()),
            ("/payments/pay", 400, r#"{"code":"price_cap_exceeded","error":"too high"}"#.to_string()),
            ("/payments/keysend", 502, r#"{"error":"no route","code":502}"#.to_string()),
            ("/payments/keysend", 400, r#"{"code":"bad_request","error":"malformed"}"#.to_string()),
            ("/payments/keysend", 400, r#"{"error":"not_dispatched"}"#.to_string()), // wrong shape
        ] {
            let route_path = path.to_string();
            let reply = body.clone();
            let routes: Routes = Arc::new(move |m, p, b| {
                if p == route_path { return (status, reply.clone()); }
                happy()(m, p, b)
            });
            let node = fake(AuthMode::Local, routes);
            spend_advance(&node.state, true).await.unwrap();
            let err = if path == "/payments/pay" {
                do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 6000).await.unwrap_err()
            } else {
                do_payment_keysend(&node.state, &pk, 5000, None, 10000).await.unwrap_err()
            };
            assert_eq!(err.code, "spend_unknown", "{path} {status} {body}");
            assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_some(), "{path} journal");
            assert!(!book(&node).is_empty(), "{path} book kept: {:?}", book(&node));
            assert!(budget_now(&node.state).unsettled_msat > 0, "{path} reservation held");
            // Blocked from a second dispatch (no double counting via re-send).
            let again = if path == "/payments/pay" {
                do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 6000).await.unwrap_err()
            } else {
                do_payment_keysend(&node.state, &pk, 5000, None, 10000).await.unwrap_err()
            };
            assert_eq!(again.code, "spend_unknown");
            assert_eq!(node.posts().iter().filter(|(p, _)| p == path).count(), 1, "{path} no second POST");
        }
    }

    #[tokio::test]
    async fn caps_transmit_confirmed_ceiling_and_safe_refusal_clears_journal() {
        let routes: Routes = Arc::new(|m,p,b| {
            if p == "/messages/compose" { return (409, serde_json::json!({"code":"price_cap_exceeded","error":"price rose"}).to_string()); }
            happy()(m,p,b)
        });
        let node=fake(AuthMode::Local,routes);
        spend_advance(&node.state,true).await.unwrap();
        assert_eq!(do_message_send(&node.state,A,false,"hi",7000, None).await.unwrap_err().code,"price_cap_exceeded");
        assert_eq!(node.posts()[0].1["max_total_msat"],7000);
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
    }
    #[tokio::test]
    async fn caps_room_unknown_cannot_be_cleared_by_one_message_or_retried() {
        for member_status in ["unknown", "pending"] {
            let routes: Routes = Arc::new(move |m,p,b| {
                if p == "/messages/compose" {
                    return (200,serde_json::json!({"max_routing_fee_msat": 0, "message_id":"ab".repeat(32),"delivered":true,"amount_msat":3000,
                        "member_outcomes":[{"recipient":A,"status":"settled","amount_msat":2000,"message_id":"ab".repeat(32)},
                            {"recipient":C,"status":member_status,"amount_msat":1000}]}).to_string());
                }
                happy()(m,p,b)
            });
            let node=fake(AuthMode::Local,routes);
            spend_advance(&node.state,true).await.unwrap();
            assert_eq!(do_message_send(&node.state,ROOM,true,"hi",13000, Some(std::collections::HashMap::from([(A.into(), 7000), (C.into(), 6000)]))).await.unwrap_err().code,"spend_unknown");
            assert!(do_spend_reconcile(&node.state).await.is_err());
            assert_eq!(do_message_send(&node.state,ROOM,true,"hi",13000, Some(std::collections::HashMap::from([(A.into(), 7000), (C.into(), 6000)]))).await.unwrap_err().code,"spend_unknown");
            assert_eq!(node.posts().len(),1);
            assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_some());
            let reopened=NodeState::for_api(node.state.api_base.clone());
            *reopened.config.lock().unwrap()=node.state.config.lock().unwrap().clone();
            assert!(spend_journal(&reopened).unwrap().pending().unwrap().is_some());
        }
    }

    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::AtomicUsize;

    const OWN: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const ROOM: &str = "0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
    const FILE_ID: &str = "11111111-2222-4333-8444-555555555555";

    type Seen = Arc<Mutex<Vec<(String, String, Option<String>, String)>>>;
    type Routes = Arc<dyn Fn(&str, &str, &str) -> (u16, String) + Send + Sync>;

    struct Fake {
        state: NodeState,
        seen: Seen,
        _dir: tempfile::TempDir,
    }

    impl Fake {
        fn posts(&self) -> Vec<(String, serde_json::Value)> {
            self.seen
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, ..)| m == "POST")
                .map(|(_, t, _, b)| (t.trim_start_matches("/api/v1").to_string(), serde_json::from_str(b).unwrap_or_default()))
                .collect()
        }
        fn targets(&self) -> Vec<String> {
            self.seen.lock().unwrap().iter().map(|(m, t, ..)| format!("{m} {}", t.trim_start_matches("/api/v1"))).collect()
        }
    }

    fn fake(auth: AuthMode, routes: Routes) -> Fake {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_ne!(port, 3141, "tests must never hold the node port");
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                // One thread per connection: a route holding a request open
                // never blocks another, as on a real node.
                let (log, routes) = (log.clone(), routes.clone());
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() {
                        return;
                    }
                    let mut parts = line.split_whitespace();
                    let method = parts.next().unwrap_or("").to_string();
                    let target = parts.next().unwrap_or("").to_string();
                    let (mut bearer, mut length) = (None, 0usize);
                    loop {
                        let mut header = String::new();
                        if reader.read_line(&mut header).is_err() || header == "\r\n" || header.is_empty() {
                            break;
                        }
                        let lower = header.to_ascii_lowercase();
                        if let Some(v) = lower.strip_prefix("content-length:") {
                            length = v.trim().parse().unwrap_or(0);
                        }
                        if let Some(v) = header.strip_prefix("authorization: Bearer ") {
                            bearer = Some(v.trim().to_string());
                        }
                    }
                    let mut body = vec![0u8; length];
                    let _ = reader.read_exact(&mut body);
                    let body = String::from_utf8_lossy(&body).to_string();
                    log.lock().unwrap().push((method.clone(), target.clone(), bearer.clone(), body.clone()));
                    let path = target.strip_prefix("/api/v1").unwrap_or(&target).to_string();
                    let (status, reply) = if path == "/pair/first-contact-grant" && bearer.as_deref() != Some("independent.owner.fixture") {
                        (403, "independent owner authority required".to_string())
                    } else { routes(&method, &path, &body) };
                    let mut out = stream;
                    let _ = write!(
                        out,
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                        reply.len()
                    );
                });
            }
        });
        let state = NodeState::for_api(format!("http://127.0.0.1:{port}/api/v1"));
        *state.token.lock().unwrap() = Some("tok.1".into());
        *state.node_id.lock().unwrap() = Some(OWN.into());
        *state.auth.lock().unwrap() = auth;
        let dir = tempfile::tempdir().unwrap();
        *state.config.lock().unwrap() = Some(dir.path().join("konsensus.toml"));
        Fake { state, seen, _dir: dir }
    }

    /// A node that accepts every action, rc7-shaped.
    fn happy() -> Routes {
        Arc::new(|_method: &str, path: &str, _body: &str| {
            let (route, _) = path.split_once('?').unwrap_or((path, ""));
            let v = match route {
                "/status" => serde_json::json!({"lightning_backend":"mock", "api_capabilities":["paid_send_caps_v1","room_terminal_outcomes_v1"]}),
                "/messages/compose" if serde_json::from_str::<serde_json::Value>(_body).unwrap_or_default()["is_room"] == true => serde_json::json!({"max_routing_fee_msat": 0, "message_id":"m1","delivered":true,"amount_msat":3000,
                    "member_outcomes":[{"recipient":A,"status":"settled","amount_msat":2000,"message_id":"m1"},{"recipient":C,"status":"settled","amount_msat":1000,"message_id":"m2"}]}),
                "/messages/compose" => serde_json::json!({"max_routing_fee_msat": 0, "message_id": "m1", "delivered": true, "amount_msat": 2000}),
                "/payments/price/200" => serde_json::json!({"kind": 200, "price_msat": 3000}),
                "/payments/pay" => serde_json::json!({"max_routing_fee_msat": 0, "payment_hash": "ab".repeat(32), "amount_msat": 1000, "preimage": "PREIMAGE"}),
                "/payments/keysend" => serde_json::json!({"max_routing_fee_msat": 0, "payment_hash": "cd".repeat(32), "amount_msat": 5000, "preimage": "PREIMAGE", "status": "Settled"}),
                "/payments/invoice" => serde_json::json!({"bolt11": "lntb210n1sample", "payment_hash": "HASH"}),
                "/invites" => serde_json::json!({"invite_id": "i1", "invite_token_b64": "tok", "invite_link": "bitsov://invite/tok"}),
                "/invites/accept" => serde_json::json!({"inviter_pubkey": A, "channel_size_hint": null, "addr": "203.0.113.5:9735"}),
                "/files" => serde_json::json!({"file_id": FILE_ID, "size_bytes": 2, "blake3_hash": "bb"}),
                r if r == format!("/files/{FILE_ID}/send") => serde_json::json!({"max_routing_fee_msat": 0, "message_id": "f1", "delivered": false, "amount_msat": 3000}),
                r if r == format!("/rooms/{ROOM}/members") => serde_json::json!([OWN, A, C]),
                "/peers" => serde_json::json!([
                    {"node_id": A, "connected": true}, {"node_id": C, "connected": true}
                ]),
                "/payments/price/0" => serde_json::json!({"kind": 0, "price_msat": 1000}),
                "/messages/first-contact/quote" => serde_json::json!({"recipient": A, "admission_msat": 1500, "message_msat": 2000, "total_msat": 3500, "expires_at": 0}),
                "/pricing/peers" => serde_json::json!([
                    {"peer_id": A, "prices": {"communication": 2000}, "age_secs": 5, "stale": false}
                ]),
                _ => return (404, r#"{"error":"route","code":404}"#.into()),
            };
            (200, v.to_string())
        })
    }

    #[tokio::test]
    async fn every_spending_action_is_refused_before_any_request_until_approved() {
        let node = fake(AuthMode::Local, happy());
        let s = &node.state;
        let codes = [
            do_message_send(s, A, false, "gm", 7000, None).await.unwrap_err().code,
            do_message_send(s, ROOM, true, "gm", 12000, Some(std::collections::HashMap::from([(A.into(), 7000), (C.into(), 6000)]))).await.unwrap_err().code,
            do_payment_pay(s, act::TEST_INVOICE_1000, 1000, 6000).await.unwrap_err().code,
            do_payment_keysend(s, &format!("02{}", "ab".repeat(32)), 5000, None, 10000).await.unwrap_err().code,
            do_invite_create(s, A, "203.0.113.5:9735", 24).await.unwrap_err().code,
            do_invite_redeem(s, "bitsov://invite/tok").await.unwrap_err().code,
            do_file_send(s, A, "a.txt", "text/plain", "aGk=", 8000, None).await.unwrap_err().code,
        ];
        assert!(codes.iter().all(|c| *c == "spend_locked"), "{codes:?}");
        assert!(node.targets().is_empty(), "{:?}", node.targets());
    }

    #[tokio::test]
    async fn receiving_needs_no_approval() {
        let node = fake(AuthMode::Local, happy());
        let invoice = do_invoice_create(&node.state, 21_000, "coffee", 600).await.unwrap();
        assert_eq!(invoice.bolt11, "lntb210n1sample");
        assert_eq!(invoice.note.as_deref(), Some("coffee"));
        assert_eq!(
            node.posts(),
            [("/payments/invoice".to_string(), serde_json::json!({"amount_msat": 21000, "expiry_secs": 600, "description": "coffee"}))]
        );
        assert!(!serde_json::to_string(&invoice).unwrap().contains("HASH"));
    }

    #[tokio::test]
    async fn app_lock_and_capable_node_compose_carries_the_exact_body() {
        let node = fake(AuthMode::Local, happy());
        let view = spend_advance(&node.state, true).await.unwrap();
        assert_eq!((view.state, view.basis), (act::SpendState::Open, Some(act::SpendBasis::AppLock)));
        assert!(node.targets().is_empty(), "rc7 has nothing to ask: the window is the app's own");

        let receipt = do_message_send(&node.state, &A.to_uppercase(), false, "gm", 7000, None).await.unwrap();
        assert_eq!((receipt.message_id.as_str(), receipt.amount_msat, receipt.delivered), ("m1", 2000, true));
        assert_eq!(receipt.recipient, A);
        assert_eq!(
            node.posts(),
            [("/messages/compose".to_string(), serde_json::json!({"recipient": A, "is_room": false, "kind": 0, "plaintext": "gm", "max_total_msat":7000,"max_routing_fee_msat":5000}))]
        );
        let bearer = node.seen.lock().unwrap()[0].2.clone();
        assert_eq!(bearer.as_deref(), Some("tok.1"));
    }

    #[tokio::test]
    async fn an_expired_window_re_prompts_without_a_request() {
        let node = fake(AuthMode::Local, happy());
        node.state.spend.lock().unwrap().arm(now_ms() - act::SPEND_WINDOW_MS - 1, act::SpendBasis::AppLock);
        let err = do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err();
        assert_eq!(err.code, "spend_expired");
        assert_eq!(spend_advance(&node.state, false).await.unwrap().state, act::SpendState::Expired);
        assert!(node.targets().is_empty());
        // One more tap re-opens it.
        assert_eq!(spend_advance(&node.state, true).await.unwrap().state, act::SpendState::Open);
    }

    #[tokio::test]
    async fn a_node_refusal_locks_the_window_and_the_next_send_is_refused_locally() {
        let routes: Routes = Arc::new(|m: &str, p: &str, b: &str| {
            if p == "/messages/compose" { (403, "token lacks required scope: spend".into()) } else { happy()(m,p,b) }
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        let err = do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err();
        assert_eq!(err.code, "spend_refused");
        assert_eq!(node.posts().len(), 1);
        assert_eq!(do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err().code, "spend_locked");
        assert_eq!(node.posts().len(), 1, "no second dispatch after a refusal");
    }

    #[tokio::test]
    async fn a_node_error_is_shown_as_the_node_wrote_it() {
        let routes: Routes = Arc::new(|m: &str, p: &str, b: &str| {
            if p == "/messages/compose" { (502, r#"{"error":"failed to pay recipient invoice: no route","code":502}"#.into()) } else { happy()(m,p,b) }
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        let err = do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err();
        assert_eq!(err.code, "spend_unknown");
        assert!(err.message.contains("/messages/compose failed (502): failed to pay recipient invoice: no route"));
        assert_eq!(spend_advance(&node.state, false).await.unwrap().state, act::SpendState::Open, "a failed payment is not a refusal");
    }

    /// Genome #100's BUG-PSI reply: admission settled, the session did not form.
    fn psi_502(amount: u64, prior: u64, current: u64, tail: &str) -> (u16, String) {
        (502, serde_json::json!({
            "error": format!("payment settled but send did not complete (prior admission: {prior} msat; current call: {current} msat): {tail}"),
            "code": "payment_settled_send_incomplete",
            "amount_msat": amount,
        }).to_string())
    }
    const PSI_TIMEOUT: &str = "internal error: first-contact admission payment settled and a signed proof is held, but the E2EE session did not establish within 25s — retry the message shortly; the retry is guarded by admission idempotence and will NOT pay admission again";

    /// The spend journal's record as the node sees it at each compose, so a
    /// test can prove the record was never absent while a retry was sent.
    type AtCompose = Arc<Mutex<Vec<Option<serde_json::Value>>>>;

    /// Compose answers from `replies` in order; everything else is `happy()`.
    fn compose_script(replies: Vec<(u16, String)>) -> Routes {
        compose_watch(replies).0
    }

    fn compose_watch(replies: Vec<(u16, String)>) -> (Routes, Arc<Mutex<Option<PathBuf>>>, AtCompose) {
        let next = Arc::new(Mutex::new(replies.into_iter()));
        let journal: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
        let seen: AtCompose = Arc::new(Mutex::new(Vec::new()));
        let (j, s) = (journal.clone(), seen.clone());
        let routes: Routes = Arc::new(move |m: &str, p: &str, b: &str| {
            if p != "/messages/compose" { return happy()(m, p, b); }
            if let Some(path) = j.lock().unwrap().clone() {
                s.lock().unwrap().push(std::fs::read(path).ok().map(|bytes| serde_json::from_slice(&bytes).unwrap()));
            }
            next.lock().unwrap().next().expect("no further compose expected")
        });
        (routes, journal, seen)
    }

    fn journal_file(node: &Fake) -> PathBuf {
        node._dir.path().join("app-spend").join("spend-pending.json")
    }

    fn compose_bodies(node: &Fake) -> Vec<serde_json::Value> {
        node.posts().into_iter().filter(|(p, _)| p == "/messages/compose").map(|(_, b)| b).collect()
    }

    fn delivered(id: &str, amount: u64) -> (u16, String) {
        (200, serde_json::json!({"message_id": id, "delivered": true, "amount_msat": amount, "max_routing_fee_msat": 0}).to_string())
    }

    fn pending(node: &Fake) -> Option<spend_journal::Pending> {
        spend_journal(&node.state).unwrap().pending().unwrap()
    }

    fn book(node: &Fake) -> Vec<(String, u64, bool)> {
        with_book(&node.state, false, |b| Ok(b.ledger.iter().map(|e| (e.id.clone(), e.msat, e.settled)).collect())).unwrap()
    }

    /// A first send whose admission settled and whose message did not go.
    async fn psi_first(node: &Fake) -> spend_journal::Pending {
        spend_advance(&node.state, true).await.unwrap();
        let err = do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err();
        assert_eq!(err.code, "payment_settled_undelivered", "{}", err.message);
        pending(node).expect("the fence stays")
    }

    // ---- exactly-once slice 3: operation_id journal and reconcile ----------------

    /// Genome `message_operations_v1`, reduced to what the app relies on: one
    /// operation per id, paid at most once, 409 on changed text, and
    /// `GET /messages/operations/{id}`. `pays` counts Lightning dispatches.
    #[derive(Default)]
    struct OpsNode {
        ops: std::collections::HashMap<String, (String, &'static str)>,
        pays: usize,
        /// Next new operation: the state it ends in, and whether its reply is lost.
        script: Vec<(&'static str, bool)>,
        /// Answer a paid operation's first POST with the node's 502 (paid, not sent).
        settled_incomplete: bool,
        /// Record nothing for the next POST and lose its reply (never reached the handler).
        drop_next: bool,
        /// The peer asks for admission again (reconnect/restart) and the node
        /// refuses to pay it under the cap, as genome `readmit_then_pay` does.
        readmission_capped: bool,
        /// Refusals answered so far: the first carries genome's `reason`, the
        /// next an older node's wording only.
        readmission_refusals: usize,
    }

    /// Genome's refusal of a capped reconnect re-admission with its stable
    /// `reason` (the wording deliberately not the older nodes').
    fn readmission_coded_reply() -> (u16, String) {
        (409, serde_json::json!({"code": "price_cap_exceeded", "reason": "readmission_required",
            "error": format!("{A} needs a paid admission on this connection; nothing was paid.")}).to_string())
    }

    /// An older genome's refusal of a capped reconnect re-admission (compose.rs
    /// `readmit_then_pay` before the reason code): English wording only.
    fn readmission_capped_reply() -> (u16, String) {
        (409, serde_json::json!({"code": "price_cap_exceeded", "error": format!(
            "{A} requires admission again on a new connection, and the confirmed cap covers the message only; \
             no invoice was paid. Send without a cap to pay admission.")}).to_string())
    }

    const OP_HASH: &str = "abababababababababababababababababababababababababababababababab";

    fn op_reply(id: &str, state: &str) -> String {
        serde_json::json!({"operation_id": id, "state": state, "accepted": state == "acked", "payment_hash": OP_HASH,
            "retry_allowed": matches!(state, "prepared" | "released" | "paid" | "sent" | "rejected_retryable"),
            "max_routing_fee_msat": 0, "message_id": "m1", "delivered": matches!(state, "sent" | "acked"), "amount_msat": 2000}).to_string()
    }

    fn ops_node() -> (Routes, Arc<Mutex<OpsNode>>) {
        let node = Arc::new(Mutex::new(OpsNode::default()));
        let n = node.clone();
        let routes: Routes = Arc::new(move |m: &str, p: &str, b: &str| {
            if p == "/status" {
                return (200, serde_json::json!({"api_capabilities": ["paid_send_caps_v1", "room_terminal_outcomes_v1", "message_operations_v1"]}).to_string());
            }
            if let Some(id) = p.strip_prefix("/messages/operations/") {
                return match n.lock().unwrap().ops.get(id) {
                    Some((_, state)) => (200, op_reply(id, state)),
                    None => (404, r#"{"error":"operation not found","code":404}"#.into()),
                };
            }
            if p != "/messages/compose" { return happy()(m, p, b); }
            let body: serde_json::Value = serde_json::from_str(b).unwrap();
            let Some(id) = body["operation_id"].as_str().map(str::to_string) else { return happy()(m, p, b); };
            let text = body["plaintext"].as_str().unwrap().to_string();
            let mut node = n.lock().unwrap();
            if std::mem::take(&mut node.drop_next) {
                drop(node);
                std::thread::sleep(Duration::from_millis(150));
                return (500, "{}".into());
            }
            let lost = match node.ops.get(&id).cloned() {
                Some((known, _)) if known != text => {
                    return (409, serde_json::json!({"error": "operation_mismatch", "code": "operation_mismatch", "operation_id": id,
                        "state": "prepared", "payment_hash": null, "accepted": false, "retry_allowed": true}).to_string());
                }
                // Paid already: re-send it, pay nothing. Unresolved: refuse.
                Some((_, "paid" | "sent" | "rejected_retryable")) => { node.ops.insert(id.clone(), (text, "acked")); false }
                Some((_, "acked")) => false,
                Some((_, "paying" | "payment_unknown")) => {
                    return (409, serde_json::json!({"error": "payment_unresolved", "code": "payment_unresolved", "operation_id": id,
                        "state": "payment_unknown", "payment_hash": OP_HASH, "accepted": false, "retry_allowed": false}).to_string());
                }
                _ if node.readmission_capped => {
                    node.ops.insert(id.clone(), (text, "released"));
                    node.readmission_refusals += 1;
                    return if node.readmission_refusals == 1 { readmission_coded_reply() } else { readmission_capped_reply() };
                }
                _ => {
                    let (state, lost) = if node.script.is_empty() { ("acked", false) } else { node.script.remove(0) };
                    if state != "prepared" { node.pays += 1; }
                    node.ops.insert(id.clone(), (text, state));
                    if state == "paid" && node.settled_incomplete {
                        return (502, serde_json::json!({"error": "payment settled but send did not complete", "code": "payment_settled_send_incomplete",
                            "amount_msat": 2000, "operation_id": id, "state": "paid", "payment_hash": OP_HASH, "accepted": false, "retry_allowed": true}).to_string());
                    }
                    lost
                }
            };
            let state = node.ops[&id].1;
            drop(node);
            if lost { std::thread::sleep(Duration::from_millis(150)); }
            (200, op_reply(&id, state))
        });
        (routes, node)
    }

    /// A node that loses replies after `spend_timeout`, as a crash after the POST would.
    fn ops_fake(configure: impl FnOnce(&mut OpsNode)) -> (Fake, Arc<Mutex<OpsNode>>) {
        let (routes, ops) = ops_node();
        configure(&mut ops.lock().unwrap());
        let mut node = fake(AuthMode::Local, routes);
        node.state.spend_timeout = Duration::from_millis(60);
        (node, ops)
    }

    fn op_ids(node: &Fake) -> Vec<Option<String>> {
        compose_bodies(node).iter().map(|b| b["operation_id"].as_str().map(str::to_string)).collect()
    }

    fn gets(node: &Fake) -> Vec<String> {
        node.targets().into_iter().filter(|t| t.starts_with("GET /messages/operations/")).collect()
    }

    #[tokio::test]
    async fn operation_id_is_journaled_before_the_first_post_and_accepted_is_reported() {
        let (routes, ops) = ops_node();
        let seen: Arc<Mutex<Vec<Option<serde_json::Value>>>> = Arc::new(Mutex::new(Vec::new()));
        let journal: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
        let (s, j) = (seen.clone(), journal.clone());
        let watched: Routes = Arc::new(move |m, p, b| {
            if p == "/messages/compose" {
                let path = j.lock().unwrap().clone().unwrap();
                s.lock().unwrap().push(std::fs::read(path).ok().map(|bytes| serde_json::from_slice(&bytes).unwrap()));
            }
            routes(m, p, b)
        });
        let node = fake(AuthMode::Local, watched);
        *journal.lock().unwrap() = Some(journal_file(&node));
        spend_advance(&node.state, true).await.unwrap();
        let receipt = do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap();
        let ids = op_ids(&node);
        let id = ids[0].clone().expect("a 1:1 compose carries an operation_id");
        assert!(uuid_v4(&id), "{id}");
        let at_post = seen.lock().unwrap()[0].clone().expect("journal on disk before the POST");
        assert_eq!(at_post["operation_id"], id.as_str());
        assert!(!at_post.to_string().contains("\"gm\""), "no plaintext in the journal");
        assert_eq!((receipt.accepted, receipt.state.as_deref(), receipt.operation_id.as_deref()), (true, Some("acked"), Some(id.as_str())));
        assert!(pending(&node).is_none());
        assert_eq!(ops.lock().unwrap().pays, 1);
        // A second, separate send is a separate operation.
        do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap();
        let ids = op_ids(&node);
        assert_ne!(ids[0], ids[1]);
    }

    fn uuid_v4(id: &str) -> bool {
        let parts: Vec<&str> = id.split('-').collect();
        parts.iter().map(|p| p.len()).collect::<Vec<_>>() == [8, 4, 4, 4, 12]
            && id.bytes().all(|c| c == b'-' || c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            && parts[2].starts_with('4') && matches!(parts[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b')
    }

    #[tokio::test]
    async fn nodes_without_operations_and_rooms_never_get_an_operation_id() {
        let node = fake(AuthMode::Local, happy());
        spend_advance(&node.state, true).await.unwrap();
        do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap();
        let (routes, _) = ops_node();
        let ops = fake(AuthMode::Local, routes);
        spend_advance(&ops.state, true).await.unwrap();
        // Even a charge that could carry one: the room body never does.
        let (auth, plan) = plan_message(&ops.state, ROOM, true, 13000, None).unwrap();
        let mut body = act::compose_body(ROOM, true, "hi").unwrap();
        body["max_total_msat"] = serde_json::json!(13000);
        body["max_recipient_msat"] = serde_json::json!({A: 7000, C: 6000});
        let charge = Charge { target: ROOM.into(), room: true, confirm: plan.confirm, readmission_possible: false, confirmed: false, operation: true };
        money_post(&ops.state, auth, "/messages/compose", body, 13000, Some(charge)).await.unwrap();
        assert_eq!(op_ids(&node), [None]);
        assert_eq!(op_ids(&ops), [None], "genome refuses operation_id for rooms (slice 4)");
    }

    #[tokio::test]
    async fn crash_after_post_before_response_reconciles_by_operation_without_resending() {
        for (end, says) in [("acked", "Accepted"), ("sent", "Sent")] {
            let (node, ops) = ops_fake(|n| n.script = vec![(end, true)]);
            spend_advance(&node.state, true).await.unwrap();
            assert_eq!(do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err().code, "spend_unknown");
            let id = pending(&node).unwrap().operation_id.expect("journaled before the POST");
            // Still fenced, and nothing is re-sent on its own.
            assert_eq!(do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err().code, "spend_unknown");
            let restarted = reopen(&node);
            let done = do_spend_reconcile(&restarted).await.unwrap();
            assert!(done.starts_with(says), "{done}");
            assert_eq!(gets(&node), [format!("GET /messages/operations/{id}")]);
            assert!(pending(&node).is_none());
            assert_eq!(book(&node).last().map(|e| (e.1, e.2)), Some((2000, true)), "accounted once, settled");
            assert_eq!(op_ids(&node), [Some(id)], "one POST");
            assert_eq!(ops.lock().unwrap().pays, 1, "zero duplicate sends");
        }
    }

    #[tokio::test]
    async fn unresolved_payment_stays_fenced_and_is_named_payment_unknown() {
        let (node, ops) = ops_fake(|n| n.script = vec![("payment_unknown", true)]);
        spend_advance(&node.state, true).await.unwrap();
        assert_eq!(do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err().code, "spend_unknown");
        let record = pending(&node).unwrap();
        for _ in 0..2 {
            let err = do_spend_reconcile(&reopen(&node)).await.unwrap_err();
            assert_eq!(err.code, "payment_unknown");
            assert_eq!(err.pending_id.as_deref(), Some(record.id.as_str()));
        }
        assert_eq!(serde_json::to_value(pending(&node).unwrap()).unwrap(), serde_json::to_value(&record).unwrap());
        assert_eq!(do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err().code, "spend_unknown");
        assert_eq!(compose_bodies(&node).len(), 1);
        // The node later resolves it: the same id reconciles, still no resend.
        ops.lock().unwrap().ops.values_mut().for_each(|op| op.1 = "acked");
        assert!(do_spend_reconcile(&node.state).await.unwrap().starts_with("Accepted"));
        assert_eq!((compose_bodies(&node).len(), ops.lock().unwrap().pays), (1, 1));
    }

    #[tokio::test]
    async fn nothing_paid_resend_reuses_the_same_operation_id() {
        // Never reached the handler (404), or recorded but never paid (prepared).
        for drop_first in [true, false] {
            let (node, ops) = ops_fake(|n| if drop_first { n.drop_next = true } else { n.script = vec![("prepared", true)] });
            spend_advance(&node.state, true).await.unwrap();
            assert_eq!(do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err().code, "spend_unknown");
            let id = pending(&node).unwrap().operation_id.unwrap();
            assert_eq!(do_spend_reconcile(&reopen(&node)).await.unwrap(), NOTHING_PAID);
            let record = pending(&node).unwrap();
            assert!(record.resumable && !record.budgeted);
            assert!(book(&node).iter().all(|e| !e.2), "reservation released, nothing settled");
            let receipt = do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap();
            assert!(receipt.accepted);
            assert_eq!(op_ids(&node), [Some(id.clone()), Some(id)], "the resend reuses the id");
            assert!(pending(&node).is_none());
            assert_eq!(ops.lock().unwrap().pays, 1);
        }
    }

    /// Real-UI 10b: the app is killed mid-send, the node restarts and reports
    /// the operation `prepared` (nothing paid), and the owner sends the same
    /// message again. The contact now asks for admission again and the node
    /// refuses it under the cap. That is said as it is, not as a price change;
    /// the record stays resumable under the same id; nothing is paid, ever twice.
    #[tokio::test]
    async fn resend_after_restart_refused_for_capped_readmission_is_named_and_stays_resumable() {
        let (node, ops) = ops_fake(|n| n.script = vec![("prepared", true)]);
        spend_advance(&node.state, true).await.unwrap();
        assert_eq!(do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err().code, "spend_unknown");
        let id = pending(&node).unwrap().operation_id.unwrap();
        let restarted = reopen(&node);
        assert_eq!(do_spend_reconcile(&restarted).await.unwrap(), NOTHING_PAID);
        ops.lock().unwrap().readmission_capped = true;
        // First refusal carries genome's reason code, the second an older node's wording only.
        for _ in 0..2 {
            let err = do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err();
            assert_eq!(err.code, "readmission_capped", "{}", err.message);
            assert!(err.message.starts_with("Not sent - nothing was paid."), "{}", err.message);
            let record = pending(&node).unwrap();
            assert!(record.resumable && !record.budgeted, "still resumable, reservation released");
            assert_eq!(record.operation_id.as_deref(), Some(id.as_str()));
        }
        let bodies = compose_bodies(&node);
        assert!(bodies[1..].iter().all(|b| b["max_total_msat"] == 14000), "the normal all-in cap, not a #53 zero cap");
        assert_eq!(op_ids(&node), vec![Some(id.clone()); 3], "every resend reuses the id");
        assert!(book(&node).iter().all(|e| !e.2), "nothing settled");
        assert_eq!(ops.lock().unwrap().readmission_refusals, 2, "coded, then legacy");
        assert_eq!(ops.lock().unwrap().pays, 0);
        // Once the connection is paid for again, the same resend pays exactly once.
        ops.lock().unwrap().readmission_capped = false;
        assert!(do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap().accepted);
        assert_eq!(op_ids(&node).last().unwrap().as_deref(), Some(id.as_str()));
        assert!(pending(&node).is_none());
        assert_eq!(ops.lock().unwrap().pays, 1);
    }

    #[tokio::test]
    async fn a_different_message_replaces_a_record_that_holds_no_payment() {
        let (node, ops) = ops_fake(|n| n.drop_next = true);
        spend_advance(&node.state, true).await.unwrap();
        do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err();
        do_spend_reconcile(&node.state).await.unwrap();
        do_message_send(&node.state, A, false, "something else", 14000, None).await.unwrap();
        let ids = op_ids(&node);
        assert_ne!(ids[0], ids[1], "a different message is a different operation");
        assert_eq!(ops.lock().unwrap().pays, 1);
    }

    #[tokio::test]
    async fn changed_plaintext_under_a_reused_id_is_refused_and_surfaced() {
        let (node, ops) = ops_fake(|n| n.script = vec![("prepared", true)]);
        spend_advance(&node.state, true).await.unwrap();
        do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err();
        do_spend_reconcile(&node.state).await.unwrap();
        // The saved fingerprint says this is the same message; the node knows better.
        let journal = spend_journal(&node.state).unwrap();
        let mut record = journal.pending().unwrap().unwrap();
        record.op = Some(spend_journal::operation(&act::compose_body(A, false, "edited").unwrap()));
        journal.save(&record).unwrap();
        drop(journal);
        let before = book(&node);
        let err = do_message_send(&node.state, A, false, "edited", 14000, None).await.unwrap_err();
        assert_eq!(err.code, "operation_mismatch");
        assert!(err.message.contains("Nothing was paid"), "{}", err.message);
        assert_eq!(serde_json::to_value(pending(&node).unwrap()).unwrap(), serde_json::to_value(&record).unwrap(), "record restored");
        assert!(book(&node).iter().skip(before.len()).all(|e| !e.2), "no settlement for the refused call");
        let ids = op_ids(&node);
        assert_eq!(ids[0], ids[1]);
        assert_eq!(ops.lock().unwrap().pays, 0);
    }

    #[tokio::test]
    async fn paid_undelivered_retry_reuses_the_operation_at_zero_cap() {
        let (node, ops) = ops_fake(|n| { n.script = vec![("paid", false)]; n.settled_incomplete = true; });
        spend_advance(&node.state, true).await.unwrap();
        let err = do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err();
        assert_eq!(err.code, "payment_settled_undelivered");
        assert!(err.undelivered.unwrap().retry, "the node holds it paid: retry re-sends");
        let record = pending(&node).unwrap();
        assert_eq!(record.undelivered.as_ref().unwrap().payment_hash.as_deref(), Some(OP_HASH));
        let receipt = do_message_retry(&node.state, A, "gm", None).await.unwrap();
        assert_eq!((receipt.accepted, receipt.amount_msat, receipt.max_routing_fee_msat), (true, 0, 0), "this call paid nothing");
        let bodies = compose_bodies(&node);
        assert_eq!(bodies[1]["max_total_msat"], 0, "#53 zero-cap retry");
        assert_eq!(bodies[0]["operation_id"], bodies[1]["operation_id"]);
        assert!(pending(&node).is_none());
        assert_eq!(ops.lock().unwrap().pays, 1);
    }

    /// The `nth` compose stays open at the node until the test releases it.
    /// `open_at_lookup` records, per `GET /messages/operations/{id}`, whether
    /// that compose was still open when the lookup arrived.
    struct Hold {
        arrived: Arc<std::sync::atomic::AtomicBool>,
        release: std::sync::mpsc::Sender<()>,
        open_at_lookup: Arc<Mutex<Vec<bool>>>,
    }

    /// `answer` replaces the node's own reply; `lose` loses it after the node
    /// handled the compose (the client's `spend_timeout` fires first).
    fn hold_compose(inner: Routes, nth: usize, answer: Option<(u16, String)>, lose: bool) -> (Routes, Hold) {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        let (arrived, open, count) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)), AtomicUsize::new(0));
        let open_at_lookup = Arc::new(Mutex::new(Vec::new()));
        let (a, o, seen) = (arrived.clone(), open.clone(), open_at_lookup.clone());
        let routes: Routes = Arc::new(move |m, p, b| {
            if p.starts_with("/messages/operations/") { seen.lock().unwrap().push(o.load(SeqCst)); }
            if p != "/messages/compose" || count.fetch_add(1, SeqCst) != nth { return inner(m, p, b); }
            o.store(true, SeqCst);
            a.store(true, SeqCst);
            gate.lock().unwrap().recv_timeout(Duration::from_secs(10)).expect("the test releases the compose");
            let reply = answer.clone().unwrap_or_else(|| inner(m, p, b));
            o.store(false, SeqCst);
            if lose { std::thread::sleep(Duration::from_millis(1500)); }
            reply
        });
        (routes, Hold { arrived, release, open_at_lookup })
    }

    /// Runs `action`; while its compose is open at the node the owner taps
    /// "check the pending result", and the compose is released a little later.
    async fn reconcile_during<T>(node: &Fake, hold: &Hold, action: impl std::future::Future<Output = T>) -> (T, Result<String, ActionError>) {
        let reconcile = async {
            while !hold.arrived.load(std::sync::atomic::Ordering::SeqCst) { tokio::time::sleep(Duration::from_millis(5)).await; }
            assert!(node.state.money.try_lock().is_err(), "the in-flight action holds the money lock");
            let (done, ()) = tokio::join!(do_spend_reconcile(&node.state), async {
                tokio::time::sleep(Duration::from_millis(150)).await;
                hold.release.send(()).unwrap();
            });
            done
        };
        let both = tokio::time::timeout(Duration::from_secs(10), async { tokio::join!(action, reconcile) }).await.expect("no deadlock");
        assert!(node.state.money.try_lock().is_ok(), "the lock is free afterwards");
        assert!(hold.open_at_lookup.lock().unwrap().iter().all(|open| !open), "no lookup while the POST was open");
        both
    }

    fn settled(node: &Fake) -> Vec<u64> {
        book(node).into_iter().filter(|e| e.2).map(|e| e.1).collect()
    }

    #[tokio::test]
    async fn reconcile_during_an_in_flight_send_waits_and_accounts_it_once() {
        for lose in [false, true] {
            let (routes, ops) = ops_node();
            let (routes, hold) = hold_compose(routes, 0, None, lose);
            let mut node = fake(AuthMode::Local, routes);
            node.state.spend_timeout = Duration::from_secs(1);
            spend_advance(&node.state, true).await.unwrap();
            let (sent, reconciled) = reconcile_during(&node, &hold, do_message_send(&node.state, A, false, "gm", 14000, None)).await;
            if lose {
                assert_eq!(sent.unwrap_err().code, "spend_unknown");
                let done = reconciled.unwrap();
                assert!(done.starts_with("Accepted"), "{done}");
                assert_eq!(gets(&node).len(), 1, "looked up after the POST ended");
            } else {
                assert!(sent.unwrap().accepted);
                assert_eq!(reconciled.unwrap(), "No pending spend.");
                assert!(gets(&node).is_empty());
            }
            assert!(pending(&node).is_none());
            assert_eq!(settled(&node), [2000], "accounted once");
            assert!(book(&node).iter().all(|e| e.2), "no reservation left open");
            assert_eq!((compose_bodies(&node).len(), ops.lock().unwrap().pays), (1, 1));
        }
    }

    #[tokio::test]
    async fn reconcile_during_an_in_flight_zero_cap_retry_waits_and_leaks_no_reservation() {
        let (routes, ops) = ops_node();
        { let mut n = ops.lock().unwrap(); n.script = vec![("paid", false)]; n.settled_incomplete = true; }
        let (routes, hold) = hold_compose(routes, 1, None, false);
        let mut node = fake(AuthMode::Local, routes);
        node.state.spend_timeout = Duration::from_secs(1);
        let record = psi_first(&node).await;
        let (retried, reconciled) = reconcile_during(&node, &hold, do_message_retry(&node.state, A, "gm", None)).await;
        let receipt = retried.unwrap();
        assert_eq!((receipt.accepted, receipt.amount_msat), (true, 0), "#53: the retry paid nothing");
        assert_eq!(reconciled.unwrap(), "No pending spend.");
        assert!(pending(&node).is_none());
        assert_eq!(compose_bodies(&node)[1]["max_total_msat"], 0);
        assert_eq!(book(&node).last().cloned(), Some((format!("{}-retry-1", record.request_hash), 0, true)), "retry reservation closed");
        assert!(book(&node).iter().all(|e| e.2));
        assert_eq!(ops.lock().unwrap().pays, 1);
    }

    #[tokio::test]
    async fn readiness_refusal_under_the_money_lock_frees_it_for_reconcile() {
        let refusal = (503, serde_json::json!({"code":"not_ready","money_ready":false,"error":"offline"}).to_string());
        // A fresh send (#56): nothing pending afterwards.
        let (routes, _) = ops_node();
        let (routes, hold) = hold_compose(routes, 0, Some(refusal.clone()), false);
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        let (sent, reconciled) = reconcile_during(&node, &hold, do_message_send(&node.state, A, false, "gm", 14000, None)).await;
        assert_eq!(sent.unwrap_err().code, "not_ready");
        assert_eq!(reconciled.unwrap(), "No pending spend.");
        assert!(pending(&node).is_none());
        // A zero-cap retry (#53 + #56): the paid record is restored, then retried.
        let (routes, ops) = ops_node();
        { let mut n = ops.lock().unwrap(); n.script = vec![("paid", false)]; n.settled_incomplete = true; }
        let (routes, hold) = hold_compose(routes, 1, Some(refusal), false);
        let node = fake(AuthMode::Local, routes);
        let record = psi_first(&node).await;
        let (retried, reconciled) = reconcile_during(&node, &hold, do_message_retry(&node.state, A, "gm", None)).await;
        assert_eq!(retried.unwrap_err().code, "not_ready");
        assert_eq!(reconciled.unwrap_err().code, "undelivered_pending");
        assert_eq!(serde_json::to_value(pending(&node).unwrap()).unwrap(), serde_json::to_value(&record).unwrap());
        assert!(do_message_retry(&node.state, A, "gm", None).await.unwrap().accepted);
        assert_eq!(ops.lock().unwrap().pays, 1);
    }

    #[tokio::test]
    async fn reconcile_never_saves_over_a_record_that_changed_during_the_lookup() {
        // Replaced by another action, or a retry that ended meanwhile.
        for replaced in [true, false] {
            let (node, _) = ops_fake(|n| { n.script = vec![("paid", false)]; n.settled_incomplete = true; });
            let record = psi_first(&node).await;
            let id = record.operation_id.clone().unwrap();
            let journal = spend_journal(&node.state).unwrap();
            let mut seen = record.clone();
            if replaced { seen.id = "an-earlier-record".into(); } else { seen.undelivered.as_mut().unwrap().in_flight = true; }
            let err = reconcile_operation(&node.state, &journal, seen, &id).await.unwrap_err();
            drop(journal);
            assert_eq!(err.code, "spend_unknown", "{}", err.message);
            assert_eq!(serde_json::to_value(pending(&node).unwrap()).unwrap(), serde_json::to_value(&record).unwrap(), "left as it is");
        }
    }

    #[tokio::test]
    async fn restart_with_a_paid_operation_offers_the_same_id_retry_never_a_fresh_send() {
        let (node, ops) = ops_fake(|n| n.script = vec![("paid", true)]);
        spend_advance(&node.state, true).await.unwrap();
        do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err();
        let restarted = reopen(&node);
        let err = do_spend_reconcile(&restarted).await.unwrap_err();
        assert_eq!(err.code, "undelivered_pending");
        let record = pending(&node).unwrap();
        let u = record.undelivered.clone().unwrap();
        assert_eq!((u.peer.as_str(), u.paid_msat, u.retry, u.in_flight), (A, 2000, true, false));
        assert_eq!(book(&node).last().map(|e| (e.1, e.2)), Some((2000, true)));
        // A fresh send stays fenced; the retry reuses the id and pays nothing.
        spend_advance(&restarted, true).await.unwrap();
        assert_eq!(do_message_send(&restarted, A, false, "gm", 14000, None).await.unwrap_err().code, "spend_unknown");
        assert_eq!(do_message_retry(&restarted, A, "other text", None).await.unwrap_err().code, "retry_unavailable");
        let receipt = do_message_retry(&restarted, A, "gm", None).await.unwrap();
        assert_eq!((receipt.accepted, receipt.amount_msat), (true, 0));
        let ids = op_ids(&node);
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[0], ids[1]);
        assert_eq!(ops.lock().unwrap().pays, 1, "zero duplicate sends");
    }

    #[tokio::test]
    async fn a_lost_retry_reply_reconciles_by_the_same_operation() {
        let (node, ops) = ops_fake(|n| { n.script = vec![("paid", false)]; n.settled_incomplete = true; });
        spend_advance(&node.state, true).await.unwrap();
        do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err();
        let id = pending(&node).unwrap().operation_id.unwrap();
        // The retry reaches the node (it re-sends, acked) but its reply is lost.
        ops.lock().unwrap().drop_next = true;
        ops.lock().unwrap().ops.get_mut(&id).unwrap().1 = "acked";
        assert_eq!(do_message_retry(&node.state, A, "gm", None).await.unwrap_err().code, "spend_unknown");
        assert!(pending(&node).unwrap().undelivered.unwrap().in_flight);
        let done = do_spend_reconcile(&reopen(&node)).await.unwrap();
        assert!(done.starts_with("Accepted"), "{done}");
        assert!(pending(&node).is_none());
        assert_eq!(op_ids(&node), [Some(id.clone()), Some(id)]);
        assert_eq!(ops.lock().unwrap().pays, 1);
    }

    #[tokio::test]
    async fn failed_paid_is_terminal_accounted_and_never_resent() {
        let (node, ops) = ops_fake(|n| n.script = vec![("failed_paid", true)]);
        spend_advance(&node.state, true).await.unwrap();
        do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err();
        assert_eq!(do_spend_reconcile(&node.state).await.unwrap_err().code, "failed_paid");
        assert!(pending(&node).is_none());
        assert_eq!(book(&node).last().map(|e| (e.1, e.2)), Some((2000, true)));
        assert_eq!((compose_bodies(&node).len(), ops.lock().unwrap().pays), (1, 1));
    }

    // Genome a400629 compose::readmit_then_pay refuses every capped reconnect
    // readmission. Keep this refusal fenced; do not "fix" it by dropping the cap.
    #[tokio::test]
    async fn psi_capped_reconnect_refusal_keeps_the_same_recoverable_journal() {
        let node = fake(AuthMode::Local, compose_script(vec![
            psi_502(2000, 0, 2000, PSI_TIMEOUT), cap_refusal(), cap_refusal(), cap_refusal(),
        ]));
        let original = psi_first(&node).await;
        assert_eq!(do_message_retry(&node.state, A, "gm", None).await.unwrap_err().code, "retry_needs_admission");
        for cap in [14000, 50000] {
            assert_eq!(do_message_retry(&node.state, A, "gm", Some(cap)).await.unwrap_err().code, "price_cap_exceeded");
            assert_eq!(pending(&node).unwrap().id, original.id);
            assert_eq!(pending(&node).unwrap().undelivered, original.undelivered);
        }
        assert_eq!(compose_bodies(&node).iter().map(|b| b["max_total_msat"].as_u64().unwrap()).collect::<Vec<_>>(), [14000, 0, 14000, 50000]);
        assert_eq!(book(&node).len(), 1);
        assert_eq!(do_spend_reconcile(&node.state).await.unwrap_err().code, "undelivered_pending");
        do_spend_dismiss_undelivered(&node.state, &original.id).unwrap();
    }

    /// #53 Retry delivery when the contact asks for admission again: no cap can
    /// pay it yet, so the app says so instead of asking for an approval that
    /// the node would refuse the same way. The paid record is untouched.
    #[tokio::test]
    async fn psi_retry_refused_for_capped_readmission_does_not_ask_for_approval() {
        let node = fake(AuthMode::Local, compose_script(vec![
            psi_502(2000, 0, 2000, PSI_TIMEOUT), readmission_coded_reply(), readmission_capped_reply(),
        ]));
        let original = psi_first(&node).await;
        for approved in [None, Some(14000)] {
            let err = do_message_retry(&node.state, A, "gm", approved).await.unwrap_err();
            assert_eq!(err.code, "readmission_capped", "{approved:?}");
            assert!(err.message.starts_with("Not delivered - nothing new was paid."), "{}", err.message);
            assert_eq!(pending(&node).unwrap().id, original.id);
            assert_eq!(pending(&node).unwrap().undelivered, original.undelivered);
        }
        assert_eq!(book(&node).len(), 1);
    }

    #[tokio::test]
    async fn psi_paired_approved_retry_renews_the_consumed_contact_authorization() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        *g1.quote.lock().unwrap() = Some(serde_json::json!({"recipient": A,
            "admission_msat": 2000, "message_msat": 2000, "max_routing_fee_msat": 10000,
            "total_msat": 14000, "expires_at": now_unix() + 60}));
        *g1.first_contact.lock().unwrap() = Some((200, serde_json::json!({
            "recipient": A, "max_total_msat": 14000, "expires_at": now_unix() + 120,
        })));
        g1_approved(&node, 500_000).await;
        owner_approves_contact(&node, A, 14000, Some(100000)).await;
        let (status, reply) = psi_502(2000, 0, 2000, PSI_TIMEOUT);
        *g1.compose.lock().unwrap() = Some((status, serde_json::from_str(&reply).unwrap()));
        assert_eq!(do_message_send_with(&node.state, A, false, "gm", 14000, None, Some(100000)).await.unwrap_err().code, "payment_settled_undelivered");
        let original = pending(&node).unwrap();
        assert!(node.state.owner_contact.lock().unwrap().is_none());
        let (status, reply) = delivered("renewed", 2000);
        *g1.compose.lock().unwrap() = Some((status, serde_json::from_str(&reply).unwrap()));
        assert_eq!(do_message_retry(&node.state, A, "gm", Some(14000)).await.unwrap_err().code, "owner_only");
        assert_eq!(compose_bodies(&node).len(), 1, "no compose without renewed owner approval");
        assert_eq!(pending(&node).unwrap().id, original.id);
        g1.grant.lock().unwrap()["per_recipient_msat"][A] = serde_json::json!(100000);
        let renewed = owner_approves_contact(&node, A, 14000, None).await;
        assert_eq!(renewed.request.contact_budget_msat, 100000);
        assert_eq!(renewed.request.max_total_msat, 14000);
        do_message_retry(&node.state, A, "gm", Some(14000)).await.unwrap();
        assert!(node.state.owner_contact.lock().unwrap().is_none());
        assert_eq!(compose_bodies(&node)[1]["max_total_msat"], 14000);
        assert!(pending(&node).is_none());
    }

    #[tokio::test]
    async fn psi_identical_later_send_rejects_stale_dismissal() {
        let node = fake(AuthMode::Local, compose_script(vec![
            psi_502(2000, 0, 2000, PSI_TIMEOUT), psi_502(2000, 0, 2000, PSI_TIMEOUT),
        ]));
        psi_first(&node).await;
        let first = do_spend_reconcile(&node.state).await.unwrap_err().pending_id.unwrap();
        do_spend_dismiss_undelivered(&node.state, &first).unwrap();
        psi_first(&node).await;
        let second = do_spend_reconcile(&node.state).await.unwrap_err().pending_id.unwrap();
        assert_ne!(first, second, "each send needs its own durable dismissal identity");
        let after = reopen(&node);
        assert_eq!(do_spend_dismiss_undelivered(&after, &first).unwrap_err().code, "retry_unavailable");
        assert!(pending(&node).is_some());
        do_spend_dismiss_undelivered(&after, &second).unwrap();
        assert_eq!(compose_bodies(&node).len(), 2);
    }

    #[tokio::test]
    async fn psi_aged_retry_refusal_keeps_rollback_accounting() {
        for recover_by_retry in [false, true] {
            let node = fake(AuthMode::Local, compose_script(vec![
                psi_502(2000, 0, 2000, PSI_TIMEOUT), psi_502(0, 2000, 0, PSI_TIMEOUT),
                cap_refusal(), delivered("recovered", 2000),
            ]));
            psi_first(&node).await;
            assert_eq!(do_message_retry(&node.state, A, "gm", None).await.unwrap_err().code, "payment_settled_undelivered");
            let prior = pending(&node).unwrap();
            with_book(&node.state, true, |b| {
                for e in &mut b.ledger { e.at_ms = now_ms() - 2 * budget::DAY_MS; }
                Ok(())
            }).unwrap();
            assert_eq!(do_message_retry(&node.state, A, "gm", None).await.unwrap_err().code, "retry_needs_admission");
            assert_eq!(pending(&node).unwrap().charge_id(), prior.charge_id());
            assert!(book(&node).iter().any(|(id, _, _)| id == prior.charge_id()), "rollback accounting survives reservation pruning");
            let after = reopen(&node);
            let checked = do_spend_reconcile(&after).await.unwrap_err();
            assert_eq!(checked.code, "undelivered_pending");
            if recover_by_retry {
                spend_advance(&after, true).await.unwrap();
                do_message_retry(&after, A, "gm", Some(14000)).await.unwrap();
            } else {
                do_spend_dismiss_undelivered(&after, &checked.pending_id.unwrap()).unwrap();
            }
            assert!(pending(&node).is_none());
        }
    }

    #[tokio::test]
    async fn psi_approved_fresh_admission_uses_the_node_all_in_quote_once() {
        let calls = Arc::new(Mutex::new(0));
        let count = calls.clone();
        let routes: Routes = Arc::new(move |m, p, b| {
            if p == "/status" {
                return (200, serde_json::json!({"api_capabilities": ["paid_send_caps_v1", "first_contact_grant_v1"]}).to_string());
            }
            if p == "/messages/first-contact/quote" {
                return (200, serde_json::json!({"recipient": A, "admission_msat": 2000,
                    "message_msat": 2000, "max_routing_fee_msat": 10000,
                    "total_msat": 14000, "expires_at": now_unix()+60}).to_string());
            }
            if p != "/messages/compose" { return happy()(m, p, b); }
            let mut n = count.lock().unwrap();
            *n += 1;
            if *n == 1 { return psi_502(2000, 0, 2000, PSI_TIMEOUT); }
            let body: serde_json::Value = serde_json::from_str(b).unwrap();
            // Genome e3c0633: two 2,000-msat principals, each with a 5,000-msat fee ceiling.
            if body["max_total_msat"].as_u64().unwrap() < 14000 { return cap_refusal(); }
            (200, serde_json::json!({"message_id": "m2", "delivered": true,
                "amount_msat": 4000, "max_routing_fee_msat": 10000}).to_string())
        });
        let node = fake(AuthMode::Local, routes);
        let record = psi_first(&node).await;
        let err = do_message_retry(&node.state, A, "gm", None).await.unwrap_err();
        assert_eq!(err.code, "retry_needs_admission");
        let quote = err.admission.unwrap();
        assert!(quote.quoted);
        assert_eq!(quote.total_msat, 14000);
        assert_eq!(serde_json::to_value(quote).unwrap()["max_routing_fee_msat"], 10000);
        assert_eq!(compose_bodies(&node)[1]["max_total_msat"], 0);
        assert_eq!(pending(&node).unwrap().undelivered, record.undelivered);
        assert_eq!(book(&node), [(record.request_hash.clone(), 14000, true)]);
        let receipt = do_message_retry(&node.state, A, "gm", Some(quote.total_msat)).await.unwrap();
        assert_eq!((receipt.total_msat, receipt.max_routing_fee_msat), (14000, 10000));
        assert!(pending(&node).is_none());
        assert_eq!(book(&node), [(record.request_hash.clone(), 14000, true),
            (format!("{}-retry-1", record.request_hash), 14000, true)]);
        assert_eq!(do_message_retry(&node.state, A, "gm", Some(quote.total_msat)).await.unwrap_err().code, "retry_unavailable");
        assert_eq!(*calls.lock().unwrap(), 3, "one initial send, one no-pay probe, one approved send");
    }

    #[tokio::test]
    async fn psi_missing_fees_keep_the_all_in_allowance_after_restart_and_dismissal() {
        let node = fake(AuthMode::Local, compose_script(vec![psi_502(2000, 0, 2000, PSI_TIMEOUT), cap_refusal()]));
        let record = psi_first(&node).await;
        assert_eq!(record.accounting_msat, Some(14000), "missing fees retain the approved allowance");
        assert_eq!(record.undelivered.as_ref().unwrap().paid_msat, 2000, "display only known settled principal");
        assert_eq!(do_message_retry(&node.state, A, "gm", None).await.unwrap_err().code, "retry_needs_admission");
        assert_eq!(book(&node), [(record.request_hash.clone(), 14000, true)], "the no-pay probe adds nothing");
        let after = reopen(&node);
        assert_eq!(do_spend_reconcile(&after).await.unwrap_err().code, "undelivered_pending");
        do_spend_dismiss_undelivered(&after, &record.id).unwrap();
        assert_eq!(budget_now(&after).spent_msat, 14000, "stopping retries does not release unknown fees");
        assert!(pending(&node).is_none());
        assert_eq!(compose_bodies(&node).len(), 2, "reconcile and dismissal do not dispatch");
    }

    #[tokio::test]
    async fn psi_positive_settlement_under_zero_cap_stays_fenced() {
        for reply in [psi_502(1, 2000, 1, PSI_TIMEOUT), delivered("bad-node", 1)] {
            let node = fake(AuthMode::Local, compose_script(vec![psi_502(2000, 0, 2000, PSI_TIMEOUT), reply]));
            let record = psi_first(&node).await;
            assert_eq!(do_message_retry(&node.state, A, "gm", None).await.unwrap_err().code, "spend_unknown");
            assert_eq!(compose_bodies(&node)[1]["max_total_msat"], 0);
            assert!(pending(&node).unwrap().over_budget);
            assert_eq!(do_spend_reconcile(&node.state).await.unwrap_err().code, "spend_unknown");
            assert!(do_spend_dismiss_undelivered(&node.state, &record.id).is_err());
            assert!(do_message_retry(&node.state, A, "gm", Some(14000)).await.is_err());
            assert_eq!(compose_bodies(&node).len(), 2);
        }
    }

    #[tokio::test]
    async fn psi_settled_undelivered_is_paid_not_unknown_and_keeps_the_fence() {
        let node = fake(AuthMode::Local, compose_script(vec![psi_502(2000, 0, 2000, PSI_TIMEOUT)]));
        spend_advance(&node.state, true).await.unwrap();
        let err = do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err();
        assert_eq!(err.code, "payment_settled_undelivered");
        assert_eq!(err.undelivered, Some(act::UndeliveredView { paid_msat: 2000, retry: true }));
        assert!(err.message.contains("Do not send it again"), "{}", err.message);
        let record = pending(&node).expect("the fence stays");
        let u = record.undelivered.clone().unwrap();
        assert_eq!((u.peer.as_str(), u.paid_msat, u.retry, u.admission_msat, u.in_flight, u.attempts), (A, 2000, true, 2000, false, 0));
        assert_eq!(u.op, spend_journal::operation(&act::compose_body(A, false, "gm").unwrap()), "bound to this message and contact");
        assert_eq!(record.accounting_msat, Some(14000));
        assert_eq!(book(&node), [(record.request_hash.clone(), 14000, true)], "the book retains the all-in allowance when fees are unknown");
        // No automatic new payment: an ordinary send is still fenced.
        assert_eq!(do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err().code, "spend_unknown");
        assert_eq!(compose_bodies(&node).len(), 1);
    }

    /// Codex review of 2d683b5 (P1): accounting must not erase the undelivered
    /// record. Reconciliation settles the book and keeps the record, the retry
    /// and the fence; only the owner stopping retries releases it.
    #[tokio::test]
    async fn psi_reconciliation_accounts_but_never_erases_the_undelivered_record() {
        let node = fake(AuthMode::Local, compose_script(vec![psi_502(2000, 0, 2000, PSI_TIMEOUT), delivered("m9", 2000)]));
        let record = psi_first(&node).await;
        for _ in 0..2 {
            let err = do_spend_reconcile(&node.state).await.unwrap_err();
            assert_eq!(err.code, "undelivered_pending", "{}", err.message);
            assert_eq!(err.pending_id.as_deref(), Some(record.id.as_str()), "names the record it shows");
            assert!(err.message.contains("Nothing was dispatched again") && err.message.contains("still not delivered"), "{}", err.message);
        }
        assert_eq!(pending(&node).unwrap().undelivered, record.undelivered, "the record survives reconciliation");
        assert_eq!(book(&node), [(record.request_hash.clone(), 14000, true)], "settled once, not twice");
        // Still fenced; the retry is still there.
        assert_eq!(do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err().code, "spend_unknown");
        assert_eq!(compose_bodies(&node).len(), 1);

        // The owner stops retrying: released, accounted, nothing dispatched.
        // A stale or foreign identity releases nothing.
        assert_eq!(do_spend_dismiss_undelivered(&node.state, "another-record").unwrap_err().code, "retry_unavailable");
        assert!(pending(&node).is_some());
        let done = do_spend_dismiss_undelivered(&node.state, &record.id).unwrap();
        assert!(done.contains("2000 msat was paid") && done.contains("nothing more will be paid"), "{done}");
        assert!(pending(&node).is_none());
        assert_eq!(do_message_retry(&node.state, A, "gm", None).await.unwrap_err().code, "retry_unavailable");
        assert_eq!(compose_bodies(&node).len(), 1);
        assert_eq!(do_spend_dismiss_undelivered(&node.state, &record.id).unwrap_err().code, "retry_unavailable");
        // Sending anew is a normal, approved send.
        assert_eq!(do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap().message_id, "m9");
    }

    fn cap_refusal() -> (u16, String) {
        (409, serde_json::json!({"error": "required 3000 msat exceeds the confirmed cap", "code": "price_cap_exceeded"}).to_string())
    }

    /// Genome #100's compose, reduced to what decides whether a capped call
    /// pays (compose.rs at 900a69a): with no session and the paid proof
    /// consumed on an earlier connection, the node takes a fresh quote and pays
    /// admission + message + one routing-fee ceiling each if that fits the cap;
    /// with the proof still deliverable it re-sends it (paying nothing), the
    /// session forms, and the message pays if its all-in price fits. Every
    /// check runs before dispatch.
    fn genome_compose(consumed: bool, admission: u64, message: u64, fee_ceiling: u64) -> Routes {
        let session = Arc::new(Mutex::new(false));
        Arc::new(move |m: &str, p: &str, b: &str| {
            if p != "/messages/compose" { return happy()(m, p, b); }
            let cap = serde_json::from_str::<serde_json::Value>(b).unwrap()["max_total_msat"].as_u64();
            let fits = |total: u64| cap.is_none_or(|c| total <= c);
            let mut session = session.lock().unwrap();
            if consumed && !*session {
                if !fits(admission + fee_ceiling + message + fee_ceiling) { return cap_refusal(); }
                *session = true;
                return delivered("m-admitted", admission + message);
            }
            *session = true;
            if !fits(message + fee_ceiling) { return cap_refusal(); }
            delivered("m-delivered", message)
        })
    }

    /// Codex review of 0308673 (P1), the reviewer's scenario: a cached message
    /// price of 50,000 msat, the paid proof consumed on an earlier connection,
    /// and a much lower fresh quote (1,000 admission + 1,000 message + two
    /// 5,000 fee ceilings = 12,000). A message-price cap would let the node buy
    /// that admission unapproved. Retry delivery sends a zero cap: the node
    /// refuses before paying, and the owner is shown the price and approves it.
    #[tokio::test]
    async fn psi_retry_delivery_never_buys_an_admission_when_the_fresh_price_falls() {
        // The model itself: under the old message-price cap the node would pay.
        let model = genome_compose(true, 1000, 1000, 5000);
        assert_eq!(model("POST", "/messages/compose", r#"{"max_total_msat":50000}"#).0, 200, "the reviewer's route is real");

        let first = Arc::new(Mutex::new(Some(psi_502(2000, 0, 2000, PSI_TIMEOUT))));
        let genome = genome_compose(true, 1000, 1000, 5000);
        let routes: Routes = Arc::new(move |m: &str, p: &str, b: &str| {
            // The price the retry sees: 50,000 cached (the first send saw 2,000).
            if p == "/pricing/peers" && first.lock().unwrap().is_none() {
                return (200, serde_json::json!([{"peer_id": A, "prices": {"communication": 50_000}, "age_secs": 5, "stale": false}]).to_string());
            }
            if p == "/messages/compose" { if let Some(reply) = first.lock().unwrap().take() { return reply; } }
            genome(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        let record = psi_first(&node).await;

        let err = do_message_retry(&node.state, A, "gm", None).await.unwrap_err();
        assert_eq!(err.code, "retry_needs_admission", "{}", err.message);
        let bodies = compose_bodies(&node);
        assert_eq!(bodies[1], serde_json::json!({"recipient": A, "is_room": false, "kind": 0, "plaintext": "gm", "max_total_msat": 0}), "a zero cap: nothing can be paid");
        // Nothing paid, the record is back exactly, the fence holds.
        assert_eq!(err.admission, Some(act::AdmissionView { admission_msat: 2000, message_msat: 50_000, max_routing_fee_msat: 10000, total_msat: 62_000, quoted: false }));
        assert!(err.message.contains("Nothing was paid") && err.message.contains("up to 62000 msat"), "{}", err.message);
        assert_eq!(pending(&node).unwrap().undelivered, record.undelivered);
        assert_eq!(book(&node), [(record.request_hash.clone(), 14000, true)], "the book gained nothing");
        assert_eq!(do_message_send(&node.state, A, false, "gm", 50_000, None).await.unwrap_err().code, "spend_unknown");
        // Asking again changes nothing: still no payment.
        assert_eq!(do_message_retry(&node.state, A, "gm", None).await.unwrap_err().code, "retry_needs_admission");
        assert_eq!(book(&node).len(), 1);

        // The owner approves the shown price: the admission is paid once, as approved.
        let receipt = do_message_retry(&node.state, A, "gm", Some(62_000)).await.unwrap();
        assert_eq!((receipt.message_id.as_str(), receipt.amount_msat), ("m-admitted", 2000));
        assert_eq!(compose_bodies(&node)[3]["max_total_msat"], 62_000);
        assert!(pending(&node).is_none());
        assert_eq!(book(&node), [(record.request_hash.clone(), 14000, true), (format!("{}-retry-1", record.request_hash), 2000, true)]);
    }

    /// Genome #100, same connection (or a proof that never went out): Retry
    /// delivery re-sends the paid proof and pays nothing; the message's price
    /// is still due, so the owner approves it, and the approved retry reuses
    /// the journal record in place. Admission once, message once.
    #[tokio::test]
    async fn psi_retry_delivery_pays_nothing_and_the_approved_retry_reuses_the_record() {
        let (routes, watch, at_compose) = compose_watch(vec![psi_502(2000, 0, 2000, PSI_TIMEOUT), cap_refusal(), delivered("m2", 2000)]);
        let node = fake(AuthMode::Local, routes);
        let record = psi_first(&node).await;
        *watch.lock().unwrap() = Some(journal_file(&node));

        let err = do_message_retry(&node.state, &A.to_uppercase(), "gm", None).await.unwrap_err();
        assert_eq!(err.code, "retry_needs_admission", "{}", err.message);
        // No signed quote on this node: an estimate from the admission paid before.
        assert_eq!(err.admission, Some(act::AdmissionView { admission_msat: 2000, message_msat: 2000, max_routing_fee_msat: 10000, total_msat: 14000, quoted: false }));
        assert_eq!(compose_bodies(&node)[1]["max_total_msat"], 0);
        // Refused before paying: the prior record is back exactly, the book gained nothing.
        assert_eq!(pending(&node).unwrap().undelivered, record.undelivered);
        assert_eq!(pending(&node).unwrap().charge_id, None);
        assert_eq!(book(&node).len(), 1);

        let receipt = do_message_retry(&node.state, A, "gm", Some(14000)).await.unwrap();
        assert_eq!((receipt.message_id.as_str(), receipt.recipient.as_str(), receipt.amount_msat), ("m2", A, 2000));
        let bodies = compose_bodies(&node);
        assert_eq!(bodies.len(), 3);
        assert_eq!(bodies[2], serde_json::json!({"recipient": A, "is_room": false, "kind": 0, "plaintext": "gm", "max_total_msat": 14000}), "capped at exactly what the owner approved");
        // While each retry was on the wire the SAME record was there, in flight:
        // never removed and re-created (Codex review of 2d683b5, P2).
        let seen = at_compose.lock().unwrap().clone();
        assert_eq!(seen.len(), 2);
        for (during, n) in seen.iter().zip([1, 1]) {
            let during = during.clone().expect("the record existed during the retry");
            assert_eq!(during["request_hash"], serde_json::json!(record.request_hash));
            assert_eq!((during["undelivered"]["in_flight"].clone(), during["undelivered"]["attempts"].clone()), (serde_json::json!(true), serde_json::json!(n)));
            assert_eq!(during["charge_id"], serde_json::json!(format!("{}-retry-{n}", record.request_hash)));
        }
        assert!(pending(&node).is_none(), "delivered: the fence lifts");
        assert_eq!(book(&node), [(record.request_hash.clone(), 14000, true), (format!("{}-retry-1", record.request_hash), 2000, true)], "admission allowance once, message once");
        // Nothing left to retry: no further compose.
        assert_eq!(do_message_retry(&node.state, A, "gm", None).await.unwrap_err().code, "retry_unavailable");
        assert_eq!(do_message_retry(&node.state, A, "gm", Some(14000)).await.unwrap_err().code, "retry_unavailable", "no double pay");
        assert_eq!(compose_bodies(&node).len(), 3);
    }

    /// Retry delivery is zero-capped even when a node budget grant covers this
    /// contact (the node could otherwise re-admit from the grant). The price
    /// shown is the contact's own signed quote.
    #[tokio::test]
    async fn psi_a_budget_grant_that_could_readmit_is_never_retried_with_money() {
        let (node, _dir, g1) = g1_node(&["read", "receive", "spend"]);
        *g1.first_contact.lock().unwrap() = Some((200, serde_json::json!({})));
        *g1.compose.lock().unwrap() = Some((409, serde_json::json!({"error": "required 3000 msat exceeds the confirmed cap", "code": "price_cap_exceeded"})));
        let body = act::compose_body(A, false, "gm").unwrap();
        let journal = spend_journal(&node.state).unwrap();
        let mut record = journal.begin(OWN, "/messages/compose", &body, 4000).unwrap();
        record.accounting_msat = Some(2000);
        record.undelivered = Some(spend_journal::Undelivered {
            peer: A.into(), paid_msat: 2000, retry: true, op: spend_journal::operation(&body),
            admission_msat: 2000, in_flight: false, attempts: 0, payment_hash: None,
        });
        journal.save(&record).unwrap();
        drop(journal);
        with_book(&node.state, true, |b| {
            b.reserve(&record.request_hash, A, false, 4000, now_ms());
            b.settle(&record.request_hash, 2000, now_ms());
            Ok(())
        }).unwrap();
        let mut grant = g1_grant(3600, 400_000, 400_000);
        grant["per_recipient_msat"] = serde_json::json!({A: 100_000});
        *node.state.node_grant.lock().unwrap() = grant::parse(&serde_json::json!({"grant": grant}).to_string()).unwrap();
        node.state.spend.lock().unwrap().arm(now_ms(), act::SpendBasis::AppLock);

        let err = do_message_retry(&node.state, A, "gm", None).await.unwrap_err();
        assert_eq!(err.code, "retry_needs_admission", "{}", err.message);
        assert_eq!(err.admission, Some(act::AdmissionView { admission_msat: 1500, message_msat: 2000, max_routing_fee_msat: 0, total_msat: 3500, quoted: true }));
        assert!(err.message.contains("3500 msat in all"), "{}", err.message);
        let bodies = compose_bodies(&node);
        assert_eq!(bodies.len(), 1);
        assert_eq!(bodies[0]["max_total_msat"], 0, "zero-capped: the grant cannot pay admission under it");
        assert_eq!(pending(&node).unwrap().undelivered, record.undelivered);
    }

    #[tokio::test]
    async fn psi_a_second_incomplete_retry_reports_the_running_total() {
        // Same connection: the prior admission is not a new debit (amount 0).
        let node = fake(AuthMode::Local, compose_script(vec![psi_502(2000, 0, 2000, PSI_TIMEOUT), psi_502(0, 2000, 0, PSI_TIMEOUT), cap_refusal(), delivered("m3", 2000)]));
        let record = psi_first(&node).await;
        let again = do_message_retry(&node.state, A, "gm", None).await.unwrap_err();
        assert_eq!(again.undelivered, Some(act::UndeliveredView { paid_msat: 2000, retry: true }));
        assert_eq!(again.pending_id.as_deref(), Some(record.id.as_str()), "the same record");
        let u = pending(&node).unwrap().undelivered.unwrap();
        assert_eq!((u.in_flight, u.attempts, u.admission_msat), (false, 1, 2000), "the same record, one retry on");
        assert_eq!(do_message_retry(&node.state, A, "gm", None).await.unwrap_err().code, "retry_needs_admission");
        assert_eq!(do_message_retry(&node.state, A, "gm", Some(4000)).await.unwrap().message_id, "m3");
        assert_eq!(book(&node), [
            (record.request_hash.clone(), 14000, true),
            (format!("{}-retry-1", record.request_hash), 0, true),
            (format!("{}-retry-2", record.request_hash), 2000, true),
        ], "one admission allowance and one message in the book");
    }

    /// Codex review of 0308673 (P2): a retry's own book entry survives expiry
    /// and pruning while its record still needs it, so reconciliation and Stop
    /// retrying keep working a day later.
    #[tokio::test]
    async fn psi_retry_accounting_survives_pruning_while_its_record_needs_it() {
        let node = fake(AuthMode::Local, compose_script(vec![psi_502(2000, 0, 2000, PSI_TIMEOUT), psi_502(0, 2000, 0, PSI_TIMEOUT)]));
        let record = psi_first(&node).await;
        do_message_retry(&node.state, A, "gm", None).await.unwrap_err();
        assert_eq!(pending(&node).unwrap().charge_id(), format!("{}-retry-1", record.request_hash));
        // Two days pass; an ordinary budget write prunes the book.
        with_book(&node.state, true, |b| {
            for e in b.ledger.iter_mut() { e.at_ms -= 2 * 86_400_000; }
            Ok(())
        }).unwrap();
        let ids: Vec<String> = book(&node).into_iter().map(|(id, _, _)| id).collect();
        assert!(ids.contains(&format!("{}-retry-1", record.request_hash)), "{ids:?}");
        assert_eq!(do_spend_reconcile(&reopen(&node)).await.unwrap_err().code, "undelivered_pending");
        do_spend_dismiss_undelivered(&node.state, &record.id).unwrap();
        assert!(pending(&node).is_none());
    }

    /// Codex review of 0308673 (P2): a delivered retry saves its accounting as
    /// a resolved delivery. A crash before the record is cleared leaves known
    /// money that reconciliation settles, never an unknown in-flight retry.
    #[tokio::test]
    async fn psi_a_delivered_retry_is_recoverable_after_a_crash_before_clear() {
        let node = fake(AuthMode::Local, compose_script(vec![psi_502(2000, 0, 2000, PSI_TIMEOUT), delivered("m2", 2000), delivered("m3", 2000)]));
        let record = psi_first(&node).await;
        // Keep the journal from being cleared: snapshot it right after the success save.
        let file = journal_file(&node);
        let receipt = do_message_retry(&node.state, A, "gm", Some(4000)).await.unwrap();
        assert_eq!(receipt.message_id, "m2");
        assert!(!file.exists());
        // The pre-clear snapshot, as the success path writes it.
        let journal = spend_journal(&node.state).unwrap();
        let mut snap = record.clone();
        snap.charge_id = Some(format!("{}-retry-1", record.request_hash));
        snap.accounting_msat = Some(2000);
        snap.budgeted = true;
        snap.undelivered = None;
        journal.save(&snap).unwrap();
        drop(journal);
        let after = reopen(&node);
        assert!(do_spend_reconcile(&after).await.unwrap().contains("accounted for"));
        assert!(pending(&node).is_none());
        spend_advance(&after, true).await.unwrap();
        assert_eq!(do_message_send(&after, A, false, "gm", 14000, None).await.unwrap().message_id, "m3");
    }

    /// A retry whose outcome is unknown leaves its record in flight: fenced,
    /// not retryable, not dismissable, and reconciliation does not guess.
    #[tokio::test]
    async fn psi_a_retry_with_an_unknown_outcome_stays_fenced() {
        let node = fake(AuthMode::Local, compose_script(vec![psi_502(2000, 0, 2000, PSI_TIMEOUT), (500, r#"{"error":"boom","code":500}"#.into())]));
        let record = psi_first(&node).await;
        assert_eq!(do_message_retry(&node.state, A, "gm", None).await.unwrap_err().code, "spend_unknown");
        let u = pending(&node).expect("the record stays").undelivered.unwrap();
        assert!(u.in_flight);
        assert_eq!(do_message_retry(&node.state, A, "gm", None).await.unwrap_err().code, "retry_unavailable");
        assert_eq!(do_spend_reconcile(&node.state).await.unwrap_err().code, "spend_unknown");
        assert_eq!(do_spend_dismiss_undelivered(&node.state, &record.id).unwrap_err().code, "spend_unknown");
        assert_eq!(do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err().code, "spend_unknown");
        assert_eq!(compose_bodies(&node).len(), 2);
    }

    #[tokio::test]
    async fn psi_no_retry_unless_the_node_says_it_will_not_pay_again() {
        let paid_message = (502, serde_json::json!({"error": "payment settled but send did not complete (prior admission: 0 msat; current call: 4000 msat): storing message failed", "code": "payment_settled_send_incomplete", "amount_msat": 4000}).to_string());
        let node = fake(AuthMode::Local, compose_script(vec![paid_message]));
        spend_advance(&node.state, true).await.unwrap();
        let err = do_message_send(&node.state, A, false, "gm", 14000, None).await.unwrap_err();
        assert_eq!(err.undelivered, Some(act::UndeliveredView { paid_msat: 4000, retry: false }));
        assert!(!err.message.contains("Retry"), "{}", err.message);
        assert_eq!(do_message_retry(&node.state, A, "gm", None).await.unwrap_err().code, "retry_unavailable");
        assert_eq!(do_message_retry(&node.state, A, "gm", Some(8000)).await.unwrap_err().code, "retry_unavailable");
        assert_eq!(compose_bodies(&node).len(), 1, "no second dispatch");

        // A retry is bound to the contact that was paid, and to this very message.
        let node = fake(AuthMode::Local, compose_script(vec![psi_502(2000, 0, 2000, PSI_TIMEOUT)]));
        psi_first(&node).await;
        assert_eq!(do_message_retry(&node.state, C, "gm", None).await.unwrap_err().code, "retry_unavailable");
        assert_eq!(do_message_retry(&node.state, A, "another message", None).await.unwrap_err().code, "retry_unavailable");
        assert_eq!(compose_bodies(&node).len(), 1);
    }

    #[tokio::test]
    async fn psi_a_retry_needs_the_owner_approval_like_any_send() {
        let node = fake(AuthMode::Local, compose_script(vec![psi_502(2000, 0, 2000, PSI_TIMEOUT)]));
        let record = psi_first(&node).await;
        node.state.spend.lock().unwrap().arm(now_ms() - act::SPEND_WINDOW_MS - 1, act::SpendBasis::AppLock);
        assert_eq!(do_message_retry(&node.state, A, "gm", None).await.unwrap_err().code, "spend_expired");
        assert_eq!(do_message_retry(&node.state, A, "gm", Some(4000)).await.unwrap_err().code, "spend_expired");
        assert_eq!(compose_bodies(&node).len(), 1);
        assert_eq!(pending(&node).unwrap().undelivered, record.undelivered, "untouched: still retryable");
    }

    #[tokio::test]
    async fn rooms_send_only_when_every_member_is_a_connected_peer() {
        let routes: Routes = Arc::new(|m: &str, p: &str, b: &str| {
            if p == "/peers" {
                return (200, serde_json::json!([{"node_id": A, "connected": true}, {"node_id": C, "connected": false}]).to_string());
            }
            happy()(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        let quote = read_room_quote(&node.state, ROOM).await.unwrap();
        // A advertises 2000; C has no table, so this node's 1000 stands in.
        assert_eq!((quote.total_msat, quote.estimate), (13000, true));
        assert_eq!(quote.unreachable, vec![C.to_string()]);

        spend_advance(&node.state, true).await.unwrap();
        let err = do_message_send(&node.state, ROOM, true, "gm", 12000, Some(std::collections::HashMap::from([(A.into(), 7000), (C.into(), 6000)]))).await.unwrap_err();
        assert_eq!(err.code, "room_unreachable");
        assert!(node.posts().is_empty(), "{:?}", node.posts());

        let node = fake(AuthMode::Local, happy());
        spend_advance(&node.state, true).await.unwrap();
        let receipt = do_message_send(&node.state, ROOM, true, "gm", 13000, Some(std::collections::HashMap::from([(A.into(), 7000), (C.into(), 6000)]))).await.unwrap();
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none(), "all terminal member outcomes release the fence");
        assert!(receipt.is_room);
        assert_eq!(
            node.posts(),
            [("/messages/compose".to_string(), serde_json::json!({"recipient": ROOM, "is_room": true, "kind": 0, "plaintext": "gm", "max_total_msat":13000, "max_routing_fee_msat":5000, "max_recipient_msat":{A:7000,C:6000}}))]
        );
    }

    fn room_policy_routes(minimum: u64, second_price: u64, route_fee: u64) -> Routes {
        Arc::new(move |m, p, b| {
            if p == "/status" {
                return (200, serde_json::json!({"lightning_backend":"lnd",
                    "api_capabilities":["paid_send_caps_v1","room_terminal_outcomes_v1"]}).to_string());
            }
            if p == "/pricing/peers" {
                return (200, serde_json::json!([
                    {"peer_id": A, "prices": {"communication": 2000}, "age_secs": 5, "stale": false},
                    {"peer_id": C, "prices": {"communication": second_price}, "age_secs": 5, "stale": false}
                ]).to_string());
            }
            if p == "/messages/compose" {
                let request: serde_json::Value = serde_json::from_str(b).unwrap();
                let caller = request["max_routing_fee_msat"].as_u64().unwrap();
                let mut fee_total = 0;
                let mut total = 0;
                // Model dac01c8's caps::all_in/check_room and fee-limited payment.
                for (peer, principal) in [(A, 2000u64), (C, second_price)] {
                    let fee = (principal / 100).max(minimum).min(10_000).min(caller);
                    fee_total += fee;
                    total += principal + fee;
                    if principal + fee > request["max_recipient_msat"][peer].as_u64().unwrap() {
                        return (409, serde_json::json!({"error":"member all-in price exceeds cap", "code":"price_cap_exceeded"}).to_string());
                    }
                    if peer == C && route_fee > fee {
                        return (409, serde_json::json!({"error":"route exceeds caller fee ceiling", "code":"price_cap_exceeded"}).to_string());
                    }
                }
                if total > request["max_total_msat"].as_u64().unwrap() {
                    return (409, serde_json::json!({"error":"total exceeds cap", "code":"price_cap_exceeded"}).to_string());
                }
                return (200, serde_json::json!({"message_id":"m1", "delivered":true,
                    "amount_msat":2000 + second_price, "max_routing_fee_msat":fee_total,
                    "member_outcomes":[
                        {"recipient":A,"status":"settled","amount_msat":2000,"message_id":"m1"},
                        {"recipient":C,"status":"settled","amount_msat":second_price,"message_id":"m2"}
                    ]}).to_string());
            }
            happy()(m, p, b)
        })
    }

    fn write_room_policy(node: &Fake, minimum: u64) {
        std::fs::write(node.state.config.lock().unwrap().as_ref().unwrap(), format!(
            "[lightning]\nbackend = \"lnd\"\n[routing_fees]\nminimum_msat = {minimum}\nproportional_millionths = 10000\nmaximum_msat = 10000\n"
        )).unwrap();
        // Simulate the same policy capture as a supervised node start/restart.
        *node.state.room_routing_policy.lock().unwrap() = configured_routing_policy(
            node.state.config.lock().unwrap().as_ref().unwrap());
    }

    async fn room_fee_policy_case(minimum: u64, second_price: u64, first_cap: u64, second_cap: u64, caller: u64, route_fee: u64) {
        let node = fake(AuthMode::Local, room_policy_routes(minimum, second_price, route_fee));
        write_room_policy(&node, minimum);
        let quote = read_room_quote(&node.state, ROOM).await.unwrap();
        assert_eq!(quote.members[0].msat, first_cap);
        assert_eq!(quote.members[1].msat, second_cap);
        assert_eq!(quote.total_msat, first_cap + second_cap);
        with_book(&node.state, true, |b| { b.set_ceiling(2_000_000); Ok(()) }).unwrap();
        spend_advance(&node.state, true).await.unwrap();
        let caps = quote.members.iter().map(|m| (m.node_id.clone(), m.msat)).collect();
        let receipt = do_message_send(&node.state, ROOM, true, "gm", quote.total_msat, Some(caps)).await.unwrap();
        assert_eq!(receipt.total_msat, first_cap + second_cap);
        assert_eq!(receipt.max_routing_fee_msat, quote.max_routing_fee_msat);
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
        let posts = node.posts();
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].1["max_routing_fee_msat"], caller);
        assert_eq!(posts[0].1["max_total_msat"], first_cap + second_cap);
        assert_eq!(posts[0].1["max_recipient_msat"], serde_json::json!({A:first_cap,C:second_cap}));
    }

    #[tokio::test]
    async fn room_fee_default_policy_control() {
        room_fee_policy_case(5000, 2000, 7000, 7000, 5000, 0).await;
    }

    #[tokio::test]
    async fn room_fee_higher_node_floor_is_displayed_and_authorized() {
        room_fee_policy_case(7500, 2000, 9500, 9500, 7500, 6000).await;
    }

    #[tokio::test]
    async fn room_fee_mixed_prices_allow_a_route_inside_the_larger_member_quote() {
        room_fee_policy_case(5000, 750_000, 7000, 757_500, 7500, 6000).await;
    }

    #[tokio::test]
    async fn room_fee_higher_policy_requires_another_approval_at_unchanged_principal() {
        let raised = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let changing = raised.clone();
        let routes: Routes = Arc::new(move |m, p, b| {
            room_policy_routes(if changing.load(Ordering::SeqCst) { 7500 } else { 5000 }, 2000, 0)(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        write_room_policy(&node, 5000);
        let quote = read_room_quote(&node.state, ROOM).await.unwrap();
        assert_eq!(quote.total_msat, 14000);
        spend_advance(&node.state, true).await.unwrap();
        raised.store(true, Ordering::SeqCst);
        write_room_policy(&node, 7500);
        let caps = quote.members.iter().map(|m| (m.node_id.clone(), m.msat)).collect();
        let err = do_message_send(&node.state, ROOM, true, "gm", quote.total_msat, Some(caps)).await.unwrap_err();
        assert_eq!(err.code, "price_changed");
        assert!(node.posts().is_empty());
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
        let refreshed = read_room_quote(&node.state, ROOM).await.unwrap();
        assert_eq!(refreshed.total_msat, 19000);
        assert_eq!(refreshed.members[0].msat, 9500);
        assert_eq!(refreshed.members[0].max_routing_fee_msat, 7500);
        let caps = refreshed.members.iter().map(|m| (m.node_id.clone(), m.msat)).collect();
        let receipt = do_message_send(&node.state, ROOM, true, "gm", refreshed.total_msat, Some(caps)).await.unwrap();
        assert_eq!(receipt.total_msat, 19000);
        assert_eq!(node.posts().len(), 1);
    }

    #[tokio::test]
    async fn room_fee_unknown_policy_does_not_silently_use_app_defaults() {
        let node = fake(AuthMode::Local, room_policy_routes(7500, 2000, 0));
        assert!(read_room_quote(&node.state, ROOM).await.is_err());
        assert!(node.posts().is_empty());
    }

    #[tokio::test]
    async fn room_fee_config_is_a_startup_snapshot_and_invalid_policy_fails_closed() {
        let node = fake(AuthMode::Local, room_policy_routes(7500, 2000, 0));
        write_room_policy(&node, 7500);
        let path = node.state.config.lock().unwrap().clone().unwrap();
        // Editing the file alone cannot claim the running node has a new policy.
        std::fs::write(&path, "[lightning]\nbackend = \"lnd\"\n").unwrap();
        assert_eq!(read_room_quote(&node.state, ROOM).await.unwrap().members[0].msat, 9500);
        // A restart loading the node's default config gives the default allowance.
        *node.state.room_routing_policy.lock().unwrap() = configured_routing_policy(&path);
        assert_eq!(read_room_quote(&node.state, ROOM).await.unwrap().members[0].msat, 7000);
        for config in [
            "not toml",
            "[lightning]\nbackend = \"ldk\"\n", // mismatched running backend
            "[lightning]\nbackend = \"lnd\"\n[routing_fees]\nminimum_msat = -1\n",
            "[lightning]\nbackend = \"lnd\"\n[routing_fees]\nminimim_msat = 7500\n",
        ] {
            std::fs::write(&path, config).unwrap();
            *node.state.room_routing_policy.lock().unwrap() = configured_routing_policy(&path);
            assert!(read_room_quote(&node.state, ROOM).await.is_err());
        }
    }

    #[test]
    fn configured_network_names_only_an_ldk_config_network() {
        let path = std::env::temp_dir().join(format!("bitsov-network-{}.toml", std::process::id()));
        for (config, want) in [
            ("[lightning]\nbackend = \"ldk\"\nnetwork = \"regtest\"\n", Some("regtest")),
            ("[lightning]\nbackend = \"ldk\"\nnetwork = \"signet\"\nesplora_url = \"x\"\n", Some("signet")),
            // The node's default for LDK is mainnet.
            ("[lightning]\nbackend = \"ldk\"\n", Some("mainnet")),
            ("[lightning]\nbackend = \"ldk\"\nnetwork = \"liquid\"\n", None),
            ("[lightning]\nbackend = \"lnd\"\nnetwork = \"regtest\"\n", None),
            ("[lightning]\nbackend = \"mock\"\n", None),
            ("not toml", None),
        ] {
            std::fs::write(&path, config).unwrap();
            assert_eq!(configured_network(&path).as_deref(), want, "{config}");
        }
        std::fs::remove_file(&path).unwrap();
        assert_eq!(configured_network(&path), None, "missing file");
    }

    #[tokio::test]
    async fn room_fee_restart_discards_policy_before_adopting_another_listener() {
        let node = fake(AuthMode::Local, room_policy_routes(7500, 2000, 0));
        write_room_policy(&node, 7500);
        assert_eq!(read_room_quote(&node.state, ROOM).await.unwrap().members[0].msat, 9500);
        // restart_node calls this even when only an external listener remains.
        node.state.stop_for_restart(Duration::ZERO);
        assert!(read_room_quote(&node.state, ROOM).await.is_err());
    }

    #[tokio::test]
    async fn room_fee_terminated_node_cannot_lend_its_policy_to_a_replacement() {
        let node = fake(AuthMode::Local, room_policy_routes(7500, 2000, 0));
        write_room_policy(&node, 7500);
        node.state.sidecar_terminated.store(true, Ordering::SeqCst);
        assert!(read_room_quote(&node.state, ROOM).await.is_err());
    }

    #[tokio::test]
    async fn room_fee_member_increase_needs_approval_even_when_total_cap_fits() {
        let node = fake(AuthMode::Local, room_policy_routes(7500, 2000, 0));
        write_room_policy(&node, 7500);
        spend_advance(&node.state, true).await.unwrap();
        let err = do_message_send(&node.state, ROOM, true, "gm", 19000,
            Some(std::collections::HashMap::from([(A.into(), 7000), (C.into(), 12000)]))).await.unwrap_err();
        assert_eq!(err.code, "price_changed");
        assert!(node.posts().is_empty());
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
    }

    #[tokio::test]
    async fn pay_goes_out_only_for_the_amount_shown_and_the_receipt_drops_the_preimage() {
        let node = fake(AuthMode::Local, happy());
        spend_advance(&node.state, true).await.unwrap();
        assert!(do_payment_pay(&node.state, act::TEST_INVOICE_1000, 2000, 7000).await.is_err());
        assert!(do_payment_pay(&node.state, "lntb1x", 0, 0).await.is_err(), "amountless");
        assert!(node.posts().is_empty());
        let receipt = do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 6000).await.unwrap();
        assert_eq!((receipt.method, receipt.status.as_str(), receipt.amount_msat), ("invoice", "settled", 1000));
        let ks = do_payment_keysend(&node.state, &format!("03{}", "cd".repeat(32)), 5000, Some("thanks"), 10000).await.unwrap();
        assert_eq!(ks.status, "settled");
        let out = serde_json::to_string(&(receipt, ks)).unwrap();
        assert!(!out.contains("PREIMAGE") && !out.contains(&"ab".repeat(32)) && !out.contains(&"cd".repeat(32)));
        assert_eq!(node.posts()[0], ("/payments/pay".to_string(), serde_json::json!({"bolt11": act::TEST_INVOICE_1000, "max_routing_fee_msat": 5000})));
    }

    fn call_routes(offer: Option<u64>) -> Routes {
        let inner = happy();
        Arc::new(move |m, p, b| {
            let (route, _) = p.split_once('?').unwrap_or((p, ""));
            match route {
                r if r == format!("/pricing/peers/{A}/call") => match offer {
                    Some(o) => (200, serde_json::json!({"peer_id": A, "offer_msat": o, "signal_msat": 50}).to_string()),
                    None => (400, r#"{"error":"their node did not answer with a call price; nothing was paid","code":400,"reason":"call_price_unknown"}"#.into()),
                },
                "/payments/price/401" => (200, serde_json::json!({"kind": 401, "price_msat": 50}).to_string()),
                "/messages/compose" => (200, serde_json::json!({"max_routing_fee_msat": 5000, "message_id": "c1", "delivered": true, "amount_msat": 10000, "accepted": true, "state": "acked"}).to_string()),
                _ => inner(m, p, b),
            }
        })
    }
    const OFFER: &str = r#"{"v":1,"call_id":"0123456789abcdef0123456789abcdef","media":"audio","sdp":"v=0"}"#;

    #[tokio::test]
    async fn a_call_offer_pays_the_callees_call_price_inside_the_contact_budget() {
        let node = fake(AuthMode::Local, call_routes(Some(10_000)));
        let s = &node.state;
        do_budget_approve(s, 500_000, budget::PresetId::Careful).await.unwrap();
        with_book(s, true, |b| b.set_limit(A, false, 50_000)).unwrap();
        let quote = read_call_quote(s, A).await.unwrap();
        assert_eq!((quote.offer_msat, quote.call_total_msat), (Some(10_000), Some(21_000)));
        let receipt = do_call_signal(s, A, 400, OFFER, 15_000).await.unwrap();
        assert_eq!((receipt.kind, receipt.amount_msat, receipt.total_msat), (400, 10_000, 15_000));
        let (path, body) = node.posts().into_iter().find(|(p, _)| p == "/messages/compose").unwrap();
        assert_eq!(path, "/messages/compose");
        assert_eq!((body["kind"].as_u64(), body["is_room"].as_bool()), (Some(400), Some(false)));
        assert_eq!((body["max_total_msat"].as_u64(), body["max_routing_fee_msat"].as_u64()), (Some(15_000), Some(5_000)));
        assert_eq!(body["plaintext"], OFFER);
        assert_eq!(budget_now(s).spent_msat, 15_000);
    }

    #[tokio::test]
    async fn a_call_is_refused_before_paying_when_it_cannot_be_priced_or_authorised() {
        // Their node advertises no call price: nothing is posted.
        let node = fake(AuthMode::Local, call_routes(None));
        do_budget_approve(&node.state, 500_000, budget::PresetId::Careful).await.unwrap();
        with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
        assert_eq!(do_call_signal(&node.state, A, 400, OFFER, 15_000).await.unwrap_err().code, "call_unsupported");
        // The ceiling the owner saw is below the price.
        let node2 = fake(AuthMode::Local, call_routes(Some(10_000)));
        do_budget_approve(&node2.state, 500_000, budget::PresetId::Careful).await.unwrap();
        with_book(&node2.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
        assert_eq!(do_call_signal(&node2.state, A, 400, OFFER, 14_999).await.unwrap_err().code, "price_changed");
        // No approval at all: locked.
        let node3 = fake(AuthMode::Local, call_routes(Some(10_000)));
        assert_eq!(do_call_signal(&node3.state, A, 400, OFFER, 15_000).await.unwrap_err().code, "spend_locked");
        // Not a JSON signal, or not a call kind.
        assert_eq!(do_call_signal(&node2.state, A, 400, "ring", 15_000).await.unwrap_err().code, "invalid");
        assert_eq!(do_call_signal(&node2.state, A, 0, "{}", 15_000).await.unwrap_err().code, "invalid");
        for n in [&node, &node2, &node3] {
            assert!(!n.posts().iter().any(|(p, _)| p == "/messages/compose"), "{:?}", n.posts());
        }
        assert_eq!(budget_now(&node2.state).spent_msat, 0);
    }

    #[tokio::test]
    async fn a_stranger_is_never_rung() {
        let node = fake(AuthMode::Local, call_routes(Some(10_000)));
        do_budget_approve(&node.state, 500_000, budget::PresetId::Careful).await.unwrap();
        let err = do_call_signal(&node.state, C, 400, OFFER, 15_000).await.unwrap_err();
        assert_eq!(err.code, "call_needs_contact", "{err:?}");
        assert!(!node.posts().iter().any(|(p, _)| p == "/messages/compose"));
    }

    #[tokio::test]
    async fn a_received_voice_note_is_fetched_read_only_by_message_id() {
        const MID: &str = "cd";
        let mid = MID.repeat(32);
        let listed = serde_json::json!([
            {"id": ROOM, "filename": "voice-note.webm", "mime_type": "audio/webm", "size_bytes": 2, "blake3_hash": "bb", "sender": A, "message_id": mid.to_uppercase(), "created_at": ""},
            {"id": FILE_ID, "filename": "doc.html", "mime_type": "text/html", "size_bytes": 2, "blake3_hash": "bb", "sender": A, "message_id": "ef".repeat(32), "created_at": ""}
        ]);
        let routes: Routes = Arc::new(move |_m, p, _b| {
            let (route, _) = p.split_once('?').unwrap_or((p, ""));
            match route {
                "/files" => (200, listed.to_string()),
                r if r == format!("/files/{ROOM}") => (200, serde_json::json!({"id": ROOM, "filename": "voice-note.webm", "mime_type": "audio/webm", "size_bytes": 2, "blake3_hash": "bb", "sender": A, "data_b64": "aGk="}).to_string()),
                _ => (404, r#"{"error":"route","code":404}"#.into()),
            }
        });
        let node = fake(AuthMode::Local, routes);
        let blob = do_voice_note_fetch(&node.state, &mid).await.unwrap();
        assert_eq!((blob.mime_type.as_str(), blob.data_b64.as_str()), ("audio/webm", "aGk="));
        // A non-audio file is never handed to the player; bad ids never reach the node.
        // A spoofed voice-note name on a non-audio file is named as such.
        assert_eq!(do_voice_note_fetch(&node.state, &"ef".repeat(32)).await.unwrap_err(), act::NOT_A_VOICE_NOTE);
        // A short list is the whole list: one small read, then "not stored".
        let before = node.targets().len();
        assert_eq!(do_voice_note_fetch(&node.state, &"99".repeat(32)).await.unwrap_err(), act::VOICE_NOT_STORED);
        assert_eq!(node.targets()[before..], ["GET /files?limit=50".to_string()]);
        let before = node.targets().len();
        assert!(do_voice_note_fetch(&node.state, "../files").await.is_err());
        assert_eq!(node.targets().len(), before);
        assert!(node.posts().is_empty(), "playback must never POST");
    }

    #[tokio::test]
    async fn a_voice_note_lookup_widens_the_file_window_only_as_needed() {
        let mid = "cd".repeat(32);
        // 250 newer files, then the note: found in the 1000 window, after 50 and 200.
        let rows: Vec<serde_json::Value> = (0..250)
            .map(|i| serde_json::json!({"id": FILE_ID, "mime_type": "application/pdf", "message_id": format!("{i:064x}")}))
            .chain(std::iter::once(serde_json::json!({"id": ROOM, "mime_type": "audio/webm", "message_id": mid.clone()})))
            .collect();
        let routes: Routes = Arc::new(move |_m, p, _b| {
            let (route, query) = p.split_once('?').unwrap_or((p, ""));
            match route {
                "/files" => {
                    let limit: usize = query.trim_start_matches("limit=").parse().unwrap();
                    (200, serde_json::Value::Array(rows.iter().take(limit).cloned().collect()).to_string())
                }
                r if r == format!("/files/{ROOM}") => (200, serde_json::json!({"filename": "voice-note.webm", "mime_type": "audio/webm", "size_bytes": 2, "data_b64": "aGk="}).to_string()),
                _ => (404, r#"{"error":"route","code":404}"#.into()),
            }
        });
        let node = fake(AuthMode::Local, routes);
        do_voice_note_fetch(&node.state, &mid).await.unwrap();
        assert_eq!(node.targets(), ["GET /files?limit=50", "GET /files?limit=200", "GET /files?limit=1000", &format!("GET /files/{ROOM}")]);
    }

    #[tokio::test]
    async fn a_received_file_is_fetched_and_can_be_written_under_the_size_cap() {
        let mid = "ab".repeat(32);
        let listed = serde_json::json!([
            {"id": FILE_ID, "filename": "brief.txt", "mime_type": "text/plain", "size_bytes": 2, "message_id": mid, "created_at": ""}
        ]);
        let routes: Routes = Arc::new(move |_m, p, _b| {
            let (route, _) = p.split_once('?').unwrap_or((p, ""));
            match route {
                "/files" => (200, listed.to_string()),
                r if r == format!("/files/{FILE_ID}") => (200, serde_json::json!({
                    "id": FILE_ID, "filename": "brief.txt", "mime_type": "text/plain", "size_bytes": 2, "data_b64": "aGk="
                }).to_string()),
                _ => (404, r#"{"error":"route","code":404}"#.into()),
            }
        });
        let node = fake(AuthMode::Local, routes);
        let blob = do_file_fetch(&node.state, &mid).await.unwrap();
        assert_eq!((blob.filename.as_str(), blob.mime_type.as_str(), blob.size_bytes), ("brief.txt", "text/plain", 2));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(act::safe_save_name(&blob.filename));
        act::write_file_bytes(&path, &blob.data_b64).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"hi");
        assert!(node.posts().is_empty(), "save must never POST");
        assert_eq!(do_file_fetch(&node.state, &"99".repeat(32)).await.unwrap_err(), act::FILE_NOT_STORED);
    }

    #[tokio::test]
    async fn an_oversized_received_file_is_refused_before_any_write() {
        let mid = "cd".repeat(32);
        let listed = serde_json::json!([{"id": FILE_ID, "mime_type": "application/octet-stream", "message_id": mid}]);
        // Declared size over the cap; payload is tiny so we only exercise the size gate.
        let routes: Routes = Arc::new(move |_m, p, _b| {
            let (route, _) = p.split_once('?').unwrap_or((p, ""));
            match route {
                "/files" => (200, listed.to_string()),
                r if r == format!("/files/{FILE_ID}") => (200, serde_json::json!({
                    "filename": "big.bin", "mime_type": "application/octet-stream",
                    "size_bytes": act::FILE_MAX_BYTES as u64 + 1, "data_b64": "aGk="
                }).to_string()),
                _ => (404, r#"{"error":"route","code":404}"#.into()),
            }
        });
        let node = fake(AuthMode::Local, routes);
        assert_eq!(do_file_fetch(&node.state, &mid).await.unwrap_err(), act::FILE_TOO_LARGE);
    }

    #[tokio::test]
    async fn a_file_is_uploaded_then_sent_to_one_peer() {
        let node = fake(AuthMode::Local, happy());
        spend_advance(&node.state, true).await.unwrap();
        let receipt = do_file_send(&node.state, A, "hi.txt", "text/plain", "aGk=", 8000, None).await.unwrap();
        assert_eq!((receipt.filename.as_str(), receipt.size_bytes, receipt.amount_msat), ("hi.txt", 2, 3000));
        assert_eq!(
            node.posts(),
            [
                ("/files".to_string(), serde_json::json!({"filename": "hi.txt", "mime_type": "text/plain", "data_b64": "aGk="})),
                (format!("/files/{FILE_ID}/send"), serde_json::json!({"recipient": A,"max_total_msat":8000,"max_routing_fee_msat":5000})),
            ]
        );
    }

    #[tokio::test]
    async fn invites_are_created_and_redeemed_and_an_owner_only_refusal_keeps_the_window() {
        let node = fake(AuthMode::Local, happy());
        spend_advance(&node.state, true).await.unwrap();
        let invite = do_invite_create(&node.state, A, "203.0.113.5:9735", 24).await.unwrap();
        assert_eq!(invite.invite_link, "bitsov://invite/tok");
        let (path, body) = node.posts()[0].clone();
        assert_eq!(path, "/invites");
        assert_eq!(body["invitee_pubkey"], A);
        assert_eq!(body["addr"], "203.0.113.5:9735");
        let redeemed = do_invite_redeem(&node.state, "bitsov://invite/tok").await.unwrap();
        assert_eq!(redeemed.inviter_pubkey, A);
        assert_eq!(node.posts()[1], ("/invites/accept".to_string(), serde_json::json!({"token": "tok"})));

        let routes: Routes = Arc::new(|_: &str, _: &str, _: &str| (403, "token lacks required scope: admin".into()));
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        assert_eq!(do_invite_create(&node.state, A, "h:1", 1).await.unwrap_err().code, "owner_only");
        assert_eq!(spend_advance(&node.state, false).await.unwrap().state, act::SpendState::Open);
    }

    fn paired_fake(routes: Routes) -> (Fake, tempfile::TempDir) {
        let session = pairing::PairedSession {
            client_id: "c1".into(),
            scopes: vec!["read".into(), "receive".into()],
            token: "tok.1".into(),
            expires_at: now_unix() + 600,
        };
        let node = fake(AuthMode::Paired(session), routes);
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join(PAIRING_STORE_DIR);
        let key = ClientKey::load_or_create(&store).unwrap();
        let client = PairingClient::new(node.state.http.clone(), node.state.api_base.clone());
        *node.state.pairing.lock().unwrap() = Some(Arc::new(PairingCtx {
            client,
            key,
            store,
            data_dir: dir.path().to_path_buf(),
        }));
        (node, dir)
    }

    /// A node that demands `front_door` for `PUT /front-door` until `granted`.
    fn front_door_node(granted: Arc<std::sync::atomic::AtomicBool>, owner_action: &'static str) -> Routes {
        let far = now_unix() + 900;
        // Only a token minted after the grant carries `front_door`.
        let minted = Arc::new(std::sync::atomic::AtomicBool::new(false));
        Arc::new(move |m: &str, path: &str, _b: &str| {
            let ok = granted.load(Ordering::SeqCst);
            if m == "POST" && path == "/pair/token" && ok {
                minted.store(true, Ordering::SeqCst);
            }
            let v = match (m, path) {
                ("PUT", "/front-door") if minted.load(Ordering::SeqCst) => serde_json::json!({"card": {}, "link": "bitsov://front-door#x"}),
                ("PUT", "/front-door") => return (403, "token lacks required scope: front_door".into()),
                ("POST", "/pair/elevation-request") => serde_json::json!({"op_id": "fd01", "expires_at": far, "owner_action": owner_action}),
                (_, p) if p.starts_with("/pair/challenge") => serde_json::json!({"challenge": "bitsov-pair-token-v1:ch"}),
                ("POST", "/pair/token") => serde_json::json!({"token": if ok { "tok.fd" } else { "tok.2" }, "expires_at": far,
                    "scopes": if ok { vec!["read", "receive", "front_door"] } else { vec!["read", "receive"] }}),
                _ => return (404, r#"{"error":"route","code":404}"#.into()),
            };
            (200, v.to_string())
        })
    }

    #[tokio::test]
    async fn front_door_publish_asks_the_owner_once_and_publishes_after_the_grant() {
        let granted = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (node, _dir) = paired_fake(front_door_node(granted.clone(), "konsensus grant --op fd01"));
        let body = serde_json::json!({"display_name": "Ada"});

        let err = put_front_door(&node.state, body.clone()).await.unwrap_err();
        assert!(err.starts_with(&format!("{FRONT_DOOR_OWNER}:")), "{err}");
        assert!(err.contains("konsensus grant --op fd01") && err.contains("no spending"), "{err}");
        // Pressing Publish again before the owner acts reuses the one request.
        put_front_door(&node.state, body.clone()).await.unwrap_err();
        let asks: Vec<_> = node.posts().into_iter().filter(|(p, _)| p == "/pair/elevation-request").collect();
        assert_eq!(asks, [("/pair/elevation-request".to_string(), serde_json::json!({"scopes": ["front_door"]}))]);

        // The owner grants at the node; the next Publish re-mints and publishes.
        granted.store(true, Ordering::SeqCst);
        put_front_door(&node.state, body).await.unwrap();
        assert_eq!(node.state.token.lock().unwrap().as_deref(), Some("tok.fd"));
        assert!(node.state.front_door_ask.lock().unwrap().is_none());
        let puts = node.targets().into_iter().filter(|t| t == "PUT /front-door").count();
        assert_eq!(puts, 6, "each press: one PUT, and one retry after a fresh token");
    }

    #[tokio::test]
    async fn front_door_publish_says_plainly_when_the_node_cannot_grant_it() {
        let granted = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (node, _dir) = paired_fake(front_door_node(granted, "unavailable in this deployment: no owner control socket"));
        let err = put_front_door(&node.state, serde_json::json!({"display_name": "Ada"})).await.unwrap_err();
        assert!(err.contains("cannot let the app publish") && err.contains("unavailable in this deployment"), "{err}");

        // Any other refusal is shown as the node wrote it, and asks nobody.
        let routes: Routes = Arc::new(|_: &str, _: &str, _: &str| (403, "token lacks required scope: admin".into()));
        let (node, _dir) = paired_fake(routes);
        let err = put_front_door(&node.state, serde_json::json!({"display_name": "Ada"})).await.unwrap_err();
        assert!(!err.starts_with(FRONT_DOOR_OWNER) && err.contains("admin"), "{err}");
        assert!(node.posts().is_empty());
    }

    /// A node that numbers each elevation request and reports `status` for all.
    fn asking_node(status: &'static str, owner_action: &'static str) -> Routes {
        let asks = Arc::new(AtomicUsize::new(0));
        let far = now_unix() + 900;
        Arc::new(move |m: &str, path: &str, b: &str| {
            let v = match path {
                "/pair/elevation-request" => {
                    let n = asks.fetch_add(1, Ordering::SeqCst) + 1;
                    let op = format!("ab{n:02}");
                    serde_json::json!({"op_id": op, "expires_at": far, "owner_action": owner_action.replace("{op}", &op)})
                }
                p if p.starts_with("/pair/elevation/") => serde_json::json!({"status": status}),
                "/front-door" => return (403, "token lacks required scope: front_door".into()),
                r if r.starts_with("/pair/challenge") => serde_json::json!({"challenge": "bitsov-pair-token-v1:00ff"}),
                "/pair/token" => serde_json::json!({"token": "tok.2", "expires_at": far, "scopes": ["read", "receive"]}),
                _ => return happy()(m, path, b),
            };
            (200, v.to_string())
        })
    }

    #[tokio::test]
    async fn a_request_the_node_lost_in_a_restart_offers_ask_again_instead_of_waiting() {
        let (node, _dir) = paired_fake(asking_node("lost", "konsensus grant --op {op}"));
        let view = spend_advance(&node.state, true).await.unwrap();
        assert_eq!((view.state, view.lapse), (act::SpendState::Pending, None));
        let first = view.pending.unwrap().op_id;

        // The node restarted: its owner code is gone, and it says so.
        let view = spend_advance(&node.state, false).await.unwrap();
        assert_eq!((view.state, view.lapse), (act::SpendState::Expired, Some(act::Lapse::Lost)));
        assert!(view.pending.is_none(), "never wait on a request nothing can approve");
        assert_eq!(do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err().code, "spend_expired");

        // Ask again: a fresh request, and the lapse note clears.
        let view = spend_advance(&node.state, true).await.unwrap();
        assert_eq!((view.state, view.lapse), (act::SpendState::Pending, None));
        assert_ne!(view.pending.unwrap().op_id, first);
        let asks = node.posts().into_iter().filter(|(p, _)| p == "/pair/elevation-request").count();
        assert_eq!(asks, 2);
    }

    #[tokio::test]
    async fn an_expired_or_forgotten_request_also_offers_ask_again() {
        for (status, lapse) in [("expired", act::Lapse::Expired), ("absent", act::Lapse::Lost)] {
            let (node, _dir) = paired_fake(asking_node(status, "konsensus grant --op {op}"));
            spend_advance(&node.state, true).await.unwrap();
            let view = spend_advance(&node.state, false).await.unwrap();
            assert_eq!((view.state, view.lapse), (act::SpendState::Expired, Some(lapse)), "{status}");
        }
        // Still pending on the node: keep waiting, no lapse.
        let (node, _dir) = paired_fake(asking_node("pending", "konsensus grant --op {op}"));
        spend_advance(&node.state, true).await.unwrap();
        let view = spend_advance(&node.state, false).await.unwrap();
        assert_eq!((view.state, view.lapse), (act::SpendState::Pending, None));
    }

    #[tokio::test]
    async fn front_door_publish_asks_again_when_the_node_lost_the_request() {
        let (node, _dir) = paired_fake(asking_node("lost", "konsensus grant --op {op}"));
        let body = serde_json::json!({"display_name": "Ada"});
        let err = put_front_door(&node.state, body.clone()).await.unwrap_err();
        assert!(err.contains("konsensus grant --op ab01"), "{err}");
        // The node restarted in between: Publish shows a new, approvable command.
        let err = put_front_door(&node.state, body).await.unwrap_err();
        assert!(err.contains("konsensus grant --op ab02") && !err.contains("ab01"), "{err}");
    }

    #[tokio::test]
    async fn front_door_publish_reuses_a_request_the_node_still_waits_on() {
        let (node, _dir) = paired_fake(asking_node("pending", "konsensus grant --op {op}"));
        let body = serde_json::json!({"display_name": "Ada"});
        put_front_door(&node.state, body.clone()).await.unwrap_err();
        let err = put_front_door(&node.state, body).await.unwrap_err();
        assert!(err.contains("konsensus grant --op ab01"), "{err}");
        assert_eq!(node.posts().into_iter().filter(|(p, _)| p == "/pair/elevation-request").count(), 1);
    }

    #[tokio::test]
    async fn the_owner_command_names_the_nodes_config_when_the_node_does_not() {
        let (node, _dir) = paired_fake(asking_node("pending", "konsensus grant --op {op}"));
        *node.state.config.lock().unwrap() = Some(PathBuf::from("/Users/owner/Bitsov Node/konsensus.toml"));
        let view = spend_advance(&node.state, true).await.unwrap();
        assert_eq!(
            view.pending.unwrap().owner_action,
            "konsensus grant --op ab01 --config '/Users/owner/Bitsov Node/konsensus.toml'"
        );
        // An attached external node's config wins over the one the app started.
        let (node, _dir) = paired_fake(asking_node("pending", "konsensus grant --op {op}"));
        *node.state.config.lock().unwrap() = Some(PathBuf::from("/own/konsensus.toml"));
        *node.state.external_node.lock().unwrap() = Some(PathBuf::from("/ext"));
        let view = spend_advance(&node.state, true).await.unwrap();
        assert_eq!(view.pending.unwrap().owner_action, "konsensus grant --op ab01 --config '/ext/konsensus.toml'");
        // A node that already names its config is shown verbatim.
        let (node, _dir) = paired_fake(asking_node("pending", "konsensus grant --op {op} --config /srv/n/konsensus.toml"));
        *node.state.config.lock().unwrap() = Some(PathBuf::from("/elsewhere/konsensus.toml"));
        let view = spend_advance(&node.state, true).await.unwrap();
        assert_eq!(view.pending.unwrap().owner_action, "konsensus grant --op ab01 --config /srv/n/konsensus.toml");
    }

    #[tokio::test]
    async fn a_paired_node_is_asked_and_the_owners_grant_opens_the_window() {
        let polls = Arc::new(AtomicUsize::new(0));
        let p = polls.clone();
        let far = now_unix() + 900;
        let routes: Routes = Arc::new(move |m: &str, path: &str, b: &str| {
            let v = match path {
                "/pair/elevation-request" => serde_json::json!({"op_id": "ab12", "expires_at": far, "owner_action": "konsensus grant --op ab12"}),
                "/pair/elevation/ab12" => {
                    let n = p.fetch_add(1, Ordering::SeqCst);
                    serde_json::json!({"op_id": "ab12", "status": if n == 0 { "pending" } else { "granted" }})
                }
                r if r.starts_with("/pair/challenge") => serde_json::json!({"challenge": "bitsov-pair-token-v1:00ff"}),
                "/pair/token" => serde_json::json!({"token": "tok.spend", "expires_at": far, "scopes": ["read", "receive", "spend"]}),
                _ => return happy()(m, path, b),
            };
            (200, v.to_string())
        });
        let (node, _dir) = paired_fake(routes);

        let view = spend_advance(&node.state, true).await.unwrap();
        assert_eq!(view.state, act::SpendState::Pending);
        let pending = view.pending.unwrap();
        // The node named no config; the app adds the one it started the node with.
        let config = node.state.config.lock().unwrap().clone().unwrap();
        assert_eq!(pending.owner_action, format!("konsensus grant --op ab12 --config '{}'", config.display()));
        assert_eq!(node.posts()[0], ("/pair/elevation-request".to_string(), serde_json::json!({"scopes": ["spend"]})));
        assert_eq!(do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err().code, "spend_locked");

        assert_eq!(spend_advance(&node.state, false).await.unwrap().state, act::SpendState::Pending);
        let view = spend_advance(&node.state, false).await.unwrap();
        assert_eq!((view.state, view.basis), (act::SpendState::Open, Some(act::SpendBasis::NodeGrant)));
        assert_eq!(node.state.token.lock().unwrap().as_deref(), Some("tok.spend"));

        do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap();
        let last = node.seen.lock().unwrap().last().cloned().unwrap();
        assert_eq!((last.1.as_str(), last.2.as_deref()), ("/api/v1/messages/compose", Some("tok.spend")));

        // Nothing about the grant is written to the app's pairing store.
        let store = node.state.pairing.lock().unwrap().clone().unwrap().store.clone();
        for entry in std::fs::read_dir(&store).unwrap() {
            let text = std::fs::read_to_string(entry.unwrap().path()).unwrap_or_default();
            assert!(!text.contains("spend"), "a spend grant reached disk");
        }
    }

    // BUDGET-SCOPE: all app message/file paths share the daily book, even
    // when the owner uses the manual window and no contact limit exists.
    #[tokio::test]
    async fn budget_scope_manual_actions_count_and_refuse_before_dispatch() {
        for action in ["message", "room", "file"] {
            let node = fake(AuthMode::Local, happy());
            let s = &node.state;
            spend_advance(s, true).await.unwrap();
            with_book(s, true, |b| { b.set_ceiling(match action { "room" => 13000, "file" => 10000, _ => 9000 }); Ok(()) }).unwrap();
            let send = || async {
                match action {
                    "message" => do_message_send(s, A, false, "hi", 7000, None).await.map(|r| r.amount_msat),
                    "room" => do_message_send(s, ROOM, true, "hi", 13000,
                        Some(std::collections::HashMap::from([(A.into(), 7000), (C.into(), 6000)]))).await.map(|r| r.amount_msat),
                    _ => do_file_send(s, A, "a.txt", "text/plain", "aGk=", 8000, None).await.map(|r| r.amount_msat),
                }
            };
            let paid = send().await.unwrap();
            assert_eq!(budget_now(s).spent_msat, paid, "{action} must count");
            assert_eq!(budget_now(&reopen(&node)).spent_msat, paid, "{action} survives restart");
            // Another contact uses up the remaining total, without a contact cap.
            do_message_send(s, C, false, "other", 7000, None).await.unwrap();
            let requests = node.targets().len();
            assert_eq!(send().await.unwrap_err().code, "ceiling_exhausted", "{action}");
            assert_eq!(node.targets().len(), requests, "{action} refused before any request");
        }
    }

    #[tokio::test]
    async fn budget_scope_files_share_contact_limits_and_use_budget_like_messages() {
        let node = fake(AuthMode::Local, happy());
        let s = &node.state;
        let view = do_budget_approve(s, 500_000, budget::PresetId::Careful).await.unwrap();
        assert_eq!(view.autopay.state, budget::AutopayState::Open);
        with_book(s, true, |b| b.set_limit(A, false, 9000)).unwrap();
        // Files use the same budget route as messages: no ten-minute window needed.
        do_file_send(s, A, "a.txt", "text/plain", "aGk=", 8000, None).await.unwrap();
        assert_eq!(budget_now(s).spent_msat, 3000);
        let requests = node.targets().len();
        assert_eq!(do_message_send(s, A, false, "hi", 7000, None).await.unwrap_err().code, "budget_exhausted");
        assert_eq!(do_file_send(s, A, "a.txt", "text/plain", "aGk=", 8000, None).await.unwrap_err().code, "budget_exhausted");
        assert_eq!(node.targets().len(), requests);
    }

    #[tokio::test]
    async fn budget_scope_files_still_need_window_without_budget_approval() {
        let node = fake(AuthMode::Local, happy());
        let s = &node.state;
        assert_eq!(do_file_send(s, A, "a.txt", "text/plain", "aGk=", 8000, None).await.unwrap_err().code, "spend_locked");
        spend_advance(s, true).await.unwrap();
        do_file_send(s, A, "a.txt", "text/plain", "aGk=", 8000, None).await.unwrap();
        assert_eq!(budget_now(s).spent_msat, 3000);
    }

    #[tokio::test]
    async fn budget_scope_unknown_file_keeps_reservation_and_blocks_retry() {
        let routes: Routes = Arc::new(|m, p, b| {
            if p.ends_with("/send") { return (500, "{}".into()); }
            happy()(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        assert_eq!(do_file_send(&node.state, A, "a.txt", "text/plain", "aGk=", 8000, None).await.unwrap_err().code, "spend_unknown");
        assert_eq!(budget_now(&reopen(&node)).unsettled_msat, 8000);
        let requests = node.targets().len();
        assert_eq!(do_file_send(&node.state, A, "a.txt", "text/plain", "aGk=", 8000, None).await.unwrap_err().code, "spend_unknown");
        assert_eq!(node.targets().len(), requests);
    }

    #[tokio::test]
    async fn budget_scope_file_rechecks_limits_after_upload_before_paid_dispatch() {
        let config = Arc::new(Mutex::new(None::<PathBuf>));
        let path = config.clone();
        let routes: Routes = Arc::new(move |m, p, b| {
            if p == "/files" {
                let dir = path.lock().unwrap().clone().unwrap().parent().unwrap().join("app-spend");
                let mut book = budget::load(&dir, OWN).unwrap();
                book.set_ceiling(2000);
                budget::save(&dir, &book).unwrap();
            }
            happy()(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        *config.lock().unwrap() = node.state.config.lock().unwrap().clone();
        spend_advance(&node.state, true).await.unwrap();
        assert_eq!(do_file_send(&node.state, A, "a.txt", "text/plain", "aGk=", 8000, None).await.unwrap_err().code, "ceiling_exhausted");
        assert_eq!(node.posts().iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), ["/files"]);
        assert_eq!(budget_now(&node.state).spent_msat, 0);
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
    }

    #[tokio::test]
    async fn budget_scope_automatic_messages_and_files_share_global_total() {
        let node = fake(AuthMode::Local, happy());
        let s = &node.state;
        do_budget_approve(s, 500_000, budget::PresetId::Careful).await.unwrap();
        with_book(s, true, |b| {
            b.set_ceiling(10000);
            b.set_limit(A, false, 10000)?;
            b.set_limit(C, false, 10000)
        }).unwrap();
        // Narrow the open autopay ceiling to the test's 10-sat total.
        s.autopay.lock().unwrap().narrow(10000);
        do_message_send(s, A, false, "automatic", 7000, None).await.unwrap();
        // File to C also rides the open budget (same contact book as messages).
        do_file_send(s, C, "a.txt", "text/plain", "aGk=", 8000, None).await.unwrap();
        assert_eq!(budget_now(s).spent_msat, 5000);
        let requests = node.targets().len();
        assert_eq!(do_message_send(s, A, false, "automatic", 7000, None).await.unwrap_err().code, "ceiling_exhausted");
        assert_eq!(node.targets().len(), requests);
    }

    #[tokio::test]
    async fn budget_scope_g1_file_reserves_admission_allowance_before_dispatch() {
        for limit in ["daily", "contact"] {
            let (node, _dir, g1) = g1_node(&["read", "receive"]);
            g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
            g1_approved(&node, 500_000).await;
            spend_advance(&node.state, true).await.unwrap();
            with_book(&node.state, true, |b| {
                if limit == "daily" { b.set_ceiling(3000); }
                else { b.set_limit(A, false, 3000)?; }
                Ok(())
            }).unwrap();
            // Genome 4aa5089 can pay admission beyond the 3-sat file cap.
            // Its 50-sat recipient allowance must fit before paid dispatch.
            let error = do_file_send(&node.state, A, "a.txt", "text/plain", "aGk=", 8000, None).await.unwrap_err();
            assert_eq!(error.code, if limit == "daily" { "ceiling_exhausted" } else { "budget_exhausted" });
            assert!(!node.posts().iter().any(|(p, _)| p.ends_with("/send")));
            assert_eq!(budget_now(&node.state).spent_msat, 0);
            assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn budget_scope_direct_payments_count_and_refuse_before_dispatch() {
        for action in ["invoice", "keysend"] {
            let node = fake(AuthMode::Local, happy());
            let s = &node.state;
            spend_advance(s, true).await.unwrap();
            with_book(s, true, |b| { b.set_ceiling(10000); Ok(()) }).unwrap();
            let send = || async {
                if action == "invoice" { do_payment_pay(s, act::TEST_INVOICE_1000, 1000, 6000).await }
                else { do_payment_keysend(s, &format!("02{}", "ab".repeat(32)), 5000, None, 10000).await }
            };
            send().await.unwrap();
            let paid = if action == "invoice" { 1000 } else { 5000 };
            assert_eq!(budget_now(s).spent_msat, paid);
            assert_eq!(budget_now(&reopen(&node)).spent_msat, paid);
            if action == "invoice" {
                do_message_send(s, A, false, "one", 7000, None).await.unwrap();
                do_message_send(s, A, false, "two", 7000, None).await.unwrap();
            }
            let requests = node.targets().len();
            assert_eq!(send().await.unwrap_err().code, "ceiling_exhausted", "{action}");
            assert_eq!(node.targets().len(), requests, "{action} refused before any request");
        }
    }

    #[tokio::test]
    async fn allin_confirmed_contact_uses_its_quote_even_below_default_fee_estimate() {
        let node = fake(AuthMode::Local, happy());
        spend_advance(&node.state, true).await.unwrap();
        // A zero-fee node's signed total can be below our ordinary estimate.
        let result = do_message_send_with(&node.state, A, false, "hi", 4000, None, Some(50000)).await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(node.posts().last().unwrap().1["max_total_msat"], 4000);
    }

    #[tokio::test]
    async fn allin_missing_response_fee_retains_the_approved_allowance() {
        let routes: Routes = Arc::new(|m, p, b| {
            if p == "/payments/pay" { return (200, serde_json::json!({"payment_hash": "ab".repeat(32),
                "amount_msat": 1000, "preimage": "PREIMAGE"}).to_string()); }
            happy()(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        let receipt = do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 6000).await.unwrap();
        assert_eq!(budget_now(&node.state).spent_msat, 6000);
        assert_eq!(receipt.max_routing_fee_msat, 5000);
    }

    #[tokio::test]
    async fn allin_legacy_missing_fee_keeps_reservation_without_false_overbudget() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50000});
        *g1.compose.lock().unwrap() = Some((200, serde_json::json!({
            "message_id": "m1", "delivered": true, "amount_msat": 2000})));
        g1_approved(&node, 500000).await;
        with_book(&node.state, true, |book| book.set_limit(A, false, 50000)).unwrap();
        let receipt = do_message_send(&node.state, A, false, "hi", 7000, None).await.unwrap();
        assert_eq!(receipt.total_msat, 50000);
        assert_eq!(budget_now(&node.state).spent_msat, 50000);
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
    }

    #[tokio::test]
    async fn allin_fee_aware_node_reserves_only_the_confirmed_cap() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50000});
        g1_approved(&node, 500000).await;
        with_book(&node.state, true, |book| {
            book.set_limit(A, false, 10000)?;
            book.reserve("earlier", A, false, 2000, now_ms());
            book.settle("earlier", 2000, now_ms());
            Ok(())
        }).unwrap();
        // Prove the contract with a fresh validated node quote, as the door UI does.
        let routes: Routes = Arc::new(|m, p, b| {
            if p == "/status" { return (200, serde_json::json!({"api_capabilities": ["first_contact_grant_v1"]}).to_string()); }
            if p == "/messages/first-contact/quote" { return (200, serde_json::json!({"recipient": A,
                "admission_msat": 2000, "message_msat": 2000, "max_routing_fee_msat": 10000,
                "total_msat": 14000, "expires_at": now_unix()+60}).to_string()); }
            happy()(m, p, b)
        });
        let quote_node = fake(AuthMode::Local, routes);
        let quote = read_first_contact_quote(&quote_node.state, A).await.unwrap();
        // Same source contract; retain the evidence against this node's identity.
        assert_eq!(quote.max_routing_fee_msat, 10000);
        // Set the marker through the production quote reader on this state's API.
        let mut proven = node.state;
        let original_api = proven.api_base.clone();
        proven.api_base = quote_node.state.api_base.clone();
        read_first_contact_quote(&proven, A).await.unwrap();
        proven.api_base = original_api;
        let receipt = do_message_send(&proven, A, false, "hi", 7000, None).await.unwrap();
        assert_eq!(receipt.amount_msat, 2000);
        assert_eq!(budget_now(&proven).spent_msat, 4000);
    }

    #[tokio::test]
    async fn allin_message_receipt_includes_admission_and_aggregate_fee() {
        let routes: Routes = Arc::new(|m, p, b| {
            if p == "/messages/compose" { return (200, serde_json::json!({"message_id": "m1",
                "delivered": true, "amount_msat": 2000, "readmission_msat": 5000,
                "max_routing_fee_msat": 10000}).to_string()); }
            happy()(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        let receipt = do_message_send(&node.state, A, false, "hi", 17000, None).await.unwrap();
        assert_eq!(budget_now(&node.state).spent_msat, 17000);
        assert_eq!(serde_json::to_value(receipt).unwrap()["total_msat"], 17000);
    }

    #[tokio::test]
    async fn allin_receipt_and_replay_charge_principal_plus_reported_fee_once() {
        let routes: Routes = Arc::new(|m, p, b| {
            if p == "/payments/pay" {
                return (200, serde_json::json!({"payment_hash": "ab".repeat(32), "amount_msat": 1000,
                    "max_routing_fee_msat": 5000, "preimage": "PREIMAGE"}).to_string());
            }
            happy()(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        for _ in 0..2 {
            do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 6000).await.unwrap();
            assert_eq!(budget_now(&node.state).spent_msat, 6000);
        }
        assert_eq!(node.posts()[0].1["max_routing_fee_msat"], 5000);
    }

    #[tokio::test]
    async fn allin_principal_only_cap_refuses_before_payment_or_file_upload() {
        let node = fake(AuthMode::Local, happy());
        spend_advance(&node.state, true).await.unwrap();
        assert!(do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 1000).await.is_err());
        assert!(do_payment_keysend(&node.state, &format!("02{}", "ab".repeat(32)), 5000, None, 5000).await.is_err());
        assert!(do_file_send(&node.state, A, "a.txt", "text/plain", "aGk=", 3000, None).await.is_err());
        assert!(node.posts().is_empty());
    }

    #[tokio::test]
    async fn allin_first_contact_accepts_node_fee_quote_and_rejects_inconsistent_total() {
        for (total, valid) in [(17000, true), (7000, false)] {
            let routes: Routes = Arc::new(move |m, p, b| {
                if p == "/messages/first-contact/quote" {
                    return (200, serde_json::json!({"recipient": A, "admission_msat": 5000,
                        "message_msat": 2000, "max_routing_fee_msat": 10000,
                        "total_msat": total, "expires_at": now_ms()/1000+60}).to_string());
                }
                if p == "/status" { return (200, serde_json::json!({"api_capabilities": ["first_contact_grant_v1"]}).to_string()); }
                happy()(m, p, b)
            });
            let node = fake(AuthMode::Local, routes);
            assert_eq!(read_first_contact_quote(&node.state, A).await.is_ok(), valid);
        }
    }

    #[tokio::test]
    async fn allin_history_without_fee_keeps_full_reservation_across_restart() {
        let routes: Routes = Arc::new(|m, p, b| {
            if p == "/payments/pay" { return (200, serde_json::json!({"payment_hash": "ab".repeat(32),
                "amount_msat": 1000, "max_routing_fee_msat": 5000, "preimage": ""}).to_string()); }
            if p == "/payments?limit=100" { return (200, serde_json::json!([
                {"payment_hash": "ab".repeat(32), "amount_msat": 1000, "direction": "outgoing", "status": "settled"}
            ]).to_string()); }
            happy()(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 6000).await.unwrap();
        do_spend_reconcile(&reopen(&node)).await.unwrap();
        assert_eq!(budget_now(&node.state).spent_msat, 6000);
        assert_eq!(budget_now(&node.state).unsettled_msat, 0);
        assert_eq!(node.posts().len(), 1);
    }

    #[tokio::test]
    async fn budget_scope_invoice_replay_counts_once_across_restart() {
        let routes: Routes = Arc::new(|m, p, b| {
            if p == "/payments/pay" {
                return (200, serde_json::json!({"max_routing_fee_msat": 0, "payment_hash": "ab".repeat(32), "amount_msat": 1000, "preimage": "PREIMAGE"}).to_string());
            }
            happy()(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 7000).await.unwrap();
        do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 7000).await.unwrap();
        assert_eq!(budget_now(&node.state).spent_msat, 1000, "replaying a settled invoice is not another transfer");
        let after = reopen(&node);
        spend_advance(&after, true).await.unwrap();
        // Uppercase BOLT11 is the same invoice and the same payment identity.
        do_payment_pay(&after, &act::TEST_INVOICE_1000.to_ascii_uppercase(), 1000, 8000).await.unwrap();
        assert_eq!(budget_now(&after).spent_msat, 1000);
        assert_eq!(budget_now(&after).unsettled_msat, 0);
        assert_eq!(node.posts().iter().filter(|(p, _)| p == "/payments/pay").count(), 3);
    }

    #[tokio::test]
    async fn budget_scope_invoice_replay_reconciliation_survives_book_write_crash() {
        let pending_reply = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reply = pending_reply.clone();
        let routes: Routes = Arc::new(move |m, p, b| {
            let value = match p {
                "/payments/pay" => serde_json::json!({"max_routing_fee_msat": 0, "payment_hash": "ab".repeat(32), "amount_msat": 1000,
                    "preimage": if reply.load(std::sync::atomic::Ordering::SeqCst) { "" } else { "PREIMAGE" }}),
                "/payments?limit=100" => serde_json::json!([
                    {"payment_hash": "ab".repeat(32), "amount_msat": 1000, "direction": "outgoing", "status": "settled"}
                ]),
                _ => return happy()(m, p, b),
            };
            (200, value.to_string())
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 7000).await.unwrap();
        pending_reply.store(true, std::sync::atomic::Ordering::SeqCst);
        do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 7000).await.unwrap();
        assert_eq!(budget_now(&node.state).spent_msat, 8000, "unknown replay keeps its full reservation");
        assert_eq!(budget_now(&node.state).unsettled_msat, 7000);
        let after = reopen(&node);
        let mut pending = spend_journal(&after).unwrap().pending().unwrap().unwrap();
        do_spend_reconcile(&after).await.unwrap();
        assert_eq!(budget_now(&after).spent_msat, 1000);
        assert_eq!(budget_now(&after).unsettled_msat, 0);
        // Recreate the journal left by a crash after book save but before clear.
        pending.accounting_msat = Some(1000);
        spend_journal(&after).unwrap().save(&pending).unwrap();
        do_spend_reconcile(&reopen(&node)).await.unwrap();
        assert_eq!(budget_now(&after).spent_msat, 1000, "reconciliation must not alter the original charge");
        assert!(spend_journal(&after).unwrap().pending().unwrap().is_none());
        assert_eq!(node.posts().iter().filter(|(p, _)| p == "/payments/pay").count(), 2);
    }

    #[tokio::test]
    async fn budget_scope_keysend_deduplicates_hash_not_identical_request_body() {
        let sequence = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let routes: Routes = Arc::new(move |m, p, b| {
            if p == "/payments/keysend" {
                let call = sequence.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let hash = if call == 0 { "ab" } else { "cd" };
                return (200, serde_json::json!({"max_routing_fee_msat": 0, "payment_hash": hash.repeat(32), "amount_msat": 5000, "status": "Settled"}).to_string());
            }
            happy()(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        for expected in [5000, 10000, 10000] {
            do_payment_keysend(&node.state, &format!("02{}", "ab".repeat(32)), 5000, None, 10000).await.unwrap();
            assert_eq!(budget_now(&node.state).spent_msat, expected);
        }
        // Identical message bodies are independent sends, too.
        for _ in 0..2 { do_message_send(&node.state, A, false, "same", 7000, None).await.unwrap(); }
        assert_eq!(budget_now(&node.state).spent_msat, 14000);
    }

    #[tokio::test]
    async fn budget_scope_payment_identity_survives_compaction_and_pruning() {
        let routes: Routes = Arc::new(|m, p, b| {
            if p == "/payments/pay" {
                return (200, serde_json::json!({"max_routing_fee_msat": 0, "payment_hash": "ab".repeat(32), "amount_msat": 1000, "preimage": "PREIMAGE"}).to_string());
            }
            happy()(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 7000).await.unwrap();
        with_book(&node.state, true, |b| {
            b.ledger.extend((0..budget::LEDGER_MAX).map(|i| budget::Entry {
                id: format!("other-{i}"), at_ms: now_ms(), target: A.into(), room: false, msat: 1, settled: true,
            }));
            b.prune(now_ms());
            assert_eq!(b.ledger.len(), 2, "settled rows compacted by target");
            Ok(())
        }).unwrap();
        do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 7000).await.unwrap();
        assert_eq!(budget_now(&node.state).spent_msat, 21000);
        with_book(&node.state, true, |b| {
            for entry in &mut b.ledger { entry.at_ms = now_ms() - budget::DAY_MS - 1; }
            b.prune(now_ms());
            assert!(b.ledger.is_empty());
            Ok(())
        }).unwrap();
        let after = reopen(&node);
        spend_advance(&after, true).await.unwrap();
        do_payment_pay(&after, act::TEST_INVOICE_1000, 1000, 7000).await.unwrap();
        assert_eq!(budget_now(&after).spent_msat, 0, "old settled payment must not re-enter the rolling window");
    }

    #[tokio::test]
    async fn budget_scope_invalid_payment_identity_retains_reservation() {
        let routes: Routes = Arc::new(|m, p, b| {
            if p == "/payments/pay" {
                return (200, serde_json::json!({"max_routing_fee_msat": 0, "payment_hash": "invalid", "amount_msat": 1000, "preimage": "PREIMAGE"}).to_string());
            }
            happy()(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        assert_eq!(do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 7000).await.unwrap_err().code, "spend_unknown");
        assert_eq!(budget_now(&node.state).unsettled_msat, 7000);
        assert!(do_spend_reconcile(&reopen(&node)).await.is_err());
        assert_eq!(node.posts().len(), 1, "invalid identity never permits redispatch");
    }

    #[tokio::test]
    async fn budget_scope_pending_payment_reconciles_exact_principal_after_restart() {
        for status in ["settled", "failed"] {
            let routes: Routes = Arc::new(move |m, p, b| {
                let value = match p {
                    "/payments/pay" => serde_json::json!({"max_routing_fee_msat": 0, "payment_hash": "ab".repeat(32), "amount_msat": 1000, "preimage": ""}),
                    "/payments?limit=100" => serde_json::json!([
                        {"payment_hash": "cd".repeat(32), "amount_msat": 2000, "direction": "outgoing", "status": "settled"},
                        {"payment_hash": "ab".repeat(32), "amount_msat": 1000, "direction": "outgoing", "status": status}
                    ]),
                    _ => return happy()(m, p, b),
                };
                (200, value.to_string())
            });
            let node = fake(AuthMode::Local, routes);
            spend_advance(&node.state, true).await.unwrap();
            let receipt = do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 7000).await.unwrap();
            assert_eq!(receipt.status, "pending");
            assert_eq!(budget_now(&node.state).unsettled_msat, 7000);
            let after = reopen(&node);
            do_spend_reconcile(&after).await.unwrap();
            let b = budget_now(&after);
            assert_eq!(b.spent_msat, if status == "settled" { 7000 } else { 0 });
            assert_eq!(b.unsettled_msat, 0);
            assert!(spend_journal(&after).unwrap().pending().unwrap().is_none());
            assert_eq!(node.posts().iter().filter(|(p, _)| p == "/payments/pay").count(), 1);
        }
    }

    #[tokio::test]
    async fn budget_scope_failed_keysend_releases_principal() {
        let routes: Routes = Arc::new(|m, p, b| {
            if p == "/payments/keysend" {
                return (200, serde_json::json!({"max_routing_fee_msat": 0, "payment_hash": "ab".repeat(32), "amount_msat": 5000, "status": "Failed"}).to_string());
            }
            happy()(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        let receipt = do_payment_keysend(&node.state, &format!("02{}", "ab".repeat(32)), 5000, None, 10000).await.unwrap();
        assert_eq!(receipt.status, "failed");
        assert_eq!(budget_now(&node.state).spent_msat, 0);
        assert_eq!(budget_now(&node.state).unsettled_msat, 0);
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
    }

    #[tokio::test]
    async fn budget_scope_old_pending_payment_survives_book_write_and_reconciles() {
        let routes: Routes = Arc::new(|m, p, b| {
            let v = match p {
                "/payments/pay" => serde_json::json!({"max_routing_fee_msat": 0, "payment_hash": "ab".repeat(32), "amount_msat": 1000, "preimage": ""}),
                "/payments?limit=100" => serde_json::json!([
                    {"payment_hash": "ab".repeat(32), "amount_msat": 1000, "direction": "outgoing", "status": "settled"}
                ]),
                _ => return happy()(m, p, b),
            };
            (200, v.to_string())
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 7000).await.unwrap();
        with_book(&node.state, true, |b| {
            b.ledger[0].at_ms = now_ms() - budget::DAY_MS - 1;
            Ok(())
        }).unwrap();
        assert_eq!(budget_now(&reopen(&node)).unsettled_msat, 7000);
        do_budget_pause(&node.state).unwrap();
        let after = reopen(&node);
        let mut pending = spend_journal(&after).unwrap().pending().unwrap().unwrap();
        do_spend_reconcile(&after).await.unwrap();
        assert_eq!(budget_now(&after).unsettled_msat, 0);
        assert_eq!(budget_now(&after).spent_msat, 7000, "aged liability is conservatively dated at reconciliation");
        assert!(spend_journal(&after).unwrap().pending().unwrap().is_none());
        // Crash after durable settlement but before removing the journal.
        pending.accounting_msat = Some(1000);
        spend_journal(&after).unwrap().save(&pending).unwrap();
        // Even another day and a budget write cannot remove journalled accounting.
        with_book(&after, true, |b| {
            b.ledger[0].at_ms = now_ms() - budget::DAY_MS - 1;
            Ok(())
        }).unwrap();
        do_spend_reconcile(&reopen(&node)).await.unwrap();
        assert!(spend_journal(&after).unwrap().pending().unwrap().is_none());
        assert_eq!(node.posts().iter().filter(|(p, _)| p == "/payments/pay").count(), 1);
    }

    // ---- B2: invisible payments ------------------------------------------------

    fn budget_now(state: &NodeState) -> budget::BudgetView {
        budget_view(state).unwrap()
    }

    /// The same data directory in a fresh process: everything in memory is gone.
    fn reopen(node: &Fake) -> NodeState {
        let state = NodeState::for_api(node.state.api_base.clone());
        *state.config.lock().unwrap() = node.state.config.lock().unwrap().clone();
        *state.node_id.lock().unwrap() = Some(OWN.into());
        *state.token.lock().unwrap() = Some("tok.1".into());
        *state.auth.lock().unwrap() = AuthMode::Local;
        state
    }

    fn composes(node: &Fake) -> usize {
        node.posts().iter().filter(|(p, _)| p == "/messages/compose").count()
    }

    #[tokio::test]
    async fn one_budget_approval_pays_messages_without_opening_the_window() {
        let node = fake(AuthMode::Local, happy());
        let s = &node.state;
        let view = do_budget_approve(s, 500_000, budget::PresetId::Careful).await.unwrap();
        assert_eq!(view.autopay.state, budget::AutopayState::Open);
        assert!(view.autopay.open_until_ms.unwrap() - now_ms() > budget::BUDGET_WINDOW_MS - 60_000);
        assert_eq!(spend_advance(s, false).await.unwrap().state, act::SpendState::Locked, "the ten-minute window stays shut");
        assert!(node.targets().is_empty(), "rc7 has nothing to ask");

        // A stranger is never paid automatically: asked once, before any request.
        assert_eq!(do_message_send(s, A, false, "gm", 7000, None).await.unwrap_err().code, "first_contact");
        assert!(node.targets().is_empty());
        do_message_send_with(s, A, false, "gm", 7000, None, Some(50_000)).await.unwrap();
        // After the one OK, the next message just goes.
        do_message_send(s, A, false, "again", 7000, None).await.unwrap();
        assert_eq!(composes(&node), 2);
        for (_, body) in node.posts().iter().filter(|(p, _)| p == "/messages/compose") {
            assert_eq!(body["max_total_msat"], 7000, "every send keeps the node-enforced cap");
        }
        let v = budget_now(s);
        assert_eq!((v.spent_msat, v.unsettled_msat), (4000, 0));
        assert_eq!(v.rows, [budget::Row { target: A.into(), room: false, limit_msat: Some(50_000), spent_msat: 4000 }]);
        // Pay still needs the ten-minute window; files share the message budget route.
        assert_eq!(do_payment_pay(s, act::TEST_INVOICE_1000, 1000, 6000).await.unwrap_err().code, "spend_locked");
        do_file_send(s, A, "note.txt", "text/plain", "aGk=", 8000, None).await.unwrap();
    }

    #[tokio::test]
    async fn an_exhausted_budget_is_refused_before_any_request_and_the_cap_still_rides_along() {
        let node = fake(AuthMode::Local, happy());
        let s = &node.state;
        do_budget_approve(s, 500_000, budget::PresetId::Careful).await.unwrap();
        with_book(s, true, |b| b.set_limit(A, false, 10000)).unwrap();
        do_message_send(s, A, false, "one", 7000, None).await.unwrap();
        do_message_send(s, A, false, "two", 7000, None).await.unwrap();
        let err = do_message_send(s, A, false, "three", 7000, None).await.unwrap_err();
        assert_eq!(err.code, "budget_exhausted");
        assert!(err.message.contains("used 4 of 10 sats"), "{}", err.message);
        // A cap above what is left is refused too, not trimmed.
        assert_eq!(do_message_send(s, A, false, "big", 6001, None).await.unwrap_err().code, "budget_exhausted");
        assert_eq!(composes(&node), 2);
        // An open ten-minute window does not override a contact's budget.
        spend_advance(s, true).await.unwrap();
        assert_eq!(do_message_send(s, A, false, "three", 7000, None).await.unwrap_err().code, "budget_exhausted");
        // Raising within the daily total is the owner's tap, and the send goes.
        with_book(s, true, |b| b.set_limit(A, false, 15_000)).unwrap();
        do_message_send(s, A, false, "three", 7000, None).await.unwrap();
        assert_eq!(composes(&node), 3);
    }

    #[tokio::test]
    async fn the_daily_total_caps_all_contacts_and_lowering_it_needs_no_approval() {
        let node = fake(AuthMode::Local, happy());
        let s = &node.state;
        do_budget_approve(s, 10000, budget::PresetId::Careful).await.unwrap();
        do_message_send_with(s, A, false, "a", 7000, None, Some(10000)).await.unwrap();
        do_message_send_with(s, C, false, "c", 7000, None, Some(10000)).await.unwrap();
        assert_eq!(do_message_send(s, C, false, "c", 7000, None).await.unwrap_err().code, "ceiling_exhausted");
        // Narrowing an open approval stays open, with the lower number.
        let v = do_budget_approve(s, 4000, budget::PresetId::Careful).await.unwrap();
        assert_eq!((v.autopay.state, v.autopay.ceiling_msat, v.ceiling_msat), (budget::AutopayState::Open, Some(4000), 4000));
        assert_eq!(v.rows.iter().map(|r| r.limit_msat).collect::<Vec<_>>(), [Some(4000), Some(4000)], "budgets above the total narrow with it");
    }

    #[tokio::test]
    async fn a_restart_keeps_the_tally_and_drops_the_approval() {
        let node = fake(AuthMode::Local, happy());
        do_budget_approve(&node.state, 500_000, budget::PresetId::Careful).await.unwrap();
        do_message_send_with(&node.state, A, false, "gm", 7000, None, Some(50_000)).await.unwrap();

        let after = reopen(&node);
        let v = budget_now(&after);
        assert_eq!(v.autopay.state, budget::AutopayState::Off, "the approval was never written down");
        assert_eq!((v.spent_msat, v.rows[0].limit_msat), (2000, Some(50_000)), "the numbers were");
        assert_eq!(do_message_send(&after, A, false, "gm", 7000, None).await.unwrap_err().code, "spend_locked");
        assert_eq!(composes(&node), 1);

        do_budget_approve(&after, 500_000, budget::PresetId::Careful).await.unwrap();
        do_message_send(&after, A, false, "gm", 7000, None).await.unwrap();
        assert_eq!(budget_now(&after).spent_msat, 4000);

        let dir = node.state.config.lock().unwrap().clone().unwrap().parent().unwrap().join("app-spend");
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let text = std::fs::read_to_string(&path).unwrap_or_default().to_ascii_lowercase();
            for word in ["grant", "scope", "tok.", "approv", "gm"] {
                assert!(!text.contains(word), "{word} reached {}: {text}", path.display());
            }
        }
    }

    #[tokio::test]
    async fn pause_stops_every_payment_until_resumed_even_across_a_restart() {
        let node = fake(AuthMode::Local, happy());
        let s = &node.state;
        do_budget_approve(s, 500_000, budget::PresetId::Careful).await.unwrap();
        spend_advance(s, true).await.unwrap();
        do_message_send_with(s, A, false, "gm", 7000, None, Some(50_000)).await.unwrap();

        let v = do_budget_pause(s).unwrap();
        assert!(v.paused);
        assert_eq!(v.autopay.state, budget::AutopayState::Off);
        assert_eq!(do_message_send(s, A, false, "gm", 7000, None).await.unwrap_err().code, "budget_paused");
        assert_eq!(do_payment_pay(s, act::TEST_INVOICE_1000, 1000, 6000).await.unwrap_err().code, "spend_locked", "the window closed too");
        assert_eq!(spend_advance(s, true).await.unwrap_err().code, "budget_paused");
        assert_eq!(do_budget_approve(s, 500_000, budget::PresetId::Careful).await.unwrap_err().code, "budget_paused");

        let after = reopen(&node);
        assert_eq!(do_message_send(&after, A, false, "gm", 7000, None).await.unwrap_err().code, "budget_paused");
        let v = do_budget_resume(&after).await.unwrap();
        assert!(!v.paused);
        assert_eq!(v.autopay.state, budget::AutopayState::Open);
        do_message_send(&after, A, false, "gm", 7000, None).await.unwrap();
        assert_eq!(composes(&node), 2);
    }

    #[tokio::test]
    async fn an_unknown_outcome_keeps_the_ceiling_counted_and_a_cap_refusal_releases_it() {
        let conflict = Arc::new(AtomicUsize::new(0));
        let c = conflict.clone();
        let routes: Routes = Arc::new(move |m: &str, p: &str, b: &str| {
            if p == "/messages/compose" {
                return if c.fetch_add(1, Ordering::SeqCst) == 0 {
                    (409, serde_json::json!({"code":"price_cap_exceeded"}).to_string())
                } else {
                    (502, "bad gateway".into())
                };
            }
            happy()(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        let s = &node.state;
        do_budget_approve(s, 500_000, budget::PresetId::Careful).await.unwrap();
        assert_eq!(do_message_send_with(s, A, false, "gm", 7000, None, Some(50_000)).await.unwrap_err().code, "price_cap_exceeded");
        assert_eq!(budget_now(s).spent_msat, 0, "refused before any payment: nothing counted");
        assert_eq!(budget_now(s).rows[0].limit_msat, Some(50_000), "the owner's OK still stands");
        assert_eq!(do_message_send(s, A, false, "gm", 7000, None).await.unwrap_err().code, "spend_unknown");
        let v = budget_now(s);
        assert_eq!((v.spent_msat, v.unsettled_msat), (7000, 7000));
        assert_eq!(budget_now(&reopen(&node)).unsettled_msat, 7000, "and it survives a restart");
    }

    #[tokio::test]
    async fn a_node_refusal_ends_the_budget_approval_and_releases_the_reservation() {
        let routes: Routes = Arc::new(|m: &str, p: &str, b: &str| {
            if p == "/messages/compose" { (403, "token lacks required scope: spend".into()) } else { happy()(m, p, b) }
        });
        let node = fake(AuthMode::Local, routes);
        let s = &node.state;
        do_budget_approve(s, 500_000, budget::PresetId::Careful).await.unwrap();
        assert_eq!(do_message_send_with(s, A, false, "gm", 7000, None, Some(50_000)).await.unwrap_err().code, "spend_refused");
        let v = budget_now(s);
        assert_eq!((v.autopay.state, v.spent_msat), (budget::AutopayState::Off, 0));
    }

    #[tokio::test]
    async fn a_paired_budget_grant_opens_autopay_and_not_the_window() {
        let polls = Arc::new(AtomicUsize::new(0));
        let p = polls.clone();
        let far = now_unix() + 900;
        let routes: Routes = Arc::new(move |m: &str, path: &str, b: &str| {
            let v = match path {
                "/pair/elevation-request" => serde_json::json!({"op_id": "ab12", "expires_at": far, "owner_action": "konsensus grant --op ab12"}),
                "/pair/elevation/ab12" => {
                    let n = p.fetch_add(1, Ordering::SeqCst);
                    serde_json::json!({"op_id": "ab12", "status": if n == 0 { "pending" } else { "granted" }})
                }
                r if r.starts_with("/pair/challenge") => serde_json::json!({"challenge": "bitsov-pair-token-v1:00ff"}),
                "/pair/token" => serde_json::json!({"token": "tok.spend", "expires_at": far, "scopes": ["read", "receive", "spend"]}),
                _ => return happy()(m, path, b),
            };
            (200, v.to_string())
        });
        let (node, _dir) = paired_fake(routes);
        let s = &node.state;
        let v = do_budget_approve(s, 500_000, budget::PresetId::Careful).await.unwrap();
        assert!(v.waiting_for_owner);
        assert_eq!(v.autopay.state, budget::AutopayState::Off);
        assert_eq!(node.posts()[0], ("/pair/elevation-request".to_string(), serde_json::json!({"scopes": ["spend"]})));

        assert_eq!(spend_advance(s, false).await.unwrap().state, act::SpendState::Pending);
        let window = spend_advance(s, false).await.unwrap();
        assert_eq!(window.state, act::SpendState::Locked, "the grant answered a budget ask only");
        let v = budget_now(s);
        assert_eq!((v.autopay.state, v.autopay.basis, v.waiting_for_owner), (budget::AutopayState::Open, Some(act::SpendBasis::NodeGrant), false));
        do_message_send_with(s, A, false, "gm", 7000, None, Some(50_000)).await.unwrap();
        let last = node.seen.lock().unwrap().last().cloned().unwrap();
        assert_eq!((last.1.as_str(), last.2.as_deref()), ("/api/v1/messages/compose", Some("tok.spend")));
        assert_eq!(do_payment_pay(s, act::TEST_INVOICE_1000, 1000, 6000).await.unwrap_err().code, "spend_locked");
    }

    // ---- G1: budget-scoped node grants -----------------------------------------

    /// A G1 node: advertises `spend_budget_grant_v1`, grants on the second poll,
    /// and answers `GET /pair/grant` with whatever `grant` holds. `compose`
    /// overrides the message reply.
    struct G1 {
        grant: Arc<Mutex<serde_json::Value>>,
        compose: Arc<Mutex<Option<(u16, serde_json::Value)>>>,
        grant_status: Arc<Mutex<u16>>,
        /// When set, the node advertises `first_contact_grant_v1` and answers
        /// `POST /pair/first-contact-grant` with this.
        first_contact: Arc<Mutex<Option<(u16, serde_json::Value)>>>,
        quote: Arc<Mutex<Option<serde_json::Value>>>,
    }

    fn g1_grant(expires_in_secs: i64, budget_msat: u64, remaining_msat: u64) -> serde_json::Value {
        let now = now_unix();
        serde_json::json!({"op_id": "ab12", "client_id": "c1", "granted_at": now, "expires_at": now + expires_in_secs,
            "budget_msat": budget_msat, "used_msat": budget_msat - remaining_msat, "remaining_msat": remaining_msat,
            "per_call_max_msat": budget_msat, "per_recipient_msat": {}, "used_by_recipient": {}})
    }

    fn g1_node(scopes: &[&str]) -> (Fake, tempfile::TempDir, G1) {
        g1_node_with(scopes, None)
    }

    /// [`g1_node`] with `first` answering before it; its status 0 falls through.
    fn g1_node_with(scopes: &[&str], first: Option<Routes>) -> (Fake, tempfile::TempDir, G1) {
        let g1 = G1 {
            grant: Arc::new(Mutex::new(g1_grant(3600, 400_000, 400_000))),
            compose: Arc::new(Mutex::new(None)),
            grant_status: Arc::new(Mutex::new(200)),
            first_contact: Arc::new(Mutex::new(None)),
            quote: Arc::new(Mutex::new(None)),
        };
        let (grant, compose, grant_status) = (g1.grant.clone(), g1.compose.clone(), g1.grant_status.clone());
        let first_contact = g1.first_contact.clone();
        let quote = g1.quote.clone();
        let polls = Arc::new(AtomicUsize::new(0));
        let far = now_unix() + 900;
        let routes: Routes = Arc::new(move |m: &str, path: &str, b: &str| {
            if let Some(first) = &first {
                let (status, body) = first(m, path, b);
                if status != 0 { return (status, body); }
            }
            let v = match path {
                "/messages/first-contact/quote" if quote.lock().unwrap().is_some() => quote.lock().unwrap().clone().unwrap(),
                "/status" if first_contact.lock().unwrap().is_some() => serde_json::json!({"api_capabilities": [
                    "paid_send_caps_v1", "room_terminal_outcomes_v1", "spend_budget_grant_v1", "first_contact_grant_v1"]}),
                "/status" => serde_json::json!({"lightning_backend":"mock", "api_capabilities": ["paid_send_caps_v1", "room_terminal_outcomes_v1", "spend_budget_grant_v1"]}),
                "/pair/first-contact-grant" if first_contact.lock().unwrap().is_some() => {
                    let asked: serde_json::Value = serde_json::from_str(b).unwrap();
                    let current = grant.lock().unwrap();
                    if let Some(existing) = current["per_recipient_msat"][asked["recipient"].as_str().unwrap()].as_u64() {
                        if asked["contact_budget_msat"].as_u64() != Some(existing) {
                            return (409, serde_json::json!({"code": "budget_exceeded", "reason": "first_contact"}).to_string());
                        }
                    }
                    let (status, body) = first_contact.lock().unwrap().clone().unwrap();
                    return (status, body.to_string());
                }
                "/pair/grant" => {
                    let status = *grant_status.lock().unwrap();
                    return (status, serde_json::json!({"grant": *grant.lock().unwrap()}).to_string());
                }
                "/pair/elevation-request" => serde_json::json!({"op_id": "ab12", "expires_at": far, "owner_action": "konsensus grant --op ab12"}),
                "/pair/elevation/ab12" => {
                    let n = polls.fetch_add(1, Ordering::SeqCst);
                    serde_json::json!({"op_id": "ab12", "status": if n == 0 { "pending" } else { "granted" }})
                }
                r if r.starts_with("/pair/challenge") => serde_json::json!({"challenge": "bitsov-pair-token-v1:00ff"}),
                "/pair/token" => serde_json::json!({"token": "tok.spend", "expires_at": far, "scopes": ["read", "receive", "spend"]}),
                "/messages/compose" if compose.lock().unwrap().is_some() => {
                    let (status, body) = compose.lock().unwrap().clone().unwrap();
                    return (status, body.to_string());
                }
                _ => return happy()(m, path, b),
            };
            (200, v.to_string())
        });
        let (node, dir) = paired_fake(routes);
        if let AuthMode::Paired(session) = &mut *node.state.auth.lock().unwrap() {
            session.scopes = scopes.iter().map(|s| s.to_string()).collect();
        }
        (node, dir, g1)
    }

    // ---- device keys, relation intents, persisted approvals ----------------

    /// The node's side of device keys. Every signature is verified with
    /// `ring` against the exact bytes the node rebuilds, as the node does.
    #[cfg(target_os = "macos")]
    struct DeviceNode {
        registered: Arc<std::sync::atomic::AtomicBool>,
        intents: Arc<Mutex<Vec<serde_json::Value>>>,
    }

    #[cfg(target_os = "macos")]
    fn device_node() -> (DeviceNode, Routes) {
        use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_ASN1};
        let d = DeviceNode { registered: Arc::new(std::sync::atomic::AtomicBool::new(false)), intents: Arc::new(Mutex::new(Vec::new())) };
        let (registered, intents) = (d.registered.clone(), d.intents.clone());
        let public: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let far = now_unix() + 900;
        let verify = |public: &str, msg: &str, sig: &str| {
            UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, hex::decode(public).unwrap())
                .verify(msg.as_bytes(), &hex::decode(sig).unwrap_or_default())
                .is_ok()
        };
        let routes: Routes = Arc::new(move |m: &str, path: &str, b: &str| {
            let body: serde_json::Value = serde_json::from_str(b).unwrap_or_default();
            let v = match (m, path) {
                ("GET", "/pair/device-keys") => serde_json::json!({"node": "fp1", "client_id": "c1", "owner_control": true,
                    "device_keys": if registered.load(Ordering::SeqCst) { serde_json::json!([{"key_id": "k1", "fingerprint": "K1K1-0000", "name": "mac", "registered_at": 1}]) } else { serde_json::json!([]) }}),
                ("POST", "/pair/device-key") => {
                    let pk = body["public_key"].as_str().unwrap().to_string();
                    if !verify(&pk, &device::registration_message("fp1", "c1", &pk), body["proof"].as_str().unwrap()) {
                        return (403, r#"{"error":"bad proof"}"#.into());
                    }
                    *public.lock().unwrap() = Some(pk);
                    serde_json::json!({"op_id": "dd01", "key_id": "k1", "fingerprint": "K1K1-0000", "expires_at": far,
                        "owner_action": "konsensus device approve --op dd01 --config /n/konsensus.toml"})
                }
                ("GET", "/pair/device-key/dd01") => serde_json::json!({"status": if registered.load(Ordering::SeqCst) { "registered" } else { "pending" }}),
                ("DELETE", _) => serde_json::json!({"status": "cancelled"}),
                ("POST", "/pair/relation-intent") => {
                    let i = &body["intent"];
                    let intent = device::Intent {
                        device_key_id: i["device_key_id"].as_str().unwrap().into(), peer: i["peer"].as_str().unwrap().into(),
                        level: i["level"].as_u64().unwrap() as u8, budget_msat: i["budget_msat"].as_u64().unwrap(),
                        per_act_max_msat: i["per_act_max_msat"].as_u64().unwrap(), window_secs: i["window_secs"].as_i64().unwrap(),
                        issued_at: i["issued_at"].as_i64().unwrap(), nonce: i["nonce"].as_str().unwrap().into(),
                    };
                    let pk = public.lock().unwrap().clone().unwrap();
                    if !verify(&pk, &device::intent_message("fp1", "c1", &intent), body["signature"].as_str().unwrap()) {
                        return (403, r#"{"error":"bad signature"}"#.into());
                    }
                    intents.lock().unwrap().push(i.clone());
                    serde_json::json!({"grant": {}})
                }
                _ => return (0, String::new()),
            };
            (200, v.to_string())
        });
        (d, routes)
    }

    /// A relation grant as the node reports it: one envelope, for `peer`.
    #[cfg(target_os = "macos")]
    fn relation_grant(peer: &str, per_act_msat: u64) -> serde_json::Value {
        let now = now_unix();
        serde_json::json!({"op_id": "rel-1", "client_id": "c1", "granted_at": now, "expires_at": now + 86_400,
            "budget_msat": 200_000, "used_msat": 0, "remaining_msat": 200_000, "per_call_max_msat": 200_000,
            "per_recipient_msat": {peer: 200_000}, "used_by_recipient": {}, "recipients_only": true,
            "per_act_max_by_recipient": {peer: per_act_msat}, "recipient_expires_at": {peer: now + 86_400}})
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn register_once_then_a_touch_id_envelope_opens_sending_to_that_contact_only() {
        let (dn, first) = device_node();
        let (node, _dir, g1) = g1_node_with(&["read", "receive"], Some(first));
        // Test keys sign without a prompt; production keys always need Touch ID.
        *node.state.device_policy.lock().unwrap() = device_key::Policy::NoPromptForTests;
        let s = &node.state;
        assert_eq!(do_device_key_status(s).await.unwrap().state, device::DeviceState::None);
        assert_eq!(do_relation_approve(s, A, None, None, Some(7000)).await.unwrap_err().code, "device_not_registered");

        // Register: the node checked the proof; the owner must approve at the node.
        let view = do_device_key_register(s).await.unwrap();
        assert_eq!(view.state, device::DeviceState::Pending);
        assert_eq!(view.owner_action.as_deref(), Some("konsensus device approve --op dd01 --config /n/konsensus.toml"));
        assert_eq!(view.fingerprint.as_deref(), Some("K1K1-0000"));
        assert_eq!(do_device_key_status(s).await.unwrap().state, device::DeviceState::Pending);
        dn.registered.store(true, Ordering::SeqCst);
        assert_eq!(do_device_key_status(s).await.unwrap().state, device::DeviceState::Registered);
        // Nothing but the public key and the proof left this app.
        let store = device_store(s).unwrap();
        let blob = std::fs::read(store.join(device::BLOB_FILE)).unwrap();
        let sent = node.posts().into_iter().find(|(p, _)| p == "/pair/device-key").unwrap().1;
        assert!(!sent.to_string().contains(&hex::encode(&blob)));

        // One tap for Maya: the node verified the signature over the exact terms.
        *g1.grant.lock().unwrap() = relation_grant(A, 7000);
        let view = do_relation_approve(s, A, Some("Maya"), None, Some(7000)).await.unwrap();
        assert_eq!((view.state, view.basis), (act::SpendState::Open, Some(act::SpendBasis::NodeGrant)));
        let intents = dn.intents.lock().unwrap().clone();
        assert_eq!(intents.len(), 1);
        assert_eq!((intents[0]["peer"].as_str(), intents[0]["budget_msat"].as_u64(), intents[0]["per_act_max_msat"].as_u64(), intents[0]["level"].as_u64()),
            (Some(A), Some(200_000), Some(7000), Some(1)));

        do_message_send(s, A, false, "gm", 7000, None).await.unwrap();
        // Another contact has no envelope: refused before any request to the node.
        let before = node.posts().len();
        assert_eq!(do_message_send(s, C, false, "gm", 7000, None).await.unwrap_err().code, "grant_no_envelope");
        assert_eq!(node.posts().len(), before);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_pending_registration_can_be_cancelled_and_a_revoked_key_is_noticed() {
        let (dn, first) = device_node();
        let (node, _dir, _g1) = g1_node_with(&["read", "receive"], Some(first));
        *node.state.device_policy.lock().unwrap() = device_key::Policy::NoPromptForTests;
        let s = &node.state;
        do_device_key_register(s).await.unwrap();
        let view = do_device_key_cancel(s).await.unwrap();
        assert_eq!(view.state, device::DeviceState::None);
        assert!(node.targets().contains(&"DELETE /pair/device-key/dd01".to_string()), "{:?}", node.targets());

        // Registered, then revoked at the node: the app stops offering Touch ID.
        do_device_key_register(s).await.unwrap();
        dn.registered.store(true, Ordering::SeqCst);
        assert_eq!(do_device_key_status(s).await.unwrap().state, device::DeviceState::Registered);
        dn.registered.store(false, Ordering::SeqCst);
        assert_eq!(do_device_key_status(s).await.unwrap().state, device::DeviceState::None);
    }

    #[tokio::test]
    async fn a_pending_console_approval_survives_an_app_restart_and_can_be_cancelled() {
        let (first, _dir1) = paired_fake(asking_node("pending", "konsensus grant --op {op}"));
        let view = spend_advance(&first.state, true).await.unwrap();
        let op = view.pending.unwrap().op_id;
        let app_dir = first.state.config.lock().unwrap().clone();

        // A new run of the app over the same data: it resumes waiting on `op`.
        let (second, _dir2) = paired_fake(asking_node("pending", "konsensus grant --op {op}"));
        *second.state.config.lock().unwrap() = app_dir;
        let view = spend_advance(&second.state, false).await.unwrap();
        assert_eq!(view.state, act::SpendState::Pending);
        assert_eq!(view.pending.unwrap().op_id, op);
        assert!(second.posts().iter().all(|(p, _)| p != "/pair/elevation-request"), "no second request");

        // Cancel: withdrawn at the node, forgotten here and on disk.
        let view = do_spend_cancel(&second.state).await.unwrap();
        assert_eq!(view.state, act::SpendState::Locked);
        assert!(second.targets().contains(&format!("DELETE /pair/elevation/{op}")), "{:?}", second.targets());
        assert!(!approvals_file(&second.state).unwrap().exists());
    }

    /// Ask for a budget and let the owner grant it at the node.
    async fn g1_approved(node: &Fake, ceiling: u64) -> budget::BudgetView {
        do_budget_approve(&node.state, ceiling, budget::PresetId::Careful).await.unwrap();
        spend_advance(&node.state, false).await.unwrap();
        spend_advance(&node.state, false).await.unwrap();
        budget_now(&node.state)
    }

    #[tokio::test]
    async fn g1_the_ask_carries_a_budget_and_the_node_grant_bounds_the_approval() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
        // The owner granted 400 sats for one hour, less than the 500 asked for.
        let v = g1_approved(&node, 500_000).await;
        assert_eq!(node.posts()[0], ("/pair/elevation-request".to_string(), serde_json::json!({
            "scopes": ["spend"],
            "budget": {"budget_msat": 500_000, "ttl_secs": 86_400, "per_recipient_msat": {A: 50_000}},
        })));
        assert_eq!((v.autopay.state, v.autopay.ceiling_msat), (budget::AutopayState::Open, Some(400_000)), "the ceiling is the node's");
        let expires = g1.grant.lock().unwrap()["expires_at"].as_u64().unwrap() * 1000;
        assert_eq!(v.autopay.open_until_ms, Some(expires), "the approval ends with the node grant, not in 24 h");
        let node_view = v.node_grant.unwrap();
        assert_eq!((node_view.budget_msat, node_view.remaining_msat, node_view.expires_at_ms), (400_000, 400_000, expires));
        assert_eq!(spend_advance(&node.state, false).await.unwrap().state, act::SpendState::Locked, "a budget ask opens no window");

        do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap();
        // The grant was read again right before the paid request.
        let t = node.targets();
        let compose = t.iter().position(|x| x == "POST /messages/compose").unwrap();
        assert_eq!(t[compose - 1], "GET /pair/grant");
    }

    async fn owner_approves_contact(node: &Fake, recipient: &str, cap: u64, budget: Option<u64>) -> owner_contact::View {
        let view = do_first_contact_request(&node.state, recipient, cap, budget).await.unwrap().unwrap();
        assert!(!do_first_contact_status(&node.state, &view.id).await.unwrap().ready);
        let response = node.state.http.post(format!("{}/pair/first-contact-grant", node.state.api_base))
            .bearer_auth("independent.owner.fixture")
            .json(&view.request).send().await.unwrap();
        assert!(response.status().is_success());
        let receipt: serde_json::Value = response.json().await.unwrap();
        node.state.owner_contact.lock().unwrap().as_ref().unwrap().write_receipt(
            receipt["recipient"].as_str().unwrap(), receipt["max_total_msat"].as_u64().unwrap(), receipt["expires_at"].as_i64().unwrap());
        assert!(do_first_contact_status(&node.state, &view.id).await.unwrap().ready);
        view
    }

    /// Where the first-contact grant sits among the POSTs, if anywhere.
    fn first_contact_then_compose(node: &Fake) -> Option<(serde_json::Value, String)> {
        // Quote POSTs only read prices; they cannot consume the owner grant.
        let posts: Vec<_> = node.posts().into_iter().filter(|(p, _)| p != "/messages/first-contact/quote").collect();
        let i = posts.iter().position(|(path, _)| path == "/pair/first-contact-grant")?;
        Some((posts[i].1.clone(), posts.get(i + 1).map(|(p, _)| p.clone()).unwrap_or_default()))
    }

    #[tokio::test]
    async fn first_contact_never_sends_a_paired_token_to_the_owner_grant_route() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        *g1.first_contact.lock().unwrap() =
            Some((403, serde_json::json!({"error": "independent owner authority required"})));
        g1_approved(&node, 500_000).await;

        let result = do_message_send_with(
            &node.state, C, false, "hello stranger", 10000, None, Some(50_000),
        ).await;

        assert!(call_api(&node.state, reqwest::Method::POST, "/pair/first-contact-grant", None).await.is_err());
        assert!(!node.seen.lock().unwrap().iter().any(|(_, path, token, _)|
            path == "/api/v1/pair/first-contact-grant" && token.as_deref() == Some("tok.spend")
        ), "paired spend authority must never be sent to the owner-only first-contact route");
        assert!(result.is_err(), "the owner has not approved this contact");
        assert!(!node.posts().iter().any(|(path, _)| path == "/messages/compose"));
    }

    #[tokio::test]
    async fn g1_a_first_contact_is_confirmed_at_the_node_for_exactly_this_contact_and_cap() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        *g1.first_contact.lock().unwrap() =
            Some((200, serde_json::json!({"recipient": C, "max_total_msat": 10000, "expires_at": now_unix() + 120})));
        g1_approved(&node, 500_000).await;
        let waiting = do_message_send_with(&node.state, C, false, "hello stranger", 10000, None, Some(50_000)).await.unwrap_err();
        assert_eq!(waiting.code, "owner_only");
        owner_approves_contact(&node, C, 10000, Some(50_000)).await;
        do_message_send_with(&node.state, C, false, "hello stranger", 10000, None, Some(50_000)).await.unwrap();
        assert!(!node.seen.lock().unwrap().iter().any(|(_, path, token, _)| path.ends_with("/first-contact-grant") && token.as_deref() != Some("independent.owner.fixture")));
        let (body, next) = first_contact_then_compose(&node).expect("the owner's OK reached the node");
        assert_eq!(body, serde_json::json!({"client_id": "c1", "grant_op_id": "ab12", "recipient": C, "max_total_msat": 10000, "contact_budget_msat": 50_000}),
            "the budget chosen on the door card makes the contact budgeted at the node");
        assert_eq!(next, "/messages/compose", "the grant is asked for right before the send it covers");
        assert_eq!(node.posts().last().unwrap().1["max_total_msat"], 10000);
    }

    #[tokio::test]
    async fn owner_contact_cancel_pause_expiry_and_replaced_grants_never_send() {
        for stop in ["cancel", "pause", "expired", "recipient", "cap", "grant", "client"] {
            let (node, _dir, g1) = g1_node(&["read", "receive"]);
            *g1.first_contact.lock().unwrap() = Some((200, serde_json::json!({
                "recipient": C, "max_total_msat": 10000, "expires_at": now_unix() + 120,
            })));
            g1_approved(&node, 500_000).await;
            let view = do_first_contact_request(&node.state, C, 10000, Some(50_000)).await.unwrap().unwrap();
            let (recipient, cap, expiry) = match stop {
                "recipient" => (A, 10000, now_unix() + 120),
                "cap" => (C, 11000, now_unix() + 120),
                "expired" => (C, 10000, now_unix() - 1),
                _ => (C, 10000, now_unix() + 120),
            };
            node.state.owner_contact.lock().unwrap().as_ref().unwrap().write_receipt(recipient, cap, expiry);
            match stop {
                "cancel" => do_first_contact_cancel(&node.state, &view.id),
                "pause" => { do_budget_pause(&node.state).unwrap(); },
                "grant" => g1.grant.lock().unwrap()["op_id"] = "cd34".into(),
                "client" => g1.grant.lock().unwrap()["client_id"] = "c2".into(),
                _ => {},
            }
            assert!(do_first_contact_status(&node.state, &view.id).await.is_err(), "{stop}");
            assert!(do_message_send_with(&node.state, C, false, "do not send", 10000, None, Some(50_000)).await.is_err(), "{stop}");
            assert!(!node.posts().iter().any(|(p, _)| p == "/messages/compose" || p == "/pair/first-contact-grant"), "{stop}");
        }
    }

    #[tokio::test]
    async fn public_receipt_cannot_replace_the_nodes_actual_approval() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        *g1.first_contact.lock().unwrap() = Some((403, serde_json::json!({})));
        g1_approved(&node, 500_000).await;
        let view = do_first_contact_request(&node.state, C, 10000, Some(50_000)).await.unwrap().unwrap();
        node.state.owner_contact.lock().unwrap().as_ref().unwrap().write_receipt(C, 10000, now_unix() + 120);
        assert!(do_first_contact_status(&node.state, &view.id).await.unwrap().ready);
        *g1.compose.lock().unwrap() = Some((409, serde_json::json!({"code": "budget_exceeded", "reason": "first_contact", "error": "no independent owner approval"})));
        assert!(do_message_send_with(&node.state, C, false, "no approval", 10000, None, Some(50_000)).await.is_err());
        assert_eq!(with_book(&node.state, false, |b| Ok(b.spent(C, false, now_ms()))).unwrap(), 0);
        assert!(node.state.owner_contact.lock().unwrap().is_none(), "a receipt cannot be replayed");
    }

    #[tokio::test]
    async fn review_l4_readmission_respects_lowered_contact_limit() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
        g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
        g1_approved(&node, 500_000).await;
        // A supported local budget edit need not reissue the wider node grant.
        with_book(&node.state, true, |b| b.set_limit(A, false, 3_000)).unwrap();
        *g1.compose.lock().unwrap() = Some((200, serde_json::json!({"max_routing_fee_msat": 0,
            "message_id": "ab".repeat(32), "delivered": true,
            "amount_msat": 2000, "readmission_msat": 20_000,
        })));
        let sent = do_message_send(&node.state, A, false, "after reconnect", 7000, None).await;
        let book = budget_now(&node.state);
        assert!(book.rows[0].spent_msat <= 3_000,
            "local contact limit=3000, paid={} after result={sent:?}; posts={:?}", book.rows[0].spent_msat, node.posts());
        assert!(sent.is_err());
        assert!(!node.posts().iter().any(|(p, _)| p == "/messages/compose"));
    }

    #[tokio::test]
    async fn review_l4_readmission_respects_lowered_daily_limit() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
        g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
        g1_approved(&node, 500_000).await;
        do_budget_approve(&node.state, 3_000, budget::PresetId::Careful).await.unwrap();
        *g1.compose.lock().unwrap() = Some((200, serde_json::json!({"max_routing_fee_msat": 0,
            "message_id": "ab".repeat(32), "delivered": true,
            "amount_msat": 2000, "readmission_msat": 20_000,
        })));
        let sent = do_message_send(&node.state, A, false, "after reconnect", 7000, None).await;
        let book = budget_now(&node.state);
        assert!(book.spent_msat <= book.ceiling_msat,
            "daily limit={}, paid={} after result={sent:?}; posts={:?}", book.ceiling_msat, book.spent_msat, node.posts());
        assert!(sent.is_err());
        assert!(!node.posts().iter().any(|(p, _)| p == "/messages/compose"));
    }

    #[tokio::test]
    async fn review_l4_settle_io_failure_keeps_readmission_accounted_or_blocked() {
        let fail_path = Arc::new(Mutex::new(None::<PathBuf>));
        let hook = fail_path.clone();
        let routes: Routes = Arc::new(move |m, p, b| {
            let value = match p {
                "/status" => serde_json::json!({"api_capabilities": ["paid_send_caps_v1", "spend_budget_grant_v1"]}),
                "/pair/grant" => {
                    let mut grant = g1_grant(3600, 400_000, 400_000);
                    grant["per_recipient_msat"] = serde_json::json!({A: 50_000});
                    serde_json::json!({"grant": grant})
                }
                "/messages/compose" => {
                    // The reservation is already durable. Simulate a failure of
                    // the following atomic book write, without damaging that book.
                    std::fs::create_dir(hook.lock().unwrap().as_ref().unwrap()).unwrap();
                    serde_json::json!({"max_routing_fee_msat": 0, "message_id": "ab".repeat(32), "delivered": true,
                        "amount_msat": 2000, "readmission_msat": 20_000})
                }
                _ => return happy()(m, p, b),
            };
            (200, value.to_string())
        });
        let (node, _dir) = paired_fake(routes);
        if let AuthMode::Paired(session) = &mut *node.state.auth.lock().unwrap() {
            session.scopes.push("spend".into());
        }
        do_budget_approve(&node.state, 500_000, budget::PresetId::Careful).await.unwrap();
        with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
        let (dir, id) = budget_dir(&node.state).unwrap();
        let temporary = budget::book_path(&dir, &id).with_extension("json.tmp");
        *fail_path.lock().unwrap() = Some(temporary.clone());
        let sent = do_message_send(&node.state, A, false, "after reconnect", 7000, None).await;
        std::fs::remove_dir(temporary).unwrap();
        let live = budget_now(&node.state);
        let restored = budget_now(&reopen(&node));
        let pending = spend_journal(&node.state).unwrap().pending().unwrap();
        assert!(live.spent_msat >= 22_000 || pending.is_some(),
            "22,000 paid but live={}, restored={}, pending={pending:?}, result={sent:?}", live.spent_msat, restored.spent_msat);
        assert_eq!(sent.unwrap_err().code, "spend_unknown");
        assert_eq!(live.spent_msat, 50_000, "the full enforceable allowance stays reserved");
        assert_eq!(restored.spent_msat, 50_000);
        let pending = pending.unwrap();
        assert_eq!(pending.accounting_msat, Some(22_000));
        let after = reopen(&node);
        do_spend_reconcile(&after).await.unwrap();
        assert_eq!(budget_now(&after).spent_msat, 22_000);
        assert_eq!(budget_now(&after).rows[0].spent_msat, 22_000);
        assert_eq!(budget_now(&after).unsettled_msat, 0);
        assert_eq!(budget_now(&reopen(&node)).spent_msat, 22_000);
        assert!(spend_journal(&after).unwrap().pending().unwrap().is_none());
        // A crash after the book write but before clearing the journal must
        // also be recoverable, without adding the same payment twice.
        spend_journal(&after).unwrap().save(&pending).unwrap();
        do_spend_reconcile(&reopen(&node)).await.unwrap();
        assert_eq!(budget_now(&reopen(&node)).spent_msat, 22_000);
        assert_eq!(node.posts().iter().filter(|(p, _)| p == "/messages/compose").count(), 1);
    }

    #[tokio::test]
    async fn pr47_accounting_recovery_requires_its_persisted_reservation() {
        let (node, _dir) = paired_fake(happy());
        {
            let journal = spend_journal(&node.state).unwrap();
            let mut pending = journal.begin(A, "/messages/compose", &serde_json::json!({}), 2000).unwrap();
            pending.node_id = node.state.node_id.lock().unwrap().clone().unwrap();
            pending.accounting_msat = Some(22_000);
            journal.save(&pending).unwrap();
        }
        assert_eq!(do_spend_reconcile(&node.state).await.unwrap_err().code, "spend_unknown");
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_some());
        assert!(node.posts().is_empty());
    }

    #[tokio::test]
    async fn pr47_unknown_readmission_holds_the_node_bound_after_restart() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
        g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
        g1_approved(&node, 500_000).await;
        *g1.compose.lock().unwrap() = Some((502, serde_json::json!({"error": "lost reply"})));
        assert_eq!(do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err().code, "spend_unknown");
        assert_eq!(budget_now(&node.state).unsettled_msat, 50_000);
        let after = reopen(&node);
        assert_eq!(budget_now(&after).unsettled_msat, 50_000);
        assert_eq!(do_spend_reconcile(&after).await.unwrap_err().code, "spend_unknown");
        assert!(spend_journal(&after).unwrap().pending().unwrap().is_some());
    }

    #[tokio::test]
    async fn pr47_normal_reply_releases_unused_admission_allowance() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
        g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
        g1_approved(&node, 500_000).await;
        do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap();
        assert_eq!(budget_now(&node.state).spent_msat, 2000);
        assert_eq!(budget_now(&node.state).unsettled_msat, 0);
        // Real node accounting advances too; the next hold fits what remains.
        g1.grant.lock().unwrap()["used_by_recipient"] = serde_json::json!({A: 2000});
        do_message_send(&node.state, A, false, "again", 7000, None).await.unwrap();
        assert_eq!(budget_now(&reopen(&node)).spent_msat, 4000);
    }


    // ---- quoted re-admission (genome quoted_readmission_v1, #111 revived) --------

    /// A genome node after a restart: the contact asks for admission again on
    /// the new connection. A compose whose cap is below the quote's total is
    /// refused before paying (409 `readmission_required`, operation kept
    /// `prepared`); a cap that fits pays admission once and the message once,
    /// and the connection then stays admitted. One operation pays at most once.
    #[derive(Default)]
    struct ReadmitNode {
        admitted: bool,
        /// Operation id -> the reply that settled it.
        paid: std::collections::HashMap<String, serde_json::Value>,
        /// Lightning dispatches: admission and message count one each.
        pays: usize,
        quotes: usize,
    }

    const READMIT_QUOTE: (u64, u64, u64) = (1000, 1000, 10_000);

    fn readmit_routes(node: Arc<Mutex<ReadmitNode>>) -> Routes {
        Arc::new(move |_m: &str, p: &str, b: &str| {
            let (admission, message, fees) = READMIT_QUOTE;
            match p {
                "/status" => (200, serde_json::json!({"api_capabilities": ["paid_send_caps_v1", "room_terminal_outcomes_v1",
                    "spend_budget_grant_v1", "first_contact_grant_v1", "message_operations_v1", "quoted_readmission_v1"]}).to_string()),
                "/messages/first-contact/quote" => {
                    node.lock().unwrap().quotes += 1;
                    (200, serde_json::json!({"recipient": A, "admission_msat": admission, "message_msat": message,
                        "max_routing_fee_msat": fees, "total_msat": admission + message + fees, "expires_at": now_unix() + 60}).to_string())
                }
                "/messages/compose" => {
                    let body: serde_json::Value = serde_json::from_str(b).unwrap();
                    let id = body["operation_id"].as_str().unwrap().to_string();
                    let cap = body["max_total_msat"].as_u64().unwrap();
                    let mut n = node.lock().unwrap();
                    if let Some(reply) = n.paid.get(&id) { return (200, reply.to_string()); }
                    let readmission = if n.admitted { 0 } else { admission };
                    if cap < readmission + message + if n.admitted { 0 } else { fees } {
                        return (409, serde_json::json!({"code": "price_cap_exceeded", "reason": "readmission_required",
                            "error": format!("{A} asks {admission} msat for admission again; no invoice was paid"),
                            "operation_id": id, "state": "prepared", "payment_hash": null, "accepted": false, "retry_allowed": true}).to_string());
                    }
                    n.pays += if n.admitted { 1 } else { 2 };
                    n.admitted = true;
                    let reply = serde_json::json!({"operation_id": id, "state": "acked", "accepted": true, "payment_hash": OP_HASH,
                        "retry_allowed": false, "message_id": format!("m{}", n.paid.len() + 1), "delivered": true,
                        "amount_msat": message, "readmission_msat": (readmission > 0).then_some(readmission), "max_routing_fee_msat": 0});
                    n.paid.insert(id, reply.clone());
                    (200, reply.to_string())
                }
                _ => (0, String::new()),
            }
        })
    }

    #[tokio::test]
    async fn quoted_readmission_within_the_contact_budget_pays_once_without_a_prompt() {
        let readmit = Arc::new(Mutex::new(ReadmitNode::default()));
        let (node, _dir, g1) = g1_node_with(&["read", "receive"], Some(readmit_routes(readmit.clone())));
        with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
        g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
        g1_approved(&node, 500_000).await;
        let receipt = do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap();
        let bodies = compose_bodies(&node);
        assert_eq!(bodies.len(), 2, "refused under the message cap, then sent under the quote");
        assert_eq!(bodies[0]["operation_id"], bodies[1]["operation_id"], "the same operation");
        assert_eq!((bodies[0]["max_total_msat"].as_u64(), bodies[1]["max_total_msat"].as_u64()), (Some(7000), Some(12_000)));
        assert_eq!(bodies[1]["max_routing_fee_msat"], 10_000, "the quote's ceilings for both payments");
        assert_eq!((receipt.amount_msat, receipt.readmission_msat, receipt.total_msat), (1000, Some(1000), 2000), "admission is in the all-in cost");
        assert_eq!(receipt.operation_id.as_deref(), bodies[0]["operation_id"].as_str());
        // Quotes: the #99 all-in probe before the first POST, then the refusal's.
        let counts = { let r = readmit.lock().unwrap(); (r.pays, r.quotes) };
        assert_eq!(counts, (2, 2), "admission once, message once");
        assert!(pending(&node).is_none());
        assert_eq!(with_book(&node.state, false, |b| Ok(b.spent(A, false, now_ms()))).unwrap(), 2000, "counted against the contact");
        // The connection stays admitted: the next message pays the message only.
        let next = do_message_send(&node.state, A, false, "again", 7000, None).await.unwrap();
        assert_eq!((next.amount_msat, next.readmission_msat), (1000, None));
        assert_eq!(readmit.lock().unwrap().pays, 3);
        assert_eq!(compose_bodies(&node).len(), 3);
    }

    #[tokio::test]
    async fn quoted_readmission_outside_the_budget_asks_once_and_keeps_the_operation() {
        let readmit = Arc::new(Mutex::new(ReadmitNode::default()));
        let node = fake(AuthMode::Local, {
            let routes = readmit_routes(readmit.clone());
            Arc::new(move |m: &str, p: &str, b: &str| match routes(m, p, b) {
                (0, _) => happy()(m, p, b),
                other => other,
            })
        });
        spend_advance(&node.state, true).await.unwrap();
        let e = do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err();
        assert_eq!(e.code, "readmission_quoted", "{}", e.message);
        assert_eq!(e.admission, Some(act::AdmissionView { admission_msat: 1000, message_msat: 1000, max_routing_fee_msat: 10_000, total_msat: 12_000, quoted: true }));
        assert_eq!(readmit.lock().unwrap().pays, 0, "nothing was paid");
        let record = pending(&node).expect("kept for the same message");
        assert!(record.resumable && !record.budgeted, "resumable, reservation released");
        let id = record.operation_id.clone().unwrap();
        assert_eq!(compose_bodies(&node).len(), 1, "no automatic resend outside the budget");
        // The owner's one OK: the same message at the quoted all-in total.
        let receipt = do_message_send(&node.state, A, false, "gm", 12_000, None).await.unwrap();
        let bodies = compose_bodies(&node);
        assert_eq!(bodies[1]["operation_id"], id.as_str());
        assert_eq!((bodies[1]["max_total_msat"].as_u64(), bodies[1]["max_routing_fee_msat"].as_u64()), (Some(12_000), Some(10_000)));
        assert_eq!((receipt.readmission_msat, receipt.total_msat), (Some(1000), 2000));
        assert_eq!(readmit.lock().unwrap().pays, 2);
        assert!(pending(&node).is_none());
    }

    #[tokio::test]
    async fn quoted_readmission_a_refused_cap_that_already_fits_is_never_resent() {
        // A node that refuses even the quoted total: the app keeps the refusal.
        let quotes = Arc::new(AtomicUsize::new(0));
        let q = quotes.clone();
        let node = fake(AuthMode::Local, Arc::new(move |m: &str, p: &str, b: &str| match p {
            "/status" => (200, serde_json::json!({"api_capabilities": ["paid_send_caps_v1", "room_terminal_outcomes_v1",
                "first_contact_grant_v1", "message_operations_v1", "quoted_readmission_v1"]}).to_string()),
            "/messages/first-contact/quote" => {
                q.fetch_add(1, Ordering::SeqCst);
                (200, serde_json::json!({"recipient": A, "admission_msat": 1000, "message_msat": 1000,
                    "max_routing_fee_msat": 0, "total_msat": 2000, "expires_at": now_unix() + 60}).to_string())
            }
            "/messages/compose" => readmission_coded_reply(),
            _ => happy()(m, p, b),
        }));
        spend_advance(&node.state, true).await.unwrap();
        let e = do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err();
        assert_eq!(e.code, "readmission_capped", "{}", e.message);
        assert_eq!(compose_bodies(&node).len(), 1);
    }

    #[tokio::test]
    async fn quoted_readmission_retry_delivery_asks_for_the_contacts_quote() {
        let composes = compose_script(vec![psi_502(2000, 0, 2000, PSI_TIMEOUT), readmission_coded_reply()]);
        let node = fake(AuthMode::Local, Arc::new(move |m: &str, p: &str, b: &str| match p {
            "/status" => (200, serde_json::json!({"api_capabilities": ["paid_send_caps_v1", "room_terminal_outcomes_v1",
                "first_contact_grant_v1", "quoted_readmission_v1"]}).to_string()),
            "/messages/first-contact/quote" => (200, serde_json::json!({"recipient": A, "admission_msat": 1000, "message_msat": 1000,
                "max_routing_fee_msat": 10_000, "total_msat": 12_000, "expires_at": now_unix() + 60}).to_string()),
            _ => composes(m, p, b),
        }));
        let first = psi_first(&node).await;
        assert!(first.undelivered.is_some());
        let e = do_message_retry(&node.state, A, "gm", None).await.unwrap_err();
        assert_eq!(e.code, "retry_needs_admission", "{}", e.message);
        assert_eq!(e.admission, Some(act::AdmissionView { admission_msat: 1000, message_msat: 1000, max_routing_fee_msat: 10_000, total_msat: 12_000, quoted: true }));
    }

    #[tokio::test]
    async fn g1_a_budgeted_contacts_readmission_is_paid_without_a_prompt_and_counted() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
        g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
        g1_approved(&node, 500_000).await;
        // After a reconnect the node paid A's admission again from the budget.
        *g1.compose.lock().unwrap() = Some((200, serde_json::json!({"max_routing_fee_msat": 0,
            "message_id": "m1", "delivered": true, "amount_msat": 2000, "readmission_msat": 2000})));
        do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap();
        assert!(first_contact_then_compose(&node).is_none(), "no prompt, no one-time OK");
        let spent = with_book(&node.state, false, |b| Ok(b.spent(A, false, now_ms()))).unwrap();
        assert_eq!(spent, 4000, "the re-admission counts against the contact");
    }

    #[tokio::test]
    async fn g1_a_known_contact_the_grant_does_not_budget_asks_for_the_ok_once() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        *g1.first_contact.lock().unwrap() =
            Some((200, serde_json::json!({"recipient": A, "max_total_msat": 9000, "expires_at": now_unix() + 120})));
        g1_approved(&node, 500_000).await;
        with_book(&node.state, true, |b| b.set_limit(A, false, 30_000)).unwrap();
        *g1.compose.lock().unwrap() = Some((409, serde_json::json!({
            "error": "this contact has no budget in your grant", "code": "budget_exceeded", "reason": "first_contact"})));
        let e = do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err();
        assert_eq!(e.code, "grant_readmission", "{}", e.message);
        assert_eq!(with_book(&node.state, false, |b| Ok(b.spent(A, false, now_ms()))).unwrap(), 0, "nothing charged");

        // The door card's one OK: backed at the node, with the contact's budget.
        *g1.compose.lock().unwrap() = None;
        owner_approves_contact(&node, A, 9000, Some(30_000)).await;
        do_message_send_with(&node.state, A, false, "gm", 9000, None, Some(30_000)).await.unwrap();
        let (body, next) = first_contact_then_compose(&node).expect("the owner's OK reached the node");
        assert_eq!(body, serde_json::json!({"client_id": "c1", "grant_op_id": "ab12", "recipient": A, "max_total_msat": 9000, "contact_budget_msat": 30_000}));
        assert_eq!(next, "/messages/compose");
    }

    #[tokio::test]
    async fn review_regression_first_contact_forwards_chosen_contact_budget() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        *g1.first_contact.lock().unwrap() = Some((200, serde_json::json!({
            "recipient": C, "max_total_msat": 10000, "expires_at": now_unix() + 120,
        })));
        g1_approved(&node, 500_000).await;
        let view = owner_approves_contact(&node, C, 10000, Some(50_000)).await;
        assert_eq!(view.request.contact_budget_msat, 50_000);
        assert!(view.owner_command.contains("konsensus approve"));
        assert!(!view.owner_command.contains("BITSOV_OWNER_TOKEN"));
        assert!(!view.owner_command.contains("tok.spend"));
        do_message_send_with(&node.state, C, false, "hello stranger", 10000, None, Some(50_000))
            .await.unwrap();
        let (body, _) = first_contact_then_compose(&node).expect("first-contact confirmation sent");
        assert_eq!(body["contact_budget_msat"], serde_json::json!(50_000),
            "the node needs the chosen contact budget to authorize later budgeted re-admission");
    }

    #[tokio::test]
    async fn review_regression_readmission_is_counted_and_survives_restart() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        with_book(&node.state, true, |book| book.set_limit(A, false, 50_000)).unwrap();
        g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
        *g1.compose.lock().unwrap() = Some((200, serde_json::json!({"max_routing_fee_msat": 0,
            "message_id": "ab".repeat(32), "delivered": true,
            "amount_msat": 2000, "readmission_msat": 20_000,
        })));
        g1_approved(&node, 500_000).await;
        do_message_send(&node.state, A, false, "after reconnect", 7000, None).await.unwrap();
        let live = budget_now(&node.state);
        let restored = budget_now(&reopen(&node));
        assert_eq!(
            (live.spent_msat, live.rows[0].spent_msat, restored.spent_msat, restored.rows[0].spent_msat),
            (22_000, 22_000, 22_000, 22_000),
            "both the message and separately reported re-admission must count against the contact and daily total",
        );
    }

    #[tokio::test]
    async fn g1_a_first_contact_the_node_will_not_back_sends_nothing() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        *g1.first_contact.lock().unwrap() = Some((409, serde_json::json!({
            "code": "budget_exceeded", "reason": "first_contact", "remaining_msat": null, "error": "no"})));
        g1_approved(&node, 500_000).await;
        let err = do_message_send_with(&node.state, C, false, "hello stranger", 10000, None, Some(50_000)).await.unwrap_err();
        assert_eq!(err.code, "owner_only");
        assert!(first_contact_then_compose(&node).is_none());
        assert!(!node.posts().iter().any(|(p, _)| p == "/messages/compose"), "refused before any paid request");
        assert!(with_book(&node.state, false, |b| Ok(b.limit(C, false))).unwrap().is_none(), "no budget recorded for them");
    }

    #[tokio::test]
    async fn g1_known_contacts_and_older_nodes_need_no_first_contact_grant() {
        // A node without first_contact_grant_v1: the send is unchanged.
        let (node, _dir, _g1) = g1_node(&["read", "receive"]);
        g1_approved(&node, 500_000).await;
        do_message_send_with(&node.state, C, false, "hello", 7000, None, Some(50_000)).await.unwrap();
        assert!(first_contact_then_compose(&node).is_none());
        // A contact already in the book is not a first contact.
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        *g1.first_contact.lock().unwrap() = Some((200, serde_json::json!({})));
        with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
        g1.grant.lock().unwrap()["per_recipient_msat"] = serde_json::json!({A: 50_000});
        g1_approved(&node, 500_000).await;
        do_message_send_with(&node.state, A, false, "gm", 7000, None, None).await.unwrap();
        assert!(first_contact_then_compose(&node).is_none());
    }

    /// A fresh card for key `[0x42; 32]`, signed now.
    fn intro_card(endpoint: &str, issued_at: u64) -> bitsov_app::introduction::Card {
        use ed25519_dalek::Signer;
        let key = ed25519_dalek::SigningKey::from_bytes(&[0x42; 32]);
        let mut card = bitsov_app::introduction::Card {
            v: 1,
            network: "regtest".into(),
            node_id: hex::encode(key.verifying_key().to_bytes()),
            endpoint: endpoint.into(),
            reach: bitsov_app::introduction::Reach::Local,
            admission_msat: 100_000,
            message_msat: 10_000,
            price_epoch: 0,
            issued_at,
            expires_at: issued_at + 600,
            intro_id: "ab".repeat(16),
            sig: String::new(),
        };
        card.sig = hex::encode(key.sign(&card.signing_digest().unwrap()).to_bytes());
        card
    }

    fn intro_routes(open: (u16, serde_json::Value)) -> Routes {
        Arc::new(move |m, p, b| match p {
            "/status" => (200, serde_json::json!({"node_id": OWN, "api_capabilities": ["paid_send_caps_v1", "introduction_v1"]}).to_string()),
            "/introduction/open" => (open.0, open.1.to_string()),
            _ => happy()(m, p, b),
        })
    }

    #[tokio::test]
    async fn introduction_open_verifies_locally_then_only_asks_the_node_to_dial() {
        let card = intro_card("127.0.0.1:9735", now_unix() as u64);
        let link = card.to_link().unwrap();
        let node = fake(AuthMode::Local, intro_routes((200, serde_json::json!({"node_id": card.node_id, "dialed": "127.0.0.1:9735", "connected": true}))));
        let door = open_introduction(&node.state, &format!("  {link}\n"), true).await.unwrap();
        assert_eq!((door.node_id.as_str(), door.admission_msat, door.message_msat), (card.node_id.as_str(), 100_000, 10_000));
        // One POST, the canonical link, and nothing else: no quote, no grant, no compose, no peer add.
        assert_eq!(node.posts(), vec![("/introduction/open".to_string(), serde_json::json!({"card": link, "allow_local": true}))]);
        assert!(node.targets().iter().all(|t| t == "GET /status" || t == "POST /introduction/open"), "{:?}", node.targets());
    }

    #[tokio::test]
    async fn introduction_open_refuses_bad_cards_before_any_request() {
        let now = now_unix() as u64;
        let node = fake(AuthMode::Local, intro_routes((200, serde_json::json!({}))));
        let mut tampered = intro_card("127.0.0.1:9735", now);
        tampered.admission_msat = 1;
        let tampered = serde_json::to_string(&tampered).unwrap();
        let expired = intro_card("127.0.0.1:9735", now - 601).to_link().unwrap();
        for bad in [tampered.as_str(), expired.as_str(), "bitsov://introduce#garbage", "https://x.example/#AQ", ""] {
            assert!(open_introduction(&node.state, bad, true).await.is_err(), "{bad}");
        }
        assert!(node.targets().is_empty(), "nothing reached the node: {:?}", node.targets());
    }

    #[tokio::test]
    async fn introduction_open_reports_closed_mesh_and_wrong_peer() {
        let card = intro_card("127.0.0.1:9735", now_unix() as u64);
        let link = card.to_link().unwrap();
        let node = fake(AuthMode::Local, intro_routes((409, serde_json::json!({"error": "introduction_closed_mesh: this node dials only peers its owner added", "code": 409}))));
        assert!(open_introduction(&node.state, &link, true).await.unwrap_err().contains("does not add one"));
        let node = fake(AuthMode::Local, intro_routes((200, serde_json::json!({"node_id": OWN, "connected": true}))));
        assert!(open_introduction(&node.state, &link, true).await.unwrap_err().contains("someone else"));
        let node = fake(AuthMode::Local, happy());
        assert!(open_introduction(&node.state, &link, true).await.unwrap_err().contains("cannot open"));
        assert!(node.posts().is_empty(), "no capability: no dial");
    }

    #[tokio::test]
    async fn introduction_open_refuses_a_dial_outside_the_cards_reach() {
        // A local card: the node must still never report a link-local,
        // metadata or missing address, and a public card never a private one.
        let local = intro_card("127.0.0.1:9735", now_unix() as u64);
        for dialed in [serde_json::json!("169.254.169.254:80"), serde_json::json!("[fe80::1]:9735"), serde_json::json!("not an address"), serde_json::Value::Null] {
            let node = fake(AuthMode::Local, intro_routes((200, serde_json::json!({"node_id": local.node_id, "dialed": dialed, "connected": true}))));
            assert!(open_introduction(&node.state, &local.to_link().unwrap(), true).await.unwrap_err().contains("does not allow"), "{dialed}");
        }
        let mut public = intro_card("node.example.org:9735", now_unix() as u64);
        public.reach = bitsov_app::introduction::Reach::Public;
        {
            use ed25519_dalek::Signer;
            let key = ed25519_dalek::SigningKey::from_bytes(&[0x42; 32]);
            public.sig = hex::encode(key.sign(&public.signing_digest().unwrap()).to_bytes());
        }
        let node = fake(AuthMode::Local, intro_routes((200, serde_json::json!({"node_id": public.node_id, "dialed": "10.0.0.7:9735", "connected": true}))));
        assert!(open_introduction(&node.state, &public.to_link().unwrap(), false).await.unwrap_err().contains("does not allow"));
        let node = fake(AuthMode::Local, intro_routes((200, serde_json::json!({"node_id": public.node_id, "dialed": "203.0.114.9:9735", "connected": true}))));
        assert!(open_introduction(&node.state, &public.to_link().unwrap(), false).await.is_ok());
    }

    /// Genome #89 `020b05e`: a local card needs the owner's explicit OK. The
    /// app refuses without it before any request, and never sends the OK for
    /// a public card, even when asked to.
    #[tokio::test]
    async fn introduction_open_sends_local_consent_only_when_given_for_a_local_card() {
        let local = intro_card("127.0.0.1:9735", now_unix() as u64);
        let node = fake(AuthMode::Local, intro_routes((200, serde_json::json!({"node_id": local.node_id, "dialed": "127.0.0.1:9735", "connected": true}))));
        assert!(open_introduction(&node.state, &local.to_link().unwrap(), false).await.unwrap_err().contains("Allow it on the card"));
        assert!(node.targets().is_empty(), "no consent: nothing reached the node");
        open_introduction(&node.state, &local.to_link().unwrap(), true).await.unwrap();
        assert_eq!(node.posts().last().unwrap().1["allow_local"], true);

        let mut public = intro_card("node.example.org:9735", now_unix() as u64);
        public.reach = bitsov_app::introduction::Reach::Public;
        {
            use ed25519_dalek::Signer;
            let key = ed25519_dalek::SigningKey::from_bytes(&[0x42; 32]);
            public.sig = hex::encode(key.sign(&public.signing_digest().unwrap()).to_bytes());
        }
        let node = fake(AuthMode::Local, intro_routes((200, serde_json::json!({"node_id": public.node_id, "dialed": "203.0.114.9:9735", "connected": true}))));
        open_introduction(&node.state, &public.to_link().unwrap(), true).await.unwrap();
        assert_eq!(node.posts().last().unwrap().1["allow_local"], false, "a public card never carries local consent");
    }

    #[tokio::test]
    async fn introduction_open_refuses_a_weak_key_forgery_before_any_request() {
        let mut forged = intro_card("127.0.0.1:9735", now_unix() as u64);
        let mut identity = [0u8; 32];
        identity[0] = 1;
        let mut sig = [0u8; 64];
        sig[0] = 1;
        forged.node_id = hex::encode(identity);
        forged.sig = hex::encode(sig);
        let node = fake(AuthMode::Local, intro_routes((200, serde_json::json!({"node_id": forged.node_id, "dialed": "127.0.0.1:9735", "connected": true}))));
        assert!(open_introduction(&node.state, &forged.to_link().unwrap(), true).await.unwrap_err().contains("weak"));
        assert!(node.targets().is_empty(), "nothing reached the node: {:?}", node.targets());
    }

    /// A card for key `[0x42; 32]` with its signed starter-bitcoin offer.
    fn offered(gift_msat: u64) -> (bitsov_app::introduction::Card, String) {
        use ed25519_dalek::Signer;
        let card = intro_card("127.0.0.1:9735", now_unix() as u64);
        let key = ed25519_dalek::SigningKey::from_bytes(&[0x42; 32]);
        let mut offer = bitsov_app::sponsor::Offer {
            network: "regtest".into(),
            intro_id: hex::decode(&card.intro_id).unwrap().try_into().unwrap(),
            sponsor: key.verifying_key().to_bytes(),
            gift_msat,
            expires_at: card.expires_at,
            sig: [0; 64],
        };
        offer.sig = key.sign(&offer.signing_digest()).to_bytes();
        let link = format!("{}.{}", card.to_link().unwrap(), offer.encode());
        (card, link)
    }

    fn sponsor_routes(extra: Routes) -> Routes {
        Arc::new(move |m, p, b| match p {
            "/status" => (200, serde_json::json!({"node_id": OWN, "api_capabilities": ["paid_send_caps_v1", "introduction_v1", "sponsor_kit_v1"]}).to_string()),
            _ => extra(m, p, b),
        })
    }

    #[tokio::test]
    async fn a_card_with_starter_bitcoin_reads_as_a_door_with_the_gift() {
        let (card, link) = offered(20_000_000);
        let (read, offer) = bitsov_app::sponsor::read(&link, now_unix() as u64).unwrap();
        let door = bitsov_app::sponsor::door(&read, offer.as_ref()).unwrap();
        assert_eq!(door.node_id, card.node_id);
        assert_eq!(door.starter.as_ref().map(|s| s.gift_msat), Some(20_000_000));
        assert_eq!(door.offer_link.as_deref(), Some(link.as_str()));
        // Opening the card with its offer attached dials the card only.
        let node = fake(AuthMode::Local, intro_routes((200, serde_json::json!({"node_id": card.node_id, "dialed": "127.0.0.1:9735", "connected": true}))));
        open_introduction(&node.state, &link, true).await.unwrap();
        assert_eq!(node.posts().last().unwrap().1["card"], card.to_link().unwrap());
    }

    #[tokio::test]
    async fn a_funding_request_forwards_the_offer_and_checks_the_answer() {
        let (card, link) = offered(20_000_000);
        let answer = |sponsor: &str, amount: u64| serde_json::json!({
            "request": "bitsov://sponsor-request#AQ", "code": "123456", "sponsor": sponsor,
            "amount_msat": amount, "payment_hash": "ab".repeat(32), "expires_at": now_unix() + 300 });
        let good = answer(&card.node_id, 20_000_000);
        let node = fake(AuthMode::Local, sponsor_routes(Arc::new(move |m, p, b| match p {
            "/sponsor/request" => (200, good.to_string()),
            _ => happy()(m, p, b),
        })));
        let ask = do_sponsor_request(&node.state, &link).await.unwrap();
        assert_eq!(ask.code, "123456");
        assert_eq!(node.posts(), vec![("/sponsor/request".to_string(), serde_json::json!({"link": link}))]);
        // A node answering for another sponsor or amount is refused.
        for bad in [answer(OWN, 20_000_000), answer(&card.node_id, 19_999_999)] {
            let node = fake(AuthMode::Local, sponsor_routes(Arc::new(move |m, p, b| match p {
                "/sponsor/request" => (200, bad.to_string()),
                _ => happy()(m, p, b),
            })));
            assert!(do_sponsor_request(&node.state, &link).await.unwrap_err().message.contains("does not match"));
        }
        // No offer on the card: refused before any request.
        let node = fake(AuthMode::Local, sponsor_routes(happy()));
        assert!(do_sponsor_request(&node.state, &card.to_link().unwrap()).await.is_err());
        assert!(node.targets().is_empty());
    }

    fn gift_candidate() -> bitsov_app::sponsor::Candidate {
        serde_json::from_value(serde_json::json!({
            "intro_id": "ab".repeat(16), "newcomer": A, "payment_hash": "cd".repeat(32),
            "gift_msat": 20_000_000, "fee_max_msat": 100_000, "code": "123456", "expires_at": now_unix() + 500,
        })).unwrap()
    }

    #[tokio::test]
    async fn paired_gift_approval_never_posts_to_the_owner_route() {
        let (node, _dir) = paired_fake(sponsor_routes(happy()));
        let c = gift_candidate();
        let view = do_sponsor_owner_approval(&node.state, &c, "123456").unwrap();
        assert!(view.owner_command.contains("konsensus approve"));
        assert!(!view.owner_command.contains("BITSOV_OWNER_TOKEN"));
        assert!(!view.owner_command.contains("tok.1"));
        assert!(node.targets().is_empty(), "preparing the command makes no request, even with the spend window closed");
        // An open delegated spend window still grants no per-gift authority.
        node.state.spend.lock().unwrap().arm(now_ms(), act::SpendBasis::NodeGrant);
        if let AuthMode::Paired(session) = &mut *node.state.auth.lock().unwrap() {
            session.scopes.push("spend".into());
        }
        do_sponsor_owner_approval(&node.state, &c, "123456").unwrap();
        assert!(node.targets().is_empty());
    }

    #[tokio::test]
    async fn gift_owner_command_carries_exact_frozen_tuple_then_reads_funded_status() {
        let mut c = gift_candidate();
        c.code = "012345".into();
        let frozen = serde_json::to_value(&c).unwrap();
        let routes = sponsor_routes(Arc::new(move |m, p, b| match p {
            "/sponsor" => (200, serde_json::json!({"enabled": true, "gift_msat": 20_000_000,
                "fee_msat": 100_000, "purse_msat": 100_000_000, "purse_used_msat": 20_000_000,
                "kits_per_day": 2, "kits_today": 1, "kits": [{"intro_id": "ab".repeat(16),
                "state": "funded", "candidate": frozen, "paid_msat": 20_000_000, "fee_paid_msat": 0}]}).to_string()),
            "/sponsor/approve" => panic!("the app must never approve"),
            _ => happy()(m, p, b),
        }));
        let (node, _dir) = paired_fake(routes);
        let view = do_sponsor_owner_approval(&node.state, &c, "012345").unwrap();
        assert_eq!(view.owner_command, format!(
            "konsensus approve gift --intro '{}' --newcomer '{}' --hash '{}' --gift-msat '20000000' --fee-max-msat '100000' --code '012345'",
            "ab".repeat(16), A, "cd".repeat(32)));
        let status = read_sponsor_status(&node.state).await.unwrap();
        assert_eq!(status.kits[0]["state"], "funded");
        assert!(node.posts().is_empty());
        assert!(do_sponsor_owner_approval(&node.state, &c, "654321").is_err());
        let mut expired = c.clone();
        expired.expires_at = 0;
        assert!(do_sponsor_owner_approval(&node.state, &expired, "012345").is_err());
        let mut malformed = c.clone();
        malformed.payment_hash = "not a hash".into();
        assert!(do_sponsor_owner_approval(&node.state, &malformed, "012345").is_err());
        with_book(&node.state, true, |b| { b.paused = true; Ok(()) }).unwrap();
        assert_eq!(do_sponsor_owner_approval(&node.state, &c, "012345").unwrap_err().code, "budget_paused");
    }

    #[tokio::test]
    async fn sponsor_reconcile_uses_read_authority_without_approval_or_a_spend_window() {
        let (node, _dir) = paired_fake(sponsor_routes(Arc::new(|m, p, b| {
            if p.ends_with("/reconcile") { (200, "{}".into()) } else { happy()(m, p, b) }
        })));
        with_book(&node.state, true, |b| { b.paused = true; Ok(()) }).unwrap();
        assert!(do_sponsor_reconcile(&node.state, "../approve").await.is_err());
        do_sponsor_reconcile(&node.state, &"ab".repeat(16)).await.unwrap();
        assert_eq!(node.posts(), vec![(format!("/sponsor/kits/{}/reconcile", "ab".repeat(16)), serde_json::json!({}))]);
        assert_eq!(node.seen.lock().unwrap()[0].2.as_deref(), Some("tok.1"));
    }

    #[test]
    fn sponsor_owner_conflict_has_a_dedicated_reason() {
        let err = sponsor_error(ActionError::node(api_error("/sponsor/approve", reqwest::StatusCode::CONFLICT,
            r#"{"error":"sponsor_owner_approval_required","code":409}"#)));
        assert_eq!(err.code, "sponsor_owner_approval_required");
    }

    #[tokio::test]
    async fn the_nodes_refusal_reason_reaches_the_owner() {
        let routes = sponsor_routes(Arc::new(|m, p, b| match p {
            "/sponsor/offer" => (409, serde_json::json!({"error": "sponsor_purse_exhausted: 100 of 100 sats used in the last 24 hours", "code": 409}).to_string()),
            _ => happy()(m, p, b),
        }));
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        assert_eq!(do_sponsor_offer(&node.state).await.unwrap_err().code, "sponsor_purse_exhausted");
    }

    #[tokio::test]
    async fn own_introduction_must_be_signed_by_this_node() {
        let card = intro_card("127.0.0.1:9735", now_unix() as u64);
        let link = card.to_link().unwrap();
        let mine = |node_id: String, link: String| -> Routes {
            let card = card.clone();
            Arc::new(move |m, p, b| match p {
                "/status" => (200, serde_json::json!({"node_id": node_id, "api_capabilities": ["introduction_v1"]}).to_string()),
                "/introduction" => (200, serde_json::json!({"card": card, "link": link}).to_string()),
                _ => happy()(m, p, b),
            })
        };
        let node = fake(AuthMode::Local, mine(card.node_id.clone(), link.clone()));
        assert_eq!(read_own_introduction(&node.state).await.unwrap().link, link);
        let node = fake(AuthMode::Local, mine(OWN.into(), link.clone()));
        assert!(read_own_introduction(&node.state).await.unwrap_err().contains("not signed by this node"));
        let node = fake(AuthMode::Local, mine(card.node_id.clone(), format!("{link}A")));
        assert!(read_own_introduction(&node.state).await.unwrap_err().contains("does not match"));
        let node = fake(AuthMode::Local, happy());
        assert!(read_own_introduction(&node.state).await.unwrap_err().contains("cannot sign"));
    }

    #[tokio::test]
    async fn first_contact_quote_reads_the_stranger_quote_only_where_offered() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        assert!(read_first_contact_quote(&node.state, C).await.is_err(), "no capability: no quote request");
        assert!(!node.posts().iter().any(|(p, _)| p == "/messages/first-contact/quote"));
        *g1.first_contact.lock().unwrap() = Some((200, serde_json::json!({})));
        assert!(read_first_contact_quote(&node.state, "not-a-node").await.is_err());
    }

    #[tokio::test]
    async fn g1_a_window_never_outlives_the_node_grant() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        *g1.grant.lock().unwrap() = g1_grant(120, 400_000, 400_000);
        spend_advance(&node.state, true).await.unwrap();
        assert_eq!(node.posts()[0].1["budget"], serde_json::json!({"budget_msat": 500_000, "ttl_secs": 600}));
        spend_advance(&node.state, false).await.unwrap();
        let view = spend_advance(&node.state, false).await.unwrap();
        let expires = g1.grant.lock().unwrap()["expires_at"].as_u64().unwrap() * 1000;
        assert_eq!((view.state, view.open_until_ms), (act::SpendState::Open, Some(expires)));
    }

    #[tokio::test]
    async fn g1_what_the_grant_would_refuse_is_refused_before_any_payment() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        g1_approved(&node, 500_000).await;
        with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
        // Another client of this pairing spent most of the node budget.
        *g1.grant.lock().unwrap() = g1_grant(3600, 400_000, 1_500);
        let err = do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err();
        assert_eq!(err.code, "grant_exhausted");
        assert!(err.message.contains("1.500 sats left"), "{}", err.message);
        let mut per_call = g1_grant(3600, 400_000, 400_000);
        per_call["per_call_max_msat"] = 1000.into();
        *g1.grant.lock().unwrap() = per_call;
        assert_eq!(do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err().code, "grant_per_call");
        let mut recipient = g1_grant(3600, 400_000, 400_000);
        recipient["per_recipient_msat"] = serde_json::json!({A: 3000});
        recipient["used_by_recipient"] = serde_json::json!({A: 2000});
        *g1.grant.lock().unwrap() = recipient;
        assert_eq!(do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err().code, "grant_recipient");
        assert_eq!(composes(&node), 0);
        let v = budget_now(&node.state);
        assert_eq!((v.spent_msat, v.autopay.state), (0, budget::AutopayState::Open), "nothing reserved; the approval stands");
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
    }

    #[tokio::test]
    async fn g1_a_revoked_or_expired_grant_closes_everything_before_any_payment() {
        for gone in [serde_json::Value::Null, g1_grant(-1, 400_000, 400_000)] {
            let (node, _dir, g1) = g1_node(&["read", "receive"]);
            g1_approved(&node, 500_000).await;
            *g1.grant.lock().unwrap() = gone;
            assert_eq!(do_message_send_with(&node.state, A, false, "gm", 7000, None, Some(50_000)).await.unwrap_err().code, "grant_ended");
            assert_eq!(composes(&node), 0);
            let v = budget_now(&node.state);
            assert_eq!((v.autopay.state, v.node_grant), (budget::AutopayState::Off, None));
            assert_eq!(spend_advance(&node.state, false).await.unwrap().state, act::SpendState::Locked);
        }
    }

    #[tokio::test]
    async fn g1_budget_exceeded_releases_the_reservation_per_reason() {
        for (reason, code, closes) in [
            ("total", "grant_exhausted", false),
            ("per_call", "grant_per_call", false),
            ("recipient", "grant_recipient", false),
            ("unpriced", "grant_unpriced", false),
            ("ledger", "grant_ledger", false),
            ("no_grant", "grant_ended", true),
        ] {
            let (node, _dir, g1) = g1_node(&["read", "receive"]);
            g1_approved(&node, 500_000).await;
            *g1.compose.lock().unwrap() = Some((409, serde_json::json!({"code": "budget_exceeded", "reason": reason, "remaining_msat": 500, "error": "no"})));
            let err = do_message_send_with(&node.state, A, false, "gm", 7000, None, Some(50_000)).await.unwrap_err();
            assert_eq!(err.code, code, "{reason}");
            assert_eq!(composes(&node), 1, "{reason}");
            let v = budget_now(&node.state);
            assert_eq!(v.spent_msat, 0, "{reason}: the node reserved nothing, so neither does the app");
            assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none(), "{reason}: not an unknown outcome");
            assert_eq!(v.autopay.state == budget::AutopayState::Off, closes, "{reason}");
        }
    }

    #[tokio::test]
    async fn g1_an_unreadable_grant_opens_nothing() {
        let (node, _dir, g1) = g1_node(&["read", "receive"]);
        *g1.grant_status.lock().unwrap() = 500;
        do_budget_approve(&node.state, 500_000, budget::PresetId::Careful).await.unwrap();
        spend_advance(&node.state, false).await.unwrap();
        assert_eq!(spend_advance(&node.state, false).await.unwrap_err().code, "grant_unknown");
        assert_eq!(budget_now(&node.state).autopay.state, budget::AutopayState::Off);
        assert_eq!(spend_advance(&node.state, false).await.unwrap().state, act::SpendState::Locked);

        // And a spend-scoped token on a node whose grant cannot be read opens nothing either.
        let (node, _dir, g1) = g1_node(&["read", "receive", "spend"]);
        *g1.grant.lock().unwrap() = serde_json::json!("garbage");
        assert_eq!(spend_advance(&node.state, true).await.unwrap_err().code, "grant_unknown");
        assert_eq!(spend_advance(&node.state, false).await.unwrap().state, act::SpendState::Locked);
    }

    #[tokio::test]
    async fn g1_a_spend_token_without_a_live_grant_asks_again() {
        let (node, _dir, g1) = g1_node(&["read", "receive", "spend"]);
        *g1.grant.lock().unwrap() = serde_json::Value::Null;
        let view = spend_advance(&node.state, true).await.unwrap();
        assert_eq!(view.state, act::SpendState::Pending, "a pre-G1 30-day grant is not honoured");
        assert_eq!(node.posts()[0].0, "/pair/elevation-request");
        // With a live grant it opens at once, bounded by it.
        let (node, _dir, _g1) = g1_node(&["read", "receive", "spend"]);
        let view = spend_advance(&node.state, true).await.unwrap();
        assert_eq!((view.state, view.basis), (act::SpendState::Open, Some(act::SpendBasis::NodeGrant)));
        assert!(node.posts().is_empty());
    }

    #[tokio::test]
    async fn a_sidecar_says_elevation_is_unavailable_and_a_lapsed_request_expires() {
        let status = Arc::new(Mutex::new("pending"));
        let s = status.clone();
        let far = now_unix() + 900;
        let routes: Routes = Arc::new(move |_: &str, path: &str, _: &str| {
            let v = match path {
                "/pair/elevation-request" => serde_json::json!({"op_id": "cd34", "expires_at": far, "owner_action": "unavailable in this deployment: the node was not started in owner-run mode"}),
                "/pair/elevation/cd34" => serde_json::json!({"op_id": "cd34", "status": *s.lock().unwrap()}),
                _ => return (404, "{}".into()),
            };
            (200, v.to_string())
        });
        let (node, _dir) = paired_fake(routes);
        let view = spend_advance(&node.state, true).await.unwrap();
        assert_eq!(view.state, act::SpendState::Unavailable);
        assert!(view.pending.unwrap().owner_action.starts_with("unavailable"));
        assert_eq!(do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err().code, "spend_locked");

        *status.lock().unwrap() = "expired";
        assert_eq!(spend_advance(&node.state, false).await.unwrap().state, act::SpendState::Expired);
        assert_eq!(do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err().code, "spend_expired");
    }

    #[tokio::test]
    async fn review_regression_pause_during_held_grant_read_blocks_payment() {
        let entered = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        let (e, r) = (entered.clone(), release.clone());
        let routes: Routes = Arc::new(move |m, p, b| {
            let value = match p {
                "/status" => serde_json::json!({"api_capabilities": ["spend_budget_grant_v1"]}),
                "/pair/grant" => {
                    e.store(true, Ordering::SeqCst);
                    while !r.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    serde_json::json!({"grant": g1_grant(3600, 400_000, 400_000)})
                }
                _ => return happy()(m, p, b),
            };
            (200, value.to_string())
        });
        let (node, _dir) = paired_fake(routes);
        if let AuthMode::Paired(session) = &mut *node.state.auth.lock().unwrap() {
            session.scopes.push("spend".into());
        }
        let ask = spend_advance(&node.state, true);
        let pause = async {
            while !entered.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            let paused = do_budget_pause(&node.state).unwrap();
            assert!(paused.paused);
            release.store(true, Ordering::SeqCst);
        };
        let (opened, ()) = tokio::join!(ask, pause);
        let payment = do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 6000).await;
        let posts = node.posts();
        assert!(budget_now(&node.state).paused);
        assert!(payment.is_err() && !posts.iter().any(|(path, _)| path == "/payments/pay"),
            "Pause all must fence the pending approval: opened={opened:?}, payment={payment:?}, posts={posts:?}");
    }

    /// Finding 1, the elevation path: the owner's budget request is granted,
    /// but Pause all lands while the app reads the node grant. Nothing opens.
    #[tokio::test]
    async fn pr47_pause_during_granted_poll_opens_nothing() {
        let entered = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        let (e, r) = (entered.clone(), release.clone());
        let far = now_unix() + 900;
        let routes: Routes = Arc::new(move |m, p, b| {
            let v = match p {
                "/status" => serde_json::json!({"api_capabilities": ["paid_send_caps_v1", "spend_budget_grant_v1"]}),
                "/pair/elevation-request" => serde_json::json!({"op_id":"ab12", "expires_at":far, "owner_action":"konsensus grant --op ab12"}),
                "/pair/elevation/ab12" => serde_json::json!({"status":"granted"}),
                "/pair/grant" => {
                    e.store(true, Ordering::SeqCst);
                    while !r.load(Ordering::SeqCst) { std::thread::sleep(Duration::from_millis(1)); }
                    serde_json::json!({"grant": g1_grant(3600, 400_000, 400_000)})
                }
                p if p.starts_with("/pair/challenge") => serde_json::json!({"challenge":"bitsov-pair-token-v1:00ff"}),
                "/pair/token" => serde_json::json!({"token":"tok.spend", "expires_at":far, "scopes":["read","receive","spend"]}),
                _ => return happy()(m,p,b),
            };
            (200, v.to_string())
        });
        let (node, _dir) = paired_fake(routes);
        with_book(&node.state, true, |b| b.set_limit(A, false, 50_000)).unwrap();
        spend_advance_for(&node.state, Some(Want::Budget(400_000))).await.unwrap();
        let poll = spend_advance(&node.state, false);
        let pause = async {
            while !entered.load(Ordering::SeqCst) { tokio::time::sleep(Duration::from_millis(1)).await; }
            assert!(do_budget_pause(&node.state).unwrap().paused);
            release.store(true, Ordering::SeqCst);
        };
        let (_polled, ()) = tokio::join!(poll, pause);
        assert_eq!(state_autopay(&node.state), budget::AutopayState::Off, "the late grant opened the budget");
        assert_eq!(node.state.spend.lock().unwrap().view(now_ms()).state, act::SpendState::Locked);
        assert_eq!(do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err().code, "budget_paused");
        assert!(do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 6000).await.is_err());
        assert!(!node.posts().iter().any(|(path, _)| path == "/messages/compose" || path == "/payments/pay"));
    }

    fn state_autopay(state: &NodeState) -> budget::AutopayState {
        state.autopay.lock().unwrap().view(now_ms()).state
    }

    #[tokio::test]
    async fn regression_lock_during_poll_discards_late_grant() {
        let entered = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        let (e, r) = (entered.clone(), release.clone());
        let far = now_unix() + 900;
        let routes: Routes = Arc::new(move |m, p, b| {
            let v = match p {
                "/pair/elevation-request" => serde_json::json!({"op_id":"ab12", "expires_at":far, "owner_action":"konsensus grant --op ab12"}),
                "/pair/elevation/ab12" => {
                    e.store(true, Ordering::SeqCst);
                    while !r.load(Ordering::SeqCst) { std::thread::sleep(Duration::from_millis(1)); }
                    serde_json::json!({"status":"granted"})
                },
                p if p.starts_with("/pair/challenge") => serde_json::json!({"challenge":"bitsov-pair-token-v1:00ff"}),
                "/pair/token" => serde_json::json!({"token":"tok.spend", "expires_at":far, "scopes":["read","receive","spend"]}),
                _ => return happy()(m,p,b),
            };
            (200, v.to_string())
        });
        let (node, _dir) = paired_fake(routes);
        spend_advance(&node.state, true).await.unwrap();
        let poll = spend_advance(&node.state, false);
        let lock = async {
            while !entered.load(Ordering::SeqCst) { tokio::time::sleep(Duration::from_millis(1)).await; }
            node.state.spend.lock().unwrap().lock();
            release.store(true, Ordering::SeqCst);
        };
        let (result, ()) = tokio::join!(poll, lock);
        assert_eq!(result.unwrap().state, act::SpendState::Locked);
        assert_eq!(do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err().code, "spend_locked");
        assert!(!node.posts().iter().any(|(path, _)| path == "/messages/compose"));
    }

    #[tokio::test]
    async fn regression_receipt_above_shown_quote_is_not_success() {
        let routes: Routes = Arc::new(|m, p, b| {
            if p == "/messages/compose" {
                return (200, serde_json::json!({"max_routing_fee_msat": 0, "message_id":"changed", "delivered":true, "amount_msat":999000}).to_string());
            }
            happy()(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        assert_eq!(read_price_quote(&node.state, Some(A)).await.unwrap().peer_msat, Some(2000));
        spend_advance(&node.state, true).await.unwrap();
        assert_eq!(do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err().code, "spend_unknown");
    }

    #[tokio::test]
    async fn regression_ambiguous_failure_blocks_second_dispatch() {
        let dispatches = Arc::new(AtomicUsize::new(0));
        let d = dispatches.clone();
        let routes: Routes = Arc::new(move |m, p, b| {
            if p == "/messages/compose" {
                d.fetch_add(1, Ordering::SeqCst);
                return (502, r#"{"error":"settlement timeout"}"#.into());
            }
            happy()(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        let first = do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err();
        let second = do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err();
        assert_eq!(dispatches.load(Ordering::SeqCst), 1);
        assert_eq!((first.code, second.code), ("spend_unknown", "spend_unknown"));
    }

    #[tokio::test]
    async fn regression_price_rise_refused_before_money_post() {
        let raised = Arc::new(AtomicBool::new(false));
        let r = raised.clone();
        let routes: Routes = Arc::new(move |m,p,b| {
            if p == "/pricing/peers" && r.load(Ordering::SeqCst) {
                return (200, serde_json::json!([{"peer_id":A, "prices":{"communication":999000}, "stale":false}]).to_string());
            }
            happy()(m,p,b)
        });
        let node = fake(AuthMode::Local, routes);
        assert_eq!(read_price_quote(&node.state, Some(A)).await.unwrap().peer_msat, Some(2000));
        raised.store(true, Ordering::SeqCst);
        spend_advance(&node.state, true).await.unwrap();
        assert_eq!(do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err().code, "price_changed");
        assert!(node.posts().is_empty());
    }

    #[tokio::test]
    async fn regression_timeout_blocks_retry_and_survives_reopen() {
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let routes: Routes = Arc::new(move |m,p,b| {
            if p == "/messages/compose" {
                c.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(120));
            }
            happy()(m,p,b)
        });
        let mut node = fake(AuthMode::Local, routes);
        assert!(node.state.spend_timeout >= Duration::from_secs(90));
        node.state.spend_timeout = Duration::from_millis(30);
        spend_advance(&node.state, true).await.unwrap();
        assert_eq!(do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err().code, "spend_unknown");
        assert_eq!(do_message_send(&node.state, A, false, "gm", 7000, None).await.unwrap_err().code, "spend_unknown");
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let reopened = NodeState::for_api(node.state.api_base.clone());
        *reopened.config.lock().unwrap() = node.state.config.lock().unwrap().clone();
        assert!(spend_journal(&reopened).unwrap().pending().unwrap().is_some());
        assert!(do_spend_reconcile(&node.state).await.is_err(), "no ID is not evidence of failure");
    }

    #[tokio::test]
    async fn regression_money_timeout_overrides_short_read_timeout() {
        let routes: Routes = Arc::new(|m,p,b| {
            if p == "/payments/keysend" { std::thread::sleep(Duration::from_millis(100)); }
            happy()(m,p,b)
        });
        let mut node = fake(AuthMode::Local, routes);
        node.state.http = reqwest::Client::builder().timeout(Duration::from_millis(20)).build().unwrap();
        spend_advance(&node.state, true).await.unwrap();
        let receipt = do_payment_keysend(&node.state, &format!("03{}", "cd".repeat(32)), 5000, None, 10000).await.unwrap();
        assert_eq!(receipt.status, "settled");
    }

    #[tokio::test]
    async fn regression_pending_payment_reconciles_by_hash_without_resend() {
        let settled = Arc::new(AtomicBool::new(false));
        let s = settled.clone();
        let hash = "ab".repeat(32);
        let routes: Routes = Arc::new(move |m,p,b| {
            if p == "/payments/keysend" {
                return (200, serde_json::json!({"max_routing_fee_msat": 0, "payment_hash":hash, "amount_msat":5000, "status":"InFlight"}).to_string());
            }
            if p == "/payments?limit=100" {
                return (200, serde_json::json!([{"payment_hash":hash, "amount_msat":5000, "direction":"outgoing", "status":if s.load(Ordering::SeqCst) {"settled"} else {"pending"}}]).to_string());
            }
            happy()(m,p,b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        let pk = format!("03{}", "cd".repeat(32));
        assert_eq!(do_payment_keysend(&node.state, &pk, 5000, None, 10000).await.unwrap().status, "inflight");
        assert!(do_spend_reconcile(&node.state).await.is_err());
        assert_eq!(do_payment_keysend(&node.state, &pk, 5000, None, 10000).await.unwrap_err().code, "spend_unknown");
        settled.store(true, Ordering::SeqCst);
        assert!(do_spend_reconcile(&node.state).await.unwrap().contains("settled"));
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
        assert_eq!(node.posts().len(), 1);
    }

    #[tokio::test]
    async fn regression_file_requotes_after_upload_before_spending() {
        let uploaded = Arc::new(AtomicBool::new(false));
        let u = uploaded.clone();
        let routes: Routes = Arc::new(move |m,p,b| {
            if p == "/files" { u.store(true, Ordering::SeqCst); }
            if p == "/payments/price/200" && u.load(Ordering::SeqCst) {
                return (200, serde_json::json!({"kind":200,"price_msat":999000}).to_string());
            }
            happy()(m,p,b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        assert_eq!(do_file_send(&node.state, A, "hi.txt", "text/plain", "aGk=", 8000, None).await.unwrap_err().code, "price_changed");
        assert_eq!(node.posts().len(), 1);
        assert_eq!(node.posts()[0].0, "/files");
    }

    #[tokio::test]
    async fn regression_payment_ceiling_and_receipt_are_both_checked() {
        let routes: Routes = Arc::new(|m,p,b| {
            if p == "/payments/pay" {
                return (200, serde_json::json!({"max_routing_fee_msat": 0, "payment_hash":"ab".repeat(32),"amount_msat":999000,"preimage":"proof"}).to_string());
            }
            happy()(m,p,b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        assert_eq!(do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 5999).await.unwrap_err().code, "price_changed");
        assert!(node.posts().is_empty());
        assert_eq!(do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 6000).await.unwrap_err().code, "spend_unknown");
        assert_eq!(do_payment_pay(&node.state, act::TEST_INVOICE_1000, 1000, 6000).await.unwrap_err().code, "spend_unknown");
        assert_eq!(node.posts().len(), 1);
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().unwrap().over_budget);
    }

    #[tokio::test]
    async fn an_unauthenticated_node_cannot_be_approved() {
        let node = fake(AuthMode::Unauthenticated, happy());
        assert_eq!(spend_advance(&node.state, true).await.unwrap_err().code, "app_not_ready");
    }
}

#[cfg(all(test, unix))]
mod stop_adapter_tests {
    //! Tests the REAL adapter against disposable subprocesses (app #16 review).
    //! Policy tests with injected effects could not prove the adapter avoids pid
    //! reuse or actually signals anything; these drive `stop_supervised_node` itself.
    use super::*;

    /// Spawn a disposable child and WAIT until it has installed its signal handler.
    ///
    /// Without this the tests race the fixture: the adapter signals immediately, and a
    /// shell that has not yet executed its `trap` line dies on the default SIGTERM
    /// disposition — which looks like a graceful exit and silently passes the
    /// escalation test. The child touches a readiness file after the trap is in place,
    /// so the handshake is deterministic rather than a sleep.
    fn spawn_ready(script_before_loop: &str) -> (Arc<SharedChild>, tempfile::TempDir) {
        let (mut c, dir) = fixture(script_before_loop);
        let child = Arc::new(SharedChild::spawn(&mut c).expect("spawn test child"));
        await_file(
            &dir.path().join("ready"),
            "test child never signalled readiness",
        );
        (child, dir)
    }

    /// The command behind `spawn_ready`, for tests that must spawn it through
    /// `NodeState::spawn_child` — the registration the exit handler relies on.
    fn fixture(script_before_loop: &str) -> (std::process::Command, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let ready = dir.path().join("ready");
        let got_term = dir.path().join("got_term");
        // {TERM_MARKER} lets a fixture record that its SIGTERM handler actually ran,
        // so a test can tell "exited because we asked politely" from "was SIGKILLed" —
        // indistinguishable from the outside otherwise.
        let script = format!(
            "{}; : > '{}'; while :; do sleep 0.05; done",
            script_before_loop.replace("{TERM_MARKER}", &got_term.display().to_string()),
            ready.display()
        );
        let mut c = std::process::Command::new("/bin/sh");
        c.args(["-c", &script]);
        (c, dir)
    }

    fn await_file(path: &Path, failure: &str) {
        for _ in 0..200 {
            if path.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("{failure}");
    }
    /// Exits on SIGTERM, like a well-behaved node, recording that it did.
    const HONOURS_TERM: &str = r#"trap ": > '{TERM_MARKER}'; exit 0" TERM"#;
    /// Ignores SIGTERM entirely — forces the escalation path.
    const IGNORES_TERM: &str = r#"trap '' TERM"#;
    /// Records SIGTERM but keeps running — a node hanging in its own shutdown.
    const RECORDS_BUT_IGNORES_TERM: &str = r#"trap ": > '{TERM_MARKER}'" TERM"#;

    fn alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[test]
    fn graceful_exit_needs_no_sigkill() {
        let (child, dir) = spawn_ready(HONOURS_TERM);
        let pid = child.id();
        let t = Instant::now();
        assert_eq!(
            stop_supervised_node(&child, Duration::from_secs(10)),
            StopOutcome::TermedAndExited,
            "a child that honours SIGTERM must not be escalated to SIGKILL"
        );
        assert!(
            dir.path().join("got_term").exists(),
            "the child's SIGTERM handler must have run — a SIGKILL-first adapter would \
             also end the process, and the outcome alone cannot tell them apart"
        );
        assert!(
            t.elapsed() < Duration::from_secs(5),
            "should exit promptly, took {:?}",
            t.elapsed()
        );
        assert!(!alive(pid), "process must be gone when the call returns");
    }

    #[test]
    fn timeout_escalates_to_sigkill_and_confirms_exit() {
        let (child, _d) = spawn_ready(IGNORES_TERM);
        let pid = child.id();
        assert_eq!(
            stop_supervised_node(&child, Duration::from_millis(400)),
            StopOutcome::Killed,
            "a child ignoring SIGTERM must be escalated once the budget elapses"
        );
        assert!(
            !alive(pid),
            "adapter must confirm completion, not assume it"
        );
    }

    #[test]
    fn already_exited_child_is_reported_not_signalled() {
        let mut c = std::process::Command::new("/bin/sh");
        c.args(["-c", "exit 0"]);
        let child = Arc::new(SharedChild::spawn(&mut c).expect("spawn"));
        child.wait().expect("reap");
        assert_eq!(
            stop_supervised_node(&child, Duration::from_secs(5)),
            StopOutcome::AlreadyExited
        );
    }

    #[test]
    fn repeated_shutdown_is_harmless() {
        let (child, _d) = spawn_ready(HONOURS_TERM);
        assert_eq!(
            stop_supervised_node(&child, Duration::from_secs(10)),
            StopOutcome::TermedAndExited
        );
        // A second shutdown event must not signal anything or hang.
        assert_eq!(
            stop_supervised_node(&child, Duration::from_secs(5)),
            StopOutcome::AlreadyExited
        );
    }

    #[test]
    fn a_foreign_process_is_untouched() {
        // The hazard the ownership work exists for: stopping ours must never disturb
        // a process we do not own, even one started from the same binary.
        let (ours, _d1) = spawn_ready(HONOURS_TERM);
        let (foreign, _d2) = spawn_ready(HONOURS_TERM);
        let foreign_pid = foreign.id();
        assert_eq!(
            stop_supervised_node(&ours, Duration::from_secs(10)),
            StopOutcome::TermedAndExited
        );
        assert!(
            alive(foreign_pid),
            "a process we do not own must survive our stop"
        );
        let _ = stop_supervised_node(&foreign, Duration::from_secs(10)); // cleanup
    }

    #[test]
    fn quit_during_a_restart_stop_still_stops_the_node() {
        // Codex R2G on 3ff4e60e: the restore deregistered the old node before its
        // stop, so a quit meanwhile found nothing, the host exited and took the restore
        // worker — and its SIGKILL fallback — with it, leaving the node running.
        let state = NodeState::default();
        let (mut cmd, dir) = fixture(RECORDS_BUT_IGNORES_TERM);
        let child = state
            .spawn_child(&mut cmd)
            .expect("spawn through NodeState");
        await_file(
            &dir.path().join("ready"),
            "test child never signalled readiness",
        );
        let pid = child.id();

        std::thread::scope(|s| {
            // The restore worker, part-way through a stop the node is not honouring.
            let restore = s.spawn(|| state.stop_for_restart(Duration::from_secs(10)));
            await_file(
                &dir.path().join("got_term"),
                "the restore never sent SIGTERM",
            );

            let outcome = state.stop_for_quit(Duration::from_millis(300));
            // Nothing runs after the exit handler returns, so the node must be gone
            // NOW — not when the restore worker's own budget would have run out.
            assert_eq!(
                outcome,
                Some(StopOutcome::Killed),
                "quit must find the node a restore is still stopping"
            );
            assert!(
                !alive(pid),
                "quit returned with the node still running — it would outlive the app"
            );
            assert!(restore.join().expect("restore worker"));
        });
        assert!(state.child.lock().unwrap().is_none());
    }

    #[test]
    fn a_restore_cannot_start_a_node_once_quit_has_begun() {
        // The other half of R2G: a restore still in flight when quit arrives must not
        // start the replacement — it would start after the exit handler looked.
        let state = NodeState::default();
        assert_eq!(state.stop_for_quit(Duration::from_secs(1)), None);

        let dir = tempfile::tempdir().expect("tempdir");
        let started = dir.path().join("started");
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", &format!(": > '{}'", started.display())]);
        assert!(
            state.spawn_child(&mut cmd).is_err(),
            "spawning after quit must be refused"
        );
        assert!(state.child.lock().unwrap().is_none());
        std::thread::sleep(Duration::from_millis(200));
        assert!(!started.exists(), "no process may be started after quit");
    }

    #[test]
    fn a_restart_without_quit_replaces_the_node() {
        // The quit coordination must not get in the way of an ordinary restore.
        let state = NodeState::default();
        let (mut cmd, old_dir) = fixture(HONOURS_TERM);
        let old_pid = state.spawn_child(&mut cmd).expect("spawn").id();
        await_file(
            &old_dir.path().join("ready"),
            "old child never signalled readiness",
        );

        assert!(state.stop_for_restart(Duration::from_secs(10)));
        assert!(
            !alive(old_pid),
            "the old node must be gone before the restart proceeds"
        );
        assert!(
            state.child.lock().unwrap().is_none(),
            "a node confirmed gone is deregistered"
        );

        let (mut cmd, new_dir) = fixture(HONOURS_TERM);
        let new_pid = state.spawn_child(&mut cmd).expect("replacement").id();
        await_file(
            &new_dir.path().join("ready"),
            "new child never signalled readiness",
        );
        assert_eq!(
            state.stop_for_quit(Duration::from_secs(10)),
            Some(StopOutcome::TermedAndExited),
            "quit must stop the replacement"
        );
        assert!(!alive(new_pid));
    }

    #[test]
    fn budget_exceeds_the_nodes_own_lightning_shutdown_window() {
        // konsensus-node allows itself 15s to flush LDK ChannelMonitor state;
        // escalating before that would cut off the persistence it protects.
        assert!(
            NODE_SHUTDOWN_BUDGET >= Duration::from_secs(20),
            "SIGKILL fallback at {NODE_SHUTDOWN_BUDGET:?} is inside the node's 15s flush window"
        );
    }
}

#[cfg(test)]
mod assistant_acl_tests {
    use super::{
        assistant_dev_enabled_from, assistant_document_allowed, assistant_node_enabled_from,
        window_may_run_privileged_command, ASSISTANT_DEV_HOST, ASSISTANT_DEV_PORT,
        ASSISTANT_DEV_SCHEME,
    };
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::PathBuf;

    fn manifest_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    fn glob_match(pattern: &str, text: &str) -> bool {
        fn rec(pattern: &[u8], text: &[u8]) -> bool {
            let (mut pi, mut ti) = (0, 0);
            let mut star: Option<usize> = None;
            let mut mark = 0;
            while ti < text.len() {
                if pi < pattern.len() && (pattern[pi] == b'?' || pattern[pi] == text[ti]) {
                    pi += 1;
                    ti += 1;
                } else if pi < pattern.len() && pattern[pi] == b'*' {
                    star = Some(pi);
                    mark = ti;
                    pi += 1;
                } else if let Some(star_pi) = star {
                    pi = star_pi + 1;
                    mark += 1;
                    ti = mark;
                } else {
                    return false;
                }
            }
            while pi < pattern.len() && pattern[pi] == b'*' {
                pi += 1;
            }
            pi == pattern.len()
        }
        rec(pattern.as_bytes(), text.as_bytes())
    }

    fn permission_slug(command: &str) -> String {
        command.replace('_', "-")
    }

    fn allow_perm(command: &str) -> String {
        format!("allow-{}", permission_slug(command))
    }

    fn deny_perm(command: &str) -> String {
        format!("deny-{}", permission_slug(command))
    }

    fn quoted_list(source: &str, marker: &str) -> Vec<String> {
        let start = source
            .find(marker)
            .unwrap_or_else(|| panic!("missing {marker}"));
        let rest = &source[start + marker.len()..];
        let end = rest.find(']').unwrap_or_else(|| panic!("{marker} has no ]"));
        rest[..end]
            .split('"')
            .enumerate()
            .filter(|(index, _)| index % 2 == 1)
            .map(|(_, part)| part.to_string())
            .collect()
    }

    fn handler_commands(source: &str) -> Vec<String> {
        let marker = "generate_handler![";
        let start = source.find(marker).expect("generate_handler");
        let rest = &source[start + marker.len()..];
        let end = rest.find(']').expect("generate_handler end");
        rest[..end]
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect()
    }

    fn function_source<'a>(source: &'a str, name: &str) -> &'a str {
        let async_pat = format!("async fn {name}(");
        let sync_pat = format!("fn {name}(");
        let start = if let Some(index) = source.find(&async_pat) {
            index
        } else {
            source
                .match_indices(&sync_pat)
                .find(|(index, _)| *index == 0 || source.as_bytes().get(index - 1) == Some(&b'\n'))
                .map(|(index, _)| index)
                .unwrap_or_else(|| panic!("missing fn {name}"))
        };
        let rest = &source[start..];
        let mut offset = 0;
        for (index, line) in rest.lines().enumerate() {
            if index > 0 && line == "}" {
                return &rest[..offset + line.len()];
            }
            offset += line.len() + 1;
        }
        panic!("unterminated fn {name}");
    }

    fn string_list(value: &serde_json::Value, key: &str) -> Vec<String> {
        value
            .get(key)
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn permission_identifiers(value: &serde_json::Value) -> Vec<String> {
        value
            .get("permissions")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|entry| match entry {
                        serde_json::Value::String(id) => Some(id.clone()),
                        serde_json::Value::Object(map) => map
                            .get("identifier")
                            .and_then(|v| v.as_str())
                            .map(str::to_owned),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn applies_to(cap: &serde_json::Value, label: &str) -> bool {
        string_list(cap, "windows")
            .iter()
            .chain(string_list(cap, "webviews").iter())
            .any(|pattern| glob_match(pattern, label))
    }

    fn load_capabilities() -> Vec<serde_json::Value> {
        let dir = manifest_dir().join("capabilities");
        let mut caps = Vec::new();
        for entry in fs::read_dir(&dir).expect("capabilities dir") {
            let path = entry.expect("capability entry").path();
            match path.extension().and_then(|ext| ext.to_str()) {
                Some("json") => {
                    let text = fs::read_to_string(&path).expect("read capability");
                    caps.push(serde_json::from_str(&text).expect("capability json"));
                }
                Some("toml") => panic!("unparsed capability {} — extend the ACL test", path.display()),
                _ => {}
            }
        }
        assert!(!caps.is_empty(), "no capability files");
        caps
    }

    fn production_source() -> String {
        let source = fs::read_to_string(manifest_dir().join("src/main.rs")).expect("main.rs");
        source
            .split("mod assistant_acl_tests")
            .next()
            .expect("split")
            .to_string()
    }

    #[test]
    fn only_the_main_window_may_run_privileged_commands() {
        assert!(window_may_run_privileged_command("main"));
        assert!(!window_may_run_privileged_command("assistant"));
        assert!(!window_may_run_privileged_command("Assistant"));
        assert!(!window_may_run_privileged_command("main-extra"));
        assert!(!window_may_run_privileged_command(""));
    }

    #[test]
    fn assistant_window_stays_behind_the_dev_flag() {
        assert!(!assistant_dev_enabled_from(false, Some("1")));
        assert!(!assistant_dev_enabled_from(true, None));
        assert!(!assistant_dev_enabled_from(true, Some("0")));
        assert!(!assistant_dev_enabled_from(true, Some("true")));
        assert!(assistant_dev_enabled_from(true, Some("1")));
    }

    /// `BITSOV_ASSISTANT=node` runs the full app with the Assistant menu, so
    /// the window can show live rows. It needs debug + sit-mock, and it never
    /// selects the node-free assistant-only path.
    #[test]
    fn node_mode_needs_debug_sit_mock_and_the_exact_flag() {
        assert!(assistant_node_enabled_from(true, true, Some("node")));
        assert!(!assistant_node_enabled_from(false, true, Some("node")));
        assert!(!assistant_node_enabled_from(true, false, Some("node")));
        assert!(!assistant_node_enabled_from(true, true, Some("1")));
        assert!(!assistant_node_enabled_from(true, true, Some("NODE")));
        assert!(!assistant_node_enabled_from(true, true, None));
        assert!(!assistant_dev_enabled_from(true, Some("node")));
    }

    /// The backend is chosen host-side. No command is added for the
    /// assistant, the choice takes host state only, and the window receives
    /// it as a frozen init-script global. The node read is outside the sealed
    /// section.
    #[test]
    fn the_sealed_window_has_no_way_to_choose_its_source() {
        let source = production_source();
        assert_eq!(
            handler_commands(&source),
            [
                "node_status",
                "fund_state",
                "fund_start",
                "funding_address",
                "payments_balance",
                "identity_restore",
                "pairing_status",
                "pairing_retry",
                // Control center reads (main window only, ACL + reject_sealed_window).
                "node_overview",
                "live_link",
                "peers_list",
                "rooms_list",
                "room_members",
                "messages_list",
                "price_quote",
                "first_contact_quote",
                "introduction_mine",
                "introduction_read",
                "introduction_open",
                "front_door_mine",
                "front_door_read",
                "front_door_open",
                "front_door_publish",
                "front_door_hash_bytes",
                "sponsor_status",
                "sponsor_offer",
                "sponsor_candidate",
                "sponsor_owner_approval",
                "sponsor_reconcile",
                "sponsor_cancel",
                "sponsor_request",
                "sponsor_request_status",
                "first_contact_request",
                "first_contact_status",
                "first_contact_cancel",
                "payments_overview",
                // Organism reads (genome N1/N2), same guard.
                "energy_read",
                "membrane_read",
                // Control center actions (slice B): same guard, plus the spend window.
                "spend_status",
                "spend_request",
                "spend_lock",
                "spend_cancel",
                "device_key_status",
                "device_key_register",
                "device_key_cancel",
                "relation_approve",
                "spend_reconcile",
                "budget_status",
                "budget_approve",
                "budget_set",
                "budget_pause",
                "budget_resume",
                "message_send",
                "message_retry",
                "spend_dismiss_undelivered",
                "room_quote",
                "invoice_create",
                "invoice_amount",
                "payment_pay",
                "payment_keysend",
                "invite_create",
                "invite_redeem",
                "file_price",
                "file_send",
                "voice_note_fetch",
                "file_fetch",
                "file_save",
                "call_quote",
                "call_signal",
                // AI track: main window only, reads through the broker.
                "ai_read",
                "ai_providers",
                "ai_disclose",
                "ai_send",
                "ai_cancel",
                "ai_local_status",
                "ai_local_select",
                "ai_local_clear",
            ]
        );
        assert!(handler_commands(&source)
            .iter()
            .all(|name| !name.contains("assistant") && !name.contains("source")));
        let build_rs = fs::read_to_string(manifest_dir().join("build.rs")).expect("build.rs");
        assert!(!build_rs.to_lowercase().contains("assistant_source"));
        assert!(!build_rs.to_lowercase().contains("backend"));

        let chooser = function_source(&source, "assistant_source_script");
        assert!(chooser.contains("app: &AppHandle"), "{chooser}");
        assert!(!chooser.contains("WebviewWindow"), "{chooser}");
        assert!(!chooser.contains("#[tauri::command]"));
        assert!(chooser.contains("assistant_feed::build(node_auth(&state), &state.api_base"));

        let opener = function_source(&source, "open_assistant_window");
        assert!(opener.contains(".initialization_script(assistant_rows_script())"));
        assert!(opener.contains(".initialization_script(source_script)"));

        let sealed = source
            .split("// ---- sealed assistant window")
            .nth(1)
            .and_then(|rest| rest.split("// ---- commands").next())
            .expect("sealed section");
        for token in ["assistant_feed::build", "LocalNodeRead", "api_base", "NodeState"] {
            assert!(!sealed.contains(token), "sealed section uses {token}");
        }
        let menu = function_source(&source, "install_assistant_menu");
        assert!(menu.contains("std::thread::spawn"), "node reads stay off the UI thread");
        assert!(menu.contains("assistant_source_script(&app)"));

        let mock = function_source(&source, "assistant_mock_builder");
        assert!(mock.contains("Feed::mock(MockReason::NotPaired).init_script()"));
    }

    fn dev_url_parts() -> (String, String, u16) {
        let conf: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(manifest_dir().join("tauri.conf.json")).expect("tauri.conf"),
        )
        .expect("tauri.conf json");
        let raw = conf["build"]["devUrl"].as_str().expect("devUrl");
        let (scheme, rest) = raw.split_once("://").expect("devUrl scheme");
        let (host, port) = rest.split_once(':').expect("devUrl port");
        assert!(port.chars().all(|c| c.is_ascii_digit()), "devUrl port");
        (
            scheme.to_string(),
            host.to_string(),
            port.parse().expect("devUrl port number"),
        )
    }

    #[test]
    fn assistant_navigation_allows_the_bundled_page_and_debug_dev_url() {
        let (scheme, host, port) = dev_url_parts();
        assert_eq!(scheme, ASSISTANT_DEV_SCHEME);
        assert_eq!(host, ASSISTANT_DEV_HOST);
        assert_eq!(port, ASSISTANT_DEV_PORT);

        assert!(assistant_document_allowed(
            true,
            ASSISTANT_DEV_SCHEME,
            Some(ASSISTANT_DEV_HOST),
            Some(ASSISTANT_DEV_PORT),
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            false,
            ASSISTANT_DEV_SCHEME,
            Some(ASSISTANT_DEV_HOST),
            Some(ASSISTANT_DEV_PORT),
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            true,
            "https",
            Some("localhost"),
            Some(ASSISTANT_DEV_PORT),
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            true,
            "http",
            Some("127.0.0.1"),
            Some(ASSISTANT_DEV_PORT),
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            true,
            "http",
            Some("localhost"),
            Some(1421),
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            true,
            "http",
            Some("localhost"),
            None,
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            true,
            "http",
            Some("localhost"),
            Some(ASSISTANT_DEV_PORT),
            "/index.html"
        ));

        assert_bundled_origin(true);
        assert_bundled_origin(false);
        assert!(!assistant_document_allowed(
            true,
            "http",
            Some("tauri.localhost"),
            Some(80),
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            false,
            "https",
            Some("tauri.localhost"),
            Some(443),
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            true,
            "javascript",
            None,
            None,
            "alert(1)"
        ));
        assert!(!assistant_document_allowed(
            true,
            "data",
            None,
            None,
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            true,
            "https",
            Some("evil.example"),
            None,
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            true,
            "http",
            Some("localhost.evil.example"),
            None,
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            true,
            "file",
            Some("localhost"),
            None,
            "/assistant.html"
        ));
    }

    fn assert_bundled_origin(debug_build: bool) {
        #[cfg(any(windows, target_os = "android"))]
        {
            assert!(assistant_document_allowed(
                debug_build,
                "http",
                Some("tauri.localhost"),
                None,
                "/assistant.html"
            ));
            assert!(!assistant_document_allowed(
                debug_build,
                "https",
                Some("tauri.localhost"),
                None,
                "/assistant.html"
            ));
            assert!(!assistant_document_allowed(
                debug_build,
                "tauri",
                Some("localhost"),
                None,
                "/assistant.html"
            ));
            assert!(!assistant_document_allowed(
                debug_build,
                "http",
                Some("tauri.localhost"),
                None,
                "/index.html"
            ));
        }
        #[cfg(not(any(windows, target_os = "android")))]
        {
            assert!(assistant_document_allowed(
                debug_build,
                "tauri",
                Some("localhost"),
                None,
                "/assistant.html"
            ));
            assert!(!assistant_document_allowed(
                debug_build,
                "http",
                Some("tauri.localhost"),
                None,
                "/assistant.html"
            ));
            assert!(!assistant_document_allowed(
                debug_build,
                "https",
                Some("tauri.localhost"),
                None,
                "/assistant.html"
            ));
            assert!(!assistant_document_allowed(
                debug_build,
                "tauri",
                Some("localhost"),
                None,
                "/index.html"
            ));
        }
    }

    #[test]
    fn assistant_capability_grants_nothing_and_main_keeps_allows() {
        let source = production_source();
        let commands = handler_commands(&source);
        let required = [
            "node_status",
            "fund_state",
            "fund_start",
            "funding_address",
            "payments_balance",
            "identity_restore",
            "pairing_status",
            "pairing_retry",
        ];
        for name in required {
            assert!(commands.iter().any(|command| command == name), "missing {name}");
        }

        let build_rs = fs::read_to_string(manifest_dir().join("build.rs")).expect("build.rs");
        let manifest = quoted_list(&build_rs, ".commands(&[");
        assert_eq!(
            commands.iter().cloned().collect::<BTreeSet<_>>(),
            manifest.iter().cloned().collect::<BTreeSet<_>>(),
            "every custom command must be in AppManifest or Tauri allows it on every window"
        );

        let caps = load_capabilities();
        assert!(
            build_rs.contains("PROFILE") && build_rs.contains("capabilities/default.json"),
            "release builds must compile the main capability only"
        );
        let vite = fs::read_to_string(manifest_dir().join("../vite.config.ts")).expect("vite");
        assert!(
            vite.contains("TAURI_ENV_PLATFORM")
                && vite.contains("TAURI_ENV_DEBUG === 'true'")
                && vite.contains("assistant.html"),
            "release frontend builds must be able to omit assistant.html"
        );

        let assistant_caps: Vec<_> = caps.iter().filter(|cap| applies_to(cap, "assistant")).collect();
        assert_eq!(
            assistant_caps.len(),
            1,
            "the assistant window needs its own capability so it is not covered by a wildcard"
        );
        assert!(
            permission_identifiers(assistant_caps[0]).is_empty(),
            "a window with no grant already gets nothing; deny entries apply to every window"
        );
        assert!(
            assistant_caps[0].get("remote").map(|v| v.is_null()).unwrap_or(true),
            "assistant capability must not allow remote origins"
        );
        for cap in &caps {
            let ids = permission_identifiers(cap);
            for command in &commands {
                assert!(
                    !ids.iter().any(|id| id == &deny_perm(command)),
                    "{} grants {}, which Tauri 2.11 applies to every window",
                    cap.get("identifier").and_then(|v| v.as_str()).unwrap_or("capability"),
                    deny_perm(command)
                );
            }
            assert!(
                !cap.to_string().to_lowercase().contains("clipboard"),
                "clipboard permissions are not granted"
            );
        }

        let main_caps: Vec<_> = caps.iter().filter(|cap| applies_to(cap, "main")).collect();
        assert_eq!(main_caps.len(), 1, "main must keep a single capability");
        let main = main_caps[0];
        assert_eq!(string_list(main, "windows"), vec!["main".to_string()]);
        assert!(!applies_to(main, "assistant"));
        let main_perms = permission_identifiers(main);
        assert!(main_perms.iter().any(|id| id == "core:default"));
        for command in &commands {
            assert!(
                main_perms.iter().any(|id| id == &allow_perm(command)),
                "main lost {command}"
            );
            assert!(
                !main_perms.iter().any(|id| id == &deny_perm(command)),
                "main is denied {command}"
            );
        }
        let shell = main
            .get("permissions")
            .and_then(|v| v.as_array())
            .and_then(|items| {
                items.iter().find(|entry| {
                    entry.get("identifier").and_then(|v| v.as_str()) == Some("shell:allow-execute")
                })
            })
            .expect("main keeps the sidecar execute permission");
        let allow = shell.get("allow").and_then(|v| v.as_array()).expect("shell allow");
        assert_eq!(allow.len(), 1);
        assert_eq!(allow[0].get("name").and_then(|v| v.as_str()), Some("bin/konsensus"));
        assert_eq!(allow[0].get("sidecar").and_then(|v| v.as_bool()), Some(true));
        assert!(main_perms.iter().all(|id| id != "shell:allow-spawn" && id != "shell:allow-kill"));

        let conf: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(manifest_dir().join("tauri.conf.json")).expect("tauri.conf"),
        )
        .expect("tauri.conf json");
        let windows = conf["app"]["windows"].as_array().expect("windows");
        assert_eq!(windows.len(), 1);
        assert!(windows[0].get("label").is_none() || windows[0]["label"] == "main");
        let text = fs::read_to_string(manifest_dir().join("tauri.conf.json")).expect("conf text");
        assert!(!text.contains("assistant"));
        if let Some(inlined) = conf["app"]["security"].get("capabilities").and_then(|v| v.as_array())
        {
            assert!(
                inlined.iter().all(|entry| entry.is_string()),
                "inline capability objects would bypass this directory scan"
            );
        }
    }

    #[test]
    fn every_privileged_handler_checks_the_caller_window() {
        let source = production_source();
        let guard = function_source(&source, "reject_sealed_window");
        assert!(guard.contains("window.label()"));
        assert!(guard.contains("window_may_run_privileged_command"));
        assert!(!guard.contains("label: String"));

        for name in handler_commands(&source) {
            let body = function_source(&source, &name);
            assert!(
                body.contains("window: WebviewWindow"),
                "{name} must take the trusted WebviewWindow"
            );
            let after = body.split_once('{').expect("body").1;
            let first = after
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty() && !line.starts_with("//"))
                .unwrap_or("");
            assert_eq!(
                first, "reject_sealed_window(&window)?;",
                "{name} must reject the assistant window before doing anything else"
            );
            assert!(!body.contains("window_label"));
            assert!(!body.contains("label:"));
        }

        let opener = function_source(&source, "open_assistant_window");
        assert!(opener.contains("assistant_dev_enabled()"));
        assert!(opener.contains("ASSISTANT_WINDOW_LABEL"));
        assert!(opener.contains("assistant_document_allowed"));
        assert!(opener.contains("debug_assertions"));
        assert!(!opener.contains("enable_clipboard_access"));
        assert!(!source.contains("clipboard-manager"));
        assert!(opener.contains("NewWindowResponse::Deny"));
        assert!(!opener.contains("WebviewUrl::External"));
        // definition + menu handler + sit-mock assistant-only setup
        assert_eq!(source.matches("open_assistant_window(").count(), 3);
        assert!(source.contains("if assistant_dev_enabled()"));
        assert!(source.contains("fn app_builder("));
        assert!(source.contains("fn assistant_mock_builder("));
        assert!(
            source.contains("assistant_mock_builder()"),
            "BITSOV_ASSISTANT + sit-mock must take the assistant-only path"
        );

        let copy = fs::read_to_string(manifest_dir().join("../src/assistant/copy.ts")).expect("copy");
        assert!(copy.contains("clipboard.writeText"));
        assert!(!copy.contains("@tauri-apps/plugin-clipboard"));
        assert!(!copy.contains("invoke("));
    }

    /// `npm run tauri:assistant` must never construct NodeState (reqwest client),
    /// register wallet commands, spawn konsensus, or call bootstrap_node.
    #[test]
    fn assistant_mock_startup_does_not_touch_node_or_network() {
        let source = production_source();
        let mock = function_source(&source, "assistant_mock_builder");
        let forbidden = [
            "NodeState",
            "bootstrap_node",
            "spawn_node",
            "spawn_child",
            "SIDECAR_BIN",
            "konsensus",
            "tauri_plugin_shell",
            "manage(",
            "reqwest",
            "call_api",
            "API_BASE",
            "mint_token",
            "3141",
            "TcpStream",
            "UdpSocket",
            "std::net",
            "tokio::net",
            "hyper",
            "ureq",
            "node_status",
            "fund_state",
            "fund_start",
            "funding_address",
            "payments_balance",
            "identity_restore",
            "pairing_status",
            "pairing_retry",
            "pairing::",
            "generate_context",
            "bootstrap",
        ];
        for token in forbidden {
            assert!(
                !mock.contains(token),
                "assistant_mock_builder must not use {token}:\n{mock}"
            );
        }
        assert!(
            mock.contains("open_assistant_window"),
            "mock path must open the sealed assistant"
        );
        assert!(
            mock.contains("generate_handler![]"),
            "mock path must register no privileged commands"
        );

        // main() must branch to the mock builder under sit-mock + the flag, and
        // release/normal debug must still call app_builder (unchanged bootstrap).
        let main_fn = function_source(&source, "main");
        assert!(main_fn.contains("assistant_mock_builder()"));
        assert!(main_fn.contains("app_builder()"));
        assert!(main_fn.contains("assistant_dev_enabled()"));
        assert!(main_fn.contains("feature = \"sit-mock\""));
        // A second generate_context in the mock path duplicates Info.plist.
        assert_eq!(
            source.matches("tauri::generate_context!").count(),
            1,
            "exactly one generate_context so sit-mock still links"
        );

        let app = function_source(&source, "app_builder");
        assert!(app.contains("NodeState::default()"));
        assert!(app.contains("bootstrap_node"));
        assert!(app.contains("tauri_plugin_shell"));
        for cmd in [
            "node_status",
            "fund_state",
            "fund_start",
            "funding_address",
            "payments_balance",
            "identity_restore",
            "pairing_status",
            "pairing_retry",
        ] {
            assert!(app.contains(cmd), "app_builder lost {cmd}");
        }
    }

    #[test]
    fn window_globs_that_would_cover_the_assistant_match() {
        assert!(glob_match("*", "assistant"));
        assert!(glob_match("assistant", "assistant"));
        assert!(glob_match("assistant*", "assistant"));
        assert!(glob_match("*assistant", "assistant"));
        assert!(!glob_match("main", "assistant"));
        assert!(!glob_match("assistant?", "assistant"));
    }

    fn local_ipc_url() -> tauri::webview::Url {
        // Split so this file has no `http://` literal. Linux/macOS use the tauri
        // scheme; Windows and Android serve the bundled origin as http on
        // tauri.localhost. Either way the origin is local to Tauri's ACL.
        let raw = if cfg!(any(windows, target_os = "android")) {
            format!("{}://tauri.localhost", "http")
        } else {
            format!("{}://localhost", "tauri")
        };
        raw.parse().expect("local ipc url")
    }

    fn invoke(
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        cmd: &str,
        body: serde_json::Value,
    ) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
        tauri::test::get_ipc_response(
            webview,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: local_ipc_url(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
    }

    fn error_text(value: &serde_json::Value) -> String {
        value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string())
    }

    fn assert_handler_ran(result: Result<tauri::ipc::InvokeResponseBody, serde_json::Value>, marker: &str) {
        match result {
            Ok(body) => panic!("{marker} returned Ok({body:?}); the handler was not the expected rejection"),
            Err(value) => {
                let text = error_text(&value);
                assert!(
                    text.contains(marker),
                    "main window should reach the handler ({marker}), got {text}"
                );
                assert!(
                    !text.contains("not allowed"),
                    "main window was blocked by the ACL before {marker}: {text}"
                );
            }
        }
    }

    fn assert_acl_denied(result: Result<tauri::ipc::InvokeResponseBody, serde_json::Value>, cmd: &str) {
        match result {
            Ok(body) => panic!("{cmd} from the assistant window returned Ok({body:?})"),
            Err(value) => {
                let text = error_text(&value);
                assert!(
                    text.contains("not allowed"),
                    "{cmd} from the assistant window should be denied by the ACL, got {text}"
                );
                assert!(
                    !text.contains("only available to the main window"),
                    "{cmd} reached the handler guard instead of the ACL: {text}"
                );
                assert!(!text.contains("at least 1 sat"), "{text}");
                assert!(!text.contains("12 or 24"), "{text}");
                assert!(!text.contains("not authenticated"), "{text}");
            }
        }
    }

    #[test]
    fn real_acl_allows_main_and_denies_assistant() {
        let app = tauri::test::mock_builder()
            .manage(super::NodeState::default())
            .invoke_handler(tauri::generate_handler![
                super::node_status,
                super::fund_state,
                super::fund_start,
                super::funding_address,
                super::payments_balance,
                super::identity_restore,
                super::pairing_status,
                super::pairing_retry,
            ])
            // `test = true` skips the macOS Info.plist embed. A second plain
            // generate_context!() defines `_EMBED_INFO_PLIST` again and cargo
            // test fails to link on macOS.
            .build(tauri::generate_context!(test = true))
            .expect("test app");

        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("main window");
        let assistant = tauri::WebviewWindowBuilder::new(&app, "assistant", Default::default())
            .build()
            .expect("assistant window");

        let status = invoke(&main, "node_status", serde_json::json!({}))
            .expect("main node_status is granted");
        match status {
            tauri::ipc::InvokeResponseBody::Json(body) => {
                assert!(body.contains("\"ready\""), "node_status body: {body}");
            }
            tauri::ipc::InvokeResponseBody::Raw(bytes) => {
                panic!("node_status returned raw bytes ({} bytes)", bytes.len());
            }
        }

        assert_handler_ran(
            invoke(
                &main,
                "fund_start",
                serde_json::json!({ "funding_amount_sats": 0 }),
            ),
            "at least 1 sat",
        );
        assert_handler_ran(
            invoke(&main, "identity_restore", serde_json::json!({ "mnemonic": "nope" })),
            "12 or 24",
        );
        for cmd in ["fund_state", "funding_address", "payments_balance"] {
            assert_handler_ran(
                invoke(&main, cmd, serde_json::json!({})),
                "not authenticated",
            );
        }

        assert_acl_denied(
            invoke(&assistant, "node_status", serde_json::json!({})),
            "node_status",
        );
        assert_acl_denied(
            invoke(
                &assistant,
                "fund_start",
                serde_json::json!({ "funding_amount_sats": 0 }),
            ),
            "fund_start",
        );
        assert_acl_denied(
            invoke(
                &assistant,
                "identity_restore",
                serde_json::json!({ "mnemonic": "nope" }),
            ),
            "identity_restore",
        );
        for cmd in ["fund_state", "funding_address", "payments_balance"] {
            assert_acl_denied(invoke(&assistant, cmd, serde_json::json!({})), cmd);
        }

        // Pairing: main reaches the handlers, the assistant is stopped by the ACL.
        match invoke(&main, "pairing_status", serde_json::json!({}))
            .expect("main pairing_status is granted")
        {
            tauri::ipc::InvokeResponseBody::Json(body) => {
                assert!(body.contains("\"state\":\"starting\""), "pairing_status body: {body}");
                assert!(!body.contains("token"), "pairing_status carries no token: {body}");
            }
            tauri::ipc::InvokeResponseBody::Raw(bytes) => {
                panic!("pairing_status returned raw bytes ({} bytes)", bytes.len());
            }
        }
        assert_handler_ran(
            invoke(&main, "pairing_retry", serde_json::json!({})),
            "the node has not started",
        );
        for cmd in ["pairing_status", "pairing_retry"] {
            assert_acl_denied(invoke(&assistant, cmd, serde_json::json!({})), cmd);
        }
    }

    /// The field bug: the bridge's socket opened (and emitted `open`) before the
    /// shell subscribed, so the pill said "reconnecting" on a live link. A
    /// subscriber that arrives after the open asks `live_link` and gets the
    /// socket's current state on `node-live`. The assistant window is denied.
    #[test]
    fn subscribe_after_open_replays_the_open_link() {
        use std::sync::{Arc, Mutex};
        use tauri::Listener;

        let app = tauri::test::mock_builder()
            .manage(super::NodeState::default())
            .invoke_handler(tauri::generate_handler![super::live_link])
            .build(tauri::generate_context!(test = true))
            .expect("test app");
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("main window");
        let assistant = tauri::WebviewWindowBuilder::new(&app, "assistant", Default::default())
            .build()
            .expect("assistant window");

        // Before the bridge reports anything there is nothing to replay.
        match invoke(&main, "live_link", serde_json::json!({})).expect("main live_link is granted") {
            tauri::ipc::InvokeResponseBody::Json(body) => assert_eq!(body, "null"),
            other => panic!("live_link body: {other:?}"),
        }

        // The socket opens while nobody is listening.
        let handle = app.handle().clone();
        for state in [super::control::LinkState::Connecting, super::control::LinkState::Open] {
            super::emit_live(&handle, super::control::LiveEvent::Link { state, detail: None });
        }

        // Now the shell subscribes, then asks for the current state.
        let heard = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = heard.clone();
        main.listen(super::LIVE_EVENT, move |event| sink.lock().unwrap().push(event.payload().to_string()));
        match invoke(&main, "live_link", serde_json::json!({})).expect("main live_link is granted") {
            tauri::ipc::InvokeResponseBody::Json(body) => assert_eq!(body, "\"open\""),
            other => panic!("live_link body: {other:?}"),
        }
        assert_eq!(
            *heard.lock().unwrap(),
            [r#"{"type":"link","state":"open","detail":null}"#],
            "the late subscriber hears the open link on node-live"
        );

        assert_acl_denied(invoke(&assistant, "live_link", serde_json::json!({})), "live_link");
        assert_eq!(heard.lock().unwrap().len(), 1, "a denied call replays nothing");
    }
}
