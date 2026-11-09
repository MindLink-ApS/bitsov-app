//! Source-only contracts: never open a browser or start Tauri.
use std::{fs, path::Path};

fn source(path: &str) -> String {
    fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap()
}

#[test]
fn privacy_command_accepts_no_destination_and_opens_only_the_host_constant() {
    let app = source("src/app.rs");
    assert!(source("src/privacy_policy.rs").contains("const URL: &str = \"https://mindlink.tech/bitsov/privacy\";"));
    let command = app.split("async fn privacy_policy_open(").nth(1).unwrap();
    let (signature, body) = command.split_once(") -> Result<(), String> {").unwrap();
    assert_eq!(signature.trim(), "window: WebviewWindow<impl tauri::Runtime>");
    let body = body.split("\n}").next().unwrap();
    let guard = body.find("reject_sealed_window(&window)?").unwrap();
    let open = body.find(".open_url(crate::privacy_policy::URL, None::<&str>)").unwrap();
    assert!(guard < open, "check the window before opening the browser");
    assert!(body.contains("use tauri_plugin_opener::OpenerExt;"));
    assert!(!body.contains("include_str!"));
}

#[test]
fn privacy_command_is_registered_and_granted_only_to_main_on_desktop_and_mobile() {
    assert!(source("build.rs").contains("\"privacy_policy_open\""));
    let app = source("src/app.rs");
    let handler = app.split("tauri::generate_handler![").nth(1).unwrap().split(']').next().unwrap();
    assert!(handler.lines().any(|line| line.trim() == "privacy_policy_open,"));
    assert!(app.contains(".open_js_links_on_click(false)"));
    for path in ["capabilities/default.json", "mobile-capabilities/default.json"] {
        let capability = source(path);
        assert!(capability.contains("\"windows\": [\"main\"]"), "{path}");
        assert!(capability.contains("\"allow-privacy-policy-open\""), "{path}");
        assert!(!capability.contains("opener:"), "{path}");
        assert!(!capability.contains("shell:"), "{path}");
    }
    assert!(!source("capabilities/assistant.json").contains("allow-privacy-policy-open"));
}

#[test]
fn renderer_keeps_absolute_web_urls_only_in_the_sample_fixture() {
    fn check(path: &Path) {
        if path.is_dir() {
            for entry in fs::read_dir(path).unwrap() {
                check(&entry.unwrap().path());
            }
        } else if !path.ends_with("control/sample.ts") {
            if let Ok(text) = fs::read_to_string(path) {
                assert!(!text.contains("https://") && !text.contains("http://"), "renderer URL in {}", path.display());
            }
        }
    }
    check(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../src"));
}
