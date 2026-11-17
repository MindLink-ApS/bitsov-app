//! Invisible payments (B2): per-contact and per-room budgets, and the owner's
//! one approval that lets messages pay inside them without a prompt.
//! Messages, files, invoice payments and keysend share the same daily all-in book.
//! Messages and files may ride an open budget approval; invoice/keysend stay
//! window-only. Routing allowances count; independent owner/node actions are outside.
//!
//! # What is stored, and what is not
//!
//! - **Stored** (`app-spend/budget-<node>.json`, 0600): budget *numbers* and a
//!   rolling 24-hour ledger of what app sends reserved and paid, plus accounted
//!   direct-payment hashes and all-in allowances (retained for replay detection). Nothing in
//!   the file can spend: no token, no scope, no grant, no approval state.
//! - **Not stored**: the owner's approval. [`Autopay`] lives in host memory for
//!   at most [`BUDGET_WINDOW_MS`]; the approval itself is the node's grant.
//!   After a restart the app reads that grant back from the node, never from
//!   this file, and resumes within its remaining total and its original expiry:
//!   nothing is renewed, refilled or extended. On a node without spending
//!   grants, sending automatically after a restart needs one new approval.
//!
//! # Limits, narrowest wins
//!
//! A send paid from the budget must fit all of: the contact's (or room's)
//! remaining budget, the daily total the owner approved, and the price cap the
//! node enforces per message (`max_total_msat`). A stranger is never paid
//! automatically: the first paid message to someone not in the book needs the
//! owner's explicit confirmation, which also sets that contact's budget.
//!
//! "Daily" is a rolling 24 hours, not a calendar day: there is no midnight
//! reset that would allow twice the budget around it, and no time zone to trust.

use crate::format::amount;
use std::collections::BTreeMap;
#[cfg(unix)]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::act::{ActionError, SpendBasis};
use crate::grant::GrantSummary;

// Separate tally rows: Lightning destinations are not BitSov contact node IDs.
pub const INVOICE_PAYMENTS: &str = "app:invoice-payments";
pub const KEYSEND_PAYMENTS: &str = "app:keysend-payments";

pub const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// How long one owner approval lets messages pay from the budget.
pub const BUDGET_WINDOW_MS: u64 = DAY_MS;

/// No approval, contact or room budget may exceed 100,000 sats a day.
pub const MAX_DAILY_MSAT: u64 = 100_000_000;

/// Past this many live entries, settled ones are compacted (never dropped),
/// and a send that would need a new line beyond it is refused.
pub const LEDGER_MAX: usize = 20_000;

const BOOK_VERSION: u32 = 1;

// ---- presets ------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PresetId {
    #[default]
    Careful,
    Everyday,
    Generous,
}

/// A named set of starting numbers. A preset is a suggestion for the owner's
/// approval; it never raises what was approved.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Preset {
    pub id: PresetId,
    /// Default budget for a newly confirmed contact, per 24 h.
    pub contact_msat: u64,
    /// Default budget for a room, per 24 h.
    pub room_msat: u64,
    /// The daily total the owner is asked to approve.
    pub ceiling_msat: u64,
}

pub const PRESETS: [Preset; 3] = [
    Preset { id: PresetId::Careful, contact_msat: 50_000, room_msat: 100_000, ceiling_msat: 500_000 },
    Preset { id: PresetId::Everyday, contact_msat: 200_000, room_msat: 500_000, ceiling_msat: 2_000_000 },
    Preset { id: PresetId::Generous, contact_msat: 1_000_000, room_msat: 2_500_000, ceiling_msat: 10_000_000 },
];

pub fn preset(id: PresetId) -> Preset {
    PRESETS.iter().copied().find(|p| p.id == id).unwrap_or(PRESETS[0])
}

// ---- the book (persisted numbers) ---------------------------------------------

/// Proven paid amount; with an unknown fee this is only the settled principal.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Paid {
    pub msat: u64,
    pub fee_unknown: bool,
}

/// One reservation or payment by an app-initiated paid send.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    /// The spend journal's request hash for this send.
    pub id: String,
    pub at_ms: u64,
    pub target: String,
    pub room: bool,
    /// Amount held against limits: in-flight ceiling, proven payment, or
    /// settled principal plus an allowance while the fee remains unknown.
    pub msat: u64,
    /// False while the outcome is unknown: the full ceiling stays counted.
    pub settled: bool,
    /// Old books stored allowances only. Missing evidence is never an exact payment.
    #[serde(default)]
    pub paid: Option<Paid>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Book {
    pub version: u32,
    pub node_id: String,
    pub preset: PresetId,
    /// The daily total the owner last approved. A number, not an authority.
    pub ceiling_msat: u64,
    /// Contacts the owner confirmed once, with their budget per 24 h.
    pub contacts: BTreeMap<String, u64>,
    pub rooms: BTreeMap<String, u64>,
    /// Pause-all. Sticky across restarts until the owner resumes.
    pub paused: bool,
    pub ledger: Vec<Entry>,
    /// Canonical direct-payment hashes and their original accounted allowances. Kept after
    /// ledger expiry/compaction: replaying an old receipt is never a new spend.
    #[serde(default)]
    pub accounted_payments: BTreeMap<String, u64>,
}

fn in_window(entry: &Entry, now_ms: u64) -> bool {
    // Unknown liabilities never age out. An entry from a clock that has
    // since moved back still counts too.
    !entry.settled || entry.at_ms.saturating_add(DAY_MS) > now_ms
}

impl Book {
    pub fn new(node_id: &str) -> Self {
        let p = preset(PresetId::default());
        Self {
            version: BOOK_VERSION,
            node_id: node_id.to_string(),
            preset: p.id,
            ceiling_msat: p.ceiling_msat,
            contacts: BTreeMap::new(),
            rooms: BTreeMap::new(),
            paused: false,
            ledger: Vec::new(),
            accounted_payments: BTreeMap::new(),
        }
    }

    fn map(&self, room: bool) -> &BTreeMap<String, u64> {
        if room { &self.rooms } else { &self.contacts }
    }

    fn map_mut(&mut self, room: bool) -> &mut BTreeMap<String, u64> {
        if room { &mut self.rooms } else { &mut self.contacts }
    }

    pub fn limit(&self, target: &str, room: bool) -> Option<u64> {
        self.map(room).get(target).copied()
    }

    /// Conservative enforcement total. Renderer paid totals come from `view`.
    pub fn spent_total(&self, now_ms: u64) -> u64 {
        self.ledger.iter().filter(|e| in_window(e, now_ms)).map(|e| e.msat).sum()
    }

    pub fn spent(&self, target: &str, room: bool, now_ms: u64) -> u64 {
        self.ledger
            .iter()
            .filter(|e| e.target == target && e.room == room && in_window(e, now_ms))
            .map(|e| e.msat)
            .sum()
    }

    /// Forget only settled charges that have left the 24-hour window. Every live charge stays
    /// counted: past [`LEDGER_MAX`], settled entries of one contact or room
    /// merge into a single entry holding their sum at the newest time. That
    /// can keep sats counted a little longer than 24 hours (under-spending),
    /// never shorter. Unsettled reservations keep their own lines, since a
    /// later settle or release finds them by id.
    pub fn prune(&mut self, now_ms: u64) {
        self.prune_retaining(now_ms, &[]);
    }

    /// Keep the journal's exact entries (the original attempt's and a retry's)
    /// until its accounting is durably cleared, including across a crash after
    /// settlement and before journal removal.
    pub fn prune_retaining(&mut self, now_ms: u64, keep: &[&str]) {
        let kept = |e: &Entry| keep.contains(&e.id.as_str());
        self.ledger.retain(|e| in_window(e, now_ms) || kept(e));
        if self.ledger.len() <= LEDGER_MAX {
            return;
        }
        let mut merged: BTreeMap<(String, bool), Entry> = BTreeMap::new();
        let mut open = Vec::new();
        for e in self.ledger.drain(..) {
            if !e.settled || kept(&e) {
                open.push(e);
                continue;
            }
            merged
                .entry((e.target.clone(), e.room))
                .and_modify(|m| {
                    m.paid = Some(Paid {
                        msat: m.paid.map_or(0, |p| p.msat).saturating_add(e.paid.map_or(0, |p| p.msat)),
                        fee_unknown: m.paid.is_none_or(|p| p.fee_unknown) || e.paid.is_none_or(|p| p.fee_unknown),
                    });
                    m.msat = m.msat.saturating_add(e.msat);
                    m.at_ms = m.at_ms.max(e.at_ms);
                })
                .or_insert_with(|| Entry { id: format!("compacted:{}", e.id), ..e });
        }
        self.ledger = merged.into_values().chain(open).collect();
        self.ledger.sort_by_key(|e| e.at_ms);
    }

    /// True when the ledger cannot take another line without dropping a live
    /// charge (only possible with thousands of unresolved sends).
    pub fn full(&self) -> bool {
        self.ledger.iter().filter(|e| !e.settled).count() >= LEDGER_MAX
    }

    /// Set, lower or (0) forget a budget. Never above the approved daily total.
    pub fn set_limit(&mut self, target: &str, room: bool, msat: u64) -> Result<(), ActionError> {
        if msat == 0 {
            self.map_mut(room).remove(target);
            return Ok(());
        }
        if msat > self.ceiling_msat {
            return Err(ActionError::invalid(format!(
                "That is above your approved daily total of {}. Raise the total first.",
                amount(self.ceiling_msat)
            )));
        }
        self.map_mut(room).insert(target.to_string(), msat);
        Ok(())
    }

    /// A lower daily total narrows every budget above it. Raising needs approval,
    /// which the caller asks for; the number itself is just recorded here.
    pub fn set_ceiling(&mut self, msat: u64) {
        self.ceiling_msat = msat;
        for v in self.contacts.values_mut().chain(self.rooms.values_mut()) {
            *v = (*v).min(msat);
        }
    }

    pub fn reserve(&mut self, id: &str, target: &str, room: bool, msat: u64, now_ms: u64) {
        // The journal-aware writer prunes after the edit, retaining current
        // and rollback accounting. Pruning here would erase rows it still needs.
        self.ledger.push(Entry { id: id.to_string(), at_ms: now_ms, target: target.to_string(), room, msat, settled: false, paid: None });
    }

    /// The node reported what was paid. Over the reservation is recorded as is.
    pub fn settle(&mut self, id: &str, msat: u64, now_ms: u64) {
        if let Some(e) = self.ledger.iter_mut().rev().find(|e| e.id == id) {
            // A delayed terminal result may have paid recently. Conservatively
            // count an aged liability for a new rolling day when resolving it.
            if !e.settled && e.at_ms.saturating_add(DAY_MS) <= now_ms {
                e.at_ms = now_ms;
            }
            e.msat = msat;
            e.settled = true;
            e.paid = Some(Paid { msat, fee_unknown: false });
        }
    }

    /// Account a canonical direct payment once. Persist this book as one atomic
    /// snapshot so its identity and allowance cannot be committed separately.
    pub fn settle_payment(&mut self, id: &str, hash: &str, msat: u64, now_ms: u64) {
        let Some(entry) = self.ledger.iter().rev().find(|e| e.id == id) else { return; };
        let hash = hash.to_ascii_lowercase();
        if entry.settled {
            // Crash after book save but before journal clear: leave this row
            // unchanged. Also retain the identity of a legacy journalled charge.
            if entry.msat > 0 {
                self.accounted_payments.entry(hash).or_insert(entry.msat);
            }
            return;
        }
        let paid = if let std::collections::btree_map::Entry::Vacant(entry) = self.accounted_payments.entry(hash) {
            entry.insert(msat);
            msat
        } else {
            0
        };
        // Keep a settled zero row for a replay, rather than removing it. The
        // identical request hash can also name the original charge; recovery
        // must keep finding this attempt until its journal is cleared.
        self.settle(id, paid, now_ms);
    }

    /// Refused before any payment (auth or price cap): nothing was spent.
    pub fn release(&mut self, id: &str) {
        if let Some(i) = self.ledger.iter().rposition(|e| e.id == id) {
            self.ledger.remove(i);
        }
    }
}

// ---- the owner's approval (memory only) ---------------------------------------

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutopayState {
    /// Never approved in this run, or paused/refused since.
    Off,
    Open,
    /// The approval ran out; one tap renews it.
    Expired,
}

/// The owner's budget approval. Host memory only; never written anywhere.
#[derive(Default, Debug)]
pub struct Autopay {
    armed_by_request: Option<String>,
    generation: u64,
    open: Option<(u64, u64, SpendBasis)>,
    expired: bool,
}

impl Autopay {
    pub fn arm(&mut self, now_ms: u64, ceiling_msat: u64, basis: SpendBasis) {
        self.arm_until(now_ms, u64::MAX, ceiling_msat, basis);
    }

    /// Open the approval, but never past `until_ms` (a G1 node grant's expiry).
    pub fn arm_until(&mut self, now_ms: u64, until_ms: u64, ceiling_msat: u64, basis: SpendBasis) {
        self.generation = self.generation.wrapping_add(1);
        self.open = Some(((now_ms + BUDGET_WINDOW_MS).min(until_ms), ceiling_msat, basis));
        self.armed_by_request = None;
        self.expired = false;
    }

    /// Complete the pending elevation after the caller has checked its poll fence.
    /// The request identity comes from that record, never from the grant cache.
    pub fn arm_pending_until(&mut self, now_ms: u64, until_ms: u64, ceiling_msat: u64, basis: SpendBasis, pending: &crate::act::Elevation) {
        self.arm_until(now_ms, until_ms, ceiling_msat, basis);
        self.armed_by_request = Some(pending.op_id.clone());
    }

    /// Read after settling the approval with `view` or `ceiling`.
    pub fn armed_by_request(&self) -> Option<&str> {
        self.open.and(self.armed_by_request.as_deref())
    }

    pub fn lock(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.open = None;
        self.armed_by_request = None;
        self.expired = false;
    }

    /// Lower the approved total in place. Raising is a new approval.
    pub fn narrow(&mut self, ceiling_msat: u64) {
        if let Some((_, c, _)) = &mut self.open {
            *c = (*c).min(ceiling_msat);
        }
    }

    /// A fresh node read can only narrow an already-open local approval.
    pub fn restrict(&mut self, until_ms: u64, ceiling_msat: u64) {
        if let Some((until, ceiling, _)) = &mut self.open {
            *until = (*until).min(until_ms);
            *ceiling = (*ceiling).min(ceiling_msat);
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    fn settle(&mut self, now_ms: u64) {
        if let Some((until, ..)) = self.open {
            if until <= now_ms {
                self.generation = self.generation.wrapping_add(1);
                self.open = None;
                self.armed_by_request = None;
                self.expired = true;
            }
        }
    }

    /// The approved daily total while open.
    pub fn ceiling(&mut self, now_ms: u64) -> Option<u64> {
        self.settle(now_ms);
        self.open.map(|(_, c, _)| c)
    }

    pub fn check_generation(&mut self, generation: u64, now_ms: u64) -> Result<(), ActionError> {
        self.settle(now_ms);
        if self.open.is_none() || self.generation != generation {
            return Err(ActionError::new("budget_needed", "Your budget approval changed while sending. Nothing was sent; approve it again."));
        }
        Ok(())
    }

    pub fn view(&mut self, now_ms: u64) -> AutopayView {
        self.settle(now_ms);
        AutopayView {
            state: match (self.open, self.expired) {
                (Some(_), _) => AutopayState::Open,
                (None, true) => AutopayState::Expired,
                (None, false) => AutopayState::Off,
            },
            open_until_ms: self.open.map(|(u, ..)| u),
            ceiling_msat: self.open.map(|(_, c, _)| c),
            basis: self.open.map(|(.., b)| b),
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct AutopayView {
    pub state: AutopayState,
    pub open_until_ms: Option<u64>,
    pub ceiling_msat: Option<u64>,
    pub basis: Option<SpendBasis>,
}

// ---- deciding one message send ------------------------------------------------

/// Which authority pays a message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// Inside the owner's budget approval: no prompt.
    Budget,
    /// The owner's explicit ten-minute window (slice B).
    Window,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub route: Route,
    /// Add this target to the book at this budget as part of the send.
    pub confirm: Option<u64>,
}

pub struct Ask<'a> {
    pub target: &'a str,
    pub room: bool,
    pub max_msat: u64,
    /// The owner confirmed a first paid message and chose this budget.
    pub first_contact_msat: Option<u64>,
    /// The approved daily total, while the owner's budget approval is open.
    pub autopay: Option<u64>,
    /// The ten-minute window's check, as slice B reports it.
    pub window: Result<(), ActionError>,
    pub now_ms: u64,
}

/// Decide, before any request, whether this message may be paid and by what.
///
/// Budgets are limits and approvals are authority: contact budgets
/// and the global daily ceiling hold even inside a ten-minute window.
/// Messages and files share this plan; invoice/keysend stay window-only.
pub fn plan(book: &Book, ask: Ask<'_>) -> Result<Plan, ActionError> {
    if book.paused {
        return Err(ActionError::new("budget_paused", "Payments are paused. Resume them to send."));
    }
    if book.full() {
        return Err(ActionError::new(
            "budget_ledger_full",
            "Too many unresolved sends to track another one. Check the pending results first.",
        ));
    }
    let who = if ask.room { "this room" } else { "this contact" };
    let known = book.limit(ask.target, ask.room);
    if let Some(limit) = known {
        let spent = book.spent(ask.target, ask.room, ask.now_ms);
        if spent.saturating_add(ask.max_msat) > limit {
            return Err(ActionError::new(
                "budget_exhausted",
                format!(
                    "You have used {} of {} for {who} in the last 24 hours, and this costs {}. Raise the budget to send.",
                    amount(spent), amount(limit), amount(ask.max_msat)
                ),
            ));
        }
    }
    let ceiling = ask.autopay.unwrap_or(book.ceiling_msat).min(book.ceiling_msat);
    let spent = book.spent_total(ask.now_ms);
    if spent.saturating_add(ask.max_msat) > ceiling {
        return Err(ActionError::new(
            "ceiling_exhausted",
            format!(
                "You have used {} of your {} app all-in payment limit (rolling 24 hours), and this costs {}. Raise the limit to send.",
                amount(spent), amount(ceiling), amount(ask.max_msat)
            ),
        ));
    }
    if ask.autopay.is_some() {
        let confirm = match (known, ask.first_contact_msat) {
            (Some(_), _) => None,
            (None, None) => {
                return Err(ActionError::new(
                    "first_contact",
                    format!("Your first paid message to {who} needs your OK once. Nothing was sent."),
                ))
            }
            (None, Some(msat)) => {
                let msat = msat.min(book.ceiling_msat);
                if msat < ask.max_msat {
                    return Err(ActionError::invalid(format!(
                        "A budget of {} does not cover this message ({}).",
                        amount(msat), amount(ask.max_msat)
                    )));
                }
                Some(msat)
            }
        };
        return Ok(Plan { route: Route::Budget, confirm });
    }
    ask.window?;
    let confirm = match (known, ask.first_contact_msat) {
        (None, Some(msat)) if msat <= book.ceiling_msat && msat >= ask.max_msat => Some(msat),
        _ => None,
    };
    Ok(Plan { route: Route::Window, confirm })
}

// ---- persistence --------------------------------------------------------------

fn unreadable(detail: impl std::fmt::Display) -> ActionError {
    ActionError::new("budget_unreadable", format!("Your budget file could not be read or written ({detail}). Automatic payments are off."))
}

/// `app-spend/budget-<first 16 hex of node id>.json`: one book per identity.
pub fn book_path(dir: &Path, node_id: &str) -> PathBuf {
    let short: String = node_id.chars().filter(|c| c.is_ascii_hexdigit()).take(16).collect::<String>().to_ascii_lowercase();
    dir.join(format!("budget-{short}.json"))
}

pub fn load(dir: &Path, node_id: &str) -> Result<Book, ActionError> {
    match std::fs::read(book_path(dir, node_id)) {
        Ok(bytes) => {
            let book: Book = serde_json::from_slice(&bytes).map_err(unreadable)?;
            if book.version != BOOK_VERSION || !book.node_id.eq_ignore_ascii_case(node_id) {
                return Err(unreadable("it belongs to another version or identity"));
            }
            Ok(book)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && crate::pairing::key::nothing_at(&book_path(dir, node_id)) => Ok(Book::new(node_id)),
        Err(e) => Err(unreadable(e)),
    }
}

/// Write-then-rename so a crash leaves the old book or the new one, never half.
#[cfg(unix)]
pub fn save(dir: &Path, book: &Book) -> Result<(), ActionError> {
    std::fs::create_dir_all(dir).map_err(unreadable)?;
    let path = book_path(dir, &book.node_id);
    let tmp = path.with_extension("json.tmp");
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&tmp).map_err(unreadable)?;
    file.write_all(&serde_json::to_vec(book).map_err(unreadable)?).map_err(unreadable)?;
    file.sync_all().map_err(unreadable)?;
    std::fs::rename(&tmp, &path).map_err(unreadable)?;
    Ok(())
}

#[cfg(not(unix))]
pub fn save(_dir: &Path, _book: &Book) -> Result<(), ActionError> {
    Err(unreadable("private budget storage is not supported on this platform"))
}

// ---- what the renderer sees ---------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub target: String,
    pub room: bool,
    /// None: paid under a ten-minute window, never confirmed for autopay.
    pub limit_msat: Option<u64>,
    pub unsettled_msat: u64,
    /// Proven payments only; excludes reservations and unreported fees.
    pub spent_msat: u64,
    /// Conservative amount used for limit enforcement, including unknown fees.
    pub accounted_msat: u64,
    pub fee_unknown: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct BudgetView {
    /// The verified node request this action acts on; null without a node request.
    pub request_id: Option<String>,
    /// Node op of the spending window this action armed; null if none or unknown.
    pub granted_op: Option<String>,
    /// The pending elevation completed to arm autopay; null without one or when closed.
    pub armed_by_request: Option<String>,
    pub paused: bool,
    pub autopay: AutopayView,
    /// A budget approval is waiting for the owner at the node.
    pub waiting_for_owner: bool,
    pub preset: PresetId,
    pub ceiling_msat: u64,
    /// Proven payments only; excludes reservations and unreported fees.
    pub spent_msat: u64,
    /// Conservative amount used for limit enforcement, including unknown fees.
    pub accounted_msat: u64,
    pub fee_unknown: bool,
    /// Reserved ceilings for sends whose outcome is not known yet; separate from paid.
    pub unsettled_msat: u64,
    pub rows: Vec<Row>,
    pub presets: Vec<Preset>,
    pub window_ms: u64,
    pub max_daily_msat: u64,
    /// The live G1 node grant this run's approvals are bounded by, if any.
    pub node_grant: Option<GrantSummary>,
}

pub fn view(book: &Book, autopay: AutopayView, waiting_for_owner: bool, now_ms: u64) -> BudgetView {
    let row = |target: &str, room: bool, limit_msat| {
        let entries: Vec<_> = book.ledger.iter().filter(|e| e.target == target && e.room == room && in_window(e, now_ms)).collect();
        Row {
            target: target.into(), room, limit_msat,
            spent_msat: entries.iter().filter(|e| e.settled).map(|e| e.paid.map_or(0, |p| p.msat)).sum(),
            unsettled_msat: entries.iter().filter(|e| !e.settled).map(|e| e.msat).sum(),
            accounted_msat: entries.iter().map(|e| e.msat).sum(),
            fee_unknown: entries.iter().any(|e| e.settled && e.paid.is_none_or(|p| p.fee_unknown)),
        }
    };
    let mut rows: Vec<Row> = Vec::new();
    for room in [false, true] {
        for (target, limit) in book.map(room) {
            rows.push(row(target, room, Some(*limit)));
        }
    }
    for e in book.ledger.iter().filter(|e| in_window(e, now_ms)) {
        if !rows.iter().any(|r| r.target == e.target && r.room == e.room) {
            rows.push(row(&e.target, e.room, None));
        }
    }
    rows.sort_by(|a, b| b.spent_msat.cmp(&a.spent_msat).then(a.target.cmp(&b.target)));
    BudgetView {
        request_id: None,
        granted_op: None,
        armed_by_request: None,
        paused: book.paused, autopay, waiting_for_owner, preset: book.preset,
        ceiling_msat: book.ceiling_msat,
        spent_msat: rows.iter().map(|r| r.spent_msat).sum(),
        unsettled_msat: rows.iter().map(|r| r.unsettled_msat).sum(),
        accounted_msat: book.spent_total(now_ms),
        fee_unknown: rows.iter().any(|r| r.fee_unknown),
        rows, presets: PRESETS.to_vec(), window_ms: BUDGET_WINDOW_MS,
        max_daily_msat: MAX_DAILY_MSAT, node_grant: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paid_totals_exclude_in_flight_ceiling_but_limits_include_it() {
        let mut book = Book::new(ME);
        book.set_limit(MAYA, false, 50_000).unwrap();
        book.reserve("paid", MAYA, false, 6000, T);
        book.settle("paid", 1000, T);
        book.reserve("pending", MAYA, false, 6000, T);
        let view = serde_json::to_value(view(&book, Autopay::default().view(T), false, T)).unwrap();
        assert_eq!(view["spent_msat"], 1000);
        assert_eq!(view["unsettled_msat"], 6000);
        assert_eq!(view["rows"][0]["spent_msat"], 1000);
        assert_eq!(view["rows"][0]["unsettled_msat"], 6000);
        assert_eq!(book.spent_total(T), 7000, "enforcement still includes reservations");
    }

    #[test]
    fn old_allowances_are_unknown_and_paid_evidence_survives_restart_and_compaction() {
        let mut book = Book::new(ME);
        book.reserve("legacy", MAYA, false, 6000, T);
        book.settle("legacy", 6000, T);
        let mut old = serde_json::to_value(&book).unwrap();
        old["ledger"][0].as_object_mut().unwrap().remove("paid");
        let mut book: Book = serde_json::from_value(old).unwrap();
        let legacy = view(&book, Autopay::default().view(T), false, T);
        assert_eq!((legacy.spent_msat, legacy.accounted_msat), (0, 6000));
        assert!(legacy.fee_unknown, "old ceilings do not prove payments");
        for i in 0..LEDGER_MAX {
            book.reserve(&format!("new-{i}"), MAYA, false, 6000, T);
            book.settle(&format!("new-{i}"), 6000, T);
            book.ledger.last_mut().unwrap().paid = Some(Paid { msat: 1000, fee_unknown: true });
        }
        book.prune(T);
        assert_eq!(book.ledger.len(), 1);
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &book).unwrap();
        let loaded = load(dir.path(), ME).unwrap();
        let shown = view(&loaded, Autopay::default().view(T), false, T);
        assert_eq!(shown.spent_msat, 20_000_000);
        assert_eq!(shown.accounted_msat, 120_006_000);
        assert_eq!(shown.unsettled_msat, 0);
        assert!(shown.fee_unknown);
    }

    const ME: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const MAYA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const JOSH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const T: u64 = 1_790_000_000_000;

    fn ask(target: &str, max: u64, autopay: Option<u64>) -> Ask<'_> {
        Ask {
            target,
            room: false,
            max_msat: max,
            first_contact_msat: None,
            autopay,
            window: Err(ActionError::new("spend_locked", "approve")),
            now_ms: T,
        }
    }

    fn book_with_maya(limit: u64) -> Book {
        let mut b = Book::new(ME);
        b.set_limit(MAYA, false, limit).unwrap();
        b
    }

    #[test]
    fn fractional_budget_refusals_use_explicit_integer_msat() {
        let b = book_with_maya(2000);
        let error = plan(&b, ask(MAYA, 21187, Some(500_000))).unwrap_err();
        assert!(error.message.contains("used 0 sats of 2 sats"), "{}", error.message);
        assert!(error.message.contains("costs 21187 msat"), "{}", error.message);
        assert!(!error.message.contains("21.187"));
        let mut b = Book::new(ME);
        b.set_ceiling(21187);
        assert!(b.set_limit(MAYA, false, 22000).unwrap_err().message.contains("21187 msat"));
    }

    #[test]
    fn inside_the_budget_pays_automatically() {
        let b = book_with_maya(50_000);
        assert_eq!(plan(&b, ask(MAYA, 2000, Some(500_000))).unwrap(), Plan { route: Route::Budget, confirm: None });
    }

    #[test]
    fn strangers_are_never_paid_automatically() {
        let b = Book::new(ME);
        assert_eq!(plan(&b, ask(JOSH, 1000, Some(500_000))).unwrap_err().code, "first_contact");
        let mut confirmed = ask(JOSH, 1000, Some(500_000));
        confirmed.first_contact_msat = Some(20_000);
        assert_eq!(plan(&b, confirmed).unwrap(), Plan { route: Route::Budget, confirm: Some(20_000) });
        // A confirmation cannot choose a budget smaller than the message.
        let mut tiny = ask(JOSH, 5000, Some(500_000));
        tiny.first_contact_msat = Some(1000);
        assert_eq!(plan(&b, tiny).unwrap_err().code, "invalid");
        // Nor above the approved total.
        let mut huge = ask(JOSH, 1000, Some(500_000));
        huge.first_contact_msat = Some(MAX_DAILY_MSAT);
        assert_eq!(plan(&b, huge).unwrap().confirm, Some(b.ceiling_msat));
    }

    #[test]
    fn exhaustion_is_refused_with_the_numbers() {
        let mut b = book_with_maya(5000);
        b.reserve("r1", MAYA, false, 2000, T - 1000);
        b.settle("r1", 2000, T);
        b.reserve("r2", MAYA, false, 2000, T - 500);
        assert!(plan(&b, ask(MAYA, 1000, Some(500_000))).is_ok());
        let e = plan(&b, ask(MAYA, 2000, Some(500_000))).unwrap_err();
        assert_eq!(e.code, "budget_exhausted");
        assert!(e.message.contains("used 4 sats of 5 sats"), "{}", e.message);
        // The contact budget holds inside a ten-minute window too.
        let mut windowed = ask(MAYA, 2000, None);
        windowed.window = Ok(());
        assert_eq!(plan(&b, windowed).unwrap_err().code, "budget_exhausted");
    }

    #[test]
    fn the_daily_total_caps_every_contact_together() {
        let mut b = Book::new(ME);
        b.set_ceiling(10_000);
        b.set_limit(MAYA, false, 8000).unwrap();
        b.set_limit(JOSH, false, 8000).unwrap();
        b.reserve("r1", MAYA, false, 8000, T - 10);
        let e = plan(&b, ask(JOSH, 3000, Some(10_000))).unwrap_err();
        assert_eq!(e.code, "ceiling_exhausted");
        // The narrower of the approved total and the book's own number wins.
        assert!(plan(&b, ask(JOSH, 2000, Some(10_000))).is_ok());
        assert_eq!(plan(&b, ask(JOSH, 2000, Some(9_000))).unwrap_err().code, "ceiling_exhausted");
    }

    #[test]
    fn a_rolling_day_forgets_old_spends_and_keeps_future_dated_ones() {
        let mut b = book_with_maya(5000);
        b.ledger.push(Entry { id: "old".into(), at_ms: T - DAY_MS, target: MAYA.into(), room: false, msat: 5000, settled: true, paid: Some(Paid { msat: 5000, fee_unknown: false }) });
        b.ledger.push(Entry { id: "skew".into(), at_ms: T + 60_000, target: MAYA.into(), room: false, msat: 3000, settled: true, paid: Some(Paid { msat: 3000, fee_unknown: false }) });
        assert_eq!(b.spent(MAYA, false, T), 3000);
        b.prune(T);
        assert_eq!(b.ledger.len(), 1);
    }

    #[test]
    fn pause_refuses_everything_first() {
        let mut b = book_with_maya(50_000);
        b.paused = true;
        let mut windowed = ask(MAYA, 1000, None);
        windowed.window = Ok(());
        assert_eq!(plan(&b, windowed).unwrap_err().code, "budget_paused");
        assert_eq!(plan(&b, ask(MAYA, 1000, Some(500_000))).unwrap_err().code, "budget_paused");
    }

    #[test]
    fn without_an_approval_the_window_decides_and_strangers_stay_unconfirmed() {
        let b = Book::new(ME);
        assert_eq!(plan(&b, ask(JOSH, 1000, None)).unwrap_err().code, "spend_locked");
        let mut windowed = ask(JOSH, 1000, None);
        windowed.window = Ok(());
        assert_eq!(plan(&b, windowed).unwrap(), Plan { route: Route::Window, confirm: None });
    }

    #[test]
    fn limits_only_narrow_below_the_approved_total() {
        let mut b = Book::new(ME);
        assert_eq!(b.set_limit(MAYA, false, b.ceiling_msat + 1).unwrap_err().code, "invalid");
        b.set_limit(MAYA, false, 400_000).unwrap();
        b.set_ceiling(100_000);
        assert_eq!(b.limit(MAYA, false), Some(100_000));
        b.set_limit(MAYA, false, 0).unwrap();
        assert_eq!(b.limit(MAYA, false), None, "zero forgets: they are a stranger again");
    }

    #[test]
    fn reservations_settle_or_release() {
        let mut b = book_with_maya(50_000);
        b.reserve("r1", MAYA, false, 2000, T);
        b.reserve("r2", MAYA, false, 2000, T);
        b.settle("r1", 1500, T);
        b.release("r2");
        assert_eq!(b.spent(MAYA, false, T), 1500);
        let v = view(&b, Autopay::default().view(T), false, T);
        assert_eq!((v.spent_msat, v.unsettled_msat), (1500, 0));
    }

    #[test]
    fn the_book_survives_a_restart_and_holds_no_authority() {
        let dir = tempfile::tempdir().unwrap();
        let mut b = book_with_maya(50_000);
        b.reserve("r1", MAYA, false, 2000, T);
        b.settle("r1", 2000, T);
        b.reserve("r2", MAYA, false, 3000, T);
        save(dir.path(), &b).unwrap();

        let again = load(dir.path(), ME).unwrap();
        assert_eq!(again, b);
        assert_eq!(again.spent(MAYA, false, T), 5000, "unknown outcomes stay reserved at their ceiling");

        let raw = std::fs::read_to_string(book_path(dir.path(), ME)).unwrap().to_ascii_lowercase();
        for word in ["spend\"", "scope", "grant", "token", "approv", "until", "basis", "preimage", "plaintext"] {
            assert!(!raw.contains(word), "{word} must never reach the budget file: {raw}");
        }
        // A new process starts with no approval, whatever the file says.
        assert_eq!(Autopay::default().view(T).state, AutopayState::Off);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(book_path(dir.path(), ME)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn legacy_book_without_payment_identities_keeps_existing_charges() {
        let dir = tempfile::tempdir().unwrap();
        let mut book = book_with_maya(50_000);
        book.reserve("settled", MAYA, false, 2000, T);
        book.settle("settled", 1500, T);
        book.reserve("pending", MAYA, false, 3000, T);
        let mut legacy = serde_json::to_value(&book).unwrap();
        legacy.as_object_mut().unwrap().remove("accounted_payments");
        std::fs::write(book_path(dir.path(), ME), legacy.to_string()).unwrap();
        let loaded = load(dir.path(), ME).unwrap();
        assert_eq!(loaded.spent_total(T), 4500);
        assert!(loaded.accounted_payments.is_empty());
        assert_eq!(loaded.ledger, book.ledger);
    }

    #[test]
    fn a_damaged_or_foreign_book_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(book_path(dir.path(), ME), b"{not json").unwrap();
        assert_eq!(load(dir.path(), ME).unwrap_err().code, "budget_unreadable");
        let mut other = Book::new(ME);
        other.node_id = MAYA.into();
        std::fs::write(book_path(dir.path(), ME), serde_json::to_vec(&other).unwrap()).unwrap();
        assert_eq!(load(dir.path(), ME).unwrap_err().code, "budget_unreadable");
        let mut planted = serde_json::to_value(Book::new(ME)).unwrap();
        planted["grant"] = serde_json::json!(true);
        std::fs::write(book_path(dir.path(), ME), planted.to_string()).unwrap();
        assert_eq!(load(dir.path(), ME).unwrap_err().code, "budget_unreadable", "unknown fields are refused");
        assert_eq!(load(tempfile::tempdir().unwrap().path(), ME).unwrap(), Book::new(ME));
    }

    #[test]
    fn autopay_expires_narrows_and_locks() {
        let mut a = Autopay::default();
        a.arm(T, 10_000, SpendBasis::AppLock);
        let g = a.generation();
        assert!(a.check_generation(g, T + 1).is_ok());
        a.narrow(20_000);
        assert_eq!(a.ceiling(T), Some(10_000), "narrow never raises");
        a.narrow(4_000);
        assert_eq!(a.ceiling(T), Some(4_000));
        assert_eq!(a.check_generation(g, T + BUDGET_WINDOW_MS).unwrap_err().code, "budget_needed");
        assert_eq!(a.view(T + BUDGET_WINDOW_MS).state, AutopayState::Expired);
        a.arm(T, 10_000, SpendBasis::AppLock);
        let g = a.generation();
        a.lock();
        assert!(a.check_generation(g, T).is_err());
        assert_eq!(a.view(T).state, AutopayState::Off);
    }

    #[test]
    fn the_view_lists_budgets_and_unbudgeted_spends() {
        let mut b = book_with_maya(50_000);
        b.reserve("r1", JOSH, false, 1000, T);
        let v = view(&b, Autopay::default().view(T), false, T);
        assert_eq!(v.rows.len(), 2);
        assert_eq!(v.rows.iter().find(|r| r.target == JOSH).unwrap(), &Row { target: JOSH.into(), room: false, limit_msat: None, spent_msat: 0, accounted_msat: 1000, unsettled_msat: 1000, fee_unknown: false });
        assert_eq!(v.rows.iter().find(|r| r.target == MAYA).unwrap().limit_msat, Some(50_000));
        assert_eq!(v.unsettled_msat, 1000);
    }
}
