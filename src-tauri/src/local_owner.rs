//! Gated local first-run ceremony. Credentials remain in the host; only the
//! one-shot recovery phrase response crosses IPC to the dedicated screen.
use super::*;
use zeroize::Zeroizing;

#[cfg(all(test, unix, feature = "local-owner-ceremony"))]
#[path = "local_owner/process_tests.rs"]
mod process_tests;

#[cfg(all(test, unix, feature = "local-owner-ceremony"))]
#[path = "local_owner/config_tests.rs"]
mod config_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    pub(super) fn mock(
        replies: Vec<(&'static str, u16, String)>,
    ) -> (NodeState, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let state = NodeState::for_api(&format!(
            "http://127.0.0.1:{}/api/v1",
            listener.local_addr().unwrap().port()
        ));
        state.owner.active.store(true, Ordering::SeqCst);
        *state.auth.lock().unwrap() = AuthMode::Paired(PairedSession {
            client_id: "client".into(),
            scopes: vec!["identity".into()],
            token: "test".into(),
            expires_at: i64::MAX,
        });
        *state.token.lock().unwrap() = Some("test".into());
        let thread = std::thread::spawn(move || {
            for (path, status, body) in replies {
                let (mut stream, _) = listener.accept().unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut chunk = [0; 4096];
                    let n = stream.read(&mut chunk).unwrap();
                    if n == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..n]);
                    if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let len = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|v| v.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + len {
                            break;
                        }
                    }
                }
                let request = String::from_utf8_lossy(&bytes);
                assert!(
                    request.starts_with(path),
                    "unexpected route: {}",
                    request.lines().next().unwrap()
                );
                if path.starts_with("POST /api/v1/identity/finalize") {
                    let body: serde_json::Value =
                        serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
                    assert_eq!(body.as_object().unwrap().len(), 3);
                    assert_eq!(
                        body["backup_words"],
                        serde_json::json!(["abandon", "above", "abuse"])
                    );
                    assert!(body.get("password").is_none());
                    assert!(body.get("mnemonic").is_none());
                    assert_eq!(body["device"]["proof"], "mock-der-proof");
                }
                write!(stream, "HTTP/1.1 {status} Reply\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (state, thread)
    }
    fn open(pending: bool) -> String {
        serde_json::json!({"state":"bootstrap", "local_owner":{"available":true,"enroll_device":true,"pending":pending}}).to_string()
    }
    fn phrase() -> String {
        serde_json::json!({"ceremony_id":"a".repeat(32), "node_id":"b".repeat(64), "mnemonic":"abandon ability able about above absent absorb abstract absurd abuse access accident", "backup_check":[0,4,9], "expires_at":9999999999i64}).to_string()
    }
    #[test]
    fn bundled_rc9_requires_both_build_and_runtime_opt_in() {
        for debug in [false, true] {
            for dev in [false, true] {
                assert!(gate(true, true, dev, debug));
                assert!(!gate(false, true, dev, debug));
                assert!(!gate(true, false, dev, debug));
            }
        }
    }
    #[tokio::test]
    async fn orphan_is_cancelled_before_a_new_phrase_and_only_metadata_is_retained() {
        let (state, server) = mock(vec![
            ("GET /api/v1/bootstrap/state", 200, open(true)),
            (
                "DELETE /api/v1/identity/pending/current",
                204,
                String::new(),
            ),
            ("POST /api/v1/identity/create-pending", 200, phrase()),
        ]);
        let reply = create(&state).await.unwrap();
        assert!(reply.mnemonic.starts_with("abandon"));
        assert!(
            !serde_json::to_string(&*state.owner.pending.lock().unwrap())
                .unwrap()
                .contains("abandon")
        );
        server.join().unwrap();
    }
    #[tokio::test]
    async fn cancel_refusal_keeps_metadata_and_does_not_echo_arbitrary_secrets() {
        let (state, server) = mock(vec![(
            "DELETE /api/v1/identity/pending/current",
            409,
            r#"{"error":"abandon password-secret","reason":"ceremony_in_progress"}"#.into(),
        )]);
        *state.owner.pending.lock().unwrap() = Some(Metadata {
            ceremony_id: "a".repeat(32),
            node_id: "b".repeat(64),
            submitted: false,
        });
        let err = cancel(&state, None).await.unwrap_err();
        assert!(err.contains("ceremony_in_progress"));
        assert!(!err.contains("abandon"));
        assert!(!err.contains("password-secret"));
        assert!(state.owner.pending.lock().unwrap().is_some());
        server.join().unwrap();
    }
    #[tokio::test]
    async fn a_late_cancel_is_bound_to_its_original_ceremony() {
        let (state, server) = mock(vec![(
            "DELETE /api/v1/identity/pending/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            410,
            "ceremony_lost".into(),
        )]);
        *state.owner.pending.lock().unwrap() = Some(Metadata {
            ceremony_id: "b".repeat(32),
            node_id: "c".repeat(64),
            submitted: false,
        });
        assert!(cancel(&state, Some(&"a".repeat(32)))
            .await
            .unwrap_err()
            .contains("ceremony_lost"));
        assert_eq!(
            state
                .owner
                .pending
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .ceremony_id,
            "b".repeat(32)
        );
        server.join().unwrap();
        assert!(cancel(&state, Some("../finalize"))
            .await
            .unwrap_err()
            .contains("Invalid ceremony id"));
    }

    #[tokio::test]
    async fn off_and_remote_make_no_requests() {
        let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
        assert!(create(&state).await.unwrap_err().contains("disabled"));
        state.owner.active.store(true, Ordering::SeqCst);
        state.remote_mode.store(true, Ordering::SeqCst);
        assert!(cancel(&state, None).await.unwrap_err().contains("This Mac"));
    }
}

// Deliberate release lock. Update only together with the verified sidecar pin.
pub const BUNDLED_NODE_SUPPORTS_LOCAL_OWNER: bool = true;
// Update only together with a verified sidecar pin that supports init --network.
pub const BUNDLED_NODE_SUPPORTS_INIT_NETWORK: bool = false;
fn gate(build: bool, runtime: bool, dev_sidecar: bool, debug: bool) -> bool {
    build && runtime && (BUNDLED_NODE_SUPPORTS_LOCAL_OWNER || (debug && dev_sidecar))
}
pub fn enabled(dev_sidecar: bool) -> bool {
    cfg!(target_os = "macos")
        && gate(
            cfg!(feature = "local-owner-ceremony"),
            std::env::var("BITSOV_LOCAL_OWNER_CEREMONY").as_deref() == Ok("1"),
            dev_sidecar,
            cfg!(debug_assertions),
        )
}
#[derive(Default)]
pub struct OwnerState {
    pub active: AtomicBool,
    pub warning: Mutex<Option<String>>,
    operation: tokio::sync::Mutex<()>,
    pending: Mutex<Option<Metadata>>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Metadata {
    ceremony_id: String,
    node_id: String,
    submitted: bool,
}
#[derive(Serialize, Deserialize)]
pub struct Pending {
    ceremony_id: String,
    node_id: String,
    mnemonic: Zeroizing<String>,
    backup_check: [usize; 3],
    expires_at: i64,
}
impl std::fmt::Debug for Pending {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Pending { redacted }")
    }
}
#[derive(Deserialize)]
struct Bootstrap {
    state: String,
    local_owner: Availability,
}
#[derive(Deserialize)]
struct Availability {
    available: bool,
    enroll_device: bool,
    pending: bool,
}

fn guard(state: &NodeState) -> Result<(), String> {
    if !state.owner.active.load(Ordering::SeqCst) {
        return Err("Local owner setup is disabled for this build or node.".into());
    }
    if state.remote_mode.load(Ordering::SeqCst) || state.external_node.lock().unwrap().is_some() {
        return Err("Local owner setup is only available for the app-run node on This Mac.".into());
    }
    Ok(())
}
fn refusal(status: reqwest::StatusCode, text: &str) -> String {
    // Only known, non-secret codes are displayed. Never echo an arbitrary node
    // body: a faulty node could include a phrase/password in a parser error.
    let json: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
    let reason = json
        .get("reason")
        .or_else(|| json.get("error"))
        .and_then(|v| v.as_str())
        .unwrap_or(text.trim());
    let code = match reason {
        "ceremony_in_progress"
        | "ceremony_client_mismatch"
        | "ceremony_expired"
        | "ceremony_lost"
        | "password_unavailable"
        | "backup_check_failed"
        | "bad_device_proof"
        | "identity_generation_failed" => reason,
        _ => "node_refused",
    };
    format!("Local owner setup refused (HTTP {}, {code}). No completion is confirmed. Check the node or cancel this attempt before starting again.", status.as_u16())
}
async fn request(
    state: &NodeState,
    method: reqwest::Method,
    path: &str,
    body: Option<&str>,
) -> Result<Zeroizing<Vec<u8>>, String> {
    guard(state)?;
    ensure_fresh_token(state).await;
    let token = state
        .token
        .lock()
        .unwrap()
        .clone()
        .ok_or("Pair this app before owner setup.")?;
    let mut request = state
        .http
        .request(method, format!("{}{path}", state.api_base))
        .bearer_auth(token)
        .timeout(Duration::from_secs(30));
    if let Some(body) = body {
        request = request
            .header("Content-Type", "application/json")
            .body(body.to_owned());
    }
    // Never automatically retry a mutating request, including on authentication failure.
    let mut response = request.send().await.map_err(|_| {
        "The node response was lost. Setup outcome is unknown; check the node before retrying."
            .to_string()
    })?;
    let status = response.status();
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        "The node response was lost. Setup outcome is unknown; check the node before retrying."
    })? {
        if bytes.len() + chunk.len() > 8192 {
            return Err(
                "The node returned an invalid setup response. Check the node before retrying."
                    .into(),
            );
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        return Err(refusal(status, std::str::from_utf8(&bytes).unwrap_or("")));
    }
    Ok(bytes)
}
async fn bootstrap(state: &NodeState) -> Result<Bootstrap, String> {
    let bytes = request(state, reqwest::Method::GET, "/bootstrap/state", None).await?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "The node returned an invalid bootstrap state.".into())
}
fn metadata(reply: &Pending) -> Result<Metadata, String> {
    let hex = |s: &str, len| s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit());
    let words = reply.mnemonic.split_whitespace().count();
    if !hex(&reply.ceremony_id, 32)
        || !hex(&reply.node_id, 64)
        || ![12, 24].contains(&words)
        || reply.backup_check.iter().any(|i| *i >= words)
        || reply.backup_check[0] == reply.backup_check[1]
        || reply.backup_check[0] == reply.backup_check[2]
        || reply.backup_check[1] == reply.backup_check[2]
    {
        return Err(
            "The node returned an invalid ceremony. Cancel this attempt and start again.".into(),
        );
    }
    Ok(Metadata {
        ceremony_id: reply.ceremony_id.clone(),
        node_id: reply.node_id.clone(),
        submitted: false,
    })
}
pub async fn create(state: &NodeState) -> Result<Pending, String> {
    guard(state)?;
    let _operation = state.owner.operation.lock().await;
    let state_reply = bootstrap(state).await?;
    if state_reply.state != "bootstrap"
        || !state_reply.local_owner.available
        || !state_reply.local_owner.enroll_device
    {
        return Err("This node is not accepting local owner setup. Nothing was created.".into());
    }
    if state_reply.local_owner.pending {
        request(
            state,
            reqwest::Method::DELETE,
            "/identity/pending/current",
            None,
        )
        .await?;
    }
    *state.owner.pending.lock().unwrap() = None;
    let bytes = request(
        state,
        reqwest::Method::POST,
        "/identity/create-pending",
        None,
    )
    .await?;
    let reply: Pending = serde_json::from_slice(&bytes).map_err(|_| {
        "The create response was unreadable. Start again to discard its pending phrase."
    })?;
    *state.owner.pending.lock().unwrap() = Some(metadata(&reply)?);
    Ok(reply)
}
pub async fn cancel(state: &NodeState, ceremony_id: Option<&str>) -> Result<(), String> {
    guard(state)?;
    let _operation = state.owner.operation.lock().await;
    let id = ceremony_id.unwrap_or("current");
    if id != "current" && (id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit())) {
        return Err("Invalid ceremony id; cancellation was not sent.".into());
    }
    request(
        state,
        reqwest::Method::DELETE,
        &format!("/identity/pending/{id}"),
        None,
    )
    .await?;
    let mut pending = state.owner.pending.lock().unwrap();
    if id == "current" || pending.as_ref().is_some_and(|p| p.ceremony_id == id) {
        *pending = None;
    }
    Ok(())
}
fn fingerprint(node_id: &str) -> String {
    let hash = blake3::keyed_hash(
        blake3::hash(b"bitsov-identity-fingerprint-v1").as_bytes(),
        node_id.as_bytes(),
    );
    hex::encode(&hash.as_bytes()[..16])
}
fn key_id(public: &str) -> Result<String, String> {
    let bytes = hex::decode(public).map_err(|_| "Invalid device public key")?;
    if bytes.len() != 65 || bytes[0] != 4 {
        return Err("Invalid device public key".into());
    }
    Ok(hex::encode(&blake3::hash(&bytes).as_bytes()[..16]))
}

pub async fn finalize(
    app: &AppHandle<impl tauri::Runtime>,
    state: &NodeState,
    words: [Zeroizing<String>; 3],
) -> Result<(), String> {
    guard(state)?;
    let _operation = state.owner.operation.lock().await;
    let mut pending = state
        .owner
        .pending
        .lock()
        .unwrap()
        .clone()
        .ok_or("The phrase is no longer available. Cancel and create a new identity.")?;
    if pending.submitted {
        return Err("A finalize was already sent. Check the node before retrying.".into());
    }
    let client_id = match &*state.auth.lock().unwrap() {
        AuthMode::Paired(session) if session.scopes.iter().any(|s| s == "identity") => {
            session.client_id.clone()
        }
        _ => return Err("A bootstrap pairing with identity authority is required.".into()),
    };
    if !device_available(state) {
        return Err("Touch ID is unavailable. Cancel setup or enable Touch ID on this Mac; no identity was committed.".into());
    }
    let store = device_store(state).map_err(|e| e.message)?;
    let (blob, mut record) = match local_key(state, &store).map_err(|e| e.message)? {
        Some(key) => key,
        None => {
            let policy = *state.device_policy.lock().unwrap();
            let (blob, public) = tokio::task::spawn_blocking(move || device_key::create(policy))
                .await
                .map_err(|_| "Creating the device key stopped unexpectedly.")?
                .map_err(|e| device_error(e).message)?;
            let record = device::Record {
                public_key: hex::encode(public),
                ..Default::default()
            };
            {
                let _guard = state.device_lifecycle.lock().unwrap();
                device::save_blob(&store, &blob).map_err(|e| e.message)?;
                device::save_record(&store, &record).map_err(|e| e.message)?;
            }
            (device_signing_key(&store, &record, blob).map_err(|e| e.message)?, record)
        }
    };
    let proof = device_sign(
        blob,
        device::registration_message(
            &fingerprint(&pending.node_id),
            &client_id,
            &record.public_key,
        ),
        "set up this Mac as the owner device for your new BitSov identity".into(),
    )
    .await
    .map_err(|e| e.message)?;
    record.key_id = Some(key_id(&record.public_key)?);
    record.registered = false;
    record.pending = None;
    {
        let _guard = state.device_lifecycle.lock().unwrap();
        device::save_record(&store, &record).map_err(|e| e.message)?;
    }
    // Bind the #237 launcher password to the committed node identity before
    // finalize. The new item is device-only and protected by current biometry.
    let config = state.config.lock().unwrap().clone().ok_or("The sidecar config is unavailable.")?;
    let dir = config.parent().ok_or("The sidecar directory is unavailable.")?.to_path_buf();
    let node = pending.node_id.clone();
    // Best effort: a Mac without Touch ID (or an unsigned build) must still be
    // able to finish the owner ceremony. It just can't remote-unlock a home node
    // until the item is saved; the legacy-item migration retries later.
    let saved = tokio::task::spawn_blocking(move || {
        let password = owner_password::load(&dir, false)?;
        home_keychain::save_password(&node, &password)
    }).await;
    if !matches!(saved, Ok(Ok(()))) {
        eprintln!("[local-owner] biometric unlock password not saved; remote unlock stays unavailable on this Mac");
    }
    submit(state, &store, &mut pending, &record, &proof, &words).await?;
    drop(words);
    restart_and_verify(app, state, &pending.node_id).await
}

async fn submit(
    state: &NodeState,
    store: &Path,
    pending: &mut Metadata,
    record: &device::Record,
    proof: &str,
    words: &[Zeroizing<String>; 3],
) -> Result<(), String> {
    // All durable data here is public. This receipt survives a lost reply/app exit.
    pending.submitted = true;
    device::write_private(
        &store.join("local-owner-attempt.json"),
        serde_json::to_string(&*pending).unwrap().as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    std::fs::File::open(store)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| "Could not durably save this Mac's setup record; finalize was not sent.")?;
    *state.owner.pending.lock().unwrap() = Some(pending.clone());
    #[derive(Serialize)]
    struct Device<'a> {
        public_key: &'a str,
        name: &'a str,
        proof: &'a str,
    }
    #[derive(Serialize)]
    struct Body<'a> {
        ceremony_id: &'a str,
        backup_words: &'a [Zeroizing<String>; 3],
        device: Device<'a>,
    }
    let body = Zeroizing::new(
        serde_json::to_string(&Body {
            ceremony_id: &pending.ceremony_id,
            backup_words: words,
            device: Device {
                public_key: &record.public_key,
                name: "BitSov app on this Mac",
                proof: &proof,
            },
        })
        .map_err(|_| "Could not encode backup confirmation")?,
    );
    let response = request(
        state,
        reqwest::Method::POST,
        "/identity/finalize",
        Some(&body),
    )
    .await?;
    drop(body);
    #[derive(Deserialize)]
    struct Reply {
        node_id: String,
        restart_required: bool,
        device_key_id: Option<String>,
    }
    let reply: Reply = serde_json::from_slice(&response)
        .map_err(|_| "Finalize returned an invalid response. Check the node before retrying.")?;
    if reply.node_id != pending.node_id
        || !reply.restart_required
        || reply.device_key_id != record.key_id
    {
        return Err(
            "Finalize returned a different identity or device. Check the node before retrying."
                .into(),
        );
    }
    Ok(())
}

pub async fn reconcile(
    app: &AppHandle<impl tauri::Runtime>,
    state: &NodeState,
) -> Result<(), String> {
    guard(state)?;
    let _operation = state.owner.operation.lock().await;
    if bootstrap(state).await.is_ok_and(|b| b.state == "bootstrap") {
        return Err("The node has not committed this identity. Cancel this attempt and create a new phrase.".into());
    }
    let store = device_store(state).map_err(|e| e.message)?;
    let pending = state
        .owner
        .pending
        .lock()
        .unwrap()
        .clone()
        .or_else(|| {
            device::read_private(&store.join("local-owner-attempt.json"))
                .ok()
                .flatten()
                .and_then(|b| serde_json::from_slice::<Metadata>(&b).ok())
        })
        .ok_or("No submitted owner setup is known. Reopen the app to check the node.")?;
    if !pending.submitted {
        return Err("No backup confirmation was submitted. Cancel this attempt.".into());
    }
    restart_and_verify(app, state, &pending.node_id).await
}
async fn restart_and_verify(
    app: &AppHandle<impl tauri::Runtime>,
    state: &NodeState,
    expected: &str,
) -> Result<(), String> {
    // Own only our child; do not use restore's legacy listener-adoption/kill path.
    *state.ready.lock().unwrap() = false;
    *state.token.lock().unwrap() = None;
    let config = state
        .config
        .lock()
        .unwrap()
        .clone()
        .ok_or("The sidecar config is unavailable.")?;
    state.stop_for_restart(NODE_SHUTDOWN_BUDGET);
    spawn_node(app, &config)?;
    wait_for_health(state).await?;
    reauthenticate(state).await?;
    if bootstrap(state).await.is_ok_and(|b| b.state == "bootstrap") {
        return Err("The node did not commit an identity. Cancel and start a new ceremony.".into());
    }
    if fetch_node_id(state).await? != expected {
        return Err(
            "The running identity does not match the ceremony. Owner setup is not confirmed."
                .into(),
        );
    }
    if let Err(error) = verify_device(state).await {
        *state.owner.warning.lock().unwrap() = Some(error.clone());
        return Err(error);
    }
    // Like finish_auth: a Mac without Touch ID (or an unsigned build) can't save
    // the biometric unlock item. The ceremony is already committed, so warn and
    // go live; only remote unlock of a home node stays unavailable.
    let warning = home_unlock::migrate_local_password(state, expected).await.err();
    *state.owner.warning.lock().unwrap() = warning;
    mark_live(state, expected);
    Ok(())
}
fn mark_live(state: &NodeState, expected: &str) {
    let mut view = state.pairing_view.lock().unwrap();
    view.bootstrap = None;
    if let AuthMode::Paired(session) = &*state.auth.lock().unwrap() {
        view.scopes = session.scopes.clone();
    }
    *state.node_id.lock().unwrap() = Some(expected.into());
    *state.ready.lock().unwrap() = true;
    *state.error.lock().unwrap() = None;
    *state.owner.pending.lock().unwrap() = None;
}
pub async fn verify_device(state: &NodeState) -> Result<(), String> {
    let store = device_store(state).map_err(|e| e.message)?;
    let (_, mut record) = local_key(state, &store).map_err(|e| e.message)?.ok_or("Owner device not enrolled on this Mac. Enroll through the owner console; setup cannot reopen on an initialized node.")?;
    let binding = device_binding(state).await.map_err(|e| e.message)?;
    let id = key_id(&record.public_key)?;
    if binding.device_approvals.as_deref() != Some("enabled")
        || !binding.device_keys.iter().any(|k| k.key_id == id)
    {
        return Err("Owner device not enrolled or approvals disabled. This Mac has only the authority reported by the node. Enroll through the owner console; the recovery phrase cannot be shown again.".into());
    }
    let _guard = state.device_lifecycle.lock().unwrap();
    if device::load_record(&store).as_ref() != Some(&record) {
        return Err(
            "This Mac's device key changed while checking enrollment. Check the node again.".into(),
        );
    }
    record.key_id = Some(id);
    record.registered = true;
    record.pending = None;
    device::save_record(&store, &record).map_err(|e| e.message)?;
    Ok(())
}

pub fn start_args(config: &Path, dev: bool, owner: bool) -> Vec<std::ffi::OsString> {
    let mut args = node_start_args(config, dev && !owner);
    if owner {
        args.extend([
            "--password-fd".into(),
            "0".into(),
            "--local-owner-device".into(),
        ]);
    }
    args
}
/// Retained plaintext identities need ordinary startup so the node can report
/// marker/price refusals. They are never enrolled or encrypted by a pin bump.
/// Fresh bootstrap and encrypted restarts keep the Keychain/descriptor path.
pub fn launch_enabled(enabled: bool, config: &Path) -> Result<bool, String> {
    if !enabled || !config.try_exists().map_err(|_| "Cannot inspect the node config")? {
        return Ok(enabled);
    }
    let text = std::fs::read_to_string(config).map_err(|_| "Cannot read the node config")?;
    let value: toml::Value = toml::from_str(&text).map_err(|_| "Cannot parse the node config")?;
    let mnemonic = value.get("identity").and_then(|v| v.get("mnemonic_file"))
        .and_then(|v| v.as_str()).ok_or("Node config has no identity mnemonic path")?;
    let path = Path::new(mnemonic);
    // Retained configs may name a seed relative to their own directory. Checking
    // the app's cwd would mistake an existing plaintext identity for a fresh one.
    let path = if path.is_relative() {
        config.parent().ok_or("node config directory is unknown")?.join(path)
    } else {
        path.to_path_buf()
    };
    if path.extension().is_some_and(|ext| ext == "enc") {
        return Ok(true);
    }
    Ok(!path.try_exists().map_err(|_| "Cannot inspect the existing identity")?)
}

/// Prepare owner startup while the directory is still observably fresh.
pub fn prepare_launch(
    config: &Path,
    load: impl FnOnce(&Path, bool) -> Result<Zeroizing<Vec<u8>>, String>,
) -> Result<Zeroizing<Vec<u8>>, String> {
    prepare_launch_for_network(config, "bitcoin", load)
}

pub fn prepare_launch_for_network(
    config: &Path,
    network: &str,
    load: impl FnOnce(&Path, bool) -> Result<Zeroizing<Vec<u8>>, String>,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let dir = config.parent().ok_or("node data directory is unknown")?;
    let fresh = may_create_password(dir)?;
    // Save/read Keychain first: writing config makes this an existing installation.
    let password = load(dir, fresh)?;
    if !config
        .try_exists()
        .map_err(|_| "Cannot inspect the node config")?
    {
        if !fresh {
            return Err("The existing node directory has no config. Restore its config before starting; owner setup will not replace existing node state.".into());
        }
        let write = if network == "bitcoin" { write_bootstrap_config(config) }
            else { write_bootstrap_config_for_network(config, network) };
        write.map_err(|_| {
            "Could not durably write the bootstrap config; the node was not started."
        })?;
    }
    Ok(password)
}

/// #237 has no config-only CLI. Match prepare_start's default_for_tier(Full),
/// relying on node serde defaults except where the constructor differs. No seed,
/// marker, database or identity directory is created. Keep in sync with the node
/// when promoting the gated sidecar pin (see docs/LOCAL_OWNER_CEREMONY.md).
/// Mirrors rc24 init defaults, with a 10-minute call limit for the app budget.
fn write_bootstrap_config(config: &Path) -> Result<(), Box<dyn std::error::Error>> {
    write_bootstrap_config_for_network(config, "bitcoin")
}

pub(super) fn write_bootstrap_config_for_network(config: &Path, network: &str) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::Write;
    let (esplora, fallback, chain, chain_fallback) = match network {
        "bitcoin" => ("https://blockstream.info/api", "https://mempool.space/api", "https://blockstream.info", "https://mempool.space"),
        "signet" => ("https://mempool.space/signet/api", "https://blockstream.info/signet/api", "https://mempool.space/signet", "https://blockstream.info/signet"),
        _ => return Err("An explicit supported network is required for local setup.".into()),
    };
    let dir = std::fs::canonicalize(config.parent().ok_or("missing config directory")?)?;
    let value = serde_json::json!({
        "tier": "full",
        "setup_page": {"port": 8080},
        "identity": {"mnemonic_file": dir.join("identity/mnemonic.txt")},
        "network": {"listen_addr": "0.0.0.0:9736", "tier": "T2"},
        "lightning": {
            "backend": "ldk", "network": network,
            "max_channel_capacity_sats": 1_000_000,
            "max_total_channel_capacity_sats": 2_000_000,
            "esplora_url": esplora,
            "esplora_url_fallback": fallback,
            "listening_address": "0.0.0.0:9735"
        },
        "chain": {
            "backend": "esplora", "api_url": chain,
            "esplora_url_fallback": chain_fallback
        },
        "payment_gate": {"verify_lightning_settlement": true},
        "storage": {"backend": "sqlite", "path": dir.join("konsensus.db")},
        "backup": {"scb_dir": dir.join("backups")},
        "api": {"audit_log_path": dir.join("audit.jsonl"), "operator_probes_enabled": false},
        // rc24 init defaults; cap call duration to the app budget.
        "pricing": {"call_block_msat": 10_000},
        "calls": {"max_call_minutes": 10},
        "pairing": {"second_device_claim_v1": true, "second_device_enrollment": false},
        "starter": {"enabled": false, "allow_mainnet": false, "hub_node_id": ""},
        "starter_hub": {
            "enabled": false, "allow_mainnet": false,
            "capacity_sats": 100_000, "push_sats": 10_000,
            "lifetime_budget_sats": 2_000_000, "max_opens_per_day": 20,
            "max_concurrent_opens": 4, "max_funding_fee_sats": 2_000,
            "funding_priority": "economy"
        }
    });
    let text = toml::to_string_pretty(&value)?;
    let mut tmp = tempfile::NamedTempFile::new_in(&dir)?;
    tmp.write_all(text.as_bytes())?;
    tmp.as_file().sync_all()?;
    tmp.persist_noclobber(config)?;
    std::fs::File::open(&dir)?.sync_all()?;
    Ok(())
}

pub fn may_create_password(dir: &Path) -> Result<bool, String> {
    // Only an empty node directory is eligible for a NEW password. The app's
    // pairing directory is not node state. The node still makes the authoritative
    // emptiness decision; the app never adopts/removes interrupted staging.
    let entries = std::fs::read_dir(dir)
        .map_err(|_| "Cannot inspect the node directory before Keychain setup.")?;
    for entry in entries {
        let entry =
            entry.map_err(|_| "Cannot inspect the node directory before Keychain setup.")?;
        if entry.file_name() != PAIRING_STORE_DIR {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    #[test]
    fn retained_plaintext_skips_owner_password_but_fresh_and_encrypted_keep_it() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("konsensus.toml");
        assert!(launch_enabled(true, &config).unwrap());
        assert!(!launch_enabled(false, &config).unwrap());
        let seed = dir.path().join("mnemonic.txt");
        std::fs::write(&seed, "retained-identity").unwrap();
        let original = format!("[identity]\nmnemonic_file = {:?}\n", seed);
        std::fs::write(&config, &original).unwrap();
        assert!(!launch_enabled(true, &config).unwrap());
        std::fs::write(dir.path().join("NODE_INITIALIZED"), "marker").unwrap();
        assert!(!launch_enabled(true, &config).unwrap());
        assert_eq!(std::fs::read_to_string(&config).unwrap(), original);
        assert_eq!(std::fs::read_to_string(&seed).unwrap(), "retained-identity");
        // An encrypted installation must never fall back to passwordless startup,
        // even if its encrypted seed or Keychain password is missing.
        std::fs::write(&config, format!("[identity]\nmnemonic_file = {:?}\n", dir.path().join("identity/mnemonic.enc"))).unwrap();
        assert!(launch_enabled(true, &config).unwrap());
        std::fs::write(&config, "invalid config").unwrap();
        assert!(launch_enabled(true, &config).is_err());
        assert!(!launch_enabled(false, &config).unwrap());
    }
    #[test]
    fn fresh_owner_launch_persists_only_config_after_password() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("quoted \" node");
        std::fs::create_dir(&dir).unwrap();
        let dir = std::fs::canonicalize(dir).unwrap();
        let config = dir.join("konsensus.toml");
        prepare_launch(&config, |_, fresh| {
            assert!(fresh);
            assert!(!config.exists(), "password must be durable before config");
            Ok(Zeroizing::new(b"test-password".to_vec()))
        })
        .unwrap();
        let text = std::fs::read_to_string(&config).expect("bootstrap config must exist");
        let value: toml::Value = toml::from_str(&text).unwrap();
        assert_eq!(value["tier"].as_str(), Some("full"));
        assert_eq!(
            value["identity"]["mnemonic_file"].as_str(),
            dir.join("identity/mnemonic.txt").to_str()
        );
        assert_eq!(value["lightning"]["backend"].as_str(), Some("ldk"));
        assert_eq!(value["network"]["tier"].as_str(), Some("T2"));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        prepare_launch(&config, |_, fresh| {
            assert!(!fresh);
            Ok(Zeroizing::new(b"test-password".to_vec()))
        })
        .unwrap();
        assert_eq!(std::fs::read_to_string(&config).unwrap(), text);
    }
    #[test]
    fn password_failure_and_nonempty_directory_never_get_bootstrap_config() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("konsensus.toml");
        assert!(prepare_launch(&config, |_, _| Err("Keychain unavailable".into())).is_err());
        assert!(!config.exists());
        std::fs::create_dir(dir.path().join("identity")).unwrap();
        assert!(prepare_launch(&config, |_, fresh| {
            assert!(!fresh);
            Ok(Zeroizing::new(vec![1]))
        })
        .is_err());
        assert!(!config.exists());
    }
    #[tokio::test]
    async fn legacy_device_mutations_cannot_replace_the_first_run_key() {
        let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
        state.owner.active.store(true, Ordering::SeqCst);
        state.pairing_view.lock().unwrap().bootstrap = Some("bootstrap".into());
        assert_eq!(
            do_device_key_register(&state).await.unwrap_err().code,
            "local_owner_ceremony"
        );
        assert_eq!(
            do_device_key_cancel(&state).await.unwrap_err().code,
            "local_owner_ceremony"
        );
        state.remote_mode.store(true, Ordering::SeqCst);
        assert!(allow_legacy_device_change(&state).is_ok());
    }
    #[test]
    fn verified_live_identity_replaces_stale_bootstrap_view_and_scopes() {
        let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
        state.pairing_view.lock().unwrap().bootstrap = Some("bootstrap".into());
        state.pairing_view.lock().unwrap().scopes = vec!["identity".into()];
        *state.auth.lock().unwrap() = AuthMode::Paired(PairedSession {
            client_id: "client".into(),
            scopes: vec!["read".into(), "receive".into()],
            token: "test".into(),
            expires_at: i64::MAX,
        });
        mark_live(&state, "expected");
        assert!(state.pairing_view.lock().unwrap().bootstrap.is_none());
        assert_eq!(
            state.pairing_view.lock().unwrap().scopes,
            ["read", "receive"]
        );
        assert!(state.status_snapshot().ready);
        assert_eq!(state.status_snapshot().node_id.as_deref(), Some("expected"));
    }
    #[test]
    fn password_creation_needs_positive_empty_directory_and_args_never_have_a_secret() {
        let dir = tempfile::tempdir().unwrap();
        assert!(may_create_password(dir.path()).unwrap());
        std::fs::create_dir(dir.path().join(PAIRING_STORE_DIR)).unwrap();
        assert!(may_create_password(dir.path()).unwrap());
        for name in [
            "konsensus.toml",
            "identity",
            "NODE_INITIALIZED",
            ".init-interrupted",
            "wallet.db",
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, b"existing").unwrap();
            assert!(!may_create_password(dir.path()).unwrap());
            std::fs::remove_file(path).unwrap();
        }
        let config = Path::new("/tmp/node/konsensus.toml");
        assert_eq!(
            start_args(config, false, false),
            node_start_args(config, false)
        );
        assert_eq!(
            start_args(config, true, false),
            node_start_args(config, true)
        );
        let args = start_args(config, true, true);
        assert_eq!(
            args,
            [
                "start",
                "--config",
                "/tmp/node/konsensus.toml",
                "--password-fd",
                "0",
                "--local-owner-device"
            ]
            .map(std::ffi::OsString::from)
        );
    }
    #[tokio::test]
    async fn finalize_success_and_refusals_keep_only_a_public_durable_receipt() {
        for (status, response, expected_error) in [
            (200, serde_json::json!({"node_id":"b".repeat(64),"restart_required":true,"device_key_id":"key"}).to_string(), None),
            (400, "backup_check_failed".into(), Some("backup_check_failed")),
            (403, "bad_device_proof".into(), Some("bad_device_proof")),
            (410, "ceremony_lost".into(), Some("ceremony_lost")),
            (410, "ceremony_expired".into(), Some("ceremony_expired")),
            (409, "ceremony_in_progress".into(), Some("ceremony_in_progress")),
            (200, "truncated".into(), Some("invalid response")),
        ] {
            let (state, server) = tests::mock(vec![("POST /api/v1/identity/finalize", status, response)]);
            let dir = tempfile::tempdir().unwrap();
            let mut pending = Metadata { ceremony_id:"a".repeat(32), node_id:"b".repeat(64), submitted:false };
            let record = device::Record { public_key:"04".into(), key_id:Some("key".into()), ..Default::default() };
            let words = ["abandon", "above", "abuse"].map(|s| Zeroizing::new(s.to_string()));
            let result = submit(&state, dir.path(), &mut pending, &record, "mock-der-proof", &words).await;
            if let Some(error) = expected_error { assert!(result.unwrap_err().contains(error)); } else { result.unwrap(); }
            let receipt = std::fs::read_to_string(dir.path().join("local-owner-attempt.json")).unwrap();
            for secret in ["abandon", "above", "abuse", "mnemonic", "password", "mock-der-proof"] { assert!(!receipt.contains(secret)); }
            assert!(state.owner.pending.lock().unwrap().as_ref().unwrap().submitted);
            server.join().unwrap();
        }
    }
    #[tokio::test]
    async fn lost_finalize_cannot_be_silently_replayed() {
        let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
        state.owner.active.store(true, Ordering::SeqCst);
        *state.token.lock().unwrap() = Some("test".into());
        let dir = tempfile::tempdir().unwrap();
        let mut pending = Metadata {
            ceremony_id: "a".repeat(32),
            node_id: "b".repeat(64),
            submitted: false,
        };
        let record = device::Record::default();
        let words = ["abandon", "above", "abuse"].map(|s| Zeroizing::new(s.to_string()));
        let error = submit(
            &state,
            dir.path(),
            &mut pending,
            &record,
            "mock-der-proof",
            &words,
        )
        .await
        .unwrap_err();
        assert!(error.contains("outcome is unknown"));
        assert!(
            state
                .owner
                .pending
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .submitted
        );
        assert!(dir.path().join("local-owner-attempt.json").exists());
    }
}

/// Legacy registration must not replace the key being bound by first-run setup.
pub fn allow_legacy_device_change(state: &NodeState) -> Result<(), ActionError> {
    if state.owner.active.load(Ordering::SeqCst)
        && !state.remote_mode.load(Ordering::SeqCst)
        && state.pairing_view.lock().unwrap().bootstrap.is_some()
    {
        return Err(ActionError::new(
            "local_owner_ceremony",
            "Use the local owner setup to manage this Mac's first device key.",
        ));
    }
    Ok(())
}
