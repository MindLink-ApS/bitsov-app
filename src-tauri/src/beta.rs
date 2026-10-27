//! Build-time network policy shared by desktop and mobile clients.
pub const MAINNET_DISABLED: &str = "beta_mainnet_disabled";
pub const NETWORK_UNKNOWN: &str = "beta_network_unknown";

pub fn network(network: Option<&str>) -> Result<(), String> {
    check(network, cfg!(feature = "developer-mainnet"))
}

fn check(network: Option<&str>, developer_mainnet: bool) -> Result<(), String> {
    if developer_mainnet { return Ok(()); }
    match network.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("bitcoin" | "mainnet") => Err(MAINNET_DISABLED.into()),
        Some("signet" | "testnet" | "testnet4" | "regtest" | "mock") => Ok(()),
        _ => Err(NETWORK_UNKNOWN.into()),
    }
}

/// Home-box setup accepts signet, plus regtest in development builds.
pub fn setup_network(network: &str) -> Result<(), String> {
    if cfg!(feature = "developer-mainnet") { return Ok(()); }
    match network.trim().to_ascii_lowercase().as_str() {
        "signet" => Ok(()),
        "regtest" if cfg!(debug_assertions) => Ok(()),
        "bitcoin" | "mainnet" => Err(MAINNET_DISABLED.into()),
        _ => Err(NETWORK_UNKNOWN.into()),
    }
}

pub fn status(status: &serde_json::Value) -> Result<(), String> {
    let backend = status.get("lightning_backend").and_then(|v| v.as_str());
    network(status.get("network").and_then(|v| v.as_str())
        .or_else(|| matches!(backend, Some("mock" | "shared_mock")).then_some("mock")))
}

#[cfg(all(desktop, not(feature = "mobile")))]
pub fn config(value: &toml::Value) -> Result<(), String> {
    let backend = value.get("lightning").and_then(|v| v.get("backend")).and_then(|v| v.as_str());
    let name = value.get("lightning").and_then(|v| v.get("network")).and_then(|v| v.as_str());
    network(match (backend, name) {
        (_, Some(name)) => Some(name),
        (Some("mock" | "shared_mock"), None) => Some("mock"),
        (Some("ldk") | None, None) => Some("bitcoin"),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn beta_refuses_mainnet_aliases_and_unknown_networks() {
        for name in ["bitcoin", "mainnet", "MAINNET", " bitcoin "] {
            assert_eq!(check(Some(name), false).unwrap_err(), MAINNET_DISABLED);
        }
        for name in [None, Some(""), Some("unknown")] {
            assert_eq!(check(name, false).unwrap_err(), NETWORK_UNKNOWN);
        }
        for name in ["signet", "testnet", "testnet4", "regtest", "mock"] {
            check(Some(name), false).unwrap();
        }
        check(Some("mainnet"), true).unwrap();
        check(None, true).unwrap();
    }
    #[test]
    fn build_flag_controls_mainnet_access() {
        assert_eq!(network(Some("bitcoin")).is_ok(), cfg!(feature = "developer-mainnet"));
        assert_eq!(network(None).is_ok(), cfg!(feature = "developer-mainnet"));
    }
    #[cfg(all(desktop, not(feature = "mobile")))]
    #[test]
    fn default_build_checks_explicit_network_even_for_mock_backends() {
        if cfg!(feature = "developer-mainnet") { return; }
        for backend in ["ldk", "mock", "lnd"] {
            let value: toml::Value = toml::from_str(&format!("[lightning]\nbackend='{backend}'\nnetwork='bitcoin'\n")).unwrap();
            assert_eq!(config(&value).unwrap_err(), MAINNET_DISABLED);
        }
    }
}
