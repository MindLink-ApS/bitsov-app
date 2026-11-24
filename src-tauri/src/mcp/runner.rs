//! MCP A1.5a: serving connections (ADR H3953 A1 §1.3–§1.4).
//!
//! **Not wired.** Nothing in the app starts a runner; the owner's switch comes
//! in a later slice. Compiles only where its parent module does (`cfg(test)`
//! or the off-by-default `mcp-grant` feature).
//!
//! One [`Host`] is shared by every connection behind a mutex that is never
//! held across socket I/O or a read: each frame takes the lock for
//! [`Host::begin_frame`] (the handshake, or authorisation and rate limit),
//! drops it for the read, and takes it again for [`Host::finish_frame`] (the
//! audit row). A slow read on one connection therefore never holds up another
//! connection's handshake or reads.
//!
//! [`serve`] is the per-connection loop and is the same on every platform.
//! On macOS, [`Runner`] owns the listener: one thread accepts, one thread
//! serves each connection, at most [`MAX_CONNECTIONS`] are live (more are
//! closed at once), a connection idle for [`IDLE_TIMEOUT`] is closed, and
//! [`Runner::stop`] closes everything and removes the socket file.

use std::io::{self, BufRead, Write};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

#[cfg(target_os = "macos")]
use super::endpoint::MAX_CONNECTIONS;
use super::endpoint::{read_frame, Begin, Conn, Host, ReadSource};
use super::server::MAX_FRAME_BYTES;

/// A connection that sends nothing for this long is closed.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// Serve one connection until the client hangs up, a frame closes it, or an
/// I/O error (an over-long line, the idle timeout) ends it. The host is
/// locked only around [`Host::begin_frame`] and [`Host::finish_frame`];
/// reading the socket, the read through `source` and writing the reply all
/// happen without it. A poisoned host lock ends the connection.
pub fn serve(
    host: &Mutex<Host>,
    source: &dyn ReadSource,
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    now_ms: &dyn Fn() -> u64,
) -> io::Result<()> {
    let mut conn = Conn::Start;
    while let Some(frame) = read_frame(reader, MAX_FRAME_BYTES)? {
        let begun = {
            let mut host = lock(host)?;
            host.begin_frame(&mut conn, &frame, now_ms())
        };
        let step = match begun {
            Begin::Done(step) => step,
            Begin::Read(pending) => {
                let read = pending.read(source);
                let mut host = lock(host)?;
                host.finish_frame(&mut conn, pending, read)
            }
        };
        if let Some(reply) = &step.reply {
            writer.write_all(reply)?;
            writer.flush()?;
        }
        if step.close {
            break;
        }
    }
    Ok(())
}

fn lock(host: &Mutex<Host>) -> io::Result<MutexGuard<'_, Host>> {
    host.lock().map_err(|_| io::Error::other("the host is unavailable"))
}

/// Milliseconds since the Unix epoch, for the host's clocks.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(target_os = "macos")]
pub use macos::Runner;

#[cfg(target_os = "macos")]
mod macos {
    use std::collections::HashMap;
    use std::io::{self, BufReader};
    use std::net::Shutdown;
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::Duration;

    use super::super::endpoint::{unix, Host, ReadSource};
    use super::{now_ms, serve, IDLE_TIMEOUT, MAX_CONNECTIONS};

    struct Shared {
        host: Arc<Mutex<Host>>,
        source: Arc<dyn ReadSource + Send + Sync>,
        idle: Duration,
        stopping: AtomicBool,
        live: Mutex<Live>,
    }

    /// The live connections (a handle each, to close them on stop) and their
    /// threads. Its own lock, never the host's.
    #[derive(Default)]
    struct Live {
        next: u64,
        streams: HashMap<u64, UnixStream>,
        workers: Vec<JoinHandle<()>>,
    }

    /// The macOS listener: the owner-only socket in `dir` and its threads.
    /// Dropping it is [`Runner::stop`].
    pub struct Runner {
        shared: Arc<Shared>,
        socket: PathBuf,
        accept: Option<JoinHandle<()>>,
    }

    impl Runner {
        /// Bind in `dir` ([`unix::bind`]) and start accepting.
        pub fn start(dir: &Path, host: Arc<Mutex<Host>>, source: Arc<dyn ReadSource + Send + Sync>) -> io::Result<Self> {
            Self::start_with_idle(dir, host, source, IDLE_TIMEOUT)
        }

        /// [`Runner::start`] with another idle timeout (tests).
        pub fn start_with_idle(
            dir: &Path,
            host: Arc<Mutex<Host>>,
            source: Arc<dyn ReadSource + Send + Sync>,
            idle: Duration,
        ) -> io::Result<Self> {
            if idle.is_zero() {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "the idle timeout must not be zero"));
            }
            let listener = unix::bind(dir)?;
            let socket = dir.join(unix::SOCKET_NAME);
            let shared = Arc::new(Shared { host, source, idle, stopping: AtomicBool::new(false), live: Mutex::default() });
            let accepting = shared.clone();
            let accept = std::thread::Builder::new()
                .name("mcp-accept".into())
                .spawn(move || accept_loop(&accepting, &listener))?;
            Ok(Self { shared, socket, accept: Some(accept) })
        }

        /// The host every connection shares.
        pub fn host(&self) -> &Arc<Mutex<Host>> {
            &self.shared.host
        }

        /// How many connections are live now.
        pub fn live(&self) -> usize {
            self.shared.live.lock().map_or(0, |live| live.streams.len())
        }

        /// Stop accepting, close every live connection and remove the socket
        /// file. Returns once every connection thread has ended. A second call
        /// does nothing.
        pub fn stop(&mut self) {
            let Some(accept) = self.accept.take() else { return };
            self.shared.stopping.store(true, Ordering::SeqCst);
            // Wake the accept thread with a connection of our own; it sees the
            // flag and ends, closing the listener. Kept open until then so the
            // accept sees a live peer. If the socket can no longer be reached
            // (its file was removed by someone else), the accept thread is left
            // blocked with the listener until the app exits; it admits nothing,
            // because the flag is checked after every accept.
            if let Ok(wake) = UnixStream::connect(&self.socket) {
                let _ = accept.join();
                drop(wake);
            }
            let workers = match self.shared.live.lock() {
                Ok(mut live) => {
                    for stream in live.streams.values() {
                        let _ = stream.shutdown(Shutdown::Both);
                    }
                    std::mem::take(&mut live.workers)
                }
                Err(_) => Vec::new(),
            };
            for worker in workers {
                let _ = worker.join();
            }
            remove_socket(&self.socket);
        }
    }

    impl Drop for Runner {
        fn drop(&mut self) {
            self.stop();
        }
    }

    /// Remove the socket file, but only if it is still a socket of ours.
    fn remove_socket(path: &Path) {
        if let Ok(meta) = std::fs::symlink_metadata(path) {
            if meta.file_type().is_socket() && meta.uid() == bitsov_ffi::effective_uid() {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    fn accept_loop(shared: &Arc<Shared>, listener: &UnixListener) {
        loop {
            let accepted = unix::accept_owner(listener);
            if shared.stopping.load(Ordering::SeqCst) {
                return;
            }
            match accepted {
                Ok(stream) => admit(shared, stream),
                // Out of descriptors and the like: wait a little, keep serving.
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }

    /// Start serving a new connection, or close it at once when
    /// [`MAX_CONNECTIONS`] are already live.
    fn admit(shared: &Arc<Shared>, stream: UnixStream) {
        let Ok(mut live) = shared.live.lock() else { return };
        live.workers.retain(|worker| !worker.is_finished());
        if live.streams.len() >= MAX_CONNECTIONS {
            let _ = stream.shutdown(Shutdown::Both);
            return;
        }
        if stream.set_read_timeout(Some(shared.idle)).is_err() || stream.set_write_timeout(Some(shared.idle)).is_err() {
            return;
        }
        let Ok(handle) = stream.try_clone() else { return };
        let key = live.next;
        live.next += 1;
        live.streams.insert(key, handle);
        let place = Place { shared: shared.clone(), key };
        let spawned = std::thread::Builder::new().name("mcp-conn".into()).spawn(move || {
            run_connection(&place.shared, stream);
            drop(place);
        });
        match spawned {
            Ok(worker) => live.workers.push(worker),
            Err(_) => {
                if let Some(stream) = live.streams.remove(&key) {
                    let _ = stream.shutdown(Shutdown::Both);
                }
            }
        }
    }

    /// One live connection's place. Dropping it, on every way out of the
    /// connection's thread (a panic included), frees the place and shuts the
    /// socket down, so the client sees the end at once.
    struct Place {
        shared: Arc<Shared>,
        key: u64,
    }

    impl Drop for Place {
        fn drop(&mut self) {
            let mut live = self.shared.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(stream) = live.streams.remove(&self.key) {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
    }

    #[cfg(test)]
    #[test]
    fn a_place_is_freed_and_its_socket_shut_down_when_its_thread_panics() {
        use std::io::Read;
        struct Unused;
        impl ReadSource for Unused {
            fn reads_for(&self, _preset: crate::ai::Preset) -> Box<dyn crate::mcp::server::Reads + '_> {
                unreachable!("no read in this test")
            }
        }
        let (client, served) = UnixStream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let shared = Arc::new(Shared {
            host: Arc::new(Mutex::new(Host::default())),
            source: Arc::new(Unused),
            idle: IDLE_TIMEOUT,
            stopping: AtomicBool::new(false),
            live: Mutex::default(),
        });
        shared.live.lock().unwrap().streams.insert(7, served);
        let place = Place { shared: shared.clone(), key: 7 };
        let ended = std::thread::spawn(move || {
            let _place = place;
            panic!("a connection thread that panics");
        }).join();
        assert!(ended.is_err());
        assert!(shared.live.lock().unwrap().streams.is_empty(), "the place is free");
        assert_eq!((&client).read(&mut [0u8; 1]).unwrap(), 0, "the client sees the end");
    }

    fn run_connection(shared: &Shared, stream: UnixStream) {
        let Ok(read_half) = stream.try_clone() else { return };
        let mut reader = BufReader::new(read_half);
        let mut writer = stream;
        let _ = serve(&shared.host, shared.source.as_ref(), &mut reader, &mut writer, &now_ms);
        let _ = writer.shutdown(Shutdown::Both);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::Topic;
    use crate::mcp::server::{ReadFailed, Reads};
    use crate::mcp::session::Outcome;
    use serde_json::{json, Value};

    struct Instant;
    impl Reads for Instant {
        fn read(&self, _topic: Topic, _since_ms: Option<u64>) -> Result<Value, ReadFailed> {
            Ok(json!({ "ok": true }))
        }
    }
    impl ReadSource for Instant {
        fn reads_for(&self, _preset: crate::ai::Preset) -> Box<dyn Reads + '_> {
            Box::new(Instant)
        }
    }

    #[test]
    fn serve_ends_when_a_frame_closes_the_connection_and_at_the_end_of_input() {
        let host = Mutex::new(Host::default());
        let mut input = io::Cursor::new(b"{\"hello\":\"mcp-00\"}\n{\"hello\":\"mcp-01\"}\n".to_vec());
        let mut output = Vec::new();
        serve(&host, &Instant, &mut input, &mut output, &|| 5).unwrap();
        let reply: Value = serde_json::from_slice(output.strip_suffix(b"\n").unwrap()).unwrap();
        assert_eq!(reply["error"], "unknown client", "one reply, then the connection closes");
        assert_eq!(host.lock().unwrap().audit.len(), 1);

        let mut empty = io::Cursor::new(Vec::new());
        serve(&host, &Instant, &mut empty, &mut output, &|| 6).unwrap();
        let mut long = io::Cursor::new(vec![b'x'; MAX_FRAME_BYTES + 2]);
        assert!(serve(&host, &Instant, &mut long, &mut Vec::new(), &|| 7).is_err(), "an over-long line ends it");
    }

    #[cfg(target_os = "macos")]
    mod macos {
        use super::*;
        use crate::ai::Preset;
        use crate::mcp::endpoint::unix::SOCKET_NAME;
        use crate::mcp::store::testing::{MemFile, TagSealer};
        use std::io::{BufReader, Read};
        use std::os::unix::net::UnixStream;
        use std::path::{Path, PathBuf};
        use std::sync::{mpsc, Arc, Condvar};
        use std::time::Instant as Clock;

        const WAIT: Duration = Duration::from_secs(10);

        /// A fresh endpoint directory, short enough for a socket path.
        fn dir(tag: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("bsm-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            dir
        }

        fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
            let start = Clock::now();
            while !done() {
                assert!(start.elapsed() < WAIT, "timed out waiting for {what}");
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        /// A client connection that fails a test instead of hanging it.
        fn connect(dir: &Path) -> (BufReader<UnixStream>, UnixStream) {
            let stream = UnixStream::connect(dir.join(SOCKET_NAME)).unwrap();
            stream.set_read_timeout(Some(WAIT)).unwrap();
            (BufReader::new(stream.try_clone().unwrap()), stream)
        }

        /// True once the app has closed this connection.
        fn closed_by_app(stream: &mut UnixStream) -> bool {
            let mut byte = [0u8; 1];
            matches!(stream.read(&mut byte), Ok(0))
        }

        fn send(writer: &mut UnixStream, line: &str) {
            writer.write_all(line.as_bytes()).unwrap();
            writer.write_all(b"\n").unwrap();
        }

        fn receive(reader: &mut BufReader<UnixStream>) -> Value {
            serde_json::from_slice(&read_frame(reader, MAX_FRAME_BYTES).unwrap().expect("a reply")).unwrap()
        }

        /// Pair through the runner; the owner approves under the host's lock.
        fn pair(runner: &Runner, dir: &Path) -> bitsov_mcp::ClientKey {
            let (mut reader, mut writer) = connect(dir);
            let host = runner.host().clone();
            let outcome = bitsov_mcp::pair(&mut reader, &mut writer, "Desk assistant", &[8u8; 32], |_| {}, || {
                let mut host = host.lock().unwrap();
                let now = now_ms();
                if let Some(shown) = host.pairing.waiting(now).first().cloned() {
                    host.commit(&MemFile::default(), Some(&TagSealer), |h| h.approve(&shown.id, &[Topic::Node], Preset::Counts, now)).unwrap();
                }
                true
            }).unwrap();
            let bitsov_mcp::PairOutcome::Approved(key) = outcome else { panic!("approved") };
            key
        }

        fn session(dir: &Path, key: &bitsov_mcp::ClientKey) -> (BufReader<UnixStream>, UnixStream) {
            let (mut reader, mut writer) = connect(dir);
            bitsov_mcp::open_session(&mut reader, &mut writer, key).unwrap();
            (reader, writer)
        }

        fn start(dir: &Path, source: Arc<dyn ReadSource + Send + Sync>, idle: Duration) -> Runner {
            Runner::start_with_idle(dir, Arc::new(Mutex::new(Host::default())), source, idle).unwrap()
        }

        #[test]
        fn a_client_pairs_opens_a_session_and_reads_through_the_runner() {
            let dir = dir("read");
            let mut runner = start(&dir, Arc::new(Instant), IDLE_TIMEOUT);
            let key = pair(&runner, &dir);
            let (mut reader, mut writer) = session(&dir, &key);
            send(&mut writer, r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#);
            assert_eq!(receive(&mut reader)["result"]["tools"].as_array().unwrap().len(), 1, "only the approved topic");
            send(&mut writer, r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_node"}}"#);
            assert_eq!(receive(&mut reader)["result"]["isError"], false);
            assert_eq!(runner.host().lock().unwrap().audit.len(), 1, "the call is audited");
            runner.stop();
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn the_ninth_connection_is_closed_at_once() {
            let dir = dir("cap");
            let mut runner = start(&dir, Arc::new(Instant), IDLE_TIMEOUT);
            let mut held: Vec<_> = (0..MAX_CONNECTIONS).map(|_| connect(&dir)).collect();
            wait_until("eight live connections", || runner.live() == MAX_CONNECTIONS);
            let (_, mut ninth) = connect(&dir);
            assert!(closed_by_app(&mut ninth), "the ninth is closed");
            assert_eq!(runner.live(), MAX_CONNECTIONS);

            // The eight are still served, and a freed place can be used again.
            let (reader, writer) = &mut held[0];
            send(writer, r#"{"hello":"mcp-00"}"#);
            assert_eq!(receive(reader)["error"], "unknown client");
            wait_until("a place to free up", || runner.live() == MAX_CONNECTIONS - 1);
            let (mut reader, mut writer) = connect(&dir);
            send(&mut writer, r#"{"hello":"mcp-01"}"#);
            assert_eq!(receive(&mut reader)["error"], "unknown client");
            runner.stop();
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn an_idle_connection_is_closed() {
            let dir = dir("idle");
            let mut runner = start(&dir, Arc::new(Instant), Duration::from_millis(200));
            let started = Clock::now();
            let (_, mut quiet) = connect(&dir);
            assert!(closed_by_app(&mut quiet), "the idle connection is closed");
            assert!(started.elapsed() >= Duration::from_millis(200));
            wait_until("no live connection", || runner.live() == 0);
            runner.stop();
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn stop_closes_live_sessions_and_removes_the_socket() {
            let dir = dir("stop");
            let mut runner = start(&dir, Arc::new(Instant), IDLE_TIMEOUT);
            let key = pair(&runner, &dir);
            let (mut reader, mut writer) = session(&dir, &key);
            send(&mut writer, r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#);
            assert_eq!(receive(&mut reader)["result"], json!({}));
            let (_, mut waiting) = connect(&dir);
            wait_until("two live connections", || runner.live() == 2);

            runner.stop();
            assert_eq!(read_frame(&mut reader, MAX_FRAME_BYTES).unwrap(), None, "the live session ends");
            assert!(closed_by_app(&mut waiting));
            assert_eq!(runner.live(), 0);
            assert!(!dir.join(SOCKET_NAME).exists(), "the socket file is removed");
            assert!(UnixStream::connect(dir.join(SOCKET_NAME)).is_err(), "nothing listens");
            runner.stop();
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// A read source that panics while reading.
        struct Panicking;
        impl Reads for Panicking {
            fn read(&self, _topic: Topic, _since_ms: Option<u64>) -> Result<Value, ReadFailed> {
                panic!("a read that panics");
            }
        }
        impl ReadSource for Panicking {
            fn reads_for(&self, _preset: Preset) -> Box<dyn Reads + '_> {
                Box::new(Panicking)
            }
        }

        /// A read source that panics before it can read at all.
        struct PanickingSource;
        impl ReadSource for PanickingSource {
            fn reads_for(&self, _preset: Preset) -> Box<dyn Reads + '_> {
                panic!("a source that panics");
            }
        }

        #[test]
        fn a_panicking_read_is_a_failed_read_audited_and_the_connection_stays_usable() {
            for (tag, source) in [("pr", Arc::new(Panicking) as Arc<dyn ReadSource + Send + Sync>), ("ps", Arc::new(PanickingSource))] {
                let dir = dir(tag);
                let mut runner = start(&dir, source, IDLE_TIMEOUT);
                let key = pair(&runner, &dir);
                let (mut reader, mut writer) = session(&dir, &key);
                send(&mut writer, r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_node"}}"#);
                assert_eq!(receive(&mut reader)["result"]["isError"], true, "{tag}: the client is told the read failed");
                let audit = runner.host().lock().unwrap().audit.clone();
                assert_eq!(audit.iter().map(|row| row.outcome).collect::<Vec<_>>(), [Outcome::ReadFailed], "{tag}: audited");
                send(&mut writer, r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#);
                assert_eq!(receive(&mut reader)["result"], json!({}), "{tag}: the connection is still served");
                drop((reader, writer));
                wait_until("the place to be freed", || runner.live() == 0);
                runner.stop();
                let _ = std::fs::remove_dir_all(&dir);
            }
        }

        #[test]
        fn a_poisoned_host_ends_the_connection_and_frees_its_place() {
            let dir = dir("pt");
            let mut runner = start(&dir, Arc::new(Instant), IDLE_TIMEOUT);
            let (_, mut client) = connect(&dir);
            wait_until("one live connection", || runner.live() == 1);
            // A panic elsewhere under the host lock poisons it; the connection
            // then fails closed on its next frame.
            let host = runner.host().clone();
            let _ = std::thread::spawn(move || {
                let _guard = host.lock().unwrap();
                panic!("poison the host");
            }).join();
            send(&mut client, r#"{"hello":"mcp-00"}"#);
            assert!(closed_by_app(&mut client), "the client sees the end");
            wait_until("the place to be freed", || runner.live() == 0);
            runner.stop();
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// Reads that wait until the test lets them go, and say when they start.
        struct Gate {
            entered: Mutex<mpsc::Sender<()>>,
            open: (Mutex<bool>, Condvar),
        }
        impl Reads for Gate {
            fn read(&self, _topic: Topic, _since_ms: Option<u64>) -> Result<Value, ReadFailed> {
                self.entered.lock().unwrap().send(()).unwrap();
                let (open, ready) = &self.open;
                // Bounded, so a failing test cannot leave the thread waiting for ever.
                let (guard, _) = ready.wait_timeout_while(open.lock().unwrap(), WAIT, |open| !*open).unwrap();
                drop(guard);
                Ok(json!({ "ok": true }))
            }
        }
        impl ReadSource for Gate {
            fn reads_for(&self, _preset: Preset) -> Box<dyn Reads + '_> {
                Box::new(GateRef(self))
            }
        }
        struct GateRef<'a>(&'a Gate);
        impl Reads for GateRef<'_> {
            fn read(&self, topic: Topic, since_ms: Option<u64>) -> Result<Value, ReadFailed> {
                self.0.read(topic, since_ms)
            }
        }

        #[test]
        fn a_slow_read_on_one_connection_does_not_hold_up_another() {
            let dir = dir("slow");
            let (entered_tx, entered) = mpsc::channel();
            let gate = Arc::new(Gate { entered: Mutex::new(entered_tx), open: (Mutex::new(false), Condvar::new()) });
            let mut runner = start(&dir, gate.clone(), IDLE_TIMEOUT);
            let key = pair(&runner, &dir);

            let (mut slow_reader, mut slow) = session(&dir, &key);
            send(&mut slow, r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_node"}}"#);
            entered.recv_timeout(WAIT).expect("the read started");

            // While that read waits, a second connection completes the whole
            // handshake and lists its tools: the host is not locked.
            let (mut reader, mut writer) = session(&dir, &key);
            send(&mut writer, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
            assert_eq!(receive(&mut reader)["result"]["tools"].as_array().unwrap().len(), 1);
            assert!(runner.host().try_lock().is_ok(), "the host is free during the read");

            let (open, ready) = &gate.open;
            *open.lock().unwrap() = true;
            ready.notify_all();
            assert_eq!(receive(&mut slow_reader)["result"]["isError"], false, "the slow read finishes");
            runner.stop();
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
