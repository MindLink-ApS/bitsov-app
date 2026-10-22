//! Receive-only starter response projection. No token, hub keys or routing data.
use serde::{Deserialize, Serialize};

pub const PATH: &str = "/onboarding/starter-channel";

#[derive(Debug, Deserialize, Serialize)]
pub struct Status {
    pub state: String,
    #[serde(default)]
    pub hub_configured: bool,
    pub hub_alias: Option<String>,
    pub request_id: Option<String>,
    pub detail: Option<String>,
    #[serde(default)]
    pub verified: bool,
    pub push_sats: Option<u64>,
    #[serde(default)]
    pub retry_allowed: bool,
    pub retry_after_unix: Option<i64>,
}
