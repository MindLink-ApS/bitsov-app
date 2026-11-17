//! Shared bad-file table for app-side persistent stores (tests only).
//!
//! Every case plants one damaged file where a store expects its own and runs
//! the store's loader. The loader must refuse with an error: treating the
//! file as absent, resetting it, or accepting it are all failures. The planted
//! path and its directory must be byte-for-byte unchanged afterwards, so a
//! rename to a backup followed by a fresh empty store is also a failure.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// One damaged input.
#[derive(Clone, Debug)]
pub enum Bad {
    /// The format version one above the one this build writes.
    NewerVersion,
    /// The format version field removed.
    MissingVersion,
    /// A field this build does not know, as a newer build would write it.
    UnknownField,
    Garbage,
    /// The valid bytes cut after this many bytes.
    Truncated(usize),
    Empty,
    /// Valid JSON of the wrong shape.
    WrongShape(&'static str),
    /// A directory where the file is expected.
    Directory,
    /// A symlink whose target does not exist.
    DanglingSymlink,
}

/// A store under test. `prepare` creates whatever else a load needs (a key,
/// a lock) inside the directory; `file` names the store's file in it.
pub struct Store<'a> {
    pub name: &'a str,
    /// Bytes this build writes and reads back successfully.
    pub valid: Vec<u8>,
    /// JSON key holding the format version, when the format has one.
    pub version_key: Option<&'a str>,
    pub prepare: &'a dyn Fn(&Path),
    pub file: &'a dyn Fn(&Path) -> PathBuf,
    /// `Ok` means the store accepted or ignored the file.
    pub load: &'a dyn Fn(&Path) -> Result<(), String>,
    /// Names the loader may create next to the file (locks), never backups.
    pub may_create: &'a [&'a str],
}

/// The standard table for a JSON store.
pub fn json_cases(store: &Store<'_>) -> Vec<Bad> {
    let len = store.valid.len();
    let mut cases = vec![Bad::UnknownField, Bad::Garbage, Bad::Empty, Bad::Directory, Bad::DanglingSymlink];
    if store.version_key.is_some() {
        cases.extend([Bad::NewerVersion, Bad::MissingVersion]);
    }
    for cut in [1, len / 4, len / 2, len - 1] {
        cases.push(Bad::Truncated(cut));
    }
    for shape in ["null", "42", "\"text\"", "[]", "{}", "[{}]"] {
        cases.push(Bad::WrongShape(shape));
    }
    cases
}

fn edit_json(valid: &[u8], edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>)) -> Vec<u8> {
    let mut value: serde_json::Value = serde_json::from_slice(valid).expect("valid fixture is JSON");
    edit(value.as_object_mut().expect("valid fixture is a JSON object"));
    serde_json::to_vec(&value).unwrap()
}

/// Plant `bad` at `path`. Returns `false` when the case does not apply.
pub fn plant(path: &Path, store: &Store<'_>, bad: &Bad) -> bool {
    let valid = &store.valid;
    let bytes = match bad {
        Bad::NewerVersion => {
            let Some(key) = store.version_key else { return false };
            edit_json(valid, |map| {
                let current = map[key].as_u64().expect("numeric version");
                map.insert(key.into(), (current + 1).into());
            })
        }
        Bad::MissingVersion => {
            let Some(key) = store.version_key else { return false };
            edit_json(valid, |map| { map.remove(key); })
        }
        Bad::UnknownField => edit_json(valid, |map| {
            map.insert("format_from_a_newer_build".into(), serde_json::json!(true));
        }),
        Bad::Garbage => b"\x00\xff garbage \x7f not a store".to_vec(),
        Bad::Truncated(cut) => valid[..*cut].to_vec(),
        Bad::Empty => Vec::new(),
        Bad::WrongShape(shape) => shape.as_bytes().to_vec(),
        Bad::Directory => {
            std::fs::create_dir_all(path.join("inside")).unwrap();
            std::fs::write(path.join("inside/keep"), b"keep").unwrap();
            return true;
        }
        Bad::DanglingSymlink => {
            std::os::unix::fs::symlink(path.with_file_name("no-such-target"), path).unwrap();
            return true;
        }
    };
    write_private(path, &bytes);
    true
}

/// Owner-only, so a permission check never hides the parser's answer.
pub fn write_private(path: &Path, bytes: &[u8]) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, bytes).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

#[derive(Debug, PartialEq, Eq)]
enum Entry {
    File(Vec<u8>),
    Dir(BTreeMap<String, Entry>),
    Link(PathBuf),
}

fn snapshot(path: &Path) -> Entry {
    let meta = std::fs::symlink_metadata(path).unwrap();
    if meta.file_type().is_symlink() {
        Entry::Link(std::fs::read_link(path).unwrap())
    } else if meta.is_dir() {
        Entry::Dir(std::fs::read_dir(path).unwrap()
            .map(|e| {
                let e = e.unwrap();
                (e.file_name().to_string_lossy().into_owned(), snapshot(&e.path()))
            })
            .collect())
    } else {
        Entry::File(std::fs::read(path).unwrap())
    }
}

/// Run `cases` and panic with one line per failure.
pub fn assert_refuses(store: &Store<'_>, cases: &[Bad]) -> usize {
    // The table is only meaningful if the same setup reads a good file.
    let good = tempfile::tempdir().unwrap();
    (store.prepare)(good.path());
    let path = (store.file)(good.path());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    write_private(&path, &store.valid);
    if let Err(error) = (store.load)(good.path()) {
        panic!("{}: the valid fixture must load: {error}", store.name);
    }
    let mut failures = Vec::new();
    let mut ran = 0;
    for bad in cases {
        let dir = tempfile::tempdir().unwrap();
        (store.prepare)(dir.path());
        let path = (store.file)(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        if !plant(&path, store, bad) {
            continue;
        }
        ran += 1;
        let root = path.parent().unwrap();
        let before = snapshot(root);
        let result = (store.load)(dir.path());
        let mut after = snapshot(root);
        if let Entry::Dir(entries) = &mut after {
            entries.retain(|name, _| {
                !store.may_create.contains(&name.as_str()) || matches!(&before, Entry::Dir(b) if b.contains_key(name))
            });
        }
        if result.is_ok() {
            failures.push(format!("{} / {bad:?}: accepted or treated as absent", store.name));
        }
        if after != before {
            failures.push(format!("{} / {bad:?}: the store directory changed", store.name));
        }
    }
    assert!(failures.is_empty(), "{} store must fail closed:\n{}", store.name, failures.join("\n"));
    ran
}
