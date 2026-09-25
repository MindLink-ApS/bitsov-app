#[path = "common/mod.rs"]
#[allow(dead_code)]
mod common;

use mock_node::{
    paths, Answer, AnswerKey, Fault, MockNode, ReadFailure, Route, BLOCK_HEIGHT,
    DIFFICULTY_EPOCH_POSITION, LIGHTNING_NODE_PUBKEY, NODE_ID, ONCHAIN_SATS, SENDER_A, SENDER_B,
    VALID_BLOCKS,
};

#[test]
fn fresh_reads_use_the_genome_shapes() {
    let node = MockNode::canonical();

    let health = node.read(paths::HEALTH).expect("health");
    for key in [
        "status",
        "connected_peers",
        "e2ee_sessions",
        "pending_deliveries",
        "lightning_available",
        "lightning_payment_capable",
        "uptime_secs",
        "version",
        "lightning_backend",
        "chain_backend",
        "block_height",
    ] {
        assert!(health.get(key).is_some(), "health missing {key}");
    }
    assert!(health.get("node_id").is_none());
    assert!(health.get("lightning_balance_msat").is_none());
    assert_eq!(health["block_height"], BLOCK_HEIGHT);

    let status = node.read(paths::STATUS).expect("status");
    assert_eq!(status["node_id"], NODE_ID);
    assert_eq!(status["connected_peer_ids"][0], SENDER_A);
    assert_eq!(status["connected_peer_ids"][1], SENDER_B);
    assert_eq!(status["lightning_node_pubkey"], LIGHTNING_NODE_PUBKEY);
    assert_eq!(
        status["lightning_balance_msat"],
        node.read(paths::BALANCE).expect("balance")["balance_msat"]
    );

    let channel = &node.read(paths::CHANNELS).expect("channels")[0];
    for key in [
        "channel_id",
        "peer_pubkey",
        "capacity_msat",
        "local_balance_msat",
        "remote_balance_msat",
        "active",
        "short_channel_id",
    ] {
        assert!(channel.get(key).is_some(), "channel missing {key}");
    }

    let message = &node.read(paths::MESSAGES).expect("messages")[0];
    for key in [
        "id",
        "kind",
        "sender",
        "recipient",
        "timestamp",
        "ciphertext",
        "payment_amount_msat",
        "payment_hash",
        "plaintext",
    ] {
        assert!(message.get(key).is_some(), "message missing {key}");
    }
    assert!(message.get("references").is_none());

    let pricing = node.read(paths::PRICING).expect("pricing");
    for key in [
        "mode",
        "prices",
        "block_height",
        "valid_blocks",
        "trust_level",
        "difficulty_epoch_position",
        "peer_tables_cached",
    ] {
        assert!(pricing.get(key).is_some(), "pricing missing {key}");
    }
    assert!(pricing.get("raw_fee_rate").is_none());
    assert_eq!(pricing["mode"], "static");
    assert_eq!(pricing["trust_level"], "server_trust");
    assert_eq!(pricing["block_height"], BLOCK_HEIGHT);
    assert_eq!(pricing["valid_blocks"], VALID_BLOCKS);
    assert_eq!(
        pricing["difficulty_epoch_position"],
        DIFFICULTY_EPOCH_POSITION
    );
    assert_eq!(BLOCK_HEIGHT % 2016, DIFFICULTY_EPOCH_POSITION);
    for category in [
        "communication",
        "structured_data",
        "files_media",
        "collaboration",
        "web_content",
        "control",
        "app_extension",
    ] {
        assert!(pricing["prices"].get(category).is_some(), "{category}");
    }

    let price = node.read(&paths::price(0)).expect("price");
    assert_eq!(price["kind"], 0);
    assert!(price.get("price_msat").is_some());

    let peer = &node.read(paths::PEERS).expect("peers")[0];
    for key in [
        "node_id",
        "addr",
        "label",
        "connected",
        "auto_connect",
        "fingerprint",
        "safety_number",
        "tier",
        "capabilities",
    ] {
        assert!(peer.get(key).is_some(), "peer missing {key}");
    }

    let payment = &node.read(paths::PAYMENTS).expect("payments")[0];
    for key in [
        "payment_hash",
        "preimage",
        "amount_msat",
        "status",
        "direction",
        "timestamp",
        "memo",
        "fee_msat",
    ] {
        assert!(payment.get(key).is_some(), "payment missing {key}");
    }
    assert_eq!(payment["status"], "settled");
    assert_eq!(payment["direction"], "outgoing");
}

#[test]
fn on_chain_is_the_balance_route_minus_channel_local() {
    let node = MockNode::canonical();
    let balance = node.read(paths::BALANCE).expect("balance")["balance_msat"]
        .as_u64()
        .expect("msat");
    let channels = node.read(paths::CHANNELS).expect("channels");
    let local: u64 = channels
        .as_array()
        .expect("array")
        .iter()
        .map(|ch| ch["local_balance_msat"].as_u64().expect("local"))
        .sum();
    assert_eq!(balance - local, ONCHAIN_SATS * 1000);
    assert_eq!(
        node.answer(AnswerKey::OnchainSats),
        Answer::Value(ONCHAIN_SATS.to_string())
    );
    assert_eq!(
        node.answer(AnswerKey::TotalBalanceMsat),
        Answer::Value(balance.to_string())
    );
}

#[test]
fn a_real_zero_on_a_fresh_route_stays_a_zero() {
    let pricing = MockNode::canonical().read(paths::PRICING).expect("pricing");
    assert_eq!(pricing["peer_tables_cached"], 0);
}

#[test]
fn faults_are_unavailable_and_never_zero() {
    for key in AnswerKey::ALL {
        let fresh = MockNode::canonical().answer(key);
        assert_ne!(fresh, Answer::Unavailable, "{key:?}");
        assert_ne!(
            fresh.as_str(),
            "0",
            "{key:?} canonical value must not be zero"
        );
        for route in key.routes() {
            for mode in [Fault::Error, Fault::Timeout, Fault::Stale] {
                let node = MockNode::canonical().fault(*route, mode);
                let answer = node.answer(key);
                assert_eq!(answer, Answer::Unavailable, "{key:?} {route:?} {mode:?}");
                assert_ne!(answer.as_str(), "0");
                let path = common::sample_path(*route, key);
                match mode {
                    Fault::Error => assert_eq!(node.read(&path), Err(ReadFailure::RouteError)),
                    Fault::Timeout => {
                        assert_eq!(node.read(&path), Err(ReadFailure::Timeout));
                        assert!(matches!(node.serve(&path), mock_node::Exchange::TimedOut));
                    }
                    Fault::Stale => {
                        assert_eq!(node.read(&path), Err(ReadFailure::Stale));
                        assert!(stale_decoy_is_vacuous(&node, *route, key), "{key:?}");
                    }
                    Fault::None => unreachable!("the loop only injects failures"),
                }
            }
        }
    }
}

fn stale_decoy_is_vacuous(node: &MockNode, route: Route, key: AnswerKey) -> bool {
    let body = common::body_of(node.serve(&common::sample_path(route, key)));
    match route {
        Route::PaymentsBalance => body["balance_msat"] == 0,
        Route::PaymentsChannels | Route::Messages | Route::Peers => {
            body.as_array().is_some_and(|items| items.is_empty())
        }
        Route::PaymentsPrice => body["price_msat"] == 0,
        Route::Pricing => body["prices"]["communication"] == 0,
        Route::Health => {
            body["connected_peers"] == 0
                && body["pending_deliveries"] == 0
                && body["block_height"] == 0
                && body["lightning_available"] == false
        }
        Route::Status => body["lightning_balance_msat"] == 0,
        Route::Payments => body[0]["amount_msat"] == 0,
    }
}

#[test]
fn unknown_paths_and_kinds_fail_without_a_number() {
    let node = MockNode::canonical();
    assert_eq!(node.read("/api/v1/missing"), Err(ReadFailure::NotFound));
    assert_eq!(
        node.read("/api/v1/payments/price/7"),
        Err(ReadFailure::RouteError)
    );
    let missing = common::body_of(node.serve("/nope"));
    assert_eq!(missing["code"], 404);
    assert!(missing.get("balance_msat").is_none());
}

#[test]
fn the_app_package_does_not_depend_on_this_crate() {
    let manifest =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.toml"))
            .expect("app manifest");
    let dependencies = manifest
        .split("[dependencies]")
        .nth(1)
        .expect("dependencies")
        .split("[dev-dependencies]")
        .next()
        .expect("dev-dependencies");
    assert!(
        !dependencies.contains("mock-node"),
        "the app must not link the mock"
    );
}
