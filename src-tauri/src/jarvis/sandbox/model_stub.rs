//! Stub child for the macOS launch and deny tests.
//!
//! Not part of the app crate. The macOS tests compile this file with `rustc`
//! and exec it under `sandbox-exec`. It reports one line on stdout and does
//! not print file contents.

use std::io::{self, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

extern "C" {
    fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    fn fork() -> i32;
    fn getpid() -> i32;
    fn close(fd: i32) -> i32;
    fn kill(pid: i32, sig: i32) -> i32;
}

/// `F_GETFD` on macOS.
const F_GETFD: i32 = 1;
/// `SIGKILL`. Same value `libc::SIGKILL` has on macOS.
const SIGKILL: i32 = 9;

fn libc_close(fd: i32) {
    unsafe {
        let _ = close(fd);
    }
}

fn main() {
    let mut args = std::env::args();
    let _argv0 = args.next();
    let action = args.next().unwrap_or_default();
    let extra = args.next().unwrap_or_default();
    let result = match action.as_str() {
        "echo" => echo(),
        "read" => read_path(&extra),
        "stat" => stat_path(&extra),
        "write" => write_path(&extra),
        "connect" => connect(),
        "listen" => listen(),
        "udp" => udp(),
        "unix" => unix_bind(&extra),
        "fds" => fds(),
        "fork-linger" => fork_linger(),
        "fork-signal" => fork_signal(),
        _ => "unknown".to_string(),
    };
    report(&result);
    let code = if result == "unknown" { 2 } else { 0 };
    std::process::exit(code);
}

fn report(text: &str) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{text}");
    let _ = out.flush();
}

fn echo() -> String {
    let mut line = String::new();
    let _ = io::stdin().read_line(&mut line);
    let line = line.trim_end_matches(['\r', '\n']);
    format!("echo {line}")
}

fn read_path(path: &str) -> String {
    match std::fs::read(path) {
        Ok(_) => "ok".to_string(),
        Err(err) => class(err),
    }
}

fn stat_path(path: &str) -> String {
    match std::fs::metadata(path) {
        Ok(_) => "ok".to_string(),
        Err(err) => class(err),
    }
}

fn write_path(path: &str) -> String {
    match std::fs::write(path, b"written-by-stub\n") {
        Ok(()) => "ok".to_string(),
        Err(err) => class(err),
    }
}

fn connect() -> String {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 1));
    match TcpStream::connect_timeout(&addr, Duration::from_secs(2)) {
        Ok(_) => "ok".to_string(),
        Err(err) => class(err),
    }
}

fn listen() -> String {
    match TcpListener::bind("127.0.0.1:0") {
        Ok(_) => "ok".to_string(),
        Err(err) => class(err),
    }
}

fn udp() -> String {
    match UdpSocket::bind("127.0.0.1:0") {
        Ok(_) => "ok".to_string(),
        Err(err) => class(err),
    }
}

fn unix_bind(path: &str) -> String {
    match UnixListener::bind(path) {
        Ok(_) => "ok".to_string(),
        Err(err) => class(err),
    }
}

fn fds() -> String {
    let mut open = Vec::new();
    for fd in 0..512 {
        let rc = unsafe { fcntl(fd, F_GETFD) };
        if rc >= 0 {
            open.push(fd.to_string());
        }
    }
    format!("fds {}", open.join(","))
}

/// Fork a worker that stays alive after this leader exits normally.
fn fork_linger() -> String {
    fork_worker(|| {})
}

/// Fork a worker, then kill this leader with SIGKILL.
///
/// The worker must still be reaped when the launcher drops the child. The
/// leader does not return, so stdout may stay empty.
fn fork_signal() -> String {
    fork_worker(|| unsafe {
        let _ = kill(getpid(), SIGKILL);
    })
}

/// Fork a worker that stays alive, then run `finish` in the leader.
///
/// The worker writes `$TMPDIR/worker.pid` and closes the broker fds so the
/// parent's pipes can EOF when the leader exits. `finish` runs only after
/// that pid file is durable, and may exit the leader by signal.
fn fork_worker(finish: impl FnOnce()) -> String {
    match unsafe { fork() } {
        -1 => format!(
            "other {}",
            io::Error::last_os_error().raw_os_error().unwrap_or(0)
        ),
        0 => {
            // Detach from the broker pipes; otherwise Drop/wait tests hang on
            // stdout EOF while this worker still holds the write end.
            for fd in 0..=2 {
                libc_close(fd);
            }
            let pid = unsafe { getpid() };
            let path = worker_pid_path();
            let _ = std::fs::write(&path, format!("{pid}\n"));
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
        _ => {
            wait_for_worker_pid();
            finish();
            "forked".to_string()
        }
    }
}

fn worker_pid_path() -> PathBuf {
    PathBuf::from(std::env::var_os("TMPDIR").unwrap_or_default()).join("worker.pid")
}

fn wait_for_worker_pid() {
    let path = worker_pid_path();
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if worker_pid_ready(&path) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn worker_pid_ready(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    text.ends_with('\n') && text.trim().parse::<i32>().unwrap_or(0) > 1
}

fn class(err: io::Error) -> String {
    match err.kind() {
        io::ErrorKind::PermissionDenied => "denied".to_string(),
        io::ErrorKind::NotFound => "missing".to_string(),
        io::ErrorKind::ConnectionRefused => "refused".to_string(),
        io::ErrorKind::ConnectionReset => "reset".to_string(),
        io::ErrorKind::AddrInUse => "inuse".to_string(),
        io::ErrorKind::TimedOut => "timeout".to_string(),
        _ => format!("other {}", err.raw_os_error().unwrap_or(0)),
    }
}
