//! Node-routed call media bridge (M6 A1): the host half of the media path
//! app -> own node -> peer node -> peer app.
//!
//! The HOST owns the node's owner-scoped media socket
//! (`GET /api/v1/calls/:call_id/media?peer=<64 hex>`) exactly as it owns
//! `/ws`: the same loopback API base (a local node, or the loopback proxy of
//! the paired Noise remote-access tunnel), the same local proxy credential,
//! the `bitsov.v1` subprotocol, and the token as the `bitsov.jwt.<token>`
//! subprotocol the node prefers (never in the URL, which proxies log). The
//! node admits the socket only for `(peer, call_id)` it knows. The renderer
//! never opens a socket or sees the token (Gate G2).
//!
//! Each binary message is one frame: `seq` (u32, big-endian) then the payload
//! bytes. The host assigns `seq` on the way up and validates the shape on the
//! way down; the payload itself is opaque here (the renderer's codec, see
//! `src/control/mediaFrame.ts`). Both directions go through bounded queues
//! that drop the OLDEST frame under backpressure: for live audio a stale
//! frame is worth less than a fresh one.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as Frame;

/// Big-endian `seq` prefix of every frame.
pub const SEQ_BYTES: usize = 4;
/// Largest payload accepted in either direction: the node's `MAX_CALL_MEDIA_BYTES`
/// (one Opus or mu-law frame is far smaller).
pub const MAX_PAYLOAD: usize = 4096;
/// The subprotocol every node socket speaks.
pub const WS_PROTOCOL: &str = "bitsov.v1";
/// The token-bearing subprotocol the node reads first (`/api/v1/ws` too).
pub const WS_JWT_PROTOCOL_PREFIX: &str = "bitsov.jwt.";
/// Frames held per direction before the oldest is dropped: one second at 20 ms.
pub const QUEUE_FRAMES: usize = 50;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaFrame {
    pub seq: u32,
    pub payload: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameError {
    /// Fewer than `SEQ_BYTES` bytes: no sequence number.
    TooShort,
    /// A sequence number and nothing else.
    EmptyPayload,
    /// More than `MAX_PAYLOAD` bytes after the sequence number.
    TooLarge,
}

impl MediaFrame {
    /// `seq` big-endian, then the payload. Refuses an oversized or empty payload.
    pub fn encode(&self) -> Result<Vec<u8>, FrameError> {
        if self.payload.is_empty() {
            return Err(FrameError::EmptyPayload);
        }
        if self.payload.len() > MAX_PAYLOAD {
            return Err(FrameError::TooLarge);
        }
        let mut out = Vec::with_capacity(SEQ_BYTES + self.payload.len());
        out.extend_from_slice(&self.seq.to_be_bytes());
        out.extend_from_slice(&self.payload);
        Ok(out)
    }

    /// The frame in `bytes`, checked the way the renderer checks it.
    pub fn decode(bytes: &[u8]) -> Result<Self, FrameError> {
        if bytes.len() < SEQ_BYTES {
            return Err(FrameError::TooShort);
        }
        let (seq, payload) = bytes.split_at(SEQ_BYTES);
        if payload.is_empty() {
            return Err(FrameError::EmptyPayload);
        }
        if payload.len() > MAX_PAYLOAD {
            return Err(FrameError::TooLarge);
        }
        Ok(Self {
            seq: u32::from_be_bytes([seq[0], seq[1], seq[2], seq[3]]),
            payload: payload.to_vec(),
        })
    }
}

/// A wire call id: 32 hex digits, as the signalling engine mints them.
pub fn call_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.len() == 32 && value.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(value.to_ascii_lowercase())
    } else {
        Err("the call id is not a 32-digit hex id".into())
    }
}

/// The call's counterparty: a 64-hex node id, as the node's `peer` parameter wants it.
pub fn peer_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(value.to_ascii_lowercase())
    } else {
        Err("the peer id is not a 64-digit hex node id".into())
    }
}

/// The token's subprotocol offer: `bitsov.v1, bitsov.jwt.<token>`.
pub fn ws_protocols(token: &str) -> Result<String, String> {
    if token.is_empty() || !token.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        return Err("the node token is not header-safe".into());
    }
    Ok(format!("{WS_PROTOCOL}, {WS_JWT_PROTOCOL_PREFIX}{token}"))
}

/// `ws://127.0.0.1:<port>/api/v1/calls/<call_id>/media?peer=<peer>` from the loopback API base.
///
/// Same rule as [`super::ws_url`]: a plain-http loopback base only. The socket
/// carries decrypted call audio, so it must never leave the machine; the
/// remote tunnel is reached through its loopback proxy. The token travels in
/// the subprotocol ([`ws_protocols`]), not here.
pub fn media_url(api_base: &str, call_id: &str, peer: &str) -> Result<String, String> {
    let rest = api_base
        .strip_prefix("http://")
        .ok_or_else(|| "call media needs a plain loopback API base".to_string())?;
    let host = rest.split(['/', ':']).next().unwrap_or("");
    if host != "127.0.0.1" && host != "localhost" {
        return Err("call media is loopback-only".into());
    }
    let id = self::call_id(call_id)?;
    let peer = peer_id(peer)?;
    Ok(format!("ws://{}/calls/{id}/media?peer={peer}", rest.trim_end_matches('/')))
}

/// Bounded frame queue shared between the IPC side and the socket task. When
/// full, `push` drops the oldest frame and reports it, so a stalled consumer
/// costs at most `capacity` frames of delay, never unbounded memory.
pub struct FrameQueue {
    frames: Mutex<VecDeque<Vec<u8>>>,
    capacity: usize,
    notify: tokio::sync::Notify,
    dropped: AtomicU64,
}

impl FrameQueue {
    pub fn new(capacity: usize) -> Self {
        Self {
            frames: Mutex::new(VecDeque::with_capacity(capacity.max(1))),
            capacity: capacity.max(1),
            notify: tokio::sync::Notify::new(),
            dropped: AtomicU64::new(0),
        }
    }

    /// Queue `frame`; returns `true` when the oldest frame was dropped to make room.
    pub fn push(&self, frame: Vec<u8>) -> bool {
        let dropped = {
            let mut frames = self.frames.lock().unwrap();
            let dropped = if frames.len() >= self.capacity {
                frames.pop_front();
                true
            } else {
                false
            };
            frames.push_back(frame);
            dropped
        };
        if dropped {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
        self.notify.notify_one();
        dropped
    }

    pub fn try_pop(&self) -> Option<Vec<u8>> {
        self.frames.lock().unwrap().pop_front()
    }

    /// The oldest queued frame, waiting for one if the queue is empty.
    pub async fn pop(&self) -> Vec<u8> {
        loop {
            if let Some(frame) = self.try_pop() {
                return frame;
            }
            self.notify.notified().await;
        }
    }

    pub fn len(&self) -> usize {
        self.frames.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&self) {
        self.frames.lock().unwrap().clear();
    }

    /// Frames dropped as the oldest so far.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

/// Link transitions the renderer sees, as JSON text on the media channel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaLink {
    Connecting,
    Open,
    /// The socket dropped; the host reconnects with backoff.
    Closed(Option<String>),
    /// The node refused the session (or the app is quitting): no reconnect.
    Ended(Option<String>),
}

impl MediaLink {
    pub fn to_json(&self) -> String {
        let (link, detail) = match self {
            MediaLink::Connecting => ("connecting", None),
            MediaLink::Open => ("open", None),
            MediaLink::Closed(detail) => ("closed", detail.as_deref()),
            MediaLink::Ended(detail) => ("ended", detail.as_deref()),
        };
        serde_json::json!({ "link": link, "detail": detail }).to_string()
    }
}

/// Why one media session stopped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionEnd {
    /// The node answered the handshake with this status: the call is not
    /// (or no longer) known, or the token lacks the scope. Reconnecting would not help.
    Refused(u16),
    /// The socket dropped or timed out; worth a reconnect.
    Dropped(String),
    /// The app's own loopback proxy, not the node, turned the handshake away
    /// (its connection limit, a retry wait, or no tunnel to the node yet).
    /// Worth a reconnect, a bounded number of times.
    ProxyUnavailable(String),
    /// The caller asked to stop.
    Stopped,
}

/// Run one media socket session: connect (then call `on_open`), pump `uplink`
/// frames up (assigning `seq`) and validated frames down into `downlink`,
/// until the socket closes, drops, or `stopping` says so. Errors never quote
/// the URL (it holds the token).
pub async fn run_media_session(
    url: &str,
    token: &str,
    local_proxy_auth: Option<&str>,
    uplink: &FrameQueue,
    downlink: &FrameQueue,
    next_seq: &mut u32,
    stopping: &(dyn Fn() -> bool + Send + Sync),
    on_open: &(dyn Fn() + Send + Sync),
) -> Result<(), SessionEnd> {
    let dropped = |why: &str| SessionEnd::Dropped(why.to_string());
    let ws_protocols = |token: &str| ws_protocols(token).map_err(|why| SessionEnd::Dropped(why));
    let mut request = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(url)
        .map_err(|_| dropped("the media request could not be built"))?;
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        ws_protocols(token)?.parse().map_err(|_| dropped("the node token is not header-safe"))?,
    );
    if let Some(local_proxy_auth) = local_proxy_auth {
        request.headers_mut().insert(
            crate::remote_access::LOCAL_AUTH_HEADER,
            local_proxy_auth
                .parse()
                .map_err(|_| dropped("the local proxy credential is invalid"))?,
        );
    }
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(request))
        .await
        .map_err(|_| dropped("the media handshake timed out"))?
        .map_err(|e| match e {
            tokio_tungstenite::tungstenite::Error::Http(response) => {
                match crate::remote_access::transient_proxy_error(
                    response.headers().get(crate::remote_access::PROXY_ERROR_HEADER).and_then(|v| v.to_str().ok()),
                    response.body().as_deref(),
                ) {
                    Some(code) => SessionEnd::ProxyUnavailable(format!("the local proxy could not reach the node ({code})")),
                    None => SessionEnd::Refused(response.status().as_u16()),
                }
            }
            _ => dropped("the node's media socket is not reachable"),
        })?;
    on_open();
    let heartbeat = Duration::from_secs(15);
    let mut deadline = tokio::time::Instant::now() + heartbeat;
    let mut awaiting_pong = false;
    loop {
        if stopping() {
            let _ = tokio::time::timeout(Duration::from_secs(2), socket.close(None)).await;
            return Err(SessionEnd::Stopped);
        }
        tokio::select! {
            frame = socket.next() => {
                let Some(frame) = frame else { break };
                match frame {
                    Ok(Frame::Binary(bytes)) => {
                        if MediaFrame::decode(bytes.as_ref()).is_ok() {
                            downlink.push(bytes.to_vec());
                        }
                    }
                    Ok(Frame::Close(_)) => break,
                    Ok(Frame::Pong(payload)) if payload.as_ref() == b"bitsov-media" => {
                        awaiting_pong = false;
                        deadline = tokio::time::Instant::now() + heartbeat;
                    }
                    Ok(Frame::Ping(_)) => {
                        tokio::time::timeout(Duration::from_secs(5), socket.flush()).await
                            .map_err(|_| dropped("the media heartbeat timed out"))?
                            .map_err(|_| dropped("the media socket dropped"))?;
                    }
                    Ok(_) => {}
                    Err(_) => return Err(dropped("the media socket dropped")),
                }
            }
            payload = uplink.pop() => {
                let frame = MediaFrame { seq: *next_seq, payload };
                let Ok(bytes) = frame.encode() else { continue };
                *next_seq = next_seq.wrapping_add(1);
                tokio::time::timeout(Duration::from_secs(5), socket.send(Frame::Binary(bytes.into())))
                    .await
                    .map_err(|_| dropped("the media socket stalled"))?
                    .map_err(|_| dropped("the media socket dropped"))?;
            }
            _ = tokio::time::sleep_until(deadline) => {
                if awaiting_pong { return Err(dropped("the media heartbeat timed out")); }
                tokio::time::timeout(Duration::from_secs(5), socket.send(Frame::Ping(b"bitsov-media".to_vec().into())))
                    .await.map_err(|_| dropped("the media heartbeat timed out"))?
                    .map_err(|_| dropped("the media socket dropped"))?;
                awaiting_pong = true;
                deadline = tokio::time::Instant::now() + heartbeat;
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                // Re-check `stopping` at the top of the loop.
            }
        }
    }
    Ok(())
}

/// Consecutive proxy-side refusals (without the socket opening in between)
/// before the link gives up. With `backoff` this waits roughly 30 to 60 s.
pub const MAX_PROXY_RETRIES: u32 = 6;

/// Own the media link for one call: reconnect with backoff while the socket
/// drops, stop on a refusal or when `stopping` says so. `prepare` rebuilds the
/// URL, token and proxy credential on every attempt (the token may have been
/// refreshed); `Ok(None)` means "not ready yet, try again shortly".
pub async fn run_media_link<F, Fut>(
    mut prepare: F,
    uplink: &FrameQueue,
    downlink: &FrameQueue,
    emit: &(dyn Fn(MediaLink) + Send + Sync),
    stopping: &(dyn Fn() -> bool + Send + Sync),
) where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Option<(String, String, String)>, String>>,
{
    let mut next_seq = 0u32;
    let mut attempt = 0u32;
    let mut proxy_refusals = 0u32;
    loop {
        if stopping() {
            emit(MediaLink::Ended(None));
            return;
        }
        let connection = prepare().await;
        let detail = match connection {
            Ok(None) => {
                tokio::time::sleep(Duration::from_millis(250)).await;
                continue;
            }
            Ok(Some((url, token, credential))) => {
                emit(MediaLink::Connecting);
                let opened = AtomicBool::new(false);
                let result = run_media_session(&url, &token, Some(&credential), uplink, downlink, &mut next_seq, stopping, &|| {
                    opened.store(true, Ordering::Relaxed);
                    emit(MediaLink::Open);
                })
                .await;
                if opened.load(Ordering::Relaxed) {
                    attempt = 0;
                    proxy_refusals = 0;
                }
                match result {
                    Ok(()) => None,
                    Err(SessionEnd::Stopped) => {
                        emit(MediaLink::Ended(None));
                        return;
                    }
                    Err(SessionEnd::Refused(status)) => {
                        emit(MediaLink::Ended(Some(format!("the node refused the media socket ({status})"))));
                        return;
                    }
                    Err(SessionEnd::Dropped(detail)) => Some(detail),
                    Err(SessionEnd::ProxyUnavailable(detail)) => {
                        proxy_refusals += 1;
                        if proxy_refusals >= MAX_PROXY_RETRIES {
                            emit(MediaLink::Ended(Some(detail)));
                            return;
                        }
                        Some(detail)
                    }
                }
            }
            Err(error) => Some(error),
        };
        emit(MediaLink::Closed(detail));
        tokio::time::sleep(super::backoff(attempt)).await;
        attempt = attempt.saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    #[test]
    fn frames_round_trip_with_a_big_endian_seq() {
        let frame = MediaFrame { seq: 0x0102_0304, payload: vec![0x01, 0xAA, 0xBB] };
        let bytes = frame.encode().unwrap();
        assert_eq!(bytes, vec![0x01, 0x02, 0x03, 0x04, 0x01, 0xAA, 0xBB]);
        assert_eq!(MediaFrame::decode(&bytes).unwrap(), frame);
        let wrapped = MediaFrame { seq: u32::MAX, payload: vec![7] };
        assert_eq!(MediaFrame::decode(&wrapped.encode().unwrap()).unwrap().seq, u32::MAX);
    }

    #[test]
    fn malformed_frames_are_refused_in_both_directions() {
        assert_eq!(MediaFrame::decode(&[]), Err(FrameError::TooShort));
        assert_eq!(MediaFrame::decode(&[0, 0, 1]), Err(FrameError::TooShort));
        assert_eq!(MediaFrame::decode(&[0, 0, 0, 1]), Err(FrameError::EmptyPayload));
        let oversized = [0u8; SEQ_BYTES + MAX_PAYLOAD + 1];
        assert_eq!(MediaFrame::decode(&oversized), Err(FrameError::TooLarge));
        let largest = [0u8; SEQ_BYTES + MAX_PAYLOAD];
        assert_eq!(MediaFrame::decode(&largest).unwrap().payload.len(), MAX_PAYLOAD);
        assert_eq!(MediaFrame { seq: 1, payload: vec![] }.encode(), Err(FrameError::EmptyPayload));
        assert_eq!(MediaFrame { seq: 1, payload: vec![0; MAX_PAYLOAD + 1] }.encode(), Err(FrameError::TooLarge));
    }

    #[test]
    fn the_queue_is_bounded_and_drops_the_oldest() {
        let queue = FrameQueue::new(3);
        assert!(!queue.push(vec![1]));
        assert!(!queue.push(vec![2]));
        assert!(!queue.push(vec![3]));
        assert!(queue.push(vec![4]));
        assert_eq!(queue.len(), 3);
        assert_eq!(queue.dropped(), 1);
        assert_eq!(queue.try_pop(), Some(vec![2]));
        assert_eq!(queue.try_pop(), Some(vec![3]));
        assert_eq!(queue.try_pop(), Some(vec![4]));
        assert_eq!(queue.try_pop(), None);
        assert!(queue.is_empty());
        let zero = FrameQueue::new(0);
        assert!(!zero.push(vec![1]));
        assert!(zero.push(vec![2]));
        assert_eq!(zero.try_pop(), Some(vec![2]));
    }

    #[tokio::test]
    async fn pop_waits_for_a_push() {
        let queue = std::sync::Arc::new(FrameQueue::new(2));
        let waiter = {
            let queue = queue.clone();
            tokio::spawn(async move { queue.pop().await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        queue.push(vec![9]);
        assert_eq!(tokio::time::timeout(Duration::from_secs(1), waiter).await.unwrap().unwrap(), vec![9]);
    }

    #[test]
    fn call_ids_are_validated_and_normalized() {
        let id = "0123456789ABCDEF0123456789abcdef";
        assert_eq!(call_id(id).unwrap(), id.to_ascii_lowercase());
        assert!(call_id("").is_err());
        assert!(call_id("0123456789abcdef0123456789abcde").is_err());
        assert!(call_id("0123456789abcdef0123456789abcdefg").is_err());
        assert!(call_id("../0123456789abcdef0123456789abcd").is_err());
    }

    const PEER: &str = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";

    #[test]
    fn peer_ids_are_validated_and_normalized() {
        assert_eq!(peer_id(&PEER.to_ascii_uppercase()).unwrap(), PEER);
        assert!(peer_id("").is_err());
        assert!(peer_id(&PEER[..63]).is_err());
        assert!(peer_id(&format!("{PEER}0")).is_err());
        assert!(peer_id(&format!("g{}", &PEER[1..])).is_err());
    }

    #[test]
    fn media_url_is_loopback_only_and_names_the_call_and_its_counterparty_without_the_token() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            media_url("http://127.0.0.1:18080/api/v1", id, PEER).unwrap(),
            format!("ws://127.0.0.1:18080/api/v1/calls/{id}/media?peer={PEER}")
        );
        assert_eq!(
            media_url("http://localhost:18080/api/v1/", &id.to_ascii_uppercase(), &PEER.to_ascii_uppercase()).unwrap(),
            format!("ws://localhost:18080/api/v1/calls/{id}/media?peer={PEER}")
        );
        let lan = ["http://", "192.0.2.1:18080/api/v1"].concat();
        assert!(media_url(&lan, id, PEER).is_err());
        assert!(media_url("https://127.0.0.1:18080/api/v1", id, PEER).is_err());
        assert!(media_url("http://127.0.0.1:18080/api/v1", "bad", PEER).is_err());
        assert!(media_url("http://127.0.0.1:18080/api/v1", id, "not-a-peer").is_err());
        assert!(media_url("http://127.0.0.1:18080/api/v1", id, "").is_err());
    }

    #[test]
    fn the_token_rides_the_jwt_subprotocol_the_node_reads_first() {
        assert_eq!(ws_protocols("tok.1").unwrap(), "bitsov.v1, bitsov.jwt.tok.1");
        assert!(ws_protocols("").is_err());
        assert!(ws_protocols("a b").is_err());
        assert!(ws_protocols("a,b").is_err());
    }

    #[test]
    fn link_states_serialize_for_the_renderer() {
        assert_eq!(MediaLink::Open.to_json(), r#"{"detail":null,"link":"open"}"#);
        assert_eq!(MediaLink::Closed(Some("x".into())).to_json(), r#"{"detail":"x","link":"closed"}"#);
        assert_eq!(MediaLink::Ended(None).to_json(), r#"{"detail":null,"link":"ended"}"#);
        assert_eq!(MediaLink::Connecting.to_json(), r#"{"detail":null,"link":"connecting"}"#);
    }

    /// A loopback stand-in for the node's media route: records the handshake,
    /// echoes each uplink frame back with its seq doubled, and pushes one
    /// malformed frame the host must drop.
    async fn media_server(listener: tokio::net::TcpListener, seen: std::sync::Arc<Mutex<Vec<String>>>) {
        let (stream, _) = listener.accept().await.unwrap();
        let seen_headers = seen.clone();
        let mut ws = tokio_tungstenite::accept_hdr_async(stream, move |req: &Request, mut res: Response| {
            let mut seen = seen_headers.lock().unwrap();
            seen.push(req.uri().to_string());
            seen.push(req.headers().get("Sec-WebSocket-Protocol").and_then(|v| v.to_str().ok()).unwrap_or("").to_string());
            seen.push(req.headers().get(crate::remote_access::LOCAL_AUTH_HEADER).and_then(|v| v.to_str().ok()).unwrap_or("").to_string());
            res.headers_mut().insert("Sec-WebSocket-Protocol", "bitsov.v1".parse().unwrap());
            Ok(res)
        })
        .await
        .unwrap();
        ws.send(Frame::Binary(vec![0, 0].into())).await.unwrap();
        while let Some(Ok(frame)) = ws.next().await {
            match frame {
                Frame::Binary(bytes) => {
                    let frame = MediaFrame::decode(bytes.as_ref()).unwrap();
                    let echoed = MediaFrame { seq: frame.seq * 2 + 1, payload: frame.payload };
                    ws.send(Frame::Binary(echoed.encode().unwrap().into())).await.unwrap();
                }
                Frame::Close(_) => break,
                _ => {}
            }
        }
    }

    #[tokio::test]
    async fn a_session_assigns_seq_upward_and_validates_frames_downward() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let server = tokio::spawn(media_server(listener, seen.clone()));
        let id = "0123456789abcdef0123456789abcdef";
        let url = media_url(&format!("http://127.0.0.1:{port}/api/v1"), id, PEER).unwrap();
        let uplink = FrameQueue::new(QUEUE_FRAMES);
        let downlink = FrameQueue::new(QUEUE_FRAMES);
        uplink.push(vec![1, 2, 3]);
        uplink.push(vec![4]);
        let stop = AtomicBool::new(false);
        let mut next_seq = 5u32;
        let opened = AtomicBool::new(false);
        let stopping = || stop.load(Ordering::Relaxed);
        let on_open = || opened.store(true, Ordering::Relaxed);
        let result = {
            let session = run_media_session(&url, "tok.1", Some("proxy-secret"), &uplink, &downlink, &mut next_seq, &stopping, &on_open);
            tokio::pin!(session);
            tokio::select! {
                r = &mut session => r,
                _ = async {
                    while downlink.len() < 2 { tokio::time::sleep(Duration::from_millis(10)).await; }
                    stop.store(true, Ordering::Relaxed);
                    tokio::time::sleep(Duration::from_secs(2)).await;
                } => Err(SessionEnd::Dropped("test timed out".into())),
            }
        };
        assert_eq!(result, Err(SessionEnd::Stopped));
        assert!(opened.load(Ordering::Relaxed));
        assert_eq!(next_seq, 7);
        let first = MediaFrame::decode(&downlink.try_pop().unwrap()).unwrap();
        let second = MediaFrame::decode(&downlink.try_pop().unwrap()).unwrap();
        assert_eq!(first, MediaFrame { seq: 11, payload: vec![1, 2, 3] });
        assert_eq!(second, MediaFrame { seq: 13, payload: vec![4] });
        assert!(downlink.try_pop().is_none(), "the malformed frame was dropped");
        let seen = seen.lock().unwrap().clone();
        // The node's contract: `peer` in the query, the token in the subprotocol, never in the URL.
        assert_eq!(seen, vec![format!("/api/v1/calls/{id}/media?peer={PEER}"), "bitsov.v1, bitsov.jwt.tok.1".to_string(), "proxy-secret".to_string()]);
        server.abort();
    }

    #[tokio::test]
    async fn a_refused_handshake_ends_the_link_without_reconnecting() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let result = tokio_tungstenite::accept_hdr_async(stream, |_: &Request, _res: Response| {
                Err(Response::builder().status(404).body(Some("no such call".to_string())).unwrap())
            })
            .await;
            assert!(result.is_err());
        });
        let id = "0123456789abcdef0123456789abcdef";
        let api = format!("http://127.0.0.1:{port}/api/v1");
        let uplink = FrameQueue::new(QUEUE_FRAMES);
        let downlink = FrameQueue::new(QUEUE_FRAMES);
        let events = Mutex::new(Vec::new());
        let attempts = AtomicU64::new(0);
        run_media_link(
            || async {
                attempts.fetch_add(1, Ordering::Relaxed);
                Ok(Some((media_url(&api, id, PEER).unwrap(), "tok".to_string(), "proxy".to_string())))
            },
            &uplink,
            &downlink,
            &|event| events.lock().unwrap().push(event),
            &|| false,
        )
        .await;
        assert_eq!(attempts.load(Ordering::Relaxed), 1);
        assert_eq!(
            events.into_inner().unwrap(),
            vec![MediaLink::Connecting, MediaLink::Ended(Some("the node refused the media socket (404)".into()))]
        );
        server.await.unwrap();
    }

    /// Answers each media handshake the way the app's loopback proxy does when
    /// it has no tunnel for it (`proxied` times), or as the node itself would
    /// with a bare 503, then accepts the socket.
    async fn refusing_server(listener: tokio::net::TcpListener, proxied: usize, node_503: bool, served: std::sync::Arc<AtomicU64>) {
        use tokio::io::AsyncReadExt;
        for _ in 0..proxied {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).await.unwrap() == 1 { head.push(byte[0]); }
            crate::remote_access::write_proxy_error(&mut stream, "503 Service Unavailable", "remote_proxy_busy", "remote proxy connection limit reached").await;
            served.fetch_add(1, Ordering::SeqCst);
        }
        let (stream, _) = listener.accept().await.unwrap();
        let result = tokio_tungstenite::accept_hdr_async(stream, move |_: &Request, mut res: Response| {
            if node_503 {
                return Err(Response::builder().status(503).body(Some(r#"{"code":"call_media_unavailable"}"#.to_string())).unwrap());
            }
            res.headers_mut().insert("Sec-WebSocket-Protocol", "bitsov.v1".parse().unwrap());
            Ok(res)
        }).await;
        served.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut ws) = result {
            while let Some(Ok(_)) = ws.next().await {}
        }
    }

    /// Skip each reconnect backoff on the virtual clock once the link has
    /// reported `closed` that many times (socket IO stays on the real clock).
    async fn skip_backoffs(events: &Mutex<Vec<MediaLink>>, done: &dyn Fn(&[MediaLink]) -> bool) {
        let mut skipped = 0;
        loop {
            let (closed, finished) = {
                let events = events.lock().unwrap();
                (events.iter().filter(|e| matches!(e, MediaLink::Closed(_))).count(), done(&events))
            };
            if finished { return; }
            if closed > skipped {
                skipped = closed;
                tokio::time::pause();
                tokio::time::advance(Duration::from_secs(31)).await;
                tokio::time::resume();
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn a_proxy_side_refusal_reconnects_instead_of_ending_the_call() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = std::sync::Arc::new(AtomicU64::new(0));
        let server = tokio::spawn(refusing_server(listener, 2, false, served.clone()));
        let api = format!("http://127.0.0.1:{port}/api/v1");
        let id = "0123456789abcdef0123456789abcdef";
        let (uplink, downlink) = (FrameQueue::new(QUEUE_FRAMES), FrameQueue::new(QUEUE_FRAMES));
        let events = Mutex::new(Vec::new());
        let stop = AtomicBool::new(false);
        let emit = |event| {
            if event == MediaLink::Open { stop.store(true, Ordering::SeqCst); }
            events.lock().unwrap().push(event)
        };
        let stopping = || stop.load(Ordering::SeqCst);
        let link = run_media_link(
            || async { Ok(Some((media_url(&api, id, PEER).unwrap(), "tok".to_string(), "proxy".to_string()))) },
            &uplink, &downlink, &emit, &stopping,
        );
        // Generous: each skipped backoff also moves this clock by 31 s.
        tokio::time::timeout(Duration::from_secs(600), async {
            tokio::join!(link, skip_backoffs(&events, &|e| e.iter().any(|e| matches!(e, MediaLink::Ended(_)))))
        }).await.unwrap();
        let busy = MediaLink::Closed(Some("the local proxy could not reach the node (remote_proxy_busy)".into()));
        assert_eq!(events.into_inner().unwrap(), vec![
            MediaLink::Connecting, busy.clone(), MediaLink::Connecting, busy,
            MediaLink::Connecting, MediaLink::Open, MediaLink::Ended(None),
        ]);
        assert_eq!(served.load(Ordering::SeqCst), 3);
        server.abort();
    }

    #[tokio::test]
    async fn proxy_side_refusals_are_retried_a_bounded_number_of_times() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = std::sync::Arc::new(AtomicU64::new(0));
        let server = tokio::spawn(refusing_server(listener, 100, false, served.clone()));
        let api = format!("http://127.0.0.1:{port}/api/v1");
        let id = "0123456789abcdef0123456789abcdef";
        let (uplink, downlink) = (FrameQueue::new(QUEUE_FRAMES), FrameQueue::new(QUEUE_FRAMES));
        let events = Mutex::new(Vec::new());
        let emit = |event| events.lock().unwrap().push(event);
        let link = run_media_link(
            || async { Ok(Some((media_url(&api, id, PEER).unwrap(), "tok".to_string(), "proxy".to_string()))) },
            &uplink, &downlink, &emit, &|| false,
        );
        // Generous: each skipped backoff also moves this clock by 31 s.
        tokio::time::timeout(Duration::from_secs(600), async {
            tokio::join!(link, skip_backoffs(&events, &|e| e.iter().any(|e| matches!(e, MediaLink::Ended(_)))))
        }).await.unwrap();
        let events = events.into_inner().unwrap();
        assert_eq!(served.load(Ordering::SeqCst), u64::from(MAX_PROXY_RETRIES));
        assert_eq!(events.last(), Some(&MediaLink::Ended(Some("the local proxy could not reach the node (remote_proxy_busy)".into()))));
        assert!(!events.contains(&MediaLink::Open));
        server.abort();
    }

    #[tokio::test]
    async fn the_nodes_own_503_still_ends_the_link() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = std::sync::Arc::new(AtomicU64::new(0));
        let server = tokio::spawn(refusing_server(listener, 0, true, served.clone()));
        let api = format!("http://127.0.0.1:{port}/api/v1");
        let id = "0123456789abcdef0123456789abcdef";
        let (uplink, downlink) = (FrameQueue::new(QUEUE_FRAMES), FrameQueue::new(QUEUE_FRAMES));
        let events = Mutex::new(Vec::new());
        run_media_link(
            || async { Ok(Some((media_url(&api, id, PEER).unwrap(), "tok".to_string(), "proxy".to_string()))) },
            &uplink, &downlink, &|event| events.lock().unwrap().push(event), &|| false,
        ).await;
        assert_eq!(events.into_inner().unwrap(), vec![
            MediaLink::Connecting, MediaLink::Ended(Some("the node refused the media socket (503)".into())),
        ]);
        assert_eq!(served.load(Ordering::SeqCst), 1);
        server.abort();
    }

    // While the app's pairing is refused the proxy answers every tunnel with
    // this code. Reconnecting could only get the same answer.
    #[tokio::test]
    async fn the_proxys_pairing_refusal_ends_the_link_at_once() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = std::sync::Arc::new(AtomicU64::new(0));
        let server = tokio::spawn({
            let served = served.clone();
            async move {
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).await.unwrap() == 1 { head.push(byte[0]); }
                    crate::remote_access::write_proxy_error(&mut stream, "403 Forbidden", "remote_pairing_refused", "remote node refused pairing").await;
                    served.fetch_add(1, Ordering::SeqCst);
                }
            }
        });
        let api = format!("http://127.0.0.1:{port}/api/v1");
        let id = "0123456789abcdef0123456789abcdef";
        let (uplink, downlink) = (FrameQueue::new(QUEUE_FRAMES), FrameQueue::new(QUEUE_FRAMES));
        let events = Mutex::new(Vec::new());
        tokio::time::timeout(Duration::from_secs(10), run_media_link(
            || async { Ok(Some((media_url(&api, id, PEER).unwrap(), "tok".to_string(), "proxy".to_string()))) },
            &uplink, &downlink, &|event| events.lock().unwrap().push(event), &|| false,
        )).await.expect("a pairing refusal must end the link, not reconnect");
        assert_eq!(events.into_inner().unwrap(), vec![
            MediaLink::Connecting, MediaLink::Ended(Some("the node refused the media socket (403)".into())),
        ]);
        assert_eq!(served.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[tokio::test]
    async fn a_stopped_link_reports_ended_and_returns() {
        let uplink = FrameQueue::new(QUEUE_FRAMES);
        let downlink = FrameQueue::new(QUEUE_FRAMES);
        let events = Mutex::new(Vec::new());
        run_media_link(
            || async { Ok(None) },
            &uplink,
            &downlink,
            &|event| events.lock().unwrap().push(event),
            &|| true,
        )
        .await;
        assert_eq!(events.into_inner().unwrap(), vec![MediaLink::Ended(None)]);
    }
}
