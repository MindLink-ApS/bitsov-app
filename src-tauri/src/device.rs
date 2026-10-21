//! This Mac as a paired device (relation ladder steps 1–2, app side), and the
//! app's persisted approval state (step 3).
//!
//! The device key lives in the Secure Enclave ([`crate::device_key`]); the
//! app keeps only its device-bound blob and public key. The node registers the
//! public key once, after console approval or delegation by another enrolled
//! owner device. A device never approves its own enrollment. After that, a spend
//! envelope for one contact is a [`Intent`] the owner signs here with Touch
//! ID: the node verifies the signature over the exact bytes built by
//! [`intent_message`] and enforces the terms itself.
//!
//! Nothing here holds authority on its own. The blob signs nothing without
//! the owner's finger, and a signature is only the terms it covers.

use bitsov_app::format::amount;
#[cfg(unix)]
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use bitsov_app::act::{ActionError, Elevation};

/// Display name sent with a device registration on this operating system.
pub fn registration_name(platform: &str) -> &'static str {
    match platform {
        "ios" => "BitSov app on this iPhone",
        "android" => "BitSov app on this Android phone",
        "macos" => "BitSov app on this Mac",
        "windows" => "BitSov app on Windows",
        "linux" => "BitSov app on Linux",
        _ => "BitSov app on this device",
    }
}

/// The enclave key blob, under the pairing store.
pub const BLOB_FILE: &str = "device-key.blob";
/// What the node said about the key, under the pairing store.
pub const RECORD_FILE: &str = "device-key.json";

/// Contact envelope defaults (research doc: 200 sats per day).
pub const DEFAULT_BUDGET_MSAT: u64 = 200_000;
/// One day, the node's longest envelope.
pub const DEFAULT_WINDOW_SECS: i64 = 86_400;
/// The Contact level of the relation ladder.
pub const LEVEL_CONTACT: u8 = 1;

/// The registration as this app last saw it. Public data only.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct Record {
    /// X9.63 public key, hex.
    pub public_key: String,
    /// Key id the node assigned (`blake3(pub)[..16]`), once it answered.
    #[serde(default)]
    pub key_id: Option<String>,
    /// Short fingerprint the owner compares at the node.
    #[serde(default)]
    pub fingerprint: Option<String>,
    /// The owner approved it at the node.
    #[serde(default)]
    pub registered: bool,
    /// The registration awaiting the owner, if any.
    #[serde(default)]
    pub pending: Option<PendingRegistration>,
}

/// Node owner-device id: the first 16 BLAKE3 bytes of the SEC1 public key.
pub fn key_id(public: &[u8]) -> String {
    hex::encode(&blake3::hash(public).as_bytes()[..16])
}

/// A registration the owner has not approved yet.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PendingRegistration {
    #[serde(default)]
    pub delegation_message: Option<String>,
    pub op_id: String,
    /// The node's own words: `konsensus device approve --op … --config …`.
    pub owner_action: String,
    pub expires_at_ms: u64,
}

/// What the renderer is told. No blob, no key material beyond the fingerprint.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DeviceView {
    pub delegation_supported: bool,
    pub second_device: bool,
    pub owner_device_count: Option<u64>,
    /// This Mac has a Secure Enclave the app can use.
    pub available: bool,
    pub state: DeviceState,
    pub fingerprint: Option<String>,
    pub owner_action: Option<String>,
    pub expires_at_ms: Option<u64>,
    /// When the node has Touch ID approvals off: its reason code
    /// (`seed_not_encrypted`, …) and what the owner is told.
    pub off_reason: Option<String>,
    pub off_message: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeviceState {
    /// No Secure Enclave, or not macOS: the console grant stays the path.
    Unavailable,
    /// Not set up yet.
    None,
    /// Waiting for the owner's one-time approval at the node.
    Pending,
    /// Registered: spend envelopes are approved with Touch ID.
    Registered,
    /// The last registration request lapsed or was cancelled by wrong codes.
    Lapsed,
    /// The node has device approvals off (e.g. its recovery phrase is not
    /// encrypted). Nothing device-signed works until the owner fixes that.
    Off,
}

/// The node's reason codes for device approvals being off
/// (`GET /pair/device-keys` → `device_approvals`, or a 403 `reason`).
pub const NODE_OFF_REASONS: [&str; 3] = ["seed_not_encrypted", "seed_password_not_typed", "owner_key_unavailable"];

/// What the owner is told for a reason code; `None` for a code this app does
/// not know (shown as generic "off").
pub fn node_off_message(reason: &str) -> &'static str {
    #[cfg(target_os = "android")]
    return match reason {
        "seed_not_encrypted" => "Encrypt your recovery phrase to enable biometric approvals. On the node's computer: stop the node, run `konsensus seed encrypt --config <path>` once, then start it again and type the password.",
        "seed_password_not_typed" => "Restart your node and type its recovery-phrase password at start to enable biometric approvals (a password file or flag leaves them off).",
        _ => "Biometric approvals are off on your node. Approve at the node instead.",
    };
    #[cfg(not(target_os = "android"))]
    match reason {
        "seed_not_encrypted" => "Encrypt your recovery phrase to enable Touch ID approvals. On the node's computer: stop the node, run `konsensus seed encrypt --config <path>` once, then start it again and type the password.",
        "seed_password_not_typed" => "Restart your node and type its recovery-phrase password at start to enable Touch ID approvals (a password file or flag leaves them off).",
        _ => "Touch ID approvals are off on your node. Approve at the node instead.",
    }
}

/// A node refusal that means device approvals are off, as an app error.
pub fn node_off_error(reason: &str) -> crate::act::ActionError {
    crate::act::ActionError::new("device_approvals_off", node_off_message(reason))
}

/// The `reason` of a node refusal body, when it is one of [`NODE_OFF_REASONS`].
pub fn node_off_reason(body: &str) -> Option<&'static str> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let reason = v.get("reason")?.as_str()?;
    NODE_OFF_REASONS.into_iter().find(|r| *r == reason)
}

impl DeviceView {
    pub fn of(available: bool, record: Option<&Record>, lapsed: bool, now_ms: u64) -> Self {
        let mut view = Self {
            delegation_supported: false,
            second_device: false,
            owner_device_count: None,
            available,
            state: if available { DeviceState::None } else { DeviceState::Unavailable },
            fingerprint: None,
            owner_action: None,
            expires_at_ms: None,
            off_reason: None,
            off_message: None,
        };
        if !available {
            return view;
        }
        if let Some(r) = record {
            view.fingerprint = r.fingerprint.clone();
            if r.registered {
                view.state = DeviceState::Registered;
            } else if let Some(p) = r.pending.as_ref().filter(|p| p.expires_at_ms > now_ms) {
                view.state = DeviceState::Pending;
                view.owner_action = Some(p.owner_action.clone());
                view.expires_at_ms = Some(p.expires_at_ms);
            } else if lapsed || r.pending.is_some() {
                view.state = DeviceState::Lapsed;
            }
        }
        view
    }
}

impl DeviceView {
    /// Apply the node's `device_approvals` value: anything but "enabled"
    /// (or absent, on an older node) turns this Mac's approvals off.
    pub fn with_node_approvals(mut self, device_approvals: Option<&str>) -> Self {
        if let Some(reason) = device_approvals.filter(|r| *r != "enabled") {
            if self.available {
                self.state = DeviceState::Off;
                self.owner_action = None;
                self.expires_at_ms = None;
                self.off_reason = Some(NODE_OFF_REASONS.into_iter().find(|r| *r == reason).unwrap_or("off").to_string());
                self.off_message = Some(node_off_message(reason).to_string());
            }
        }
        self
    }
}

/// The terms signed for one contact's envelope. Field names are the node's.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Intent {
    pub device_key_id: String,
    pub peer: String,
    pub level: u8,
    pub budget_msat: u64,
    pub per_act_max_msat: u64,
    pub window_secs: i64,
    pub issued_at: i64,
    pub nonce: String,
}

impl Intent {
    /// A Contact envelope for `peer`, with a fresh 16-byte nonce.
    pub fn contact(key_id: &str, peer: &str, budget_msat: u64, per_act_max_msat: u64, now_unix: i64) -> Result<Self, ActionError> {
        let peer = bitsov_app::control::node_id(peer).map_err(ActionError::invalid)?.to_ascii_lowercase();
        if budget_msat == 0 || per_act_max_msat == 0 || per_act_max_msat > budget_msat {
            return Err(ActionError::invalid("The per-message maximum must fit the daily budget."));
        }
        let mut nonce = [0u8; 16];
        getrandom::getrandom(&mut nonce)
            .map_err(|_| ActionError::new("device_key", "This Mac could not produce a random nonce."))?;
        Ok(Self {
            device_key_id: key_id.to_string(),
            peer,
            level: LEVEL_CONTACT,
            budget_msat,
            per_act_max_msat,
            window_secs: DEFAULT_WINDOW_SECS,
            issued_at: now_unix,
            nonce: hex::encode(nonce),
        })
    }
}

/// Exact bytes the device signs at registration (the node's
/// `registration_message`).
pub fn registration_message(node: &str, client_id: &str, public_key_hex: &str) -> String {
    format!("bitsov-device-register-v1\nnode:{node}\nclient:{client_id}\npublic_key:{public_key_hex}")
}

/// Exact bytes the device signs for an envelope (the node's `intent_message`).
pub fn intent_message(node: &str, client_id: &str, i: &Intent) -> String {
    format!(
        "bitsov-relation-intent-v1\nnode:{node}\nclient:{client_id}\ndevice:{}\npeer:{}\nlevel:{}\n\
         budget_msat:{}\nper_act_max_msat:{}\nwindow_secs:{}\nissued_at:{}\nnonce:{}",
        i.device_key_id, i.peer, i.level, i.budget_msat, i.per_act_max_msat, i.window_secs, i.issued_at, i.nonce
    )
}

/// What the Touch ID dialog says. It is where the owner reads what they
/// approve: the amounts come first, then the contact.
pub fn intent_reason(contact: &str, budget_msat: u64, per_act_max_msat: u64) -> String {
    format!(
        "approve paying up to {} per day, at most {} per message, to {contact}",
        amount(budget_msat),
        amount(per_act_max_msat)
    )
}

/// The contact as the dialog names it: the node key the intent signs, shown
/// short as the app shows it (`shortId`: first 8 and last 8 hex). Never a name:
/// a node-side label may be the peer's own claim, and petnames stay on this Mac.
pub fn contact_key(peer: &str) -> String {
    format!("node {}…{}", &peer[..8.min(peer.len())], &peer[peer.len().saturating_sub(8)..])
}

/// The dialog text for one signed intent, from the intent alone: the amounts
/// and key the owner reads are exactly the ones signed.
pub fn contact_intent_reason(intent: &Intent) -> String {
    intent_reason(&contact_key(&intent.peer), intent.budget_msat, intent.per_act_max_msat)
}

/// The per-message maximum for a contact: its quoted price, at least 1 sat
/// and never above the budget.
pub fn default_per_act(quoted_msat: Option<u64>, budget_msat: u64) -> u64 {
    quoted_msat.unwrap_or(10_000).clamp(1_000, budget_msat.max(1_000))
}

// ---- private files -----------------------------------------------------------

/// Write-then-rename, 0600, never through a symlink.
#[cfg(unix)]
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Per file: the blob and the record must never share a temporary name.
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(&tmp, path)
}

/// Read a private file; a symlink or a group/world-readable file is refused.
#[cfg(unix)]
pub fn read_private(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !meta.file_type().is_file() {
        return Err(std::io::Error::other("not a regular file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(std::io::Error::other("readable by other users"));
        }
    }
    std::fs::read(path).map(Some)
}

// Unix file modes and no-follow semantics have no implemented equivalent here.
#[cfg(not(unix))]
pub fn write_private(_path: &Path, _bytes: &[u8]) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported,
        "private device storage is not supported on this platform"))
}

#[cfg(not(unix))]
pub fn read_private(_path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported,
        "private device storage is not supported on this platform"))
}

pub fn load_record(store: &Path) -> Option<Record> {
    let bytes = read_private(&store.join(RECORD_FILE)).ok()??;
    serde_json::from_slice(&bytes).ok()
}

pub fn save_record(store: &Path, record: &Record) -> Result<(), ActionError> {
    write_private(&store.join(RECORD_FILE), &serde_json::to_vec(record).expect("record serializes"))
        .map_err(|e| ActionError::new("device_key", format!("Could not save the device key record: {e}")))
}

pub fn load_blob(store: &Path) -> Option<Vec<u8>> {
    read_private(&store.join(BLOB_FILE)).ok().flatten()
}

pub fn save_blob(store: &Path, blob: &[u8]) -> Result<(), ActionError> {
    write_private(&store.join(BLOB_FILE), blob)
        .map_err(|e| ActionError::new("device_key", format!("Could not save the device key: {e}")))
}

/// Forget the key (the owner revoked it, or it no longer works on this Mac).
pub fn forget(store: &Path) {
    let _ = std::fs::remove_file(store.join(BLOB_FILE));
    let _ = std::fs::remove_file(store.join(RECORD_FILE));
}

// ---- step 3: the pending approval survives an app restart ---------------------

/// The app's pending console approval, per node. Private file.
pub fn approvals_path(dir: &Path, node_id: &str) -> PathBuf {
    let safe: String = node_id.chars().filter(|c| c.is_ascii_hexdigit()).take(64).collect();
    dir.join(format!("approval-{safe}.json"))
}

pub fn save_pending(path: &Path, pending: Option<&Elevation>) -> std::io::Result<()> {
    match pending {
        Some(p) => write_private(path, &serde_json::to_vec(p).expect("elevation serializes")),
        None => match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        },
    }
}

/// A saved request, if it has not run out. Anything unreadable is dropped.
pub fn load_pending(path: &Path, now_ms: u64) -> Option<Elevation> {
    let bytes = read_private(path).ok()??;
    let e: Elevation = serde_json::from_slice(&bytes).ok()?;
    let op_ok = !e.op_id.is_empty() && e.op_id.len() <= 64 && e.op_id.chars().all(|c| c.is_ascii_hexdigit());
    (op_ok && e.expires_at_ms > now_ms).then_some(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_name_identifies_iphone() {
        assert_eq!(registration_name("ios"), "BitSov app on this iPhone");
    }

    #[test]
    fn registration_name_identifies_android_phone() {
        assert_eq!(registration_name("android"), "BitSov app on this Android phone");
    }

    #[test]
    fn registration_name_identifies_mac() {
        assert_eq!(registration_name("macos"), "BitSov app on this Mac");
    }

    #[test]
    fn registration_name_identifies_windows() {
        assert_eq!(registration_name("windows"), "BitSov app on Windows");
    }

    #[test]
    fn legacy_pending_registration_loads_and_delegation_message_survives_storage() {
        let mut record: Record = serde_json::from_value(serde_json::json!({
            "public_key": "04",
            "pending": {"op_id": "ab", "owner_action": "approve", "expires_at_ms": 100}
        })).unwrap();
        assert!(record.pending.as_ref().unwrap().delegation_message.is_none());
        record.pending.as_mut().unwrap().delegation_message = Some("delegation-message".into());
        let dir = tempfile::tempdir().unwrap();
        save_record(dir.path(), &record).unwrap();
        assert_eq!(load_record(dir.path()), Some(record));
    }

    const PEER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn messages_match_the_nodes_bytes() {
        let i = Intent {
            device_key_id: "k1".into(), peer: PEER.into(), level: 1, budget_msat: 200_000,
            per_act_max_msat: 2_000, window_secs: 86_400, issued_at: 1_790_000_000, nonce: "0f".repeat(16),
        };
        assert_eq!(
            intent_message("fp", "c1", &i),
            format!("bitsov-relation-intent-v1\nnode:fp\nclient:c1\ndevice:k1\npeer:{PEER}\nlevel:1\nbudget_msat:200000\nper_act_max_msat:2000\nwindow_secs:86400\nissued_at:1790000000\nnonce:{}", "0f".repeat(16))
        );
        assert_eq!(registration_message("fp", "c1", "04ab"), "bitsov-device-register-v1\nnode:fp\nclient:c1\npublic_key:04ab");
        // The node's JSON field names.
        let v = serde_json::to_value(&i).unwrap();
        for f in ["device_key_id", "peer", "level", "budget_msat", "per_act_max_msat", "window_secs", "issued_at", "nonce"] {
            assert!(v.get(f).is_some(), "{f}");
        }
    }

    #[test]
    fn an_intent_is_lowercase_bounded_and_fresh() {
        let a = Intent::contact("k1", &PEER.to_uppercase(), 200_000, 2_000, 5).unwrap();
        let b = Intent::contact("k1", PEER, 200_000, 2_000, 5).unwrap();
        assert_eq!(a.peer, PEER);
        assert_eq!(a.nonce.len(), 32);
        assert_ne!(a.nonce, b.nonce);
        assert!(Intent::contact("k1", PEER, 1_000, 2_000, 5).is_err());
        assert!(Intent::contact("k1", "not-a-node", 1_000, 1_000, 5).is_err());
    }

    #[test]
    fn the_dialog_names_the_contact_by_key_and_both_amounts() {
        assert_eq!(intent_reason("Maya", 200_000, 21_187), "approve paying up to 200 sats per day, at most 21187 msat per message, to Maya");
        assert_eq!(contact_key(PEER), "node aaaaaaaa…aaaaaaaa");
        assert_eq!(intent_reason(&contact_key(PEER), 200_000, 2_000), "approve paying up to 200 sats per day, at most 2 sats per message, to node aaaaaaaa…aaaaaaaa");
        // Built from the signed intent alone: no label, node-side or local, can reach it.
        let peer = format!("AB12CD34{}EF56AB78", "0".repeat(48));
        let intent = Intent::contact("k1", &peer, 200_000, 2_000, 5).unwrap();
        assert_eq!(contact_intent_reason(&intent), "approve paying up to 200 sats per day, at most 2 sats per message, to node ab12cd34…ef56ab78");
        assert_eq!(default_per_act(Some(2_000), 200_000), 2_000);
        assert_eq!(default_per_act(None, 200_000), 10_000);
        assert_eq!(default_per_act(Some(500_000), 200_000), 200_000);
    }

    #[test]
    fn the_view_never_shows_an_expired_command() {
        let r = Record {
            public_key: "04".into(), fingerprint: Some("AAAA-BBBB".into()),
            pending: Some(PendingRegistration { delegation_message: None, op_id: "ab".into(), owner_action: "konsensus device approve --op ab".into(), expires_at_ms: 100 }),
            ..Default::default()
        };
        assert_eq!(DeviceView::of(true, Some(&r), false, 50).state, DeviceState::Pending);
        let lapsed = DeviceView::of(true, Some(&r), false, 100);
        assert_eq!((lapsed.state, lapsed.owner_action), (DeviceState::Lapsed, None));
        assert_eq!(DeviceView::of(false, Some(&r), false, 0).state, DeviceState::Unavailable);
        assert_eq!(DeviceView::of(true, None, false, 0).state, DeviceState::None);
    }

    #[test]
    fn the_blob_and_the_record_never_share_a_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        save_blob(dir.path(), b"blob").unwrap();
        save_record(dir.path(), &Record { public_key: "04".into(), ..Default::default() }).unwrap();
        assert_eq!(load_blob(dir.path()).unwrap(), b"blob");
        assert_eq!(load_record(dir.path()).unwrap().public_key, "04");
        // Leftover temporaries of both, as after a crash, do not collide either.
        std::fs::write(dir.path().join("device-key.blob.tmp"), b"x").unwrap();
        std::fs::write(dir.path().join("device-key.json.tmp"), b"y").unwrap();
        save_blob(dir.path(), b"blob2").unwrap();
        save_record(dir.path(), &Record { public_key: "05".into(), ..Default::default() }).unwrap();
        assert_eq!(load_blob(dir.path()).unwrap(), b"blob2");
    }

    #[test]
    fn private_files_are_0600_and_refuse_symlinks_and_loose_modes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.json");
        write_private(&p, b"hi").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(read_private(&p).is_err());
            let link = dir.path().join("l.json");
            std::os::unix::fs::symlink(&p, &link).unwrap();
            assert!(read_private(&link).is_err());
        }
    }

    #[test]
    fn a_pending_approval_round_trips_until_it_runs_out() {
        let dir = tempfile::tempdir().unwrap();
        let p = approvals_path(dir.path(), "../../ab");
        assert_eq!(p.file_name().unwrap(), "approval-ab.json");
        let e = Elevation { op_id: "ab12".into(), expires_at_ms: 1_000, owner_action: "konsensus grant --op ab12".into(), owner_can_grant: true };
        save_pending(&p, Some(&e)).unwrap();
        assert_eq!(load_pending(&p, 999), Some(e));
        assert_eq!(load_pending(&p, 1_000), None);
        save_pending(&p, None).unwrap();
        assert!(!p.exists());
        save_pending(&p, None).unwrap();
    }
}

#[cfg(test)]
mod node_off_tests {
    use super::*;

    #[test]
    fn node_off_reasons_map_to_the_owner_message() {
        assert_eq!(node_off_reason(r#"{"error":"x","reason":"seed_not_encrypted"}"#), Some("seed_not_encrypted"));
        assert_eq!(node_off_reason(r#"{"error":"x","reason":"budget_exceeded"}"#), None);
        assert_eq!(node_off_reason("not json"), None);
        let base = DeviceView::of(true, None, false, 0);
        assert_eq!(base.clone().with_node_approvals(Some("enabled")), base);
        assert_eq!(base.clone().with_node_approvals(None), base, "older nodes: unchanged");
        let off = base.with_node_approvals(Some("seed_not_encrypted"));
        assert_eq!(off.state, DeviceState::Off);
        assert!(off.off_message.unwrap().contains("konsensus seed encrypt"));
        // A Mac without an enclave stays "unavailable", whatever the node says.
        let none = DeviceView::of(false, None, false, 0).with_node_approvals(Some("seed_not_encrypted"));
        assert_eq!(none.state, DeviceState::Unavailable);
    }
}

#[cfg(all(test, not(unix)))]
mod unsupported_platform_tests {
    use super::*;

    #[test]
    fn private_files_are_refused_without_touching_disk() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("private/key");
        let error = write_private(&path, b"secret").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::Unsupported);
        assert!(error.to_string().contains("not supported on this platform"));
        let error = read_private(&path).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::Unsupported);
        assert!(!path.parent().unwrap().exists());
    }
}
