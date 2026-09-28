//! Independent-owner first-contact handoff. The app never obtains the owner's
//! credential. The owner runs the HTTP command at the node, which writes only
//! the public response. A receipt is a readiness signal, not spend authority:
//! the node still checks and consumes its actual single-use grant on compose.
use std::io::Read;
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
        let dir = tempfile::Builder::new().prefix("bitsov-owner-contact-").tempdir()
            .map_err(|_| ActionError::node("Cannot prepare the owner approval receipt."))?;
        let id = dir.path().file_name().unwrap().to_string_lossy().into_owned();
        let receipt = quote(&dir.path().join("receipt.json").to_string_lossy());
        let partial = quote(&dir.path().join("receipt.part").to_string_lossy());
        let body = quote(&serde_json::to_string(&request).map_err(|_| crate::grant::unreadable())?);
        // Header comes from the OWNER'S environment over stdin, never argv,
        // the app, the command text, or the receipt. No redirect following.
        let owner_command = format!(
            "(set +x; umask 077; printf 'Authorization: Bearer %s\\n' \"${{BITSOV_OWNER_TOKEN:?Set an independent node owner credential in this terminal}}\" | curl --fail --silent --show-error --max-time 20 --proto '=http' --header @- --header 'Content-Type: application/json' --data {body} --output {partial} {} && mv {partial} {receipt})",
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
