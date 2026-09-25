use std::collections::BTreeSet;
use std::fs;

use mock_node::{paths, AnswerKey, Fault, MockNode, Route, CANARIES, SENDER_A};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    pin: String,
    source: String,
    rule: String,
    questions: Vec<Question>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Question {
    id: String,
    question: String,
    expected: String,
    unit: String,
    sources: Vec<String>,
    class: Class,
    key: AnswerKey,
    #[serde(default)]
    faults: Option<Vec<FaultSpec>>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Class {
    Positive,
    Unavailable,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FaultSpec {
    route: Route,
    mode: Fault,
}

#[test]
fn the_fixture_has_fifty_questions_computed_from_the_mock() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../jarvis/fixtures/questions.json"
    );
    let fixture: Fixture =
        serde_json::from_str(&fs::read_to_string(path).expect("fixture")).expect("fixture json");
    let covered: BTreeSet<Route> = read_surfaces()
        .into_iter()
        .map(|(route, _)| route)
        .collect();
    for route in [
        Route::Health,
        Route::Status,
        Route::PaymentsBalance,
        Route::PaymentsChannels,
        Route::Payments,
        Route::PaymentsPrice,
        Route::Messages,
        Route::Pricing,
        Route::Peers,
    ] {
        assert!(covered.contains(&route), "catalog misses {route:?}");
    }
    assert_eq!(fixture.pin, "v0.3.0-rc7");
    assert_eq!(fixture.source, "958e3997f9969497c1d270f557282b9bb591fe85");
    assert!(fixture.rule.contains("unavailable"));
    assert_eq!(fixture.questions.len(), 50);

    let mut ids = BTreeSet::new();
    let mut positive_keys = BTreeSet::new();
    let mut errors = 0usize;
    let mut timeouts = 0usize;
    let mut stales = 0usize;
    let mut unavailable = 0usize;

    for (index, question) in fixture.questions.iter().enumerate() {
        assert_eq!(question.id, format!("q{:02}", index + 1));
        assert!(ids.insert(question.id.clone()));
        assert!(!question.question.is_empty());
        assert!(!question.unit.is_empty());
        assert!(!question.sources.is_empty(), "{}", question.id);
        assert!(
            !contains_canary(&question.question)
                && !contains_canary(&question.expected)
                && question
                    .sources
                    .iter()
                    .all(|source| !contains_canary(source)),
            "{} leaks a canary into the fixture",
            question.id
        );

        match question.class {
            Class::Positive => {
                assert!(question.faults.is_none(), "{}", question.id);
                assert_ne!(question.expected, "unavailable");
                assert_ne!(question.expected, "0");
                let answer = MockNode::canonical().answer(question.key);
                assert_eq!(answer.as_str(), question.expected, "{}", question.id);
                assert!(
                    positive_keys.insert(question.key),
                    "duplicate positive {}",
                    question.id
                );
            }
            Class::Unavailable => {
                unavailable += 1;
                let faults = question
                    .faults
                    .as_ref()
                    .expect("unavailable questions name every fault");
                assert!(!faults.is_empty(), "{}", question.id);
                let mode = faults[0].mode;
                assert_ne!(mode, Fault::None);
                assert!(
                    faults.iter().all(|fault| fault.mode == mode),
                    "{} mixes fault modes",
                    question.id
                );
                let faulted: BTreeSet<Route> = faults.iter().map(|fault| fault.route).collect();
                assert_eq!(
                    faulted,
                    BTreeSet::from_iter(question.key.routes().iter().copied()),
                    "{} must fault every route that answers it",
                    question.id
                );
                let fresh = MockNode::canonical().answer(question.key);
                assert_ne!(fresh.as_str(), "0", "{} truth is zero", question.id);
                assert_ne!(fresh.as_str(), "unavailable");
                let mut node = MockNode::canonical();
                for fault in faults {
                    node = node.fault(fault.route, fault.mode);
                }
                assert_eq!(
                    node.answer(question.key).as_str(),
                    "unavailable",
                    "{}",
                    question.id
                );
                assert_eq!(question.expected, "unavailable");
                assert_unfaulted_routes_omit(&node, &faulted, fresh.as_str(), &question.id);
                match mode {
                    Fault::Error => errors += 1,
                    Fault::Timeout => timeouts += 1,
                    Fault::Stale => stales += 1,
                    Fault::None => panic!("unavailable questions do not use a clear route"),
                }
            }
        }
    }

    assert_eq!(positive_keys, BTreeSet::from(AnswerKey::ALL));
    assert_eq!(unavailable, 18);
    assert_eq!((errors, timeouts, stales), (6, 6, 6));
}

fn contains_canary(text: &str) -> bool {
    CANARIES.iter().any(|canary| text.contains(canary))
}

fn assert_unfaulted_routes_omit(
    node: &MockNode,
    faulted: &BTreeSet<Route>,
    answer: &str,
    id: &str,
) {
    for (route, path) in read_surfaces() {
        if faulted.contains(&route) {
            continue;
        }
        let body = match node.serve(&path) {
            mock_node::Exchange::Ready { body, .. }
            | mock_node::Exchange::Failed { body, .. }
            | mock_node::Exchange::Stale { body, .. } => body,
            mock_node::Exchange::TimedOut => panic!("{id} {path} timed out without a fault"),
        };
        assert!(
            !json_contains_answer(&body, answer),
            "{id} answer {answer} is still on unfaulted {path}"
        );
    }
}

fn read_surfaces() -> Vec<(Route, String)> {
    vec![
        (Route::Health, paths::HEALTH.into()),
        (Route::Status, paths::STATUS.into()),
        (Route::PaymentsBalance, paths::BALANCE.into()),
        (Route::PaymentsChannels, paths::CHANNELS.into()),
        (Route::Payments, paths::PAYMENTS.into()),
        (Route::Messages, paths::MESSAGES.into()),
        (
            Route::Messages,
            format!("{}?peer={SENDER_A}", paths::MESSAGES),
        ),
        (Route::Pricing, paths::PRICING.into()),
        (Route::Peers, paths::PEERS.into()),
        (Route::PaymentsPrice, paths::price(0)),
        (Route::PaymentsPrice, paths::price(1)),
        (Route::PaymentsPrice, paths::price(7)),
        (Route::PaymentsPrice, paths::price(100)),
        (Route::PaymentsPrice, paths::price(200)),
        (Route::PaymentsPrice, paths::price(700)),
    ]
}

fn json_contains_answer(value: &Value, answer: &str) -> bool {
    match value {
        Value::Array(items) => {
            items.len().to_string() == answer
                || items.iter().any(|item| json_contains_answer(item, answer))
        }
        Value::Object(map) => map.values().any(|item| json_contains_answer(item, answer)),
        Value::Number(number) => number
            .as_u64()
            .map(|n| n.to_string() == answer)
            .or_else(|| number.as_i64().map(|n| n.to_string() == answer))
            .unwrap_or(false),
        Value::String(text) => text == answer,
        Value::Bool(flag) => flag.to_string() == answer,
        Value::Null => false,
    }
}
