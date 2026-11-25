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
//! [`serve`] and [`serve_timed`] are the per-connection loops and are the
//! same on every platform. [`serve_timed`] adds the [`Deadlines`]: nothing
//! between frames for [`IDLE_TIMEOUT`], a frame not finished within
//! [`FRAME_DEADLINE`] of its first byte, or a connection not ready within
//! [`HANDSHAKE_DEADLINE`] of its accept (a pairing request: within
//! [`PAIRING_DEADLINE`]) closes the connection.
//!
//! On macOS and Windows, [`Runner`] owns the listener (the socket, or this
//! user's pipe): one thread accepts, one thread serves each connection with
//! the deadlines, and at most [`MAX_CONNECTIONS`] are live. At the cap the
//! oldest connection still in the handshake makes room, then the oldest
//! pairing request; a ready client never does, and when all are ready a new
//! connection is closed at once. [`Runner::stop`] closes
//! everything and removes the socket file (on Windows, releases the pipe name).

use std::io::{self, BufRead, BufReader, Read, Write};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

#[cfg(any(target_os = "macos", windows))]
use super::endpoint::MAX_CONNECTIONS;
use super::endpoint::{read_frame, Begin, Conn, Host, ReadSource, Step};
use super::pairing::REQUEST_TTL_MS;
use super::server::MAX_FRAME_BYTES;

/// A connection that sends nothing between frames for this long is closed.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Once the first byte of a frame arrives, the whole line must follow
/// within this, however slowly the bytes come.
pub const FRAME_DEADLINE: Duration = Duration::from_secs(10);
/// A connection that has not proved a client key this long after it was
/// accepted is closed.
pub const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(30);
/// A connection waiting for the owner's pairing decision may stay this long
/// after it was accepted (the pairing request's own lifetime). It must still
/// send its frames within [`FRAME_DEADLINE`] and [`IDLE_TIMEOUT`].
pub const PAIRING_DEADLINE: Duration = Duration::from_millis(REQUEST_TTL_MS);

/// The deadlines one connection lives by (see the constants).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Deadlines {
    pub idle: Duration,
    pub frame: Duration,
    pub handshake: Duration,
    pub pairing: Duration,
}

impl Default for Deadlines {
    fn default() -> Self {
        Self { idle: IDLE_TIMEOUT, frame: FRAME_DEADLINE, handshake: HANDSHAKE_DEADLINE, pairing: PAIRING_DEADLINE }
    }
}

impl Deadlines {
    fn any_zero(&self) -> bool {
        [self.idle, self.frame, self.handshake, self.pairing].iter().any(Duration::is_zero)
    }
}

/// Where a connection stands, for its deadline and for the connection cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Not yet proved a client key.
    Handshake,
    /// Waiting for the owner's pairing decision.
    Pairing,
    /// A client that proved its key.
    Ready,
    /// Sending its last reply, then closing: for a pairing approval that
    /// reply is the client's only copy of its secret, so a connection in this
    /// phase is never closed to make room.
    Closing,
}

impl Phase {
    fn of(conn: &Conn) -> Self {
        match conn {
            Conn::Ready { .. } => Self::Ready,
            Conn::Pairing { .. } => Self::Pairing,
            Conn::Start | Conn::Challenged { .. } => Self::Handshake,
            Conn::Closed => Self::Closing,
        }
    }
}

/// A stream whose read timeout can be set before each read.
pub trait ReadTimeout {
    fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()>;
}

#[cfg(unix)]
impl ReadTimeout for std::os::unix::net::UnixStream {
    fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        std::os::unix::net::UnixStream::set_read_timeout(self, timeout)
    }
}

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
        let step = handle_frame(host, source, &mut conn, &frame, now_ms())?;
        if !send(writer, &step)? {
            break;
        }
    }
    Ok(())
}

/// [`serve`] with deadlines (see [`Deadlines`]). The read timeout is set
/// before every read: between frames it is the idle timeout, once a frame has
/// begun it is what is left of the frame deadline, and before the client is
/// ready neither may run past the handshake (or pairing) deadline counted from
/// `accepted`. `phase` hears where the connection stands after every frame,
/// before the reply is written.
#[allow(clippy::too_many_arguments)]
pub fn serve_timed<S: Read + ReadTimeout>(
    host: &Mutex<Host>,
    source: &dyn ReadSource,
    reader: &mut BufReader<S>,
    writer: &mut impl Write,
    now_ms: &dyn Fn() -> u64,
    deadlines: Deadlines,
    accepted: Instant,
    phase: &dyn Fn(Phase),
) -> io::Result<()> {
    let mut conn = Conn::Start;
    loop {
        let until = match Phase::of(&conn) {
            Phase::Handshake | Phase::Closing => Some(accepted + deadlines.handshake),
            Phase::Pairing => Some(accepted + deadlines.pairing),
            Phase::Ready => None,
        };
        let Some(frame) = read_frame_by(reader, MAX_FRAME_BYTES, deadlines, until)? else { return Ok(()) };
        let step = handle_frame(host, source, &mut conn, &frame, now_ms())?;
        phase(Phase::of(&conn));
        if !send(writer, &step)? {
            return Ok(());
        }
    }
}

/// One frame through the host: locked for the start and the end, not for the read.
fn handle_frame(host: &Mutex<Host>, source: &dyn ReadSource, conn: &mut Conn, frame: &[u8], now_ms: u64) -> io::Result<Step> {
    let begun = {
        let mut host = lock(host)?;
        host.begin_frame(conn, frame, now_ms)
    };
    Ok(match begun {
        Begin::Done(step) => step,
        Begin::Read(pending) => {
            let read = pending.read(source);
            let mut host = lock(host)?;
            host.finish_frame(conn, pending, read)
        }
    })
}

/// Write the step's reply. False when the connection is to close.
fn send(writer: &mut impl Write, step: &Step) -> io::Result<bool> {
    if let Some(reply) = &step.reply {
        writer.write_all(reply)?;
        writer.flush()?;
    }
    Ok(!step.close)
}

/// [`read_frame`] with deadlines: the first byte must come within the idle
/// timeout, the rest of the line within the frame deadline from that byte,
/// and neither past `until`. A passed deadline is an error (the connection
/// closes). At the end of the stream a partial line is a frame, as in
/// [`read_frame`].
fn read_frame_by<S: Read + ReadTimeout>(
    reader: &mut BufReader<S>,
    max: usize,
    deadlines: Deadlines,
    until: Option<Instant>,
) -> io::Result<Option<Vec<u8>>> {
    let cap = |at: Instant| until.map_or(at, |until| at.min(until));
    let mut by = cap(Instant::now() + deadlines.idle);
    let mut frame: Option<Vec<u8>> = None;
    loop {
        let left = by.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "deadline passed"));
        }
        reader.get_ref().set_read_timeout(Some(left))?;
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if available.is_empty() {
            return Ok(frame);
        }
        if frame.is_none() {
            by = cap(Instant::now() + deadlines.frame);
        }
        let (take, ends) = match available.iter().position(|&byte| byte == b'\n') {
            Some(at) => (at, true),
            None => (available.len(), false),
        };
        let buf = frame.get_or_insert_with(Vec::new);
        buf.extend_from_slice(&available[..take]);
        reader.consume(if ends { take + 1 } else { take });
        if buf.len() > max {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
        }
        if ends {
            return Ok(frame);
        }
    }
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

#[cfg(any(target_os = "macos", windows))]
pub use platform::Runner;

#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;

/// What the macOS and Windows runners share: the live connections, the cap
/// and who makes room at it, each connection's place, and closing them all.
/// Each platform supplies only how a connection is accepted, served and closed.
#[cfg(any(target_os = "macos", windows))]
mod live {
    use std::collections::HashMap;
    use std::io;
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;

    use super::super::endpoint::{Host, ReadSource};
    use super::{Deadlines, Phase, MAX_CONNECTIONS};

    pub(super) struct Shared {
        pub(super) host: Arc<Mutex<Host>>,
        pub(super) source: Arc<dyn ReadSource + Send + Sync>,
        pub(super) deadlines: Deadlines,
        pub(super) stopping: AtomicBool,
        live: Mutex<Live>,
        spawn: Spawn,
    }

    /// Ends one live connection from another thread; the client sees the end.
    pub(super) type Close = Box<dyn Fn() + Send>;

    /// The live connections (a way to close each, on stop or to make room)
    /// and their threads. Its own lock, never the host's.
    #[derive(Default)]
    struct Live {
        next: u64,
        conns: HashMap<u64, LiveConn>,
        workers: Vec<JoinHandle<()>>,
    }

    struct LiveConn {
        close: Close,
        /// The connection's [`Phase`], as its thread last reported it.
        phase: Arc<AtomicU8>,
    }

    const HANDSHAKE: u8 = 0;
    const PAIRING: u8 = 1;
    const READY: u8 = 2;
    const CLOSING: u8 = 3;

    fn phase_code(phase: Phase) -> u8 {
        match phase {
            Phase::Handshake => HANDSHAKE,
            Phase::Pairing => PAIRING,
            Phase::Ready => READY,
            Phase::Closing => CLOSING,
        }
    }

    impl Live {
        /// The connection to close to make room: the oldest one still in the
        /// handshake, else the oldest one waiting for a pairing decision. A
        /// ready client, or one sending its last reply (a pairing secret,
        /// perhaps), is never closed to make room. `except` is never chosen.
        fn to_make_room(&self, except: u64) -> Option<u64> {
            [HANDSHAKE, PAIRING].into_iter().find_map(|wanted| {
                self.conns.iter()
                    .filter(|(key, conn)| **key != except && conn.phase.load(Ordering::SeqCst) == wanted)
                    .map(|(key, _)| *key)
                    .min()
            })
        }
    }

    impl Shared {
        pub(super) fn new(host: Arc<Mutex<Host>>, source: Arc<dyn ReadSource + Send + Sync>, deadlines: Deadlines, spawn: Spawn) -> Self {
            Self { host, source, deadlines, stopping: AtomicBool::new(false), live: Mutex::default(), spawn }
        }

        /// How many connections are live now.
        pub(super) fn live(&self) -> usize {
            self.live.lock().map_or(0, |live| live.conns.len())
        }

        /// Whether a live connection may make room for one more (see
        /// [`Live::to_make_room`]). Nothing is closed here: [`admit`] closes
        /// it once the new connection has started.
        #[cfg_attr(not(windows), allow(dead_code))]
        pub(super) fn could_make_room(&self) -> bool {
            self.live.lock().is_ok_and(|live| live.to_make_room(u64::MAX).is_some())
        }

        /// Close every live connection and wait for every connection thread.
        /// Called once the accept thread has ended, so none can be added.
        pub(super) fn close_all_and_join(&self) {
            let workers = match self.live.lock() {
                Ok(mut live) => {
                    for conn in live.conns.values() {
                        (conn.close)();
                    }
                    std::mem::take(&mut live.workers)
                }
                Err(_) => Vec::new(),
            };
            for worker in workers {
                let _ = worker.join();
            }
        }
    }

    /// Start serving a new connection on its own thread. When
    /// [`MAX_CONNECTIONS`] are already live, the connection that makes room
    /// is closed (see [`Live::to_make_room`]); if none may, the new one is
    /// closed at once. Nothing is closed to make room until the new
    /// connection is set up and its thread has started: if that fails, every
    /// connection that was live stays live.
    ///
    /// `serve` runs on the connection's thread and hears its phase. What it
    /// returns (the connection's own handles) is dropped only after the place
    /// is freed, so the count here never trails a platform count of open
    /// connections.
    pub(super) fn admit<T: 'static>(
        shared: &Arc<Shared>,
        close: Close,
        serve: impl FnOnce(&Shared, &dyn Fn(Phase)) -> T + Send + 'static,
    ) {
        let Ok(mut live) = shared.live.lock() else {
            close();
            return;
        };
        live.workers.retain(|worker| !worker.is_finished());
        let key = live.next;
        if live.conns.len() >= MAX_CONNECTIONS && live.to_make_room(key).is_none() {
            close();
            return;
        }
        live.next += 1;
        let phase = Arc::new(AtomicU8::new(HANDSHAKE));
        live.conns.insert(key, LiveConn { close, phase: phase.clone() });
        let place = Place { shared: shared.clone(), key };
        // The thread is spawned with the lock released: if the spawn fails,
        // the place is dropped here and its drop takes this same lock.
        drop(live);
        let spawned = (shared.spawn)(Box::new(move || {
            let report = |now: Phase| phase.store(phase_code(now), Ordering::SeqCst);
            let kept = serve(&place.shared, &report);
            drop(place);
            drop(kept);
        }));
        // A failed spawn has already freed the new place; nothing was closed.
        let Ok(worker) = spawned else { return };
        // Only the accept thread admits, and stop() joins it before it takes
        // the workers, so no worker can be missed here.
        let Ok(mut live) = shared.live.lock() else { return };
        live.workers.push(worker);
        if live.conns.len() > MAX_CONNECTIONS {
            // Chosen again now: a phase may have moved on while the lock was
            // released. If nothing may make room any more, the new one goes.
            let closing = live.to_make_room(key).unwrap_or(key);
            // Its thread ends on the closed connection; its place is free at once.
            if let Some(closed) = live.conns.remove(&closing) {
                (closed.close)();
            }
        }
    }

    /// How a connection thread is started (a test makes it fail).
    pub(super) type Spawn = fn(Box<dyn FnOnce() + Send>) -> io::Result<JoinHandle<()>>;

    pub(super) fn spawn_thread(work: Box<dyn FnOnce() + Send>) -> io::Result<JoinHandle<()>> {
        std::thread::Builder::new().name("mcp-conn".into()).spawn(work)
    }

    /// One live connection's place. Dropping it, on every way out of the
    /// connection's thread (a panic included), frees the place and closes the
    /// connection, so the client sees the end at once.
    struct Place {
        shared: Arc<Shared>,
        key: u64,
    }

    impl Drop for Place {
        fn drop(&mut self) {
            let mut live = self.shared.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(conn) = live.conns.remove(&self.key) {
                (conn.close)();
            }
        }
    }

    #[cfg(all(test, target_os = "macos"))]
    #[test]
    fn a_place_is_freed_and_its_socket_shut_down_when_its_thread_panics() {
        use std::io::Read;
        use std::net::Shutdown;
        use std::os::unix::net::UnixStream;
        use std::time::Duration;
        struct Unused;
        impl ReadSource for Unused {
            fn reads_for(&self, _preset: crate::mcp::store::R2Preset) -> Box<dyn crate::mcp::server::Reads + '_> {
                unreachable!("no read in this test")
            }
        }
        let (client, served) = UnixStream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let shared = Arc::new(Shared::new(Arc::new(Mutex::new(Host::default())), Arc::new(Unused), Deadlines::default(), spawn_thread));
        let close: Close = Box::new(move || {
            let _ = served.shutdown(Shutdown::Both);
        });
        shared.live.lock().unwrap().conns.insert(7, LiveConn { close, phase: Arc::new(AtomicU8::new(HANDSHAKE)) });
        let place = Place { shared: shared.clone(), key: 7 };
        let ended = std::thread::spawn(move || {
            let _place = place;
            panic!("a connection thread that panics");
        }).join();
        assert!(ended.is_err());
        assert!(shared.live.lock().unwrap().conns.is_empty(), "the place is free");
        assert_eq!((&client).read(&mut [0u8; 1]).unwrap(), 0, "the client sees the end");
    }

    #[cfg(test)]
    #[test]
    fn room_is_made_by_the_oldest_handshake_then_pairing_never_ready_or_closing() {
        let mut live = Live::default();
        for (key, code) in [(1, READY), (2, CLOSING), (3, PAIRING), (4, HANDSHAKE), (5, PAIRING), (6, HANDSHAKE)] {
            live.conns.insert(key, LiveConn { close: Box::new(|| {}), phase: Arc::new(AtomicU8::new(code)) });
        }
        assert_eq!(live.to_make_room(99), Some(4), "the oldest handshake first");
        assert_eq!(live.to_make_room(4), Some(6), "never the one excepted");
        live.conns.retain(|_, conn| conn.phase.load(Ordering::SeqCst) != HANDSHAKE);
        assert_eq!(live.to_make_room(99), Some(3), "then the oldest pairing request");
        live.conns.retain(|_, conn| conn.phase.load(Ordering::SeqCst) != PAIRING);
        assert_eq!(live.to_make_room(99), None, "a ready or closing connection never makes room");
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::io::{self, BufReader};
    use std::net::Shutdown;
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    use super::super::endpoint::{unix, Host, ReadSource};
    use super::live::{self, Shared, Spawn};
    use super::{now_ms, serve_timed, Deadlines, Phase};

    /// The macOS listener: the owner-only socket in `dir` and its threads.
    /// Dropping it is [`Runner::stop`].
    pub struct Runner {
        shared: Arc<Shared>,
        socket: PathBuf,
        accept: Option<JoinHandle<()>>,
    }

    impl Runner {
        /// Bind in `dir` ([`unix::bind`]) and start accepting, with the
        /// default [`Deadlines`].
        pub fn start(dir: &Path, host: Arc<Mutex<Host>>, source: Arc<dyn ReadSource + Send + Sync>) -> io::Result<Self> {
            Self::start_with(dir, host, source, Deadlines::default())
        }

        /// [`Runner::start`] with another idle timeout (tests).
        pub fn start_with_idle(
            dir: &Path,
            host: Arc<Mutex<Host>>,
            source: Arc<dyn ReadSource + Send + Sync>,
            idle: Duration,
        ) -> io::Result<Self> {
            Self::start_with(dir, host, source, Deadlines { idle, ..Deadlines::default() })
        }

        /// [`Runner::start`] with other deadlines (tests). None may be zero.
        pub fn start_with(
            dir: &Path,
            host: Arc<Mutex<Host>>,
            source: Arc<dyn ReadSource + Send + Sync>,
            deadlines: Deadlines,
        ) -> io::Result<Self> {
            Self::start_spawning(dir, host, source, deadlines, live::spawn_thread)
        }

        fn start_spawning(
            dir: &Path,
            host: Arc<Mutex<Host>>,
            source: Arc<dyn ReadSource + Send + Sync>,
            deadlines: Deadlines,
            spawn: Spawn,
        ) -> io::Result<Self> {
            if deadlines.any_zero() {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "a deadline must not be zero"));
            }
            let listener = unix::bind(dir)?;
            let socket = dir.join(unix::SOCKET_NAME);
            let shared = Arc::new(Shared::new(host, source, deadlines, spawn));
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
            self.shared.live()
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
            self.shared.close_all_and_join();
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

    /// Serve a new connection (see [`live::admit`] for the cap).
    fn admit(shared: &Arc<Shared>, stream: UnixStream) {
        let accepted = Instant::now();
        if stream.set_write_timeout(Some(shared.deadlines.idle)).is_err() {
            return;
        }
        let Ok(handle) = stream.try_clone() else { return };
        let close = Box::new(move || {
            let _ = handle.shutdown(Shutdown::Both);
        });
        live::admit(shared, close, move |shared, report| run_connection(shared, stream, accepted, report));
    }

    #[cfg(test)]
    #[test]
    fn a_failed_thread_spawn_frees_the_place_and_neither_accept_nor_stop_hangs() {
        use std::io::Read;
        fn no_threads(_work: Box<dyn FnOnce() + Send>) -> io::Result<JoinHandle<()>> {
            Err(io::Error::other("no thread for this test"))
        }
        struct Unused;
        impl ReadSource for Unused {
            fn reads_for(&self, _preset: crate::mcp::store::R2Preset) -> Box<dyn crate::mcp::server::Reads + '_> {
                unreachable!("no read in this test")
            }
        }
        let dir = std::env::temp_dir().join(format!("bsm-{}-sf", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let runner = Runner::start_spawning(&dir, Arc::new(Mutex::new(Host::default())), Arc::new(Unused), Deadlines::default(), no_threads).unwrap();
        // On a thread with a deadline, so a deadlock fails the test instead of hanging it.
        let (done, finished) = std::sync::mpsc::channel();
        let socket = dir.join(unix::SOCKET_NAME);
        std::thread::spawn(move || {
            let mut runner = runner;
            // Two in a row: the accept thread is still accepting after the first.
            let ends: Vec<bool> = (0..2).map(|_| {
                let client = UnixStream::connect(&socket).unwrap();
                client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                matches!((&client).read(&mut [0u8; 1]), Ok(0))
            }).collect();
            let live = runner.live();
            runner.stop();
            let _ = done.send((ends, live));
        });
        let (ends, live) = finished.recv_timeout(Duration::from_secs(20)).expect("accept and stop() return");
        assert_eq!(ends, [true, true], "each client sees the end");
        assert_eq!(live, 0, "the place is free");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(test)]
    #[test]
    fn when_a_new_connection_cannot_start_no_live_connection_is_closed() {
        use std::io::Read;
        use super::MAX_CONNECTIONS;
        use std::sync::atomic::AtomicUsize;
        static STARTED: AtomicUsize = AtomicUsize::new(0);
        fn eight_then_none(work: Box<dyn FnOnce() + Send>) -> io::Result<JoinHandle<()>> {
            if STARTED.fetch_add(1, Ordering::SeqCst) < MAX_CONNECTIONS {
                live::spawn_thread(work)
            } else {
                Err(io::Error::other("no more threads for this test"))
            }
        }
        struct Unused;
        impl ReadSource for Unused {
            fn reads_for(&self, _preset: crate::mcp::store::R2Preset) -> Box<dyn crate::mcp::server::Reads + '_> {
                unreachable!("no read in this test")
            }
        }
        let dir = std::env::temp_dir().join(format!("bsm-{}-nf", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut runner = Runner::start_spawning(&dir, Arc::new(Mutex::new(Host::default())), Arc::new(Unused), Deadlines::default(), eight_then_none).unwrap();
        let socket = dir.join(unix::SOCKET_NAME);
        let held: Vec<UnixStream> = (0..MAX_CONNECTIONS).map(|_| UnixStream::connect(&socket).unwrap()).collect();
        let started = Instant::now();
        while runner.live() < MAX_CONNECTIONS {
            assert!(started.elapsed() < Duration::from_secs(10), "eight live connections");
            std::thread::sleep(Duration::from_millis(10));
        }
        // Eight stalled handshakes could make room, but the ninth cannot start: it goes, they stay.
        let ninth = UnixStream::connect(&socket).unwrap();
        ninth.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        assert_eq!((&ninth).read(&mut [0u8; 1]).unwrap(), 0, "the ninth sees the end");
        assert_eq!(runner.live(), MAX_CONNECTIONS, "no live connection was closed for it");
        for stream in &held {
            stream.set_nonblocking(true).unwrap();
            let still_open = matches!((&*stream).read(&mut [0u8; 1]), Err(error) if error.kind() == io::ErrorKind::WouldBlock);
            assert!(still_open, "a live connection was closed");
        }
        runner.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn run_connection(shared: &Shared, stream: UnixStream, accepted: Instant, report: &dyn Fn(Phase)) {
        let Ok(read_half) = stream.try_clone() else { return };
        let mut reader = BufReader::new(read_half);
        let mut writer = stream;
        let _ = serve_timed(&shared.host, shared.source.as_ref(), &mut reader, &mut writer, &now_ms, shared.deadlines, accepted, report);
        let _ = writer.shutdown(Shutdown::Both);
    }
}

#[cfg(windows)]
impl ReadTimeout for bitsov_ffi::win_private::pipe::PipeHalf {
    fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        bitsov_ffi::win_private::pipe::PipeHalf::set_read_timeout(self, timeout)
    }
}

#[cfg(windows)]
mod windows {
    use std::io::{self, BufReader};
    use std::sync::atomic::Ordering;
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    use bitsov_ffi::win_private::pipe::{PipeConnection, PipeListener, PipeStopper};

    use super::super::endpoint::{Host, ReadSource};
    use super::live::{self, Shared, Spawn};
    use super::{now_ms, serve_timed, Deadlines};

    /// The Windows listener: this user's pipe (`bitsov_ffi`) and its threads.
    /// The same deadlines, cap and make-room rule as on macOS. At the cap the
    /// pipe asks the runner whether a connection may make room before it
    /// refuses a client; if so, the client comes in as one over, and once its
    /// thread has started the runner closes the connection that makes room
    /// (or the new one). A closed connection gives its pipe slot back at
    /// once, so the runner's count and the pipe's agree. Dropping it is
    /// [`Runner::stop`].
    pub struct Runner {
        shared: Arc<Shared>,
        stopper: PipeStopper,
        accept: Option<JoinHandle<()>>,
    }

    impl Runner {
        /// Serve this user's pipe, `\\.\pipe\bitsov-mcp-<SID>`, with the
        /// default [`Deadlines`].
        pub fn start(host: Arc<Mutex<Host>>, source: Arc<dyn ReadSource + Send + Sync>) -> io::Result<Self> {
            Self::start_spawning(None, host, source, Deadlines::default(), live::spawn_thread)
        }

        /// Serve another pipe of the app's family
        /// ([`PipeListener::bind_at`]) with other deadlines (tests). None may
        /// be zero.
        pub fn start_named(
            name: &str,
            host: Arc<Mutex<Host>>,
            source: Arc<dyn ReadSource + Send + Sync>,
            deadlines: Deadlines,
        ) -> io::Result<Self> {
            Self::start_spawning(Some(name.to_owned()), host, source, deadlines, live::spawn_thread)
        }

        fn start_spawning(
            name: Option<String>,
            host: Arc<Mutex<Host>>,
            source: Arc<dyn ReadSource + Send + Sync>,
            deadlines: Deadlines,
            spawn: Spawn,
        ) -> io::Result<Self> {
            if deadlines.any_zero() {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "a deadline must not be zero"));
            }
            let shared = Arc::new(Shared::new(host, source, deadlines, spawn));
            let accepting = shared.clone();
            // The listener is not `Send`: it is bound on the accept thread, and
            // only its stopper comes back.
            let (bound_tx, bound_rx) = mpsc::channel();
            let accept = std::thread::Builder::new().name("mcp-accept".into()).spawn(move || {
                let bound = match &name {
                    Some(name) => PipeListener::bind_at(name),
                    None => PipeListener::bind(),
                };
                let mut listener = match bound {
                    Ok(listener) => listener,
                    Err(error) => {
                        let _ = bound_tx.send(Err(error));
                        return;
                    }
                };
                let _ = bound_tx.send(Ok(listener.stopper()));
                accept_loop(&accepting, &mut listener);
            })?;
            let stopper = match bound_rx.recv() {
                Ok(Ok(stopper)) => stopper,
                Ok(Err(error)) => {
                    let _ = accept.join();
                    return Err(error);
                }
                Err(_) => {
                    let _ = accept.join();
                    return Err(io::Error::other("the accept thread ended before binding"));
                }
            };
            Ok(Self { shared, stopper, accept: Some(accept) })
        }

        /// The host every connection shares.
        pub fn host(&self) -> &Arc<Mutex<Host>> {
            &self.shared.host
        }

        /// How many connections are live now.
        pub fn live(&self) -> usize {
            self.shared.live()
        }

        /// Stop accepting, close every live connection and release the pipe
        /// name. Returns once every connection thread has ended. A second call
        /// does nothing.
        pub fn stop(&mut self) {
            let Some(accept) = self.accept.take() else { return };
            self.shared.stopping.store(true, Ordering::SeqCst);
            // Cancels the waiting accept and closes every live connection.
            self.stopper.stop();
            let _ = accept.join();
            self.shared.close_all_and_join();
        }
    }

    impl Drop for Runner {
        fn drop(&mut self) {
            self.stop();
        }
    }

    fn accept_loop(shared: &Arc<Shared>, listener: &mut PipeListener) {
        loop {
            let accepted = listener.accept_one_making_room(&mut || shared.could_make_room());
            if shared.stopping.load(Ordering::SeqCst) {
                return;
            }
            match accepted {
                Ok(Some(connection)) => admit(shared, connection),
                // A client refused by the pipe (another user, elevated, gone,
                // or every place taken by a ready client).
                Ok(None) => {}
                // Out of handles and the like: wait a little, keep serving.
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }

    /// Serve a new connection (see [`live::admit`] for the cap).
    fn admit(shared: &Arc<Shared>, connection: PipeConnection) {
        let accepted = Instant::now();
        let Ok((reader, writer)) = connection.split() else { return };
        if writer.set_write_timeout(Some(shared.deadlines.idle)).is_err() {
            return;
        }
        let closer = writer.closer();
        let close = Box::new(move || closer.close());
        live::admit(shared, close, move |shared, report| {
            let mut reader = BufReader::new(reader);
            let mut writer = writer;
            let _ = serve_timed(&shared.host, shared.source.as_ref(), &mut reader, &mut writer, &now_ms, shared.deadlines, accepted, report);
            // Kept open until the place is freed (which closes the pipe).
            (reader, writer)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::Topic;
    use crate::mcp::server::{ReadFailed, Reads};
    #[cfg(target_os = "macos")]
    use crate::mcp::session::Outcome;
    use serde_json::{json, Value};

    struct Instant;
    impl Reads for Instant {
        fn read(&self, _topic: Topic, _since_ms: Option<u64>) -> Result<Value, ReadFailed> {
            Ok(json!({ "ok": true }))
        }
    }
    impl ReadSource for Instant {
        fn reads_for(&self, _preset: crate::mcp::store::R2Preset) -> Box<dyn Reads + '_> {
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
            runner.host().lock().unwrap().open_pairing(now_ms());
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

        fn start_with(dir: &Path, deadlines: Deadlines) -> Runner {
            Runner::start_with(dir, Arc::new(Mutex::new(Host::default())), Arc::new(Instant), deadlines).unwrap()
        }

        fn short(idle_ms: u64, frame_ms: u64, handshake_ms: u64) -> Deadlines {
            let ms = Duration::from_millis;
            Deadlines { idle: ms(idle_ms), frame: ms(frame_ms), handshake: ms(handshake_ms), pairing: Duration::from_secs(5) }
        }

        fn ask_pairing(runner: &Runner, dir: &Path) -> (BufReader<UnixStream>, UnixStream) {
            runner.host().lock().unwrap().open_pairing(now_ms());
            let (mut reader, mut writer) = connect(dir);
            send(&mut writer, &json!({"pair": {"name": "Notes", "nonce": hex::encode([5u8; 32])}}).to_string());
            assert!(receive(&mut reader)["pair"]["id"].is_string());
            (reader, writer)
        }

        fn lists_tools(reader: &mut BufReader<UnixStream>, writer: &mut UnixStream) -> bool {
            send(writer, r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#);
            receive(reader)["result"]["tools"].is_array()
        }

        #[test]
        fn at_the_cap_stalled_handshakes_make_room_first_and_a_ready_client_never_does() {
            let dir = dir("cap");
            let mut runner = start(&dir, Arc::new(Instant), IDLE_TIMEOUT);
            let key = pair(&runner, &dir);
            let (mut waiting_r, mut waiting_w) = ask_pairing(&runner, &dir);
            let (mut ready_r, mut ready_w) = session(&dir, &key);
            let mut stalled: Vec<_> = (0..MAX_CONNECTIONS - 2).map(|_| connect(&dir)).collect();
            wait_until("eight live connections", || runner.live() == MAX_CONNECTIONS);

            // A ninth: the oldest stalled handshake is closed to make room, and the ninth is served.
            let (mut ninth_r, mut ninth_w) = connect(&dir);
            assert!(closed_by_app(&mut stalled[0].1), "the oldest handshake made room");
            assert!(lists_tools(&mut ready_r, &mut ready_w), "the ready client keeps working");
            send(&mut waiting_w, r#"{"pair_status":true}"#);
            assert_eq!(receive(&mut waiting_r)["pair"], "waiting", "the pairing request is kept while handshakes can go");
            send(&mut ninth_w, r#"{"hello":"mcp-00"}"#);
            assert_eq!(receive(&mut ninth_r)["error"], "unknown client", "the ninth was served");

            // Only ready clients and the pairing request left: the pairing request makes room.
            drop(stalled);
            wait_until("two live connections", || runner.live() == 2);
            let mut sessions: Vec<_> = (0..MAX_CONNECTIONS - 2).map(|_| session(&dir, &key)).collect();
            assert_eq!(runner.live(), MAX_CONNECTIONS);
            let mut last = session(&dir, &key);
            assert_eq!(read_frame(&mut waiting_r, MAX_FRAME_BYTES).unwrap(), None, "the pairing request made room");
            assert!(lists_tools(&mut last.0, &mut last.1));

            // Eight ready clients: a new connection is closed at once, and all eight keep working.
            let (_, mut refused) = connect(&dir);
            assert!(closed_by_app(&mut refused), "no ready client is closed to make room");
            assert_eq!(runner.live(), MAX_CONNECTIONS);
            assert!(lists_tools(&mut ready_r, &mut ready_w));
            for (reader, writer) in &mut sessions {
                assert!(lists_tools(reader, writer));
            }
            runner.stop();
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn a_frame_trickled_a_byte_at_a_time_is_closed_at_the_frame_deadline() {
            let dir = dir("loris");
            let mut runner = start_with(&dir, short(5_000, 300, 5_000));
            let (_, mut writer) = connect(&dir);
            let mut watch = writer.try_clone().unwrap();
            let started = Clock::now();
            // A byte every 50 ms and never a newline: each read is well inside the idle timeout.
            let trickle = std::thread::spawn(move || {
                for _ in 0..100 {
                    if writer.write_all(b"x").is_err() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            });
            assert!(closed_by_app(&mut watch), "the trickling connection is closed");
            let took = started.elapsed();
            assert!(took >= Duration::from_millis(300) && took < Duration::from_secs(3), "{took:?}");
            trickle.join().unwrap();
            wait_until("no live connection", || runner.live() == 0);
            runner.stop();
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn a_connection_that_never_finishes_the_handshake_is_closed_but_a_pairing_request_may_wait() {
            let dir = dir("hs");
            let mut runner = start_with(&dir, short(5_000, 5_000, 300));
            let key = pair(&runner, &dir);

            // Silent from the start, and challenged but never signing: both closed at the handshake deadline.
            let started = Clock::now();
            let (_, mut silent) = connect(&dir);
            let (mut reader, mut writer) = connect(&dir);
            send(&mut writer, &json!({"hello": key.id}).to_string());
            assert!(receive(&mut reader)["challenge"].is_string());
            assert!(closed_by_app(&mut silent));
            assert_eq!(read_frame(&mut reader, MAX_FRAME_BYTES).unwrap(), None);
            assert!(started.elapsed() < Duration::from_secs(3), "well before the idle timeout");

            // A pairing request that keeps asking is not held to the handshake deadline.
            let (mut waiting_r, mut waiting_w) = ask_pairing(&runner, &dir);
            for _ in 0..6 {
                std::thread::sleep(Duration::from_millis(100));
                send(&mut waiting_w, r#"{"pair_status":true}"#);
                assert_eq!(receive(&mut waiting_r)["pair"], "waiting");
            }
            runner.stop();
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn a_ready_client_outlives_the_handshake_deadline_and_a_slow_whole_frame_is_served() {
            let dir = dir("rdy");
            let mut runner = start_with(&dir, short(5_000, 1_000, 300));
            let key = pair(&runner, &dir);
            let (mut reader, mut writer) = session(&dir, &key);
            std::thread::sleep(Duration::from_millis(600));
            assert!(lists_tools(&mut reader, &mut writer), "past the handshake deadline");
            // One frame in two parts, 200 ms apart: inside the frame deadline.
            writer.write_all(br#"{"jsonrpc":"2.0","id":8,"#).unwrap();
            std::thread::sleep(Duration::from_millis(200));
            writer.write_all(b"\"method\":\"ping\"}\n").unwrap();
            assert_eq!(receive(&mut reader)["result"], json!({}));
            runner.stop();
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn an_idle_ready_client_is_closed() {
            let dir = dir("idle");
            let mut runner = start_with(&dir, short(300, 5_000, 5_000));
            let key = pair(&runner, &dir);
            let (mut reader, mut writer) = session(&dir, &key);
            assert!(lists_tools(&mut reader, &mut writer));
            let started = Clock::now();
            assert_eq!(read_frame(&mut reader, MAX_FRAME_BYTES).unwrap(), None, "the idle session is closed");
            assert!(started.elapsed() >= Duration::from_millis(250));
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

        /// Writes, noted in one log with the phases.
        struct Noting {
            inner: UnixStream,
            log: Arc<Mutex<Vec<String>>>,
        }
        impl Write for Noting {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                let what = if bytes.windows(8).any(|w| w == b"\"secret\"") { "write secret" } else { "write" };
                self.log.lock().unwrap().push(what.to_owned());
                self.inner.write(bytes)
            }
            fn flush(&mut self) -> io::Result<()> {
                self.inner.flush()
            }
        }

        #[test]
        fn a_connection_handing_over_a_pairing_secret_is_closing_before_the_write() {
            let host = Arc::new(Mutex::new(Host::default()));
            host.lock().unwrap().open_pairing(now_ms());
            let (client, served) = UnixStream::pair().unwrap();
            client.set_read_timeout(Some(WAIT)).unwrap();
            let log = Arc::new(Mutex::new(Vec::new()));
            let server = {
                let (host, log) = (host.clone(), log.clone());
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(served.try_clone().unwrap());
                    let mut writer = Noting { inner: served, log: log.clone() };
                    let report = move |phase: Phase| log.lock().unwrap().push(format!("{phase:?}"));
                    serve_timed(&host, &Instant, &mut reader, &mut writer, &now_ms, Deadlines::default(), Clock::now(), &report)
                })
            };
            let mut reader = BufReader::new(client.try_clone().unwrap());
            let mut writer = client;
            send(&mut writer, &json!({"pair": {"name": "Desk", "nonce": hex::encode([6u8; 32])}}).to_string());
            let id = receive(&mut reader)["pair"]["id"].as_str().unwrap().to_owned();
            host.lock().unwrap().commit(&MemFile::default(), Some(&TagSealer), |h| h.approve(&id, &[Topic::Node], Preset::Counts, now_ms())).unwrap();
            send(&mut writer, r#"{"pair_status":true}"#);
            assert_eq!(receive(&mut reader)["pair"], "approved");
            server.join().unwrap().unwrap();
            let log = log.lock().unwrap().clone();
            let secret = log.iter().position(|entry| entry == "write secret").expect("the secret was written");
            assert_eq!(log[secret - 1], "Closing", "never closed to make room while it hands over: {log:?}");
            assert_eq!(log[..secret - 1], ["Pairing", "write"], "{log:?}");
        }

        /// A read source that panics while reading.
        struct Panicking;
        impl Reads for Panicking {
            fn read(&self, _topic: Topic, _since_ms: Option<u64>) -> Result<Value, ReadFailed> {
                panic!("a read that panics");
            }
        }
        impl ReadSource for Panicking {
            fn reads_for(&self, _preset: crate::mcp::store::R2Preset) -> Box<dyn Reads + '_> {
                Box::new(Panicking)
            }
        }

        /// A read source that panics before it can read at all.
        struct PanickingSource;
        impl ReadSource for PanickingSource {
            fn reads_for(&self, _preset: crate::mcp::store::R2Preset) -> Box<dyn Reads + '_> {
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
            fn reads_for(&self, _preset: crate::mcp::store::R2Preset) -> Box<dyn Reads + '_> {
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

    /// The Windows runner over a real pipe, with the shim's own pipe client.
    #[cfg(windows)]
    mod windows_runner_tests {
        use super::*;
        use crate::ai::Preset;
        use crate::mcp::endpoint::MAX_CONNECTIONS;
        use crate::mcp::store::testing::{MemFile, TagSealer};
        use bitsov_ffi::win_private::pipe::PipeHalf;
        use std::io::{BufReader, Read};
        use std::sync::Arc;
        use std::time::Instant as Clock;

        const WAIT: Duration = Duration::from_secs(10);
        /// `ERROR_PIPE_BUSY`: every instance is taken for a moment.
        const PIPE_BUSY: i32 = 231;

        type Client = (BufReader<PipeHalf>, PipeHalf);

        /// A fresh pipe name in the app's family, per test.
        fn pipe(tag: &str) -> String {
            format!(r"\\.\pipe\bitsov-mcp-rt-{}-{tag}", std::process::id())
        }

        fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
            let start = Clock::now();
            while !done() {
                assert!(start.elapsed() < WAIT, "timed out waiting for {what}");
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        /// Connect as the shim does, waiting while the pipe is busy. A read
        /// timeout makes a hang fail the test instead.
        fn try_connect(name: &str) -> io::Result<Client> {
            let start = Clock::now();
            loop {
                match bitsov_mcp::windows::connect(name) {
                    Ok((reader, writer)) => {
                        reader.set_read_timeout(Some(WAIT))?;
                        return Ok((BufReader::new(reader), writer));
                    }
                    Err(error) if error.raw_os_error() == Some(PIPE_BUSY) && start.elapsed() < WAIT => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => return Err(error),
                }
            }
        }

        fn connect(name: &str) -> Client {
            try_connect(name).unwrap()
        }

        /// True once the app has closed this connection.
        fn closed_by_app(reader: &mut BufReader<PipeHalf>) -> bool {
            matches!(reader.read(&mut [0u8; 1]), Ok(0))
        }

        /// Refused at once: the pipe cut it before or right after it opened.
        fn refused(name: &str) -> bool {
            match try_connect(name) {
                Ok((mut reader, _)) => closed_by_app(&mut reader),
                Err(_) => true,
            }
        }

        fn send(writer: &mut PipeHalf, line: &str) {
            writer.write_all(line.as_bytes()).unwrap();
            writer.write_all(b"\n").unwrap();
        }

        fn receive(reader: &mut BufReader<PipeHalf>) -> Value {
            serde_json::from_slice(&read_frame(reader, MAX_FRAME_BYTES).unwrap().expect("a reply")).unwrap()
        }

        fn start(name: &str, deadlines: Deadlines) -> Runner {
            Runner::start_named(name, Arc::new(Mutex::new(Host::default())), Arc::new(Instant), deadlines).unwrap()
        }

        fn short(idle_ms: u64, frame_ms: u64, handshake_ms: u64) -> Deadlines {
            let ms = Duration::from_millis;
            Deadlines { idle: ms(idle_ms), frame: ms(frame_ms), handshake: ms(handshake_ms), pairing: Duration::from_secs(5) }
        }

        /// Pair through the runner; the owner approves under the host's lock.
        fn pair(runner: &Runner, name: &str) -> bitsov_mcp::ClientKey {
            let (mut reader, mut writer) = connect(name);
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

        fn session(name: &str, key: &bitsov_mcp::ClientKey) -> Client {
            let (mut reader, mut writer) = connect(name);
            bitsov_mcp::open_session(&mut reader, &mut writer, key).unwrap();
            (reader, writer)
        }

        fn ask_pairing(name: &str) -> Client {
            let (mut reader, mut writer) = connect(name);
            send(&mut writer, &json!({"pair": {"name": "Notes", "nonce": hex::encode([5u8; 32])}}).to_string());
            assert!(receive(&mut reader)["pair"]["id"].is_string());
            (reader, writer)
        }

        fn lists_tools(client: &mut Client) -> bool {
            send(&mut client.1, r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#);
            receive(&mut client.0)["result"]["tools"].is_array()
        }

        #[test]
        fn a_client_pairs_opens_a_session_and_reads_over_the_pipe() {
            let name = pipe("read");
            let mut runner = start(&name, Deadlines::default());
            let key = pair(&runner, &name);
            let (mut reader, mut writer) = session(&name, &key);
            send(&mut writer, r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#);
            assert_eq!(receive(&mut reader)["result"]["tools"].as_array().unwrap().len(), 1, "only the approved topic");
            send(&mut writer, r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_node"}}"#);
            assert_eq!(receive(&mut reader)["result"]["isError"], false);
            assert_eq!(runner.host().lock().unwrap().audit.len(), 1, "the call is audited");
            runner.stop();
        }

        #[test]
        fn a_frame_trickled_a_byte_at_a_time_is_closed_at_the_frame_deadline() {
            let name = pipe("loris");
            let mut runner = start(&name, short(5_000, 300, 5_000));
            let (mut watch, mut writer) = connect(&name);
            let started = Clock::now();
            // A byte every 50 ms and never a newline: each read is well inside the idle timeout.
            let trickle = std::thread::spawn(move || {
                for _ in 0..100 {
                    if writer.write_all(b"x").is_err() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            });
            assert!(closed_by_app(&mut watch), "the trickling connection is closed");
            let took = started.elapsed();
            assert!(took >= Duration::from_millis(300) && took < Duration::from_secs(3), "{took:?}");
            trickle.join().unwrap();
            wait_until("no live connection", || runner.live() == 0);
            runner.stop();
        }

        #[test]
        fn a_connection_that_never_finishes_the_handshake_is_closed_but_a_pairing_request_may_wait() {
            let name = pipe("hs");
            let mut runner = start(&name, short(5_000, 5_000, 300));
            let key = pair(&runner, &name);

            // Silent from the start, and challenged but never signing: both closed at the handshake deadline.
            let started = Clock::now();
            let (mut silent, _silent_w) = connect(&name);
            let (mut reader, mut writer) = connect(&name);
            send(&mut writer, &json!({"hello": key.id}).to_string());
            assert!(receive(&mut reader)["challenge"].is_string());
            assert!(closed_by_app(&mut silent));
            assert_eq!(read_frame(&mut reader, MAX_FRAME_BYTES).unwrap(), None);
            assert!(started.elapsed() < Duration::from_secs(3), "well before the idle timeout");

            // A pairing request that keeps asking is not held to the handshake deadline.
            let (mut waiting_r, mut waiting_w) = ask_pairing(&name);
            for _ in 0..6 {
                std::thread::sleep(Duration::from_millis(100));
                send(&mut waiting_w, r#"{"pair_status":true}"#);
                assert_eq!(receive(&mut waiting_r)["pair"], "waiting");
            }
            runner.stop();
        }

        #[test]
        fn at_the_cap_stalled_handshakes_make_room_first_and_a_ready_client_never_does() {
            let name = pipe("cap");
            let mut runner = start(&name, Deadlines::default());
            let key = pair(&runner, &name);
            wait_until("the pairing connection to end", || runner.live() == 0);
            let mut waiting = ask_pairing(&name);
            let mut ready = session(&name, &key);
            let mut stalled: Vec<Client> = (0..MAX_CONNECTIONS - 2).map(|_| connect(&name)).collect();
            wait_until("eight live connections", || runner.live() == MAX_CONNECTIONS);

            // A ninth: the oldest stalled handshake is closed to make room, and the ninth is served.
            let mut ninth = connect(&name);
            assert!(closed_by_app(&mut stalled[0].0), "the oldest handshake made room");
            assert!(lists_tools(&mut ready), "the ready client keeps working");
            send(&mut waiting.1, r#"{"pair_status":true}"#);
            assert_eq!(receive(&mut waiting.0)["pair"], "waiting", "the pairing request is kept while handshakes can go");
            send(&mut ninth.1, r#"{"hello":"mcp-00"}"#);
            assert_eq!(receive(&mut ninth.0)["error"], "unknown client", "the ninth was served");

            // Only ready clients and the pairing request left: the pairing request makes room.
            drop(stalled);
            wait_until("two live connections", || runner.live() == 2);
            let mut sessions: Vec<Client> = (0..MAX_CONNECTIONS - 2).map(|_| session(&name, &key)).collect();
            assert_eq!(runner.live(), MAX_CONNECTIONS);
            let mut last = session(&name, &key);
            assert_eq!(read_frame(&mut waiting.0, MAX_FRAME_BYTES).unwrap(), None, "the pairing request made room");
            assert!(lists_tools(&mut last));

            // Eight ready clients: a new connection is refused at once, and all eight keep working.
            assert!(refused(&name), "no ready client is closed to make room");
            assert_eq!(runner.live(), MAX_CONNECTIONS);
            assert!(lists_tools(&mut ready));
            for client in &mut sessions {
                assert!(lists_tools(client));
            }
            runner.stop();
        }

        #[test]
        fn stop_closes_live_sessions_and_releases_the_pipe_name() {
            let name = pipe("stop");
            let mut runner = start(&name, Deadlines::default());
            let key = pair(&runner, &name);
            let (mut reader, mut writer) = session(&name, &key);
            send(&mut writer, r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#);
            assert_eq!(receive(&mut reader)["result"], json!({}));
            let (mut waiting, _waiting_w) = connect(&name);
            wait_until("two live connections", || runner.live() == 2);

            let started = Clock::now();
            runner.stop();
            assert!(started.elapsed() < Duration::from_secs(5), "stop() returns promptly");
            assert_eq!(read_frame(&mut reader, MAX_FRAME_BYTES).unwrap(), None, "the live session ends");
            assert!(closed_by_app(&mut waiting));
            assert_eq!(runner.live(), 0);
            assert!(bitsov_mcp::windows::connect(&name).is_err(), "nothing serves the pipe");
            runner.stop();
            // Once the clients let go too, the name can be served again.
            drop((reader, writer, waiting, _waiting_w));
            let mut again = start(&name, Deadlines::default());
            again.stop();
        }
    }
}
