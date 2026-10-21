//! Owner-side N-2DEV orchestration. Uses the same device key and serialized setup lock.
use super::*;
use crate::home_node;
use bitsov_app::second_device::{self as protocol, Pending};

#[derive(Default)]
pub(super) struct Session {
    uri: Option<Zeroizing<String>>,
    ticket_id: Option<String>,
    expires_at: i64,
    pending: Vec<Pending>,
}
impl Session {
    pub(super) fn is_active(&self) -> bool { self.uri.is_some() || !self.pending.is_empty() }
}
fn context(state: &NodeState, owner: &Owner) -> Result<home_node::UnlockBinding, ActionError> {
    let node = state.node_id.lock().unwrap().clone().ok_or_else(|| refusal(403))?;
    let token = state.token.lock().unwrap().clone().ok_or_else(|| refusal(403))?;
    home_node::UnlockBinding::from_session(&node, &owner.binding.client_id, &token).map_err(|_| refusal(403))
}
fn validate(p: &Pending, owner: &Owner, ctx: &home_node::UnlockBinding) -> Result<(), ActionError> {
    p.validate(&owner.binding.node, &owner.binding.client_id, ctx.epoch, &owner.key_id, now_unix()).map_err(invalid)?;
    if p.public_key == owner.record.public_key { return Err(refusal(403)); }
    Ok(())
}
fn view(session: &Session) -> View {
    if session.uri.is_none() && session.pending.is_empty() {
        return View::Ready { owner: true, second_device: true };
    }
    View::Ticket {
        uri: session.uri.as_ref().filter(|_| session.expires_at > now_unix() && session.pending.is_empty()).map(|u| u.to_string()).unwrap_or_default(),
        expires_at: session.expires_at,
        second_device: true,
        pending: session.pending.iter().map(|p| Comparison {
            op_id: p.op_id.clone(), name: p.name.clone(), words: p.sas_words.clone(),
            expires_at: p.expires_at, can_approve: p.can_approve(session.ticket_id.as_deref()),
        }).collect(),
    }
}
pub(super) async fn run(state: &NodeState, setup: &mut Setup, input: Input) -> Result<View, ActionError> {
    if matches!(input, Input::Cancel) {
        setup.second = None;
        return Ok(View::Ready { owner: key_id(state).is_some(), second_device: true });
    }
    if !node_offers(state, protocol::CAPABILITY).await {
        setup.second = None;
        return Ok(View::Unsupported);
    }
    let owner = match owner(state).await {
        Ok(owner) => owner,
        Err(_) if matches!(input, Input::Status) => return Ok(View::Ready { owner: false, second_device: true }),
        Err(e) => return Err(e),
    };
    let ctx = context(state, &owner)?;
    let session = setup.second.get_or_insert_with(Session::default);
    let reject = matches!(input, Input::Reject { .. });
    match input {
        Input::Status | Input::Poll => {
            #[derive(Deserialize)]
            struct List { pending: Vec<serde_json::Value> }
            let text = request(state, reqwest::Method::GET, &format!("/pair/device-key/pending?approver_key_id={}", owner.key_id), None).await?;
            let list: List = decode_act("pending second devices", &text)?;
            let mut pending = Vec::new();
            for value in list.pending {
                if value["sas_version"] != 2 || value["approval_message"].is_null() { continue; }
                let p: Pending = serde_json::from_value(value).map_err(|_| invalid("Invalid second-device comparison."))?;
                validate(&p, &owner, &ctx)?;
                pending.push(p);
            }
            if !pending.is_empty() {
                if let Some(uri) = &mut session.uri { uri.clear(); }
            }
            session.pending = pending;
            Ok(view(session))
        }
        Input::Mint => {
            if session.uri.is_some() { return Err(invalid("Close the current ticket before creating another.")); }
            #[derive(Deserialize)]
            struct Challenge { nonce: String, message: String }
            let text = request(state, reqwest::Method::GET, &format!("/pair/ticket?approver_key_id={}", owner.key_id), None).await?;
            let challenge: Challenge = decode_act("ticket challenge", &text)?;
            if ticket_message(&owner.binding.node, &challenge.nonce).map_err(invalid)? != challenge.message {
                return Err(invalid("Invalid ticket challenge. Nothing was signed."));
            }
            let message = protocol::ticket_message(&owner.binding.node, &challenge.nonce).map_err(invalid)?;
            let signature = device_sign(owner.blob, message, "create a one-use second-device ticket".into()).await?;
            #[derive(Deserialize)]
            struct Issued { uri: String, expires_at: i64 }
            let text = request(state, reqwest::Method::POST, "/pair/ticket", Some(serde_json::json!({
                "approver_key_id":owner.key_id,"nonce":challenge.nonce,"purpose":"second_device","signature":signature,
            }))).await?;
            let issued: Issued = decode_act("second-device ticket", &text)?;
            let descriptor = remote_access::parse_pairing_link(&issued.uri).map_err(|_| invalid("Invalid second-device ticket."))?;
            if Some(descriptor.node_id()) != state.node_id.lock().unwrap().as_deref()
                || issued.expires_at <= now_unix() || issued.expires_at > now_unix() + protocol::TTL {
                return Err(invalid("The ticket is expired or belongs to another node."));
            }
            session.ticket_id = descriptor.ticket_id();
            session.uri = Some(Zeroizing::new(issued.uri));
            session.expires_at = issued.expires_at;
            Ok(view(session))
        }
        Input::Approve { op_id } | Input::Reject { op_id } => {
            // `reject` is captured before the match, because op_id moves.
            let reviewed = session.pending.iter().find(|p| p.op_id == op_id).cloned()
                .ok_or_else(|| invalid("Compare the new device's four words before deciding."))?;
            validate(&reviewed, &owner, &ctx)?;
            if !reject && !reviewed.can_approve(session.ticket_id.as_deref()) {
                return Err(invalid("Approve on the device that showed the QR."));
            }
            let text = request(state, reqwest::Method::GET, &format!("/pair/device-key/{op_id}/delegation?approver_key_id={}",owner.key_id), None).await?;
            let latest: Pending = decode_act("second-device comparison", &text)?;
            if latest != reviewed { return Err(invalid("The comparison changed. Compare again before deciding.")); }
            let signature = device_sign(owner.blob.clone(), reviewed.message(reject),
                if reject { "reject the second device whose words differ" } else { "approve the second device whose four words you compared" }.into()).await?;
            validate(&reviewed, &owner, &ctx)?;
            let decision = if reject { "reject" } else { "approve" };
            let text = request(state, reqwest::Method::POST, &format!("/pair/device-key/{op_id}/second-device/{decision}"), Some(serde_json::json!({"approver_key_id":owner.key_id,"signature":signature}))).await?;
            if !reject {
                let receipt: serde_json::Value = decode_act("second-device approval", &text)?;
                let public = hex::decode(&reviewed.public_key).map_err(|_| invalid("Invalid device key."))?;
                let expected = hex::encode(&blake3::hash(&public).as_bytes()[..16]);
                if receipt["op_id"] != op_id || receipt["status"] != "registered" || receipt["key_id"] != expected {
                    return Err(invalid("The node did not confirm this device. Check the new device."));
                }
            }
            setup.second = None;
            Ok(if reject { View::Rejected } else { View::Done })
        }
        Input::Cancel => unreachable!(),
    }
}
