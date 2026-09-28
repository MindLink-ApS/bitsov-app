//! Independent-owner first-contact handoff. The app never obtains the owner's
//! credential. The owner runs the HTTP command at the node, which writes only
//! the public response. A receipt is a readiness signal, not spend authority:
//! the node still checks and consumes its actual single-use grant on compose.
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use serde::{Deserialize, Serialize};
use crate::{act::ActionError, grant::NodeGrant};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Request {
    pub client_id: String,
    pub grant_op_id: String,
    pub recipient: String,
    pub max_total_msat: u64,
    pub contact_budget_msat: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct View {
    pub id: String,
    pub request: Request,
    pub owner_command: String,
    pub ready: bool,
    pub expires_at_ms: u64,
}

pub struct Pending {
    pub view: View,
    pub fence: (u64, u64),
    dir: tempfile::TempDir,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    recipient: String,
    max_total_msat: u64,
    expires_at: i64,
}

fn quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\"'\"'")) }
fn waiting() -> ActionError {
    ActionError::new("owner_only", "Approve this contact at your node. Nothing was sent.")
}

impl Pending {
    pub fn new(base: &str, request: Request, fence: (u64, u64), now: u64, grant: &NodeGrant) -> Result<Self, ActionError> {
        for id in [&request.client_id, &request.grant_op_id] {
            if id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(crate::grant::unreadable());
            }
        }
        let mut builder = tempfile::Builder::new();
        builder.prefix("bitsov-owner-contact-");
        // Restrict access in mkdir itself: a later chmod leaves a planting window.
        #[cfg(unix)]
        builder.permissions(std::fs::Permissions::from_mode(0o700));
        let dir = builder.tempdir()
            .map_err(|_| ActionError::node("Cannot prepare the owner approval receipt."))?;
        let id = dir.path().file_name().unwrap().to_string_lossy().into_owned();
        let receipt = quote(&dir.path().join("receipt.json").to_string_lossy());
        let partial = quote(&dir.path().join("receipt.part").to_string_lossy());
        let body = quote(&serde_json::to_string(&request).map_err(|_| crate::grant::unreadable())?);
        // Header comes from the OWNER'S environment over stdin, never argv,
        // the app, the command text, or the receipt. No redirect following.
        // Noclobber opens a fresh partial before curl runs. Curl writes to that
        // descriptor via stdout, never reopening a potentially planted path.
        // Also reject nonregular files/symlinks, which noclobber alone permits.
        let owner_command = format!(
            "(set +x; umask 077; set -C; [ ! -e {partial} ] && [ ! -L {partial} ] && {{ printf 'Authorization: Bearer %s\\n' \"${{BITSOV_OWNER_TOKEN:?Set an independent node owner credential in this terminal}}\" | curl --fail --silent --show-error --max-time 20 --proto '=http' --header @- --header 'Content-Type: application/json' --data {body} --output - {}; }} > {partial} && mv {partial} {receipt})",
            quote(&format!("{base}/pair/first-contact-grant")));
        Ok(Self { view: View { id, request, owner_command, ready: false,
            expires_at_ms: now.saturating_add(15 * 60_000).min(grant.expires_at_ms()) }, fence, dir })
    }

    pub fn status(&self, grant: &NodeGrant, fence: (u64, u64), now: u64) -> Result<View, ActionError> {
        let r = &self.view.request;
        if self.fence != fence || self.view.expires_at_ms <= now ||
            grant.client_id != r.client_id || grant.op_id != r.grant_op_id {
            return Err(ActionError::new("owner_only", "This owner request ended or the budget grant changed. Cancel and request approval again."));
        }
        grant.check(r.max_total_msat, Some(&r.recipient), now)?;
        let mut view = self.view.clone();
        let path = self.dir.path().join("receipt.json");
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(view),
            Err(_) => return Err(waiting()),
        };
        if !metadata.is_file() || metadata.len() > 4096 { return Err(waiting()); }
        let mut bytes = Vec::new();
        std::fs::File::open(path).map_err(|_| waiting())?.take(4097)
            .read_to_end(&mut bytes).map_err(|_| waiting())?;
        let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|_| waiting())?;
        let until = u64::try_from(receipt.expires_at).unwrap_or(0).saturating_mul(1000);
        if receipt.recipient != r.recipient || receipt.max_total_msat != r.max_total_msat ||
            until <= now || until > grant.expires_at_ms() || until > now.saturating_add(120_000) {
            return Err(ActionError::new("owner_only", "The owner approval receipt is expired or does not match this contact and cap. Request approval again."));
        }
        view.ready = true;
        view.expires_at_ms = until;
        Ok(view)
    }

    #[cfg(test)]
    pub fn write_receipt(&self, recipient: &str, cap: u64, expires_at: i64) {
        std::fs::write(self.dir.path().join("receipt.json"), serde_json::json!({
            "recipient": recipient, "max_total_msat": cap, "expires_at": expires_at,
        }).to_string()).unwrap();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::process::Command;
    use std::sync::mpsc;
    use std::time::Duration;

    fn pending(base: &str) -> Pending {
        let grant = NodeGrant {
            client_id: "c1".into(), op_id: "ab12".into(), expires_at: 120,
            budget_msat: 50_000, used_msat: 0, remaining_msat: 50_000,
            per_call_max_msat: 5_000, per_recipient_msat: Default::default(),
            used_by_recipient: Default::default(),
        };
        Pending::new(base, Request {
            client_id: "c1".into(), grant_op_id: "ab12".into(),
            recipient: "a".repeat(64), max_total_msat: 5_000, contact_budget_msat: 50_000,
        }, (0, 0), 0, &grant).unwrap()
    }

    #[test]
    fn receipt_directory_is_private_under_permissive_umasks() {
        // Change umask only in a subprocess, never in the parallel test runner.
        if std::env::var_os("BITSOV_TEST_RECEIPT_UMASK_CHILD").is_some() {
            let p = pending("http://127.0.0.1:1/api/v1");
            assert_eq!(std::fs::metadata(p.dir.path()).unwrap().permissions().mode() & 0o777, 0o700);
            return;
        }
        let mut failures = Vec::new();
        for mask in ["000", "002", "022"] {
            let output = Command::new("/bin/sh")
                .args(["-c", "umask \"$1\"; exec \"$2\" --exact owner_contact::tests::receipt_directory_is_private_under_permissive_umasks --nocapture", "receipt-umask", mask])
                .arg(std::env::current_exe().unwrap())
                .env("BITSOV_TEST_RECEIPT_UMASK_CHILD", "1")
                .env("TMPDIR", "/tmp")
                .output().unwrap();
            if !output.status.success() {
                failures.push(format!("umask {mask}: {}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    // Real curl and a loopback response exercise the generated shell command.
    struct Fixture {
        base: String,
        stop: mpsc::Sender<()>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Fixture {
        fn new() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://127.0.0.1:{}/api/v1", listener.local_addr().unwrap().port());
            listener.set_nonblocking(true).unwrap();
            let (stop, stopped) = mpsc::channel();
            let thread = std::thread::spawn(move || loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                        let mut reader = BufReader::new(&mut stream);
                        let mut length = 0;
                        loop {
                            let mut line = String::new();
                            reader.read_line(&mut line).unwrap();
                            if line == "\r\n" || line.is_empty() { break; }
                            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                                length = value.trim().parse().unwrap();
                            }
                        }
                        reader.read_exact(&mut vec![0; length]).unwrap();
                        let body = format!("{{\"recipient\":\"{}\",\"max_total_msat\":5000,\"expires_at\":120}}", "a".repeat(64));
                        write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if stopped.recv_timeout(Duration::from_millis(5)) != Err(mpsc::RecvTimeoutError::Timeout) { break; }
                    }
                    Err(e) => panic!("fixture accept: {e}"),
                }
            });
            Self { base, stop, thread: Some(thread) }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.stop.send(());
            self.thread.take().unwrap().join().unwrap();
        }
    }

    fn run_owner(p: &Pending) -> std::process::Output {
        Command::new("/bin/sh").args(["-c", &p.view.owner_command])
            .env("BITSOV_OWNER_TOKEN", "synthetic-independent-owner")
            .env("NO_PROXY", "127.0.0.1").output().unwrap()
    }

    #[test]
    fn owner_command_refuses_a_planted_partial_symlink_without_touching_victim() {
        let fixture = Fixture::new();
        let p = pending(&fixture.base);
        let victim = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(victim.path(), "ORIGINAL DUMMY CONTENT").unwrap();
        let partial = p.dir.path().join("receipt.part");
        symlink(victim.path(), &partial).unwrap();
        let output = run_owner(&p);
        assert_eq!(std::fs::read_to_string(victim.path()).unwrap(), "ORIGINAL DUMMY CONTENT");
        assert!(!output.status.success());
        assert!(partial.is_symlink());
        assert!(!p.dir.path().join("receipt.json").exists());
    }

    #[test]
    fn owner_command_refuses_an_existing_partial_file() {
        let fixture = Fixture::new();
        let p = pending(&fixture.base);
        let partial = p.dir.path().join("receipt.part");
        std::fs::write(&partial, "existing partial").unwrap();
        let output = run_owner(&p);
        assert_eq!(std::fs::read_to_string(partial).unwrap(), "existing partial");
        assert!(!output.status.success());
        assert!(!p.dir.path().join("receipt.json").exists());
    }

    #[test]
    fn owner_command_refuses_a_dangling_partial_symlink() {
        let fixture = Fixture::new();
        let p = pending(&fixture.base);
        let target = p.dir.path().join("must-not-be-created");
        symlink(&target, p.dir.path().join("receipt.part")).unwrap();
        let output = run_owner(&p);
        assert!(!target.exists());
        assert!(!output.status.success());
        assert!(!p.dir.path().join("receipt.json").exists());
    }

    #[test]
    fn owner_command_refuses_a_partial_symlink_to_a_device() {
        let fixture = Fixture::new();
        let p = pending(&fixture.base);
        let partial = p.dir.path().join("receipt.part");
        symlink("/dev/null", &partial).unwrap();
        let output = run_owner(&p);
        assert!(!output.status.success());
        assert!(partial.is_symlink());
        assert!(!p.dir.path().join("receipt.json").is_symlink());
    }

    #[test]
    fn owner_command_publishes_a_private_regular_receipt() {
        let fixture = Fixture::new();
        let p = pending(&fixture.base);
        let output = run_owner(&p);
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let receipt = p.dir.path().join("receipt.json");
        let metadata = std::fs::symlink_metadata(&receipt).unwrap();
        assert!(metadata.is_file());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        let body: serde_json::Value = serde_json::from_slice(&std::fs::read(receipt).unwrap()).unwrap();
        assert_eq!(body, serde_json::json!({"recipient": "a".repeat(64), "max_total_msat": 5000, "expires_at": 120}));
        assert!(!p.dir.path().join("receipt.part").exists());
    }
}
