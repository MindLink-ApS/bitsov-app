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
// A dev-only `assistant` window can display text. It is not a model, it has no
// network, and it cannot call privileged commands (capability ACL + the
// window-label check below).
//
// KEYS (charter invariant A.3): the node is the identity anchor. This host never
// holds, derives, or displays key material. The loopback JWT lives in `NodeState`
// and is attached to requests here — it is never returned to the renderer, and no
// command response type carries a token, a mnemonic, or a private key.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
#[cfg(unix)]
use shared_child::unix::SharedChildExt;
use shared_child::SharedChild;
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Manager, RunEvent, State, WebviewWindow};
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

/// Must exceed the node's own shutdown cost: it allows up to 15s for the Lightning
/// backend alone so LDK can flush ChannelMonitor persistence.
const NODE_SHUTDOWN_BUDGET: Duration = Duration::from_secs(30);

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
}

impl Default for NodeState {
    fn default() -> Self {
        Self {
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
    for (label, pipe) in [
        ("out", child.take_stdout().map(PipeKind::Out)),
        ("err", child.take_stderr().map(PipeKind::Err)),
    ] {
        if let Some(pipe) = pipe {
            std::thread::spawn(move || {
                let reader: Box<dyn std::io::Read + Send> = match pipe {
                    PipeKind::Out(p) => Box::new(p),
                    PipeKind::Err(p) => Box::new(p),
                };
                let reader = std::io::BufReader::new(reader);
                for line in std::io::BufRead::lines(reader).map_while(Result::ok) {
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

/// The bundled assistant document only.
///
/// Linux and macOS serve it as `tauri` on host `localhost` with no port.
/// Windows serves it as http(s) on host `tauri.localhost` with the default port.
/// A localhost dev server, on any port, is rejected.
fn assistant_document_allowed(
    scheme: &str,
    host: Option<&str>,
    port: Option<u16>,
    path: &str,
) -> bool {
    if port.is_some() || path != "/assistant.html" {
        return false;
    }
    match (scheme, host) {
        ("tauri", Some("localhost")) => true,
        ("http" | "https", Some("tauri.localhost")) => true,
        _ => false,
    }
}

/// Create the assistant window on demand. Not called at startup.
fn open_assistant_window(app: &AppHandle) -> Result<(), String> {
    if !assistant_dev_enabled() {
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
    .on_navigation(|url| {
        assistant_document_allowed(url.scheme(), url.host_str(), url.port(), url.path())
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
            let _ = open_assistant_window(app);
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
            if assistant_dev_enabled() {
                install_assistant_menu(app)?;
            }
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
            // A repeated shutdown event is a no-op, and a restore in flight can neither
            // hide its old node from this nor start a new one after it (`stop_for_quit`).
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                app.state::<NodeState>().stop_for_quit(NODE_SHUTDOWN_BUDGET);
            }
        });
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
    use super::{assistant_dev_enabled_from, assistant_document_allowed, window_may_run_privileged_command};
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

    #[test]
    fn assistant_navigation_allows_only_the_bundled_page() {
        assert!(assistant_document_allowed(
            "tauri",
            Some("localhost"),
            None,
            "/assistant.html"
        ));
        assert!(assistant_document_allowed(
            "http",
            Some("tauri.localhost"),
            None,
            "/assistant.html"
        ));
        assert!(assistant_document_allowed(
            "https",
            Some("tauri.localhost"),
            None,
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            "http",
            Some("localhost"),
            Some(1420),
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            "http",
            Some("localhost"),
            None,
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            "http",
            Some("127.0.0.1"),
            Some(1420),
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            "http",
            Some("127.0.0.1"),
            None,
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            "https",
            Some("tauri.localhost"),
            Some(443),
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            "http",
            Some("tauri.localhost"),
            Some(80),
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            "tauri",
            Some("localhost"),
            None,
            "/index.html"
        ));
        assert!(!assistant_document_allowed(
            "javascript",
            None,
            None,
            "alert(1)"
        ));
        assert!(!assistant_document_allowed("data", None, None, "/assistant.html"));
        assert!(!assistant_document_allowed(
            "https",
            Some("evil.example"),
            None,
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            "http",
            Some("localhost.evil.example"),
            None,
            "/assistant.html"
        ));
        assert!(!assistant_document_allowed(
            "file",
            Some("localhost"),
            None,
            "/assistant.html"
        ));
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
        assert!(!opener.contains("enable_clipboard_access"));
        assert!(!source.contains("clipboard-manager"));
        assert!(opener.contains("NewWindowResponse::Deny"));
        assert!(!opener.contains("WebviewUrl::External"));
        assert_eq!(source.matches("open_assistant_window(").count(), 2);
        assert!(source.contains("if assistant_dev_enabled()"));

        let copy = fs::read_to_string(manifest_dir().join("../src/assistant/copy.ts")).expect("copy");
        assert!(copy.contains("clipboard.writeText"));
        assert!(!copy.contains("@tauri-apps/plugin-clipboard"));
        assert!(!copy.contains("invoke("));
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
            ])
            .build(tauri::generate_context!())
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
    }
}
