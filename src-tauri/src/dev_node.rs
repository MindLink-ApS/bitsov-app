// DEV ONLY — run the app against a `konsensus` binary built from genome `main`.
//
// !!! THIS BYPASSES SIDECAR VERIFICATION. !!!
//
// The product path runs `bin/konsensus-<triple>`, which `scripts/fetch-node-sidecar.sh`
// installs only after checking the pinned release's GPG signature and sha256. This
// module lets a developer point the app at ANY local binary instead. Nothing checks
// that binary: not a signature, not a hash, not a version. It exists so the control
// center can be exercised against genome features that are not in a tag yet
// (pairing, #77). See docs/DEV_NODE_FROM_MAIN.md.
//
// It cannot reach a release build:
// - the override is compiled only for `debug_assertions` + the non-default
//   `dev-node` feature; every other build gets the stub below, which never reads
//   the environment;
// - `dev-node` in a release build is a compile error (`compile_error!` below), and
//   `scripts/test-dev-node-release-guard.sh` proves it by compiling that combination.
//
// It also never runs an unverified binary on the product data dir: the override
// requires an explicit data dir too, outside the app's own data dir.
//
// Two more dev-only knobs for the real-window harness follow the same gate:
// `BITSOV_DEV_API_BASE` moves the node API off 127.0.0.1:3141 (loopback only), so a
// test run never talks to, restarts or stops a pilot node that holds 3141; and
// `BITSOV_UI_E2E_SAVE_DIR` replaces the native save dialog with a fixed directory.

#[cfg(all(feature = "dev-node", not(debug_assertions)))]
compile_error!(
    "feature `dev-node` is DEV ONLY: it runs an unverified node binary. \
     Release builds must bundle the signature-verified sidecar (scripts/fetch-node-sidecar.sh)."
);

use std::path::{Path, PathBuf};

/// Absolute path to a locally built `konsensus` binary.
pub const SIDECAR_ENV: &str = "BITSOV_DEV_SIDECAR";
/// Absolute path to the node + app data dir used with that binary.
pub const DATA_DIR_ENV: &str = "BITSOV_DEV_DATA_DIR";
/// The product bundle identifier (tauri.conf.json). The dev overlay
/// (tauri.dev-node.conf.json) runs under another one, so the product data dir is a
/// sibling of the dev app's data dir, and is refused explicitly.
#[cfg_attr(not(all(debug_assertions, feature = "dev-node")), allow(dead_code))]
const PRODUCT_IDENTIFIER: &str = "tech.mindlink.bitsov";
/// Window title while a dev node is running.
pub const WINDOW_TITLE: &str = "BitSov — DEV NODE (genome main, UNVERIFIED)";

/// A dev node override: which binary to run, and on which data dir.
#[derive(Debug, PartialEq, Eq)]
pub struct DevNode {
    pub sidecar: PathBuf,
    pub data_dir: PathBuf,
}

/// The override for this process. `Ok(None)` means the bundled, verified sidecar and
/// the app data dir, exactly as without this module.
#[cfg(all(debug_assertions, feature = "dev-node"))]
pub fn resolve(app_data_dir: &Path) -> Result<Option<DevNode>, String> {
    let sidecar = std::env::var(SIDECAR_ENV).ok();
    let data_dir = std::env::var(DATA_DIR_ENV).ok();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let forbidden = [
        app_data_dir.to_path_buf(),
        app_data_dir.with_file_name(PRODUCT_IDENTIFIER),
    ];
    let mut dev = resolve_from(
        sidecar.as_deref(),
        data_dir.as_deref(),
        &forbidden,
        home.as_deref(),
    )?;
    if let Some(dev) = &mut dev {
        std::fs::create_dir_all(&dev.data_dir)
            .map_err(|e| format!("{DATA_DIR_ENV}: cannot create dev directory: {e}"))?;
        // Resolve again after creation, before handing a path to the node. The
        // returned path never retains a caller-controlled symlink alias.
        dev.data_dir = checked_data_dir(&dev.data_dir, &forbidden, home.as_deref())?;
    }
    Ok(dev)
}

/// Release and ordinary debug builds: no override, and the environment is not read.
#[cfg(not(all(debug_assertions, feature = "dev-node")))]
pub fn resolve(_app_data_dir: &Path) -> Result<Option<DevNode>, String> {
    Ok(None)
}

/// Absolute path to the data dir of a node the owner already runs (external mode).
pub const EXTERNAL_ENV: &str = "BITSOV_DEV_EXTERNAL_NODE";
/// Window title while attached to an external node.
pub const EXTERNAL_WINDOW_TITLE: &str =
    "BitSov — DEV, EXTERNAL NODE (127.0.0.1:3141, not started by the app)";
/// The product API bind (`API_BASE` in main.rs). The only one outside dev builds.
#[cfg_attr(not(all(debug_assertions, feature = "dev-node")), allow(dead_code))]
const LOOPBACK_API: &str = "127.0.0.1:3141";

/// A node the owner started and supervises. The app attaches to its loopback API
/// and never inits, starts, restarts or stops it.
#[derive(Debug, PartialEq, Eq)]
pub struct ExternalNode {
    /// The node's data dir. Read only: the app reads its pairing challenge files
    /// (`<data_dir>/pairing`) and the routing policy in `konsensus.toml`.
    pub data_dir: PathBuf,
    pub config: PathBuf,
}

/// External mode for this process, from `BITSOV_DEV_EXTERNAL_NODE`. `Ok(None)` when
/// it is unset.
#[cfg(all(debug_assertions, feature = "dev-node"))]
pub fn resolve_external(app_data_dir: &Path) -> Result<Option<ExternalNode>, String> {
    let external = std::env::var(EXTERNAL_ENV).ok();
    let spawn_set = [SIDECAR_ENV, DATA_DIR_ENV]
        .iter()
        .any(|name| non_empty(std::env::var(name).ok().as_deref()).is_some());
    let forbidden = [
        app_data_dir.to_path_buf(),
        app_data_dir.with_file_name(PRODUCT_IDENTIFIER),
    ];
    let api = api_port_from(std::env::var(API_BASE_ENV).ok().as_deref())?
        .map(|port| format!("127.0.0.1:{port}"));
    external_from(
        external.as_deref(),
        spawn_set,
        &forbidden,
        api.as_deref().unwrap_or(LOOPBACK_API),
    )
}

/// Release and ordinary debug builds: no external mode, and the environment is not read.
#[cfg(not(all(debug_assertions, feature = "dev-node")))]
pub fn resolve_external(_app_data_dir: &Path) -> Result<Option<ExternalNode>, String> {
    Ok(None)
}

/// The external-mode rules, separate from the environment so tests can drive them.
///
/// Refuses: a relative or missing dir, a dir inside an app data dir, a dir without
/// `konsensus.toml` + `NODE_INITIALIZED` (the app never initialises a node here), a
/// config whose API is not bound to `api` (`127.0.0.1:3141` unless
/// `BITSOV_DEV_API_BASE` moved it), and the spawn variables set at the same time
/// (external mode never starts a node).
#[cfg_attr(not(all(debug_assertions, feature = "dev-node")), allow(dead_code))]
pub fn external_from(
    external: Option<&str>,
    spawn_set: bool,
    forbidden: &[PathBuf],
    api: &str,
) -> Result<Option<ExternalNode>, String> {
    let Some(external) = non_empty(external) else {
        return Ok(None);
    };
    if spawn_set {
        return Err(format!(
            "{EXTERNAL_ENV} attaches to a node you already run; unset {SIDECAR_ENV} and {DATA_DIR_ENV}"
        ));
    }
    let dir = PathBuf::from(external);
    if !dir.is_absolute() {
        return Err(format!("{EXTERNAL_ENV} must be an absolute path"));
    }
    let data_dir = std::fs::canonicalize(&dir)
        .ok()
        .filter(|d| d.is_dir())
        .ok_or_else(|| format!("{EXTERNAL_ENV}: no node data dir at {}", dir.display()))?;
    for app_dir in forbidden {
        if is_within(&data_dir, &canonical_directory(app_dir)?) {
            return Err(format!(
                "{EXTERNAL_ENV} is inside an app data dir ({}); point it at your own node's data dir",
                app_dir.display()
            ));
        }
    }
    let config = data_dir.join("konsensus.toml");
    if !config.is_file() || !data_dir.join("NODE_INITIALIZED").is_file() {
        return Err(format!(
            "{EXTERNAL_ENV}: {} is not an initialised node (konsensus.toml and NODE_INITIALIZED); the app never initialises one in this mode",
            data_dir.display()
        ));
    }
    if configured_api_addr(&config).as_deref() != Some(api) {
        return Err(format!(
            "{EXTERNAL_ENV}: the node's [api] listen_addr must be {api}, the only address the app talks to"
        ));
    }
    Ok(Some(ExternalNode { data_dir, config }))
}

/// `[api] listen_addr` from the node config, or the node default when absent.
/// `None` when the file is unreadable or malformed. Parse errors are never shown:
/// the rest of the file can hold credentials.
#[cfg_attr(not(all(debug_assertions, feature = "dev-node")), allow(dead_code))]
fn configured_api_addr(config: &Path) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Config {
        api: Option<Api>,
    }
    #[derive(serde::Deserialize)]
    struct Api {
        listen_addr: Option<String>,
    }
    let text = std::fs::read_to_string(config).ok()?;
    let parsed: Config = toml::from_str(&text).ok()?;
    Some(
        parsed
            .api
            .and_then(|a| a.listen_addr)
            .unwrap_or_else(|| LOOPBACK_API.to_string()),
    )
}

/// `http://127.0.0.1:<port>`: the node API to talk to instead of 127.0.0.1:3141.
pub const API_BASE_ENV: &str = "BITSOV_DEV_API_BASE";

/// The node API base for this process. Release and ordinary debug builds return
/// `product` (main.rs `API_BASE`) and never read the environment. An invalid
/// override is an error, never a silent fall back to 3141: that port may belong
/// to a pilot node the app must not touch.
#[cfg(all(debug_assertions, feature = "dev-node"))]
pub fn api_base(product: &str) -> Result<String, String> {
    Ok(api_port_from(std::env::var(API_BASE_ENV).ok().as_deref())?
        .map(|port| format!("http://127.0.0.1:{port}/api/v1"))
        .unwrap_or_else(|| product.to_string()))
}

/// Release and ordinary debug builds: always the product API base.
#[cfg(not(all(debug_assertions, feature = "dev-node")))]
pub fn api_base(product: &str) -> Result<String, String> {
    Ok(product.to_string())
}

/// The override rules, separate from the environment so tests can drive them.
/// Accepts only `http://127.0.0.1:<port>`, optionally followed by `/` or
/// `/api/v1`, with a decimal port 1-65535. Returns the port. Anything else
/// (another host, `localhost`, https, credentials, another path) is refused.
#[cfg_attr(not(all(debug_assertions, feature = "dev-node")), allow(dead_code))]
pub fn api_port_from(value: Option<&str>) -> Result<Option<u16>, String> {
    let Some(value) = non_empty(value) else {
        return Ok(None);
    };
    let refuse =
        || format!("{API_BASE_ENV} must be http://127.0.0.1:<port> (loopback only), got {value:?}");
    let rest = value.strip_prefix("http://127.0.0.1:").ok_or_else(refuse)?;
    let port = ["/api/v1", "/", ""]
        .iter()
        .find_map(|suffix| rest.strip_suffix(suffix).filter(|p| !p.is_empty()))
        .ok_or_else(refuse)?;
    if !port.bytes().all(|b| b.is_ascii_digit()) || port.starts_with('0') {
        return Err(refuse());
    }
    port.parse().map(Some).map_err(|_| refuse())
}

/// Absolute path to an existing directory. With `BITSOV_UI_E2E=1`, Save writes
/// received files there instead of opening the native save dialog.
pub const SAVE_DIR_ENV: &str = "BITSOV_UI_E2E_SAVE_DIR";

/// Where Save writes without a dialog, for the real-window harness. `Ok(None)`
/// means the native dialog. Release and ordinary debug builds: always `Ok(None)`,
/// and the environment is not read.
#[cfg(all(debug_assertions, feature = "dev-node"))]
pub fn save_dir() -> Result<Option<PathBuf>, String> {
    if std::env::var("BITSOV_UI_E2E").ok().as_deref() != Some("1") {
        return Ok(None);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    save_dir_from(std::env::var(SAVE_DIR_ENV).ok().as_deref(), home.as_deref())
}

/// Release and ordinary debug builds: the native save dialog, always.
#[cfg(not(all(debug_assertions, feature = "dev-node")))]
pub fn save_dir() -> Result<Option<PathBuf>, String> {
    Ok(None)
}

/// The save-dir rules: an absolute, existing directory outside HOME.
#[cfg_attr(not(all(debug_assertions, feature = "dev-node")), allow(dead_code))]
pub fn save_dir_from(value: Option<&str>, home: Option<&Path>) -> Result<Option<PathBuf>, String> {
    let Some(value) = non_empty(value) else {
        return Ok(None);
    };
    let dir = PathBuf::from(value);
    if !dir.is_absolute() {
        return Err(format!("{SAVE_DIR_ENV} must be an absolute path"));
    }
    let dir = std::fs::canonicalize(&dir)
        .ok()
        .filter(|d| d.is_dir())
        .ok_or_else(|| format!("{SAVE_DIR_ENV}: no directory at {}", dir.display()))?;
    let home = home.ok_or_else(|| format!("{SAVE_DIR_ENV}: HOME is required"))?;
    if is_within(&dir, &canonical_directory(home)?) {
        return Err(format!(
            "{SAVE_DIR_ENV} must not be the home directory or inside it"
        ));
    }
    Ok(Some(dir))
}

/// The rules, separate from the environment so tests can drive them.
///
/// Both variables or neither. A binary without a data dir would run unverified code
/// on the product data dir, so that is refused rather than defaulted.
#[cfg_attr(not(all(debug_assertions, feature = "dev-node")), allow(dead_code))]
pub fn resolve_from(
    sidecar: Option<&str>,
    data_dir: Option<&str>,
    forbidden: &[PathBuf],
    home: Option<&Path>,
) -> Result<Option<DevNode>, String> {
    let (sidecar, data_dir) = match (non_empty(sidecar), non_empty(data_dir)) {
        (None, None) => return Ok(None),
        (Some(s), Some(d)) => (PathBuf::from(s), PathBuf::from(d)),
        (Some(_), None) => {
            return Err(format!(
                "{SIDECAR_ENV} is set but {DATA_DIR_ENV} is not; refusing to run an unverified node on the app data dir"
            ))
        }
        (None, Some(_)) => {
            return Err(format!("{DATA_DIR_ENV} is set but {SIDECAR_ENV} is not"))
        }
    };
    if !sidecar.is_absolute() {
        return Err(format!("{SIDECAR_ENV} must be an absolute path"));
    }
    if !sidecar.is_file() {
        return Err(format!("{SIDECAR_ENV}: no file at {}", sidecar.display()));
    }
    if !data_dir.is_absolute() {
        return Err(format!("{DATA_DIR_ENV} must be an absolute path"));
    }
    let data_dir = checked_data_dir(&data_dir, forbidden, home)?;
    Ok(Some(DevNode { sidecar, data_dir }))
}

fn checked_data_dir(
    data_dir: &Path,
    forbidden: &[PathBuf],
    home: Option<&Path>,
) -> Result<PathBuf, String> {
    let home =
        home.ok_or_else(|| format!("{DATA_DIR_ENV}: HOME is required for directory protection"))?;
    let data_dir = canonical_directory(data_dir)?;
    for app_dir in forbidden {
        if is_within(&data_dir, &canonical_directory(app_dir)?) {
            return Err(format!(
                "{DATA_DIR_ENV} is inside an app data dir ({}); use a separate dev dir",
                app_dir.display()
            ));
        }
    }
    if is_within(&data_dir, &canonical_directory(&home.join(".konsensus"))?) {
        return Err(format!("{DATA_DIR_ENV} must not be under ~/.konsensus"));
    }
    if is_within(&data_dir, &canonical_directory(home)?) {
        return Err(format!(
            "{DATA_DIR_ENV} must not be the home directory or inside it"
        ));
    }
    Ok(data_dir)
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// Resolve existing components with realpath before interpreting the next `..`.
/// Missing suffixes are allowed for first use, but dangling symlinks, non-directory
/// components and filesystem errors fail closed. Protected paths use this too.
fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    use std::path::Component;
    if !path.is_absolute() {
        return Err(format!(
            "{DATA_DIR_ENV}: protected and dev paths must be absolute"
        ));
    }
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => {
                out.push(name);
                match std::fs::symlink_metadata(&out) {
                    Ok(_) => {
                        out = std::fs::canonicalize(&out).map_err(|e| {
                            format!("{DATA_DIR_ENV}: cannot resolve {}: {e}", out.display())
                        })?;
                        if !out.is_dir() {
                            return Err(format!(
                                "{DATA_DIR_ENV}: {} is not a directory",
                                out.display()
                            ));
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => {
                        return Err(format!(
                            "{DATA_DIR_ENV}: cannot inspect {}: {e}",
                            out.display()
                        ))
                    }
                }
            }
            other => out.push(other),
        }
    }
    Ok(out)
}

fn is_within(path: &Path, protected: &Path) -> bool {
    // Filesystem identity also covers aliases whose Unicode spelling differs on
    // case-insensitive APFS. Missing suffixes are compared by component below.
    #[cfg(unix)]
    if let Ok(root) = std::fs::metadata(protected) {
        use std::os::unix::fs::MetadataExt;
        if path.ancestors().any(|ancestor| {
            std::fs::metadata(ancestor)
                .is_ok_and(|entry| entry.dev() == root.dev() && entry.ino() == root.ino())
        }) {
            return true;
        }
    }
    #[cfg(target_os = "macos")]
    {
        // Conservative on case-sensitive Mac volumes too: a different spelling
        // never turns a protected app/home path into an allowed dev directory.
        let mut parts = path.components();
        protected.components().all(|root| {
            parts.next().is_some_and(|part| {
                part.as_os_str().to_string_lossy().to_lowercase()
                    == root.as_os_str().to_string_lossy().to_lowercase()
            })
        })
    }
    #[cfg(not(target_os = "macos"))]
    path.starts_with(protected)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _tmp: tempfile::TempDir,
        bin: String,
        app: PathBuf,
        home: PathBuf,
        dev: String,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("konsensus");
        std::fs::write(&bin, b"").unwrap();
        let home = tmp.path().join("home");
        Fixture {
            bin: bin.to_string_lossy().into_owned(),
            app: home.join("Library/Application Support/tech.mindlink.bitsov"),
            dev: tmp.path().join("devnode").to_string_lossy().into_owned(),
            home,
            _tmp: tmp,
        }
    }

    fn run(
        f: &Fixture,
        sidecar: Option<&str>,
        data: Option<&str>,
    ) -> Result<Option<DevNode>, String> {
        resolve_from(sidecar, data, std::slice::from_ref(&f.app), Some(&f.home))
    }

    #[test]
    fn neither_variable_means_the_verified_sidecar() {
        let f = fixture();
        assert_eq!(run(&f, None, None), Ok(None));
        assert_eq!(run(&f, Some(" "), Some("")), Ok(None));
    }

    #[test]
    fn both_variables_select_the_dev_node() {
        let f = fixture();
        let dev = run(&f, Some(&f.bin), Some(&f.dev)).unwrap().unwrap();
        assert_eq!(dev.sidecar, PathBuf::from(&f.bin));
        assert_eq!(
            dev.data_dir,
            std::fs::canonicalize(f._tmp.path())
                .unwrap()
                .join("devnode")
        );
    }

    #[test]
    fn a_binary_without_a_data_dir_is_refused() {
        let f = fixture();
        let err = run(&f, Some(&f.bin), None).unwrap_err();
        assert!(err.contains(DATA_DIR_ENV), "{err}");
        assert!(run(&f, None, Some(&f.dev)).is_err());
    }

    #[test]
    fn relative_or_missing_paths_are_refused() {
        let f = fixture();
        assert!(run(&f, Some("konsensus"), Some(&f.dev)).is_err());
        assert!(run(&f, Some("/nonexistent/konsensus"), Some(&f.dev)).is_err());
        assert!(run(&f, Some(&f.bin), Some("devnode")).is_err());
    }

    #[test]
    fn the_product_data_dir_and_konsensus_home_are_refused() {
        let f = fixture();
        let app = f.app.to_string_lossy().into_owned();
        assert!(run(&f, Some(&f.bin), Some(&app)).is_err());
        let inside = f.app.join("sub").to_string_lossy().into_owned();
        assert!(run(&f, Some(&f.bin), Some(&inside)).is_err());
        let sneaky = format!("{}/x/..", app);
        assert!(run(&f, Some(&f.bin), Some(&sneaky)).is_err());
        let konsensus = f
            .home
            .join(".konsensus/node")
            .to_string_lossy()
            .into_owned();
        assert!(run(&f, Some(&f.bin), Some(&konsensus)).is_err());
        let home = f.home.to_string_lossy().into_owned();
        assert!(run(&f, Some(&f.bin), Some(&home)).is_err());
    }

    #[test]
    fn home_descendants_and_trailing_slashes_are_refused() {
        let f = fixture();
        for path in [f.home.join("fresh/node"), f.home.join("child/../")] {
            assert!(
                run(&f, Some(&f.bin), path.to_str()).is_err(),
                "{}",
                path.display()
            );
        }
        let trailing = format!("{}/", f.home.display());
        assert!(run(&f, Some(&f.bin), Some(&trailing)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_to_every_protected_directory_and_new_descendants_are_refused() {
        use std::os::unix::fs::symlink;
        let f = fixture();
        for (index, protected) in [f.home.clone(), f.home.join(".konsensus"), f.app.clone()]
            .iter()
            .enumerate()
        {
            std::fs::create_dir_all(protected).unwrap();
            let alias = f._tmp.path().join(format!("alias-{index}"));
            symlink(protected, &alias).unwrap();
            for path in [
                alias.clone(),
                alias.join("not-created/nested"),
                alias.join("./"),
            ] {
                assert!(
                    run(&f, Some(&f.bin), path.to_str()).is_err(),
                    "{}",
                    path.display()
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn parent_traversal_is_resolved_after_symlinks() {
        let f = fixture();
        let child = f.home.join("child");
        std::fs::create_dir_all(&child).unwrap();
        let alias = f._tmp.path().join("alias-child");
        std::os::unix::fs::symlink(child, &alias).unwrap();
        assert!(run(&f, Some(&f.bin), alias.join("../").to_str()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn protected_paths_are_canonicalized_too() {
        use std::os::unix::fs::symlink;
        let f = fixture();
        std::fs::create_dir_all(&f.home).unwrap();
        // Each protected root can itself be an alias to a directory outside HOME.
        for (index, protected) in [f.home.join(".konsensus"), f.app.clone()]
            .iter()
            .enumerate()
        {
            std::fs::create_dir_all(protected.parent().unwrap()).unwrap();
            let target = f._tmp.path().join(format!("relocated-{index}"));
            std::fs::create_dir(&target).unwrap();
            symlink(&target, protected).unwrap();
            assert!(run(&f, Some(&f.bin), target.to_str()).is_err());
            assert!(run(&f, Some(&f.bin), target.join("new").to_str()).is_err());
        }
        let home_alias = f._tmp.path().join("home-alias");
        symlink(&f.home, &home_alias).unwrap();
        assert!(resolve_from(Some(&f.bin), f.home.to_str(), &[], Some(&home_alias)).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_case_aliases_of_protected_paths_are_refused() {
        let f = fixture();
        std::fs::create_dir_all(f.home.join(".konsensus")).unwrap();
        for path in [
            f._tmp.path().join("HOME"),
            f.home.join(".KONSENSUS/"),
            f._tmp.path().join("HOME/not-created"),
        ] {
            assert!(
                run(&f, Some(&f.bin), path.to_str()).is_err(),
                "{}",
                path.display()
            );
        }
        // Test an app root outside HOME so the home guard cannot mask this check.
        let app = f._tmp.path().join("ProductApp");
        std::fs::create_dir(&app).unwrap();
        let alias = f._tmp.path().join("PRODUCTAPP/new");
        assert!(resolve_from(Some(&f.bin), alias.to_str(), &[app], Some(&f.home)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn accepted_symlink_is_returned_as_a_canonical_path() {
        let f = fixture();
        let target = f._tmp.path().join("safe");
        std::fs::create_dir(&target).unwrap();
        let alias = f._tmp.path().join("safe-alias");
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        let dev = run(&f, Some(&f.bin), alias.join("new/../node").to_str())
            .unwrap()
            .unwrap();
        assert_eq!(
            dev.data_dir,
            std::fs::canonicalize(target).unwrap().join("node")
        );
    }

    #[cfg(unix)]
    #[test]
    fn dangling_symlinks_are_refused_without_creating_directories() {
        let f = fixture();
        let target = f._tmp.path().join("missing");
        let alias = f._tmp.path().join("dangling");
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        assert!(run(&f, Some(&f.bin), alias.join("new").to_str()).is_err());
        assert!(!target.exists());
    }

    #[test]
    fn unavailable_home_cannot_disable_the_protection() {
        let f = fixture();
        assert!(resolve_from(Some(&f.bin), Some(&f.dev), &[f.app], None).is_err());
    }

    struct External {
        _tmp: tempfile::TempDir,
        app: PathBuf,
        node: PathBuf,
    }

    fn external_fixture(api: Option<&str>) -> External {
        let tmp = tempfile::tempdir().unwrap();
        let node = tmp.path().join("pilot");
        std::fs::create_dir(&node).unwrap();
        let mut config = String::from("[lightning]\nbackend = \"ldk\"\n");
        if let Some(api) = api {
            config.push_str(&format!("[api]\nlisten_addr = \"{api}\"\n"));
        }
        std::fs::write(node.join("konsensus.toml"), config).unwrap();
        std::fs::write(node.join("NODE_INITIALIZED"), b"").unwrap();
        External {
            app: tmp.path().join("app/tech.mindlink.bitsov.devnode"),
            node,
            _tmp: tmp,
        }
    }

    fn attach(
        f: &External,
        dir: Option<&str>,
        spawn_set: bool,
    ) -> Result<Option<ExternalNode>, String> {
        external_from(dir, spawn_set, std::slice::from_ref(&f.app), LOOPBACK_API)
    }

    #[test]
    fn external_unset_means_no_external_mode() {
        let f = external_fixture(Some("127.0.0.1:3141"));
        assert_eq!(attach(&f, None, false), Ok(None));
        assert_eq!(attach(&f, Some("  "), true), Ok(None));
    }

    #[test]
    fn external_attaches_to_an_initialised_loopback_node() {
        for api in [Some("127.0.0.1:3141"), None] {
            let f = external_fixture(api);
            let node = attach(&f, f.node.to_str(), false).unwrap().unwrap();
            let canonical = std::fs::canonicalize(&f.node).unwrap();
            assert_eq!(node.config, canonical.join("konsensus.toml"));
            assert_eq!(node.data_dir, canonical);
        }
    }

    #[test]
    fn external_refuses_the_spawn_variables_at_the_same_time() {
        let f = external_fixture(Some("127.0.0.1:3141"));
        let err = attach(&f, f.node.to_str(), true).unwrap_err();
        assert!(
            err.contains(SIDECAR_ENV) && err.contains(DATA_DIR_ENV),
            "{err}"
        );
    }

    #[test]
    fn external_refuses_other_api_binds() {
        for api in [
            "0.0.0.0:3141",
            "127.0.0.1:3142",
            "[::1]:3141",
            "192.168.1.5:3141",
        ] {
            let f = external_fixture(Some(api));
            let err = attach(&f, f.node.to_str(), false).unwrap_err();
            assert!(err.contains("127.0.0.1:3141"), "{api}: {err}");
        }
        let f = external_fixture(None);
        std::fs::write(f.node.join("konsensus.toml"), "not = [valid").unwrap();
        assert!(attach(&f, f.node.to_str(), false).is_err());
    }

    #[test]
    fn external_follows_a_moved_api_base() {
        let f = external_fixture(Some("127.0.0.1:47123"));
        let moved = external_from(
            f.node.to_str(),
            false,
            std::slice::from_ref(&f.app),
            "127.0.0.1:47123",
        );
        assert!(moved.unwrap().is_some());
        // The pilot's 3141 config is refused while the app talks to another port.
        let f = external_fixture(Some("127.0.0.1:3141"));
        let err = external_from(
            f.node.to_str(),
            false,
            std::slice::from_ref(&f.app),
            "127.0.0.1:47123",
        )
        .unwrap_err();
        assert!(err.contains("127.0.0.1:47123"), "{err}");
    }

    #[test]
    fn api_override_accepts_only_loopback_http_with_a_port() {
        assert_eq!(api_port_from(None), Ok(None));
        assert_eq!(api_port_from(Some("  ")), Ok(None));
        for ok in [
            "http://127.0.0.1:47123",
            "http://127.0.0.1:47123/",
            "http://127.0.0.1:47123/api/v1",
            " http://127.0.0.1:47123 ",
        ] {
            assert_eq!(api_port_from(Some(ok)), Ok(Some(47123)), "{ok}");
        }
        assert_eq!(api_port_from(Some("http://127.0.0.1:1")), Ok(Some(1)));
        assert_eq!(
            api_port_from(Some("http://127.0.0.1:65535/api/v1")),
            Ok(Some(65535))
        );
        for bad in [
            "http://127.0.0.1",
            "http://127.0.0.1:",
            "http://127.0.0.1:0",
            "http://127.0.0.1:03141",
            "http://127.0.0.1:65536",
            "http://127.0.0.1:+80",
            "http://127.0.0.1:80/api/v2",
            "http://127.0.0.1:80/api/v1/",
            "http://127.0.0.1:80?x=1",
            "http://127.0.0.1:80#x",
            "http://127.0.0.1.evil.example:80",
            "http://user@127.0.0.1:80",
            "http://localhost:80",
            "http://[::1]:80",
            "http://0.0.0.0:80",
            "http://192.168.1.5:80",
            "http://127.0.0.2:80",
            "https://127.0.0.1:80",
            "ws://127.0.0.1:80",
            "127.0.0.1:80",
        ] {
            let err = api_port_from(Some(bad)).unwrap_err();
            assert!(err.contains(API_BASE_ENV), "{bad}: {err}");
        }
    }

    #[test]
    fn save_dir_is_an_existing_absolute_dir_outside_home() {
        let f = fixture();
        std::fs::create_dir_all(&f.home).unwrap();
        let out = f._tmp.path().join("saved");
        std::fs::create_dir(&out).unwrap();
        assert_eq!(save_dir_from(None, Some(&f.home)), Ok(None));
        assert_eq!(
            save_dir_from(out.to_str(), Some(&f.home)),
            Ok(Some(std::fs::canonicalize(&out).unwrap()))
        );
        assert!(save_dir_from(Some("saved"), Some(&f.home)).is_err());
        assert!(save_dir_from(out.join("missing").to_str(), Some(&f.home)).is_err());
        assert!(save_dir_from(f.home.to_str(), Some(&f.home)).is_err());
        let inside = f.home.join("Downloads");
        std::fs::create_dir(&inside).unwrap();
        assert!(save_dir_from(inside.to_str(), Some(&f.home)).is_err());
        assert!(save_dir_from(out.to_str(), None).is_err());
    }

    /// Release builds (and debug builds without `dev-node`) talk to 127.0.0.1:3141
    /// whatever the environment says, and always open the native save dialog.
    /// `cargo test --release` runs this with `debug_assertions` off.
    #[cfg(not(all(debug_assertions, feature = "dev-node")))]
    #[test]
    fn release_ignores_the_api_base_and_save_dir_overrides() {
        // Only this test sets these variables, and the stubs never read them.
        std::env::set_var(API_BASE_ENV, "http://127.0.0.1:47123");
        std::env::set_var(SAVE_DIR_ENV, "/tmp");
        std::env::set_var("BITSOV_UI_E2E", "1");
        let product = "http://127.0.0.1:3141/api/v1";
        assert_eq!(api_base(product), Ok(product.to_string()));
        assert_eq!(save_dir(), Ok(None));
        let f = external_fixture(Some("127.0.0.1:47123"));
        assert_eq!(resolve_external(&f.app), Ok(None));
        std::env::remove_var(API_BASE_ENV);
        std::env::remove_var(SAVE_DIR_ENV);
        std::env::remove_var("BITSOV_UI_E2E");
    }

    #[test]
    fn external_refuses_relative_missing_and_uninitialised_dirs() {
        let f = external_fixture(Some("127.0.0.1:3141"));
        assert!(attach(&f, Some("pilot"), false).is_err());
        let missing = f.node.join("missing");
        assert!(attach(&f, missing.to_str(), false).is_err());
        std::fs::remove_file(f.node.join("NODE_INITIALIZED")).unwrap();
        let err = attach(&f, f.node.to_str(), false).unwrap_err();
        assert!(err.contains("never initialises"), "{err}");
        assert!(!f.node.join("NODE_INITIALIZED").exists());
    }

    #[test]
    fn external_refuses_app_data_dirs() {
        let f = external_fixture(Some("127.0.0.1:3141"));
        std::fs::create_dir_all(&f.app).unwrap();
        std::fs::write(f.app.join("konsensus.toml"), "").unwrap();
        std::fs::write(f.app.join("NODE_INITIALIZED"), "").unwrap();
        let err = attach(&f, f.app.to_str(), false).unwrap_err();
        assert!(err.contains("app data dir"), "{err}");
    }

    /// Without `debug_assertions` + `dev-node`, external mode never exists.
    #[cfg(not(all(debug_assertions, feature = "dev-node")))]
    #[test]
    fn builds_without_the_feature_have_no_external_mode() {
        let f = external_fixture(Some("127.0.0.1:3141"));
        assert_eq!(resolve_external(&f.app), Ok(None));
    }

    /// Without `debug_assertions` + `dev-node`, `resolve` must be the stub: no override
    /// whatever the environment says. (`cargo test` builds without `dev-node`.)
    #[cfg(not(all(debug_assertions, feature = "dev-node")))]
    #[test]
    fn builds_without_the_feature_ignore_the_environment() {
        let f = fixture();
        // Not set via std::env::set_var: tests run in parallel. The stub takes no
        // environment at all, which is what the source check below pins.
        assert_eq!(resolve(&f.app), Ok(None));
    }

    #[test]
    fn release_guard_and_gates_are_in_place() {
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/dev_node.rs"),
        )
        .unwrap();
        let source = source.split("#[cfg(test)]").next().unwrap();
        assert!(source.contains(
            "#[cfg(all(feature = \"dev-node\", not(debug_assertions)))]\ncompile_error!("
        ));
        let gate = "#[cfg(all(debug_assertions, feature = \"dev-node\"))]\npub fn resolve(";
        let stub = "#[cfg(not(all(debug_assertions, feature = \"dev-node\")))]\npub fn resolve(_app_data_dir: &Path) -> Result<Option<DevNode>, String> {\n    Ok(None)\n}";
        assert!(source.contains(gate));
        assert!(source.contains(stub));
        let external_gate =
            "#[cfg(all(debug_assertions, feature = \"dev-node\"))]\npub fn resolve_external(";
        let external_stub = "#[cfg(not(all(debug_assertions, feature = \"dev-node\")))]\npub fn resolve_external(_app_data_dir: &Path) -> Result<Option<ExternalNode>, String> {\n    Ok(None)\n}";
        assert!(source.contains(external_gate));
        assert!(source.contains(external_stub));
        let api_stub = "#[cfg(not(all(debug_assertions, feature = \"dev-node\")))]\npub fn api_base(product: &str) -> Result<String, String> {\n    Ok(product.to_string())\n}";
        let save_stub = "#[cfg(not(all(debug_assertions, feature = \"dev-node\")))]\npub fn save_dir() -> Result<Option<PathBuf>, String> {\n    Ok(None)\n}";
        assert!(source
            .contains("#[cfg(all(debug_assertions, feature = \"dev-node\"))]\npub fn api_base("));
        assert!(source.contains(api_stub));
        assert!(source
            .contains("#[cfg(all(debug_assertions, feature = \"dev-node\"))]\npub fn save_dir("));
        assert!(source.contains(save_stub));
        // Only the gated bodies read the environment.
        assert_eq!(source.matches("std::env::var").count(), 10);
        for stub in [api_stub, save_stub] {
            let body = &source[source.find(stub).unwrap()..][..stub.len()];
            assert!(!body.contains("std::env"), "{body}");
        }
        let external_at = source.find(external_gate).unwrap();
        assert!(source[external_at..source.find(external_stub).unwrap()].contains("std::env::var"));
        let stub_at = source.find(stub).unwrap();
        assert!(source.find("std::env::var").unwrap() < stub_at);

        let manifest = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"),
        )
        .unwrap();
        assert!(
            manifest.contains("default = []"),
            "dev-node must never be a default feature"
        );
    }
}
