//! Host subprocess coverage: capture its real stdout/stderr, exercise host API
//! code and descriptor delivery, and inspect all artifacts without printing secrets.
use super::*;
use std::io::{BufRead, Write};
use std::process::{Child, Command, Stdio};
use std::time::Instant;

const PASSWORD: &str = "owner-process-canary-6f98b212e2c9440a";
const PHRASE: &str =
    "abandon ability able about above absent absorb abstract absurd abuse access accident";
const CHILD: &str = "local_owner::process_tests::host_child";

fn leak(bytes: &[u8], secrets: &[&str]) -> Option<usize> {
    for (i, secret) in secrets.iter().enumerate() {
        // Mnemonic words are tokens: e.g. `act` in `active` is not a seed leak.
        // The password is checked as an exact byte substring on every surface.
        let leaked = if i == 0 || secret.contains(' ') {
            bytes.windows(secret.len()).any(|w| w == secret.as_bytes())
        } else {
            bytes
                .split(|b| !b.is_ascii_alphabetic())
                .any(|w| w == secret.as_bytes())
        };
        if leaked {
            return Some(i);
        }
    }
    None
}
fn scan(bytes: &[u8], secrets: &[&str], surface: &str) {
    assert!(
        leak(bytes, secrets).is_none(),
        "forbidden token detected on {surface}"
    );
}
fn scan_files(dir: &Path, secrets: &[&str]) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            scan_files(&path, secrets);
        } else if path.is_file() {
            scan(&std::fs::read(&path).unwrap(), secrets, "persisted file");
        }
    }
}
fn run_host(binary: Option<&Path>) {
    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("app.log");
    let log = std::fs::File::create(&log_path).unwrap();
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    cmd.args(["--exact", CHILD, "--nocapture"])
        .env(
            "BITSOV_OWNER_TEST_ROOT",
            std::fs::canonicalize(dir.path()).unwrap(),
        )
        .env_remove("BITSOV_OWNER_TEST_NODE")
        .stdout(log.try_clone().unwrap())
        .stderr(log);
    if let Some(binary) = binary {
        cmd.env("BITSOV_OWNER_TEST_NODE", binary);
    }
    let mut child = cmd.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(120);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("host process timed out");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let logs = std::fs::read(&log_path).unwrap();
    let mut secrets = vec![PASSWORD];
    if binary.is_none() {
        secrets.extend(PHRASE.split_whitespace());
    }
    scan(&logs, &secrets, "host stdout/stderr");
    // Never include the captured logs in an assertion: a regression may leak.
    let location = String::from_utf8_lossy(&logs)
        .lines()
        .find(|line| line.contains("panicked at src/"))
        .map(|line| line.split("panicked at ").nth(1).unwrap().to_string())
        .unwrap_or_else(|| "unknown location".into());
    assert!(
        status.success(),
        "host process failed at {location}; diagnostics suppressed to protect canaries"
    );
}

#[test]
fn contract_a_host_process_leaks_no_password_or_mnemonic_word() {
    run_host(None);
}

#[test]
fn real_node_create_finalize_restart_lists_device() {
    let explicit = std::env::var_os("BITSOV_OWNER_TEST_BINARY").map(PathBuf::from);
    let binary = explicit.clone().or_else(|| {
        ["target-review-node", "target"]
            .into_iter()
            .map(|target| {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../pa-ownerB")
                    .join(target)
                    .join("debug/konsensus")
            })
            .find(|p| p.is_file())
    });
    let Some(binary) = binary else {
        eprintln!("SKIP real owner lifecycle: build pa-ownerB or set BITSOV_OWNER_TEST_BINARY");
        return;
    };
    assert!(binary.is_file(), "explicit real-node binary is missing");
    run_host(Some(&binary));
}

struct Node {
    child: Child,
    readers: Vec<std::thread::JoinHandle<()>>,
}
impl Node {
    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        for reader in self.readers.drain(..) {
            reader.join().unwrap();
        }
    }
}
impl Drop for Node {
    fn drop(&mut self) {
        self.stop();
    }
}

fn start(binary: &Path, config: &Path, root: &Path, state: &NodeState, run: usize) -> Node {
    let password = prepare_launch(config, |_, fresh| {
        assert!(!fresh); // config already prepared before test-only port overrides
        Ok(Zeroizing::new(PASSWORD.as_bytes().to_vec()))
    })
    .unwrap();
    let mut command = Command::new(binary);
    command.args(start_args(config, true, true));
    launch(command, password, root, state, run)
}

fn launch(
    mut command: Command,
    password: Zeroizing<Vec<u8>>,
    root: &Path,
    state: &NodeState,
    run: usize,
) -> Node {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    owner_password::deliver(child.stdin.take(), password).unwrap();
    let pipes: Vec<(&str, Box<dyn std::io::Read + Send>)> = vec![
        ("out", Box::new(child.stdout.take().unwrap())),
        ("err", Box::new(child.stderr.take().unwrap())),
    ];
    let readers = pipes
        .into_iter()
        .map(|(label, pipe)| {
            let codes = state.printed_codes.clone();
            let mut capture =
                std::fs::File::create(root.join(format!("node-{run}-{label}.log"))).unwrap();
            std::thread::spawn(move || {
                for line in std::io::BufReader::new(pipe).split(b'\n') {
                    let line = line.unwrap();
                    capture.write_all(&line).unwrap();
                    capture.write_all(b"\n").unwrap();
                    let line = String::from_utf8_lossy(&line);
                    if label == "out" {
                        codes.record_line(&line);
                    }
                    log_node_line(label, &line, true);
                }
            })
        })
        .collect();
    Node { child, readers }
}
async fn ready(node: &mut Node, state: &NodeState) {
    let deadline = Instant::now() + Duration::from_secs(45);
    while !(health_ok(state).await
        || bootstrap_restore_available(state)
            .await
            .ok()
            .flatten()
            .is_some())
    {
        assert!(
            node.child.try_wait().unwrap().is_none(),
            "node exited before health"
        );
        assert!(Instant::now() < deadline, "node health timeout");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn host_child() {
    let Some(root) = std::env::var_os("BITSOV_OWNER_TEST_ROOT").map(PathBuf::from) else {
        return;
    };
    let dir = root.join("node");
    std::fs::create_dir(&dir).unwrap();
    let config = dir.join("konsensus.toml");
    prepare_launch(&config, |_, fresh| {
        assert!(fresh);
        assert!(!config.exists());
        Ok(Zeroizing::new(PASSWORD.as_bytes().to_vec()))
    })
    .unwrap();
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    // This also proves the host logger suppresses arbitrary secret-bearing node
    // diagnostics, independently of whether today's node happens to emit them.
    log_node_line("out", PASSWORD, true);
    log_node_line("err", PHRASE, true);
    if let Some(binary) = std::env::var_os("BITSOV_OWNER_TEST_NODE") {
        real_lifecycle(&root, &dir, &config, Path::new(&binary)).await;
    } else {
        fixture_lifecycle(&root, &dir).await;
    }
}

async fn fixture_lifecycle(root: &Path, dir: &Path) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let state = NodeState::for_api(format!("http://{address}/api/v1"));
    state.owner.active.store(true, Ordering::SeqCst);
    *state.token.lock().unwrap() = Some("test".into());
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "local_owner::process_tests::node_fixture_child",
            "--nocapture",
        ])
        .env("BITSOV_OWNER_FIXTURE_ADDR", address.to_string());
    let mut node = launch(
        command,
        Zeroizing::new(PASSWORD.as_bytes().to_vec()),
        root,
        &state,
        0,
    );
    ready(&mut node, &state).await;
    let pending = create(&state).await.unwrap();
    let mut metadata = metadata(&pending).unwrap();
    let record = device::Record {
        public_key: "04".into(),
        key_id: Some("key".into()),
        ..Default::default()
    };
    let words = ["abandon", "above", "abuse"].map(|s| Zeroizing::new(s.to_string()));
    submit(
        &state,
        dir,
        &mut metadata,
        &record,
        "mock-der-proof",
        &words,
    )
    .await
    .unwrap();
    assert!(node.child.wait().unwrap().success());
    node.stop();
    let mut secrets = vec![PASSWORD];
    secrets.extend(pending.mnemonic.split_whitespace());
    scan_files(root, &secrets);
}

// A separate HTTP/descriptor process keeps the leak contract runnable without
// a node checkout. The real-node test below verifies the protocol implementation.
#[test]
fn node_fixture_child() {
    use std::io::Read;
    let Ok(address) = std::env::var("BITSOV_OWNER_FIXTURE_ADDR") else {
        return;
    };
    let mut password = Zeroizing::new(Vec::new());
    std::io::stdin().read_to_end(&mut password).unwrap();
    assert!(password.as_slice() == PASSWORD.as_bytes());
    let listener = std::net::TcpListener::bind(address).unwrap();
    println!("fixture online");
    eprintln!("descriptor closed");
    for connection in listener.incoming() {
        let mut stream = connection.unwrap();
        let mut request = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let n = stream.read(&mut chunk).unwrap();
            assert!(n > 0);
            request.extend_from_slice(&chunk[..n]);
            if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..end]);
                let len = headers
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|v| v.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if request.len() >= end + 4 + len {
                    break;
                }
            }
        }
        let request = Zeroizing::new(String::from_utf8(request).unwrap());
        let route = request
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap();
        let reply = match route {
            "/api/v1/health" => serde_json::json!({"status":"ok"}),
            "/api/v1/bootstrap/state" => serde_json::json!({"state":"bootstrap", "local_owner":{"available":true,"enroll_device":true,"pending":false}}),
            "/api/v1/identity/create-pending" => serde_json::json!({"ceremony_id":"a".repeat(32),"node_id":"b".repeat(64),"mnemonic":PHRASE,"backup_check":[0,4,9],"expires_at":9999999999i64}),
            "/api/v1/identity/finalize" => {
                let body: serde_json::Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
                assert!(body["backup_words"] == serde_json::json!(["abandon", "above", "abuse"]));
                assert!(body.get("password").is_none());
                assert!(body.get("mnemonic").is_none());
                serde_json::json!({"node_id":"b".repeat(64),"restart_required":true,"device_key_id":"key"})
            },
            _ => panic!("unexpected fixture route"),
        }.to_string();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
            reply.len()
        )
        .unwrap();
        if route.ends_with("/finalize") {
            break;
        }
    }
}

async fn real_lifecycle(root: &Path, dir: &Path, config: &Path, binary: &Path) {
    use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let mut value: toml::Value = toml::from_str(&std::fs::read_to_string(config).unwrap()).unwrap();
    value["api"]
        .as_table_mut()
        .unwrap()
        .insert("listen_addr".into(), address.to_string().into());
    std::fs::write(config, toml::to_string(&value).unwrap()).unwrap();
    drop(listener);
    let state = NodeState::for_api(format!("http://{address}/api/v1"));
    state.owner.active.store(true, Ordering::SeqCst);
    *state.config.lock().unwrap() = Some(config.to_path_buf());
    let mut node = start(binary, config, root, &state, 0);
    ready(&mut node, &state).await;
    authenticate(&state, dir).await.unwrap();
    let pending = create(&state).await.unwrap();
    assert!(!dir.join("identity").exists());
    assert!(!dir.join("NODE_INITIALIZED").exists());
    // Random BIP39 words can coincide with public config/log vocabulary
    // (e.g. network/path/true). Strict per-word coverage is deterministic in
    // fixture_lifecycle; here additionally detect the real password/full phrase.
    let secrets = vec![PASSWORD, pending.mnemonic.as_str()];
    scan_files(root, &secrets);
    let words = pending.backup_check.map(|i| {
        Zeroizing::new(
            pending
                .mnemonic
                .split_whitespace()
                .nth(i)
                .unwrap()
                .to_string(),
        )
    });
    let rng = ring::rand::SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
    let key =
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng).unwrap();
    let public = hex::encode(key.public_key().as_ref());
    let client = match &*state.auth.lock().unwrap() {
        AuthMode::Paired(s) => s.client_id.clone(),
        _ => panic!("not paired"),
    };
    let proof = hex::encode(
        key.sign(
            &rng,
            device::registration_message(&fingerprint(&pending.node_id), &client, &public)
                .as_bytes(),
        )
        .unwrap()
        .as_ref(),
    );
    let record = device::Record {
        key_id: Some(key_id(&public).unwrap()),
        public_key: public,
        ..Default::default()
    };
    let store = device_store(&state).unwrap();
    device::save_record(&store, &record).unwrap();
    submit(
        &state,
        &store,
        &mut metadata(&pending).unwrap(),
        &record,
        &proof,
        &words,
    )
    .await
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = node.child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(
            Instant::now() < deadline,
            "bootstrap did not exit after finalize"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    node.stop();
    let mut value: toml::Value = toml::from_str(&std::fs::read_to_string(config).unwrap()).unwrap();
    assert_eq!(
        value["identity"]["mnemonic_file"].as_str(),
        dir.join("identity/mnemonic.enc").to_str()
    );
    assert!(dir.join("identity/mnemonic.enc").exists());
    assert!(dir.join("NODE_INITIALIZED").exists());
    assert!(!dir.join("identity/mnemonic.txt").exists());
    // Bootstrap above uses the production defaults. Live wallet/chain backends
    // are replaced only here to keep this protocol regression offline.
    value["lightning"] = toml::Value::try_from(serde_json::json!({"backend":"mock"})).unwrap();
    value["chain"] = toml::Value::try_from(serde_json::json!({"backend":"mock"})).unwrap();
    value["network"]["listen_addr"] = "127.0.0.1:0".into();
    std::fs::write(config, toml::to_string(&value).unwrap()).unwrap();
    let mut node = start(binary, config, root, &state, 1);
    ready(&mut node, &state).await;
    reauthenticate(&state).await.unwrap();
    assert_eq!(fetch_node_id(&state).await.unwrap(), pending.node_id);
    let binding = device_binding(&state).await.unwrap();
    assert_eq!(binding.device_approvals.as_deref(), Some("enabled"));
    assert!(binding
        .device_keys
        .iter()
        .any(|k| Some(&k.key_id) == record.key_id.as_ref()));
    node.stop();
    scan_files(root, &secrets);
}

#[test]
fn leak_scanner_detects_each_canary_on_each_surface() {
    let mut secrets = vec![PASSWORD, PHRASE];
    secrets.extend(PHRASE.split_whitespace());
    for surface in ["node stdout", "node stderr", "app logs", "files"] {
        for secret in &secrets {
            assert!(
                leak(secret.as_bytes(), &secrets).is_some(),
                "scanner missed {surface}"
            );
        }
    }
}
