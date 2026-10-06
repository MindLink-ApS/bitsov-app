//! Porch reads, host side (genome `docs/protocol/BROWSE.md`, `porch_read_v1`).
//!
//! One read pays the owner's page price once through the node's
//! `POST /api/v1/browse/fetch`, and the reply is bound to that payment. This
//! module is the pure part: which paths a porch serves, the request body, how
//! a node answer is classified (refused before paying, paid without an
//! answer, or a reply), and what reaches the renderer. A served card is
//! verified here again before it is shown. A page body is text, cleaned of
//! control and invisible formatting characters; nothing here or in the
//! renderer treats it as HTML.

use serde::{Deserialize, Serialize};

use crate::act::{ActionError, PaymentQuote};
use crate::control::PeerPrice;
use crate::front_door::{Card, FrontDoor};

/// `/status` capability: this node has `POST /browse/fetch`.
pub const CAPABILITY: &str = "porch_read_v1";
/// How a connected peer's node lists the same advert (federation Hello,
/// `Capability::Custom`, rendered with `{:?}`). Only such a peer answers a read.
pub const PEER_CAPABILITY: &str = r#"Custom("porch_read_v1")"#;
pub const QUOTE_CAPABILITY: &str = "porch_quote_v1";
pub const PEER_QUOTE_CAPABILITY: &str = r#"Custom("porch_quote_v1")"#;
pub const QUOTE_ROUTE: &str = "/browse/quote";
pub const ROUTE: &str = "/browse/fetch";
pub const CARDS_ROUTE: &str = "/browse/cards";
/// The owner's published card, served even when their site is off.
pub const CARD_PATH: &str = "/front-door.json";
pub const MAX_BODY_BYTES: usize = 256 * 1024;
pub const MAX_PATH_LEN: usize = 128;
/// `KIND_PAGE_REQUEST`: what a read pays for.
pub const KIND_PAGE_REQUEST: u16 = 500;
/// Pricing category of kind 500 in `/pricing/peers` tables.
pub const CATEGORY_WEB_CONTENT: &str = "web_content";
/// Genome's sender-side floor (`caps::payable`): a read never pays less.
pub const MIN_READ_MSAT: u64 = 1_000;
/// Genome's `REPLY_TIMEOUT` for the bound reply.
pub const REPLY_TIMEOUT_SECS: u64 = 20;
/// Genome `MAX_CACHED_CARDS`.
pub const MAX_CACHED_CARDS: usize = 512;

/// A flat, visible `.md` or `.txt` page at the site root (genome `is_site_page`).
pub fn is_site_page(path: &str) -> bool {
    let Some(name) = path.strip_prefix('/') else { return false };
    path.len() <= MAX_PATH_LEN
        && !name.starts_with('.')
        && (name.ends_with(".md") || name.ends_with(".txt"))
        && !name.contains("..")
        && !name.chars().any(|c| matches!(c, '/' | '\\' | '%') || c.is_control())
}

/// The canonical porch path for what the owner typed or a card names
/// (`index.md` or `/index.md`), or why it is not one. Checked before any quote.
pub fn porch_path(input: &str) -> Result<String, ActionError> {
    let trimmed = input.trim();
    let path = if trimmed.starts_with('/') { trimmed.to_string() } else { format!("/{trimmed}") };
    if path == CARD_PATH || is_site_page(&path) {
        Ok(path)
    } else {
        Err(refused("porch_path_invalid"))
    }
}

/// What one read costs before the network fee: the peer's fresh advertised
/// web-content price, else this node's own, never below the 1-sat floor.
/// This is how the node's compose prices it.
pub fn read_price(table: Option<&PeerPrice>, own_msat: u64) -> u64 {
    table
        .filter(|t| !t.stale)
        .and_then(|t| t.prices.get(CATEGORY_WEB_CONTENT).copied())
        .unwrap_or(own_msat)
        .max(MIN_READ_MSAT)
}

/// Free path-specific metadata. Bind it to the requested peer and path and
/// keep recipient principal separate from the node's maximum routing fee.
pub fn quote(text: &str, peer: &str, path: &str) -> Result<PaymentQuote, ActionError> {
    #[derive(Deserialize)]
    struct QuoteReply {
        node_id: String,
        path: String,
        status: String,
        amount_msat: Option<u64>,
        max_routing_fee_msat: u64,
        max_total_msat: u64,
    }
    let invalid = || refused("porch_quote_invalid");
    let reply: QuoteReply = serde_json::from_str(text).map_err(|_| invalid())?;
    if !reply.node_id.eq_ignore_ascii_case(peer) || reply.path != path {
        return Err(invalid());
    }
    if reply.status != "Ok" {
        if reply.amount_msat.is_some() || reply.max_total_msat != 0 || reply.max_routing_fee_msat != 0 {
            return Err(invalid());
        }
        return Err(refused(match reply.status.as_str() {
            "NotFound" => "porch_not_found",
            "Forbidden" => "porch_knock_first",
            _ => "porch_unavailable",
        }));
    }
    let principal_msat = reply.amount_msat.filter(|n| *n >= MIN_READ_MSAT).ok_or_else(invalid)?;
    if principal_msat.checked_add(reply.max_routing_fee_msat) != Some(reply.max_total_msat)
        || reply.max_total_msat > 9_007_199_254_740_991 { // renderer's exact integer range
        return Err(invalid());
    }
    Ok(PaymentQuote { principal_msat, max_routing_fee_msat: reply.max_routing_fee_msat, total_msat: reply.max_total_msat })
}

/// The `/browse/fetch` body (genome `FetchRequest`, `deny_unknown_fields`).
pub fn fetch_body(node_id: &str, path: &str, max_total_msat: u64, max_routing_fee_msat: u64) -> serde_json::Value {
    serde_json::json!({
        "node_id": node_id,
        "path": path,
        "max_total_msat": max_total_msat,
        "max_routing_fee_msat": max_routing_fee_msat,
    })
}

/// `1 sat`, `6 sats`, or msat when not a whole sat.
pub fn amount(msat: u64) -> String {
    match (msat % 1000, msat / 1000) {
        (0, 1) => "1 sat".into(),
        (0, sats) => format!("{sats} sats"),
        _ => format!("{msat} msat"),
    }
}

const REFUSALS: [&str; 5] = ["porch_path_invalid", "porch_own_node", "porch_unreachable", "porch_knock_first", "porch_busy"];
const PAID_FAILURES: [&str; 3] = ["porch_timeout", "porch_reply_invalid", "porch_card_mismatch"];

/// A refusal before any payment, as a plain sentence.
pub fn refused(code: &'static str) -> ActionError {
    let text = match code {
        "porch_knock_first" => "Knock first. You have no session with this node yet: Knock from their profile link (it pays their admission once), then read their porch.",
        "porch_unreachable" => "Their node is not reachable right now: your node is not connected to it. Try again when they are online.",
        "porch_busy" => "A read from this node is already in progress. Wait for it to finish.",
        "porch_own_node" => "That is your own node. Your own profile is under Profile in Settings.",
        "porch_path_invalid" => "A porch serves its profile card and flat .md or .txt pages only, like /index.md.",
        "porch_unsupported" => "Their node does not offer porch reads (it does not advertise porch_quote_v1 or legacy porch_read_v1).",
        "porch_unavailable" => "This card or page is unavailable right now.",
        "porch_not_found" => "Not found or empty: their node has no content at this path.",
        "porch_quote_unavailable" => "Their node could not provide a quote. It may need upgrading or may be offline. Try checking again later.",
        "porch_quote_invalid" => "Their node returned an invalid availability or price quote.",
        "porch_room" => "Porch reads are only available for individual contacts, not rooms.",
        "porch_needs_contact" => "Porch reads go to contacts you have already paid. Knock or send them a message first.",
        "porch_readmission" => "Their node asks yours to pay admission again (after a reconnect or a restart), and a porch read never pays admission. Send them a message first, then read.",
        _ => "Your node refused this read.",
    };
    ActionError::new(code, format!("{text} Nothing was paid."))
}

/// Paid, but no usable answer. Known money: the app does not retry.
pub fn paid_failure(code: &'static str, paid_msat: u64) -> ActionError {
    let paid = amount(paid_msat);
    let text = match code {
        "porch_timeout" => format!("Paid {paid}, but their node did not answer within {REPLY_TIMEOUT_SECS} seconds. The app does not retry: reading again pays again."),
        "porch_card_mismatch" => format!("Paid {paid}, but their node served a card signed by another node. It was not kept or shown."),
        _ => format!("Paid {paid}, but their node's answer could not be read. Nothing is shown."),
    };
    ActionError::new(code, text)
}

/// How the node answered a read that did not succeed, when it said.
#[derive(Debug, PartialEq, Eq)]
pub enum Answer {
    /// Refused before anything was paid: release the reservation.
    Refused(ActionError),
    /// The read paid `paid_msat` principal and got no usable reply.
    Paid { paid_msat: u64, error: ActionError },
}

/// Classify a non-2xx `/browse/fetch` answer by the node's `reason`. `None`
/// is anything else: the caller keeps its unknown-outcome handling.
pub fn answer(status: u16, body: &str) -> Option<Answer> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let reason = v.get("reason")?.as_str()?;
    let prepayment = match (status, reason) {
        (404, "porch_not_found") => Some("porch_not_found"),
        (409, "porch_unavailable") => Some("porch_unavailable"),
        (409, "porch_quote_unavailable") => Some("porch_quote_unavailable"),
        (409, "porch_quote_invalid") => Some("porch_quote_invalid"),
        (400, "porch_room") => Some("porch_room"),
        (400 | 409, _) => REFUSALS.iter().find(|c| **c == reason).copied(),
        _ => None,
    };
    if let Some(code) = prepayment {
        return Some(Answer::Refused(refused(code)));
    }
    if status == 502 {
        let code = PAID_FAILURES.iter().find(|c| **c == reason)?;
        let paid_msat = paid_in(v.get("error")?.as_str()?)?;
        return Some(Answer::Paid { paid_msat, error: paid_failure(code, paid_msat) });
    }
    None
}

/// `N` from the genome's `…: paid N msat, …`.
fn paid_in(text: &str) -> Option<u64> {
    let rest = &text[text.find("paid ")? + "paid ".len()..];
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 || !rest[digits..].starts_with(" msat") {
        return None;
    }
    rest[..digits].parse().ok()
}

/// Principal the node reports for a successful read (genome `FetchResponse`).
pub fn principal(text: &str) -> Option<u64> {
    let reply: FetchReply = serde_json::from_str(text).ok()?;
    reply.amount_msat.checked_add(reply.readmission_msat.unwrap_or(0))
}

#[derive(Deserialize)]
struct FetchReply {
    node_id: String,
    path: String,
    status: String,
    #[serde(default)]
    content_type: String,
    #[serde(default)]
    body: String,
    amount_msat: u64,
    #[serde(default)]
    readmission_msat: Option<u64>,
    message_id: String,
    #[serde(default)]
    card: Option<CardView>,
}

#[derive(Deserialize)]
struct CardView {
    card: Card,
    link: String,
    #[serde(default)]
    stale: bool,
}

#[derive(Deserialize)]
struct CardsReply {
    cards: Vec<CardView>,
}

/// A verified card as the renderer sees it.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct PorchCard {
    #[serde(flatten)]
    pub view: FrontDoor,
    /// Read from what this node already holds, not paid for now.
    pub cached: bool,
    /// The node kept a newer card it held: this read served an older one.
    pub stale: bool,
}

/// One paid read, projected. `body` is empty for a card or a missing page.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct PorchRead {
    pub node_id: String,
    pub path: String,
    /// `ok`, `not_found`, or `unavailable` (their node could not serve it).
    pub status: &'static str,
    /// `card`, `markdown`, `text`, or `none`.
    pub kind: &'static str,
    pub body: String,
    pub card: Option<PorchCard>,
    pub amount_msat: u64,
    /// What this read counts against the budget (the all-in ceiling).
    pub total_msat: u64,
    pub message_id: String,
}

fn verified(view: CardView, peer: Option<&str>, now_unix: u64, cached: bool) -> Result<PorchCard, String> {
    let shown = view.card.view(now_unix)?;
    if peer.is_some_and(|p| !shown.node_id.eq_ignore_ascii_case(p)) {
        return Err("the card is signed by another node".into());
    }
    if shown.link != view.link {
        return Err("the card link does not match the card".into());
    }
    Ok(PorchCard { view: shown, cached, stale: !cached && view.stale })
}

/// Drop C0/C1 controls (keeping newline and tab) and invisible formatting or
/// direction overrides, so a page cannot hide or reorder what it shows.
pub fn clean_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .chars()
        .map(|c| if matches!(c, '\r' | '\u{2028}' | '\u{2029}') { '\n' } else { c })
        .filter(|c| {
            !(c.is_control() && !matches!(c, '\n' | '\t'))
                && !matches!(c, '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')
        })
        .collect()
}

/// Project a successful `/browse/fetch` reply for `peer` and `path`.
pub fn project(text: &str, peer: &str, path: &str, total_msat: u64, now_unix: u64) -> Result<PorchRead, String> {
    let reply: FetchReply = serde_json::from_str(text).map_err(|e| format!("the reply is not a porch read ({e})"))?;
    if !reply.node_id.eq_ignore_ascii_case(peer) || reply.path != path {
        return Err("the reply names another node or page".into());
    }
    if reply.body.len() > MAX_BODY_BYTES {
        return Err("the page is larger than a porch serves".into());
    }
    let status = match reply.status.as_str() {
        "Ok" => "ok",
        "NotFound" => "not_found",
        _ => "unavailable",
    };
    let (kind, body, card) = match (status, path == CARD_PATH) {
        ("ok", true) => {
            let view = reply.card.ok_or("the node sent no verified card")?;
            ("card", String::new(), Some(verified(view, Some(peer), now_unix, false)?))
        }
        ("ok", false) => {
            let kind = if reply.content_type == "text/markdown" { "markdown" } else { "text" };
            (kind, clean_text(&reply.body), None)
        }
        _ => ("none", String::new(), None),
    };
    Ok(PorchRead {
        node_id: reply.node_id.to_ascii_lowercase(),
        path: reply.path,
        status,
        kind,
        body,
        card,
        amount_msat: reply.amount_msat,
        total_msat,
        message_id: reply.message_id,
    })
}

/// `GET /browse/cards`: every held card that verifies here, marked cached.
/// A card that does not verify is dropped, never shown.
pub fn cached_cards(text: &str, now_unix: u64) -> Result<Vec<PorchCard>, String> {
    let reply: CardsReply = serde_json::from_str(text).map_err(|e| format!("{CARDS_ROUTE} decode failed: {e}"))?;
    Ok(reply
        .cards
        .into_iter()
        .take(MAX_CACHED_CARDS)
        .filter_map(|view| verified(view, None, now_unix, true).ok())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::front_door::{FrontDoorPrices, FrontDoorProfile, FrontDoorSite, ProfileKind};
    use crate::introduction::Reach;
    use ed25519_dalek::{Signer, SigningKey};

    const NOW: u64 = 1_700_000_000;

    fn card(key: &SigningKey, seq: u64) -> Card {
        let mut card = Card {
            v: 1,
            network: "regtest".into(),
            node_id: hex::encode(key.verifying_key().to_bytes()),
            endpoint: "node.example.org:9000".into(),
            reach: Reach::Public,
            seq,
            issued_at: NOW,
            expires_at: NOW + 7 * 24 * 3600,
            prices: FrontDoorPrices { admission_msat: 100_000, message_msat: 10_000, page_msat: 1_000, price_epoch: 0 },
            profile: FrontDoorProfile {
                kind: ProfileKind::Person,
                display_name: "Maya".into(),
                tagline: String::new(),
                about: String::new(),
                avatar: None,
            },
            cv: None,
            media: vec![],
            site: Some(FrontDoorSite { index_path: Some("index.md".into()), page_count: 1, ..Default::default() }),
            links: vec![],
            sig: String::new(),
        };
        card.sig = hex::encode(key.sign(&card.digest().unwrap()).to_bytes());
        card
    }

    fn reply(card: Option<&Card>, path: &str, status: &str, content_type: &str, body: &str, node: &str) -> String {
        let card = card.map(|c| serde_json::json!({"card": c, "link": c.to_link().unwrap(), "fresh": true}));
        serde_json::json!({
            "node_id": node, "path": path, "status": status, "content_type": content_type,
            "body": body, "amount_msat": 1000, "message_id": "ab".repeat(32), "card": card,
        })
        .to_string()
    }

    #[test]
    fn quote_keeps_msat_units_and_refuses_unbound_or_invalid_metadata() {
        let valid = serde_json::json!({
            "node_id": "a", "path": "/notes.txt", "status": "Ok", "amount_msat": 1000,
            "max_routing_fee_msat": 1250, "max_total_msat": 2250,
        });
        let shown = quote(&valid.to_string(), "a", "/notes.txt").unwrap();
        assert_eq!((shown.principal_msat, shown.max_routing_fee_msat, shown.total_msat), (1000, 1250, 2250));
        for (field, value) in [
            ("node_id", serde_json::json!("b")), ("path", serde_json::json!("/other.txt")),
            ("amount_msat", serde_json::json!(null)), ("amount_msat", serde_json::json!(999)),
            ("max_routing_fee_msat", serde_json::json!(-1)), ("max_total_msat", serde_json::json!(2251)),
            ("status", serde_json::json!("NotFound")),
        ] {
            let mut bad = valid.clone();
            bad[field] = value;
            assert_eq!(quote(&bad.to_string(), "a", "/notes.txt").unwrap_err().code, "porch_quote_invalid", "{field}");
        }
    }

    #[test]
    fn paths_are_the_card_and_flat_visible_pages() {
        assert_eq!(porch_path("/front-door.json").unwrap(), CARD_PATH);
        assert_eq!(porch_path(" index.md ").unwrap(), "/index.md");
        assert_eq!(porch_path("/notes.txt").unwrap(), "/notes.txt");
        for bad in ["/page.html", "/blog/post.md", "/../x.md", "/.draft.md", "/a%2fb.md", "/x\u{0}.md", "", "/", "/front-door.seq"] {
            assert_eq!(porch_path(bad).unwrap_err().code, "porch_path_invalid", "{bad:?}");
        }
        assert!(porch_path(&format!("/{}.md", "a".repeat(MAX_PATH_LEN))).is_err());
    }

    #[test]
    fn a_read_costs_the_advertised_price_never_under_one_sat() {
        let table = |msat: u64, stale: bool| PeerPrice {
            peer_id: "a".into(),
            prices: [(CATEGORY_WEB_CONTENT.to_string(), msat)].into(),
            age_secs: 0,
            stale,
        };
        assert_eq!(read_price(None, 50), MIN_READ_MSAT);
        assert_eq!(read_price(None, 2_000), 2_000);
        assert_eq!(read_price(Some(&table(3_000, false)), 1_000), 3_000);
        assert_eq!(read_price(Some(&table(3_000, true)), 1_000), 1_000, "a stale table is not their price");
        assert_eq!(read_price(Some(&table(0, false)), 1_000), MIN_READ_MSAT);
        assert_eq!((amount(1_000), amount(6_000), amount(1_500)), ("1 sat".into(), "6 sats".into(), "1500 msat".into()));
    }

    #[test]
    fn refusals_before_paying_are_plain_sentences_that_say_nothing_was_paid() {
        for (status, reason, words) in [
            (409, "porch_knock_first", "Knock first"),
            (409, "porch_unreachable", "not reachable"),
            (409, "porch_busy", "already in progress"),
            (400, "porch_own_node", "your own node"),
            (400, "porch_path_invalid", ".md or .txt"),
        ] {
            let body = serde_json::json!({"error": format!("{reason}: detail"), "code": status, "reason": reason}).to_string();
            let Some(Answer::Refused(e)) = answer(status, &body) else { panic!("{reason}") };
            assert_eq!(e.code, reason);
            assert!(e.message.contains(words) && e.message.ends_with("Nothing was paid."), "{}", e.message);
            assert!(!e.message.contains('_'), "no codes in the sentence: {}", e.message);
        }
        // A reason the porch does not own, or none, is not classified here.
        assert_eq!(answer(409, r#"{"error":"x","code":"price_cap_exceeded"}"#), None);
        assert_eq!(answer(409, r#"{"error":"x","reason":"readmission_required"}"#), None);
        assert_eq!(answer(500, r#"{"error":"x","reason":"porch_busy"}"#), None);
        assert_eq!(answer(409, "not json"), None);
    }

    #[test]
    fn paid_without_an_answer_names_the_amount_and_does_not_retry() {
        let body = r#"{"error":"porch_timeout: paid 1000 msat, no reply within 20 s; not retried, a retry pays again","code":502,"reason":"porch_timeout"}"#;
        let Some(Answer::Paid { paid_msat, error }) = answer(502, body) else { panic!() };
        assert_eq!((paid_msat, error.code), (1_000, "porch_timeout"));
        assert!(error.message.starts_with("Paid 1 sat") && error.message.contains("reading again pays again"), "{}", error.message);
        let mismatch = r#"{"error":"porch_card_mismatch: paid 2000 msat, the node served a card for another node","reason":"porch_card_mismatch"}"#;
        assert!(matches!(answer(502, mismatch), Some(Answer::Paid { paid_msat: 2_000, .. })));
        // No amount it can read: the caller keeps the outcome unknown.
        assert_eq!(answer(502, r#"{"error":"porch_timeout: no reply","reason":"porch_timeout"}"#), None);
        assert_eq!(answer(502, r#"{"error":"payment settled","code":"payment_settled_send_incomplete"}"#), None);
    }

    #[test]
    fn a_card_read_shows_only_a_card_that_verifies_for_that_node() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let maya = card(&key, 3);
        let peer = maya.node_id.clone();
        let read = project(&reply(Some(&maya), CARD_PATH, "Ok", "application/json", "{…}", &peer), &peer, CARD_PATH, 6_000, NOW + 5).unwrap();
        assert_eq!((read.status, read.kind, read.body.as_str(), read.total_msat), ("ok", "card", "", 6_000));
        let shown = read.card.unwrap();
        assert_eq!((shown.view.seq, shown.cached, shown.stale, shown.view.verified), (3, false, false, true));

        // Signed by another key than the node read.
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let theirs = card(&other, 1);
        assert!(project(&reply(Some(&theirs), CARD_PATH, "Ok", "application/json", "", &peer), &peer, CARD_PATH, 6_000, NOW).is_err());
        // Tampered after signing.
        let mut forged = maya.clone();
        forged.profile.display_name = "Mallory".into();
        assert!(project(&reply(Some(&forged), CARD_PATH, "Ok", "application/json", "", &peer), &peer, CARD_PATH, 6_000, NOW).is_err());
        // An answer for another page or node.
        assert!(project(&reply(Some(&maya), CARD_PATH, "Ok", "", "", &peer), &peer, "/index.md", 6_000, NOW).is_err());
        assert!(project(&reply(None, "/index.md", "Ok", "text/plain", "x", &"cd".repeat(32)), &peer, "/index.md", 6_000, NOW).is_err());
    }

    #[test]
    fn a_page_is_cleaned_text_and_a_missing_one_has_no_body() {
        let peer = "ab".repeat(32);
        let page = "# Maya\r\n\u{202E}evil\u{200B} <script>x</script>\u{7}\n\tok";
        let read = project(&reply(None, "/index.md", "Ok", "text/markdown", page, &peer), &peer, "/index.md", 6_000, NOW).unwrap();
        assert_eq!((read.kind, read.body.as_str()), ("markdown", "# Maya\nevil <script>x</script>\n\tok"));
        let text = project(&reply(None, "/a.txt", "Ok", "text/html", "<b>", &peer), &peer, "/a.txt", 6_000, NOW).unwrap();
        assert_eq!(text.kind, "text", "never anything but text");
        let missing = project(&reply(None, "/gone.md", "NotFound", "", "Not found", &peer), &peer, "/gone.md", 6_000, NOW).unwrap();
        assert_eq!((missing.status, missing.kind, missing.body.as_str()), ("not_found", "none", ""));
        let big = "x".repeat(MAX_BODY_BYTES + 1);
        assert!(project(&reply(None, "/big.md", "Ok", "text/markdown", &big, &peer), &peer, "/big.md", 6_000, NOW).is_err());
    }

    #[test]
    fn held_cards_are_shown_as_cached_and_a_bad_one_is_dropped() {
        let maya = card(&SigningKey::from_bytes(&[7u8; 32]), 2);
        let mut forged = card(&SigningKey::from_bytes(&[9u8; 32]), 1);
        forged.seq = 5;
        let cards = serde_json::json!({"cards": [
            {"card": maya, "link": maya.to_link().unwrap(), "fresh": true},
            {"card": forged, "link": forged.to_link().unwrap(), "fresh": true},
        ]})
        .to_string();
        let held = cached_cards(&cards, NOW + 1).unwrap();
        assert_eq!(held.len(), 1);
        assert!(held[0].cached && !held[0].stale && held[0].view.fresh);
        assert_eq!(held[0].view.site.as_ref().unwrap().index_path.as_deref(), Some("index.md"));
        assert!(!cached_cards(&cards, NOW + 8 * 24 * 3600).unwrap()[0].view.fresh, "expired stays shown, marked");
    }
}
