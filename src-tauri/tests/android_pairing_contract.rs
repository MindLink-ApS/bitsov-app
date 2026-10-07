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
