//! Independent-owner first-contact handoff. The app never obtains the owner's
//! credential. Local nodes retain the CLI receipt; remote nodes expose a paired
//! status read. Both are readiness signals, not spend authority: the node still
//! checks and consumes its actual single-use grant on compose.
use std::io::Read;
use std::path::Path;
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_window_secs: Option<u64>,
}

pub struct Pending {
    pub view: View,
    pub fence: (u64, u64),
    dir: Option<tempfile::TempDir>,
    remote_started_at: Option<u64>,
    replaced_approval: Option<RemoteReply>,
}

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    recipient: String,
    max_total_msat: u64,
    expires_at: i64,
}

const REMOTE_APPROVAL_WINDOW_SECS: u64 = 300;

#[derive(Clone, PartialEq, Eq, Deserialize)]
struct RemoteReply {
    grant_op_id: String,
    recipient: String,
    state: String,
    approval_window_secs: u64,
    approval: Option<Receipt>,
}

pub fn unavailable() -> ActionError {
    ActionError::new("owner_contact_unavailable", "Remote contact approval status is not available: this may be an older node, owner control may be off, or the budget operation may have ended. Check the node and request approval again. Nothing was sent.")
}
fn expired() -> ActionError {
    ActionError::new("owner_contact_expired", "Contact approval expired. Get a fresh quote and request approval again. Nothing was sent.")
}

fn quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\"'\"'")) }
fn waiting() -> ActionError {
    ActionError::new("owner_only", "Approve this contact at your node. Nothing was sent.")
}

impl Pending {
    /// `owner_config` is set only in the #65 external-node attach path, where the
    /// app already knows the node's `konsensus.toml`. Production and ordinary
    /// supervised runs leave it unset; the owner runs from the data dir or adds
    /// `--config` themselves.
    #[cfg(not(unix))]
    pub fn new(
        _request: Request,
        _fence: (u64, u64),
        _now: u64,
        _grant: &NodeGrant,
        _owner_config: Option<&Path>,
    ) -> Result<Self, ActionError> {
        Err(ActionError::new("owner_contact_unavailable",
            "private owner approval receipts are not supported on this platform"))
    }

    #[cfg(unix)]
    pub fn new(
        request: Request,
        fence: (u64, u64),
        now: u64,
        grant: &NodeGrant,
        owner_config: Option<&Path>,
    ) -> Result<Self, ActionError> {
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
        let receipt = quote(&dir.path().join("receipt").to_string_lossy());
        let (dev_hint, config_arg) = match owner_config {
            Some(path) => (
                "# Dev external node: if konsensus is not on PATH, replace it with its absolute path.\n",
                format!(" --config {}", quote(&path.to_string_lossy())),
            ),
            None => ("", String::new()),
        };
        let command = format!(
            "konsensus approve first-contact --client {} --op {} --to {} --max-msat {} --contact-budget-msat {}{config_arg}",
            quote(&request.client_id), quote(&request.grant_op_id), quote(&request.recipient),
            quote(&request.max_total_msat.to_string()), quote(&request.contact_budget_msat.to_string()));
        // The local handoff records CLI success in a private receipt. Record
        // CLI success, never authority. Start the conservative two-minute TTL
        // BEFORE approval, and bound it by the underlying budget grant.
        //
        // A failed first run (CLI missing / wrong cwd) used to leave an empty
        // receipt.part via the noclobber redirect; later runs then exited 1 with
        // no message. Pre-check planted files/symlinks, exclusive-create the
        // partial, remove it on failure, and publish with `ln` (fails if the
        // destination already exists). Use `{ … } > f || { … }` — not
        // `if ! { … } > f` — so bash 3.2 and zsh both take the failure path when
        // the redirect open itself fails.
        let body = quote(&format!("{{\"recipient\":\"{}\",\"max_total_msat\":{},\"expires_at\":%s}}\\n",
            request.recipient, request.max_total_msat));
        let until = quote(&grant.expires_at.to_string());
        let owner_command = format!(r#"{dev_hint}(
  umask 077; set -C
  receipt={receipt}
  if [ -e "$receipt.part" ] || [ -L "$receipt.part" ]; then
    printf '%s\n' 'bitsov: receipt.part already exists (or is a symlink); cancel and request approval again.' >&2
    exit 1
  fi
  if [ -e "$receipt.json" ] || [ -L "$receipt.json" ]; then
    printf '%s\n' 'bitsov: receipt already published; if the app still waits, click Check pending result.' >&2
    exit 1
  fi
  {{
    started=$(date +%s) && expires=$((started + 120)) &&
    {{ [ "$expires" -le {until} ] || expires={until}; }} &&
    {command} >&2 &&
    printf {body} "$expires"
  }} > "$receipt.part" || {{
    printf '%s\n' 'bitsov: owner approval failed; no receipt published.' >&2
    rm -f "$receipt.part"
    exit 1
  }}
  ln "$receipt.part" "$receipt.json" || {{
    printf '%s\n' 'bitsov: could not publish receipt.json.' >&2
    rm -f "$receipt.part"
    exit 1
  }}
  rm -f "$receipt.part"
)"#);
        Ok(Self { view: View { id, request, owner_command, ready: false,
            expires_at_ms: now.saturating_add(15 * 60_000).min(grant.expires_at_ms()), approval_window_secs: None }, fence, dir: Some(dir), remote_started_at: None, replaced_approval: None })
    }

    pub fn remote(request: Request, fence: (u64, u64), now: u64, grant: &NodeGrant) -> Result<Self, ActionError> {
        for id in [&request.client_id, &request.grant_op_id] {
            if id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(crate::grant::unreadable());
            }
        }
        crate::control::node_id(&request.recipient).map_err(ActionError::invalid)?;
        let owner_command = format!(
            "konsensus approve first-contact --client {} --op {} --to {} --max-msat {} --contact-budget-msat {}",
            quote(&request.client_id), quote(&request.grant_op_id), quote(&request.recipient),
            quote(&request.max_total_msat.to_string()), quote(&request.contact_budget_msat.to_string()));
        Ok(Self {
            view: View { id: crate::remote_access::new_local_auth_token().map_err(|_| waiting())?,
                request, owner_command, ready: false,
                expires_at_ms: now.saturating_add(REMOTE_APPROVAL_WINDOW_SECS * 1000).min(grant.expires_at_ms()),
                approval_window_secs: Some(REMOTE_APPROVAL_WINDOW_SECS) },
            fence, dir: None, remote_started_at: Some(now), replaced_approval: None,
        })
    }

    pub fn remote_path(&self) -> Option<String> {
        self.remote_started_at.map(|_| format!("/pair/first-contact-grant/{}?recipient={}",
            self.view.request.grant_op_id, self.view.request.recipient))
    }

    /// A fresh handoff can replace an expired/consumed approval or one for an
    /// earlier quoted cap. Paid retries remain gated by the payment journal. Ignore only that exact old observation while the
    /// owner runs the new command; it can never make this request ready.
    pub fn remote_discover(&mut self, body: &str, grant: &NodeGrant, fence: (u64, u64), now: u64) -> Result<View, ActionError> {
        let reply: RemoteReply = serde_json::from_str(body).map_err(|_| waiting())?;
        if matches!(reply.state.as_str(), "expired" | "consumed") || (reply.state == "approved" && reply.approval.as_ref().is_some_and(|a|
            a.recipient == self.view.request.recipient &&
            (a.max_total_msat != self.view.request.max_total_msat || a.expires_at <= (now / 1000) as i64))) {
            self.replaced_approval = Some(reply);
        }
        self.remote_status(body, grant, fence, now)
    }

    pub fn remote_status(&mut self, body: &str, grant: &NodeGrant, fence: (u64, u64), now: u64) -> Result<View, ActionError> {
        self.status(grant, fence, now)?;
        let mut reply: RemoteReply = serde_json::from_str(body).map_err(|_| waiting())?;
        let r = &self.view.request;
        if reply.grant_op_id != r.grant_op_id || reply.recipient != r.recipient || reply.approval_window_secs == 0 {
            return Err(waiting());
        }
        let window = reply.approval_window_secs.min(REMOTE_APPROVAL_WINDOW_SECS);
        self.view.approval_window_secs = Some(window);
        self.view.expires_at_ms = self.view.expires_at_ms.min(
            self.remote_started_at.unwrap().saturating_add(window * 1000));
        if self.replaced_approval.as_ref() == Some(&reply) {
            reply.state = "pending".into();
            reply.approval = None;
        } else {
            self.replaced_approval = None;
        }
        if now >= self.view.expires_at_ms || reply.state == "expired" { return Err(expired()); }
        let mut view = self.view.clone();
        match reply.state.as_str() {
            "pending" if reply.approval.is_none() => Ok(view),
            "approved" => {
                let approval = reply.approval.ok_or_else(waiting)?;
                let until = u64::try_from(approval.expires_at).unwrap_or(0).saturating_mul(1000);
                if until <= now { return Err(expired()); }
                if approval.recipient != r.recipient || approval.max_total_msat != r.max_total_msat || until > grant.expires_at_ms() {
                    return Err(waiting());
                }
                view.ready = true;
                view.expires_at_ms = view.expires_at_ms.min(until);
                Ok(view)
            }
            "consumed" => Err(ActionError::new("owner_contact_unavailable", "This contact approval was already used. Check the pending message result. Nothing was sent.")),
            _ => Err(waiting()),
        }
    }

    pub fn status(&self, grant: &NodeGrant, fence: (u64, u64), now: u64) -> Result<View, ActionError> {
        let r = &self.view.request;
        if self.remote_started_at.is_some() && self.view.expires_at_ms <= now { return Err(expired()); }
        if self.fence != fence || self.view.expires_at_ms <= now ||
            grant.client_id != r.client_id || grant.op_id != r.grant_op_id {
            return Err(ActionError::new("owner_only", "This owner request ended or the budget grant changed. Cancel and request approval again."));
        }
        grant.check(r.max_total_msat, Some(&r.recipient), now)?;
        let mut view = self.view.clone();
        if self.remote_started_at.is_some() { return Ok(view); }
        let path = self.dir.as_ref().unwrap().path().join("receipt.json");
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
        std::fs::write(self.dir.as_ref().unwrap().path().join("receipt.json"), serde_json::json!({
            "recipient": recipient, "max_total_msat": cap, "expires_at": expires_at,
        }).to_string()).unwrap();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::process::Command;

    fn pending() -> Pending { pending_with_expiry(120) }

    fn pending_with_expiry(expires_at: i64) -> Pending {
        pending_with(expires_at, None)
    }

    fn pending_with(expires_at: i64, owner_config: Option<&Path>) -> Pending {
        let grant = NodeGrant {
            client_id: "c1".into(), op_id: "ab12".into(), expires_at,
            budget_msat: 50_000, used_msat: 0, remaining_msat: 50_000,
            per_call_max_msat: 5_000, per_recipient_msat: Default::default(),
            used_by_recipient: Default::default(), ..Default::default()
        };
        Pending::new(Request {
            client_id: "c1".into(), grant_op_id: "ab12".into(),
            recipient: "a".repeat(64), max_total_msat: 5_000, contact_budget_msat: 50_000,
        }, (0, 0), 0, &grant, owner_config).unwrap()
    }

    fn remote_fixture() -> (Pending, NodeGrant, serde_json::Value) {
        let grant = NodeGrant {
            client_id: "c1".into(), op_id: "ab12".into(), expires_at: 1000,
            budget_msat: 50_000, remaining_msat: 50_000, per_call_max_msat: 5_000,
            ..Default::default()
        };
        let pending = Pending::remote(Request {
            client_id: "c1".into(), grant_op_id: "ab12".into(), recipient: "a".repeat(64),
            max_total_msat: 5000, contact_budget_msat: 50_000,
        }, (1, 2), 10_000, &grant).unwrap();
        let reply = serde_json::json!({"grant_op_id": "ab12", "recipient": "a".repeat(64),
            "state": "approved", "approval_window_secs": 300,
            "approval": {"recipient": "a".repeat(64), "max_total_msat": 5000, "expires_at": 310}});
        (pending, grant, reply)
    }

    #[test]
    fn remote_status_requires_exact_live_approval_and_current_authority() {
        for change in ["operation", "recipient", "approval_recipient", "cap", "expired", "missing", "consumed", "unknown", "fence", "grant", "client", "zero_window"] {
            let (mut p, mut grant, mut reply) = remote_fixture();
            let mut fence = (1, 2);
            match change {
                "operation" => reply["grant_op_id"] = "abcd".into(),
                "recipient" => reply["recipient"] = "b".repeat(64).into(),
                "approval_recipient" => reply["approval"]["recipient"] = "b".repeat(64).into(),
                "cap" => reply["approval"]["max_total_msat"] = 6000.into(),
                "expired" => reply["approval"]["expires_at"] = 10.into(),
                "missing" => reply["approval"] = serde_json::Value::Null,
                "consumed" | "unknown" => reply["state"] = change.into(),
                "fence" => fence = (1, 3),
                "grant" => grant.op_id = "cd34".into(),
                "client" => grant.client_id = "c2".into(),
                "zero_window" => reply["approval_window_secs"] = 0.into(),
                _ => unreachable!(),
            }
            assert!(p.remote_status(&reply.to_string(), &grant, fence, 11_000).is_err(), "{change}");
        }
        let (mut p, grant, reply) = remote_fixture();
        assert!(p.dir.is_none(), "remote approval creates no local receipt directory");
        assert!(p.remote_status(&reply.to_string(), &grant, (1, 2), 11_000).unwrap().ready);
    }

    #[test]
    fn remote_wait_uses_advertised_window_without_renewing_it_on_each_poll() {
        for (advertised, deadline) in [(30, 40_000), (300, 310_000), (900, 310_000)] {
            let (mut p, grant, mut reply) = remote_fixture();
            reply["state"] = "pending".into();
            reply["approval"] = serde_json::Value::Null;
            reply["approval_window_secs"] = advertised.into();
            for now in [10_000, 26_000, deadline - 1] {
                let view = p.remote_status(&reply.to_string(), &grant, (1, 2), now).unwrap();
                assert!(!view.ready);
                assert_eq!(view.expires_at_ms, deadline);
            }
            assert_eq!(p.remote_status(&reply.to_string(), &grant, (1, 2), deadline).unwrap_err().code, "owner_contact_expired");
        }
    }

    #[test]
    fn receipt_directory_is_private_under_permissive_umasks() {
        // Change umask only in a subprocess, never in the parallel test runner.
        if std::env::var_os("BITSOV_TEST_RECEIPT_UMASK_CHILD").is_some() {
            let p = pending();
            assert_eq!(std::fs::metadata(p.dir.as_ref().unwrap().path()).unwrap().permissions().mode() & 0o777, 0o700);
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

    // A CLI stand-in records the actual POSIX-shell argument boundaries. The
    // real CLI/control socket is exercised by the real-window UI-E2E fixture.
    struct Fixture { dir: tempfile::TempDir }
    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let cli = dir.path().join("konsensus");
            std::fs::write(&cli, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$OWNER_TEST_ARGS\"\nprintf 1050 > \"$OWNER_TEST_CLOCK\"\nexit \"${OWNER_TEST_EXIT:-0}\"\n").unwrap();
            std::fs::set_permissions(cli, std::fs::Permissions::from_mode(0o700)).unwrap();
            let clock = dir.path().join("clock");
            std::fs::write(&clock, "1000").unwrap();
            let date = dir.path().join("date");
            std::fs::write(&date, "#!/bin/sh\ncat \"$OWNER_TEST_CLOCK\"\n").unwrap();
            std::fs::set_permissions(date, std::fs::Permissions::from_mode(0o700)).unwrap();
            Self { dir }
        }
    }
    fn run_owner_with(p: &Pending, fixture: &Fixture, exit: &str) -> std::process::Output {
        Command::new("/bin/sh").args(["-c", &p.view.owner_command])
            .env("PATH", format!("{}:/usr/bin:/bin", fixture.dir.path().display()))
            .env("OWNER_TEST_ARGS", fixture.dir.path().join("args"))
            .env("OWNER_TEST_CLOCK", fixture.dir.path().join("clock"))
            .env("OWNER_TEST_EXIT", exit).output().unwrap()
    }
    fn run_owner(p: &Pending, fixture: &Fixture) -> std::process::Output {
        run_owner_with(p, fixture, "0")
    }
    fn run_owner_shell(shell: &str, p: &Pending, fixture: &Fixture) -> std::process::Output {
        Command::new(shell).args(["-c", &p.view.owner_command])
            .env("PATH", format!("{}:/usr/bin:/bin", fixture.dir.path().display()))
            .env("OWNER_TEST_ARGS", fixture.dir.path().join("args"))
            .env("OWNER_TEST_CLOCK", fixture.dir.path().join("clock"))
            .env("OWNER_TEST_EXIT", "0").output().unwrap()
    }

    #[test]
    fn owner_cli_receives_exact_reviewed_tuple_and_failure_publishes_no_receipt() {
        let fixture = Fixture::new();
        let p = pending();
        let output = run_owner_with(&p, &fixture, "1");
        assert!(!output.status.success());
        assert!(!p.dir.as_ref().unwrap().path().join("receipt.json").exists());
        assert!(!p.dir.as_ref().unwrap().path().join("receipt.part").exists(),
            "failed run must not leave an empty receipt.part that blocks retry");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("owner approval failed"), "{stderr}");
        assert_eq!(std::fs::read_to_string(fixture.dir.path().join("args")).unwrap(),
            format!("approve\nfirst-contact\n--client\nc1\n--op\nab12\n--to\n{}\n--max-msat\n5000\n--contact-budget-msat\n50000\n", "a".repeat(64)));
    }

    #[test]
    fn receipt_expiry_starts_before_cli_and_never_outlives_budget_grant() {
        for (grant_expiry, expected) in [(5000, 1120), (1100, 1100)] {
            let fixture = Fixture::new();
            let p = pending_with_expiry(grant_expiry);
            let output = run_owner(&p, &fixture);
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            let receipt: serde_json::Value = serde_json::from_slice(
                &std::fs::read(p.dir.as_ref().unwrap().path().join("receipt.json")).unwrap()).unwrap();
            assert_eq!(receipt["expires_at"], expected);
            assert_eq!(std::fs::read_to_string(fixture.dir.path().join("clock")).unwrap(), "1050");
        }
    }

    #[test]
    fn owner_command_refuses_a_planted_partial_symlink_without_touching_victim() {
        let fixture = Fixture::new();
        let p = pending();
        let victim = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(victim.path(), "ORIGINAL DUMMY CONTENT").unwrap();
        let partial = p.dir.as_ref().unwrap().path().join("receipt.part");
        symlink(victim.path(), &partial).unwrap();
        let output = run_owner(&p, &fixture);
        assert_eq!(std::fs::read_to_string(victim.path()).unwrap(), "ORIGINAL DUMMY CONTENT");
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("receipt.part already exists"), "{stderr}");
        assert!(partial.is_symlink());
        assert!(!p.dir.as_ref().unwrap().path().join("receipt.json").exists());
        assert!(!fixture.dir.path().join("args").exists(), "CLI must not run after pre-check refusal");
    }

    #[test]
    fn owner_command_refuses_an_existing_partial_file() {
        let fixture = Fixture::new();
        let p = pending();
        let partial = p.dir.as_ref().unwrap().path().join("receipt.part");
        std::fs::write(&partial, "existing partial").unwrap();
        let output = run_owner(&p, &fixture);
        assert_eq!(std::fs::read_to_string(partial).unwrap(), "existing partial");
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("receipt.part already exists"), "{stderr}");
        assert!(!p.dir.as_ref().unwrap().path().join("receipt.json").exists());
    }

    #[test]
    fn owner_command_refuses_a_dangling_partial_symlink() {
        let fixture = Fixture::new();
        let p = pending();
        let target = p.dir.as_ref().unwrap().path().join("must-not-be-created");
        symlink(&target, p.dir.as_ref().unwrap().path().join("receipt.part")).unwrap();
        let output = run_owner(&p, &fixture);
        assert!(!target.exists());
        assert!(!output.status.success());
        assert!(!p.dir.as_ref().unwrap().path().join("receipt.json").exists());
    }

    #[test]
    fn owner_command_refuses_a_partial_symlink_to_a_device() {
        let fixture = Fixture::new();
        let p = pending();
        let partial = p.dir.as_ref().unwrap().path().join("receipt.part");
        symlink("/dev/null", &partial).unwrap();
        let output = run_owner(&p, &fixture);
        assert!(!output.status.success());
        assert!(partial.is_symlink());
        assert!(!p.dir.as_ref().unwrap().path().join("receipt.json").is_symlink());
    }

    #[test]
    fn owner_command_publishes_a_private_regular_receipt() {
        let fixture = Fixture::new();
        let p = pending();
        let output = run_owner(&p, &fixture);
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let receipt = p.dir.as_ref().unwrap().path().join("receipt.json");
        let metadata = std::fs::symlink_metadata(&receipt).unwrap();
        assert!(metadata.is_file());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        let body: serde_json::Value = serde_json::from_slice(&std::fs::read(receipt).unwrap()).unwrap();
        assert_eq!(body, serde_json::json!({"recipient": "a".repeat(64), "max_total_msat": 5000, "expires_at": 120}));
        assert!(!p.dir.as_ref().unwrap().path().join("receipt.part").exists());
    }

    /// The generated command text must publish exactly once under both bash and
    /// zsh. A second run must refuse without rewriting receipt.json.
    #[test]
    fn owner_command_publishes_once_under_bash_and_zsh_and_second_run_refuses() {
        for shell in ["/bin/bash", "/bin/zsh"] {
            if !std::path::Path::new(shell).exists() {
                continue;
            }
            let fixture = Fixture::new();
            let p = pending();
            let first = run_owner_shell(shell, &p, &fixture);
            assert!(first.status.success(), "{shell} first: {}", String::from_utf8_lossy(&first.stderr));
            let receipt = p.dir.as_ref().unwrap().path().join("receipt.json");
            let first_body = std::fs::read(&receipt).unwrap();
            assert!(!first_body.is_empty());
            assert!(!p.dir.as_ref().unwrap().path().join("receipt.part").exists());

            std::fs::write(fixture.dir.path().join("args"), "MUST_NOT_RERUN").unwrap();
            let second = run_owner_shell(shell, &p, &fixture);
            assert!(!second.status.success(), "{shell} second must refuse");
            let stderr = String::from_utf8_lossy(&second.stderr);
            assert!(stderr.contains("receipt already published"), "{shell} stderr: {stderr}");
            assert!(stderr.contains("Check pending result"), "{shell} stderr: {stderr}");
            assert_eq!(std::fs::read(&receipt).unwrap(), first_body, "{shell} must not rewrite receipt");
            assert_eq!(std::fs::read_to_string(fixture.dir.path().join("args")).unwrap(), "MUST_NOT_RERUN",
                "{shell} must not re-run konsensus on the second attempt");
        }
    }

    #[test]
    fn owner_command_failed_run_does_not_leave_blocking_empty_part() {
        // Real defect on main before #66: a failed first run (CLI missing / exit
        // non-zero) left an empty receipt.part from the noclobber redirect, after
        // which every later run exited 1 silently. Failure must clean the partial
        // and print a clear message.
        let fixture = Fixture::new();
        let p = pending();
        let output = run_owner_with(&p, &fixture, "1");
        assert!(!output.status.success());
        assert!(!p.dir.as_ref().unwrap().path().join("receipt.part").exists());
        assert!(!p.dir.as_ref().unwrap().path().join("receipt.json").exists());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("owner approval failed"), "{stderr}");
    }

    #[test]
    fn owner_command_redirect_open_failure_reports_in_bash_and_zsh() {
        // bash 3.2 skipped the then-branch of `if ! { … } > f`; the `||` form
        // must take the failure path in both shells when the open itself fails.
        for shell in ["/bin/bash", "/bin/zsh"] {
            if !std::path::Path::new(shell).exists() {
                continue;
            }
            let fixture = Fixture::new();
            let p = pending();
            // Make the receipt directory unwritable so `> receipt.part` fails.
            let mut perms = std::fs::metadata(p.dir.as_ref().unwrap().path()).unwrap().permissions();
            perms.set_mode(0o500);
            std::fs::set_permissions(p.dir.as_ref().unwrap().path(), perms).unwrap();
            let output = run_owner_shell(shell, &p, &fixture);
            // Restore so TempDir cleanup succeeds.
            let mut perms = std::fs::metadata(p.dir.as_ref().unwrap().path()).unwrap().permissions();
            perms.set_mode(0o700);
            std::fs::set_permissions(p.dir.as_ref().unwrap().path(), perms).unwrap();
            assert!(!output.status.success(), "{shell}");
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(stderr.contains("owner approval failed"), "{shell} stderr: {stderr}");
            assert!(!stderr.contains("could not publish receipt.json"),
                "{shell} must not fall through to mv/ln with a misleading message: {stderr}");
            assert!(!p.dir.as_ref().unwrap().path().join("receipt.json").exists());
        }
    }

    #[test]
    fn external_node_command_includes_config_and_absolute_binary_hint() {
        let config = Path::new("/tmp/owner-node/konsensus.toml");
        let p = pending_with(120, Some(config));
        assert!(p.view.owner_command.contains(
            "# Dev external node: if konsensus is not on PATH, replace it with its absolute path."
        ));
        assert!(p.view.owner_command.contains("--config '/tmp/owner-node/konsensus.toml'"));
        let fixture = Fixture::new();
        let output = run_owner(&p, &fixture);
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(std::fs::read_to_string(fixture.dir.path().join("args")).unwrap(),
            format!("approve\nfirst-contact\n--client\nc1\n--op\nab12\n--to\n{}\n--max-msat\n5000\n--contact-budget-msat\n50000\n--config\n/tmp/owner-node/konsensus.toml\n", "a".repeat(64)));
    }

    #[test]
    fn production_command_has_no_config_or_dev_hint() {
        let p = pending();
        assert!(!p.view.owner_command.contains("--config"));
        assert!(!p.view.owner_command.contains("Dev external node"));
    }
}
