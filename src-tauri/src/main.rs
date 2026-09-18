// bitsov-app — CS-1 desktop shell + CS-2 first-run fund flow.
//
// BOUNDARY (charter Gate G1): this app CONSUMES the public BitSov node API over
// loopback. It bundles the released `konsensus` node BINARY as a Tauri sidecar and
// supervises it as a subprocess. It does NOT link the `konsensus-*` crates and does
// NOT fork protocol logic. See docs/ARCHITECTURE_BOUNDARY.md and docs/API_READINESS.md.
//
// Scope: app shell -> bundle/spawn node -> loopback auth (/auth/local) -> identity
// screen -> first-run funding (onboarding/start, funding address + QR, poll to
// funding-seen, balance) and mnemonic restore. No channels, rooms, messaging,
// pricing, mobile, calls, hosted, or AI.
//
// KEYS (charter invariant A.3): the node is the identity anchor. This host never
// holds, derives, or displays key material. The loopback JWT lives in `NodeState`
// and is attached to requests here — it is never returned to the renderer, and no
// command response type carries a token, a mnemonic, or a private key.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

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

const NODE_SHUTDOWN_POLL: Duration = Duration::from_millis(250);
const NODE_SHUTDOWN_BUDGET_SECS: u32 = 30;
const NODE_SHUTDOWN_WAIT_STEPS: u32 = NODE_SHUTDOWN_BUDGET_SECS * 4;

struct NodeState {
    ready: Mutex<bool>,
    node_id: Mutex<Option<String>>,
    error: Mutex<Option<String>>,
    /// Supervised node process; killed on app exit so no orphan node is left running.
    child: Mutex<Option<CommandChild>>,
    /// The loopback JWT lives here and nowhere else (see the KEYS note above).
    token: Mutex<Option<String>>,
    /// The supervised node's `konsensus.toml`. Captured at bootstrap so a restore can
    /// restart the SAME data dir without re-running `init`.
    config: Mutex<Option<PathBuf>>,
    /// Last throttled re-mint attempt, for `REMINT_COOLDOWN`.
    last_remint: Mutex<Option<Instant>>,
    /// Set when the supervised sidecar emits `CommandEvent::Terminated`.
    sidecar_terminated: AtomicBool,
    http: reqwest::Client,
}

impl Default for NodeState {
    fn default() -> Self {
        Self {
            ready: Mutex::new(false),
            node_id: Mutex::new(None),
            error: Mutex::new(None),
            child: Mutex::new(None),
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
fn spawn_node(app: &AppHandle, config: &Path) -> Result<(), String> {
    let cmd = app
        .shell()
        .sidecar("konsensus")
        .map_err(|e| format!("cannot resolve node sidecar: {e}"))?
        .args(["start", "--config", &config.to_string_lossy()]);
    let state = app.state::<NodeState>();
    state.sidecar_terminated.store(false, Ordering::SeqCst);
    let (mut rx, child) = cmd.spawn().map_err(|e| format!("node start failed: {e}"))?;
    *state.child.lock().unwrap() = Some(child);

    // Drain node stdout/stderr to the app log (never render node plaintext in the UI).
    // Terminated is the wait_for_health fail-fast signal: do not burn 60s on a dead child.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Terminated(payload) = event {
                eprintln!("[node] terminated: {:?}", payload);
                handle
                    .state::<NodeState>()
                    .sidecar_terminated
                    .store(true, Ordering::SeqCst);
                break;
            }
        }
    });
    Ok(())
}

async fn health_ok(state: &NodeState) -> bool {
    state
        .http
        .get(format!("{API_BASE}/health"))
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
    mint_token(state).await?;
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
async fn restart_node(app: &AppHandle, expected_node_id: &str) -> Result<bool, String> {
    let state = app.state::<NodeState>();
    *state.ready.lock().unwrap() = false;
    *state.node_id.lock().unwrap() = None;
    *state.token.lock().unwrap() = None;

    let previous = state.child.lock().unwrap().take();
    if let Some(child) = previous {
        let _ = child.kill();
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
/// wait for /health, mint a loopback JWT via /auth/local, and read /identity.
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
    if let Err(e) = mint_token(&state).await {
        return set_error(&state, e);
    }
    match fetch_node_id(&state).await {
        Ok(node_id) => {
            *state.node_id.lock().unwrap() = Some(node_id);
            *state.ready.lock().unwrap() = true;
        }
        Err(e) => set_error(&state, e),
    }
}

// ---- loopback control plane ----------------------------------------------

/// POST /auth/local (loopback, no signature) -> JWT, stored in the host state.
async fn mint_token(state: &NodeState) -> Result<(), String> {
    let token = state
        .http
        .post(format!("{API_BASE}/auth/local"))
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

/// Re-mint after a 401, no more often than `REMINT_COOLDOWN`.
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
    mint_token(state).await
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
            .request(method.clone(), format!("{API_BASE}{path}"))
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

// ---- commands -------------------------------------------------------------

/// Frontend reads node state here (identity screen). Synchronous — the async
/// bootstrap task populates the state; the command just reflects it.
#[tauri::command]
fn node_status(state: State<'_, NodeState>) -> Status {
    Status {
        ready: *state.ready.lock().unwrap(),
        node_id: state.node_id.lock().unwrap().clone(),
        error: state.error.lock().unwrap().clone(),
    }
}

/// `GET /onboarding/state`. `None` means the first-run funding flow has not been
/// started yet — the node answers 404 until `/onboarding/start` has run once.
#[tauri::command(rename_all = "snake_case")]
async fn fund_state(state: State<'_, NodeState>) -> Result<Option<FundState>, String> {
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
    state: State<'_, NodeState>,
    funding_amount_sats: u32,
) -> Result<FundState, String> {
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
async fn funding_address(state: State<'_, NodeState>) -> Result<FundingAddress, String> {
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
async fn payments_balance(state: State<'_, NodeState>) -> Result<Balance, String> {
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
    app: AppHandle,
    state: State<'_, NodeState>,
    mnemonic: String,
) -> Result<RestoreOutcome, String> {
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

/// What a stop attempt actually did. Returned so the policy can be asserted in
/// tests rather than inferred from source text (app #16 review, finding 3).
#[derive(Debug, PartialEq, Eq)]
enum StopOutcome {
    /// The child was already reaped — nothing was signalled.
    AlreadyExited,
    /// The pid is no longer ours (exited and reused). Nothing was signalled.
    NotOwned,
    /// SIGTERM was sent and the process exited within the budget.
    TermedAndExited,
    /// SIGTERM was sent, the budget elapsed, SIGKILL was the fallback.
    Killed,
}

/// The stop policy, with every effect injected so it can be unit-tested without
/// spawning a process or signalling anything.
///
/// Order matters and is the point of the test: never signal a pid we cannot prove
/// is still our child; SIGTERM first so the node can flush; SIGKILL only after the
/// budget elapses.
fn graceful_stop_policy(
    already_terminated: bool,
    owns_pid: &mut dyn FnMut() -> bool,
    send_term: &mut dyn FnMut(),
    is_alive: &mut dyn FnMut() -> bool,
    send_kill: &mut dyn FnMut(),
    steps: u32,
) -> StopOutcome {
    if already_terminated {
        return StopOutcome::AlreadyExited;
    }
    if !owns_pid() {
        return StopOutcome::NotOwned;
    }
    send_term();
    for _ in 0..steps {
        if !is_alive() {
            return StopOutcome::TermedAndExited;
        }
    }
    send_kill();
    StopOutcome::Killed
}

/// Is `pid` still the child THIS process spawned?
///
/// A raw pid does not prove ownership (app #16 review, finding 1): the plugin may
/// already have reaped the child, after which the OS may hand that number to an
/// unrelated process and our signal would hit a stranger. `CommandChild::kill()` is
/// safe here — it holds an `Arc<SharedChild>` synchronised against reaping — but a
/// bare `kill -TERM <pid>` is not. So we require BOTH that the pid's parent is us
/// and that its command line is the sidecar we launched.
#[cfg(unix)]
fn pid_is_our_sidecar(pid: u32) -> bool {
    let out = match std::process::Command::new("ps")
        .args(["-o", "ppid=,command=", "-p", &pid.to_string()])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return false,
    };
    let line = String::from_utf8_lossy(&out.stdout);
    let line = line.trim();
    let (ppid, command) = match line.split_once(char::is_whitespace) {
        Some((a, b)) => (a.trim(), b.trim()),
        None => return false,
    };
    ppid.parse::<u32>().ok() == Some(std::process::id()) && command.contains(SIDECAR_BIN)
}

/// Stop the node this app spawned: SIGTERM, wait, SIGKILL only as a last resort.
///
/// Only ever called with the `CommandChild` from our own `spawn_node`, and only after
/// [`pid_is_our_sidecar`] confirms the pid still belongs to us. We deliberately do NOT
/// hunt for whoever holds port 3141 — a node the app did not start belongs to someone
/// else and must survive our quit (app #16).
///
/// The graceful step is not a nicety. `CommandChild::kill()` is SIGKILL, and the node's
/// own shutdown path (konsensus-node `main.rs`, comment L0e) stops the Lightning backend
/// explicitly because "LDK queues ChannelMonitor persistence calls during shutdown; if we
/// wait for Drop ... those persistence calls can be silently lost — real-fund-loss class
/// on a live channel". The node allows itself up to 15s for that, so the SIGKILL fallback
/// sits beyond it. rc7 installs a real SIGTERM handler (`SignalKind::terminate()`).
fn stop_supervised_node(
    child: tauri_plugin_shell::process::CommandChild,
    already_terminated: bool,
) {
    let pid = child.pid();
    #[cfg(unix)]
    {
        let outcome = graceful_stop_policy(
            already_terminated,
            &mut || pid_is_our_sidecar(pid),
            &mut || {
                let _ = std::process::Command::new("kill")
                    .args(["-TERM", &pid.to_string()])
                    .status();
            },
            &mut || {
                std::thread::sleep(NODE_SHUTDOWN_POLL);
                std::process::Command::new("kill")
                    .args(["-0", &pid.to_string()])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
            },
            &mut || {},
            NODE_SHUTDOWN_WAIT_STEPS,
        );
        match outcome {
            StopOutcome::AlreadyExited | StopOutcome::TermedAndExited => return,
            StopOutcome::NotOwned => {
                eprintln!("[node] pid {pid} is no longer our sidecar — not signalling");
                return;
            }
            StopOutcome::Killed => {
                eprintln!("[node] pid {pid} ignored SIGTERM for {NODE_SHUTDOWN_BUDGET_SECS}s; sending SIGKILL");
            }
        }
    }
    // SIGKILL through the plugin handle: synchronised against reaping, so this
    // cannot land on a reused pid.
    let _ = child.kill();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(NodeState::default())
        .invoke_handler(tauri::generate_handler![
            node_status,
            fund_state,
            fund_start,
            funding_address,
            payments_balance,
            identity_restore
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(bootstrap_node(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building bitsov-app")
        .run(|app, event| {
            // Stop the supervised node on exit — no orphan node with the user's keys.
            //
            // BOTH events are required (app #16). `ExitRequested` fires when the last
            // window closes, which on macOS does NOT quit the app; Cmd-Q goes through
            // NSApplication terminate and emits `Exit`. Matching only `ExitRequested`
            // therefore never ran on macOS: every quit left a mainnet node running with
            // the user's keys loaded, still holding 3141/9735/9736. Reproduced before the
            // fix — the node's ppid went from the GUI's pid to 1 on quit.
            //
            // `take()` makes a repeated shutdown event a no-op: the second one finds None.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                let state = app.state::<NodeState>();
                let terminated = state.sidecar_terminated.load(Ordering::SeqCst);
                let child = state.child.lock().unwrap().take();
                if let Some(child) = child {
                    stop_supervised_node(child, terminated);
                }
            }
        });
}

#[cfg(test)]
mod stop_policy_tests {
    use super::*;

    /// Drives the policy with scripted liveness and records every effect.
    fn run(already: bool, owns: bool, alive_for: u32, steps: u32) -> (StopOutcome, u32, u32, u32) {
        let (mut terms, mut kills, mut polls) = (0u32, 0u32, 0u32);
        let outcome = graceful_stop_policy(
            already,
            &mut || owns,
            &mut || terms += 1,
            &mut || {
                polls += 1;
                polls <= alive_for
            },
            &mut || kills += 1,
            steps,
        );
        (outcome, terms, kills, polls)
    }

    #[test]
    fn already_reaped_child_is_never_signalled() {
        let (outcome, terms, kills, _) = run(true, true, 99, 8);
        assert_eq!(outcome, StopOutcome::AlreadyExited);
        assert_eq!(
            (terms, kills),
            (0, 0),
            "a reaped child must receive no signal"
        );
    }

    #[test]
    fn foreign_pid_is_never_signalled() {
        // The pid outlived our child and was reused: ownership check fails.
        let (outcome, terms, kills, _) = run(false, false, 99, 8);
        assert_eq!(outcome, StopOutcome::NotOwned);
        assert_eq!(
            (terms, kills),
            (0, 0),
            "never signal a pid we cannot prove is ours"
        );
    }

    #[test]
    fn sigterm_alone_suffices_when_the_node_exits() {
        let (outcome, terms, kills, _) = run(false, true, 2, 8);
        assert_eq!(outcome, StopOutcome::TermedAndExited);
        assert_eq!(terms, 1, "exactly one SIGTERM");
        assert_eq!(
            kills, 0,
            "SIGKILL must NOT be used when the node exits gracefully"
        );
    }

    #[test]
    fn sigkill_is_the_fallback_only_after_the_budget() {
        let (outcome, terms, kills, polls) = run(false, true, u32::MAX, 8);
        assert_eq!(outcome, StopOutcome::Killed);
        assert_eq!(terms, 1, "SIGTERM is still sent first");
        assert_eq!(kills, 1);
        assert_eq!(polls, 8, "the full budget is waited before escalating");
    }

    #[test]
    fn graceful_precedes_forceful() {
        // Ordering, not just presence: a SIGKILL-first implementation would exit
        // at the first poll with kills==1 and terms==0.
        let (_, terms, kills, _) = run(false, true, 1, 4);
        assert!(terms == 1 && kills == 0, "SIGTERM must precede any SIGKILL");
    }

    #[test]
    fn budget_exceeds_the_nodes_own_lightning_shutdown_window() {
        // konsensus-node allows itself 15s to flush LDK ChannelMonitor state.
        // Escalating before that would cut off the persistence it protects.
        let budget = NODE_SHUTDOWN_POLL * NODE_SHUTDOWN_WAIT_STEPS;
        assert!(
            budget >= Duration::from_secs(20),
            "SIGKILL fallback at {budget:?} is inside the node's 15s Lightning flush window"
        );
    }
}
