//! Android-only intent inbox. No persistence, logging, parsing or auto-import.
use serde::Deserialize;
use std::{io, sync::OnceLock};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Wry,
};

static HANDLE: OnceLock<PluginHandle<Wry>> = OnceLock::new();

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("pairing-link")
        .setup(|_app, api| {
            let handle =
                api.register_android_plugin("tech.mindlink.bitsov", "PairingLinkPlugin")?;
            HANDLE.set(handle).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "pairing link inbox already registered",
                )
            })?;
            Ok(())
        })
        .build()
}

#[derive(Deserialize)]
struct PendingLink {
    link: Option<String>,
}

pub fn take() -> Result<Option<String>, String> {
    let handle = HANDLE.get().ok_or("pairing link inbox unavailable")?;
    let response: PendingLink = handle
        .run_mobile_plugin("takePendingLink", serde_json::json!({}))
        .map_err(|_| "could not read pairing link inbox")?;
    Ok(response.link)
}
