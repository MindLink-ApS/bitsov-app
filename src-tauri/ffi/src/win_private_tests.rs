//! Native Windows tests for the private-file layer. They need NTFS and an
//! unelevated account; on an elevated runner they check the refusal instead.

use super::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);

/// A fresh folder under the system temp folder, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("bitsov-private-{}-{name}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn private(&self) -> PathBuf {
        let dir = self.0.join("private");
        create_dir_private(&dir).unwrap();
        dir
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn elevated() -> bool {
    let token = open_process_token().expect("token");
    token_is_elevated(&token).expect("elevation")
}

fn refusal(error: &io::Error) -> Option<Refusal> {
    error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<Refusal>())
        .copied()
}

fn assert_refused(result: io::Result<VerifiedFile>, why: Refusal) {
    let error = result.expect_err("must refuse");
    assert_eq!(refusal(&error), Some(why), "{error}");
}

fn user_sid() -> String {
    current_user().unwrap().as_str().to_owned()
}

/// Skip adversarial cases on an elevated runner; those runs prove the gate.
macro_rules! unelevated {
    () => {
        if elevated() {
            eprintln!("elevated process: covered by every_entry_point_refuses_when_elevated");
            return;
        }
    };
}

#[test]
fn every_entry_point_refuses_when_elevated() {
    if !elevated() {
        assert!(elevation_gate().is_ok());
        return;
    }
    let scratch = Scratch::new("elevated");
    let dir = scratch.0.join("private");
    assert_eq!(
        refusal(&elevation_gate().unwrap_err()),
        Some(Refusal::Elevated)
    );
    assert_refused(create_dir_private(&dir), Refusal::Elevated);
    assert_refused(
        create_new_private(&scratch.0.join("new")),
        Refusal::Elevated,
    );
    assert_refused(open_lock(&scratch.0.join("lock")), Refusal::Elevated);
    assert_refused(
        open_verified(&scratch.0, ObjectKind::Dir, Access::Read),
        Refusal::Elevated,
    );
    assert_eq!(
        refusal(&sync_dir(&scratch.0).unwrap_err()),
        Some(Refusal::Elevated)
    );
    // Nothing was written.
    assert_eq!(std::fs::read_dir(&scratch.0).unwrap().count(), 0);
}

#[test]
#[ignore = "manual: run from an elevated (Run as administrator) shell"]
fn an_elevated_shell_is_refused() {
    assert_eq!(
        refusal(&elevation_gate().unwrap_err()),
        Some(Refusal::Elevated)
    );
}

#[test]
fn private_objects_round_trip_through_one_handle() {
    unelevated!();
    let scratch = Scratch::new("round-trip");
    let dir = scratch.private();
    let dest = dir.join("record.json");
    for body in [&b"first"[..], b"second, longer body"] {
        let mut file = create_new_private(&dir.join("record.json.tmp")).unwrap();
        file.replace_contents(body).unwrap();
        publish(file, &dest, body).unwrap();
        let mut read = open_verified(&dest, ObjectKind::File, Access::Read).unwrap();
        assert_eq!(read.read_bounded(64).unwrap().as_slice(), body);
        assert!(!dir.join("record.json.tmp").exists());
    }
    // An existing private folder is opened and verified, not recreated.
    create_dir_private(&dir).unwrap();
    sync_dir(&dir).unwrap();
}

#[test]
fn reads_are_bounded_on_the_handle() {
    unelevated!();
    let scratch = Scratch::new("bounded");
    let dir = scratch.private();
    let mut file = create_new_private(&dir.join("big")).unwrap();
    file.replace_contents(&[7; 100]).unwrap();
    assert_eq!(
        file.read_bounded(99).unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    assert_eq!(file.read_bounded(100).unwrap().len(), 100);
}

#[test]
fn a_readback_mismatch_does_not_publish() {
    unelevated!();
    let scratch = Scratch::new("readback");
    let dir = scratch.private();
    let mut file = create_new_private(&dir.join("x.tmp")).unwrap();
    file.replace_contents(b"written").unwrap();
    assert!(publish(file, &dir.join("x"), b"expected").is_err());
    assert!(!dir.join("x").exists());
    assert_eq!(std::fs::read(dir.join("x.tmp")).unwrap(), b"written");
}

#[test]
fn an_existing_file_is_never_opened_or_truncated_by_create_new() {
    unelevated!();
    let scratch = Scratch::new("existing");
    let dir = scratch.private();
    let private = dir.join("leftover.tmp");
    let mut file = create_new_private(&private).unwrap();
    file.replace_contents(b"leftover").unwrap();
    drop(file);
    let plain = scratch.0.join("plain.tmp");
    std::fs::write(&plain, b"plain").unwrap();
    for (path, body) in [(&private, &b"leftover"[..]), (&plain, b"plain")] {
        let error = create_new_private(path).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(path).unwrap(), body);
    }
}

#[test]
fn a_foreign_owner_is_refused() {
    unelevated!();
    // System folders are owned by a system account, not the test user.
    let root = PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot"));
    assert_refused(
        open_verified(&root, ObjectKind::Dir, Access::Read),
        Refusal::ForeignOwner,
    );
    let hosts = root
        .join("System32")
        .join("drivers")
        .join("etc")
        .join("hosts");
    if hosts.exists() {
        let before = std::fs::read(&hosts).unwrap();
        assert_refused(
            open_verified(&hosts, ObjectKind::File, Access::Read),
            Refusal::ForeignOwner,
        );
        assert_eq!(std::fs::read(&hosts).unwrap(), before);
    }
}

#[test]
fn widened_access_lists_are_refused_and_left_unchanged() {
    unelevated!();
    let scratch = Scratch::new("acl");
    let dir = scratch.private();
    let sid = user_sid();
    let cases = [
        (
            format!("O:{sid}D:P(A;;FA;;;{sid})(A;;FR;;;WD)"),
            Refusal::ForeignAce,
        ),
        (
            format!("O:{sid}D:P(D;;FW;;;WD)(A;;FA;;;{sid})"),
            Refusal::DenyAce,
        ),
        (
            format!("O:{sid}D:P(A;;FA;;;{sid})(A;;FA;;;{sid})"),
            Refusal::ExtraAce,
        ),
        (
            format!("O:{sid}D:P(A;ID;FA;;;{sid})"),
            Refusal::InheritedAce,
        ),
        (
            format!("O:{sid}D:(A;;FA;;;{sid})"),
            Refusal::UnprotectedDacl,
        ),
        (
            format!("O:{sid}D:P(A;OICI;FA;;;{sid})"),
            Refusal::UnexpectedAceFlags,
        ),
        (format!("O:{sid}D:P"), Refusal::EmptyDacl),
    ];
    for (index, (sddl, why)) in cases.iter().enumerate() {
        let path = dir.join(format!("case-{index}"));
        create_with_sddl(&path, sddl, false).unwrap();
        for access in [Access::Read, Access::ReadWrite] {
            let result = open_verified(&path, ObjectKind::File, access);
            // The OS itself already denies some of these opens; either way
            // nothing is returned.
            let os_denied = *why == Refusal::EmptyDacl
                || (*why == Refusal::DenyAce && access == Access::ReadWrite);
            if os_denied {
                assert!(result.is_err(), "{sddl}");
                continue;
            }
            assert_refused(result, *why);
        }
        if *why != Refusal::EmptyDacl {
            assert_eq!(std::fs::read(&path).unwrap(), b"fixture", "{sddl}");
        }
    }
    // A folder with a widened list is refused the same way.
    let wide = dir.join("wide-dir");
    create_with_sddl(
        &wide,
        &format!("O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;FR;;;WD)"),
        true,
    )
    .unwrap();
    assert_refused(create_dir_private(&wide), Refusal::ForeignAce);
}

#[test]
fn inherited_children_and_plain_folders_are_refused_not_repaired() {
    unelevated!();
    let scratch = Scratch::new("inherit");
    let dir = scratch.private();
    // Ordinary creation inherits the parent's entry: refused, even though it
    // names only the user.
    let child = dir.join("inherited.json");
    std::fs::write(&child, b"child").unwrap();
    assert_refused(
        open_verified(&child, ObjectKind::File, Access::Read),
        Refusal::UnprotectedDacl,
    );
    assert_eq!(std::fs::read(&child).unwrap(), b"child");
    // A folder made by ordinary creation is refused and keeps its contents.
    let plain = scratch.0.join("plain-dir");
    std::fs::create_dir(&plain).unwrap();
    std::fs::write(plain.join("keep"), b"keep").unwrap();
    assert_refused(create_dir_private(&plain), Refusal::UnprotectedDacl);
    assert_eq!(std::fs::read(plain.join("keep")).unwrap(), b"keep");
    assert_refused(
        open_verified(&plain, ObjectKind::Dir, Access::Read),
        Refusal::UnprotectedDacl,
    );
}

fn junction(link: &Path, target: &Path) {
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "mklink /J failed");
}

#[test]
fn junctions_are_refused_and_their_targets_untouched() {
    unelevated!();
    let scratch = Scratch::new("junction");
    let dir = scratch.private();
    let target = scratch.private_target();
    std::fs::write(target.join("canary"), b"canary").unwrap();
    let link = dir.join("link");
    junction(&link, &target);
    assert_refused(
        open_verified(&link, ObjectKind::Dir, Access::Read),
        Refusal::Reparse,
    );
    assert_refused(create_dir_private(&link), Refusal::Reparse);
    assert_eq!(
        create_new_private(&link).unwrap_err().kind(),
        io::ErrorKind::AlreadyExists
    );
    assert!(sync_dir(&link).is_err());
    assert_eq!(std::fs::read(target.join("canary")).unwrap(), b"canary");
    assert_eq!(std::fs::read_dir(&target).unwrap().count(), 1);
}

impl Scratch {
    fn private_target(&self) -> PathBuf {
        let dir = self.0.join("target");
        create_dir_private(&dir).unwrap();
        dir
    }
}

#[test]
fn hard_links_are_refused_and_the_canary_is_unchanged() {
    unelevated!();
    let scratch = Scratch::new("hardlink");
    let dir = scratch.private();
    let canary = dir.join("canary");
    let mut file = create_new_private(&canary).unwrap();
    file.replace_contents(b"canary").unwrap();
    drop(file);
    let alias = dir.join("record.json.tmp");
    std::fs::hard_link(&canary, &alias).unwrap();
    for path in [&alias, &canary] {
        assert_refused(
            open_verified(path, ObjectKind::File, Access::Read),
            Refusal::Linked,
        );
        assert_refused(
            open_verified(path, ObjectKind::File, Access::ReadWrite),
            Refusal::Linked,
        );
    }
    assert_eq!(
        create_new_private(&alias).unwrap_err().kind(),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(std::fs::read(&canary).unwrap(), b"canary");
}

#[test]
fn a_held_handle_cannot_be_swapped_out() {
    unelevated!();
    let scratch = Scratch::new("swap");
    let dir = scratch.private();
    let path = dir.join("held");
    let mut file = create_new_private(&path).unwrap();
    file.replace_contents(b"original").unwrap();
    // Exclusive sharing: no rename, delete or second open while it is held.
    assert!(std::fs::rename(&path, dir.join("moved")).is_err());
    assert!(std::fs::remove_file(&path).is_err());
    assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());
    assert_eq!(file.read_bounded(64).unwrap().as_slice(), b"original");
}

#[test]
fn lock_files_share_opens_and_exclude_by_os_lock() {
    unelevated!();
    let scratch = Scratch::new("lock");
    let dir = scratch.private();
    let path = dir.join("spend.lock");
    let first = open_lock(&path).unwrap();
    let second = open_lock(&path).unwrap();
    first.as_file().try_lock().unwrap();
    assert!(second.as_file().try_lock().is_err());
    assert!(
        std::fs::remove_file(&path).is_err(),
        "an open lock file cannot be replaced"
    );
    first.as_file().unlock().unwrap();
    second.as_file().try_lock().unwrap();
}

#[test]
fn sync_dir_refuses_files_and_reports_errors() {
    unelevated!();
    let scratch = Scratch::new("sync");
    let dir = scratch.private();
    sync_dir(&dir).unwrap();
    let file = create_new_private(&dir.join("f")).unwrap();
    drop(file);
    assert!(sync_dir(&dir.join("f")).is_err());
    assert!(sync_dir(&dir.join("missing")).is_err());
}
