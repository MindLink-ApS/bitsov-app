#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(all(target_os = "macos", not(feature = "mobile")))]
    if std::env::args().nth(1).as_deref() == Some("--keychain-smoke-test") {
        match bitsov_app::mac_keychain_smoke_test() {
            Ok(path) => println!("PASS: Keychain add/read/delete; identity path={path}"),
            Err(error) => { eprintln!("{error}"); std::process::exit(1); }
        }
        return;
    }
    bitsov_app::run();
}
