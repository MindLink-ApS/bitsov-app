//! Pinned Noise transport for a remotely hosted BitSov node.
//!
//! The renderer only imports a descriptor. All remote traffic remains behind
//! a process-local loopback proxy, and no pairing code or private key is ever
//! returned to or logged by this module.

use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use snow::{Builder, TransportState};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch, Semaphore};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

use crate::at_rest::{self, Sealer};
use crate::pairing::{self, ClientKey};
use crate::home_node::{BoxPin, BoxPinStore};
use crate::connection_retry::RemoteRetry;

/// Exact Noise protocol used by both app and node ingress.
pub const NOISE_PROTOCOL: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2s";
pub const TRANSPORT_PROOF_DOMAIN: &str = "bitsov-remote-transport-v1";
pub const PAIRING_PROOF_DOMAIN: &str = "bitsov-remote-pair-v1";
/// BLAKE3 KDF context for deriving an X25519 secret from the app Ed25519 seed.
pub const CLIENT_TRANSPORT_KDF_CONTEXT: &str = "bitsov remote access client x25519 static v1";

pub const REMOTE_CONFIG_DIR: &str = "remote-access";
pub const REMOTE_CONFIG_FILE: &str = "descriptor.json";
// Serialize import/forget with authentication's durable update. A handshake
// already in flight must not resurrect a link the user has just forgotten.
static REMOTE_CONFIG_LOCK: Mutex<()> = Mutex::new(());
const LOCAL_PAIRING_RESET: &str = "local-pairing-reset";
pub const MAX_NOISE_PLAINTEXT: usize = 16 * 1024;
pub const MAX_TRANSPORT_FRAME: usize = MAX_NOISE_PLAINTEXT + 2 + 16;
pub const MAX_HANDSHAKE_FRAME: usize = 65_535;
pub const MAX_AUTH_PLAINTEXT: usize = 8 * 1024;
pub const LOCAL_AUTH_HEADER: &str = "x-bitsov-proxy-auth";
const MAX_LINK_BYTES: usize = 8 * 1024;
const MAX_LOCAL_REQUEST_PREFIX: usize = 64 * 1024;
const LOCAL_AUTH_TIMEOUT: Duration = Duration::from_secs(2);
const REMOTE_READER_QUEUE: usize = 2;
const MAX_LOCAL_CONNECTIONS: usize = 8;
/// Of those, slots only a call media socket may use, so a full HTTP pool
/// plus the live WebSocket cannot starve a call's audio.
const RESERVED_MEDIA_CONNECTIONS: usize = 1;
/// A proxied request waits at most this long for its remote tunnel (handshake
/// queue included). Shorter than the slowest local caller's own timeout, so a
/// request is never forwarded after that caller has given up.
const REMOTE_CONNECT_DEADLINE: Duration = Duration::from_secs(60);
/// Request bytes held for a caller while its tunnel is set up. Beyond this the
/// rest waits in the socket, and the caller's close is seen once it is read.
const MAX_HELD_LOCAL_BYTES: usize = 1024 * 1024;
const MAX_PENDING_LOCAL_AUTH: usize = 16;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
pub const HANDSHAKE_UNAVAILABLE: &str = "remote handshake limit or endpoint unavailable";
/// Response header naming the code of an error the loopback proxy itself
/// wrote (the same code is in the JSON body). Node responses never pass
/// through `write_proxy_error`.
pub const PROXY_ERROR_HEADER: &str = "x-bitsov-proxy-error";
/// Proxy-originated codes that only mean "no tunnel right now": worth a retry.
const TRANSIENT_PROXY_ERRORS: [&str; 5] = [
    "remote_retry_wait", "remote_proxy_busy", "remote_proxy_auth_busy",
    "remote_handshake_unavailable", "remote_transport_refused",
];

/// The code of a transient error written by this proxy, read from its header
/// or else its JSON body. `None` for anything else, including every response
/// the node itself sent.
pub fn transient_proxy_error(header: Option<&str>, body: Option<&[u8]>) -> Option<&'static str> {
    #[derive(Deserialize)]
    struct Body { code: String }
    let body_code = || body.filter(|b| b.len() <= 1024)
        .and_then(|b| serde_json::from_slice::<Body>(b).ok()).map(|b| b.code);
    let code = header.map(str::to_owned).or_else(body_code)?;
    TRANSIENT_PROXY_ERRORS.into_iter().find(|known| *known == code)
}

/// Longest `hosted_by` label shown, in characters (the node's own limit).
pub const HOSTED_BY_MAX_CHARS: usize = 64;

/// Pairing-link JSON carried as unpadded base64url after `bitsov://pair/`.
/// Node `PairLink` (BitSov-bitsov #252); fields after `code` are optional so
/// links from older nodes still parse.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairingLinkV1 {
    pub v: u8,
    pub endpoint: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub endpoints: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoints_signature: Option<String>,
    /// Empty only in a ticket issued before the node had an identity.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub node_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub transport_pubkey: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub transport_signature: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub box_transport_pubkey: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_transport_signature: Option<String>,
    pub code: String,
    /// Unix seconds; zero marks a legacy link without an expiry.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub expires_at: i64,
    /// Operator-chosen, unsigned and display only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hosted_by: Option<String>,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

impl fmt::Debug for PairingLinkV1 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairingLinkV1")
            .field("v", &self.v)
            .field("endpoint", &self.endpoint)
            .field("node_id", &self.node_id)
            .field("transport_pubkey", &self.transport_pubkey)
            .field("transport_signature", &self.transport_signature)
            .field("box_transport_pubkey", &self.box_transport_pubkey)
            .field("has_code", &true)
            .field("expires_at", &self.expires_at)
            .field("hosted_by", &self.hosted_by)
            .finish()
    }
}

/// Validated, persisted descriptor. Byte forms are retained for pin checks and
/// proof construction; its `Debug` implementation never includes the code.
#[derive(Clone, Serialize, Deserialize)]
pub struct RemoteDescriptor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enrollment_commitment: Option<[u8; 32]>,
    v: u8,
    endpoint: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    endpoints: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    bootstrap_routes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    endpoints_signature: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    box_transport_pubkey: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    box_transport_signature: Option<String>,
    node_id: String,
    transport_pubkey: String,
    transport_signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hosted_by: Option<String>,
    #[serde(skip)]
    transport_pubkey_bytes: [u8; 32],
    #[serde(skip)]
    pin_store: Option<Arc<dyn BoxPinStore>>,
}

impl fmt::Debug for RemoteDescriptor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RemoteDescriptor")
            .field("v", &self.v)
            .field("endpoint", &self.endpoint)
            .field("node_id", &self.node_id)
            .field("transport_pubkey", &self.transport_pubkey)
            .field("has_code", &self.code.is_some())
            .finish()
    }
}

impl RemoteDescriptor {
    pub fn with_pin_store(mut self, store: Arc<dyn BoxPinStore>) -> Self {
        self.pin_store = Some(store);
        self
    }

    pub fn box_pin(&self) -> Result<Option<BoxPin>, RemoteError> {
        if self.node_id.is_empty() { return Ok(None); }
        if let Some(signature) = &self.box_transport_signature {
            return BoxPin::verify(&self.node_id, &self.endpoint, &self.box_transport_pubkey, signature).map(Some);
        }
        let Some(store) = &self.pin_store else { return Ok(None); };
        let Some(pin) = store.read(&self.node_id)? else { return Ok(None); };
        if pin.node_id != self.node_id || pin.endpoint != self.endpoint {
            return Err(RemoteError::Invalid("box pin belongs to another node or endpoint".into()));
        }
        BoxPin::verify(&self.node_id, &self.endpoint, &pin.public_key, &pin.signature).map(Some)
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    pub fn bootstrap_box_key(&self) -> Option<&str> {
        self.node_id.is_empty().then_some(self.box_transport_pubkey.as_str())
    }
    pub fn has_live_pin(&self) -> bool { !self.transport_pubkey.is_empty() }

    /// Presentation only: a saved join can precede ticket redemption.
    pub fn pending_phone_enrollment(&self) -> bool {
        self.node_id.is_empty() || self.enrollment_commitment.is_some()
            || self.code.as_deref().is_some_and(|code| code.starts_with("second_") || code.starts_with("owner_"))
    }

    pub fn enrollment_commitment(&self) -> Option<[u8; 32]> { self.enrollment_commitment }
    pub fn ticket_id(&self) -> Option<String> {
        self.code.as_deref().map(crate::second_device::ticket_id)
    }

    pub fn has_code(&self) -> bool {
        self.code.is_some()
    }

    /// Display-safe label from the pairing link; never an authority input.
    pub fn hosted_by(&self) -> Option<&str> {
        self.hosted_by.as_deref()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredDescriptor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enrollment_commitment: Option<[u8; 32]>,
    v: u8,
    endpoint: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    endpoints: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    bootstrap_routes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    endpoints_signature: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    box_transport_pubkey: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    box_transport_signature: Option<String>,
    node_id: String,
    transport_pubkey: String,
    transport_signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    /// The one-time code as [`at_rest::Sealer`] ciphertext (unpadded
    /// base64url). Written instead of `code` whenever a sealer is installed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sealed_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hosted_by: Option<String>,
}

/// First encrypted application message after the pinned XX handshake.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteAuthRequest {
    pub v: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_pubkey: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// Node response to [`RemoteAuthRequest`], still inside Noise.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, tag = "status", rename_all = "snake_case")]
pub enum RemoteAuthResponse {
    Ok {
        v: u8,
        client_id: String,
        scopes: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        box_transport_pubkey: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        box_transport_signature: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transport_pubkey: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transport_signature: Option<String>,
    },
    Error {
        v: u8,
        code: String,
        message: String,
    },
}

/// Public ticket identity only; contains no pairing code or other authority.
#[derive(Debug, Clone, Serialize)]
pub struct RemotePreviewView {
    /// Only second-device tickets defer comparison to owner approval.
    pub second_device: bool,
    pub first_run: bool,
    pub endpoint: String,
    pub node_id_fingerprint: String,
    pub hosted_by: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteImportView {
    pub endpoint: String,
    pub node_id_fingerprint: String,
    pub hosted_by: Option<String>,
    pub restart_required: bool,
}

#[derive(Debug)]
pub enum RemoteError {
    Invalid(String),
    Local(String),
    Transport(String),
    Refused(String),
    /// The node already holds a pairing for this app's client identity and
    /// refused only the ticket. The existing pairing still reconnects.
    AlreadyPaired,
    HandshakeUnavailable,
    Unclaimed,
    LocalNetwork,
    AndroidLocalNetwork,
    RateLimited(u64),
    Waiting(u64),
    /// Seconds since the pairing ticket expired.
    Expired(u64),
    /// This device has no passcode, so its protected identity cannot be stored or read.
    DeviceUnavailable,
    /// This Mac has no Secure Enclave: secrets cannot be stored safely here.
    /// `identity_kept`: an existing identity was left untouched.
    SecureStorageUnavailable { identity_kept: bool },
}

fn elapsed_text(seconds: u64) -> String {
    match seconds {
        0..=119 => format!("{seconds} s"),
        120..=7199 => format!("{} min", seconds / 60),
        7200..=172_799 => format!("{} h", seconds / 3600),
        _ => format!("{} days", seconds / 86_400),
    }
}

impl fmt::Display for RemoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "invalid remote pairing link: {message}"),
            Self::Expired(seconds) => write!(
                f,
                "This pairing link expired {} ago. Make a new code on your computer (for support: konsensus pair-ticket on your box), and check this device's clock.",
                elapsed_text(*seconds)
            ),
            Self::Local(message) => f.write_str(message),
            Self::Transport(message) => write!(f, "remote transport failed: {message}"),
            Self::Refused(message) => write!(f, "remote node refused pairing: {message}"),
            Self::AlreadyPaired => write!(f, "remote node refused pairing: {ALREADY_PAIRED_MESSAGE}"),
            Self::Unclaimed => f.write_str("This box isn't set up yet. Finish setup on a Mac, then add this phone."),
            Self::LocalNetwork => f.write_str("Local network access is denied or unavailable. Check BitSov's Local Network permission in Settings and your network connection."),
            Self::AndroidLocalNetwork => f.write_str("Local network access is unavailable. Allow Nearby devices for BitSov in Android Settings, then return to BitSov or tap Reconnect."),
            Self::HandshakeUnavailable => f.write_str(HANDSHAKE_UNAVAILABLE),
            Self::DeviceUnavailable => f.write_str(PASSCODE_REQUIRED),
            Self::SecureStorageUnavailable { identity_kept } => {
                f.write_str(NO_SECURE_ENCLAVE)?;
                if *identity_kept { f.write_str(IDENTITY_KEPT)?; }
                Ok(())
            }
            Self::RateLimited(seconds) => write!(f, "Remote connection limited; waiting {seconds} s"),
            Self::Waiting(seconds) => write!(f, "Remote connection unavailable; waiting {seconds} s"),
        }
    }
}

impl std::error::Error for RemoteError {}

impl RemoteError {
    /// The node answered and refused this app's saved pairing: an unknown or
    /// revoked client, a used or expired ticket. Retrying the same link and
    /// client identity cannot change that answer. Transport errors, timeouts,
    /// busy replies and `AlreadyPaired` (the pairing itself stands) are never
    /// definitive.
    pub fn is_definitive_refusal(&self) -> bool {
        matches!(self, Self::Refused(_) | Self::Expired(_))
    }
}

/// Shown for a pairing the node has already refused while it stays refused.
pub const REFUSED_PAIRING_MESSAGE: &str = "this app's pairing was refused; pair again from an enrolled device";

const ALREADY_PAIRED_MESSAGE: &str = "This device already has a pairing. Reconnect with its saved pairing; a second-device ticket is for a new device.";

/// Stable renderer contract. Detail is diagnostic copy, never a ticket or key.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ConnectionError {
    pub kind: ConnectionErrorKind,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionErrorKind {
    Unclaimed,
    LocalNetwork,
    Unreachable,
    Tailscale,
    Busy,
    Expired,
    Clock,
    Used,
    ClaimMismatch,
    /// No device passcode (and so no Face ID / Touch ID): protected storage is off.
    DeviceUnavailable,
    /// No Secure Enclave on this Mac. Permanent; never the passcode message.
    SecureStorageUnavailable,
    Other,
}

pub const USED_TICKET_MESSAGE: &str = "This ticket expired, was already used, or its owner was revoked. Ask an enrolled owner device for a new ticket.";
pub const EXPIRED_TICKET_MESSAGE: &str = "This ticket has expired. Ask an enrolled owner device for a new ticket.";

/// Stable diagnostic codes. The renderer maps `kind` (and these codes) to copy;
/// detail never carries peer text or prose meant for the user.
pub const UNREACHABLE_CODE: &str = "remote_unreachable";
pub const CONNECTION_FAILED_CODE: &str = "remote_connection_failed";
pub const PASSCODE_REQUIRED_CODE: &str = "device_passcode_required";
/// The Apple Keychain bridge's fixed text for a device without a passcode
/// (`bitsov_ffi::keychain_status::PASSCODE_REQUIRED`, which Android does not
/// link). Kept here so every target compiles the classification; a test binds
/// the two copies wherever the bridge exists.
pub const PASSCODE_REQUIRED: &str = "This device has no passcode, so Face ID and protected storage are off. Turn on a passcode in Settings, then try again.";
/// A Mac without a Secure Enclave. The renderer shows its own copy for these.
pub const SECURE_STORAGE_UNAVAILABLE_CODE: &str = "secure_storage_unavailable";
/// The same, when an existing pairing was kept untouched for its original Mac.
pub const SECURE_STORAGE_KEPT_CODE: &str = "secure_storage_unavailable_identity_kept";
/// Mirrors `bitsov_ffi::keychain_status::NO_SECURE_ENCLAVE` (Android links no
/// bridge); a test binds the two copies wherever the bridge exists.
pub const NO_SECURE_ENCLAVE: &str = "This Mac has no Secure Enclave, so BitSov cannot store its pairing key safely. Nothing was saved.";
pub const IDENTITY_KEPT: &str = " Your existing pairing is kept and works again on the Mac it was made on.";

/// Classify the node's refusal of a pairing code by its reason, for every ticket
/// kind (first pairing, owner, second device, legacy). Only a fixed local
/// message crosses; the node's text stays out of the renderer.
fn ticket_refusal(code: &str, message: &str, ticket: Option<&str>) -> Option<&'static str> {
    if code != "authentication_failed" { return None; }
    let reason = message.to_ascii_lowercase();
    // A used, revoked or mismatched code needs a new ticket, whatever its kind.
    if reason.contains("already used") || reason.contains("did not match") || reason.contains("does not match")
        || reason.contains("did not verify") {
        return Some(USED_TICKET_MESSAGE);
    }
    if reason.contains("expired") { return Some(EXPIRED_TICKET_MESSAGE); }
    // Owner and second-device tickets are single use; any other refusal of one
    // means it can no longer pair this device.
    ticket.is_some_and(|c| c.starts_with("owner_") || c.starts_with("second_")).then_some(USED_TICKET_MESSAGE)
}

impl ConnectionError {
    pub fn main_window_only() -> Self {
        Self { kind: ConnectionErrorKind::Other, detail: "this command is only available to the main window".into() }
    }
    pub fn app_data_unavailable() -> Self {
        Self { kind: ConnectionErrorKind::Other, detail: "The app data directory is unavailable. Remote pairing could not be saved.".into() }
    }
    pub fn other() -> Self { Self::from(&RemoteError::Local(String::new())) }
    pub fn busy() -> Self { Self::from(&RemoteError::RateLimited(0)) }
    pub fn for_endpoint(error: &RemoteError, endpoint: Option<&str>) -> Self {
        let mut result = Self::from(error);
        if result.kind == ConnectionErrorKind::Unreachable && endpoint.is_some_and(is_tailscale_endpoint) {
            result.kind = ConnectionErrorKind::Tailscale;
            result.detail = "Check that Tailscale is connected on this device and your node.".into();
        }
        result
    }
}

fn is_tailscale_endpoint(endpoint: &str) -> bool {
    endpoint_parts(endpoint).is_ok_and(|(host, _)| {
        if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
            let bytes = ip.octets();
            bytes[0] == 100 && (64..=127).contains(&bytes[1])
        } else { host.trim_end_matches('.').to_ascii_lowercase().ends_with(".ts.net") }
    })
}

impl From<&RemoteError> for ConnectionError {
    fn from(error: &RemoteError) -> Self {
        use ConnectionErrorKind::*;
        let (kind, detail) = match error {
            RemoteError::Unclaimed => (Unclaimed, error.to_string()),
            RemoteError::LocalNetwork | RemoteError::AndroidLocalNetwork => (LocalNetwork, error.to_string()),
            RemoteError::HandshakeUnavailable | RemoteError::Waiting(_) | RemoteError::Transport(_) =>
                (Unreachable, UNREACHABLE_CODE.into()),
            RemoteError::RateLimited(_) => (Busy, "The remote connection is busy. Try again shortly.".into()),
            // A very old expiry can also mean the device clock is wrong. This
            // is a recovery hint, never proof of clock skew or an expiry bypass.
            RemoteError::Expired(seconds) if *seconds > 86_400 =>
                (Clock, "Check this device's date and time, or request a fresh pairing link.".into()),
            RemoteError::Expired(_) => (Expired, error.to_string()),
            RemoteError::Refused(message) if message == USED_TICKET_MESSAGE => (Used, USED_TICKET_MESSAGE.into()),
            RemoteError::Refused(message) if message == EXPIRED_TICKET_MESSAGE => (Expired, EXPIRED_TICKET_MESSAGE.into()),
            RemoteError::DeviceUnavailable => (DeviceUnavailable, PASSCODE_REQUIRED_CODE.into()),
            RemoteError::Local(message) if message == PASSCODE_REQUIRED =>
                (DeviceUnavailable, PASSCODE_REQUIRED_CODE.into()),
            RemoteError::SecureStorageUnavailable { identity_kept } => (SecureStorageUnavailable,
                if *identity_kept { SECURE_STORAGE_KEPT_CODE } else { SECURE_STORAGE_UNAVAILABLE_CODE }.into()),
            _ => (Other, CONNECTION_FAILED_CODE.into()),
        };
        // Peer text may echo authentication codes. Only fixed local copy crosses.
        Self { kind, detail }
    }
}

/// Platforms that gate connections to local addresses behind a Local Network
/// permission: iOS, and macOS 15 and later. On these a denial is reported as
/// `LocalNetwork`, so the tester is pointed at the setting instead of a
/// generic "unreachable".
const LOCAL_NETWORK_PRIVACY: bool = cfg!(any(target_os = "ios", target_os = "macos"));

// BSD sockets cannot definitively distinguish a Local Network privacy denial
// from an unavailable route. Preserve these classes without asserting permission
// was denied; a timeout/refusal alone is not evidence of a privacy restriction.
fn classify_connect_error(error: std::io::Error, local_network_privacy: bool, endpoint: &str) -> RemoteError {
    use std::io::ErrorKind;
    let local = endpoint_parts(endpoint).is_ok_and(|(host, _)| {
        match host.parse::<std::net::IpAddr>() {
            Ok(std::net::IpAddr::V4(ip)) => ip.is_private() || ip.is_link_local(),
            Ok(std::net::IpAddr::V6(ip)) => ip.is_unique_local() || ip.is_unicast_link_local(),
            Err(_) => host.trim_end_matches('.').to_ascii_lowercase().ends_with(".local"),
        }
    });
    if local_network_privacy && local && matches!(error.kind(), ErrorKind::PermissionDenied | ErrorKind::NetworkDown
        | ErrorKind::NetworkUnreachable | ErrorKind::HostUnreachable) {
        RemoteError::LocalNetwork
    } else {
        RemoteError::HandshakeUnavailable
    }
}

/// A connect failure on this platform, classified as above.
fn connect_error(error: std::io::Error, endpoint: &str) -> RemoteError {
    classify_connect_error(error, LOCAL_NETWORK_PRIVACY, endpoint)
}

/// Exact UTF-8 string signed by the node for the pairing link.
pub fn descriptor_signature_message(node_id_hex: &str, transport_pubkey_hex: &str) -> String {
    format!("{TRANSPORT_PROOF_DOMAIN}:{node_id_hex}:{transport_pubkey_hex}")
}

pub fn node_id_fingerprint(node_id_hex: &str) -> String {
    format!(
        "{}…{}",
        &node_id_hex[..8],
        &node_id_hex[node_id_hex.len() - 8..]
    )
}

pub fn new_local_auth_token() -> Result<String, RemoteError> {
    let mut token = [0u8; 32];
    getrandom::fill(&mut token).map_err(|error| {
        RemoteError::Local(format!("cannot secure remote loopback proxy: {error}"))
    })?;
    Ok(hex::encode(token))
}

/// Exact UTF-8 string signed by a newly pairing client.
pub fn auth_proof_message(
    node_id_hex: &str,
    client_transport_pubkey_hex: &str,
    code: &str,
    client_pubkey_hex: &str,
) -> String {
    format!(
        "{PAIRING_PROOF_DOMAIN}:{node_id_hex}:{client_transport_pubkey_hex}:{code}:{client_pubkey_hex}"
    )
}

fn decode_hex<const N: usize>(value: &str, what: &str) -> Result<[u8; N], RemoteError> {
    hex::decode(value)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| RemoteError::Invalid(format!("{what} must be {} lowercase hex bytes", N)))
        .and_then(|bytes: [u8; N]| {
            if hex::encode(bytes) != value {
                Err(RemoteError::Invalid(format!(
                    "{what} must use canonical lowercase hex"
                )))
            } else {
                Ok(bytes)
            }
        })
}

fn validate_code(code: Option<&str>) -> Result<(), RemoteError> {
    if let Some(code) = code {
        if let Some(secret) = code.strip_prefix("owner_") {
            return if crate::delegation::canonical_hex(secret, 32) { Ok(()) }
                else { Err(RemoteError::Invalid("owner ticket code must contain 32 lowercase hex bytes".into())) };
        }
        let code = code.strip_prefix("second_").unwrap_or(code);
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(code)
            .map_err(|_| {
                RemoteError::Invalid("code must be unpadded base64url for 32 bytes".into())
            })?;
        if bytes.len() != 32
            || base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes) != code
        {
            return Err(RemoteError::Invalid(
                "code must be canonical unpadded base64url for 32 bytes".into(),
            ));
        }
    }
    Ok(())
}

pub(crate) fn endpoint_parts(endpoint: &str) -> Result<(&str, u16), RemoteError> {
    if endpoint.len() > 300
        || endpoint.is_empty()
        || !endpoint.is_ascii()
        || endpoint.chars().any(char::is_whitespace)
    {
        return Err(RemoteError::Invalid(
            "endpoint is not a valid host:port".into(),
        ));
    }

    let (host, port_text) = if let Some(rest) = endpoint.strip_prefix('[') {
        let (host, rest) = rest
            .split_once(']')
            .ok_or_else(|| RemoteError::Invalid("IPv6 endpoint must use [address]:port".into()))?;
        let port = rest
            .strip_prefix(':')
            .ok_or_else(|| RemoteError::Invalid("endpoint is missing a port".into()))?;
        host.parse::<Ipv6Addr>()
            .map_err(|_| RemoteError::Invalid("endpoint has an invalid IPv6 address".into()))?;
        (host, port)
    } else {
        let (host, port) = endpoint
            .rsplit_once(':')
            .ok_or_else(|| RemoteError::Invalid("endpoint is missing a port".into()))?;
        if host.contains(':') {
            return Err(RemoteError::Invalid(
                "IPv6 endpoint must use [address]:port".into(),
            ));
        }
        if host.parse::<Ipv4Addr>().is_err() {
            let valid_dns = host.len() <= 253
                && host.split('.').all(|label| {
                    !label.is_empty()
                        && label.len() <= 63
                        && !label.starts_with('-')
                        && !label.ends_with('-')
                        && label
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                });
            if !valid_dns {
                return Err(RemoteError::Invalid(
                    "endpoint has an invalid DNS name".into(),
                ));
            }
        }
        (host, port)
    };
    let port = port_text
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| RemoteError::Invalid("endpoint has an invalid port".into()))?;
    Ok((host, port))
}

fn validate_descriptor(stored: StoredDescriptor) -> Result<RemoteDescriptor, RemoteError> {
    if ![1, 2].contains(&stored.v) {
        return Err(RemoteError::Invalid(
            "unsupported descriptor version".into(),
        ));
    }
    endpoint_parts(&stored.endpoint)?;
    validate_code(stored.code.as_deref())?;
    validate_endpoints(&stored)?;
    if stored.node_id.is_empty() {
        if !stored.transport_pubkey.is_empty() || !stored.transport_signature.is_empty()
            || stored.box_transport_signature.is_some() || stored.endpoints_signature.is_some() {
            return Err(RemoteError::Invalid("bootstrap ticket cannot claim identity proofs".into()));
        }
        let pin = decode_hex::<32>(&stored.box_transport_pubkey, "box_transport_pubkey")?;
        if pin == [0; 32] { return Err(RemoteError::Invalid("empty box pin".into())); }
        return Ok(descriptor_from_stored(stored, pin));
    }
    if let Some(signature) = &stored.box_transport_signature {
        BoxPin::verify(&stored.node_id, &stored.endpoint, &stored.box_transport_pubkey, signature)?;
    } else if !stored.box_transport_pubkey.is_empty() {
        return Err(RemoteError::Invalid("missing box transport signature".into()));
    }
    // Identity-bearing links and persisted receipts require both signed pins.
    if stored.transport_pubkey.is_empty() || stored.transport_signature.is_empty() {
        return Err(RemoteError::Invalid("missing live transport proof".into()));
    }
    let transport_pubkey_bytes = verify_transport_proof(&stored.node_id, &stored.transport_pubkey, &stored.transport_signature)?;
    Ok(descriptor_from_stored(stored, transport_pubkey_bytes))
}

/// PR #287 / PairLink proof: exact UTF-8 domain, lowercase hex, unpadded base64url.
pub fn verify_transport_proof(node_id: &str, transport_pubkey: &str, transport_signature: &str)
    -> Result<[u8; 32], RemoteError> {
    let node_id_bytes = decode_hex::<32>(node_id, "node_id")?;
    let transport_pubkey_bytes = decode_hex::<32>(transport_pubkey, "transport_pubkey")?;
    if transport_pubkey_bytes.iter().all(|byte| *byte == 0) {
        return Err(RemoteError::Invalid(
            "transport_pubkey cannot be all zero".into(),
        ));
    }
    let signature_vec = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(transport_signature)
        .map_err(|_| {
            RemoteError::Invalid("transport_signature must be unpadded base64url".into())
        })?;
    if base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&signature_vec)
        != transport_signature
    {
        return Err(RemoteError::Invalid(
            "transport_signature must use canonical unpadded base64url".into(),
        ));
    }
    let signature_bytes: [u8; 64] = signature_vec
        .try_into()
        .map_err(|_| RemoteError::Invalid("transport_signature must encode 64 bytes".into()))?;
    let identity = VerifyingKey::from_bytes(&node_id_bytes)
        .map_err(|_| RemoteError::Invalid("node_id is not an Ed25519 public key".into()))?;
    identity
        .verify_strict(
            descriptor_signature_message(node_id, transport_pubkey).as_bytes(),
            &Signature::from_bytes(&signature_bytes),
        )
        .map_err(|_| {
            RemoteError::Invalid(
                "transport_signature does not bind this key to the node identity".into(),
            )
        })?;

    Ok(transport_pubkey_bytes)
}

fn descriptor_from_stored(stored: StoredDescriptor, transport_pubkey_bytes: [u8; 32]) -> RemoteDescriptor {
    RemoteDescriptor {
        enrollment_commitment: stored.enrollment_commitment,
        v: stored.v, endpoint: stored.endpoint, endpoints: stored.endpoints,
        endpoints_signature: stored.endpoints_signature, bootstrap_routes: stored.bootstrap_routes,
        box_transport_pubkey: stored.box_transport_pubkey,
        box_transport_signature: stored.box_transport_signature,
        node_id: stored.node_id, transport_pubkey: stored.transport_pubkey,
        transport_signature: stored.transport_signature, code: stored.code,
        hosted_by: display_label(stored.hosted_by.as_deref()),
        transport_pubkey_bytes, pin_store: None,
    }
}

fn validate_endpoints(stored: &StoredDescriptor) -> Result<(), RemoteError> {
    if !stored.bootstrap_routes.is_empty() {
        if stored.v != 1 || stored.node_id.is_empty() || stored.box_transport_signature.is_none()
            || stored.code.is_some() || stored.bootstrap_routes.len() > 64 {
            return Err(RemoteError::Invalid("invalid bootstrap routing hints".into()));
        }
        for endpoint in &stored.bootstrap_routes { endpoint_parts(endpoint)?; }
    }
    if stored.v == 1 {
        if !stored.endpoints.is_empty() || stored.endpoints_signature.is_some() {
            return Err(RemoteError::Invalid("v1 cannot carry v2 endpoint fields".into()));
        }
        return Ok(());
    }
    if stored.endpoints.is_empty() || stored.endpoints.len() > 64
        || stored.endpoints.first() != Some(&stored.endpoint) {
        return Err(RemoteError::Invalid("invalid ordered endpoints".into()));
    }
    for endpoint in &stored.endpoints { endpoint_parts(endpoint)?; }
    if stored.node_id.is_empty() { return Ok(()); }
    let message = serde_json::to_vec(&(
        "bitsov-endpoints-v2", 2, &stored.node_id, &stored.transport_pubkey,
        &stored.box_transport_pubkey, &stored.endpoint, &stored.endpoints,
    )).map_err(|_| RemoteError::Invalid("invalid endpoints descriptor".into()))?;
    let encoded = stored.endpoints_signature.as_ref()
        .ok_or_else(|| RemoteError::Invalid("missing endpoints signature".into()))?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded)
        .map_err(|_| RemoteError::Invalid("invalid endpoints signature".into()))?;
    if base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes) != *encoded {
        return Err(RemoteError::Invalid("noncanonical endpoints signature".into()));
    }
    let signature = Signature::from_slice(&bytes)
        .map_err(|_| RemoteError::Invalid("invalid endpoints signature".into()))?;
    VerifyingKey::from_bytes(&decode_hex::<32>(&stored.node_id, "node_id")?)
        .map_err(|_| RemoteError::Invalid("invalid node identity".into()))?
        .verify_strict(&message, &signature)
        .map_err(|_| RemoteError::Invalid("endpoints signature does not bind this ordered list and pins".into()))
}

fn is_invisible_format(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{2028}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
    )
}

/// The label is unsigned, so it is shown only as plain text beside the node
/// fingerprint: trimmed, capped, and dropped whole if any character could
/// reorder or hide text.
fn display_label(label: Option<&str>) -> Option<String> {
    let label = label?.trim();
    if label.is_empty() || label.chars().any(|c| c.is_control() || is_invisible_format(c)) {
        return None;
    }
    if label.chars().count() <= HOSTED_BY_MAX_CHARS {
        return Some(label.to_string());
    }
    let mut capped: String = label.chars().take(HOSTED_BY_MAX_CHARS - 1).collect();
    capped.truncate(capped.trim_end().len());
    capped.push('…');
    Some(capped)
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64)
}

fn validate_link(link: PairingLinkV1, now: i64) -> Result<RemoteDescriptor, RemoteError> {
    if link.expires_at < 0 {
        return Err(RemoteError::Invalid("ticket expiry is invalid".into()));
    }
    // One-use tickets cross device clocks; match the enrollment UI's bounded
    // allowance. The node still enforces the ticket's original deadline.
    let deadline = if link.code.starts_with("owner_") || link.code.starts_with("second_") {
        crate::delegation::expiry_deadline(link.expires_at)
    } else {
        link.expires_at
    };
    if link.expires_at != 0 && deadline <= now {
        return Err(RemoteError::Expired((now - link.expires_at) as u64));
    }
    let descriptor = validate_descriptor(StoredDescriptor {
        enrollment_commitment: None,
        bootstrap_routes: vec![],
        endpoints: link.endpoints,
        endpoints_signature: link.endpoints_signature,
        box_transport_pubkey: link.box_transport_pubkey.clone(),
        box_transport_signature: link.box_transport_signature.clone(),
        v: link.v,
        endpoint: link.endpoint,
        node_id: link.node_id,
        transport_pubkey: link.transport_pubkey,
        transport_signature: link.transport_signature,
        code: Some(link.code),
        sealed_code: None,
        hosted_by: link.hosted_by,
    })?;
    // The box key is pinned only from an authenticated session; a proof in
    // the link is checked so a corrupted link fails here, not later.
    if let Some(signature) = &link.box_transport_signature {
        BoxPin::verify(
            &descriptor.node_id,
            &descriptor.endpoint,
            &link.box_transport_pubkey,
            signature,
        )?;
    }
    Ok(descriptor)
}

pub fn parse_pairing_link(link: &str) -> Result<RemoteDescriptor, RemoteError> {
    parse_pairing_link_at(link, unix_now())
}

fn parse_pairing_link_at(link: &str, now: i64) -> Result<RemoteDescriptor, RemoteError> {
    let encoded = link
        .strip_prefix("bitsov://pair/")
        .ok_or_else(|| RemoteError::Invalid("expected bitsov://pair/<base64url-json>".into()))?;
    if encoded.is_empty() || encoded.len() > MAX_LINK_BYTES * 2 || encoded.contains(['?', '#', '='])
    {
        return Err(RemoteError::Invalid(
            "descriptor payload is empty, oversized, padded, or has a suffix".into(),
        ));
    }
    let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| RemoteError::Invalid("descriptor is not unpadded base64url".into()))?;
    if json.len() > MAX_LINK_BYTES {
        return Err(RemoteError::Invalid("descriptor JSON is oversized".into()));
    }
    // Preserve strict legacy schema even for explicitly empty/null v2 fields.
    let fields: serde_json::Value = serde_json::from_slice(&json)
        .map_err(|_| RemoteError::Invalid("descriptor JSON has the wrong shape".into()))?;
    if fields.get("v").and_then(|v| v.as_u64()) == Some(1)
        && (fields.get("endpoints").is_some() || fields.get("endpoints_signature").is_some()) {
        return Err(RemoteError::Invalid("v1 cannot carry v2 endpoint fields".into()));
    }
    let link: PairingLinkV1 = serde_json::from_slice(&json)
        .map_err(|_| RemoteError::Invalid("descriptor JSON has the wrong shape".into()))?;
    validate_link(link, now)
}

fn config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir
        .join(REMOTE_CONFIG_DIR)
        .join(REMOTE_CONFIG_FILE)
}

fn persist_at(path: &Path, descriptor: &RemoteDescriptor) -> Result<(), RemoteError> {
    persist_with(path, descriptor, at_rest::installed())
}

/// Without a sealer this is the descriptor's own JSON, exactly as before.
/// With one, the file holds only public fields plus the sealed code.
fn stored_bytes(
    descriptor: &RemoteDescriptor,
    sealer: Option<&dyn Sealer>,
) -> Result<Vec<u8>, RemoteError> {
    let Some(sealer) = sealer else {
        return serde_json::to_vec(descriptor)
            .map_err(|_| RemoteError::Local("cannot serialize remote descriptor".into()));
    };
    let sealed_code = descriptor
        .code
        .as_deref()
        .map(|code| {
            sealer
                .seal(&at_rest::pairing_code_purpose(&descriptor.node_id), code.as_bytes())
                .map(|sealed| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sealed))
                .map_err(|e| RemoteError::Local(format!("cannot protect the pairing code: {e}")))
        })
        .transpose()?;
    serde_json::to_vec(&StoredDescriptor {
        enrollment_commitment: descriptor.enrollment_commitment,
        bootstrap_routes: descriptor.bootstrap_routes.clone(),
        endpoints: descriptor.endpoints.clone(),
        endpoints_signature: descriptor.endpoints_signature.clone(),
        box_transport_pubkey: descriptor.box_transport_pubkey.clone(),
        box_transport_signature: descriptor.box_transport_signature.clone(),
        v: descriptor.v,
        endpoint: descriptor.endpoint.clone(),
        node_id: descriptor.node_id.clone(),
        transport_pubkey: descriptor.transport_pubkey.clone(),
        transport_signature: descriptor.transport_signature.clone(),
        code: None,
        sealed_code,
        hosted_by: descriptor.hosted_by.clone(),
    })
    .map_err(|_| RemoteError::Local("cannot serialize remote descriptor".into()))
}

/// Restore the plaintext code from `sealed_code`. Returns whether the file
/// still carried a plaintext code that must be migrated under `sealer`.
fn open_sealed_code(
    mut stored: StoredDescriptor,
    sealer: Option<&dyn Sealer>,
) -> Result<(StoredDescriptor, bool), RemoteError> {
    let Some(sealed) = stored.sealed_code.take() else {
        let migrate = sealer.is_some() && stored.code.is_some();
        return Ok((stored, migrate));
    };
    let Some(sealer) = sealer else {
        return Err(RemoteError::Local(
            "protected storage is unavailable for this pairing link; try again on the original device".into(),
        ));
    };
    if !sealer.hardware_available() {
        return Err(RemoteError::SecureStorageUnavailable { identity_kept: true });
    }
    if stored.code.is_some() {
        return Err(RemoteError::Local("the remote access descriptor is corrupt".into()));
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&sealed)
        .map_err(|_| RemoteError::Local("the remote access descriptor is corrupt".into()))?;
    let code = sealer
        .open(&at_rest::pairing_code_purpose(&stored.node_id), &bytes)
        .map_err(|e| {
            RemoteError::Local(format!(
                "this device cannot open its saved pairing code: {e}"
            ))
        })?;
    let code = std::str::from_utf8(&code)
        .map_err(|_| RemoteError::Local("the remote access descriptor is corrupt".into()))?;
    stored.code = Some(code.to_owned());
    Ok((stored, false))
}

#[cfg(not(windows))]
fn persist_with(
    path: &Path,
    descriptor: &RemoteDescriptor,
    sealer: Option<&dyn Sealer>,
) -> Result<(), RemoteError> {
    // A code that cannot be sealed is never written, not even to a tempfile.
    if descriptor.code.is_some() && sealer.is_some_and(|sealer| !sealer.hardware_available()) {
        return Err(RemoteError::SecureStorageUnavailable { identity_kept: false });
    }
    let dir = path
        .parent()
        .ok_or_else(|| RemoteError::Local("remote config has no parent directory".into()))?;
    pairing::key::restrict_dir(dir).map_err(|e| RemoteError::Local(e.to_string()))?;
    if path.exists() {
        pairing::key::check_owner_only(path, "remote access descriptor")
            .map_err(|e| RemoteError::Local(e.to_string()))?;
    }
    let tmp = dir.join(format!("{REMOTE_CONFIG_FILE}.tmp"));
    let _ = std::fs::remove_file(&tmp);
    let mut file = pairing::key::create_new_protected(&tmp)
        .map_err(|e| RemoteError::Local(format!("cannot create remote descriptor: {e}")))?;
    let bytes = match stored_bytes(descriptor, sealer) {
        Ok(bytes) => bytes,
        Err(error) => {
            drop(file);
            let _ = std::fs::remove_file(&tmp);
            return Err(error);
        }
    };
    let io_error = |error| RemoteError::Local(format!("cannot persist remote descriptor: {error}"));
    let result = (|| {
        // Check the actual serialized ciphertext, including base64 expansion.
        if bytes.len() > MAX_LINK_BYTES {
            return Err(RemoteError::Local(
                "the remote access descriptor is oversized".into(),
            ));
        }
        std::io::Write::write_all(&mut file, &bytes)
            .and_then(|()| file.sync_all()).map_err(io_error)?;
        if sealer.is_some() && descriptor.code.is_some() {
            let readback = std::fs::read(&tmp).map_err(io_error)?;
            let stored = serde_json::from_slice(&readback)
                .map_err(|_| RemoteError::Local("cannot verify protected pairing code".into()))?;
            let (opened, _) = open_sealed_code(stored, sealer)?;
            if opened.code != descriptor.code {
                return Err(RemoteError::Local("protected pairing code does not reopen to the same code".into()));
            }
        }
        std::fs::rename(&tmp, path).map_err(io_error)
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    Ok(())
}

/// The descriptor file's bytes; unchanged path read outside Windows.
#[cfg(not(windows))]
fn read_descriptor_file(path: &Path) -> std::io::Result<Vec<u8>> {
    std::fs::read(path)
}

/// Windows: the descriptor on the private-file layer.
#[cfg(windows)]
#[path = "remote_access/windows_store.rs"]
mod windows_store;
#[cfg(windows)]
use windows_store::{persist_with, read_descriptor_file};

/// Validate with the same parser as import, without storage or network access.
pub fn preview_pairing_link(link: &str) -> Result<RemotePreviewView, RemoteError> {
    let descriptor = parse_pairing_link(link)?;
    Ok(RemotePreviewView {
        second_device: descriptor.code.as_deref().is_some_and(|code| code.starts_with("second_")),
        first_run: descriptor.bootstrap_box_key().is_some() && descriptor.node_id().is_empty(),
        endpoint: descriptor.endpoint.clone(),
        node_id_fingerprint: node_id_fingerprint(descriptor.bootstrap_box_key().unwrap_or(&descriptor.node_id)),
        hosted_by: descriptor.hosted_by.clone(),
    })
}

pub fn import_pairing_link(
    app_data_dir: &Path,
    link: &str,
) -> Result<RemoteImportView, RemoteError> {
    let descriptor = parse_pairing_link(link)?;
    let _config = REMOTE_CONFIG_LOCK.lock().unwrap();
    persist_at(&config_path(app_data_dir), &descriptor)?;
    Ok(RemoteImportView {
        endpoint: descriptor.endpoint.clone(),
        node_id_fingerprint: node_id_fingerprint(descriptor.bootstrap_box_key().unwrap_or(&descriptor.node_id)),
        hosted_by: descriptor.hosted_by.clone(),
        restart_required: true,
    })
}

/// The identity a descriptor pins: its node id, or the box key of an
/// identity-free bootstrap ticket.
fn pinned_identity(descriptor: &RemoteDescriptor) -> &str {
    descriptor.bootstrap_box_key().unwrap_or(&descriptor.node_id)
}

/// Whether `next` would replace `current` with a different node. Pure.
pub fn replaces_another_node(current: &RemoteDescriptor, next: &RemoteDescriptor) -> bool {
    !pinned_identity(current).eq_ignore_ascii_case(pinned_identity(next))
}

/// Forget only the startup link. Local keys, identity and live transport are untouched.
pub fn forget_persisted(app_data_dir: &Path) -> Result<(), RemoteError> {
    let _config = REMOTE_CONFIG_LOCK.lock().unwrap();
    let descriptor = config_path(app_data_dir);
    if descriptor.exists() {
        let dir = app_data_dir.join(REMOTE_CONFIG_DIR);
        pairing::key::restrict_dir(&dir).map_err(|e| RemoteError::Local(e.to_string()))?;
        let reset = dir.join(LOCAL_PAIRING_RESET);
        #[cfg(windows)]
        crate::private_fs::ensure_marker(&reset)
            .map_err(|e| RemoteError::Local(format!("cannot schedule local pairing reset: {e}")))?;
        #[cfg(not(windows))]
        if reset.exists() {
            pairing::key::check_owner_only(&reset, "local pairing reset")
                .map_err(|e| RemoteError::Local(e.to_string()))?;
        } else {
            pairing::key::create_new_protected(&reset)
                .and_then(|file| file.sync_all())
                .map_err(|e| RemoteError::Local(format!("cannot schedule local pairing reset: {e}")))?;
        }
    }
    match std::fs::remove_file(descriptor) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(RemoteError::Local(format!("cannot forget remote descriptor: {error}"))),
    }
}

/// Called only at startup, before attaching a local node. Remote and local
/// sessions historically share the pairing record, so discard the old remote
/// record here, after the previous process and its live session have exited.
pub fn prepare_local_pairing(app_data_dir: &Path, pairing_store: &Path) -> Result<(), RemoteError> {
    let _config = REMOTE_CONFIG_LOCK.lock().unwrap();
    let reset = app_data_dir.join(REMOTE_CONFIG_DIR).join(LOCAL_PAIRING_RESET);
    if config_path(app_data_dir).exists() || !reset.exists() {
        return Ok(());
    }
    pairing::key::check_owner_only(&reset, "local pairing reset")
        .map_err(|e| RemoteError::Local(e.to_string()))?;
    match std::fs::remove_file(pairing_store.join(pairing::RECORD_FILE)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(RemoteError::Local(format!("cannot reset remote pairing record: {error}"))),
    }
    std::fs::remove_file(reset)
        .map_err(|error| RemoteError::Local(format!("cannot finish local pairing reset: {error}")))
}

pub fn load_persisted(app_data_dir: &Path) -> Result<Option<RemoteDescriptor>, RemoteError> {
    let sealer = at_rest::installed();
    // A one-time migration rewrites the file; never race an import or forget.
    let _config = sealer.map(|_| REMOTE_CONFIG_LOCK.lock().unwrap());
    load_with(&config_path(app_data_dir), sealer)
}

fn load_with(
    path: &Path,
    sealer: Option<&dyn Sealer>,
) -> Result<Option<RemoteDescriptor>, RemoteError> {
    if pairing::key::nothing_at(path) {
        return Ok(None);
    }
    #[cfg(not(windows))]
    pairing::key::check_owner_only(path, "remote access descriptor")
        .map_err(|e| RemoteError::Local(e.to_string()))?;
    let bytes = read_descriptor_file(path)
        .map_err(|e| RemoteError::Local(format!("cannot read remote descriptor: {e}")))?;
    if bytes.len() > MAX_LINK_BYTES {
        return Err(RemoteError::Local(
            "the remote access descriptor is oversized".into(),
        ));
    }
    let persisted: StoredDescriptor = serde_json::from_slice(&bytes)
        .map_err(|_| RemoteError::Local("the remote access descriptor is corrupt".into()))?;
    let (persisted, migrate) = open_sealed_code(persisted, sealer)?;
    let descriptor = validate_descriptor(persisted)?;
    if migrate {
        // The atomic replacement unlinks the file that held the plaintext code.
        if let Err(error) = persist_with(path, &descriptor, sealer) {
            // A missing Secure Enclave refuses before anything is written, so the
            // existing pairing on disk is untouched: report it as kept.
            let error = match error {
                RemoteError::SecureStorageUnavailable { .. } => {
                    RemoteError::SecureStorageUnavailable { identity_kept: true }
                }
                other => other,
            };
            if !sealer.is_some_and(|sealer| sealer.allows_plaintext_fallback()) {
                return Err(error);
            }
            // `migrate` proves the original descriptor was plaintext. Never
            // use this fallback for a failed open of an existing sealed code.
            eprintln!("[pairing] retaining the plaintext pending pairing code: {error}");
        }
    }
    Ok(Some(descriptor))
}

/// The descriptor currently on disk, as `finalize_authenticated_pairing`
/// compares it. Unchanged without a sealer.
fn saved_descriptor(bytes: &[u8]) -> Option<RemoteDescriptor> {
    let Some(sealer) = at_rest::installed() else {
        return serde_json::from_slice::<RemoteDescriptor>(bytes).ok();
    };
    let stored = serde_json::from_slice::<StoredDescriptor>(bytes).ok()?;
    let (stored, _) = open_sealed_code(stored, Some(sealer)).ok()?;
    validate_descriptor(stored).ok()
}

fn derived_transport_key(key: &ClientKey) -> ([u8; 32], [u8; 32]) {
    let mut secret_bytes =
        key.with_seed(|seed| blake3::derive_key(CLIENT_TRANSPORT_KDF_CONTEXT, seed));
    let secret = StaticSecret::from(secret_bytes);
    secret_bytes.fill(0);
    let public = X25519PublicKey::from(&secret);
    (secret.to_bytes(), public.to_bytes())
}

pub fn client_transport_public_key(key: &ClientKey) -> [u8; 32] {
    derived_transport_key(key).1
}

fn auth_request(
    descriptor: &RemoteDescriptor,
    key: &ClientKey,
    client_name: &str,
) -> RemoteAuthRequest {
    let Some(code) = descriptor.code.as_deref() else {
        return RemoteAuthRequest {
            v: 1,
            code: None,
            client_name: None,
            client_pubkey: None,
            signature: None,
        };
    };
    let (_, transport_public) = derived_transport_key(key);
    let transport_public_hex = hex::encode(transport_public);
    let client_pubkey = key.public_hex().to_string();
    let proof = auth_proof_message(
        &descriptor.node_id,
        &transport_public_hex,
        code,
        &client_pubkey,
    );
    RemoteAuthRequest {
        v: 1,
        code: Some(code.to_string()),
        client_name: Some(client_name.to_string()),
        client_pubkey: Some(client_pubkey),
        signature: Some(
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(key.sign_bytes(proof.as_bytes())),
        ),
    }
}

async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    frame: &[u8],
) -> Result<(), RemoteError> {
    if frame.is_empty() || frame.len() > MAX_HANDSHAKE_FRAME {
        return Err(RemoteError::Transport(
            "outbound frame exceeds the limit".into(),
        ));
    }
    tokio::time::timeout(WRITE_TIMEOUT, async {
        writer
            .write_all(&(frame.len() as u32).to_be_bytes())
            .await
            .map_err(|e| RemoteError::Transport(format!("cannot write frame length: {e}")))?;
        writer
            .write_all(frame)
            .await
            .map_err(|e| RemoteError::Transport(format!("cannot write frame: {e}")))
    }).await.map_err(|_| RemoteError::Transport("frame write timed out".into()))?
}

async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
    max_len: usize,
) -> Result<Vec<u8>, RemoteError> {
    let mut length = [0u8; 4];
    reader
        .read_exact(&mut length)
        .await
        .map_err(|e| RemoteError::Transport(format!("cannot read frame length: {e}")))?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > max_len {
        return Err(RemoteError::Transport(
            "inbound frame exceeds the limit".into(),
        ));
    }
    let mut frame = vec![0u8; length];
    reader
        .read_exact(&mut frame)
        .await
        .map_err(|e| RemoteError::Transport(format!("cannot read frame: {e}")))?;
    Ok(frame)
}

/// Match `NoiseSession::encrypt`: each snow ciphertext has an inner u16-BE
/// length, and the resulting record is later wrapped by the outer u32 frame.
fn encode_transport(noise: &mut TransportState, plaintext: &[u8]) -> Result<Vec<u8>, RemoteError> {
    if plaintext.is_empty() || plaintext.len() > MAX_NOISE_PLAINTEXT {
        return Err(RemoteError::Transport(
            "transport plaintext exceeds the limit".into(),
        ));
    }
    let mut ciphertext = vec![0u8; plaintext.len() + 16];
    let length = noise
        .write_message(plaintext, &mut ciphertext)
        .map_err(|e| RemoteError::Transport(format!("Noise encrypt failed: {e}")))?;
    let inner_length = u16::try_from(length)
        .map_err(|_| RemoteError::Transport("Noise ciphertext length overflow".into()))?;
    let mut record = Vec::with_capacity(length + 2);
    record.extend_from_slice(&inner_length.to_be_bytes());
    record.extend_from_slice(&ciphertext[..length]);
    if record.len() > MAX_TRANSPORT_FRAME {
        return Err(RemoteError::Transport(
            "transport record exceeds the limit".into(),
        ));
    }
    Ok(record)
}

/// Match `NoiseSession::decrypt`, including its support for one or more inner
/// length-prefixed snow ciphertexts in a transport record.
fn decode_transport(
    noise: &mut TransportState,
    record: &[u8],
    max_plaintext: usize,
) -> Result<Vec<u8>, RemoteError> {
    if record.is_empty() || record.len() > MAX_TRANSPORT_FRAME {
        return Err(RemoteError::Transport(
            "transport record exceeds the limit".into(),
        ));
    }
    let mut plaintext = Vec::new();
    let mut cursor = 0;
    while cursor < record.len() {
        if cursor + 2 > record.len() {
            return Err(RemoteError::Transport(
                "transport record has a truncated inner length".into(),
            ));
        }
        let length = u16::from_be_bytes([record[cursor], record[cursor + 1]]) as usize;
        cursor += 2;
        if length == 0 || cursor + length > record.len() {
            return Err(RemoteError::Transport(
                "transport record has an invalid inner length".into(),
            ));
        }
        let mut chunk = vec![0u8; length];
        let written = noise
            .read_message(&record[cursor..cursor + length], &mut chunk)
            .map_err(|e| RemoteError::Transport(format!("Noise decrypt failed: {e}")))?;
        plaintext.extend_from_slice(&chunk[..written]);
        if plaintext.len() > max_plaintext {
            return Err(RemoteError::Transport(
                "decrypted transport plaintext exceeds the limit".into(),
            ));
        }
        cursor += length;
    }
    if plaintext.is_empty() {
        return Err(RemoteError::Transport(
            "decrypted transport plaintext is empty".into(),
        ));
    }
    Ok(plaintext)
}

fn retry_hint(message: &[u8]) -> Option<u64> {
    #[derive(Deserialize)]
    struct Hint {
        code: String,
        v: u64,
        retry_after_secs: u64,
    }
    if message.len() > 1024 {
        return None;
    }
    let hint: Hint = serde_json::from_slice(message).ok()?;
    (hint.code == "rate_limited" && hint.v == 1 && (1..=60).contains(&hint.retry_after_secs))
        .then_some(hint.retry_after_secs)
}

#[cfg(test)]
async fn pinned_handshake<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S, descriptor: &RemoteDescriptor, key: &ClientKey,
) -> Result<TransportState, RemoteError> {
    pinned_handshake_bound(stream, descriptor, key).await.map(|(noise, _)| noise)
}

async fn pinned_handshake_bound<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    descriptor: &RemoteDescriptor,
    key: &ClientKey,
) -> Result<(TransportState, [u8;32]), RemoteError> {
    tokio::time::timeout(CONNECT_TIMEOUT, async {
        let (secret, _) = derived_transport_key(key);
        let params = NOISE_PROTOCOL
            .parse()
            .map_err(|_| RemoteError::Local("invalid built-in Noise protocol".into()))?;
        let mut noise = Builder::new(params)
            .local_private_key(&secret)
            .and_then(|b| b.build_initiator())
            .map_err(|e| RemoteError::Local(format!("cannot initialize Noise: {e}")))?;
        let mut output = vec![0u8; MAX_HANDSHAKE_FRAME];
        let length = noise
            .write_message(&[], &mut output)
            .map_err(|e| RemoteError::Transport(format!("Noise message 1 failed: {e}")))?;
        write_frame(stream, &output[..length]).await?;

        let message = read_frame(stream, MAX_HANDSHAKE_FRAME).await?;
        // This unauthenticated record can only delay a retry. It never grants
        // pairing, changes the descriptor, or bypasses the Noise pin checks.
        if let Some(seconds) = retry_hint(&message) {
            return Err(RemoteError::RateLimited(seconds));
        }
        noise
            .read_message(&message, &mut output)
            .map_err(|e| RemoteError::Transport(format!("Noise message 2 failed: {e}")))?;
        let responder = noise.get_remote_static().ok_or_else(|| {
            RemoteError::Transport("Noise responder did not present a static key".into())
        })?;
        if responder != descriptor.transport_pubkey_bytes
            && !(descriptor.code.is_none() && descriptor.box_pin()?.as_ref().is_some_and(|pin| pin.matches(responder))) {
            return Err(RemoteError::Transport(
                "Noise responder static key does not match the pairing link".into(),
            ));
        }

        let length = noise
            .write_message(&[], &mut output)
            .map_err(|e| RemoteError::Transport(format!("Noise message 3 failed: {e}")))?;
        write_frame(stream, &output[..length]).await?;
        let hash: [u8;32] = noise.get_handshake_hash().try_into()
            .map_err(|_| RemoteError::Invalid("invalid Noise transcript".into()))?;
        noise
            .into_transport_mode().map(|noise| (noise, hash))
            .map_err(|e| RemoteError::Transport(format!("Noise transport transition failed: {e}")))
    }).await.map_err(|_| RemoteError::HandshakeUnavailable)?
}

async fn encrypted_auth<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    noise: &mut TransportState,
    descriptor: &RemoteDescriptor,
    key: &ClientKey,
    client_name: &str,
    recovery_node: Option<&str>,
    before_auth: Option<&(dyn Fn() -> Result<(), RemoteError> + Sync)>,
) -> Result<(String, Vec<String>, Option<TransportProofs>), RemoteError> {
    tokio::time::timeout(CONNECT_TIMEOUT, async {
        let request = serde_json::to_vec(&auth_request(descriptor, key, client_name))
            .map_err(|_| RemoteError::Local("cannot serialize remote authentication".into()))?;
        if request.is_empty() || request.len() > MAX_AUTH_PLAINTEXT {
            return Err(RemoteError::Local(
                "remote authentication request is oversized".into(),
            ));
        }
        let encrypted = encode_transport(noise, &request)?;
        if let Some(retire) = before_auth { retire()?; }
        write_frame(stream, &encrypted).await?;

        let encrypted = read_frame(stream, MAX_TRANSPORT_FRAME).await?;
        let plaintext = decode_transport(noise, &encrypted, MAX_AUTH_PLAINTEXT)?;
        let response: RemoteAuthResponse = serde_json::from_slice(&plaintext)
            .map_err(|_| RemoteError::Transport("authentication reply has the wrong shape".into()))?;
        match response {
            RemoteAuthResponse::Ok {
                v,
                client_id,
                scopes,
                box_transport_pubkey,
                box_transport_signature,
                transport_pubkey,
                transport_signature,
            } => {
                if v != 1 {
                    return Err(RemoteError::Transport(
                        "authentication reply has an unsupported version".into(),
                    ));
                }
                if client_id.len() != 32
                    || !client_id
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return Err(RemoteError::Transport(
                        "authentication reply has an invalid client id".into(),
                    ));
                }
                let node = recovery_node.unwrap_or(&descriptor.node_id);
                let live = match (transport_pubkey, transport_signature) {
                    (Some(public), Some(signature)) => {
                        verify_transport_proof(node, &public, &signature)?;
                        Some((public, signature))
                    }
                    (None, None) => None,
                    _ => return Err(RemoteError::Invalid("incomplete live transport proof".into())),
                };
                let mut proofs = None;
                match (box_transport_pubkey, box_transport_signature) {
                    (Some(public), Some(signature)) => {
                        let pin = BoxPin::verify(node, &descriptor.endpoint, &public, &signature)?;
                        if recovery_node.is_some() {
                            // The identity comes from the saved SAS confirmation, never this reply.
                            if descriptor.bootstrap_box_key() != Some(public.as_str())
                                || !pin.matches(noise.get_remote_static().unwrap_or(&[])) {
                                return Err(RemoteError::Invalid("recovery changed the pinned box static".into()));
                            }
                        } else if noise.get_remote_static() == Some(&descriptor.transport_pubkey_bytes[..]) {
                            if let Some(store) = &descriptor.pin_store { store.save(&pin)?; }
                        } else if !descriptor.box_pin()?.is_some_and(|saved| saved.public_key == public && saved.matches(noise.get_remote_static().unwrap_or(&[]))) {
                            return Err(RemoteError::Invalid("locked node cannot replace its box pin".into()));
                        }
                        if let Some((transport_pubkey, transport_signature)) = live {
                            proofs = Some(TransportProofs { pin, transport_pubkey, transport_signature });
                        }
                    }
                    (None, None) if noise.get_remote_static() == Some(&descriptor.transport_pubkey_bytes[..])
                        && (recovery_node.is_none() || live.is_none()) => {},
                    _ => return Err(RemoteError::Invalid("missing box transport proof".into())),
                }
                Ok((client_id, scopes, proofs))
            }
            RemoteAuthResponse::Error { v, code, message } => {
                if v != 1 {
                    return Err(RemoteError::Transport(
                        "authentication reply has an unsupported version".into(),
                    ));
                }
                if code == "already_paired" {
                    return Err(RemoteError::AlreadyPaired);
                }
                let reason: String = if let Some(fixed) = ticket_refusal(&code, &message, descriptor.code.as_deref()) {
                    fixed.into()
                } else { format!("{code}: {message}").chars().take(160).collect() };
                Err(RemoteError::Refused(reason))
            }
        }
    }).await.map_err(|_| RemoteError::HandshakeUnavailable)?
}

async fn tunnel<L, R>(
    mut local: L,
    remote: R,
    mut noise: TransportState,
    mut local_http: LocalHttpSanitizer,
    initial_local: Vec<u8>,
) -> Result<(), RemoteError>
where
    L: AsyncRead + AsyncWrite + Unpin,
    R: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut remote_reader, mut remote_writer) = tokio::io::split(remote);
    let (frames_tx, mut frames_rx) =
        mpsc::channel::<Result<Vec<u8>, RemoteError>>(REMOTE_READER_QUEUE);
    let reader_task = tokio::spawn(async move {
        loop {
            let frame = read_frame(&mut remote_reader, MAX_TRANSPORT_FRAME).await;
            let stop = frame.is_err();
            if frames_tx.send(frame).await.is_err() || stop {
                break;
            }
        }
    });
    struct AbortOnDrop(tokio::task::JoinHandle<()>);
    impl Drop for AbortOnDrop {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let _reader_task = AbortOnDrop(reader_task);

    for chunk in initial_local.chunks(MAX_NOISE_PLAINTEXT) {
        let encrypted = encode_transport(&mut noise, chunk)?;
        write_frame(&mut remote_writer, &encrypted).await?;
    }

    let mut local_buffer = vec![0u8; MAX_NOISE_PLAINTEXT];
    loop {
        tokio::select! {
            // Pooled HTTP streams and silent/half-open peers must not reserve
            // a Noise session indefinitely. Active WebSockets reset this timer.
            _ = tokio::time::sleep(IDLE_TIMEOUT) => return Ok(()),
            read = local.read(&mut local_buffer) => {
                let read = read.map_err(|e| RemoteError::Transport(format!("loopback read failed: {e}")))?;
                if read == 0 {
                    return Ok(());
                }
                let sanitized = local_http.push(&local_buffer[..read])?;
                for chunk in sanitized.chunks(MAX_NOISE_PLAINTEXT) {
                    let encrypted = encode_transport(&mut noise, chunk)?;
                    write_frame(&mut remote_writer, &encrypted).await?;
                }
            }
            frame = frames_rx.recv() => {
                let frame = frame.ok_or_else(|| {
                    RemoteError::Transport("remote framed reader stopped unexpectedly".into())
                })??;
                let plaintext = decode_transport(&mut noise, &frame, MAX_NOISE_PLAINTEXT)?;
                tokio::time::timeout(WRITE_TIMEOUT, local.write_all(&plaintext))
                    .await
                    .map_err(|_| RemoteError::Transport("loopback write timed out".into()))?
                    .map_err(|e| RemoteError::Transport(format!("loopback write failed: {e}")))?;
            }
        }
    }
}

fn auth_token_matches(expected: &str, presented: Option<&str>) -> bool {
    let Some(presented) = presented else {
        return false;
    };
    if expected.len() != presented.len() {
        return false;
    }
    expected
        .bytes()
        .zip(presented.bytes())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

enum LocalHttpState {
    Headers(Vec<u8>),
    FixedBody(usize),
    ChunkSize(Vec<u8>),
    ChunkData(usize),
    ChunkDataCrlf(u8),
    ChunkTrailers { line: Vec<u8>, total: usize },
    Upgraded,
}

struct LocalHttpSanitizer {
    expected_auth: String,
    state: LocalHttpState,
    authenticated_requests: usize,
}

impl LocalHttpSanitizer {
    fn new(expected_auth: &str) -> Self {
        Self {
            expected_auth: expected_auth.to_owned(),
            state: LocalHttpState::Headers(Vec::with_capacity(4096)),
            authenticated_requests: 0,
        }
    }

    fn has_authenticated_request(&self) -> bool {
        self.authenticated_requests != 0
    }

    fn rejected(message: &str) -> RemoteError {
        RemoteError::Local(format!(
            "remote proxy rejected unauthenticated local connection: {message}"
        ))
    }

    fn sanitized_headers(&self, header: &[u8]) -> Result<(Vec<u8>, LocalHttpState), RemoteError> {
        let head = header
            .strip_suffix(b"\r\n\r\n")
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .ok_or_else(|| Self::rejected("malformed HTTP headers"))?;
        let mut lines = head.split("\r\n");
        let request_line = lines
            .next()
            .filter(|line| {
                !line.is_empty()
                    && !line.starts_with(char::is_whitespace)
                    && line.ends_with(" HTTP/1.1")
            })
            .ok_or_else(|| Self::rejected("malformed HTTP request line"))?;
        let mut presented = None;
        let mut content_length = None;
        let mut chunked = false;
        let mut websocket = false;
        let mut connection_upgrade = false;
        let mut sanitized = Vec::with_capacity(header.len());
        sanitized.extend_from_slice(request_line.as_bytes());
        sanitized.extend_from_slice(b"\r\n");

        for line in lines {
            if line.starts_with([' ', '\t']) {
                return Err(Self::rejected("folded HTTP headers are not accepted"));
            }
            let (name, value) = line
                .split_once(':')
                .filter(|(name, _)| !name.is_empty() && name.trim() == *name)
                .ok_or_else(|| Self::rejected("malformed HTTP header"))?;
            let value = value.trim();
            if name.eq_ignore_ascii_case(LOCAL_AUTH_HEADER) {
                if presented.replace(value).is_some() {
                    return Err(Self::rejected("duplicate proxy credential"));
                }
                continue;
            }
            if name.eq_ignore_ascii_case("content-length") {
                if content_length.is_some() {
                    return Err(Self::rejected("duplicate content length"));
                }
                content_length = Some(
                    value
                        .parse::<usize>()
                        .map_err(|_| Self::rejected("invalid content length"))?,
                );
            } else if name.eq_ignore_ascii_case("transfer-encoding") {
                if chunked || !value.eq_ignore_ascii_case("chunked") {
                    return Err(Self::rejected("unsupported transfer encoding"));
                }
                chunked = true;
            } else if name.eq_ignore_ascii_case("upgrade") {
                websocket = value.eq_ignore_ascii_case("websocket");
            } else if name.eq_ignore_ascii_case("connection") {
                connection_upgrade = value
                    .split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("upgrade"));
            }
            sanitized.extend_from_slice(line.as_bytes());
            sanitized.extend_from_slice(b"\r\n");
        }
        if !auth_token_matches(&self.expected_auth, presented) {
            return Err(Self::rejected("missing or wrong proxy credential"));
        }
        if content_length.is_some() && chunked {
            return Err(Self::rejected(
                "content length and transfer encoding cannot be combined",
            ));
        }
        if websocket
            && connection_upgrade
            && (chunked || content_length.is_some_and(|length| length != 0))
        {
            return Err(Self::rejected("WebSocket upgrade cannot carry a body"));
        }
        sanitized.extend_from_slice(b"\r\n");

        let next = if websocket && connection_upgrade {
            LocalHttpState::Upgraded
        } else if chunked {
            LocalHttpState::ChunkSize(Vec::new())
        } else if let Some(length) = content_length.filter(|length| *length != 0) {
            LocalHttpState::FixedBody(length)
        } else {
            LocalHttpState::Headers(Vec::with_capacity(4096))
        };
        Ok((sanitized, next))
    }

    fn push(&mut self, input: &[u8]) -> Result<Vec<u8>, RemoteError> {
        let mut output = Vec::with_capacity(input.len());
        let mut offset = 0;
        while offset < input.len() {
            let state = std::mem::replace(
                &mut self.state,
                LocalHttpState::Headers(Vec::with_capacity(4096)),
            );
            match state {
                LocalHttpState::Headers(mut header) => {
                    while offset < input.len() && !header.ends_with(b"\r\n\r\n") {
                        if header.len() >= MAX_LOCAL_REQUEST_PREFIX {
                            return Err(Self::rejected("HTTP headers exceed the limit"));
                        }
                        header.push(input[offset]);
                        offset += 1;
                    }
                    if header.ends_with(b"\r\n\r\n") {
                        let (sanitized, next) = self.sanitized_headers(&header)?;
                        output.extend_from_slice(&sanitized);
                        self.authenticated_requests += 1;
                        self.state = next;
                    } else {
                        self.state = LocalHttpState::Headers(header);
                    }
                }
                LocalHttpState::FixedBody(mut remaining) => {
                    let take = remaining.min(input.len() - offset);
                    output.extend_from_slice(&input[offset..offset + take]);
                    offset += take;
                    remaining -= take;
                    self.state = if remaining == 0 {
                        LocalHttpState::Headers(Vec::with_capacity(4096))
                    } else {
                        LocalHttpState::FixedBody(remaining)
                    };
                }
                LocalHttpState::ChunkSize(mut line) => {
                    while offset < input.len() && !line.ends_with(b"\r\n") {
                        if line.len() >= 1024 {
                            return Err(Self::rejected("chunk size line exceeds the limit"));
                        }
                        let byte = input[offset];
                        line.push(byte);
                        output.push(byte);
                        offset += 1;
                    }
                    if line.ends_with(b"\r\n") {
                        let size = line[..line.len() - 2]
                            .split(|byte| *byte == b';')
                            .next()
                            .filter(|size| !size.is_empty())
                            .and_then(|size| std::str::from_utf8(size).ok())
                            .and_then(|size| usize::from_str_radix(size, 16).ok())
                            .ok_or_else(|| Self::rejected("invalid chunk size"))?;
                        self.state = if size == 0 {
                            LocalHttpState::ChunkTrailers {
                                line: Vec::new(),
                                total: 0,
                            }
                        } else {
                            LocalHttpState::ChunkData(size)
                        };
                    } else {
                        self.state = LocalHttpState::ChunkSize(line);
                    }
                }
                LocalHttpState::ChunkData(mut remaining) => {
                    let take = remaining.min(input.len() - offset);
                    output.extend_from_slice(&input[offset..offset + take]);
                    offset += take;
                    remaining -= take;
                    self.state = if remaining == 0 {
                        LocalHttpState::ChunkDataCrlf(0)
                    } else {
                        LocalHttpState::ChunkData(remaining)
                    };
                }
                LocalHttpState::ChunkDataCrlf(mut seen) => {
                    while offset < input.len() && seen < 2 {
                        let expected = if seen == 0 { b'\r' } else { b'\n' };
                        if input[offset] != expected {
                            return Err(Self::rejected("invalid chunk delimiter"));
                        }
                        output.push(input[offset]);
                        offset += 1;
                        seen += 1;
                    }
                    self.state = if seen == 2 {
                        LocalHttpState::ChunkSize(Vec::new())
                    } else {
                        LocalHttpState::ChunkDataCrlf(seen)
                    };
                }
                LocalHttpState::ChunkTrailers {
                    mut line,
                    mut total,
                } => {
                    while offset < input.len() && !line.ends_with(b"\r\n") {
                        if total >= MAX_LOCAL_REQUEST_PREFIX {
                            return Err(Self::rejected("chunk trailers exceed the limit"));
                        }
                        let byte = input[offset];
                        line.push(byte);
                        output.push(byte);
                        offset += 1;
                        total += 1;
                    }
                    if line == b"\r\n" {
                        self.state = LocalHttpState::Headers(Vec::with_capacity(4096));
                    } else if line.ends_with(b"\r\n") {
                        self.state = LocalHttpState::ChunkTrailers {
                            line: Vec::new(),
                            total,
                        };
                    } else {
                        self.state = LocalHttpState::ChunkTrailers { line, total };
                    }
                }
                LocalHttpState::Upgraded => {
                    output.extend_from_slice(&input[offset..]);
                    offset = input.len();
                    self.state = LocalHttpState::Upgraded;
                }
            }
        }
        Ok(output)
    }
}

#[cfg(test)]
fn request_has_local_auth(prefix: &[u8], expected: &str) -> bool {
    let mut sanitizer = LocalHttpSanitizer::new(expected);
    sanitizer.push(prefix).is_ok() && sanitizer.has_authenticated_request()
}

async fn authenticated_prefix(
    local: &mut TcpStream,
    expected: &str,
) -> Result<(LocalHttpSanitizer, Vec<u8>), RemoteError> {
    let read = async {
        let mut sanitizer = LocalHttpSanitizer::new(expected);
        loop {
            let mut buffer = vec![0u8; 4096];
            let count = local.read(&mut buffer).await.map_err(|error| {
                RemoteError::Local(format!("cannot read local request: {error}"))
            })?;
            if count == 0 {
                return Err(RemoteError::Local(
                    "local request closed before authentication".into(),
                ));
            }
            let sanitized = sanitizer.push(&buffer[..count])?;
            if sanitizer.has_authenticated_request() {
                return Ok((sanitizer, sanitized));
            }
        }
    };
    tokio::time::timeout(LOCAL_AUTH_TIMEOUT, read)
        .await
        .map_err(|_| RemoteError::Local("local proxy authentication timed out".into()))?
}

fn map_pre_auth_failure(error: RemoteError) -> RemoteError {
    if is_lost_connection(&error) { RemoteError::HandshakeUnavailable } else { error }
}

/// The connection timed out or dropped: the box gave no answer to act on.
fn is_lost_connection(error: &RemoteError) -> bool {
    match error {
        RemoteError::HandshakeUnavailable => true,
        RemoteError::Transport(message) => message.starts_with("cannot read frame")
            || message.starts_with("cannot write frame")
            || message.starts_with("cannot connect to endpoint")
            || message == "connection timed out"
            || message == "frame write timed out",
        _ => false,
    }
}

fn is_unauthenticated_local(error: &RemoteError) -> bool {
    matches!(
        error,
        RemoteError::Local(message)
            if message.starts_with("remote proxy rejected unauthenticated")
                || message.starts_with("local request closed before authentication")
                || message.starts_with("local proxy authentication timed out")
                || message.starts_with("cannot read local request")
                || message.starts_with("remote proxy request headers exceed")
    )
}

pub(crate) async fn write_proxy_error(local: &mut TcpStream, status: &str, code: &str, message: &str) {
    let body = format!(r#"{{"code":"{code}","message":"{message}"}}"#);
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{PROXY_ERROR_HEADER}: {code}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = tokio::time::timeout(WRITE_TIMEOUT, async {
        local.write_all(response.as_bytes()).await?;
        local.shutdown().await
    }).await;
}

async fn write_connection_error(local: &mut TcpStream, error: &RemoteError) {
    if let RemoteError::RateLimited(seconds) | RemoteError::Waiting(seconds) = error {
        write_proxy_error(local, "503 Service Unavailable", "remote_retry_wait", &format!("Remote connection unavailable; waiting {seconds} s")).await;
        return;
    }
    let (status, code, message) = match error {
        RemoteError::HandshakeUnavailable => ("503 Service Unavailable", "remote_handshake_unavailable", HANDSHAKE_UNAVAILABLE),
        RemoteError::Refused(_) | RemoteError::AlreadyPaired => ("403 Forbidden", "remote_pairing_refused", "remote node refused pairing"),
        _ => ("502 Bad Gateway", "remote_transport_refused", "remote transport validation failed"),
    };
    write_proxy_error(local, status, code, message).await;
}

fn finalize_authenticated_pairing(
    descriptor: &Mutex<RemoteDescriptor>,
    config_path: &Path,
    pairing_store: &Path,
    key: &ClientKey,
    client_id: String,
    scopes: Vec<String>,
) -> Result<(), RemoteError> {
    let mut current = descriptor
        .lock()
        .map_err(|_| RemoteError::Local("remote descriptor lock is poisoned".into()))?;
    if current.code.is_some() {
        let _config = REMOTE_CONFIG_LOCK.lock().unwrap();
        // Only update the descriptor this handshake started with. Import or
        // forget may have changed the next startup while the network awaited.
        let stored = read_descriptor_file(config_path)
            .ok()
            .and_then(|bytes| saved_descriptor(&bytes));
        if !stored.is_some_and(|saved| saved.node_id == current.node_id
            && saved.endpoint == current.endpoint
            && saved.transport_pubkey == current.transport_pubkey
            && saved.code == current.code)
        {
            return Err(RemoteError::Local("remote pairing link was forgotten or replaced; restart BitSov".into()));
        }
        if scopes.is_empty() {
            let code = current.code.as_deref().unwrap();
            if current.node_id.is_empty() || !(code.starts_with("owner_") || code.starts_with("second_")) {
                return Err(RemoteError::Invalid("unexpected provisional pairing".into()));
            }
            current.enrollment_commitment = Some(crate::second_device::ticket_commitment(code));
        }
        current.code = None;
        if let Err(error) = persist_at(config_path, &current) {
            // Fail closed: never leave a confirmed one-time code available
            // for replay after restart if the atomic replacement failed.
            let _ = std::fs::remove_file(config_path);
            return Err(error);
        }
        // This durable write is deliberately after descriptor replacement.
        pairing::save_remote_record(pairing_store, key, client_id, scopes)
            .map_err(|e| RemoteError::Local(e.to_string()))?;
    } else {
        pairing::save_remote_record_once(pairing_store, key, client_id, scopes)
            .map_err(|e| RemoteError::Local(e.to_string()))?;
    }
    Ok(())
}

async fn connect_authenticated(
    descriptor: &RemoteDescriptor,
    key: &ClientKey,
    client_name: &str,
) -> Result<(TcpStream, TransportState, String, Vec<String>), RemoteError> {
    let (remote, noise, _, client_id, scopes, _) = connect_bound(descriptor, key, client_name, None, None).await?;
    Ok((remote, noise, client_id, scopes))
}

// The endpoint that last completed the handshake and authentication, per box
// identity. Endpoints are public routing data; this is never persisted.
static PREFERRED_ENDPOINTS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
const MAX_PREFERRED_ENDPOINTS: usize = 8;

fn endpoint_memory_key(descriptor: &RemoteDescriptor) -> String {
    format!("{}/{}/{}", descriptor.node_id, descriptor.transport_pubkey, descriptor.box_transport_pubkey)
}

/// Try the endpoint that worked last time first, then the rest in their
/// advertised order. An unknown or no longer advertised endpoint changes nothing.
fn ordered_endpoints<'a>(descriptor: &RemoteDescriptor, mut endpoints: Vec<&'a str>) -> Vec<&'a str> {
    let key = endpoint_memory_key(descriptor);
    let preferred = PREFERRED_ENDPOINTS.lock().ok()
        .and_then(|memory| memory.iter().find(|(k, _)| *k == key).map(|(_, endpoint)| endpoint.clone()));
    if let Some(index) = preferred.and_then(|p| endpoints.iter().position(|endpoint| *endpoint == p)) {
        let endpoint = endpoints.remove(index);
        endpoints.insert(0, endpoint);
    }
    endpoints
}

fn remember_endpoint(descriptor: &RemoteDescriptor, endpoint: &str) {
    let key = endpoint_memory_key(descriptor);
    let Ok(mut memory) = PREFERRED_ENDPOINTS.lock() else { return };
    memory.retain(|(k, _)| *k != key);
    if memory.len() >= MAX_PREFERRED_ENDPOINTS { memory.remove(0); }
    memory.push((key, endpoint.to_owned()));
}

fn forget_endpoint(descriptor: &RemoteDescriptor, endpoint: &str) {
    let key = endpoint_memory_key(descriptor);
    let Ok(mut memory) = PREFERRED_ENDPOINTS.lock() else { return };
    memory.retain(|(k, remembered)| *k != key || remembered != endpoint);
}

async fn connect_bound(
    descriptor: &RemoteDescriptor, key: &ClientKey, name: &str, recovery_node: Option<&str>,
    before_auth: Option<&(dyn Fn() -> Result<(), RemoteError> + Sync)>,
) -> Result<(TcpStream, TransportState, [u8; 32], String, Vec<String>, Option<TransportProofs>), RemoteError> {
    let routes = if descriptor.endpoints.is_empty() { &descriptor.bootstrap_routes } else { &descriptor.endpoints };
    let endpoints = if routes.is_empty() { vec![descriptor.endpoint.as_str()] }
        else { routes.iter().map(String::as_str).collect() };
    // Each unreachable endpoint costs up to CONNECT_TIMEOUT, on every new tunnel.
    let endpoints = ordered_endpoints(descriptor, endpoints);
    let mut last = RemoteError::HandshakeUnavailable;
    for endpoint in endpoints {
        let attempt = async {
            #[cfg(target_os = "android")]
            let addresses = crate::android_network::resolve(endpoint).await?;
            #[cfg(target_os = "android")]
            let target = addresses.as_slice();
            #[cfg(not(target_os = "android"))]
            let target = endpoint;
            let mut stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(target))
                .await.map_err(|_| RemoteError::HandshakeUnavailable)?
                .map_err(|error| connect_error(error, endpoint))?;
            let (noise, hash) = pinned_handshake_bound(&mut stream, descriptor, key).await?;
            Ok::<_, RemoteError>((stream, noise, hash))
        }.await;
        match attempt {
            Ok((mut remote, mut noise, hash)) => {
                match encrypted_auth(&mut remote, &mut noise, descriptor, key, name, recovery_node, before_auth).await {
                    Ok((client, scopes, proofs)) => {
                        remember_endpoint(descriptor, endpoint);
                        return Ok((remote, noise, hash, client, scopes, proofs));
                    }
                    // A one-time code may already be spent on this box, so the
                    // next endpoint could only refuse it, and an answer from the
                    // box is final. Leaving here also keeps `before_auth` to one
                    // run for a code; without a code it has nothing to retire.
                    Err(error) if descriptor.has_code() || !is_lost_connection(&error) => return Err(error),
                    Err(error) => {
                        forget_endpoint(descriptor, endpoint);
                        last = error;
                    }
                }
            }
            Err(error @ RemoteError::RateLimited(_)) => return Err(error),
            // Keep the actionable OS error if a later fallback is unreachable.
            Err(error @ (RemoteError::LocalNetwork | RemoteError::AndroidLocalNetwork)) => last = error,
            Err(error) => {
                let error = map_pre_auth_failure(error);
                if !matches!(last, RemoteError::LocalNetwork | RemoteError::AndroidLocalNetwork) || !matches!(error, RemoteError::HandshakeUnavailable) {
                    last = error;
                }
            }
        }
    }
    Err(last)
}

/// Re-pin a verified finalize receipt (or pinned LOCKED recovery) for the SAS box.
pub fn commit_bootstrap(app_dir: &Path, previous: &RemoteDescriptor,
    node: &str, box_key: &str, box_signature: &str, live_key: &str, live_signature: &str,
) -> Result<RemoteDescriptor, RemoteError> {
    verify_transport_proof(node, live_key, live_signature)?;
    let _config = REMOTE_CONFIG_LOCK.lock().unwrap();
    let stored = read_descriptor_file(&config_path(app_dir)).ok().and_then(|bytes| saved_descriptor(&bytes));
    if !stored.is_some_and(|saved| saved.node_id == previous.node_id
        && saved.box_transport_pubkey == previous.box_transport_pubkey
        && saved.endpoint == previous.endpoint && saved.endpoints == previous.endpoints
        && saved.code == previous.code) {
        return Err(RemoteError::Local("the pairing link changed during setup; its replacement was not overwritten".into()));
    }
    if (!previous.node_id.is_empty() && previous.node_id != node) || previous.box_transport_pubkey != box_key {
        return Err(RemoteError::Invalid("finalize changed the bootstrap box pin".into()));
    }
    let descriptor = validate_descriptor(StoredDescriptor {
        enrollment_commitment: None,
        v: 1, endpoint: previous.endpoint.clone(), endpoints: vec![], endpoints_signature: None,
        bootstrap_routes: if previous.endpoints.is_empty() { previous.bootstrap_routes.clone() } else { previous.endpoints.clone() },
        node_id: node.into(), transport_pubkey: live_key.into(), transport_signature: live_signature.into(),
        box_transport_pubkey: box_key.into(), box_transport_signature: Some(box_signature.into()),
        code: None, sealed_code: None, hosted_by: previous.hosted_by.clone(),
    })?.with_pin_store(previous.pin_store.clone().ok_or_else(|| RemoteError::Local("missing protected pin store".into()))?);
    persist_at(&config_path(app_dir), &descriptor)?;
    Ok(descriptor)
}

/// Remove the consumed ticket hash only after enrollment and access refresh.
/// Do not resurrect a forgotten descriptor or overwrite a replacement import.
pub fn clear_enrollment_commitment(app_dir: &Path, descriptor: &mut RemoteDescriptor) -> Result<(), RemoteError> {
    let _config = REMOTE_CONFIG_LOCK.lock().unwrap();
    let path = config_path(app_dir);
    let mut saved = read_descriptor_file(&path).ok().and_then(|bytes| saved_descriptor(&bytes))
        .ok_or_else(|| RemoteError::Local("pairing ticket was forgotten or replaced".into()))?;
    if saved.node_id != descriptor.node_id || saved.endpoint != descriptor.endpoint
        || saved.transport_pubkey != descriptor.transport_pubkey || saved.code.is_some()
        || saved.enrollment_commitment != descriptor.enrollment_commitment {
        return Err(RemoteError::Local("pairing ticket was forgotten or replaced".into()));
    }
    saved.enrollment_commitment = None;
    persist_at(&path, &saved)?;
    descriptor.enrollment_commitment = None;
    Ok(())
}

/// Identity proofs obtained inside an authenticated, already pinned session.
pub struct TransportProofs {
    pub pin: BoxPin,
    pub transport_pubkey: String,
    pub transport_signature: String,
}

pub async fn recover_bootstrap(
    descriptor: &RemoteDescriptor, key: &ClientKey, name: &str,
    trusted_node: &str, expected_client: &str,
) -> Result<Option<TransportProofs>, RemoteError> {
    if descriptor.bootstrap_box_key().is_none() || descriptor.has_code() {
        return Err(RemoteError::Invalid("recovery requires the already paired bootstrap box".into()));
    }
    let (mut remote, mut noise, _, client_id, scopes, proofs) =
        connect_bound(descriptor, key, name, Some(trusted_node), None).await?;
    if client_id != expected_client {
        return Err(RemoteError::Invalid("recovery client binding changed".into()));
    }
    let Some(proofs) = proofs else {
        // A crash just before send, or a definite precommit refusal, can leave
        // the same pinned box in SETUP. Keep the saved identity context, allow
        // bootstrap UI/cancellation, and never infer a new live pin.
        if scopes.iter().any(|s| s == "identity") {
            let (status, body) = noise_http_request(&mut remote, &mut noise,
                "GET", "/api/v1/bootstrap/state", b"", None).await?;
            let state: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
            if status == 200 && state["state"] == "bootstrap" { return Ok(None); }
        }
        return Err(RemoteError::Invalid("locked node omitted its signed live transport proof; no new pin was saved".into()));
    };
    let mut connection = LockedConnection { remote, noise, client_id, pin: proofs.pin.clone() };
    connection.status().await?;
    Ok(Some(proofs))
}

/// Dedicated host-only HTTP channel. Unlock passwords never enter the loopback proxy.
/// A connection can be constructed only after an existing box pin matched Noise.
pub struct LockedConnection {
    remote: TcpStream,
    noise: TransportState,
    pub client_id: String,
    pub pin: BoxPin,
}
impl LockedConnection {
    pub async fn connect(descriptor: &RemoteDescriptor, key: &ClientKey, name: &str) -> Result<Option<Self>, RemoteError> {
        if descriptor.has_code() { return Ok(None); }
        let Some(pin) = descriptor.box_pin()? else { return Ok(None); };
        let (remote, noise, client_id, _) = connect_authenticated(descriptor, key, name).await?;
        if noise.get_remote_static() == Some(&descriptor.transport_pubkey_bytes[..]) { return Ok(None); }
        if !pin.matches(noise.get_remote_static().unwrap_or(&[])) {
            return Err(RemoteError::Invalid("unlock requires the pinned box static".into()));
        }
        Ok(Some(Self { remote, noise, client_id, pin }))
    }

    pub async fn status(&mut self) -> Result<crate::home_node::LockStatus, RemoteError> {
        let (status, body) = self.request("GET", "/api/v1/node/lock", b"").await?;
        if status != 200 { return Err(RemoteError::Refused("lock status unavailable".into())); }
        let lock: crate::home_node::LockStatus = serde_json::from_slice(&body)
            .map_err(|_| RemoteError::Invalid("invalid lock status".into()))?;
        if lock.state != "locked" || lock.node_id != self.pin.node_id
            || lock.fingerprint != crate::home_node::identity_fingerprint(&self.pin.node_id) {
            return Err(RemoteError::Invalid("locked identity does not match the box pin".into()));
        }
        Ok(lock)
    }

    pub async fn challenge(&mut self) -> Result<crate::home_node::UnlockChallenge, RemoteError> {
        let (status, body) = self.request("POST", "/api/v1/node/unlock/challenge", b"{}").await?;
        unlock_status(status, 200)?;
        serde_json::from_slice(&body).map_err(|_| RemoteError::Invalid("invalid unlock challenge".into()))
    }

    pub async fn unlock(&mut self, body: &crate::home_node::UnlockBody) -> Result<(), RemoteError> {
        let bytes = zeroize::Zeroizing::new(serde_json::to_vec(body)
            .map_err(|_| RemoteError::Local("cannot encode unlock request".into()))?);
        let (status, _) = self.request("POST", "/api/v1/node/unlock", &bytes).await?;
        unlock_status(status, 204)
    }

    async fn request(&mut self, method: &str, path: &str, body: &[u8]) -> Result<(u16, zeroize::Zeroizing<Vec<u8>>), RemoteError> {
        noise_http_request(&mut self.remote, &mut self.noise, method, path, body, None).await
    }
}

async fn noise_http_request(remote: &mut TcpStream, noise: &mut TransportState,
    method: &str, path: &str, body: &[u8], token: Option<&str>,
) -> Result<(u16, zeroize::Zeroizing<Vec<u8>>), RemoteError> {
    if token.is_some_and(|t| t.bytes().any(|b| b <= 32 || b >= 127)) {
        return Err(RemoteError::Invalid("invalid bearer token".into()));
    }
    let authorization = zeroize::Zeroizing::new(token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default());
        let authorization = authorization.as_str();
        tokio::time::timeout(Duration::from_secs(15), async {
            let mut request = zeroize::Zeroizing::new(format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\n{authorization}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes());
            request.extend_from_slice(body);
            for chunk in request.chunks(MAX_NOISE_PLAINTEXT) {
                let encrypted = encode_transport(noise, chunk)?;
                write_frame(remote, &encrypted).await?;
            }
            // Axum's fixed JSON/empty replies have Content-Length (204 may omit it).
            // Do not follow redirects or forward server text, which could echo a secret.
            let mut response = zeroize::Zeroizing::new(Vec::new());
            loop {
                let encrypted = read_frame(remote, MAX_TRANSPORT_FRAME).await?;
                let plaintext = zeroize::Zeroizing::new(decode_transport(noise, &encrypted, MAX_NOISE_PLAINTEXT)?);
                response.extend_from_slice(&plaintext);
                if response.len() > 32 * 1024 { return Err(RemoteError::Invalid("unlock reply too large".into())); }
                if let Some(end) = response.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header = std::str::from_utf8(&response[..end]).map_err(|_| RemoteError::Invalid("invalid unlock HTTP reply".into()))?;
                    let status = header.lines().next().and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse::<u16>().ok())
                        .ok_or_else(|| RemoteError::Invalid("invalid unlock HTTP status".into()))?;
                    let mut length = None;
                    for line in header.lines().skip(1) {
                        let (name, value) = line.split_once(':').ok_or_else(|| RemoteError::Invalid("invalid unlock header".into()))?;
                        if name.eq_ignore_ascii_case("transfer-encoding") { return Err(RemoteError::Invalid("unsupported unlock framing".into())); }
                        if name.eq_ignore_ascii_case("content-length") {
                            if length.is_some() { return Err(RemoteError::Invalid("duplicate unlock length".into())); }
                            length = Some(value.trim().parse::<usize>().map_err(|_| RemoteError::Invalid("invalid unlock length".into()))?);
                        }
                    }
                    let length = length.or((status == 204).then_some(0)).filter(|n| *n <= 16 * 1024)
                        .ok_or_else(|| RemoteError::Invalid("missing or oversized unlock length".into()))?;
                    if response.len() >= end + 4 + length { return Ok((status, zeroize::Zeroizing::new(response[end+4..end+4+length].to_vec()))); }
                }
            }
        }).await.map_err(|_| RemoteError::Transport("unlock request timed out; check the node before retrying".into()))?
}

/// One Noise connection for the entire SAS ceremony. Never reconnects on errors.
pub struct BootstrapConnection {
    remote: TcpStream,
    noise: TransportState,
    pub client_id: String,
    pub binding: crate::sas::NoiseBinding,
}
impl BootstrapConnection {
    /// A fresh, already-paired device's enrollment uses one authenticated Noise
    /// transcript through both requests, without replaying its consumed ticket.
    pub async fn connect_device(descriptor: &RemoteDescriptor, key: &ClientKey, name: &str) -> Result<Self, RemoteError> {
        Self::connect_enrollment(descriptor, key, name, false).await
    }
    pub async fn connect_second_device(descriptor: &RemoteDescriptor, key: &ClientKey, name: &str) -> Result<Self, RemoteError> {
        if descriptor.enrollment_commitment.is_none() {
            return Err(RemoteError::Invalid("scan a second-device ticket first".into()));
        }
        Self::connect_enrollment(descriptor, key, name, true).await
    }
    async fn connect_enrollment(descriptor: &RemoteDescriptor, key: &ClientKey, name: &str, second: bool) -> Result<Self, RemoteError> {
        if descriptor.node_id.is_empty() || descriptor.has_code() {
            return Err(RemoteError::Invalid("an initialized, paired home node is required".into()));
        }
        let pin = descriptor.box_pin()?.ok_or_else(|| RemoteError::Invalid("missing box pin".into()))?;
        let (remote, noise, handshake_hash, client_id, scopes, _) = connect_bound(descriptor, key, name, None, None).await?;
        if (second && !scopes.is_empty()) || (!second && !scopes.iter().any(|s| s == "read")) { return Err(RemoteError::Refused("pairing does not authorize this enrollment".into())); }
        Ok(Self {remote, noise, client_id, binding:crate::sas::NoiseBinding {
            handshake_hash, box_public_key:decode_hex(&pin.public_key, "box pin")?, client_static:client_transport_public_key(key),
        }})
    }

    pub async fn connect(descriptor: &RemoteDescriptor, key: &ClientKey, name: &str) -> Result<Self, RemoteError> {
        if !descriptor.node_id.is_empty() || descriptor.has_code() {
            return Err(RemoteError::Invalid("a paired empty box is required".into()));
        }
        let (remote, noise, handshake_hash, client_id, scopes, _) = connect_bound(descriptor, key, name, None, None).await?;
        if !scopes.iter().any(|s| s == "identity") {
            return Err(RemoteError::Refused("box setup is closed".into()));
        }
        Ok(Self { remote, noise, client_id, binding: crate::sas::NoiseBinding {
            handshake_hash, box_public_key: decode_hex(&descriptor.box_transport_pubkey, "box pin")?,
            client_static: client_transport_public_key(key),
        }})
    }
    pub async fn request(&mut self, method: &str, path: &str, body: &[u8], token: &str)
        -> Result<(u16, zeroize::Zeroizing<Vec<u8>>), RemoteError> {
        noise_http_request(&mut self.remote, &mut self.noise, method, path, body, Some(token)).await
    }
}

fn unlock_status(status: u16, expected: u16) -> Result<(), RemoteError> {
    if status == expected { return Ok(()); }
    Err(RemoteError::Refused(match status {
        401 => "Unlock failed. No password was retained by the app.",
        403 => "This device is not approved to unlock this node.",
        409 => "Your node is already unlocking. Wait a few seconds.",
        429 => "Unlock is rate limited. Wait before trying again.",
        _ => "The node did not confirm unlock.",
    }.into()))
}

/// Complete the pinned Noise authentication before any paired HTTP token flow.
///
/// A fresh import has no pairing record yet, so `establish_remote` cannot be
/// the operation that opens the first proxy connection. This direct bootstrap
/// consumes the one-time code, durably saves the returned client record, and
/// returns the descriptor with its code removed.
pub async fn authenticate_pinned_transport_and_save_record(
    app_data_dir: &Path,
    descriptor: RemoteDescriptor,
    key: &ClientKey,
    client_name: &str,
    pairing_store: &Path,
    retry: &RemoteRetry,
) -> Result<RemoteDescriptor, RemoteError> {
    let path = config_path(app_data_dir);
    let one_use = |d: &RemoteDescriptor| d.code.as_deref().is_some_and(|c| c.starts_with("second_") || c.starts_with("owner_"));
    // A previous interrupted send may already have retired the ticket on disk.
    let descriptor = if one_use(&descriptor) {
        let saved = read_descriptor_file(&path).ok().and_then(|bytes| saved_descriptor(&bytes));
        match saved {
            Some(mut saved) if saved.code.is_none() && saved.node_id == descriptor.node_id
                && saved.endpoint == descriptor.endpoint && saved.transport_pubkey == descriptor.transport_pubkey
                && saved.enrollment_commitment == descriptor.code.as_deref().map(crate::second_device::ticket_commitment) => {
                    saved.pin_store = descriptor.pin_store.clone(); saved
                }
            _ => descriptor,
        }
    } else { descriptor };
    let current = Mutex::new(descriptor);
    let retire = || -> Result<(), RemoteError> {
        let mut current = current.lock().unwrap();
        if !one_use(&current) { return Ok(()); }
        let _config = REMOTE_CONFIG_LOCK.lock().unwrap();
        let saved = read_descriptor_file(&path).ok().and_then(|bytes| saved_descriptor(&bytes));
        if !saved.is_some_and(|d| d.node_id == current.node_id && d.endpoint == current.endpoint
            && d.transport_pubkey == current.transport_pubkey && d.code == current.code) {
            return Err(RemoteError::Local("pairing ticket was forgotten or replaced".into()));
        }
        let mut consumed = current.clone();
        consumed.enrollment_commitment = consumed.code.as_deref().map(crate::second_device::ticket_commitment);
        consumed.code = None;
        // Retire BEFORE writing a proof: crashes or lost replies can only
        // reconnect with these same keys, never replay this one-use ticket.
        persist_at(&path, &consumed)?;
        *current = consumed;
        Ok(())
    };
    let (_, _, _, client_id, scopes, _) = retry.run(|| async {
        let snapshot = current.lock().unwrap().clone();
        let result = connect_bound(&snapshot, key, client_name, None, Some(&retire)).await;
        // The ticket was retired before its proof was sent. After a lost reply,
        // or when the node already pairs this client identity, reconnect with
        // the existing pairing: same keys, no code, never the ticket again.
        if matches!(&result, Err(RemoteError::Transport(_) | RemoteError::HandshakeUnavailable | RemoteError::AlreadyPaired))
            && one_use(&snapshot) && !current.lock().unwrap().has_code() {
            let consumed = current.lock().unwrap().clone();
            return connect_bound(&consumed, key, client_name, None, None).await;
        }
        result
    }).await?;
    let mut descriptor = current.into_inner().unwrap();
    if descriptor.enrollment_commitment.is_some() {
        if scopes.is_empty() && descriptor.node_id.is_empty() {
            return Err(RemoteError::Invalid("unexpected provisional pairing".into()));
        }
        let _config = REMOTE_CONFIG_LOCK.lock().unwrap();
        let saved = read_descriptor_file(&path).ok().and_then(|bytes| saved_descriptor(&bytes));
        if !saved.is_some_and(|d| d.node_id == descriptor.node_id && d.endpoint == descriptor.endpoint
            && d.code.is_none() && d.enrollment_commitment == descriptor.enrollment_commitment) {
            return Err(RemoteError::Local("pairing ticket was forgotten or replaced".into()));
        }
        // An owner_ ticket may be the legacy read-scoped ceremony. Only an
        // authenticated provisional response selects SAS v2.
        if !scopes.is_empty() { descriptor.enrollment_commitment = None; persist_at(&path, &descriptor)?; }
        pairing::save_remote_record(pairing_store, key, client_id, scopes).map_err(|e| RemoteError::Local(e.to_string()))?;
        return Ok(descriptor);
    }
    let descriptor = Mutex::new(descriptor);
    finalize_authenticated_pairing(&descriptor, &path, pairing_store, key, client_id, scopes)?;
    descriptor.into_inner().map_err(|_| RemoteError::Local("remote descriptor lock is poisoned".into()))
}

/// Resolves once the local caller has closed or reset its connection, or sent
/// something the sanitizer rejects. A close is only visible behind the bytes
/// before it, so what the caller sends meanwhile (a request body) is read and
/// held for the tunnel.
async fn caller_gone(local: &mut TcpStream, http: &mut LocalHttpSanitizer, held: &mut Vec<u8>) -> Result<(), RemoteError> {
    let mut buffer = vec![0u8; 4096];
    while held.len() < MAX_HELD_LOCAL_BYTES {
        match local.read(&mut buffer).await {
            Ok(count @ 1..) => held.extend(http.push(&buffer[..count])?),
            _ => return Ok(()),
        }
    }
    std::future::pending().await
}

/// A call media WebSocket upgrade (`/api/v1/calls/<id>/media`), which may use
/// the reserved slots.
fn is_call_media_upgrade(http: &LocalHttpSanitizer, initial: &[u8]) -> bool {
    let line = initial.split(|byte| *byte == b'\r').next().unwrap_or_default();
    let Some(target) = std::str::from_utf8(line).ok()
        .and_then(|line| line.strip_prefix("GET "))
        .and_then(|line| line.strip_suffix(" HTTP/1.1")) else { return false };
    let path = target.split('?').next().unwrap_or_default();
    matches!(http.state, LocalHttpState::Upgraded)
        && path.strip_prefix("/api/v1/calls/").and_then(|rest| rest.strip_suffix("/media"))
            .is_some_and(|id| !id.is_empty() && !id.contains('/'))
}

struct AuthenticatedLocal {
    stream: TcpStream,
    http: LocalHttpSanitizer,
    initial: Vec<u8>,
}

async fn serve_connection(
    local: AuthenticatedLocal,
    descriptor: Arc<Mutex<RemoteDescriptor>>,
    config_path: PathBuf,
    key: Arc<ClientKey>,
    client_name: Arc<str>,
    pairing_store: PathBuf,
    retry: Arc<RemoteRetry>,
) -> Result<(), RemoteError> {
    let AuthenticatedLocal {
        stream: mut local,
        http: mut local_http,
        initial: mut initial_local,
    } = local;
    let snapshot = descriptor
        .lock()
        .map_err(|_| RemoteError::Local("remote descriptor lock is poisoned".into()))?
        .clone();
    // The node refused this app's pairing: admit no new tunnel (live feed, API
    // polling) until the owner acts, and record a refusal seen here first.
    // Both happen inside the serialized admission, so tunnels queued behind
    // the refused handshake answer 403 without dialing.
    // The request is already buffered. If its caller gives up while it waits
    // or while the tunnel is being set up, drop it instead of forwarding it
    // late. That cancels the dial and says nothing about the pairing.
    let connected = tokio::select! {
        biased;
        gone = caller_gone(&mut local, &mut local_http, &mut initial_local) => return gone,
        connected = tokio::time::timeout(
            REMOTE_CONNECT_DEADLINE,
            retry.run_unless_refused(|| connect_authenticated(&snapshot, &key, &client_name)),
        ) => connected.unwrap_or(Err(RemoteError::HandshakeUnavailable)),
    };
    let (remote, noise, client_id, scopes) = match connected {
        Ok(connection) => connection,
        Err(error) => {
            write_connection_error(&mut local, &error).await;
            return Err(error);
        }
    };
    if let Some(gone) = futures_util::FutureExt::now_or_never(caller_gone(&mut local, &mut local_http, &mut initial_local)) {
        return gone;
    }

    if noise.get_remote_static() != Some(&snapshot.transport_pubkey_bytes[..]) {
        write_proxy_error(&mut local, "503 Service Unavailable", "node_locked", "Node is locked after restart").await;
        return Ok(());
    }
    finalize_authenticated_pairing(
        &descriptor,
        &config_path,
        &pairing_store,
        &key,
        client_id,
        scopes,
    )?;
    // Established streams may close normally (HTTP keep-alive expiry or a
    // cancelled local consumer). Only failed connection/authentication attempts
    // incur the shared retry debt; the next handshake detects an actual outage.
    tunnel(local, remote, noise, local_http, initial_local).await
}

/// Process-local listener. Loopback alone is not process isolation, so every
/// accepted HTTP/WebSocket connection must present a memory-only credential
/// generated by this app process. Dropping or stopping the proxy closes the
/// listener and asks all accepted connection tasks to close.
pub struct RemoteProxy {
    descriptor: Arc<Mutex<RemoteDescriptor>>,
    local_addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    stopped: Option<tokio::sync::oneshot::Receiver<()>>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl RemoteProxy {
    /// Keep the listener and app credential while replacing the verified
    /// bootstrap pins after finalize. Existing tunnels die with the old node.
    pub fn finish_bootstrap(&self, descriptor: RemoteDescriptor) -> Result<(), RemoteError> {
        let mut current = self.descriptor.lock().unwrap();
        if current.box_transport_pubkey != descriptor.box_transport_pubkey
            || (!current.node_id.is_empty() && current.node_id != descriptor.node_id)
            || descriptor.node_id.is_empty() || descriptor.box_pin()?.is_none() {
            return Err(RemoteError::Invalid("cannot replace another box's proxy pins".into()));
        }
        *current = descriptor;
        Ok(())
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
    }

    /// Release the listener and every accepted socket before another proxy binds.
    pub async fn stop_and_wait(mut self) {
        self.stop();
        if let Some(stopped) = self.stopped.take() { let _ = stopped.await; }
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|error| error.clone())
    }
}

impl Drop for RemoteProxy {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Parse the configured API base and accept only an IP-literal loopback bind.
pub fn loopback_addr(api_base: &str) -> Result<SocketAddr, RemoteError> {
    let authority = api_base
        .strip_prefix("http://")
        .and_then(|value| value.strip_suffix("/api/v1"))
        .ok_or_else(|| {
            RemoteError::Local(
                "remote proxy API base must use loopback HTTP and the /api/v1 path".into(),
            )
        })?;
    let address: SocketAddr = authority
        .parse()
        .map_err(|_| RemoteError::Local("remote proxy API base has an invalid address".into()))?;
    if !address.ip().is_loopback() || address.port() == 0 {
        return Err(RemoteError::Local(
            "remote proxy refuses a non-loopback or zero-port API base".into(),
        ));
    }
    Ok(address)
}

/// Each HTTP connection occupies a Noise tunnel. Retain a bounded warm pool,
/// leaving one shared slot for the live WebSocket (the reserved media slot is
/// out of reach for HTTP anyway). Local connect stays bounded, while WAN
/// requests have time to complete without losing the tunnel.
pub fn http_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .pool_max_idle_per_host(MAX_LOCAL_CONNECTIONS - RESERVED_MEDIA_CONNECTIONS - 1)
        .pool_idle_timeout(Duration::from_secs(55))
        .timeout(Duration::from_secs(15))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
}

#[allow(clippy::too_many_arguments)]
pub async fn start_proxy(
    api_base: &str,
    app_data_dir: &Path,
    descriptor: RemoteDescriptor,
    key: Arc<ClientKey>,
    client_name: &str,
    pairing_store: PathBuf,
    local_auth: Arc<str>,
    retry: Arc<RemoteRetry>,
) -> Result<RemoteProxy, RemoteError> {
    let local_addr = loopback_addr(api_base)?;
    let listener = TcpListener::bind(local_addr)
        .await
        .map_err(|e| RemoteError::Local(format!("cannot bind remote loopback proxy: {e}")))?;
    let actual_addr = listener
        .local_addr()
        .map_err(|e| RemoteError::Local(format!("cannot inspect remote proxy address: {e}")))?;
    let descriptor = Arc::new(Mutex::new(descriptor));
    let config_path = config_path(app_data_dir);
    let client_name: Arc<str> = Arc::from(client_name);
    let (shutdown, mut stopped) = watch::channel(false);
    let (closed, closed_rx) = tokio::sync::oneshot::channel();
    // HTTP keep-alive and WebSocket connections each retain one remote
    // TCP/Noise tunnel. Independent byte streams are never interleaved; this
    // bounded set is the safe reusable pool without adding a mux wire protocol.
    let tunnel_permits = Arc::new(Semaphore::new(MAX_LOCAL_CONNECTIONS - RESERVED_MEDIA_CONNECTIONS));
    let media_permits = Arc::new(Semaphore::new(RESERVED_MEDIA_CONNECTIONS));
    let auth_permits = Arc::new(Semaphore::new(MAX_PENDING_LOCAL_AUTH));
    let last_error = Arc::new(Mutex::new(None));

    tokio::spawn({
        let descriptor = descriptor.clone();
        let key = key.clone();
        let last_error = last_error.clone();
        async move {
            let mut connections = tokio::task::JoinSet::new();
            let mut accept_backoff = Duration::from_millis(10);
            loop {
                tokio::select! {
                    biased;
                    _ = connections.join_next(), if !connections.is_empty() => {}
                    changed = stopped.changed() => {
                        if changed.is_err() || *stopped.borrow() {
                            break;
                        }
                    }
                    accepted = listener.accept() => {
                        let (mut stream, peer) = match accepted {
                            Ok(accepted) => {
                                accept_backoff = Duration::from_millis(10);
                                accepted
                            }
                            Err(error) => {
                                if let Ok(mut slot) = last_error.lock() {
                                    *slot = Some(format!("remote proxy accept failed: {error}"));
                                }
                                tokio::time::sleep(accept_backoff).await;
                                accept_backoff = (accept_backoff * 2).min(Duration::from_secs(1));
                                continue;
                            }
                        };
                        if !peer.ip().is_loopback() {
                            continue;
                        }
                        let Ok(auth_permit) = auth_permits.clone().try_acquire_owned() else {
                            write_proxy_error(
                                &mut stream,
                                "503 Service Unavailable",
                                "remote_proxy_auth_busy",
                                "remote proxy authentication limit reached",
                            )
                            .await;
                            continue;
                        };
                        let descriptor = descriptor.clone();
                        let config_path = config_path.clone();
                        let key = key.clone();
                        let client_name = client_name.clone();
                        let pairing_store = pairing_store.clone();
                        let local_auth = local_auth.clone();
                        let last_error = last_error.clone();
                        let tunnel_permits = tunnel_permits.clone();
                        let media_permits = media_permits.clone();
                        let retry = retry.clone();
                        let mut connection_stopped = stopped.clone();
                        connections.spawn(async move {
                            let (local_http, initial_local) =
                                match authenticated_prefix(&mut stream, &local_auth).await {
                                    Ok(prefix) => prefix,
                                    Err(error) => {
                                        write_proxy_error(
                                            &mut stream,
                                            "403 Forbidden",
                                            "remote_proxy_unauthorized",
                                            "remote proxy accepts authenticated app traffic only",
                                        )
                                        .await;
                                        drop(auth_permit);
                                        if !is_unauthenticated_local(&error) {
                                            if let Ok(mut slot) = last_error.lock() {
                                                *slot = Some(error.to_string());
                                            }
                                        }
                                        return;
                                    }
                                };
                            drop(auth_permit);
                            let reserved = if is_call_media_upgrade(&local_http, &initial_local) {
                                media_permits.try_acquire_owned().ok()
                            } else { None };
                            let Some(tunnel_permit) = reserved.or_else(|| tunnel_permits.try_acquire_owned().ok()) else {
                                write_proxy_error(
                                    &mut stream,
                                    "503 Service Unavailable",
                                    "remote_proxy_busy",
                                    "remote proxy connection limit reached",
                                )
                                .await;
                                return;
                            };
                            let _tunnel_permit = tunnel_permit;
                            tokio::select! {
                                _ = connection_stopped.changed() => {}
                                result = serve_connection(
                                    AuthenticatedLocal {
                                        stream,
                                        http: local_http,
                                        initial: initial_local,
                                    },
                                    descriptor,
                                    config_path,
                                    key,
                                    client_name,
                                    pairing_store,
                                    retry,
                                ) => {
                                    if let Err(error) = result {
                                        if !is_unauthenticated_local(&error) {
                                            if let Ok(mut slot) = last_error.lock() {
                                                *slot = Some(error.to_string());
                                            }
                                            // Never include descriptors, auth JSON, or codes.
                                            eprintln!("[remote] connection closed: {error}");
                                        }
                                    }
                                }
                            }
                        });
                    }
                }
            }
            drop(listener);
            connections.abort_all();
            while connections.join_next().await.is_some() {}
            let _ = closed.send(());
        }
    });

    Ok(RemoteProxy {
        descriptor,
        local_addr: actual_addr,
        shutdown,
        stopped: Some(closed_rx),
        last_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::net::IpAddr;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn u1_auth_fixture_is_accepted() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/home-node.json")).unwrap();
        let response = serde_json::from_value::<RemoteAuthResponse>(fixture["auth"].clone());
        assert!(response.is_ok(), "U1 auth response rejected: {response:?}");
    }

    fn test_code(byte: u8) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([byte; 32])
    }

    fn signed_link(
        endpoint: String,
        node: &SigningKey,
        transport_public: [u8; 32],
        code: &str,
    ) -> String {
        let node_id = hex::encode(node.verifying_key().as_bytes());
        let transport_pubkey = hex::encode(transport_public);
        let signature =
            node.sign(descriptor_signature_message(&node_id, &transport_pubkey).as_bytes());
        let payload = PairingLinkV1 {
            v: 1,
            endpoint,
            node_id,
            transport_pubkey,
            transport_signature: base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(signature.to_bytes()),
            code: code.to_string(),
            ..Default::default()
        };
        let json = serde_json::to_vec(&payload).unwrap();
        format!(
            "bitsov://pair/{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
        )
    }

    #[test]
    fn v1_identity_with_only_a_signed_box_pin_is_refused() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/remote-first-run-pr287.json"
        )).unwrap();
        let receipt = &fixture["finalize"];
        let mut value = serde_json::json!({
            "v": 1, "endpoint": "box.local:9737", "code": test_code(1),
            "node_id": receipt["node_id"],
            "box_transport_pubkey": receipt["box_transport_pubkey"],
            "box_transport_signature": receipt["box_transport_signature"],
        });
        let uri = |v: &serde_json::Value| format!("bitsov://pair/{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(v).unwrap()));
        for empty in [false, true] {
            if empty {
                value["transport_pubkey"] = "".into();
                value["transport_signature"] = "".into();
            }
            let error = parse_pairing_link(&uri(&value)).unwrap_err();
            assert!(error.to_string().contains("missing live transport proof"), "{error}");
        }
        value["transport_pubkey"] = receipt["transport_pubkey"].clone();
        value["transport_signature"] = receipt["transport_signature"].clone();
        assert!(parse_pairing_link(&uri(&value)).is_ok());
    }

    #[test]
    fn accepts_box_pinned_bootstrap_and_ordered_v2_descriptor() {
        let bootstrap = serde_json::json!({"v":2,"endpoint":"box.local:9737",
            "endpoints":["box.local:9737","192.168.1.2:9737"],
            "box_transport_pubkey":"22".repeat(32),"code":test_code(1)});
        let uri = |v: &serde_json::Value| format!("bitsov://pair/{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(v).unwrap()));
        assert!(parse_pairing_link(&uri(&bootstrap)).is_ok());
        let node = SigningKey::from_bytes(&[7;32]);
        let legacy = signed_link("box.local:9737".into(), &node, [9;32], &test_code(1));
        let mut value: serde_json::Value = serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(legacy.strip_prefix("bitsov://pair/").unwrap()).unwrap()).unwrap();
        value["v"] = 2.into();
        value["endpoints"] = bootstrap["endpoints"].clone();
        value["box_transport_pubkey"] = "22".repeat(32).into();
        let node_id = hex::encode(node.verifying_key().as_bytes());
        value["box_transport_signature"] = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(node.sign(format!("bitsov-box-transport-v1:{node_id}:{}", "22".repeat(32)).as_bytes()).to_bytes()).into();
        let message = serde_json::to_vec(&serde_json::json!(["bitsov-endpoints-v2",2,node_id,"09".repeat(32),"22".repeat(32),"box.local:9737",["box.local:9737","192.168.1.2:9737"]])).unwrap();
        value["endpoints_signature"] = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(node.sign(&message).to_bytes()).into();
        assert!(parse_pairing_link(&uri(&value)).is_ok());
        for field in ["endpoint", "transport_pubkey", "box_transport_pubkey", "node_id"] {
            let mut bad = value.clone(); bad[field] = "changed".into();
            assert!(parse_pairing_link(&uri(&bad)).is_err(), "{field}");
        }
        let mut bad = value.clone(); bad["endpoints"][1] = "attacker:9737".into();
        assert!(parse_pairing_link(&uri(&bad)).is_err());
        bad = value.clone(); bad["v"] = 1.into();
        assert!(parse_pairing_link(&uri(&bad)).is_err());
    }

    #[test]
    fn descriptor_verifies_signature_and_syntax() {
        let node = SigningKey::from_bytes(&[7u8; 32]);
        let transport = X25519PublicKey::from(&StaticSecret::from([9u8; 32])).to_bytes();
        let link = signed_link("node.example:4242".into(), &node, transport, &test_code(1));
        let descriptor = parse_pairing_link(&link).unwrap();
        assert_eq!(descriptor.endpoint(), "node.example:4242");
        assert!(descriptor.has_code());
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(link.strip_prefix("bitsov://pair/").unwrap())
            .unwrap();
        let json = std::str::from_utf8(&decoded).unwrap();
        assert!(json.contains("\"transport_pubkey\""));
        assert!(!json.contains("\"transport_key\""));

        let other = X25519PublicKey::from(&StaticSecret::from([10u8; 32])).to_bytes();
        let mut payload: PairingLinkV1 = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(link.strip_prefix("bitsov://pair/").unwrap())
                .unwrap(),
        )
        .unwrap();
        payload.transport_pubkey = hex::encode(other);
        let tampered = format!(
            "bitsov://pair/{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&payload).unwrap())
        );
        assert!(parse_pairing_link(&tampered).is_err());
        assert!(parse_pairing_link(&signed_link(
            "node.example:4242".into(),
            &node,
            transport,
            "not-base64!",
        ))
        .is_err());
        assert!(parse_pairing_link("https://node.example/pair").is_err());
    }

    const NOW: i64 = 1_800_000_000;

    /// A `konsensus pair-ticket` link (BitSov-bitsov #252): the legacy fields
    /// plus `extra`, which may also override or null a field.
    fn node_ticket(node: &SigningKey, extra: serde_json::Value) -> String {
        let transport = X25519PublicKey::from(&StaticSecret::from([9u8; 32])).to_bytes();
        let link = signed_link("node.example:4242".into(), node, transport, &test_code(3));
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let mut json: serde_json::Value =
            serde_json::from_slice(&engine.decode(link.strip_prefix("bitsov://pair/").unwrap()).unwrap()).unwrap();
        for (key, value) in extra.as_object().unwrap() {
            json[key] = value.clone();
        }
        format!("bitsov://pair/{}", engine.encode(serde_json::to_vec(&json).unwrap()))
    }

    fn box_proof(node: &SigningKey) -> (String, String) {
        let node_id = hex::encode(node.verifying_key().as_bytes());
        let key = hex::encode([0x33u8; 32]);
        let signature = node.sign(format!("bitsov-box-transport-v1:{node_id}:{key}").as_bytes());
        (key, base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }

    #[test]
    fn old_link_without_ticket_fields_still_imports() {
        let node = SigningKey::from_bytes(&[7u8; 32]);
        let link = node_ticket(&node, serde_json::json!({}));
        let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(link.strip_prefix("bitsov://pair/").unwrap())
            .unwrap();
        let mut keys: Vec<String> = serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&json)
            .unwrap()
            .keys()
            .cloned()
            .collect();
        keys.sort();
        assert_eq!(keys, ["code", "endpoint", "node_id", "transport_pubkey", "transport_signature", "v"]);

        let descriptor = parse_pairing_link_at(&link, NOW).unwrap();
        assert!(descriptor.has_code());
        assert_eq!(descriptor.hosted_by(), None);

        let data = tempfile::tempdir().unwrap();
        let view = import_pairing_link(data.path(), &link).unwrap();
        assert_eq!(view.hosted_by, None);
        let stored = std::fs::read_to_string(config_path(data.path())).unwrap();
        assert!(!stored.contains("hosted_by"), "{stored}");
        assert!(load_persisted(data.path()).unwrap().unwrap().has_code());
    }

    #[test]
    fn node_ticket_with_expiry_label_and_box_proof_imports() {
        let node = SigningKey::from_bytes(&[7u8; 32]);
        let (box_key, box_signature) = box_proof(&node);
        let ticket = |extra: serde_json::Value| {
            let mut fields = serde_json::json!({
                "box_transport_pubkey": box_key,
                "box_transport_signature": box_signature,
                "expires_at": NOW + 86_400,
                "hosted_by": "Alex's Pi",
            });
            for (key, value) in extra.as_object().unwrap() {
                fields[key] = value.clone();
            }
            node_ticket(&node, fields)
        };

        let descriptor = parse_pairing_link_at(&ticket(serde_json::json!({})), NOW).unwrap();
        assert_eq!(descriptor.hosted_by(), Some("Alex's Pi"));
        assert!(descriptor.has_code());
        // The node writes `null` when `[node].hosted_by` is unset.
        let unlabeled = parse_pairing_link_at(&ticket(serde_json::json!({ "hosted_by": null })), NOW).unwrap();
        assert_eq!(unlabeled.hosted_by(), None);

        // Fields the node does not send are still refused.
        let unknown = ticket(serde_json::json!({ "ticket_version": 2 }));
        assert!(matches!(parse_pairing_link_at(&unknown, NOW), Err(RemoteError::Invalid(_))));
        let other = SigningKey::from_bytes(&[8u8; 32]);
        let (_, foreign_signature) = box_proof(&other);
        let forged = ticket(serde_json::json!({ "box_transport_signature": foreign_signature }));
        assert!(matches!(parse_pairing_link_at(&forged, NOW), Err(RemoteError::Invalid(_))));
        let identityless = identityless_link(&node_ticket(&node, serde_json::json!({
            "node_id": null, "transport_pubkey": null, "transport_signature": null,
            "box_transport_pubkey": box_key, "expires_at": NOW + 60,
        })));
        assert!(parse_pairing_link_at(&identityless, NOW).is_ok());

        let data = tempfile::tempdir().unwrap();
        let live = ticket(serde_json::json!({ "expires_at": unix_now() + 86_400 }));
        let view = import_pairing_link(data.path(), &live).unwrap();
        assert_eq!(view.hosted_by.as_deref(), Some("Alex's Pi"));
        let reloaded = load_persisted(data.path()).unwrap().unwrap();
        assert_eq!(reloaded.hosted_by(), Some("Alex's Pi"));
        assert!(reloaded.has_code());
    }

    /// Drop the identity fields entirely, as `pair-ticket` does before first unlock.
    fn identityless_link(link: &str) -> String {
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let mut json: serde_json::Map<String, serde_json::Value> =
            serde_json::from_slice(&engine.decode(link.strip_prefix("bitsov://pair/").unwrap()).unwrap()).unwrap();
        json.retain(|_, value| !value.is_null());
        format!("bitsov://pair/{}", engine.encode(serde_json::to_vec(&json).unwrap()))
    }

    #[test]
    fn expired_ticket_is_refused_with_a_clear_message() {
        let node = SigningKey::from_bytes(&[7u8; 32]);
        let at = |expires_at: i64| node_ticket(&node, serde_json::json!({ "expires_at": expires_at }));

        let error = parse_pairing_link_at(&at(NOW - 7_200), NOW).unwrap_err();
        assert!(matches!(error, RemoteError::Expired(7_200)));
        let message = error.to_string();
        assert!(message.starts_with("This pairing link expired 2 h ago."), "{message}");
        assert!(message.contains("konsensus pair-ticket"), "{message}");
        assert!(matches!(parse_pairing_link_at(&at(NOW), NOW), Err(RemoteError::Expired(0))));
        assert!(matches!(parse_pairing_link_at(&at(-1), NOW), Err(RemoteError::Invalid(_))));
        assert!(parse_pairing_link_at(&at(NOW + 1), NOW).is_ok());
        // Zero is the node's marker for a legacy link without an expiry.
        assert!(parse_pairing_link_at(&at(0), NOW).is_ok());

        let data = tempfile::tempdir().unwrap();
        assert!(matches!(import_pairing_link(data.path(), &at(unix_now() - 1)), Err(RemoteError::Expired(_))));
        assert!(!config_path(data.path()).exists());
    }

    #[test]
    fn owner_and_second_device_ticket_imports_allow_only_thirty_seconds_of_clock_skew() {
        let node = SigningKey::from_bytes(&[7u8; 32]);
        for prefix in ["owner_", "second_"] {
            let code = if prefix == "owner_" { "ab".repeat(32) }
                else { base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0xab;32]) };
            let at = |expires_at| node_ticket(&node, serde_json::json!({
                "code": format!("{prefix}{code}"), "expires_at": expires_at
            }));
            for (expiry, accepted) in [(NOW - 30, false), (NOW - 29, true),
                (NOW, true), (NOW + 270, true), (NOW + 300, true), (NOW + 330, true)] {
                assert_eq!(parse_pairing_link_at(&at(expiry), NOW).is_ok(), accepted, "{prefix} {expiry}");
            }
            let data = tempfile::tempdir().unwrap();
            assert!(import_pairing_link(data.path(), &at(unix_now() - 20)).is_ok());
        }
    }

    #[test]
    fn preview_only_skips_comparison_for_owner_approved_second_device_tickets() {
        let node = SigningKey::from_bytes(&[7u8; 32]);
        for (code, second) in [
            (format!("second_{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0xab;32])), true),
            (format!("owner_{}", "ab".repeat(32)), false),
            (base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0xab;32]), false),
        ] {
            let link = node_ticket(&node, serde_json::json!({"code":code, "expires_at": 0}));
            let view = serde_json::to_value(preview_pairing_link(&link).unwrap()).unwrap();
            assert_eq!(view["second_device"].as_bool(), Some(second));
        }
    }

    #[test]
    fn saved_phone_setup_includes_unredeemed_tickets_but_not_an_ordinary_pairing() {
        let node = SigningKey::from_bytes(&[7u8; 32]);
        for (code, pending) in [
            (format!("second_{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0xab;32])), true),
            (format!("owner_{}", "ab".repeat(32)), true),
            (base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0xab;32]), false),
        ] {
            let link = node_ticket(&node, serde_json::json!({"code":code}));
            let descriptor = parse_pairing_link_at(&link, NOW).unwrap();
            assert_eq!(descriptor.pending_phone_enrollment(), pending);
        }
    }

    #[test]
    fn hosted_by_label_is_capped_and_odd_labels_are_not_shown() {
        let node = SigningKey::from_bytes(&[7u8; 32]);
        let label = |hosted_by: &str| {
            parse_pairing_link_at(&node_ticket(&node, serde_json::json!({ "hosted_by": hosted_by })), NOW)
                .unwrap()
                .hosted_by()
                .map(str::to_owned)
        };

        let long = label(&"x".repeat(500)).unwrap();
        assert_eq!(long.chars().count(), HOSTED_BY_MAX_CHARS);
        assert!(long.ends_with('…'));
        assert_eq!(label(&format!("{} tail", "y".repeat(62))).unwrap(), format!("{}…", "y".repeat(62)));
        // The node's own longest label is kept whole.
        assert_eq!(label(&"𝔅".repeat(64)).as_deref(), Some("𝔅".repeat(64).as_str()));
        assert_eq!(label("  My Pi  ").as_deref(), Some("My Pi"));
        // Markup stays literal; the renderer shows it as text.
        assert_eq!(label("<img src=x onerror=alert(1)>").as_deref(), Some("<img src=x onerror=alert(1)>"));
        for odd in ["Pi\u{202E}kcab", "Alex\u{7}Pi", "line\nbreak", "zero\u{200B}width", "\u{2066}Pi", "   ", ""] {
            assert_eq!(label(odd), None, "{odd:?}");
        }

        // A hand-edited descriptor gets the same treatment on load.
        let data = tempfile::tempdir().unwrap();
        import_pairing_link(data.path(), &node_ticket(&node, serde_json::json!({}))).unwrap();
        let path = config_path(data.path());
        let mut stored: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        stored["hosted_by"] = "Pi\u{202E}kcab".into();
        std::fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
        assert_eq!(load_persisted(data.path()).unwrap().unwrap().hosted_by(), None);
        stored["hosted_by"] = "z".repeat(100).into();
        std::fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
        let reloaded = load_persisted(data.path()).unwrap().unwrap();
        assert_eq!(reloaded.hosted_by().unwrap().chars().count(), HOSTED_BY_MAX_CHARS);
    }

    #[test]
    fn forgetting_remote_is_idempotent_and_preserves_local_data() {
        let dir = tempfile::tempdir().unwrap();
        let node = SigningKey::from_bytes(&[11u8; 32]);
        let transport = X25519PublicKey::from(&StaticSecret::from([12u8; 32])).to_bytes();
        import_pairing_link(dir.path(), &signed_link("127.0.0.1:4242".into(), &node, transport, &test_code(2))).unwrap();
        let local = dir.path().join("mnemonic.txt");
        std::fs::write(&local, "local identity untouched").unwrap();
        forget_persisted(dir.path()).unwrap();
        assert!(load_persisted(dir.path()).unwrap().is_none());
        forget_persisted(dir.path()).unwrap();
        assert_eq!(std::fs::read_to_string(local).unwrap(), "local identity untouched");
    }

    fn link_for(seed: u8) -> String {
        let node = SigningKey::from_bytes(&[seed; 32]);
        let transport = X25519PublicKey::from(&StaticSecret::from([seed.wrapping_add(1); 32])).to_bytes();
        signed_link("127.0.0.1:4242".into(), &node, transport, &test_code(seed))
    }

    #[test]
    fn same_node_check_compares_pinned_identities() {
        let a = parse_pairing_link(&link_for(21)).unwrap();
        let b = parse_pairing_link(&link_for(31)).unwrap();
        assert!(!replaces_another_node(&a, &a.clone()));
        assert!(replaces_another_node(&a, &b));
    }

    #[test]
    fn forgetting_remote_reports_removal_errors() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(config_path(dir.path())).unwrap();
        assert!(forget_persisted(dir.path()).is_err());
    }

    #[test]
    fn local_reset_waits_for_local_startup_and_preserves_the_client_key() {
        let dir = tempfile::tempdir().unwrap();
        let node = SigningKey::from_bytes(&[11u8; 32]);
        let transport = X25519PublicKey::from(&StaticSecret::from([12u8; 32])).to_bytes();
        let link = signed_link("127.0.0.1:4242".into(), &node, transport, &test_code(2));
        let store = dir.path().join("app-client");
        let key = ClientKey::load_or_create(&store).unwrap();
        let key_bytes = std::fs::read(store.join(pairing::KEY_FILE)).unwrap();
        pairing::save_remote_record(&store, &key,
            "0123456789abcdef0123456789abcdef".into(), vec!["read".into()]).unwrap();
        let record = store.join(pairing::RECORD_FILE);
        prepare_local_pairing(dir.path(), &store).unwrap();
        assert!(record.exists(), "normal startup preserves its pairing");
        import_pairing_link(dir.path(), &link).unwrap();
        forget_persisted(dir.path()).unwrap();
        assert!(record.exists(), "live session keeps its record");
        import_pairing_link(dir.path(), &link).unwrap();
        prepare_local_pairing(dir.path(), &store).unwrap();
        assert!(record.exists(), "a newer remote choice takes precedence");
        forget_persisted(dir.path()).unwrap();
        prepare_local_pairing(dir.path(), &store).unwrap();
        assert!(!record.exists());
        assert_eq!(std::fs::read(store.join(pairing::KEY_FILE)).unwrap(), key_bytes);
        // Consuming the marker is one-time: a later local pairing survives.
        std::fs::write(&record, "new local record").unwrap();
        prepare_local_pairing(dir.path(), &store).unwrap();
        assert_eq!(std::fs::read_to_string(record).unwrap(), "new local record");
    }

    #[test]
    fn in_flight_auth_cannot_restore_a_forgotten_descriptor() {
        let dir = tempfile::tempdir().unwrap();
        let node = SigningKey::from_bytes(&[11u8; 32]);
        let transport = X25519PublicKey::from(&StaticSecret::from([12u8; 32])).to_bytes();
        import_pairing_link(dir.path(), &signed_link("127.0.0.1:4242".into(), &node, transport, &test_code(2))).unwrap();
        let descriptor = Mutex::new(load_persisted(dir.path()).unwrap().unwrap());
        let store = dir.path().join("pairing-client");
        let key = ClientKey::load_or_create(&store).unwrap();
        forget_persisted(dir.path()).unwrap();
        finalize_authenticated_pairing(&descriptor, &config_path(dir.path()), &store, &key, "client".into(), vec!["read".into()]).unwrap_err();
        assert!(load_persisted(dir.path()).unwrap().is_none());
    }

    #[test]
    #[cfg(unix)]
    fn persistence_is_owner_only_and_code_is_stripped() {
        let dir = tempfile::tempdir().unwrap();
        let node = SigningKey::from_bytes(&[11u8; 32]);
        let transport = X25519PublicKey::from(&StaticSecret::from([12u8; 32])).to_bytes();
        let code = test_code(2);
        let link = signed_link("127.0.0.1:4242".into(), &node, transport, &code);
        import_pairing_link(dir.path(), &link).unwrap();
        let path = config_path(dir.path());
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let mut descriptor = load_persisted(dir.path()).unwrap().unwrap();
        assert!(descriptor.has_code());
        descriptor.code = None;
        persist_at(&path, &descriptor).unwrap();
        let text = std::fs::read_to_string(path).unwrap();
        assert!(!text.contains(&code));
        assert!(!text.contains("\"code\""));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    mod linux_candidate_tests {
        include!("remote_access/linux_candidate_tests.rs");
    }

    fn sealed_fixture(seed: u8) -> (tempfile::TempDir, PathBuf, RemoteDescriptor, String) {
        let dir = tempfile::tempdir().unwrap();
        let node = SigningKey::from_bytes(&[seed; 32]);
        let transport = X25519PublicKey::from(&StaticSecret::from([seed + 1; 32])).to_bytes();
        let code = test_code(seed);
        let link = signed_link("127.0.0.1:4242".into(), &node, transport, &code);
        let path = config_path(dir.path());
        (dir, path, parse_pairing_link(&link).unwrap(), code)
    }

    #[cfg(windows)]
    #[test]
    fn windows_descriptor_round_trips_and_tampering_is_refused() {
        use crate::at_rest::test_sealer::MemorySealer;
        use crate::private_fs::fixtures::*;
        if elevated() {
            return;
        }
        let (dir, path, descriptor, code) = sealed_fixture(41);
        persist_with(&path, &descriptor, Some(&MemorySealer)).unwrap();
        persist_with(&path, &descriptor, Some(&MemorySealer)).unwrap();
        let loaded = load_with(&path, Some(&MemorySealer)).unwrap().unwrap();
        assert_eq!(loaded.code.as_deref(), Some(code.as_str()));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(&code) && text.contains("sealed_code"), "{text}");
        // The reset marker is a private object too.
        forget_persisted(dir.path()).unwrap();
        let reset = path.parent().unwrap().join(LOCAL_PAIRING_RESET);
        crate::private_fs::verify_file(&reset).unwrap();
        persist_with(&path, &descriptor, Some(&MemorySealer)).unwrap();
        // Extra access entry: refused for reading and replacing, bytes kept.
        let bytes = std::fs::read(&path).unwrap();
        grant_everyone_read(&path);
        assert!(load_with(&path, Some(&MemorySealer)).is_err());
        assert!(persist_with(&path, &descriptor, Some(&MemorySealer)).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        // A leftover scratch file is refused, not reused or deleted.
        let (_dir2, path2, descriptor2, _) = sealed_fixture(43);
        persist_with(&path2, &descriptor2, Some(&MemorySealer)).unwrap();
        let scratch = path2.with_file_name(format!("{REMOTE_CONFIG_FILE}.tmp"));
        std::fs::write(&scratch, b"leftover").unwrap();
        assert!(persist_with(&path2, &descriptor2, Some(&MemorySealer)).is_err());
        assert_eq!(std::fs::read(&scratch).unwrap(), b"leftover");
        // Reparse point at the descriptor folder.
        let (dir3, path3, descriptor3, _) = sealed_fixture(45);
        let target = dir3.path().join("elsewhere");
        std::fs::create_dir(&target).unwrap();
        junction(path3.parent().unwrap(), &target);
        assert!(persist_with(&path3, &descriptor3, Some(&MemorySealer)).is_err());
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
        // Wrong owner.
        let foreign = foreign_owned_dir().join(REMOTE_CONFIG_FILE);
        assert!(persist_with(&foreign, &descriptor3, Some(&MemorySealer)).is_err());
    }

    #[test]
    fn a_sealer_keeps_the_pairing_code_out_of_the_descriptor_file() {
        use crate::at_rest::test_sealer::MemorySealer;
        let (_dir, path, descriptor, code) = sealed_fixture(31);
        persist_with(&path, &descriptor, Some(&MemorySealer)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(&code), "{text}");
        assert!(!text.contains("\"code\""), "{text}");
        assert!(text.contains("\"sealed_code\""), "{text}");
        assert!(text.contains(&descriptor.transport_pubkey), "public pins stay readable");

        let loaded = load_with(&path, Some(&MemorySealer)).unwrap().unwrap();
        assert_eq!(loaded.code.as_deref(), Some(code.as_str()));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text, "no rewrite once sealed");
        assert!(
            load_with(&path, None).is_err(),
            "a sealed code never falls back to a plaintext read"
        );

        let mut stripped = loaded;
        stripped.code = None;
        persist_with(&path, &stripped, Some(&MemorySealer)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("\"code\"") && !text.contains("sealed_code"), "{text}");
    }

    #[test]
    fn save_enforces_the_load_limit_after_sealing_without_replacing_the_old_file() {
        use crate::at_rest::test_sealer::MemorySealer;
        let (_dir, path, mut descriptor, _) = sealed_fixture(39);
        persist_with(&path, &descriptor, Some(&MemorySealer)).unwrap();
        let original = std::fs::read(&path).unwrap();
        // Sealing plus base64 expands a plaintext descriptor that fits at import.
        let overhead = stored_bytes(&descriptor, Some(&MemorySealer)).unwrap().len();
        descriptor.hosted_by = Some("x".repeat(8192 - overhead - ",\"hosted_by\":\"\"".len()));
        assert!(stored_bytes(&descriptor, None).unwrap().len() < 8192);
        assert_eq!(stored_bytes(&descriptor, Some(&MemorySealer)).unwrap().len(), 8192);
        persist_with(&path, &descriptor, Some(&MemorySealer)).unwrap();
        assert!(load_with(&path, Some(&MemorySealer)).is_ok());
        let boundary = std::fs::read(&path).unwrap();
        descriptor.hosted_by.as_mut().unwrap().push('x');
        assert!(stored_bytes(&descriptor, None).unwrap().len() < 8192);
        let error = persist_with(&path, &descriptor, Some(&MemorySealer)).unwrap_err();
        assert!(error.to_string().contains("oversized"));
        assert_eq!(std::fs::read(&path).unwrap(), boundary);
        assert!(!path.with_file_name(format!("{REMOTE_CONFIG_FILE}.tmp")).exists());
        std::fs::remove_file(&path).unwrap();
        assert!(persist_with(&path, &descriptor, Some(&MemorySealer)).is_err());
        assert!(!path.exists());
        assert_ne!(original, boundary);
    }

    #[test]
    #[cfg(unix)]
    fn a_plaintext_pending_code_is_sealed_once_on_load() {
        use crate::at_rest::test_sealer::MemorySealer;
        let (_dir, path, descriptor, code) = sealed_fixture(41);
        persist_with(&path, &descriptor, None).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains(&code));

        let loaded = load_with(&path, Some(&MemorySealer)).unwrap().unwrap();
        assert_eq!(loaded.code.as_deref(), Some(code.as_str()));
        let migrated = std::fs::read_to_string(&path).unwrap();
        assert!(!migrated.contains(&code), "{migrated}");
        assert!(migrated.contains("\"sealed_code\""), "{migrated}");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, [REMOTE_CONFIG_FILE], "only the migrated descriptor remains");

        load_with(&path, Some(&MemorySealer)).unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), migrated, "migration runs once");
    }

    #[test]
    fn failed_optional_code_migration_preserves_plaintext_but_never_downgrades_sealed_code() {
        use crate::at_rest::test_sealer::MemorySealer;
        struct FailingMigration { fail_seal: bool, fallback: bool }
        impl Sealer for FailingMigration {
            fn allows_plaintext_fallback(&self) -> bool { self.fallback }
            fn seal(&self, purpose: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
                if self.fail_seal { Err("Secure Enclave unavailable".into()) }
                else { MemorySealer.seal(purpose, plain) }
            }
            fn open(&self, _: &str, _: &[u8]) -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
                Err("cannot open on this Mac".into())
            }
        }
        for fail_seal in [true, false] {
            let (_dir, path, descriptor, code) = sealed_fixture(51);
            persist_with(&path, &descriptor, None).unwrap();
            let original = std::fs::read(&path).unwrap();
            let optional = FailingMigration { fail_seal, fallback: true };
            let loaded = load_with(&path, Some(&optional)).unwrap().unwrap();
            assert_eq!(loaded.code.as_deref(), Some(code.as_str()));
            assert_eq!(std::fs::read(&path).unwrap(), original);
            let strict = FailingMigration { fail_seal, fallback: false };
            assert!(load_with(&path, Some(&strict)).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), original);

            persist_with(&path, &descriptor, Some(&MemorySealer)).unwrap();
            let sealed = std::fs::read(&path).unwrap();
            assert!(load_with(&path, Some(&optional)).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), sealed);
        }
    }

    /// A Mac without an enclave: a native call here would be a bug.
    struct NoEnclaveSealer;
    impl Sealer for NoEnclaveSealer {
        fn seal(&self, _: &str, _: &[u8]) -> Result<Vec<u8>, String> { panic!("seal called without an enclave") }
        fn open(&self, _: &str, _: &[u8]) -> Result<zeroize::Zeroizing<Vec<u8>>, String> { panic!("open called without an enclave") }
        fn hardware_available(&self) -> bool { false }
    }
    /// The same Mac, as the native bridge answers if it is asked anyway.
    struct NoEnclaveBridge;
    impl Sealer for NoEnclaveBridge {
        fn seal(&self, _: &str, _: &[u8]) -> Result<Vec<u8>, String> { Err("no Secure Enclave".into()) }
        fn open(&self, _: &str, _: &[u8]) -> Result<zeroize::Zeroizing<Vec<u8>>, String> { Err("no Secure Enclave".into()) }
        fn hardware_available(&self) -> bool { false }
    }

    #[test]
    fn persisting_a_pairing_code_without_enclave_refuses_and_writes_nothing() {
        let (dir, path, descriptor, code) = sealed_fixture(61);
        assert!(descriptor.code.is_some());
        let error = persist_with(&path, &descriptor, Some(&NoEnclaveSealer)).unwrap_err();
        assert!(matches!(error, RemoteError::SecureStorageUnavailable { identity_kept: false }), "{error}");
        assert!(!error.to_string().contains("try again"), "{error}");
        assert!(!error.to_string().contains(&code));
        assert!(!path.exists());
        assert!(!path.with_file_name(format!("{REMOTE_CONFIG_FILE}.tmp")).exists());
        assert!(!dir.path().join(REMOTE_CONFIG_DIR).exists(), "no directory or file was created");
    }

    #[test]
    fn plaintext_code_migration_without_enclave_keeps_file_and_refuses() {
        let (_dir, path, descriptor, _) = sealed_fixture(63);
        persist_with(&path, &descriptor, None).unwrap();
        let original = std::fs::read(&path).unwrap();
        // The saved pairing is untouched, so the refusal says it was kept, never "nothing was saved".
        let error = load_with(&path, Some(&NoEnclaveBridge)).unwrap_err();
        assert!(matches!(error, RemoteError::SecureStorageUnavailable { identity_kept: true }), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert!(!path.with_file_name(format!("{REMOTE_CONFIG_FILE}.tmp")).exists());
    }

    #[test]
    fn sealed_code_without_enclave_is_refused_not_rewritten() {
        use crate::at_rest::test_sealer::MemorySealer;
        let (_dir, path, descriptor, _) = sealed_fixture(65);
        persist_with(&path, &descriptor, Some(&MemorySealer)).unwrap();
        let sealed = std::fs::read(&path).unwrap();
        assert!(load_with(&path, Some(&NoEnclaveBridge)).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), sealed);
        assert!(load_with(&path, None).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), sealed);
    }

    #[test]
    fn import_view_exposes_only_a_short_node_id_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let node = SigningKey::from_bytes(&[13u8; 32]);
        let node_id = hex::encode(node.verifying_key().as_bytes());
        let transport = X25519PublicKey::from(&StaticSecret::from([14u8; 32])).to_bytes();
        let view = import_pairing_link(
            dir.path(),
            &signed_link("127.0.0.1:4242".into(), &node, transport, &test_code(7)),
        )
        .unwrap();
        assert_eq!(
            view.node_id_fingerprint,
            format!("{}…{}", &node_id[..8], &node_id[node_id.len() - 8..])
        );
        assert_ne!(view.node_id_fingerprint, node_id);
    }

    #[test]
    fn successful_auth_removes_code_before_pairing_record_failure() {
        let app_dir = tempfile::tempdir().unwrap();
        let key_dir = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(key_dir.path()).unwrap();
        let node = SigningKey::from_bytes(&[15u8; 32]);
        let transport = X25519PublicKey::from(&StaticSecret::from([16u8; 32])).to_bytes();
        import_pairing_link(
            app_dir.path(),
            &signed_link("127.0.0.1:4242".into(), &node, transport, &test_code(8)),
        )
        .unwrap();
        let descriptor = Mutex::new(load_persisted(app_dir.path()).unwrap().unwrap());
        let invalid_store = app_dir.path().join("not-a-directory");
        std::fs::write(&invalid_store, b"file").unwrap();

        let error = finalize_authenticated_pairing(
            &descriptor,
            &config_path(app_dir.path()),
            &invalid_store,
            &key,
            "0123456789abcdef0123456789abcdef".into(),
            vec!["read".into()],
        )
        .unwrap_err();
        assert!(error.to_string().contains("cannot create"));
        let persisted = std::fs::read_to_string(config_path(app_dir.path())).unwrap();
        assert!(!persisted.contains("\"code\""));
        assert!(!descriptor.lock().unwrap().has_code());
    }

    #[test]
    #[cfg(unix)]
    fn returning_auth_validates_existing_record_without_rewriting_it() {
        let app_dir = tempfile::tempdir().unwrap();
        let pairing_store = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(pairing_store.path()).unwrap();
        let node = SigningKey::from_bytes(&[17u8; 32]);
        let transport = X25519PublicKey::from(&StaticSecret::from([18u8; 32])).to_bytes();
        import_pairing_link(
            app_dir.path(),
            &signed_link("127.0.0.1:4242".into(), &node, transport, &test_code(9)),
        )
        .unwrap();
        let descriptor = Mutex::new(load_persisted(app_dir.path()).unwrap().unwrap());
        finalize_authenticated_pairing(
            &descriptor,
            &config_path(app_dir.path()),
            pairing_store.path(),
            &key,
            "0123456789abcdef0123456789abcdef".into(),
            vec!["read".into()],
        )
        .unwrap();

        std::fs::set_permissions(pairing_store.path(), std::fs::Permissions::from_mode(0o500))
            .unwrap();
        let result = finalize_authenticated_pairing(
            &descriptor,
            &config_path(app_dir.path()),
            pairing_store.path(),
            &key,
            "0123456789abcdef0123456789abcdef".into(),
            vec!["read".into()],
        );
        std::fs::set_permissions(pairing_store.path(), std::fs::Permissions::from_mode(0o700))
            .unwrap();
        result.unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn derived_key_is_stable_and_not_the_ed25519_seed() {
        let a_dir = tempfile::tempdir().unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        std::fs::write(
            a_dir.path().join(crate::pairing::KEY_FILE),
            hex::encode([21u8; 32]),
        )
        .unwrap();
        std::fs::write(
            b_dir.path().join(crate::pairing::KEY_FILE),
            hex::encode([22u8; 32]),
        )
        .unwrap();
        std::fs::set_permissions(
            a_dir.path().join(crate::pairing::KEY_FILE),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        std::fs::set_permissions(
            b_dir.path().join(crate::pairing::KEY_FILE),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let a = ClientKey::load_or_create(a_dir.path()).unwrap();
        let b = ClientKey::load_or_create(b_dir.path()).unwrap();
        assert_eq!(
            client_transport_public_key(&a),
            client_transport_public_key(&a)
        );
        assert_ne!(
            client_transport_public_key(&a),
            client_transport_public_key(&b)
        );
        assert_ne!(derived_transport_key(&a).0, [21u8; 32]);
    }

    #[test]
    fn auth_json_and_proofs_match_the_node_contract_exactly() {
        let node = SigningKey::from_bytes(&[25u8; 32]);
        let node_transport = X25519PublicKey::from(&StaticSecret::from([26u8; 32])).to_bytes();
        let code = test_code(3);
        let link = signed_link("node.example:4242".into(), &node, node_transport, &code);
        let mut descriptor = parse_pairing_link(&link).unwrap();
        let key_dir = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(key_dir.path()).unwrap();
        let request = auth_request(&descriptor, &key, "BitSov app");
        let json = serde_json::to_value(&request).unwrap();
        let object = json.as_object().unwrap();
        assert_eq!(
            object
                .keys()
                .map(String::as_str)
                .collect::<std::collections::BTreeSet<_>>(),
            ["client_name", "client_pubkey", "code", "signature", "v"]
                .into_iter()
                .collect()
        );
        assert!(!object.contains_key("client_transport_key"));

        let client_transport = hex::encode(client_transport_public_key(&key));
        let expected = format!(
            "bitsov-remote-pair-v1:{}:{client_transport}:{code}:{}",
            descriptor.node_id(),
            key.public_hex()
        );
        assert_eq!(
            auth_proof_message(
                descriptor.node_id(),
                &client_transport,
                &code,
                key.public_hex()
            ),
            expected
        );
        let signature: [u8; 64] = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(request.signature.as_deref().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let public: [u8; 32] = hex::decode(key.public_hex()).unwrap().try_into().unwrap();
        VerifyingKey::from_bytes(&public)
            .unwrap()
            .verify_strict(expected.as_bytes(), &Signature::from_bytes(&signature))
            .unwrap();

        descriptor.code = None;
        assert_eq!(
            serde_json::to_string(&auth_request(&descriptor, &key, "ignored")).unwrap(),
            r#"{"v":1}"#
        );

        let ok = r#"{"status":"ok","v":1,"client_id":"0123456789abcdef0123456789abcdef","scopes":["read","receive"]}"#;
        assert_eq!(
            serde_json::to_string(&serde_json::from_str::<RemoteAuthResponse>(ok).unwrap())
                .unwrap(),
            ok
        );
        let error = r#"{"status":"error","v":1,"code":"authentication_failed","message":"denied"}"#;
        assert_eq!(
            serde_json::to_string(&serde_json::from_str::<RemoteAuthResponse>(error).unwrap())
                .unwrap(),
            error
        );
        assert!(serde_json::from_str::<RemoteAuthResponse>(
            r#"{"v":1,"ok":true,"client_id":"abcd","scopes":[]}"#
        )
        .is_err());
    }

    #[test]
    fn ticket_refusals_become_used_or_expired_for_every_ticket_kind() {
        // Reasons the node sends with authentication_failed (konsensus-node remote_access).
        let used = [
            "first-pairing code is unavailable or already used",
            "second-device ticket unavailable or already used",
            "pairing request is unknown, already used, or expired",
            "pairing code did not match",
            "remote pairing proof did not verify",
            "remote pairing key does not match the existing transport binding",
        ];
        let expired = ["first-pairing code expired", "second-device ticket invalid or expired", "operation expired"];
        for ticket in [None, Some("legacy0123"), Some("owner_abc"), Some("second_abc")] {
            for reason in used {
                assert_eq!(ticket_refusal("authentication_failed", reason, ticket), Some(USED_TICKET_MESSAGE), "{reason}");
            }
            for reason in expired {
                assert_eq!(ticket_refusal("authentication_failed", reason, ticket), Some(EXPIRED_TICKET_MESSAGE), "{reason}");
            }
            assert_eq!(ticket_refusal("box_locked", "first-pairing code expired", ticket), None);
        }
        // Any other refusal of a single-use owner or second-device ticket still means used.
        assert_eq!(ticket_refusal("authentication_failed", "denied", Some("owner_x")), Some(USED_TICKET_MESSAGE));
        assert_eq!(ticket_refusal("authentication_failed", "denied", Some("legacy")), None);
        let used = ConnectionError::from(&RemoteError::Refused(USED_TICKET_MESSAGE.into()));
        assert_eq!((used.kind, used.detail.as_str()), (ConnectionErrorKind::Used, USED_TICKET_MESSAGE));
        let expired = ConnectionError::from(&RemoteError::Refused(EXPIRED_TICKET_MESSAGE.into()));
        assert_eq!(expired.kind, ConnectionErrorKind::Expired);
        // Unknown peer text never reaches the renderer.
        let other = ConnectionError::from(&RemoteError::Refused("authentication_failed: secret".into()));
        assert_eq!((other.kind, other.detail.as_str()), (ConnectionErrorKind::Other, CONNECTION_FAILED_CODE));
    }

    #[test]
    fn diagnostics_are_codes_and_a_missing_passcode_has_its_own_kind() {
        for error in [RemoteError::HandshakeUnavailable, RemoteError::Waiting(3), RemoteError::Transport("x".into())] {
            let mapped = ConnectionError::from(&error);
            assert_eq!((mapped.kind, mapped.detail.as_str()), (ConnectionErrorKind::Unreachable, UNREACHABLE_CODE));
        }
        for error in [RemoteError::DeviceUnavailable,
                      RemoteError::Local(PASSCODE_REQUIRED.into())] {
            let mapped = ConnectionError::from(&error);
            assert_eq!((mapped.kind, mapped.detail.as_str()), (ConnectionErrorKind::DeviceUnavailable, PASSCODE_REQUIRED_CODE));
        }
        assert_eq!(serde_json::to_value(ConnectionErrorKind::DeviceUnavailable).unwrap(), "device_unavailable");
        // The bridge's text and this copy must stay identical (no bridge on Android).
        #[cfg(not(target_os = "android"))]
        assert_eq!(bitsov_ffi::keychain_status::PASSCODE_REQUIRED, PASSCODE_REQUIRED);
        assert_eq!(ConnectionError::from(&RemoteError::Local("other".into())).kind, ConnectionErrorKind::Other);
    }

    #[test]
    fn secure_storage_unavailable_maps_to_its_own_connection_kind() {
        for (identity_kept, code) in [(false, SECURE_STORAGE_UNAVAILABLE_CODE), (true, SECURE_STORAGE_KEPT_CODE)] {
            let mapped = ConnectionError::from(&RemoteError::SecureStorageUnavailable { identity_kept });
            assert_eq!((mapped.kind, mapped.detail.as_str()), (ConnectionErrorKind::SecureStorageUnavailable, code));
            assert_ne!(mapped.kind, ConnectionErrorKind::DeviceUnavailable);
            assert_ne!(mapped.detail, PASSCODE_REQUIRED_CODE);
        }
        assert_eq!(SECURE_STORAGE_UNAVAILABLE_CODE, "secure_storage_unavailable");
        assert_eq!(serde_json::to_value(ConnectionErrorKind::SecureStorageUnavailable).unwrap(), "secure_storage_unavailable");
        let text = RemoteError::SecureStorageUnavailable { identity_kept: true }.to_string();
        assert!(text.contains("Secure Enclave") && text.contains("kept"), "{text}");
        assert!(!text.contains("try again") && !text.to_lowercase().contains("clear"), "{text}");
        #[cfg(not(target_os = "android"))]
        assert_eq!(bitsov_ffi::keychain_status::NO_SECURE_ENCLAVE, NO_SECURE_ENCLAVE);
    }

    fn transport_pair() -> (TransportState, TransportState) {
        let params: snow::params::NoiseParams = NOISE_PROTOCOL.parse().unwrap();
        let initiator_secret = [41u8; 32];
        let responder_secret = [42u8; 32];
        let mut initiator = Builder::new(params.clone())
            .local_private_key(&initiator_secret)
            .and_then(|b| b.build_initiator())
            .unwrap();
        let mut responder = Builder::new(params)
            .local_private_key(&responder_secret)
            .and_then(|b| b.build_responder())
            .unwrap();
        let mut message = vec![0u8; MAX_HANDSHAKE_FRAME];
        let mut plaintext = vec![0u8; MAX_HANDSHAKE_FRAME];
        let length = initiator.write_message(&[], &mut message).unwrap();
        responder
            .read_message(&message[..length], &mut plaintext)
            .unwrap();
        let length = responder.write_message(&[], &mut message).unwrap();
        initiator
            .read_message(&message[..length], &mut plaintext)
            .unwrap();
        let length = initiator.write_message(&[], &mut message).unwrap();
        responder
            .read_message(&message[..length], &mut plaintext)
            .unwrap();
        (
            initiator.into_transport_mode().unwrap(),
            responder.into_transport_mode().unwrap(),
        )
    }

    #[test]
    fn transport_record_has_inner_u16_before_snow_ciphertext() {
        let (mut initiator, mut responder) = transport_pair();
        let plaintext = b"GET /api/v1/health HTTP/1.1\r\n\r\n";
        let record = encode_transport(&mut initiator, plaintext).unwrap();
        assert_eq!(
            u16::from_be_bytes([record[0], record[1]]) as usize,
            record.len() - 2
        );
        assert_eq!(record.len(), plaintext.len() + 2 + 16);
        assert_eq!(
            decode_transport(&mut responder, &record, MAX_NOISE_PLAINTEXT).unwrap(),
            plaintext
        );

        let maximum = vec![0x5a; MAX_NOISE_PLAINTEXT];
        let record = encode_transport(&mut initiator, &maximum).unwrap();
        assert_eq!(record.len(), MAX_TRANSPORT_FRAME);
        assert_eq!(
            decode_transport(&mut responder, &record, MAX_NOISE_PLAINTEXT).unwrap(),
            maximum
        );
    }

    // In-memory IO: these regressions never bind or connect to a socket.
    #[tokio::test(start_paused = true)]
    async fn resilience_silent_handshake_is_bounded() {
        let node = SigningKey::from_bytes(&[35u8; 32]);
        let public = X25519PublicKey::from(&StaticSecret::from([36u8; 32])).to_bytes();
        let descriptor = parse_pairing_link(&signed_link(
            "example.invalid:8443".into(), &node, public, &test_code(10),
        )).unwrap();
        let store = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(store.path()).unwrap();
        let (mut app, _silent_node) = tokio::io::duplex(65536);
        let result = tokio::time::timeout(Duration::from_secs(6), pinned_handshake(&mut app, &descriptor, &key)).await;
        assert!(matches!(result, Ok(Err(_))), "a silent handshake must release its connection slot");
        let (mut app, _silent_node) = tokio::io::duplex(65536);
        let (mut noise, _) = transport_pair();
        let result = tokio::time::timeout(Duration::from_secs(6), encrypted_auth(&mut app, &mut noise, &descriptor, &key, "test", None, None)).await;
        assert!(matches!(result, Ok(Err(_))), "silent encrypted auth must also be bounded");
    }

    #[tokio::test(start_paused = true)]
    async fn resilience_idle_and_blocked_connections_release_slots() {
        let slots = Arc::new(Semaphore::new(MAX_LOCAL_CONNECTIONS));
        for blocked in [false, true] {
            let (local, _caller) = tokio::io::duplex(1);
            let (remote, _node) = tokio::io::duplex(1);
            let (noise, _) = transport_pair();
            let permit = slots.clone().acquire_owned().await.unwrap();
            let connection = async {
                let _permit = permit;
                tunnel(local, remote, noise, LocalHttpSanitizer::new("test"),
                    if blocked { vec![1; 1024] } else { Vec::new() }).await
            };
            assert!(tokio::time::timeout(Duration::from_secs(65), connection).await.is_ok(),
                "idle or blocked connections cannot retain a slot forever");
            assert_eq!(slots.available_permits(), MAX_LOCAL_CONNECTIONS);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn resilience_remote_eof_during_blocked_local_write_releases_slot() {
        let slots = Arc::new(Semaphore::new(1));
        let permit = slots.clone().acquire_owned().await.unwrap();
        let (local, _caller) = tokio::io::duplex(1);
        let (remote, mut node) = tokio::io::duplex(4096);
        let (noise, mut node_noise) = transport_pair();
        let reply = encode_transport(&mut node_noise, &[1; 1024]).unwrap();
        write_frame(&mut node, &reply).await.unwrap();
        drop(node);
        let result = tokio::time::timeout(Duration::from_secs(6), async {
            let _permit = permit;
            tunnel(local, remote, noise, LocalHttpSanitizer::new("test"), Vec::new()).await
        }).await;
        assert!(matches!(result, Ok(Err(_))));
        assert_eq!(slots.available_permits(), 1);
    }

    #[tokio::test]
    async fn resilience_restart_and_many_short_connections_release_every_slot() {
        let slots = Arc::new(Semaphore::new(MAX_LOCAL_CONNECTIONS));
        for cycle in 0..32 {
            let mut tasks = Vec::new();
            let mut callers = Vec::new();
            let mut nodes = Vec::new();
            for _ in 0..MAX_LOCAL_CONNECTIONS {
                let (local, caller) = tokio::io::duplex(4096);
                let (remote, node) = tokio::io::duplex(4096);
                let (noise, mut node_noise) = transport_pair();
                let permit = slots.clone().try_acquire_owned().unwrap();
                tasks.push(tokio::spawn(async move {
                    let _permit = permit;
                    tunnel(local, remote, noise, LocalHttpSanitizer::new("test"), Vec::new()).await
                }));
                let mut node = node;
                let mut caller = caller;
                let reply = encode_transport(&mut node_noise, b"ok").unwrap();
                write_frame(&mut node, &reply).await.unwrap();
                let mut received = [0; 2];
                caller.read_exact(&mut received).await.unwrap();
                assert_eq!(&received, b"ok"); // Fresh Noise session works after every restart.
                callers.push(caller);
                nodes.push(node);
            }
            assert_eq!(slots.available_permits(), 0);
            match cycle % 4 {
                0 => nodes.clear(), // Node restart / remote EOF.
                1 => callers.clear(), // Short local connection / local EOF.
                2 => { // Invalid ciphertext must tear down the session too.
                    for node in &mut nodes { write_frame(node, &[0; 32]).await.unwrap(); }
                }
                _ => { for task in &tasks { task.abort(); } } // Proxy shutdown.
            }
            for task in tasks {
                let result = tokio::time::timeout(Duration::from_secs(1), task).await.unwrap();
                if cycle % 4 == 3 { assert!(result.unwrap_err().is_cancelled()); }
                else { assert_eq!(result.unwrap().is_ok(), cycle % 4 == 1); }
            }
            assert_eq!(slots.available_permits(), MAX_LOCAL_CONNECTIONS, "cycle {cycle}");
            // The framed reader must also release its half of the transport:
            // a returned permit alone is insufficient if a Noise socket lingers.
            for endpoint in nodes.iter_mut().chain(callers.iter_mut()) {
                let mut byte = [0];
                assert_eq!(tokio::time::timeout(Duration::from_secs(1), endpoint.read(&mut byte))
                    .await.unwrap().unwrap(), 0);
            }
        }
    }

    async fn fragmented_reply_survives_outgoing_local_traffic(split_at: usize) {
        let (local_proxy, local_client) = tokio::io::duplex(65536);
        let (remote_proxy, mut remote_node) = tokio::io::duplex(65536);

        let (app_noise, mut node_noise) = transport_pair();
        let local_auth = "fragment-auth";
        let bridge = tokio::spawn(tunnel(
            local_proxy,
            remote_proxy,
            app_noise,
            LocalHttpSanitizer::new(local_auth),
            Vec::new(),
        ));
        let mut local_client = local_client;

        let reply = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
        let record = encode_transport(&mut node_noise, reply).unwrap();
        let mut outer = Vec::with_capacity(record.len() + 4);
        outer.extend_from_slice(&(record.len() as u32).to_be_bytes());
        outer.extend_from_slice(&record);
        assert!(split_at > 0 && split_at < outer.len());
        remote_node.write_all(&outer[..split_at]).await.unwrap();

        // Give the framed reader time to consume the fragment. The old
        // select-owned read_frame lost these bytes when this local read won.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let outgoing = b"GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\nX-BitSov-Proxy-Auth: fragment-auth\r\n\r\n";
        local_client.write_all(outgoing).await.unwrap();

        let outgoing_record = tokio::time::timeout(
            Duration::from_secs(1),
            read_frame(&mut remote_node, MAX_TRANSPORT_FRAME),
        )
        .await
        .expect("outgoing frame must arrive while reply is fragmented")
        .unwrap();
        assert_eq!(
            decode_transport(&mut node_noise, &outgoing_record, MAX_NOISE_PLAINTEXT).unwrap(),
            b"GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n\r\n"
        );

        remote_node.write_all(&outer[split_at..]).await.unwrap();
        let mut received = vec![0u8; reply.len()];
        tokio::time::timeout(
            Duration::from_secs(1),
            local_client.read_exact(&mut received),
        )
        .await
        .expect("fragmented reply must survive the competing local read")
        .unwrap();
        assert_eq!(received, reply);

        local_client.shutdown().await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), bridge)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn tunnel_keeps_partial_outer_header_when_local_traffic_wins() {
        fragmented_reply_survives_outgoing_local_traffic(2).await;
    }

    #[tokio::test]
    async fn tunnel_keeps_partial_outer_body_when_local_traffic_wins() {
        fragmented_reply_survives_outgoing_local_traffic(7).await;
    }

    #[tokio::test]
    async fn tunnel_strips_proxy_auth_from_two_keep_alive_requests() {
        let (local_proxy, mut local_client) = tokio::io::duplex(65536);
        let (remote_proxy, mut remote_node) = tokio::io::duplex(65536);
        let (app_noise, mut node_noise) = transport_pair();
        let secret = "keep-alive-secret";
        let bridge = tokio::spawn(tunnel(
            local_proxy,
            remote_proxy,
            app_noise,
            LocalHttpSanitizer::new(secret),
            Vec::new(),
        ));

        for path in ["/first", "/second"] {
            let request = format!(
                "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n{LOCAL_AUTH_HEADER}: {secret}\r\n\r\n"
            );
            local_client.write_all(request.as_bytes()).await.unwrap();
            let frame = tokio::time::timeout(
                Duration::from_secs(1),
                read_frame(&mut remote_node, MAX_TRANSPORT_FRAME),
            )
            .await
            .expect("sanitized keep-alive request must reach the remote")
            .unwrap();
            let plaintext = decode_transport(&mut node_noise, &frame, MAX_NOISE_PLAINTEXT).unwrap();
            let text = std::str::from_utf8(&plaintext).unwrap();
            assert!(text.starts_with(&format!("GET {path} HTTP/1.1\r\n")));
            assert!(!text.to_ascii_lowercase().contains(LOCAL_AUTH_HEADER));
            assert!(!text.contains(secret));
        }

        local_client.shutdown().await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), bridge)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }

    #[test]
    fn local_proxy_auth_predicate_rejects_missing_duplicate_and_wrong_tokens() {
        let request = |headers: &str| {
            format!("GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n{headers}\r\n")
        };
        assert!(request_has_local_auth(
            request("X-BitSov-Proxy-Auth: abc123\r\n").as_bytes(),
            "abc123"
        ));
        assert!(!request_has_local_auth(request("").as_bytes(), "abc123"));
        assert!(!request_has_local_auth(
            request("X-BitSov-Proxy-Auth: wrong\r\n").as_bytes(),
            "abc123"
        ));
        assert!(!request_has_local_auth(
            request("X-BitSov-Proxy-Auth: abc123\r\nx-bitsov-proxy-auth: abc123\r\n").as_bytes(),
            "abc123"
        ));
    }

    #[test]
    fn local_proxy_auth_is_stripped_before_tunneling() {
        let request = b"POST /api/v1/messages HTTP/1.1\r\nHost: localhost\r\nX-BitSov-Proxy-Auth: abc123\r\nContent-Length: 4\r\n\r\nbody";
        let mut sanitizer = LocalHttpSanitizer::new("abc123");
        let sanitized = sanitizer.push(request).unwrap();
        assert_eq!(
            sanitized,
            b"POST /api/v1/messages HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\nbody"
        );
        assert!(!sanitized
            .windows(LOCAL_AUTH_HEADER.len())
            .any(|window| window.eq_ignore_ascii_case(LOCAL_AUTH_HEADER.as_bytes())));
    }

    #[test]
    fn pipelined_requests_each_require_and_strip_the_proxy_credential() {
        let mut sanitizer = LocalHttpSanitizer::new("abc123");
        let requests = b"GET /one HTTP/1.1\r\nHost: localhost\r\nX-BitSov-Proxy-Auth: abc123\r\n\r\nGET /two HTTP/1.1\r\nHost: localhost\r\nx-bitsov-proxy-auth: abc123\r\n\r\n";
        let sanitized = sanitizer.push(requests).unwrap();
        assert_eq!(
            sanitized,
            b"GET /one HTTP/1.1\r\nHost: localhost\r\n\r\nGET /two HTTP/1.1\r\nHost: localhost\r\n\r\n"
        );
        assert_eq!(sanitizer.authenticated_requests, 2);

        let mut missing_second = LocalHttpSanitizer::new("abc123");
        assert!(missing_second
            .push(b"GET /one HTTP/1.1\r\nX-BitSov-Proxy-Auth: abc123\r\n\r\nGET /two HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .is_err());
    }

    #[test]
    fn websocket_upgrade_is_sanitized_then_frames_are_forwarded_raw() {
        let mut sanitizer = LocalHttpSanitizer::new("abc123");
        let request = b"GET /api/v1/ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-BitSov-Proxy-Auth: abc123\r\n\r\n";
        let sanitized = sanitizer.push(request).unwrap();
        assert_eq!(
            sanitized,
            b"GET /api/v1/ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
        );
        let frame = [0x81, 0x02, b'o', b'k'];
        assert_eq!(sanitizer.push(&frame).unwrap(), frame);
    }

    #[test]
    fn chunked_body_boundary_preserves_the_next_authenticated_request() {
        let mut sanitizer = LocalHttpSanitizer::new("abc123");
        let requests = b"POST /one HTTP/1.1\r\nTransfer-Encoding: chunked\r\nX-BitSov-Proxy-Auth: abc123\r\n\r\n4\r\nbody\r\n0\r\n\r\nGET /two HTTP/1.1\r\nX-BitSov-Proxy-Auth: abc123\r\n\r\n";
        let sanitized = sanitizer.push(requests).unwrap();
        assert_eq!(
            sanitized,
            b"POST /one HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nbody\r\n0\r\n\r\nGET /two HTTP/1.1\r\n\r\n"
        );
        assert_eq!(sanitizer.authenticated_requests, 2);
    }

    #[test]
    fn pre_auth_eof_has_stable_handshake_limit_error() {
        let error = map_pre_auth_failure(RemoteError::Transport(
            "cannot read frame length: early eof".into(),
        ));
        assert!(matches!(error, RemoteError::HandshakeUnavailable));
        assert_eq!(error.to_string(), HANDSHAKE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn remote_dial_opens_with_a_noise_frame_not_tls() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let node = SigningKey::from_bytes(&[42; 32]);
        let descriptor = parse_pairing_link(&signed_link(
            listener.local_addr().unwrap().to_string(), &node, [43; 32], &test_code(44),
        )).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(dir.path()).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut head = [0; 4];
            stream.read_exact(&mut head).await.unwrap();
            assert_ne!(head[0], 0x16);
            assert_eq!(u32::from_be_bytes(head), 32);
        });
        assert!(connect_authenticated(&descriptor, &key, "test phone").await.is_err());
        tokio::time::timeout(Duration::from_secs(2), server).await.unwrap().unwrap();
    }

    async fn responder(listener: TcpListener, secret: [u8; 32]) -> Result<(), RemoteError> {
        let (mut stream, _) = listener.accept().await.unwrap();
        let params = NOISE_PROTOCOL.parse().unwrap();
        let mut noise = Builder::new(params)
            .local_private_key(&secret)
            .and_then(|b| b.build_responder())
            .unwrap();
        let mut output = vec![0u8; MAX_HANDSHAKE_FRAME];
        let message = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await?;
        noise.read_message(&message, &mut output).unwrap();
        let length = noise.write_message(&[], &mut output).unwrap();
        write_frame(&mut stream, &output[..length]).await?;
        let message = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await?;
        noise.read_message(&message, &mut output).unwrap();
        Ok(())
    }

    async fn pairing_responder(
        listener: TcpListener,
        secret: [u8; 32],
    ) -> Result<RemoteAuthRequest, RemoteError> {
        let (mut stream, _) = listener.accept().await.unwrap();
        let params = NOISE_PROTOCOL.parse().unwrap();
        let mut noise = Builder::new(params)
            .local_private_key(&secret)
            .and_then(|b| b.build_responder())
            .unwrap();
        let mut output = vec![0u8; MAX_HANDSHAKE_FRAME];
        let message = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await?;
        noise.read_message(&message, &mut output).unwrap();
        let length = noise.write_message(&[], &mut output).unwrap();
        write_frame(&mut stream, &output[..length]).await?;
        let message = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await?;
        noise.read_message(&message, &mut output).unwrap();
        let mut noise = noise.into_transport_mode().unwrap();

        let encrypted = read_frame(&mut stream, MAX_TRANSPORT_FRAME).await?;
        let plaintext = decode_transport(&mut noise, &encrypted, MAX_AUTH_PLAINTEXT)?;
        let request = serde_json::from_slice::<RemoteAuthRequest>(&plaintext).unwrap();
        let response = serde_json::to_vec(&RemoteAuthResponse::Ok {
            v: 1,
            client_id: "0123456789abcdef0123456789abcdef".into(),
            scopes: vec!["read".into(), "receive".into()],
            box_transport_pubkey: None, box_transport_signature: None,
            transport_pubkey: None, transport_signature: None,
        })
        .unwrap();
        let encrypted = encode_transport(&mut noise, &response)?;
        write_frame(&mut stream, &encrypted).await?;
        Ok(request)
    }

    // A real Noise/auth responder with HTTP keep-alive inside each tunnel.
    // Count socket handshakes, not requests, so losing pooling fails this test.
    async fn polling_responder(mut stream: TcpStream, secret: [u8; 32]) -> Result<(), RemoteError> {
        let mut noise = Builder::new(NOISE_PROTOCOL.parse().unwrap())
            .local_private_key(&secret).and_then(|b| b.build_responder()).unwrap();
        let mut output = vec![0u8; MAX_HANDSHAKE_FRAME];
        let message = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await?;
        noise.read_message(&message, &mut output).unwrap();
        let length = noise.write_message(&[], &mut output).unwrap();
        write_frame(&mut stream, &output[..length]).await?;
        let message = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await?;
        noise.read_message(&message, &mut output).unwrap();
        let mut noise = noise.into_transport_mode().unwrap();
        let encrypted = read_frame(&mut stream, MAX_TRANSPORT_FRAME).await?;
        let auth = decode_transport(&mut noise, &encrypted, MAX_AUTH_PLAINTEXT)?;
        let _: RemoteAuthRequest = serde_json::from_slice(&auth).unwrap();
        let response = serde_json::to_vec(&RemoteAuthResponse::Ok {
            v: 1, client_id: "0123456789abcdef0123456789abcdef".into(),
            scopes: vec!["read".into(), "receive".into()],
            box_transport_pubkey: None, box_transport_signature: None,
            transport_pubkey: None, transport_signature: None,
        }).unwrap();
        let encrypted = encode_transport(&mut noise, &response)?;
        write_frame(&mut stream, &encrypted).await?;
        let mut request = Vec::new();
        loop {
            let encrypted = read_frame(&mut stream, MAX_TRANSPORT_FRAME).await?;
            request.extend(decode_transport(&mut noise, &encrypted, MAX_NOISE_PLAINTEXT)?);
            while let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                request.drain(..end + 4);
                let response = encode_transport(&mut noise, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")?;
                write_frame(&mut stream, &response).await?;
            }
        }
    }

    #[tokio::test]
    async fn normal_polling_reuses_at_most_eight_handshakes_over_two_simulated_minutes() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let secret = [28u8; 32];
        let node = SigningKey::from_bytes(&[27u8; 32]);
        let public = X25519PublicKey::from(&StaticSecret::from(secret)).to_bytes();
        let descriptor = parse_pairing_link(&signed_link(
            listener.local_addr().unwrap().to_string(), &node, public, &test_code(11),
        )).unwrap();
        let attempts = Arc::new(AtomicUsize::new(0));
        let refuse = Arc::new(AtomicBool::new(false));
        let server = tokio::spawn({
            let attempts = attempts.clone();
            let refuse = refuse.clone();
            async move {
                let mut sessions = tokio::task::JoinSet::new();
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    attempts.fetch_add(1, Ordering::SeqCst);
                    let reject = refuse.swap(false, Ordering::SeqCst);
                    sessions.spawn(async move {
                        if reject {
                            let _ = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await;
                            write_frame(&mut stream, br#"{"v":1,"code":"rate_limited","retry_after_secs":1}"#).await.unwrap();
                        } else {
                            let _ = polling_responder(stream, secret).await;
                        }
                    });
                }
            }
        });
        let app_dir = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let key = Arc::new(ClientKey::load_or_create(store.path()).unwrap());
        let auth: Arc<str> = Arc::from("b".repeat(64));
        let retry = Arc::new(RemoteRetry::default());
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_base = format!("http://127.0.0.1:{}/api/v1", probe.local_addr().unwrap().port());
        drop(probe);
        persist_at(&config_path(app_dir.path()), &descriptor).unwrap();
        let proxy = start_proxy(&local_base, app_dir.path(), descriptor,
            key, "polling test", store.path().to_path_buf(), auth.clone(), retry.clone()).await.unwrap();
        let client = http_client_builder().build().unwrap();
        let url = format!("http://127.0.0.1:{}/api/v1/status", proxy.local_addr().port());
        let read = || async {
            let response = client.get(&url).header(LOCAL_AUTH_HEADER, auth.as_ref()).send().await.unwrap();
            assert_eq!(response.status(), 200);
            assert_eq!(response.text().await.unwrap(), "{}");
        };
        // The initial seven loads use the same two slots as periodic reads.
        for _ in 0..4 { tokio::join!(read(), read()); }
        let warm = attempts.load(Ordering::SeqCst);
        assert!((1..=2).contains(&warm));
        let mut requests = 8;
        // Shell cadence, with panel offsets. Two sequential spend/budget reads
        // every three seconds keep the pool warm between less frequent panels.
        for tick in 1..=480 {
            tokio::time::pause();
            tokio::time::advance(Duration::from_millis(250)).await;
            tokio::time::resume(); // real loopback IO must not auto-advance timers
            let mut due = usize::from(tick % 12 == 0) * 2;
            for (period, offset) in [(40, 1), (60, 2), (60, 3), (80, 4), (120, 5), (120, 6), (120, 7), (120, 8)] {
                due += usize::from(tick % period == offset);
            }
            while due >= 2 { tokio::join!(read(), read()); due -= 2; requests += 2; }
            if due == 1 { read().await; requests += 1; }
        }
        assert!(requests >= 130, "exercise the whole polling workload: {requests}");
        assert!(attempts.load(Ordering::SeqCst) <= 8, "handshakes: {}", attempts.load(Ordering::SeqCst));
        assert_eq!(attempts.load(Ordering::SeqCst), warm, "no handshake churn after warm-up");

        // Refusing one new tunnel must leave established tunnels usable.
        refuse.store(true, Ordering::SeqCst);
        let extra = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = extra.get(&url).header(LOCAL_AUTH_HEADER, auth.as_ref()).send().await.unwrap();
        assert_eq!(response.status(), 503);
        assert!(response.text().await.unwrap().contains("waiting 1 s"));
        assert!(retry.remaining().is_some());
        tokio::join!(read(), read());
        assert_eq!(attempts.load(Ordering::SeqCst), warm + 1);
        drop(proxy);
        server.abort();
    }

    #[tokio::test]
    async fn fresh_import_bootstraps_pinned_noise_before_remote_establish() {
        let app_dir = tempfile::tempdir().unwrap();
        let pairing_store = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(pairing_store.path()).unwrap();
        let node = SigningKey::from_bytes(&[27u8; 32]);
        let responder_secret = [28u8; 32];
        let responder_public =
            X25519PublicKey::from(&StaticSecret::from(responder_secret)).to_bytes();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let descriptor = parse_pairing_link(&signed_link(
            listener.local_addr().unwrap().to_string(),
            &node,
            responder_public,
            &test_code(11),
        ))
        .unwrap();
        persist_at(&config_path(app_dir.path()), &descriptor).unwrap();
        assert!(!pairing_store.path().join(pairing::RECORD_FILE).exists());
        let server = tokio::spawn(pairing_responder(listener, responder_secret));

        let descriptor = authenticate_pinned_transport_and_save_record(
            app_dir.path(),
            descriptor,
            &key,
            "BitSov test",
            pairing_store.path(),
            &RemoteRetry::default(),
        )
        .await
        .unwrap();
        let request = server.await.unwrap().unwrap();
        assert!(request.code.is_some());
        assert!(!descriptor.has_code());
        assert!(pairing_store.path().join(pairing::RECORD_FILE).exists());
        assert!(!std::fs::read_to_string(config_path(app_dir.path()))
            .unwrap()
            .contains("\"code\""));

        let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead_base = format!("http://{}/{}", dead.local_addr().unwrap(), "api/v1");
        drop(dead);
        let client = pairing::PairingClient::new(reqwest::Client::new(), dead_base);
        let error = pairing::establish_remote(&client, &key, pairing_store.path())
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            pairing::PairError::Transport {
                step: "/pair/challenge",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn noise_pin_succeeds_and_mismatch_is_required_refusal() {
        let key_dir = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(key_dir.path()).unwrap();
        let node = SigningKey::from_bytes(&[31u8; 32]);
        let responder_secret = [32u8; 32];
        let responder_public =
            X25519PublicKey::from(&StaticSecret::from(responder_secret)).to_bytes();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = listener.local_addr().unwrap().to_string();
        let descriptor = parse_pairing_link(&signed_link(
            endpoint,
            &node,
            responder_public,
            &test_code(4),
        ))
        .unwrap();
        let server = tokio::spawn(responder(listener, responder_secret));
        let mut stream = TcpStream::connect(descriptor.endpoint()).await.unwrap();
        pinned_handshake(&mut stream, &descriptor, &key)
            .await
            .unwrap();
        server.await.unwrap().unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = listener.local_addr().unwrap().to_string();
        let wrong_public = X25519PublicKey::from(&StaticSecret::from([33u8; 32])).to_bytes();
        let descriptor =
            parse_pairing_link(&signed_link(endpoint, &node, wrong_public, &test_code(5))).unwrap();
        let server = tokio::spawn(responder(listener, responder_secret));
        let mut stream = TcpStream::connect(descriptor.endpoint()).await.unwrap();
        let error = pinned_handshake(&mut stream, &descriptor, &key)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("does not match"));
        drop(stream);
        assert!(server.await.unwrap().is_err());
    }

    // Handshake and authenticate every accepted tunnel, then hand back what
    // arrives inside it (the forwarded HTTP bytes) until the tunnel closes.
    async fn authenticating_responder(listener: TcpListener, secret: [u8; 32], forwarded: mpsc::UnboundedSender<Vec<u8>>) {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            tokio::spawn(authenticate_and_forward(stream, secret, forwarded.clone()));
        }
    }

    // Complete the handshake and read the app's authentication request.
    async fn read_auth_request(stream: &mut TcpStream, secret: [u8; 32]) -> Result<TransportState, RemoteError> {
        let mut noise = Builder::new(NOISE_PROTOCOL.parse().unwrap())
            .local_private_key(&secret).and_then(|b| b.build_responder()).unwrap();
        let mut output = vec![0u8; MAX_HANDSHAKE_FRAME];
        let message = read_frame(stream, MAX_HANDSHAKE_FRAME).await?;
        noise.read_message(&message, &mut output).unwrap();
        let length = noise.write_message(&[], &mut output).unwrap();
        write_frame(stream, &output[..length]).await?;
        let message = read_frame(stream, MAX_HANDSHAKE_FRAME).await?;
        noise.read_message(&message, &mut output).unwrap();
        let mut noise = noise.into_transport_mode().unwrap();
        let encrypted = read_frame(stream, MAX_TRANSPORT_FRAME).await?;
        let auth = decode_transport(&mut noise, &encrypted, MAX_AUTH_PLAINTEXT)?;
        let _: RemoteAuthRequest = serde_json::from_slice(&auth).unwrap();
        Ok(noise)
    }

    // The node's answer to a client it does not know: a definitive refusal.
    async fn refuse_authentication(mut stream: TcpStream, secret: [u8; 32]) -> Result<(), RemoteError> {
        let mut noise = read_auth_request(&mut stream, secret).await?;
        let response = serde_json::to_vec(&RemoteAuthResponse::Error {
            v: 1, code: "authentication_failed".into(), message: "unknown client".into(),
        }).unwrap();
        let encrypted = encode_transport(&mut noise, &response)?;
        write_frame(&mut stream, &encrypted).await
    }

    async fn authenticate_and_forward(mut stream: TcpStream, secret: [u8; 32], forwarded: mpsc::UnboundedSender<Vec<u8>>) -> Result<(), RemoteError> {
        let mut noise = read_auth_request(&mut stream, secret).await?;
        let response = serde_json::to_vec(&RemoteAuthResponse::Ok {
            v: 1, client_id: "0123456789abcdef0123456789abcdef".into(),
            scopes: vec!["read".into()],
            box_transport_pubkey: None, box_transport_signature: None,
            transport_pubkey: None, transport_signature: None,
        }).unwrap();
        let encrypted = encode_transport(&mut noise, &response)?;
        write_frame(&mut stream, &encrypted).await?;
        loop {
            let encrypted = read_frame(&mut stream, MAX_TRANSPORT_FRAME).await?;
            let _ = forwarded.send(decode_transport(&mut noise, &encrypted, MAX_NOISE_PLAINTEXT)?);
        }
    }

    async fn proxy_for(descriptor: RemoteDescriptor, local_auth: &Arc<str>, retry: Arc<RemoteRetry>) -> (RemoteProxy, tempfile::TempDir, tempfile::TempDir) {
        let app_dir = tempfile::tempdir().unwrap();
        persist_at(&config_path(app_dir.path()), &descriptor).unwrap();
        let pairing_store = tempfile::tempdir().unwrap();
        let key = Arc::new(ClientKey::load_or_create(pairing_store.path()).unwrap());
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_addr = probe.local_addr().unwrap();
        drop(probe);
        let proxy = start_proxy(&format!("http://{local_addr}/{}", "api/v1"), app_dir.path(), descriptor, key,
            "BitSov test", pairing_store.path().to_path_buf(), local_auth.clone(), retry).await.unwrap();
        (proxy, app_dir, pairing_store)
    }

    // The caller gives up while the tunnel is still being set up (here: the
    // box holds the handshake). The buffered request must not be sent later.
    #[tokio::test]
    async fn a_request_whose_caller_gave_up_is_never_forwarded() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let secret = [66u8; 32];
        let node = SigningKey::from_bytes(&[65u8; 32]);
        let public = X25519PublicKey::from(&StaticSecret::from(secret)).to_bytes();
        let descriptor = parse_pairing_link(&signed_link(
            listener.local_addr().unwrap().to_string(), &node, public, &test_code(67),
        )).unwrap();
        let (accepted_tx, mut accepted_rx) = mpsc::unbounded_channel();
        let release = Arc::new(tokio::sync::Notify::new());
        let (forwarded, mut forwarded_rx) = mpsc::unbounded_channel();
        let server = tokio::spawn({
            let release = release.clone();
            async move {
                let (stream, _) = listener.accept().await.unwrap();
                accepted_tx.send(()).unwrap();
                release.notified().await;
                let _ = authenticate_and_forward(stream, secret, forwarded).await;
            }
        });
        let local_auth: Arc<str> = Arc::from("c".repeat(64));
        let (proxy, _app, _store) = proxy_for(descriptor, &local_auth, Arc::new(RemoteRetry::default())).await;

        let mut caller = TcpStream::connect(proxy.local_addr()).await.unwrap();
        caller.write_all(format!(
            "GET /api/v1/status HTTP/1.1\r\nHost: localhost\r\n{LOCAL_AUTH_HEADER}: {local_auth}\r\n\r\n"
        ).as_bytes()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), accepted_rx.recv()).await.unwrap().unwrap();
        // The caller's own timeout fires: it closes the connection.
        drop(caller);
        tokio::time::sleep(Duration::from_millis(100)).await;
        release.notify_one();
        let late = tokio::time::timeout(Duration::from_secs(2), forwarded_rx.recv()).await;
        assert!(!matches!(late, Ok(Some(_))), "a request was forwarded after its caller gave up");
        drop(proxy);
        server.abort();
    }

    // A request queued behind a slow tunnel setup gets a bounded wait. After
    // the deadline it is answered (503) and never forwarded.
    #[tokio::test]
    async fn a_queued_request_has_an_overall_connect_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let secret = [69u8; 32];
        let node = SigningKey::from_bytes(&[68u8; 32]);
        let public = X25519PublicKey::from(&StaticSecret::from(secret)).to_bytes();
        let descriptor = parse_pairing_link(&signed_link(
            listener.local_addr().unwrap().to_string(), &node, public, &test_code(70),
        )).unwrap();
        let (forwarded, mut forwarded_rx) = mpsc::unbounded_channel();
        let server = tokio::spawn(authenticating_responder(listener, secret, forwarded));
        let local_auth: Arc<str> = Arc::from("d".repeat(64));
        let retry = Arc::new(RemoteRetry::default());
        let (proxy, _app, _store) = proxy_for(descriptor, &local_auth, retry.clone()).await;

        // Another tunnel setup holds the handshake queue.
        let (release, held) = tokio::sync::oneshot::channel::<()>();
        let holder = tokio::spawn({
            let retry = retry.clone();
            async move { retry.run(|| async { let _ = held.await; Ok(()) }).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let mut caller = TcpStream::connect(proxy.local_addr()).await.unwrap();
        caller.write_all(format!(
            "GET /api/v1/status HTTP/1.1\r\nHost: localhost\r\n{LOCAL_AUTH_HEADER}: {local_auth}\r\n\r\n"
        ).as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        tokio::time::pause();
        tokio::time::advance(REMOTE_CONNECT_DEADLINE + Duration::from_secs(1)).await;
        tokio::time::resume();
        let mut response = String::new();
        let read = tokio::time::timeout(Duration::from_secs(2), caller.read_to_string(&mut response)).await;
        release.send(()).unwrap();
        holder.await.unwrap().unwrap();
        let late = tokio::time::timeout(Duration::from_secs(1), forwarded_rx.recv()).await;
        assert!(!matches!(late, Ok(Some(_))), "a request was forwarded after the connect deadline");
        assert!(read.is_ok(), "the caller is answered at the deadline");
        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable"), "{response}");
        assert!(response.contains("remote_handshake_unavailable"));
        assert!(response.contains(&format!("{PROXY_ERROR_HEADER}: remote_handshake_unavailable")));
        assert!(!retry.is_refused(), "a deadline says nothing about the pairing");
        drop(proxy);
        server.abort();
    }

    async fn send_status_request(proxy: &RemoteProxy, local_auth: &str) -> TcpStream {
        let mut caller = TcpStream::connect(proxy.local_addr()).await.unwrap();
        caller.write_all(format!(
            "GET /api/v1/status HTTP/1.1\r\nHost: localhost\r\n{LOCAL_AUTH_HEADER}: {local_auth}\r\n\r\n"
        ).as_bytes()).await.unwrap();
        caller
    }

    // A refusal that arrives inside the connect race is recorded, is answered
    // with the code the media link treats as final, and stops every later dial.
    #[tokio::test]
    async fn a_refusal_met_inside_the_connect_race_is_recorded_and_stops_dialing() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let secret = [72u8; 32];
        let node = SigningKey::from_bytes(&[71u8; 32]);
        let public = X25519PublicKey::from(&StaticSecret::from(secret)).to_bytes();
        let descriptor = parse_pairing_link(&signed_link(
            listener.local_addr().unwrap().to_string(), &node, public, &test_code(73),
        )).unwrap();
        let dials = Arc::new(AtomicUsize::new(0));
        let server = tokio::spawn({
            let dials = dials.clone();
            async move {
                loop {
                    let (stream, _) = listener.accept().await.unwrap();
                    dials.fetch_add(1, Ordering::SeqCst);
                    let _ = refuse_authentication(stream, secret).await;
                }
            }
        });
        let local_auth: Arc<str> = Arc::from("e".repeat(64));
        let retry = Arc::new(RemoteRetry::default());
        let (proxy, _app, _store) = proxy_for(descriptor, &local_auth, retry.clone()).await;
        for _ in 0..3 {
            let mut caller = send_status_request(&proxy, &local_auth).await;
            let mut response = String::new();
            tokio::time::timeout(Duration::from_secs(5), caller.read_to_string(&mut response)).await.unwrap().unwrap();
            assert!(response.starts_with("HTTP/1.1 403 Forbidden"), "{response}");
            assert!(response.contains(&format!("{PROXY_ERROR_HEADER}: remote_pairing_refused")), "{response}");
            assert!(retry.is_refused());
        }
        assert_eq!(dials.load(Ordering::SeqCst), 1, "no dial once refused");
        drop(proxy);
        server.abort();
    }

    // The caller closes while the box holds the handshake. The dial is
    // cancelled and nothing is recorded, even if the box would have refused.
    #[tokio::test]
    async fn a_caller_giving_up_mid_dial_is_not_a_refusal() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let secret = [75u8; 32];
        let node = SigningKey::from_bytes(&[74u8; 32]);
        let public = X25519PublicKey::from(&StaticSecret::from(secret)).to_bytes();
        let descriptor = parse_pairing_link(&signed_link(
            listener.local_addr().unwrap().to_string(), &node, public, &test_code(76),
        )).unwrap();
        let (accepted_tx, mut accepted_rx) = mpsc::unbounded_channel();
        let release = Arc::new(tokio::sync::Notify::new());
        let (forwarded, mut forwarded_rx) = mpsc::unbounded_channel();
        let server = tokio::spawn({
            let release = release.clone();
            async move {
                let (stream, _) = listener.accept().await.unwrap();
                accepted_tx.send(()).unwrap();
                release.notified().await;
                let _ = refuse_authentication(stream, secret).await;
                authenticating_responder(listener, secret, forwarded).await;
            }
        });
        let local_auth: Arc<str> = Arc::from("f".repeat(64));
        let retry = Arc::new(RemoteRetry::default());
        let (proxy, _app, _store) = proxy_for(descriptor, &local_auth, retry.clone()).await;

        let caller = send_status_request(&proxy, &local_auth).await;
        tokio::time::timeout(Duration::from_secs(2), accepted_rx.recv()).await.unwrap().unwrap();
        drop(caller);
        tokio::time::sleep(Duration::from_millis(100)).await;
        release.notify_one();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!retry.is_refused(), "a caller's cancellation set the refused flag");
        assert!(retry.connection_error().is_none(), "a caller's cancellation was counted as a failure");
        assert_eq!(retry.failure_revision(), 0);

        // The next caller dials normally once the cancelled attempt's spacing has passed.
        while retry.remaining().is_some() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _caller = send_status_request(&proxy, &local_auth).await;
        let bytes = tokio::time::timeout(Duration::from_secs(5), forwarded_rx.recv()).await.unwrap().unwrap();
        assert!(bytes.starts_with(b"GET /api/v1/status"));
        drop(proxy);
        server.abort();
    }

    // The caller closes while queued behind another tunnel's handshake, on the
    // path that checks the refusal. Its turn must never come.
    #[tokio::test]
    async fn a_caller_that_gives_up_in_the_admission_queue_never_dials() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let secret = [78u8; 32];
        let node = SigningKey::from_bytes(&[77u8; 32]);
        let public = X25519PublicKey::from(&StaticSecret::from(secret)).to_bytes();
        let descriptor = parse_pairing_link(&signed_link(
            listener.local_addr().unwrap().to_string(), &node, public, &test_code(79),
        )).unwrap();
        let local_auth: Arc<str> = Arc::from("9".repeat(64));
        let retry = Arc::new(RemoteRetry::default());
        let (proxy, _app, _store) = proxy_for(descriptor, &local_auth, retry.clone()).await;

        let (release, held) = tokio::sync::oneshot::channel::<()>();
        let holder = tokio::spawn({
            let retry = retry.clone();
            async move { retry.run_unless_refused(|| async { let _ = held.await; Ok(()) }).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let caller = send_status_request(&proxy, &local_auth).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        drop(caller);
        tokio::time::sleep(Duration::from_millis(100)).await;
        release.send(()).unwrap();
        holder.await.unwrap().unwrap();
        let dialed = tokio::time::timeout(Duration::from_millis(500), listener.accept()).await;
        assert!(dialed.is_err(), "a caller that gave up still reached the box");
        assert!(!retry.is_refused());
        drop(proxy);
    }

    // A caller gives up only through its client's timeout, and `caller_gone`
    // sees that only if the client closes the socket. Pin both halves: the
    // close itself, and the request it stops at the proxy.
    #[tokio::test]
    async fn a_client_timeout_closes_the_socket_and_the_request_is_never_forwarded() {
        // The whole request was read and no answer ever comes.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/{}", listener.local_addr().unwrap(), "api/v1/messages/compose");
        let client = http_client_builder().timeout(Duration::from_millis(500)).build().unwrap();
        let request = tokio::spawn(client.post(url).body("{\"kind\":404}").send());
        let (mut accepted, _) = listener.accept().await.unwrap();
        let mut seen = Vec::new();
        let mut buffer = [0u8; 4096];
        while !seen.ends_with(b"{\"kind\":404}") {
            let read = accepted.read(&mut buffer).await.unwrap();
            assert_ne!(read, 0, "the client gave up before it sent the request");
            seen.extend_from_slice(&buffer[..read]);
        }
        assert!(request.await.unwrap().unwrap_err().is_timeout());
        let closed = tokio::time::timeout(Duration::from_secs(2), accepted.read(&mut buffer)).await
            .expect("the client closes its socket when the request times out");
        assert!(matches!(closed, Ok(0) | Err(_)), "{closed:?}");

        // Through the proxy, with the tunnel still queued, for the client-wide
        // timeout (the 15 s callers) and a per-request one (the money path).
        for per_request in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let secret = [87u8; 32];
            let node = SigningKey::from_bytes(&[86u8; 32]);
            let public = X25519PublicKey::from(&StaticSecret::from(secret)).to_bytes();
            let descriptor = parse_pairing_link(&signed_link(
                listener.local_addr().unwrap().to_string(), &node, public, &test_code(88),
            )).unwrap();
            let (forwarded, mut forwarded_rx) = mpsc::unbounded_channel();
            let server = tokio::spawn(authenticating_responder(listener, secret, forwarded));
            let local_auth: Arc<str> = Arc::from("6".repeat(64));
            let retry = Arc::new(RemoteRetry::default());
            let (proxy, _app, _store) = proxy_for(descriptor, &local_auth, retry.clone()).await;
            let (release, held) = tokio::sync::oneshot::channel::<()>();
            let holder = tokio::spawn({
                let retry = retry.clone();
                async move { retry.run(|| async { let _ = held.await; Ok(()) }).await }
            });
            tokio::time::sleep(Duration::from_millis(50)).await;

            let builder = http_client_builder();
            let client = if per_request { builder } else { builder.timeout(Duration::from_millis(200)) }.build().unwrap();
            let url = format!("http://{}/{}", proxy.local_addr(), "api/v1/messages/compose");
            let post = client.post(url).header(LOCAL_AUTH_HEADER, local_auth.as_ref()).body("{\"kind\":404}");
            let post = if per_request { post.timeout(Duration::from_millis(200)) } else { post };
            assert!(post.send().await.unwrap_err().is_timeout());
            tokio::time::sleep(Duration::from_millis(100)).await;
            release.send(()).unwrap();
            holder.await.unwrap().unwrap();
            let late = tokio::time::timeout(Duration::from_secs(1), forwarded_rx.recv()).await;
            assert!(!matches!(late, Ok(Some(_))), "forwarded after the client timed out (per request: {per_request})");
            drop(proxy);
            server.abort();
        }
    }

    // A body too large for the first read is still in the socket when the
    // caller closes. The close must be seen behind it.
    #[tokio::test]
    async fn a_caller_that_gives_up_after_sending_a_body_is_never_forwarded() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let secret = [81u8; 32];
        let node = SigningKey::from_bytes(&[80u8; 32]);
        let public = X25519PublicKey::from(&StaticSecret::from(secret)).to_bytes();
        let descriptor = parse_pairing_link(&signed_link(
            listener.local_addr().unwrap().to_string(), &node, public, &test_code(82),
        )).unwrap();
        let (accepted_tx, mut accepted_rx) = mpsc::unbounded_channel();
        let release = Arc::new(tokio::sync::Notify::new());
        let (forwarded, mut forwarded_rx) = mpsc::unbounded_channel();
        let server = tokio::spawn({
            let release = release.clone();
            async move {
                let (stream, _) = listener.accept().await.unwrap();
                accepted_tx.send(()).unwrap();
                release.notified().await;
                let _ = authenticate_and_forward(stream, secret, forwarded).await;
            }
        });
        let local_auth: Arc<str> = Arc::from("8".repeat(64));
        let (proxy, _app, _store) = proxy_for(descriptor, &local_auth, Arc::new(RemoteRetry::default())).await;

        let mut caller = TcpStream::connect(proxy.local_addr()).await.unwrap();
        caller.write_all(format!(
            "POST /api/v1/spend HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10000\r\n{LOCAL_AUTH_HEADER}: {local_auth}\r\n\r\n"
        ).as_bytes()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), accepted_rx.recv()).await.unwrap().unwrap();
        caller.write_all(&[b'z'; 10_000]).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(caller);
        tokio::time::sleep(Duration::from_millis(100)).await;
        release.notify_one();
        let late = tokio::time::timeout(Duration::from_secs(2), forwarded_rx.recv()).await;
        assert!(!matches!(late, Ok(Some(_))), "a request was forwarded after its caller gave up");
        drop(proxy);
        server.abort();
    }

    // Bytes read while the tunnel was set up arrive once, in order, and a body
    // over the holding limit keeps flowing through the tunnel afterwards.
    #[tokio::test]
    async fn a_body_sent_while_the_tunnel_is_set_up_is_forwarded_intact() {
        for length in [10_000, MAX_HELD_LOCAL_BYTES + 256 * 1024] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let secret = [84u8; 32];
            let node = SigningKey::from_bytes(&[83u8; 32]);
            let public = X25519PublicKey::from(&StaticSecret::from(secret)).to_bytes();
            let descriptor = parse_pairing_link(&signed_link(
                listener.local_addr().unwrap().to_string(), &node, public, &test_code(85),
            )).unwrap();
            let (accepted_tx, mut accepted_rx) = mpsc::unbounded_channel();
            let release = Arc::new(tokio::sync::Notify::new());
            let (forwarded, mut forwarded_rx) = mpsc::unbounded_channel();
            let server = tokio::spawn({
                let release = release.clone();
                async move {
                    let (stream, _) = listener.accept().await.unwrap();
                    accepted_tx.send(()).unwrap();
                    release.notified().await;
                    let _ = authenticate_and_forward(stream, secret, forwarded).await;
                }
            });
            let local_auth: Arc<str> = Arc::from("7".repeat(64));
            let (proxy, _app, _store) = proxy_for(descriptor, &local_auth, Arc::new(RemoteRetry::default())).await;

            let mut caller = TcpStream::connect(proxy.local_addr()).await.unwrap();
            caller.write_all(format!(
                "POST /api/v1/files HTTP/1.1\r\nHost: localhost\r\nContent-Length: {length}\r\n{LOCAL_AUTH_HEADER}: {local_auth}\r\n\r\n"
            ).as_bytes()).await.unwrap();
            tokio::time::timeout(Duration::from_secs(2), accepted_rx.recv()).await.unwrap().unwrap();
            let body: Vec<u8> = (0..length).map(|index| (index % 251) as u8).collect();
            let expected = body.clone();
            // Held open: a close would drop the request.
            let writer = tokio::spawn(async move { caller.write_all(&body).await.unwrap(); caller });
            tokio::time::sleep(Duration::from_millis(100)).await;
            release.notify_one();
            let mut received = Vec::new();
            let end = loop {
                let bytes = tokio::time::timeout(Duration::from_secs(10), forwarded_rx.recv()).await.unwrap().unwrap();
                received.extend(bytes);
                if let Some(end) = received.windows(4).position(|w| w == b"\r\n\r\n") {
                    if received.len() >= end + 4 + length { break end + 4; }
                }
            };
            assert!(received.starts_with(b"POST /api/v1/files HTTP/1.1\r\n"));
            assert!(received[end..] == expected[..], "the body changed on its way through ({length} bytes)");
            let _caller = writer.await.unwrap();
            drop(proxy);
            server.abort();
        }
    }

    #[test]
    fn only_the_proxys_own_transient_errors_are_retryable() {
        for code in TRANSIENT_PROXY_ERRORS {
            assert_eq!(transient_proxy_error(Some(code), None), Some(code));
            let body = format!(r#"{{"code":"{code}","message":"x"}}"#);
            assert_eq!(transient_proxy_error(None, Some(body.as_bytes())), Some(code));
        }
        for code in ["remote_pairing_refused", "remote_proxy_unauthorized", "node_locked", "call_not_admitted"] {
            assert_eq!(transient_proxy_error(Some(code), None), None);
            let body = format!(r#"{{"code":"{code}","message":"x"}}"#);
            assert_eq!(transient_proxy_error(None, Some(body.as_bytes())), None);
        }
        assert_eq!(transient_proxy_error(None, Some(br#"{"error":"not admitted"}"#)), None);
        assert_eq!(transient_proxy_error(None, Some(b"Service Unavailable")), None);
        assert_eq!(transient_proxy_error(None, None), None);
    }

    // Skip one CONNECT_TIMEOUT on the virtual clock once the dead endpoint
    // holds an attempt. Real loopback IO runs on the real clock, because a
    // paused clock auto-advances while the runtime waits for socket events.
    async fn skip_dead_endpoint(accepts: &std::sync::atomic::AtomicUsize, expected: usize) {
        while accepts.load(std::sync::atomic::Ordering::SeqCst) < expected {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        tokio::time::pause();
        tokio::time::advance(CONNECT_TIMEOUT).await;
        tokio::time::resume();
    }

    // A box can advertise an address this device cannot reach (for example a
    // container bridge) before the reachable one. Only the first new tunnel
    // may pay the connect timeout for it.
    #[tokio::test]
    async fn new_tunnels_try_the_endpoint_that_last_worked_first() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead_endpoint = dead.local_addr().unwrap().to_string();
        let dead_accepts = Arc::new(AtomicUsize::new(0));
        let silent = tokio::spawn({
            let dead_accepts = dead_accepts.clone();
            async move {
                let mut held = Vec::new();
                loop {
                    // Accept the TCP connection, never answer the handshake.
                    held.push(dead.accept().await.unwrap().0);
                    dead_accepts.fetch_add(1, Ordering::SeqCst);
                }
            }
        });
        let live = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let live_endpoint = live.local_addr().unwrap().to_string();
        let secret = [62u8; 32];
        let node = SigningKey::from_bytes(&[61u8; 32]);
        let public = X25519PublicKey::from(&StaticSecret::from(secret)).to_bytes();
        let mut descriptor = parse_pairing_link(&signed_link(
            dead_endpoint.clone(), &node, public, &test_code(63),
        )).unwrap();
        descriptor.endpoints = vec![dead_endpoint, live_endpoint];
        let (forwarded, _forwarded_rx) = mpsc::unbounded_channel();
        let server = tokio::spawn(authenticating_responder(live, secret, forwarded));
        let store = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(store.path()).unwrap();

        let start = tokio::time::Instant::now();
        let (first, ()) = tokio::join!(
            connect_authenticated(&descriptor, &key, "test phone"),
            skip_dead_endpoint(&dead_accepts, 1),
        );
        assert!(first.is_ok(), "the second endpoint answers");
        assert!(start.elapsed() >= CONNECT_TIMEOUT, "{:?}", start.elapsed());
        assert_eq!(dead_accepts.load(Ordering::SeqCst), 1);

        // No clock skip this time: the remembered endpoint answers at once.
        let second = tokio::time::timeout(Duration::from_secs(2),
            connect_authenticated(&descriptor, &key, "test phone")).await
            .expect("the remembered endpoint is tried first, without a connect timeout");
        assert!(second.is_ok());
        assert_eq!(dead_accepts.load(Ordering::SeqCst), 1, "the unreachable endpoint is not tried again");

        // A descriptor that no longer lists the remembered endpoint falls back
        // to its own order.
        let mut moved = descriptor.clone();
        moved.endpoints.truncate(1);
        let (result, ()) = tokio::join!(
            connect_authenticated(&moved, &key, "test phone"),
            skip_dead_endpoint(&dead_accepts, 2),
        );
        assert!(result.is_err());
        assert_eq!(dead_accepts.load(Ordering::SeqCst), 2);
        silent.abort();
        server.abort();
    }

    // What a box does once it has the app's authentication request.
    enum AuthStage { Stall, Drop, Answer(Vec<u8>) }

    // Completes the handshake on every tunnel, then behaves as `stage` says.
    // Returns how many authentication requests arrived.
    fn box_failing_auth(listener: TcpListener, secret: [u8; 32], stage: AuthStage) -> (Arc<std::sync::atomic::AtomicUsize>, tokio::task::JoinHandle<()>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let requests = Arc::new(AtomicUsize::new(0));
        let counted = requests.clone();
        let server = tokio::spawn(async move {
            let mut held = Vec::new();
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let Ok(mut noise) = read_auth_request(&mut stream, secret).await else { continue };
                counted.fetch_add(1, Ordering::SeqCst);
                match &stage {
                    AuthStage::Stall => held.push(stream),
                    AuthStage::Drop => drop(stream),
                    AuthStage::Answer(answer) => {
                        let encrypted = encode_transport(&mut noise, answer).unwrap();
                        write_frame(&mut stream, &encrypted).await.unwrap();
                        held.push(stream);
                    }
                }
            }
        });
        (requests, server)
    }

    // Counts connections and answers nothing.
    fn counting_listener(listener: TcpListener) -> (Arc<std::sync::atomic::AtomicUsize>, tokio::task::JoinHandle<()>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let dials = Arc::new(AtomicUsize::new(0));
        let counted = dials.clone();
        let server = tokio::spawn(async move {
            let mut held = Vec::new();
            loop {
                held.push(listener.accept().await.unwrap().0);
                counted.fetch_add(1, Ordering::SeqCst);
            }
        });
        (dials, server)
    }

    // One box at two addresses. `seed` keeps its endpoint memory to this test.
    fn box_at_two_endpoints(seed: u8, first: &str, second: &str) -> ([u8; 32], RemoteDescriptor) {
        let secret = [seed; 32];
        let node = SigningKey::from_bytes(&[seed + 1; 32]);
        let public = X25519PublicKey::from(&StaticSecret::from(secret)).to_bytes();
        let mut descriptor = parse_pairing_link(&signed_link(first.to_owned(), &node, public, &test_code(seed + 2))).unwrap();
        descriptor.endpoints = vec![first.to_owned(), second.to_owned()];
        (secret, descriptor)
    }

    async fn loopback_listener() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = listener.local_addr().unwrap().to_string();
        (listener, endpoint)
    }

    // The memory is only replaced by a later success, so an endpoint that
    // finishes the handshake and then fails must not hold back the others.
    #[tokio::test]
    async fn a_remembered_endpoint_that_fails_in_auth_gives_way_to_the_next() {
        use std::sync::atomic::Ordering;
        for (seed, stage) in [(120u8, AuthStage::Stall), (130, AuthStage::Drop)] {
            let stalls = matches!(stage, AuthStage::Stall);
            let (remembered, remembered_endpoint) = loopback_listener().await;
            let (real, real_endpoint) = loopback_listener().await;
            let (secret, mut descriptor) = box_at_two_endpoints(seed, &remembered_endpoint, &real_endpoint);
            descriptor.code = None;
            let (requests, failing) = box_failing_auth(remembered, secret, stage);
            let (forwarded, _forwarded_rx) = mpsc::unbounded_channel();
            let server = tokio::spawn(authenticating_responder(real, secret, forwarded));
            let store = tempfile::tempdir().unwrap();
            let key = ClientKey::load_or_create(store.path()).unwrap();
            remember_endpoint(&descriptor, &remembered_endpoint);

            let first = if stalls {
                tokio::join!(
                    connect_authenticated(&descriptor, &key, "test phone"),
                    skip_dead_endpoint(&requests, 1),
                ).0
            } else {
                connect_authenticated(&descriptor, &key, "test phone").await
            };
            assert!(first.is_ok(), "the other endpoint answers: {:?}", first.err());
            assert_eq!(requests.load(Ordering::SeqCst), 1);

            // No clock skip: the endpoint that worked is tried first.
            let second = tokio::time::timeout(Duration::from_secs(2),
                connect_authenticated(&descriptor, &key, "test phone")).await
                .expect("the next tunnel starts at the endpoint that worked");
            assert!(second.is_ok());
            assert_eq!(requests.load(Ordering::SeqCst), 1, "the failing endpoint is not tried again");
            failing.abort();
            server.abort();
        }
    }

    #[tokio::test]
    async fn an_answer_in_auth_is_final_and_does_not_try_the_next_endpoint() {
        use std::sync::atomic::Ordering;
        let answer = |code: &str| serde_json::to_vec(&RemoteAuthResponse::Error {
            v: 1, code: code.into(), message: "unknown client".into(),
        }).unwrap();
        type Expected = fn(&RemoteError) -> bool;
        let cases: [(u8, Vec<u8>, Expected); 3] = [
            (140, answer("authentication_failed"), |error| matches!(error, RemoteError::Refused(_))),
            (150, answer("already_paired"), |error| matches!(error, RemoteError::AlreadyPaired)),
            (160, b"not an authentication reply".to_vec(), |error| matches!(error, RemoteError::Transport(m) if m.contains("wrong shape"))),
        ];
        for (seed, reply, expected) in cases {
            let (answering, answering_endpoint) = loopback_listener().await;
            let (other, other_endpoint) = loopback_listener().await;
            let (secret, mut descriptor) = box_at_two_endpoints(seed, &answering_endpoint, &other_endpoint);
            descriptor.code = None;
            let (requests, answers) = box_failing_auth(answering, secret, AuthStage::Answer(reply));
            let (dials, silent) = counting_listener(other);
            let store = tempfile::tempdir().unwrap();
            let key = ClientKey::load_or_create(store.path()).unwrap();
            remember_endpoint(&descriptor, &answering_endpoint);

            let error = connect_authenticated(&descriptor, &key, "test phone").await.expect_err("the box refused");
            assert!(expected(&error), "{error}");
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(requests.load(Ordering::SeqCst), 1);
            assert_eq!(dials.load(Ordering::SeqCst), 0, "{error}");
            assert_eq!(ordered_endpoints(&descriptor, vec![&other_endpoint, &answering_endpoint])[0], answering_endpoint,
                "an endpoint that answered stays remembered");
            answers.abort();
            silent.abort();
        }
    }

    // The first box may have consumed the ticket with no reply reaching the app.
    // Sending it to another endpoint could only turn that into a refusal.
    #[tokio::test]
    async fn a_one_time_code_is_not_sent_to_another_endpoint_after_an_auth_failure() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for (seed, stage) in [(170u8, AuthStage::Stall), (180, AuthStage::Drop)] {
            let stalls = matches!(stage, AuthStage::Stall);
            let (first, first_endpoint) = loopback_listener().await;
            let (other, other_endpoint) = loopback_listener().await;
            let (secret, descriptor) = box_at_two_endpoints(seed, &first_endpoint, &other_endpoint);
            assert!(descriptor.has_code());
            let (requests, failing) = box_failing_auth(first, secret, stage);
            let (dials, silent) = counting_listener(other);
            let store = tempfile::tempdir().unwrap();
            let key = ClientKey::load_or_create(store.path()).unwrap();
            let retired = AtomicUsize::new(0);
            let retire = || -> Result<(), RemoteError> {
                retired.fetch_add(1, Ordering::SeqCst);
                Ok(())
            };

            let connect = connect_bound(&descriptor, &key, "test phone", None, Some(&retire));
            let result = if stalls {
                tokio::join!(connect, skip_dead_endpoint(&requests, 1)).0
            } else {
                connect.await
            };
            let error = result.err().expect("no endpoint may pair");
            assert!(is_lost_connection(&error), "{error}");
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(requests.load(Ordering::SeqCst), 1);
            assert_eq!(dials.load(Ordering::SeqCst), 0, "the ticket stays with the first box");
            assert_eq!(retired.load(Ordering::SeqCst), 1);
            failing.abort();
            silent.abort();
        }
    }

    // With every endpoint failing, no success replaces the memory, so the one
    // that failed in auth has to be forgotten. Another endpoint's memory stays.
    #[tokio::test]
    async fn only_the_endpoint_that_failed_in_auth_is_forgotten() {
        let (failing_listener, failing_endpoint) = loopback_listener().await;
        let (closed, closed_endpoint) = loopback_listener().await;
        drop(closed);
        let (secret, mut descriptor) = box_at_two_endpoints(190, &closed_endpoint, &failing_endpoint);
        descriptor.code = None;
        let (_requests, failing) = box_failing_auth(failing_listener, secret, AuthStage::Drop);
        let store = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(store.path()).unwrap();
        let advertised = vec![closed_endpoint.as_str(), failing_endpoint.as_str()];

        remember_endpoint(&descriptor, &closed_endpoint);
        assert!(connect_authenticated(&descriptor, &key, "test phone").await.is_err());
        let reversed: Vec<&str> = advertised.iter().rev().copied().collect();
        assert_eq!(ordered_endpoints(&descriptor, reversed.clone())[0], closed_endpoint, "not the endpoint that failed");

        remember_endpoint(&descriptor, &failing_endpoint);
        assert!(connect_authenticated(&descriptor, &key, "test phone").await.is_err());
        assert_eq!(ordered_endpoints(&descriptor, advertised.clone()), advertised, "the memory is gone");
        failing.abort();
    }

    #[tokio::test]
    async fn proxy_caps_authenticated_local_connections() {
        let remote_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let remote_endpoint = remote_listener.local_addr().unwrap().to_string();
        let (accepted_tx, mut accepted_rx) = mpsc::channel(MAX_LOCAL_CONNECTIONS);
        let remote_server = tokio::spawn(async move {
            let mut held = Vec::new();
            loop {
                let (stream, _) = remote_listener.accept().await.unwrap();
                held.push(stream);
                accepted_tx.send(()).await.unwrap();
            }
        });

        let node = SigningKey::from_bytes(&[35u8; 32]);
        let responder_public = X25519PublicKey::from(&StaticSecret::from([36u8; 32])).to_bytes();
        let descriptor = parse_pairing_link(&signed_link(
            remote_endpoint,
            &node,
            responder_public,
            &test_code(10),
        ))
        .unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        persist_at(&config_path(app_dir.path()), &descriptor).unwrap();
        let pairing_store = tempfile::tempdir().unwrap();
        let key = Arc::new(ClientKey::load_or_create(pairing_store.path()).unwrap());
        let port_probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_addr = port_probe.local_addr().unwrap();
        drop(port_probe);
        let local_auth: Arc<str> = Arc::from("a".repeat(64));
        let proxy = start_proxy(
            &format!("http://{local_addr}/{}", "api/v1"),
            app_dir.path(),
            descriptor,
            key,
            "BitSov test",
            pairing_store.path().to_path_buf(),
            local_auth.clone(),
            Arc::new(RemoteRetry::default()),
        )
        .await
        .unwrap();

        let request = format!(
            "GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n{LOCAL_AUTH_HEADER}: {local_auth}\r\n\r\n"
        );
        let mut held_local = Vec::new();
        for _ in 0..MAX_LOCAL_CONNECTIONS - RESERVED_MEDIA_CONNECTIONS {
            let mut stream = TcpStream::connect(proxy.local_addr()).await.unwrap();
            stream.write_all(request.as_bytes()).await.unwrap();
            held_local.push(stream);
        }
        // Only the first handshake may be in flight. The remaining local
        // requests still occupy the bounded slots while awaiting its outcome.
        tokio::time::timeout(Duration::from_secs(1), accepted_rx.recv())
            .await.unwrap().unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(50), accepted_rx.recv()).await.is_err());

        let mut refused = TcpStream::connect(proxy.local_addr()).await.unwrap();
        refused.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(1), refused.read_to_end(&mut response))
            .await
            .unwrap();
        assert!(
            read.is_ok()
                || read.is_err_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset)
        );
        let response = String::from_utf8(response).unwrap();
        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable"));
        assert!(response.contains("remote_proxy_busy"));
        assert!(response.contains(&format!("{PROXY_ERROR_HEADER}: remote_proxy_busy\r\n")));

        // A call's media socket still gets the reserved slot (it queues for
        // the handshake like the others); a second one does not.
        let media = format!(
            "GET /api/v1/calls/0123456789abcdef0123456789abcdef/media?peer={} HTTP/1.1\r\nHost: localhost\r\n\
             Connection: Upgrade\r\nUpgrade: websocket\r\n{LOCAL_AUTH_HEADER}: {local_auth}\r\n\r\n", "ab".repeat(32)
        );
        let mut call_media = TcpStream::connect(proxy.local_addr()).await.unwrap();
        call_media.write_all(media.as_bytes()).await.unwrap();
        let mut byte = [0u8; 1];
        assert!(tokio::time::timeout(Duration::from_millis(200), call_media.read(&mut byte)).await.is_err(),
            "the media socket must not be turned away while HTTP holds every shared slot");
        let mut second_media = TcpStream::connect(proxy.local_addr()).await.unwrap();
        second_media.write_all(media.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(1), second_media.read_to_end(&mut response)).await.unwrap();
        assert!(String::from_utf8(response).unwrap().contains("remote_proxy_busy"));

        drop(call_media);
        drop(held_local);
        drop(proxy);
        remote_server.abort();
    }

    #[tokio::test]
    async fn silent_pre_auth_close_returns_stable_http_status() {
        refusal_blocks_poll_burst(false).await;
    }

    #[tokio::test]
    async fn framed_rate_limit_blocks_all_proxy_poll_retries() {
        refusal_blocks_poll_burst(true).await;
    }

    async fn refusal_blocks_poll_burst(hinted: bool) {
        let remote_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let remote_endpoint = remote_listener.local_addr().unwrap().to_string();
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = attempts.clone();
        let remote_server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = remote_listener.accept().await.unwrap();
                seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await;
                if hinted {
                    write_frame(
                        &mut stream,
                        br#"{"code":"rate_limited","v":1,"retry_after_secs":60}"#,
                    )
                    .await
                    .unwrap();
                }
                // Old nodes close without a hint; new nodes send one then close.
            }
        });

        let node = SigningKey::from_bytes(&[37u8; 32]);
        let responder_public = X25519PublicKey::from(&StaticSecret::from([38u8; 32])).to_bytes();
        let descriptor = parse_pairing_link(&signed_link(
            remote_endpoint,
            &node,
            responder_public,
            &test_code(11),
        ))
        .unwrap();
        let app_dir = tempfile::tempdir().unwrap();
        persist_at(&config_path(app_dir.path()), &descriptor).unwrap();
        let pairing_store = tempfile::tempdir().unwrap();
        let key = Arc::new(ClientKey::load_or_create(pairing_store.path()).unwrap());
        let port_probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_addr = port_probe.local_addr().unwrap();
        drop(port_probe);
        let local_auth: Arc<str> = Arc::from("b".repeat(64));
        let proxy = start_proxy(
            &format!("http://{local_addr}/{}", "api/v1"),
            app_dir.path(),
            descriptor,
            key,
            "BitSov test",
            pairing_store.path().to_path_buf(),
            local_auth.clone(),
            Arc::new(RemoteRetry::default()),
        )
        .await
        .unwrap();

        let mut local = TcpStream::connect(proxy.local_addr()).await.unwrap();
        local
            .write_all(
                format!(
                    "GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n{LOCAL_AUTH_HEADER}: {local_auth}\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(1), local.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        let response = String::from_utf8(response).unwrap();
        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable"));
        if hinted {
            assert!(response.contains("waiting 60 s"));
        } else {
            assert!(response.contains("remote_handshake_unavailable"));
            assert!(response.contains(HANDSHAKE_UNAVAILABLE));
        }
        for _ in 0..10 {
            let mut local = TcpStream::connect(proxy.local_addr()).await.unwrap();
            local.write_all(format!("GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n{LOCAL_AUTH_HEADER}: {local_auth}\r\n\r\n").as_bytes()).await.unwrap();
            let mut response = String::new();
            tokio::time::timeout(Duration::from_secs(1), local.read_to_string(&mut response))
                .await
                .unwrap()
                .unwrap();
            assert!(response.contains("remote_retry_wait"));
        }
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);

        remote_server.abort();
    }

    #[test]
    fn only_bounded_version_one_rate_limit_hints_are_used() {
        for seconds in [1, 3, 60] {
            assert_eq!(
                retry_hint(
                    format!(r#"{{"v":1,"code":"rate_limited","retry_after_secs":{seconds}}}"#)
                        .as_bytes()
                ),
                Some(seconds)
            );
        }
        for body in [
            r#"{"v":2,"code":"rate_limited","retry_after_secs":3}"#,
            r#"{"v":1,"code":"ok","retry_after_secs":3}"#,
            r#"{"v":1,"code":"rate_limited","retry_after_secs":0}"#,
            r#"{"v":1,"code":"rate_limited","retry_after_secs":61}"#,
            r#"{"v":1,"code":"rate_limited","retry_after_secs":-1}"#,
            r#"{"v":1,"code":"rate_limited","retry_after_secs":1.5}"#,
            r#"{"v":1,"code":"rate_limited","retry_after_secs":"60"}"#,
            r#"{"v":1,"code":"rate_limited"}"#,
            "not json",
        ] {
            assert_eq!(retry_hint(body.as_bytes()), None, "{body}");
        }
    }

    #[tokio::test]
    async fn framed_rate_limit_is_a_retry_hint_not_a_noise_failure() {
        let (mut app, mut node_stream) = tokio::io::duplex(4096);
        let node = SigningKey::from_bytes(&[37u8; 32]);
        let descriptor = parse_pairing_link(&signed_link(
            "127.0.0.1:1234".into(),
            &node,
            [38; 32],
            &test_code(11),
        ))
        .unwrap();
        let store = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(store.path()).unwrap();
        let server = tokio::spawn(async move {
            read_frame(&mut node_stream, MAX_HANDSHAKE_FRAME)
                .await
                .unwrap();
            write_frame(
                &mut node_stream,
                br#"{"code":"rate_limited","v":1,"retry_after_secs":60}"#,
            )
            .await
            .unwrap();
        });
        let error = pinned_handshake(&mut app, &descriptor, &key)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Remote connection limited; waiting 60 s");
        server.await.unwrap();
    }

    #[test]
    fn proxy_bind_is_loopback_only() {
        let api = |host: &str| format!("http://{host}:3141/{}", "api/v1");
        assert_eq!(
            loopback_addr(&api("127.0.0.1")).unwrap(),
            "127.0.0.1:3141".parse().unwrap()
        );
        assert_eq!(
            loopback_addr(&api("[::1]")).unwrap().ip(),
            IpAddr::V6(Ipv6Addr::LOCALHOST)
        );
        assert!(loopback_addr(&api("0.0.0.0")).is_err());
        assert!(loopback_addr(&api("node.example")).is_err());
        assert!(loopback_addr("https://127.0.0.1:3141/not-api-v1").is_err());
    }
}

#[cfg(test)]
#[path = "remote_access/home_tests.rs"]
mod home_tests;

#[cfg(test)]
mod onboarding_error_tests {
    use super::*;

    #[test]
    fn structured_errors_never_echo_remote_or_local_secrets() {
        for error in [RemoteError::Refused("SECRET_TICKET_SENTINEL".into()),
            RemoteError::Transport("SECRET_TICKET_SENTINEL".into()),
            RemoteError::Local("SECRET_TICKET_SENTINEL".into()),
            RemoteError::Invalid("SECRET_TICKET_SENTINEL".into())] {
            let wire = serde_json::to_string(&ConnectionError::from(&error)).unwrap();
            assert!(!wire.contains("SECRET_TICKET_SENTINEL"));
        }
    }

    #[test]
    fn ios_connect_permission_and_unavailable_classes_survive_mapping() {
        for kind in [std::io::ErrorKind::PermissionDenied, std::io::ErrorKind::NetworkDown, std::io::ErrorKind::NetworkUnreachable, std::io::ErrorKind::HostUnreachable] {
            let error = classify_connect_error(std::io::Error::from(kind), true, "192.168.1.2:3141");
            assert!(matches!(error, RemoteError::LocalNetwork));
            assert!(matches!(map_pre_auth_failure(error), RemoteError::LocalNetwork));
        }
        for kind in [std::io::ErrorKind::ConnectionRefused, std::io::ErrorKind::TimedOut, std::io::ErrorKind::NotFound] {
            assert!(matches!(classify_connect_error(std::io::Error::from(kind), true, "192.168.1.2:3141"), RemoteError::HandshakeUnavailable));
        }
        assert!(matches!(classify_connect_error(std::io::Error::from(std::io::ErrorKind::PermissionDenied), false, "192.168.1.2:3141"), RemoteError::HandshakeUnavailable));
        for endpoint in ["100.64.0.1:3141", "box.tailnet.ts.net:3141", "example.com:3141"] {
            assert!(matches!(classify_connect_error(std::io::Error::from(std::io::ErrorKind::NetworkUnreachable), true, endpoint), RemoteError::HandshakeUnavailable));
        }
        for endpoint in ["box.local:3141", "[fe80::123]:3141", "[fd00::123]:3141", "10.0.0.2:3141"] {
            assert!(matches!(classify_connect_error(std::io::Error::from(std::io::ErrorKind::NetworkDown), true, endpoint), RemoteError::LocalNetwork));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_macos_local_network_denial_points_at_the_setting() {
        for kind in [std::io::ErrorKind::PermissionDenied, std::io::ErrorKind::HostUnreachable] {
            let error = connect_error(std::io::Error::from(kind), "10.0.0.2:9735");
            assert!(matches!(error, RemoteError::LocalNetwork), "{kind:?}");
            assert!(error.to_string().contains("Local Network permission"));
        }
        assert!(matches!(connect_error(std::io::Error::from(std::io::ErrorKind::TimedOut), "10.0.0.2:9735"), RemoteError::HandshakeUnavailable));
        assert!(matches!(connect_error(std::io::Error::from(std::io::ErrorKind::HostUnreachable), "example.com:9735"), RemoteError::HandshakeUnavailable));
    }

    #[test]
    fn ios_local_network_usage_copy_explains_box_connection_and_recovery() {
        let plist = include_str!("../Info.ios.plist");
        let copy = plist.split("<key>NSLocalNetworkUsageDescription</key>").nth(1).unwrap().split("</string>").next().unwrap();
        assert!(copy.contains("connect to your box"));
        assert!(copy.contains("local network"));
        assert!(!copy.contains("claim code"));
        let generated = include_str!("../gen/apple/bitsov-app_iOS/Info.plist");
        let generated_copy = generated.split("<key>NSLocalNetworkUsageDescription</key>").nth(1).unwrap()
            .split("</string>").next().unwrap().split("<string>").nth(1).unwrap();
        assert_eq!(generated_copy, copy.split("<string>").nth(1).unwrap());
    }
}

#[cfg(test)]
#[path = "remote_access/second_tests.rs"]
pub(crate) mod second_tests;

/// Preparation entry point; production persistence is unchanged.
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
pub(crate) fn persist_linux_candidate(path: &Path, descriptor: &RemoteDescriptor, sealer: Option<&dyn Sealer>) -> Result<(), RemoteError> {
    let sealer = at_rest::linux::required(sealer).map_err(RemoteError::Local)?;
    let _config = REMOTE_CONFIG_LOCK.lock().unwrap();
    match std::fs::symlink_metadata(path) {
        Ok(_) => { load_with(path, Some(&sealer))?; }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(RemoteError::Local(format!("cannot inspect remote descriptor: {error}"))),
    }
    persist_with(path, descriptor, Some(&sealer))
}

/// Preparation entry point; production loading is unchanged.
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
pub(crate) fn load_linux_candidate(path: &Path, sealer: Option<&dyn Sealer>) -> Result<Option<RemoteDescriptor>, RemoteError> {
    let sealer = at_rest::linux::required(sealer).map_err(RemoteError::Local)?;
    let _config = REMOTE_CONFIG_LOCK.lock().unwrap();
    load_with(path, Some(&sealer))
}
