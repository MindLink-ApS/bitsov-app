//! Test harness for the pairing client: mock-node's in-memory `/pair/*` state
//! machine behind a loopback listener on an ephemeral port, with real Ed25519
//! and the #77 BLAKE3 derivations injected.
//!
//! mock-node itself stays socket-free and dependency-free (the Jarvis sit-mock
//! guard); the listener and crypto live here, in test code only.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use bitsov_app::pairing::PrintedCodes;
use mock_node::pairing::{PairCrypto, PairRoutes, PairingMock, PairingMockConfig};

/// The node's port. Tests must never bind it.
const NODE_PORT: u16 = 3141;

/// Real crypto, matching `konsensus-api/src/pairing.rs` at #77.
pub struct NodeCrypto;

impl PairCrypto for NodeCrypto {
    fn random(&self, out: &mut [u8]) {
        getrandom::getrandom(out).expect("getrandom");
    }

    fn verify(&self, pubkey_hex: &str, message: &[u8], signature_hex: &str) -> bool {
        let Ok(pk) = hex::decode(pubkey_hex) else { return false };
        let Ok(pk) = <[u8; 32]>::try_from(pk.as_slice()) else { return false };
        let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(&pk) else { return false };
        let Ok(sig) = hex::decode(signature_hex) else { return false };
        let Ok(sig) = ed25519_dalek::Signature::from_slice(&sig) else { return false };
        key.verify_strict(message, &sig).is_ok()
    }

    /// Independent copy of the node's `short_code`, so the app's derivation is
    /// cross-checked rather than compared with itself.
    fn short_code(&self, challenge: &[u8]) -> String {
        const ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
        let digest = blake3::keyed_hash(blake3::hash(b"bitsov-pair-shortcode-v1").as_bytes(), challenge);
        let mut out = String::new();
        for (i, b) in digest.as_bytes().iter().take(8).enumerate() {
            if i == 4 {
                out.push('-');
            }
            out.push(ALPHABET[(*b as usize) % ALPHABET.len()] as char);
        }
        out
    }

    fn client_id(&self, pubkey_hex: &str) -> String {
        let digest = blake3::keyed_hash(
            blake3::hash(b"bitsov-pair-client-id-v1").as_bytes(),
            pubkey_hex.as_bytes(),
        );
        hex::encode(&digest.as_bytes()[..16])
    }
}

/// Crypto that prints a code the app cannot derive: the tripwire must fire.
pub struct LyingCodeCrypto;

impl PairCrypto for LyingCodeCrypto {
    fn random(&self, out: &mut [u8]) {
        NodeCrypto.random(out)
    }
    fn verify(&self, pubkey_hex: &str, message: &[u8], signature_hex: &str) -> bool {
        NodeCrypto.verify(pubkey_hex, message, signature_hex)
    }
    fn short_code(&self, _challenge: &[u8]) -> String {
        "ZZZZ-ZZZZ".into()
    }
    fn client_id(&self, pubkey_hex: &str) -> String {
        NodeCrypto.client_id(pubkey_hex)
    }
}

pub fn mock(data_dir: &Path, routes: PairRoutes, now: i64) -> Arc<PairingMock> {
    mock_with(data_dir, routes, now, Box::new(NodeCrypto))
}

pub fn mock_with(
    data_dir: &Path,
    routes: PairRoutes,
    now: i64,
    crypto: Box<dyn PairCrypto>,
) -> Arc<PairingMock> {
    Arc::new(PairingMock::new(
        PairingMockConfig {
            data_dir: data_dir.to_path_buf(),
            routes,
            token_ttl_secs: 600,
            now,
        },
        crypto,
    ))
}

/// A loopback HTTP/1.1 listener in front of a [`PairingMock`].
///
/// New node stdout lines are forwarded to `codes` after each request, the way
/// the app's stdout drain forwards the real sidecar's output.
pub struct Server {
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
}

impl Server {
    pub fn start(node: Arc<PairingMock>, codes: PrintedCodes) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind ephemeral loopback port");
        let addr = listener.local_addr().expect("addr");
        assert_ne!(addr.port(), NODE_PORT, "tests must never hold the node port");
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        std::thread::spawn(move || {
            let mut forwarded = 0;
            for stream in listener.incoming() {
                if flag.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                serve_one(&node, stream);
                let lines = node.stdout_lines();
                for line in &lines[forwarded..] {
                    codes.record_line(line);
                }
                forwarded = lines.len();
            }
        });
        Self { addr, stop }
    }

    /// `http://127.0.0.1:<ephemeral>/api/v1`
    pub fn api_base(&self) -> String {
        format!("http://127.0.0.1:{}/api/v1", self.addr.port())
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
    }
}

fn serve_one(node: &PairingMock, stream: TcpStream) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() || line.is_empty() {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let mut length = 0usize;
    let mut bearer = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).is_err() || header == "\r\n" || header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':').unwrap_or((&header, ""));
        let value = value.trim();
        match name.to_ascii_lowercase().as_str() {
            "content-length" => length = value.parse().unwrap_or(0),
            "authorization" => bearer = value.strip_prefix("Bearer ").map(str::to_owned),
            _ => {}
        }
    }
    let mut body = vec![0u8; length];
    let _ = reader.read_exact(&mut body);
    let (status, text) = node.handle(&method, &target, bearer.as_deref(), &body);
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        _ => "Error",
    };
    let mut out = stream;
    let _ = write!(
        out,
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
        text.len()
    );
}
