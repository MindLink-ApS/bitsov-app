use super::*;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};

#[derive(Default)]
struct Pins {
    pin: Mutex<Option<BoxPin>>,
    writes: std::sync::atomic::AtomicUsize,
}
impl BoxPinStore for Pins {
    fn read(&self, _: &str) -> Result<Option<BoxPin>, RemoteError> {
        Ok(self.pin.lock().unwrap().clone())
    }
    fn save(&self, pin: &BoxPin) -> Result<(), RemoteError> {
        self.writes
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *self.pin.lock().unwrap() = Some(pin.clone());
        Ok(())
    }
}
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/home-node.json")).unwrap()
}
fn setup(endpoint: String, pinned: bool) -> (RemoteDescriptor, Arc<Pins>) {
    let f = fixture();
    let node = SigningKey::from_bytes(&[7; 32]);
    let transport = hex::encode(X25519PublicKey::from(&StaticSecret::from([12; 32])).to_bytes());
    let node_id = f["node_id"].as_str().unwrap().to_owned();
    let signature = node.sign(descriptor_signature_message(&node_id, &transport).as_bytes());
    let descriptor = validate_descriptor(StoredDescriptor {
        v: 1,
        endpoint: endpoint.clone(),
        node_id: node_id.clone(),
        transport_pubkey: transport,
        transport_signature: base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(signature.to_bytes()),
        code: None,
        hosted_by: None,
    })
    .unwrap();
    let pins = Arc::new(Pins::default());
    if pinned {
        *pins.pin.lock().unwrap() = Some(
            BoxPin::verify(
                &node_id,
                &endpoint,
                f["auth"]["box_transport_pubkey"].as_str().unwrap(),
                f["auth"]["box_transport_signature"].as_str().unwrap(),
            )
            .unwrap(),
        );
    }
    (descriptor.with_pin_store(pins.clone()), pins)
}
async fn responder(
    listener: TcpListener,
    secret: u8,
    auth: Value,
) -> Result<(TcpStream, TransportState, RemoteAuthRequest), RemoteError> {
    let (mut stream, _) = listener.accept().await.unwrap();
    let secret = [secret; 32];
    let mut hs = Builder::new(NOISE_PROTOCOL.parse().unwrap())
        .local_private_key(&secret)
        .build_responder()
        .unwrap();
    let mut out = vec![0; MAX_HANDSHAKE_FRAME];
    let msg = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await?;
    hs.read_message(&msg, &mut out).unwrap();
    let n = hs.write_message(&[], &mut out).unwrap();
    write_frame(&mut stream, &out[..n]).await?;
    let msg = read_frame(&mut stream, MAX_HANDSHAKE_FRAME).await?;
    hs.read_message(&msg, &mut out).unwrap();
    let mut noise = hs.into_transport_mode().unwrap();
    let encrypted = read_frame(&mut stream, MAX_TRANSPORT_FRAME).await?;
    let request = serde_json::from_slice(&decode_transport(
        &mut noise,
        &encrypted,
        MAX_AUTH_PLAINTEXT,
    )?)
    .unwrap();
    let encrypted = encode_transport(&mut noise, &serde_json::to_vec(&auth).unwrap())?;
    write_frame(&mut stream, &encrypted).await?;
    Ok((stream, noise, request))
}

#[tokio::test]
async fn box_never_tofu_and_first_pairing_never_uses_box_pin() {
    for (pinned, first_pairing, secret) in [(false, false, 9), (true, true, 9), (true, false, 10)] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (mut descriptor, pins) = setup(listener.local_addr().unwrap().to_string(), pinned);
        if first_pairing {
            descriptor.code =
                Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([1; 32]));
        }
        let server = tokio::spawn(responder(listener, secret, fixture()["auth"].clone()));
        let dir = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(dir.path()).unwrap();
        let result = connect_authenticated(&descriptor, &key, "fixture").await;
        assert!(result.is_err(), "unpinned/first-pairing box accepted");
        assert!(
            server.await.unwrap().is_err(),
            "client sent auth to an untrusted static"
        );
        assert_eq!(pins.writes.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn only_identity_transport_can_learn_the_signed_box_fixture() {
    for tamper in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (descriptor, pins) = setup(listener.local_addr().unwrap().to_string(), false);
        let identity_pin = descriptor.transport_pubkey.clone();
        let mut auth = fixture()["auth"].clone();
        if tamper {
            auth["box_transport_pubkey"] = json!("ab".repeat(32));
        }
        let server = tokio::spawn(responder(listener, 12, auth));
        let dir = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(dir.path()).unwrap();
        let result = connect_authenticated(&descriptor, &key, "fixture").await;
        assert_eq!(result.is_ok(), !tamper);
        assert_eq!(
            pins.writes.load(std::sync::atomic::Ordering::SeqCst),
            usize::from(!tamper)
        );
        assert_eq!(descriptor.transport_pubkey, identity_pin);
        server.await.unwrap().unwrap();
    }
}

#[tokio::test]
async fn locked_fixture_accepts_existing_auth_and_never_replaces_pin() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (descriptor, pins) = setup(listener.local_addr().unwrap().to_string(), true);
    let server = tokio::spawn(responder(listener, 9, fixture()["auth"].clone()));
    let dir = tempfile::tempdir().unwrap();
    let key = ClientKey::load_or_create(dir.path()).unwrap();
    let connection = LockedConnection::connect(&descriptor, &key, "fixture")
        .await
        .unwrap()
        .unwrap();
    assert!(connection
        .pin
        .matches(connection.noise.get_remote_static().unwrap()));
    let (_, _, request) = server.await.unwrap().unwrap();
    assert!(
        request.code.is_none() && request.client_pubkey.is_none() && request.signature.is_none()
    );
    assert_eq!(pins.writes.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[tokio::test]
async fn password_crosses_only_the_pinned_noise_session_and_errors_never_echo_it() {
    for status in [204, 401, 403, 409, 429] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (descriptor, _) = setup(listener.local_addr().unwrap().to_string(), true);
        let server = tokio::spawn(async move {
            let (mut stream, mut noise, _) = responder(listener, 9, fixture()["auth"].clone())
                .await
                .unwrap();
            let encrypted = read_frame(&mut stream, MAX_TRANSPORT_FRAME).await.unwrap();
            assert!(!encrypted.windows(18).any(|b| b == b"fixture-password!!"));
            let request = decode_transport(&mut noise, &encrypted, MAX_NOISE_PLAINTEXT).unwrap();
            let split = request.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            assert!(request.starts_with(b"POST /api/v1/node/unlock HTTP/1.1\r\n"));
            let body: Value = serde_json::from_slice(&request[split + 4..]).unwrap();
            assert_eq!(body["password"], "fixture-password!!");
            assert_eq!(body.as_object().unwrap().len(), 4);
            // A hostile endpoint may echo the password: the client returns only fixed copy.
            let echo = if status == 204 {
                ""
            } else {
                "fixture-password!!"
            };
            let reply = format!(
                "HTTP/1.1 {status} Reply\r\nContent-Length: {}\r\n\r\n{echo}",
                echo.len()
            );
            // Deliberately split HTTP headers across two Noise frames.
            for chunk in reply.as_bytes().chunks(11) {
                let encrypted = encode_transport(&mut noise, chunk).unwrap();
                write_frame(&mut stream, &encrypted).await.unwrap();
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let key = ClientKey::load_or_create(dir.path()).unwrap();
        let mut connection = LockedConnection::connect(&descriptor, &key, "fixture")
            .await
            .unwrap()
            .unwrap();
        let body = crate::home_node::UnlockBody {
            challenge: "aa".repeat(32),
            key_id: "key".into(),
            signature: "der".into(),
            password: zeroize::Zeroizing::new("fixture-password!!".into()),
        };
        let result = connection.unlock(&body).await;
        assert_eq!(result.is_ok(), status == 204);
        if let Err(error) = result {
            assert!(!error.to_string().contains("fixture-password"));
        }
        server.await.unwrap();
    }
}

#[test]
fn saved_box_pin_is_reverified_and_bound_to_node_and_endpoint() {
    let (descriptor, pins) = setup("node.example:4242".into(), true);
    assert!(descriptor.box_pin().unwrap().is_some());
    pins.pin.lock().unwrap().as_mut().unwrap().endpoint = "attacker.example:4242".into();
    assert!(descriptor.box_pin().is_err());
    pins.pin.lock().unwrap().as_mut().unwrap().endpoint = descriptor.endpoint.clone();
    pins.pin.lock().unwrap().as_mut().unwrap().signature = "invalid".into();
    assert!(descriptor.box_pin().is_err());
}

#[tokio::test]
async fn identity_pinned_session_can_repair_a_stale_box_endpoint() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (descriptor, pins) = setup(listener.local_addr().unwrap().to_string(), true);
    pins.pin.lock().unwrap().as_mut().unwrap().endpoint = "old.example:4242".into();
    let server = tokio::spawn(responder(listener, 12, fixture()["auth"].clone()));
    let dir = tempfile::tempdir().unwrap();
    let key = ClientKey::load_or_create(dir.path()).unwrap();
    connect_authenticated(&descriptor, &key, "fixture")
        .await
        .unwrap();
    assert_eq!(
        descriptor.box_pin().unwrap().unwrap().endpoint,
        descriptor.endpoint()
    );
    server.await.unwrap().unwrap();
}
