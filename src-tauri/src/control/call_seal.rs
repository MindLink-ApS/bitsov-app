//! App-to-app sealing of node-routed call media, behind a build flag.
//!
//! First slice of `docs/E2E-CALLS-AND-VIDEO.md`: key agreement by hash
//! commitment over the call's SDP, and an authenticated cipher around each
//! media payload, in the host. The renderer and both nodes see only what they
//! see today: the renderer plain frames, the nodes opaque bytes.
//!
//! What this authenticates: every sealed frame comes from whoever holds the
//! key from this one exchange, for this call, direction, epoch and counter.
//! Changing any value in the exchange changes the keys.
//!
//! What this does NOT authenticate: who that is. The keys are unauthenticated
//! ephemeral X25519. A node that swaps both public keys in signalling sits in
//! the middle and can read everything; only people comparing the words catch
//! that, and no screen shows the words yet. The node ids come from the node.
//! A node can also strip the offer's attribute, which the app shows as not
//! sealed. Nothing here has had an outside review.

use std::time::{Duration, Instant};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

/// Offer and answer attribute name, version 1.
pub const ATTRIBUTE_PREFIX: &str = "a=x-bitsov-e2e:1 ";
/// `caps` bit 0: this app seals v1. Other bits are reserved and covered by the transcript.
pub const CAP_SEALED_V1: u32 = 1;
/// `sas` value: four BIP-39 English words.
pub const SAS_FOUR_WORDS: u8 = 1;

/// Clear reveal frame: type, the caller's public key, its nonce.
pub const TYPE_REVEAL: u8 = 0x10;
pub const REVEAL_BYTES: usize = 1 + 32 + 16;
/// Sealed frame: type, epoch u8, counter u32 BE, ciphertext, tag.
pub const TYPE_SEALED: u8 = 0x11;
pub const SEALED_HEADER_BYTES: usize = 6;
pub const TAG_BYTES: usize = 16;
/// Inside the seal: type u8, stream_seq u32 BE, len u16 BE, data, zero padding.
pub const INNER_HEADER_BYTES: usize = 7;
/// The inside is padded to a multiple of this, so a voice frame has one size.
pub const PADDING_BYTES: usize = 128;
/// 4,096 minus the sealed form's 22 bytes, rounded down to the padding step.
pub const MAX_INNER_BYTES: usize = 3_968;

/// Sender rotation: 60 s of its own clock or 65,536 frames, whichever is first.
pub const EPOCH_MAX_AGE: Duration = Duration::from_secs(60);
pub const EPOCH_MAX_FRAMES: u32 = 65_536;
/// Prototype default: counters remembered per direction and epoch.
pub const REPLAY_WINDOW: u32 = 1_024;
/// Prototype default: how long the previous epoch stays readable.
pub const PREVIOUS_EPOCH_GRACE: Duration = Duration::from_secs(5);
/// Prototype default: how many epochs ahead a packet may be tried.
pub const FORWARD_EPOCHS: u8 = 2;
/// Prototype default: no authentic packet for this long, while frames arrive, ends the call.
pub const NO_AUTHENTIC_LIMIT: Duration = Duration::from_secs(10);
/// The caller repeats its reveal this often until a sealed frame authenticates.
pub const REVEAL_INTERVAL: Duration = Duration::from_secs(1);
/// The callee ends the call when no reveal has come this long after its link opened.
pub const REVEAL_TIMEOUT: Duration = Duration::from_secs(5);

/// The build flag: only the exact value `sealed` turns sealing on in the host.
/// Same parent-process variable as `VITE_CALL_SEAL` in vite.config.ts.
pub const fn flag_is_on(value: Option<&str>) -> bool {
    match value {
        Some(value) => {
            let value = value.as_bytes();
            let want = b"sealed";
            if value.len() != want.len() {
                return false;
            }
            let mut i = 0;
            while i < want.len() {
                if value[i] != want[i] {
                    return false;
                }
                i += 1;
            }
            true
        }
        None => false,
    }
}

/// Whether this build seals calls. Off by default.
pub const fn enabled() -> bool {
    flag_is_on(option_env!("VITE_CALL_SEAL"))
}

/// Why sealing refused or ended a call. Never a reason to send plaintext. The
/// code is what the renderer receives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SealError {
    /// The build flag is off.
    Disabled,
    /// A call id or node id is not in its wire form.
    BadIdentity,
    /// An attribute is present and wrong: length, case, a field missing or repeated.
    InvalidAttribute,
    /// A key exchange output no party contributed to (a low-order key).
    LowOrderKey,
    /// The reveal does not open the offer's commitment.
    BadCommitment,
    /// A reveal differs from the one already accepted, or has the wrong shape.
    BadReveal,
    /// No reveal arrived in time.
    NoReveal,
    /// Frames keep arriving and none authenticates.
    NoAuthenticFrames,
    /// The last epoch ran out; a key is never reused.
    Exhausted,
    /// The media link was asked to open with no finished exchange for this call.
    NotReady,
}

impl SealError {
    pub const fn code(self) -> &'static str {
        match self {
            SealError::Disabled => "seal_disabled",
            SealError::BadIdentity => "seal_bad_identity",
            SealError::InvalidAttribute => "seal_invalid_attribute",
            SealError::LowOrderKey => "seal_low_order_key",
            SealError::BadCommitment => "seal_bad_commitment",
            SealError::BadReveal => "seal_bad_reveal",
            SealError::NoReveal => "seal_no_reveal",
            SealError::NoAuthenticFrames => "seal_no_authentic_frames",
            SealError::Exhausted => "seal_exhausted",
            SealError::NotReady => "seal_not_ready",
        }
    }
}

// ---- derivations -----------------------------------------------------------

fn dk(context: &str, parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new_derive_key(context);
    for part in parts {
        hasher.update(part);
    }
    *hasher.finalize().as_bytes()
}

type Secret32 = Zeroizing<[u8; 32]>;

/// Call id and the two person node ids, caller first, in fixed-width form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Parties {
    call_id: [u8; 32],
    caller_id: [u8; 32],
    callee_id: [u8; 32],
}

impl Parties {
    /// `call_id` as on the wire (32 hex digits), node ids as 64 hex digits.
    pub fn new(call_id: &str, caller_id: &str, callee_id: &str) -> Result<Self, SealError> {
        let call = super::media::call_id(call_id).map_err(|_| SealError::BadIdentity)?;
        let mut call_bytes = [0u8; 32];
        call_bytes.copy_from_slice(call.as_bytes());
        let node = |value: &str| {
            let id = super::media::peer_id(value).map_err(|_| SealError::BadIdentity)?;
            let mut raw = [0u8; 32];
            hex::decode_to_slice(id, &mut raw).map_err(|_| SealError::BadIdentity)?;
            Ok::<_, SealError>(raw)
        };
        Ok(Self { call_id: call_bytes, caller_id: node(caller_id)?, callee_id: node(callee_id)? })
    }
}

/// Canonical commitment: covers the whole first message, so a changed `caps`
/// or `sas` fails it.
fn commitment(parties: &Parties, caller_caps: u32, sas: u8, a: &[u8; 32], nonce_c: &[u8; 16]) -> [u8; 32] {
    dk(
        "bitsov-e2e-commit-v1",
        &[&parties.call_id, &parties.caller_id, &parties.callee_id, &caller_caps.to_be_bytes(), &[sas], a, nonce_c],
    )
}

/// The frozen public values of one exchange.
struct Exchange<'a> {
    parties: &'a Parties,
    caller_caps: u32,
    callee_caps: u32,
    sas: u8,
    commit: &'a [u8; 32],
    a: &'a [u8; 32],
    b: &'a [u8; 32],
    nonce_c: &'a [u8; 16],
    nonce_e: &'a [u8; 16],
}

fn transcript(x: &Exchange<'_>) -> [u8; 32] {
    dk(
        "bitsov-e2e-transcript-v1",
        &[
            &[1u8],
            &x.parties.call_id,
            &x.parties.caller_id,
            &x.parties.callee_id,
            &x.caller_caps.to_be_bytes(),
            &x.callee_caps.to_be_bytes(),
            &[x.sas],
            x.commit,
            x.a,
            x.b,
            x.nonce_c,
            x.nonce_e,
        ],
    )
}

/// What leaves the derivation. `root` and the DH output do not.
struct KeySet {
    send_caller: Secret32,
    send_callee: Secret32,
    sas_digest: [u8; 32],
}

fn derive_keys(dh: &[u8; 32], transcript: &[u8; 32]) -> KeySet {
    let root: Secret32 = Zeroizing::new(dk("bitsov-e2e-root-v1", &[dh, transcript]));
    KeySet {
        send_caller: Zeroizing::new(dk("bitsov-e2e-send-caller-v1", &[root.as_ref()])),
        send_callee: Zeroizing::new(dk("bitsov-e2e-send-callee-v1", &[root.as_ref()])),
        sas_digest: dk("bitsov-e2e-sas-v1", &[root.as_ref()]),
    }
}

fn next_epoch_key(key: &[u8; 32]) -> Secret32 {
    Zeroizing::new(dk("bitsov-e2e-epoch-next-v1", &[key]))
}

/// DH with the rejection the protocol requires, before any key is installed.
fn exchange_secret(secret: StaticSecret, peer: &[u8; 32]) -> Result<Secret32, SealError> {
    let shared = secret.diffie_hellman(&PublicKey::from(*peer));
    if !shared.was_contributory() {
        return Err(SealError::LowOrderKey);
    }
    Ok(Zeroizing::new(*shared.as_bytes()))
}

fn random_secret() -> Result<StaticSecret, SealError> {
    let mut bytes = Zeroizing::new([0u8; 32]);
    getrandom::getrandom(bytes.as_mut()).map_err(|_| SealError::NotReady)?;
    Ok(StaticSecret::from(*bytes))
}

fn random_nonce() -> Result<[u8; 16], SealError> {
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce).map_err(|_| SealError::NotReady)?;
    Ok(nonce)
}

// ---- attributes ------------------------------------------------------------

/// `key=<lowercase hex>` fields of one attribute line, each exactly once.
fn attribute_fields<'a>(line: &'a str, names: &[(&str, usize)]) -> Result<Vec<&'a str>, SealError> {
    let rest = line.strip_prefix(ATTRIBUTE_PREFIX).ok_or(SealError::InvalidAttribute)?;
    let fields: Vec<&str> = rest.split(' ').collect();
    if fields.len() != names.len() {
        return Err(SealError::InvalidAttribute);
    }
    let mut out = Vec::with_capacity(names.len());
    for (field, (name, length)) in fields.into_iter().zip(names) {
        let value = field
            .strip_prefix(name)
            .and_then(|value| value.strip_prefix('='))
            .ok_or(SealError::InvalidAttribute)?;
        if value.len() != *length || !value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(SealError::InvalidAttribute);
        }
        out.push(value);
    }
    Ok(out)
}

fn hex_array<const N: usize>(value: &str) -> Result<[u8; N], SealError> {
    let mut raw = [0u8; N];
    hex::decode_to_slice(value, &mut raw).map_err(|_| SealError::InvalidAttribute)?;
    Ok(raw)
}

fn caps_of(value: &str) -> Result<u32, SealError> {
    Ok(u32::from_be_bytes(hex_array::<4>(value)?))
}

struct OfferFields {
    commit: [u8; 32],
    caps: u32,
    sas: u8,
}

fn parse_offer(line: &str) -> Result<OfferFields, SealError> {
    let fields = attribute_fields(line, &[("commit", 64), ("caps", 8), ("sas", 2)])?;
    let sas = hex_array::<1>(fields[2])?[0];
    if sas != SAS_FOUR_WORDS {
        return Err(SealError::InvalidAttribute);
    }
    Ok(OfferFields { commit: hex_array(fields[0])?, caps: caps_of(fields[1])?, sas })
}

struct AnswerFields {
    key: [u8; 32],
    nonce: [u8; 16],
    caps: u32,
}

fn parse_answer(line: &str) -> Result<AnswerFields, SealError> {
    let fields = attribute_fields(line, &[("key", 64), ("nonce", 32), ("caps", 8)])?;
    Ok(AnswerFields { key: hex_array(fields[0])?, nonce: hex_array(fields[1])?, caps: caps_of(fields[2])? })
}

// ---- key agreement ---------------------------------------------------------

/// The caller after its offer: holds its secret until the answer is processed.
pub struct CallerOffer {
    parties: Parties,
    secret: StaticSecret,
    a: [u8; 32],
    nonce_c: [u8; 16],
    caps: u32,
    sas: u8,
    commit: [u8; 32],
}

impl CallerOffer {
    /// A new ephemeral key and nonce, and the attribute for the offer's SDP.
    pub fn new(parties: Parties) -> Result<(Self, String), SealError> {
        let secret = random_secret()?;
        let nonce_c = random_nonce()?;
        Ok(Self::with_secret(parties, secret, nonce_c))
    }

    fn with_secret(parties: Parties, secret: StaticSecret, nonce_c: [u8; 16]) -> (Self, String) {
        let a = PublicKey::from(&secret).to_bytes();
        let caps = CAP_SEALED_V1;
        let sas = SAS_FOUR_WORDS;
        let commit = commitment(&parties, caps, sas, &a, &nonce_c);
        let attribute = format!("{ATTRIBUTE_PREFIX}commit={} caps={caps:08x} sas={sas:02x}", hex::encode(commit));
        (Self { parties, secret, a, nonce_c, caps, sas, commit }, attribute)
    }

    /// Process the answer's attribute. `Ok(None)`: the peer said it cannot
    /// seal, which the app must show. Consumes the secret either way.
    pub fn accept_answer(self, line: &str) -> Result<Option<SealedMedia>, SealError> {
        let answer = parse_answer(line)?;
        if answer.caps & CAP_SEALED_V1 == 0 {
            return Ok(None);
        }
        let dh = exchange_secret(self.secret, &answer.key)?;
        let t = transcript(&Exchange {
            parties: &self.parties,
            caller_caps: self.caps,
            callee_caps: answer.caps,
            sas: self.sas,
            commit: &self.commit,
            a: &self.a,
            b: &answer.key,
            nonce_c: &self.nonce_c,
            nonce_e: &answer.nonce,
        });
        let keys = derive_keys(&dh, &t);
        let mut reveal = [0u8; REVEAL_BYTES];
        reveal[0] = TYPE_REVEAL;
        reveal[1..33].copy_from_slice(&self.a);
        reveal[33..].copy_from_slice(&self.nonce_c);
        Ok(Some(SealedMedia::new(self.parties.call_id, Setup::Caller { reveal, last_sent: None }, Some(keys), true)))
    }
}

/// What the callee answers to an offer's attribute.
pub enum AnswerDecision {
    /// Answer with this attribute; media waits for the caller's reveal.
    Seal { media: Box<SealedMedia>, attribute: String },
    /// The offer says it cannot seal, which the app must show.
    PeerCannotSeal,
}

/// The callee's half of the exchange, up to the caller's reveal.
pub fn answer_offer(parties: Parties, line: &str) -> Result<AnswerDecision, SealError> {
    let secret = random_secret()?;
    let nonce_e = random_nonce()?;
    answer_with_secret(parties, line, secret, nonce_e)
}

fn answer_with_secret(parties: Parties, line: &str, secret: StaticSecret, nonce_e: [u8; 16]) -> Result<AnswerDecision, SealError> {
    let offer = parse_offer(line)?;
    if offer.caps & CAP_SEALED_V1 == 0 {
        return Ok(AnswerDecision::PeerCannotSeal);
    }
    let b = PublicKey::from(&secret).to_bytes();
    let caps = CAP_SEALED_V1;
    let attribute = format!("{ATTRIBUTE_PREFIX}key={} nonce={} caps={caps:08x}", hex::encode(b), hex::encode(nonce_e));
    let pending = CalleePending { secret, b, nonce_e, caller_caps: offer.caps, callee_caps: caps, sas: offer.sas, commit: offer.commit };
    let call_id = parties.call_id;
    let media = SealedMedia::new(call_id, Setup::Callee { parties, pending: Some(pending), accepted: None }, None, false);
    Ok(AnswerDecision::Seal { media: Box::new(media), attribute })
}

/// The callee's secret stays only until a valid reveal arrives, or the call ends.
struct CalleePending {
    secret: StaticSecret,
    b: [u8; 32],
    nonce_e: [u8; 16],
    caller_caps: u32,
    callee_caps: u32,
    sas: u8,
    commit: [u8; 32],
}

#[allow(clippy::large_enum_variant)] // One per call, for the length of the call.
enum Setup {
    Caller { reveal: [u8; REVEAL_BYTES], last_sent: Option<Instant> },
    Callee { parties: Parties, pending: Option<CalleePending>, accepted: Option<[u8; REVEAL_BYTES]> },
}

// ---- media state -----------------------------------------------------------

/// Counters already seen in one epoch: authenticate first, then mark.
#[derive(Default)]
struct ReplayWindow {
    highest: Option<u32>,
    seen: [u64; (REPLAY_WINDOW as usize) / 64],
}

impl ReplayWindow {
    fn bit(counter: u32) -> (usize, u64) {
        let slot = counter % REPLAY_WINDOW;
        ((slot / 64) as usize, 1u64 << (slot % 64))
    }

    /// Whether this counter may still be accepted. Changes nothing.
    fn allows(&self, counter: u32) -> bool {
        let Some(highest) = self.highest else { return true };
        if counter > highest {
            return true;
        }
        if highest - counter >= REPLAY_WINDOW {
            return false;
        }
        let (word, mask) = Self::bit(counter);
        self.seen[word] & mask == 0
    }

    fn mark(&mut self, counter: u32) {
        match self.highest {
            Some(highest) if counter > highest => {
                if counter - highest >= REPLAY_WINDOW {
                    self.seen = [0; (REPLAY_WINDOW as usize) / 64];
                } else {
                    for skipped in (highest + 1)..counter {
                        let (word, mask) = Self::bit(skipped);
                        self.seen[word] &= !mask;
                    }
                    let (word, mask) = Self::bit(counter);
                    self.seen[word] &= !mask;
                }
                self.highest = Some(counter);
            }
            None => self.highest = Some(counter),
            Some(_) => {}
        }
        let (word, mask) = Self::bit(counter);
        self.seen[word] |= mask;
    }
}

struct SendState {
    epoch: u8,
    key: Secret32,
    counter: u32,
    epoch_started: Instant,
}

struct ReadEpoch {
    epoch: u8,
    key: Secret32,
    window: ReplayWindow,
}

struct ReadState {
    current: ReadEpoch,
    /// The epoch before `current`, readable until the instant it holds.
    previous: Option<(ReadEpoch, Instant)>,
}

fn nonce_for(counter: u32) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[8..].copy_from_slice(&counter.to_be_bytes());
    nonce
}

fn seal_bytes(key: &[u8; 32], call_id: &[u8; 32], epoch: u8, counter: u32, inner: &[u8]) -> Option<Vec<u8>> {
    let mut header = [0u8; SEALED_HEADER_BYTES];
    header[0] = TYPE_SEALED;
    header[1] = epoch;
    header[2..].copy_from_slice(&counter.to_be_bytes());
    let mut aad = [0u8; SEALED_HEADER_BYTES + 32];
    aad[..SEALED_HEADER_BYTES].copy_from_slice(&header);
    aad[SEALED_HEADER_BYTES..].copy_from_slice(call_id);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let body = cipher.encrypt(Nonce::from_slice(&nonce_for(counter)), Payload { msg: inner, aad: &aad }).ok()?;
    let mut out = Vec::with_capacity(SEALED_HEADER_BYTES + body.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&body);
    Some(out)
}

fn open_bytes(key: &[u8; 32], call_id: &[u8; 32], frame: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    let counter = u32::from_be_bytes([frame[2], frame[3], frame[4], frame[5]]);
    let mut aad = [0u8; SEALED_HEADER_BYTES + 32];
    aad[..SEALED_HEADER_BYTES].copy_from_slice(&frame[..SEALED_HEADER_BYTES]);
    aad[SEALED_HEADER_BYTES..].copy_from_slice(call_id);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(&nonce_for(counter)), Payload { msg: &frame[SEALED_HEADER_BYTES..], aad: &aad })
        .ok()
        .map(Zeroizing::new)
}

/// The inner layout for a payload the renderer made (type byte, then data).
fn inner_for(payload: &[u8], stream_seq: u32) -> Option<Zeroizing<Vec<u8>>> {
    let (&kind, data) = payload.split_first()?;
    let used = INNER_HEADER_BYTES + data.len();
    let padded = used.div_ceil(PADDING_BYTES) * PADDING_BYTES;
    if padded > MAX_INNER_BYTES {
        return None;
    }
    let mut inner = Zeroizing::new(vec![0u8; padded]);
    inner[0] = kind;
    inner[1..5].copy_from_slice(&stream_seq.to_be_bytes());
    inner[5..7].copy_from_slice(&(data.len() as u16).to_be_bytes());
    inner[INNER_HEADER_BYTES..used].copy_from_slice(data);
    Some(inner)
}

/// The renderer's frame (`stream_seq` as its `seq`, then type and data) from
/// an authenticated inner. None when the layout is wrong.
fn frame_from_inner(inner: &[u8]) -> Option<Vec<u8>> {
    if inner.len() < INNER_HEADER_BYTES {
        return None;
    }
    let len = u16::from_be_bytes([inner[5], inner[6]]) as usize;
    let end = INNER_HEADER_BYTES.checked_add(len)?;
    if end > inner.len() || inner[end..].iter().any(|b| *b != 0) {
        return None;
    }
    let mut frame = Vec::with_capacity(5 + len);
    frame.extend_from_slice(&inner[1..5]);
    frame.push(inner[0]);
    frame.extend_from_slice(&inner[INNER_HEADER_BYTES..end]);
    Some(frame)
}

/// Counters for evidence and tests. No key material.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SealCounters {
    pub sealed_out: u64,
    pub reveals_out: u64,
    /// Uplink frames dropped because the keys were not there yet.
    pub held_back: u64,
    pub opened: u64,
    /// Sealed frames that failed: wrong key, wrong call, replayed, out of range.
    pub rejected: u64,
    /// Frames in the clear on a sealed call. Never reach the renderer.
    pub clear_refused: u64,
    /// Sealed frames before the keys existed.
    pub early: u64,
}

/// What a tick asks the socket to do.
#[derive(Debug, PartialEq, Eq)]
pub enum Tick {
    Nothing,
    Send(Vec<u8>),
}

/// One call's sealed media, from the finished exchange to the end of the call.
/// Keys, counters and replay state survive socket reconnects; dropping this
/// ends the seal, and the secrets are wiped.
pub struct SealedMedia {
    call_id: [u8; 32],
    setup: Setup,
    send: Option<SendState>,
    read: Option<ReadState>,
    sas_digest: Option<[u8; 32]>,
    is_caller: bool,
    stream_seq: u32,
    /// A frame from the peer has authenticated on this call.
    authenticated: bool,
    /// Reported once: see `take_first_authentic`.
    first_authentic_pending: bool,
    last_authentic: Option<Instant>,
    last_rejected: Option<Instant>,
    link_opened: Option<Instant>,
    counters: SealCounters,
}

impl SealedMedia {
    fn new(call_id: [u8; 32], setup: Setup, keys: Option<KeySet>, is_caller: bool) -> Self {
        let mut media = Self {
            call_id,
            setup,
            send: None,
            read: None,
            sas_digest: None,
            is_caller,
            stream_seq: 0,
            authenticated: false,
            first_authentic_pending: false,
            last_authentic: None,
            last_rejected: None,
            link_opened: None,
            counters: SealCounters::default(),
        };
        if let Some(keys) = keys {
            media.install(keys, Instant::now());
        }
        media
    }

    fn install(&mut self, keys: KeySet, now: Instant) {
        let (send, read) = if self.is_caller { (keys.send_caller, keys.send_callee) } else { (keys.send_callee, keys.send_caller) };
        self.send = Some(SendState { epoch: 0, key: send, counter: 0, epoch_started: now });
        self.read = Some(ReadState { current: ReadEpoch { epoch: 0, key: read, window: ReplayWindow::default() }, previous: None });
        self.sas_digest = Some(keys.sas_digest);
    }

    /// The call's four words, once this side has the keys. No screen shows
    /// them yet; they exist so that a later slice can, and so tests can compare.
    pub fn words(&self) -> Option<[&'static str; 4]> {
        self.sas_digest.map(|digest| crate::sas::words(&blake3::Hash::from_bytes(digest)))
    }

    pub fn counters(&self) -> SealCounters {
        self.counters
    }

    /// A frame from the peer has authenticated on this call.
    pub fn authenticated(&self) -> bool {
        self.authenticated
    }

    /// True once, after the first authentic frame: the label may change then.
    pub fn take_first_authentic(&mut self) -> bool {
        std::mem::take(&mut self.first_authentic_pending)
    }

    /// The socket opened (again): the reveal clock starts here.
    pub fn link_opened(&mut self, now: Instant) {
        self.link_opened = Some(now);
    }

    /// Seal one renderer payload. `Ok(None)`: not sent, because the keys are
    /// not here yet or the frame is too large. Never returns plaintext.
    pub fn seal(&mut self, payload: &[u8], now: Instant) -> Result<Option<Vec<u8>>, SealError> {
        let Some(send) = self.send.as_mut() else {
            self.counters.held_back += 1;
            return Ok(None);
        };
        if send.counter >= EPOCH_MAX_FRAMES || now.saturating_duration_since(send.epoch_started) >= EPOCH_MAX_AGE {
            let epoch = send.epoch.checked_add(1).ok_or(SealError::Exhausted)?;
            send.key = next_epoch_key(&send.key);
            send.epoch = epoch;
            send.counter = 0;
            send.epoch_started = now;
        }
        let Some(inner) = inner_for(payload, self.stream_seq) else {
            self.counters.held_back += 1;
            return Ok(None);
        };
        let sealed = seal_bytes(&send.key, &self.call_id, send.epoch, send.counter, &inner).ok_or(SealError::Exhausted)?;
        send.counter += 1;
        self.stream_seq = self.stream_seq.wrapping_add(1);
        self.counters.sealed_out += 1;
        Ok(Some(sealed))
    }

    /// One payload from the node. `Ok(Some)`: a frame for the renderer. Anything
    /// in the clear, or failing the tag, changes no state and reaches nothing.
    pub fn receive(&mut self, payload: &[u8], now: Instant) -> Result<Option<Vec<u8>>, SealError> {
        match payload.first() {
            Some(&TYPE_SEALED) => Ok(self.open(payload, now)),
            Some(&TYPE_REVEAL) => {
                self.reveal(payload, now)?;
                Ok(None)
            }
            _ => {
                self.counters.clear_refused += 1;
                self.last_rejected = Some(now);
                Ok(None)
            }
        }
    }

    fn reject(&mut self, now: Instant) -> Option<Vec<u8>> {
        self.counters.rejected += 1;
        self.last_rejected = Some(now);
        None
    }

    fn open(&mut self, payload: &[u8], now: Instant) -> Option<Vec<u8>> {
        if payload.len() < SEALED_HEADER_BYTES + TAG_BYTES {
            return self.reject(now);
        }
        let epoch = payload[1];
        let counter = u32::from_be_bytes([payload[2], payload[3], payload[4], payload[5]]);
        let call_id = self.call_id;
        let Some(read) = self.read.as_mut() else {
            self.counters.early += 1;
            return None;
        };
        if read.previous.as_ref().is_some_and(|(_, until)| now >= *until) {
            read.previous = None;
        }
        let current_epoch = read.current.epoch;
        let inner = if epoch == current_epoch {
            if !read.current.window.allows(counter) {
                return self.reject(now);
            }
            let Some(inner) = open_bytes(&read.current.key, &call_id, payload) else { return self.reject(now) };
            read.current.window.mark(counter);
            inner
        } else if epoch < current_epoch {
            let Some((previous, _)) = read.previous.as_mut().filter(|(previous, _)| previous.epoch == epoch) else {
                return self.reject(now);
            };
            if !previous.window.allows(counter) {
                return self.reject(now);
            }
            let Some(inner) = open_bytes(&previous.key, &call_id, payload) else { return self.reject(now) };
            previous.window.mark(counter);
            inner
        } else {
            let steps = epoch - current_epoch;
            if steps > FORWARD_EPOCHS {
                return self.reject(now);
            }
            // Staged: nothing below touches the read state unless the tag passes.
            let mut before_key = Zeroizing::new(*read.current.key);
            let mut key = next_epoch_key(&read.current.key);
            for _ in 1..steps {
                before_key = Zeroizing::new(*key);
                key = next_epoch_key(&key);
            }
            let Some(inner) = open_bytes(&key, &call_id, payload) else { return self.reject(now) };
            let mut window = ReplayWindow::default();
            window.mark(counter);
            // Only the epoch right before this one may still have packets on their way.
            let before_window = if steps == 1 { std::mem::take(&mut read.current.window) } else { ReplayWindow::default() };
            let before = ReadEpoch { epoch: epoch - 1, key: before_key, window: before_window };
            read.previous = Some((before, now + PREVIOUS_EPOCH_GRACE));
            read.current = ReadEpoch { epoch, key, window };
            inner
        };
        // Authentic from here on: the tag covered these bytes.
        self.last_authentic = Some(now);
        self.counters.opened += 1;
        if !self.authenticated {
            self.authenticated = true;
            self.first_authentic_pending = true;
        }
        frame_from_inner(&inner)
    }

    fn reveal(&mut self, payload: &[u8], now: Instant) -> Result<(), SealError> {
        let Setup::Callee { parties, pending, accepted } = &mut self.setup else {
            // A caller is never sent one: treat it as any other unexpected clear frame.
            self.counters.clear_refused += 1;
            self.last_rejected = Some(now);
            return Ok(());
        };
        if payload.len() != REVEAL_BYTES {
            return Err(SealError::BadReveal);
        }
        if let Some(accepted) = accepted {
            return if accepted[..] == *payload { Ok(()) } else { Err(SealError::BadReveal) };
        }
        let Some(exchange) = pending.take() else { return Err(SealError::BadReveal) };
        let a: [u8; 32] = payload[1..33].try_into().map_err(|_| SealError::BadReveal)?;
        let nonce_c: [u8; 16] = payload[33..].try_into().map_err(|_| SealError::BadReveal)?;
        if commitment(parties, exchange.caller_caps, exchange.sas, &a, &nonce_c) != exchange.commit {
            return Err(SealError::BadCommitment);
        }
        let t = transcript(&Exchange {
            parties,
            caller_caps: exchange.caller_caps,
            callee_caps: exchange.callee_caps,
            sas: exchange.sas,
            commit: &exchange.commit,
            a: &a,
            b: &exchange.b,
            nonce_c: &nonce_c,
            nonce_e: &exchange.nonce_e,
        });
        let dh = exchange_secret(exchange.secret, &a)?;
        let keys = derive_keys(&dh, &t);
        let mut frozen = [0u8; REVEAL_BYTES];
        frozen.copy_from_slice(payload);
        *accepted = Some(frozen);
        self.install(keys, now);
        Ok(())
    }

    /// Timers, about four times a second while the link is open. A reveal to
    /// send, or the reason the call must end.
    pub fn tick(&mut self, now: Instant) -> Result<Tick, SealError> {
        let opened = self.link_opened.unwrap_or(now);
        if let Setup::Callee { pending: Some(_), .. } = &self.setup {
            if now.saturating_duration_since(opened) >= REVEAL_TIMEOUT {
                return Err(SealError::NoReveal);
            }
        }
        if let Some(rejected) = self.last_rejected {
            let since = self.last_authentic.map_or(opened, |authentic| authentic.max(opened));
            if rejected > since
                && now.saturating_duration_since(since) >= NO_AUTHENTIC_LIMIT
                && now.saturating_duration_since(rejected) < Duration::from_secs(1)
            {
                return Err(SealError::NoAuthenticFrames);
            }
        }
        if let Setup::Caller { reveal, last_sent } = &mut self.setup {
            let due = last_sent.is_none_or(|sent| now.saturating_duration_since(sent) >= REVEAL_INTERVAL);
            if !self.authenticated && due {
                *last_sent = Some(now);
                self.counters.reveals_out += 1;
                return Ok(Tick::Send(reveal.to_vec()));
            }
        }
        Ok(Tick::Nothing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CALL: &str = "0123456789abcdef0123456789abcdef";
    const OTHER_CALL: &str = "fedcba9876543210fedcba9876543210";

    fn ids() -> (String, String) {
        ("a1".repeat(32), "b2".repeat(32))
    }

    fn parties() -> Parties {
        let (caller, callee) = ids();
        Parties::new(CALL, &caller, &callee).unwrap()
    }

    fn unhex<const N: usize>(text: &str) -> [u8; N] {
        let mut out = [0u8; N];
        hex::decode_to_slice(text, &mut out).unwrap();
        out
    }

    /// A caller and a callee who finished the exchange, reveal delivered.
    fn pair() -> (SealedMedia, SealedMedia) {
        pair_for(parties(), parties())
    }

    fn pair_for(caller_parties: Parties, callee_parties: Parties) -> (SealedMedia, SealedMedia) {
        let (offer, offer_line) = CallerOffer::new(caller_parties).unwrap();
        let AnswerDecision::Seal { media: callee, attribute } = answer_offer(callee_parties, &offer_line).unwrap() else { panic!("no seal") };
        let mut callee = *callee;
        let mut caller = offer.accept_answer(&attribute).unwrap().unwrap();
        let now = Instant::now();
        caller.link_opened(now);
        callee.link_opened(now);
        let Tick::Send(reveal) = caller.tick(now).unwrap() else { panic!("no reveal") };
        assert_eq!(callee.receive(&reveal, now).unwrap(), None);
        (caller, callee)
    }

    // ---- the protocol table's known answers --------------------------------

    #[test]
    fn every_derivation_matches_the_published_vectors() {
        let p = parties();
        let a_secret = StaticSecret::from([0x11u8; 32]);
        let b_secret = StaticSecret::from([0x22u8; 32]);
        let a = PublicKey::from(&a_secret).to_bytes();
        let b = PublicKey::from(&b_secret).to_bytes();
        assert_eq!(a, unhex("7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13"));
        assert_eq!(b, unhex("0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20"));
        let (nonce_c, nonce_e) = ([0xc1u8; 16], [0xe1u8; 16]);
        let dh = a_secret.diffie_hellman(&PublicKey::from(b));
        assert_eq!(*dh.as_bytes(), unhex::<32>("9e004098efc091d4ec2663b4e9f5cfd4d7064571690b4bea97ab146ab9f35056"));
        let commit = commitment(&p, 1, 1, &a, &nonce_c);
        assert_eq!(commit, unhex::<32>("82fe1e10cf97b89fd49c5d190c6bfb6ceba9607360e45a3e1e2a999ed88baccf"));
        let t = transcript(&Exchange { parties: &p, caller_caps: 1, callee_caps: 1, sas: 1, commit: &commit, a: &a, b: &b, nonce_c: &nonce_c, nonce_e: &nonce_e });
        assert_eq!(t, unhex::<32>("f0df137fd0941c42a279fa5bd5b96bedf3f443d07d23c0de1e17d46f65969e6a"));
        assert_eq!(dk("bitsov-e2e-root-v1", &[dh.as_bytes(), &t]), unhex::<32>("83a6036d746e4966bea97a6a6edd41d55062ccd7c8aab5409d1e7df88d478327"));
        let keys = derive_keys(dh.as_bytes(), &t);
        assert_eq!(*keys.send_caller, unhex::<32>("4314183a3bf3ce45c872db94c11a0810d7f664f2f44985f4a2229b463e1bf2a3"));
        assert_eq!(*keys.send_callee, unhex::<32>("734e7008a567eed7da87dae5f67b85d5bc5c4d631684b2270ee8d87f47cf219a"));
        assert_eq!(*next_epoch_key(&keys.send_caller), unhex::<32>("71fbf316536f280ddcc0ad5dc953c0363ab6b8000a1affcf274df634a6ed746a"));
        assert_eq!(keys.sas_digest, unhex::<32>("5b54a1cf34721f9828ad911feb48073e1fc01b84460575b8d1f8ad8921e91500"));
        let list = bip39::Language::English.word_list();
        let words = crate::sas::words(&blake3::Hash::from_bytes(keys.sas_digest));
        assert_eq!(words, [list[730], list[1320], list[926], list[839]]);
        let inner = inner_for(&[0x01, 0xde, 0xad, 0xbe], 7).unwrap();
        let mut want_inner = vec![0u8; 128];
        want_inner[..10].copy_from_slice(&[0x01, 0, 0, 0, 7, 0, 3, 0xde, 0xad, 0xbe]);
        assert_eq!(*inner, want_inner);
        let sealed = seal_bytes(&keys.send_caller, &p.call_id, 0, 0, &inner).unwrap();
        assert_eq!(hex::encode(&sealed[..6]), "110000000000");
        assert_eq!(hex::encode(&sealed[6..]), "cd2b1a6ab80474b09c213462bfe368dee9a645845f4cf9296ca66aa6dedf17189a9f36ea6d9cb14caa7ba6349ae578ff68ab3bf99f488598c9826eb4c96e3d7956f306ff92aeb8d0ad77e4225d3c7fb249d80762e1c78b56b13b746397f58829c21962795305f65dbb97bac397019ea0cfa146a6821f036c07cd786dba82fde5eb651ea3eb62bad2f56b102cb5a6a649");
    }

    #[test]
    fn the_whole_exchange_reaches_the_published_keys_through_the_attributes() {
        let (offer, offer_line) = CallerOffer::with_secret(parties(), StaticSecret::from([0x11u8; 32]), [0xc1u8; 16]);
        assert_eq!(offer_line, "a=x-bitsov-e2e:1 commit=82fe1e10cf97b89fd49c5d190c6bfb6ceba9607360e45a3e1e2a999ed88baccf caps=00000001 sas=01");
        let AnswerDecision::Seal { media: callee, attribute } =
            answer_with_secret(parties(), &offer_line, StaticSecret::from([0x22u8; 32]), [0xe1u8; 16]).unwrap() else { panic!("no seal") };
        assert_eq!(attribute, format!("a=x-bitsov-e2e:1 key=0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20 nonce={} caps=00000001", "e1".repeat(16)));
        let mut callee = *callee;
        let mut caller = offer.accept_answer(&attribute).unwrap().unwrap();
        assert_eq!(*caller.send.as_ref().unwrap().key, unhex::<32>("4314183a3bf3ce45c872db94c11a0810d7f664f2f44985f4a2229b463e1bf2a3"));
        let now = Instant::now();
        let Tick::Send(reveal) = caller.tick(now).unwrap() else { panic!("no reveal") };
        assert_eq!(reveal.len(), REVEAL_BYTES);
        assert_eq!(reveal[0], TYPE_REVEAL);
        callee.receive(&reveal, now).unwrap();
        assert_eq!(*callee.send.as_ref().unwrap().key, unhex::<32>("734e7008a567eed7da87dae5f67b85d5bc5c4d631684b2270ee8d87f47cf219a"));
        assert_eq!(caller.words(), callee.words());
        assert!(caller.words().is_some());
    }

    #[test]
    fn changing_any_input_changes_the_transcript() {
        let (p, a, b, commit, nc, ne) = (parties(), [1u8; 32], [2u8; 32], [3u8; 32], [4u8; 16], [5u8; 16]);
        let base = transcript(&Exchange { parties: &p, caller_caps: 1, callee_caps: 1, sas: 1, commit: &commit, a: &a, b: &b, nonce_c: &nc, nonce_e: &ne });
        let (caller, callee) = ids();
        let other_call = Parties::new(OTHER_CALL, &caller, &callee).unwrap();
        let other_caller = Parties::new(CALL, &"c3".repeat(32), &callee).unwrap();
        let other_callee = Parties::new(CALL, &caller, &"c3".repeat(32)).unwrap();
        let changed = [
            transcript(&Exchange { parties: &other_call, caller_caps: 1, callee_caps: 1, sas: 1, commit: &commit, a: &a, b: &b, nonce_c: &nc, nonce_e: &ne }),
            transcript(&Exchange { parties: &other_caller, caller_caps: 1, callee_caps: 1, sas: 1, commit: &commit, a: &a, b: &b, nonce_c: &nc, nonce_e: &ne }),
            transcript(&Exchange { parties: &other_callee, caller_caps: 1, callee_caps: 1, sas: 1, commit: &commit, a: &a, b: &b, nonce_c: &nc, nonce_e: &ne }),
            transcript(&Exchange { parties: &p, caller_caps: 3, callee_caps: 1, sas: 1, commit: &commit, a: &a, b: &b, nonce_c: &nc, nonce_e: &ne }),
            transcript(&Exchange { parties: &p, caller_caps: 1, callee_caps: 3, sas: 1, commit: &commit, a: &a, b: &b, nonce_c: &nc, nonce_e: &ne }),
            transcript(&Exchange { parties: &p, caller_caps: 1, callee_caps: 1, sas: 2, commit: &commit, a: &a, b: &b, nonce_c: &nc, nonce_e: &ne }),
            transcript(&Exchange { parties: &p, caller_caps: 1, callee_caps: 1, sas: 1, commit: &[9u8; 32], a: &a, b: &b, nonce_c: &nc, nonce_e: &ne }),
            transcript(&Exchange { parties: &p, caller_caps: 1, callee_caps: 1, sas: 1, commit: &commit, a: &[9u8; 32], b: &b, nonce_c: &nc, nonce_e: &ne }),
            transcript(&Exchange { parties: &p, caller_caps: 1, callee_caps: 1, sas: 1, commit: &commit, a: &a, b: &[9u8; 32], nonce_c: &nc, nonce_e: &ne }),
            transcript(&Exchange { parties: &p, caller_caps: 1, callee_caps: 1, sas: 1, commit: &commit, a: &a, b: &b, nonce_c: &[9u8; 16], nonce_e: &ne }),
            transcript(&Exchange { parties: &p, caller_caps: 1, callee_caps: 1, sas: 1, commit: &commit, a: &a, b: &b, nonce_c: &nc, nonce_e: &[9u8; 16] }),
        ];
        for other in changed {
            assert_ne!(other, base);
        }
    }

    // ---- validation --------------------------------------------------------

    const LOW_ORDER: [&str; 7] = [
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0100000000000000000000000000000000000000000000000000000000000000",
        "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
        "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    ];

    #[test]
    fn a_low_order_key_is_refused_at_both_roles_before_any_key_is_installed() {
        for key in LOW_ORDER {
            // The caller, at the answer, before it sends a reveal.
            let (offer, _) = CallerOffer::new(parties()).unwrap();
            let line = format!("{ATTRIBUTE_PREFIX}key={key} nonce={} caps=00000001", "e1".repeat(16));
            assert_eq!(offer.accept_answer(&line).err(), Some(SealError::LowOrderKey), "caller, {key}");
            // The callee, at the reveal, after the commitment passes.
            let a = unhex::<32>(key);
            let nonce_c = [0xc1u8; 16];
            let commit = commitment(&parties(), 1, 1, &a, &nonce_c);
            let line = format!("{ATTRIBUTE_PREFIX}commit={} caps=00000001 sas=01", hex::encode(commit));
            let AnswerDecision::Seal { media, .. } = answer_offer(parties(), &line).unwrap() else { panic!("no seal") };
            let mut callee = *media;
            let mut reveal = vec![TYPE_REVEAL];
            reveal.extend_from_slice(&a);
            reveal.extend_from_slice(&nonce_c);
            assert_eq!(callee.receive(&reveal, Instant::now()), Err(SealError::LowOrderKey), "callee, {key}");
            assert!(callee.send.is_none() && callee.read.is_none(), "no key installed");
        }
    }

    #[test]
    fn invalid_attributes_are_refused_never_treated_as_absent() {
        let commit = "ab".repeat(32);
        let offers = [
            format!("a=x-bitsov-e2e:2 commit={commit} caps=00000001 sas=01"),
            format!("a=x-bitsov-e2e:1 commit={} caps=00000001 sas=01", &commit[..62]),
            format!("a=x-bitsov-e2e:1 commit={} caps=00000001 sas=01", commit.to_ascii_uppercase()),
            format!("a=x-bitsov-e2e:1 commit={commit} caps=00000001"),
            format!("a=x-bitsov-e2e:1 commit={commit} caps=00000001 sas=01 sas=01"),
            format!("a=x-bitsov-e2e:1 commit={commit} commit={commit} sas=01"),
            format!("a=x-bitsov-e2e:1 caps=00000001 commit={commit} sas=01"),
            format!("a=x-bitsov-e2e:1 commit={commit} caps=00000001 sas=02"),
            format!("a=x-bitsov-e2e:1 commit={commit} caps=0000001 sas=01"),
            format!("a=x-bitsov-e2e:1  commit={commit} caps=00000001 sas=01"),
            format!("a=x-bitsov-e2e:1 commit={commit} caps=00000001 sas=01 "),
            String::new(),
        ];
        for line in offers {
            assert_eq!(answer_offer(parties(), &line).err(), Some(SealError::InvalidAttribute), "offer: {line}");
        }
        let key = "cd".repeat(32);
        let nonce = "ef".repeat(16);
        let answers = [
            format!("a=x-bitsov-e2e:1 key={key} nonce={nonce}"),
            format!("a=x-bitsov-e2e:1 key={key} nonce={} caps=00000001", &nonce[..30]),
            format!("a=x-bitsov-e2e:1 nonce={nonce} key={key} caps=00000001"),
            format!("a=x-bitsov-e2e:1 key={} nonce={nonce} caps=00000001", key.to_ascii_uppercase()),
        ];
        for line in answers {
            let (offer, _) = CallerOffer::new(parties()).unwrap();
            assert_eq!(offer.accept_answer(&line).err(), Some(SealError::InvalidAttribute), "answer: {line}");
        }
    }

    #[test]
    fn a_peer_without_the_capability_is_reported_never_sealed_silently() {
        let line = format!("{ATTRIBUTE_PREFIX}commit={} caps=00000002 sas=01", "ab".repeat(32));
        assert!(matches!(answer_offer(parties(), &line), Ok(AnswerDecision::PeerCannotSeal)));
        let (offer, _) = CallerOffer::new(parties()).unwrap();
        let line = format!("{ATTRIBUTE_PREFIX}key={} nonce={} caps=00000002", "cd".repeat(32), "ef".repeat(16));
        assert!(matches!(offer.accept_answer(&line), Ok(None)));
    }

    #[test]
    fn identities_must_be_in_wire_form() {
        let (caller, callee) = ids();
        assert_eq!(Parties::new("nope", &caller, &callee).err(), Some(SealError::BadIdentity));
        assert_eq!(Parties::new(CALL, "nope", &callee).err(), Some(SealError::BadIdentity));
        assert_eq!(Parties::new(CALL, &caller, "nope").err(), Some(SealError::BadIdentity));
    }

    // ---- commitment and reveal ---------------------------------------------

    fn exchanged() -> (Vec<u8>, SealedMedia) {
        let (offer, offer_line) = CallerOffer::new(parties()).unwrap();
        let AnswerDecision::Seal { media, attribute } = answer_offer(parties(), &offer_line).unwrap() else { panic!("no seal") };
        let mut caller = offer.accept_answer(&attribute).unwrap().unwrap();
        let Tick::Send(reveal) = caller.tick(Instant::now()).unwrap() else { panic!("no reveal") };
        (reveal, *media)
    }

    #[test]
    fn a_changed_reveal_fails_the_commitment_and_ends_setup() {
        for at in [1, 32, 33, 48] {
            let (mut reveal, mut callee) = exchanged();
            reveal[at] ^= 1;
            assert_eq!(callee.receive(&reveal, Instant::now()), Err(SealError::BadCommitment), "byte {at}");
            assert!(callee.send.is_none() && callee.read.is_none());
        }
        let (reveal, mut callee) = exchanged();
        assert_eq!(callee.receive(&reveal[..48], Instant::now()), Err(SealError::BadReveal));
        let (reveal, mut callee) = exchanged();
        let mut long = reveal.clone();
        long.push(0);
        assert_eq!(callee.receive(&long, Instant::now()), Err(SealError::BadReveal));
    }

    #[test]
    fn a_changed_sas_or_caps_in_the_offer_fails_the_commitment() {
        for edit in ["caps=00000003", "caps=80000001"] {
            let (offer, offer_line) = CallerOffer::new(parties()).unwrap();
            let changed = offer_line.replace("caps=00000001", edit);
            let AnswerDecision::Seal { media, attribute } = answer_offer(parties(), &changed).unwrap() else { panic!("no seal") };
            let mut callee = *media;
            let mut caller = offer.accept_answer(&attribute).unwrap().unwrap();
            let Tick::Send(reveal) = caller.tick(Instant::now()).unwrap() else { panic!("no reveal") };
            assert_eq!(callee.receive(&reveal, Instant::now()), Err(SealError::BadCommitment), "{edit}");
        }
        // Only `sas=01` exists today, so another value is refused outright.
        let (_, offer_line) = CallerOffer::new(parties()).unwrap();
        assert_eq!(answer_offer(parties(), &offer_line.replace("sas=01", "sas=02")).err(), Some(SealError::InvalidAttribute));
    }

    #[test]
    fn a_repeated_reveal_is_ignored_and_a_different_one_ends_the_call() {
        let (reveal, mut callee) = exchanged();
        let now = Instant::now();
        callee.receive(&reveal, now).unwrap();
        let words = callee.words();
        assert_eq!(callee.receive(&reveal, now), Ok(None));
        assert_eq!(callee.words(), words);
        let mut other = reveal.clone();
        other[1] ^= 1;
        assert_eq!(callee.receive(&other, now), Err(SealError::BadReveal));
    }

    #[test]
    fn a_node_swapping_both_keys_gets_different_words_on_each_leg() {
        // The node answers the caller as one exchange and offers the callee another.
        let (offer, _) = CallerOffer::new(parties()).unwrap();
        let (node_offer, node_offer_line) = CallerOffer::new(parties()).unwrap();
        let AnswerDecision::Seal { media, attribute } = answer_offer(parties(), &node_offer_line).unwrap() else { panic!("no seal") };
        let mut callee = *media;
        let mut node_as_caller = node_offer.accept_answer(&attribute).unwrap().unwrap();
        let Tick::Send(reveal) = node_as_caller.tick(Instant::now()).unwrap() else { panic!("no reveal") };
        callee.receive(&reveal, Instant::now()).unwrap();
        let node_key = PublicKey::from(&random_secret().unwrap()).to_bytes();
        let node_answer = format!("{ATTRIBUTE_PREFIX}key={} nonce={} caps=00000001", hex::encode(node_key), "e1".repeat(16));
        let mut caller = offer.accept_answer(&node_answer).unwrap().unwrap();
        // Both ends think they are sealed, which is why the label says a node
        // could be attacking. Only the words differ, and only people can compare them.
        assert_ne!(caller.words(), callee.words());
        let frame = caller.seal(&[1, 2, 3], Instant::now()).unwrap().unwrap();
        assert_eq!(callee.receive(&frame, Instant::now()), Ok(None), "the other leg's key reads nothing");
        assert_eq!(callee.counters().rejected, 1);
    }

    #[test]
    fn after_setup_no_exchange_secret_is_held() {
        let (caller, callee) = pair();
        // By type: `SealedMedia` has no field for `root` or the DH output, and
        // `CallerOffer::accept_answer` consumes the caller's secret.
        assert!(matches!(caller.setup, Setup::Caller { .. }));
        let Setup::Callee { pending, .. } = &callee.setup else { panic!("callee") };
        assert!(pending.is_none(), "the callee's secret went with the reveal");
        // Held until then.
        let (_, waiting) = exchanged();
        let Setup::Callee { pending, .. } = &waiting.setup else { panic!("callee") };
        assert!(pending.is_some());
    }

    // ---- sealing -----------------------------------------------------------

    #[test]
    fn frames_round_trip_with_stream_seq_as_the_renderers_seq() {
        let (mut caller, mut callee) = pair();
        let now = Instant::now();
        for seq in 0u32..3 {
            let sealed = caller.seal(&[0x02, 0xAA, seq as u8], now).unwrap().unwrap();
            assert_eq!(sealed[0], TYPE_SEALED);
            let frame = callee.receive(&sealed, now).unwrap().unwrap();
            let mut want = seq.to_be_bytes().to_vec();
            want.extend_from_slice(&[0x02, 0xAA, seq as u8]);
            assert_eq!(frame, want);
        }
        assert_eq!(callee.counters().opened, 3);
        let back = callee.seal(&[0x00, 0x03], now).unwrap().unwrap();
        assert_eq!(caller.receive(&back, now).unwrap().unwrap(), vec![0, 0, 0, 0, 0x00, 0x03]);
    }

    #[test]
    fn voice_frames_of_any_size_have_one_size_on_the_wire() {
        let (mut caller, _) = pair();
        let now = Instant::now();
        for data in 0..=121usize {
            let mut payload = vec![0x02];
            payload.extend(std::iter::repeat_n(0x55, data));
            assert_eq!(caller.seal(&payload, now).unwrap().unwrap().len(), 150, "{data} bytes of data");
        }
        // The mu-law floor: one 160-byte frame.
        let mut payload = vec![0x01];
        payload.extend([0x7f; 160]);
        assert_eq!(caller.seal(&payload, now).unwrap().unwrap().len(), 278);
    }

    #[test]
    fn a_frame_too_large_for_the_slot_is_not_sent_at_all() {
        let (mut caller, _) = pair();
        let now = Instant::now();
        let largest = vec![0x20; 1 + MAX_INNER_BYTES - INNER_HEADER_BYTES];
        assert_eq!(caller.seal(&largest, now).unwrap().unwrap().len(), MAX_INNER_BYTES + SEALED_HEADER_BYTES + TAG_BYTES);
        let over = vec![0x20; largest.len() + 1];
        assert_eq!(caller.seal(&over, now), Ok(None));
        assert_eq!(caller.counters().held_back, 1);
    }

    #[test]
    fn the_callee_sends_nothing_before_the_reveal() {
        let (reveal, mut callee) = exchanged();
        let now = Instant::now();
        assert_eq!(callee.seal(&[0x02, 1, 2, 3], now), Ok(None));
        assert_eq!(callee.counters().held_back, 1);
        callee.receive(&reveal, now).unwrap();
        assert!(callee.seal(&[0x02, 1, 2, 3], now).unwrap().is_some());
    }

    #[test]
    fn clear_frames_on_a_sealed_call_never_reach_the_renderer() {
        let (mut caller, mut callee) = pair();
        let now = Instant::now();
        for clear in [vec![0x00, 0x03], vec![0x01, 1, 2, 3], vec![0x02, 1, 2, 3], vec![0x20, 0, 0], vec![0xFF]] {
            assert_eq!(callee.receive(&clear, now), Ok(None));
            assert_eq!(caller.receive(&clear, now), Ok(None));
        }
        assert_eq!(callee.counters().clear_refused, 5);
        // A reveal sent to the caller is just another unexpected clear frame.
        assert_eq!(caller.receive(&[TYPE_REVEAL; REVEAL_BYTES], now), Ok(None));
        assert_eq!(caller.counters().clear_refused, 6);
        assert_eq!(callee.counters().opened, 0);
    }

    #[test]
    fn any_changed_byte_fails_the_tag() {
        let (mut caller, mut callee) = pair();
        let now = Instant::now();
        let sealed = caller.seal(&[0x02, 1, 2, 3], now).unwrap().unwrap();
        for at in 1..sealed.len() {
            let mut changed = sealed.clone();
            changed[at] ^= 0x01;
            assert_eq!(callee.receive(&changed, now), Ok(None), "byte {at}");
        }
        assert_eq!(callee.counters().opened, 0);
        assert!(callee.receive(&sealed, now).unwrap().is_some(), "and the real one still opens");
    }

    #[test]
    fn a_frame_from_another_direction_call_or_epoch_fails() {
        let now = Instant::now();
        let (mut caller, mut callee) = pair();
        let own = caller.seal(&[0x02, 1], now).unwrap().unwrap();
        assert_eq!(caller.receive(&own, now), Ok(None), "cross-direction");
        assert_eq!(caller.counters().rejected, 1);
        let (caller_ids, callee_ids) = ids();
        let other = Parties::new(OTHER_CALL, &caller_ids, &callee_ids).unwrap();
        let (mut other_caller, _) = pair_for(other.clone(), other);
        let foreign = other_caller.seal(&[0x02, 1], now).unwrap().unwrap();
        assert_eq!(callee.receive(&foreign, now), Ok(None), "cross-call");
        // The same keys under another call id: the AAD catches it.
        let keys = caller.send.as_ref().unwrap().key.clone();
        let inner = inner_for(&[0x02, 1], 0).unwrap();
        let moved = seal_bytes(&keys, &other_caller.call_id, 0, 500, &inner).unwrap();
        assert_eq!(callee.receive(&moved, now), Ok(None), "wrong call id in the AAD");
        // Epoch byte relabelled, the key not rotated.
        let mut relabelled = caller.seal(&[0x02, 1], now).unwrap().unwrap();
        relabelled[1] = 1;
        assert_eq!(callee.receive(&relabelled, now), Ok(None), "cross-epoch");
        assert_eq!(callee.read.as_ref().unwrap().current.epoch, 0);
    }

    #[test]
    fn an_authentic_frame_with_a_wrong_layout_delivers_nothing() {
        let (mut caller, mut callee) = pair();
        let now = Instant::now();
        let key = caller.send.as_ref().unwrap().key.clone();
        let call_id = caller.call_id;
        let mut padded = vec![0u8; PADDING_BYTES];
        padded[..9].copy_from_slice(&[0x02, 0, 0, 0, 1, 0, 2, 0xAA, 0xBB]);
        let mut dirty = padded.clone();
        dirty[100] = 1;
        let mut long = padded.clone();
        long[5..7].copy_from_slice(&500u16.to_be_bytes());
        for (counter, inner) in [(0u32, dirty), (1, long), (2, vec![0x02, 0, 0])] {
            let sealed = seal_bytes(&key, &call_id, 0, counter, &inner).unwrap();
            assert_eq!(callee.receive(&sealed, now), Ok(None), "counter {counter}");
        }
        let good = seal_bytes(&key, &call_id, 0, 3, &padded).unwrap();
        assert_eq!(callee.receive(&good, now).unwrap().unwrap(), vec![0, 0, 0, 1, 0x02, 0xAA, 0xBB]);
        let _ = caller.seal(&[0x02], now);
    }

    #[test]
    fn duplicates_are_dropped_and_reordered_frames_still_open() {
        let (mut caller, mut callee) = pair();
        let now = Instant::now();
        let frames: Vec<_> = (0..5).map(|i| caller.seal(&[0x02, i], now).unwrap().unwrap()).collect();
        for at in [0usize, 2, 1, 4, 3] {
            assert!(callee.receive(&frames[at], now).unwrap().is_some(), "frame {at}");
        }
        for frame in &frames {
            assert_eq!(callee.receive(frame, now), Ok(None), "replay");
        }
        assert_eq!(callee.counters().opened, 5);
        assert_eq!(callee.counters().rejected, 5);
    }

    #[test]
    fn counters_older_than_the_window_are_refused() {
        let (mut caller, mut callee) = pair();
        let now = Instant::now();
        let frames: Vec<_> = (0..=REPLAY_WINDOW + 2).map(|_| caller.seal(&[0x02, 1], now).unwrap().unwrap()).collect();
        assert!(callee.receive(&frames[REPLAY_WINDOW as usize + 2], now).unwrap().is_some());
        // Never seen, so only its age can refuse them: their ring slots are free.
        assert_eq!(callee.receive(&frames[1], now), Ok(None), "1,025 behind the newest");
        assert_eq!(callee.receive(&frames[2], now), Ok(None), "1,024 behind the newest");
        assert_eq!(callee.counters().rejected, 2);
        assert!(callee.receive(&frames[3], now).unwrap().is_some(), "1,023 behind is still inside");
    }

    #[test]
    fn the_replay_window_forgets_slots_it_passes() {
        let mut window = ReplayWindow::default();
        window.mark(5);
        assert!(!window.allows(5));
        window.mark(5 + REPLAY_WINDOW - 1);
        assert!(!window.allows(5), "still inside");
        window.mark(5 + REPLAY_WINDOW);
        assert!(!window.allows(5), "now too old");
        assert!(window.allows(6 + REPLAY_WINDOW));
        assert!(!window.allows(5 + REPLAY_WINDOW));
        // A jump past a whole window leaves no old bit behind.
        window.mark(5 + 5 * REPLAY_WINDOW);
        assert!(window.allows(5 + 5 * REPLAY_WINDOW - 1));
        // A slot reused in the ring reads as unseen after its counter passed by.
        let mut ring = ReplayWindow::default();
        ring.mark(0);
        ring.mark(REPLAY_WINDOW + 10);
        assert!(ring.allows(REPLAY_WINDOW));
    }

    fn at_epoch(epoch: u8) -> (SealedMedia, SealedMedia) {
        let (mut caller, callee) = pair();
        let send = caller.send.as_mut().unwrap();
        for _ in 0..epoch {
            send.key = next_epoch_key(&send.key);
        }
        send.epoch = epoch;
        (caller, callee)
    }

    #[test]
    fn junk_at_any_epoch_changes_no_state() {
        let now = Instant::now();
        let (mut caller, mut callee) = pair();
        let good = caller.seal(&[0x02, 1], now).unwrap().unwrap();
        for epoch in [0u8, 1, 2, 3, 200] {
            let mut junk = vec![TYPE_SEALED, epoch, 0, 0, 0, 9];
            junk.extend_from_slice(&[0x5a; 150]);
            assert_eq!(callee.receive(&junk, now), Ok(None));
            let read = callee.read.as_ref().unwrap();
            assert_eq!(read.current.epoch, 0, "no epoch advance");
            assert!(read.previous.is_none(), "no readable epoch lost");
            assert!(read.current.window.highest.is_none(), "no replay bit");
        }
        assert!(callee.receive(&good, now).unwrap().is_some());
    }

    #[test]
    fn senders_rotate_on_age_and_on_frame_count_and_receivers_follow() {
        let (mut caller, mut callee) = pair();
        let start = Instant::now();
        let first = caller.seal(&[0x02, 1], start).unwrap().unwrap();
        assert_eq!(first[1], 0);
        let late = start + EPOCH_MAX_AGE + Duration::from_secs(1);
        let rotated = caller.seal(&[0x02, 2], late).unwrap().unwrap();
        assert_eq!(rotated[1], 1, "60 s of its own clock");
        assert_eq!(&rotated[2..6], &[0, 0, 0, 0], "the counter restarts");
        assert!(callee.receive(&rotated, late).unwrap().is_some());
        assert_eq!(callee.read.as_ref().unwrap().current.epoch, 1);
        // The previous epoch stays readable for its grace.
        assert!(callee.receive(&first, late + Duration::from_secs(1)).unwrap().is_some());
        // Exactly the frame limit.
        let (mut caller, _) = pair();
        caller.send.as_mut().unwrap().counter = EPOCH_MAX_FRAMES - 1;
        let now = caller.send.as_ref().unwrap().epoch_started;
        assert_eq!(caller.seal(&[0x02, 1], now).unwrap().unwrap()[1], 0);
        assert_eq!(caller.seal(&[0x02, 1], now).unwrap().unwrap()[1], 1);
    }

    #[test]
    fn the_previous_epoch_retires_after_its_grace_and_its_key_is_gone() {
        let (mut caller, mut callee) = pair();
        let start = Instant::now();
        let old = caller.seal(&[0x02, 1], start).unwrap().unwrap();
        let next = start + EPOCH_MAX_AGE;
        let rotated = caller.seal(&[0x02, 2], next).unwrap().unwrap();
        callee.receive(&rotated, next).unwrap();
        assert_eq!(callee.receive(&old, next + PREVIOUS_EPOCH_GRACE), Ok(None));
        assert!(callee.read.as_ref().unwrap().previous.is_none(), "retired, wiped");
    }

    #[test]
    fn up_to_two_epochs_forward_open_and_three_do_not() {
        let now = Instant::now();
        let (mut caller, mut callee) = at_epoch(2);
        let ahead = caller.seal(&[0x02, 1], now).unwrap().unwrap();
        assert_eq!(ahead[1], 2);
        assert!(callee.receive(&ahead, now).unwrap().is_some());
        assert_eq!(callee.read.as_ref().unwrap().current.epoch, 2);
        assert_eq!(callee.read.as_ref().unwrap().previous.as_ref().unwrap().0.epoch, 1);
        let (mut caller, mut callee) = at_epoch(3);
        let beyond = caller.seal(&[0x02, 1], now).unwrap().unwrap();
        assert_eq!(callee.receive(&beyond, now), Ok(None));
        assert_eq!(callee.read.as_ref().unwrap().current.epoch, 0);
    }

    #[test]
    fn a_read_key_only_goes_forward() {
        let (mut caller, mut callee) = at_epoch(1);
        let now = Instant::now();
        let frame = caller.seal(&[0x02, 1], now).unwrap().unwrap();
        callee.receive(&frame, now).unwrap();
        // An older epoch than the kept one cannot be asked for: no key for it.
        let read = callee.read.as_ref().unwrap();
        assert_eq!(read.current.epoch, 1);
        assert_eq!(read.previous.as_ref().unwrap().0.epoch, 0);
        let (mut caller2, mut callee2) = at_epoch(2);
        let frame = caller2.seal(&[0x02, 1], now).unwrap().unwrap();
        callee2.receive(&frame, now).unwrap();
        let mut older = vec![TYPE_SEALED, 0, 0, 0, 0, 1];
        older.extend_from_slice(&[0u8; 150]);
        assert_eq!(callee2.receive(&older, now), Ok(None));
    }

    #[test]
    fn the_last_epoch_ending_ends_the_call_and_never_reuses_a_key() {
        let (mut caller, _) = at_epoch(255);
        let now = caller.send.as_ref().unwrap().epoch_started;
        assert!(caller.seal(&[0x02, 1], now).unwrap().is_some());
        caller.send.as_mut().unwrap().counter = EPOCH_MAX_FRAMES;
        assert_eq!(caller.seal(&[0x02, 1], now), Err(SealError::Exhausted));
    }

    // ---- timers ------------------------------------------------------------

    #[test]
    fn the_caller_repeats_its_reveal_until_a_frame_authenticates() {
        let (mut caller, mut callee) = pair();
        let start = Instant::now();
        caller.link_opened(start);
        assert_eq!(caller.tick(start + Duration::from_millis(250)), Ok(Tick::Nothing));
        assert!(matches!(caller.tick(start + REVEAL_INTERVAL + Duration::from_millis(1)), Ok(Tick::Send(_))));
        assert_eq!(caller.counters().reveals_out, 2);
        let frame = callee.seal(&[0x02, 1], start).unwrap().unwrap();
        assert!(!caller.authenticated());
        caller.receive(&frame, start).unwrap();
        assert!(caller.authenticated());
        assert!(caller.take_first_authentic());
        assert!(!caller.take_first_authentic(), "reported once");
        let another = callee.seal(&[0x02, 2], start).unwrap().unwrap();
        caller.receive(&another, start).unwrap();
        assert!(!caller.take_first_authentic(), "and not again on the next frame");
        assert_eq!(caller.tick(start + Duration::from_secs(9)), Ok(Tick::Nothing));
    }

    #[test]
    fn junk_does_not_stop_the_reveal_or_count_as_authentic() {
        let (mut caller, _) = pair();
        let now = Instant::now();
        let mut junk = vec![TYPE_SEALED, 0, 0, 0, 0, 0];
        junk.extend_from_slice(&[0x11; 150]);
        caller.receive(&junk, now).unwrap();
        assert!(!caller.authenticated());
        assert!(!caller.take_first_authentic());
    }

    #[test]
    fn no_reveal_in_time_ends_the_call_and_a_new_link_restarts_the_clock() {
        let (_, mut callee) = exchanged();
        let start = Instant::now();
        callee.link_opened(start);
        assert_eq!(callee.tick(start + REVEAL_TIMEOUT - Duration::from_millis(1)), Ok(Tick::Nothing));
        assert_eq!(callee.tick(start + REVEAL_TIMEOUT), Err(SealError::NoReveal));
        let reopened = start + Duration::from_secs(4);
        callee.link_opened(reopened);
        assert_eq!(callee.tick(start + REVEAL_TIMEOUT), Ok(Tick::Nothing));
    }

    #[test]
    fn frames_that_never_authenticate_end_the_call_after_ten_seconds() {
        let (_, mut callee) = pair();
        let start = Instant::now();
        callee.link_opened(start);
        let mut junk = vec![TYPE_SEALED, 0, 0, 0, 0, 0];
        junk.extend_from_slice(&[0x11; 150]);
        callee.receive(&junk, start + Duration::from_secs(9)).unwrap();
        assert_eq!(callee.tick(start + Duration::from_secs(9)), Ok(Tick::Nothing));
        let late = start + NO_AUTHENTIC_LIMIT;
        callee.receive(&junk, late).unwrap();
        assert_eq!(callee.tick(late), Err(SealError::NoAuthenticFrames));
    }

    #[test]
    fn a_silent_stall_does_not_end_the_call() {
        let (mut caller, mut callee) = pair();
        let start = Instant::now();
        callee.link_opened(start);
        let frame = caller.seal(&[0x02, 1], start).unwrap().unwrap();
        callee.receive(&frame, start).unwrap();
        // One bad frame, then silence for a minute: nothing is arriving.
        let mut junk = vec![TYPE_SEALED, 0, 0, 0, 0, 9];
        junk.extend_from_slice(&[0x11; 150]);
        callee.receive(&junk, start + Duration::from_secs(1)).unwrap();
        assert_eq!(callee.tick(start + Duration::from_secs(60)), Ok(Tick::Nothing));
    }

    #[test]
    fn one_bad_packet_among_good_ones_changes_nothing() {
        let (mut caller, mut callee) = pair();
        let start = Instant::now();
        callee.link_opened(start);
        let mut junk = vec![TYPE_SEALED, 0, 0, 0, 0, 9];
        junk.extend_from_slice(&[0x11; 150]);
        for second in 0..30u64 {
            let now = start + Duration::from_secs(second);
            let frame = caller.seal(&[0x02, 1], now).unwrap().unwrap();
            callee.receive(&frame, now).unwrap();
            callee.receive(&junk, now + Duration::from_millis(1)).unwrap();
            assert_eq!(callee.tick(now + Duration::from_millis(2)), Ok(Tick::Nothing));
        }
    }

    // ---- the flag ----------------------------------------------------------

    #[test]
    fn the_flag_takes_only_the_exact_value() {
        assert!(flag_is_on(Some("sealed")));
        for value in [None, Some(""), Some("1"), Some("true"), Some("Sealed"), Some("sealed "), Some("seale")] {
            assert!(!flag_is_on(value), "{value:?}");
        }
        assert_eq!(enabled(), option_env!("VITE_CALL_SEAL") == Some("sealed"));
    }
}
