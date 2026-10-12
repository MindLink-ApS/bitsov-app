use bitsov_app::delegation::{ticket_message, PendingDevice};

fn pending() -> PendingDevice {
    serde_json::from_str(include_str!("fixtures/node301-pending.json")).unwrap()
}
#[test]
fn validates_the_node_tuple_and_displayed_words_before_signing() {
    let p = pending();
    assert!(p.validate(&"11".repeat(16), "owner-client", 1000).is_ok());
    assert!(p.validate(&"99".repeat(16), "owner-client", 1000).is_err());
    assert!(p.validate(&"11".repeat(16), "new-client", 1000).is_err());
    assert!(p.validate(&"11".repeat(16), "owner-client", 1930).is_err());
    let mut changed = p.clone();
    changed.sas_words[0] = "zoo".into();
    assert!(changed
        .validate(&"11".repeat(16), "owner-client", 1000)
        .is_err());
    for (from, to) in [
        ("delegation-v2", "delegation-v1"),
        ("epoch:1", "epoch:01"),
        ("nonce:", "extra:x\nnonce:"),
        ("op_id:aa", "op_id:bb"),
        ("device_key:0444", "device_key:0455"),
    ] {
        let mut changed = p.clone();
        changed.delegation_message = changed.delegation_message.map(|s| s.replace(from, to));
        assert!(
            changed
                .validate(&"11".repeat(16), "owner-client", 1000)
                .is_err(),
            "{from}"
        );
    }
    let mut changed = p.clone();
    changed.delegation_message.as_mut().unwrap().push('\n');
    assert!(changed
        .validate(&"11".repeat(16), "owner-client", 1000)
        .is_err());
}
#[test]
fn a_request_without_sas_finalization_cannot_be_signed() {
    let mut p = pending();
    p.delegation_message = None;
    assert!(p.validate(&"11".repeat(16), "owner-client", 1000).is_err());
}
#[test]
fn ticket_challenge_is_canonical_and_bound_to_the_paired_node() {
    let node = "11".repeat(16);
    let nonce = "22".repeat(32);
    assert_eq!(
        ticket_message(&node, &nonce).unwrap(),
        format!("bitsov-ticket-v1\nnode:{node}\nnonce:{nonce}")
    );
    assert!(ticket_message("wrong\nnode", &nonce).is_err());
    assert!(ticket_message(&node, &"AB".repeat(32)).is_err());
}
#[test]
fn owner_ticket_codes_accept_only_the_nodes_exact_opaque_format() {
    use base64::Engine;
    let link = |code: String| {
        format!("bitsov://pair/{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({
        "v":2,"endpoint":"box.local:9737","endpoints":["box.local:9737"],"box_transport_pubkey":"22".repeat(32),"code":code
    })).unwrap()))
    };
    assert!(bitsov_app::remote_access::parse_pairing_link(&link(format!(
        "owner_{}",
        "ab".repeat(32)
    )))
    .is_ok());
    for invalid in [
        "owner_".to_string(),
        format!("owner_{}", "AB".repeat(32)),
        format!("owner_{}", "ab".repeat(31)),
        format!("owner_{}x", "ab".repeat(32)),
    ] {
        assert!(bitsov_app::remote_access::parse_pairing_link(&link(invalid)).is_err());
    }
}

#[test]
fn pending_expiry_allows_only_thirty_seconds_of_clock_skew() {
    let mut p = pending();
    for (expiry, accepted) in [
        (970, false),
        (971, true),
        (1000, true),
        (1900, true),
        (1930, true),
        (1931, false),
        (i64::MAX, false),
    ] {
        p.expires_at = expiry;
        assert_eq!(
            p.validate(&"11".repeat(16), "owner-client", 1000).is_ok(),
            accepted,
            "{expiry}"
        );
    }
}

#[test]
fn rejects_wrong_lengths_and_noncanonical_hex_in_the_node_contract() {
    let node = "11".repeat(16);
    for bytes in [11, 13, 16] {
        let mut p = pending();
        p.delegation_message = p
            .delegation_message
            .map(|s| s.replace(&p.op_id, &"aa".repeat(bytes)));
        p.op_id = "aa".repeat(bytes);
        assert!(p.validate(&node, "owner-client", 1000).is_err());
    }
    for nonce in ["55".repeat(15), "55".repeat(17), "AB".repeat(16)] {
        let mut p = pending();
        p.box_nonce = nonce;
        assert!(p.validate(&node, "owner-client", 1000).is_err());
    }
    for (field, value) in [
        ("client_pubkey", "22".repeat(31)),
        ("nonce", "33".repeat(15)),
        ("nonce", "33".repeat(17)),
        ("sas_digest", "00".repeat(31)),
        ("epoch", "18446744073709551616".into()),
    ] {
        let mut p = pending();
        p.delegation_message = p.delegation_message.map(|s| {
            s.lines()
                .map(|line| {
                    if line.starts_with(&format!("{field}:")) {
                        format!("{field}:{value}")
                    } else {
                        line.to_owned()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        });
        assert!(p.validate(&node, "owner-client", 1000).is_err(), "{field}");
    }
    for nonce in ["22".repeat(31), "22".repeat(33)] {
        assert!(ticket_message(&node, &nonce).is_err());
    }
}

#[test]
fn ticket_expiry_allows_only_thirty_seconds_of_clock_skew() {
    use bitsov_app::delegation::{valid_expiry, TICKET_TTL_SECS};
    for (expiry, accepted) in [
        (970, false),
        (971, true),
        (1000, true),
        (1300, true),
        (1330, true),
        (1331, false),
        (i64::MAX, false),
        (0, false),
    ] {
        assert_eq!(
            valid_expiry(expiry, 1000, TICKET_TTL_SECS),
            accepted,
            "{expiry}"
        );
    }
}
