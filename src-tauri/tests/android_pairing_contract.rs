//! Source-only contracts: never start Tauri or a device.
use std::{fs, path::Path};

fn source(path: &str) -> String {
    fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap()
}

#[test]
fn camera_is_optional_and_pair_links_open_the_single_task_activity() {
    let manifest = source("gen/android/app/src/main/AndroidManifest.xml");
    assert!(manifest.contains("<uses-permission android:name=\"android.permission.CAMERA\" />"));
    assert!(manifest.contains("android.hardware.camera\" android:required=\"false\""));
    let activity = manifest.split("<activity").nth(1).unwrap().split("</activity>").next().unwrap();
    assert!(activity.contains("android:launchMode=\"singleTask\""));
    let filter = activity.split("<intent-filter>").find(|s| s.contains("android.intent.action.VIEW")).unwrap();
    let filter = filter.split("</intent-filter>").next().unwrap();
    for value in ["android.intent.category.DEFAULT", "android.intent.category.BROWSABLE",
        "android:scheme=\"bitsov\"", "android:host=\"pair\"", "android:pathPrefix=\"/\""] {
        assert!(filter.contains(value), "missing {value}");
    }
}

#[test]
fn deep_links_are_taken_once_on_android_without_logging_or_importing() {
    let kotlin = source("gen/android/app/src/main/java/tech/mindlink/bitsov/PairingLinkPlugin.kt");
    for value in ["activity.intent", "onNewIntent", "Intent.ACTION_VIEW", "intent.data = null", "pendingLink = null"] {
        assert!(kotlin.contains(value), "missing {value}");
    }
    for forbidden in ["Log.", "Logger", "println", "remote_access_import"] {
        assert!(!kotlin.contains(forbidden));
    }
    let app = source("src/app.rs");
    assert!(app.contains(".plugin(crate::pairing_link_mobile::init())"));
    assert!(source("mobile-capabilities/default.json").contains("allow-pairing-link-take"));
    assert!(!source("capabilities/default.json").contains("allow-pairing-link-take"));
}

#[test]
fn native_cap_matches_the_typescript_envelope_and_taken_marker_survives_process_death() {
    let kotlin = source("gen/android/app/src/main/java/tech/mindlink/bitsov/PairingLinkPlugin.kt");
    let ts = source("../src/onboarding/pairing.ts");
    assert!(ts.contains("prefix.length + 16384"));
    assert!(kotlin.contains("PAIRING_PREFIX.length + 16384"));
    assert!(kotlin.contains("const val PAIRING_PREFIX = \"bitsov://pair/\""));
    assert!(kotlin.contains("MessageDigest.getInstance(\"SHA-256\")"));
    assert!(kotlin.contains("getSharedPreferences("));
    assert!(kotlin.contains("getString(\"taken_hashes_v2\", \"\")"));
    assert!(kotlin.contains("if (hash in takenHashes) return"));
    let take = kotlin.split("fun takePendingLink").nth(1).unwrap();
    assert!(take.contains("val receipts = (takenHashes - pendingHash!! + pendingHash!!).takeLast(MAX_RECEIPTS)"));
    assert!(take.contains("putString(\"taken_hashes_v2\", receipts.joinToString(\",\")).commit()"));
    assert!(kotlin.contains("private const val MAX_RECEIPTS = 32"));
    assert!(kotlin.contains("split(',').filter { it.length == 64 }.takeLast(MAX_RECEIPTS)"));
    assert!(take.find(".commit()").unwrap() < take.find("response.put(\"link\"").unwrap());
    assert!(!kotlin.contains("putString(\"ticket\""));
}

#[test]
fn preview_only_parses_and_is_registered_for_main_windows() {
    let rust = source("src/remote_access.rs");
    let preview = rust.split("pub fn preview_pairing_link(").nth(1).expect("parse-only preview").split("pub fn import_pairing_link(").next().unwrap();
    assert!(preview.contains("parse_pairing_link(link)?"));
    for forbidden in ["persist", "config_path", "REMOTE_CONFIG_LOCK", "reqwest", "Sealer"] {
        assert!(!preview.contains(forbidden), "preview must not perform {forbidden}");
    }
    for path in ["capabilities/default.json", "mobile-capabilities/default.json"] {
        assert!(source(path).contains("allow-remote-access-preview"));
    }
    assert!(source("build.rs").contains("\"remote_access_preview\""));
    assert!(source("src/app.rs").contains("remote_access::preview_pairing_link(link.trim())"));
}
