//! MCP phase 1, slice 2: per-client sessions in front of the protocol skeleton.
//!
//! **Not wired.** Pure, in-memory state only: nothing here opens a socket,
//! pipe or port, stores a key, reads the node, or touches a wallet, the spend
//! journal or any payment path. It compiles only where its parent module does
//! (`cfg(test)` or the off-by-default `mcp-grant` feature).
//!
//! Every frame names the client it came from. The registry is checked on each
//! frame, so a revoked client is refused from its next frame on, live session
//! or not. Each client has its own tool allowlist and at most
//! [`CALLS_PER_MINUTE`] tool calls in any 60 s. Every `tools/call` frame is one
//! audit row, whatever happened to it: audit rows equal attempts.

use std::cell::Cell;
use std::collections::{HashMap, VecDeque};

use serde_json::{json, Value};

use super::server::{self, ReadFailed, Reads, MAX_FRAME_BYTES};
use crate::ai::Topic;

/// Tool calls one client may make in any 60 s window.
pub const CALLS_PER_MINUTE: usize = 30;
const WINDOW_MS: u64 = 60_000;
/// Longest client name kept (characters), after cleaning.
pub const MAX_CLIENT_NAME: usize = 64;
/// Longest tool name and argument text kept in an audit row (bytes).
const MAX_AUDIT_TOOL: usize = 64;
const MAX_AUDIT_ARGUMENTS: usize = 256;

// JSON-RPC 2.0 server error codes (the -32000..-32099 range).
const NOT_AUTHORISED: i64 = -32000;
const RATE_LIMITED: i64 = -32001;

/// A paired client as the host knows it. The id is opaque to this module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Client {
    pub name: String,
    pub allowed: Vec<Topic>,
    revoked: bool,
}

/// The clients the owner approved. In memory in this slice.
#[derive(Debug, Default, Clone)]
pub struct Registry {
    clients: HashMap<String, Client>,
}

impl Registry {
    /// Adds (or replaces) a client. The name is cleaned and capped; the
    /// allowlist is kept in the order given, without repeats.
    pub fn add(&mut self, id: &str, name: &str, allowed: &[Topic]) {
        let mut topics = Vec::new();
        for topic in allowed {
            if !topics.contains(topic) {
                topics.push(*topic);
            }
        }
        self.clients.insert(id.to_owned(), Client { name: clean(name, MAX_CLIENT_NAME), allowed: topics, revoked: false });
    }

    /// Revokes a client. True when it was known and not yet revoked.
    pub fn revoke(&mut self, id: &str) -> bool {
        match self.clients.get_mut(id) {
            Some(client) if !client.revoked => {
                client.revoked = true;
                true
            }
            _ => false,
        }
    }

    /// A client that may still use the server.
    pub fn active(&self, id: &str) -> Option<&Client> {
        self.clients.get(id).filter(|client| !client.revoked)
    }
}

/// What became of one `tools/call` attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The tool ran and its projection was returned.
    Read,
    /// The tool ran and the read failed.
    ReadFailed,
    /// Refused before any read: unknown or disallowed tool, bad arguments,
    /// a malformed request, or a notification (which never runs a tool).
    Refused,
    /// Over [`CALLS_PER_MINUTE`]; nothing was read.
    RateLimited,
    /// Unknown or revoked client; nothing was read.
    NotAuthorised,
}

/// One audit row. Tool name and arguments are as the client sent them,
/// cleaned and capped; nothing the host read is ever logged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditRow {
    pub at_ms: u64,
    pub client: String,
    pub tool: String,
    pub arguments: String,
    pub outcome: Outcome,
}

/// Where audit rows go. Append-only: there is no way to change or drop a row.
pub trait Audit {
    fn append(&mut self, row: AuditRow);
}

impl Audit for Vec<AuditRow> {
    fn append(&mut self, row: AuditRow) {
        self.push(row);
    }
}

/// Per-client call windows for the rate limit.
#[derive(Debug, Default)]
pub struct Sessions {
    calls: HashMap<String, VecDeque<u64>>,
}

/// A frame that passed [`Sessions::begin`]: the client is known and within
/// its limit. It holds everything the read and [`Sessions::finish`] need, so
/// the caller can drop its lock on the registry while the read runs.
#[derive(Debug)]
pub struct Begun {
    client: String,
    allowed: Vec<Topic>,
    now_ms: u64,
    peek: Peek,
}

impl Begun {
    /// The client this frame came from.
    pub fn client(&self) -> &str {
        &self.client
    }

    /// Run the frame through the protocol skeleton with this client's
    /// allowlist. Needs no shared state: call it without any lock held.
    /// Returns the reply (`None` for a notification) and what to audit.
    pub fn read(&self, frame: &[u8], reads: &dyn Reads) -> (Option<Vec<u8>>, Outcome) {
        let observed = Observed { reads, ran: Cell::new(None) };
        let reply = server::handle(frame, &self.allowed, &observed);
        let outcome = match observed.ran.get() {
            None => Outcome::Refused,
            Some(true) => Outcome::Read,
            Some(false) => Outcome::ReadFailed,
        };
        (reply, outcome)
    }
}

impl Sessions {
    /// Handles one frame from `client`. `None` when no reply is sent (a
    /// notification). The same as [`Sessions::begin`], [`Begun::read`] and
    /// [`Sessions::finish`] in a row.
    pub fn handle(
        &mut self,
        client: &str,
        frame: &[u8],
        now_ms: u64,
        registry: &Registry,
        reads: &dyn Reads,
        audit: &mut dyn Audit,
    ) -> Option<Vec<u8>> {
        match self.begin(client, frame, now_ms, registry, audit) {
            Err(reply) => reply,
            Ok(begun) => {
                let (reply, outcome) = begun.read(frame, reads);
                self.finish(begun, outcome, audit);
                reply
            }
        }
    }

    /// The first phase of one frame: is the client known, and is a tool call
    /// within its limit? A refusal is audited here and its reply (if any) is
    /// in `Err`; nothing is read. `Ok` means the frame may go to the read.
    pub fn begin(
        &mut self,
        client: &str,
        frame: &[u8],
        now_ms: u64,
        registry: &Registry,
        audit: &mut dyn Audit,
    ) -> Result<Begun, Option<Vec<u8>>> {
        let peek = Peek::of(frame);
        let Some(known) = registry.active(client) else {
            self.calls.remove(client);
            record(audit, client, now_ms, &peek, Outcome::NotAuthorised);
            return Err(peek.replies.then(|| error(peek.id.clone(), NOT_AUTHORISED, "client not authorised")));
        };

        // Only a tool call that would run counts towards the limit.
        if peek.call.is_some() && peek.replies {
            let window = self.calls.entry(client.to_owned()).or_default();
            while window.front().is_some_and(|&at| now_ms.saturating_sub(at) >= WINDOW_MS) {
                window.pop_front();
            }
            if window.len() >= CALLS_PER_MINUTE {
                record(audit, client, now_ms, &peek, Outcome::RateLimited);
                return Err(Some(error(peek.id.clone(), RATE_LIMITED, "rate limited")));
            }
            window.push_back(now_ms);
        }
        Ok(Begun { client: client.to_owned(), allowed: known.allowed.clone(), now_ms, peek })
    }

    /// The last phase: the audit row for a tool call (other frames leave none).
    pub fn finish(&mut self, begun: Begun, outcome: Outcome, audit: &mut dyn Audit) {
        record(audit, &begun.client, begun.now_ms, &begun.peek, outcome);
    }
}

/// One audit row for a tool call frame; nothing for any other frame.
fn record(audit: &mut dyn Audit, client: &str, now_ms: u64, peek: &Peek, outcome: Outcome) {
    if let Some(call) = &peek.call {
        audit.append(AuditRow {
            at_ms: now_ms,
            client: clean(client, MAX_CLIENT_NAME),
            tool: call.tool.clone(),
            arguments: call.arguments.clone(),
            outcome,
        });
    }
}

/// Records whether the skeleton ran a read, and how it went.
struct Observed<'a> {
    reads: &'a dyn Reads,
    ran: Cell<Option<bool>>,
}

impl Reads for Observed<'_> {
    fn read(&self, topic: Topic, since_ms: Option<u64>) -> Result<Value, ReadFailed> {
        let result = self.reads.read(topic, since_ms);
        self.ran.set(Some(result.is_ok()));
        result
    }
}

/// What the session needs to know about a frame before the skeleton sees it.
#[derive(Debug)]
struct Peek {
    id: Value,
    /// A request (with an id) gets a reply; a notification does not.
    replies: bool,
    call: Option<Call>,
}

#[derive(Debug)]
struct Call {
    tool: String,
    arguments: String,
}

impl Peek {
    fn of(frame: &[u8]) -> Self {
        let parsed = (frame.len() <= MAX_FRAME_BYTES)
            .then(|| serde_json::from_slice::<Value>(frame).ok())
            .flatten();
        let Some(request) = parsed.as_ref().and_then(Value::as_object) else {
            // Unreadable frames get the skeleton's own error reply.
            return Self { id: Value::Null, replies: true, call: None };
        };
        let id = request.get("id").cloned();
        let call = (request.get("method").and_then(Value::as_str) == Some("tools/call")).then(|| {
            let params = request.get("params");
            let tool = params.and_then(|p| p.get("name")).and_then(Value::as_str).unwrap_or_default();
            let arguments = params.and_then(|p| p.get("arguments")).map(Value::to_string).unwrap_or_default();
            Call { tool: audit_text(tool, MAX_AUDIT_TOOL), arguments: audit_text(&arguments, MAX_AUDIT_ARGUMENTS) }
        });
        let reply_id = match &id {
            Some(id @ (Value::String(_) | Value::Number(_))) => id.clone(),
            _ => Value::Null,
        };
        Self { id: reply_id, replies: id.is_some(), call }
    }
}

/// Drops control and bidi characters and keeps at most `max` characters.
pub(super) fn clean(text: &str, max: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// Audit text: control and bidi characters dropped, then at most `max` bytes.
fn audit_text(text: &str, max: usize) -> String {
    cap(&clean(text, usize::MAX), max)
}

/// Keeps at most `max` bytes, on a character boundary.
fn cap(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn error(id: Value, code: i64, message: &str) -> Vec<u8> {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string().into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake {
        seen: RefCell<Vec<Topic>>,
        fail: bool,
    }
    impl Fake {
        fn new() -> Self {
            Self { seen: RefCell::new(Vec::new()), fail: false }
        }
    }
    impl Reads for Fake {
        fn read(&self, topic: Topic, _since_ms: Option<u64>) -> Result<Value, ReadFailed> {
            self.seen.borrow_mut().push(topic);
            if self.fail { Err(ReadFailed) } else { Ok(json!({ "ok": true })) }
        }
    }

    const ALL: [Topic; 6] = [Topic::Node, Topic::Channels, Topic::Prices, Topic::Balance, Topic::Payments, Topic::Inbox];

    fn call(id: u64, tool: &str) -> Vec<u8> {
        json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":tool}}).to_string().into_bytes()
    }

    fn reply(bytes: Option<Vec<u8>>) -> Value {
        serde_json::from_slice(&bytes.expect("a reply")).unwrap()
    }

    fn registry() -> Registry {
        let mut registry = Registry::default();
        registry.add("desk", "Desk assistant", &ALL);
        registry.add("notes", "Notes app", &[Topic::Node]);
        registry
    }

    #[test]
    fn an_unknown_client_is_refused_and_reads_nothing() {
        let (mut sessions, reads, mut audit) = (Sessions::default(), Fake::new(), Vec::new());
        let r = reply(sessions.handle("stranger", &call(1, "read_node"), 0, &registry(), &reads, &mut audit));
        assert_eq!(r["error"]["code"], NOT_AUTHORISED);
        assert_eq!(r["id"], 1);
        assert!(reads.seen.borrow().is_empty());
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].outcome, Outcome::NotAuthorised);
        // Not even the handshake or the tool list.
        let list = br#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#;
        assert_eq!(reply(sessions.handle("stranger", list, 0, &registry(), &reads, &mut audit))["error"]["code"], NOT_AUTHORISED);
    }

    #[test]
    fn revoke_refuses_the_very_next_frame_of_a_live_session() {
        let (mut sessions, reads, mut audit) = (Sessions::default(), Fake::new(), Vec::new());
        let mut registry = registry();
        let first = reply(sessions.handle("desk", &call(1, "read_balance"), 0, &registry, &reads, &mut audit));
        assert_eq!(first["result"]["isError"], false);
        assert!(registry.revoke("desk"));
        assert!(!registry.revoke("desk"), "revoking twice changes nothing");
        let next = reply(sessions.handle("desk", &call(2, "read_balance"), 1, &registry, &reads, &mut audit));
        assert_eq!(next["error"]["code"], NOT_AUTHORISED);
        assert_eq!(*reads.seen.borrow(), vec![Topic::Balance]);
        assert_eq!(audit.iter().map(|row| row.outcome).collect::<Vec<_>>(), [Outcome::Read, Outcome::NotAuthorised]);
        // The other client is unaffected.
        assert!(registry.active("notes").is_some());
    }

    #[test]
    fn each_client_has_its_own_allowlist() {
        let (mut sessions, reads, mut audit) = (Sessions::default(), Fake::new(), Vec::new());
        let registry = registry();
        let list = br#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        let tools = reply(sessions.handle("notes", list, 0, &registry, &reads, &mut audit));
        assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 1);
        let refused = reply(sessions.handle("notes", &call(2, "read_balance"), 0, &registry, &reads, &mut audit));
        assert_eq!(refused["error"]["message"], "unknown tool");
        let allowed = reply(sessions.handle("notes", &call(3, "read_node"), 0, &registry, &reads, &mut audit));
        assert_eq!(allowed["result"]["isError"], false);
        assert_eq!(*reads.seen.borrow(), vec![Topic::Node]);
        assert_eq!(audit.iter().map(|row| row.outcome).collect::<Vec<_>>(), [Outcome::Refused, Outcome::Read]);
    }

    #[test]
    fn at_most_thirty_calls_a_minute_per_client() {
        let (mut sessions, reads, mut audit) = (Sessions::default(), Fake::new(), Vec::new());
        let registry = registry();
        for i in 0..CALLS_PER_MINUTE as u64 {
            let r = reply(sessions.handle("desk", &call(i, "read_node"), 1_000 + i, &registry, &reads, &mut audit));
            assert_eq!(r["result"]["isError"], false, "call {i}");
        }
        let over = reply(sessions.handle("desk", &call(99, "read_node"), 30_000, &registry, &reads, &mut audit));
        assert_eq!(over["error"]["code"], RATE_LIMITED);
        assert_eq!(reads.seen.borrow().len(), CALLS_PER_MINUTE, "a limited call reads nothing");
        // Another client has its own window.
        let other = reply(sessions.handle("notes", &call(1, "read_node"), 30_000, &registry, &reads, &mut audit));
        assert_eq!(other["result"]["isError"], false);
        // Other methods are not limited.
        let ping = reply(sessions.handle("desk", br#"{"jsonrpc":"2.0","id":"p","method":"ping"}"#, 30_000, &registry, &reads, &mut audit));
        assert_eq!(ping["result"], json!({}));
        // Once the first call is a minute old, one more fits.
        let later = reply(sessions.handle("desk", &call(100, "read_node"), 61_000, &registry, &reads, &mut audit));
        assert_eq!(later["result"]["isError"], false);
        let again = reply(sessions.handle("desk", &call(101, "read_node"), 61_000, &registry, &reads, &mut audit));
        assert_eq!(again["error"]["code"], RATE_LIMITED);
    }

    #[test]
    fn audit_rows_equal_tool_call_attempts() {
        let (mut sessions, mut reads, mut audit) = (Sessions::default(), Fake::new(), Vec::new());
        let mut registry = registry();
        let frames: Vec<(&str, Vec<u8>)> = vec![
            ("desk", br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#.to_vec()),
            ("desk", br#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#.to_vec()),
            ("desk", call(3, "read_node")),
            ("desk", call(4, "pay")),
            ("desk", br#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read_payments","arguments":{"since_ms":-1}}}"#.to_vec()),
            ("desk", br#"{"jsonrpc":"2.0","method":"tools/call","params":{"name":"read_node"}}"#.to_vec()),
            ("desk", b"{not json".to_vec()),
            ("stranger", call(6, "read_node")),
        ];
        for (client, frame) in &frames {
            sessions.handle(client, frame, 5, &registry, &reads, &mut audit);
        }
        reads.fail = true;
        sessions.handle("desk", &call(7, "read_channels"), 6, &registry, &reads, &mut audit);
        registry.revoke("notes");
        sessions.handle("notes", &call(8, "read_node"), 7, &registry, &reads, &mut audit);

        let outcomes: Vec<_> = audit.iter().map(|row| (row.client.as_str(), row.tool.as_str(), row.outcome)).collect();
        assert_eq!(outcomes, [
            ("desk", "read_node", Outcome::Read),
            ("desk", "pay", Outcome::Refused),
            ("desk", "read_payments", Outcome::Refused),
            ("desk", "read_node", Outcome::Refused), // a notification never runs a tool
            ("stranger", "read_node", Outcome::NotAuthorised),
            ("desk", "read_channels", Outcome::ReadFailed),
            ("notes", "read_node", Outcome::NotAuthorised),
        ]);
        assert_eq!(audit[2].arguments, r#"{"since_ms":-1}"#);
        assert_eq!(audit[0].at_ms, 5);
    }

    #[test]
    fn audit_text_is_cleaned_and_capped_and_never_holds_read_data() {
        let (mut sessions, reads, mut audit) = (Sessions::default(), Fake::new(), Vec::new());
        let long_tool = format!("read_{}\u{202e}\n", "x".repeat(200));
        let frame = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":long_tool,"arguments":{"pad":"é".repeat(400)}}});
        sessions.handle("desk", frame.to_string().as_bytes(), 0, &registry(), &reads, &mut audit);
        let row = &audit[0];
        assert!(row.tool.len() <= MAX_AUDIT_TOOL);
        assert!(!row.tool.contains('\u{202e}') && !row.tool.contains('\n'));
        assert!(row.arguments.len() <= MAX_AUDIT_ARGUMENTS);
        assert_eq!(row.outcome, Outcome::Refused);

        // Arguments are cleaned too: JSON escapes control characters, but not bidi ones.
        let frame = json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_payments","arguments":{"note":"a\u{202e}b\u{2066}c\u{0007}"}}});
        sessions.handle("desk", frame.to_string().as_bytes(), 0, &registry(), &reads, &mut audit);
        let args = &audit.last().unwrap().arguments;
        assert!(args.chars().all(|c| !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')), "{args:?}");
        assert!(args.contains("abc"), "{args:?}");

        sessions.handle("desk", &call(2, "read_node"), 0, &registry(), &reads, &mut audit);
        // The successful read's own row (found by tool and outcome, not position) holds nothing it read.
        let read = audit.iter().find(|row| row.tool == "read_node" && row.outcome == Outcome::Read).expect("the read_node row");
        assert!(!format!("{read:?}").contains("ok"), "the read result is not logged");
    }

    #[test]
    fn client_names_are_cleaned_and_allowlists_deduplicated() {
        let mut registry = Registry::default();
        registry.add("c", "  Evil\u{202e}name\u{0007}  ", &[Topic::Node, Topic::Node, Topic::Inbox]);
        let client = registry.active("c").unwrap();
        assert_eq!(client.name, "Evilname");
        assert_eq!(client.allowed, [Topic::Node, Topic::Inbox]);
        registry.add("long", &"n".repeat(500), &[]);
        assert_eq!(registry.active("long").unwrap().name.chars().count(), MAX_CLIENT_NAME);
        assert!(!registry.revoke("missing"));
    }
}
