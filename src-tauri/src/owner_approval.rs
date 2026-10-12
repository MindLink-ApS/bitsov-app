//! Owner approval v1. Uses the existing paired API and its authenticated Noise
//! proxy; the renderer supplies only the request or the exact text it displayed.
use super::*;
use serde_json::Value;

fn clean(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() && !matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
        .take(160)
        .collect()
}

fn refusal(status: u16, body: &str) -> ActionError {
    let value: Value = serde_json::from_str(body).unwrap_or_default();
    let reason = value["reason"].as_str();
    let code = match status {
        403 if reason.is_some_and(|r| device::NODE_OFF_REASONS.contains(&r)) => "approval_off",
        403 => "approval_forbidden",
        409 if value["code"] == "budget_exceeded" => "approval_budget_exceeded",
        409 => "approval_expired",
        404 => "approval_unknown",
        429 => "approval_rate_limited",
        400 => "approval_invalid",
        500 => "approval_unsaved",
        _ => "node",
    };
    // Never echo an arbitrary response body (HTML, tokens, or protocol data).
    let message = value["error"]
        .as_str()
        .map(clean)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("Your node refused the approval request ({status})."));
    let mut error = ActionError::new(code, message);
    if matches!(code, "approval_off" | "approval_budget_exceeded") {
        error.reason = reason.map(clean);
    }
    if code == "approval_budget_exceeded" {
        error.remaining_msat = value["remaining_msat"].as_u64();
    }
    error
}

async fn request(
    state: &NodeState,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, ActionError> {
    let (status, text) = call_api(state, method, path, body)
        .await
        .map_err(|_| ActionError::new("node", "Could not reach your node for owner approval."))?;
    if !status.is_success() {
        return Err(refusal(status.as_u16(), &text));
    }
    serde_json::from_str(&text).map_err(|_| {
        ActionError::new(
            "node",
            "Your node returned an unreadable approval response.",
        )
    })
}

fn operation_path(op_id: &str) -> Result<String, ActionError> {
    // UUIDs are path segments, never renderer-controlled routes or queries.
    if op_id.len() != 36
        || !op_id.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return Err(ActionError::new(
            "approval_invalid",
            "Invalid approval operation id.",
        ));
    }
    Ok(format!("/pair/approval/{op_id}"))
}

pub async fn create(state: &NodeState, body: Value) -> Result<Value, ActionError> {
    request(
        state,
        reqwest::Method::POST,
        "/pair/approval-request",
        Some(body),
    )
    .await
}

pub async fn status(state: &NodeState, op_id: &str) -> Result<Value, ActionError> {
    request(state, reqwest::Method::GET, &operation_path(op_id)?, None).await
}

pub async fn device_keys(state: &NodeState) -> Result<Value, ActionError> {
    request(state, reqwest::Method::GET, "/pair/device-keys", None).await
}

fn remote_client(state: &NodeState) -> Result<String, ActionError> {
    if !state.remote_mode.load(Ordering::SeqCst) {
        return Err(refusal(
            403,
            r#"{"error":"Owner approval requires this device's Noise session."}"#,
        ));
    }
    let client = match &*state.auth.lock().unwrap() {
        AuthMode::Paired(session) => session.client_id.clone(),
        _ => {
            return Err(refusal(
                403,
                r#"{"error":"Owner approval requires a paired device."}"#,
            ))
        }
    };
    if state.remote_proxy.lock().unwrap().is_none() {
        return Err(ActionError::new(
            "node",
            "The device's Noise session is not connected.",
        ));
    }
    Ok(client)
}

fn registered_key(state: &NodeState) -> Result<(Vec<u8>, String), ActionError> {
    let (blob, record) = local_key(&device_store(state)?)
        .ok_or_else(|| device_error(device_key::DeviceKeyError::Invalid))?;
    let key_id = record
        .key_id
        .filter(|id| record.registered && bitsov_app::delegation::canonical_hex(id, 16))
        .ok_or_else(|| {
            refusal(
                403,
                r#"{"error":"This pairing has no enrolled owner device key."}"#,
            )
        })?;
    Ok((blob, key_id))
}

async fn pending_for(state: &NodeState, key_id: &str) -> Result<Vec<Value>, ActionError> {
    #[derive(Deserialize)]
    struct Pending {
        pending: Vec<Value>,
    }
    let value = request(
        state,
        reqwest::Method::GET,
        &format!("/pair/approvals/pending?approver_key_id={key_id}"),
        None,
    )
    .await?;
    serde_json::from_value::<Pending>(value)
        .map(|p| p.pending)
        .map_err(|_| {
            ActionError::new(
                "node",
                "Your node returned an unreadable pending approval list.",
            )
        })
}

pub async fn pending(state: &NodeState) -> Result<Vec<Value>, ActionError> {
    let _connection = state.remote_recovery.lock().await;
    remote_client(state)?;
    let (_, key_id) = registered_key(state)?;
    pending_for(state, &key_id).await
}

pub async fn approve(
    state: &NodeState,
    op_id: &str,
    displayed_message: &str,
) -> Result<Value, ActionError> {
    let path = operation_path(op_id)?;
    let _connection = state.remote_recovery.lock().await;
    let _device = state.add_device.lock().await;
    let client = remote_client(state)?;
    let (blob, key_id) = registered_key(state)?;
    // GET /approval/{id} is requester-only. Owners must re-read via pending,
    // authenticated with their own key and pairing over the existing proxy.
    let fresh = pending_for(state, &key_id)
        .await?
        .into_iter()
        .find(|v| v["op_id"] == op_id);
    let view = match fresh {
        Some(view) => view,
        None => {
            // Pending excludes this pairing's own ops. Its requester-only read
            // lets us give the specified self refusal, still over Noise.
            let own = status(state, op_id).await?;
            checked_approval(&own, &client, displayed_message)?;
            return Err(refusal(
                404,
                r#"{"error":"The approval is no longer pending."}"#,
            ));
        }
    };
    let signature = sign_checked(&view, &client, displayed_message, |message, reason| {
        device_sign(blob, message, reason)
    })
    .await?;
    // Refresh may occur during the biometric prompt. Never submit under a
    // different pairing; the node also enforces key, epoch and operation binding.
    if remote_client(state)? != client {
        return Err(refusal(
            403,
            r#"{"error":"The device pairing changed during approval."}"#,
        ));
    }
    request(
        state,
        reqwest::Method::POST,
        &format!("{path}/approve"),
        Some(serde_json::json!({"approver_key_id":key_id, "signature":signature})),
    )
    .await
}

/// Keep the refusal checks before even invoking the biometric signer.
async fn sign_checked<F, Fut>(
    view: &Value,
    client: &str,
    displayed: &str,
    sign: F,
) -> Result<String, ActionError>
where
    F: FnOnce(String, String) -> Fut,
    Fut: std::future::Future<Output = Result<String, ActionError>>,
{
    let reason = checked_approval(view, client, displayed)?;
    let message = view["approval_message"]
        .as_str()
        .expect("checked message")
        .to_owned();
    sign(message, reason).await
}

#[derive(Deserialize)]
#[serde(tag = "kind", content = "terms", rename_all = "snake_case")]
enum ApprovalRequest {
    SpendGrant {
        budget_msat: u64,
        per_call_max_msat: u64,
        window_secs: i64,
        recipient: Option<String>,
    },
    FirstContact {
        recipient: String,
        max_total_msat: u64,
        budget_msat: Option<u64>,
    },
}

fn checked_approval(view: &Value, client: &str, displayed: &str) -> Result<String, ActionError> {
    if view["approval_message"].as_str().map(str::as_bytes) != Some(displayed.as_bytes()) {
        return Err(ActionError::new(
            "approval_changed",
            "The request changed after it was shown. Nothing was signed.",
        ));
    }
    if view["client_id"].as_str() == Some(client) {
        return Err(ActionError::new(
            "approval_self",
            "This pairing cannot approve its own request.",
        ));
    }
    #[derive(Deserialize)]
    struct Terms {
        client_id: String,
        client_pubkey: String,
        request: ApprovalRequest,
    }
    let terms: Terms = serde_json::from_value(view.clone())
        .map_err(|_| ActionError::new("node", "Your node returned unreadable approval terms."))?;
    if terms.client_id.is_empty() {
        return Err(ActionError::new(
            "node",
            "Your node returned no approval requester.",
        ));
    }
    // Exact equivalent of renderer approvalReason / termLines (without petnames).
    let mut lines = match terms.request {
        ApprovalRequest::SpendGrant {
            budget_msat,
            per_call_max_msat,
            window_secs,
            recipient,
        } => vec![
            "Let this app spend".into(),
            format!("Budget: up to {}", sats(budget_msat)),
            format!("Each payment: up to {}", sats(per_call_max_msat)),
            format!("For: {}", span(window_secs)),
            recipient
                .filter(|s| !s.is_empty())
                .map(|r| format!("Only to: {}", short_key(&r)))
                .unwrap_or_else(|| "To: any contact, within the budget".into()),
        ],
        ApprovalRequest::FirstContact {
            recipient,
            max_total_msat,
            budget_msat,
        } => {
            let mut lines = vec![
                "Let this app message someone new".into(),
                format!("To: {}", short_key(&recipient)),
                format!("First message: up to {}", sats(max_total_msat)),
            ];
            // The renderer tests !== undefined: a JSON null is present and
            // its numeric conversion is zero; omission produces no line.
            if view["request"]["terms"].get("budget_msat").is_some() {
                lines.push(format!(
                    "Contact budget: up to {}",
                    sats(budget_msat.unwrap_or(0))
                ));
            }
            lines
        }
    };
    lines.push(format!(
        "Requested by app {}",
        short_key(&terms.client_pubkey)
    ));
    Ok(lines.join(" · "))
}

fn short_key(key: &str) -> String {
    let key: String = key
        .chars()
        .filter(char::is_ascii_hexdigit)
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if key.len() <= 12 {
        key
    } else {
        format!("{}…{}", &key[..6], &key[key.len() - 6..])
    }
}
fn sats(msat: u64) -> String {
    let whole = (msat / 1000).to_string();
    let mut value = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            value.push(',');
        }
        value.push(c);
    }
    if msat % 1000 != 0 {
        value.push_str(format!(".{:03}", msat % 1000).trim_end_matches('0'));
    }
    format!("{value} {}", if msat == 1000 { "sat" } else { "sats" })
}
fn span(secs: i64) -> String {
    if secs % 3600 == 0 {
        format!("{} h", secs / 3600)
    } else if secs % 60 == 0 {
        format!("{} min", secs / 60)
    } else {
        format!("{secs} s")
    }
}

#[cfg(test)]
#[path = "owner_approval_tests.rs"]
mod tests;
