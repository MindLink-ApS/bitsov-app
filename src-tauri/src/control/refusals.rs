//! Aggregate-only projection of genome #96. No event, identity or new authority.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const HOUR_MS: u64 = 3_600_000;
const REASONS: [&str; 8] = [
    "session_before_payment",
    "delivery_before_payment",
    "price_before_payment",
    "peer_exchange_before_payment",
    "lightning_info_before_payment",
    "gossip_before_payment",
    "invoice_error_before_payment",
    "admission_required",
];

#[derive(Deserialize, Clone, Debug)]
pub struct NodePrePaymentRefusals {
    bucket_ms: u64,
    capacity: usize,
    buckets: Vec<Bucket>,
}

#[derive(Deserialize, Clone, Debug)]
struct Bucket {
    start_ms: u64,
    counts: BTreeMap<String, u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RefusalCount {
    /// Decimal text preserves u64 counters and their u128 sums across JS IPC.
    count: String,
    /// A saturated input makes this sum a lower bound, never an exact count.
    at_least: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RefusalRow {
    reason: &'static str,
    hour: RefusalCount,
    day: RefusalCount,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PrePaymentRefusals {
    /// Windows belong to this snapshot, not to the renderer's ticking clock.
    hour_start_ms: u64,
    rows: Vec<RefusalRow>,
}

impl NodePrePaymentRefusals {
    pub fn project(self, read_at: u64) -> Option<PrePaymentRefusals> {
        let mut starts = BTreeSet::new();
        if self.bucket_ms != HOUR_MS
            || self.capacity != 24
            || self.buckets.len() > 24
            || self
                .buckets
                .iter()
                .any(|b| b.start_ms % HOUR_MS != 0 || !starts.insert(b.start_ms))
        {
            return None;
        }
        // The node pins counts to its most recent observed hour on clock rollback.
        let hour_start_ms = (read_at / HOUR_MS * HOUR_MS).max(starts.last().copied().unwrap_or(0));
        let day_start_ms = hour_start_ms.saturating_sub(23 * HOUR_MS);
        let rows = REASONS
            .iter()
            .map(|&reason| {
                let sum = |since| {
                    let mut count = 0_u128;
                    let mut at_least = false;
                    for b in self
                        .buckets
                        .iter()
                        .filter(|b| b.start_ms >= since && b.start_ms <= hour_start_ms)
                    {
                        let n = b.counts.get(reason).copied().unwrap_or(0);
                        count += u128::from(n);
                        at_least |= n == u64::MAX;
                    }
                    RefusalCount {
                        count: count.to_string(),
                        at_least,
                    }
                };
                RefusalRow {
                    reason,
                    hour: sum(hour_start_ms),
                    day: sum(day_start_ms),
                }
            })
            .collect();
        Some(PrePaymentRefusals {
            hour_start_ms,
            rows,
        })
    }
}
