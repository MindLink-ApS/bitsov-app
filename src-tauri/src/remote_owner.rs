//! Remote first run. The password and session-bound SAS stay in the Rust host.
use super::*;
use bitsov_app::{
    home_node::{BoxPin, BoxPinStore, UnlockBinding},
    sas,
};
use remote_access::BootstrapConnection;
use zeroize::Zeroizing;
#[path = "remote_owner/password_store.rs"]
mod password_store;
#[path = "remote_owner/recovery.rs"]
pub mod recovery;
use recovery::Recovery;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Input {
    Create {
        password: Zeroizing<String>,
        claim_code: Zeroizing<String>,
    },
    Match {},
    Finalize {
        backup_words: [Zeroizing<String>; 3],
    },
    Poll {},
    Cancel {},
}
#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum View {
    Compare {
        words: [&'static str; 4],
        expires_at: i64,
    },
    Backup {
        mnemonic: Zeroizing<String>,
        backup_check: [usize; 3],
        expires_at: i64,
    },
    BackupCheck {
        backup_check: [usize; 3],
    },
    WaitingForBoxApproval,
    Starting,
    Done,
    WordsDiffer,
}
#[derive(Deserialize)]
struct Pending {
    ceremony_id: String,
    node_id: String,
    mnemonic: Zeroizing<String>,
    backup_check: [usize; 3],
    #[serde(rename = "expires_at")]
    _expires_at: i64,
    sas_version: u8,
    box_nonce: String,
}
impl Pending {
    fn validate(&self) -> Result<[u8; 16], String> {
        let canonical = |s: &str, n| {
            s.len() == n
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        let count = self.mnemonic.split_whitespace().count();
        if !canonical(&self.ceremony_id, 32)
            || !canonical(&self.node_id, 64)
            || self.sas_version != 1
            || !canonical(&self.box_nonce, 32)
            || ![12, 24].contains(&count)
            || self.backup_check.iter().any(|i| *i >= count)
            || self.backup_check[0] == self.backup_check[1]
            || self.backup_check[0] == self.backup_check[2]
            || self.backup_check[1] == self.backup_check[2]
        {
            return Err(
                "The box returned an invalid setup ceremony. Cancel and start again.".into(),
            );
        }
        hex::decode(&self.box_nonce)
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| "Invalid box nonce.".into())
    }
}
struct Attempt {
    connection: BootstrapConnection,
    pending: Pending,
    password: Arc<Mutex<Option<Zeroizing<String>>>>,
    digest: blake3::Hash,
    blob: Vec<u8>,
    record: device::Record,
    proof: Option<String>,
    backup: Option<[Zeroizing<String>; 3]>,
    finalize_uncertain: bool,
    escrow: password_store::Escrow,
    deadline: Instant,
}
#[derive(Default)]
pub struct Setup {
    attempt: Option<Attempt>,
    completion: Option<Completion>,
}
impl Setup {
    pub fn is_active(&self) -> bool {
        self.attempt.is_some()
            || self
                .completion
                .as_ref()
                .is_some_and(|c| c.stage != CompletionStage::Done)
    }
}
const NAME: &str = "BitSov app on this Mac";

fn safe_error(status: u16, bytes: &[u8]) -> String {
    let json: serde_json::Value = serde_json::from_slice(bytes).unwrap_or_default();
    let code = json
        .get("code")
        .or_else(|| json.get("reason"))
        .or_else(|| json.get("error"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    match code {
        "box_approval_pending" => "box_approval_pending",
        "setup_closed" | "sas_setup_closed" | "setup_window_closed" => "Setup closed after three failed attempts or its time limit. Restart the box to begin again.",
        "sas_mismatch" | "sas_digest_mismatch" => "Words differ. Setup was not approved. Cancel this attempt and check the physical claim code.",
        "sas_binding_mismatch" | "noise_binding_mismatch" | "ceremony_lost" | "ceremony_expired" => "The box restarted or this setup expired. Cancel and open a new setup link.",
        "backup_check_failed" => "The backup words did not match. Cancel and start a new setup if your written backup is incomplete.",
        "ceremony_in_progress" => "A device is already setting up this box. Check the box page before continuing.",
        _ if status == 410 => "The box restarted or this setup expired. Open a new setup link.",
        _ => "The box did not confirm setup. Check its page before trying again.",
    }.into()
}
async fn token(state: &NodeState) -> Result<String, String> {
    ensure_fresh_token(state).await;
    state
        .token
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Pair with the box before setup.".into())
}
async fn request_finalize(
    attempt: &mut Attempt,
    token: &str,
    body: &[u8],
) -> Result<(u16, Zeroizing<Vec<u8>>), String> {
    if Instant::now() >= attempt.deadline {
        return Err("Setup expired. Cancel this attempt and restart setup on the box page.".into());
    }
    attempt.finalize_uncertain = true;
    attempt.escrow.retain_for_recovery();
    attempt
        .connection
        .request("POST", "/api/v1/identity/finalize", body, token)
        .await
        .map_err(|_| {
            "The box restarted or the setup connection was lost. Cancel and open a new setup link."
                .into()
        })
}

// Own the cleanup guard while parsing and validating every create response.
fn accept_pending(
    response: Result<(u16, Zeroizing<Vec<u8>>), remote_access::RemoteError>,
    escrow: password_store::Escrow,
) -> Result<(Pending, [u8; 16], password_store::Escrow), String> {
    let (status, bytes) = response.map_err(|_| {
        "The setup connection was lost. Cancel the pending setup before trying again."
    })?;
    if !(200..300).contains(&status) {
        return Err(safe_error(status, &bytes));
    }
    let pending: Pending = serde_json::from_slice(&bytes)
        .map_err(|_| "Invalid setup response. Cancel this attempt.")?;
    let nonce = pending.validate()?;
    Ok((pending, nonce, escrow))
}

pub async fn run(state: &NodeState, input: Input) -> Result<View, String> {
    if !cfg!(all(target_os = "macos", desktop, not(feature = "mobile"))) {
        return Err("Remote owner setup currently requires this Mac's Secure Enclave.".into());
    }
    let _recovery = state.remote_recovery.lock().await;
    let mut setup = state.remote_owner.lock().await;
    if !state.remote_mode.load(Ordering::SeqCst) {
        if let Some(attempt) = setup.attempt.take() {
            *attempt.password.lock().unwrap() = None;
        }
        return Err("Connect to your remote box before setup.".into());
    }
    if let Some(completion) = setup.completion.as_mut() {
        return match input {
            Input::Poll {} => resume(state, completion).await,
            _ => Err("Your identity was saved. Continue starting the box; setup can no longer be cancelled.".into()),
        };
    }
    let recover_lost = setup.attempt.as_ref().is_some_and(|a| a.finalize_uncertain)
        || (setup.attempt.is_none() && matches!(input, Input::Poll {}));
    if recover_lost {
        if !matches!(input, Input::Poll {}) {
            return Err(
                "Setup may already be committed. Check the box and continue recovery.".into(),
            );
        }
        let descriptor = state
            .remote_descriptor
            .lock()
            .unwrap()
            .clone()
            .ok_or("Missing box descriptor.")?;
        let ctx = state
            .pairing
            .lock()
            .unwrap()
            .clone()
            .ok_or("Pairing is unavailable.")?;
        if Recovery::load(&ctx.store)?.is_none() {
            return Err("No confirmed setup is waiting for recovery.".into());
        }
        let recovered = recovery::recover(state, &descriptor).await?;
        setup.attempt = None;
        if recovered.bootstrap_box_key().is_some() {
            return Err(
                "The box is still in setup. Cancel this pending setup before starting again."
                    .into(),
            );
        }
        home_unlock::probe(state).await?;
        return Ok(View::Done);
    }
    let result = run_pending(state, &mut setup, input).await;
    if result.is_err() && !setup.attempt.as_ref().is_some_and(|a| a.finalize_uncertain) {
        // A failed precommit step is an abort, even if the user never cancels.
        if let Some(attempt) = setup.attempt.take() {
            *attempt.password.lock().unwrap() = None;
        }
    }
    result
}

async fn run_pending(state: &NodeState, setup: &mut Setup, input: Input) -> Result<View, String> {
    match input {
        Input::Create {
            password,
            claim_code,
        } => {
            if setup.attempt.is_some() {
                return Err("A setup is already pending. Compare or cancel it first.".into());
            }
            if password.is_empty() || password.len() > 4096 {
                return Err("Choose a password of 1–4096 bytes for this box.".into());
            }
            let claim = Zeroizing::new(sas::claim_commitment(&claim_code).map_err(str::to_owned)?);
            drop(claim_code);
            if !device_available(state) {
                return Err("Enable Touch ID on this Mac before setting up the box.".into());
            }
            let descriptor = state
                .remote_descriptor
                .lock()
                .unwrap()
                .clone()
                .ok_or("Missing remote box.")?;
            let ctx = state
                .pairing
                .lock()
                .unwrap()
                .clone()
                .ok_or("Missing pairing.")?;
            let token = token(state).await?;
            let mut connection = BootstrapConnection::connect(&descriptor, &ctx.key, NAME)
                .await
                .map_err(|_| {
                    "The box restarted or setup is closed. Open a new link from the box page."
                })?;
            let (blob, record) = match local_key(&ctx.store) {
                Some((_, record)) if record.registered => {
                    return Err(
                        "This pairing already has an enrolled device. Open a new setup link."
                            .into(),
                    )
                }
                Some(key) => key,
                None => {
                    let (blob, public) = tokio::task::spawn_blocking(|| {
                        device_key::create(device_key::Policy::Biometry)
                    })
                    .await
                    .map_err(|_| "Creating the Secure Enclave key stopped.")?
                    .map_err(|_| "Could not create this Mac's Secure Enclave key.")?;
                    let record = device::Record {
                        public_key: hex::encode(public),
                        ..Default::default()
                    };
                    device::save_blob(&ctx.store, &blob).map_err(|e| e.message)?;
                    device::save_record(&ctx.store, &record).map_err(|e| e.message)?;
                    (blob, record)
                }
            };
            let box_key = descriptor
                .bootstrap_box_key()
                .ok_or("This box is already initialized.")?
                .to_owned();
            let (password, saved) = tokio::task::spawn_blocking(move || {
                let result = password_store::Escrow::save(box_key, password.as_bytes());
                (password, result)
            })
            .await
            .map_err(|_| "Saving the protected setup password stopped.")?;
            let escrow = saved?;
            let body = serde_json::to_vec(&serde_json::json!({"password_commitment":blake3::hash(password.as_bytes()).to_hex().to_string(),
                "sas_version":1,"device":{"public_key":record.public_key,"name":NAME}})).unwrap();
            let (pending, nonce, escrow) = accept_pending(
                connection
                    .request("POST", "/api/v1/identity/create-pending", &body, &token)
                    .await,
                escrow,
            )?;
            let public: [u8; 65] = hex::decode(&record.public_key)
                .ok()
                .and_then(|b| b.try_into().ok())
                .ok_or("Invalid local device key.")?;
            let digest = sas::digest(&connection.binding, &public, &nonce, &claim);
            let view = View::Compare {
                words: sas::words(&digest),
                expires_at: now_unix() + 900,
            };
            let deadline = Instant::now() + Duration::from_secs(900);
            let id = pending.ceremony_id.clone();
            let password = Arc::new(Mutex::new(Some(password)));
            let expiry_password = Arc::clone(&password);
            setup.attempt = Some(Attempt {
                connection,
                pending,
                password,
                digest,
                blob,
                record,
                proof: None,
                backup: None,
                finalize_uncertain: false,
                escrow,
                deadline,
            });
            // Provisional escrow and memory secrets expire even if the webview disappears.
            let state_slot = Arc::clone(&state.remote_owner);
            tokio::spawn(async move {
                tokio::time::sleep_until(deadline.into()).await;
                *expiry_password.lock().unwrap() = None;
                let mut setup = state_slot.lock().await;
                if setup
                    .attempt
                    .as_ref()
                    .is_some_and(|a| a.pending.ceremony_id == id)
                {
                    setup.attempt = None;
                }
            });
            Ok(view)
        }
        Input::Cancel {} => {
            // Dropping the password is unconditional, including network failure.
            let mut attempt = setup.attempt.take();
            if let Some(attempt) = attempt.as_mut() {
                *attempt.password.lock().unwrap() = None;
                attempt.escrow.clear()?;
            }
            // Local cleanup precedes every fallible token/network operation.
            let token = token(state).await?;
            let mut connection = match attempt {
                Some(attempt) => attempt.connection,
                None => {
                    let descriptor = state
                        .remote_descriptor
                        .lock()
                        .unwrap()
                        .clone()
                        .ok_or("Missing remote box.")?;
                    let ctx = state
                        .pairing
                        .lock()
                        .unwrap()
                        .clone()
                        .ok_or("Missing pairing.")?;
                    BootstrapConnection::connect(&descriptor, &ctx.key, NAME)
                        .await
                        .map_err(|_| "The box restarted. Open a new setup link.")?
                }
            };
            let (status, bytes) = connection.request("DELETE", "/api/v1/identity/pending/current", b"", &token).await
                .map_err(|_| "Words differ. The connection was lost; cancel setup on the box page before retrying.")?;
            if !(200..300).contains(&status) {
                return Err(safe_error(status, &bytes));
            }
            finish_cancel(state)?;
            Ok(View::WordsDiffer)
        }
        Input::Match {} => {
            let attempt = setup
                .attempt
                .as_mut()
                .ok_or("Setup expired or the box restarted. Open a new setup link.")?;
            if attempt.proof.is_some() {
                return Err(
                    "The comparison was already confirmed. Complete the backup check.".into(),
                );
            }
            if Instant::now() >= attempt.deadline {
                return Err("Setup expired. Cancel and start again.".into());
            }
            // Explicit Match is the only route to this biometric signature.
            let proof = setup_signature(
                attempt.blob.clone(),
                sas::registration_message(
                    &bitsov_app::home_node::identity_fingerprint(&attempt.pending.node_id),
                    &attempt.connection.client_id,
                    &attempt.record.public_key,
                    &attempt.digest,
                ),
                "Confirm the four words match your BitSov box page".into(),
                false,
            )
            .await
            .map_err(|e| e.message)?;
            if Instant::now() >= attempt.deadline {
                return Err(
                    "Setup expired while waiting for Touch ID. Cancel and start again.".into(),
                );
            }
            attempt.proof = Some(proof);
            let mnemonic =
                std::mem::replace(&mut attempt.pending.mnemonic, Zeroizing::new(String::new()));
            Ok(View::Backup {
                mnemonic,
                backup_check: attempt.pending.backup_check,
                expires_at: now_unix()
                    + attempt
                        .deadline
                        .saturating_duration_since(Instant::now())
                        .as_secs() as i64,
            })
        }
        Input::Finalize { backup_words } => {
            let attempt = setup
                .attempt
                .as_mut()
                .ok_or("Setup expired or the box restarted. Open a new setup link.")?;
            if attempt.proof.is_none() {
                return Err("Compare the words and choose Match with Touch ID first.".into());
            }
            if attempt.backup.is_some() {
                return Err("Confirmation already submitted. Wait for the box page.".into());
            }
            attempt.backup = Some(backup_words);
            submit(state, setup).await
        }
        Input::Poll {} => {
            if setup
                .attempt
                .as_ref()
                .is_some_and(|a| a.backup.is_some() && a.proof.is_some())
            {
                submit(state, setup).await
            } else {
                Err("No confirmed setup is waiting for box approval.".into())
            }
        }
    }
}

// Called only after the box confirms cancellation. A recovered/restarted
// attempt may no longer have an in-memory escrow owner.
fn finish_cancel(state: &NodeState) -> Result<(), String> {
    if let Some(key) = state
        .remote_descriptor
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|d| d.bootstrap_box_key())
    {
        password_store::forget(key)?;
    }
    if let Some(ctx) = state.pairing.lock().unwrap().as_ref() {
        Recovery::clear(&ctx.store)?;
    }
    Ok(())
}

async fn submit(state: &NodeState, setup: &mut Setup) -> Result<View, String> {
    let token = token(state).await?;
    let attempt = setup.attempt.as_mut().ok_or("Setup expired.")?;
    #[derive(Serialize)]
    struct Device<'a> {
        public_key: &'a str,
        name: &'a str,
        proof: &'a str,
    }
    #[derive(Serialize)]
    struct Body<'a> {
        ceremony_id: &'a str,
        backup_words: &'a [Zeroizing<String>; 3],
        device: Device<'a>,
        password: &'a str,
        sas_version: u8,
        sas_digest: String,
    }
    let password = attempt
        .password
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| Zeroizing::new(p.as_str().to_owned()))
        .ok_or("Setup password expired. Cancel and start again.")?;
    let body = Zeroizing::new(
        serde_json::to_vec(&Body {
            ceremony_id: &attempt.pending.ceremony_id,
            backup_words: attempt
                .backup
                .as_ref()
                .ok_or("Confirm your backup first.")?,
            device: Device {
                public_key: &attempt.record.public_key,
                name: NAME,
                proof: attempt.proof.as_deref().ok_or("Compare the words first.")?,
            },
            password: &password,
            sas_version: 1,
            sas_digest: attempt.digest.to_hex().to_string(),
        })
        .map_err(|_| "Could not encode setup confirmation.")?,
    );
    let ctx = state
        .pairing
        .lock()
        .unwrap()
        .clone()
        .ok_or("Pairing is unavailable.")?;
    let descriptor = state
        .remote_descriptor
        .lock()
        .unwrap()
        .clone()
        .ok_or("Missing box descriptor.")?;
    let public = hex::decode(&attempt.record.public_key).map_err(|_| "Invalid device key.")?;
    Recovery {
        node_id: attempt.pending.node_id.clone(),
        box_key: hex::encode(attempt.connection.binding.box_public_key),
        endpoint: descriptor.endpoint().into(),
        client_public_key: ctx.key.public_hex().into(),
        binding: bootstrap_binding(
            &token,
            &attempt.connection.client_id,
            &attempt.pending.node_id,
        )?,
        device_public_key: attempt.record.public_key.clone(),
        device_key_id: device::key_id(&public),
        password_saved: false,
    }
    .save(&ctx.store)?;
    // Write-ahead context is durable before the node can commit. A lost reply
    // must never cause a passive poll to submit the password/finalize again.
    let (status, bytes) =
        request_finalize(attempt, &token, &body).await
            .map_err(|_| "The finalize reply was lost. Check the box and continue to recover over its pinned locked connection.")?;
    drop(body);
    drop(password);
    if status == 409 && safe_error(status, &bytes) == "box_approval_pending" {
        attempt.finalize_uncertain = false;
        attempt.escrow.resume_cleanup();
        Recovery::clear(&ctx.store)?;
        return Ok(View::WaitingForBoxApproval);
    }
    if !(200..300).contains(&status) {
        // A server error may follow commit. Keep recovery-only behavior for 5xx.
        attempt.finalize_uncertain = status >= 500;
        if !attempt.finalize_uncertain {
            attempt.escrow.resume_cleanup();
            Recovery::clear(&ctx.store)?;
        }
        let error = safe_error(status, &bytes);
        // A failed backup must never be resubmitted by passive polling.
        attempt.backup = None;
        if error.starts_with("The backup words did not match") {
            return Ok(View::BackupCheck {
                backup_check: attempt.pending.backup_check,
            });
        }
        return Err(error);
    }
    let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|_| {
        "Setup may have completed, but its receipt was invalid. Check the box before retrying."
    })?;
    receipt.verify(attempt)?;
    let binding = receipt.binding(&token)?;
    let attempt = setup.attempt.take().ok_or("Missing setup attempt.")?;
    setup.completion = Some(Completion {
        receipt,
        binding,
        blob: attempt.blob,
        record: attempt.record,
        // Detach from the precommit expiry task; postcommit gets its own 120 s cap.
        password: Arc::new(Mutex::new(attempt.password.lock().unwrap().take())),
        deadline: Instant::now() + Duration::from_secs(120),
        descriptor: None,
        stage: CompletionStage::Persist,
    });
    let expiry_password = Arc::clone(&setup.completion.as_ref().unwrap().password);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(120)).await;
        *expiry_password.lock().unwrap() = None;
    });
    resume(state, setup.completion.as_mut().unwrap()).await
}

#[derive(Deserialize)]
struct Receipt {
    node_id: String,
    client_id: String,
    epoch: u64,
    restart_required: bool,
    device_key_id: String,
    box_transport_pubkey: String,
    box_transport_signature: String,
    transport_pubkey: String,
    transport_signature: String,
}
impl Receipt {
    fn verify(&self, attempt: &Attempt) -> Result<(), String> {
        self.verify_context(
            &attempt.pending.node_id,
            &attempt.connection.client_id,
            &attempt.record.public_key,
            &hex::encode(attempt.connection.binding.box_public_key),
        )
    }

    fn verify_context(
        &self,
        node: &str,
        client: &str,
        device_public: &str,
        box_key: &str,
    ) -> Result<(), String> {
        let public = hex::decode(device_public).map_err(|_| "Invalid device key.")?;
        if self.node_id != node
            || self.client_id != client
            || !self.restart_required
            || self.device_key_id != device::key_id(&public)
            || self.box_transport_pubkey != box_key
        {
            return Err(
                "Setup receipt did not match this box and device. Nothing was re-pinned.".into(),
            );
        }
        BoxPin::verify(
            &self.node_id,
            "unused",
            &self.box_transport_pubkey,
            &self.box_transport_signature,
        )
        .map_err(|_| "The box's setup receipt had an invalid identity signature.".to_string())?;
        remote_access::verify_transport_proof(
            &self.node_id,
            &self.transport_pubkey,
            &self.transport_signature,
        )
        .map_err(|_| "The setup receipt had an invalid live transport signature.".to_string())?;
        Ok(())
    }

    fn binding(&self, token: &str) -> Result<UnlockBinding, String> {
        let binding = bootstrap_binding(token, &self.client_id, &self.node_id)?;
        if binding.epoch != self.epoch {
            return Err("The setup receipt changed the pairing epoch.".into());
        }
        Ok(UnlockBinding {
            client_id: self.client_id.clone(),
            epoch: self.epoch,
            fingerprint: binding.fingerprint,
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CompletionStage {
    Persist,
    Restart,
    Reconnect,
    Done,
}
struct Completion {
    receipt: Receipt,
    binding: UnlockBinding,
    blob: Vec<u8>,
    record: device::Record,
    password: Arc<Mutex<Option<Zeroizing<String>>>>,
    deadline: Instant,
    descriptor: Option<remote_access::RemoteDescriptor>,
    stage: CompletionStage,
}

async fn resume(state: &NodeState, completion: &mut Completion) -> Result<View, String> {
    let ctx = state
        .pairing
        .lock()
        .unwrap()
        .clone()
        .ok_or("Pairing is unavailable.")?;
    if completion.stage == CompletionStage::Persist {
        let descriptor = if let Some(descriptor) = &completion.descriptor {
            descriptor.clone()
        } else {
            let previous = state
                .remote_descriptor
                .lock()
                .unwrap()
                .clone()
                .ok_or("Missing box descriptor.")?;
            let descriptor = remote_access::commit_bootstrap(
                &ctx.data_dir,
                &previous,
                &completion.receipt.node_id,
                &completion.receipt.box_transport_pubkey,
                &completion.receipt.box_transport_signature,
                &completion.receipt.transport_pubkey,
                &completion.receipt.transport_signature,
            )
            .map_err(|e| e.to_string())?;
            completion.descriptor = Some(descriptor.clone());
            descriptor
        };
        // Only the verified receipt may choose a node-scoped credential name.
        // Before this point the password lives in a domain-separated box escrow.
        let node = completion.receipt.node_id.clone();
        let password = completion
            .password
            .lock()
            .unwrap()
            .as_ref()
            .map(|p| Zeroizing::new(p.as_str().to_owned()))
            .ok_or(
                "Setup password left memory. Recover with your saved password or recovery backup.",
            )?;
        tokio::task::spawn_blocking(move || {
            home_keychain::save_password(&node, password.as_bytes())
        })
        .await
        .map_err(|_| "Saving the node password stopped; continue setup to retry.")??;
        let mut recovery =
            Recovery::load(&ctx.store)?.ok_or("Missing first-run recovery context.")?;
        recovery.verify_binding(&completion.receipt.node_id, &completion.binding)?;
        recovery.password_saved = true;
        recovery.save(&ctx.store)?;
        completion.record.key_id = Some(completion.receipt.device_key_id.clone());
        completion.record.registered = true;
        completion.record.pending = None;
        device::save_record(&ctx.store, &completion.record).map_err(|e| e.message)?;
        home_keychain::save_binding(&completion.receipt.node_id, &completion.binding)?;
        let pin = descriptor
            .box_pin()
            .map_err(|e| e.to_string())?
            .ok_or("Missing committed box pin.")?;
        home_keychain::MacBoxPins
            .save(&pin)
            .map_err(|e| e.to_string())?;
        if let Some(proxy) = state.remote_proxy.lock().unwrap().as_ref() {
            proxy
                .finish_bootstrap(descriptor.clone())
                .map_err(|e| e.to_string())?;
        }
        *state.remote_descriptor.lock().unwrap() = Some(descriptor);
        *state.expected_remote_node_id.lock().unwrap() = Some(completion.receipt.node_id.clone());
        *state.node_id.lock().unwrap() = Some(completion.receipt.node_id.clone());
        *state.token.lock().unwrap() = None;
        *state.auth.lock().unwrap() = AuthMode::Unauthenticated;
        *state.ready.lock().unwrap() = false;
        password_store::forget(&completion.receipt.box_transport_pubkey)?;
        completion.stage = CompletionStage::Restart;
        return Ok(View::Starting);
    }
    let descriptor = completion
        .descriptor
        .as_ref()
        .ok_or("Missing committed box descriptor.")?;
    if completion.stage == CompletionStage::Restart {
        if Instant::now() >= completion.deadline || completion.password.lock().unwrap().is_none() {
            *completion.password.lock().unwrap() = None;
            state.home_locked.store(true, Ordering::SeqCst);
            return Err("Your box was set up and the password saved. The first-unlock window expired; unlock with Touch ID.".into());
        }
        let remaining = completion
            .deadline
            .saturating_duration_since(Instant::now());
        let connected = tokio::time::timeout(
            remaining,
            state
                .remote_retry
                .run(|| remote_access::LockedConnection::connect(descriptor, &ctx.key, NAME)),
        )
        .await;
        let mut connection = match connected {
            Err(_) => {
                *completion.password.lock().unwrap() = None;
                return Err("The first unlock expired. Unlock with Touch ID.".into());
            }
            Ok(result) => match result {
                Ok(Some(connection)) => connection,
                Ok(None) => {
                    completion.stage = CompletionStage::Reconnect;
                    return Ok(View::Starting);
                }
                Err(
                    remote_access::RemoteError::HandshakeUnavailable
                    | remote_access::RemoteError::RateLimited(_)
                    | remote_access::RemoteError::Waiting(_),
                ) => return Ok(View::Starting),
                Err(_) => return Err(
                    "Your box restarted but did not authenticate. Check the box before continuing."
                        .into(),
                ),
            },
        };
        if connection.client_id != completion.binding.client_id {
            return Err("The locked node changed the setup client binding.".into());
        }
        let challenge = connection.challenge().await.map_err(|e| e.to_string())?;
        let pin = &connection.pin;
        let key_id = completion
            .record
            .key_id
            .as_deref()
            .ok_or("Missing device key.")?;
        let message =
            challenge.message(&completion.binding, key_id, &pin.public_key, now_unix())?;
        let signature = setup_signature(
            completion.blob.clone(),
            message,
            "Start your newly configured BitSov box".into(),
            true,
        )
        .await
        .map_err(|_| {
            *completion.password.lock().unwrap() = None;
            state.home_locked.store(true, Ordering::SeqCst);
            "The setup approval expired. Unlock your box with Touch ID to continue.".to_string()
        })?;
        if Instant::now() >= completion.deadline {
            *completion.password.lock().unwrap() = None;
            return Err("The first unlock expired. Unlock with Touch ID.".into());
        }
        let password = completion
            .password
            .lock()
            .unwrap()
            .take()
            .ok_or("Unlock with Touch ID to continue.")?;
        // No automatic replay after a lost unlock response. Reconnection proves readiness.
        completion.stage = CompletionStage::Reconnect;
        connection
            .unlock(&bitsov_app::home_node::UnlockBody {
                challenge: challenge.challenge,
                key_id: key_id.into(),
                signature,
                password,
            })
            .await
            .map_err(|_| {
                "Your box may have unlocked. Check its connection before unlocking again."
            })?;
        return Ok(View::Starting);
    }
    if completion.stage == CompletionStage::Reconnect {
        if !descriptor.has_live_pin() {
            return Err("The box has not provided its signed live transport key. Reconnect while it is locked to recover the proof.".into());
        }
        // Use bounded authenticated connection attempts; UI polling drives retries.
        if state.remote_proxy.lock().unwrap().is_none() {
            let proxy = remote_access::start_proxy(
                &state.api_base,
                &ctx.data_dir,
                descriptor.clone(),
                ctx.key.clone(),
                PAIRING_CLIENT_NAME,
                ctx.store.clone(),
                state.remote_proxy_auth.clone(),
                state.remote_retry.clone(),
            )
            .await
            .map_err(|e| e.to_string())?;
            *state.remote_proxy.lock().unwrap() = Some(proxy);
        }
        // One bounded authentication pass; later polls can retry connectivity.
        let _ =
            tokio::time::timeout(Duration::from_secs(30), finish_auth(state, &ctx.data_dir)).await;
        if !*state.ready.lock().unwrap() {
            return Ok(View::Starting);
        }
        completion.stage = CompletionStage::Done;
    }
    Ok(View::Done)
}

async fn setup_signature(
    blob: Vec<u8>,
    message: String,
    reason: String,
    finish: bool,
) -> Result<String, ActionError> {
    tokio::task::spawn_blocking(move || {
        device_key::sign_setup(&blob, message.as_bytes(), &reason, finish)
    })
    .await
    .map_err(|_| ActionError::new("device_key", "The setup biometric request stopped."))?
    .map(hex::encode)
    .map_err(device_error)
}

fn bootstrap_binding(token: &str, client_id: &str, node: &str) -> Result<UnlockBinding, String> {
    use base64::Engine;
    #[derive(Deserialize)]
    struct Claims {
        cid: String,
        epc: u64,
    }
    if token.split('.').count() != 3 {
        return Err("Invalid bootstrap pairing binding.".into());
    }
    let claims: Claims = token
        .split('.')
        .nth(1)
        .and_then(|p| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(p)
                .ok()
        })
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or("Invalid bootstrap pairing binding.")?;
    if claims.cid != client_id {
        return Err("Bootstrap client binding changed.".into());
    }
    Ok(UnlockBinding {
        client_id: claims.cid,
        epoch: claims.epc,
        fingerprint: bitsov_app::home_node::identity_fingerprint(node),
    })
}

/// True while a first-run recovery journal is unresolved for the saved node.
/// Replacing the remote link then would make the next start check the new node
/// against the old journal and refuse it, so callers must not replace.
pub fn has_pending_recovery(store: &Path) -> Result<bool, String> {
    Ok(Recovery::load(store)?.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confirmed_cancel_cleans_retained_escrow_after_attempt_was_lost() {
        use base64::Engine;
        let key = password_store::test_store::key();
        let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("pairing");
        *state.pairing.lock().unwrap() = Some(Arc::new(PairingCtx {
            client: PairingClient::new(state.http.clone(), state.api_base.clone()),
            key: Arc::new(ClientKey::load_or_create(&store).unwrap()),
            store: store.clone(),
            data_dir: dir.path().to_path_buf(),
        }));
        let value = serde_json::json!({"v":1,"endpoint":"box.local:9737",
            "box_transport_pubkey":key,"code":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([3;32])});
        let link = format!(
            "bitsov://pair/{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&value).unwrap())
        );
        *state.remote_descriptor.lock().unwrap() =
            Some(remote_access::parse_pairing_link(&link).unwrap());
        let saved = Recovery {
            node_id: "ab".repeat(32),
            box_key: key.clone(),
            endpoint: "box.local:9737".into(),
            client_public_key: "33".repeat(32),
            device_public_key: "04".repeat(65),
            device_key_id: "key".into(),
            password_saved: false,
            binding: UnlockBinding {
                client_id: "client".into(),
                epoch: 7,
                fingerprint: "fp".into(),
            },
        };
        saved.save(&store).unwrap();
        let mut escrow = password_store::Escrow::save(key.clone(), b"password").unwrap();
        escrow.retain_for_recovery();
        // Lost finalize -> recovery finds SETUP, or the app restarts/expires.
        // The attempt is gone, but its escrow and journal remain recoverable.
        drop(escrow);
        assert!(password_store::test_store::contains(&key));
        assert!(state.remote_owner.try_lock().unwrap().attempt.is_none());
        finish_cancel(&state).unwrap();
        assert!(!password_store::test_store::contains(&key));
        assert!(Recovery::load(&store).unwrap().is_none());
    }

    #[test]
    fn pending_recovery_is_reported_until_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("pairing");
        std::fs::create_dir_all(&store).unwrap();
        assert!(!has_pending_recovery(&store).unwrap());
        let saved = Recovery {
            node_id: "ab".repeat(32),
            box_key: "k".into(),
            endpoint: "box.local:9737".into(),
            client_public_key: "33".repeat(32),
            device_public_key: "04".repeat(65),
            device_key_id: "key".into(),
            password_saved: false,
            binding: UnlockBinding {
                client_id: "client".into(),
                epoch: 7,
                fingerprint: "fp".into(),
            },
        };
        saved.save(&store).unwrap();
        assert!(has_pending_recovery(&store).unwrap());
        Recovery::clear(&store).unwrap();
        assert!(!has_pending_recovery(&store).unwrap());
    }

    #[test]
    fn create_failures_release_escrow_without_cancel() {
        let valid = serde_json::json!({"ceremony_id":"a".repeat(32), "node_id":"b".repeat(64),
            "mnemonic":"abandon ability able about above absent absorb abstract absurd abuse access accident",
            "backup_check":[0,4,9],"expires_at":1,"sas_version":1,"box_nonce":"55".repeat(16)});
        let mut invalid = valid.clone();
        invalid["box_nonce"] = "invalid".into();
        for response in [
            Err(remote_access::RemoteError::HandshakeUnavailable),
            Ok((
                409,
                Zeroizing::new(br#"{"code":"ceremony_in_progress"}"#.to_vec()),
            )),
            Ok((500, Zeroizing::new(b"{}".to_vec()))),
            Ok((200, Zeroizing::new(b"not json".to_vec()))),
            Ok((200, Zeroizing::new(b"{}".to_vec()))),
            Ok((200, Zeroizing::new(serde_json::to_vec(&invalid).unwrap()))),
        ] {
            let key = password_store::test_store::key();
            let escrow = password_store::Escrow::save(key.clone(), b"password").unwrap();
            assert!(accept_pending(response, escrow).is_err());
            assert!(!password_store::test_store::contains(&key));
        }
        let key = password_store::test_store::key();
        let escrow = password_store::Escrow::save(key.clone(), b"password").unwrap();
        let pending = accept_pending(
            Ok((200, Zeroizing::new(serde_json::to_vec(&valid).unwrap()))),
            escrow,
        )
        .unwrap();
        assert!(password_store::test_store::contains(&key));
        // An abort after validation (e.g. invalid local public key) still cleans up.
        drop(pending);
        assert!(!password_store::test_store::contains(&key));
    }

    #[test]
    fn pr287_sas_receipt_requires_live_proof_and_pairing_binding() {
        let value = serde_json::json!({"node_id":"ab".repeat(32),"restart_required":true,
            "device_key_id":"key","box_transport_pubkey":"22".repeat(32),
            "box_transport_signature":"box-proof","transport_pubkey":"33".repeat(32),
            "transport_signature":"live-proof","client_id":"a".repeat(32),"epoch":7});
        for field in [
            "transport_pubkey",
            "transport_signature",
            "client_id",
            "epoch",
        ] {
            let mut missing = value.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<Receipt>(missing).is_err(),
                "accepted missing {field}"
            );
        }
        assert!(serde_json::from_value::<Receipt>(value).is_ok());
    }

    #[test]
    fn pr287_receipt_verifies_both_domains_and_preserved_binding() {
        use base64::Engine;
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/remote-first-run-pr287.json"
        ))
        .unwrap();
        let public = [4u8; 65];
        let mut value = fixture["finalize"].clone();
        value["device_key_id"] = hex::encode(&blake3::hash(&public).as_bytes()[..16]).into();
        let node = value["node_id"].as_str().unwrap();
        let client = value["client_id"].as_str().unwrap();
        let box_key = value["box_transport_pubkey"].as_str().unwrap();
        let verify = |v: serde_json::Value| {
            serde_json::from_value::<Receipt>(v)
                .unwrap()
                .verify_context(node, client, &hex::encode(public), box_key)
        };
        verify(value.clone()).unwrap();
        for field in [
            "node_id",
            "client_id",
            "device_key_id",
            "box_transport_pubkey",
            "box_transport_signature",
            "transport_pubkey",
            "transport_signature",
        ] {
            let mut bad = value.clone();
            bad[field] = "invalid".into();
            assert!(verify(bad).is_err(), "{field}");
        }
        let mut wrong_domain = value.clone();
        wrong_domain["transport_signature"] = value["box_transport_signature"].clone();
        assert!(verify(wrong_domain).is_err());
        let receipt: Receipt = serde_json::from_value(value.clone()).unwrap();
        let token = |cid: &str, epoch: u64| {
            format!(
                "h.{}.s",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&serde_json::json!({"cid":cid,"epc":epoch})).unwrap()
                )
            )
        };
        assert_eq!(receipt.binding(&token(client, 7)).unwrap().epoch, 7);
        assert!(receipt.binding(&token(client, 8)).is_err());
        assert!(receipt.binding(&token("other", 7)).is_err());
        for bad in [
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!("7"),
            serde_json::Value::Null,
        ] {
            let mut malformed = value.clone();
            malformed["epoch"] = bad;
            assert!(serde_json::from_value::<Receipt>(malformed).is_err());
        }
    }

    #[test]
    fn pending_rejects_missing_sas_downgrade_malformed_nonce_and_bad_backup() {
        let value = serde_json::json!({"ceremony_id":"a".repeat(32), "node_id":"b".repeat(64),
            "mnemonic":"abandon ability able about above absent absorb abstract absurd abuse access accident",
            "backup_check":[0,4,9],"expires_at":1,"sas_version":1,"box_nonce":"55".repeat(16)});
        let valid: Pending = serde_json::from_value(value.clone()).unwrap();
        // A box without RTC can have a wall clock far behind this Mac.
        assert_eq!(valid.validate().unwrap(), [0x55; 16]);
        for (field, bad) in [
            ("sas_version", serde_json::json!(0)),
            ("box_nonce", serde_json::json!("bad")),
            ("backup_check", serde_json::json!([0, 0, 9])),
            ("backup_check", serde_json::json!([0, 4, 24])),
            ("node_id", serde_json::json!("wrong")),
            ("ceremony_id", serde_json::json!("../current")),
        ] {
            let mut tampered = value.clone();
            tampered[field] = bad;
            let pending: Pending = serde_json::from_value(tampered).unwrap();
            assert!(pending.validate().is_err(), "{field}");
        }
        let mut downgrade = value;
        downgrade.as_object_mut().unwrap().remove("sas_version");
        assert!(serde_json::from_value::<Pending>(downgrade).is_err());
    }
    #[test]
    fn errors_never_echo_password_phrase_or_unknown_node_text() {
        for status in [400, 403, 409, 410, 429, 500] {
            let error = safe_error(
                status,
                br#"{"error":"password-secret abandon phrase","code":"unknown-secret"}"#,
            );
            assert!(!error.contains("password-secret"));
            assert!(!error.contains("abandon"));
            assert!(!error.contains("unknown-secret"));
        }
        assert_eq!(
            safe_error(409, br#"{"code":"box_approval_pending"}"#),
            "box_approval_pending"
        );
        assert!(safe_error(403, br#"{"code":"setup_closed"}"#).contains("three failed"));
        assert!(safe_error(403, br#"{"code":"sas_mismatch"}"#).contains("Words differ"));
        assert!(safe_error(410, b"{}").contains("restarted"));
    }
    #[test]
    fn renderer_cannot_supply_sas_digest_keys_or_fake_confirmation() {
        for body in [
            r#"{"action":"match","sas_digest":"fake"}"#,
            r#"{"action":"poll","confirmed":true}"#,
            r#"{"action":"create","password":"typed","claim_code":"physical","device":{"public_key":"fake"}}"#,
        ] {
            assert!(serde_json::from_str::<Input>(body).is_err());
        }
        let view = serde_json::to_value(View::Compare {
            words: ["noodle", "gallery", "demand", "science"],
            expires_at: 1,
        })
        .unwrap();
        assert_eq!(view.as_object().unwrap().len(), 3);
        assert!(view.get("password").is_none());
        assert!(view.get("mnemonic").is_none());
        assert!(view.get("sas_digest").is_none());
    }
    #[test]
    fn bootstrap_binding_is_bound_to_authenticated_client_and_committed_fingerprint() {
        use base64::Engine;
        let payload =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"cid":"client","epc":7}"#);
        let jwt = format!("h.{payload}.s");
        let binding = bootstrap_binding(&jwt, "client", &"ab".repeat(32)).unwrap();
        assert_eq!(binding.epoch, 7);
        assert_eq!(binding.client_id, "client");
        assert_eq!(
            binding.fingerprint,
            bitsov_app::home_node::identity_fingerprint(&"ab".repeat(32))
        );
        assert!(bootstrap_binding(&jwt, "other", &"ab".repeat(32)).is_err());
    }
    #[tokio::test]
    async fn passive_status_does_not_interrupt_the_first_restart() {
        let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
        state.remote_mode.store(true, Ordering::SeqCst);
        let payload = serde_json::json!({"v":1,"endpoint":"box.local:9737", "box_transport_pubkey":"22".repeat(32),
            "code":base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, [3;32])});
        let link = format!(
            "bitsov://pair/{}",
            base64::Engine::encode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                serde_json::to_vec(&payload).unwrap()
            )
        );
        *state.remote_descriptor.lock().unwrap() =
            Some(remote_access::parse_pairing_link(&link).unwrap());
        state.remote_owner.lock().await.completion = Some(Completion {
            receipt: Receipt {
                node_id: "ab".repeat(32),
                client_id: "client".into(),
                epoch: 0,
                restart_required: true,
                device_key_id: "key".into(),
                box_transport_pubkey: "22".repeat(32),
                box_transport_signature: String::new(),
                transport_pubkey: String::new(),
                transport_signature: String::new(),
            },
            binding: UnlockBinding {
                client_id: "client".into(),
                epoch: 0,
                fingerprint: "fp".into(),
            },
            blob: vec![],
            record: device::Record::default(),
            password: Arc::new(Mutex::new(None)),
            deadline: Instant::now(),
            descriptor: None,
            stage: CompletionStage::Restart,
        });
        home_unlock::refresh(&state).await;
        assert!(!state.home_locked.load(Ordering::SeqCst));
        assert!(state.error.lock().unwrap().is_none());
        assert!(state.home_last_probe.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn passive_poll_and_finalize_never_create_or_approve_a_ceremony() {
        let state = NodeState::for_api("http://127.0.0.1:1/api/v1");
        state.remote_mode.store(true, Ordering::SeqCst);
        assert!(run(&state, Input::Poll {}).await.is_err());
        assert!(run(&state, Input::Match {}).await.is_err());
        assert!(run(
            &state,
            Input::Finalize {
                backup_words: std::array::from_fn(|_| Zeroizing::new("word".into()))
            }
        )
        .await
        .is_err());
        assert!(state.remote_owner.lock().await.attempt.is_none());
    }
}
