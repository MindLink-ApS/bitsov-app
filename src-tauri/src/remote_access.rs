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

use crate::pairing::{self, ClientKey};
use crate::connection_retry::RemoteRetry;

/// Exact Noise protocol used by both app and node ingress.
pub const NOISE_PROTOCOL: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2s";
pub const TRANSPORT_PROOF_DOMAIN: &str = "bitsov-remote-transport-v1";
pub const PAIRING_PROOF_DOMAIN: &str = "bitsov-remote-pair-v1";
/// BLAKE3 KDF context for deriving an X25519 secret from the app Ed25519 seed.
pub const CLIENT_TRANSPORT_KDF_CONTEXT: &str = "bitsov remote access client x25519 static v1";

pub const REMOTE_CONFIG_DIR: &str = "remote-access";
pub const REMOTE_CONFIG_FILE: &str = "descriptor.json";
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
const MAX_PENDING_LOCAL_AUTH: usize = 16;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
pub const HANDSHAKE_UNAVAILABLE: &str = "remote handshake limit or endpoint unavailable";

/// Pairing-link JSON carried as unpadded base64url after `bitsov://pair/`.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairingLinkV1 {
    pub v: u8,
    pub endpoint: String,
    pub node_id: String,
    pub transport_pubkey: String,
    pub transport_signature: String,
    pub code: String,
}

impl fmt::Debug for PairingLinkV1 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairingLinkV1")
            .field("v", &self.v)
            .field("endpoint", &self.endpoint)
            .field("node_id", &self.node_id)
            .field("transport_pubkey", &self.transport_pubkey)
            .field("transport_signature", &self.transport_signature)
            .field("has_code", &true)
            .finish()
    }
}

/// Validated, persisted descriptor. Byte forms are retained for pin checks and
/// proof construction; its `Debug` implementation never includes the code.
#[derive(Clone, Serialize, Deserialize)]
pub struct RemoteDescriptor {
    v: u8,
    endpoint: String,
    node_id: String,
    transport_pubkey: String,
    transport_signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip)]
    transport_pubkey_bytes: [u8; 32],
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
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    pub fn has_code(&self) -> bool {
        self.code.is_some()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredDescriptor {
    v: u8,
    endpoint: String,
    node_id: String,
    transport_pubkey: String,
    transport_signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    code: Option<String>,
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
    },
    Error {
        v: u8,
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteImportView {
    pub endpoint: String,
    pub node_id_fingerprint: String,
    pub restart_required: bool,
}

#[derive(Debug)]
pub enum RemoteError {
    Invalid(String),
    Local(String),
    Transport(String),
    Refused(String),
    HandshakeUnavailable,
    RateLimited(u64),
    Waiting(u64),
}

impl fmt::Display for RemoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "invalid remote pairing link: {message}"),
            Self::Local(message) => f.write_str(message),
            Self::Transport(message) => write!(f, "remote transport failed: {message}"),
            Self::Refused(message) => write!(f, "remote node refused pairing: {message}"),
            Self::HandshakeUnavailable => f.write_str(HANDSHAKE_UNAVAILABLE),
            Self::RateLimited(seconds) => write!(f, "Remote connection limited; waiting {seconds} s"),
            Self::Waiting(seconds) => write!(f, "Remote connection unavailable; waiting {seconds} s"),
        }
    }
}

impl std::error::Error for RemoteError {}

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
    getrandom::getrandom(&mut token).map_err(|error| {
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

fn endpoint_parts(endpoint: &str) -> Result<(&str, u16), RemoteError> {
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
    if stored.v != 1 {
        return Err(RemoteError::Invalid(
            "unsupported descriptor version".into(),
        ));
    }
    endpoint_parts(&stored.endpoint)?;
    validate_code(stored.code.as_deref())?;
    let node_id_bytes = decode_hex::<32>(&stored.node_id, "node_id")?;
    let transport_pubkey_bytes = decode_hex::<32>(&stored.transport_pubkey, "transport_pubkey")?;
    if transport_pubkey_bytes.iter().all(|byte| *byte == 0) {
        return Err(RemoteError::Invalid(
            "transport_pubkey cannot be all zero".into(),
        ));
    }
    let signature_vec = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&stored.transport_signature)
        .map_err(|_| {
            RemoteError::Invalid("transport_signature must be unpadded base64url".into())
        })?;
    if base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&signature_vec)
        != stored.transport_signature
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
            descriptor_signature_message(&stored.node_id, &stored.transport_pubkey).as_bytes(),
            &Signature::from_bytes(&signature_bytes),
        )
        .map_err(|_| {
            RemoteError::Invalid(
                "transport_signature does not bind this key to the node identity".into(),
            )
        })?;

    Ok(RemoteDescriptor {
        v: stored.v,
        endpoint: stored.endpoint,
        node_id: stored.node_id,
        transport_pubkey: stored.transport_pubkey,
        transport_signature: stored.transport_signature,
        code: stored.code,
        transport_pubkey_bytes,
    })
}

fn validate_link(link: PairingLinkV1) -> Result<RemoteDescriptor, RemoteError> {
    validate_descriptor(StoredDescriptor {
        v: link.v,
        endpoint: link.endpoint,
        node_id: link.node_id,
        transport_pubkey: link.transport_pubkey,
        transport_signature: link.transport_signature,
        code: Some(link.code),
    })
}

pub fn parse_pairing_link(link: &str) -> Result<RemoteDescriptor, RemoteError> {
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
    let link: PairingLinkV1 = serde_json::from_slice(&json)
        .map_err(|_| RemoteError::Invalid("descriptor JSON has the wrong shape".into()))?;
    validate_link(link)
}

fn config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir
        .join(REMOTE_CONFIG_DIR)
        .join(REMOTE_CONFIG_FILE)
}

fn persist_at(path: &Path, descriptor: &RemoteDescriptor) -> Result<(), RemoteError> {
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
    let bytes = serde_json::to_vec(descriptor)
        .map_err(|_| RemoteError::Local("cannot serialize remote descriptor".into()))?;
    let result = std::io::Write::write_all(&mut file, &bytes)
        .and_then(|()| file.sync_all())
        .and_then(|()| std::fs::rename(&tmp, path));
    if let Err(error) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(RemoteError::Local(format!(
            "cannot persist remote descriptor: {error}"
        )));
    }
    Ok(())
}

pub fn import_pairing_link(
    app_data_dir: &Path,
    link: &str,
) -> Result<RemoteImportView, RemoteError> {
    let descriptor = parse_pairing_link(link)?;
    persist_at(&config_path(app_data_dir), &descriptor)?;
    Ok(RemoteImportView {
        endpoint: descriptor.endpoint.clone(),
        node_id_fingerprint: node_id_fingerprint(&descriptor.node_id),
        restart_required: true,
    })
}

pub fn load_persisted(app_data_dir: &Path) -> Result<Option<RemoteDescriptor>, RemoteError> {
    let path = config_path(app_data_dir);
    if !path.exists() {
        return Ok(None);
    }
    pairing::key::check_owner_only(&path, "remote access descriptor")
        .map_err(|e| RemoteError::Local(e.to_string()))?;
    let bytes = std::fs::read(&path)
        .map_err(|e| RemoteError::Local(format!("cannot read remote descriptor: {e}")))?;
    if bytes.len() > MAX_LINK_BYTES {
        return Err(RemoteError::Local(
            "the remote access descriptor is oversized".into(),
        ));
    }
    let persisted: StoredDescriptor = serde_json::from_slice(&bytes)
        .map_err(|_| RemoteError::Local("the remote access descriptor is corrupt".into()))?;
    validate_descriptor(persisted).map(Some)
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

async fn pinned_handshake<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    descriptor: &RemoteDescriptor,
    key: &ClientKey,
) -> Result<TransportState, RemoteError> {
    tokio::time::timeout(CONNECT_TIMEOUT, async {
        let (secret, _) = derived_transport_key(key);
        let params = NOISE_PROTOCOL
            .parse()
            .map_err(|_| RemoteError::Local("invalid built-in Noise protocol".into()))?;
        let mut noise = Builder::new(params)
            .local_private_key(&secret)
            .build_initiator()
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
        if responder != descriptor.transport_pubkey_bytes {
            return Err(RemoteError::Transport(
                "Noise responder static key does not match the pairing link".into(),
            ));
        }

        let length = noise
            .write_message(&[], &mut output)
            .map_err(|e| RemoteError::Transport(format!("Noise message 3 failed: {e}")))?;
        write_frame(stream, &output[..length]).await?;
        noise
            .into_transport_mode()
            .map_err(|e| RemoteError::Transport(format!("Noise transport transition failed: {e}")))
    }).await.map_err(|_| RemoteError::HandshakeUnavailable)?
}

async fn encrypted_auth<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    noise: &mut TransportState,
    descriptor: &RemoteDescriptor,
    key: &ClientKey,
    client_name: &str,
) -> Result<(String, Vec<String>), RemoteError> {
    tokio::time::timeout(CONNECT_TIMEOUT, async {
        let request = serde_json::to_vec(&auth_request(descriptor, key, client_name))
            .map_err(|_| RemoteError::Local("cannot serialize remote authentication".into()))?;
        if request.is_empty() || request.len() > MAX_AUTH_PLAINTEXT {
            return Err(RemoteError::Local(
                "remote authentication request is oversized".into(),
            ));
        }
        let encrypted = encode_transport(noise, &request)?;
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
                Ok((client_id, scopes))
            }
            RemoteAuthResponse::Error { v, code, message } => {
                if v != 1 {
                    return Err(RemoteError::Transport(
                        "authentication reply has an unsupported version".into(),
                    ));
                }
                let reason: String = format!("{code}: {message}").chars().take(160).collect();
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
    match error {
        RemoteError::Transport(message)
            if message.starts_with("cannot read frame")
                || message.starts_with("cannot write frame")
                || message.starts_with("cannot connect to endpoint")
                || message == "connection timed out"
                || message == "frame write timed out" =>
        {
            RemoteError::HandshakeUnavailable
        }
        other => other,
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

async fn write_proxy_error(local: &mut TcpStream, status: &str, code: &str, message: &str) {
    let body = format!(r#"{{"code":"{code}","message":"{message}"}}"#);
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
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
        RemoteError::Refused(_) => ("403 Forbidden", "remote_pairing_refused", "remote node refused pairing"),
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
    let mut remote =
        tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(descriptor.endpoint()))
            .await
            .map_err(|_| RemoteError::HandshakeUnavailable)?
            .map_err(|_| RemoteError::HandshakeUnavailable)?;
    let mut noise = pinned_handshake(&mut remote, descriptor, key)
        .await
        .map_err(map_pre_auth_failure)?;
    let (client_id, scopes) = encrypted_auth(&mut remote, &mut noise, descriptor, key, client_name)
        .await
        .map_err(map_pre_auth_failure)?;
    Ok((remote, noise, client_id, scopes))
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
    let (_remote, _noise, client_id, scopes) = retry
        .run(|| connect_authenticated(&descriptor, key, client_name))
        .await?;

    let descriptor = Mutex::new(descriptor);
    finalize_authenticated_pairing(
        &descriptor,
        &config_path(app_data_dir),
        pairing_store,
        key,
        client_id,
        scopes,
    )?;
    descriptor
        .into_inner()
        .map_err(|_| RemoteError::Local("remote descriptor lock is poisoned".into()))
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
        http: local_http,
        initial: initial_local,
    } = local;
    let snapshot = descriptor
        .lock()
        .map_err(|_| RemoteError::Local("remote descriptor lock is poisoned".into()))?
        .clone();
    let (remote, noise, client_id, scopes) = match retry
        .run(|| connect_authenticated(&snapshot, &key, &client_name))
        .await
    {
        Ok(connection) => connection,
        Err(error) => {
            write_connection_error(&mut local, &error).await;
            return Err(error);
        }
    };

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
    local_addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl RemoteProxy {
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
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
/// leaving the proxy's eighth slot for the live WebSocket. Local connect stays
/// bounded, while WAN requests have time to complete without losing the tunnel.
pub fn http_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .pool_max_idle_per_host(MAX_LOCAL_CONNECTIONS - 1)
        .pool_idle_timeout(Duration::from_secs(55))
        .timeout(Duration::from_secs(15))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
}

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
    // HTTP keep-alive and WebSocket connections each retain one remote
    // TCP/Noise tunnel. Independent byte streams are never interleaved; this
    // bounded set is the safe reusable pool without adding a mux wire protocol.
    let tunnel_permits = Arc::new(Semaphore::new(MAX_LOCAL_CONNECTIONS));
    let auth_permits = Arc::new(Semaphore::new(MAX_PENDING_LOCAL_AUTH));
    let last_error = Arc::new(Mutex::new(None));

    tokio::spawn({
        let descriptor = descriptor.clone();
        let key = key.clone();
        let last_error = last_error.clone();
        async move {
            let mut accept_backoff = Duration::from_millis(10);
            loop {
                tokio::select! {
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
                        let retry = retry.clone();
                        let mut connection_stopped = stopped.clone();
                        tokio::spawn(async move {
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
                            let Ok(tunnel_permit) = tunnel_permits.try_acquire_owned() else {
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
        }
    });

    Ok(RemoteProxy {
        local_addr: actual_addr,
        shutdown,
        last_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::net::IpAddr;
    use std::os::unix::fs::PermissionsExt;

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
        };
        let json = serde_json::to_vec(&payload).unwrap();
        format!(
            "bitsov://pair/{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
        )
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

    #[test]
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

    fn transport_pair() -> (TransportState, TransportState) {
        let params: snow::params::NoiseParams = NOISE_PROTOCOL.parse().unwrap();
        let initiator_secret = [41u8; 32];
        let responder_secret = [42u8; 32];
        let mut initiator = Builder::new(params.clone())
            .local_private_key(&initiator_secret)
            .build_initiator()
            .unwrap();
        let mut responder = Builder::new(params)
            .local_private_key(&responder_secret)
            .build_responder()
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
        let result = tokio::time::timeout(Duration::from_secs(6), encrypted_auth(&mut app, &mut noise, &descriptor, &key, "test")).await;
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

    async fn responder(listener: TcpListener, secret: [u8; 32]) -> Result<(), RemoteError> {
        let (mut stream, _) = listener.accept().await.unwrap();
        let params = NOISE_PROTOCOL.parse().unwrap();
        let mut noise = Builder::new(params)
            .local_private_key(&secret)
            .build_responder()
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
            .build_responder()
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
            .local_private_key(&secret).build_responder().unwrap();
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
        let local_base = format!("http://{}/api/v1", probe.local_addr().unwrap());
        drop(probe);
        let proxy = start_proxy(&local_base, app_dir.path(), descriptor,
            key, "polling test", store.path().to_path_buf(), auth.clone(), retry.clone()).await.unwrap();
        let client = http_client_builder().build().unwrap();
        let url = format!("http://{}/api/v1/status", proxy.local_addr());
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
        for _ in 0..MAX_LOCAL_CONNECTIONS {
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
