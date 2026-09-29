//! Own-tier local model: talk to a server already running on loopback.
//!
//! Detects Ollama (`/api/tags`) or an OpenAI-compatible llama.cpp server
//! (`/v1/models`) on `127.0.0.1` only. No downloads, no install, no host other
//! than loopback, no spend path. The window may pick a model; the host writes
//! `ai-local.json` and routes chat through `/v1/chat/completions`.

use std::net::Ipv4Addr;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{
    clean_question, endpoint_host, request_body, send, short, Remote, RemoteAnswer, TopicRead,
    MAX_REMOTE_BYTES, Preset, ProviderKind, DEFAULT_PRESET,
};

/// Ollama's default listen port.
pub const OLLAMA_PORT: u16 = 11434;
/// llama.cpp server's common default.
pub const LLAMA_CPP_PORT: u16 = 8080;
/// Ports tried when the owner has not set one.
pub const DEFAULT_PROBE_PORTS: [u16; 2] = [OLLAMA_PORT, LLAMA_CPP_PORT];

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const LOOPBACK: Ipv4Addr = Ipv4Addr::LOCALHOST;

/// How the owner starts a local server, when none is running. No URL scheme —
/// the window must not embed `http://` (G2).
pub const HOWTO: &str = "Start Ollama (`ollama serve`) or a llama.cpp server on this computer \
(listening on 127.0.0.1, usually port 11434 or 8080). Then pick a model here. \
BitSov does not download or install models; nothing leaves this computer.";

/// Which loopback API shape answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalKind {
    /// Ollama: models from `GET /api/tags`; chat via OpenAI-compat path.
    Ollama,
    /// llama.cpp (or any OpenAI-compat server) on loopback.
    OpenAiCompat,
}

impl LocalKind {
    fn chat_path(self) -> &'static str {
        "/v1/chat/completions"
    }
}

/// Saved Own-tier pick. Host file only; the window sets it through a command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalFile {
    pub port: u16,
    pub model: String,
    #[serde(default)]
    pub kind: Option<LocalKind>,
}

/// A live pick the host may chat with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalChoice {
    pub port: u16,
    pub model: String,
    pub kind: LocalKind,
}

impl LocalChoice {
    /// OpenAI-compatible chat URL on loopback only.
    pub fn endpoint(&self) -> String {
        format!(
            "http://{}:{}{}",
            LOOPBACK,
            self.port,
            self.kind.chat_path()
        )
    }

    pub fn as_remote(&self) -> Remote {
        let endpoint = self.endpoint();
        Remote {
            kind: ProviderKind::Local,
            label: "On this computer".into(),
            host: endpoint_host(&endpoint).unwrap_or_else(|| LOOPBACK.to_string()),
            endpoint,
            model: self.model.clone(),
            key_env: None,
        }
    }
}

/// What the window shows in AI settings for Own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LocalStatus {
    pub running: bool,
    pub kind: Option<LocalKind>,
    pub port: Option<u16>,
    pub models: Vec<String>,
    /// Last model the owner picked, if any (may be absent from `models` if the server changed).
    pub selected: Option<String>,
    pub selected_port: Option<u16>,
    pub howto: String,
}

/// One probe hit on loopback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalProbe {
    pub kind: LocalKind,
    pub port: u16,
    pub models: Vec<String>,
}

fn loopback_url(port: u16, path: &str) -> String {
    format!("http://{LOOPBACK}:{port}{path}")
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .https_only(false)
        .timeout(timeout)
        .build()
        .map_err(|_| "Could not start the request.".to_string())
}

/// Bound a body the same way remote send does.
async fn read_bounded(response: &mut reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_REMOTE_BYTES as u64)
    {
        return Err("The model list was too large to read.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The model server did not finish answering.".to_string())?
    {
        if chunk.len() > MAX_REMOTE_BYTES.saturating_sub(bytes.len()) {
            return Err("The model list was too large to read.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn parse_ollama_tags(body: &[u8]) -> Option<Vec<String>> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let models = value.get("models")?.as_array()?;
    let mut names = Vec::new();
    for entry in models {
        let name = entry.get("name").and_then(|v| v.as_str())?;
        if let Some(clean) = short(name, 80) {
            if !names.contains(&clean) {
                names.push(clean);
            }
        }
    }
    Some(names)
}

fn parse_openai_models(body: &[u8]) -> Option<Vec<String>> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let data = value.get("data")?.as_array()?;
    let mut names = Vec::new();
    for entry in data {
        let id = entry.get("id").and_then(|v| v.as_str())?;
        if let Some(clean) = short(id, 80) {
            if !names.contains(&clean) {
                names.push(clean);
            }
        }
    }
    Some(names)
}

async fn get_ok(client: &reqwest::Client, url: &str) -> Option<Vec<u8>> {
    let mut response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    read_bounded(&mut response).await.ok()
}

/// Probe one loopback port: Ollama tags first, then OpenAI `/v1/models`.
pub async fn probe_port(port: u16) -> Option<LocalProbe> {
    if port == 0 {
        return None;
    }
    let client = http_client(PROBE_TIMEOUT).ok()?;
    if let Some(body) = get_ok(&client, &loopback_url(port, "/api/tags")).await {
        if let Some(models) = parse_ollama_tags(&body) {
            return Some(LocalProbe {
                kind: LocalKind::Ollama,
                port,
                models,
            });
        }
    }
    if let Some(body) = get_ok(&client, &loopback_url(port, "/v1/models")).await {
        if let Some(models) = parse_openai_models(&body) {
            return Some(LocalProbe {
                kind: LocalKind::OpenAiCompat,
                port,
                models,
            });
        }
    }
    None
}

/// Probe `preferred` first (when set), then the default ports. First hit wins.
pub async fn probe(preferred: Option<u16>) -> Option<LocalProbe> {
    let mut ports = Vec::new();
    if let Some(port) = preferred.filter(|p| *p != 0) {
        ports.push(port);
    }
    for port in DEFAULT_PROBE_PORTS {
        if !ports.contains(&port) {
            ports.push(port);
        }
    }
    for port in ports {
        if let Some(hit) = probe_port(port).await {
            return Some(hit);
        }
    }
    None
}

/// Read `ai-local.json`. Missing or invalid means rules-only Own.
pub fn load_local_file(path: &Path) -> Option<LocalFile> {
    let text = std::fs::read_to_string(path).ok()?;
    let file: LocalFile = serde_json::from_str(&text).ok()?;
    if file.port == 0 {
        return None;
    }
    let model = short(&file.model, 80)?;
    Some(LocalFile {
        port: file.port,
        model,
        kind: file.kind,
    })
}

/// Write the owner's pick. Creates parent dirs when needed.
pub fn save_local_file(path: &Path, file: &LocalFile) -> Result<(), String> {
    if file.port == 0 {
        return Err("Pick a port between 1 and 65535.".into());
    }
    let model = short(&file.model, 80).ok_or("Pick a model name.")?;
    let clean = LocalFile {
        port: file.port,
        model,
        kind: file.kind,
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "Could not save the model pick.".to_string())?;
    }
    let text = serde_json::to_string_pretty(&clean)
        .map_err(|_| "Could not save the model pick.".to_string())?;
    std::fs::write(path, text).map_err(|_| "Could not save the model pick.".to_string())
}

pub fn clear_local_file(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not clear the model pick.".into()),
    }
}

/// Build status for the settings UI from a probe and the saved pick.
pub fn status_from(probe: Option<LocalProbe>, saved: Option<&LocalFile>) -> LocalStatus {
    match probe {
        Some(hit) => LocalStatus {
            running: true,
            kind: Some(hit.kind),
            port: Some(hit.port),
            models: hit.models,
            selected: saved.map(|s| s.model.clone()),
            selected_port: saved.map(|s| s.port),
            howto: HOWTO.into(),
        },
        None => LocalStatus {
            running: false,
            kind: None,
            port: None,
            models: Vec::new(),
            selected: saved.map(|s| s.model.clone()),
            selected_port: saved.map(|s| s.port),
            howto: HOWTO.into(),
        },
    }
}

/// Resolve a saved pick against a live probe. `None` when the server is down
/// or the model is no longer listed (owner must pick again).
pub fn resolve_choice(saved: &LocalFile, probe: &LocalProbe) -> Option<LocalChoice> {
    if saved.port != probe.port && !probe.models.iter().any(|m| m == &saved.model) {
        // Different port answered; still allow if the model name is present there.
    }
    if !probe.models.iter().any(|m| m == &saved.model) {
        return None;
    }
    Some(LocalChoice {
        port: probe.port,
        model: saved.model.clone(),
        kind: saved.kind.unwrap_or(probe.kind),
    })
}

/// Prefer the saved port when probing so a non-default listen port still works.
pub async fn resolve_saved(saved: Option<&LocalFile>) -> Option<LocalChoice> {
    let saved = saved?;
    let hit = probe(Some(saved.port)).await?;
    // Model renamed on the same server: keep rules until the owner picks again.
    resolve_choice(saved, &hit)
}

/// Ask the Own-tier model: read is already done by the caller; build + POST loopback.
pub async fn ask(
    choice: &LocalChoice,
    question: &str,
    read: &TopicRead,
    preset: Preset,
) -> Result<RemoteAnswer, String> {
    let question = clean_question(question).ok_or("Ask a question first.")?;
    let remote = choice.as_remote();
    let body = request_body(&remote, &question, read, preset)
        .ok_or("Your node could not be read, so nothing was asked.")?;
    // No API key: Own tier never pays and never leaves the machine.
    send(&remote, body, None).await
}

/// Default preset for Own-tier model asks (same narrow start as remotes).
pub fn own_preset() -> Preset {
    DEFAULT_PRESET
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::Duration;

    use serde_json::json;

    fn serve(routes: Vec<(String, String)>) -> (u16, mpsc::Receiver<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let head = loop {
                    let n = stream.read(&mut chunk).unwrap();
                    if n == 0 {
                        break String::new();
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(split) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break String::from_utf8_lossy(&buf[..split]).to_string();
                    }
                };
                let path = head
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("")
                    .to_string();
                let _ = tx.send(path.clone());
                let reply = routes
                    .iter()
                    .find(|(p, _)| path.starts_with(p.as_str()))
                    .map(|(_, body)| body.clone())
                    .unwrap_or_else(|| "{}".into());
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        // Give the listener a moment on slow CI.
        std::thread::sleep(Duration::from_millis(20));
        (port, rx)
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn probe_finds_ollama_tags_on_loopback() {
        let tags = json!({"models": [{"name": "llama3.2:latest"}, {"name": "qwen2.5"}]}).to_string();
        let (port, seen) = serve(vec![("/api/tags".into(), tags)]);
        let hit = block_on(probe_port(port)).expect("ollama");
        assert_eq!(hit.kind, LocalKind::Ollama);
        assert_eq!(hit.port, port);
        assert_eq!(hit.models, vec!["llama3.2:latest".to_string(), "qwen2.5".to_string()]);
        assert_eq!(seen.recv_timeout(Duration::from_secs(2)).unwrap(), "/api/tags");
    }

    #[test]
    fn probe_finds_openai_compatible_models() {
        let models = json!({"data": [{"id": "Qwen2.5-3B"}, {"id": "tiny"}]}).to_string();
        let (port, seen) = serve(vec![("/v1/models".into(), models)]);
        let hit = block_on(probe_port(port)).expect("openai");
        assert_eq!(hit.kind, LocalKind::OpenAiCompat);
        assert_eq!(hit.models, vec!["Qwen2.5-3B".to_string(), "tiny".to_string()]);
        let mut paths = Vec::new();
        while let Ok(path) = seen.recv_timeout(Duration::from_millis(200)) {
            paths.push(path);
        }
        // Probe tries Ollama tags first; OpenAI models must still be hit.
        assert!(
            paths.iter().any(|p| p.starts_with("/v1/models")),
            "paths={paths:?}"
        );
    }

    #[test]
    fn probe_skips_dead_ports_and_prefers_saved() {
        let tags = json!({"models": [{"name": "only-here"}]}).to_string();
        let (port, _) = serve(vec![("/api/tags".into(), tags)]);
        let hit = block_on(probe(Some(port))).expect("preferred");
        assert_eq!(hit.port, port);
        assert_eq!(hit.models, vec!["only-here".to_string()]);
        assert!(block_on(probe_port(1)).is_none());
    }

    #[test]
    fn choice_endpoint_is_loopback_http_only() {
        let choice = LocalChoice {
            port: 11434,
            model: "m".into(),
            kind: LocalKind::Ollama,
        };
        let endpoint = choice.endpoint();
        assert!(endpoint.starts_with("http://127.0.0.1:11434/"));
        assert!(endpoint_host(&endpoint).as_deref() == Some("127.0.0.1"));
        assert_eq!(choice.as_remote().kind, ProviderKind::Local);
        assert!(choice.as_remote().key_env.is_none());
    }

    #[test]
    fn resolve_choice_requires_listed_model() {
        let probe = LocalProbe {
            kind: LocalKind::Ollama,
            port: 11434,
            models: vec!["a".into(), "b".into()],
        };
        let ok = LocalFile {
            port: 11434,
            model: "b".into(),
            kind: Some(LocalKind::Ollama),
        };
        assert_eq!(
            resolve_choice(&ok, &probe).unwrap().model,
            "b"
        );
        let missing = LocalFile {
            port: 11434,
            model: "gone".into(),
            kind: None,
        };
        assert!(resolve_choice(&missing, &probe).is_none());
    }

    #[test]
    fn status_howto_when_nothing_runs() {
        let status = status_from(None, None);
        assert!(!status.running);
        assert!(status.models.is_empty());
        assert!(status.howto.contains("ollama serve"));
        assert!(status.howto.contains("127.0.0.1"));
        assert!(!status.howto.contains("http://"));
    }

    #[test]
    fn local_file_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ai-local.json");
        let file = LocalFile {
            port: 8080,
            model: "tiny".into(),
            kind: Some(LocalKind::OpenAiCompat),
        };
        save_local_file(&path, &file).unwrap();
        assert_eq!(load_local_file(&path).unwrap(), file);
        clear_local_file(&path).unwrap();
        assert!(load_local_file(&path).is_none());
    }

    #[test]
    fn ask_posts_chat_completions_on_loopback_only() {
        use crate::ai::{Freshness, Topic, TopicRead};
        let reply = json!({"choices": [{"message": {"content": "You have one channel."}}]}).to_string();
        let tags = json!({"models": [{"name": "tiny"}]}).to_string();
        let (port, seen) = serve(vec![
            ("/api/tags".into(), tags),
            ("/v1/chat/completions".into(), reply),
        ]);
        let choice = LocalChoice {
            port,
            model: "tiny".into(),
            kind: LocalKind::Ollama,
        };
        let read = TopicRead::Live {
            topic: Topic::Channels,
            outputs: vec![],
            freshness: Freshness {
                state: "unknown",
                age_ms: None,
                fresh_for_ms: None,
                node_as_of: false,
                node_stale: false,
                clock_skew: false,
            },
            routes: vec!["GET /channels".into()],
        };
        let answer = block_on(ask(&choice, "how many channels?", &read, Preset::Counts)).unwrap();
        assert_eq!(answer.provider, ProviderKind::Local);
        assert_eq!(answer.model, "tiny");
        assert_eq!(answer.host, "127.0.0.1");
        assert_eq!(answer.text, "You have one channel.");
        assert!(answer.label.contains("computer"));
        // First hit may be tags from an incidental probe; chat must appear.
        let mut paths = Vec::new();
        while let Ok(path) = seen.recv_timeout(Duration::from_millis(200)) {
            paths.push(path);
            if paths.iter().any(|p| p.starts_with("/v1/chat/completions")) {
                break;
            }
        }
        assert!(
            paths.iter().any(|p| p.starts_with("/v1/chat/completions")),
            "paths={paths:?}"
        );
    }
}
