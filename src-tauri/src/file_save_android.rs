//! Android: save a received file into the shared Downloads collection through
//! the app's own `FileSavePlugin` (MediaStore, Android 10+). The checks that
//! decide what is sent to the plugin are pure and tested on every platform.

#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use crate::act;

/// Shown when the phone is older than Android 10 (no MediaStore Downloads
/// without a storage permission, which the app does not ask for).
pub const NEEDS_ANDROID_10: &str = "Saving received files needs Android 10 or later.";

/// A MIME type MediaStore may be given: a plain `type/subtype` made of letters,
/// digits and `+ . -`, else a generic binary type. Peer input never reaches
/// the content resolver unchecked.
pub fn safe_mime(mime: &str) -> String {
    let ok_part = |part: &str| !part.is_empty() && part.len() <= 64
        && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    match mime.trim().split_once('/') {
        Some((kind, sub)) if ok_part(kind) && ok_part(sub) => format!("{}/{}", kind.to_ascii_lowercase(), sub.to_ascii_lowercase()),
        _ => "application/octet-stream".into(),
    }
}

/// A one-segment name within Android's 255-byte limit, leaving room for the
/// " (1)"-style suffix MediaStore adds to a taken name. The extension is split
/// off before shortening (so the type survives) and cuts fall on a character
/// boundary. A long "extension" is not one: it stays in the name.
pub fn download_name(filename: &str) -> String {
    const MAX_BYTES: usize = 255;
    const EXT_MAX_BYTES: usize = 16;
    const SUFFIX_ROOM: usize = " (99)".len();
    let last = filename.rsplit(['/', '\\']).next().unwrap_or("");
    let (raw_stem, raw_ext) = match last.rfind('.') {
        Some(dot) if dot > 0 && last.len() - dot <= EXT_MAX_BYTES => (&last[..dot], &last[dot + 1..]),
        _ => (last, ""),
    };
    let ext = if raw_ext.is_empty() { String::new() } else {
        let clean = act::safe_save_name(raw_ext);
        // "file" is also the cleaner's fallback for nothing usable: drop it then,
        // but keep a genuine ".file" extension.
        if clean == "file" && raw_ext.trim() != "file" { String::new() } else { format!(".{clean}") }
    };
    let stem = act::safe_save_name(raw_stem);
    let mut end = stem.len().min(MAX_BYTES - ext.len() - SUFFIX_ROOM);
    while !stem.is_char_boundary(end) { end -= 1; }
    format!("{}{ext}", &stem[..end])
}

/// The plugin request: a cleaned single-segment name, a safe type, and data
/// already checked to decode and to fit the app's file cap.
pub fn request(filename: &str, mime: &str, data_b64: &str) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|_| "corrupt file data".to_string())?;
    if bytes.len() > act::FILE_MAX_BYTES {
        return Err(act::FILE_TOO_LARGE.into());
    }
    Ok(serde_json::json!({
        "name": download_name(filename),
        "mime": safe_mime(mime),
        "data": data_b64,
    }))
}

/// The plugin's refusal codes, said plainly.
pub fn refusal(error: &str) -> String {
    if error.contains("unsupported") {
        NEEDS_ANDROID_10.into()
    } else if error.contains("corrupt") {
        "corrupt file data".into()
    } else {
        "could not save".into()
    }
}

#[cfg(target_os = "android")]
mod android {
    use std::sync::OnceLock;
    use tauri::{plugin::{Builder, PluginHandle, TauriPlugin}, Wry};

    static HANDLE: OnceLock<PluginHandle<Wry>> = OnceLock::new();

    #[derive(serde::Deserialize)]
    struct Saved {
        name: String,
    }

    pub fn init() -> TauriPlugin<Wry> {
        Builder::new("file-save").setup(|_app, api| {
            let handle = api.register_android_plugin("org.bitsov.files", "FileSavePlugin")?;
            HANDLE.set(handle).map_err(|_| std::io::Error::other("file save already registered"))?;
            Ok(())
        }).build()
    }

    /// The name Downloads gave the file (the system renames a taken name).
    pub async fn save(request: serde_json::Value) -> Result<String, String> {
        let handle = HANDLE.get().ok_or("could not save")?;
        handle.run_mobile_plugin_async::<Saved>("saveToDownloads", request)
            .await
            .map(|saved| saved.name)
            .map_err(|error| super::refusal(&error.to_string()))
    }
}

#[cfg(target_os = "android")]
pub use android::{init, save};

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn b64(bytes: &[u8]) -> String { base64::engine::general_purpose::STANDARD.encode(bytes) }

    #[test]
    fn only_a_plain_type_reaches_mediastore() {
        assert_eq!(safe_mime("application/pdf"), "application/pdf");
        assert_eq!(safe_mime("Image/PNG"), "image/png");
        assert_eq!(safe_mime("application/vnd.oasis.opendocument.text"), "application/vnd.oasis.opendocument.text");
        for bad in ["", "text", "text/", "/plain", "text/plain; charset=utf-8", "text/pl ain", "a/b/c", "x/\u{0}"] {
            assert_eq!(safe_mime(bad), "application/octet-stream", "{bad:?}");
        }
    }

    #[test]
    fn the_request_carries_a_clean_name_and_only_checked_data() {
        let sent = request("../../Download/evil.apk", "application/vnd.android.package-archive", &b64(b"x")).unwrap();
        assert_eq!(sent["name"], "evil.apk");
        assert_eq!(sent["mime"], "application/vnd.android.package-archive");
        assert_eq!(sent["data"], b64(b"x"));
        assert_eq!(request(".hidden", "text/plain", &b64(b"x")).unwrap()["name"], "hidden");
        assert!(super::request("a", "text/plain", "%%%").is_err());
        let big = b64(&vec![0u8; act::FILE_MAX_BYTES + 1]);
        assert_eq!(super::request("a", "text/plain", &big).unwrap_err(), act::FILE_TOO_LARGE);
    }

    #[test]
    fn long_multibyte_names_fit_255_bytes_with_room_for_a_suffix() {
        let name = download_name(&format!("{}.pdf", "\u{1F600}".repeat(180)));
        assert!(name.len() + " (99)".len() <= 255, "{} bytes", name.len());
        assert!(name.ends_with(".pdf"), "{name}");
        let cjk = download_name(&format!("{}.{}", "\u{6587}".repeat(120), "x".repeat(200)));
        assert!(cjk.len() + " (99)".len() <= 255, "{} bytes", cjk.len());
        assert_eq!(download_name("report.pdf"), "report.pdf");
        assert_eq!(download_name("notes"), "notes");
        // A genuine ".file" extension is kept; one that cleans to nothing is dropped.
        assert_eq!(download_name("data.file"), "data.file");
        assert_eq!(download_name("notes.  "), "notes");
    }

    #[test]
    fn plugin_refusals_are_said_plainly() {
        assert_eq!(refusal("unsupported"), NEEDS_ANDROID_10);
        assert_eq!(refusal("plugin error: corrupt"), "corrupt file data");
        assert_eq!(refusal("anything else"), "could not save");
    }
}
