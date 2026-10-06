//! Safe macOS process primitive for the sandboxed model launcher.

use std::ffi::{CString, OsStr, OsString};
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

unsafe extern "C" {
    fn posix_spawn_file_actions_addchdir_np(
        actions: *mut libc::posix_spawn_file_actions_t,
        path: *const libc::c_char,
    ) -> libc::c_int;
}

#[derive(Debug)]
pub enum SpawnError {
    Argument,
    Io(io::Error),
}

/// A child whose process group remains owned until drop.
///
/// The leader is observed with `WNOWAIT`, so its process-group id cannot be
/// reused before drop kills any descendants and reaps the leader.
pub struct Child {
    pid: libc::pid_t,
    stdin: File,
    stdout: File,
    stderr: File,
    exit: Option<i32>,
}

impl Child {
    pub fn id(&self) -> u32 {
        self.pid as u32
    }

    pub fn stdin(&mut self) -> &mut File {
        &mut self.stdin
    }

    pub fn stdout(&mut self) -> &mut File {
        &mut self.stdout
    }

    pub fn stderr(&mut self) -> &mut File {
        &mut self.stderr
    }

    pub fn wait(&mut self) -> io::Result<i32> {
        self.wait_blocking()
    }

    pub fn wait_timeout(&mut self, limit: Duration) -> io::Result<i32> {
        let start = Instant::now();
        loop {
            if let Some(code) = self.poll()? {
                return Ok(code);
            }
            if start.elapsed() >= limit {
                self.kill_group();
                return self.wait_blocking();
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn poll(&mut self) -> io::Result<Option<i32>> {
        if let Some(code) = self.exit {
            return Ok(Some(code));
        }
        self.observe(true)
    }

    fn wait_blocking(&mut self) -> io::Result<i32> {
        if let Some(code) = self.exit {
            return Ok(code);
        }
        match self.observe(false)? {
            Some(code) => Ok(code),
            None => Err(io::Error::other("waitid returned no status")),
        }
    }

    fn observe(&mut self, nonblocking: bool) -> io::Result<Option<i32>> {
        if self.pid <= 0 {
            return Err(io::Error::other("model process is not running"));
        }
        let mut flags = libc::WEXITED | libc::WNOWAIT;
        if nonblocking {
            flags |= libc::WNOHANG;
        }
        loop {
            // Darwin leaves siginfo untouched when WNOHANG finds no status.
            let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
            // SAFETY: `info` points to writable storage and the remaining
            // arguments identify the child process owned by this value.
            let rc = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.pid as libc::id_t,
                    info.as_mut_ptr(),
                    flags,
                )
            };
            if rc == 0 {
                // SAFETY: waitid returned success and initialized `info`.
                let info = unsafe { info.assume_init() };
                if info.si_signo == libc::SIGCHLD {
                    let code = decode_siginfo(&info);
                    self.exit = Some(code);
                    return Ok(Some(code));
                }
                if info.si_signo == 0 {
                    return if nonblocking {
                        Ok(None)
                    } else {
                        Err(io::Error::other("waitid returned no status"))
                    };
                }
                return Err(io::Error::other(format!(
                    "unexpected si_signo from waitid: {}",
                    info.si_signo
                )));
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            if error.raw_os_error() == Some(libc::ECHILD) {
                self.pid = 0;
            }
            return Err(error);
        }
    }

    fn kill_group(&self) {
        if self.pid > 0 {
            // SAFETY: a negative owned leader PID addresses its process group.
            unsafe {
                libc::kill(-self.pid, libc::SIGKILL);
            }
        }
    }

    fn reap_leader(&mut self) {
        if self.pid <= 0 {
            return;
        }
        let leader = self.pid;
        let mut status = 0;
        loop {
            // SAFETY: `status` is writable and `leader` is this value's child.
            let pid = unsafe { libc::waitpid(leader, &mut status, 0) };
            if pid == leader {
                if self.exit.is_none() {
                    self.exit = Some(decode(status));
                }
                self.pid = 0;
                return;
            }
            if pid < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                self.pid = 0;
                return;
            }
        }
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        if self.pid <= 0 {
            return;
        }
        self.kill_group();
        self.reap_leader();
    }
}

/// Spawn one process in a fresh process group with only stdin/stdout/stderr
/// inherited. `arguments` excludes argv[0]; `environment` entries are `K=V`.
pub fn spawn(
    program: &OsStr,
    arguments: &[OsString],
    current_dir: &Path,
    environment: &[OsString],
) -> Result<Child, SpawnError> {
    let (stdin_r, stdin_w) = anon_pipe().map_err(SpawnError::Io)?;
    let (stdout_r, stdout_w) = anon_pipe().map_err(SpawnError::Io)?;
    let (stderr_r, stderr_w) = anon_pipe().map_err(SpawnError::Io)?;

    let mut state = SpawnState::new();
    // SAFETY: each pointer addresses uninitialized storage of the exact native
    // type. Success is recorded so drop destroys only initialized values.
    cvt(unsafe { libc::posix_spawnattr_init(state.attr.as_mut_ptr()) }).map_err(SpawnError::Io)?;
    state.attr_ok = true;
    // SAFETY: same initialization contract as above.
    cvt(unsafe { libc::posix_spawn_file_actions_init(state.actions.as_mut_ptr()) })
        .map_err(SpawnError::Io)?;
    state.actions_ok = true;

    let mut default_set = std::mem::MaybeUninit::<libc::sigset_t>::uninit();
    // SAFETY: `default_set` is valid output storage.
    if unsafe { libc::sigemptyset(default_set.as_mut_ptr()) } != 0 {
        return Err(SpawnError::Io(io::Error::last_os_error()));
    }
    // SAFETY: sigemptyset initialized the set.
    if unsafe { libc::sigaddset(default_set.as_mut_ptr(), libc::SIGPIPE) } != 0 {
        return Err(SpawnError::Io(io::Error::last_os_error()));
    }
    // SAFETY: both spawn attributes and signal set are initialized.
    cvt(unsafe {
        libc::posix_spawnattr_setsigdefault(state.attr.as_mut_ptr(), default_set.as_ptr())
    })
    .map_err(SpawnError::Io)?;
    // SAFETY: the spawn attributes are initialized.
    cvt(unsafe { libc::posix_spawnattr_setpgroup(state.attr.as_mut_ptr(), 0) })
        .map_err(SpawnError::Io)?;
    let flags = (libc::POSIX_SPAWN_SETPGROUP
        | libc::POSIX_SPAWN_SETSIGDEF
        | libc::POSIX_SPAWN_CLOEXEC_DEFAULT) as libc::c_short;
    // SAFETY: the spawn attributes are initialized.
    cvt(unsafe { libc::posix_spawnattr_setflags(state.attr.as_mut_ptr(), flags) })
        .map_err(SpawnError::Io)?;

    map_fd(
        state.actions.as_mut_ptr(),
        stdin_r.as_raw_fd(),
        libc::STDIN_FILENO,
    )
    .map_err(SpawnError::Io)?;
    map_fd(
        state.actions.as_mut_ptr(),
        stdout_w.as_raw_fd(),
        libc::STDOUT_FILENO,
    )
    .map_err(SpawnError::Io)?;
    map_fd(
        state.actions.as_mut_ptr(),
        stderr_w.as_raw_fd(),
        libc::STDERR_FILENO,
    )
    .map_err(SpawnError::Io)?;

    let cwd = c_os(current_dir.as_os_str()).map_err(|_| SpawnError::Argument)?;
    // SAFETY: actions are initialized and cwd is a live C string.
    cvt(unsafe { posix_spawn_file_actions_addchdir_np(state.actions.as_mut_ptr(), cwd.as_ptr()) })
        .map_err(SpawnError::Io)?;

    let mut owned = Vec::with_capacity(arguments.len() + 1);
    owned.push(c_os(program).map_err(|_| SpawnError::Argument)?);
    for argument in arguments {
        owned.push(c_os(argument).map_err(|_| SpawnError::Argument)?);
    }
    let mut argv: Vec<*mut libc::c_char> =
        owned.iter().map(|value| value.as_ptr() as *mut _).collect();
    argv.push(std::ptr::null_mut());

    let environment: Result<Vec<_>, _> = environment.iter().map(|value| c_os(value)).collect();
    let environment = environment.map_err(|_| SpawnError::Argument)?;
    let mut envp: Vec<*mut libc::c_char> = environment
        .iter()
        .map(|value| value.as_ptr() as *mut _)
        .collect();
    envp.push(std::ptr::null_mut());

    let executable = c_os(program).map_err(|_| SpawnError::Argument)?;
    let mut pid = 0;
    // SAFETY: all native state and pointer arrays are initialized, terminated
    // with null entries, and remain live for the synchronous spawn call.
    let rc = unsafe {
        libc::posix_spawn(
            &mut pid,
            executable.as_ptr(),
            state.actions.as_ptr(),
            state.attr.as_ptr(),
            argv.as_ptr(),
            envp.as_ptr(),
        )
    };
    if rc != 0 {
        return Err(SpawnError::Io(io::Error::from_raw_os_error(rc)));
    }
    if pid <= 0 {
        return Err(SpawnError::Io(io::Error::other(
            "posix_spawn returned no pid",
        )));
    }
    drop(stdin_r);
    drop(stdout_w);
    drop(stderr_w);
    Ok(Child {
        pid,
        stdin: stdin_w,
        stdout: stdout_r,
        stderr: stderr_r,
        exit: None,
    })
}

struct SpawnState {
    attr: std::mem::MaybeUninit<libc::posix_spawnattr_t>,
    actions: std::mem::MaybeUninit<libc::posix_spawn_file_actions_t>,
    attr_ok: bool,
    actions_ok: bool,
}

impl SpawnState {
    fn new() -> Self {
        Self {
            attr: std::mem::MaybeUninit::uninit(),
            actions: std::mem::MaybeUninit::uninit(),
            attr_ok: false,
            actions_ok: false,
        }
    }
}

impl Drop for SpawnState {
    fn drop(&mut self) {
        // SAFETY: the flags track successful initialization and each native
        // value is destroyed at most once.
        unsafe {
            if self.attr_ok {
                libc::posix_spawnattr_destroy(self.attr.as_mut_ptr());
            }
            if self.actions_ok {
                libc::posix_spawn_file_actions_destroy(self.actions.as_mut_ptr());
            }
        }
    }
}

fn map_fd(
    actions: *mut libc::posix_spawn_file_actions_t,
    source: libc::c_int,
    destination: libc::c_int,
) -> io::Result<()> {
    // SAFETY: actions are initialized and both descriptors are integers.
    cvt(unsafe { libc::posix_spawn_file_actions_adddup2(actions, source, destination) })?;
    if source != destination {
        // SAFETY: actions are initialized and source is a valid descriptor.
        cvt(unsafe { libc::posix_spawn_file_actions_addclose(actions, source) })?;
    }
    Ok(())
}

fn anon_pipe() -> io::Result<(File, File)> {
    let mut fds = [-1; 2];
    // SAFETY: fds points to two writable descriptor slots.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    for fd in fds {
        // SAFETY: each fd was created by pipe and remains open.
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
            let error = io::Error::last_os_error();
            // SAFETY: both descriptors are open and owned here.
            unsafe {
                libc::close(fds[0]);
                libc::close(fds[1]);
            }
            return Err(error);
        }
    }
    // SAFETY: ownership of each open descriptor transfers to exactly one File.
    Ok(unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) })
}

fn cvt(code: libc::c_int) -> io::Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code))
    }
}

fn c_os(value: &OsStr) -> Result<CString, std::ffi::NulError> {
    CString::new(value.as_bytes())
}

fn decode(status: libc::c_int) -> i32 {
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        125
    }
}

fn decode_siginfo(info: &libc::siginfo_t) -> i32 {
    if info.si_code == libc::CLD_EXITED {
        info.si_status
    } else if info.si_code == libc::CLD_KILLED || info.si_code == libc::CLD_DUMPED {
        128 + info.si_status
    } else {
        125
    }
}

/// Duplicate a file descriptor without close-on-exec. Used to prove the
/// launcher closes unrelated inherited descriptors.
pub fn duplicate_inheritable(file: &File) -> io::Result<OwnedFd> {
    // SAFETY: the source descriptor is borrowed and valid for this call.
    let descriptor = unsafe { libc::dup(file.as_raw_fd()) };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: dup returned a new descriptor owned by this function.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

pub fn process_exists(pid: i32) -> bool {
    // SAFETY: signal 0 performs permission/existence checking only.
    unsafe { libc::kill(pid, 0) == 0 }
}

pub const SIGKILL: i32 = libc::SIGKILL;
