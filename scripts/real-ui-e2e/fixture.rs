// Included in a disposable copy of genome's regtest_e2e module. Production
// genome sources and the existing harness checkout are never edited.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "real window fixture; local regtest only"]
async fn real_ui_fixture() {
    let root = std::path::PathBuf::from(std::env::var("REAL_UI_ROOT").unwrap());
    let chain = infra::Chain::start().await;
    let (c, addr) = infra::router(&root.join("router"), &chain).await;
    chain.fund(&c).await;
    let publish = |name: &str, value: Value| {
        let tmp = root.join(format!("{name}.tmp"));
        std::fs::write(&tmp, serde_json::to_vec(&value).unwrap()).unwrap();
        std::fs::rename(tmp, root.join(name)).unwrap();
    };
    publish("fixture-ready.json", json!({"esplora":chain.url,"chain_api":chain.api_url,
        "router_id":c.node_id().to_string(),"router_addr":addr,"network":"regtest"}));
    for sequence in 1.. {
        let request = root.join(format!("request-{sequence}.json"));
        tokio::time::timeout(Duration::from_secs(1800), async {
            while !request.exists() { tokio::time::sleep(Duration::from_millis(100)).await; }
        }).await.expect("fixture command timeout");
        let value: Value = serde_json::from_slice(&std::fs::read(request).unwrap()).unwrap();
        let op = value["op"].as_str().unwrap();
        let response = match op {
            "fund" => {
                let txid: Value = chain.bitcoin.client.call("sendtoaddress", &[value["address"].clone(),json!(0.03)]).unwrap();
                chain.mine(&[&c], 6).await;
                json!({"txid":txid})
            }
            "mine" => { chain.mine(&[&c], 6).await; json!({"mined":6}) }
            "mempool" => chain.bitcoin.client.call::<Value>("getrawmempool", &[]).unwrap(),
            "open" => {
                c.open_channel(value["pubkey"].as_str().unwrap().parse().unwrap(),
                    value["address"].as_str().unwrap().parse().unwrap(),1_000_000,None,None).unwrap();
                json!({"opened":true})
            }
            "fee" => {
                let base = value["base_msat"].as_u64().unwrap() as u32;
                for ch in c.list_channels() {
                    let mut config = ch.config.clone();
                    config.forwarding_fee_base_msat = base;
                    c.update_channel_config(&ch.user_channel_id, ch.counterparty_node_id, config).unwrap();
                }
                json!({"fee_base_msat":base})
            }
            "invoice_policy" => {
                let invoice: ldk_node::lightning_invoice::Bolt11Invoice = value["bolt11"].as_str().unwrap().parse().unwrap();
                json!({"fees":invoice.route_hints().iter().flat_map(|r| r.0.iter().map(|h| h.fees.base_msat)).collect::<Vec<_>>()})
            }
            "snapshot" => json!({"capacity_msat":capacity(&c),"channels":c.list_channels().iter().map(|ch|
                json!({"peer":ch.counterparty_node_id.to_string(),"usable":ch.is_usable,
                    "outbound_capacity_msat":ch.outbound_capacity_msat,
                    "fee_base_msat":ch.config.forwarding_fee_base_msat,
                    "fee_ppm":ch.config.forwarding_fee_proportional_millionths})).collect::<Vec<_>>() }),
            "finish" => { publish(&format!("response-{sequence}.json"),json!({"stopped":true})); break; }
            _ => panic!("unsupported fixture command"),
        };
        publish(&format!("response-{sequence}.json"),response);
    }
    c.stop().unwrap();
}
