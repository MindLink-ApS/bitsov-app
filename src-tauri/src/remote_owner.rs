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
async fn request(
    attempt: &mut Attempt,
    token: &str,
    method: &str,
    path: &str,
    body: &[u8],
) -> Result<(u16, Zeroizing<Vec<u8>>), String> {
    if Instant::now() >= attempt.deadline {
        return Err("Setup expired. Cancel this attempt and restart setup on the box page.".into());
    }
    attempt
        .connection
        .request(method, path, body, token)
        .await
        .map_err(|_| {
            "The box restarted or the setup connection was lost. Cancel and open a new setup link."
                .into()
        })
}

pub async fn run(state: &NodeState, input: Input) -> Result<View, String> {
    if !cfg!(all(target_os = "macos", desktop, not(feature = "mobile"))) {
        return Err("Remote owner setup currently requires this Mac's Secure Enclave.".into());
    }
    let _recovery = state.remote_recovery.lock().await;
    let mut setup = state.remote_owner.lock().await;
    if !state.remote_mode.load(Ordering::SeqCst) {
        return Err("Connect to your remote box before setup.".into());
    }
    if let Some(completion) = setup.completion.as_mut() {
        return match input {
            Input::Poll {} => resume(state, completion).await,
            _ => Err("Your identity was saved. Continue starting the box; setup can no longer be cancelled.".into()),
        };
    }
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
                let result = password_store::save(&box_key, password.as_bytes());
                (password, result)
            })
            .await
            .map_err(|_| "Saving the protected setup password stopped.")?;
            saved?;
            let body = serde_json::to_vec(&serde_json::json!({"password_commitment":blake3::hash(password.as_bytes()).to_hex().to_string(),
                "sas_version":1,"device":{"public_key":record.public_key,"name":NAME}})).unwrap();
            let (status, bytes) = connection
                .request("POST", "/api/v1/identity/create-pending", &body, &token)
                .await
                .map_err(|_| {
                    "The setup connection was lost. Cancel the pending setup before trying again."
                })?;
            if !(200..300).contains(&status) {
                return Err(safe_error(status, &bytes));
            }
            let pending: Pending = serde_json::from_slice(&bytes)
                .map_err(|_| "Invalid setup response. Cancel this attempt.")?;
            let nonce = pending.validate()?;
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
                deadline,
            });
            // Memory-only secrets expire even if the webview disappears.
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
            let attempt = setup.attempt.take();
            let token = token(state).await?;
            let mut connection = match attempt {
                Some(attempt) => {
                    *attempt.password.lock().unwrap() = None;
                    attempt.connection
                }
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
            if let Some(key) = state
                .remote_descriptor
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|d| d.bootstrap_box_key())
            {
                password_store::forget(key)?;
            }
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
            submit(state, &mut setup).await
        }
        Input::Poll {} => {
            if setup
                .attempt
                .as_ref()
                .is_some_and(|a| a.backup.is_some() && a.proof.is_some())
            {
                submit(state, &mut setup).await
            } else {
                Err("No confirmed setup is waiting for box approval.".into())
            }
        }
    }
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
    let (status, bytes) =
        request(attempt, &token, "POST", "/api/v1/identity/finalize", &body).await?;
    drop(body);
    drop(password);
    if status == 409 && safe_error(status, &bytes) == "box_approval_pending" {
        return Ok(View::WaitingForBoxApproval);
    }
    if !(200..300).contains(&status) {
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
    let binding = bootstrap_binding(&token, &attempt.connection.client_id, &receipt.node_id)?;
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
    restart_required: bool,
    device_key_id: String,
    box_transport_pubkey: String,
    box_transport_signature: String,
    #[serde(default)]
    transport_pubkey: String,
    #[serde(default)]
    transport_signature: String,
}
impl Receipt {
    fn verify(&self, attempt: &Attempt) -> Result<(), String> {
        let public = hex::decode(&attempt.record.public_key).map_err(|_| "Invalid device key.")?;
        if self.node_id != attempt.pending.node_id
            || !self.restart_required
            || self.device_key_id != hex::encode(&blake3::hash(&public).as_bytes()[..16])
            || self.box_transport_pubkey != hex::encode(attempt.connection.binding.box_public_key)
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
        Ok(())
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
            return Err("Your box is set up, but this node version did not return its signed live transport key. Import a new identity-signed pairing link from the unlocked box to reconnect. Your password is saved behind Touch ID.".into());
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

#[cfg(test)]
mod tests {
    use super::*;
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
