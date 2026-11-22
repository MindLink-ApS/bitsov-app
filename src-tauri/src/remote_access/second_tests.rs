//! Wire fixture: pinned Noise and independent node SAS v2 bytes; never runs a node binary.
use super::*;
// Only the desktop macOS enrollment tests use the Keystore-independent wire
// server. The ticket validation regression below must also run on Linux CI.
#[cfg(all(target_os = "macos", not(feature = "mobile"), feature = "native-test-keys"))]
pub(crate) use fixtures::{node, first_node, claim_code};

#[cfg(all(target_os = "macos", not(feature = "mobile"), feature = "native-test-keys"))]
mod fixtures {
use super::*;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};

pub(crate) async fn node(finalize_status: u16) -> (String, tokio::task::JoinHandle<()>) {
    enrollment_node(finalize_status, None).await
}

pub(crate) async fn first_node(name: &'static str) -> (String, tokio::task::JoinHandle<()>) {
    enrollment_node(204, Some(name)).await
}

pub(crate) fn claim_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut code = [b'A'; 18];
    let hash = blake3::hash(&code[..16]);
    code[16] = ALPHABET[(hash.as_bytes()[0] >> 3) as usize];
    code[17] = ALPHABET[(((hash.as_bytes()[0] & 7) << 2) | (hash.as_bytes()[1] >> 6)) as usize];
    String::from_utf8(code.to_vec()).unwrap()
}

async fn enrollment_node(finalize_status: u16, first_name: Option<&'static str>) -> (String, tokio::task::JoinHandle<()>) {
    let version = if first_name.is_some() { 1 } else { 2 };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = listener.local_addr().unwrap().to_string();
    let identity = SigningKey::from_bytes(&[7;32]);
    let node = hex::encode(identity.verifying_key().as_bytes());
    let secret = [12;32];
    let live = hex::encode(X25519PublicKey::from(&StaticSecret::from(secret)).to_bytes());
    let box_key = hex::encode(X25519PublicKey::from(&StaticSecret::from([9;32])).to_bytes());
    let sign = |m: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(identity.sign(m.as_bytes()).to_bytes());
    let code = format!("{}{}", if version == 2 { "second_" } else { "" }, base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([77;32]));
    let link = json!({"v":1,"endpoint":endpoint,"node_id":node,"transport_pubkey":live,
        "transport_signature":sign(&format!("bitsov-remote-transport-v1:{node}:{live}")),
        "box_transport_pubkey":box_key,"box_transport_signature":sign(&format!("bitsov-box-transport-v1:{node}:{box_key}")),
        "code":code,"expires_at":unix_now()+300});
    let uri = format!("bitsov://pair/{}",base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&link).unwrap()));
    let server = tokio::spawn(async move {
        for first in [true, false] {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut hs = Builder::new(NOISE_PROTOCOL.parse().unwrap()).local_private_key(&secret).build_responder().unwrap();
            let mut out = vec![0;MAX_HANDSHAKE_FRAME];
            let msg = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await.unwrap();
            hs.read_message(&msg, &mut out).unwrap();
            let n = hs.write_message(&[], &mut out).unwrap();
            write_frame(&mut stream, &out[..n]).await.unwrap();
            let msg = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await.unwrap();
            hs.read_message(&msg, &mut out).unwrap();
            let handshake = hs.get_handshake_hash().to_vec();
            let client_static = hs.get_remote_static().unwrap().to_vec();
            let mut noise = hs.into_transport_mode().unwrap();
            let encrypted = read_frame(&mut stream, MAX_TRANSPORT_FRAME).await.unwrap();
            let auth: Value = serde_json::from_slice(&decode_transport(&mut noise, &encrypted, MAX_AUTH_PLAINTEXT).unwrap()).unwrap();
            if first { assert!(auth["code"].as_str() == Some(code.as_str())); }
            else { assert!(auth.get("code").is_none(), "consumed ticket must not be replayed"); }
            let response = encode_transport(&mut noise, &serde_json::to_vec(&json!({"status":"ok","v":1,"client_id":"cccccccccccccccccccccccccccccccc","scopes":if version == 2 { vec![] } else { vec!["read", "receive"] }})).unwrap()).unwrap();
            write_frame(&mut stream, &response).await.unwrap();
            if first { continue; }
            let request = http(&mut stream, &mut noise).await;
            assert!(request.0.starts_with("POST /api/v1/pair/device-key HTTP/"));
            assert_eq!(request.1["sas_version"], version);
            if let Some(name) = first_name { assert_eq!(request.1["name"], name); }
            assert!(request.1.get("claim_code").is_none());
            let public = hex::decode(request.1["public_key"].as_str().unwrap()).unwrap();
            let public_hex = hex::encode(&public);
            let fingerprint = crate::home_node::identity_fingerprint(&node);
            verify(&public, &format!("bitsov-device-register-v1\nnode:{fingerprint}\nclient:cccccccccccccccccccccccccccccccc\npublic_key:{public_hex}"), &request.1);
            let op = "aa".repeat(12);
            let nonce = [0x55;16];
            let reply = json!({"op_id":op,"key_id":hex::encode(&blake3::hash(&public).as_bytes()[..16]),"fingerprint":"fixture","expires_at":unix_now()+300,"sas_version":version,"box_nonce":hex::encode(nonce)});
            respond(&mut stream,&mut noise,200,&reply.to_string()).await;
            let finalized = http(&mut stream, &mut noise).await;
            assert!(finalized.0.starts_with(&format!("POST /api/v1/pair/device-key/{op}/finalize HTTP/")));
            assert_eq!(finalized.1["sas_version"], version);
            // Copied concatenation from node sas.rs and second_device.rs, not app helpers.
            let mut ticket = blake3::Hasher::new();
            if version == 2 {
                ticket.update(b"bitsov-second-device-ticket-v1"); ticket.update(code.as_bytes());
            } else {
                ticket.update(b"bitsov-claim-code-v1"); ticket.update(claim_code().as_bytes());
            }
            let mut h = blake3::Hasher::new();
            for bytes in [if version == 2 { b"bitsov-sas-v2".as_slice() } else { b"bitsov-sas-v1".as_slice() },&handshake,&hex::decode(&box_key).unwrap(),&client_static,&public,&nonce,ticket.finalize().as_bytes()] { h.update(bytes); }
            let digest = h.finalize().to_hex().to_string();
            assert!(finalized.1["sas_digest"].as_str() == Some(digest.as_str()), "SAS bytes differ from node");
            verify(&public,&format!("bitsov-device-register-v2\nnode:{fingerprint}\nclient:cccccccccccccccccccccccccccccccc\npublic_key:{public_hex}\nsas_digest:{digest}"),&finalized.1);
            respond(&mut stream,&mut noise,finalize_status,"").await;
        }
    });
    (uri, server)
}
fn verify(public: &[u8], message: &str, value: &Value) {
    ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_ASN1, public)
        .verify(message.as_bytes(), &hex::decode(value["proof"].as_str().unwrap()).unwrap()).unwrap();
}
async fn http(stream: &mut TcpStream, noise: &mut TransportState) -> (String,Value) {
    let encrypted = read_frame(stream, MAX_TRANSPORT_FRAME).await.unwrap();
    let bytes = decode_transport(noise,&encrypted,MAX_NOISE_PLAINTEXT).unwrap();
    let request = String::from_utf8(bytes).unwrap();
    let (head,body) = request.split_once("\r\n\r\n").unwrap();
    (head.into(),serde_json::from_str(body).unwrap())
}
async fn respond(stream: &mut TcpStream, noise: &mut TransportState, status: u16, body: &str) {
    let response = format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\n\r\n{body}",body.len());
    let bytes = encode_transport(noise,response.as_bytes()).unwrap();
    write_frame(stream,&bytes).await.unwrap();
}

}

#[test]
fn second_ticket_expiry_and_consumption_leave_no_replayable_code() {
    // Same signed fixture as transport tests; the expiration check precedes signature parsing.
    let expired = PairingLinkV1 {
        code: format!("second_{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([77;32])),
        expires_at: unix_now()-30,
        ..Default::default()
    };
    assert!(matches!(validate_link(expired,unix_now()),Err(RemoteError::Expired(_))));
}
