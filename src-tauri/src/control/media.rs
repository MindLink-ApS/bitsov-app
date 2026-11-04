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
//!
//! A session opened with a [`VideoPath`] also carries video on the same
//! socket, with its own queues, its own `seq` counter and a pacer: audio goes
//! first both ways, audio's `seq` stays gapless for its jitter buffer, and a
//! key frame cannot burst past the node's budget. Without a video path nothing
//! here differs from an audio-only session, byte for byte.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
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
/// Video fragments held per direction before the oldest is dropped. The
/// renderer stops encoding well before this fills.
pub const VIDEO_QUEUE_FRAMES: usize = 32;
/// Video control packets (key frame requests, reports) held before the oldest is dropped.
pub const VIDEO_CONTROL_FRAMES: usize = 16;

/// The node's media limits when an operator raised them. Absent means the
/// defaults below; the value is `<messages> <bytes>` per second, per direction.
pub const MEDIA_LIMITS_HEADER: &str = "x-bitsov-media-limits";
/// What every node allows unless its operator raised it.
pub const DEFAULT_NODE_MESSAGES: u32 = 100;
pub const DEFAULT_NODE_BYTES: u32 = 64 * 1024;
/// What the node keeps per second for packets of audio size; video gets the rest.
const NODE_RESERVED_MESSAGES: u32 = 60;
const NODE_RESERVED_BYTES: u32 = 12 * 1024;
/// Share of what the reservation leaves that the pacer uses: the node closes the
/// socket past its budget, and a stall can bunch packets into one of its windows.
const PACER_PERCENT: u64 = 85;

/// The pacer's rates for a node's limits, with the bytes and messages audio needs kept free.
pub fn pacer_rates(node_messages: u32, node_bytes: u32) -> (u32, u32) {
    let share = |cap: u32, reserved: u32| (u64::from(cap.saturating_sub(reserved)) * PACER_PERCENT / 100) as u32;
    (share(node_bytes, NODE_RESERVED_BYTES), share(node_messages, NODE_RESERVED_MESSAGES))
}

/// A node's limits from its handshake answer; anything else means the defaults.
pub fn parse_node_limits(value: Option<&str>) -> Option<(u32, u32)> {
    let mut parts = value?.split_ascii_whitespace();
    let messages: u32 = parts.next()?.parse().ok()?;
    let bytes: u32 = parts.next()?.parse().ok()?;
    (parts.next().is_none() && messages >= DEFAULT_NODE_MESSAGES && bytes >= DEFAULT_NODE_BYTES).then_some((messages, bytes))
}

/// Whether a payload belongs to the video path: type bytes `0x20` to `0x2F`
/// (video) and `0x38` to `0x3F` (its control packets). Audio, HELLO and the
/// reserved sealed types are not in these ranges.
pub fn is_video_payload(payload: &[u8]) -> bool {
    matches!(payload.first(), Some(0x20..=0x2F | 0x38..=0x3F))
}

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

    /// Size of the oldest queued frame.
    fn front_len(&self) -> Option<usize> {
        self.frames.lock().unwrap().front().map(Vec::len)
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

/// What the video path may send per second: a token bucket, so in any one
/// second it sends at most its rate plus one burst. The node counts in fixed
/// one-second windows and closes the socket past its budget, so video must
/// arrive spread out, however it was produced.
#[derive(Clone, Debug)]
pub struct VideoPacer {
    bytes_per_second: f64,
    messages_per_second: f64,
    byte_tokens: f64,
    message_tokens: f64,
    last: tokio::time::Instant,
}

impl VideoPacer {
    /// One full frame on the wire.
    const BURST_BYTES: f64 = (SEQ_BYTES + MAX_PAYLOAD) as f64;
    const BURST_MESSAGES: f64 = 2.0;

    pub fn new(bytes_per_second: u32, messages_per_second: u32, now: tokio::time::Instant) -> Self {
        Self {
            bytes_per_second: f64::from(bytes_per_second.clamp(8 * 1024, 1024 * 1024)),
            messages_per_second: f64::from(messages_per_second.clamp(10, 1000)),
            byte_tokens: Self::BURST_BYTES,
            message_tokens: Self::BURST_MESSAGES,
            last: now,
        }
    }

    fn refill(&mut self, now: tokio::time::Instant) {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.last = now;
        self.byte_tokens = (self.byte_tokens + elapsed * self.bytes_per_second).min(Self::BURST_BYTES);
        self.message_tokens = (self.message_tokens + elapsed * self.messages_per_second).min(Self::BURST_MESSAGES);
    }

    /// How long until a message of `size` wire bytes may go; zero means now.
    pub fn wait_for(&mut self, size: usize, now: tokio::time::Instant) -> Duration {
        self.refill(now);
        let bytes = (size as f64 - self.byte_tokens).max(0.0) / self.bytes_per_second;
        let messages = (1.0 - self.message_tokens).max(0.0) / self.messages_per_second;
        Duration::from_secs_f64(bytes.max(messages))
    }

    /// Spend for a message of `size` wire bytes.
    pub fn take(&mut self, size: usize) {
        self.byte_tokens -= size as f64;
        self.message_tokens -= 1.0;
    }
}

/// The video half of one media session: queues in both directions, the pacer
/// and video's own `seq` counter. Absent on an audio-only session.
pub struct VideoPath {
    control: FrameQueue,
    fragments: FrameQueue,
    downlink: FrameQueue,
    pacer: Mutex<VideoPacer>,
    next_seq: AtomicU32,
    wake: tokio::sync::Notify,
    window: Mutex<SentWindow>,
}

/// Everything sent on this socket in the last second, audio included. The node
/// closes the socket past its budget, so when audio is catching up after a stall,
/// video waits rather than push the second over.
struct SentWindow {
    sent: VecDeque<(tokio::time::Instant, usize)>,
    bytes: usize,
    max_messages: usize,
    max_bytes: usize,
}

impl SentWindow {
    fn new(node_messages: u32, node_bytes: u32) -> Self {
        let share = |cap: u32| (u64::from(cap) * PACER_PERCENT / 100) as usize;
        Self { sent: VecDeque::new(), bytes: 0, max_messages: share(node_messages), max_bytes: share(node_bytes) }
    }

    fn forget_old(&mut self, now: tokio::time::Instant) {
        while let Some(&(at, size)) = self.sent.front() {
            if now.saturating_duration_since(at) < Duration::from_secs(1) {
                break;
            }
            self.sent.pop_front();
            self.bytes -= size;
        }
    }

    fn note(&mut self, size: usize, now: tokio::time::Instant) {
        self.forget_old(now);
        self.sent.push_back((now, size));
        self.bytes += size;
    }

    /// Whether one more full frame would stay inside the margin.
    fn has_room(&mut self, now: tokio::time::Instant) -> bool {
        self.forget_old(now);
        self.sent.len() < self.max_messages && self.bytes + SEQ_BYTES + MAX_PAYLOAD <= self.max_bytes
    }
}

impl VideoPath {
    /// A path paced for a node at the default limits, until the node says otherwise.
    pub fn new() -> Self {
        let (bytes, messages) = pacer_rates(DEFAULT_NODE_MESSAGES, DEFAULT_NODE_BYTES);
        Self::with_rates(bytes, messages)
    }

    pub fn with_rates(bytes_per_second: u32, messages_per_second: u32) -> Self {
        Self {
            control: FrameQueue::new(VIDEO_CONTROL_FRAMES),
            fragments: FrameQueue::new(VIDEO_QUEUE_FRAMES),
            downlink: FrameQueue::new(VIDEO_QUEUE_FRAMES),
            pacer: Mutex::new(VideoPacer::new(bytes_per_second, messages_per_second, tokio::time::Instant::now())),
            next_seq: AtomicU32::new(0),
            wake: tokio::sync::Notify::new(),
            window: Mutex::new(SentWindow::new(DEFAULT_NODE_MESSAGES, DEFAULT_NODE_BYTES)),
        }
    }

    /// The node said what it allows: pace for that.
    fn set_node_limits(&self, node_messages: u32, node_bytes: u32) {
        let (bytes, messages) = pacer_rates(node_messages, node_bytes);
        *self.pacer.lock().unwrap() = VideoPacer::new(bytes, messages, tokio::time::Instant::now());
        *self.window.lock().unwrap() = SentWindow::new(node_messages, node_bytes);
    }

    /// Queue one uplink video payload; returns the fragments waiting to leave,
    /// which the renderer reads as backpressure. Control packets go ahead of
    /// fragments. A payload outside the video range is refused.
    pub fn push(&self, payload: Vec<u8>) -> Result<usize, String> {
        match payload.first() {
            Some(0x20..=0x2F) => {
                self.fragments.push(payload);
            }
            Some(0x38..=0x3F) => {
                self.control.push(payload);
            }
            _ => return Err("not a video payload".into()),
        }
        self.wake.notify_one();
        Ok(self.fragments.len())
    }

    /// Fragments waiting to leave.
    pub fn depth(&self) -> usize {
        self.fragments.len()
    }

    /// Fragments dropped as the oldest so far.
    pub fn dropped(&self) -> u64 {
        self.fragments.dropped()
    }

    pub fn clear(&self) {
        self.control.clear();
        self.fragments.clear();
        self.downlink.clear();
    }

    /// The next uplink payload the pacer allows, waiting for one. Safe to
    /// cancel: a payload leaves its queue only when this returns.
    pub async fn next_uplink(&self) -> Vec<u8> {
        loop {
            let notified = self.wake.notified();
            let queue = if self.control.is_empty() { &self.fragments } else { &self.control };
            let Some(len) = queue.front_len() else {
                notified.await;
                continue;
            };
            let size = SEQ_BYTES + len;
            let wait = self.pacer.lock().unwrap().wait_for(size, tokio::time::Instant::now());
            if wait.is_zero() {
                if let Some(payload) = queue.try_pop() {
                    self.pacer.lock().unwrap().take(size);
                    return payload;
                }
                continue;
            }
            tokio::time::sleep(wait).await;
        }
    }

    fn note_sent(&self, size: usize) {
        self.window.lock().unwrap().note(size, tokio::time::Instant::now());
    }

    fn has_room(&self) -> bool {
        self.window.lock().unwrap().has_room(tokio::time::Instant::now())
    }

    /// Video's own `seq`, so audio's never has a gap.
    fn take_seq(&self) -> u32 {
        self.next_seq.fetch_add(1, Ordering::Relaxed)
    }
}

/// The next frame for the renderer: all queued audio before any video.
pub async fn next_downlink(downlink: &FrameQueue, video: Option<&VideoPath>) -> Vec<u8> {
    match video {
        None => downlink.pop().await,
        Some(video) => tokio::select! {
            biased;
            frame = downlink.pop() => frame,
            frame = video.downlink.pop() => frame,
        },
    }
}

async fn next_video_uplink(video: Option<&VideoPath>) -> Vec<u8> {
    match video {
        Some(video) => video.next_uplink().await,
        None => std::future::pending().await,
    }
}

/// Link transitions the renderer sees, as JSON text on the media channel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaLink {
    Connecting,
    Open,
    /// Open, on a video session: what the node allows per direction, per second.
    OpenWithLimits { messages: u32, bytes: u32 },
    /// The socket dropped; the host reconnects with backoff.
    Closed(Option<String>),
    /// The node refused the session (or the app is quitting): no reconnect.
    Ended(Option<String>),
}

impl MediaLink {
    pub fn to_json(&self) -> String {
        let (link, detail) = match self {
            MediaLink::OpenWithLimits { messages, bytes } => {
                return serde_json::json!({ "link": "open", "detail": null, "limits": { "messages": messages, "bytes": bytes } }).to_string();
            }
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
    run_media_session_with_video(url, token, local_proxy_auth, uplink, downlink, None, next_seq, stopping, &|_| on_open()).await
}

/// [`run_media_session`] with an optional [`VideoPath`] on the same socket.
#[allow(clippy::too_many_arguments)]
pub async fn run_media_session_with_video(
    url: &str,
    token: &str,
    local_proxy_auth: Option<&str>,
    uplink: &FrameQueue,
    downlink: &FrameQueue,
    video: Option<&VideoPath>,
    next_seq: &mut u32,
    stopping: &(dyn Fn() -> bool + Send + Sync),
    on_open: &(dyn Fn(MediaLink) + Send + Sync),
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
    let (mut socket, answer) = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(request))
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
    // Fragments queued while the socket was down are stale: the far decoder
    // asks for a key frame once it sees the gap.
    match video {
        Some(video) => {
            video.fragments.clear();
            let limits = parse_node_limits(answer.headers().get(MEDIA_LIMITS_HEADER).and_then(|v| v.to_str().ok()));
            let (messages, bytes) = limits.unwrap_or((DEFAULT_NODE_MESSAGES, DEFAULT_NODE_BYTES));
            video.set_node_limits(messages, bytes);
            on_open(MediaLink::OpenWithLimits { messages, bytes });
        }
        None => on_open(MediaLink::Open),
    }
    let heartbeat = Duration::from_secs(15);
    let mut deadline = tokio::time::Instant::now() + heartbeat;
    let mut awaiting_pong = false;
    loop {
        if stopping() {
            let _ = tokio::time::timeout(Duration::from_secs(2), socket.close(None)).await;
            return Err(SessionEnd::Stopped);
        }
        let audio_waiting = !uplink.is_empty();
        let video_room = video.is_some_and(VideoPath::has_room);
        tokio::select! {
            frame = socket.next() => {
                let Some(frame) = frame else { break };
                match frame {
                    Ok(Frame::Binary(bytes)) => {
                        if let Ok(frame) = MediaFrame::decode(bytes.as_ref()) {
                            match video {
                                Some(video) if is_video_payload(&frame.payload) => { video.downlink.push(bytes.to_vec()); }
                                _ => { downlink.push(bytes.to_vec()); }
                            }
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
                if let Some(video) = video {
                    video.note_sent(bytes.len());
                }
                tokio::time::timeout(Duration::from_secs(5), socket.send(Frame::Binary(bytes.into())))
                    .await
                    .map_err(|_| dropped("the media socket stalled"))?
                    .map_err(|_| dropped("the media socket dropped"))?;
            }
            // Audio goes first: no video leaves while an audio frame waits.
            payload = next_video_uplink(video), if video.is_some() && !audio_waiting && video_room => {
                let Some(video) = video else { continue };
                let frame = MediaFrame { seq: video.take_seq(), payload };
                let Ok(bytes) = frame.encode() else { continue };
                video.note_sent(bytes.len());
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
    prepare: F,
    uplink: &FrameQueue,
    downlink: &FrameQueue,
    emit: &(dyn Fn(MediaLink) + Send + Sync),
    stopping: &(dyn Fn() -> bool + Send + Sync),
) where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Option<(String, String, String)>, String>>,
{
    run_media_link_with_video(prepare, uplink, downlink, None, emit, stopping).await
}

/// [`run_media_link`] with an optional [`VideoPath`] on the same socket.
pub async fn run_media_link_with_video<F, Fut>(
    mut prepare: F,
    uplink: &FrameQueue,
    downlink: &FrameQueue,
    video: Option<&VideoPath>,
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
                let result = run_media_session_with_video(&url, &token, Some(&credential), uplink, downlink, video, &mut next_seq, stopping, &|link| {
                    opened.store(true, Ordering::Relaxed);
                    emit(link);
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
    fn only_video_types_take_the_video_path() {
        for audio in [0x00u8, 0x01, 0x02, 0x03, 0x10, 0x11, 0x1F, 0x30, 0x31, 0x32, 0x37, 0x40, 0xFF] {
            assert!(!is_video_payload(&[audio, 1, 2]), "{audio:#x} is not video");
        }
        for video in [0x20u8, 0x2F, 0x38, 0x3F] {
            assert!(is_video_payload(&[video]), "{video:#x} is video");
        }
        assert!(!is_video_payload(&[]));
        let path = VideoPath::new();
        assert!(path.push(vec![0x02, 1]).is_err(), "an audio payload is refused on the video path");
        assert!(path.push(vec![]).is_err());
        assert_eq!(path.push(vec![0x20, 1]), Ok(1));
        assert_eq!(path.push(vec![0x39, 1]), Ok(1), "control does not count as backpressure");
    }

    #[tokio::test(start_paused = true)]
    async fn the_pacer_never_exceeds_its_rate_plus_one_burst_in_any_second() {
        // Video's share at today's node caps, as the renderer asks for it.
        let (rate, messages) = pacer_rates(DEFAULT_NODE_MESSAGES, DEFAULT_NODE_BYTES);
        assert_eq!((rate, messages), (45_260, 34));
        let path = VideoPath::new();
        let started = tokio::time::Instant::now();
        // A key frame of 8 full fragments on top of a steady stream.
        let mut sent: Vec<(Duration, usize)> = Vec::new();
        for _ in 0..600 {
            path.fragments.push(vec![0x20; MAX_PAYLOAD]);
            let payload = path.next_uplink().await;
            sent.push((started.elapsed(), SEQ_BYTES + payload.len()));
        }
        let span = sent.last().unwrap().0;
        assert!(span >= Duration::from_secs(50), "600 full frames cannot leave in {span:?}");
        // Every one-second window, at every phase the node's window could have.
        for (i, (start, _)) in sent.iter().enumerate() {
            let window: Vec<_> = sent[i..].iter().take_while(|(t, _)| *t < *start + Duration::from_secs(1)).collect();
            let bytes: usize = window.iter().map(|(_, n)| n).sum();
            assert!(bytes as f64 <= f64::from(rate) + VideoPacer::BURST_BYTES + 1.0, "{bytes} bytes in a second");
            assert!(window.len() as f64 <= f64::from(messages) + VideoPacer::BURST_MESSAGES + 1.0, "{} messages in a second", window.len());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn small_fragments_are_held_to_the_message_rate() {
        let path = VideoPath::with_rates(1024 * 1024, 20);
        let started = tokio::time::Instant::now();
        for _ in 0..41 {
            path.fragments.push(vec![0x20; 100]);
            path.next_uplink().await;
        }
        assert!(started.elapsed() >= Duration::from_millis(1900), "{:?}", started.elapsed());
    }

    #[tokio::test]
    async fn control_goes_ahead_of_queued_fragments_and_a_cancelled_wait_loses_nothing() {
        let path = VideoPath::with_rates(8 * 1024, 10);
        for _ in 0..3 {
            path.push(vec![0x20; MAX_PAYLOAD]).unwrap();
        }
        path.push(vec![0x39, 7]).unwrap();
        assert_eq!(path.next_uplink().await, vec![0x39, 7]);
        // The next fragment cannot leave yet; giving up the wait keeps it queued.
        assert_eq!(path.next_uplink().await.len(), MAX_PAYLOAD);
        assert!(tokio::time::timeout(Duration::from_millis(10), path.next_uplink()).await.is_err());
        assert_eq!(path.depth(), 2);
    }

    #[tokio::test]
    async fn downlink_hands_over_every_audio_frame_before_any_video() {
        let path = VideoPath::new();
        let audio = FrameQueue::new(QUEUE_FRAMES);
        path.downlink.push(vec![0, 0, 0, 1, 0x20, 1]);
        path.downlink.push(vec![0, 0, 0, 2, 0x20, 2]);
        audio.push(vec![0, 0, 0, 9, 0x02, 3]);
        assert_eq!(next_downlink(&audio, Some(&path)).await[4], 0x02);
        assert_eq!(next_downlink(&audio, Some(&path)).await[3], 1);
        audio.push(vec![0, 0, 0, 10, 0x02, 4]);
        assert_eq!(next_downlink(&audio, Some(&path)).await[3], 10);
        assert_eq!(next_downlink(&audio, Some(&path)).await[3], 2);
        // A full video queue costs video frames only.
        for _ in 0..(VIDEO_QUEUE_FRAMES + 10) {
            path.downlink.push(vec![0, 0, 0, 3, 0x20, 5]);
        }
        assert_eq!(audio.dropped(), 0);
        assert_eq!(path.downlink.len(), VIDEO_QUEUE_FRAMES);
    }

    /// Stands in for the node: records every uplink frame, then sends `down`.
    async fn recording_server(listener: tokio::net::TcpListener, seen: std::sync::Arc<Mutex<Vec<MediaFrame>>>, down: Vec<Vec<u8>>) {
        limited_server(listener, seen, down, None).await
    }

    async fn limited_server(listener: tokio::net::TcpListener, seen: std::sync::Arc<Mutex<Vec<MediaFrame>>>, down: Vec<Vec<u8>>, limits: Option<&'static str>) {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_hdr_async(stream, move |_: &Request, mut res: Response| {
            res.headers_mut().insert("Sec-WebSocket-Protocol", "bitsov.v1".parse().unwrap());
            if let Some(limits) = limits {
                res.headers_mut().insert(MEDIA_LIMITS_HEADER, limits.parse().unwrap());
            }
            Ok(res)
        })
        .await
        .unwrap();
        for frame in down {
            ws.send(Frame::Binary(frame.into())).await.unwrap();
        }
        while let Some(Ok(frame)) = ws.next().await {
            if let Frame::Binary(bytes) = frame {
                seen.lock().unwrap().push(MediaFrame::decode(bytes.as_ref()).unwrap());
            }
        }
    }

    #[tokio::test]
    async fn video_on_the_socket_leaves_audio_seq_gapless_and_audio_first() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("ws://{}/", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let down = vec![
            MediaFrame { seq: 5, payload: vec![0x02, 1] }.encode().unwrap(),
            MediaFrame { seq: 900, payload: vec![0x20, 2] }.encode().unwrap(),
            MediaFrame { seq: 6, payload: vec![0x02, 3] }.encode().unwrap(),
        ];
        tokio::spawn(recording_server(listener, seen.clone(), down));
        let (uplink, downlink) = (FrameQueue::new(QUEUE_FRAMES), FrameQueue::new(QUEUE_FRAMES));
        let path = VideoPath::with_rates(1024 * 1024, 1000);
        // Video queued before the socket even opens is stale and goes.
        path.push(vec![0x20, 0xEE]).unwrap();
        let stop = AtomicBool::new(false);
        let stopping = || stop.load(Ordering::SeqCst);
        let mut next_seq = 0;
        let opened = AtomicBool::new(false);
        let on_open = |_: MediaLink| opened.store(true, Ordering::SeqCst);
        let session = run_media_session_with_video(&url, "tok.1", None, &uplink, &downlink, Some(&path), &mut next_seq, &stopping, &on_open);
        let drive = async {
            while !opened.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            for i in 0..5u8 {
                path.push(vec![0x20, i]).unwrap();
                uplink.push(vec![0x02, i]);
                path.push(vec![0x39, i]).unwrap();
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            for _ in 0..200 {
                if seen.lock().unwrap().len() >= 15 && downlink.len() + path.downlink.len() >= 3 { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            stop.store(true, Ordering::SeqCst);
        };
        let (result, ()) = tokio::join!(session, drive);
        assert_eq!(result, Err(SessionEnd::Stopped));
        let frames = seen.lock().unwrap().clone();
        let audio: Vec<u32> = frames.iter().filter(|f| !is_video_payload(&f.payload)).map(|f| f.seq).collect();
        assert_eq!(audio, vec![0, 1, 2, 3, 4], "audio's seq is its own and has no gap");
        let video: Vec<u32> = frames.iter().filter(|f| is_video_payload(&f.payload)).map(|f| f.seq).collect();
        assert_eq!(video, (0..video.len() as u32).collect::<Vec<_>>(), "video counts on its own");
        assert_eq!(video.len(), 10);
        assert!(!frames.iter().any(|f| f.payload == vec![0x20, 0xEE]), "stale video did not go out");
        // Down: audio to the audio queue, video to its own.
        assert_eq!(downlink.len(), 2);
        assert_eq!(path.downlink.len(), 1);
    }

    #[test]
    fn node_limits_parse_strictly_and_fall_back_to_the_defaults() {
        assert_eq!(parse_node_limits(Some("160 262144")), Some((160, 262_144)));
        assert_eq!(parse_node_limits(None), None);
        for bad in ["", "160", "160 262144 9", "x 262144", "99 262144", "160 65535", "-1 262144"] {
            assert_eq!(parse_node_limits(Some(bad)), None, "{bad}");
        }
        assert_eq!(pacer_rates(100, 65_536), (45_260, 34));
        assert_eq!(pacer_rates(160, 262_144), (212_377, 85));
    }

    async fn opened_link(limits: Option<&'static str>, video: bool) -> MediaLink {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("ws://{}/", listener.local_addr().unwrap());
        tokio::spawn(limited_server(listener, Default::default(), vec![], limits));
        let (uplink, downlink) = (FrameQueue::new(QUEUE_FRAMES), FrameQueue::new(QUEUE_FRAMES));
        let path = VideoPath::new();
        let seen = Mutex::new(None);
        let stop = AtomicBool::new(false);
        let stopping = || stop.load(Ordering::SeqCst);
        let on_open = |link: MediaLink| {
            *seen.lock().unwrap() = Some(link);
            stop.store(true, Ordering::SeqCst);
        };
        let mut next_seq = 0;
        let _ = run_media_session_with_video(&url, "tok.1", None, &uplink, &downlink, video.then_some(&path), &mut next_seq, &stopping, &on_open).await;
        let link = seen.lock().unwrap().clone().unwrap();
        link
    }

    #[tokio::test]
    async fn a_video_session_learns_the_nodes_limits_from_the_handshake() {
        assert_eq!(opened_link(Some("160 262144"), true).await, MediaLink::OpenWithLimits { messages: 160, bytes: 262_144 });
        assert_eq!(opened_link(None, true).await, MediaLink::OpenWithLimits { messages: 100, bytes: 65_536 });
        assert_eq!(opened_link(Some("nonsense"), true).await, MediaLink::OpenWithLimits { messages: 100, bytes: 65_536 });
        // An audio session says what it always said.
        assert_eq!(opened_link(Some("160 262144"), false).await, MediaLink::Open);
        assert_eq!(MediaLink::Open.to_json(), r#"{"detail":null,"link":"open"}"#);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&MediaLink::OpenWithLimits { messages: 160, bytes: 262_144 }.to_json()).unwrap(),
            serde_json::json!({ "link": "open", "detail": null, "limits": { "messages": 160, "bytes": 262_144 } })
        );
    }

    #[tokio::test]
    async fn audio_catching_up_holds_video_back_from_the_nodes_budget() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("ws://{}/", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        tokio::spawn(recording_server(listener, seen.clone(), vec![]));
        let (uplink, downlink) = (FrameQueue::new(QUEUE_FRAMES), FrameQueue::new(QUEUE_FRAMES));
        let path = VideoPath::new();
        let stop = AtomicBool::new(false);
        let stopping = || stop.load(Ordering::SeqCst);
        let mut next_seq = 0;
        let session = run_media_session_with_video(&url, "tok.1", None, &uplink, &downlink, Some(&path), &mut next_seq, &stopping, &|_| {});
        let drive = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            // A stalled second's worth of audio and more, then a video backlog.
            for round in 0..2 {
                for i in 0..40u8 {
                    uplink.push(vec![0x02, round, i]);
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
            for i in 0..30u8 {
                path.push(vec![0x20, i]).unwrap();
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
            let at_400ms = seen.lock().unwrap().iter().filter(|f: &&MediaFrame| is_video_payload(&f.payload)).count();
            assert!(at_400ms <= 5, "85 of 100 messages in the second: {at_400ms} video frames");
            // Once the second has passed, what waited goes.
            tokio::time::sleep(Duration::from_millis(1_000)).await;
            stop.store(true, Ordering::SeqCst);
        };
        let (result, ()) = tokio::join!(session, drive);
        assert_eq!(result, Err(SessionEnd::Stopped));
        assert!(seen.lock().unwrap().iter().filter(|f| is_video_payload(&f.payload)).count() > 10, "video went on once there was room");
    }

    #[tokio::test]
    async fn no_video_frame_leaves_while_an_audio_frame_waits() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("ws://{}/", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        tokio::spawn(recording_server(listener, seen.clone(), vec![]));
        let (uplink, downlink) = (FrameQueue::new(QUEUE_FRAMES), FrameQueue::new(QUEUE_FRAMES));
        let path = VideoPath::with_rates(1024 * 1024, 1000);
        let stop = AtomicBool::new(false);
        let stopping = || stop.load(Ordering::SeqCst);
        let mut next_seq = 0;
        // Both queues are full before the session's loop first looks at them.
        let on_open = |_: MediaLink| {
            for i in 0..8u8 {
                path.push(vec![0x20, i]).unwrap();
                uplink.push(vec![0x02, i]);
            }
        };
        let session = run_media_session_with_video(&url, "tok.1", None, &uplink, &downlink, Some(&path), &mut next_seq, &stopping, &on_open);
        let drive = async {
            for _ in 0..500 {
                if seen.lock().unwrap().len() >= 16 { break; }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            stop.store(true, Ordering::SeqCst);
        };
        let (result, ()) = tokio::join!(session, drive);
        assert_eq!(result, Err(SessionEnd::Stopped));
        let order: Vec<u8> = seen.lock().unwrap().iter().map(|f| f.payload[0]).collect();
        assert_eq!(order.len(), 16);
        assert!(order[..8].iter().all(|&t| t == 0x02), "audio first: {order:02x?}");
    }

    #[tokio::test]
    async fn a_session_without_a_video_path_treats_every_frame_as_it_always_did() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("ws://{}/", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let down = vec![
            MediaFrame { seq: 1, payload: vec![0x20, 2] }.encode().unwrap(),
            MediaFrame { seq: 2, payload: vec![0x02, 3] }.encode().unwrap(),
        ];
        tokio::spawn(recording_server(listener, seen.clone(), down));
        let (uplink, downlink) = (FrameQueue::new(QUEUE_FRAMES), FrameQueue::new(QUEUE_FRAMES));
        let stop = AtomicBool::new(false);
        let stopping = || stop.load(Ordering::SeqCst);
        let mut next_seq = 0;
        let session = run_media_session(&url, "tok.1", None, &uplink, &downlink, &mut next_seq, &stopping, &|| {});
        let drive = async {
            uplink.push(vec![0x02, 9]);
            for _ in 0..200 {
                if seen.lock().unwrap().len() == 1 && downlink.len() == 2 { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            stop.store(true, Ordering::SeqCst);
        };
        let (result, ()) = tokio::join!(session, drive);
        assert_eq!(result, Err(SessionEnd::Stopped));
        assert_eq!(seen.lock().unwrap().as_slice(), &[MediaFrame { seq: 0, payload: vec![0x02, 9] }]);
        assert_eq!(downlink.len(), 2, "no frame is sorted out when there is no video path");
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
