use bitsov_app::delegation::{ticket_message, PendingDevice};

fn pending() -> PendingDevice {
    serde_json::from_value(serde_json::json!({
        "op_id": "aa".repeat(16), "client_id": "new-client", "name": "My phone",
        "public_key": format!("04{}", "44".repeat(64)), "expires_at": 2000,
        "sas_version": 1, "box_nonce": "55".repeat(16),
        "sas_words": ["abandon", "abandon", "abandon", "abandon"],
        "delegation_message": format!("bitsov-owner-delegation-v2\nnode:{}\nclient_pubkey:{}\nepoch:1\ndevice_key:04{}\nop_id:{}\nnonce:{}\nsas_digest:{}",
            "11".repeat(16), "22".repeat(32), "44".repeat(64), "aa".repeat(16), "33".repeat(16), "00".repeat(32))
    })).unwrap()
}
#[test]
fn validates_the_node_tuple_and_displayed_words_before_signing() {
    let p = pending();
    assert!(p.validate(&"11".repeat(16), "owner-client", 1000).is_ok());
    assert!(p.validate(&"99".repeat(16), "owner-client", 1000).is_err());
    assert!(p.validate(&"11".repeat(16), "new-client", 1000).is_err());
    assert!(p.validate(&"11".repeat(16), "owner-client", 2000).is_err());
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
