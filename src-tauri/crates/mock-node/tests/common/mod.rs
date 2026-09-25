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
        for literal in quoted_strings(&text) {
            let hex_canary = literal.len() >= 32
                && literal.chars().all(|ch| ch.is_ascii_hexdigit())
                && literal.contains("4a4152564953");
            if literal.starts_with("JARVIS_CANARY_") || hex_canary {
                found.insert(literal);
            }
        }
    }
    found
}

fn quoted_strings(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'"' {
            let start = index + 1;
            index += 1;
            while index < bytes.len() && bytes[index] != b'"' {
                index += 1;
            }
            if index < bytes.len() {
                out.push(text[start..index].to_string());
                index += 1;
            }
        } else {
            index += 1;
        }
    }
    out
}

pub fn fresh_paths() -> Vec<String> {
    mock_node::Route::ALL
        .into_iter()
        .flat_map(|route| route.paths())
        .collect()
}

pub fn body_of(exchange: Exchange) -> Value {
    exchange.body.expect("timeout has no body")
}
