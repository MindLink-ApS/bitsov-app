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

/// Node API bind — konsensus ApiConfig `default_api_addr()` = 127.0.0.1:3141.
/// Loopback ONLY (Gate G2): never point this at a non-loopback host until a
/// confidential remote transport + delegated auth exist.
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
    /// Serializes this process's budget-file read-modify-write.
    budget_io: Mutex<()>,
}

/// The owner asked for these while an elevation request is pending.
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
        Self::for_api(API_BASE)
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
            budget_io: Mutex::new(()),
            ready: Mutex::new(false),
            node_id: Mutex::new(None),
            error: Mutex::new(None),
            child: Mutex::new(None),
            quitting: AtomicBool::new(false),
            token: Mutex::new(None),
            config: Mutex::new(None),
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
async fn init_node(app: &AppHandle, data_dir: &Path) -> Result<(), String> {
    let cmd = app
        .shell()
        .sidecar("konsensus")
        .map_err(|e| format!("cannot resolve node sidecar: {e}"))?
        .args([
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
    let program = sidecar_path(SIDECAR_BIN)?;
    let mut cmd = std::process::Command::new(&program);
    cmd.args(["start", "--config", &config.to_string_lossy()])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let state = app.state::<NodeState>();
    state.sidecar_terminated.store(false, Ordering::SeqCst);
    let child = state.spawn_child(&mut cmd)?;

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

/// PIDs listening on the loopback control plane. POST /identity/restore only writes
/// files; whoever still answers 3141 keeps the old id until that process is replaced.
fn loopback_listener_pids() -> Vec<u32> {
    let mut pids = Vec::new();
    if let Ok(out) = std::process::Command::new("lsof")
        .args(["-nP", "-iTCP:3141", "-sTCP:LISTEN", "-t"])
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

/// Stop the process that holds 127.0.0.1:3141 so a restart can bind the restored identity.
fn stop_loopback_listener() {
    let our_pid = std::process::id();
    for pid in loopback_listener_pids() {
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
    *state.ready.lock().unwrap() = false;
    *state.node_id.lock().unwrap() = None;
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
        stop_loopback_listener();
        for _ in 0..20 {
            if !health_ok(&state).await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        if health_ok(&state).await {
            return Err("could not free 127.0.0.1:3141 after identity restore".into());
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

/// Ensure a node config exists (first run), then start + supervise the node,
/// wait for /health, pair (or fall back to /auth/local on rc7), and read /identity.
async fn bootstrap_node(app: AppHandle) {
    let state = app.state::<NodeState>();
    let data_dir: PathBuf = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => return set_error(&state, format!("no app data dir: {e}")),
    };
    let _ = std::fs::create_dir_all(&data_dir);
    let config = data_dir.join("konsensus.toml");

    if !config.exists() {
        if let Err(e) = init_node(&app, &data_dir).await {
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
fn pairing_ctx(state: &NodeState, data_dir: &Path) -> Result<Arc<PairingCtx>, PairError> {
    if let Some(ctx) = state.pairing.lock().unwrap().as_ref() {
        return Ok(ctx.clone());
    }
    let store = data_dir.join(PAIRING_STORE_DIR);
    let key = ClientKey::load_or_create(&store)?;
    let client = PairingClient::new(state.http.clone(), state.api_base.clone())
        .expect_challenge_dir(data_dir.join("pairing"));
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
    Ok(control::NodeOverview::from_status(status, now_ms()))
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
    get_json(state.inner(), "/peers").await
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

/// An admin POST (invites or file upload), never a money request.
async fn gated_post(
    state: &NodeState,
    path: &str,
    body: serde_json::Value,
) -> Result<String, ActionError> {
    state.spend.lock().unwrap().check(now_ms())?;
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

fn spend_journal(state: &NodeState) -> Result<Journal, ActionError> {
    let config = state.config.lock().unwrap().clone()
        .ok_or_else(|| spend_journal::unknown("The app data directory is not ready."))?;
    let dir = config.parent().ok_or_else(|| spend_journal::unknown("Missing app data directory."))?;
    Journal::open(&dir.join("app-spend"))
}

fn ceiling(price: u64, max_msat: u64) -> Result<(), ActionError> {
    if max_msat == 0 || price > max_msat {
        return Err(ActionError::new("price_changed", format!("The current price is {price} msat, above the confirmed ceiling of {max_msat} msat. Nothing was dispatched; refresh the quote.")));
    }
    Ok(())
}

fn no_pending_spend(state: &NodeState) -> Result<(), ActionError> {
    if spend_journal(state)?.pending()?.is_some() {
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
}

fn budget_dir(state: &NodeState) -> Result<(PathBuf, String), ActionError> {
    let config = state.config.lock().unwrap().clone()
        .ok_or_else(|| ActionError::new("not_ready", "The app data directory is not ready."))?;
    let dir = config.parent().ok_or_else(|| ActionError::new("not_ready", "Missing app data directory."))?.join("app-spend");
    let node_id = state.node_id.lock().unwrap().clone().ok_or_else(|| ActionError::new("not_ready", "No node identity."))?;
    Ok((dir, node_id))
}

/// Read the book, let `edit` change it, and write it back only if asked.
fn with_book<T>(state: &NodeState, write: bool, edit: impl FnOnce(&mut Book) -> Result<T, ActionError>) -> Result<T, ActionError> {
    let _io = state.budget_io.lock().unwrap();
    let (dir, node_id) = budget_dir(state)?;
    let mut book = budget::load(&dir, &node_id)?;
    let out = edit(&mut book)?;
    if write {
        book.prune(now_ms());
        budget::save(&dir, &book)?;
    }
    Ok(out)
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

/// Settle or release a reservation. A failed write leaves the full ceiling
/// counted, which only ever under-spends.
fn close_charge(state: &NodeState, id: &str, paid: Option<u64>) {
    let _ = with_book(state, true, |book| {
        match paid {
            Some(msat) => book.settle(id, msat),
            None => book.release(id),
        }
        Ok(())
    });
}

/// No automatic HTTP retry on a money path. Journal before dispatch, and retain
/// ambiguity on every transport/5xx/decode failure, even across app restarts.
async fn money_post(state: &NodeState, auth: Auth, path: &str, body: serde_json::Value, max_msat: u64, charge: Option<Charge>) -> Result<String, ActionError> {
    let journal = spend_journal(state)?;
    if journal.pending()?.is_some() { return Err(spend_journal::unknown("Check the pending result before sending again.")); }
    ensure_fresh_token(state).await;
    let token = state.token.lock().unwrap().clone().ok_or_else(|| ActionError::new("not_ready", "Not authenticated."))?;
    let node_id = state.node_id.lock().unwrap().clone().ok_or_else(|| ActionError::new("not_ready", "No node identity."))?;
    check_auth(state, auth)?;
    let mut pending = journal.begin(&node_id, path, &body, max_msat)?;
    let charged = match &charge {
        Some(c) => match reserve(state, auth, c, &pending.request_hash, max_msat) {
            Ok(()) => Some(pending.request_hash.clone()),
            Err(e) => {
                journal.clear()?;
                return Err(e);
            }
        },
        None => None,
    };
    let release = |state: &NodeState| if let Some(id) = &charged { close_charge(state, id, None) };
    // Journal I/O can take time. Recheck immediately before issuing the request.
    if let Err(e) = check_auth(state, auth) {
        release(state);
        journal.clear()?;
        return Err(e);
    }
    let response = state.http.post(format!("{}{path}", state.api_base))
        .bearer_auth(token).json(&body).timeout(state.spend_timeout).send().await
        .map_err(|_| spend_journal::unknown("The node did not return a complete response."))?;
    let status = response.status();
    // These statuses are rejected by authentication before any handler runs.
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::UNAUTHORIZED {
        release(state);
        journal.clear()?;
        state.autopay.lock().unwrap().lock();
        return Err(state.spend.lock().unwrap().refused());
    }
    let text = response.text().await.map_err(|_| spend_journal::unknown("The response was interrupted."))?;
    if status == reqwest::StatusCode::CONFLICT && body.get("max_total_msat").is_some()
        && serde_json::from_str::<serde_json::Value>(&text).ok().is_some_and(|v| v["code"] == "price_cap_exceeded") {
        release(state);
        journal.clear()?;
        return Err(ActionError::new("price_cap_exceeded", "The node refused the changed price before any payment. Refresh the quote."));
    }
    if !status.is_success() {
        return Err(spend_journal::unknown(api_error(path, status, &text)));
    }
    let value: serde_json::Value = serde_json::from_str(&text).map_err(spend_journal::unknown)?;
    let is_room = body["is_room"].as_bool() == Some(true);
    let mut room_refused = false;
    let (amount, complete) = if path == "/payments/pay" {
        let receipt: act::PayReply = serde_json::from_value(value.clone()).map_err(spend_journal::unknown)?;
        (receipt.amount_msat, !receipt.preimage.is_empty())
    } else if path == "/payments/keysend" {
        let receipt: act::KeysendReply = serde_json::from_value(value.clone()).map_err(spend_journal::unknown)?;
        (receipt.amount_msat, matches!(receipt.status.to_ascii_lowercase().as_str(), "settled" | "failed"))
    } else {
        let receipt: act::SendReply = serde_json::from_value(value.clone()).map_err(spend_journal::unknown)?;
        let complete = if is_room {
            let summary = act::room_result(&value, &body, max_msat)?;
            room_refused = summary.1;
            summary.0
        } else { true };
        (receipt.amount_msat, complete)
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
    pending.over_budget = amount > max_msat;
    // An unresolved room keeps its whole ceiling reserved; otherwise count what was paid.
    if let (Some(id), true) = (&charged, complete) { close_charge(state, id, Some(amount)); }
    if pending.over_budget || !complete {
        journal.save(&pending)?;
        if pending.over_budget {
            return Err(spend_journal::unknown(format!("The node reports {amount} msat, exceeding the confirmed {max_msat} msat. Funds may already have moved; do not retry.")));
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
    Ok(text)
}

async fn do_spend_reconcile(state: &NodeState) -> Result<String, ActionError> {
    let journal = spend_journal(state)?;
    let Some(pending) = journal.pending()? else { return Ok("No pending spend.".into()); };
    if state.node_id.lock().unwrap().as_deref() != Some(pending.node_id.as_str()) {
        return Err(spend_journal::unknown("The pending action belongs to another identity."));
    }
    let path = match &pending.target {
        Some(Target::Payment { .. }) => "/payments?limit=100".to_string(),
        Some(Target::Message { peer, .. }) => control::messages_path(peer, None, Some(200))?,
        None => return Err(spend_journal::unknown("No node-issued receipt ID was returned. Automatic reconciliation is unavailable; inspect the owner node. The app will not retry.")),
    };
    let rows: Vec<serde_json::Value> = get_json(state, &path).await?;
    match spend_journal::terminal(&pending, &rows) {
        Some(status) => {
            journal.clear()?;
            Ok(format!("Previous action {status}. Nothing was dispatched again."))
        }
        None => Err(spend_journal::unknown("No matching terminal record. Missing history does not prove failure.")),
    }
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
    if want.is_some() && budget_paused(state)? {
        return Err(ActionError::new("budget_paused", "Payments are paused. Resume them first."));
    }
    let open = |state: &NodeState, want: Want, basis: act::SpendBasis| match want {
        Want::Window => state.spend.lock().unwrap().arm(now_ms(), basis),
        Want::Budget(ceiling) => state.autopay.lock().unwrap().arm(now_ms(), ceiling, basis),
    };
    enum Mode {
        Local,
        Paired { spend: bool },
    }
    let mode = match &*state.auth.lock().unwrap() {
        AuthMode::Unauthenticated => {
            return Err(ActionError::new("not_ready", "Your node is not signed in yet."))
        }
        AuthMode::Local => Mode::Local,
        AuthMode::Paired(session) => Mode::Paired {
            spend: session.scopes.iter().any(|s| s == "spend"),
        },
    };
    match mode {
        Mode::Local => {
            if let Some(want) = want { open(state, want, act::SpendBasis::AppLock); }
        }
        Mode::Paired { spend: true } => {
            if let Some(want) = want { open(state, want, act::SpendBasis::NodeGrant); }
        }
        Mode::Paired { spend: false } => {
            let (generation, pending) = {
                let mut gate = state.spend.lock().unwrap();
                gate.view(now_ms());
                (gate.generation(), gate.pending().cloned())
            };
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
                        let mut gate = state.spend.lock().unwrap();
                        if !gate.matches_poll(generation, &pending, now_ms()) {
                            return Ok(gate.view(now_ms()));
                        }
                        let wants = std::mem::take(&mut *state.wants.lock().unwrap());
                        if !has_spend {
                            state.autopay.lock().unwrap().lock();
                            return Err(gate.refused());
                        }
                        // Open only what the owner asked for with this request.
                        if wants.window { gate.arm(now_ms(), act::SpendBasis::NodeGrant); } else { gate.clear_pending(); }
                        drop(gate);
                        if let Some(ceiling) = wants.budget {
                            state.autopay.lock().unwrap().arm(now_ms(), ceiling, act::SpendBasis::NodeGrant);
                        }
                    }
                    "expired" | "absent" => {
                        let mut gate = state.spend.lock().unwrap();
                        if gate.matches_poll(generation, &pending, now_ms()) {
                            gate.pending_expired();
                            *state.wants.lock().unwrap() = Wants::default();
                        }
                    },
                    _ => {}
                }
            } else if want.is_some() {
                let (status, body) = call_api(
                    state,
                    reqwest::Method::POST,
                    "/pair/elevation-request",
                    Some(serde_json::json!({ "scopes": ["spend"] })),
                )
                .await?;
                if !status.is_success() {
                    return Err(ActionError::node(api_error("/pair/elevation-request", status, &body)));
                }
                let reply: act::ElevationReply = decode_act("/pair/elevation-request", &body)?;
                let pending = reply.into_elevation()?;
                let mut gate = state.spend.lock().unwrap();
                if gate.generation() == generation && pending.expires_at_ms > now_ms() {
                    gate.set_pending(pending);
                }
            }
        }
    }
    Ok(state.spend.lock().unwrap().view(now_ms()))
}

async fn read_room_quote(state: &NodeState, room_id: &str) -> Result<act::RoomQuote, String> {
    let room = control::room_id(room_id)?;
    let own_id = state.node_id.lock().unwrap().clone().unwrap_or_default();
    let own_id = if own_id.is_empty() { fetch_node_id(state).await? } else { own_id };
    let members = read_room_members(state, &room).await?;
    let peers: Vec<control::Peer> = get_json(state, "/peers").await?;
    let own: control::KindPrice = get_json(state, &control::price_path(control::KIND_CHAT)).await?;
    let tables: Vec<control::PeerPrice> = get_json(state, "/pricing/peers").await?;
    Ok(act::room_quote(&room, &own_id, own.price_msat, &members, &peers, &tables))
}

/// Only an explicit versioned node contract authorizes variable-price sends.
async fn require_price_caps(state: &NodeState, room: bool) -> Result<(), ActionError> {
    let unavailable = || ActionError::new("price_cap_unavailable", "This node cannot enforce your confirmed spending ceiling. Upgrade the node before sending messages or files.");
    let status: serde_json::Value = get_json(state, "/status").await.map_err(|_| unavailable())?;
    let capabilities = status["api_capabilities"].as_array().ok_or_else(unavailable)?;
    if !capabilities.iter().any(|v| v.as_str() == Some("paid_send_caps_v1"))
        || (room && !capabilities.iter().any(|v| v.as_str() == Some("room_terminal_outcomes_v1"))) {
        return Err(unavailable());
    }
    Ok(())
}

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
    require_price_caps(state, is_room).await?;
    let mut body = act::compose_body(recipient, is_room, plaintext)?;
    body["max_total_msat"] = serde_json::json!(max_msat);
    if is_room {
        let caps = max_recipient_msat.ok_or_else(|| ActionError::new("price_changed", "Refresh the room quote before sending."))?;
        body["max_recipient_msat"] = serde_json::json!(caps);
    }
    let price = if is_room {
        let quote = read_room_quote(state, recipient).await?;
        act::room_sendable(&quote)?;
        quote.total_msat
    } else {
        let quote = read_price_quote(state, Some(recipient)).await?;
        if quote.peer_stale { quote.own_msat } else { quote.peer_msat.unwrap_or(quote.own_msat) }
            .max(act::MIN_PAYMENT_MSAT)
    };
    ceiling(price, max_msat)?;
    let recipient = body["recipient"].as_str().unwrap_or_default().to_string();
    let charge = Charge { target, room: is_room, confirm: plan.confirm };
    let text = money_post(state, auth, "/messages/compose", body, max_msat, Some(charge)).await?;
    let reply: act::SendReply = decode_act("/messages/compose", &text)?;
    Ok(act::SendReceipt {
        message_id: reply.message_id,
        recipient,
        is_room,
        delivered: reply.delivered,
        amount_msat: reply.amount_msat,
        sent_at_ms: now_ms(),
    })
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
    let body = act::pay_body(bolt11, amount_msat)?;
    ceiling(amount_msat, max_msat)?;
    let text = money_post(state, Auth::Window(generation), "/payments/pay", body, max_msat, None).await?;
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
    let body = act::keysend_body(dest_pubkey, amount_msat, memo)?;
    ceiling(amount_msat, max_msat)?;
    let text = money_post(state, Auth::Window(generation), "/payments/keysend", body, max_msat, None).await?;
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

async fn do_file_send(
    state: &NodeState,
    recipient: &str,
    filename: &str,
    mime_type: &str,
    data_b64: &str,
    max_msat: u64,
) -> Result<act::FileReceipt, ActionError> {
    let generation = approval_generation(state)?;
    no_pending_spend(state)?;
    let recipient = control::node_id(recipient).map_err(ActionError::invalid)?;
    require_price_caps(state, false).await?;
    let body = act::file_upload_body(filename, mime_type, data_b64)?;
    let filename = body["filename"].as_str().unwrap_or_default().to_string();
    let quote: control::KindPrice = get_json(state, &control::price_path(act::KIND_FILE_REF)).await?;
    ceiling(quote.price_msat.max(act::MIN_PAYMENT_MSAT), max_msat)?;
    let text = gated_post(state, "/files", body).await?;
    let upload: act::UploadReply = decode_act("/files", &text)?;
    let path = act::file_send_path(&upload.file_id)?;
    // Upload can take time; quote again immediately before the money request.
    let quote: control::KindPrice = get_json(state, &control::price_path(act::KIND_FILE_REF)).await?;
    ceiling(quote.price_msat.max(act::MIN_PAYMENT_MSAT), max_msat)?;
    let text = money_post(state, Auth::Window(generation), &path, serde_json::json!({ "recipient": recipient, "max_total_msat": max_msat }), max_msat, None).await?;
    let reply: act::SendReply = decode_act("/files/send", &text)?;
    Ok(act::FileReceipt {
        message_id: reply.message_id,
        recipient,
        filename,
        size_bytes: upload.size_bytes,
        delivered: reply.delivered,
        amount_msat: reply.amount_msat,
        sent_at_ms: now_ms(),
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
    let mut gate = state.spend.lock().unwrap();
    gate.lock();
    // The lock also ends a pending request, and with it anything it would have opened.
    *state.wants.lock().unwrap() = Wants::default();
    Ok(gate.view(now_ms()))
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

fn budget_view(state: &NodeState) -> Result<budget::BudgetView, ActionError> {
    let now = now_ms();
    let autopay = state.autopay.lock().unwrap().view(now);
    let waiting = state.wants.lock().unwrap().budget.is_some() && state.spend.lock().unwrap().view(now).pending.is_some();
    with_book(state, false, |book| Ok(budget::view(book, autopay, waiting, now)))
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
    // Polls a pending elevation too, so a budget grant lands without another tap.
    spend_advance(state.inner(), false).await?;
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
) -> Result<u64, String> {
    reject_sealed_window(&window)?;
    drop(window);
    let price: control::KindPrice = get_json(state.inner(), &control::price_path(act::KIND_FILE_REF)).await?;
    Ok(price.price_msat.max(act::MIN_PAYMENT_MSAT))
}

/// `POST /files` then `POST /files/:id/send` to one peer.
#[tauri::command(rename_all = "snake_case")]
async fn file_send(
    window: WebviewWindow<impl tauri::Runtime>,
    state: State<'_, NodeState>,
    recipient: String,
    filename: String,
    mime_type: String,
    data_b64: String,
    max_msat: u64,
) -> Result<act::FileReceipt, ActionError> {
    reject_sealed_window(&window)?;
    drop(window);
    do_file_send(state.inner(), &recipient, &filename, &mime_type, &data_b64, max_msat).await
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

/// `ai-providers.json` in the app config dir. The window cannot write it.
fn ai_provider_set(app: &AppHandle<impl tauri::Runtime>) -> (Vec<ai::ProviderView>, Vec<ai::Remote>) {
    let file = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|dir| ai::load_providers_file(&dir.join("ai-providers.json")));
    ai::providers(file.as_ref())
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
#[tauri::command(rename_all = "snake_case")]
fn ai_providers(window: WebviewWindow<impl tauri::Runtime>) -> Result<Vec<ai::ProviderView>, String> {
    reject_sealed_window(&window)?;
    Ok(ai_provider_set(window.app_handle()).0)
}

/// Prepare, never send: re-read the topic, narrow it, build the exact body,
/// and hold it for one send.
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
    let remote = ai_provider_set(window.app_handle())
        .1
        .into_iter()
        .find(|remote| remote.kind == provider)
        .ok_or("That model is off on this computer. Nothing was prepared.")?;
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
            payments_overview,
            spend_status,
            spend_request,
            spend_lock,
            spend_reconcile,
            budget_status,
            budget_approve,
            budget_set,
            budget_pause,
            budget_resume,
            message_send,
            room_quote,
            invoice_create,
            invoice_amount,
            payment_pay,
            payment_keysend,
            invite_create,
            invite_redeem,
            file_price,
            file_send,
            ai_read,
            ai_providers,
            ai_disclose,
            ai_send,
            ai_cancel
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

    struct FakeNode {
        state: NodeState,
        seen: Arc<Mutex<Vec<(String, Option<String>)>>>,
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
            assert_eq!(do_message_send(&node.state,A,false,"hi",2000,None).await.unwrap_err().code,"price_cap_unavailable");
            assert_eq!(do_message_send(&node.state,ROOM,true,"hi",3000,Some(std::collections::HashMap::from([(A.into(),2000),(C.into(),1000)]))).await.unwrap_err().code,"price_cap_unavailable");
            assert_eq!(do_file_send(&node.state,A,"a.txt","text/plain","aGk=",3000).await.unwrap_err().code,"price_cap_unavailable");
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
        assert_eq!(do_message_send(&node.state,A,false,"hi",2000, None).await.unwrap_err().code,"price_cap_unavailable");
        assert_eq!(do_file_send(&node.state,A,"a.txt","text/plain","aGk=",3000).await.unwrap_err().code,"price_cap_unavailable");
        assert!(node.posts().is_empty());
    }
    #[tokio::test]
    async fn caps_transmit_confirmed_ceiling_and_safe_refusal_clears_journal() {
        let routes: Routes = Arc::new(|m,p,b| {
            if p == "/messages/compose" { return (409, serde_json::json!({"code":"price_cap_exceeded","error":"price rose"}).to_string()); }
            happy()(m,p,b)
        });
        let node=fake(AuthMode::Local,routes);
        spend_advance(&node.state,true).await.unwrap();
        assert_eq!(do_message_send(&node.state,A,false,"hi",2000, None).await.unwrap_err().code,"price_cap_exceeded");
        assert_eq!(node.posts()[0].1["max_total_msat"],2000);
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none());
    }
    #[tokio::test]
    async fn caps_room_unknown_cannot_be_cleared_by_one_message_or_retried() {
        for member_status in ["unknown", "pending"] {
            let routes: Routes = Arc::new(move |m,p,b| {
                if p == "/messages/compose" {
                    return (200,serde_json::json!({"message_id":"ab".repeat(32),"delivered":true,"amount_msat":3000,
                        "member_outcomes":[{"recipient":A,"status":"settled","amount_msat":2000,"message_id":"ab".repeat(32)},
                            {"recipient":C,"status":member_status,"amount_msat":1000}]}).to_string());
                }
                happy()(m,p,b)
            });
            let node=fake(AuthMode::Local,routes);
            spend_advance(&node.state,true).await.unwrap();
            assert_eq!(do_message_send(&node.state,ROOM,true,"hi",3000, Some(std::collections::HashMap::from([(A.into(), 2000), (C.into(), 1000)]))).await.unwrap_err().code,"spend_unknown");
            assert!(do_spend_reconcile(&node.state).await.is_err());
            assert_eq!(do_message_send(&node.state,ROOM,true,"hi",3000, Some(std::collections::HashMap::from([(A.into(), 2000), (C.into(), 1000)]))).await.unwrap_err().code,"spend_unknown");
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
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
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
                log.lock().unwrap().push((method.clone(), target.clone(), bearer, body.clone()));
                let path = target.strip_prefix("/api/v1").unwrap_or(&target).to_string();
                let (status, reply) = routes(&method, &path, &body);
                let mut out = stream;
                let _ = write!(
                    out,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                    reply.len()
                );
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
                "/status" => serde_json::json!({"api_capabilities":["paid_send_caps_v1","room_terminal_outcomes_v1"]}),
                "/messages/compose" if serde_json::from_str::<serde_json::Value>(_body).unwrap_or_default()["is_room"] == true => serde_json::json!({"message_id":"m1","delivered":true,"amount_msat":3000,
                    "member_outcomes":[{"recipient":A,"status":"settled","amount_msat":2000,"message_id":"m1"},{"recipient":C,"status":"settled","amount_msat":1000,"message_id":"m2"}]}),
                "/messages/compose" => serde_json::json!({"message_id": "m1", "delivered": true, "amount_msat": 2000}),
                "/payments/price/200" => serde_json::json!({"kind": 200, "price_msat": 3000}),
                "/payments/pay" => serde_json::json!({"payment_hash": "HASH", "amount_msat": 1000, "preimage": "PREIMAGE"}),
                "/payments/keysend" => serde_json::json!({"payment_hash": "HASH", "amount_msat": 5000, "preimage": "PREIMAGE", "status": "Settled"}),
                "/payments/invoice" => serde_json::json!({"bolt11": "lntb210n1sample", "payment_hash": "HASH"}),
                "/invites" => serde_json::json!({"invite_id": "i1", "invite_token_b64": "tok", "invite_link": "bitsov://invite/tok"}),
                "/invites/accept" => serde_json::json!({"inviter_pubkey": A, "channel_size_hint": null, "addr": "203.0.113.5:9735"}),
                "/files" => serde_json::json!({"file_id": FILE_ID, "size_bytes": 2, "blake3_hash": "bb"}),
                r if r == format!("/files/{FILE_ID}/send") => serde_json::json!({"message_id": "f1", "delivered": false, "amount_msat": 3000}),
                r if r == format!("/rooms/{ROOM}/members") => serde_json::json!([OWN, A, C]),
                "/peers" => serde_json::json!([
                    {"node_id": A, "connected": true}, {"node_id": C, "connected": true}
                ]),
                "/payments/price/0" => serde_json::json!({"kind": 0, "price_msat": 1000}),
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
            do_message_send(s, A, false, "gm", 2000, None).await.unwrap_err().code,
            do_message_send(s, ROOM, true, "gm", 2000, Some(std::collections::HashMap::from([(A.into(), 2000), (C.into(), 1000)]))).await.unwrap_err().code,
            do_payment_pay(s, "lntb10n1x", 1000, 1000).await.unwrap_err().code,
            do_payment_keysend(s, &format!("02{}", "ab".repeat(32)), 5000, None, 5000).await.unwrap_err().code,
            do_invite_create(s, A, "203.0.113.5:9735", 24).await.unwrap_err().code,
            do_invite_redeem(s, "bitsov://invite/tok").await.unwrap_err().code,
            do_file_send(s, A, "a.txt", "text/plain", "aGk=", 3000).await.unwrap_err().code,
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

        let receipt = do_message_send(&node.state, &A.to_uppercase(), false, "gm", 2000, None).await.unwrap();
        assert_eq!((receipt.message_id.as_str(), receipt.amount_msat, receipt.delivered), ("m1", 2000, true));
        assert_eq!(receipt.recipient, A);
        assert_eq!(
            node.posts(),
            [("/messages/compose".to_string(), serde_json::json!({"recipient": A, "is_room": false, "kind": 0, "plaintext": "gm", "max_total_msat":2000}))]
        );
        let bearer = node.seen.lock().unwrap()[0].2.clone();
        assert_eq!(bearer.as_deref(), Some("tok.1"));
    }

    #[tokio::test]
    async fn an_expired_window_re_prompts_without_a_request() {
        let node = fake(AuthMode::Local, happy());
        node.state.spend.lock().unwrap().arm(now_ms() - act::SPEND_WINDOW_MS - 1, act::SpendBasis::AppLock);
        let err = do_message_send(&node.state, A, false, "gm", 2000, None).await.unwrap_err();
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
        let err = do_message_send(&node.state, A, false, "gm", 2000, None).await.unwrap_err();
        assert_eq!(err.code, "spend_refused");
        assert_eq!(node.posts().len(), 1);
        assert_eq!(do_message_send(&node.state, A, false, "gm", 2000, None).await.unwrap_err().code, "spend_locked");
        assert_eq!(node.posts().len(), 1, "no second dispatch after a refusal");
    }

    #[tokio::test]
    async fn a_node_error_is_shown_as_the_node_wrote_it() {
        let routes: Routes = Arc::new(|m: &str, p: &str, b: &str| {
            if p == "/messages/compose" { (502, r#"{"error":"failed to pay recipient invoice: no route","code":502}"#.into()) } else { happy()(m,p,b) }
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        let err = do_message_send(&node.state, A, false, "gm", 2000, None).await.unwrap_err();
        assert_eq!(err.code, "spend_unknown");
        assert!(err.message.contains("/messages/compose failed (502): failed to pay recipient invoice: no route"));
        assert_eq!(spend_advance(&node.state, false).await.unwrap().state, act::SpendState::Open, "a failed payment is not a refusal");
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
        assert_eq!((quote.total_msat, quote.estimate), (3000, true));
        assert_eq!(quote.unreachable, vec![C.to_string()]);

        spend_advance(&node.state, true).await.unwrap();
        let err = do_message_send(&node.state, ROOM, true, "gm", 2000, Some(std::collections::HashMap::from([(A.into(), 2000), (C.into(), 1000)]))).await.unwrap_err();
        assert_eq!(err.code, "room_unreachable");
        assert!(node.posts().is_empty(), "{:?}", node.posts());

        let node = fake(AuthMode::Local, happy());
        spend_advance(&node.state, true).await.unwrap();
        let receipt = do_message_send(&node.state, ROOM, true, "gm", 3000, Some(std::collections::HashMap::from([(A.into(), 2000), (C.into(), 1000)]))).await.unwrap();
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().is_none(), "all terminal member outcomes release the fence");
        assert!(receipt.is_room);
        assert_eq!(
            node.posts(),
            [("/messages/compose".to_string(), serde_json::json!({"recipient": ROOM, "is_room": true, "kind": 0, "plaintext": "gm", "max_total_msat":3000, "max_recipient_msat":{A:2000,C:1000}}))]
        );
    }

    #[tokio::test]
    async fn pay_goes_out_only_for_the_amount_shown_and_the_receipt_drops_the_preimage() {
        let node = fake(AuthMode::Local, happy());
        spend_advance(&node.state, true).await.unwrap();
        assert!(do_payment_pay(&node.state, "lntb10n1x", 2000, 2000).await.is_err());
        assert!(do_payment_pay(&node.state, "lntb1x", 0, 0).await.is_err(), "amountless");
        assert!(node.posts().is_empty());
        let receipt = do_payment_pay(&node.state, "lntb10n1x", 1000, 1000).await.unwrap();
        assert_eq!((receipt.method, receipt.status.as_str(), receipt.amount_msat), ("invoice", "settled", 1000));
        let ks = do_payment_keysend(&node.state, &format!("03{}", "cd".repeat(32)), 5000, Some("thanks"), 5000).await.unwrap();
        assert_eq!(ks.status, "settled");
        let out = serde_json::to_string(&(receipt, ks)).unwrap();
        assert!(!out.contains("PREIMAGE") && !out.contains("HASH"));
        assert_eq!(node.posts()[0], ("/payments/pay".to_string(), serde_json::json!({"bolt11": "lntb10n1x"})));
    }

    #[tokio::test]
    async fn a_file_is_uploaded_then_sent_to_one_peer() {
        let node = fake(AuthMode::Local, happy());
        spend_advance(&node.state, true).await.unwrap();
        let receipt = do_file_send(&node.state, A, "hi.txt", "text/plain", "aGk=", 3000).await.unwrap();
        assert_eq!((receipt.filename.as_str(), receipt.size_bytes, receipt.amount_msat), ("hi.txt", 2, 3000));
        assert_eq!(
            node.posts(),
            [
                ("/files".to_string(), serde_json::json!({"filename": "hi.txt", "mime_type": "text/plain", "data_b64": "aGk="})),
                (format!("/files/{FILE_ID}/send"), serde_json::json!({"recipient": A,"max_total_msat":3000})),
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
        assert_eq!(pending.owner_action, "konsensus grant --op ab12");
        assert_eq!(node.posts()[0], ("/pair/elevation-request".to_string(), serde_json::json!({"scopes": ["spend"]})));
        assert_eq!(do_message_send(&node.state, A, false, "gm", 2000, None).await.unwrap_err().code, "spend_locked");

        assert_eq!(spend_advance(&node.state, false).await.unwrap().state, act::SpendState::Pending);
        let view = spend_advance(&node.state, false).await.unwrap();
        assert_eq!((view.state, view.basis), (act::SpendState::Open, Some(act::SpendBasis::NodeGrant)));
        assert_eq!(node.state.token.lock().unwrap().as_deref(), Some("tok.spend"));

        do_message_send(&node.state, A, false, "gm", 2000, None).await.unwrap();
        let last = node.seen.lock().unwrap().last().cloned().unwrap();
        assert_eq!((last.1.as_str(), last.2.as_deref()), ("/api/v1/messages/compose", Some("tok.spend")));

        // Nothing about the grant is written to the app's pairing store.
        let store = node.state.pairing.lock().unwrap().clone().unwrap().store.clone();
        for entry in std::fs::read_dir(&store).unwrap() {
            let text = std::fs::read_to_string(entry.unwrap().path()).unwrap_or_default();
            assert!(!text.contains("spend"), "a spend grant reached disk");
        }
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
        assert_eq!(do_message_send(s, A, false, "gm", 2000, None).await.unwrap_err().code, "first_contact");
        assert!(node.targets().is_empty());
        do_message_send_with(s, A, false, "gm", 2000, None, Some(50_000)).await.unwrap();
        // After the one OK, the next message just goes.
        do_message_send(s, A, false, "again", 2000, None).await.unwrap();
        assert_eq!(composes(&node), 2);
        for (_, body) in node.posts().iter().filter(|(p, _)| p == "/messages/compose") {
            assert_eq!(body["max_total_msat"], 2000, "every send keeps the node-enforced cap");
        }
        let v = budget_now(s);
        assert_eq!((v.spent_msat, v.unsettled_msat), (4000, 0));
        assert_eq!(v.rows, [budget::Row { target: A.into(), room: false, limit_msat: Some(50_000), spent_msat: 4000 }]);
        // Pay and files still need the ten-minute window.
        assert_eq!(do_payment_pay(s, "lntb10n1x", 1000, 1000).await.unwrap_err().code, "spend_locked");
    }

    #[tokio::test]
    async fn an_exhausted_budget_is_refused_before_any_request_and_the_cap_still_rides_along() {
        let node = fake(AuthMode::Local, happy());
        let s = &node.state;
        do_budget_approve(s, 500_000, budget::PresetId::Careful).await.unwrap();
        with_book(s, true, |b| b.set_limit(A, false, 5000)).unwrap();
        do_message_send(s, A, false, "one", 2000, None).await.unwrap();
        do_message_send(s, A, false, "two", 2000, None).await.unwrap();
        let err = do_message_send(s, A, false, "three", 2000, None).await.unwrap_err();
        assert_eq!(err.code, "budget_exhausted");
        assert!(err.message.contains("used 4 of 5 sats"), "{}", err.message);
        // A cap above what is left is refused too, not trimmed.
        assert_eq!(do_message_send(s, A, false, "big", 1001, None).await.unwrap_err().code, "budget_exhausted");
        assert_eq!(composes(&node), 2);
        // An open ten-minute window does not override a contact's budget.
        spend_advance(s, true).await.unwrap();
        assert_eq!(do_message_send(s, A, false, "three", 2000, None).await.unwrap_err().code, "budget_exhausted");
        // Raising within the daily total is the owner's tap, and the send goes.
        with_book(s, true, |b| b.set_limit(A, false, 10_000)).unwrap();
        do_message_send(s, A, false, "three", 2000, None).await.unwrap();
        assert_eq!(composes(&node), 3);
    }

    #[tokio::test]
    async fn the_daily_total_caps_all_contacts_and_lowering_it_needs_no_approval() {
        let node = fake(AuthMode::Local, happy());
        let s = &node.state;
        do_budget_approve(s, 5000, budget::PresetId::Careful).await.unwrap();
        do_message_send_with(s, A, false, "a", 2000, None, Some(5000)).await.unwrap();
        do_message_send_with(s, C, false, "c", 2000, None, Some(5000)).await.unwrap();
        assert_eq!(do_message_send(s, C, false, "c", 2000, None).await.unwrap_err().code, "ceiling_exhausted");
        // Narrowing an open approval stays open, with the lower number.
        let v = do_budget_approve(s, 4000, budget::PresetId::Careful).await.unwrap();
        assert_eq!((v.autopay.state, v.autopay.ceiling_msat, v.ceiling_msat), (budget::AutopayState::Open, Some(4000), 4000));
        assert_eq!(v.rows.iter().map(|r| r.limit_msat).collect::<Vec<_>>(), [Some(4000), Some(4000)], "budgets above the total narrow with it");
    }

    #[tokio::test]
    async fn a_restart_keeps_the_tally_and_drops_the_approval() {
        let node = fake(AuthMode::Local, happy());
        do_budget_approve(&node.state, 500_000, budget::PresetId::Careful).await.unwrap();
        do_message_send_with(&node.state, A, false, "gm", 2000, None, Some(50_000)).await.unwrap();

        let after = reopen(&node);
        let v = budget_now(&after);
        assert_eq!(v.autopay.state, budget::AutopayState::Off, "the approval was never written down");
        assert_eq!((v.spent_msat, v.rows[0].limit_msat), (2000, Some(50_000)), "the numbers were");
        assert_eq!(do_message_send(&after, A, false, "gm", 2000, None).await.unwrap_err().code, "spend_locked");
        assert_eq!(composes(&node), 1);

        do_budget_approve(&after, 500_000, budget::PresetId::Careful).await.unwrap();
        do_message_send(&after, A, false, "gm", 2000, None).await.unwrap();
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
        do_message_send_with(s, A, false, "gm", 2000, None, Some(50_000)).await.unwrap();

        let v = do_budget_pause(s).unwrap();
        assert!(v.paused);
        assert_eq!(v.autopay.state, budget::AutopayState::Off);
        assert_eq!(do_message_send(s, A, false, "gm", 2000, None).await.unwrap_err().code, "budget_paused");
        assert_eq!(do_payment_pay(s, "lntb10n1x", 1000, 1000).await.unwrap_err().code, "spend_locked", "the window closed too");
        assert_eq!(spend_advance(s, true).await.unwrap_err().code, "budget_paused");
        assert_eq!(do_budget_approve(s, 500_000, budget::PresetId::Careful).await.unwrap_err().code, "budget_paused");

        let after = reopen(&node);
        assert_eq!(do_message_send(&after, A, false, "gm", 2000, None).await.unwrap_err().code, "budget_paused");
        let v = do_budget_resume(&after).await.unwrap();
        assert!(!v.paused);
        assert_eq!(v.autopay.state, budget::AutopayState::Open);
        do_message_send(&after, A, false, "gm", 2000, None).await.unwrap();
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
        assert_eq!(do_message_send_with(s, A, false, "gm", 2000, None, Some(50_000)).await.unwrap_err().code, "price_cap_exceeded");
        assert_eq!(budget_now(s).spent_msat, 0, "refused before any payment: nothing counted");
        assert_eq!(budget_now(s).rows[0].limit_msat, Some(50_000), "the owner's OK still stands");
        assert_eq!(do_message_send(s, A, false, "gm", 2000, None).await.unwrap_err().code, "spend_unknown");
        let v = budget_now(s);
        assert_eq!((v.spent_msat, v.unsettled_msat), (2000, 2000));
        assert_eq!(budget_now(&reopen(&node)).unsettled_msat, 2000, "and it survives a restart");
    }

    #[tokio::test]
    async fn a_node_refusal_ends_the_budget_approval_and_releases_the_reservation() {
        let routes: Routes = Arc::new(|m: &str, p: &str, b: &str| {
            if p == "/messages/compose" { (403, "token lacks required scope: spend".into()) } else { happy()(m, p, b) }
        });
        let node = fake(AuthMode::Local, routes);
        let s = &node.state;
        do_budget_approve(s, 500_000, budget::PresetId::Careful).await.unwrap();
        assert_eq!(do_message_send_with(s, A, false, "gm", 2000, None, Some(50_000)).await.unwrap_err().code, "spend_refused");
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
        do_message_send_with(s, A, false, "gm", 2000, None, Some(50_000)).await.unwrap();
        let last = node.seen.lock().unwrap().last().cloned().unwrap();
        assert_eq!((last.1.as_str(), last.2.as_deref()), ("/api/v1/messages/compose", Some("tok.spend")));
        assert_eq!(do_payment_pay(s, "lntb10n1x", 1000, 1000).await.unwrap_err().code, "spend_locked");
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
        assert_eq!(do_message_send(&node.state, A, false, "gm", 2000, None).await.unwrap_err().code, "spend_locked");

        *status.lock().unwrap() = "expired";
        assert_eq!(spend_advance(&node.state, false).await.unwrap().state, act::SpendState::Expired);
        assert_eq!(do_message_send(&node.state, A, false, "gm", 2000, None).await.unwrap_err().code, "spend_expired");
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
        assert_eq!(do_message_send(&node.state, A, false, "gm", 2000, None).await.unwrap_err().code, "spend_locked");
        assert!(!node.posts().iter().any(|(path, _)| path == "/messages/compose"));
    }

    #[tokio::test]
    async fn regression_receipt_above_shown_quote_is_not_success() {
        let routes: Routes = Arc::new(|m, p, b| {
            if p == "/messages/compose" {
                return (200, serde_json::json!({"message_id":"changed", "delivered":true, "amount_msat":999000}).to_string());
            }
            happy()(m, p, b)
        });
        let node = fake(AuthMode::Local, routes);
        assert_eq!(read_price_quote(&node.state, Some(A)).await.unwrap().peer_msat, Some(2000));
        spend_advance(&node.state, true).await.unwrap();
        assert_eq!(do_message_send(&node.state, A, false, "gm", 2000, None).await.unwrap_err().code, "spend_unknown");
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
        let first = do_message_send(&node.state, A, false, "gm", 2000, None).await.unwrap_err();
        let second = do_message_send(&node.state, A, false, "gm", 2000, None).await.unwrap_err();
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
        assert_eq!(do_message_send(&node.state, A, false, "gm", 2000, None).await.unwrap_err().code, "price_changed");
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
        assert_eq!(do_message_send(&node.state, A, false, "gm", 2000, None).await.unwrap_err().code, "spend_unknown");
        assert_eq!(do_message_send(&node.state, A, false, "gm", 2000, None).await.unwrap_err().code, "spend_unknown");
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
        let receipt = do_payment_keysend(&node.state, &format!("03{}", "cd".repeat(32)), 5000, None, 5000).await.unwrap();
        assert_eq!(receipt.status, "settled");
    }

    #[tokio::test]
    async fn regression_pending_payment_reconciles_by_hash_without_resend() {
        let settled = Arc::new(AtomicBool::new(false));
        let s = settled.clone();
        let hash = "ab".repeat(32);
        let routes: Routes = Arc::new(move |m,p,b| {
            if p == "/payments/keysend" {
                return (200, serde_json::json!({"payment_hash":hash, "amount_msat":5000, "status":"InFlight"}).to_string());
            }
            if p == "/payments?limit=100" {
                return (200, serde_json::json!([{"payment_hash":hash, "amount_msat":5000, "direction":"outgoing", "status":if s.load(Ordering::SeqCst) {"settled"} else {"pending"}}]).to_string());
            }
            happy()(m,p,b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        let pk = format!("03{}", "cd".repeat(32));
        assert_eq!(do_payment_keysend(&node.state, &pk, 5000, None, 5000).await.unwrap().status, "inflight");
        assert!(do_spend_reconcile(&node.state).await.is_err());
        assert_eq!(do_payment_keysend(&node.state, &pk, 5000, None, 5000).await.unwrap_err().code, "spend_unknown");
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
        assert_eq!(do_file_send(&node.state, A, "hi.txt", "text/plain", "aGk=", 3000).await.unwrap_err().code, "price_changed");
        assert_eq!(node.posts().len(), 1);
        assert_eq!(node.posts()[0].0, "/files");
    }

    #[tokio::test]
    async fn regression_payment_ceiling_and_receipt_are_both_checked() {
        let routes: Routes = Arc::new(|m,p,b| {
            if p == "/payments/pay" {
                return (200, serde_json::json!({"payment_hash":"ab".repeat(32),"amount_msat":999000,"preimage":"proof"}).to_string());
            }
            happy()(m,p,b)
        });
        let node = fake(AuthMode::Local, routes);
        spend_advance(&node.state, true).await.unwrap();
        assert_eq!(do_payment_pay(&node.state, "lntb10n1x", 1000, 999).await.unwrap_err().code, "price_changed");
        assert!(node.posts().is_empty());
        assert_eq!(do_payment_pay(&node.state, "lntb10n1x", 1000, 1000).await.unwrap_err().code, "spend_unknown");
        assert_eq!(do_payment_pay(&node.state, "lntb10n1x", 1000, 1000).await.unwrap_err().code, "spend_unknown");
        assert_eq!(node.posts().len(), 1);
        assert!(spend_journal(&node.state).unwrap().pending().unwrap().unwrap().over_budget);
    }

    #[tokio::test]
    async fn an_unauthenticated_node_cannot_be_approved() {
        let node = fake(AuthMode::Unauthenticated, happy());
        assert_eq!(spend_advance(&node.state, true).await.unwrap_err().code, "not_ready");
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
                "payments_overview",
                // Control center actions (slice B): same guard, plus the spend window.
                "spend_status",
                "spend_request",
                "spend_lock",
                "spend_reconcile",
                "budget_status",
                "budget_approve",
                "budget_set",
                "budget_pause",
                "budget_resume",
                "message_send",
                "room_quote",
                "invoice_create",
                "invoice_amount",
                "payment_pay",
                "payment_keysend",
                "invite_create",
                "invite_redeem",
                "file_price",
                "file_send",
                // AI track: main window only, reads through the broker.
                "ai_read",
                "ai_providers",
                "ai_disclose",
                "ai_send",
                "ai_cancel",
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
