use super::*;
use std::os::unix::fs::PermissionsExt;

const BETA: &str = "tech.mindlink.bitsov.beta";

fn fixture(text: &str) -> (tauri::App<tauri::test::MockRuntime>, tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let node = dir.path().join("node");
    std::fs::create_dir(&node).unwrap();
    let config = node.join("konsensus.toml");
    std::fs::write(&config, text).unwrap();
    let program = dir.path().join("stand-in");
    std::fs::write(&program, "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$0.calls\"\n").unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let state = NodeState::for_identifier(BETA);
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
    assert!(!calls.exists());
    assert_eq!(std::fs::read_dir(data_dir).unwrap().count(), 0);
}
