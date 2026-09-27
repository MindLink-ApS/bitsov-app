//! What the sealed assistant window is told about where its rows came from.
//!
//! The host decides. The window gets frozen, non-configurable globals through
//! its initialization script and has no command, IPC grant or network path to
//! change them. There is no window-callable way to pick the backend.

use serde_json::{json, Value};

use super::broker::BearerToken;

/// The host's auth state, as F1 (`crate::pairing`) established it.
#[derive(Debug)]
pub enum NodeAuth {
    /// No session: not started, pairing pending, or pairing failed.
    NotPaired,
    /// rc7: `/pair/request` was 404 and the host minted via `/auth/local`.
    /// The assistant does not read with that token.
    Rc7Fallback,
    /// #77 pairing. `token` is the current paired token.
    Paired {
        token: BearerToken,
        scopes: Vec<String>,
    },
}

/// Global holding `{kind: "live"}` or `{kind: "mock", reason}`. Must match
/// `src/assistant/source.ts`.
pub const SOURCE_GLOBAL: &str = "__BITSOV_ASSISTANT_SOURCE__";

/// Global holding live `[[id, answer], ...]`. Defined only for a live feed.
/// Must match `src/assistant/source.ts`.
pub const LIVE_ROWS_GLOBAL: &str = "__BITSOV_LIVE_ROWS__";

/// Why the window shows mock rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MockReason {
    /// No paired session with a `read` scope (includes a refused token).
    NotPaired,
    /// The node did not answer on loopback, or the base URL was refused.
    NodeUnreachable,
    /// The node has no pairing routes (rc7): the app is on `/auth/local`,
    /// which the assistant does not use.
    Rc7Fallback,
}

impl MockReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotPaired => "not_paired",
            Self::NodeUnreachable => "node_unreachable",
            Self::Rc7Fallback => "rc7_fallback",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Live,
    Mock(MockReason),
}

/// The host's decision plus, when live, the rows read from the node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Feed {
    source: Source,
    live_rows: Vec<(String, String)>,
}

impl Feed {
    pub fn mock(reason: MockReason) -> Self {
        Self {
            source: Source::Mock(reason),
            live_rows: Vec::new(),
        }
    }

    pub fn live(rows: Vec<(String, String)>) -> Self {
        Self {
            source: Source::Live,
            live_rows: rows,
        }
    }

    pub fn source(&self) -> Source {
        self.source
    }

    pub fn live_rows(&self) -> &[(String, String)] {
        &self.live_rows
    }

    /// Initialization script: defines [`SOURCE_GLOBAL`], and
    /// [`LIVE_ROWS_GLOBAL`] for a live feed. Both are frozen, not writable and
    /// not configurable.
    pub fn init_script(&self) -> String {
        let source = match self.source {
            Source::Live => json!({ "kind": "live" }),
            Source::Mock(reason) => json!({ "kind": "mock", "reason": reason.code() }),
        };
        let mut script = String::from(
            "(() => { const deepFreeze = (v) => { if (v && typeof v === 'object') \
             { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; }; ",
        );
        script.push_str(&define(SOURCE_GLOBAL, &source));
        if self.source == Source::Live {
            let rows: Vec<[&str; 2]> = self
                .live_rows
                .iter()
                .map(|(id, value)| [id.as_str(), value.as_str()])
                .collect();
            script.push_str(&define(LIVE_ROWS_GLOBAL, &json!(rows)));
        }
        script.push_str("})();");
        script
    }
}

fn define(global: &str, value: &Value) -> String {
    format!(
        "Object.defineProperty(window, '{global}', {{ value: deepFreeze({}), \
         writable: false, configurable: false }}); ",
        js_literal(value)
    )
}

/// JSON as a JS expression that cannot close a `<script>` or split a statement.
///
/// serde_json escapes quotes, backslashes and control characters. `<` and the
/// JS line separators are escaped here.
pub fn js_literal(value: &Value) -> String {
    value
        .to_string()
        .replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pull `value: <json>` for `global` back out of a script.
    fn defined(script: &str, global: &str) -> Option<Value> {
        let head = format!("Object.defineProperty(window, '{global}', {{ value: ");
        let start = script.find(&head)? + head.len();
        let rest = &script[start..];
        let end = rest.find(", writable: false, configurable: false });")?;
        let expr = &rest[..end];
        let json = expr
            .strip_prefix("deepFreeze(")
            .and_then(|e| e.strip_suffix(')'))
            .unwrap_or(expr);
        Some(serde_json::from_str(json).expect("json literal"))
    }

    #[test]
    fn mock_feed_names_its_reason_and_defines_no_live_rows() {
        for (reason, code) in [
            (MockReason::NotPaired, "not_paired"),
            (MockReason::NodeUnreachable, "node_unreachable"),
            (MockReason::Rc7Fallback, "rc7_fallback"),
        ] {
            let script = Feed::mock(reason).init_script();
            assert_eq!(
                defined(&script, SOURCE_GLOBAL),
                Some(json!({ "kind": "mock", "reason": code })),
                "{script}"
            );
            assert!(!script.contains(LIVE_ROWS_GLOBAL), "{script}");
        }
    }

    #[test]
    fn live_feed_defines_source_and_rows() {
        let rows = vec![
            ("q01".to_string(), "500000".to_string()),
            ("q02".to_string(), "Unavailable".to_string()),
        ];
        let script = Feed::live(rows).init_script();
        assert_eq!(
            defined(&script, SOURCE_GLOBAL),
            Some(json!({ "kind": "live" }))
        );
        assert_eq!(
            defined(&script, LIVE_ROWS_GLOBAL),
            Some(json!([["q01", "500000"], ["q02", "Unavailable"]]))
        );
    }

    #[test]
    fn globals_are_frozen_and_cannot_be_redefined() {
        let script = Feed::live(vec![("q01".into(), "1".into())]).init_script();
        assert_eq!(
            script
                .matches(", writable: false, configurable: false });")
                .count(),
            2,
            "{script}"
        );
        assert_eq!(script.matches("value: deepFreeze(").count(), 2, "{script}");
        assert!(script.contains("Object.freeze"), "{script}");
    }

    #[test]
    fn live_values_cannot_close_the_script_or_split_a_statement() {
        let hostile = "</script><img src=x>'\"\\\u{2028}\u{2029}".to_string();
        let script = Feed::live(vec![("q01".into(), hostile.clone())]).init_script();
        assert!(!script.contains('<'), "{script}");
        assert!(!script.contains('\u{2028}') && !script.contains('\u{2029}'));
        assert_eq!(
            defined(&script, LIVE_ROWS_GLOBAL),
            Some(json!([["q01", hostile]]))
        );
    }
}
