use super::*;
use std::os::unix::fs::PermissionsExt;

const BETA: &str = "tech.mindlink.bitsov.beta";

fn fixture(text: &str) -> (tauri::App<tauri::test::MockRuntime>, tempfile::TempDir, PathBuf, PathBuf) {
    fixture_for_identifier(text, BETA)
}

fn fixture_for_identifier(text: &str, identifier: &str) -> (tauri::App<tauri::test::MockRuntime>, tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let node = dir.path().join("node");
    std::fs::create_dir(&node).unwrap();
    let config = node.join("konsensus.toml");
    std::fs::write(&config, text).unwrap();
    let program = dir.path().join("stand-in");
    std::fs::write(&program, "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$0.calls\"\n").unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut state = NodeState::for_identifier(identifier);
    state.api_base = "http://localhost:1/api/v1".into();
    *state.test_sidecar.lock().unwrap() = Some(program.clone());
    let app = tauri::test::mock_builder().manage(state)
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    (app, dir, config, program.with_extension("calls"))
}

fn digest(config: &Path) -> Vec<u8> {
    ring::digest::digest(&ring::digest::SHA256, &std::fs::read(config).unwrap()).as_ref().to_vec()
}

fn assert_refused(text: &str, refusal: &str) {
    let (app, _dir, config, calls) = fixture(text);
    let before = digest(&config);
    let result = spawn_node(app.handle(), &config);
    assert!(result.is_err(), "the config must be refused before a child starts");
    let status = serde_json::to_value(app.state::<NodeState>().status_snapshot()).unwrap();
    assert_eq!(status["network_refusal"], refusal);
    assert!(!calls.exists());
    assert_eq!(digest(&config), before);
    assert_eq!(std::fs::read_dir(config.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn beta_refuses_config_without_network_key() {
    assert_refused("[lightning]\nbackend = 'ldk'\n", "unknown");
}

#[test]
fn beta_refuses_mainnet_config_before_spawn() {
    assert_refused("[lightning]\nbackend = 'ldk'\nnetwork = 'bitcoin'\n", "mainnet");
}

#[test]
fn beta_refuses_allow_mainnet_flag() {
    assert_refused("[lightning]\nbackend = 'ldk'\nnetwork = 'signet'\n[node]\nallow_mainnet = true\n", "mainnet");
}

#[tokio::test]
async fn beta_init_without_network_flag_support_offers_no_local_setup() {
    let (app, _dir, config, calls) = fixture("");
    std::fs::remove_file(&config).unwrap();
    let data_dir = config.parent().unwrap();
    let state = app.state::<NodeState>();
    start_local_node(app.handle(), data_dir, data_dir, None, false).await;
    let status = serde_json::to_value(state.status_snapshot()).unwrap();
    assert_eq!(status["network_refusal"], "local_unavailable");
    assert!(!status["local_setup_needed"].as_bool().unwrap());
    assert!(init_node(app.handle(), data_dir, None).await.is_err());
    assert!(node_setup_local_at(app.handle(), &state, data_dir, true).await.is_err());
    assert!(!calls.exists());
    assert_eq!(std::fs::read_dir(data_dir).unwrap().count(), 0);
}

#[test]
fn beta_refuses_other_or_garbage_network() {
    for network in ["'testnet'", "'regtest'", "'SIGNET'", "''", "42", "'garbage'"] {
        let refusal = if network == "42" || network == "''" { "unknown" } else { "other" };
        assert_refused(&format!("[lightning]\nbackend = 'ldk'\nnetwork = {network}\n"), refusal);
    }
    assert_refused("[lightning]\nbackend = 'lnd'\nnetwork = 'signet'\n", "unknown");
    assert_refused("[lightning", "unknown");
    let (app, _dir, config, calls) = fixture("");
    std::fs::remove_file(&config).unwrap();
    assert!(spawn_node(app.handle(), &config).is_err());
    assert!(!calls.exists());
    assert_eq!(serde_json::to_value(app.state::<NodeState>().status_snapshot()).unwrap()["network_refusal"], "unknown");
}

#[tokio::test]
async fn beta_refusal_also_guards_restart_and_attach() {
    let (app, dir, config, calls) = fixture("[lightning]\nbackend='ldk'\nnetwork='bitcoin'\n");
    let before = digest(&config);
    let state = app.state::<NodeState>();
    assert!(start_after_repair(app.handle(), &state, &config).await.is_err());
    assert!(!calls.exists());
    assert_eq!(digest(&config), before);
    attach_external(app.handle(), dir.path(), dev_node::ExternalNode {
        data_dir: config.parent().unwrap().to_path_buf(), config: config.clone(),
    }).await;
    assert_eq!(serde_json::to_value(state.status_snapshot()).unwrap()["network_refusal"], "mainnet");
    assert!(state.pairing.lock().unwrap().is_none());
    assert!(!dir.path().join("external-node").exists());
    assert_eq!(digest(&config), before);
}

#[test]
fn beta_never_writes_node_files() {
    for text in ["[lightning]\nbackend='ldk'\n", "[lightning]\nbackend='ldk'\nnetwork='bitcoin'\n",
        "[lightning]\nbackend='ldk'\nnetwork='signet'\n[node]\nallow_mainnet=true\n",
        "[lightning]\nbackend='ldk'\nnetwork='regtest'\n", "[lightning"] {
        let (app, _dir, config, calls) = fixture(text);
        let before = digest(&config);
        let node_dir = config.parent().unwrap();
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o400)).unwrap();
        std::fs::set_permissions(node_dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        assert!(spawn_node(app.handle(), &config).is_err());
        assert_eq!(digest(&config), before);
        assert!(!calls.exists());
        assert_eq!(std::fs::read_dir(node_dir).unwrap().count(), 1);
        assert_eq!(std::fs::metadata(&config).unwrap().permissions().mode() & 0o777, 0o400);
        assert_eq!(std::fs::metadata(node_dir).unwrap().permissions().mode() & 0o777, 0o500);
        std::fs::set_permissions(node_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
}

pub(super) struct StatusServer {
    addr: std::net::SocketAddr,
    stopped: Arc<AtomicBool>,
}

impl Drop for StatusServer {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = std::net::TcpStream::connect(self.addr);
    }
}

fn auth_fixture(network: Option<serde_json::Value>) -> (NodeState, tempfile::TempDir, StatusServer) {
    auth_fixture_with_options(network, mock_node::pairing::PairRoutes::Live, None)
}

type Pause = (Arc<AtomicBool>, Arc<tokio::sync::Notify>);

fn auth_fixture_with_options(network: Option<serde_json::Value>, routes: mock_node::pairing::PairRoutes, pause: Option<Pause>) -> (NodeState, tempfile::TempDir, StatusServer) {
    auth_fixture_controlled(network, routes, pause, Arc::new(ReportControl::default()))
}

#[derive(Clone)]
pub(super) struct ReportReply {
    pub network: Option<serde_json::Value>,
    pub status: u16,
    pub raw: Option<String>,
}

impl ReportReply {
    pub fn network(network: Option<&str>) -> Self {
        Self { network: network.map(serde_json::Value::from), status: 200, raw: None }
    }
}

#[derive(Default)]
pub(super) struct ReportControl {
    pub reply: Mutex<Option<ReportReply>>,
    pub queue: Mutex<std::collections::VecDeque<ReportReply>>,
    pub calls: Mutex<std::collections::BTreeMap<String, usize>>,
    pub probe_401: AtomicBool,
    pub require_latest: AtomicBool,
    pub fail_identity: AtomicBool,
    pub pause: Mutex<Option<Arc<ReportPause>>>,
}

impl ReportControl {
    pub fn count(&self, path: &str) -> usize {
        *self.calls.lock().unwrap().get(path).unwrap_or(&0)
    }
}

#[derive(Default)]
pub(super) struct ReportPause {
    pub arrived: tokio::sync::Notify,
    released: Mutex<bool>,
    wake: std::sync::Condvar,
}

impl ReportPause {
    pub fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.wake.notify_one();
    }

    fn wait(&self) {
        self.arrived.notify_one();
        let (released, timeout) = self.wake.wait_timeout_while(
            self.released.lock().unwrap(), Duration::from_secs(5), |released| !*released,
        ).unwrap();
        assert!(*released && !timeout.timed_out(), "report barrier was not released");
    }
}

pub(super) fn auth_fixture_controlled(network: Option<serde_json::Value>, routes: mock_node::pairing::PairRoutes, pause: Option<Pause>, control: Arc<ReportControl>) -> (NodeState, tempfile::TempDir, StatusServer) {
    auth_fixture_controlled_for_identifier(BETA, network, routes, pause, control)
}

pub(super) fn auth_fixture_controlled_for_identifier(identifier: &str, network: Option<serde_json::Value>, routes: mock_node::pairing::PairRoutes, pause: Option<Pause>, control: Arc<ReportControl>) -> (NodeState, tempfile::TempDir, StatusServer) {
    auth_fixture_controlled_for_state(NodeState::for_identifier(identifier), network, routes, pause, control)
}

pub(super) fn auth_fixture_controlled_for_state(state: NodeState, network: Option<serde_json::Value>, routes: mock_node::pairing::PairRoutes, pause: Option<Pause>, control: Arc<ReportControl>) -> (NodeState, tempfile::TempDir, StatusServer) {
    use std::io::{BufRead, Read, Write};
    let dir = tempfile::tempdir().unwrap();
    let node = test_support::mock(dir.path(), routes, now_unix());
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let addr = listener.local_addr().unwrap();
    assert_ne!(addr.port(), 3141);
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let mut state = state;
    state.api_base = format!("http://localhost:{}/api/v1", addr.port());
    *state.external_node.lock().unwrap() = Some(dir.path().to_path_buf());
    let codes = state.printed_codes.clone();
    std::thread::spawn(move || {
        let mut forwarded = 0;
        let mut latest_issued = None;
        for stream in listener.incoming() {
            if stop.load(Ordering::SeqCst) { break; }
            let mut reader = std::io::BufReader::new(stream.unwrap());
            reader.get_mut().set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let parts: Vec<_> = line.split_whitespace().map(str::to_owned).collect();
            if parts.len() < 2 { continue; }
            let (mut length, mut auth) = (0, None);
            loop {
                line.clear(); reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() { break; }
                let (name, value) = line.split_once(':').unwrap();
                if name.eq_ignore_ascii_case("content-length") { length = value.trim().parse().unwrap(); }
                if name.eq_ignore_ascii_case("authorization") { auth = value.trim().strip_prefix("Bearer ").map(str::to_owned); }
            }
            let mut body = vec![0; length]; reader.read_exact(&mut body).unwrap();
            if parts[1].starts_with("/api/v1/pair/challenge") {
                if let Some((hold, arrived)) = &pause {
                    if hold.load(Ordering::SeqCst) {
                        arrived.notify_one();
                        let deadline = Instant::now() + Duration::from_secs(5);
                        while hold.load(Ordering::SeqCst) && Instant::now() < deadline {
                            std::thread::sleep(Duration::from_millis(1));
                        }
                    }
                }
            }
            let path = parts[1].split('?').next().unwrap().trim_start_matches("/api/v1");
            *control.calls.lock().unwrap().entry(path.to_owned()).or_default() += 1;
            let (status, mut body) = if path == "/status" {
                let reply = control.queue.lock().unwrap().pop_front()
                    .or_else(|| control.reply.lock().unwrap().clone())
                    .unwrap_or(ReportReply { network: network.clone(), status: 200, raw: None });
                let mut status = serde_json::json!({"status":"ok", "node_id":mock_node::NODE_ID, "lightning_backend":"ldk"});
                if let Some(network) = &reply.network { status["network"] = network.clone(); }
                let barrier = control.pause.lock().unwrap().take();
                if let Some(barrier) = barrier { barrier.wait(); }
                let code = if control.require_latest.load(Ordering::SeqCst) && auth != latest_issued { 401 } else { reply.status };
                (code, reply.raw.unwrap_or_else(|| status.to_string()))
            } else if path == "/renewal-probe" {
                if control.probe_401.swap(false, Ordering::SeqCst) || auth.is_none() {
                    (401, "{}".into())
                } else { (200, "{}".into()) }
            } else if path == "/identity" && control.fail_identity.load(Ordering::SeqCst) {
                (503, r#"{"error":"unavailable"}"#.into())
            } else if parts[1] == "/api/v1/health" { (200, "{}".into()) }
            else { node.handle(&parts[0], &parts[1], auth.as_deref(), &body) };
            if matches!(path, "/pair/token" | "/auth/local") && status == 200 {
                latest_issued = serde_json::from_str::<serde_json::Value>(&body).ok()
                    .and_then(|value| value.get("token").and_then(|token| token.as_str()).map(str::to_owned));
            }
            if parts[1] == "/api/v1/bootstrap/state" && status == 200 {
                if let Some(network) = &network {
                    let mut value: serde_json::Value = serde_json::from_str(&body).unwrap();
                    value["network"] = network.clone();
                    body = value.to_string();
                }
            }
            let lines = node.stdout_lines();
            for line in lines.iter().skip(forwarded) { codes.record_line(line); }
            forwarded = lines.len();
            write!(reader.get_mut(), "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
    });
    (state, dir, StatusServer { addr, stopped })
}

#[tokio::test]
async fn beta_auth_refuses_non_signet_status() {
    for network in [Some("bitcoin"), Some("mainnet"), Some("testnet"), Some("regtest"), None, Some("SIGNET"), Some("garbage")] {
        let (state, dir, _server) = auth_fixture(network.map(serde_json::Value::from));
        *state.configured_network.lock().unwrap() = Some("signet".into());
        finish_auth(&state, dir.path()).await;
        assert!(!state.status_snapshot().ready, "{network:?}");
        assert!(state.token.lock().unwrap().is_none(), "{network:?}");
        assert!(matches!(*state.auth.lock().unwrap(), AuthMode::Unauthenticated));
        assert_eq!(state.pairing_snapshot().state, "failed");
    }
}

#[tokio::test]
async fn beta_auth_signet_status_ready() {
    let (state, dir, _server) = auth_fixture(Some("signet".into()));
    finish_auth(&state, dir.path()).await;
    assert!(state.status_snapshot().ready, "{:?}", state.status_snapshot().error);
    assert!(state.token.lock().unwrap().is_some());
    assert!(matches!(*state.auth.lock().unwrap(), AuthMode::Paired(_)));
}

#[tokio::test]
async fn beta_local_path_requires_verified_local_node() {
    let (state, dir, _server) = auth_fixture(Some("signet".into()));
    *state.external_node.lock().unwrap() = None;
    finish_auth(&state, dir.path()).await;
    assert!(!state.status_snapshot().ready);
    assert!(state.pairing.lock().unwrap().is_none(), "no pairing context or request before local provenance");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn beta_signet_config_spawns() {
    assert_spawns(BETA, "signet");
}

#[test]
fn product_profile_mainnet_config_unchanged_behaviour() {
    assert_spawns("tech.mindlink.bitsov", "bitcoin");
}

fn assert_spawns(identifier: &str, network: &str) {
    let (app, _dir, config, calls) = fixture_for_identifier(
        &format!("[lightning]\nbackend='ldk'\nnetwork='{network}'\n"), identifier);
    let before = digest(&config);
    spawn_node(app.handle(), &config).unwrap();
    let state = app.state::<NodeState>();
    let child = state.child.lock().unwrap().clone().unwrap();
    child.wait().unwrap();
    let args = std::fs::read_to_string(&calls).unwrap();
    assert_eq!(args.lines().filter(|arg| *arg == "start").count(), 1);
    assert_eq!(serde_json::to_value(state.status_snapshot()).unwrap()["network_refusal"], "none");
    assert_eq!(digest(&config), before);
}

#[tokio::test]
async fn beta_init_passes_network_signet_when_supported() {
    let (app, _dir, config, calls) = fixture("");
    std::fs::remove_file(&config).unwrap();
    let state = app.state::<NodeState>();
    *state.test_init_network_support.lock().unwrap() = Some(true);
    init_node(app.handle(), config.parent().unwrap(), None).await.unwrap();
    let args = std::fs::read_to_string(&calls).unwrap();
    assert_eq!(args.lines().collect::<Vec<_>>(), ["init", "--dir", config.parent().unwrap().to_str().unwrap(), "--non-interactive", "--tier", "full", "--network", "signet"]);
    local_owner::write_bootstrap_config_for_network(&config, "signet").unwrap();
    let value: toml::Value = toml::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
    assert_eq!(value["lightning"]["network"].as_str(), Some("signet"));
    assert_eq!(value["lightning"]["esplora_url"].as_str(), Some("https://mempool.space/signet/api"));
    assert_eq!(value["lightning"]["esplora_url_fallback"].as_str(), Some("https://blockstream.info/signet/api"));
    assert_eq!(value["chain"]["api_url"].as_str(), Some("https://mempool.space/signet"));
    assert_eq!(value["chain"]["esplora_url_fallback"].as_str(), Some("https://blockstream.info/signet"));
}

#[tokio::test]
async fn product_init_args_unchanged() {
    let (app, _dir, config, calls) = fixture_for_identifier("", "tech.mindlink.bitsov");
    std::fs::remove_file(&config).unwrap();
    init_node(app.handle(), config.parent().unwrap(), None).await.unwrap();
    let args = std::fs::read_to_string(&calls).unwrap();
    assert_eq!(args.lines().collect::<Vec<_>>(), ["init", "--dir", config.parent().unwrap().to_str().unwrap(), "--non-interactive", "--tier", "full"]);
}

#[test]
fn beta_identifier_exact_match() {
    for identifier in [BETA, "tech.mindlink.bitsov.remotetest"] {
        let profile = crate::profile::AppProfile::for_identifier(identifier);
        assert!(profile.signet_only());
        assert_eq!(profile.keychain_service("service"), format!("{identifier}.service"));
    }
    for identifier in ["tech.mindlink.bitsov", "tech.mindlink.bitsov.beta.extra", "tech.mindlink.bitsov.betax", "TECH.MINDLINK.BITSOV.BETA"] {
        let profile = crate::profile::AppProfile::for_identifier(identifier);
        assert!(!profile.signet_only());
        assert_eq!(profile.keychain_service("service"), "service");
    }
}

#[test]
fn product_bootstrap_config_byte_identical() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("konsensus.toml");
    local_owner::write_bootstrap_config_for_network(&config, "bitcoin").unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let expected = include_str!("bootstrap-product.toml").replace("NODE_DIRECTORY", root.to_str().unwrap());
    assert_eq!(std::fs::read_to_string(config).unwrap(), expected);
}

#[test]
fn bootstrap_requires_an_explicit_supported_network() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("konsensus.toml");
    for network in ["", "unknown", "SIGNET"] {
        assert!(local_owner::write_bootstrap_config_for_network(&config, network).is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}

#[test]
fn beta_refuses_unreadable_config() {
    let (app, _dir, config, calls) = fixture("[lightning]\nbackend='ldk'\nnetwork='signet'\n");
    let before = digest(&config);
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o000)).unwrap();
    let result = spawn_node(app.handle(), &config);
    assert_eq!(std::fs::metadata(&config).unwrap().permissions().mode() & 0o777, 0o000);
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(result.is_err());
    assert!(!calls.exists());
    assert_eq!(digest(&config), before);
}

#[tokio::test]
async fn beta_bootstrap_refuses_unverified_network_before_identity_setup() {
    for network in [None, Some("bitcoin"), Some("SIGNET"), Some("regtest")] {
        let (state, dir, _server) = auth_fixture_with_options(network.map(serde_json::Value::from), mock_node::pairing::PairRoutes::Bootstrap, None);
        finish_auth(&state, dir.path()).await;
        assert!(!state.status_snapshot().ready);
        assert!(state.token.lock().unwrap().is_none(), "{network:?}");
        assert!(matches!(*state.auth.lock().unwrap(), AuthMode::Unauthenticated));
        assert_eq!(state.pairing_snapshot().state, "failed");
    }
}

#[tokio::test]
async fn beta_bootstrap_signet_can_reach_setup_without_live_readiness() {
    let (state, dir, _server) = auth_fixture_with_options(Some("signet".into()), mock_node::pairing::PairRoutes::Bootstrap, None);
    finish_auth(&state, dir.path()).await;
    assert!(!state.status_snapshot().ready);
    assert!(state.token.lock().unwrap().is_some());
    assert_eq!(state.pairing_snapshot().bootstrap.as_deref(), Some("bootstrap"));
    assert_eq!(state.pairing_snapshot().state, "paired");
}

#[tokio::test]
async fn beta_restart_adoption_requires_reported_signet() {
    for network in [None, Some("bitcoin"), Some("regtest"), Some("signet")] {
        let (state, dir, _server) = auth_fixture(network.map(serde_json::Value::from));
        authenticate(&state, dir.path()).await.unwrap();
        let result = adopt_matching_identity(&state, mock_node::NODE_ID).await;
        if network == Some("signet") { assert_eq!(result.unwrap(), true); }
        else {
            assert!(!matches!(result, Ok(true)), "{network:?}");
            assert!(!state.status_snapshot().ready);
            assert!(state.token.lock().unwrap().is_none());
        }
    }
}

#[tokio::test]
async fn beta_network_refusal_fences_a_buffered_refresh() {
    let hold = Arc::new(AtomicBool::new(false));
    let arrived = Arc::new(tokio::sync::Notify::new());
    let (state, dir, _server) = auth_fixture_with_options(Some("signet".into()), mock_node::pairing::PairRoutes::Live, Some((hold.clone(), arrived.clone())));
    finish_auth(&state, dir.path()).await;
    assert!(state.status_snapshot().ready);
    hold.store(true, Ordering::SeqCst);
    let refresh = refresh_paired(&state);
    tokio::pin!(refresh);
    tokio::select! {
        _ = arrived.notified() => {},
        result = &mut refresh => panic!("refresh ended before the held reply: {result:?}"),
        _ = tokio::time::sleep(Duration::from_secs(5)) => panic!("refresh did not reach the server"),
    }
    state.refuse_network(crate::network_policy::NetworkRefusal::Mainnet);
    hold.store(false, Ordering::SeqCst);
    assert!(refresh.await.is_err());
    assert!(state.token.lock().unwrap().is_none());
    assert!(matches!(*state.auth.lock().unwrap(), AuthMode::Unauthenticated));
    assert!(!state.status_snapshot().ready);
}

#[tokio::test]
async fn beta_remote_desktop_startup_resolves_without_local_creation() {
    let state = NodeState::for_identifier(BETA);
    let dir = tempfile::tempdir().unwrap();
    assert!(state.local_startup.load(Ordering::SeqCst));
    assert!(bootstrap_remote_desktop_at(&state, dir.path()).await.is_err());
    assert!(!state.local_startup.load(Ordering::SeqCst));
    assert_eq!(serde_json::to_value(state.status_snapshot()).unwrap()["network_refusal"], "local_unavailable");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn beta_signet_bootstrap_replaces_an_old_refusal() {
    let (state, dir, _server) = auth_fixture_with_options(Some("signet".into()), mock_node::pairing::PairRoutes::Bootstrap, None);
    state.refuse_network(crate::network_policy::NetworkRefusal::Mainnet);
    state.reset_network_policy();
    assert_eq!(serde_json::to_value(state.status_snapshot()).unwrap()["network_refusal"], "none");
    assert!(!state.status_snapshot().ready);
    finish_auth(&state, dir.path()).await;
    assert_eq!(state.pairing_snapshot().bootstrap.as_deref(), Some("bootstrap"));
    assert_eq!(serde_json::to_value(state.status_snapshot()).unwrap()["network_refusal"], "none");
}

/// A phone build of the product app paired to a node that reports mainnet.
fn phone_fixture(control: Arc<ReportControl>) -> (NodeState, tempfile::TempDir, StatusServer) {
    let state = NodeState::for_profile(crate::profile::AppProfile::for_platform("tech.mindlink.bitsov", true));
    assert!(state.signet_only);
    auth_fixture_controlled_for_state(state, Some("bitcoin".into()), mock_node::pairing::PairRoutes::Live, None, control)
}

async fn assert_no_wallet_dispatch(state: &NodeState, control: &ReportControl) {
    assert!(do_invoice_create(state, 1_000, "", 3600).await.is_err());
    assert_eq!(control.count("/payments/invoice"), 0, "no wallet request may reach an unverified node");
}

#[tokio::test]
async fn phone_identity_failure_keeps_wallet_requests_off_the_node() {
    let control = Arc::new(ReportControl::default());
    control.fail_identity.store(true, Ordering::SeqCst);
    let (state, dir, _server) = phone_fixture(control.clone());
    finish_auth(&state, dir.path()).await;
    assert_eq!(control.count("/identity"), 1);
    assert_eq!(control.count("/status"), 0, "the network check never ran");
    assert!(!state.status_snapshot().ready);
    assert_no_wallet_dispatch(&state, &control).await;
}

#[tokio::test]
async fn phone_wallet_requests_wait_for_the_network_check() {
    let control = Arc::new(ReportControl::default());
    let (state, dir, _server) = phone_fixture(control.clone());
    authenticate(&state, dir.path()).await.unwrap();
    assert!(state.token.lock().unwrap().is_some());
    assert_eq!(control.count("/status"), 0, "the network check has not run yet");
    assert_no_wallet_dispatch(&state, &control).await;
}

#[tokio::test]
async fn beta_new_credential_does_not_inherit_an_earlier_network_check() {
    let control = Arc::new(ReportControl::default());
    let (state, dir, _server) = auth_fixture_controlled(Some("signet".into()), mock_node::pairing::PairRoutes::Live, None, control.clone());
    finish_auth(&state, dir.path()).await;
    assert!(state.status_snapshot().ready);
    authenticate(&state, dir.path()).await.unwrap();
    assert!(state.token.lock().unwrap().is_some());
    assert_no_wallet_dispatch(&state, &control).await;
}

#[tokio::test]
async fn beta_verified_signet_session_still_reaches_wallet_routes() {
    let control = Arc::new(ReportControl::default());
    let (state, dir, _server) = auth_fixture_controlled(Some("signet".into()), mock_node::pairing::PairRoutes::Live, None, control.clone());
    finish_auth(&state, dir.path()).await;
    assert!(state.status_snapshot().ready);
    let _ = do_invoice_create(&state, 1_000, "", 3600).await;
    assert_eq!(control.count("/payments/invoice"), 1);
}

async fn file_read_after(reauthenticate: bool) -> usize {
    let control = Arc::new(ReportControl::default());
    let (state, dir, _server) = auth_fixture_controlled(Some("signet".into()), mock_node::pairing::PairRoutes::Live, None, control.clone());
    finish_auth(&state, dir.path()).await;
    assert!(state.status_snapshot().ready);
    if reauthenticate { authenticate(&state, dir.path()).await.unwrap(); }
    let _ = read_file_blob(&state, "f1").await;
    control.count("/files/f1")
}

#[tokio::test]
async fn beta_direct_reads_wait_for_the_network_check_of_a_new_credential() {
    assert_eq!(file_read_after(false).await, 1, "a checked session reaches the node");
    assert_eq!(file_read_after(true).await, 0, "a new credential reads nothing before its network check");
}

#[path = "beta_network_renewal_tests.rs"]
pub(super) mod renewal_tests;
