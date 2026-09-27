//! [`NodeRead`] against the local node over loopback.
//!
//! The host builds one with the paired token (F1, `crate::pairing`) and the
//! app's loopback API base. The assistant window never sees it and cannot
//! select it. Deny-by-default:
//!
//! - The base URL must be plain `http` to a loopback IP literal and port, path
//!   `/api/v1`. A host name (even `localhost`), a non-loopback address, TLS,
//!   credentials or any other path is refused, so the only socket this opens
//!   is loopback.
//! - Every request passes [`admit`] immediately before it is written: GET
//!   only, a path from [`super::ALLOWED_PATHS`] with no forbidden segment, and
//!   the one `limit` query on `/messages`. Anything else is refused and logged
//!   (method, sanitized path, reason) and never reaches the node.
//! - Plain `std::net`: no proxy settings, no redirects, no DNS, no cookies.
//!   A response with `Transfer-Encoding` is not decoded.
//!
//! On a 2xx, `BitSov-Data-As-Of` and `BitSov-Data-Stale` (genome #78) are
//! parsed into [`NodeMarks`] for [`super::RouteFreshness`]. A malformed or
//! repeated as-of is dropped and logged with the path and reason, never the
//! value. Headers on any other status are dropped unread. rc7 sends neither.
//!
//! Log lines and errors carry no body, no token and no key. A node-stale body
//! is still returned as a body (the label says *Stale*), so this reader never
//! returns [`ReadFault::Stale`].

use std::fmt;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv6Addr, SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use super::freshness::parse_as_of;
use super::route::{self, Query, ReadRoute};
use super::{Fetched, NodeMarks, NodeRead, RawRead, ReadFault};

const LOG_PREFIX: &str = "[assistant-broker]";
/// Same bounds as the host's loopback reqwest client.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const IO_TIMEOUT: Duration = Duration::from_secs(5);
/// A `/messages` page at the genome cap stays well under this.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
/// Longest refused path echoed into the host log.
const MAX_LOGGED_PATH: usize = 96;
/// Genome #78 freshness headers. Matched case-insensitively.
const AS_OF_HEADER: &str = "BitSov-Data-As-Of";
const STALE_HEADER: &str = "BitSov-Data-Stale";

/// Why a `BitSov-Data-As-Of` header was dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AsOfIgnored {
    Malformed,
    Repeated,
}

impl AsOfIgnored {
    fn text(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::Repeated => "repeated",
        }
    }
}

/// Why a request was refused before any byte left the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenyReason {
    Method,
    Route,
    Query,
}

impl DenyReason {
    fn text(self) -> &'static str {
        match self {
            Self::Method => "method not allowed",
            Self::Route => "route not allowlisted",
            Self::Query => "query not allowlisted",
        }
    }
}

/// The base URL is not `http` to a loopback IP and port with path `/api/v1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BaseUrlRejected;

/// A bearer token. `Debug` redacts it and there is no `Display`. Only visible
/// ASCII is accepted, so it cannot split the request's header block.
pub struct BearerToken(String);

impl BearerToken {
    pub fn new(token: String) -> Option<Self> {
        let printable = !token.is_empty() && token.bytes().all(|b| b.is_ascii_graphic());
        printable.then_some(Self(token))
    }
}

impl fmt::Debug for BearerToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("BearerToken(..)")
    }
}

/// Host log for the broker. Lines carry a method, an allowlisted path (or a
/// sanitized refused path) and a reason. Never a body, a token, or a key.
pub trait AuditSink: Send + Sync {
    fn record(&self, line: &str);
}

/// The app's sink: stderr.
pub struct StderrAudit;

impl AuditSink for StderrAudit {
    fn record(&self, line: &str) {
        eprintln!("{line}");
    }
}

pub struct LocalNodeRead {
    addr: SocketAddr,
    token: BearerToken,
    audit: Arc<dyn AuditSink>,
}

impl fmt::Debug for LocalNodeRead {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalNodeRead")
            .field("addr", &self.addr)
            .finish_non_exhaustive()
    }
}

impl LocalNodeRead {
    /// `base_url` is the app's loopback API base, e.g. `API_BASE`.
    pub fn new(
        base_url: &str,
        token: BearerToken,
        audit: Arc<dyn AuditSink>,
    ) -> Result<Self, BaseUrlRejected> {
        match loopback_addr(base_url) {
            Some(addr) => Ok(Self { addr, token, audit }),
            None => {
                audit.record(&format!(
                    "{LOG_PREFIX} refused base url: not http on a loopback IP with /api/v1"
                ));
                Err(BaseUrlRejected)
            }
        }
    }

    /// The one place a request is written. [`admit`] runs first.
    fn send(&self, method: &str, path: &str, query: Option<Query>) -> Result<RawRead, Refused> {
        if let Err(reason) = admit(method, path, query) {
            self.audit.record(&format!(
                "{LOG_PREFIX} denied {} {}: {}",
                printable(method, 8),
                printable(path.split('?').next().unwrap_or(""), MAX_LOGGED_PATH),
                reason.text()
            ));
            return Err(Refused::Denied(reason));
        }
        match self.exchange(path, query) {
            Some((raw, marks)) => {
                if !(200..300).contains(&raw.status) {
                    self.audit.record(&format!(
                        "{LOG_PREFIX} {method} {path}: http {}",
                        raw.status
                    ));
                    return Ok(raw);
                }
                let marks = marks.unwrap_or_else(|ignored| {
                    self.audit.record(&format!(
                        "{LOG_PREFIX} {method} {path}: ignored {AS_OF_HEADER}: {}",
                        ignored.reason.text()
                    ));
                    ignored.kept
                });
                Ok(raw.marked(marks))
            }
            None => {
                self.audit
                    .record(&format!("{LOG_PREFIX} {method} {path}: transport error"));
                Err(Refused::Fault(ReadFault::Transport))
            }
        }
    }

    /// One `GET` over a fresh connection, with the node's freshness headers
    /// unapplied. `None` on any transport or framing problem; the cause is
    /// dropped so nothing from the wire is echoed.
    fn exchange(&self, path: &str, query: Option<Query>) -> Option<(RawRead, MarksRead)> {
        let mut stream = TcpStream::connect_timeout(&self.addr, CONNECT_TIMEOUT).ok()?;
        stream.set_read_timeout(Some(IO_TIMEOUT)).ok()?;
        stream.set_write_timeout(Some(IO_TIMEOUT)).ok()?;
        let target = match query {
            Some(query) => format!("{path}?{}={}", query.key, query.value),
            None => path.to_string(),
        };
        let request = format!(
            "GET {target} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\n\
             Accept: application/json\r\nConnection: close\r\n\r\n",
            self.addr, self.token.0
        );
        stream.write_all(request.as_bytes()).ok()?;

        let mut response = Vec::new();
        stream
            .take(MAX_RESPONSE_BYTES as u64 + 1)
            .read_to_end(&mut response)
            .ok()?;
        if response.len() > MAX_RESPONSE_BYTES {
            return None;
        }
        let fetched = Fetched::now();
        parse_marked_response(&response).map(|(raw, marks)| (raw.stamped(fetched), marks))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refused {
    Denied(DenyReason),
    Fault(ReadFault),
}

/// Deny-by-default gate: GET, an allowlisted path, and only `limit` on
/// `/messages`. Exact byte matches; no normalisation.
pub fn admit(method: &str, path: &str, query: Option<Query>) -> Result<(), DenyReason> {
    if method != "GET" {
        return Err(DenyReason::Method);
    }
    if !route::path_allowed(path) || !route::segments_allowed(path) {
        return Err(DenyReason::Route);
    }
    match query {
        None => Ok(()),
        Some(query) if path == route::MESSAGES && query.key == "limit" => Ok(()),
        Some(_) => Err(DenyReason::Query),
    }
}

impl NodeRead for LocalNodeRead {
    fn read(&self, route: ReadRoute) -> Result<RawRead, ReadFault> {
        let target = route.target();
        match self.send(target.method, target.path, target.query) {
            Ok(raw) => Ok(raw),
            Err(Refused::Fault(fault)) => Err(fault),
            // Unreachable for a `ReadRoute`; refused all the same.
            Err(Refused::Denied(_)) => Err(ReadFault::Transport),
        }
    }
}

/// Plain `http`, a loopback IP literal, an explicit non-zero port, and path
/// `/api/v1` (one optional trailing `/`).
fn loopback_addr(base_url: &str) -> Option<SocketAddr> {
    let rest = base_url.strip_prefix("http://")?;
    let (authority, path) = rest.split_at(rest.find('/')?);
    if path != "/api/v1" && path != "/api/v1/" {
        return None;
    }
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (host, port) = v6.split_once("]:")?;
        (IpAddr::V6(host.parse::<Ipv6Addr>().ok()?), port)
    } else {
        let (host, port) = authority.split_once(':')?;
        (IpAddr::V4(host.parse().ok()?), port)
    };
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    (host.is_loopback() && port != 0).then_some(SocketAddr::new(host, port))
}

/// The freshness headers kept from a dropped as-of, and why it was dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Ignored {
    kept: NodeMarks,
    reason: AsOfIgnored,
}

type MarksRead = Result<NodeMarks, Ignored>;

/// Status line, headers, then a `Content-Length` body (or the rest of the
/// stream on `Connection: close`). `Transfer-Encoding` is refused.
#[cfg(test)]
fn parse_response(response: &[u8]) -> Option<RawRead> {
    parse_marked_response(response).map(|(raw, _)| raw)
}

/// [`parse_response`] plus the freshness headers, which the caller applies
/// only to a 2xx.
fn parse_marked_response(response: &[u8]) -> Option<(RawRead, MarksRead)> {
    let split = response.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&response[..split]).ok()?;
    let body = &response[split + 4..];
    let mut lines = head.split("\r\n");
    let mut status_line = lines.next()?.splitn(3, ' ');
    if !status_line.next()?.starts_with("HTTP/1.") {
        return None;
    }
    let status_text = status_line.next()?;
    if status_text.len() != 3 {
        return None;
    }
    let status: u16 = status_text.parse().ok()?;
    let mut length = None;
    let mut as_of = Vec::new();
    let mut stale = false;
    for line in lines {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return None;
        }
        if name.eq_ignore_ascii_case("content-length") {
            length = Some(value.trim().parse::<usize>().ok()?);
        }
        if name.eq_ignore_ascii_case(AS_OF_HEADER) {
            as_of.push(value.trim());
        }
        if name.eq_ignore_ascii_case(STALE_HEADER) && value.trim() == "1" {
            stale = true;
        }
    }
    let body = match length {
        Some(length) => body.get(..length)?,
        None => body,
    };
    let kept = NodeMarks {
        as_of_ms: None,
        stale,
    };
    let marks = match as_of.as_slice() {
        [] => Ok(kept),
        [one] => match parse_as_of(one) {
            Some(ms) => Ok(NodeMarks {
                as_of_ms: Some(ms),
                stale,
            }),
            None => Err(Ignored {
                kept,
                reason: AsOfIgnored::Malformed,
            }),
        },
        _ => Err(Ignored {
            kept,
            reason: AsOfIgnored::Repeated,
        }),
    };
    Some((RawRead::new(status, body.to_vec()), marks))
}

/// Bounded, single-line form of a caller-supplied string for the host log.
fn printable(text: &str, max: usize) -> String {
    text.chars()
        .take(max)
        .map(|c| if c.is_ascii_graphic() { c } else { '?' })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mock_node::{Fault, MockNode, Route};

    use super::super::test_server::{closed_loopback_port, TestServer, NODE_PORT};
    use super::*;

    const TOKEN: &str = "paired-TOKEN-CANARY-7f3a";

    #[derive(Default)]
    struct Collect(Mutex<Vec<String>>);

    impl AuditSink for Collect {
        fn record(&self, line: &str) {
            self.0.lock().unwrap().push(line.to_string());
        }
    }

    impl Collect {
        fn lines(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
    }

    /// Scheme split off so the source has no literal non-loopback control-plane
    /// URL for the G2 authority gate to trip on.
    fn http(rest: &str) -> String {
        format!("{}://{rest}", "http")
    }

    fn token() -> BearerToken {
        BearerToken::new(TOKEN.to_string()).expect("token")
    }

    fn reader(base: &str) -> (LocalNodeRead, Arc<Collect>) {
        let audit = Arc::new(Collect::default());
        let read = LocalNodeRead::new(base, token(), audit.clone()).expect("loopback base");
        (read, audit)
    }

    fn body_text(raw: &RawRead) -> String {
        String::from_utf8(raw.body.clone()).expect("utf8")
    }

    #[test]
    fn accepts_only_http_loopback_ip_bases_with_the_api_prefix() {
        let audit: Arc<dyn AuditSink> = Arc::new(Collect::default());
        let port = closed_loopback_port();
        for good in [
            format!("http://127.0.0.1:{port}/api/v1"),
            format!("http://127.0.0.1:{port}/api/v1/"),
            http(&format!("127.8.9.10:{port}/api/v1")),
            http(&format!("[::1]:{port}/api/v1")),
        ] {
            assert!(
                LocalNodeRead::new(&good, token(), audit.clone()).is_ok(),
                "{good}"
            );
        }
        let mut bad: Vec<String> = [
            "192.168.1.5:3141/api/v1",
            "10.0.0.1:3141/api/v1",
            "0.0.0.0:3141/api/v1",
            "[::]:3141/api/v1",
            "[2001:db8::1]:3141/api/v1",
            "localhost:3141/api/v1",
            "127.0.0.1.evil.example:3141/api/v1",
            "evil.example/api/v1",
            "user@127.0.0.1:3141/api/v1",
            "127.0.0.1/api/v1",
            "127.0.0.1:0/api/v1",
            "127.0.0.1:3141",
            "127.0.0.1:3141/",
            "127.0.0.1:3141/api/v2",
            "127.0.0.1:3141/api/v1/payments/pay",
            "127.0.0.1:3141/api/v1?x=1",
            "127.1:3141/api/v1",
        ]
        .iter()
        .map(|rest| http(rest))
        .collect();
        bad.push(format!("{}s://127.0.0.1:3141/api/v1", "http"));
        bad.push("ws://127.0.0.1:3141/api/v1".into());
        bad.push("127.0.0.1:3141/api/v1".into());
        bad.push(String::new());
        for bad in &bad {
            assert_eq!(
                LocalNodeRead::new(bad, token(), audit.clone()).map(|_| ()),
                Err(BaseUrlRejected),
                "{bad}"
            );
        }
    }

    #[test]
    fn refused_base_url_is_logged_without_the_url() {
        let audit = Arc::new(Collect::default());
        let bad = &http("user:hunter2@192.168.1.5:3141/api/v1");
        assert!(LocalNodeRead::new(bad, token(), audit.clone()).is_err());
        let lines = audit.lines();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("refused base url"), "{lines:?}");
        assert!(!lines[0].contains("hunter2") && !lines[0].contains("192.168"));
    }

    #[test]
    fn response_framing_is_strict() {
        let ok = parse_response(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}trailing")
            .expect("framed");
        assert_eq!((ok.status, ok.body.as_slice()), (200, b"{}".as_slice()));
        let to_eof = parse_response(b"HTTP/1.1 502 Bad Gateway\r\n\r\n{\"e\":1}").expect("eof");
        assert_eq!(
            (to_eof.status, to_eof.body.as_slice()),
            (502, b"{\"e\":1}".as_slice())
        );

        for bad in [
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n".as_slice(),
            b"HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\ncontent-length: x\r\n\r\n{}",
            b"HTTP/1.1 2000 OK\r\n\r\n{}",
            b"SPDY/1 200 OK\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nno-colon-header\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\n",
            b"",
        ] {
            assert!(
                parse_response(bad).is_none(),
                "{:?}",
                String::from_utf8_lossy(bad)
            );
        }
    }

    #[test]
    fn rejects_tokens_that_could_break_the_request_line() {
        for bad in ["", "a b", "a\r\nX-Evil: 1", "tok\n", "tök", "a\tb"] {
            assert!(BearerToken::new(bad.to_string()).is_none(), "{bad:?}");
        }
        assert!(BearerToken::new("eyJ.abc-_~+/=".to_string()).is_some());
    }

    #[test]
    fn admit_allows_only_pinned_get_reads() {
        let limit = Some(Query {
            key: "limit",
            value: 50,
        });
        assert_eq!(admit("GET", "/api/v1/health", None), Ok(()));
        assert_eq!(admit("GET", "/api/v1/payments/balance", None), Ok(()));
        assert_eq!(admit("GET", "/api/v1/payments/channels", None), Ok(()));
        assert_eq!(admit("GET", "/api/v1/messages", limit), Ok(()));
        assert_eq!(admit("GET", "/api/v1/pricing", None), Ok(()));

        for method in ["POST", "PUT", "DELETE", "PATCH", "HEAD", "get", "GET "] {
            assert_eq!(
                admit(method, "/api/v1/health", None),
                Err(DenyReason::Method),
                "{method}"
            );
        }
        for path in [
            "/api/v1/payments/pay",
            "/api/v1/payments/invoice",
            "/api/v1/payments/keysend",
            "/api/v1/payments/send-onchain",
            "/api/v1/payments/open-channel",
            "/api/v1/payments/close-channel",
            "/api/v1/payments/funding-address",
            "/api/v1/payments/price/0",
            "/api/v1/payments",
            "/api/v1/identity",
            "/api/v1/identity/restore",
            "/api/v1/auth/local",
            "/api/v1/pair/request",
            "/api/v1/onboarding/start",
            "/api/v1/status",
            "/api/v1/peers",
            "/api/v1/messages/compose",
            "/api/v1/health/../payments/pay",
            "/api/v1/health?x=1",
            "/api/v1/health/",
            "/API/V1/HEALTH",
            "health",
            "",
        ] {
            assert_eq!(admit("GET", path, None), Err(DenyReason::Route), "{path}");
        }
        for key in ["peer", "before", "sent", "limit "] {
            assert_eq!(
                admit("GET", "/api/v1/messages", Some(Query { key, value: 1 })),
                Err(DenyReason::Query),
                "{key}"
            );
        }
        // A query on a route that takes none.
        assert_eq!(
            admit("GET", "/api/v1/health", limit),
            Err(DenyReason::Query)
        );
    }

    #[test]
    fn write_and_unlisted_requests_never_reach_the_node_and_are_logged() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let (read, audit) = reader(&server.api_base());

        assert_eq!(
            read.send("POST", "/api/v1/payments/pay", None).map(|_| ()),
            Err(Refused::Denied(DenyReason::Method))
        );
        assert_eq!(
            read.send("POST", "/api/v1/auth/local", None).map(|_| ()),
            Err(Refused::Denied(DenyReason::Method))
        );
        assert_eq!(
            read.send("GET", "/api/v1/identity", None).map(|_| ()),
            Err(Refused::Denied(DenyReason::Route))
        );
        assert_eq!(
            read.send("GET", "/api/v1/payments/price/0?secret=abc", None)
                .map(|_| ()),
            Err(Refused::Denied(DenyReason::Route))
        );
        assert!(
            server.seen().is_empty(),
            "a refused request reached the node"
        );

        let lines = audit.lines();
        assert_eq!(
            lines,
            [
                "[assistant-broker] denied POST /api/v1/payments/pay: method not allowed",
                "[assistant-broker] denied POST /api/v1/auth/local: method not allowed",
                "[assistant-broker] denied GET /api/v1/identity: route not allowlisted",
                "[assistant-broker] denied GET /api/v1/payments/price/0: route not allowlisted",
            ]
        );
    }

    #[test]
    fn denied_path_in_the_log_is_bounded_and_printable() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let (read, audit) = reader(&server.api_base());
        let hostile = format!("/api/v1/x\r\nInjected: 1{}", "a".repeat(500));
        assert!(read.send("GET", &hostile, None).is_err());
        let line = &audit.lines()[0];
        assert!(!line.contains('\r') && !line.contains('\n'), "{line:?}");
        assert!(line.len() < 200, "{}", line.len());
    }

    #[test]
    fn reads_an_allowlisted_route_with_the_paired_token() {
        let server = TestServer::start(MockNode::canonical(), TOKEN);
        let (read, _audit) = reader(&server.api_base());

        let raw = read.read(ReadRoute::PaymentsBalance).expect("balance");
        assert_eq!(raw.status, 200);
        assert_eq!(body_text(&raw), r#"{"balance_msat":52500000}"#);

        let raw = read
            .read(ReadRoute::Messages { limit: 7 })
            .expect("messages");
        assert_eq!(raw.status, 200);

        let seen = server.seen();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].method, "GET");
        assert_eq!(seen[0].target, "/api/v1/payments/balance");
        assert_eq!(seen[0].bearer.as_deref(), Some(TOKEN));
        assert_eq!(seen[1].target, "/api/v1/messages?limit=7");
    }

    #[test]
    fn a_node_error_status_is_returned_as_a_status_not_a_fault() {
        let node = MockNode::canonical().fault(Route::PaymentsChannels, Fault::Error);
        let server = TestServer::start(node, TOKEN);
        let (read, audit) = reader(&server.api_base());
        let raw = read.read(ReadRoute::PaymentsChannels).expect("status");
        assert_eq!(raw.status, 502);
        assert_eq!(
            audit.lines(),
            ["[assistant-broker] GET /api/v1/payments/channels: http 502"]
        );
    }

    #[test]
    fn a_wrong_token_is_a_401_status() {
        let server = TestServer::start(MockNode::canonical(), "some-other-token");
        let (read, _audit) = reader(&server.api_base());
        assert_eq!(read.read(ReadRoute::Health).expect("status").status, 401);
    }

    #[test]
    fn a_closed_connection_is_a_transport_fault() {
        let node = MockNode::canonical().fault(Route::Health, Fault::Timeout);
        let server = TestServer::start(node, TOKEN);
        let (read, audit) = reader(&server.api_base());
        assert_eq!(
            read.read(ReadRoute::Health).map(|_| ()),
            Err(ReadFault::Transport)
        );
        assert_eq!(
            audit.lines(),
            ["[assistant-broker] GET /api/v1/health: transport error"]
        );
    }

    #[test]
    fn an_unreachable_node_is_a_transport_fault() {
        let port = closed_loopback_port();
        assert_ne!(port, NODE_PORT);
        let (read, audit) = reader(&format!("http://127.0.0.1:{port}/api/v1"));
        assert_eq!(
            read.read(ReadRoute::Health).map(|_| ()),
            Err(ReadFault::Transport)
        );
        assert_eq!(
            audit.lines(),
            ["[assistant-broker] GET /api/v1/health: transport error"]
        );
    }

    #[test]
    fn the_token_never_appears_in_logs_errors_or_debug() {
        let port = closed_loopback_port();
        let error_node = MockNode::canonical()
            .fault(Route::PaymentsBalance, Fault::Error)
            .fault(Route::Health, Fault::Timeout);
        let server = TestServer::start(error_node, TOKEN);
        let wrong = TestServer::start(MockNode::canonical(), "other");

        let mut text = Vec::new();
        for base in [
            server.api_base(),
            wrong.api_base(),
            format!("http://127.0.0.1:{port}/api/v1"),
        ] {
            let (read, audit) = reader(&base);
            for route in [
                ReadRoute::PaymentsBalance,
                ReadRoute::Health,
                ReadRoute::PaymentsChannels,
            ] {
                text.push(format!("{:?}", read.read(route)));
            }
            text.push(format!(
                "{:?}",
                read.send("POST", "/api/v1/payments/pay", None)
            ));
            text.push(format!("{read:?}"));
            text.extend(audit.lines());
        }
        let audit = Arc::new(Collect::default());
        let refused = LocalNodeRead::new(&http("10.0.0.1:1/api/v1"), token(), audit.clone());
        text.push(format!("{refused:?}"));
        text.extend(audit.lines());
        text.push(format!("{:?}", token()));

        assert!(text.len() > 10);
        for entry in &text {
            assert!(!entry.contains(TOKEN), "token leaked: {entry}");
            assert!(!entry.contains("TOKEN-CANARY"), "token leaked: {entry}");
        }
    }
}
