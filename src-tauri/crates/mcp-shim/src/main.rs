//! `bitsov-mcp`: see the library docs. Status and errors go to stderr; stdout
//! carries only MCP frames from the app.

const USAGE: &str = "\
bitsov-mcp connects an AI client to the BitSov app on this computer.

  bitsov-mcp pair \"<name>\"   ask the app to approve this client (shows six words)
  bitsov-mcp                 run as the AI client's MCP server (stdin/stdout)
  bitsov-mcp forget          delete this client's key

  --socket <path>            use another endpoint (for testing)";

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

#[cfg(not(target_os = "macos"))]
fn run(_args: &[String]) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "not available on this platform yet"))
}

#[cfg(target_os = "macos")]
fn run(args: &[String]) -> std::io::Result<()> {
    use std::io::{BufReader, Error, ErrorKind};
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use bitsov_mcp::{key_file, macos, open_session, pair, relay, PairOutcome};

    let mut args = args.to_vec();
    let socket = match args.iter().position(|a| a == "--socket") {
        Some(at) => {
            let path = args.get(at + 1).cloned().ok_or_else(|| Error::new(ErrorKind::InvalidInput, "--socket needs a path"))?;
            args.drain(at..=at + 1);
            PathBuf::from(path)
        }
        None => macos::default_socket()?,
    };
    let keys = key_file::default_dir()?;
    let connect = || {
        macos::connect(&socket).map_err(|e| Error::new(e.kind(), format!("cannot reach the BitSov app ({e}); is it open with AI clients turned on?")))
    };

    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["pair", name] => {
            if key_file::load(&keys).is_ok() {
                return Err(Error::new(ErrorKind::AlreadyExists, "this client is already paired; run `bitsov-mcp forget` first"));
            }
            let stream = connect()?;
            let mut reader = BufReader::new(stream.try_clone()?);
            let mut writer = stream;
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
            let stream = connect()?;
            let mut reader = BufReader::new(stream.try_clone()?);
            let mut writer = stream.try_clone()?;
            open_session(&mut reader, &mut writer, &key)?;
            drop(key);
            relay(reader, writer, BufReader::new(std::io::stdin()), std::io::stdout(),
                |app: std::os::unix::net::UnixStream| { let _ = app.shutdown(std::net::Shutdown::Write); })
        }
        _ => Err(Error::new(ErrorKind::InvalidInput, USAGE)),
    }
}
