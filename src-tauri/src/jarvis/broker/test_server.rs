//! Test-only loopback HTTP server in front of [`mock_node::MockNode`].
//!
//! Binds `127.0.0.1:0` (never the node's 3141) and answers the rc7 read routes
//! with mock-node's canonical bodies, so `LocalNodeRead` can be compared with
//! the in-process mock adapter over a real socket. mock-node stays socket-free;
//! the listener lives here, in `cfg(test)` code only.
//!
//! Fault mapping over the wire:
//! - `error`: the status and body mock-node gives (502/500/400).
//! - `timeout`: the connection is closed with no response.
//! - `stale`: `503`. rc7 has no stale marker on the wire, so a real rc7 node
//!   cannot tell the app a body is stale. The test server carries mock-node's
//!   out-of-band flag as an error status so the fixture's stale rows still
//!   come back `Unavailable` (see docs/ASSISTANT_LOCAL_BROKER.md).

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use mock_node::MockNode;

/// The node's port. Tests must never bind it.
pub const NODE_PORT: u16 = 3141;

/// One request as the server saw it. `bearer` is kept so tests can check the
/// right token was sent; it is never printed.
#[derive(Clone)]
pub struct Seen {
    pub method: String,
    pub target: String,
    pub bearer: Option<String>,
}

struct Shared {
    node: Mutex<MockNode>,
    token: String,
    seen: Mutex<Vec<Seen>>,
}

pub struct TestServer {
    addr: SocketAddr,
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
}

impl TestServer {
    /// Serve `node`, accepting only `Authorization: Bearer <token>`.
    pub fn start(node: MockNode, token: &str) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind ephemeral loopback port");
        let addr = listener.local_addr().expect("addr");
        assert_ne!(
            addr.port(),
            NODE_PORT,
            "tests must never hold the node port"
        );
        let shared = Arc::new(Shared {
            node: Mutex::new(node),
            token: token.to_string(),
            seen: Mutex::new(Vec::new()),
        });
        let stop = Arc::new(AtomicBool::new(false));
        let (flag, state) = (stop.clone(), shared.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if flag.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                serve_one(&state, stream);
            }
        });
        Self { addr, shared, stop }
    }

    /// `http://127.0.0.1:<ephemeral>/api/v1`, the shape of the app's `API_BASE`.
    pub fn api_base(&self) -> String {
        format!("{}://127.0.0.1:{}/api/v1", "http", self.addr.port())
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    /// Swap the node (and its faults) between questions.
    pub fn set_node(&self, node: MockNode) {
        *self.shared.node.lock().unwrap() = node;
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.shared.seen.lock().unwrap().clone()
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
    }
}

/// A loopback port with nothing listening: bind an ephemeral port, then drop it.
pub fn closed_loopback_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().expect("addr").port();
    assert_ne!(port, NODE_PORT);
    drop(listener);
    port
}

fn serve_one(shared: &Shared, stream: TcpStream) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() || line.is_empty() {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let mut bearer = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).is_err() || header == "\r\n" || header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':').unwrap_or((&header, ""));
        if name.eq_ignore_ascii_case("authorization") {
            bearer = value.trim().strip_prefix("Bearer ").map(str::to_owned);
        }
    }
    shared.seen.lock().unwrap().push(Seen {
        method: method.clone(),
        target: target.clone(),
        bearer: bearer.clone(),
    });

    let (status, body) = if bearer.as_deref() != Some(shared.token.as_str()) {
        (
            401,
            r#"{"error":"invalid or expired token","code":401}"#.to_string(),
        )
    } else if method != "GET" {
        (405, String::new())
    } else {
        let exchange = shared.node.lock().unwrap().serve(&target);
        if exchange.timed_out {
            return; // close with no response
        }
        if exchange.stale {
            (503, r#"{"error":"stale","code":503}"#.to_string())
        } else {
            let body = exchange
                .body
                .map(|value| value.to_string())
                .unwrap_or_default();
            (exchange.status, body)
        }
    };
    let mut out = stream;
    let _ = write!(
        out,
        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
}
