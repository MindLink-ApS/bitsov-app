//! Pairing from inside the AI app, with no terminal.
//!
//! An AI app starts `bitsov-mcp` as a stdio MCP server and never shows the
//! shim's stderr to the owner. So while there is no key yet, the shim answers
//! as a small MCP server of its own with one tool, [`TOOL`]. Calling it sends
//! the pairing request to BitSov and returns the six words as the tool's
//! result, which the AI app shows in its chat, next to the plain steps. The
//! owner compares them with the request BitSov is showing and approves it
//! there. Only a refusal (no window open) or a request that has ended tells
//! the owner to open 'Add an AI app': opening it again while a request waits
//! would end that request.
//!
//! The request then waits on its own thread, polling the app. Calling the tool
//! again reports where it stands: waiting (with the words again), approved
//! (the key is saved; the AI app restarts the tool to use it), or not
//! approved. The secret is saved to the key file and never appears in any
//! output: only the words and the status do.

use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bitsov_mcp_wire::{clean_name, read_frame, MAX_FRAME_BYTES};
use serde_json::{json, Value};

use super::{ask_pair, refused_for_window, wait_pair, ClientKey, PairOutcome};

/// The one tool offered before pairing.
pub const TOOL: &str = "pair_with_bitsov";
/// The protocol version answered when the client names none.
const PROTOCOL_VERSION: &str = "2025-06-18";
/// The name used when neither the call nor the AI app gives one.
const FALLBACK_NAME: &str = "AI app";

/// A connection to the app: a reader and a writer.
pub type AppConnection = (Box<dyn BufRead + Send>, Box<dyn Write + Send>);
/// Opens a connection to the app.
pub type Connect = Box<dyn Fn() -> io::Result<AppConnection> + Send + Sync>;
/// Saves the key the app hands over.
pub type SaveKey = Arc<dyn Fn(&ClientKey) -> io::Result<()> + Send + Sync>;

/// How the pairing tool reaches the app and the key file.
pub struct Link {
    /// Open a connection to the app.
    pub connect: Connect,
    /// Before asking the app: refuse if a key could not be saved.
    pub ready: Box<dyn Fn() -> io::Result<()> + Send + Sync>,
    /// Save the key the app hands over (once).
    pub save: SaveKey,
    /// How often a waiting request asks the app (well inside its idle limit).
    pub poll_every: Duration,
    /// When a waiting request is given up (the app's request lifetime).
    pub give_up_after: Duration,
}

/// Where this run's pairing stands.
#[derive(Debug, Clone, PartialEq, Eq)]
enum State {
    Idle,
    Waiting { words: [&'static str; 6] },
    Approved,
    NotApproved,
    Expired,
    Failed(String),
}

/// The MCP server that runs while there is no key.
pub struct Server {
    link: Link,
    state: Arc<Mutex<State>>,
    /// Set when the AI app goes away: a waiting request stops polling.
    ended: Arc<AtomicBool>,
    client_name: Option<String>,
}

impl Server {
    pub fn new(link: Link) -> Self {
        Self { link, state: Arc::new(Mutex::new(State::Idle)), ended: Arc::new(AtomicBool::new(false)), client_name: None }
    }

    /// Answer MCP requests from `input` on `output`, one line each, until the
    /// AI app's input ends.
    pub fn serve(mut self, mut input: impl BufRead, mut output: impl Write) -> io::Result<()> {
        let result = loop {
            let frame = match read_frame(&mut input, MAX_FRAME_BYTES) {
                Ok(Some(frame)) => frame,
                Ok(None) => break Ok(()),
                Err(error) => break Err(error),
            };
            let reply = match serde_json::from_slice::<Value>(&frame) {
                Ok(request) => self.handle(&request),
                Err(_) => Some(error_reply(Value::Null, -32700, "parse error")),
            };
            if let Some(reply) = reply {
                let mut line = reply.to_string().into_bytes();
                line.push(b'\n');
                if let Err(error) = output.write_all(&line).and_then(|()| output.flush()) {
                    break Err(error);
                }
            }
        };
        self.ended.store(true, Ordering::SeqCst);
        result
    }

    /// One JSON-RPC message. None for a notification.
    pub fn handle(&mut self, request: &Value) -> Option<Value> {
        let id = request.get("id").cloned()?;
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        Some(match request.get("method").and_then(Value::as_str) {
            Some("initialize") => {
                self.client_name = params["clientInfo"]["name"].as_str().map(clean_name).filter(|name| !name.is_empty());
                let version = params["protocolVersion"].as_str().unwrap_or(PROTOCOL_VERSION);
                result(id, json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "bitsov-mcp", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": format!("Not paired with BitSov yet. Use the {TOOL} tool to pair; it shows six words to compare in BitSov."),
                }))
            }
            Some("ping") => result(id, json!({})),
            Some("tools/list") => result(id, json!({ "tools": [tool()] })),
            Some("tools/call") if params["name"] == TOOL => {
                let name = params["arguments"]["name"].as_str().map(clean_name).filter(|name| !name.is_empty());
                let (text, failed) = self.call(name);
                result(id, json!({ "content": [{ "type": "text", "text": text }], "isError": failed }))
            }
            Some("tools/call") => error_reply(id, -32602, "unknown tool"),
            _ => error_reply(id, -32601, "method not found"),
        })
    }

    /// The tool: start a request, or say where the one started stands.
    fn call(&mut self, name: Option<String>) -> (String, bool) {
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match state.clone() {
            State::Idle => {
                drop(state);
                self.start(name.or_else(|| self.client_name.clone()).unwrap_or_else(|| FALLBACK_NAME.to_owned()))
            }
            State::Waiting { words } => (waiting_text(&words), false),
            State::Approved => (APPROVED.to_owned(), false),
            State::NotApproved => {
                *state = State::Idle;
                (NOT_APPROVED.to_owned(), true)
            }
            State::Expired => {
                *state = State::Idle;
                (EXPIRED.to_owned(), true)
            }
            State::Failed(why) => {
                *state = State::Idle;
                (format!("Pairing with BitSov stopped: {why}. Press 'Add an AI app' in BitSov, then call {TOOL} again."), true)
            }
        }
    }

    fn start(&mut self, name: String) -> (String, bool) {
        if let Err(error) = (self.link.ready)() {
            return (format!("Pairing cannot start on this computer: {error}."), true);
        }
        let (mut reader, mut writer) = match (self.link.connect)() {
            Ok(connection) => connection,
            Err(_) => return (UNREACHABLE.to_owned(), true),
        };
        let mut nonce = [0u8; 32];
        if getrandom::fill(&mut nonce).is_err() {
            return ("Pairing cannot start: no randomness available.".to_owned(), true);
        }
        let asked = match ask_pair(&mut reader, &mut writer, &name, &nonce) {
            Ok(asked) => asked,
            Err(error) if refused_for_window(&error) => return (WINDOW_CLOSED.to_owned(), true),
            Err(error) => return (format!("BitSov did not take the request: {error}."), true),
        };
        let words = asked.words;
        *self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = State::Waiting { words };
        let (state, ended, save) = (self.state.clone(), self.ended.clone(), self.link.save.clone());
        let (poll_every, give_up_after) = (self.link.poll_every, self.link.give_up_after);
        let started = Instant::now();
        let spawned = std::thread::Builder::new().name("bitsov-mcp-pair".into()).spawn(move || {
            let wait = || {
                std::thread::sleep(poll_every);
                !ended.load(Ordering::SeqCst) && started.elapsed() < give_up_after
            };
            let next = match wait_pair(&mut reader, &mut writer, &asked.id, wait) {
                Ok(PairOutcome::Approved(key)) => match save(&key) {
                    Ok(()) => State::Approved,
                    Err(error) => State::Failed(format!("the key could not be saved ({error})")),
                },
                Ok(PairOutcome::Gone) => State::NotApproved,
                Err(error) if error.kind() == io::ErrorKind::TimedOut => State::Expired,
                Err(error) => State::Failed(error.to_string()),
            };
            *state.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = next;
        });
        if spawned.is_err() {
            *self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = State::Idle;
            return ("Pairing cannot start: no thread available.".to_owned(), true);
        }
        (format!(
            "BitSov got a pairing request from \"{}\" and is showing it now. Compare these six words with the request in BitSov, and approve it there only if they are the same:\n\n    {}\n\nIf the words are different, choose Deny. When you have decided, call {TOOL} again to finish.",
            clean_name(&name),
            words.join(" ")
        ), false)
    }
}

const UNREACHABLE: &str = "BitSov is not reachable. Open BitSov, turn on AI apps, press 'Add an AI app', then try again.";
const WINDOW_CLOSED: &str = "Open 'Add an AI app' in BitSov first, then try again.";
const APPROVED: &str = "Approved. BitSov is paired with this AI app. Restart this tool (or close and reopen your AI app) to start using BitSov.";
const NOT_APPROVED: &str = "BitSov did not approve this request (it was denied, or it ended). To try again, press 'Add an AI app' in BitSov, then call pair_with_bitsov again.";
const EXPIRED: &str = "The request expired before it was approved. To try again, press 'Add an AI app' in BitSov, then call pair_with_bitsov again.";

fn waiting_text(words: &[&'static str; 6]) -> String {
    format!("Still waiting for your answer in BitSov. Compare these six words with the request BitSov is showing now, and approve it there only if they are the same:\n\n    {}\n\nThen call {TOOL} again.", words.join(" "))
}

fn tool() -> Value {
    json!({
        "name": TOOL,
        "description": "Pair this AI app with the BitSov app on this computer. Shows six words: the owner approves in BitSov only if BitSov shows the same six words. Call it again to see whether the owner approved.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "The name BitSov shows for this AI app (optional)." }
            },
        },
    })
}

fn result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_reply(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitsov_mcp_wire::pair_code;
    use std::io::Cursor;

    /// What the scripted app was sent, shared with the test.
    #[derive(Clone, Default)]
    struct Sent(Arc<Mutex<Vec<u8>>>);
    impl Write for Sent {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// The app's first reply, made from the request the shim sent: its nonce
    /// and name give the words, as the real app computes them.
    struct ScriptedApp {
        sent: Sent,
        /// Replies after the first: pair_status answers.
        later: Vec<Value>,
        refuse: Option<&'static str>,
    }

    impl BufRead for ScriptedReader {
        fn fill_buf(&mut self) -> io::Result<&[u8]> {
            if self.cursor.position() as usize >= self.cursor.get_ref().len() {
                self.next_reply();
            }
            self.cursor.fill_buf()
        }
        fn consume(&mut self, amount: usize) {
            self.cursor.consume(amount);
        }
    }
    impl io::Read for ScriptedReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let available = self.fill_buf()?;
            let n = available.len().min(buf.len());
            buf[..n].copy_from_slice(&available[..n]);
            self.consume(n);
            Ok(n)
        }
    }

    /// Answers each request once the shim has sent it.
    struct ScriptedReader {
        app: ScriptedApp,
        cursor: Cursor<Vec<u8>>,
        answered: usize,
    }

    impl ScriptedReader {
        fn next_reply(&mut self) {
            let lines: Vec<Value> = self.app.sent.0.lock().unwrap()
                .split(|b| *b == b'\n').filter(|l| !l.is_empty()).map(|l| serde_json::from_slice(l).unwrap()).collect();
            let Some(request) = lines.get(self.answered) else { return };
            self.answered += 1;
            let reply = if let Some(pair) = request.get("pair") {
                match self.app.refuse {
                    Some(reason) => json!({ "error": reason }),
                    None => {
                        let nonce: [u8; 32] = hex::decode(pair["nonce"].as_str().unwrap()).unwrap().try_into().unwrap();
                        let host = [3u8; 32];
                        json!({ "pair": { "id": "mcp-0e", "host_nonce": hex::encode(host), "code": pair_code(&nonce, &host, pair["name"].as_str().unwrap()) } })
                    }
                }
            } else if self.app.later.is_empty() {
                json!({ "pair": "waiting" })
            } else {
                self.app.later.remove(0)
            };
            let mut bytes = reply.to_string().into_bytes();
            bytes.push(b'\n');
            self.cursor = Cursor::new(bytes);
        }
    }

    type Saved = Arc<Mutex<Vec<(String, [u8; 32])>>>;

    struct Fixture {
        server: Server,
        sent: Sent,
        saved: Saved,
    }

    fn fixture(later: Vec<Value>, refuse: Option<&'static str>, reachable: bool) -> Fixture {
        let sent = Sent::default();
        let script = Arc::new(Mutex::new(Some((later, refuse))));
        let saved = Arc::new(Mutex::new(Vec::new()));
        let link = Link {
            connect: {
                let sent = sent.clone();
                Box::new(move || {
                    if !reachable {
                        return Err(io::Error::new(io::ErrorKind::NotFound, "no endpoint"));
                    }
                    let (later, refuse) = script.lock().unwrap().take().expect("one connection");
                    let app = ScriptedApp { sent: sent.clone(), later, refuse };
                    let reader = ScriptedReader { app, cursor: Cursor::new(Vec::new()), answered: 0 };
                    Ok((Box::new(reader) as Box<dyn BufRead + Send>, Box::new(sent.clone()) as Box<dyn Write + Send>))
                })
            },
            ready: Box::new(|| Ok(())),
            save: {
                let saved = saved.clone();
                Arc::new(move |key: &ClientKey| {
                    saved.lock().unwrap().push((key.id.clone(), *key.secret));
                    Ok(())
                })
            },
            poll_every: Duration::from_millis(5),
            give_up_after: Duration::from_secs(5),
        };
        Fixture { server: Server::new(link), sent, saved }
    }

    fn call(server: &mut Server, args: Value) -> (String, bool) {
        let reply = server.handle(&json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": { "name": TOOL, "arguments": args } })).unwrap();
        let result = &reply["result"];
        (result["content"][0]["text"].as_str().unwrap().to_owned(), result["isError"].as_bool().unwrap())
    }

    /// Call the tool until its text contains `want`.
    fn call_until(server: &mut Server, want: &str) -> (String, bool) {
        let start = Instant::now();
        loop {
            let (text, failed) = call(server, json!({}));
            if text.contains(want) {
                return (text, failed);
            }
            assert!(start.elapsed() < Duration::from_secs(5), "never got {want:?}; last: {text}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn sent_lines(sent: &Sent) -> Vec<Value> {
        sent.0.lock().unwrap().split(|b| *b == b'\n').filter(|l| !l.is_empty()).map(|l| serde_json::from_slice(l).unwrap()).collect()
    }

    #[test]
    fn with_no_key_the_server_offers_one_pairing_tool() {
        let Fixture { server, .. } = fixture(Vec::new(), None, true);
        let input = [
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26", "clientInfo": { "name": "Desk\u{202e} app" } } }),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            json!({ "jsonrpc": "2.0", "id": 3, "method": "ping" }),
            json!({ "jsonrpc": "2.0", "id": 4, "method": "resources/list" }),
            json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "read_node" } }),
        ].iter().map(|v| v.to_string() + "\n").collect::<String>() + "not json\n";
        let mut output = Vec::new();
        server.serve(Cursor::new(input.into_bytes()), &mut output).unwrap();
        let replies: Vec<Value> = output.split(|b| *b == b'\n').filter(|l| !l.is_empty()).map(|l| serde_json::from_slice(l).unwrap()).collect();
        assert_eq!(replies.len(), 6, "no reply to the notification");
        assert_eq!(replies[0]["result"]["protocolVersion"], "2025-03-26");
        assert!(replies[0]["result"]["capabilities"]["tools"].is_object());
        let tools = replies[1]["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], TOOL);
        assert_eq!(replies[2]["result"], json!({}));
        assert_eq!(replies[3]["error"]["code"], -32601);
        assert_eq!(replies[4]["error"]["code"], -32602, "no other tool");
        assert_eq!(replies[5]["error"]["code"], -32700);
    }

    #[test]
    fn the_tool_shows_the_six_words_and_the_steps_then_reports_approved_and_saves_the_key() {
        let secret = [0xabu8; 32];
        let mut h = fixture(vec![json!({ "pair": "waiting" }), json!({ "pair": "approved", "id": "mcp-0e", "secret": hex::encode(secret) })], None, true);
        h.server.handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "Desk app" } } }));
        let (text, failed) = call(&mut h.server, json!({}));
        assert!(!failed, "{text}");
        let first = &sent_lines(&h.sent)[0]["pair"];
        assert_eq!(first["name"], "Desk app", "the AI app's own name by default");
        let nonce: [u8; 32] = hex::decode(first["nonce"].as_str().unwrap()).unwrap().try_into().unwrap();
        let words = pair_code(&nonce, &[3u8; 32], "Desk app").join(" ");
        assert!(text.contains(&words), "{text}");
        assert!(text.contains("approve it there only if they are the same"), "{text}");
        assert!(!text.contains("Add an AI app"), "a waiting request would end if the window were opened again: {text}");

        let (text, failed) = call_until(&mut h.server, "Approved.");
        assert!(!failed);
        assert!(text.contains("Restart this tool"), "{text}");
        assert_eq!(*h.saved.lock().unwrap(), [("mcp-0e".to_owned(), secret)], "the key is saved once");
        // The secret never shows, in any reply.
        let hex_secret = hex::encode(secret);
        for (text, _) in [call(&mut h.server, json!({})), (text, false)] {
            assert!(!text.contains(&hex_secret) && !text.contains("mcp-0e"), "{text}");
        }
    }

    #[test]
    fn while_waiting_the_tool_repeats_the_words_and_a_given_name_is_used() {
        let mut h = fixture(Vec::new(), None, true);
        let (first, _) = call(&mut h.server, json!({ "name": " Notes\n" }));
        assert_eq!(sent_lines(&h.sent)[0]["pair"]["name"], "Notes");
        let words = first.lines().find(|line| line.starts_with("    ")).unwrap().trim().to_owned();
        let (text, failed) = call(&mut h.server, json!({}));
        assert!(!failed);
        assert!(text.starts_with("Still waiting"), "{text}");
        assert!(text.contains(&words), "{text}");
        assert!(!first.contains("Add an AI app") && !text.contains("Add an AI app"), "{first}\n{text}");
        h.server.ended.store(true, Ordering::SeqCst);
    }

    #[test]
    fn a_denied_or_ended_request_is_reported_and_the_tool_can_start_again() {
        let mut h = fixture(vec![json!({ "pair": "gone" })], None, true);
        call(&mut h.server, json!({}));
        let (text, failed) = call_until(&mut h.server, "did not approve");
        assert!(failed, "{text}");
        assert!(h.saved.lock().unwrap().is_empty());
        // Back to the start: the next call asks again (here: a fresh connection is needed).
        assert_eq!(*h.server.state.lock().unwrap(), State::Idle);
    }

    #[test]
    fn a_closed_window_or_an_unreachable_app_says_what_to_do() {
        for reason in ["pairing closed", "pairing request already made"] {
            let mut h = fixture(Vec::new(), Some(reason), true);
            let (text, failed) = call(&mut h.server, json!({}));
            assert!(failed);
            assert_eq!(text, WINDOW_CLOSED, "{reason}");
            assert!(text.contains("Open 'Add an AI app' in BitSov first"), "{reason}");
        }
        let mut h = fixture(Vec::new(), None, false);
        let (text, failed) = call(&mut h.server, json!({}));
        assert!(failed);
        assert_eq!(text, UNREACHABLE);
        let mut h = fixture(Vec::new(), Some("too many pairing requests waiting"), true);
        let (text, _) = call(&mut h.server, json!({}));
        assert!(text.contains("too many pairing requests waiting"), "{text}");
    }

    #[test]
    fn a_request_not_decided_in_time_expires() {
        let mut h = fixture(Vec::new(), None, true);
        h.server.link.give_up_after = Duration::from_millis(50);
        call(&mut h.server, json!({}));
        let (text, failed) = call_until(&mut h.server, "expired");
        assert!(failed, "{text}");
    }

    #[test]
    fn a_key_that_cannot_be_saved_is_reported_without_the_secret() {
        let secret = [0xcdu8; 32];
        let mut h = fixture(vec![json!({ "pair": "approved", "id": "mcp-0e", "secret": hex::encode(secret) })], None, true);
        h.server.link.save = Arc::new(|_: &ClientKey| Err(io::Error::other("disk full")));
        call(&mut h.server, json!({}));
        let (text, failed) = call_until(&mut h.server, "could not be saved");
        assert!(failed);
        assert!(!text.contains(&hex::encode(secret)), "{text}");
    }
}
