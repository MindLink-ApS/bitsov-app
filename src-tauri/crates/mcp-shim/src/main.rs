//! `bitsov-mcp`: see the library docs. Status and errors go to stderr; stdout
//! carries only MCP frames from the app.

const USAGE: &str = "\
bitsov-mcp connects an AI client to the BitSov app on this computer.

  bitsov-mcp pair \"<name>\"   ask the app to approve this client (shows six words)
  bitsov-mcp                 run as the AI client's MCP server (stdin/stdout)
  bitsov-mcp forget          delete this client's key

  --endpoint <path>          use another endpoint (for testing)";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        eprintln!("{USAGE}");
        return;
    }
    let code = match run(&args) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("bitsov-mcp: {error}");
            1
        }
    };
    std::process::exit(code);
}

#[cfg(not(any(target_os = "macos", windows)))]
fn run(_args: &[String]) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "available on macOS and Windows only"))
}

/// One connection to the app: a reader, a writer, and how to tell the app
/// that the client's input ended.
#[cfg(any(target_os = "macos", windows))]
mod platform {
    use std::io::{self, BufReader};

    #[cfg(target_os = "macos")]
    pub type Reader = std::os::unix::net::UnixStream;
    #[cfg(target_os = "macos")]
    pub type Writer = std::os::unix::net::UnixStream;
    // Two overlapped halves: a read waiting on the app never holds up a write.
    #[cfg(windows)]
    pub type Reader = bitsov_mcp::windows::PipeHalf;
    #[cfg(windows)]
    pub type Writer = bitsov_mcp::windows::PipeHalf;

    #[cfg(target_os = "macos")]
    pub fn default_endpoint() -> io::Result<String> {
        Ok(bitsov_mcp::macos::default_socket()?.to_string_lossy().into_owned())
    }
    #[cfg(windows)]
    pub fn default_endpoint() -> io::Result<String> {
        bitsov_mcp::windows::default_pipe()
    }

    pub fn connect(endpoint: &str) -> io::Result<(BufReader<Reader>, Writer)> {
        let unreachable = |e: io::Error| io::Error::new(e.kind(),
            format!("cannot reach the BitSov app ({e}); is it open with AI clients turned on?"));
        #[cfg(target_os = "macos")]
        let (reader, writer) = {
            let stream = bitsov_mcp::macos::connect(std::path::Path::new(endpoint)).map_err(unreachable)?;
            (stream.try_clone()?, stream)
        };
        #[cfg(windows)]
        let (reader, writer) = bitsov_mcp::windows::connect(endpoint).map_err(unreachable)?;
        Ok((BufReader::new(reader), writer))
    }

    /// The client's input ended: half-close the socket (macOS), or end the
    /// process, which closes the pipe (Windows pipes have no half-close).
    pub fn client_ended(stream: Writer) {
        #[cfg(target_os = "macos")]
        {
            let _ = stream.shutdown(std::net::Shutdown::Write);
        }
        #[cfg(windows)]
        {
            drop(stream);
            std::process::exit(0);
        }
    }
}

#[cfg(any(target_os = "macos", windows))]
fn run(args: &[String]) -> std::io::Result<()> {
    use std::io::{BufReader, Error, ErrorKind};
    use std::time::{Duration, Instant};

    use bitsov_mcp::{key_file, open_session, pair, relay, PairOutcome};

    let mut args = args.to_vec();
    let endpoint = match args.iter().position(|a| a == "--endpoint") {
        Some(at) => {
            let value = args.get(at + 1).cloned().ok_or_else(|| Error::new(ErrorKind::InvalidInput, "--endpoint needs a value"))?;
            args.drain(at..=at + 1);
            value
        }
        None => platform::default_endpoint()?,
    };
    let keys = key_file::default_dir()?;

    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["pair", name] => {
            // Before connecting: the app hands the secret over once, so it must be savable.
            key_file::ready_to_pair(&keys)?;
            let (mut reader, mut writer) = platform::connect(&endpoint)?;
            let mut nonce = [0u8; 32];
            getrandom::fill(&mut nonce).map_err(|_| Error::other("no randomness available"))?;
            let started = Instant::now();
            let outcome = pair(&mut reader, &mut writer, name, &nonce,
                |words| eprintln!("In BitSov, approve this client only if the request shows these six words:\n\n    {}\n", words.join(" ")),
                || { std::thread::sleep(Duration::from_secs(2)); started.elapsed() < Duration::from_secs(5 * 60) })?;
            match outcome {
                PairOutcome::Approved(key) => {
                    key_file::save(&keys, &key)?;
                    eprintln!("Approved. Your AI client can now start bitsov-mcp.");
                    Ok(())
                }
                PairOutcome::Gone => Err(Error::new(ErrorKind::PermissionDenied, "the request was denied or has expired")),
            }
        }
        ["forget"] => {
            if key_file::forget(&keys)? { eprintln!("This client's key is deleted. Revoke it in BitSov too."); }
            else { eprintln!("There was no key."); }
            Ok(())
        }
        [] => {
            let key = key_file::load(&keys).map_err(|e| match e.kind() {
                ErrorKind::NotFound => Error::new(ErrorKind::NotFound, "not paired yet: run `bitsov-mcp pair \"<name>\"`"),
                _ => e,
            })?;
            let (mut reader, mut writer) = platform::connect(&endpoint)?;
            open_session(&mut reader, &mut writer, &key)?;
            drop(key);
            relay(reader, writer, BufReader::new(std::io::stdin()), std::io::stdout(), platform::client_ended)
        }
        _ => Err(Error::new(ErrorKind::InvalidInput, USAGE)),
    }
}
