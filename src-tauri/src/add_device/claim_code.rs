//! The claim code is an owner-local read, never a remote proxy request.
use super::*;

#[derive(Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum View {
    Open {
        code: Zeroizing<String>,
        expires_at: i64,
        // An enrolling device's label is not evidence and is not shown.
        #[serde(rename = "device_name", skip_serializing)]
        _device_name: String,
    },
    Claimed {},
    Closed {},
    Unavailable {},
}

fn failed() -> ActionError {
    ActionError::new("claim_code_unavailable", "The code could not be shown. Check your node connection and try again.")
}
fn owner_required() -> ActionError {
    ActionError::new("claim_code_owner_required", "Use an enrolled owner device to show the code.")
}

pub(super) async fn read(state: &NodeState) -> Result<View, ActionError> {
    // Even the app's loopback base can be a remote tunnel listener. Refuse
    // before authentication, a route probe, or any request can reach it.
    if state.remote_mode.load(Ordering::SeqCst)
        || state.remote_proxy.lock().unwrap().is_some()
        || loopback_api_port(&state.api_base).is_none()
    {
        return Err(ActionError::new("claim_code_owner_local", "Open BitSov on the owner device connected directly to your node."));
    }
    enrolled_owner(state).await.map_err(|_| owner_required())?;
    let token = state.token.lock().unwrap().clone().ok_or_else(owner_required)?;
    let response = state.http.get(format!("{}/owner/claim-code", state.api_base))
        .bearer_auth(token)
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .send().await.map_err(|_| failed())?;
    match response.status().as_u16() {
        200 => {},
        401 | 403 => return Err(owner_required()),
        404 | 405 => return Ok(View::Unavailable {}),
        429 => return Err(ActionError::new("claim_code_rate_limited", "Wait a minute before showing the code again.")),
        _ => return Err(failed()),
    }
    // No raw response body or decoder error can reach a log or the renderer.
    // Zeroize both the wire body and the code after IPC serialization.
    let body = Zeroizing::new(response.text().await.map_err(|_| failed())?);
    let view: View = serde_json::from_str(&body).map_err(|_| failed())?;
    if let View::Open { code, expires_at, .. } = &view {
        if code.len() != 18 || sas::claim_commitment(code).is_err() || *expires_at <= now_unix() {
            return Err(failed());
        }
    }
    Ok(view)
}
