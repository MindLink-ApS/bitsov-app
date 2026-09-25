use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use mock_node::{AnswerKey, Exchange, Route, CANARIES};
use serde_json::Value;

pub fn walk_strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) => out.push(text.clone()),
        Value::Array(items) => {
            for item in items {
                walk_strings(item, out);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                out.push(key.clone());
                walk_strings(item, out);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

pub fn canaries_in(value: &Value) -> BTreeSet<&'static str> {
    let mut strings = Vec::new();
    walk_strings(value, &mut strings);
    CANARIES
        .iter()
        .copied()
        .filter(|canary| strings.iter().any(|text| text.contains(canary)))
        .collect()
}

pub fn sample_path(route: Route, key: AnswerKey) -> String {
    match route {
        Route::Health => mock_node::paths::HEALTH.into(),
        Route::Status => mock_node::paths::STATUS.into(),
        Route::PaymentsBalance => mock_node::paths::BALANCE.into(),
        Route::PaymentsChannels => mock_node::paths::CHANNELS.into(),
        Route::Payments => mock_node::paths::PAYMENTS.into(),
        Route::Messages => mock_node::paths::MESSAGES.into(),
        Route::Pricing => mock_node::paths::PRICING.into(),
        Route::Peers => mock_node::paths::PEERS.into(),
        Route::PaymentsPrice => {
            let kind = match key {
                AnswerKey::PriceLongformMsat => 1,
                AnswerKey::PriceCalendarMsat => 100,
                AnswerKey::PriceFileMsat => 200,
                _ => 0,
            };
            mock_node::paths::price(kind)
        }
    }
}

pub fn rust_canary_literals(dir: &Path) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for entry in fs::read_dir(dir).expect("read src") {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
            continue;
        }
        let text = fs::read_to_string(&path).expect("read source");
        let mut rest = text.as_str();
        let needle = "JARVIS_CANARY_";
        while let Some(index) = rest.find(needle) {
            let tail = &rest[index..];
            let end = tail
                .char_indices()
                .find(|(_, ch)| !ch.is_ascii_uppercase() && !ch.is_ascii_digit() && *ch != '_')
                .map(|(i, _)| i)
                .unwrap_or(tail.len());
            found.insert(tail[..end].to_string());
            rest = &tail[end..];
        }
    }
    found
}

pub fn fresh_paths() -> Vec<String> {
    let mut paths = vec![
        mock_node::paths::HEALTH.into(),
        mock_node::paths::STATUS.into(),
        mock_node::paths::BALANCE.into(),
        mock_node::paths::CHANNELS.into(),
        mock_node::paths::PAYMENTS.into(),
        mock_node::paths::MESSAGES.into(),
        mock_node::paths::PRICING.into(),
        mock_node::paths::PEERS.into(),
        mock_node::paths::price(0),
        mock_node::paths::price(1),
        mock_node::paths::price(100),
        mock_node::paths::price(200),
    ];
    paths.extend(["/health", "/payments/balance"].map(str::to_string));
    paths
}

pub fn body_of(exchange: Exchange) -> Value {
    match exchange {
        Exchange::Ready { body, .. }
        | Exchange::Failed { body, .. }
        | Exchange::Stale { body, .. } => body,
        Exchange::TimedOut => panic!("timeout has no body"),
    }
}
