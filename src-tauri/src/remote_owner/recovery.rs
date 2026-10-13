//! Public, host-owned write-ahead context. No password, mnemonic, JWT or proof of
//! device possession is stored here. It is written only after explicit Match.
use super::*;

const FILE: &str = "remote-first-run.json";

#[derive(Serialize, Deserialize)]
pub(super) struct Recovery {
    pub node_id: String,
    pub box_key: String,
    pub endpoint: String,
    pub client_public_key: String,
    pub binding: UnlockBinding,
    pub device_public_key: String,
    pub device_key_id: String,
    pub password_saved: bool,
}

impl Recovery {
    pub fn load(store: &Path) -> Result<Option<Self>, String> {
        device::read_private(&store.join(FILE))
            .map_err(|_| "Could not read first-run recovery context.".to_string())?
            .map(|bytes| {
                serde_json::from_slice(&bytes)
                    .map_err(|_| "Invalid first-run recovery context.".to_string())
            })
            .transpose()
    }

    pub fn save(&self, store: &Path) -> Result<(), String> {
        device::write_private(
            &store.join(FILE),
            &serde_json::to_vec(self).map_err(|_| "Invalid recovery context.")?,
        )
        .map_err(|_| "Could not save first-run recovery context.".into())
    }

    pub fn clear(store: &Path) -> Result<(), String> {
        match std::fs::remove_file(store.join(FILE)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Could not clear first-run recovery context.".into()),
        }
    }

    pub fn verify_binding(&self, node: &str, fresh: &UnlockBinding) -> Result<(), String> {
        if node != self.node_id
            || fresh.client_id != self.binding.client_id
            || fresh.epoch != self.binding.epoch
            || fresh.fingerprint != self.binding.fingerprint
        {
            return Err(
                "The node's fresh token changed the saved first-run client or epoch.".into(),
            );
        }
        Ok(())
    }

    fn validate(
        &self,
        ctx: &PairingCtx,
        descriptor: &remote_access::RemoteDescriptor,
        record: &device::Record,
    ) -> Result<(), String> {
        let box_key = match descriptor.bootstrap_box_key() {
            Some(key) => key.to_owned(),
            None => {
                descriptor
                    .box_pin()
                    .map_err(|e| e.to_string())?
                    .ok_or("Missing saved box pin.")?
                    .public_key
            }
        };
        let public = hex::decode(&record.public_key).map_err(|_| "Invalid saved device key.")?;
        if self.box_key != box_key
            || self.endpoint != descriptor.endpoint()
            || (!descriptor.node_id().is_empty() && self.node_id != descriptor.node_id())
            || self.client_public_key != ctx.key.public_hex()
            || self.device_public_key != record.public_key
            || self.device_key_id != device::key_id(&public)
            || self.binding.fingerprint
                != bitsov_app::home_node::identity_fingerprint(&self.node_id)
        {
            return Err("The saved setup belongs to a different box, pairing or device.".into());
        }
        Ok(())
    }
}

/// Recover after a lost finalize response or a crash during local persistence.
/// Call under remote_recovery. This never sends finalize or reads a password.
pub async fn recover(
    state: &NodeState,
    descriptor: &remote_access::RemoteDescriptor,
) -> Result<remote_access::RemoteDescriptor, String> {
    let ctx = state
        .pairing
        .lock()
        .unwrap()
        .clone()
        .ok_or("Pairing is unavailable.")?;
    let Some(saved) = Recovery::load(&ctx.store)? else {
        return Ok(descriptor.clone());
    };
    let (_, mut record) = local_key(&ctx.store).ok_or("Missing setup device key.")?;
    saved.validate(&ctx, descriptor, &record)?;
    let descriptor = if descriptor.bootstrap_box_key().is_some() {
        let proofs = state
            .remote_retry
            .run(|| {
                remote_access::recover_bootstrap(
                    descriptor,
                    &ctx.key,
                    NAME,
                    &saved.node_id,
                    &saved.binding.client_id,
                )
            })
            .await
            .map_err(|e| e.to_string())?;
        let Some(proofs) = proofs else {
            return Ok(descriptor.clone());
        };
        remote_access::commit_bootstrap(
            &ctx.data_dir,
            descriptor,
            &saved.node_id,
            &proofs.pin.public_key,
            &proofs.pin.signature,
            &proofs.transport_pubkey,
            &proofs.transport_signature,
        )
        .map_err(|e| e.to_string())?
    } else {
        // The descriptor may have been committed just before a crash. Its proofs
        // were reverified by load_persisted; never replace its trusted identity.
        descriptor.clone()
    };
    // Adopt the already durable descriptor before any subsequent local write
    // can fail, so another recovery poll can resume partial persistence.
    install_descriptor(state, &descriptor)?;
    record.key_id = Some(saved.device_key_id.clone());
    record.registered = true;
    record.pending = None;
    device::save_record(&ctx.store, &record).map_err(|e| e.message)?;
    home_keychain::save_binding(&saved.node_id, &saved.binding)?;
    let pin = descriptor
        .box_pin()
        .map_err(|e| e.to_string())?
        .ok_or("Missing box pin.")?;
    home_keychain::MacBoxPins
        .save(&pin)
        .map_err(|e| e.to_string())?;
    Ok(descriptor)
}

pub(super) fn install_descriptor(
    state: &NodeState,
    descriptor: &remote_access::RemoteDescriptor,
) -> Result<(), String> {
    if let Some(proxy) = state.remote_proxy.lock().unwrap().as_ref() {
        proxy
            .finish_bootstrap(descriptor.clone())
            .map_err(|e| e.to_string())?;
    }
    *state.remote_descriptor.lock().unwrap() = Some(descriptor.clone());
    *state.expected_remote_node_id.lock().unwrap() = Some(descriptor.node_id().into());
    *state.node_id.lock().unwrap() = Some(descriptor.node_id().into());
    *state.token.lock().unwrap() = None;
    *state.auth.lock().unwrap() = AuthMode::Unauthenticated;
    *state.ready.lock().unwrap() = false;
    Ok(())
}

/// Validate a newly issued live token before it can become an API credential.
/// The bootstrap token has a different identity fingerprint and is only used
/// while the descriptor still pins an identity-free box.
pub fn verify_session(state: &NodeState, session: &PairedSession) -> Result<(), String> {
    let descriptor = state.remote_descriptor.lock().unwrap().clone();
    let Some(descriptor) = descriptor else {
        return Ok(());
    };
    if descriptor.bootstrap_box_key().is_some() {
        return Ok(());
    }
    let ctx = state
        .pairing
        .lock()
        .unwrap()
        .clone()
        .ok_or("Pairing is unavailable.")?;
    if let Some(saved) = Recovery::load(&ctx.store)? {
        let fresh =
            UnlockBinding::from_session(descriptor.node_id(), &session.client_id, &session.token)?;
        saved.verify_binding(descriptor.node_id(), &fresh)?;
    }
    Ok(())
}

pub fn verify_fresh_binding(
    state: &NodeState,
    node: &str,
    fresh: &UnlockBinding,
) -> Result<(), String> {
    let ctx = state
        .pairing
        .lock()
        .unwrap()
        .clone()
        .ok_or("Pairing is unavailable.")?;
    if let Some(saved) = Recovery::load(&ctx.store)? {
        saved.verify_binding(node, fresh)?;
    }
    Ok(())
}

pub fn finish(state: &NodeState) -> Result<(), String> {
    let ctx = state
        .pairing
        .lock()
        .unwrap()
        .clone()
        .ok_or("Pairing is unavailable.")?;
    if let Some(saved) = Recovery::load(&ctx.store)? {
        // A typed/external unlock may not have migrated the escrow yet. Retain
        // the journal so the owner's next explicit Touch ID unlock can do so.
        if saved.password_saved {
            password_store::forget(&saved.box_key)?;
            Recovery::clear(&ctx.store)?;
        }
    }
    Ok(())
}

/// Called only from explicit unlock, where password access already requires
/// Touch ID. Passive recovery never triggers a biometric prompt.
pub fn password(store: &Path, node: &str, blob: &[u8]) -> Result<Zeroizing<String>, String> {
    if let Some(mut saved) = Recovery::load(store)? {
        if saved.node_id != node {
            return Err("Setup password belongs to another node.".into());
        }
        if !saved.password_saved {
            let password = password_store::password(&saved.box_key, blob)?;
            home_keychain::save_password(node, password.as_bytes())?;
            saved.password_saved = true;
            saved.save(store)?;
            password_store::forget(&saved.box_key)?;
            return Ok(password);
        }
    }
    home_keychain::password(node, Some(blob))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> Recovery {
        Recovery {
            node_id: "ab".repeat(32),
            box_key: "22".repeat(32),
            endpoint: "box.local:9737".into(),
            client_public_key: "33".repeat(32),
            binding: UnlockBinding {
                client_id: "a".repeat(32),
                epoch: 7,
                fingerprint: bitsov_app::home_node::identity_fingerprint(&"ab".repeat(32)),
            },
            device_public_key: "04".repeat(65),
            device_key_id: "key".into(),
            password_saved: false,
        }
    }

    #[test]
    fn pr287_fresh_token_epoch_is_checked_before_remember_can_replace_binding() {
        use base64::Engine;
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("pairing");
        let key = Arc::new(ClientKey::load_or_create(&store).unwrap());
        let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
        *state.pairing.lock().unwrap() = Some(Arc::new(PairingCtx {
            client: PairingClient::new(state.http.clone(), state.api_base.clone()),
            key,
            store: store.clone(),
            data_dir: dir.path().to_path_buf(),
        }));
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/remote-first-run-pr287.json"
        ))
        .unwrap();
        let receipt = &fixture["finalize"];
        let mut link = receipt.clone();
        for field in ["client_id", "epoch", "restart_required", "device_key_id"] {
            link.as_object_mut().unwrap().remove(field);
        }
        link["v"] = 1.into();
        link["endpoint"] = "box.local:9737".into();
        link["code"] = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode([3; 32])
            .into();
        let link = format!(
            "bitsov://pair/{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&link).unwrap())
        );
        *state.remote_descriptor.lock().unwrap() =
            Some(remote_access::parse_pairing_link(&link).unwrap());
        let mut saved = context();
        saved.node_id = receipt["node_id"].as_str().unwrap().into();
        saved.binding.fingerprint = bitsov_app::home_node::identity_fingerprint(&saved.node_id);
        saved.save(&store).unwrap();
        let before = std::fs::read(store.join(FILE)).unwrap();
        for epoch in [0, 8, u64::MAX] {
            let payload = serde_json::json!({"cid":saved.binding.client_id,"epc":epoch,"idf":saved.binding.fingerprint});
            let token = format!(
                "h.{}.s",
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(serde_json::to_vec(&payload).unwrap())
            );
            *state.auth.lock().unwrap() = AuthMode::Paired(PairedSession {
                client_id: saved.binding.client_id.clone(),
                scopes: vec!["read".into()],
                token,
                expires_at: now_unix() + 60,
            });
            let error = home_unlock::remember_binding(&state, &saved.node_id).unwrap_err();
            assert!(error.contains("changed the saved first-run"), "{error}");
            assert_eq!(std::fs::read(store.join(FILE)).unwrap(), before);
            let session = match &*state.auth.lock().unwrap() {
                AuthMode::Paired(session) => session.clone(),
                _ => panic!("missing test session"),
            };
            *state.ready.lock().unwrap() = true;
            *state.token.lock().unwrap() = Some("previous-token".into());
            assert!(check_first_run_session(&state, &session).is_err());
            assert!(!*state.ready.lock().unwrap());
            assert!(state.token.lock().unwrap().is_none());
            assert!(matches!(
                *state.auth.lock().unwrap(),
                AuthMode::Unauthenticated
            ));
        }
    }

    #[test]
    fn pr287_recovery_binding_survives_restart_and_refuses_changed_epoch_client_or_node() {
        let dir = tempfile::tempdir().unwrap();
        let saved = context();
        saved.save(dir.path()).unwrap();
        let loaded = Recovery::load(dir.path()).unwrap().unwrap();
        loaded
            .verify_binding(&saved.node_id, &saved.binding)
            .unwrap();
        for field in ["epoch", "client", "fingerprint"] {
            let mut fresh = saved.binding.clone();
            match field {
                "epoch" => fresh.epoch += 1,
                "client" => fresh.client_id = "b".repeat(32),
                _ => fresh.fingerprint = "other".into(),
            }
            assert!(
                loaded.verify_binding(&saved.node_id, &fresh).is_err(),
                "{field}"
            );
        }
        assert!(loaded
            .verify_binding(&"cd".repeat(32), &saved.binding)
            .is_err());
        Recovery::clear(dir.path()).unwrap();
        assert!(Recovery::load(dir.path()).unwrap().is_none());
    }
}
