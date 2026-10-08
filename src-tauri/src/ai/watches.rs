//! Passive, deterministic watches. Only scalar observations enter; no IO or action capability.
use super::{assistants::Assistant, Topic};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rule {
    Locked,
    Offline,
    Channels,
    MoneyReady,
    BalanceDrop,
    PaymentFailed,
    Unread,
}
impl Rule {
    pub fn assistant(self) -> Assistant {
        match self {
            Self::Locked | Self::Offline | Self::Channels | Self::MoneyReady => Assistant::Node,
            Self::BalanceDrop | Self::PaymentFailed => Assistant::Wallet,
            Self::Unread => Assistant::Inbox,
        }
    }
    pub fn topic(self) -> Topic {
        match self {
            Self::Locked | Self::Offline | Self::MoneyReady => Topic::Node,
            Self::Channels => Topic::Channels,
            Self::BalanceDrop => Topic::Balance,
            Self::PaymentFailed => Topic::Payments,
            Self::Unread => Topic::Inbox,
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Poll {
    pub revision: Option<String>,
    pub sample: Sample,
}
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Sample {
    pub locked: Option<bool>,
    pub offline: Option<bool>,
    pub money_ready: Option<bool>,
    pub channels: Option<u64>,
    pub balance_msat: Option<u64>,
    pub payment_failures: Option<u64>,
    pub unread: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Notice {
    pub at: u64,
    pub rule: Rule,
    pub text: String,
}
const DURATION_MS: u64 = 5 * 60 * 1000;
const BALANCE_DROP_MSAT: u64 = 1_000_000;
// Closing the UI or suspending the Mac cannot count as continuous observation.
const MAX_POLL_GAP_MS: u64 = 10_000;
#[derive(Debug, Clone, Default)]
struct Condition {
    since: Option<u64>,
    notified: bool,
}
impl Condition {
    fn update(&mut self, value: Option<bool>, now: u64) -> bool {
        match value {
            Some(false) => *self = Self::default(),
            Some(true) => {
                let since = *self.since.get_or_insert(now);
                if now.saturating_sub(since) > DURATION_MS && !self.notified {
                    self.notified = true;
                    return true;
                }
            }
            None => *self = Self::default(),
        }
        false
    }
}
#[derive(Debug, Clone, Default)]
struct State {
    last_poll: Option<u64>,
    locked: Condition,
    offline: Condition,
    money_notified: bool,
    channels: Option<u64>,
    balance: Option<u64>,
    failures: Option<u64>,
    unread: Option<u64>,
}
#[derive(Debug, Clone, Default)]
pub struct Engine {
    states: [State; 3],
}
impl Engine {
    pub fn reset(&mut self, assistant: Assistant) {
        self.states[index(assistant)] = State::default();
    }
    pub fn reset_rule(&mut self, rule: Rule) {
        let s = &mut self.states[index(rule.assistant())];
        match rule {
            Rule::Locked => s.locked = Condition::default(),
            Rule::Offline => s.offline = Condition::default(),
            Rule::MoneyReady => s.money_notified = false,
            Rule::Channels => s.channels = None,
            Rule::BalanceDrop => s.balance = None,
            Rule::PaymentFailed => s.failures = None,
            Rule::Unread => s.unread = None,
        }
    }
    pub fn poll(
        &mut self,
        open: bool,
        now: u64,
        assistant: Assistant,
        sample: &Sample,
        disabled: &[Rule],
    ) -> Result<Vec<Notice>, String> {
        let fields = [
            (Rule::Locked, sample.locked.is_some()),
            (Rule::Offline, sample.offline.is_some()),
            (Rule::MoneyReady, sample.money_ready.is_some()),
            (Rule::Channels, sample.channels.is_some()),
            (Rule::BalanceDrop, sample.balance_msat.is_some()),
            (Rule::PaymentFailed, sample.payment_failures.is_some()),
            (Rule::Unread, sample.unread.is_some()),
        ];
        for (rule, present) in fields {
            if present {
                assistant.authorize(rule.topic())?;
            }
        }
        if disabled.iter().any(|rule| rule.assistant() != assistant) {
            return Err("That watch belongs to another assistant.".into());
        }
        let state = &mut self.states[index(assistant)];
        if !open {
            *state = State::default();
            return Ok(vec![]);
        }
        if state
            .last_poll
            .is_some_and(|last| now < last || now - last > MAX_POLL_GAP_MS)
        {
            *state = State::default();
        }
        state.last_poll = Some(now);
        let mut notices = vec![];
        let mut notice = |rule, text: String| {
            notices.push(Notice {
                at: now,
                rule,
                text,
            })
        };
        let enabled = |rule| !disabled.contains(&rule);
        if state
            .locked
            .update(sample.locked.filter(|_| enabled(Rule::Locked)), now)
        {
            notice(
                Rule::Locked,
                "Node has been locked for more than 5 minutes while the app is open.".into(),
            );
        }
        if state
            .offline
            .update(sample.offline.filter(|_| enabled(Rule::Offline)), now)
        {
            notice(
                Rule::Offline,
                "Node has been offline for more than 5 minutes while the app is open.".into(),
            );
        }
        if !enabled(Rule::MoneyReady) || sample.money_ready == Some(true) {
            state.money_notified = false;
        }
        if enabled(Rule::MoneyReady) && sample.money_ready == Some(false) && !state.money_notified {
            state.money_notified = true;
            notice(
                Rule::MoneyReady,
                "Node reports money_ready false. Money is not ready.".into(),
            );
        }
        for (rule, current, previous) in [
            (Rule::Channels, sample.channels, &mut state.channels),
            (Rule::BalanceDrop, sample.balance_msat, &mut state.balance),
            (
                Rule::PaymentFailed,
                sample.payment_failures,
                &mut state.failures,
            ),
            (Rule::Unread, sample.unread, &mut state.unread),
        ] {
            let current = current.filter(|_| enabled(rule));
            if let (Some(old), Some(new)) = (*previous, current) {
                let text = match rule {
                    Rule::Channels if old != new => Some(format!("Channel count changed from {old} to {new}.")),
                    Rule::BalanceDrop if old.saturating_sub(new) > BALANCE_DROP_MSAT => Some(format!("Reported balance dropped by {} msat since the last check (more than 1,000 sats).", old - new)),
                    Rule::PaymentFailed if new > old => Some(format!("{} payment attempt(s) failed in this app session.", new - old)),
                    Rule::Unread if new > old => Some(format!("Unread count rose from {old} to {new} in this app session.")),
                    _ => None,
                };
                if let Some(text) = text {
                    notice(rule, text);
                }
            }
            *previous = current;
        }
        Ok(notices)
    }
}
fn index(a: Assistant) -> usize {
    match a {
        Assistant::Node => 0,
        Assistant::Wallet => 1,
        Assistant::Inbox => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn poll(e: &mut Engine, a: Assistant, t: u64, s: &Sample) -> Vec<Rule> {
        e.poll(true, t, a, s, &[])
            .unwrap()
            .iter()
            .map(|n| n.rule)
            .collect()
    }
    #[test]
    fn locked_and_offline_require_five_continuous_minutes_and_rearm_after_recovery() {
        for rule in [Rule::Locked, Rule::Offline] {
            let mut e = Engine::default();
            let bad = match rule {
                Rule::Locked => Sample {
                    locked: Some(true),
                    ..Sample::default()
                },
                _ => Sample {
                    offline: Some(true),
                    ..Sample::default()
                },
            };
            for t in (0..=300_000).step_by(1500) {
                assert!(poll(&mut e, Assistant::Node, t, &bad).is_empty());
            }
            assert_eq!(poll(&mut e, Assistant::Node, 301_500, &bad), [rule]);
            assert!(poll(&mut e, Assistant::Node, 303_000, &bad).is_empty());
            let good = Sample {
                locked: Some(false),
                offline: Some(false),
                ..Sample::default()
            };
            poll(&mut e, Assistant::Node, 304_500, &good);
            for t in (306_000..=606_000).step_by(1500) {
                assert!(poll(&mut e, Assistant::Node, t, &bad).is_empty());
            }
            assert_eq!(poll(&mut e, Assistant::Node, 607_500, &bad), [rule]);
        }
    }
    #[test]
    fn changes_baseline_then_dedupe_and_use_strict_balance_threshold() {
        for (a, before, after, expected) in [
            (
                Assistant::Node,
                Sample {
                    channels: Some(2),
                    ..Sample::default()
                },
                Sample {
                    channels: Some(3),
                    ..Sample::default()
                },
                Rule::Channels,
            ),
            (
                Assistant::Wallet,
                Sample {
                    balance_msat: Some(3_000_000),
                    ..Sample::default()
                },
                Sample {
                    balance_msat: Some(1_999_999),
                    ..Sample::default()
                },
                Rule::BalanceDrop,
            ),
            (
                Assistant::Wallet,
                Sample {
                    payment_failures: Some(0),
                    ..Sample::default()
                },
                Sample {
                    payment_failures: Some(1),
                    ..Sample::default()
                },
                Rule::PaymentFailed,
            ),
            (
                Assistant::Inbox,
                Sample {
                    unread: Some(2),
                    ..Sample::default()
                },
                Sample {
                    unread: Some(3),
                    ..Sample::default()
                },
                Rule::Unread,
            ),
        ] {
            let mut e = Engine::default();
            assert!(poll(&mut e, a, 0, &before).is_empty());
            assert_eq!(poll(&mut e, a, 1500, &after), [expected]);
            assert!(poll(&mut e, a, 3000, &after).is_empty());
        }
        let mut e = Engine::default();
        for (t, amount) in [(0, 3_000_000), (1500, 2_000_000), (3000, 3_000_000)] {
            assert!(poll(
                &mut e,
                Assistant::Wallet,
                t,
                &Sample {
                    balance_msat: Some(amount),
                    ..Sample::default()
                }
            )
            .is_empty());
        }
    }
    #[test]
    fn money_ready_notifies_once_until_known_recovery() {
        let mut e = Engine::default();
        let bad = Sample {
            money_ready: Some(false),
            ..Sample::default()
        };
        assert_eq!(poll(&mut e, Assistant::Node, 0, &bad), [Rule::MoneyReady]);
        assert!(poll(&mut e, Assistant::Node, 1500, &bad).is_empty());
        assert!(poll(&mut e, Assistant::Node, 3000, &Sample::default()).is_empty());
        assert!(poll(&mut e, Assistant::Node, 4500, &bad).is_empty());
        poll(
            &mut e,
            Assistant::Node,
            6000,
            &Sample {
                money_ready: Some(true),
                ..Sample::default()
            },
        );
        assert_eq!(
            poll(&mut e, Assistant::Node, 7500, &bad),
            [Rule::MoneyReady]
        );
    }
    #[test]
    fn closed_gap_and_disabled_watches_do_not_accumulate_or_notify() {
        let mut e = Engine::default();
        let s = Sample {
            locked: Some(true),
            money_ready: Some(false),
            ..Sample::default()
        };
        for t in [0, 400_000, 900_000] {
            assert!(e
                .poll(false, t, Assistant::Node, &s, &[])
                .unwrap()
                .is_empty());
        }
        assert!(e
            .poll(
                true,
                901_000,
                Assistant::Node,
                &s,
                &[Rule::Locked, Rule::MoneyReady]
            )
            .unwrap()
            .is_empty());
        assert_eq!(
            poll(&mut e, Assistant::Node, 902_500, &s),
            [Rule::MoneyReady]
        );
        // No catch-up after the UI stops polling (closed window or sleep).
        assert_eq!(
            poll(&mut e, Assistant::Node, 2_000_000, &s),
            [Rule::MoneyReady]
        );
        let before = Sample {
            unread: Some(0),
            ..Sample::default()
        };
        let after = Sample {
            unread: Some(9),
            ..Sample::default()
        };
        poll(&mut e, Assistant::Inbox, 0, &before);
        assert!(e
            .poll(true, 1500, Assistant::Inbox, &after, &[Rule::Unread])
            .unwrap()
            .is_empty());
        assert!(poll(&mut e, Assistant::Inbox, 3000, &after).is_empty());
    }
    #[test]
    fn every_off_switch_suppresses_only_its_rule() {
        for (a, before, after, rule) in [
            (
                Assistant::Node,
                Sample {
                    channels: Some(2),
                    ..Sample::default()
                },
                Sample {
                    channels: Some(3),
                    ..Sample::default()
                },
                Rule::Channels,
            ),
            (
                Assistant::Wallet,
                Sample {
                    balance_msat: Some(9_000_000),
                    ..Sample::default()
                },
                Sample {
                    balance_msat: Some(0),
                    ..Sample::default()
                },
                Rule::BalanceDrop,
            ),
            (
                Assistant::Wallet,
                Sample {
                    payment_failures: Some(0),
                    ..Sample::default()
                },
                Sample {
                    payment_failures: Some(4),
                    ..Sample::default()
                },
                Rule::PaymentFailed,
            ),
            (
                Assistant::Inbox,
                Sample {
                    unread: Some(0),
                    ..Sample::default()
                },
                Sample {
                    unread: Some(9),
                    ..Sample::default()
                },
                Rule::Unread,
            ),
        ] {
            let mut e = Engine::default();
            poll(&mut e, a, 0, &before);
            assert!(e.poll(true, 1500, a, &after, &[rule]).unwrap().is_empty());
            assert!(
                poll(&mut e, a, 3000, &after).is_empty(),
                "reenabling must baseline: {rule:?}"
            );
        }
        let mut e = Engine::default();
        let bad = Sample {
            locked: Some(true),
            offline: Some(true),
            money_ready: Some(false),
            ..Sample::default()
        };
        for t in (0..=330_000).step_by(1500) {
            assert!(e
                .poll(
                    true,
                    t,
                    Assistant::Node,
                    &bad,
                    &[Rule::Locked, Rule::Offline, Rule::MoneyReady]
                )
                .unwrap()
                .is_empty());
        }
        let mut e = Engine::default();
        assert_eq!(
            e.poll(true, 0, Assistant::Node, &bad, &[Rule::Locked])
                .unwrap()[0]
                .rule,
            Rule::MoneyReady
        );
    }
    #[test]
    fn rejects_cross_role_and_action_data_before_evaluation() {
        for (a, s) in [
            (
                Assistant::Node,
                Sample {
                    unread: Some(1),
                    ..Sample::default()
                },
            ),
            (
                Assistant::Wallet,
                Sample {
                    channels: Some(3),
                    ..Sample::default()
                },
            ),
            (
                Assistant::Inbox,
                Sample {
                    balance_msat: Some(1),
                    ..Sample::default()
                },
            ),
        ] {
            assert!(Engine::default().poll(true, 0, a, &s, &[]).is_err());
        }
        for field in ["send", "spend", "draft", "body", "url", "command"] {
            assert!(
                serde_json::from_value::<Sample>(serde_json::json!({field: "anything"})).is_err()
            );
        }
    }
}
