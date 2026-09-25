#[path = "common/mod.rs"]
#[allow(dead_code)]
mod common;

use mock_node::{
    paths, Answer, AnswerKey, Fault, MockNode, ReadFailure, Route, BLOCK_HEIGHT,
    DIFFICULTY_EPOCH_POSITION, LIGHTNING_NODE_PUBKEY, NODE_ID, SENDER_A, SENDER_B,
    SPENDABLE_ONCHAIN_SATS, TOTAL_LIGHTNING_BALANCE_SATS, VALID_BLOCKS,
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

    let channels = node.read(paths::CHANNELS).expect("channels");
    let channel = &channels[0];
    assert_eq!(channel["channel_id"], "UserChannelId(1)");
    assert_eq!(channels[1]["channel_id"], "UserChannelId(2)");
    assert_eq!(channels[2]["channel_id"], "UserChannelId(3)");
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
    assert_eq!(
        message["references"],
        serde_json::json!([mock_node::MSG_NESTED_01])
    );
    assert!(node.read(paths::MESSAGES).expect("messages")[1]
        .get("references")
        .is_none());

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
    let payments = node.read(paths::PAYMENTS).expect("payments");
    let first = payments[0]["timestamp"].as_u64().expect("ts");
    let second = payments[1]["timestamp"].as_u64().expect("ts");
    assert!(first > second, "rc7 lists payments newest first");
}

#[test]
fn combined_balance_matches_rc7_and_is_not_channel_local() {
    let node = MockNode::canonical();
    let balance = node.read(paths::BALANCE).expect("balance");
    let reported = balance["balance_msat"].as_u64().expect("msat");
    assert_eq!(
        reported,
        (TOTAL_LIGHTNING_BALANCE_SATS + SPENDABLE_ONCHAIN_SATS) * 1000
    );
    assert_eq!(mock_node::balance_msat(), reported);
    assert!(balance.get("onchain_sats").is_none());
    assert!(balance.get("spendable_onchain_balance_sats").is_none());
    let status = node.read(paths::STATUS).expect("status");
    assert_eq!(status["lightning_balance_msat"], reported);
    assert!(status.get("spendable_onchain_balance_sats").is_none());

    let channels = node.read(paths::CHANNELS).expect("channels");
    let local: u64 = channels
        .as_array()
        .expect("array")
        .iter()
        .map(|ch| ch["local_balance_msat"].as_u64().expect("local"))
        .sum();
    assert_ne!(local, TOTAL_LIGHTNING_BALANCE_SATS * 1000);
    assert_ne!(local, reported);
    assert_eq!(
        node.answer(AnswerKey::FirstChannelLocalMsat),
        Answer::Value(channels[0]["local_balance_msat"].to_string())
    );
    assert_eq!(
        node.answer(AnswerKey::TotalBalanceMsat),
        Answer::Value(reported.to_string())
    );
    let mut numbers = Vec::new();
    collect_u64(&balance, &mut numbers);
    collect_u64(&status, &mut numbers);
    collect_u64(&channels, &mut numbers);
    assert!(!numbers.contains(&SPENDABLE_ONCHAIN_SATS));
    assert!(!numbers.contains(&TOTAL_LIGHTNING_BALANCE_SATS));
    assert!(!numbers.contains(&(SPENDABLE_ONCHAIN_SATS * 1000)));
    assert!(!numbers.contains(&(TOTAL_LIGHTNING_BALANCE_SATS * 1000)));
}

fn collect_u64(value: &serde_json::Value, out: &mut Vec<u64>) {
    match value {
        serde_json::Value::Number(number) => {
            if let Some(n) = number.as_u64() {
                out.push(n);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_u64(item, out);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values() {
                collect_u64(item, out);
            }
        }
        _ => {}
    }
}

#[test]
fn a_real_zero_on_a_fresh_route_stays_a_zero() {
    let response = MockNode::canonical().serve(paths::PRICING);
    assert!(!response.stale);
    assert!(!response.timed_out);
    let pricing = response.body.expect("body");
    assert_eq!(pricing["peer_tables_cached"], 0);
    let stale = MockNode::canonical()
        .fault(Route::Pricing, Fault::Stale)
        .serve(paths::PRICING);
    assert!(stale.stale);
    assert_eq!(stale.status, 200);
    assert!(stale.body.expect("body")["peer_tables_cached"] == 0);
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
                        assert!(node.serve(&path).timed_out);
                    }
                    Fault::Stale => {
                        assert_eq!(node.read(&path), Err(ReadFailure::Stale));
                        let response = node.serve(&path);
                        assert!(response.stale, "{key:?} stale flag");
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
                && body.get("block_height").is_none()
                && body["version"] == 2
                && body["lightning_available"] == false
        }
        Route::Status => {
            body.get("lightning_balance_msat").is_none()
                && body.get("block_height").is_none()
                && body["node_id"] == NODE_ID
                && body["version"] == 2
        }
        Route::Payments => body.as_array().is_some_and(|items| items.is_empty()),
    }
}

#[test]
fn unknown_paths_and_kinds_fail_without_a_number() {
    let node = MockNode::canonical();
    assert_eq!(node.read("/api/v1/missing"), Err(ReadFailure::NotFound));
    let kind7 = node.read("/api/v1/payments/price/7").expect("kind 7");
    assert_eq!(kind7["kind"], 7);
    assert_eq!(kind7["price_msat"], 1_000);
    let unknown = common::body_of(node.serve("/api/v1/payments/price/700"));
    assert_eq!(unknown["code"], 400);
    assert_eq!(unknown["error"], "kind 700 is not priceable");
    assert!(unknown.get("price_msat").is_none());
    let missing = common::body_of(node.serve("/nope"));
    assert_eq!(missing["code"], 404);
    assert_eq!(missing["error"], "route");
    assert!(missing.get("balance_msat").is_none());
}

#[test]
fn messages_follow_the_rc7_list_rules() {
    let node = MockNode::canonical();
    let incoming = node.read(paths::MESSAGES).expect("messages");
    let incoming = incoming.as_array().expect("array");
    assert!(incoming.iter().all(|msg| msg["recipient"] == NODE_ID));
    assert!(incoming.iter().all(|msg| msg["sender"] != NODE_ID));
    assert_eq!(incoming.len(), 5);
    assert_eq!(
        node.answer(AnswerKey::MessageCount),
        Answer::Value("6".into())
    );
    assert_eq!(
        node.answer(AnswerKey::ChatMessageCount),
        Answer::Value("4".into())
    );
    let stamps: Vec<u64> = incoming
        .iter()
        .map(|msg| msg["timestamp"].as_u64().expect("ts"))
        .collect();
    let mut sorted = stamps.clone();
    sorted.sort_by_key(|ts| std::cmp::Reverse(*ts));
    assert_eq!(stamps, sorted);

    let limited = node
        .read(&format!("{}?limit=1", paths::MESSAGES))
        .expect("limit");
    assert_eq!(limited.as_array().expect("array").len(), 1);
    assert_eq!(limited[0]["timestamp"], incoming[0]["timestamp"]);

    let none = node
        .read(&format!("{}?limit=0", paths::MESSAGES))
        .expect("zero");
    assert_eq!(none.as_array().expect("array").len(), 0);

    let before = incoming[0]["timestamp"].as_u64().expect("ts");
    let older = node
        .read(&format!("{}?before={before}", paths::MESSAGES))
        .expect("before");
    let older = older.as_array().expect("array");
    assert_eq!(older.len(), incoming.len() - 1);
    assert!(older
        .iter()
        .all(|msg| msg["timestamp"].as_u64().expect("ts") < before));

    let conversation = node
        .read(&format!("{}?peer={SENDER_A}", paths::MESSAGES))
        .expect("peer");
    let conversation = conversation.as_array().expect("array");
    assert_eq!(
        conversation
            .iter()
            .filter(|msg| msg["sender"] == NODE_ID)
            .count(),
        1
    );
    assert!(conversation
        .iter()
        .all(|msg| msg["sender"] == SENDER_A || msg["sender"] == NODE_ID));

    let invalid = common::body_of(node.serve(&format!("{}?peer=zz", paths::MESSAGES)));
    assert_eq!(invalid["code"], 400);
    assert_eq!(
        invalid["error"],
        "invalid peer: expected 64-char hex node ID or UUID"
    );
    let room = node
        .read(&format!(
            "{}?peer=550e8400-e29b-41d4-a716-446655440000",
            paths::MESSAGES
        ))
        .expect("room");
    assert_eq!(room.as_array().expect("array").len(), 0);

    let faulted = MockNode::canonical().fault(Route::Messages, Fault::Error);
    let body = common::body_of(faulted.serve(&format!("{}?peer=zz", paths::MESSAGES)));
    assert_eq!(body["code"], 500);
    assert_eq!(body["error"], mock_node::ERROR_BODY_01);
}

#[test]
fn fresh_bodies_have_no_unknown_keys() {
    let node = MockNode::canonical();
    for path in common::fresh_paths() {
        let body = common::body_of(node.serve(&path));
        assert!(!has_key(&body, "_unknown"), "{path} has an unknown field");
    }
}

fn has_key(value: &serde_json::Value, key: &str) -> bool {
    match value {
        serde_json::Value::Array(items) => items.iter().any(|item| has_key(item, key)),
        serde_json::Value::Object(map) => {
            map.contains_key(key) || map.values().any(|item| has_key(item, key))
        }
        _ => false,
    }
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
