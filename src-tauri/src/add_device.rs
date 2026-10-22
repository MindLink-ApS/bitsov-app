//! Owner delegation and joining-device enrollment. Signing keys and claim validation stay in the host.
use super::*;
use bitsov_app::{
    delegation::{
        canonical_hex, expiry_deadline, ticket_message, valid_expiry, PendingDevice,
        ENROLLMENT_TTL_SECS, OP_ID_BYTES, TICKET_TTL_SECS,
    },
    sas,
};
use zeroize::Zeroizing;
#[path = "add_device/second.rs"]
mod second;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Input {
    Status,
    Mint,
    Poll,
    Approve { op_id: String },
    Reject { op_id: String },
    Cancel,
}
#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum View {
    Unsupported,
    Ready {
        owner: bool,
        second_device: bool,
    },
    Ticket {
        uri: String,
        second_device: bool,
        expires_at: i64,
        pending: Vec<Comparison>,
    },
    Done,
    Rejected,
}
#[derive(Serialize)]
pub struct Comparison {
    can_approve: bool,
    op_id: String,
    name: String,
    words: [String; 4],
    expires_at: i64,
}
struct Ticket {
    uri: Zeroizing<String>,
    expires_at: i64,
    node: String,
    client: String,
    key_id: String,
    pending: Vec<PendingDevice>,
}
#[derive(Default)]
pub struct Setup {
    second: Option<second::Session>,
    ticket: Option<Ticket>,
    join: Option<Joining>,
}

impl Setup {
    pub fn is_active(&self) -> bool { self.ticket.is_some() || self.second.as_ref().is_some_and(second::Session::is_active) || self.join.is_some() }
}

fn refusal(status: u16) -> ActionError {
    let message = match status {
        403 => "Only an enrolled owner device can add devices. This pairing or approval key is not authorized, or was revoked.",
        404 | 405 => "This node does not support this device request, or the request expired, was used, or was cancelled. Start again.",
        409 | 410 => "This ticket or device request expired, was already used, or the node restarted. Start again with a new ticket.",
        429 => "Too many device requests. Wait before trying again; the node allows five tickets in 15 minutes.",
        _ => "The node did not confirm the device request. Check the connection before trying again.",
    };
    ActionError::new("device_pairing", message)
}
fn invalid(message: &str) -> ActionError {
    ActionError::new("device_pairing", message)
}
async fn request(
    state: &NodeState,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<String, ActionError> {
    let (status, text) = call_api(state, method, path, body).await.map_err(|_| {
        invalid("The connection was lost. Check the new device before trying again.")
    })?;
    if !status.is_success() {
        return Err(refusal(status.as_u16()));
    }
    Ok(text)
}
fn key_id(state: &NodeState) -> Option<String> {
    device_store(state)
        .ok()
        .and_then(|store| device::load_record(&store))
        .filter(|r| r.registered)
        .and_then(|r| r.key_id)
        .filter(|id| canonical_hex(id, 16))
}
/// A read-only route probe; 403 means supported but not owner-authorized. A 404
/// (old node) never offers the action. No challenge or ticket is minted by polling.
pub async fn supported(state: &NodeState) -> Result<bool, ActionError> {
    if !state.remote_mode.load(Ordering::SeqCst) {
        return Ok(false);
    }
    let id = key_id(state).unwrap_or_else(|| "0".repeat(32));
    let (status, body) = call_api(
        state,
        reqwest::Method::GET,
        &format!("/pair/device-key/pending?approver_key_id={id}"),
        None,
    )
    .await
    .map_err(|_| invalid("Could not check whether this node supports adding devices."))?;
    match status.as_u16() {
        // An old router captures "pending" as an operation id and returns
        // {status:"lost"} with 200. Only the new list shape proves support.
        200 => Ok(serde_json::from_str::<PendingList>(&body).is_ok()),
        403 => Ok(true),
        404 | 405 => Ok(false),
        _ => Err(refusal(status.as_u16())),
    }
}
fn check_binding(state: &NodeState, binding: &DeviceBinding) -> Result<(), ActionError> {
    let node = state
        .node_id
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| invalid("Reconnect to your home node first."))?;
    let client = match &*state.auth.lock().unwrap() {
        AuthMode::Paired(session) => session.client_id.clone(),
        _ => return Err(refusal(403)),
    };
    if binding.node != bitsov_app::home_node::identity_fingerprint(&node)
        || binding.client_id != client
    {
        return Err(invalid(
            "The node or pairing changed. Nothing was signed; reconnect before starting again.",
        ));
    }
    Ok(())
}
struct Owner {
    blob: Vec<u8>,
    record: device::Record,
    binding: DeviceBinding,
    key_id: String,
}
async fn owner(state: &NodeState) -> Result<Owner, ActionError> {
    if !state.remote_mode.load(Ordering::SeqCst) {
        return Err(refusal(403));
    }
    let (blob, record) = local_key(state, &device_store(state)?)?
        .filter(|(_, r)| r.registered)
        .ok_or_else(|| refusal(403))?;
    let key_id = record
        .key_id
        .clone()
        .filter(|id| canonical_hex(id, 16))
        .ok_or_else(|| refusal(403))?;
    let binding = device_binding(state).await?;
    check_binding(state, &binding)?;
    if binding
        .device_approvals
        .as_deref()
        .is_some_and(|v| v != "enabled")
        || !binding.device_keys.iter().any(|k| k.key_id == key_id)
    {
        return Err(refusal(403));
    }
    Ok(Owner {
        blob,
        record,
        binding,
        key_id,
    })
}
async fn ready(state: &NodeState) -> Result<View, ActionError> {
    if !supported(state).await? {
        return Ok(View::Unsupported);
    }
    Ok(View::Ready {
        second_device: false,
        owner: owner(state).await.is_ok(),
    })
}
#[derive(Deserialize)]
struct PendingList {
    pending: Vec<PendingDevice>,
}
async fn pending(state: &NodeState, owner: &Owner) -> Result<Vec<PendingDevice>, ActionError> {
    let text = request(
        state,
        reqwest::Method::GET,
        &format!("/pair/device-key/pending?approver_key_id={}", owner.key_id),
        None,
    )
    .await?;
    let list: PendingList = decode_act("device comparison", &text)?;
    let mut confirmed = Vec::new();
    for p in list.pending {
        // The node exposes an operation while the joining device is still
        // doing its second biometric signature. Do not show approvable words yet.
        if p.delegation_message.is_none() {
            continue;
        }
        p.validate(&owner.binding.node, &owner.binding.client_id, now_unix())
            .map_err(invalid)?;
        confirmed.push(p);
    }
    Ok(confirmed)
}
fn ticket_view(t: &Ticket) -> View {
    View::Ticket {
        second_device: false,
        uri: if expiry_deadline(t.expires_at) > now_unix() && t.pending.is_empty() {
            t.uri.to_string()
        } else {
            String::new()
        },
        // The renderer must use the same local deadline as host validation.
        expires_at: expiry_deadline(t.expires_at),
        pending: t
            .pending
            .iter()
            .map(|p| Comparison {
                can_approve: true,
                op_id: p.op_id.clone(),
                name: p
                    .name
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(80)
                    .collect(),
                words: p.sas_words.clone(),
                expires_at: expiry_deadline(p.expires_at),
            })
            .collect(),
    }
}
pub async fn run(state: &NodeState, input: Input) -> Result<View, ActionError> {
    let _connection = state.remote_recovery.lock().await;
    let mut setup = state.add_device.lock().await;
    if setup.second.is_some() || node_offers(state, bitsov_app::second_device::CAPABILITY).await {
        return second::run(state, &mut setup, input).await;
    }
    if matches!(input, Input::Reject { .. }) { return Err(invalid("This node does not support second-device rejection.")); }
    if matches!(input, Input::Cancel) {
        setup.ticket = None;
        return Ok(View::Ready {
            second_device: false,
            owner: key_id(state).is_some(),
        });
    }
    if matches!(input, Input::Status) {
        if let Some(t) = &setup.ticket {
            return Ok(ticket_view(t));
        }
        return ready(state).await;
    }
    let owner = owner(state).await?;
    if let Some(t) = &setup.ticket {
        if t.node != owner.binding.node
            || t.client != owner.binding.client_id
            || t.key_id != owner.key_id
        {
            setup.ticket = None;
            return Err(invalid("The owner pairing changed. Start again."));
        }
    }
    match input {
        Input::Mint => {
            if setup.ticket.is_some() {
                return Err(invalid("Close the current ticket before creating another."));
            }
            #[derive(Deserialize)]
            struct Challenge {
                nonce: String,
                message: String,
            }
            let text = request(
                state,
                reqwest::Method::GET,
                &format!("/pair/ticket?approver_key_id={}", owner.key_id),
                None,
            )
            .await?;
            let challenge: Challenge = decode_act("ticket challenge", &text)?;
            let message = ticket_message(&owner.binding.node, &challenge.nonce).map_err(invalid)?;
            if message != challenge.message {
                return Err(invalid("Invalid ticket challenge. Nothing was signed."));
            }
            let signature = device_sign(
                owner.blob,
                message,
                "create a one-use ticket to add a device to your BitSov node".into(),
            )
            .await?;
            #[derive(Deserialize)]
            struct Issued {
                uri: String,
                expires_at: i64,
            }
            let text = request(state, reqwest::Method::POST, "/pair/ticket", Some(serde_json::json!({
                "approver_key_id": owner.key_id, "nonce": challenge.nonce, "signature": signature,
            }))).await?;
            let issued: Issued = decode_act("pairing ticket", &text)?;
            let descriptor = remote_access::parse_pairing_link(&issued.uri)
                .map_err(|_| invalid("The node returned an invalid pairing ticket."))?;
            if Some(descriptor.node_id()) != state.node_id.lock().unwrap().as_deref()
                || !valid_expiry(issued.expires_at, now_unix(), TICKET_TTL_SECS)
            {
                return Err(invalid(
                    "The node returned a ticket for a different node or with an invalid expiry.",
                ));
            }
            let t = Ticket {
                uri: Zeroizing::new(issued.uri),
                expires_at: issued.expires_at,
                node: owner.binding.node,
                client: owner.binding.client_id,
                key_id: owner.key_id,
                pending: Vec::new(),
            };
            let view = ticket_view(&t);
            setup.ticket = Some(t);
            Ok(view)
        }
        Input::Poll => {
            let t = setup
                .ticket
                .as_mut()
                .ok_or_else(|| invalid("Create a ticket first."))?;
            t.pending = pending(state, &owner).await?;
            if !t.pending.is_empty() || expiry_deadline(t.expires_at) <= now_unix() {
                t.uri.clear();
            }
            Ok(ticket_view(t))
        }
        Input::Approve { op_id } => {
            let reviewed = setup
                .ticket
                .as_ref()
                .and_then(|t| t.pending.iter().find(|p| p.op_id == op_id))
                .cloned()
                .ok_or_else(|| invalid("Compare the new device's four words before approving."))?;
            let message = reviewed
                .validate(&owner.binding.node, &owner.binding.client_id, now_unix())
                .map_err(invalid)?
                .to_string();
            if reviewed.public_key == owner.record.public_key {
                return Err(refusal(403));
            }
            let path = format!(
                "/pair/device-key/{op_id}/delegation?approver_key_id={}",
                owner.key_id
            );
            let latest: PendingDevice = decode_act(
                "device comparison",
                &request(state, reqwest::Method::GET, &path, None).await?,
            )?;
            if latest != reviewed {
                return Err(invalid(
                    "The device comparison changed. Close this ticket and compare again.",
                ));
            }
            let signature = device_sign(
                owner.blob,
                message,
                "approve the new BitSov device whose four words you compared".into(),
            )
            .await?;
            reviewed
                .validate(&owner.binding.node, &owner.binding.client_id, now_unix())
                .map_err(invalid)?;
            let text = request(
                state,
                reqwest::Method::POST,
                &format!("/pair/device-key/{op_id}/delegate"),
                Some(serde_json::json!({
                    "approver_key_id":owner.key_id, "signature":signature,
                })),
            )
            .await?;
            #[derive(Deserialize)]
            struct Receipt {
                op_id: String,
                key_id: String,
                status: String,
            }
            let receipt: Receipt = decode_act("device approval", &text)?;
            let expected = hex::encode(
                &blake3::hash(
                    &hex::decode(&reviewed.public_key)
                        .map_err(|_| invalid("Invalid device key."))?,
                )
                .as_bytes()[..16],
            );
            if receipt.op_id != op_id
                || receipt.status != "registered"
                || receipt.key_id != expected
            {
                return Err(invalid("The node did not confirm this device. Check the new device before trying again."));
            }
            setup.ticket = None;
            Ok(View::Done)
        }
        Input::Status | Input::Cancel | Input::Reject { .. } => unreachable!(),
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum JoinInput {
    Status,
    Start { claim_code: Zeroizing<String> },
    StartSecond {},
    Poll,
    Cancel,
}
#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum JoinView {
    Idle { second_device: bool },
    Waiting {
        second_device: bool,
        words: [&'static str; 4],
        expires_at: i64,
    },
    Done { second_device: bool },
}
struct Joining {
    op_id: String,
    store: PathBuf,
    public_key: String,
    words: [&'static str; 4],
    expires_at: i64,
    deadline: Instant,
    second_device: bool,
}
impl Joining {
    fn view(&self) -> JoinView {
        JoinView::Waiting {
            second_device: self.second_device,
            words: self.words,
            expires_at: if self.second_device { self.expires_at } else { expiry_deadline(self.expires_at) },
        }
    }
}

fn enrollment_refusal(status: u16, finalizing: bool) -> ActionError {
    let mut error = invalid(match status {
        403 if finalizing => "The comparison could not be verified. Check the 18-character claim code shown at your node's owner console with `konsensus claim-code --show`, or on a BitSov box's sticker. Cancel the pending setup before trying again.",
        403 => "This pairing cannot enroll an owner device, or setup is closed. Use an enrolled owner device and check that the home node is unlocked.",
        404 | 405 => "This node does not support this enrollment request, or the request was lost. Cancel pending setup and reconnect.",
        409 | 410 => "The enrollment expired or the node restarted. Cancel pending setup and start again.",
        429 => "Another enrollment is pending, or requests are too frequent. Finish or cancel it on the joining device, or wait up to 15 minutes for it to expire.",
        _ => "The node did not confirm enrollment. Check its connection before trying again.",
    });
    use crate::remote_access::{ConnectionError, ConnectionErrorKind};
    error.connection_error = Some(ConnectionError {
        kind: match (status, finalizing) {
            (403, true) => ConnectionErrorKind::ClaimMismatch,
            (429, _) => ConnectionErrorKind::Busy,
            (409 | 410, _) => ConnectionErrorKind::Expired,
            _ => ConnectionErrorKind::Other,
        },
        detail: error.message.clone(),
    });
    error
}
fn enrollment_lost(finalizing: bool) -> ActionError {
    invalid(if finalizing {
        "The confirmation reply was lost. The request may still be approved; cancel pending setup before starting again."
    } else {
        "The enrollment reply was lost. The node may have created a request whose identifier was not received, so this app cannot cancel it. Wait up to 15 minutes for it to expire before starting again."
    })
}
async fn bound_request(
    connection: &mut remote_access::BootstrapConnection,
    token: &str,
    path: &str,
    body: serde_json::Value,
) -> Result<Zeroizing<Vec<u8>>, ActionError> {
    let bytes = Zeroizing::new(
        serde_json::to_vec(&body).map_err(|_| invalid("Invalid enrollment request."))?,
    );
    let finalizing = path.ends_with("/finalize");
    let (status, reply) = connection
        .request("POST", path, &bytes, token)
        .await
        .map_err(|_| enrollment_lost(finalizing))?;
    if !(200..300).contains(&status) {
        return Err(enrollment_refusal(status, finalizing && body["sas_version"] != 2));
    }
    Ok(reply)
}
#[derive(Deserialize)]
pub(super) struct Enrollment {
    op_id: String,
    key_id: String,
    fingerprint: String,
    expires_at: i64,
    sas_version: u8,
    box_nonce: String,
}
pub(super) fn accept_enrollment_reply(
    state: &NodeState,
    store: &Path,
    record: &mut device::Record,
    bytes: &[u8],
    now: i64,
) -> Result<Enrollment, ActionError> {
    accept_enrollment_version(state, store, record, bytes, now, 1)
}
fn accept_enrollment_version(state: &NodeState, store: &Path, record: &mut device::Record, bytes: &[u8], now: i64, version: u8) -> Result<Enrollment, ActionError> {
    // Decode only the cancellation handle first. Other fields may be missing,
    // malformed, or from a newer protocol; none may strand a created operation.
    #[derive(Deserialize)]
    struct Operation {
        op_id: String,
    }
    let operation: Operation = serde_json::from_slice(bytes).map_err(|_| enrollment_lost(false))?;
    record.pending = Some(device::PendingRegistration {
        delegation_message: None,
        op_id: operation.op_id,
        owner_action: String::new(),
        // Not yet validated, so never present this record as approvable.
        expires_at_ms: 0,
    });
    {
        let _guard = state.device_lifecycle.lock().unwrap();
        device::save_record(store, record)?;
        state.device_lapsed.store(false, Ordering::SeqCst);
    }
    let pending: Enrollment = serde_json::from_slice(bytes).map_err(|_| {
        invalid("Invalid device enrollment reply. Cancel pending setup before trying again.")
    })?;
    if !canonical_hex(&pending.op_id, OP_ID_BYTES)
        || !canonical_hex(&pending.box_nonce, 16)
        || pending.sas_version != version
        || !canonical_hex(&pending.key_id, 16)
        || if version == 2 { pending.expires_at <= now || pending.expires_at > now.saturating_add(bitsov_app::second_device::TTL) } else { !valid_expiry(pending.expires_at, now, ENROLLMENT_TTL_SECS) }
    {
        return Err(invalid(
            "Invalid or expired device enrollment reply. Cancel pending setup before trying again.",
        ));
    }
    record.key_id = Some(pending.key_id.clone());
    record.fingerprint = Some(
        pending
            .fingerprint
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .take(24)
            .collect(),
    );
    record.pending = Some(device::PendingRegistration {
        delegation_message: None,
        op_id: pending.op_id.clone(),
        owner_action: String::new(),
        expires_at_ms: ((if version == 2 { pending.expires_at } else { expiry_deadline(pending.expires_at) }).max(0) as u64).saturating_mul(1000),
    });
    {
        let _guard = state.device_lifecycle.lock().unwrap();
        device::save_record(store, record)?;
        state.device_lapsed.store(false, Ordering::SeqCst);
    }
    Ok(pending)
}

pub fn has_second_ticket(state: &NodeState) -> bool {
    state.remote_descriptor.lock().unwrap().as_ref().is_some_and(|d| d.enrollment_commitment().is_some())
}
pub fn is_second_join(state: &NodeState) -> bool {
    has_second_ticket(state)
        && matches!(&*state.auth.lock().unwrap(), AuthMode::Paired(s) if s.scopes.is_empty())
}

pub fn second_completion_pending(state: &NodeState) -> bool {
    has_second_ticket(state) && !state.second_join_complete.load(Ordering::SeqCst)
}

/// Called while remote_recovery is held, from either enrollment or ordinary
/// device-status polling. The renderer must never observe completion first.
pub async fn complete_second_join(state: &NodeState) -> Result<(), ActionError> {
    if !second_completion_pending(state) { return Ok(()); }
    refresh_paired(state).await.map_err(|_| invalid("Device approved. Reconnect to refresh its access."))?;
    if is_second_join(state) { return Err(invalid("The node has not granted this device access yet.")); }
    let dir = state.pairing.lock().unwrap().as_ref().map(|c| c.data_dir.clone()).ok_or_else(|| refusal(403))?;
    finish_auth(state, &dir).await;
    if state.error.lock().unwrap().is_some() || !*state.ready.lock().unwrap() {
        return Err(invalid("Device approved. Reconnect to finish setup."));
    }
    state.second_join_complete.store(true, Ordering::SeqCst);
    Ok(())
}

pub async fn join(state: &NodeState, input: JoinInput) -> Result<JoinView, ActionError> {
    join_on_platform(state, input, std::env::consts::OS).await
}

pub(super) async fn join_on_platform(state: &NodeState, input: JoinInput, platform: &str) -> Result<JoinView, ActionError> {
    let _connection = state.remote_recovery.lock().await;
    let mut setup = state.add_device.lock().await;
    if !state.remote_mode.load(Ordering::SeqCst) {
        return Err(invalid("Pair this device with your home node first."));
    }
    let store = device_store(state)?;
    if matches!(input, JoinInput::Cancel) {
        do_device_key_cancel(state).await?;
        setup.join = None;
        return Ok(JoinView::Idle { second_device: has_second_ticket(state) });
    }
    let view = do_device_key_status_local(state).await?;
    if view.state == device::DeviceState::Registered {
        complete_second_join(state).await?;
        setup.join = None;
        return Ok(JoinView::Done { second_device: has_second_ticket(state) });
    }
    if let Some(j) = &setup.join {
        let same_record = device::load_record(&store).is_some_and(|r| {
            r.public_key == j.public_key && r.pending.as_ref().is_some_and(|p| p.op_id == j.op_id)
        });
        if store != j.store
            || !same_record
            || now_unix() >= if j.second_device { j.expires_at } else { expiry_deadline(j.expires_at) }
            || Instant::now() >= j.deadline
        {
            setup.join = None;
            return Err(invalid("This enrollment expired, was cancelled, or the node restarted. Cancel any pending setup and start again."));
        }
        if matches!(input, JoinInput::Status | JoinInput::Poll) {
            return Ok(j.view());
        }
        return Err(invalid("Compare or cancel the current enrollment first."));
    }
    if device::load_record(&store).is_some_and(|r| r.pending.is_some()) {
        return Err(invalid(
            "A previous enrollment is pending. Cancel it before starting a new comparison.",
        ));
    }
    let second_device = has_second_ticket(state);
    let claim = match input {
        JoinInput::StartSecond {} if is_second_join(state) => None,
        JoinInput::Start { claim_code } if !second_device => Some(Zeroizing::new(sas::claim_commitment(&claim_code).map_err(invalid)?)),
        JoinInput::StartSecond {} | JoinInput::Start { .. } => return Err(invalid("Use the enrollment method authorized by this pairing. Scan a new second-device ticket if needed.")),
        _ => return Ok(JoinView::Idle { second_device }),
    };
    if !device_available(state) {
        return Err(device_error(
            device_key::DeviceKeyError::BiometryUnavailable,
        ));
    }
    let binding = if second_device {
        let node = state.node_id.lock().unwrap().clone().ok_or_else(|| refusal(403))?;
        let client_id = match &*state.auth.lock().unwrap() { AuthMode::Paired(s) => s.client_id.clone(), _ => return Err(refusal(403)) };
        DeviceBinding { node: bitsov_app::home_node::identity_fingerprint(&node), client_id, device_keys: vec![], owner_device_count: None, device_approvals: None }
    } else { device_binding(state).await? };
    check_binding(state, &binding)?;
    if binding
        .device_approvals
        .as_deref()
        .is_some_and(|v| v != "enabled")
    {
        return Err(refusal(403));
    }
    let (blob, mut record) = match local_key(state, &store)? {
        Some(key) => key,
        None => {
            let policy = *state.device_policy.lock().unwrap();
            let (blob, public) = tokio::task::spawn_blocking(move || device_key::create(policy))
                .await
                .map_err(|_| invalid("Creating the approval key stopped."))?
                .map_err(device_error)?;
            let record = device::Record {
                public_key: hex::encode(public),
                ..Default::default()
            };
            let _guard = state.device_lifecycle.lock().unwrap();
            device::save_blob(&store, &blob)?;
            device::save_record(&store, &record)?;
            (blob, record)
        }
    };
    let name = device::registration_name(platform);
    let proof = device_sign(
        blob.clone(),
        device::registration_message(&binding.node, &binding.client_id, &record.public_key),
        "prepare this device for owner approval".into(),
    )
    .await?;
    let descriptor = state
        .remote_descriptor
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| invalid("Missing home node pairing."))?;
    let ctx = state
        .pairing
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| invalid("Pair with your home node first."))?;
    ensure_fresh_token(state).await;
    let token = state
        .token
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| invalid("Reconnect to your node first."))?;
    let mut connection =
        if second_device { remote_access::BootstrapConnection::connect_second_device(&descriptor, &ctx.key, name).await }
            else { remote_access::BootstrapConnection::connect_device(&descriptor, &ctx.key, name).await }
            .map_err(|_| {
                invalid("Could not start enrollment on your home node. Reconnect and try again.")
            })?;
    if connection.client_id != binding.client_id {
        return Err(invalid("The pairing changed. Start again."));
    }
    let bytes = bound_request(
        &mut connection,
        &token,
        "/api/v1/pair/device-key",
        serde_json::json!({
            "public_key":record.public_key, "name":name, "proof":proof, "sas_version":if second_device {2} else {1},
        }),
    )
    .await?;
    let pending = accept_enrollment_version(state, &store, &mut record, &bytes, now_unix(), if second_device {2} else {1})?;
    let public: [u8; 65] = hex::decode(&record.public_key)
        .map_err(|_| invalid("Invalid device key."))?
        .try_into()
        .map_err(|_| invalid("Invalid device key."))?;
    let nonce: [u8; 16] = hex::decode(&pending.box_nonce)
        .map_err(|_| invalid("Invalid comparison nonce."))?
        .try_into()
        .map_err(|_| invalid("Invalid comparison nonce."))?;
    let digest = if second_device {
        sas::digest_v2(&connection.binding, &public, &nonce, &descriptor.enrollment_commitment().ok_or_else(|| invalid("Scan a second-device ticket first."))?)
    } else { sas::digest(&connection.binding, &public, &nonce, claim.as_ref().unwrap()) };
    drop(claim);
    // Persist the operation BEFORE prompting, so a cancelled prompt or a lost
    // reply can be withdrawn. Neither the claim code nor SAS digest is persisted.
    let proof = device_sign(
        blob,
        sas::registration_message(
            &binding.node,
            &binding.client_id,
            &record.public_key,
            &digest,
        ),
        "confirm this device's comparison words for owner approval".into(),
    )
    .await?;
    bound_request(
        &mut connection,
        &token,
        &format!("/api/v1/pair/device-key/{}/finalize", pending.op_id),
        serde_json::json!({
            "sas_version":if second_device {2} else {1}, "sas_digest":digest.to_hex().as_str(), "proof":proof,
        }),
    )
    .await?;
    let j = Joining {
        second_device,
        op_id: pending.op_id,
        store,
        public_key: record.public_key,
        words: sas::words(&digest),
        expires_at: pending.expires_at,
        deadline: Instant::now()
            + Duration::from_secs(((if second_device { pending.expires_at } else { expiry_deadline(pending.expires_at) }) - now_unix()).max(0) as u64),
    };
    let view = j.view();
    setup.join = Some(j);
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renderer_expiry_preserves_the_host_clock_skew_allowance() {
        let now = now_unix();
        let mut ticket = Ticket {
            uri: Zeroizing::new("node-issued-ticket".into()),
            expires_at: now - 20,
            node: String::new(),
            client: String::new(),
            key_id: String::new(),
            pending: vec![],
        };
        let view = serde_json::to_value(ticket_view(&ticket)).unwrap();
        assert_eq!(view["uri"], "node-issued-ticket");
        assert_eq!(view["expires_at"], now + 10);
        let mut pending: PendingDevice =
            serde_json::from_str(include_str!("../tests/fixtures/node301-pending.json")).unwrap();
        pending.expires_at = now - 20;
        ticket.pending.push(pending);
        let view = serde_json::to_value(ticket_view(&ticket)).unwrap();
        assert_eq!(view["pending"][0]["expires_at"], now + 10);
        ticket.expires_at = now - 30;
        ticket.pending.clear();
        let view = serde_json::to_value(ticket_view(&ticket)).unwrap();
        assert_eq!(view["uri"], "");
    }

    #[test]
    fn finalize_refusal_names_the_owner_console_and_box_sticker() {
        let error = enrollment_refusal(403, true);
        assert_eq!(serde_json::to_value(&error).unwrap()["kind"], "claim_mismatch");
        assert_eq!(serde_json::to_value(enrollment_refusal(429, false)).unwrap()["kind"], "busy");
        assert!(error.message.contains("18-character claim code"));
        assert!(error.message.contains("your node's owner console"));
        assert!(error.message.contains("konsensus claim-code --show"));
        assert!(error.message.contains("BitSov box's sticker"));
        assert!(error.message.contains("Cancel the pending setup before trying again."));
    }

    #[test]
    fn joining_errors_distinguish_claim_mismatch_busy_ceremony_and_unknown_creation() {
        assert!(enrollment_refusal(403, true).message.contains("claim code"));
        assert!(enrollment_refusal(429, false)
            .message
            .contains("enrollment is pending"));
        assert!(!enrollment_refusal(429, false)
            .message
            .contains("five tickets"));
        assert!(enrollment_lost(false).message.contains("cannot cancel"));
        assert!(enrollment_lost(false).message.contains("15 minutes"));
        assert!(enrollment_lost(true)
            .message
            .contains("may still be approved"));
    }
}
