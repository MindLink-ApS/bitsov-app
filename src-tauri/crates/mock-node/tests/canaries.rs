#[path = "common/mod.rs"]
#[allow(dead_code)]
mod common;

use std::collections::BTreeSet;
use std::path::Path;

use mock_node::{paths, Fault, MockNode, Route, CANARIES, ERROR_BODY_01};

#[test]
fn the_exported_list_is_unique_and_unambiguous() {
    let mut seen = BTreeSet::new();
    for canary in CANARIES {
        assert!(canary.starts_with("JARVIS_CANARY_"), "{canary}");
        assert!(seen.insert(*canary), "duplicate {canary}");
        for other in CANARIES {
            if canary != other {
                assert!(!canary.contains(other), "{canary} contains {other}");
            }
        }
    }
    assert_eq!(seen.len(), CANARIES.len());
}

#[test]
fn every_planted_canary_is_exported_and_every_export_is_planted() {
    let node = MockNode::canonical();
    let mut found = BTreeSet::new();
    for path in common::fresh_paths() {
        found.extend(common::canaries_in(&common::body_of(node.serve(&path))));
    }
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
        let stale = MockNode::canonical().fault(route, Fault::Stale);
        let error = MockNode::canonical().fault(route, Fault::Error);
        let path = match route {
            Route::PaymentsPrice => paths::price(0),
            other => common::sample_path(other, mock_node::AnswerKey::OnchainSats),
        };
        found.extend(common::canaries_in(&common::body_of(stale.serve(&path))));
        found.extend(common::canaries_in(&common::body_of(error.serve(&path))));
        assert!(
            matches!(
                MockNode::canonical()
                    .fault(route, Fault::Timeout)
                    .serve(&path),
                mock_node::Exchange::TimedOut
            ),
            "timeout must not invent a body"
        );
    }
    found.extend(common::canaries_in(&common::body_of(
        node.serve("/missing"),
    )));
    found.extend(common::canaries_in(&common::body_of(
        node.serve("/api/v1/payments/price/7"),
    )));

    let expected: BTreeSet<&str> = CANARIES.iter().copied().collect();
    assert_eq!(found, expected);
}

#[test]
fn source_literals_match_the_exported_list() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let literals = common::rust_canary_literals(&src);
    let expected: BTreeSet<String> = CANARIES
        .iter()
        .map(|canary| (*canary).to_string())
        .collect();
    assert_eq!(literals, expected);
}

#[test]
fn fresh_bodies_do_not_carry_the_error_canary() {
    let node = MockNode::canonical();
    for path in common::fresh_paths() {
        let body = common::body_of(node.serve(&path));
        let mut strings = Vec::new();
        common::walk_strings(&body, &mut strings);
        assert!(
            strings.iter().all(|text| !text.contains(ERROR_BODY_01)),
            "{path} leaked the error canary"
        );
    }
}

#[test]
fn the_error_body_uses_the_genome_error_shape() {
    let node = MockNode::canonical().fault(Route::PaymentsBalance, Fault::Error);
    let body = common::body_of(node.serve(paths::BALANCE));
    assert_eq!(body["code"], 502);
    assert_eq!(body["error"], format!("lightning error: {ERROR_BODY_01}"));
    assert_eq!(body.as_object().expect("object").len(), 2);
}
