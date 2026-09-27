// bitsov-app — CS-1 desktop shell + CS-2 first-run fund flow.
//
// BOUNDARY (charter Gate G1): this app CONSUMES the public BitSov node API over
// loopback. It bundles the released `konsensus` node BINARY as a Tauri sidecar and
// supervises it as a subprocess. It does NOT link the `konsensus-*` crates and does
// NOT fork protocol logic. See docs/ARCHITECTURE_BOUNDARY.md and docs/API_READINESS.md.
//
// Scope: app shell -> bundle/spawn node -> loopback auth -> identity
// screen -> first-run funding (onboarding/start, funding address + QR, poll to
// funding-seen, balance) and mnemonic restore. No channels, rooms, messaging,
// pricing, mobile, calls, hosted, or AI.
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
use tauri::{AppHandle, Manager, RunEvent, State, WebviewWindow};
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
            ready: Mutex::new(false),
            node_id: Mutex::new(None),
            error: Mutex::new(None),
            child: Mutex::new(None),
            quitting: AtomicBool::new(false),
            token: Mutex::new(None),
            config: Mutex::new(None),
            last_remint: Mutex::new(None),
            sidecar_terminated: AtomicBool::new(false),
            // Bounded so a hung loopback /health or /auth/local cannot pin restoring().
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(5))
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

/// F1's auth state as the assistant feed sees it. Only a paired token is
/// handed over; the rc7 `/auth/local` token never is.
#[cfg_attr(not(all(debug_assertions, feature = "sit-mock")), allow(dead_code))]
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
        .invoke_handler(tauri::generate_handler![
            node_status,
            fund_state,
            fund_start,
            funding_address,
            payments_balance,
            identity_restore,
            pairing_status,
            pairing_retry
        ])
        .setup(|app| {
            if assistant_dev_enabled() || assistant_node_enabled() {
                install_assistant_menu(app)?;
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(bootstrap_node(handle));
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

        let err = authenticate(&f.state, f.data_dir.path()).await.err().expect("refused");
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
            .filter_map(|(index, part)| (index % 2 == 1).then(|| part.to_string()))
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
            ]
        );
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
            vite.contains("TAURI_ENV_DEBUG") && vite.contains("assistant.html"),
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
}
