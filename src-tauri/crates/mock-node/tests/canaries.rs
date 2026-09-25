#[path = "common/mod.rs"]
#[allow(dead_code)]
mod common;

use std::collections::BTreeSet;
use std::path::Path;

use mock_node::{paths, Fault, MockNode, Route, CANARIES, ERROR_BODY_01, EXTRA_01, EXTRA_02};

/// Explicit list. This is not `CANARIES.len()`: deleting an entry from the
/// export fails this equality.
const EXPECTED_CANARIES: &[&str] = &[
    "JARVIS_CANARY_MSG_BODY_01",
    "JARVIS_CANARY_MSG_BODY_02",
    "JARVIS_CANARY_MSG_BODY_03",
    "JARVIS_CANARY_MSG_BODY_04",
    "JARVIS_CANARY_MSG_BODY_05",
    "JARVIS_CANARY_MSG_BODY_06",
    "JARVIS_CANARY_MSG_BODY_07",
    "4a41525649535f43414e4152595f4d53475f4e45535445445f30311111111111",
    "4a41525649535f43414e4152595f4d53475f4349504845525f3031",
    "JARVIS_CANARY_SENT_NOTE_01",
    "JARVIS_CANARY_MEMO_01",
    "JARVIS_CANARY_MEMO_02",
    "4a41525649535f43414e4152595f505245494d4147455f303121212121212121",
    "4a41525649535f43414e4152595f505245494d4147455f303222222222222222",
    "JARVIS_CANARY_ALIAS_01",
    "JARVIS_CANARY_ALIAS_02",
    "4a41525649535f43414e4152595f434f554e54455250415254595f303131313131",
    "4a41525649535f43414e4152595f434f554e54455250415254595f303232323232",
    "4a41525649535f43414e4152595f434f554e54455250415254595f303333333333",
    "JARVIS_CANARY_EXTRA_01",
    "JARVIS_CANARY_EXTRA_02",
    "JARVIS_CANARY_ERROR_BODY_01",
];

#[test]
fn the_exported_list_is_the_explicit_expected_list() {
    assert!(EXPECTED_CANARIES.len() >= 20);
    assert_eq!(CANARIES, EXPECTED_CANARIES);
    let mut seen = BTreeSet::new();
    for canary in EXPECTED_CANARIES {
        assert!(
            canary.starts_with("JARVIS_CANARY_")
                || (canary.len() >= 32 && canary.chars().all(|ch| ch.is_ascii_hexdigit())),
            "{canary}"
        );
        assert!(seen.insert(*canary), "duplicate {canary}");
        for other in EXPECTED_CANARIES {
            if canary != other {
                assert!(!canary.contains(other), "{canary} contains {other}");
            }
        }
    }
}

#[test]
fn every_planted_canary_is_exported_and_every_export_is_planted() {
    let mut found = BTreeSet::new();
    for route in Route::ALL {
        for path in route.paths() {
            for mode in [Fault::None, Fault::Error, Fault::Timeout, Fault::Stale] {
                let node = match mode {
                    Fault::None => MockNode::canonical(),
                    other => MockNode::canonical().fault(route, other),
                };
                let response = node.serve(&path);
                match mode {
                    Fault::None => {
                        assert!(!response.stale, "{path}");
                        assert!(!response.timed_out, "{path}");
                    }
                    Fault::Error => {
                        assert!(!response.stale, "{path}");
                        assert!(response.body.is_some(), "{path}");
                    }
                    Fault::Timeout => {
                        assert!(response.timed_out, "{path}");
                        assert!(response.body.is_none(), "{path}");
                        assert!(!response.stale, "{path}");
                    }
                    Fault::Stale => {
                        assert!(response.stale, "{path}");
                        assert!(!response.timed_out, "{path}");
                    }
                }
                if let Some(body) = response.body {
                    found.extend(common::canaries_in(&body));
                }
            }
        }
    }
    found.extend(common::canaries_in(&common::body_of(
        MockNode::canonical().serve("/api/v1/missing"),
    )));

    let expected: BTreeSet<&str> = EXPECTED_CANARIES.iter().copied().collect();
    assert_eq!(found, expected);
}

#[test]
fn source_literals_match_the_exported_list() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let literals = common::rust_canary_literals(&src);
    let expected: BTreeSet<String> = EXPECTED_CANARIES
        .iter()
        .map(|canary| (*canary).to_string())
        .collect();
    assert_eq!(literals, expected);
}

#[test]
fn fresh_bodies_do_not_carry_the_error_or_unknown_field_canaries() {
    let node = MockNode::canonical();
    for route in Route::ALL {
        for path in route.paths() {
            let response = node.serve(&path);
            assert!(!response.stale, "{path}");
            let body = response.body.expect("body");
            let mut strings = Vec::new();
            common::walk_strings(&body, &mut strings);
            assert!(
                strings.iter().all(|text| {
                    !text.contains(ERROR_BODY_01)
                        && !text.contains(EXTRA_01)
                        && !text.contains(EXTRA_02)
                }),
                "{path} leaked an error or unknown-field canary"
            );
        }
    }
}

#[test]
fn the_error_body_uses_the_genome_error_shape() {
    let node = MockNode::canonical().fault(Route::PaymentsBalance, Fault::Error);
    let body = common::body_of(node.serve(paths::BALANCE));
    assert_eq!(body["code"], 502);
    assert_eq!(body["error"], ERROR_BODY_01);
    assert_eq!(body["detail"]["unknown_field"], EXTRA_01);
    assert_eq!(body["detail"]["nested"]["unknown_field"], EXTRA_02);

    let messages = MockNode::canonical().fault(Route::Messages, Fault::Error);
    let body = common::body_of(messages.serve(paths::MESSAGES));
    assert_eq!(body["code"], 500);
    assert_eq!(body["error"], ERROR_BODY_01);

    let price = MockNode::canonical().fault(Route::PaymentsPrice, Fault::Error);
    let body = common::body_of(price.serve(&paths::price(0)));
    assert_eq!(body["code"], 400);
    assert_eq!(body["error"], ERROR_BODY_01);

    let unknown = common::body_of(MockNode::canonical().serve(&paths::price(700)));
    assert_eq!(unknown["error"], "kind 700 is not priceable");
    assert!(unknown.get("detail").is_none());
}
