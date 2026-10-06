//! Host orchestration for locked home nodes. No password-bearing IPC.
use super::*;
use bitsov_app::home_node::{UnlockBinding, UnlockBody};
use remote_access::LockedConnection;

pub async fn probe(state: &NodeState) -> Result<bool, String> {
    let descriptor = state.remote_descriptor.lock().unwrap().clone();
    let Some(descriptor) = descriptor else {
        return Ok(false);
    };
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
    home_keychain::save_binding(node, &binding)
}

/// Passive status refresh never reads the biometric password or signs anything.
pub async fn refresh(state: &NodeState) {
    if !state.remote_mode.load(Ordering::SeqCst)
        || state.remote_descriptor.lock().unwrap().is_none()
    {
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
    let node = status.node_id;
    let binding = home_keychain::binding(&node)?;
    if binding.client_id != connection.client_id || binding.fingerprint != status.fingerprint {
        return Err("This device's saved unlock binding does not match the node.".into());
    }
    let (blob, record) = local_key(&ctx.store).ok_or_else(|| {
        if cfg!(target_os = "android") {
            "This phone has no enrolled Android Keystore key for this node."
        } else {
            "This Mac has no enrolled Secure Enclave key for this node."
        }
    })?;
    if !record.registered {
        return Err(if cfg!(target_os = "android") {
            "This phone's device key has not been approved."
        } else {
            "This Mac's device key has not been approved."
        }
        .into());
    }
    let key_id = record.key_id.ok_or("No enrolled device key id.")?;
    let challenge = connection.challenge().await.map_err(|e| e.to_string())?;
    let message = challenge.message(&binding, &key_id, &connection.pin.public_key, now_unix())?;
    let signature = device_sign(blob.clone(), message, "Unlock your BitSov home node".into())
        .await
        .map_err(|e| e.message)?;
    let password = tokio::task::spawn_blocking(move || home_keychain::password(&node, Some(&blob)))
        .await
        .map_err(|_| {
            if cfg!(target_os = "android") {
                "The biometric password request stopped."
            } else {
                "The Keychain unlock request stopped."
            }
        })??;
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
    drop(connection);
    result.map_err(|e| e.to_string())?;
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
}
