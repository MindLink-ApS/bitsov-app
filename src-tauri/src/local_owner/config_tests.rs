//! Drift guard against the real node CLI, without linking any node crate.
use super::*;
use std::process::{Command, Stdio};

// Intentional differences, exhaustively listed:
// - The scratch roots differ. Only storage.path, backup.scb_dir and
//   api.audit_log_path are rebased; their relative filenames must still match.
// - init creates mnemonic.txt; owner bootstrap reserves identity/mnemonic.txt
//   without creating an identity. Finalize later changes that path to .enc.
// - The app omits the following serde defaults. Check their literal values
//   before removing them from init's output, never copy arbitrary node values
//   into the app config. Older pins can omit these fields too. New fields and
//   changed defaults must fail until deliberately reviewed here. The three
//   known rc7/owner-node web default differences are listed separately below.
// Defaults last reviewed for rc14; rc20 signed-binary validation is pending. LAN setup
// limits are internal constants; grant breakers live in pairing records, not TOML.
const OMITTED_DEFAULTS: &str = r#"
disk_free_floor_bytes = 2147483648
peers = []
admission_mode = "whitelist"
cookie_mode = "adaptive"

# rc11 #250: peer doorway limits are inherited by the bootstrap config.
[dos_edge]
connections_per_second = 10.0
connection_burst = 40
handshakes_per_second = 2.0
handshake_burst = 8
max_pending = 128
max_handshakes = 64
max_per_ip = 4
max_per_subnet = 8
cookie_threshold = 32
max_tracked_sources = 4096
cookie_timeout_secs = 3
handshake_timeout_secs = 10

# rc11: no display label or local watchtower staging by default.
[node]

[tower.clients]

[logging]
max_file_size_bytes = 10485760
max_files = 5

[routing_fees]
minimum_msat = 5000
proportional_millionths = 10000
maximum_msat = 10000

[identity]
passphrase = ""

[lightning]
forward_to_private_channels = false

[lightning.liquidity]
enabled = false
providers = []

# rc9 node #233: the entire service uses serde defaults. Keep bootstrap minimal
# and check every serialized default, including tariffs for the disabled service.
[lightning.lsps2_service]
enabled = false
channel_opening_fee_ppm = 10000
channel_over_provisioning_ppm = 1000000
min_channel_opening_fee_msat = 1000000
min_channel_lifetime = 144
max_client_to_self_delay = 2016
min_payment_size_msat = 10000000
max_payment_size_msat = 1000000000
funding_priority = "normal"
max_funding_fee_sats = 10000
max_concurrent_jit_opens = 4
max_jit_capital_sats = 10000000
forwarding_fee_ppm = 500
forwarding_fee_base_msat = 1000

[pricing]
mode = "static"
fee_target_blocks = 6
fee_cache_secs = 60
max_price_multiplier = 5.0
fee_rate_ema_alpha = 0.3
chat_msat = 10
longform_msat = 50
calendar_msat = 25
file_ref_msat = 100
control_msat = 1
collaboration_msat = 25
realtime_signal_msat = 50
call_msat = 10000
app_ext_msat = 10

[pricing.category_fee_targets]

[privacy]
peer_exchange = "off"
shareable_peers = []
share_peer_labels = []

[storage]
encrypted = true
retention_days = 0

[backup]
rotation_count = 24

[api]
listen_addr = "127.0.0.1:3141"
rate_limit_rps = 60
cors_enabled = true

[remote_access]

[web]
enabled = false
content_dir = "pages"
page_cache_secs = 300
site_name = "BitSov Node"

[onboarding_subsidy]
enabled = false
max_channel_sats = 0
max_total_budget_sats = 0
max_funding_fee_rate_sat_per_vb = 0
per_peer_max_opens = 1
allowlist = []

[sponsor]
enabled = false
gift_sats = 20000
fee_sats = 100
purse_sats = 100000
kits_per_day = 2

[relay]
enabled = false

[calls]
"#;

fn remove_documented_web_defaults(node: &mut toml::Value) {
    let fields = [
        ("pricing", "web_content_msat"),
        ("web", "max_page_size"),
        ("web", "page_price_msat"),
    ];
    let actual = fields.map(|(section, key)| {
        node[section][key]
            .as_integer()
            .expect("integer web default")
    });
    // The app omits all three and inherits the selected node's serde defaults.
    // Accept only these reviewed sets, not arbitrary values or mixed profiles:
    // rc7: 50 msat content/page, 4 MiB; owner node: 1000 msat, 256 KiB.
    assert!(
        [[50, 4_194_304, 50], [1000, 262_144, 1000]].contains(&actual),
        "node web defaults drifted: {actual:?}"
    );
    for (section, key) in fields {
        node[section].as_table_mut().unwrap().remove(key);
    }
}

fn remove_documented_defaults(node: &mut toml::Table, defaults: toml::Table, prefix: &str) {
    for (key, expected) in defaults {
        let Some(actual) = node.get_mut(&key) else {
            continue; // Older pins need not serialize every later serde default.
        };
        let field = format!("{prefix}{key}");
        if let toml::Value::Table(expected) = expected {
            let actual = actual
                .as_table_mut()
                .expect("default section must be a table");
            remove_documented_defaults(actual, expected, &format!("{field}."));
            if actual.is_empty() {
                node.remove(&key);
            }
        } else {
            // No diagnostic values: an identity field could contain a secret.
            assert!(*actual == expected, "node default drifted: {field}");
            node.remove(&key);
        }
    }
}

fn normalize_paths(config: &mut toml::Value, root: &Path, mnemonic: &str) {
    for (section, key, relative) in [
        ("identity", "mnemonic_file", mnemonic),
        ("storage", "path", "konsensus.db"),
        ("backup", "scb_dir", "backups"),
        ("api", "audit_log_path", "audit.jsonl"),
    ] {
        let actual = config[section][key]
            .as_str()
            .expect("path must be a string");
        assert_eq!(Path::new(actual), root.join(relative), "{section}.{key}");
        config[section][key] = if section == "identity" {
            "<mnemonic>".into()
        } else {
            relative.into()
        };
    }
}

#[test]
#[should_panic(expected = "node default drifted: lightning.lsps2_service.enabled")]
fn lsps2_enabled_drift_is_rejected() {
    let mut node = toml::from_str("[lightning.lsps2_service]\nenabled = true").unwrap();
    remove_documented_defaults(&mut node, toml::from_str(OMITTED_DEFAULTS).unwrap(), "");
}

#[test]
#[should_panic(expected = "node default drifted: lightning.lsps2_service.channel_opening_fee_ppm")]
fn lsps2_tariff_drift_is_rejected() {
    let mut node =
        toml::from_str("[lightning.lsps2_service]\nchannel_opening_fee_ppm = 10001").unwrap();
    remove_documented_defaults(&mut node, toml::from_str(OMITTED_DEFAULTS).unwrap(), "");
}

#[test]
fn unknown_lsps2_fields_remain_for_the_drift_comparison() {
    let mut node =
        toml::from_str("[lightning.lsps2_service]\nenabled = false\nunreviewed_tariff = 123")
            .unwrap();
    remove_documented_defaults(&mut node, toml::from_str(OMITTED_DEFAULTS).unwrap(), "");
    let remaining: toml::Table =
        toml::from_str("[lightning.lsps2_service]\nunreviewed_tariff = 123").unwrap();
    assert_eq!(
        node, remaining,
        "unknown fields must not be silently omitted"
    );
}

#[test]
fn bootstrap_config_matches_node_init() {
    let Some(binary) = super::process_tests::real_node_binary() else {
        return;
    };
    let scratch = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(scratch.path()).unwrap();
    let node_dir = root.join("node");
    let app_dir = root.join("app");
    std::fs::create_dir(&app_dir).unwrap();

    // init creates a disposable seed, unlike bootstrap. Close stdin and suppress
    // all output so neither prompts nor generated mnemonic words reach CI logs.
    let status = Command::new(binary)
        .args(["init", "--tier", "full", "--non-interactive", "--dir"])
        .arg(&node_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("run real node init");
    assert!(status.success(), "node init failed: {status}");

    let app_config = app_dir.join("konsensus.toml");
    write_bootstrap_config(&app_config).unwrap();
    assert_eq!(std::fs::read_dir(&app_dir).unwrap().count(), 1);
    let read = |path: &Path| -> toml::Value {
        toml::from_str(&std::fs::read_to_string(path).unwrap())
            .unwrap_or_else(|_| panic!("invalid TOML config (contents suppressed)"))
    };
    let mut app = read(&app_config);
    let mut node = read(&node_dir.join("konsensus.toml"));
    normalize_paths(&mut app, &app_dir, "identity/mnemonic.txt");
    normalize_paths(&mut node, &node_dir, "mnemonic.txt");
    remove_documented_web_defaults(&mut node);
    remove_documented_defaults(
        node.as_table_mut().unwrap(),
        toml::from_str(OMITTED_DEFAULTS).unwrap(),
        "",
    );
    assert_eq!(
        app, node,
        "bootstrap defaults drifted from konsensus init --tier full"
    );
}
