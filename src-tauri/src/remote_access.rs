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
use tokio::sync::watch;
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
const MAX_LINK_BYTES: usize = 8 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

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
    pub node_id: String,
    pub restart_required: bool,
}

#[derive(Debug)]
pub enum RemoteError {
    Invalid(String),
    Local(String),
    Transport(String),
    Refused(String),
}

impl fmt::Display for RemoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "invalid remote pairing link: {message}"),
            Self::Local(message) => f.write_str(message),
            Self::Transport(message) => write!(f, "remote transport failed: {message}"),
            Self::Refused(message) => write!(f, "remote node refused pairing: {message}"),
        }
    }
}

impl std::error::Error for RemoteError {}

/// Exact UTF-8 string signed by the node for the pairing link.
pub fn descriptor_signature_message(node_id_hex: &str, transport_pubkey_hex: &str) -> String {
    format!("{TRANSPORT_PROOF_DOMAIN}:{node_id_hex}:{transport_pubkey_hex}")
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
        node_id: descriptor.node_id.clone(),
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
    mut remote: TcpStream,
    mut noise: TransportState,
) -> Result<(), RemoteError> {
    let mut local_buffer = vec![0u8; MAX_NOISE_PLAINTEXT];
    loop {
        tokio::select! {
            read = local.read(&mut local_buffer) => {
                let read = read.map_err(|e| RemoteError::Transport(format!("loopback read failed: {e}")))?;
                if read == 0 {
                    return Ok(());
                }
                let encrypted = encode_transport(&mut noise, &local_buffer[..read])?;
                write_frame(&mut remote, &encrypted).await?;
            }
            frame = read_frame(&mut remote, MAX_TRANSPORT_FRAME) => {
                let frame = frame?;
                let plaintext = decode_transport(&mut noise, &frame, MAX_NOISE_PLAINTEXT)?;
                local.write_all(&plaintext)
                    .await
                    .map_err(|e| RemoteError::Transport(format!("loopback write failed: {e}")))?;
            }
        }
    }
}

async fn serve_connection(
    local: TcpStream,
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
    let mut remote = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(snapshot.endpoint()))
        .await
        .map_err(|_| RemoteError::Transport("connection timed out".into()))?
        .map_err(|e| RemoteError::Transport(format!("cannot connect to endpoint: {e}")))?;
    let mut noise = pinned_handshake(&mut remote, &snapshot, &key).await?;
    let (client_id, scopes) =
        encrypted_auth(&mut remote, &mut noise, &snapshot, &key, &client_name).await?;

    {
        let mut current = descriptor
            .lock()
            .map_err(|_| RemoteError::Local("remote descriptor lock is poisoned".into()))?;
        if current.code.is_some() {
            current.code = None;
            if let Err(error) = persist_at(&config_path, &current) {
                // Fail closed: never leave a confirmed one-time code available
                // for replay after restart if the atomic replacement failed.
                let _ = std::fs::remove_file(&config_path);
                return Err(error);
            }
        }
        // Serialize the fixed-name atomic temp file across concurrent HTTP
        // connections. Saving on reuse also repairs an interrupted first save.
        pairing::save_remote_record(&pairing_store, &key, client_id, scopes)
            .map_err(|e| RemoteError::Local(e.to_string()))?;
    }
    tunnel(local, remote, noise).await
}

/// Process-local listener. Dropping or stopping it closes the listener and
/// asks all accepted connection tasks to close.
pub struct RemoteProxy {
    local_addr: SocketAddr,
    shutdown: watch::Sender<bool>,
}

impl RemoteProxy {
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
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

    tokio::spawn({
        let descriptor = descriptor.clone();
        let key = key.clone();
        async move {
            loop {
                tokio::select! {
                    changed = stopped.changed() => {
                        if changed.is_err() || *stopped.borrow() {
                            break;
                        }
                    }
                    accepted = listener.accept() => {
                        let Ok((stream, peer)) = accepted else {
                            break;
                        };
                        if !peer.ip().is_loopback() {
                            continue;
                        }
                        let descriptor = descriptor.clone();
                        let config_path = config_path.clone();
                        let key = key.clone();
                        let client_name = client_name.clone();
                        let pairing_store = pairing_store.clone();
                        let mut connection_stopped = stopped.clone();
                        tokio::spawn(async move {
                            tokio::select! {
                                _ = connection_stopped.changed() => {}
                                result = serve_connection(
                                    stream,
                                    descriptor,
                                    config_path,
                                    key,
                                    client_name,
                                    pairing_store,
                                ) => {
                                    if let Err(error) = result {
                                        // Never include descriptors, auth JSON, or codes.
                                        eprintln!("[remote] connection closed: {error}");
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
