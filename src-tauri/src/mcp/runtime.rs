//! MCP A1.5b: the runtime behind the owner's "AI apps" switch (ADR H3953 A1 §1.2).
//!
//! **Behind the off-by-default `mcp-grant` feature.** The Tauri commands in
//! the app call this; the Settings screen comes in a later slice.
//!
//! [`Runtime`] owns everything the switch turns on and off:
//! - the [`Host`], loaded once from the sealed clients file
//!   ([`Host::from_load`]); a file that does not load blocks saving and is
//!   only ever moved aside by the owner ([`Runtime::reset_clients`]);
//! - the platform listener (the [`super::runner::Runner`]: a socket on
//!   macOS, this user's pipe on Windows; elsewhere `start_failed`);
//! - the sealed [`AuditLog`]: the host's rows are moved to it by a tick
//!   thread, never under the host lock, which also calls
//!   [`AuditLog::flush_due`]; switching off calls [`AuditLog::flush`];
//! - the read source every connection reads through.
//!
//! The switch is off when the app starts: nothing listens until the owner
//! turns it on. Switching off closes the pairing window, every live
//! connection and the socket; the approved clients stay on file. Without a
//! sealer (Linux) nothing here is available.
//!
//! Every method returns a short error code ([`code`]), never prose: the
//! window maps codes to its own copy.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;

use super::audit_log::{self, AppendIo, AuditLog, TailBytes, SHOW_ROWS};
use super::endpoint::{ChangeError, Host, ReadSource, HANDSHAKE_AUDIT_TOOL, PAIRING_CLOSED, PAIRING_TAKEN, REMOVED_AUDIT_TOOL};
use super::pairing::PairError;
use super::session::{Audit, Outcome};
use super::store::{self, FileIo, R2Preset};
use crate::ai::Topic;
use crate::at_rest::Sealer;

/// The short error codes the commands return.
pub mod code {
    pub const MAIN_WINDOW_ONLY: &str = "main_window_only";
    pub const UNAVAILABLE: &str = "unavailable";
    pub const BLOCKED: &str = "blocked";
    pub const START_FAILED: &str = "start_failed";
    pub const UNKNOWN: &str = "unknown";
    pub const NO_TOPICS: &str = "no_topics";
    pub const PRESET_TOO_WIDE: &str = "preset_too_wide";
    pub const NOT_SAVED: &str = "not_saved";
    /// Already the most clients kept: the owner removes one first.
    pub const TOO_MANY_CLIENTS: &str = "too_many_clients";
    /// A removal is not on file yet: the endpoint stays off until it is.
    pub const REMOVAL_NOT_SAVED: &str = "removal_not_saved";
    pub const PAIRING_CLOSED: &str = "pairing_closed";
    /// An earlier command failed midway (a panic); the switch was turned off
    /// and the state is read again from the clients file. Returned once.
    pub const RECOVERED: &str = "recovered";
}

/// The folder under the app's data directory: the socket, the clients file
/// and the audit log.
pub const DIR_NAME: &str = "mcp";

/// How often the tick thread moves audit rows to the log and looks for a
/// pairing request to tell the window about.
pub const TICK: Duration = Duration::from_secs(1);

/// The tool name an audit row shows for a `pair` refused outside a window.
pub const PAIRING_REFUSED_TOOL: &str = "pairing_refused";

/// A running platform listener.
pub trait Listener: Send {
    /// Stop accepting, close every live connection, remove the endpoint.
    fn stop(&mut self);
}

#[cfg(any(target_os = "macos", windows))]
impl Listener for super::runner::Runner {
    fn stop(&mut self) {
        super::runner::Runner::stop(self);
    }
}

/// Starts the platform listener in a directory.
pub type StartListener =
    Box<dyn Fn(&Path, Arc<Mutex<Host>>, Arc<dyn ReadSource + Send + Sync>) -> io::Result<Box<dyn Listener>> + Send>;

/// Opens the audit file in a directory.
pub type OpenAudit = Box<dyn Fn(&Path) -> io::Result<Box<dyn AppendIo + Send>> + Send>;

/// The listener of this platform: the macOS runner on a socket in `dir`,
/// the Windows runner on this user's pipe. Elsewhere `Unsupported`.
pub fn platform_listener() -> StartListener {
    Box::new(|dir, host, source| {
        #[cfg(target_os = "macos")]
        {
            let runner = super::runner::Runner::start(dir, host, source)?;
            Ok(Box::new(runner) as Box<dyn Listener>)
        }
        #[cfg(windows)]
        {
            // The pipe name is per user; the directory holds only the files.
            let _ = dir;
            let runner = super::runner::Runner::start(host, source)?;
            Ok(Box::new(runner) as Box<dyn Listener>)
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = (dir, host, source);
            Err(io::Error::new(io::ErrorKind::Unsupported, "no MCP listener on this platform yet"))
        }
    })
}

/// The real audit file.
pub fn platform_audit() -> OpenAudit {
    Box::new(|dir| Ok(Box::new(audit_log::PrivateFile::open(dir)?) as Box<dyn AppendIo + Send>))
}

impl AppendIo for Box<dyn AppendIo + Send> {
    fn append_line(&mut self, line: &[u8]) -> io::Result<u64> {
        (**self).append_line(line)
    }
    fn read_tail(&self, max_bytes: usize) -> io::Result<Option<TailBytes>> {
        (**self).read_tail(max_bytes)
    }
    fn replace_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        (**self).replace_all(bytes)
    }
}

type Log = AuditLog<'static, Box<dyn AppendIo + Send>>;

/// What the runtime is built from.
pub struct Config {
    /// `<app data>/mcp`.
    pub dir: PathBuf,
    /// The platform's at-rest sealer; `None` means MCP is unavailable.
    pub sealer: Option<&'static dyn Sealer>,
    /// The clients file.
    pub store: Box<dyn FileIo + Send>,
    pub source: Arc<dyn ReadSource + Send + Sync>,
    pub start: StartListener,
    pub open_audit: OpenAudit,
    /// Tells the main window something changed (no payload).
    pub notify: Arc<dyn Fn() + Send + Sync>,
    /// Milliseconds since the Unix epoch, for the tick thread.
    pub clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl Config {
    /// The app's own: the clients file and audit log in `dir`, the platform
    /// sealer, listener and audit file.
    pub fn for_app(dir: PathBuf, source: Arc<dyn ReadSource + Send + Sync>, notify: Arc<dyn Fn() + Send + Sync>) -> Self {
        let store = Box::new(store::PrivateFile { path: dir.join(store::FILE_NAME) });
        Config {
            dir,
            sealer: crate::at_rest::installed(),
            store,
            source,
            start: platform_listener(),
            open_audit: platform_audit(),
            notify,
            clock: Arc::new(super::runner::now_ms),
        }
    }
}

/// The switch's state, as the window shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    /// `ok`, or `no_sealer` (Linux): the switch is shown disabled.
    pub platform: &'static str,
    pub enabled: bool,
    /// `ok`, `empty` (no client on file) or `blocked` (the file did not load).
    pub store: &'static str,
    /// Why the last switch-on failed, if it did.
    pub start_error: Option<&'static str>,
    /// Seconds left in the pairing window (or of its waiting request).
    pub pairing_open_s: Option<u16>,
    /// Requests waiting for the owner (at most one per window).
    pub waiting: u8,
    /// Approved clients.
    pub clients: u8,
    /// A removal holds in memory but is not on file yet. The endpoint stays
    /// off until a save carries it (`start_error` is `removal_not_saved`).
    pub unsaved_revoke: bool,
}

/// One request waiting for the owner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PendingView {
    pub id: String,
    pub name: String,
    pub words: Vec<String>,
    pub expires_in_s: u16,
    pub others_refused: u8,
}

/// One approved client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClientView {
    pub id: String,
    pub name: String,
    pub topics: Vec<Topic>,
    pub preset: R2Preset,
    pub created_ms: u64,
}

/// Whether a change is on file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Saved {
    pub saved: bool,
}

/// One audit row as shown. No client-supplied arguments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuditView {
    pub at_ms: u64,
    /// The client's name from the clients file (removed clients included);
    /// `None` when the row names no known client.
    pub client: Option<String>,
    pub tool: String,
    pub outcome: &'static str,
}

/// The newest audit rows, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuditPage {
    pub rows: Vec<AuditView>,
    pub unreadable: u32,
}

/// How the tick thread is started (a test makes it fail).
type SpawnTick = fn(Box<dyn FnOnce() + Send>) -> io::Result<JoinHandle<()>>;

fn spawn_tick(work: Box<dyn FnOnce() + Send>) -> io::Result<JoinHandle<()>> {
    std::thread::Builder::new().name("mcp-tick".into()).spawn(work)
}

struct Running {
    listener: Box<dyn Listener>,
    tick: Option<JoinHandle<()>>,
    stop_tick: Arc<(Mutex<bool>, Condvar)>,
}

/// The MCP runtime: the switch, the host, the listener and the audit log.
pub struct Runtime {
    config: Config,
    host: Arc<Mutex<Host>>,
    loaded: bool,
    audit: Option<Arc<Mutex<Log>>>,
    running: Option<Running>,
    start_error: Option<&'static str>,
    unsaved_revoke: bool,
    spawn_tick: SpawnTick,
    /// Clients revoked in memory when the state was dropped after a panic
    /// ([`Guarded`]): revoked again after every load until a save succeeds,
    /// so a recovery never gives back access a revoke took away. Cleared only
    /// by a successful save: saves are refused while the file is blocked, so
    /// the host saved was either loaded (these applied) or started over (no
    /// client of the old file in it), and either way the file no longer
    /// approves them. Whether a record for an id exists does not matter.
    carry_revokes: Vec<String>,
}

/// The runtime behind its lock, recovering fail-safe after a panic.
///
/// A command that panics while it holds the lock leaves it poisoned, and the
/// runtime may be half-updated. The next command then does not use that state
/// for anything: the listener and the tick are stopped (the switch is off),
/// the in-memory host and audit log are dropped without a save or a flush,
/// the clients file is left untouched, and that command returns
/// [`code::RECOVERED`] once. Later commands work normally and read the state
/// again from the file. The one thing carried over is which clients were
/// revoked in memory, since keeping a revoke can only take access away.
pub struct Guarded(Mutex<Runtime>);

impl Guarded {
    pub fn new(runtime: Runtime) -> Self {
        Guarded(Mutex::new(runtime))
    }

    /// Run `command` on the runtime, or recover from an earlier panic.
    pub fn with<T>(&self, command: impl FnOnce(&mut Runtime) -> Result<T, &'static str>) -> Result<T, &'static str> {
        match self.0.lock() {
            Ok(mut runtime) => command(&mut runtime),
            Err(poisoned) => {
                let mut runtime = poisoned.into_inner();
                runtime.recover_after_panic();
                self.0.clear_poison();
                Err(code::RECOVERED)
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, &'static str> {
    mutex.lock().map_err(|_| code::UNAVAILABLE)
}

fn seconds_until(until_ms: u64, now_ms: u64) -> u16 {
    u16::try_from(until_ms.saturating_sub(now_ms).div_ceil(1000)).unwrap_or(u16::MAX)
}

fn outcome_code(outcome: Outcome) -> &'static str {
    match outcome {
        Outcome::Read => "read",
        Outcome::ReadFailed => "read_failed",
        Outcome::Refused => "refused",
        Outcome::RateLimited => "rate_limited",
        Outcome::NotAuthorised => "not_authorised",
        Outcome::Removed => "removed",
    }
}

/// Move the host's audit rows to the log (the host lock is held only to take
/// them), then write any summary rows that are due.
fn drain(host: &Mutex<Host>, audit: &Mutex<Log>, now_ms: u64) {
    let rows = match host.lock() {
        Ok(mut host) => std::mem::take(&mut host.audit),
        Err(_) => return,
    };
    if let Ok(mut log) = audit.lock() {
        for row in rows {
            log.append(row);
        }
        log.flush_due(now_ms);
    }
}

/// What the window is told about: the pairing window and its request.
fn pairing_signature(host: &Mutex<Host>, now_ms: u64) -> Option<(Option<String>, u8)> {
    let mut host = host.lock().ok()?;
    host.pairing_window(now_ms).map(|view| (view.request.map(|shown| shown.id), view.others_refused))
}

impl Runtime {
    pub fn new(config: Config) -> Self {
        Runtime {
            config,
            host: Arc::new(Mutex::new(Host::default())),
            loaded: false,
            audit: None,
            running: None,
            start_error: None,
            unsaved_revoke: false,
            spawn_tick,
            carry_revokes: Vec::new(),
        }
    }

    /// The host every connection shares (tests and the read source).
    pub fn host(&self) -> &Arc<Mutex<Host>> {
        &self.host
    }

    fn sealer(&self) -> Result<&'static dyn Sealer, &'static str> {
        self.config.sealer.ok_or(code::UNAVAILABLE)
    }

    /// Load the clients file once. While it is blocked, `retry` loads it
    /// again (nothing can be approved or lost while blocked).
    fn ensure_loaded(&mut self, retry: bool) -> Result<(), &'static str> {
        let sealer = self.sealer()?;
        let blocked = lock(&self.host)?.blocked().is_some();
        if self.loaded && !(retry && blocked) {
            return Ok(());
        }
        let mut loaded = Host::from_load(store::load(self.config.store.as_ref(), Some(sealer)));
        // Revokes held only in memory before a recovery hold again; the file
        // does not have them yet. Applied to every load, blocked or not, and
        // kept until a save puts them on file: a blocked load has no records
        // to revoke, and the next good load must still find them.
        let now = (self.config.clock)();
        for id in &self.carry_revokes {
            if loaded.revoke(id, now).is_ok() {
                self.unsaved_revoke = true;
            }
        }
        *lock(&self.host)? = loaded;
        self.loaded = true;
        Ok(())
    }

    /// A save of every record succeeded: nothing is held only in memory now.
    fn saved(&mut self) {
        self.unsaved_revoke = false;
        self.carry_revokes.clear();
    }

    /// After a panic left the state half-updated (see [`Guarded`]): stop
    /// everything and drop the in-memory state without saving or flushing it.
    fn recover_after_panic(&mut self) {
        let revoked = {
            let host = self.host.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            revokes_to_carry(&host)
        };
        if let Some(mut running) = self.running.take() {
            running.listener.stop();
            let (stopped, wake) = &*running.stop_tick;
            *stopped.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = true;
            wake.notify_all();
            if let Some(tick) = running.tick.take() {
                let _ = tick.join();
            }
        }
        // New locks, not the possibly poisoned ones.
        self.host = Arc::new(Mutex::new(Host::default()));
        self.audit = None;
        self.loaded = false;
        self.start_error = None;
        for id in revoked {
            if !self.carry_revokes.contains(&id) {
                self.carry_revokes.push(id);
            }
        }
        self.notify();
    }

    fn audit_log(&mut self) -> Result<Arc<Mutex<Log>>, &'static str> {
        if let Some(log) = &self.audit {
            return Ok(log.clone());
        }
        let sealer = self.sealer()?;
        let io = (self.config.open_audit)(&self.config.dir).map_err(|_| code::UNAVAILABLE)?;
        let log = Arc::new(Mutex::new(AuditLog::new(sealer, io)));
        self.audit = Some(log.clone());
        Ok(log)
    }

    fn notify(&self) {
        (self.config.notify)();
    }

    /// The switch's state. Never fails: without a sealer it says so.
    pub fn status(&mut self, now_ms: u64) -> Status {
        let unavailable = Status {
            platform: "no_sealer",
            enabled: false,
            store: "empty",
            start_error: None,
            pairing_open_s: None,
            waiting: 0,
            clients: 0,
            unsaved_revoke: false,
        };
        if self.ensure_loaded(false).is_err() {
            return unavailable;
        }
        let Ok(mut host) = self.host.lock() else { return unavailable };
        let window = host.pairing_window(now_ms);
        let active = host.stored().len();
        Status {
            platform: "ok",
            enabled: self.running.is_some(),
            store: if host.blocked().is_some() {
                "blocked"
            } else if host.stored().is_empty() {
                "empty"
            } else {
                "ok"
            },
            start_error: self.start_error,
            pairing_open_s: window.as_ref().map(|view| seconds_until(view.until_ms, now_ms)),
            waiting: u8::from(window.as_ref().is_some_and(|view| view.request.is_some())),
            clients: u8::try_from(active).unwrap_or(u8::MAX),
            unsaved_revoke: self.unsaved_revoke,
        }
    }

    /// The owner's switch. On: load the clients (a file that does not load
    /// keeps it off with `blocked`), start the listener and the tick. Off:
    /// close the pairing window, stop the listener (live connections close,
    /// the socket goes), write the audit's held rows. Clients stay on file.
    pub fn set_enabled(&mut self, on: bool, now_ms: u64) -> Result<Status, &'static str> {
        self.sealer()?;
        if on {
            self.switch_on()?;
        } else {
            self.switch_off(now_ms);
        }
        Ok(self.status(now_ms))
    }

    fn switch_on(&mut self) -> Result<(), &'static str> {
        if self.running.is_some() {
            return Ok(());
        }
        self.ensure_loaded(true)?;
        if lock(&self.host)?.blocked().is_some() {
            return Err(code::BLOCKED);
        }
        // A removal that is not on file: try once more, and stay off if the
        // file still lists the removed client.
        if self.unsaved_revoke {
            let sealer = self.sealer()?;
            let mut host = lock(&self.host)?;
            if host.save_now(self.config.store.as_ref(), Some(sealer)).is_err() {
                drop(host);
                self.start_error = Some(code::REMOVAL_NOT_SAVED);
                return Err(code::REMOVAL_NOT_SAVED);
            }
            host.saved();
            self.unsaved_revoke = false;
        }
        let Ok(audit) = self.audit_log() else {
            self.start_error = Some(code::START_FAILED);
            return Err(code::START_FAILED);
        };
        let listener = match (self.config.start)(&self.config.dir, self.host.clone(), self.config.source.clone()) {
            Ok(listener) => listener,
            Err(_) => {
                self.start_error = Some(code::START_FAILED);
                return Err(code::START_FAILED);
            }
        };
        let stop_tick = Arc::new((Mutex::new(false), Condvar::new()));
        let spawned = {
            let (host, stop, notify, clock) = (self.host.clone(), stop_tick.clone(), self.config.notify.clone(), self.config.clock.clone());
            // Taken now, not when the thread starts, so no change is missed.
            let seen = pairing_signature(&self.host, clock());
            (self.spawn_tick)(Box::new(move || tick_loop(&host, &audit, &stop, notify.as_ref(), clock.as_ref(), seen)))
        };
        // Without the tick, audit rows would stay in memory and a request
        // would never reach the window: fail closed.
        let Ok(tick) = spawned else {
            let mut listener = listener;
            listener.stop();
            self.start_error = Some(code::START_FAILED);
            return Err(code::START_FAILED);
        };
        self.start_error = None;
        self.running = Some(Running { listener, tick: Some(tick), stop_tick });
        self.notify();
        Ok(())
    }

    fn switch_off(&mut self, now_ms: u64) {
        if let Ok(mut host) = self.host.lock() {
            host.close_pairing(now_ms);
        }
        let Some(mut running) = self.running.take() else { return };
        running.listener.stop();
        {
            let (stopped, wake) = &*running.stop_tick;
            if let Ok(mut stopped) = stopped.lock() {
                *stopped = true;
            }
            wake.notify_all();
        }
        if let Some(tick) = running.tick.take() {
            let _ = tick.join();
        }
        if let Some(audit) = &self.audit {
            drain(&self.host, audit, now_ms);
            if let Ok(mut log) = audit.lock() {
                log.flush(now_ms);
            }
        }
        self.notify();
    }

    /// "Stop all": the switch goes off; the clients stay on file.
    pub fn stop_all(&mut self, now_ms: u64) -> Result<Status, &'static str> {
        self.set_enabled(false, now_ms)
    }

    /// "Add an AI app": open the pairing window. Only while on and not blocked.
    pub fn open_pairing(&mut self, now_ms: u64) -> Result<Status, &'static str> {
        self.sealer()?;
        if self.running.is_none() {
            return Err(code::UNAVAILABLE);
        }
        {
            let mut host = lock(&self.host)?;
            if host.blocked().is_some() {
                return Err(code::BLOCKED);
            }
            host.close_pairing(now_ms);
            host.open_pairing(now_ms);
        }
        self.notify();
        Ok(self.status(now_ms))
    }

    /// The owner cancels the pairing window. Idempotent.
    pub fn close_pairing(&mut self, now_ms: u64) -> Result<Status, &'static str> {
        self.sealer()?;
        lock(&self.host)?.close_pairing(now_ms);
        self.notify();
        Ok(self.status(now_ms))
    }

    /// The request waiting in the pairing window, if any.
    pub fn pending(&mut self, now_ms: u64) -> Result<Vec<PendingView>, &'static str> {
        self.sealer()?;
        if self.running.is_none() {
            return Ok(Vec::new());
        }
        let Some(view) = lock(&self.host)?.pairing_window(now_ms) else { return Ok(Vec::new()) };
        Ok(view.request.into_iter().map(|shown| PendingView {
            id: shown.id,
            name: shown.name,
            words: shown.code.iter().map(|word| (*word).to_owned()).collect(),
            expires_in_s: seconds_until(shown.expires_ms, now_ms),
            others_refused: view.others_refused,
        }).collect())
    }

    /// The owner approves the waiting request with topics and a preset
    /// (counts or rounded). Saved, or nothing changed; the window closes.
    pub fn approve(&mut self, id: &str, topics: &[Topic], preset: R2Preset, now_ms: u64) -> Result<ClientView, &'static str> {
        let sealer = self.sealer()?;
        // Every save writes the whole list: never before the file was read.
        self.ensure_loaded(false)?;
        if topics.is_empty() {
            return Err(code::NO_TOPICS);
        }
        let view = {
            let mut host = lock(&self.host)?;
            // Only the open window's own request can be approved.
            let its_request = host.pairing_window(now_ms).and_then(|view| view.request).is_some_and(|shown| shown.id == id);
            if !its_request {
                return Err(code::UNKNOWN);
            }
            let result = host.commit(self.config.store.as_ref(), Some(sealer), |h| h.approve(id, topics, preset.preset(), now_ms));
            match result {
                Ok(()) => {}
                Err(ChangeError::StoreBlocked(_)) => return Err(code::BLOCKED),
                Err(ChangeError::Store(_)) => return Err(code::NOT_SAVED),
                Err(ChangeError::PresetTooWide) => return Err(code::PRESET_TOO_WIDE),
                Err(ChangeError::TooManyClients) => return Err(code::TOO_MANY_CLIENTS),
                Err(ChangeError::Pair(PairError::Unknown) | ChangeError::UnknownClient) => return Err(code::UNKNOWN),
                Err(_) => return Err(code::NOT_SAVED),
            }
            host.close_pairing(now_ms);
            host.stored().iter().find(|record| record.id == id).and_then(client_view).ok_or(code::UNKNOWN)?
        };
        // The save carried every record, an earlier unsaved revoke included.
        self.saved();
        self.notify();
        Ok(view)
    }

    /// The owner denies the waiting request. Its window closes; denying any
    /// other id (unknown, or already settled) leaves an open window alone.
    pub fn deny(&mut self, id: &str, now_ms: u64) -> Result<bool, &'static str> {
        self.sealer()?;
        let denied = {
            let mut host = lock(&self.host)?;
            let its_request = host.pairing_window(now_ms).and_then(|view| view.request).is_some_and(|shown| shown.id == id);
            let denied = host.deny(id, now_ms);
            if its_request {
                host.close_pairing(now_ms);
            }
            denied
        };
        self.notify();
        Ok(denied)
    }

    /// The approved clients.
    pub fn clients(&mut self) -> Result<Vec<ClientView>, &'static str> {
        self.sealer()?;
        self.ensure_loaded(false)?;
        let host = lock(&self.host)?;
        Ok(host.stored().iter().filter_map(client_view).collect())
    }

    /// The owner removes a client. Access is cut at once in memory and the
    /// record leaves the file. If the file could not be saved, `saved: false`,
    /// the endpoint switches off and stays off until a later save works
    /// ([`Runtime::save_again`], or switching on, which tries again).
    pub fn revoke(&mut self, id: &str) -> Result<Saved, &'static str> {
        let sealer = self.sealer()?;
        self.ensure_loaded(false)?;
        let now = (self.config.clock)();
        let result = lock(&self.host)?.revoke_saved(self.config.store.as_ref(), Some(sealer), id, now);
        let saved = match result {
            Ok(()) => {
                // Every record was saved, an earlier unsaved revoke included.
                self.saved();
                true
            }
            Err(ChangeError::RevokedNotSaved(_)) => {
                self.unsaved_revoke = true;
                // The file still lists the client: nothing listens until it agrees.
                self.switch_off(now);
                self.start_error = Some(code::REMOVAL_NOT_SAVED);
                false
            }
            Err(_) => return Err(code::UNKNOWN),
        };
        self.notify();
        Ok(Saved { saved })
    }

    /// Save the records again after a revoke that was not saved.
    pub fn save_again(&mut self) -> Result<Saved, &'static str> {
        let sealer = self.sealer()?;
        // Never save before the file was read: an empty host would replace it.
        self.ensure_loaded(false)?;
        let mut host = lock(&self.host)?;
        let result = host.save_now(self.config.store.as_ref(), Some(sealer));
        if result.is_ok() {
            host.saved();
        }
        drop(host);
        let saved = match result {
            Ok(()) => {
                self.saved();
                if self.start_error == Some(code::REMOVAL_NOT_SAVED) {
                    self.start_error = None;
                }
                true
            }
            Err(ChangeError::StoreBlocked(_)) => return Err(code::BLOCKED),
            Err(_) => false,
        };
        self.notify();
        Ok(Saved { saved })
    }

    /// The newest [`SHOW_ROWS`] audit rows, newest first, with client names
    /// from the clients file (removed clients included).
    pub fn audit(&mut self, now_ms: u64) -> Result<AuditPage, &'static str> {
        self.sealer()?;
        self.ensure_loaded(false)?;
        let log = self.audit_log()?;
        drain(&self.host, &log, now_ms);
        let tail = lock(&log)?.last(SHOW_ROWS).map_err(|_| code::UNAVAILABLE)?;
        let host = lock(&self.host)?;
        // A removed client's record has left the file; its removal row keeps the name.
        let removed: std::collections::HashMap<&str, &str> = tail.rows.iter()
            .filter(|row| row.outcome == Outcome::Removed && row.tool == REMOVED_AUDIT_TOOL)
            .map(|row| (row.client.as_str(), row.arguments.as_str()))
            .collect();
        let name_of = |client: &str| host.stored().iter().find(|record| record.id == client).map(|record| record.name.clone())
            .or_else(|| removed.get(client).map(|name| (*name).to_owned()));
        let rows = tail.rows.iter().rev().map(|row| {
            let pairing = row.tool == HANDSHAKE_AUDIT_TOOL && (row.arguments == PAIRING_CLOSED || row.arguments == PAIRING_TAKEN);
            AuditView {
                at_ms: row.at_ms,
                // A refused pairing proved no key: its name is only what the caller declared.
                client: if pairing { None } else { name_of(&row.client) },
                tool: if pairing { PAIRING_REFUSED_TOOL.to_owned() } else { row.tool.clone() },
                outcome: outcome_code(row.outcome),
            }
        }).collect();
        Ok(AuditPage { rows, unreadable: u32::try_from(tail.skipped).unwrap_or(u32::MAX) })
    }

    /// The clients file did not load: move it aside (kept, never parsed)
    /// and start from no clients. Only while blocked, and only confirmed.
    pub fn reset_clients(&mut self, confirm: bool, now_ms: u64) -> Result<Status, &'static str> {
        self.sealer()?;
        self.ensure_loaded(false)?;
        if !confirm || lock(&self.host)?.blocked().is_none() {
            return Err(code::UNAVAILABLE);
        }
        let path = self.config.dir.join(store::FILE_NAME);
        let aside = self.config.dir.join(format!("{}.unreadable-{now_ms}", store::FILE_NAME));
        match std::fs::rename(&path, &aside) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(code::NOT_SAVED),
        }
        lock(&self.host)?.start_over();
        self.notify();
        Ok(self.status(now_ms))
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        let now = (self.config.clock)();
        self.switch_off(now);
    }
}

/// The clients whose access a recovery must not give back: every client
/// removed in this host whose removal no save has carried yet (a saved
/// removal has left the file, so a reload cannot give it back). The one
/// place that reads them, so a change to how revocations are kept changes
/// only this.
fn revokes_to_carry(host: &Host) -> Vec<String> {
    host.removed_unsaved().to_vec()
}

fn client_view(record: &store::StoredClient) -> Option<ClientView> {
    Some(ClientView {
        id: record.id.clone(),
        name: record.name.clone(),
        topics: record.topics.clone(),
        preset: R2Preset::new(record.preset)?,
        created_ms: record.created_ms,
    })
}

fn tick_loop(
    host: &Mutex<Host>,
    audit: &Mutex<Log>,
    stop: &(Mutex<bool>, Condvar),
    notify: &(dyn Fn() + Send + Sync),
    clock: &(dyn Fn() -> u64 + Send + Sync),
    mut seen: Option<(Option<String>, u8)>,
) {
    let (stopped, wake) = stop;
    loop {
        let Ok(guard) = stopped.lock() else { return };
        let Ok((guard, _)) = wake.wait_timeout_while(guard, TICK, |stopped| !*stopped) else { return };
        if *guard {
            return;
        }
        drop(guard);
        let now = clock();
        drain(host, audit, now);
        let signature = pairing_signature(host, now);
        if signature != seen {
            seen = signature;
            notify();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use serde_json::{json, Value};

    use super::*;
    use crate::mcp::audit_log::MemoryFile;
    use crate::mcp::endpoint::{Conn, PAIRING_WINDOW_MS};
    use crate::mcp::identity::sign;
    use crate::mcp::pairing::REQUEST_TTL_MS;
    use crate::mcp::server::{ReadFailed, Reads};
    use crate::mcp::session::AuditRow;
    use crate::mcp::store::testing::TagSealer;

    static SEALER: TagSealer = TagSealer;

    /// The clients file, shared with the test so it can fail or be inspected.
    #[derive(Clone, Default)]
    struct SharedFile(Arc<Mutex<(Option<Vec<u8>>, bool)>>);
    impl SharedFile {
        fn fail(&self, fail: bool) {
            self.0.lock().unwrap().1 = fail;
        }
        fn put(&self, bytes: &[u8]) {
            self.0.lock().unwrap().0 = Some(bytes.to_vec());
        }
    }
    impl FileIo for SharedFile {
        fn read(&self, max_bytes: usize) -> io::Result<Option<Vec<u8>>> {
            Ok(self.0.lock().unwrap().0.as_ref().map(|b| b[..b.len().min(max_bytes)].to_vec()))
        }
        fn write(&self, bytes: &[u8]) -> io::Result<()> {
            let mut file = self.0.lock().unwrap();
            if file.1 {
                return Err(io::Error::other("disk full"));
            }
            file.0 = Some(bytes.to_vec());
            Ok(())
        }
    }

    #[derive(Default)]
    struct Counts {
        started: AtomicUsize,
        stopped: Arc<AtomicUsize>,
        refuse_start: AtomicBool,
        notified: AtomicUsize,
    }

    struct FakeListener(Arc<AtomicUsize>);
    impl Listener for FakeListener {
        fn stop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct Quiet;
    impl Reads for Quiet {
        fn read(&self, _topic: Topic, _since_ms: Option<u64>) -> Result<Value, ReadFailed> {
            Ok(json!({ "ok": true }))
        }
    }
    impl ReadSource for Quiet {
        fn reads_for(&self, _preset: R2Preset) -> Box<dyn Reads + '_> {
            Box::new(Quiet)
        }
    }

    fn runtime_with(dir: PathBuf, sealer: Option<&'static dyn Sealer>, file: &SharedFile, counts: &Arc<Counts>) -> Runtime {
        runtime_clocked(dir, sealer, file, counts, Arc::new(|| 5))
    }

    fn runtime_clocked(
        dir: PathBuf,
        sealer: Option<&'static dyn Sealer>,
        file: &SharedFile,
        counts: &Arc<Counts>,
        clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Runtime {
        let (start_counts, notify_counts) = (counts.clone(), counts.clone());
        Runtime::new(Config {
            dir,
            sealer,
            store: Box::new(file.clone()),
            source: Arc::new(Quiet),
            start: Box::new(move |_, _, _| {
                if start_counts.refuse_start.load(Ordering::SeqCst) {
                    return Err(io::Error::other("cannot bind"));
                }
                start_counts.started.fetch_add(1, Ordering::SeqCst);
                Ok(Box::new(FakeListener(start_counts.stopped.clone())) as Box<dyn Listener>)
            }),
            open_audit: Box::new(|_| Ok(Box::new(MemoryFile::default()) as Box<dyn AppendIo + Send>)),
            notify: Arc::new(move || {
                notify_counts.notified.fetch_add(1, Ordering::SeqCst);
            }),
            clock,
        })
    }

    fn runtime(file: &SharedFile, counts: &Arc<Counts>) -> Runtime {
        runtime_with(std::env::temp_dir().join("bsm-unused"), Some(&SEALER), file, counts)
    }

    fn pair_frame(host: &Arc<Mutex<Host>>, name: &str, nonce: u8, at: u64) -> (Conn, Value) {
        let mut conn = Conn::Start;
        let frame = json!({"pair": {"name": name, "nonce": hex::encode([nonce; 32])}}).to_string();
        let step = host.lock().unwrap().on_frame(&mut conn, frame.as_bytes(), at, &Quiet);
        let reply = serde_json::from_slice(step.reply.unwrap().strip_suffix(b"\n").unwrap()).unwrap();
        (conn, reply)
    }

    /// Enable, open a window, take one request and approve it. Returns the id and the secret.
    fn approved(rt: &mut Runtime, preset: R2Preset) -> (String, [u8; 32]) {
        rt.set_enabled(true, 0).unwrap();
        rt.open_pairing(0).unwrap();
        let (mut conn, asked) = pair_frame(rt.host(), "Desk", 3, 1);
        let id = asked["pair"]["id"].as_str().unwrap().to_owned();
        rt.approve(&id, &[Topic::Node], preset, 2).unwrap();
        let step = rt.host().lock().unwrap().on_frame(&mut conn, br#"{"pair_status":true}"#, 3, &Quiet);
        let done: Value = serde_json::from_slice(step.reply.unwrap().strip_suffix(b"\n").unwrap()).unwrap();
        let secret: [u8; 32] = hex::decode(done["secret"].as_str().unwrap()).unwrap().try_into().unwrap();
        (id, secret)
    }

    fn hello(rt: &Runtime, id: &str, at: u64) -> Value {
        let mut conn = Conn::Start;
        let step = rt.host().lock().unwrap().on_frame(&mut conn, json!({"hello": id}).to_string().as_bytes(), at, &Quiet);
        serde_json::from_slice(step.reply.unwrap().strip_suffix(b"\n").unwrap()).unwrap()
    }

    #[test]
    fn off_at_start_then_on_and_off_again_with_the_clients_kept() {
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut rt = runtime(&file, &counts);
        let status = rt.status(0);
        assert_eq!((status.platform, status.enabled, status.store), ("ok", false, "empty"));
        assert_eq!(counts.started.load(Ordering::SeqCst), 0, "nothing listens until the owner switches it on");
        assert_eq!(rt.open_pairing(0), Err(code::UNAVAILABLE), "no pairing window while off");

        let (id, _) = approved(&mut rt, R2Preset::Rounded);
        assert_eq!(counts.started.load(Ordering::SeqCst), 1);
        rt.open_pairing(10).unwrap();
        assert!(rt.status(10).pairing_open_s.is_some());

        let off = rt.set_enabled(false, 11).unwrap();
        assert!(!off.enabled);
        assert_eq!(off.pairing_open_s, None, "switching off closes the window");
        assert_eq!(counts.stopped.load(Ordering::SeqCst), 1, "the listener is stopped");
        assert_eq!(rt.clients().unwrap().iter().map(|c| c.id.clone()).collect::<Vec<_>>(), std::slice::from_ref(&id), "clients stay on file");
        assert_eq!(off.clients, 1);

        // A removal that is not on file keeps it off until the file agrees,
        // without a second load that could undo the removal.
        rt.set_enabled(true, 12).unwrap();
        file.fail(true);
        assert_eq!(rt.revoke(&id).unwrap(), Saved { saved: false });
        assert_eq!(counts.stopped.load(Ordering::SeqCst), 2, "the endpoint closed");
        let status = rt.status(12);
        assert_eq!((status.enabled, status.unsaved_revoke, status.clients, status.start_error), (false, true, 0, Some(code::REMOVAL_NOT_SAVED)));
        assert_eq!(rt.set_enabled(true, 12), Err(code::REMOVAL_NOT_SAVED), "stays off while the file still lists it");
        assert_eq!(counts.started.load(Ordering::SeqCst), 2);
        file.fail(false);
        let on = rt.set_enabled(true, 12).unwrap();
        assert!(on.enabled && !on.unsaved_revoke && on.start_error.is_none());
        assert!(store::load(&file, Some(&SEALER)).unwrap().is_empty(), "switching on saved the removal first");
        assert!(!rt.stop_all(13).unwrap().enabled);
        assert_eq!(counts.stopped.load(Ordering::SeqCst), 3);

        // A listener that cannot start leaves it off and says so.
        counts.refuse_start.store(true, Ordering::SeqCst);
        assert_eq!(rt.set_enabled(true, 14), Err(code::START_FAILED));
        let status = rt.status(14);
        assert_eq!((status.enabled, status.start_error), (false, Some(code::START_FAILED)));
        assert!(counts.notified.load(Ordering::SeqCst) > 0);
    }

    #[test]
    fn without_a_sealer_everything_is_unavailable() {
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut rt = runtime_with(std::env::temp_dir().join("bsm-unused"), None, &file, &counts);
        assert_eq!(rt.status(0).platform, "no_sealer");
        assert_eq!(rt.set_enabled(true, 0), Err(code::UNAVAILABLE));
        assert_eq!(counts.started.load(Ordering::SeqCst), 0);
        assert_eq!(rt.open_pairing(0), Err(code::UNAVAILABLE));
        assert_eq!(rt.close_pairing(0), Err(code::UNAVAILABLE));
        assert_eq!(rt.pending(0), Err(code::UNAVAILABLE));
        assert_eq!(rt.approve("mcp-00", &[Topic::Node], R2Preset::Counts, 0), Err(code::UNAVAILABLE));
        assert_eq!(rt.deny("mcp-00", 0), Err(code::UNAVAILABLE));
        assert_eq!(rt.clients(), Err(code::UNAVAILABLE));
        assert_eq!(rt.revoke("mcp-00"), Err(code::UNAVAILABLE));
        assert_eq!(rt.save_again(), Err(code::UNAVAILABLE));
        assert_eq!(rt.audit(0), Err(code::UNAVAILABLE));
        assert_eq!(rt.reset_clients(true, 0), Err(code::UNAVAILABLE));
        assert_eq!(rt.stop_all(0), Err(code::UNAVAILABLE));
    }

    #[test]
    fn pairing_needs_the_owners_window_and_takes_one_request() {
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut rt = runtime(&file, &counts);
        rt.set_enabled(true, 0).unwrap();
        let (_, refused) = pair_frame(rt.host(), "Sneaky", 1, 1);
        assert_eq!(refused["error"], PAIRING_CLOSED);
        assert!(rt.pending(1).unwrap().is_empty());

        let open = rt.open_pairing(2).unwrap();
        assert_eq!(open.pairing_open_s, Some(u16::try_from(PAIRING_WINDOW_MS / 1000).unwrap()));
        let (_, asked) = pair_frame(rt.host(), "Desk", 3, 3);
        let id = asked["pair"]["id"].as_str().unwrap().to_owned();
        let (_, second) = pair_frame(rt.host(), "Other", 4, 4);
        assert_eq!(second["error"], PAIRING_TAKEN);
        let pending = rt.pending(5).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!((pending[0].id.as_str(), pending[0].name.as_str(), pending[0].words.len(), pending[0].others_refused), (id.as_str(), "Desk", 6, 1));
        assert!(pending[0].expires_in_s <= u16::try_from(REQUEST_TTL_MS / 1000).unwrap());
        assert_eq!(rt.status(5).waiting, 1);

        assert_eq!(rt.approve(&id, &[], R2Preset::Counts, 6), Err(code::NO_TOPICS));
        let client = rt.approve(&id, &[Topic::Node, Topic::Inbox], R2Preset::Rounded, 7).unwrap();
        assert_eq!((client.name.as_str(), client.preset), ("Desk", R2Preset::Rounded));
        let status = rt.status(8);
        assert_eq!((status.pairing_open_s, status.waiting, status.clients), (None, 0, 1), "approve closes the window");
        let (_, late) = pair_frame(rt.host(), "Late", 5, 9);
        assert_eq!(late["error"], PAIRING_CLOSED);

        // Deny closes it too.
        rt.open_pairing(10).unwrap();
        let (_, asked) = pair_frame(rt.host(), "Notes", 6, 11);
        assert!(rt.deny(asked["pair"]["id"].as_str().unwrap(), 12).unwrap());
        assert_eq!(rt.status(12).pairing_open_s, None);
        // And the owner can cancel an empty window.
        rt.open_pairing(13).unwrap();
        assert_eq!(rt.close_pairing(14).unwrap().pairing_open_s, None);

        let audit = rt.audit(15).unwrap();
        let refusals = audit.rows.iter().filter(|row| row.tool == PAIRING_REFUSED_TOOL).count();
        assert_eq!(refusals, 3, "outside the window twice, and the second request in one window");
        assert!(audit.rows.iter().all(|row| row.outcome == "not_authorised"));
    }

    #[test]
    fn approve_revoke_and_save_again_over_a_file_that_fails() {
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut rt = runtime(&file, &counts);
        rt.set_enabled(true, 0).unwrap();
        rt.open_pairing(0).unwrap();
        let (_, asked) = pair_frame(rt.host(), "Desk", 3, 1);
        let id = asked["pair"]["id"].as_str().unwrap().to_owned();

        file.fail(true);
        assert_eq!(rt.approve(&id, &[Topic::Node], R2Preset::Counts, 2), Err(code::NOT_SAVED));
        assert!(rt.clients().unwrap().is_empty(), "nothing approved");
        assert_eq!(rt.pending(3).unwrap().len(), 1, "the request still waits, so the owner can try again");
        file.fail(false);
        rt.approve(&id, &[Topic::Node], R2Preset::Counts, 4).unwrap();

        file.fail(true);
        assert_eq!(rt.revoke(&id).unwrap(), Saved { saved: false });
        assert!(rt.status(5).unsaved_revoke);
        assert_eq!(hello(&rt, &id, 6)["error"], "unknown client", "refused now, though not on file");
        assert_eq!(rt.revoke(&id), Err(code::UNKNOWN), "cannot be revoked twice");
        assert_eq!(rt.save_again().unwrap(), Saved { saved: false });
        file.fail(false);
        assert_eq!(rt.save_again().unwrap(), Saved { saved: true });
        let status = rt.status(7);
        assert!(!status.unsaved_revoke && status.start_error.is_none());
        let records = store::load(&file, Some(&SEALER)).unwrap();
        assert!(records.is_empty(), "the removal is on file");
        assert_eq!(rt.revoke("mcp-ffff"), Err(code::UNKNOWN));
    }

    #[test]
    fn save_again_before_anything_was_loaded_reads_the_file_first() {
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut first = runtime(&file, &counts);
        let (id, _) = approved(&mut first, R2Preset::Counts);
        drop(first);
        // A restart: the first call is "save again" (or an approval of nothing).
        let before = file.0.lock().unwrap().0.clone();
        let mut rt = runtime(&file, &counts);
        assert_eq!(rt.approve("mcp-none", &[Topic::Node], R2Preset::Counts, 9), Err(code::UNKNOWN));
        assert_eq!(rt.save_again().unwrap(), Saved { saved: true });
        assert_eq!(file.0.lock().unwrap().0, before, "the file is unchanged");
        let records = store::load(&file, Some(&SEALER)).unwrap();
        assert_eq!(records.iter().map(|record| record.id.as_str()).collect::<Vec<_>>(), [id.as_str()], "the client is still on file");
        // A file that does not load is never saved over.
        file.put(b"tampered");
        let mut rt = runtime(&file, &counts);
        assert_eq!(rt.save_again(), Err(code::BLOCKED));
        assert_eq!(file.0.lock().unwrap().0.as_deref(), Some(&b"tampered"[..]));
    }

    #[test]
    fn an_audit_file_that_cannot_open_is_a_start_failure() {
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut rt = runtime(&file, &counts);
        rt.config.open_audit = Box::new(|_| Err(io::Error::other("no audit file")));
        assert_eq!(rt.set_enabled(true, 0), Err(code::START_FAILED));
        let status = rt.status(0);
        assert_eq!((status.enabled, status.start_error), (false, Some(code::START_FAILED)));
        assert_eq!(counts.started.load(Ordering::SeqCst), 0, "nothing listens");
    }

    #[test]
    fn a_panic_mid_command_turns_the_switch_off_once_and_keeps_the_file_and_the_revokes() {
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut rt = runtime(&file, &counts);
        let (first, _) = approved(&mut rt, R2Preset::Counts);
        rt.open_pairing(20).unwrap();
        let (_, asked) = pair_frame(rt.host(), "Notes", 5, 21);
        let second = asked["pair"]["id"].as_str().unwrap().to_owned();
        rt.approve(&second, &[Topic::Node], R2Preset::Counts, 22).unwrap();
        file.fail(true);
        assert_eq!(rt.revoke(&second).unwrap(), Saved { saved: false }, "revoked in memory only");
        let on_file = file.0.lock().unwrap().0.clone();

        let guarded = Guarded::new(rt);
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guarded.with(|_runtime| -> Result<(), &'static str> { panic!("a command that panics midway") })
        }));
        assert!(panicked.is_err());

        assert_eq!(guarded.with(|runtime| Ok(runtime.status(30))), Err(code::RECOVERED), "said once");
        assert_eq!(counts.stopped.load(Ordering::SeqCst), 1, "the listener is stopped");
        assert_eq!(file.0.lock().unwrap().0, on_file, "the clients file is untouched");
        let status = guarded.with(|runtime| Ok(runtime.status(31))).unwrap();
        assert_eq!((status.enabled, status.clients, status.unsaved_revoke), (false, 1, true), "read again, the revoke kept");

        // The removal is not on file: it stays off, and the removal still holds.
        assert_eq!(guarded.with(|runtime| runtime.set_enabled(true, 32)), Err(code::REMOVAL_NOT_SAVED));
        assert_eq!(guarded.with(|runtime| Ok(hello(runtime, &second, 33))).unwrap()["error"], "unknown client");
        assert!(guarded.with(|runtime| Ok(hello(runtime, &first, 34))).unwrap()["challenge"].is_string());
        // Back on once the file agrees: the removal is saved first.
        file.fail(false);
        assert!(guarded.with(|runtime| runtime.set_enabled(true, 35)).unwrap().enabled);
        assert_eq!(guarded.with(|runtime| Ok(hello(runtime, &second, 36))).unwrap()["error"], "unknown client");
        let records = store::load(&file, Some(&SEALER)).unwrap();
        assert!(records.iter().all(|record| record.id != second), "the removal is on file now");
        assert!(records.iter().any(|record| record.id == first));
    }

    #[test]
    fn revokes_carried_over_a_recovery_survive_a_blocked_load_until_saved() {
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut rt = runtime(&file, &counts);
        let (first, _) = approved(&mut rt, R2Preset::Counts);
        rt.open_pairing(20).unwrap();
        let (_, asked) = pair_frame(rt.host(), "Notes", 5, 21);
        let second = asked["pair"]["id"].as_str().unwrap().to_owned();
        rt.approve(&second, &[Topic::Node], R2Preset::Counts, 22).unwrap();
        let good = file.0.lock().unwrap().0.clone().unwrap();
        file.fail(true);
        assert_eq!(rt.revoke(&second).unwrap(), Saved { saved: false });

        let guarded = Guarded::new(rt);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guarded.with(|_runtime| -> Result<(), &'static str> { panic!("a command that panics midway") })
        }));
        assert_eq!(guarded.with(|runtime| Ok(runtime.status(30))), Err(code::RECOVERED));

        // The first load after the recovery is blocked: no records to revoke.
        file.put(b"tampered");
        assert_eq!(guarded.with(|runtime| Ok(runtime.status(31))).unwrap().store, "blocked");
        assert_eq!(guarded.with(|runtime| runtime.set_enabled(true, 32)), Err(code::BLOCKED));
        // The file is good again: the next load still removes the client, and
        // the switch stays off while that removal cannot be saved.
        file.put(&good);
        assert_eq!(guarded.with(|runtime| runtime.set_enabled(true, 33)), Err(code::REMOVAL_NOT_SAVED));
        assert_eq!(guarded.with(|runtime| Ok(hello(runtime, &second, 34))).unwrap()["error"], "unknown client");
        assert!(guarded.with(|runtime| Ok(hello(runtime, &first, 35))).unwrap()["challenge"].is_string());
        assert!(guarded.with(|runtime| Ok(runtime.status(36))).unwrap().unsaved_revoke);

        // Kept until a save works; then on file, and nothing is carried any more.
        assert_eq!(guarded.with(|runtime| runtime.save_again()).unwrap(), Saved { saved: false });
        file.fail(false);
        assert_eq!(guarded.with(|runtime| runtime.save_again()).unwrap(), Saved { saved: true });
        assert!(store::load(&file, Some(&SEALER)).unwrap().iter().all(|record| record.id != second));
        assert!(guarded.with(|runtime| Ok(runtime.carry_revokes.is_empty())).unwrap());
    }

    #[test]
    fn revokes_carried_over_a_recovery_hold_after_starting_over_and_a_restored_file() {
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let dir = std::env::temp_dir().join(format!("bsm-{}-carry", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut rt = runtime_with(dir.clone(), Some(&SEALER), &file, &counts);
        let (id, _) = approved(&mut rt, R2Preset::Counts);
        let good = file.0.lock().unwrap().0.clone().unwrap();
        file.fail(true);
        assert_eq!(rt.revoke(&id).unwrap(), Saved { saved: false });
        let guarded = Guarded::new(rt);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            guarded.with(|_runtime| -> Result<(), &'static str> { panic!("a command that panics midway") })
        }));
        assert_eq!(guarded.with(|runtime| Ok(runtime.status(30))), Err(code::RECOVERED));

        // Blocked, started over (no clients), then the old file comes back and is loaded on a restart-like reload.
        file.put(b"tampered");
        assert_eq!(guarded.with(|runtime| Ok(runtime.status(31))).unwrap().store, "blocked");
        guarded.with(|runtime| runtime.reset_clients(true, 32)).unwrap();
        file.put(&good);
        assert_eq!(guarded.with(|runtime| {
            runtime.loaded = false;
            runtime.set_enabled(true, 33)
        }), Err(code::REMOVAL_NOT_SAVED), "the old file lists the client: it stays off");
        assert_eq!(guarded.with(|runtime| Ok(hello(runtime, &id, 34))).unwrap()["error"], "unknown client", "still refused");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tick_that_cannot_start_leaves_the_switch_off() {
        fn no_thread(_work: Box<dyn FnOnce() + Send>) -> io::Result<JoinHandle<()>> {
            Err(io::Error::other("no thread for this test"))
        }
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut rt = runtime(&file, &counts);
        rt.spawn_tick = no_thread;
        assert_eq!(rt.set_enabled(true, 0), Err(code::START_FAILED));
        assert_eq!((counts.started.load(Ordering::SeqCst), counts.stopped.load(Ordering::SeqCst)), (1, 1), "the listener is stopped again");
        let status = rt.status(0);
        assert_eq!((status.enabled, status.start_error), (false, Some(code::START_FAILED)));
        assert_eq!(rt.open_pairing(0), Err(code::UNAVAILABLE));
        rt.spawn_tick = spawn_tick;
        let status = rt.set_enabled(true, 1).unwrap();
        assert_eq!((status.enabled, status.start_error), (true, None));
    }

    #[test]
    fn only_the_open_windows_own_request_can_be_approved() {
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut rt = runtime(&file, &counts);
        rt.set_enabled(true, 0).unwrap();
        // A request no window took (made directly on the host).
        let stray = rt.host().lock().unwrap().pairing.request("Stray", &[1u8; 32], 1).unwrap().id;
        assert_eq!(rt.approve(&stray, &[Topic::Node], R2Preset::Counts, 2), Err(code::UNKNOWN));
        rt.open_pairing(3).unwrap();
        assert_eq!(rt.approve(&stray, &[Topic::Node], R2Preset::Counts, 4), Err(code::UNKNOWN), "not this window's request");
        assert!(rt.clients().unwrap().is_empty());
        assert_eq!(file.0.lock().unwrap().0, None, "nothing was saved");
    }

    #[test]
    fn a_refused_pairing_names_no_client_even_with_a_known_id_as_its_name() {
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut rt = runtime(&file, &counts);
        let (id, _) = approved(&mut rt, R2Preset::Counts);
        let (_, refused) = pair_frame(rt.host(), &id, 9, 10);
        assert_eq!(refused["error"], PAIRING_CLOSED);
        assert_eq!(hello(&rt, "mcp-0000", 11)["error"], "unknown client");
        let page = rt.audit(12).unwrap();
        let pairing = page.rows.iter().find(|row| row.tool == PAIRING_REFUSED_TOOL).expect("the refused pairing");
        assert_eq!(pairing.client, None, "a declared name proves nothing");
        assert_eq!(page.rows.iter().filter(|row| row.client.is_some()).count(), 0);
    }

    #[test]
    fn denying_another_id_leaves_the_owners_window_open() {
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut rt = runtime(&file, &counts);
        rt.set_enabled(true, 0).unwrap();
        rt.open_pairing(0).unwrap();
        // An empty window, then the same window with its request: a stale or unknown id changes nothing.
        assert!(!rt.deny("mcp-stale", 1).unwrap());
        assert!(rt.status(1).pairing_open_s.is_some(), "the empty window stays open");
        let (_, asked) = pair_frame(rt.host(), "Desk", 3, 2);
        let id = asked["pair"]["id"].as_str().unwrap().to_owned();
        assert!(!rt.deny("mcp-stale", 3).unwrap());
        let status = rt.status(3);
        assert_eq!((status.waiting, status.pairing_open_s.is_some()), (1, true), "the request still waits");
        // Denying the window's own request ends it.
        assert!(rt.deny(&id, 4).unwrap());
        let status = rt.status(4);
        assert_eq!((status.waiting, status.pairing_open_s), (0, None));
    }

    #[test]
    fn any_later_save_clears_an_unsaved_revoke() {
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut rt = runtime(&file, &counts);
        let (first, _) = approved(&mut rt, R2Preset::Counts);
        rt.open_pairing(5).unwrap();
        let (_, asked) = pair_frame(rt.host(), "Notes", 5, 6);
        let second = asked["pair"]["id"].as_str().unwrap().to_owned();
        rt.approve(&second, &[Topic::Node], R2Preset::Counts, 7).unwrap();

        file.fail(true);
        assert_eq!(rt.revoke(&first).unwrap(), Saved { saved: false });
        assert!(rt.status(10).unsaved_revoke);
        // A second removal that fails changes nothing more; one that saves carries both.
        assert_eq!(rt.revoke(&second).unwrap(), Saved { saved: false });
        file.fail(false);
        assert_eq!(rt.save_again().unwrap(), Saved { saved: true });
        assert!(!rt.status(11).unsaved_revoke);
        assert!(store::load(&file, Some(&SEALER)).unwrap().is_empty(), "every removal is on file");
        assert!(rt.set_enabled(true, 12).unwrap().enabled);
    }

    #[test]
    fn approving_past_the_cap_is_refused_with_its_own_code() {
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut rt = runtime(&file, &counts);
        let _ = approved(&mut rt, R2Preset::Counts);
        for n in 1..store::MAX_CLIENTS {
            rt.open_pairing(10).unwrap();
            let (_, asked) = pair_frame(rt.host(), "Desk", 10 + n as u8, 11);
            rt.approve(asked["pair"]["id"].as_str().unwrap(), &[Topic::Node], R2Preset::Counts, 12).unwrap();
        }
        rt.open_pairing(20).unwrap();
        let (_, asked) = pair_frame(rt.host(), "One more", 99, 21);
        let id = asked["pair"]["id"].as_str().unwrap().to_owned();
        assert_eq!(rt.approve(&id, &[Topic::Node], R2Preset::Counts, 22), Err(code::TOO_MANY_CLIENTS));
        assert_eq!(rt.status(22).clients as usize, store::MAX_CLIENTS);
    }

    #[test]
    fn an_unreadable_file_keeps_it_off_until_the_owner_moves_it_aside() {
        let dir = std::env::temp_dir().join(format!("bsm-{}-reset", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(store::FILE_NAME), b"tampered").unwrap();
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        file.put(b"tampered");
        let mut rt = runtime_with(dir.clone(), Some(&SEALER), &file, &counts);

        assert_eq!(rt.status(0).store, "blocked");
        assert_eq!(rt.set_enabled(true, 0), Err(code::BLOCKED));
        assert_eq!(counts.started.load(Ordering::SeqCst), 0, "nothing listens");
        assert!(!rt.status(0).enabled);
        assert_eq!(rt.reset_clients(false, 1), Err(code::UNAVAILABLE), "only confirmed");

        let status = rt.reset_clients(true, 2).unwrap();
        assert_eq!(status.store, "empty");
        assert!(!dir.join(store::FILE_NAME).exists());
        let aside = dir.join(format!("{}.unreadable-2", store::FILE_NAME));
        assert_eq!(std::fs::read(&aside).unwrap(), b"tampered", "kept as it was");
        assert!(rt.set_enabled(true, 3).unwrap().enabled);
        assert_eq!(rt.reset_clients(true, 4), Err(code::UNAVAILABLE), "only while blocked");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_audit_names_clients_removed_ones_included_newest_first_at_most_200() {
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut rt = runtime(&file, &counts);
        let (id, secret) = approved(&mut rt, R2Preset::Counts);
        // A session and one read, then a removal and a refused hello.
        {
            let mut host = rt.host().lock().unwrap();
            let mut conn = Conn::Start;
            let step = host.on_frame(&mut conn, json!({"hello": id}).to_string().as_bytes(), 10, &Quiet);
            let reply: Value = serde_json::from_slice(step.reply.unwrap().strip_suffix(b"\n").unwrap()).unwrap();
            let challenge: [u8; 32] = hex::decode(reply["challenge"].as_str().unwrap()).unwrap().try_into().unwrap();
            let signature = json!({"signature": hex::encode(sign(&secret, &id, &challenge))}).to_string();
            host.on_frame(&mut conn, signature.as_bytes(), 11, &Quiet);
            host.on_frame(&mut conn, br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_node"}}"#, 12, &Quiet);
        }
        rt.revoke(&id).unwrap();
        assert_eq!(hello(&rt, &id, 13)["error"], "unknown client");
        assert_eq!(hello(&rt, "mcp-0000", 14)["error"], "unknown client");

        let page = rt.audit(15).unwrap();
        let seen: Vec<_> = page.rows.iter().map(|row| (row.client.clone(), row.tool.as_str(), row.outcome)).collect();
        assert_eq!(seen, [
            (None, HANDSHAKE_AUDIT_TOOL, "not_authorised"),
            (Some("Desk".to_owned()), HANDSHAKE_AUDIT_TOOL, "not_authorised"),
            (Some("Desk".to_owned()), REMOVED_AUDIT_TOOL, "removed"),
            (Some("Desk".to_owned()), "read_node", "read"),
        ], "newest first; a removed client keeps its name");
        assert_eq!(page.unreadable, 0);

        {
            let mut host = rt.host().lock().unwrap();
            for at in 100..400 {
                host.audit.push(AuditRow { at_ms: at, client: id.clone(), tool: "read_node".into(), arguments: String::new(), outcome: Outcome::Read });
            }
        }
        let page = rt.audit(500).unwrap();
        assert_eq!(page.rows.len(), SHOW_ROWS);
        assert_eq!(page.rows[0].at_ms, 399);
        assert!(page.rows.windows(2).all(|pair| pair[0].at_ms >= pair[1].at_ms));
    }

    #[test]
    fn the_tick_moves_rows_off_the_host_and_tells_the_window_about_a_request() {
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut rt = runtime_clocked(std::env::temp_dir().join("bsm-unused"), Some(&SEALER), &file, &counts, Arc::new(super::super::runner::now_ms));
        let now = super::super::runner::now_ms();
        rt.set_enabled(true, now).unwrap();
        rt.open_pairing(now).unwrap();
        let before = counts.notified.load(Ordering::SeqCst);
        let _ = pair_frame(rt.host(), "Desk", 3, super::super::runner::now_ms());
        let _ = hello(&rt, "mcp-0000", super::super::runner::now_ms());
        let started = std::time::Instant::now();
        while counts.notified.load(Ordering::SeqCst) == before || !rt.host().lock().unwrap().audit.is_empty() {
            assert!(started.elapsed() < Duration::from_secs(10), "the tick ran");
            std::thread::sleep(Duration::from_millis(20));
        }
        rt.set_enabled(false, super::super::runner::now_ms()).unwrap();
        assert_eq!(rt.audit(super::super::runner::now_ms()).unwrap().rows.len(), 1, "the refused hello is in the log");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_switch_starts_and_stops_the_real_listener() {
        let dir = std::env::temp_dir().join(format!("bsm-{}-rt", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
        let mut rt = runtime_clocked(dir.clone(), Some(&SEALER), &file, &counts, Arc::new(super::super::runner::now_ms));
        rt.config.start = platform_listener();
        let socket = dir.join(crate::mcp::endpoint::unix::SOCKET_NAME);
        assert!(!socket.exists(), "nothing listens before the switch");
        let now = super::super::runner::now_ms();
        rt.set_enabled(true, now).unwrap();
        let client = std::os::unix::net::UnixStream::connect(&socket).expect("listening");
        client.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        rt.set_enabled(false, now).unwrap();
        assert!(!socket.exists(), "the socket is removed");
        assert_eq!(std::io::Read::read(&mut &client, &mut [0u8; 1]).unwrap(), 0, "the live connection is closed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The switch over the real Windows pipe, with the real shim.
    #[cfg(windows)]
    mod windows_runtime_tests {
        use super::*;
        use crate::mcp::endpoint::read_frame;
        use crate::mcp::runner::{now_ms, Deadlines, Runner};
        use crate::mcp::server::MAX_FRAME_BYTES;
        use bitsov_ffi::win_private::pipe::PipeHalf;
        use std::io::{BufReader, Read, Write};

        const WAIT: Duration = Duration::from_secs(10);
        /// `ERROR_PIPE_BUSY`: every instance is taken for a moment.
        const PIPE_BUSY: i32 = 231;

        type Client = (BufReader<PipeHalf>, PipeHalf);

        fn try_connect(name: &str) -> io::Result<Client> {
            let start = std::time::Instant::now();
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

        fn lists_tools(client: &mut Client) -> usize {
            client.1.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n").unwrap();
            let frame = read_frame(&mut client.0, MAX_FRAME_BYTES).unwrap().expect("a reply");
            let reply: Value = serde_json::from_slice(&frame).unwrap();
            reply["result"]["tools"].as_array().map_or(0, Vec::len)
        }

        fn session(name: &str, key: &bitsov_mcp::ClientKey) -> Client {
            let (mut reader, mut writer) = try_connect(name).unwrap();
            bitsov_mcp::open_session(&mut reader, &mut writer, key).unwrap();
            (reader, writer)
        }

        #[test]
        fn the_switch_starts_and_stops_the_real_pipe() {
            let name = format!(r"\\.\pipe\bitsov-mcp-rt-{}-onoff", std::process::id());
            let (file, counts) = (SharedFile::default(), Arc::new(Counts::default()));
            let dir = std::env::temp_dir().join(format!("bsm-{}-won", std::process::id()));
            let mut rt = runtime_clocked(dir, Some(&SEALER), &file, &counts, Arc::new(now_ms));
            let pipe = name.clone();
            rt.config.start = Box::new(move |_, host, source| {
                Ok(Box::new(Runner::start_named(&pipe, host, source, Deadlines::default())?) as Box<dyn Listener>)
            });

            rt.set_enabled(true, now_ms()).unwrap();
            rt.open_pairing(now_ms()).unwrap();
            let (mut reader, mut writer) = try_connect(&name).unwrap();
            let outcome = bitsov_mcp::pair(&mut reader, &mut writer, "Desk assistant", &[8u8; 32], |_| {}, || {
                let now = now_ms();
                if let Some(waiting) = rt.pending(now).unwrap().first().cloned() {
                    rt.approve(&waiting.id, &[Topic::Node], R2Preset::Counts, now).unwrap();
                }
                true
            }).unwrap();
            let bitsov_mcp::PairOutcome::Approved(key) = outcome else { panic!("approved") };
            let mut live = session(&name, &key);
            assert_eq!(lists_tools(&mut live), 1, "only the approved topic");

            rt.set_enabled(false, now_ms()).unwrap();
            assert!(matches!(live.0.read(&mut [0u8; 1]), Ok(0) | Err(_)), "the live session is closed");
            let refused = match bitsov_mcp::windows::connect(&name) {
                Err(_) => true,
                Ok((mut reader, _)) => matches!(reader.read(&mut [0u8; 1]), Ok(0) | Err(_)),
            };
            assert!(refused, "nothing listens while off");

            rt.set_enabled(true, now_ms()).unwrap();
            let mut again = session(&name, &key);
            assert_eq!(lists_tools(&mut again), 1, "on again, the same client works");
            rt.set_enabled(false, now_ms()).unwrap();
        }
    }

    #[test]
    fn approve_takes_counts_or_rounded_and_never_exact() {
        assert_eq!(serde_json::from_value::<R2Preset>(json!("rounded")).unwrap(), R2Preset::Rounded);
        assert_eq!(serde_json::from_value::<R2Preset>(json!("counts")).unwrap(), R2Preset::Counts);
        assert!(serde_json::from_value::<R2Preset>(json!("exact")).is_err());
    }
}
