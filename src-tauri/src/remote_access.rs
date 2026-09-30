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
}

impl fmt::Display for RemoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "invalid remote pairing link: {message}"),
            Self::Local(message) => f.write_str(message),
            Self::Transport(message) => write!(f, "remote transport failed: {message}"),
            Self::Refused(message) => write!(f, "remote node refused pairing: {message}"),
            Self::HandshakeUnavailable => f.write_str(HANDSHAKE_UNAVAILABLE),
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
    writer
        .write_all(&(frame.len() as u32).to_be_bytes())
        .await
        .map_err(|e| RemoteError::Transport(format!("cannot write frame length: {e}")))?;
    writer
        .write_all(frame)
        .await
        .map_err(|e| RemoteError::Transport(format!("cannot write frame: {e}")))
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

async fn pinned_handshake(
    stream: &mut TcpStream,
    descriptor: &RemoteDescriptor,
    key: &ClientKey,
) -> Result<TransportState, RemoteError> {
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
}

async fn encrypted_auth(
    stream: &mut TcpStream,
    noise: &mut TransportState,
    descriptor: &RemoteDescriptor,
    key: &ClientKey,
    client_name: &str,
) -> Result<(String, Vec<String>), RemoteError> {
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
}

async fn tunnel(
    mut local: TcpStream,
    remote: TcpStream,
    mut noise: TransportState,
    initial_local: Vec<u8>,
) -> Result<(), RemoteError> {
    let (mut remote_reader, mut remote_writer) = remote.into_split();
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
            read = local.read(&mut local_buffer) => {
                let read = read.map_err(|e| RemoteError::Transport(format!("loopback read failed: {e}")))?;
                if read == 0 {
                    return Ok(());
                }
                let encrypted = encode_transport(&mut noise, &local_buffer[..read])?;
                write_frame(&mut remote_writer, &encrypted).await?;
            }
            frame = frames_rx.recv() => {
                let frame = frame.ok_or_else(|| {
                    RemoteError::Transport("remote framed reader stopped unexpectedly".into())
                })??;
                let plaintext = decode_transport(&mut noise, &frame, MAX_NOISE_PLAINTEXT)?;
                local.write_all(&plaintext)
                    .await
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

#[cfg(test)]
fn request_has_local_auth(prefix: &[u8], expected: &str) -> bool {
    strip_local_auth_header(prefix, expected).is_some()
}

fn strip_local_auth_header(prefix: &[u8], expected: &str) -> Option<Vec<u8>> {
    let header_end = prefix.windows(4).position(|window| window == b"\r\n\r\n")?;
    let Ok(head) = std::str::from_utf8(&prefix[..header_end]) else {
        return None;
    };
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?;
    if request_line.is_empty() || request_line.starts_with(char::is_whitespace) {
        return None;
    }
    let mut presented = None;
    let mut sanitized = Vec::with_capacity(prefix.len());
    sanitized.extend_from_slice(request_line.as_bytes());
    sanitized.extend_from_slice(b"\r\n");
    for line in lines {
        if line.starts_with([' ', '\t']) {
            return None;
        }
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case(LOCAL_AUTH_HEADER) {
            if presented.is_some() {
                return None;
            }
            presented = Some(value.trim());
        } else {
            sanitized.extend_from_slice(line.as_bytes());
            sanitized.extend_from_slice(b"\r\n");
        }
    }
    if !auth_token_matches(expected, presented) {
        return None;
    }
    sanitized.extend_from_slice(b"\r\n");
    sanitized.extend_from_slice(&prefix[header_end + 4..]);
    Some(sanitized)
}

async fn authenticated_prefix(
    local: &mut TcpStream,
    expected: &str,
) -> Result<Vec<u8>, RemoteError> {
    let read = async {
        let mut prefix = Vec::with_capacity(4096);
        loop {
            if prefix.len() >= MAX_LOCAL_REQUEST_PREFIX {
                return Err(RemoteError::Local(
                    "remote proxy request headers exceed the limit".into(),
                ));
            }
            let remaining = MAX_LOCAL_REQUEST_PREFIX - prefix.len();
            let mut buffer = vec![0u8; remaining.min(4096)];
            let count = local.read(&mut buffer).await.map_err(|error| {
                RemoteError::Local(format!("cannot read local request: {error}"))
            })?;
            if count == 0 {
                return Err(RemoteError::Local(
                    "local request closed before authentication".into(),
                ));
            }
            prefix.extend_from_slice(&buffer[..count]);
            if prefix.windows(4).any(|window| window == b"\r\n\r\n") {
                return strip_local_auth_header(&prefix, expected).ok_or_else(|| {
                    RemoteError::Local(
                        "remote proxy rejected unauthenticated local connection".into(),
                    )
                });
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
                || message == "connection timed out" =>
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
    let _ = local.write_all(response.as_bytes()).await;
    let _ = local.shutdown().await;
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

async fn serve_connection(
    mut local: TcpStream,
    initial_local: Vec<u8>,
    descriptor: Arc<Mutex<RemoteDescriptor>>,
    config_path: PathBuf,
    key: Arc<ClientKey>,
    client_name: Arc<str>,
    pairing_store: PathBuf,
) -> Result<(), RemoteError> {
    let snapshot = descriptor
        .lock()
        .map_err(|_| RemoteError::Local("remote descriptor lock is poisoned".into()))?
        .clone();
    let remote_result =
        tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(snapshot.endpoint()))
            .await
            .map_err(|_| RemoteError::Transport("connection timed out".into()))
            .and_then(|result| {
                result
                    .map_err(|e| RemoteError::Transport(format!("cannot connect to endpoint: {e}")))
            })
            .map_err(map_pre_auth_failure);
    let mut remote = match remote_result {
        Ok(remote) => remote,
        Err(error) => {
            if matches!(error, RemoteError::HandshakeUnavailable) {
                write_proxy_error(
                    &mut local,
                    "503 Service Unavailable",
                    "remote_handshake_unavailable",
                    HANDSHAKE_UNAVAILABLE,
                )
                .await;
            }
            return Err(error);
        }
    };
    let mut noise = match pinned_handshake(&mut remote, &snapshot, &key)
        .await
        .map_err(map_pre_auth_failure)
    {
        Ok(noise) => noise,
        Err(error) => {
            if matches!(error, RemoteError::HandshakeUnavailable) {
                write_proxy_error(
                    &mut local,
                    "503 Service Unavailable",
                    "remote_handshake_unavailable",
                    HANDSHAKE_UNAVAILABLE,
                )
                .await;
            }
            return Err(error);
        }
    };
    let (client_id, scopes) =
        match encrypted_auth(&mut remote, &mut noise, &snapshot, &key, &client_name)
            .await
            .map_err(map_pre_auth_failure)
        {
            Ok(auth) => auth,
            Err(error) => {
                if matches!(error, RemoteError::HandshakeUnavailable) {
                    write_proxy_error(
                        &mut local,
                        "503 Service Unavailable",
                        "remote_handshake_unavailable",
                        HANDSHAKE_UNAVAILABLE,
                    )
                    .await;
                }
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
    tunnel(local, remote, noise, initial_local).await
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

pub async fn start_proxy(
    api_base: &str,
    app_data_dir: &Path,
    descriptor: RemoteDescriptor,
    key: Arc<ClientKey>,
    client_name: &str,
    pairing_store: PathBuf,
    local_auth: Arc<str>,
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
                        let mut connection_stopped = stopped.clone();
                        tokio::spawn(async move {
                            let initial_local =
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
                                    stream,
                                    initial_local,
                                    descriptor,
                                    config_path,
                                    key,
                                    client_name,
                                    pairing_store,
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

    async fn fragmented_reply_survives_outgoing_local_traffic(split_at: usize) {
        let local_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_client = TcpStream::connect(local_listener.local_addr().unwrap())
            .await
            .unwrap();
        let (local_proxy, _) = local_listener.accept().await.unwrap();

        let remote_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let remote_proxy = TcpStream::connect(remote_listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut remote_node, _) = remote_listener.accept().await.unwrap();

        let (app_noise, mut node_noise) = transport_pair();
        let bridge = tokio::spawn(tunnel(local_proxy, remote_proxy, app_noise, Vec::new()));
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
        let outgoing = b"GET /api/v1/health HTTP/1.1\r\n\r\n";
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
            outgoing
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
        let sanitized = strip_local_auth_header(request, "abc123").unwrap();
        assert_eq!(
            sanitized,
            b"POST /api/v1/messages HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\nbody"
        );
        assert!(!sanitized
            .windows(LOCAL_AUTH_HEADER.len())
            .any(|window| window.eq_ignore_ascii_case(LOCAL_AUTH_HEADER.as_bytes())));
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
        for _ in 0..MAX_LOCAL_CONNECTIONS {
            tokio::time::timeout(Duration::from_secs(1), accepted_rx.recv())
                .await
                .unwrap()
                .unwrap();
        }

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
        let remote_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let remote_endpoint = remote_listener.local_addr().unwrap().to_string();
        let remote_server = tokio::spawn(async move {
            let (mut stream, _) = remote_listener.accept().await.unwrap();
            let _ = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await;
            // Simulate a node silently enforcing its handshake/rate limit.
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
        assert!(response.contains("remote_handshake_unavailable"));
        assert!(response.contains(HANDSHAKE_UNAVAILABLE));

        remote_server.await.unwrap();
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
