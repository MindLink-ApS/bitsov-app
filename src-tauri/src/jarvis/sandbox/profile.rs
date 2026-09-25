//! Deny-by-default SBPL for the local model child.
//!
//! Seatbelt keeps the last matching rule. Denies for the home directory, the
//! Data-volume firmlink, keychains and node data are emitted before the allows
//! for the model directory, the binary directory and scratch, so a later allow
//! cannot reopen a tree the layout check already rejected.
#![forbid(unsafe_code)]

use std::path::{Component, Path, PathBuf};

/// Mach services the J0 spike required to be unreachable for keychain access.
const KEYCHAIN_MACH_SERVICES: &[&str] = &[
    "com.apple.SecurityServer",
    "com.apple.securityd.xpc",
    "com.apple.securityd.general",
    "com.apple.security.octagon",
    "com.apple.ctkd.token-client",
];

const DENIED_ROOTS: [&str; 2] = ["/Users", "/System/Volumes/Data"];

/// Directories the profile is built from. Every path is absolute, lexical
/// (no `.` or `..`), and UTF-8. The macOS launcher canonicalizes real
/// directories before calling [`render_profile`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxPaths {
    pub model_dir: PathBuf,
    pub scratch_dir: PathBuf,
    pub exec_dir: PathBuf,
    pub home_dir: PathBuf,
    pub keychain_dirs: Vec<PathBuf>,
    pub node_data_dir: PathBuf,
}

/// Why a profile was refused. The value does not echo the path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileError {
    /// Relative, or the filesystem root. `(subpath "/")` would match everything.
    NotAbsolute,
    NotUtf8,
    /// `.` or `..` components. Prefix checks would not match the kernel path.
    NotCanonical,
    /// A character that can close an SBPL string and inject a rule.
    IllegalCharacter,
    /// The model, scratch or binary directory sits in the home directory,
    /// under `/Users`, or on the Data-volume firmlink.
    InsideDeniedRoot,
    /// An allowed directory would cover a denied one, or scratch would cover
    /// the model or the binary.
    AllowsDeniedTree,
    /// No keychain directory was supplied, so the profile would not name one.
    KeychainRequired,
}

impl std::fmt::Display for ProfileError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            ProfileError::NotAbsolute => {
                "sandbox path must be absolute and must not be the filesystem root"
            }
            ProfileError::NotUtf8 => "sandbox path must be utf-8",
            ProfileError::NotCanonical => "sandbox path must not contain . or ..",
            ProfileError::IllegalCharacter => "sandbox path contains an sbpl metacharacter",
            ProfileError::InsideDeniedRoot => {
                "model, scratch or binary directory is inside a denied root"
            }
            ProfileError::AllowsDeniedTree => {
                "sandbox allow would cover a denied directory or the binary"
            }
            ProfileError::KeychainRequired => "sandbox profile requires a keychain directory",
        };
        formatter.write_str(text)
    }
}

impl std::error::Error for ProfileError {}

/// Keychain locations the spike treated as unreadable. `home` is the user's
/// home directory; the other two are the system keychain directories.
pub fn default_keychain_dirs(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join("Library/Keychains"),
        PathBuf::from("/Library/Keychains"),
        PathBuf::from("/System/Library/Keychains"),
    ]
}

/// Render the SBPL profile. This does not apply it and does not touch the
/// filesystem, so unit tests run on every host.
pub fn render_profile(paths: &SandboxPaths) -> Result<String, ProfileError> {
    validate(paths)?;
    let mut out = String::new();
    emit_preamble(&mut out);
    emit_process(&mut out, &paths.exec_dir)?;
    emit_os_reads(&mut out);
    emit_ancestor_metadata(&mut out, paths)?;
    emit_home_denies(&mut out, &paths.home_dir)?;
    emit_keychain_denies(&mut out, &paths.keychain_dirs)?;
    emit_node_data_deny(&mut out, &paths.node_data_dir)?;
    emit_model_read_only(&mut out, &paths.model_dir)?;
    emit_exec_read(&mut out, &paths.exec_dir)?;
    emit_scratch(&mut out, &paths.scratch_dir)?;
    emit_network_denies(&mut out);
    Ok(out)
}

fn validate(paths: &SandboxPaths) -> Result<(), ProfileError> {
    check_path(&paths.model_dir)?;
    check_path(&paths.scratch_dir)?;
    check_path(&paths.exec_dir)?;
    check_path(&paths.home_dir)?;
    check_path(&paths.node_data_dir)?;
    if paths.keychain_dirs.is_empty() {
        return Err(ProfileError::KeychainRequired);
    }
    for dir in &paths.keychain_dirs {
        check_path(dir)?;
    }
    check_layout(paths)
}

fn check_path(path: &Path) -> Result<(), ProfileError> {
    if path == Path::new("/") || !path.is_absolute() {
        return Err(ProfileError::NotAbsolute);
    }
    if path
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(ProfileError::NotCanonical);
    }
    let text = path.to_str().ok_or(ProfileError::NotUtf8)?;
    if text
        .bytes()
        .any(|byte| matches!(byte, b'"' | b'\\' | b'\n' | b'\r' | b'(' | b')' | 0))
    {
        return Err(ProfileError::IllegalCharacter);
    }
    Ok(())
}

fn check_layout(paths: &SandboxPaths) -> Result<(), ProfileError> {
    let allows = [&paths.model_dir, &paths.scratch_dir, &paths.exec_dir];
    for allow in allows {
        if allow == &paths.home_dir || allow.starts_with(&paths.home_dir) {
            return Err(ProfileError::InsideDeniedRoot);
        }
        for root in DENIED_ROOTS {
            let root = Path::new(root);
            if allow == root || allow.starts_with(root) {
                return Err(ProfileError::InsideDeniedRoot);
            }
        }
        if same_or_inside(&paths.home_dir, allow)
            || same_or_inside(&paths.node_data_dir, allow)
            || same_or_inside(allow, &paths.node_data_dir)
        {
            return Err(ProfileError::AllowsDeniedTree);
        }
        for keychain in &paths.keychain_dirs {
            if same_or_inside(keychain, allow) || same_or_inside(allow, keychain) {
                return Err(ProfileError::AllowsDeniedTree);
            }
        }
    }
    if paths.scratch_dir == paths.model_dir || paths.scratch_dir == paths.exec_dir {
        return Err(ProfileError::AllowsDeniedTree);
    }
    if strictly_inside(&paths.model_dir, &paths.scratch_dir)
        || strictly_inside(&paths.scratch_dir, &paths.model_dir)
        || strictly_inside(&paths.exec_dir, &paths.scratch_dir)
        || strictly_inside(&paths.scratch_dir, &paths.exec_dir)
    {
        return Err(ProfileError::AllowsDeniedTree);
    }
    Ok(())
}

fn same_or_inside(path: &Path, parent: &Path) -> bool {
    path == parent || path.starts_with(parent)
}

fn strictly_inside(path: &Path, parent: &Path) -> bool {
    path != parent && path.starts_with(parent)
}

fn quote(path: &Path) -> Result<String, ProfileError> {
    check_path(path)?;
    let text = path.to_str().ok_or(ProfileError::NotUtf8)?;
    Ok(format!("\"{text}\""))
}

fn put(out: &mut String, text: &str) {
    out.push_str(text);
    out.push('\n');
}

fn emit_preamble(out: &mut String) {
    put(out, "(version 1)");
    put(out, "(deny default)");
    // dyld on macOS 13+ maps the shared cache out of the OS cryptex. The spike
    // measured that omitting this import aborts the child before main.
    put(out, "(import \"dyld-support.sb\")");
}

fn emit_process(out: &mut String, exec_dir: &Path) -> Result<(), ProfileError> {
    let exec_dir = quote(exec_dir)?;
    put(out, "(allow process-fork)");
    put(
        out,
        &format!("(allow process-exec\n    (subpath {exec_dir}))"),
    );
    // The spike measured that (deny default) alone still allows proc_pidinfo
    // on other processes. The explicit deny is load-bearing.
    put(out, "(deny process-info*)");
    put(out, "(allow process-info* (target self))");
    put(out, "(allow signal (target self))");
    put(out, "(deny mach-priv-task-port)");
    put(out, "(deny mach-task-name)");
    put(out, "(allow sysctl-read)");
    put(
        out,
        "(deny sysctl-read\n    (sysctl-name-prefix \"kern.proc.\")\n    (sysctl-name-prefix \"kern.procargs\"))",
    );
    Ok(())
}

const OS_READS: &str = r#"(allow file-read*
    (subpath "/System")
    (subpath "/usr/lib")
    (subpath "/usr/share")
    (subpath "/Library/Apple/System")
    (subpath "/private/var/db/dyld")
    (subpath "/private/var/db/timezone")
    (literal "/private/etc/localtime")
    (literal "/dev/null")
    (literal "/dev/zero")
    (literal "/dev/random")
    (literal "/dev/urandom"))"#;

fn emit_os_reads(out: &mut String) {
    put(out, OS_READS);
}

fn emit_ancestor_metadata(out: &mut String, paths: &SandboxPaths) -> Result<(), ProfileError> {
    let scratch = quote(&paths.scratch_dir)?;
    let exec_dir = quote(&paths.exec_dir)?;
    let model = quote(&paths.model_dir)?;
    put(
        out,
        &format!(
            "(allow file-read-metadata\n    (literal \"/\")\n    (literal \"/tmp\")\n    (literal \"/var\")\n    (literal \"/etc\")\n    (path-ancestors {scratch})\n    (path-ancestors {exec_dir})\n    (path-ancestors {model}))"
        ),
    );
    Ok(())
}

/// No access to the home directory, to other homes under `/Users`, or to the
/// Data-volume firmlink that aliases them.
fn emit_home_denies(out: &mut String, home: &Path) -> Result<(), ProfileError> {
    let home = quote(home)?;
    put(
        out,
        &format!(
            "(deny file-read* file-write*\n    (subpath \"/Users\")\n    (subpath \"/System/Volumes/Data\")\n    (subpath {home}))"
        ),
    );
    Ok(())
}

/// No access to keychain files, and no lookup of the keychain daemons.
fn emit_keychain_denies(out: &mut String, dirs: &[PathBuf]) -> Result<(), ProfileError> {
    let mut rule = String::from("(deny file-read* file-write*");
    for dir in dirs {
        let path = quote(dir)?;
        rule.push_str("\n    (subpath ");
        rule.push_str(&path);
        rule.push(')');
    }
    rule.push(')');
    put(out, &rule);
    let mut mach = String::from("(deny mach-lookup");
    for service in KEYCHAIN_MACH_SERVICES {
        mach.push_str("\n    (global-name \"");
        mach.push_str(service);
        mach.push_str("\")");
    }
    mach.push(')');
    put(out, &mach);
    Ok(())
}

/// No access to the node data directory.
fn emit_node_data_deny(out: &mut String, node_data: &Path) -> Result<(), ProfileError> {
    let node_data = quote(node_data)?;
    put(
        out,
        &format!("(deny file-read* file-write*\n    (subpath {node_data}))"),
    );
    Ok(())
}

/// Read-only model directory: reads allowed, writes denied after that allow.
fn emit_model_read_only(out: &mut String, model: &Path) -> Result<(), ProfileError> {
    let model = quote(model)?;
    put(out, &format!("(allow file-read*\n    (subpath {model}))"));
    put(out, &format!("(deny file-write*\n    (subpath {model}))"));
    Ok(())
}

fn emit_exec_read(out: &mut String, exec_dir: &Path) -> Result<(), ProfileError> {
    let exec_dir = quote(exec_dir)?;
    put(
        out,
        &format!("(allow file-read*\n    (subpath {exec_dir}))"),
    );
    Ok(())
}

/// Scratch is the only writable directory. Reads of that same directory are
/// allowed so the model can use files it just wrote. `/dev/null` is the
/// spike's only other write, and it is not a directory.
fn emit_scratch(out: &mut String, scratch: &Path) -> Result<(), ProfileError> {
    let scratch = quote(scratch)?;
    put(out, &format!("(allow file-read*\n    (subpath {scratch}))"));
    put(
        out,
        &format!("(allow file-write*\n    (subpath {scratch}))"),
    );
    put(out, "(allow file-write-data (literal \"/dev/null\"))");
    Ok(())
}

/// No network. There is no unix-socket allow: the broker channel is a pipe
/// inherited from the launcher, which Seatbelt does not treat as a socket.
fn emit_network_denies(out: &mut String) {
    put(out, "(deny network-outbound)");
    put(out, "(deny network-inbound)");
    put(out, "(deny network-bind)");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> SandboxPaths {
        let home = PathBuf::from("/Users/operator");
        SandboxPaths {
            model_dir: PathBuf::from("/model"),
            scratch_dir: PathBuf::from("/scratch"),
            exec_dir: PathBuf::from("/exec"),
            home_dir: home.clone(),
            keychain_dirs: default_keychain_dirs(&home),
            node_data_dir: PathBuf::from("/node"),
        }
    }

    fn rendered() -> String {
        render_profile(&sample()).expect("sample profile")
    }

    #[test]
    fn profile_is_deny_by_default() {
        let profile = rendered();
        assert!(profile.starts_with("(version 1)\n(deny default)\n"));
        assert!(profile.contains("(import \"dyld-support.sb\")\n"));
        assert!(profile.contains("(deny process-info*)\n"));
        assert!(!profile.contains("SYSTEM_EXEC"));
        assert!(!profile.contains("(subpath \"/bin\")"));
        assert!(!profile.contains("(subpath \"/usr/bin\")"));
        let system = profile.find("(subpath \"/System\")").expect("system read");
        let data = profile
            .find("(subpath \"/System/Volumes/Data\")")
            .expect("data volume deny");
        assert!(
            system < data,
            "data-volume deny must follow the /System allow"
        );
    }

    #[test]
    fn profile_model_dir_is_read_only() {
        let profile = rendered();
        let read = profile
            .find("(allow file-read*\n    (subpath \"/model\"))")
            .expect("model read");
        let deny = profile
            .find("(deny file-write*\n    (subpath \"/model\"))")
            .expect("model write deny");
        assert!(read < deny);
        assert!(!profile.contains("(allow file-write*\n    (subpath \"/model\"))"));
    }

    #[test]
    fn profile_scratch_is_the_only_writable_directory() {
        let profile = rendered();
        assert!(profile.contains("(allow file-read*\n    (subpath \"/scratch\"))"));
        assert!(profile.contains("(allow file-write*\n    (subpath \"/scratch\"))"));
        assert!(profile.contains("(allow file-write-data (literal \"/dev/null\"))"));
        assert_eq!(profile.matches("(allow file-write*\n").count(), 1);
        let home = profile
            .find("(subpath \"/Users/operator\")")
            .expect("home deny");
        let scratch = profile
            .find("(allow file-write*\n    (subpath \"/scratch\"))")
            .expect("scratch write");
        assert!(home < scratch);
    }

    #[test]
    fn profile_denies_home() {
        let profile = rendered();
        assert!(profile.contains("(subpath \"/Users\")"));
        assert!(profile.contains("(subpath \"/System/Volumes/Data\")"));
        assert!(profile.contains("(subpath \"/Users/operator\")"));
        let marker = profile
            .find("(deny file-read* file-write*\n    (subpath \"/Users\")")
            .expect("home rule");
        assert!(marker > 0);
    }

    #[test]
    fn profile_denies_keychain_files_and_mach_services() {
        let profile = rendered();
        for dir in default_keychain_dirs(Path::new("/Users/operator")) {
            let needle = format!("(subpath \"{}\")", dir.display());
            assert!(profile.contains(&needle), "{needle}");
        }
        let files = profile
            .find("(subpath \"/System/Library/Keychains\")")
            .unwrap();
        let system = profile.find("(subpath \"/System\")").unwrap();
        assert!(files > system);
        assert!(profile.contains("(deny mach-lookup\n"));
        assert!(!profile.contains("(allow mach-lookup"));
        for service in KEYCHAIN_MACH_SERVICES {
            assert!(profile.contains(&format!("(global-name \"{service}\")")));
        }
    }

    #[test]
    fn profile_denies_node_data() {
        let profile = rendered();
        assert!(profile.contains("(deny file-read* file-write*\n    (subpath \"/node\"))"));
    }

    #[test]
    fn profile_has_no_network_and_no_socket() {
        let profile = rendered();
        assert!(profile.contains("(deny network-outbound)\n"));
        assert!(profile.contains("(deny network-inbound)\n"));
        assert!(profile.contains("(deny network-bind)\n"));
        assert!(!profile.contains("(allow network"));
        assert!(!profile.contains("unix-socket"));
        assert!(!profile.contains("LISTEN_SOCK"));
        assert!(!profile.contains("iokit-open"));
        assert!(!profile.contains("MTLCompiler"));
    }

    #[test]
    fn profile_rejects_paths_inside_home_or_data_volume() {
        let mut paths = sample();
        paths.scratch_dir = PathBuf::from("/Users/operator/scratch");
        assert_eq!(render_profile(&paths), Err(ProfileError::InsideDeniedRoot));
        paths = sample();
        paths.model_dir = PathBuf::from("/System/Volumes/Data/m");
        assert_eq!(render_profile(&paths), Err(ProfileError::InsideDeniedRoot));
        paths = sample();
        paths.exec_dir = PathBuf::from("/Users/other/bin");
        assert_eq!(render_profile(&paths), Err(ProfileError::InsideDeniedRoot));
    }

    #[test]
    fn profile_rejects_a_scratch_dir_that_covers_the_model() {
        let mut paths = sample();
        paths.model_dir = PathBuf::from("/scratch/model");
        assert_eq!(render_profile(&paths), Err(ProfileError::AllowsDeniedTree));
        paths = sample();
        paths.scratch_dir = PathBuf::from("/model");
        assert_eq!(render_profile(&paths), Err(ProfileError::AllowsDeniedTree));
        paths = sample();
        paths.node_data_dir = PathBuf::from("/model/node");
        assert_eq!(render_profile(&paths), Err(ProfileError::AllowsDeniedTree));
    }

    #[test]
    fn profile_rejects_injection_and_relative_paths() {
        let mut paths = sample();
        paths.model_dir = PathBuf::from("/tmp/x\"(allow network-outbound)");
        assert_eq!(render_profile(&paths), Err(ProfileError::IllegalCharacter));
        paths = sample();
        paths.scratch_dir = PathBuf::from("scratch");
        assert_eq!(render_profile(&paths), Err(ProfileError::NotAbsolute));
        paths = sample();
        paths.node_data_dir = PathBuf::from("/node/../etc");
        assert_eq!(render_profile(&paths), Err(ProfileError::NotCanonical));
        paths = sample();
        paths.home_dir = PathBuf::from("/");
        assert_eq!(render_profile(&paths), Err(ProfileError::NotAbsolute));
        paths = sample();
        paths.keychain_dirs.clear();
        assert_eq!(render_profile(&paths), Err(ProfileError::KeychainRequired));
    }

    #[test]
    fn profile_allows_model_and_exec_to_be_the_same_directory() {
        let mut paths = sample();
        paths.exec_dir = PathBuf::from("/model");
        let profile = render_profile(&paths).expect("same directory");
        assert!(profile.contains("(allow process-exec\n    (subpath \"/model\"))"));
        assert!(profile.contains("(deny file-write*\n    (subpath \"/model\"))"));
    }

    #[test]
    fn default_keychain_dirs_lists_the_spike_locations() {
        let dirs = default_keychain_dirs(Path::new("/Users/operator"));
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/Users/operator/Library/Keychains"),
                PathBuf::from("/Library/Keychains"),
                PathBuf::from("/System/Library/Keychains"),
            ]
        );
    }

    #[test]
    fn model_stub_source_is_present_for_the_macos_launch_tests() {
        let source = include_str!("model_stub.rs");
        assert!(source.contains("fn main"));
        assert!(source.contains("\"connect\""));
        assert!(source.contains("\"fds\""));
    }
}
