//! PR #47 merge-gate regression (finding 2): a full ledger never forgets live spend.
use bitsov_app::{act::ActionError, budget::{self, Ask, Book, Entry}};

#[test]
fn review_active_ledger_cannot_forget_spend_after_restart() {
    let now = 1_000_000;
    let mut book = Book::new(&"a".repeat(64));
    book.set_ceiling(20_001_000);
    book.set_limit("contact", false, 20_001_000).unwrap();
    book.ledger = (0..20_001).map(|i| Entry {
        id: i.to_string(), at_ms: now, target: "contact".into(), room: false,
        msat: 1000, settled: true, paid: None,
    }).collect();
    book.prune(now);
    let dir = tempfile::tempdir().unwrap();
    budget::save(dir.path(), &book).unwrap();
    let loaded = budget::load(dir.path(), &book.node_id).unwrap();
    let result = budget::plan(&loaded, Ask {
        target: "contact", room: false, max_msat: 1000, first_contact_msat: None,
        autopay: Some(20_001_000), window: Err(ActionError::new("spend_locked", "closed")),
        now_ms: now,
    });
    assert!(result.is_err(), "20,001 sats already paid against 20,001-sat ceiling; after prune/restart counted {}, next send {:?}", loaded.spent_total(now), result);
}

#[test]
fn unsettled_reservations_keep_their_lines_and_a_full_book_refuses() {
    let now = 1_000_000;
    let mut book = Book::new(&"a".repeat(64));
    book.set_ceiling(100_000_000);
    book.ledger = (0..budget::LEDGER_MAX).map(|i| Entry {
        id: i.to_string(), at_ms: now, target: "contact".into(), room: false, msat: 1, settled: false, paid: None,
    }).collect();
    book.prune(now);
    assert_eq!(book.ledger.len(), budget::LEDGER_MAX, "reservations are never merged or dropped");
    let result = budget::plan(&book, Ask {
        target: "other", room: false, max_msat: 1000, first_contact_msat: Some(10_000),
        autopay: Some(100_000_000), window: Err(ActionError::new("spend_locked", "closed")), now_ms: now,
    });
    assert_eq!(result.unwrap_err().code, "budget_ledger_full");
}
