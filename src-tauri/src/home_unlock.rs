//! Host orchestration for locked home nodes. Password input is write-only.
use super::*;
use bitsov_app::home_node::{UnlockBinding, UnlockBody};
use remote_access::LockedConnection;

pub async fn probe(state: &NodeState) -> Result<bool, String> {
    let descriptor = state.remote_descriptor.lock().unwrap().clone();
    let Some(descriptor) = descriptor else {
        return Ok(false);
    };
    #[cfg(all(desktop, not(feature = "mobile")))]
    let descriptor = if descriptor.bootstrap_box_key().is_some() {
        remote_owner::recovery::recover(state, &descriptor).await?
    } else { descriptor };
    let ctx = state
        .pairing
        .lock()
        .unwrap()
        .clone()
        .ok_or("Pairing is unavailable.")?;
    let connection = state
        .remote_retry
        .run(|| LockedConnection::connect(&descriptor, &ctx.key, PAIRING_CLIENT_NAME))
        .await
        .map_err(|e| e.to_string())?;
    if let Some(mut connection) = connection {
        let status = connection.status().await.map_err(|e| e.to_string())?;
        state.home_locked.store(true, Ordering::SeqCst);
        *state.ready.lock().unwrap() = false;
        *state.home_attempts_left.lock().unwrap() = status.attempts_left;
        *state.node_id.lock().unwrap() = Some(status.node_id);
        *state.token.lock().unwrap() = None;
        *state.auth.lock().unwrap() = AuthMode::Unauthenticated;
        *state.error.lock().unwrap() = None;
        return Ok(true);
    }
    Ok(false)
}

/// Capture public signing context only after finish_auth verified the node id.
pub fn remember_binding(state: &NodeState, node: &str) -> Result<(), String> {
    let descriptor = state.remote_descriptor.lock().unwrap().clone();
    let Some(descriptor) = descriptor else {
        return Ok(());
    };
    if descriptor.box_pin().map_err(|e| e.to_string())?.is_none() {
        return Ok(());
    }
    let session = match &*state.auth.lock().unwrap() {
        AuthMode::Paired(session) => session.clone(),
        _ => return Err("No paired unlock binding is available.".into()),
    };
    let binding = UnlockBinding::from_session(node, &session.client_id, &session.token)?;
    #[cfg(all(desktop, not(feature = "mobile")))]
    remote_owner::recovery::verify_fresh_binding(state, node, &binding)?;
    home_keychain::save_binding(node, &binding)?;
    #[cfg(all(desktop, not(feature = "mobile")))]
    remote_owner::recovery::finish(state)?;
    Ok(())
}

/// Passive status refresh never reads the biometric password or signs anything.
pub async fn refresh(state: &NodeState) {
    if !state.remote_mode.load(Ordering::SeqCst)
        || state.remote_descriptor.lock().unwrap().is_none()
    {
        return;
    }
    // The node refused this app's pairing: polling must neither dial nor
    // repeat the token exchange until the owner acts.
    if hold_refused(state) {
        return;
    }
    // Nothing clears `ready` when a home node reboots into locked mode (proxied
    // calls just get 503 node_locked), so keep probing while live, but every
    // 60 s instead of 10 s to spare the node's handshake limiter.
    let interval = if !state.home_locked.load(Ordering::SeqCst) && *state.ready.lock().unwrap() {
        Duration::from_secs(60)
    } else {
        Duration::from_secs(10)
    };
    let Ok(_operation) = state.remote_recovery.try_lock() else {
        return;
    };
    // The ceremony owns the first restart/unlock. A passive status probe must
    // not replace that screen with LockedNode and cancel its continuation.
    #[cfg(all(desktop, not(feature = "mobile")))]
    if state.remote_owner.try_lock().map(|setup| setup.is_active()).unwrap_or(true) {
        return;
    }
    {
        let mut last = state.home_last_probe.lock().unwrap();
        if last.is_some_and(|at| at.elapsed() < interval) {
            return;
        }
        *last = Some(Instant::now());
    }
    if state.remote_retry.remaining().is_some() {
        return;
    }
    let result = probe(state).await;
    finish_probe(state, result).await;
}

async fn finish_probe(state: &NodeState, result: Result<bool, String>) {
    match result {
        Ok(true) => {}
        Ok(false) if state.home_locked.load(Ordering::SeqCst) || !*state.ready.lock().unwrap() => {
            let ctx = state.pairing.lock().unwrap().clone();
            if let Some(ctx) = ctx {
                finish_auth(state, &ctx.data_dir).await;
            }
        }
        Ok(false) => {}
        Err(error) => {
            *state.ready.lock().unwrap() = false;
            *state.error.lock().unwrap() = Some(error);
        }
    }
}

pub async fn unlock(state: &NodeState) -> Result<(), String> {
    unlock_with(state, None).await
}

/// How long a password the node accepted waits for the owner's
/// "Remember on this device" choice. Memory only.
#[cfg(any(target_os = "android", all(target_os = "macos", desktop, not(feature = "mobile"))))]
const REMEMBER_WINDOW: Duration = Duration::from_secs(120);

#[cfg(any(target_os = "android", all(target_os = "macos", desktop, not(feature = "mobile"))))]
pub struct RememberOffer {
    node: String,
    password: zeroize::Zeroizing<String>,
    offered: Instant,
}

/// The owner typed the node password because this device has no
/// saved copy, or its saved copy no longer opens. The node checks it; only a
/// password it accepted is kept, in memory, for [`remember`].
#[cfg(any(target_os = "android", all(target_os = "macos", desktop, not(feature = "mobile"))))]
pub async fn unlock_typed(
    state: &NodeState,
    password: zeroize::Zeroizing<String>,
) -> Result<(), String> {
    *state.home_remember.lock().unwrap() = None;
    if password.is_empty() || password.len() > 4096 {
        return Err("Type the password you chose for your home node.".into());
    }
    unlock_with(state, Some(password)).await
}

/// Answer the offer made by the last typed unlock. Storage is biometric-bound;
/// a cancelled or failed save keeps the offer until it expires.
#[cfg(any(target_os = "android", all(target_os = "macos", desktop, not(feature = "mobile"))))]
pub async fn remember(state: &NodeState, remember: bool) -> Result<(), String> {
    let offer = state
        .home_remember
        .lock()
        .unwrap()
        .take()
        .ok_or("There is no typed password to remember. Unlock with your node password first.")?;
    if !remember {
        return Ok(());
    }
    if offer.offered.elapsed() >= REMEMBER_WINDOW {
        return Err("This offer expired. The next time you unlock with your password, choose Remember again.".into());
    }
    if state.node_id.lock().unwrap().as_deref() != Some(offer.node.as_str()) {
        return Err("This device is no longer connected to the node that accepted the password.".into());
    }
    let ctx = state
        .pairing
        .lock()
        .unwrap()
        .clone()
        .ok_or("Pairing is unavailable.")?;
    let (blob, record) = local_key(state, &ctx.store).map_err(|e| e.message)?
        .ok_or("This device has no enrolled approval key for this node.")?;
    if !record.registered {
        return Err("This device's approval key has not been approved.".into());
    }
    let (offer, saved) = tokio::task::spawn_blocking(move || {
        // The blocking pool may have queued this request past its deadline.
        if offer.offered.elapsed() >= REMEMBER_WINDOW {
            return (offer, Err("This offer expired. Unlock with your password again before choosing Remember.".into()));
        }
        #[cfg(target_os = "android")]
        let saved = home_keychain::save_password_for_device(
            &offer.node,
            offer.password.as_bytes(),
            &blob,
            true,
        );
        #[cfg(all(target_os = "macos", desktop, not(feature = "mobile")))]
        let saved = {
            let _ = blob;
            home_keychain::save_password(&offer.node, offer.password.as_bytes())
        };
        (offer, saved)
    })
    .await
    .map_err(|_| "The biometric save request stopped.")?;
    if saved.is_err() && offer.offered.elapsed() < REMEMBER_WINDOW {
        state.home_remember.lock().unwrap().get_or_insert(offer);
    }
    saved
}

/// Public status carries only availability, never the secret.
pub fn remember_available(state: &NodeState) -> bool {
    #[cfg(any(target_os = "android", all(target_os = "macos", desktop, not(feature = "mobile"))))]
    {
        let mut pending = state.home_remember.lock().unwrap();
        if pending.as_ref().is_some_and(|offer| offer.offered.elapsed() >= REMEMBER_WINDOW) {
            *pending = None;
        }
        pending.is_some()
    }
    #[cfg(not(any(target_os = "android", all(target_os = "macos", desktop, not(feature = "mobile")))))]
    { let _ = state; false }
}

/// Local public enrollment metadata only: no password read or signing prompt.
pub fn locked_view(state: &NodeState) -> (&'static str, Option<device::DeviceView>) {
    if !state.home_locked.load(Ordering::SeqCst) { return ("ready", None); }
    let ctx = state.pairing.lock().unwrap().clone();
    let key = match ctx.map(|ctx| local_device_record(state, &ctx.store)).unwrap_or(Ok(None)) {
        Ok(key) => key,
        // A transient bridge read cannot revoke enrollment. Keep the unlock
        // path available; an explicit attempt reports the retryable error.
        Err(_) => return (*state.home_unlock_state.lock().unwrap(), None),
    };
    let Some(record) = key else { return ("not-enrolled", None); };
    let view = device::DeviceView::of(true, Some(&record), false, now_ms());
    if view.state == device::DeviceState::Pending { return ("pending-approval", Some(view)); }
    if !record.registered { return ("not-enrolled", None); }
    (*state.home_unlock_state.lock().unwrap(), None)
}

async fn unlock_with(
    state: &NodeState,
    typed: Option<zeroize::Zeroizing<String>>,
) -> Result<(), String> {
    let _operation = state
        .remote_recovery
        .try_lock()
        .map_err(|_| "A node connection or unlock is already in progress.")?;
    if !state.remote_mode.load(Ordering::SeqCst) || !state.home_locked.load(Ordering::SeqCst) {
        return Err("Your home node is not locked.".into());
    }
    let descriptor = state
        .remote_descriptor
        .lock()
        .unwrap()
        .clone()
        .ok_or("No remote descriptor.")?;
    let ctx = state
        .pairing
        .lock()
        .unwrap()
        .clone()
        .ok_or("Pairing is unavailable.")?;
    let mut connection = state
        .remote_retry
        .run(|| LockedConnection::connect(&descriptor, &ctx.key, PAIRING_CLIENT_NAME))
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Your node is already running. Reconnect to it.")?;
    let status = connection.status().await.map_err(|e| e.to_string())?;
    *state.home_attempts_left.lock().unwrap() = status.attempts_left;
    let node = status.node_id;
    let binding = home_keychain::binding(&node)?;
    if binding.client_id != connection.client_id || binding.fingerprint != status.fingerprint {
        return Err("This device's saved unlock binding does not match the node.".into());
    }
    let (blob, record) = local_key(state, &ctx.store).map_err(|e| e.message)?.ok_or_else(|| {
        if cfg!(target_os = "android") {
            "This device has no enrolled approval key for this node."
        } else {
            "This Mac has no enrolled Secure Enclave key for this node."
        }
    })?;
    if !record.registered {
        return Err(if cfg!(target_os = "android") {
            "This device's approval key has not been approved."
        } else {
            "This Mac's device key has not been approved."
        }
        .into());
    }
    let key_id = record.key_id.ok_or("No enrolled device key id.")?;
    let challenge = connection.challenge().await.map_err(|e| e.to_string())?;
    if !challenge.key_ids.iter().any(|id| id == &key_id) {
        *state.home_unlock_state.lock().unwrap() = "not-enrolled";
        return Err("This device is not approved to unlock this node. Unlock at the box or from another approved owner device first.".into());
    }
    let message = challenge.message(&binding, &key_id, &connection.pin.public_key, now_unix())?;
    let signature = device_sign(blob.clone(), message, "Unlock your BitSov home node".into())
        .await
        .map_err(|e| {
            if forget_invalid_signing_key(&ctx.store, &e) {
                *state.home_unlock_state.lock().unwrap() = "not-enrolled";
            }
            e.message
        })?;
    #[cfg(any(target_os = "android", all(target_os = "macos", desktop, not(feature = "mobile"))))]
    let accepted = typed
        .as_ref()
        .map(|password| zeroize::Zeroizing::new(password.as_str().to_owned()));
    let blob = password_device_blob(blob);
    let password = match typed {
        Some(password) => password,
        None => {
            let node = node.clone();
            #[cfg(all(desktop, not(feature = "mobile")))]
            let store = ctx.store.clone();
            tokio::task::spawn_blocking(move || {
                #[cfg(all(desktop, not(feature = "mobile")))]
                { remote_owner::recovery::password(&store, &node, &blob) }
                #[cfg(not(all(desktop, not(feature = "mobile"))))]
                { home_keychain::password(&node, Some(&blob)) }
            })
                .await
                .map_err(|_| {
                    if cfg!(target_os = "android") {
                        "The biometric password request stopped."
                    } else {
                        "The Keychain unlock request stopped."
                    }
                })?
                .map_err(|error| {
                    *state.home_unlock_state.lock().unwrap() = "no-password";
                    error
                })?
        }
    };
    // Both biometric operations may take time; the node enforces challenge expiry.
    challenge.message(&binding, &key_id, &connection.pin.public_key, now_unix())?;
    let body = UnlockBody {
        challenge: challenge.challenge,
        key_id,
        signature,
        password,
    };
    let result = connection.unlock(&body).await;
    drop(body);
    if result.is_err() {
        // Only a fresh API budget is displayed; never guess or decrement locally.
        *state.home_attempts_left.lock().unwrap() = connection.status().await.ok().and_then(|s| s.attempts_left);
    }
    drop(connection);
    result.map_err(|e| e.to_string())?;
    #[cfg(any(target_os = "android", all(target_os = "macos", desktop, not(feature = "mobile"))))]
    if let Some(password) = accepted {
        let offered = Instant::now();
        *state.home_remember.lock().unwrap() = Some(RememberOffer {
            node,
            password,
            offered,
        });
        // Drop (and zeroize) even when the renderer never answers the offer.
        let pending = Arc::clone(&state.home_remember);
        tokio::spawn(async move {
            tokio::time::sleep(REMEMBER_WINDOW).await;
            let mut pending = pending.lock().unwrap();
            if pending.as_ref().is_some_and(|offer| offer.offered == offered) {
                *pending = None;
            }
        });
    }
    // The node closes the locked listener within 250 ms, then restarts its live
    // services. Retry only connection/authentication, never the unlock body.
    tokio::time::sleep(Duration::from_millis(300)).await;
    finish_remote_auth(state, &ctx.data_dir).await;
    if *state.ready.lock().unwrap() && !state.home_locked.load(Ordering::SeqCst) {
        Ok(())
    } else {
        Err(state.error.lock().unwrap().clone().unwrap_or_else(|| {
            "Your node accepted unlock and is still starting. Wait for it to reconnect.".into()
        }))
    }
}

/// Existing local owner installations migrate too, after the node proves its id.
#[cfg(all(desktop, not(feature = "mobile")))]
pub async fn migrate_local_password(state: &NodeState, node: &str) -> Result<(), String> {
    let config = state
        .config
        .lock()
        .unwrap()
        .clone()
        .ok_or("Missing local node config.")?;
    let dir = config
        .parent()
        .ok_or("Missing local node directory.")?
        .to_path_buf();
    let node = node.to_owned();
    tokio::task::spawn_blocking(move || owner_password::bind_to_node(&dir, &node))
        .await
        .map_err(|_| "Keychain migration stopped.")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn transient_probe_failure_then_live_probe_attempts_reauthentication() {
        // A missing HTTP service makes the reauthentication attempt fail; its
        // pairing view transition proves recovery is attempted, not skipped.
        let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("pairing");
        let key = Arc::new(ClientKey::load_or_create(&store).unwrap());
        *state.pairing.lock().unwrap() = Some(Arc::new(PairingCtx {
            client: PairingClient::new(state.http.clone(), state.api_base.clone()),
            key,
            store,
            data_dir: dir.path().to_path_buf(),
        }));
        state.remote_mode.store(true, Ordering::SeqCst);
        *state.ready.lock().unwrap() = true;
        finish_probe(&state, Err("temporary outage".into())).await;
        assert!(!*state.ready.lock().unwrap());
        assert_eq!(state.pairing_view.lock().unwrap().state, "starting");
        finish_probe(&state, Ok(false)).await;
        assert_eq!(state.pairing_view.lock().unwrap().state, "failed");
        assert!(state
            .pairing_view
            .lock()
            .unwrap()
            .reason
            .as_ref()
            .unwrap()
            .contains("no paired client record"));
    }

    #[cfg(any(target_os = "android", all(target_os = "macos", desktop, not(feature = "mobile"))))]
    fn offer(state: &NodeState, node: &str, age: Duration) {
        *state.home_remember.lock().unwrap() = Some(RememberOffer {
            node: node.into(), password: zeroize::Zeroizing::new("typed secret".into()),
            offered: Instant::now() - age,
        });
    }

    #[cfg(any(target_os = "android", all(target_os = "macos", desktop, not(feature = "mobile"))))]
    #[tokio::test]
    async fn remember_decline_expiry_and_node_mismatch_never_reach_storage() {
        let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
        *state.device_policy.lock().unwrap() = device_key::Policy::NoPromptForTests;
        assert!(remember(&state, true).await.unwrap_err().contains("no typed password"));
        offer(&state, "node-a", Duration::ZERO);
        remember(&state, false).await.unwrap();
        assert!(!remember_available(&state));
        offer(&state, "node-a", Duration::from_secs(121));
        assert!(remember(&state, true).await.unwrap_err().contains("expired"));
        assert!(!remember_available(&state));
        *state.node_id.lock().unwrap() = Some("node-b".into());
        offer(&state, "node-a", Duration::ZERO);
        assert!(remember(&state, true).await.unwrap_err().contains("no longer connected"));
        assert!(!remember_available(&state));
        offer(&state, "node-b", Duration::from_secs(121));
        assert!(!remember_available(&state));
        assert!(state.home_remember.lock().unwrap().is_none());
    }

    #[cfg(any(target_os = "android", all(target_os = "macos", desktop, not(feature = "mobile"))))]
    #[tokio::test]
    async fn invalid_typed_password_discards_previous_offer() {
        let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
        for password in [String::new(), "x".repeat(4097)] {
            offer(&state, "node-a", Duration::ZERO);
            assert!(unlock_typed(&state, zeroize::Zeroizing::new(password)).await.is_err());
            assert!(!remember_available(&state));
        }
    }

    #[cfg(all(target_os = "macos", desktop, not(feature = "mobile"), feature = "native-test-keys"))]
    #[tokio::test]
    async fn remember_requires_local_key_and_owner_registration_before_keychain_write() {
        let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
        *state.device_policy.lock().unwrap() = device_key::Policy::NoPromptForTests;
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("pairing");
        let key = Arc::new(ClientKey::load_or_create(&store).unwrap());
        *state.pairing.lock().unwrap() = Some(Arc::new(PairingCtx {
            client: PairingClient::new(state.http.clone(), state.api_base.clone()),
            key, store: store.clone(), data_dir: dir.path().to_path_buf(),
        }));
        let node = "ab".repeat(32);
        *state.node_id.lock().unwrap() = Some(node.clone());
        offer(&state, &node, Duration::ZERO);
        assert!(remember(&state, true).await.unwrap_err().contains("no enrolled approval key"));
        if !device_key::enclave_available() { return; }
        let (blob, public) = device_key::create(device_key::Policy::NoPromptForTests).unwrap();
        device::save_blob(&store, &blob).unwrap();
        device::save_record(&store, &device::Record { public_key: hex::encode(public), ..Default::default() }).unwrap();
        offer(&state, &node, Duration::ZERO);
        assert!(remember(&state, true).await.unwrap_err().contains("not been approved"));
        assert!(!remember_available(&state));
    }

}
