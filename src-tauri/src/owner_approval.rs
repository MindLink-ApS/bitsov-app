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
    // Keep the renderer body unchanged, but refuse malformed requests locally.
    // Serde also accepts positional arrays, but the request contract uses objects.
    if !body.is_object() || !body["terms"].is_object() {
        return Err(ActionError::new(
            "approval_invalid",
            "Invalid owner approval request.",
        ));
    }
    serde_json::from_value::<ApprovalRequest>(body.clone()).map_err(|_| {
        ActionError::new("approval_invalid", "Invalid owner approval request.")
    })?;
    // TypeScript's optional fields may be absent, but none of its terms are
    // nullable. Serde's Option otherwise treats explicit null as omission.
    if body["terms"]
        .as_object()
        .is_some_and(|terms| terms.values().any(Value::is_null))
    {
        return Err(ActionError::new(
            "approval_invalid",
            "Invalid owner approval request.",
        ));
    }
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

fn registered_key(state: &NodeState) -> Result<(DeviceSigningKey, String), ActionError> {
    let (blob, record) = local_key(state, &device_store(state)?)?
        .ok_or_else(|| device_error(device_key::DeviceKeyError::Invalid))?;
    Ok((blob, registered_key_id(&record)?))
}

fn registered_key_id(record: &device::Record) -> Result<String, ActionError> {
    let public = hex::decode(&record.public_key)
        .map_err(|_| device_error(device_key::DeviceKeyError::Invalid))?;
    let derived = device::key_id(&public);
    if !record.registered || record.key_id.as_deref() != Some(derived.as_str()) {
        return Err(refusal(
            403,
            r#"{"error":"This pairing has no enrolled owner device key."}"#,
        ));
    }
    Ok(derived)
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
#[serde(tag = "kind", content = "terms", rename_all = "snake_case", deny_unknown_fields)]
enum ApprovalRequest {
    BreakerReset {},
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
    let attribution = format!(
        " · Requested by app {}",
        short_key(&terms.client_pubkey)
    );
    let available = 300 - attribution.encode_utf16().count();
    // Renderer approvalReason / termLines, without petnames. Both use UTC for
    // expiry so locale and timezone differences cannot change the prompt.
    let lines = match terms.request {
        ApprovalRequest::BreakerReset {} => breaker_lines(view, Some(available))?,
        ApprovalRequest::SpendGrant {
            budget_msat,
            per_call_max_msat,
            window_secs,
            recipient,
        } => vec![
            "Let this app spend".into(),
            format!("Budget: up to {}", sats(budget_msat)),
            format!("Each payment: up to {}", sats(per_call_max_msat)),
            // The node caps every non-call payment at 6 sats, whatever is signed.
            format!("Messages: up to {} each", sats(per_call_max_msat.min(grant::MESSAGING_PER_CALL_MAX_MSAT))),
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
    Ok(format!("{}{attribution}", lines.join(" · ")))
}

fn breaker_lines(view: &Value, available: Option<usize>) -> Result<Vec<String>, ActionError> {
    #[derive(Deserialize)]
    struct Snapshot {
        tripped: Vec<String>,
        budget_msat: u64,
        remaining_msat: u64,
        per_call_max_msat: u64,
        grant_expires_at: i64,
        resets_last_day: u64,
    }
    let mut lines = vec!["Reset this app’s paused spending".into()];
    let snapshot = &view["breaker_reset"];
    // Match the renderer's missing-snapshot fallback. The snapshot belongs to
    // the view, never to request.terms (which is the unchanged empty object).
    if !snapshot["tripped"].is_array() || !snapshot["remaining_msat"].is_number() {
        lines.push("Your node did not include the grant’s state".into());
        return Ok(lines);
    }
    let snapshot: Snapshot = serde_json::from_value(snapshot.clone())
        .map_err(|_| ActionError::new("node", "Your node returned unreadable breaker reset terms."))?;
    let trips: Vec<String> = snapshot.tripped.iter().map(|trip| match trip.as_str() {
        "grant_paused" => "paused after failed payments".into(),
        "rate_limit_minute" => "too many payments this minute".into(),
        "rate_limit_hour" => "too many payments this hour".into(),
        "velocity_limit" => "spending too fast".into(),
        other => safe_trip_code(other),
    }).collect();
    lines.extend([
        format!("Tripped: {}", if trips.is_empty() { "nothing".into() } else { trips.join(", ") }),
        format!("Budget: up to {}, {} left", sats(snapshot.budget_msat), sats(snapshot.remaining_msat)),
        format!("Each payment: up to {}", sats(snapshot.per_call_max_msat)),
        format!("Grant ends: {}", approval_date(snapshot.grant_expires_at)?),
        format!("Device resets in the last day: {} of 3", snapshot.resets_last_day),
    ]);
    if let Some(available) = available {
        if lines.join(" · ").encode_utf16().count() > available {
            // Match approvalReason: preserve all amounts, expiry and attribution;
            // shorten only the trip list, keeping complete Unicode descriptions.
            lines[1] = format!("Tripped: {}", if trips.is_empty() { "nothing".into() } else { format!("+{} more", trips.len()) });
            // Extreme amounts may also require omitting the informational reset
            // count from the prompt (it remains in the full terms view).
            if lines.join(" · ").encode_utf16().count() > available { lines.pop(); }
            let mut prefix = String::new();
            for (i, trip) in trips.iter().enumerate() {
                if i > 0 { prefix.push_str(", "); }
                prefix.push_str(trip);
                let remaining = trips.len() - i - 1;
                let suffix = if remaining > 0 { format!(", +{remaining} more") } else { String::new() };
                let candidate = format!("Tripped: {prefix}{suffix}");
                if lines.join(" · ").encode_utf16().count() - lines[1].encode_utf16().count() + candidate.encode_utf16().count() > available { break; }
                lines[1] = candidate;
            }
        }
    }
    Ok(lines)
}

// Display-only, mirrored in ownerApproval.ts; never applied to approval_message.
fn safe_trip_code(code: &str) -> String {
    code.chars().filter(|c| !matches!(c,
        '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}' | '\u{00ad}' | '\u{061c}' |
        '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}'
    )).map(|c| match c {
        '·' => '/',
        ':' | '：' | '﹕' | '꞉' | '∶' => '=',
        other => other,
    }).collect()
}

fn approval_date(seconds: i64) -> Result<String, ActionError> {
    chrono::DateTime::from_timestamp(seconds, 0)
        .map(|date| date.format("%Y-%m-%d %H:%M:%S UTC").to_string())
        .ok_or_else(|| ActionError::new("node", "Your node returned an invalid grant expiry."))
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
// Display only; the node-owned approval_message is checked and signed verbatim.
// Match ownerApproval.ts in every language: grouped whole sats or integer msat.
fn sats(msat: u64) -> String {
    bitsov_app::format::grouped_amount(msat)
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
