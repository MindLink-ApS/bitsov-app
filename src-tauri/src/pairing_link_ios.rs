//! iOS-only URL inbox, the counterpart of the Android `PairingLinkPlugin`. No
//! persistence, logging, parsing or auto-import.
//!
//! The native scene bridge captures cold connectionOptions.URLContexts and
//! warm openURLContexts before forwarding to tao. RunEvent::Opened is retained
//! as a deduplicated fallback. The renderer takes each link once through
//! `pairing_link_take`, and import and validation belong to the existing
//! pairing command, called only after the owner confirms in the webview.
//!
//! The official deep-link plugin is deliberately not used: on iOS it emits
//! every opened URL on the global `deep-link://new-url` event and keeps it in
//! memory for `get_current`, so a bearer ticket would reach the event bus.
use std::collections::VecDeque;
use std::sync::Mutex;

const PAIRING_PREFIX: &str = "bitsov://pair/";
/// Same bound as Android and `normalizePairingLink`: an oversized link still
/// opens the review screen, which then shows a validation error.
const MAX_LINK_LEN: usize = PAIRING_PREFIX.len() + 16384;
/// Bounded: a hostile app firing random links can only evict old receipts.
const MAX_RECEIPTS: usize = 32;

type Digest = [u8; 32];

/// Take-once, newest-only. Receipts are SHA-256 digests of links already
/// handed to the renderer; the tickets themselves are never retained.
pub(crate) struct Inbox {
    pending: Option<(String, Digest)>,
    taken: VecDeque<Digest>,
}

impl Inbox {
    pub(crate) const fn new() -> Self {
        Self { pending: None, taken: VecDeque::new() }
    }

    /// The Info.plist registers the whole `bitsov` scheme; like Android's
    /// `host="pair"` intent filter, only pairing links enter the inbox.
    pub(crate) fn receive(&mut self, link: &str) {
        if !link.starts_with(PAIRING_PREFIX) {
            return;
        }
        let digest = digest(link);
        // A link already reviewed is not a fresh confirmation prompt.
        if self.taken.contains(&digest) {
            return;
        }
        // Preserve the exact URL; newer links replace an untaken one.
        let kept = if link.len() <= MAX_LINK_LEN { link.to_owned() } else { String::new() };
        self.pending = Some((kept, digest));
    }

    /// Record the receipt before handing the link out, as Android does.
    pub(crate) fn take(&mut self) -> Option<String> {
        let (link, digest) = self.pending.take()?;
        self.taken.retain(|taken| *taken != digest);
        self.taken.push_back(digest);
        while self.taken.len() > MAX_RECEIPTS {
            self.taken.pop_front();
        }
        Some(link)
    }
}

fn digest(link: &str) -> Digest {
    let mut out = [0u8; 32];
    out.copy_from_slice(ring::digest::digest(&ring::digest::SHA256, link.as_bytes()).as_ref());
    out
}

static INBOX: Mutex<Inbox> = Mutex::new(Inbox::new());

/// Called from the run loop for `RunEvent::Opened`, in delivery order.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub(crate) fn receive<'a>(urls: impl IntoIterator<Item = &'a str>) {
    let Ok(mut inbox) = INBOX.lock() else { return };
    for url in urls {
        inbox.receive(url);
    }
}

#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub(crate) fn take() -> Result<Option<String>, String> {
    let mut inbox = INBOX.lock().map_err(|_| "could not read pairing link inbox")?;
    Ok(inbox.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cold_scene_link_survives_until_mount_and_warm_delivery_is_deduplicated() {
        let mut inbox = Inbox::new();
        // The native willConnect hook runs before Tao creates the webview.
        inbox.receive("bitsov://pair/cold-launch-fixture");
        // A duplicate Opened callback before the first take is harmless.
        inbox.receive("bitsov://pair/cold-launch-fixture");
        assert!(inbox.pending.is_some());
        assert!(inbox.take().is_some());
        inbox.receive("bitsov://pair/cold-launch-fixture");
        assert!(inbox.take().is_none());
    }

    #[test]
    fn take_is_once_and_empty_by_default() {
        let mut inbox = Inbox::new();
        assert_eq!(inbox.take(), None);
        inbox.receive("bitsov://pair/first");
        assert_eq!(inbox.take().as_deref(), Some("bitsov://pair/first"));
        assert_eq!(inbox.take(), None);
    }

    #[test]
    fn only_the_newest_link_is_kept() {
        let mut inbox = Inbox::new();
        inbox.receive("bitsov://pair/first");
        inbox.receive("bitsov://pair/second");
        inbox.receive("bitsov://pair/newest");
        assert_eq!(inbox.take().as_deref(), Some("bitsov://pair/newest"));
        assert_eq!(inbox.take(), None);
    }

    #[test]
    fn ignores_other_bitsov_links_and_schemes() {
        let mut inbox = Inbox::new();
        for link in [
            "bitsov://introduce#card.offer",
            "bitsov://invite/abc",
            "bitsov://pair",
            "bitsov://pairx/abc",
            "https://example.com/bitsov://pair/abc",
            "",
        ] {
            inbox.receive(link);
        }
        assert_eq!(inbox.take(), None);
        // A non-pairing link never evicts a queued pairing link.
        inbox.receive("bitsov://pair/kept");
        inbox.receive("bitsov://sponsor-request#x");
        assert_eq!(inbox.take().as_deref(), Some("bitsov://pair/kept"));
    }

    #[test]
    fn a_taken_link_is_not_queued_again() {
        let mut inbox = Inbox::new();
        inbox.receive("bitsov://pair/once");
        assert!(inbox.take().is_some());
        inbox.receive("bitsov://pair/once");
        assert_eq!(inbox.take(), None);
        // An untaken link may be replaced and re-delivered freely.
        inbox.receive("bitsov://pair/a");
        inbox.receive("bitsov://pair/b");
        inbox.receive("bitsov://pair/a");
        assert_eq!(inbox.take().as_deref(), Some("bitsov://pair/a"));
    }

    #[test]
    fn receipts_are_bounded_digests() {
        let mut inbox = Inbox::new();
        for i in 0..(MAX_RECEIPTS + 5) {
            inbox.receive(&format!("bitsov://pair/t{i}"));
            assert!(inbox.take().is_some());
        }
        assert_eq!(inbox.taken.len(), MAX_RECEIPTS);
        // The oldest receipts were evicted; the newest still block.
        inbox.receive("bitsov://pair/t0");
        assert_eq!(inbox.take().as_deref(), Some("bitsov://pair/t0"));
        inbox.receive(&format!("bitsov://pair/t{}", MAX_RECEIPTS + 4));
        assert_eq!(inbox.take(), None);
    }

    #[test]
    fn oversized_link_opens_review_empty() {
        let mut inbox = Inbox::new();
        let at_limit = format!("{PAIRING_PREFIX}{}", "A".repeat(16384));
        inbox.receive(&at_limit);
        assert_eq!(inbox.take().as_deref(), Some(at_limit.as_str()));
        let over = format!("{PAIRING_PREFIX}{}", "B".repeat(16385));
        inbox.receive(&over);
        assert_eq!(inbox.take().as_deref(), Some(""));
        inbox.receive(&over);
        assert_eq!(inbox.take(), None);
    }

    #[test]
    fn url_round_trip_preserves_a_ticket() {
        // tao parses the iOS URL into `url::Url`; base64url tickets survive.
        let link = "bitsov://pair/eyJ2IjoyLCJlbmRwb2ludCI6ImhvbWUifQ_-x";
        let url = tauri::Url::parse(link).unwrap();
        receive([url.as_str()]);
        assert_eq!(take().unwrap().as_deref(), Some(link));
        assert_eq!(take().unwrap(), None);
    }
}
