//! Start the local model under the J0 deny-by-default profile.
//!
//! `sandbox-exec -p` applies the rendered profile from an argument, so the
//! policy never sits in a path the confined child can overwrite. The child
//! inherits stdin and stdout as the only broker channel, and stderr for a
//! launch failure. Every other descriptor is closed with
//! `POSIX_SPAWN_CLOEXEC_DEFAULT` (Apple's `spawn.h`, `0x4000`). That is the
//! multithreaded equivalent of the spike's `PROC_PIDLISTFDS` sweep: calling
//! `proc_pidinfo` after `fork` can deadlock a process that already has other
//! threads.
//!
//! App Sandbox remains the fallback named in
//! `docs/spike/J0-MACOS-ISOLATION.md` §1 if Apple removes custom SBPL. It is
//! not this path. See `bitsov_app::jarvis::sandbox`.

#[cfg(target_os = "macos")]
#[allow(dead_code)]
mod macos {
    use std::ffi::{CString, OsStr, OsString};
    use std::fs::{self, File};
    use std::io::{self, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Component, Path, PathBuf};
    use std::thread;
    use std::time::{Duration, Instant};

    use bitsov_app::jarvis::sandbox::{
        default_keychain_dirs, render_profile, ProfileError, SandboxPaths,
    };

    const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

    extern "C" {
        fn posix_spawn_file_actions_addchdir_np(
            actions: *mut libc::posix_spawn_file_actions_t,
            path: *const libc::c_char,
        ) -> libc::c_int;
    }

    /// What to run, and the directories the profile allows or denies.
    ///
    /// `keychain_dirs` is added to [`default_keychain_dirs`]. The home
    /// directory, `/Users` and the Data-volume firmlink are always denied.
    #[derive(Debug, Clone)]
    pub struct LaunchRequest {
        pub program: PathBuf,
        pub args: Vec<OsString>,
        pub model_dir: PathBuf,
        pub scratch_dir: PathBuf,
        pub node_data_dir: PathBuf,
        pub home_dir: PathBuf,
        pub keychain_dirs: Vec<PathBuf>,
    }

    #[derive(Debug)]
    pub enum LaunchError {
        Profile(ProfileError),
        /// `/usr/bin/sandbox-exec` is not there. The model is not started.
        SandboxExecMissing,
        NotFound,
        Argument,
        Io(io::Error),
    }

    impl std::fmt::Display for LaunchError {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                LaunchError::Profile(err) => write!(formatter, "{err}"),
                LaunchError::SandboxExecMissing => {
                    formatter.write_str("sandbox-exec is missing; the model was not started")
                }
                LaunchError::NotFound => formatter.write_str("model launch path does not exist"),
                LaunchError::Argument => {
                    formatter.write_str("model launch argument contains a nul")
                }
                LaunchError::Io(err) => write!(formatter, "{err}"),
            }
        }
    }

    impl std::error::Error for LaunchError {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            match self {
                LaunchError::Profile(err) => Some(err),
                LaunchError::Io(err) => Some(err),
                LaunchError::SandboxExecMissing | LaunchError::NotFound | LaunchError::Argument => {
                    None
                }
            }
        }
    }

    impl From<ProfileError> for LaunchError {
        fn from(err: ProfileError) -> Self {
            LaunchError::Profile(err)
        }
    }

    /// The model process. Stdin and stdout are the broker pipe. Drop kills
    /// the process group if it is still running.
    pub struct ModelChild {
        pid: libc::pid_t,
        stdin: File,
        stdout: File,
        stderr: File,
        exit: Option<i32>,
    }

    impl ModelChild {
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

        pub fn wait(&mut self) -> Result<i32, LaunchError> {
            self.wait_blocking()
        }

        pub fn wait_timeout(&mut self, limit: Duration) -> Result<i32, LaunchError> {
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

        fn poll(&mut self) -> Result<Option<i32>, LaunchError> {
            if let Some(code) = self.exit {
                return Ok(Some(code));
            }
            loop {
                let mut status = 0;
                let pid = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) };
                if pid == 0 {
                    return Ok(None);
                }
                if pid == self.pid {
                    let code = decode(status);
                    self.exit = Some(code);
                    return Ok(Some(code));
                }
                let err = io::Error::last_os_error();
                if err.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                return Err(LaunchError::Io(err));
            }
        }

        fn wait_blocking(&mut self) -> Result<i32, LaunchError> {
            if let Some(code) = self.exit {
                return Ok(code);
            }
            loop {
                let mut status = 0;
                let pid = unsafe { libc::waitpid(self.pid, &mut status, 0) };
                if pid == self.pid {
                    let code = decode(status);
                    self.exit = Some(code);
                    return Ok(code);
                }
                let err = io::Error::last_os_error();
                if err.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                return Err(LaunchError::Io(err));
            }
        }

        fn kill_group(&self) {
            let pgid = unsafe { libc::getpgid(self.pid) };
            if pgid == self.pid {
                unsafe {
                    libc::kill(-self.pid, libc::SIGKILL);
                }
            }
            unsafe {
                libc::kill(self.pid, libc::SIGKILL);
            }
        }
    }

    impl Drop for ModelChild {
        fn drop(&mut self) {
            if self.exit.is_none() && self.pid > 0 {
                self.kill_group();
                let mut status = 0;
                loop {
                    let pid = unsafe { libc::waitpid(self.pid, &mut status, 0) };
                    if pid == self.pid {
                        self.exit = Some(decode(status));
                        break;
                    }
                    if pid < 0 {
                        let err = io::Error::last_os_error();
                        if err.raw_os_error() == Some(libc::EINTR) {
                            continue;
                        }
                        break;
                    }
                }
            }
        }
    }

    struct Prepared {
        program: PathBuf,
        args: Vec<OsString>,
        scratch_dir: PathBuf,
        home_dir: PathBuf,
        profile: String,
    }

    /// Spawn `program` under `sandbox-exec`. On any failure the program is
    /// not left running outside the profile.
    pub fn launch(request: &LaunchRequest) -> Result<ModelChild, LaunchError> {
        let prepared = prepare(request)?;
        if !Path::new(SANDBOX_EXEC).is_file() {
            return Err(LaunchError::SandboxExecMissing);
        }
        spawn(&prepared)
    }

    fn prepare(request: &LaunchRequest) -> Result<Prepared, LaunchError> {
        let program = canonicalize_file(&request.program)?;
        let exec_dir = program.parent().ok_or(LaunchError::NotFound)?.to_path_buf();
        let model_dir = canonicalize_dir(&request.model_dir)?;
        let scratch_dir = canonicalize_dir(&request.scratch_dir)?;
        let node_data_dir = canonicalize_dir(&request.node_data_dir)?;
        let home_dir = canonicalize_dir(&request.home_dir)?;
        let mut keychain_dirs = default_keychain_dirs(&home_dir);
        keychain_dirs.extend(request.keychain_dirs.iter().cloned());
        let mut normalized = Vec::with_capacity(keychain_dirs.len());
        for dir in keychain_dirs {
            normalized.push(normalize_keychain(&dir)?);
        }
        let paths = SandboxPaths {
            model_dir,
            scratch_dir: scratch_dir.clone(),
            exec_dir,
            home_dir: home_dir.clone(),
            keychain_dirs: normalized,
            node_data_dir,
        };
        let profile = render_profile(&paths)?;
        Ok(Prepared {
            program,
            args: request.args.clone(),
            scratch_dir,
            home_dir,
            profile,
        })
    }

    fn canonicalize_dir(path: &Path) -> Result<PathBuf, LaunchError> {
        let canon = fs::canonicalize(path).map_err(|_| LaunchError::NotFound)?;
        if !canon.is_dir() {
            return Err(LaunchError::NotFound);
        }
        Ok(canon)
    }

    fn canonicalize_file(path: &Path) -> Result<PathBuf, LaunchError> {
        let canon = fs::canonicalize(path).map_err(|_| LaunchError::NotFound)?;
        if !canon.is_file() {
            return Err(LaunchError::NotFound);
        }
        Ok(canon)
    }

    fn normalize_keychain(path: &Path) -> Result<PathBuf, LaunchError> {
        if let Ok(canon) = fs::canonicalize(path) {
            return Ok(canon);
        }
        if path.is_absolute()
            && !path
                .components()
                .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
        {
            return Ok(path.to_path_buf());
        }
        Err(LaunchError::NotFound)
    }

    fn spawn(prepared: &Prepared) -> Result<ModelChild, LaunchError> {
        let (stdin_r, stdin_w) = anon_pipe()?;
        let (stdout_r, stdout_w) = anon_pipe()?;
        let (stderr_r, stderr_w) = anon_pipe()?;

        let mut state = SpawnState::new();
        cvt(unsafe { libc::posix_spawnattr_init(state.attr.as_mut_ptr()) })?;
        state.attr_ok = true;
        cvt(unsafe { libc::posix_spawn_file_actions_init(state.actions.as_mut_ptr()) })?;
        state.actions_ok = true;

        let mut default_set = std::mem::MaybeUninit::<libc::sigset_t>::uninit();
        if unsafe { libc::sigemptyset(default_set.as_mut_ptr()) } != 0 {
            return Err(LaunchError::Io(io::Error::last_os_error()));
        }
        if unsafe { libc::sigaddset(default_set.as_mut_ptr(), libc::SIGPIPE) } != 0 {
            return Err(LaunchError::Io(io::Error::last_os_error()));
        }
        cvt(unsafe {
            libc::posix_spawnattr_setsigdefault(state.attr.as_mut_ptr(), default_set.as_ptr())
        })?;
        cvt(unsafe { libc::posix_spawnattr_setpgroup(state.attr.as_mut_ptr(), 0) })?;
        let flags = (libc::POSIX_SPAWN_SETPGROUP
            | libc::POSIX_SPAWN_SETSIGDEF
            | libc::POSIX_SPAWN_CLOEXEC_DEFAULT) as libc::c_short;
        cvt(unsafe { libc::posix_spawnattr_setflags(state.attr.as_mut_ptr(), flags) })?;

        map_fd(
            state.actions.as_mut_ptr(),
            stdin_r.as_raw_fd(),
            libc::STDIN_FILENO,
        )?;
        map_fd(
            state.actions.as_mut_ptr(),
            stdout_w.as_raw_fd(),
            libc::STDOUT_FILENO,
        )?;
        map_fd(
            state.actions.as_mut_ptr(),
            stderr_w.as_raw_fd(),
            libc::STDERR_FILENO,
        )?;
        let cwd = c_os(prepared.scratch_dir.as_os_str())?;
        cvt(unsafe {
            posix_spawn_file_actions_addchdir_np(state.actions.as_mut_ptr(), cwd.as_ptr())
        })?;

        // Pass the profile as an argument (`-p`) so it never lands in a
        // directory the confined child can overwrite between write and open.
        let mut owned = Vec::new();
        owned.push(c_os(OsStr::new(SANDBOX_EXEC))?);
        owned.push(c_os(OsStr::new("-p"))?);
        owned.push(c_os(OsStr::new(&prepared.profile))?);
        owned.push(c_os(prepared.program.as_os_str())?);
        for arg in &prepared.args {
            owned.push(c_os(arg)?);
        }
        let mut argv: Vec<*mut libc::c_char> = owned.iter().map(|s| s.as_ptr() as *mut _).collect();
        argv.push(std::ptr::null_mut());

        let env_owned = vec![
            env_pair("PATH", OsStr::new("/usr/bin:/bin"))?,
            env_pair("HOME", prepared.home_dir.as_os_str())?,
            env_pair("TMPDIR", prepared.scratch_dir.as_os_str())?,
            env_pair("LANG", OsStr::new("C"))?,
        ];
        let mut envp: Vec<*mut libc::c_char> =
            env_owned.iter().map(|s| s.as_ptr() as *mut _).collect();
        envp.push(std::ptr::null_mut());

        let sandbox_exe = c_os(OsStr::new(SANDBOX_EXEC))?;
        let mut pid: libc::pid_t = 0;
        let rc = unsafe {
            libc::posix_spawn(
                &mut pid,
                sandbox_exe.as_ptr(),
                state.actions.as_ptr(),
                state.attr.as_ptr(),
                argv.as_ptr(),
                envp.as_ptr(),
            )
        };
        if rc != 0 {
            return Err(LaunchError::Io(io::Error::from_raw_os_error(rc)));
        }
        if pid <= 0 {
            return Err(LaunchError::Io(io::Error::other(
                "posix_spawn returned no pid",
            )));
        }
        drop(stdin_r);
        drop(stdout_w);
        drop(stderr_w);
        Ok(ModelChild {
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
        src: libc::c_int,
        dst: libc::c_int,
    ) -> Result<(), LaunchError> {
        cvt(unsafe { libc::posix_spawn_file_actions_adddup2(actions, src, dst) })?;
        if src != dst {
            cvt(unsafe { libc::posix_spawn_file_actions_addclose(actions, src) })?;
        }
        Ok(())
    }

    fn anon_pipe() -> Result<(File, File), LaunchError> {
        let mut fds = [-1; 2];
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(LaunchError::Io(io::Error::last_os_error()));
        }
        for fd in fds {
            if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
                let err = io::Error::last_os_error();
                unsafe {
                    libc::close(fds[0]);
                    libc::close(fds[1]);
                }
                return Err(LaunchError::Io(err));
            }
        }
        let read = unsafe { File::from_raw_fd(fds[0]) };
        let write = unsafe { File::from_raw_fd(fds[1]) };
        Ok((read, write))
    }

    fn cvt(rc: libc::c_int) -> Result<(), LaunchError> {
        if rc == 0 {
            Ok(())
        } else {
            Err(LaunchError::Io(io::Error::from_raw_os_error(rc)))
        }
    }

    fn c_os(text: &OsStr) -> Result<CString, LaunchError> {
        CString::new(text.as_bytes()).map_err(|_| LaunchError::Argument)
    }

    fn env_pair(key: &str, value: &OsStr) -> Result<CString, LaunchError> {
        let mut bytes = Vec::from(key.as_bytes());
        bytes.push(b'=');
        bytes.extend_from_slice(value.as_bytes());
        CString::new(bytes).map_err(|_| LaunchError::Argument)
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

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::io::Read;
        use std::process::{Command, Stdio};
        use std::sync::OnceLock;

        struct StubBin {
            _root: tempfile::TempDir,
            program: PathBuf,
        }

        struct Fixture {
            _root: tempfile::TempDir,
            model: PathBuf,
            scratch: PathBuf,
            node: PathBuf,
            home: PathBuf,
            keychain: PathBuf,
        }

        fn stub() -> &'static StubBin {
            static STUB: OnceLock<StubBin> = OnceLock::new();
            STUB.get_or_init(compile_stub)
        }

        fn compile_stub() -> StubBin {
            let root = tempfile::tempdir().expect("tempdir");
            let src_dir = root.path().join("src");
            let exec_dir = root.path().join("exec");
            fs::create_dir(&src_dir).unwrap();
            fs::create_dir(&exec_dir).unwrap();
            let src = src_dir.join("model_stub.rs");
            fs::write(&src, include_str!("jarvis/sandbox/model_stub.rs")).unwrap();
            let program = exec_dir.join("model-stub");
            let output = Command::new("rustc")
                .arg("--edition=2021")
                .arg("-C")
                .arg("debuginfo=0")
                .arg(&src)
                .arg("-o")
                .arg(&program)
                .output()
                .expect("rustc");
            assert!(
                output.status.success(),
                "rustc failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            StubBin {
                program: fs::canonicalize(&program).unwrap(),
                _root: root,
            }
        }

        fn make_dir(root: &Path, name: &str) -> PathBuf {
            let path = root.join(name);
            fs::create_dir(&path).unwrap();
            fs::canonicalize(&path).unwrap()
        }

        fn fixture() -> Fixture {
            let root = tempfile::tempdir().unwrap();
            Fixture {
                model: make_dir(root.path(), "model"),
                scratch: make_dir(root.path(), "scratch"),
                node: make_dir(root.path(), "node"),
                home: make_dir(root.path(), "home"),
                keychain: make_dir(root.path(), "keychain"),
                _root: root,
            }
        }

        impl Fixture {
            fn request(&self, args: &[&str]) -> LaunchRequest {
                LaunchRequest {
                    program: stub().program.clone(),
                    args: args.iter().map(OsString::from).collect(),
                    model_dir: self.model.clone(),
                    scratch_dir: self.scratch.clone(),
                    node_data_dir: self.node.clone(),
                    home_dir: self.home.clone(),
                    keychain_dirs: vec![self.keychain.clone()],
                }
            }
        }

        fn slurp(file: &mut File) -> String {
            let mut buf = String::new();
            file.read_to_string(&mut buf).unwrap();
            buf
        }

        fn run(
            fix: &Fixture,
            sandboxed: bool,
            args: &[&str],
            stdin_line: Option<&str>,
        ) -> (i32, String, String) {
            if sandboxed {
                let mut child = launch(&fix.request(args)).expect("launch");
                if let Some(line) = stdin_line {
                    writeln!(child.stdin(), "{line}").unwrap();
                    child.stdin().flush().unwrap();
                }
                let code = child.wait_timeout(Duration::from_secs(20)).expect("wait");
                let out = slurp(child.stdout());
                let err = slurp(child.stderr());
                return (code, out, err);
            }
            let mut child = Command::new(&stub().program)
                .args(args)
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .env("HOME", &fix.home)
                .env("TMPDIR", &fix.scratch)
                .env("LANG", "C")
                .current_dir(&fix.scratch)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("baseline spawn");
            if let Some(line) = stdin_line {
                writeln!(child.stdin.as_mut().unwrap(), "{line}").unwrap();
            }
            let code = wait_command(&mut child, Duration::from_secs(20));
            let mut out = String::new();
            let mut err = String::new();
            child.stdout.unwrap().read_to_string(&mut out).unwrap();
            child.stderr.unwrap().read_to_string(&mut err).unwrap();
            (code, out, err)
        }

        fn wait_command(child: &mut std::process::Child, limit: Duration) -> i32 {
            let start = Instant::now();
            loop {
                match child.try_wait().unwrap() {
                    Some(status) => return status.code().unwrap_or(125),
                    None if start.elapsed() >= limit => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return 137;
                    }
                    None => thread::sleep(Duration::from_millis(20)),
                }
            }
        }

        fn line(fix: &Fixture, sandboxed: bool, args: &[&str]) -> String {
            let (code, out, err) = run(fix, sandboxed, args, None);
            assert_eq!(code, 0, "stdout={out} stderr={err}");
            out.trim().to_string()
        }

        fn arg(path: &Path) -> String {
            path.to_str().expect("utf-8 path").to_string()
        }

        fn listed_fds(report: &str) -> Vec<i32> {
            let list = report
                .strip_prefix("fds ")
                .unwrap_or_else(|| panic!("fd report {report}"));
            if list.is_empty() {
                return Vec::new();
            }
            list.split(',')
                .map(|item| item.parse().unwrap_or_else(|_| panic!("fd {item}")))
                .collect()
        }

        #[test]
        fn launch_refuses_a_missing_program() {
            let fix = fixture();
            let mut request = fix.request(&[]);
            request.program = fix.model.join("missing-binary");
            assert!(matches!(launch(&request), Err(LaunchError::NotFound)));
        }

        #[test]
        fn launch_passes_the_profile_as_an_argument() {
            let fix = fixture();
            let prepared = prepare(&fix.request(&["echo"])).expect("prepare");
            assert!(prepared.profile.starts_with("(version 1)\n(deny default)\n"));
            // Regression: the profile must stay in argv (`-p`), never a temp
            // path under a child-writable tree such as scratch or TMPDIR.
            let mut child = spawn(&prepared).expect("spawn with -p profile");
            writeln!(child.stdin(), "hello-broker").unwrap();
            child.stdin().flush().unwrap();
            let code = child.wait_timeout(Duration::from_secs(20)).expect("wait");
            let out = slurp(child.stdout());
            let err = slurp(child.stderr());
            assert_eq!(code, 0, "stdout={out} stderr={err}");
            assert_eq!(out.trim(), "echo hello-broker");
        }

        #[test]
        fn launch_speaks_only_over_the_broker_pipe() {
            let fix = fixture();
            let (code, out, err) = run(&fix, true, &["echo"], Some("hello-broker"));
            assert_eq!(code, 0, "stdout={out} stderr={err}");
            assert_eq!(out.trim(), "echo hello-broker");
        }

        #[test]
        fn launch_denies_network() {
            let fix = fixture();
            let baseline = line(&fix, false, &["connect"]);
            assert!(
                baseline == "refused" || baseline == "ok",
                "unconfined connect was {baseline}"
            );
            assert_eq!(line(&fix, true, &["connect"]), "denied");
            assert_eq!(line(&fix, false, &["listen"]), "ok");
            assert_eq!(line(&fix, true, &["listen"]), "denied");
            assert_eq!(line(&fix, false, &["udp"]), "ok");
            assert_eq!(line(&fix, true, &["udp"]), "denied");
            let sock = fix.scratch.join("ipc.sock");
            let sock_arg = arg(&sock);
            assert_eq!(line(&fix, false, &["unix", &sock_arg]), "ok");
            fs::remove_file(&sock).unwrap();
            assert_eq!(line(&fix, true, &["unix", &sock_arg]), "denied");
            assert!(!sock.exists());
        }

        #[test]
        fn launch_model_dir_is_read_only() {
            let fix = fixture();
            let weights = fix.model.join("weights.bin");
            fs::write(&weights, b"weights").unwrap();
            let weights_arg = arg(&weights);
            assert_eq!(line(&fix, false, &["read", &weights_arg]), "ok");
            assert_eq!(line(&fix, true, &["read", &weights_arg]), "ok");
            let baseline_write = fix.model.join("baseline-write");
            let baseline_arg = arg(&baseline_write);
            assert_eq!(line(&fix, false, &["write", &baseline_arg]), "ok");
            fs::remove_file(&baseline_write).unwrap();
            let denied = fix.model.join("not-allowed");
            let denied_arg = arg(&denied);
            assert_eq!(line(&fix, true, &["write", &denied_arg]), "denied");
            assert!(!denied.exists());
        }

        #[test]
        fn launch_scratch_is_writable() {
            let fix = fixture();
            let note = fix.scratch.join("note.txt");
            let note_arg = arg(&note);
            assert_eq!(line(&fix, true, &["write", &note_arg]), "ok");
            assert_eq!(fs::read(&note).unwrap(), b"written-by-stub\n");
        }

        #[test]
        fn launch_denies_home_keychain_and_node_data() {
            let fix = fixture();
            let secret = fix.home.join("secret");
            fs::write(&secret, b"home").unwrap();
            let secret_arg = arg(&secret);
            assert_eq!(line(&fix, false, &["read", &secret_arg]), "ok");
            assert_eq!(line(&fix, true, &["read", &secret_arg]), "denied");
            assert_eq!(line(&fix, true, &["stat", &arg(&fix.home)]), "denied");
            assert_eq!(line(&fix, false, &["stat", "/Users"]), "ok");
            assert_eq!(line(&fix, true, &["stat", "/Users"]), "denied");

            let item = fix.keychain.join("login.keychain-db");
            fs::write(&item, b"key").unwrap();
            let item_arg = arg(&item);
            assert_eq!(line(&fix, false, &["read", &item_arg]), "ok");
            assert_eq!(line(&fix, true, &["read", &item_arg]), "denied");
            assert_eq!(line(&fix, false, &["stat", "/Library/Keychains"]), "ok");
            assert_eq!(line(&fix, true, &["stat", "/Library/Keychains"]), "denied");

            let node_file = fix.node.join("state.bin");
            fs::write(&node_file, b"node").unwrap();
            let node_arg = arg(&node_file);
            assert_eq!(line(&fix, false, &["read", &node_arg]), "ok");
            assert_eq!(line(&fix, true, &["read", &node_arg]), "denied");
            assert_eq!(line(&fix, true, &["stat", &arg(&fix.node)]), "denied");
        }

        #[test]
        fn launch_child_fds_are_only_the_broker_pipes() {
            let fix = fixture();
            let marker = fix.scratch.join("planted");
            fs::write(&marker, b"not-for-the-child").unwrap();
            let file = File::open(&marker).unwrap();
            let planted = unsafe { libc::dup(file.as_raw_fd()) };
            assert!(planted > 2, "planted fd {planted}");
            let baseline = listed_fds(&line(&fix, false, &["fds"]));
            assert!(
                baseline.contains(&planted),
                "unconfined fds {baseline:?} did not include {planted}"
            );
            assert_eq!(listed_fds(&line(&fix, true, &["fds"])), vec![0, 1, 2]);
            unsafe { libc::close(planted) };
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::{launch, LaunchError, LaunchRequest, ModelChild};
