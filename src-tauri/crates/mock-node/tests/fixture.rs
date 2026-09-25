use std::collections::BTreeSet;
use std::fs;

use mock_node::{AnswerKey, Fault, MockNode, Route, CANARIES};
use serde::Deserialize;

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
    fault: Option<FaultSpec>,
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
                assert!(question.fault.is_none(), "{}", question.id);
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
                let fault = question
                    .fault
                    .as_ref()
                    .expect("unavailable questions name a fault");
                assert_ne!(fault.mode, Fault::None);
                assert!(
                    question.key.routes().contains(&fault.route),
                    "{} faults a route the answer does not read",
                    question.id
                );
                let fresh = MockNode::canonical().answer(question.key);
                assert_ne!(fresh.as_str(), "0", "{} truth is zero", question.id);
                assert_ne!(fresh.as_str(), "unavailable");
                let node = MockNode::canonical().fault(fault.route, fault.mode);
                assert_eq!(
                    node.answer(question.key).as_str(),
                    "unavailable",
                    "{}",
                    question.id
                );
                assert_eq!(question.expected, "unavailable");
                match fault.mode {
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
