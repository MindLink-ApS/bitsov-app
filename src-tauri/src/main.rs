// bitsov-app — CS-1 desktop shell.
//
// BOUNDARY (charter Gate G1): this app CONSUMES the public BitSov node API over
// loopback. It bundles the released `konsensus` node BINARY as a Tauri sidecar and
// supervises it as a subprocess. It does NOT link the `konsensus-*` crates and does
// NOT fork protocol logic. See docs/ARCHITECTURE_BOUNDARY.md and docs/API_READINESS.md.
//
// CS-1 scope only: app shell -> bundle/spawn node -> loopback auth (/auth/local) ->
// identity screen. No funding, rooms, messaging, mobile, calls, hosted, or AI.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Node API bind — konsensus ApiConfig `default_api_addr()` = 127.0.0.1:3141.
/// Loopback ONLY (Gate G2): never point this at a non-loopback host until a
/// confidential remote transport + delegated auth exist.
const API_BASE: &str = "http://127.0.0.1:3141/api/v1";

#[derive(Default)]
struct NodeState {
    ready: Mutex<bool>,
    node_id: Mutex<Option<String>>,
    error: Mutex<Option<String>>,
    /// Supervised node process; killed on app exit so no orphan node is left running.
    child: Mutex<Option<CommandChild>>,
}

#[derive(Serialize, Clone)]
struct Status {
    ready: bool,
    node_id: Option<String>,
    error: Option<String>,
}

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

fn set_error(state: &NodeState, msg: impl Into<String>) {
    *state.error.lock().unwrap() = Some(msg.into());
}

/// rc4 workaround: `konsensus init --tier full` writes `[network].listen_addr` (P2P) and
/// `[lightning].listening_address` both on `0.0.0.0:9735`, and `konsensus start` fail-closes on
/// the collision. Move ONLY `[network].listen_addr` to `:9736` (the node's own hint) when it
/// collides with Lightning. Section-aware so it never touches `[api].listen_addr` (shares the key
/// name) or Lightning. Idempotent. Config-only workaround for the released rc4 `init`, NOT a
/// protocol fork — remove when a node release emits non-colliding defaults. See
/// docs/CS1_RUNBOOK.md and the BitSov-bitsov issue.
fn dodge_rc4_port_collision(config: &std::path::Path) {
    let Ok(text) = std::fs::read_to_string(config) else {
        return;
    };
    let port_in = |section: &str, key: &str| -> Option<String> {
        let mut in_section = false;
        for line in text.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with('[') {
                in_section = trimmed.trim_end() == section;
                continue;
            }
            if in_section {
                if let Some(rest) = trimmed.strip_prefix(key) {
                    let rest = rest.trim_start();
                    if rest.starts_with('=') {
                        let value = rest.trim_start_matches('=').trim().trim_matches('"');
                        return value.rsplit_once(':').map(|(_, port)| port.to_string());
                    }
                }
            }
        }
        None
    };
    let (Some(p2p), Some(lightning)) = (
        port_in("[network]", "listen_addr"),
        port_in("[lightning]", "listening_address"),
    ) else {
        return;
    };
    if p2p != lightning {
        return;
    }
    let mut in_network = false;
    let patched: Vec<String> = text
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if trimmed.starts_with('[') {
                in_network = trimmed.trim_end() == "[network]";
                return line.to_string();
            }
            if in_network && trimmed.starts_with("listen_addr") && line.contains(&format!(":{p2p}")) {
                return line.replacen(&format!(":{p2p}"), ":9736", 1);
            }
            line.to_string()
        })
        .collect();
    let _ = std::fs::write(config, format!("{}\n", patched.join("\n")));
}

/// Ensure a node config exists (first run), then start + supervise the node,
/// wait for /health, mint a loopback JWT via /auth/local, and read /identity.
async fn bootstrap_node(app: tauri::AppHandle) {
    let state = app.state::<NodeState>();
    let data_dir: PathBuf = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => return set_error(&state, format!("no app data dir: {e}")),
    };
    let _ = std::fs::create_dir_all(&data_dir);
    let config = data_dir.join("konsensus.toml");

    // rc4 workaround: the released node resolves SQLite migrations at runtime from
    // KONSENSUS_SQLITE_MIGRATIONS_DIR (else the build-host CARGO_MANIFEST_DIR, absent on the
    // target). Point it at the migrations bundled beside the node binary (fetched pinned to the
    // node's source-ref by fetch-node-sidecar.sh, bundled via tauri.conf resources). See
    // docs/CS1_RUNBOOK.md + the BitSov-bitsov issue; remove when a release embeds/ships migrations.
    let migrations_dir = app.path().resource_dir().ok().map(|d| d.join("migrations"));

    // First run: `konsensus init` generates identity + config (tier full = fund-your-node).
    if !config.exists() {
        match app.shell().sidecar("konsensus") {
            Ok(cmd) => {
                let mut cmd = cmd.args([
                    "init",
                    "--dir",
                    &data_dir.to_string_lossy(),
                    "--non-interactive",
                    "--tier",
                    "full",
                ]);
                if let Some(ref dir) = migrations_dir {
                    cmd = cmd.env(
                        "KONSENSUS_SQLITE_MIGRATIONS_DIR",
                        dir.to_string_lossy().to_string(),
                    );
                }
                match cmd.output().await {
                    Ok(out) if out.status.success() => {}
                    Ok(out) => {
                        let stderr = String::from_utf8_lossy(&out.stderr);
                        return set_error(
                            &state,
                            format!(
                                "node init failed (exit {:?}): {}",
                                out.status.code(),
                                stderr.trim()
                            ),
                        );
                    }
                    Err(e) => return set_error(&state, format!("node init could not run: {e}")),
                }
            }
            Err(e) => return set_error(&state, format!("cannot resolve node sidecar: {e}")),
        }
    }

    // rc4 workaround (docs/CS1_RUNBOOK.md + BitSov-bitsov issue): `konsensus init --tier full`
    // emits `[network].listen_addr` (P2P) and `[lightning].listening_address` both on
    // 0.0.0.0:9735; `konsensus start` fail-closes on it. Move only P2P to :9736 before start.
    dodge_rc4_port_collision(&config);

    // Start + supervise the node (with the migrations dir env for the released rc4 node).
    let start = match app.shell().sidecar("konsensus") {
        Ok(cmd) => {
            let mut cmd = cmd.args(["start", "--config", &config.to_string_lossy()]);
            if let Some(ref dir) = migrations_dir {
                cmd = cmd.env(
                    "KONSENSUS_SQLITE_MIGRATIONS_DIR",
                    dir.to_string_lossy().to_string(),
                );
            }
            cmd
        }
        Err(e) => return set_error(&state, format!("cannot resolve node sidecar: {e}")),
    };
    let (mut rx, child) = match start.spawn() {
        Ok(pair) => pair,
        Err(e) => return set_error(&state, format!("node start failed: {e}")),
    };
    *state.child.lock().unwrap() = Some(child);

    // Drain node stdout/stderr to the app log (never render node plaintext in the UI).
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Terminated(payload) = event {
                eprintln!("[node] terminated: {:?}", payload);
                break;
            }
        }
    });

    // Wait for the API to come up, then authenticate over loopback.
    let http = reqwest::Client::new();
    for _ in 0..60 {
        if http
            .get(format!("{API_BASE}/health"))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
        {
            match authenticate_and_identify(&http).await {
                Ok(node_id) => {
                    *state.node_id.lock().unwrap() = Some(node_id);
                    *state.ready.lock().unwrap() = true;
                    return;
                }
                Err(e) => return set_error(&state, e),
            }
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
    set_error(&state, "node did not become healthy within 60s");
}

/// POST /auth/local (loopback, no signature) -> JWT; GET /identity -> node_id.
async fn authenticate_and_identify(http: &reqwest::Client) -> Result<String, String> {
    let token = http
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

    let node_id = http
        .get(format!("{API_BASE}/identity"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("identity request failed: {e}"))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("identity decode failed: {e}"))?
        .get("node_id")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .ok_or_else(|| "identity returned no node_id".to_string())?;

    Ok(node_id)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(NodeState::default())
        .invoke_handler(tauri::generate_handler![node_status])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(bootstrap_node(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building bitsov-app")
        .run(|app, event| {
            // Kill the supervised node on exit — no orphan node with the user's keys.
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(child) = app.state::<NodeState>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
