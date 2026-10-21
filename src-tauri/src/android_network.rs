//! Android LAN permission guard; the resolver is host-testable without JNI.

use crate::remote_access::RemoteError;
use std::net::SocketAddr;

async fn resolve_allowed<F, Fut>(endpoint: &str, permission: F) -> Result<Vec<SocketAddr>, RemoteError>
where
    F: FnOnce(Vec<SocketAddr>, bool) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<bool>, RemoteError>>,
{
    let (host, _) = crate::remote_access::endpoint_parts(endpoint)?;
    let mdns = host.trim_end_matches('.').to_ascii_lowercase().ends_with(".local");
    let mut permission = Some(permission);
    // mDNS itself needs permission, before any lookup can take place.
    if mdns { permission.take().unwrap()(vec![], true).await?; }
    let mut addresses: Vec<_> = tokio::time::timeout(std::time::Duration::from_secs(10), tokio::net::lookup_host(endpoint))
        .await.map_err(|_| RemoteError::HandshakeUnavailable)?
        .map_err(|_| RemoteError::HandshakeUnavailable)?.collect();
    if !mdns {
        let allowed = permission.take().unwrap()(addresses.clone(), false).await?;
        if allowed.len() != addresses.len() { return Err(RemoteError::AndroidLocalNetwork); }
        addresses = addresses.into_iter().zip(allowed).filter_map(|(address, allowed)| allowed.then_some(address)).collect();
        if addresses.is_empty() { return Err(RemoteError::AndroidLocalNetwork); }
    }
    Ok(addresses)
}

#[cfg(target_os = "android")]
mod native {
    use super::*;
    use serde::Deserialize;
    use std::sync::OnceLock;
    use tauri::{plugin::{Builder, PluginHandle, TauriPlugin}, Wry};

    static HANDLE: OnceLock<PluginHandle<Wry>> = OnceLock::new();

    pub fn init() -> TauriPlugin<Wry> {
        Builder::new("local-network")
            .setup(|_app, api| {
                let handle = api.register_android_plugin("tech.mindlink.bitsov", "LocalNetworkPlugin")?;
                HANDLE.set(handle).map_err(|_| std::io::Error::other("local network plugin already registered"))?;
                Ok(())
            }).build()
    }

    pub async fn resolve(endpoint: &str) -> Result<Vec<SocketAddr>, RemoteError> {
        resolve_allowed(endpoint, |addresses, mdns| async move {
            #[derive(Deserialize)]
            struct Permission { granted: bool, allowed: Vec<bool> }
            let handle = HANDLE.get().ok_or(RemoteError::AndroidLocalNetwork)?;
            // Tauri's callback unwraps its send. Keep its receiver alive even
            // when Forget/replacement drops this connection future; only this
            // detached permission exchange survives, never the socket attempt.
            let response = tauri::async_runtime::spawn(async move {
                handle.run_mobile_plugin_async::<Permission>("ensurePermission", serde_json::json!({
                    "addresses": addresses.iter().map(|address| address.ip().to_string()).collect::<Vec<_>>(),
                    "mdns": mdns,
                })).await
            }).await.map_err(|_| RemoteError::AndroidLocalNetwork)?
                .map_err(|_| RemoteError::AndroidLocalNetwork)?;
            if mdns && !response.granted { return Err(RemoteError::AndroidLocalNetwork); }
            Ok(response.allowed)
        }).await
    }
}

#[cfg(target_os = "android")]
pub use native::{init, resolve};

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn denial_stops_lan_and_mdns_before_dial_or_resolution() {
        for endpoint in ["192.168.1.2:3141", "[fd00::1]:3141", "box.local:3141"] {
            assert!(matches!(resolve_allowed(endpoint, |_, _| async { Err(RemoteError::AndroidLocalNetwork) }).await,
                Err(crate::remote_access::RemoteError::AndroidLocalNetwork)));
        }
    }

    #[tokio::test]
    async fn a_later_permission_grant_recovers_lan_resolution() {
        let endpoint = "192.168.1.2:3141";
        assert!(resolve_allowed(endpoint, |_, _| async { Err(RemoteError::AndroidLocalNetwork) }).await.is_err());
        let addresses = resolve_allowed(endpoint, |addresses, _| async move { Ok(vec![true; addresses.len()]) }).await.unwrap();
        assert_eq!(addresses, [endpoint.parse::<std::net::SocketAddr>().unwrap()]);
    }

    #[tokio::test]
    async fn public_vpn_and_loopback_remain_usable_when_native_policy_allows_them() {
        for endpoint in ["8.8.8.8:3141", "100.64.0.1:3141", "127.0.0.1:3141", "[::1]:3141", "localhost:3141"] {
            assert!(!resolve_allowed(endpoint, |addresses, mdns| async move { assert!(!mdns); Ok(vec![true; addresses.len()]) }).await.unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn denied_addresses_are_filtered_and_malformed_native_responses_fail_closed() {
        assert!(matches!(resolve_allowed("192.168.1.2:3141", |_, _| async { Ok(vec![false]) }).await,
            Err(RemoteError::AndroidLocalNetwork)));
        assert!(matches!(resolve_allowed("192.168.1.2:3141", |_, _| async { Ok(vec![]) }).await,
            Err(RemoteError::AndroidLocalNetwork)));
    }

    #[tokio::test]
    async fn a_pending_permission_request_is_cancellable_and_does_not_block_replacement() {
        let pending = resolve_allowed("192.168.1.2:3141", |_, _| std::future::pending());
        assert!(tokio::time::timeout(std::time::Duration::from_millis(10), pending).await.is_err());
        assert!(resolve_allowed("192.168.1.3:3141", |addresses, _| async move { Ok(vec![true; addresses.len()]) }).await.is_ok());
    }

    #[test]
    fn android_permission_denial_is_actionable_and_not_transient() {
        let error = crate::remote_access::RemoteError::AndroidLocalNetwork;
        let view = crate::remote_access::ConnectionError::from(&error);
        assert_eq!(view.kind, crate::remote_access::ConnectionErrorKind::LocalNetwork);
        assert!(view.detail.contains("Nearby devices"));
        let retry = crate::connection_retry::RemoteRetry::default();
        retry.failed(&error);
        assert!(!retry.is_retrying());
    }

    #[test]
    #[cfg(unix)]
    fn sealed_identity_survives_restart_but_not_a_fresh_install_directory() {
        use crate::{at_rest::test_sealer::MemorySealer, pairing::ClientKey};
        let install = tempfile::tempdir().unwrap();
        let store = install.path().join("pairing");
        let original = ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap().public_hex().to_string();
        assert_eq!(ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap().public_hex(), original);
        std::fs::remove_dir_all(&store).unwrap();
        let fresh = ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap().public_hex().to_string();
        assert_ne!(fresh, original);
        assert_eq!(ClientKey::load_or_create_sealed(&store, &MemorySealer).unwrap().public_hex(), fresh);
    }
}
