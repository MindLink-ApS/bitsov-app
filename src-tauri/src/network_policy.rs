use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NetworkRefusal {
    #[default]
    None,
    Mainnet,
    Unknown,
    Other,
    #[cfg_attr(feature = "mobile", allow(dead_code))]
    LocalUnavailable,
}

impl NetworkRefusal {
    pub(crate) fn reported(network: Option<&str>) -> Result<(), Self> {
        match network {
            Some("signet") => Ok(()),
            Some("bitcoin" | "mainnet") => Err(Self::Mainnet),
            None | Some("") => Err(Self::Unknown),
            Some(_) => Err(Self::Other),
        }
    }

    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::None => "",
            Self::Mainnet => "This test version requires a signet node.",
            Self::Unknown | Self::Other => "This test version could not confirm a signet node.",
            Self::LocalUnavailable => "This test version cannot create a local node yet. Connect to a signet node.",
        }
    }
}

#[cfg(all(desktop, not(feature = "mobile")))]
pub(crate) fn check_config(config: &std::path::Path) -> Result<(), NetworkRefusal> {
    let text = std::fs::read_to_string(config).map_err(|_| NetworkRefusal::Unknown)?;
    let value: toml::Value = toml::from_str(&text).map_err(|_| NetworkRefusal::Unknown)?;
    if value.get("node").and_then(|v| v.get("allow_mainnet")).and_then(|v| v.as_bool()) == Some(true) {
        return Err(NetworkRefusal::Mainnet);
    }
    let lightning = value.get("lightning").ok_or(NetworkRefusal::Unknown)?;
    if lightning.get("backend").and_then(|v| v.as_str()) != Some("ldk") {
        return Err(NetworkRefusal::Unknown);
    }
    NetworkRefusal::reported(lightning.get("network").and_then(|v| v.as_str()))
}
