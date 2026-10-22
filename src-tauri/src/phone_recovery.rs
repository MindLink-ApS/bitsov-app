//! Fixed mobile recovery destinations. No renderer-supplied URL or package.
#[cfg(target_os = "android")]
mod android {
    use std::sync::OnceLock;
    use tauri::{plugin::{Builder, PluginHandle, TauriPlugin}, Wry};
    static HANDLE: OnceLock<PluginHandle<Wry>> = OnceLock::new();
    pub fn init() -> TauriPlugin<Wry> {
        Builder::new("phone-recovery").setup(|_app, api| {
            let handle = api.register_android_plugin("tech.mindlink.bitsov", "PhoneRecoveryPlugin")?;
            HANDLE.set(handle).map_err(|_| std::io::Error::other("phone recovery already registered"))?;
            Ok(())
        }).build()
    }
    pub async fn open(tailscale: bool) -> Result<(), String> {
        let handle = HANDLE.get().ok_or("phone recovery unavailable")?;
        handle.run_mobile_plugin_async::<serde_json::Value>(
            if tailscale { "openTailscale" } else { "openAppSettings" }, serde_json::json!({})
        ).await.map_err(|_| "Could not open the app. Open it from your home screen.".to_string())?;
        Ok(())
    }
}
#[cfg(target_os = "android")]
pub use android::init;

pub async fn open(tailscale: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    { android::open(tailscale).await }
    #[cfg(target_os = "ios")]
    { tauri::async_runtime::spawn_blocking(move || bitsov_ffi::phone_recovery::open(tailscale))
        .await.map_err(|_| "Could not open the app".to_string())? }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    { let _ = tailscale; Err("Phone recovery is available only on a phone".into()) }
}
