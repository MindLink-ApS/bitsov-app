//! MCP phase 1, slice A1.5a: the sealed, append-only audit log (ADR H3953 A1 §1.9).
//!
//! **Not wired.** Nothing registers this log with a session or the endpoint
//! yet. It compiles only where its parent module does (`cfg(test)` or the
//! off-by-default `mcp-grant` feature).
//!
//! Each [`AuditRow`] is serialized on its own, sealed with the platform
//! at-rest sealer under [`AUDIT_PURPOSE`], and written as one base64 line.
//! A line that does not decode, open or parse is skipped and counted; it never
//! fails the whole read and its bytes are never returned. The log is evidence
//! for the owner, not a control against a program running as the same user:
//! such a program can still delete or reorder whole lines.
//!
//! Two bounds keep the file small:
//! - at most [`REFUSED_HANDSHAKES_PER_MINUTE`] refused-handshake rows are
//!   written in any 60 s; the rest are counted and written as one summary row
//!   ([`SUMMARY_TOOL`]) once the minute has passed. Tool-call rows are never
//!   held back.
//! - when the file grows past [`MAX_FILE_BYTES`], it is cut back to the newest
//!   whole lines that fit in [`TRIM_TO_BYTES`].
//!
//! File access goes through [`AppendIo`], so tests use memory. [`PrivateFile`]
//! is the real file: owner-only and append-only on macOS, iOS and Linux, and
//! the verified private-file layer on Windows. Other platforms get a clear
//! `Unsupported` error.

use std::collections::VecDeque;
use std::io;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};

use super::session::{Audit, AuditRow, Outcome};
use crate::at_rest::Sealer;

/// The sealer purpose for one audit line.
pub const AUDIT_PURPOSE: &str = "mcp-audit-v1";
/// The file's name, beside the approved-clients file.
pub const FILE_NAME: &str = "mcp-audit.log";
/// Rows the UI shows.
pub const SHOW_ROWS: usize = 200;
/// Refused-handshake rows written in any 60 s; more are only counted.
pub const REFUSED_HANDSHAKES_PER_MINUTE: usize = 30;
/// The tool name a refused handshake is audited under (the endpoint's).
pub const HANDSHAKE_TOOL: &str = "handshake";
/// The tool name of the row that counts refused handshakes not written.
pub const SUMMARY_TOOL: &str = "handshakes_not_logged";
/// Longest line written or read (base64 of the sealed record, without `\n`).
pub const MAX_LINE_BYTES: usize = 8 * 1024;
/// Above this size the file is cut back to [`TRIM_TO_BYTES`].
pub const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
/// What a cut keeps: the newest whole lines that fit.
pub const TRIM_TO_BYTES: usize = 1024 * 1024;

/// Format version inside each sealed record.
const VERSION: u32 = 1;
const WINDOW_MS: u64 = 60_000;
/// Field caps applied again here, so no caller can make a line grow unbounded.
const MAX_CLIENT: usize = 128;
const MAX_TOOL: usize = 64;
const MAX_ARGUMENTS: usize = 256;
/// The largest file the log ever leaves behind: a cut happens right after the
/// append that crossed [`MAX_FILE_BYTES`].
const READ_LIMIT: usize = MAX_FILE_BYTES + MAX_LINE_BYTES + 1;

/// The tail of the file, as read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailBytes {
    pub bytes: Vec<u8>,
    /// The bytes start at the beginning of the file. When `false`, the first
    /// (partial) line is dropped by the reader, never parsed.
    pub from_start: bool,
}

/// File access for the log.
pub trait AppendIo {
    /// Append `line` and a `\n` in one write. Returns the file's size after
    /// the write.
    fn append_line(&mut self, line: &[u8]) -> io::Result<u64>;
    /// At most the last `max_bytes` of the file, or `None` when nothing is
    /// there. Never reads more than `max_bytes`.
    fn read_tail(&self, max_bytes: usize) -> io::Result<Option<TailBytes>>;
    /// Replace the whole file (used only to cut it back).
    fn replace_all(&mut self, bytes: &[u8]) -> io::Result<()>;
}

/// What [`AuditLog::last`] read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tail {
    /// At most `n` rows, oldest first, newest last.
    pub rows: Vec<AuditRow>,
    /// Lines in the part read that did not decode, open or parse.
    pub skipped: usize,
}

/// One row as sealed. Field names are stable: they are the on-disk format.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    v: u32,
    at_ms: u64,
    client: String,
    tool: String,
    arguments: String,
    outcome: String,
}

fn outcome_code(outcome: Outcome) -> &'static str {
    match outcome {
        Outcome::Read => "read",
        Outcome::ReadFailed => "read_failed",
        Outcome::Refused => "refused",
        Outcome::RateLimited => "rate_limited",
        Outcome::NotAuthorised => "not_authorised",
    }
}

fn outcome_parse(code: &str) -> Option<Outcome> {
    [Outcome::Read, Outcome::ReadFailed, Outcome::Refused, Outcome::RateLimited, Outcome::NotAuthorised]
        .into_iter()
        .find(|o| outcome_code(*o) == code)
}

/// At most `max` bytes, on a character boundary.
fn cap(text: &str, max: usize) -> String {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn is_refused_handshake(row: &AuditRow) -> bool {
    row.tool == HANDSHAKE_TOOL && row.outcome == Outcome::NotAuthorised
}

/// The sealed, append-only audit log.
pub struct AuditLog<'s, I: AppendIo> {
    sealer: &'s dyn Sealer,
    io: I,
    /// Times of refused-handshake rows written in the last 60 s.
    handshakes: VecDeque<u64>,
    /// Refused handshakes counted but not written, and when the first was.
    held: usize,
    held_since_ms: u64,
    write_failures: usize,
}

impl<'s, I: AppendIo> AuditLog<'s, I> {
    pub fn new(sealer: &'s dyn Sealer, io: I) -> Self {
        AuditLog { sealer, io, handshakes: VecDeque::new(), held: 0, held_since_ms: 0, write_failures: 0 }
    }

    /// Rows that could not be sealed or written since this log was made.
    /// `Audit::append` cannot return an error, so failures are counted here.
    pub fn write_failures(&self) -> usize {
        self.write_failures
    }

    /// Refused handshakes counted but not yet written as a summary row.
    pub fn held_handshakes(&self) -> usize {
        self.held
    }

    /// Write the summary row for held handshakes now, if any (for example
    /// when the endpoint stops).
    pub fn flush(&mut self, now_ms: u64) {
        if self.held > 0 {
            let row = AuditRow {
                at_ms: now_ms,
                client: String::new(),
                tool: SUMMARY_TOOL.to_owned(),
                arguments: format!("{} refused handshakes not logged", self.held),
                outcome: Outcome::NotAuthorised,
            };
            self.held = 0;
            self.write(&row);
        }
    }

    /// At most `n` of the newest rows, oldest first. A line that does not
    /// decode, open or parse is skipped and counted.
    pub fn last(&self, n: usize) -> io::Result<Tail> {
        let budget = n.saturating_mul(MAX_LINE_BYTES + 1).min(READ_LIMIT);
        let Some(tail) = self.io.read_tail(budget)? else {
            return Ok(Tail { rows: Vec::new(), skipped: 0 });
        };
        let mut lines: Vec<&[u8]> = tail.bytes.split(|b| *b == b'\n').collect();
        if !tail.from_start && !lines.is_empty() {
            lines.remove(0);
        }
        // A final empty piece after the last `\n` is not a line.
        if lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        let mut rows = Vec::new();
        let mut skipped = 0;
        for line in lines.iter().rev() {
            if rows.len() == n {
                break;
            }
            match self.decode(line) {
                Some(row) => rows.push(row),
                None => skipped += 1,
            }
        }
        rows.reverse();
        Ok(Tail { rows, skipped })
    }

    fn decode(&self, line: &[u8]) -> Option<AuditRow> {
        if line.is_empty() || line.len() > MAX_LINE_BYTES {
            return None;
        }
        let sealed = STANDARD.decode(line).ok()?;
        let plain = self.sealer.open(AUDIT_PURPOSE, &sealed).ok()?;
        let record: Record = serde_json::from_slice(&plain).ok()?;
        if record.v != VERSION {
            return None;
        }
        Some(AuditRow {
            at_ms: record.at_ms,
            client: record.client,
            tool: record.tool,
            arguments: record.arguments,
            outcome: outcome_parse(&record.outcome)?,
        })
    }

    fn encode(&self, row: &AuditRow) -> Option<Vec<u8>> {
        let record = Record {
            v: VERSION,
            at_ms: row.at_ms,
            client: cap(&row.client, MAX_CLIENT),
            tool: cap(&row.tool, MAX_TOOL),
            arguments: cap(&row.arguments, MAX_ARGUMENTS),
            outcome: outcome_code(row.outcome).to_owned(),
        };
        let plain = zeroize::Zeroizing::new(serde_json::to_vec(&record).ok()?);
        let sealed = self.sealer.seal(AUDIT_PURPOSE, &plain).ok()?;
        let line = STANDARD.encode(sealed).into_bytes();
        (line.len() <= MAX_LINE_BYTES).then_some(line)
    }

    fn write(&mut self, row: &AuditRow) {
        let Some(line) = self.encode(row) else {
            self.write_failures += 1;
            return;
        };
        match self.io.append_line(&line) {
            Ok(size) if size > MAX_FILE_BYTES as u64 => {
                if self.trim().is_err() {
                    self.write_failures += 1;
                }
            }
            Ok(_) => {}
            Err(_) => self.write_failures += 1,
        }
    }

    /// Keep the newest whole lines that fit in [`TRIM_TO_BYTES`].
    fn trim(&mut self) -> io::Result<()> {
        let Some(tail) = self.io.read_tail(TRIM_TO_BYTES)? else {
            return Ok(());
        };
        let keep = if tail.from_start {
            &tail.bytes[..]
        } else {
            match tail.bytes.iter().position(|b| *b == b'\n') {
                Some(i) => &tail.bytes[i + 1..],
                None => &[][..],
            }
        };
        self.io.replace_all(keep)
    }
}

impl<I: AppendIo> Audit for AuditLog<'_, I> {
    fn append(&mut self, row: AuditRow) {
        let now = row.at_ms;
        if self.held > 0 && now >= self.held_since_ms.saturating_add(WINDOW_MS) {
            self.flush(now);
        }
        if is_refused_handshake(&row) {
            while self.handshakes.front().is_some_and(|t| now.saturating_sub(*t) >= WINDOW_MS || *t > now) {
                self.handshakes.pop_front();
            }
            if self.handshakes.len() >= REFUSED_HANDSHAKES_PER_MINUTE {
                if self.held == 0 {
                    self.held_since_ms = now;
                }
                self.held += 1;
                return;
            }
            self.handshakes.push_back(now);
        }
        self.write(&row);
    }
}

/// The real audit file in the app's data directory.
#[derive(Debug)]
pub struct PrivateFile {
    #[cfg_attr(not(any(all(unix, not(target_os = "android")), windows)), allow(dead_code))]
    path: PathBuf,
}

impl PrivateFile {
    /// Open the log in `dir` (the folder of the approved-clients file).
    #[cfg(all(unix, not(target_os = "android")))]
    pub fn open(dir: &Path) -> io::Result<PrivateFile> {
        unix::ensure_dir(dir)?;
        Ok(PrivateFile { path: dir.join(FILE_NAME) })
    }

    /// Open the log in `dir` (the folder of the approved-clients file).
    #[cfg(windows)]
    pub fn open(dir: &Path) -> io::Result<PrivateFile> {
        crate::private_fs::ensure_dir(dir)?;
        Ok(PrivateFile { path: dir.join(FILE_NAME) })
    }

    /// No owner-only file layer on this platform: the audit log is unavailable.
    #[cfg(not(any(all(unix, not(target_os = "android")), windows)))]
    pub fn open(_dir: &Path) -> io::Result<PrivateFile> {
        Err(unsupported())
    }
}

#[cfg(not(any(all(unix, not(target_os = "android")), windows)))]
fn unsupported() -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, "the MCP audit log has no owner-only file store on this platform")
}

#[cfg(not(any(all(unix, not(target_os = "android")), windows)))]
impl AppendIo for PrivateFile {
    fn append_line(&mut self, _line: &[u8]) -> io::Result<u64> {
        Err(unsupported())
    }
    fn read_tail(&self, _max_bytes: usize) -> io::Result<Option<TailBytes>> {
        Err(unsupported())
    }
    fn replace_all(&mut self, _bytes: &[u8]) -> io::Result<()> {
        Err(unsupported())
    }
}

/// macOS, iOS and Linux: `O_APPEND`, 0600, `O_NOFOLLOW`; owner, mode, kind and
/// link count are checked on the open handle before any byte moves.
#[cfg(all(unix, not(target_os = "android")))]
mod unix {
    use std::fs::{File, OpenOptions};
    use std::io::{self, Read, Seek, SeekFrom, Write};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::Path;

    use super::{AppendIo, PrivateFile, TailBytes};

    /// The folder must be a real directory owned by this user; it is made 0700.
    pub(super) fn ensure_dir(dir: &Path) -> io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let meta = std::fs::symlink_metadata(dir)?;
        if !meta.file_type().is_dir() || meta.uid() != bitsov_ffi::effective_uid() {
            return Err(io::Error::other("the audit folder is not this user's directory"));
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
    }

    /// Refuse anything but this user's own regular, single-link, 0600 file.
    fn verify(file: &File) -> io::Result<u64> {
        let meta = file.metadata()?;
        if !meta.file_type().is_file()
            || meta.uid() != bitsov_ffi::effective_uid()
            || meta.mode() & 0o077 != 0
            || meta.nlink() != 1
        {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "the audit file is not this user's private file"));
        }
        Ok(meta.len())
    }

    impl AppendIo for PrivateFile {
        fn append_line(&mut self, line: &[u8]) -> io::Result<u64> {
            let mut file = OpenOptions::new()
                .append(true)
                .create(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(&self.path)?;
            verify(&file)?;
            let mut bytes = Vec::with_capacity(line.len() + 1);
            bytes.extend_from_slice(line);
            bytes.push(b'\n');
            file.write_all(&bytes)?;
            file.sync_data()?;
            Ok(file.metadata()?.len())
        }

        fn read_tail(&self, max_bytes: usize) -> io::Result<Option<TailBytes>> {
            let mut file = match OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(&self.path)
            {
                Ok(file) => file,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(e),
            };
            let len = verify(&file)?;
            let start = len.saturating_sub(max_bytes as u64);
            file.seek(SeekFrom::Start(start))?;
            let mut bytes = Vec::new();
            file.take(max_bytes as u64).read_to_end(&mut bytes)?;
            Ok(Some(TailBytes { bytes, from_start: start == 0 }))
        }

        fn replace_all(&mut self, bytes: &[u8]) -> io::Result<()> {
            let tmp = self.path.with_extension("log.tmp");
            // A leftover from an interrupted cut is unlinked, never followed.
            match std::fs::remove_file(&tmp) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&tmp)?;
            verify(&file)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            std::fs::rename(&tmp, &self.path)
        }
    }
}

/// Windows: the verified private-file layer. It has no append by handle, so an
/// append reads the (bounded) file and replaces it with the line added.
#[cfg(windows)]
impl AppendIo for PrivateFile {
    fn append_line(&mut self, line: &[u8]) -> io::Result<u64> {
        let mut bytes = crate::private_fs::read_optional(&self.path, READ_LIMIT as u64)?
            .map(|b| b.to_vec())
            .unwrap_or_default();
        bytes.extend_from_slice(line);
        bytes.push(b'\n');
        self.replace_all(&bytes)?;
        Ok(bytes.len() as u64)
    }

    fn read_tail(&self, max_bytes: usize) -> io::Result<Option<TailBytes>> {
        let Some(all) = crate::private_fs::read_optional(&self.path, READ_LIMIT as u64)? else {
            return Ok(None);
        };
        let start = all.len().saturating_sub(max_bytes);
        Ok(Some(TailBytes { bytes: all[start..].to_vec(), from_start: start == 0 }))
    }

    fn replace_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        let tmp = self.path.with_extension("log.tmp");
        crate::private_fs::write_replacing_verified(&tmp, &self.path, bytes, |e| e, |readback| {
            if readback == bytes { Ok(()) } else { Err(io::Error::other("the audit file did not read back")) }
        })
    }
}

/// An in-memory file for tests.
#[cfg(test)]
#[derive(Debug, Default)]
pub(crate) struct MemoryFile {
    pub(crate) bytes: Vec<u8>,
    pub(crate) exists: bool,
}

#[cfg(test)]
impl AppendIo for MemoryFile {
    fn append_line(&mut self, line: &[u8]) -> io::Result<u64> {
        self.exists = true;
        self.bytes.extend_from_slice(line);
        self.bytes.push(b'\n');
        Ok(self.bytes.len() as u64)
    }

    fn read_tail(&self, max_bytes: usize) -> io::Result<Option<TailBytes>> {
        if !self.exists {
            return Ok(None);
        }
        let start = self.bytes.len().saturating_sub(max_bytes);
        Ok(Some(TailBytes { bytes: self.bytes[start..].to_vec(), from_start: start == 0 }))
    }

    fn replace_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.exists = true;
        self.bytes = bytes.to_vec();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::at_rest::test_sealer::MemorySealer;

    fn row(at_ms: u64, tool: &str, outcome: Outcome) -> AuditRow {
        AuditRow { at_ms, client: "c1".into(), tool: tool.into(), arguments: "{}".into(), outcome }
    }

    fn handshake(at_ms: u64) -> AuditRow {
        AuditRow {
            at_ms,
            client: "stranger".into(),
            tool: HANDSHAKE_TOOL.into(),
            arguments: "unknown client".into(),
            outcome: Outcome::NotAuthorised,
        }
    }

    fn lines(file: &MemoryFile) -> Vec<&[u8]> {
        let mut v: Vec<&[u8]> = file.bytes.split(|b| *b == b'\n').collect();
        v.pop();
        v
    }

    #[test]
    fn rows_round_trip_one_sealed_line_each() {
        let sealer = MemorySealer;
        let mut log = AuditLog::new(&sealer, MemoryFile::default());
        assert_eq!(log.last(SHOW_ROWS).unwrap(), Tail { rows: vec![], skipped: 0 });
        let outcomes = [Outcome::Read, Outcome::ReadFailed, Outcome::Refused, Outcome::RateLimited, Outcome::NotAuthorised];
        let written: Vec<AuditRow> = outcomes
            .iter()
            .enumerate()
            .map(|(i, o)| AuditRow {
                at_ms: 1_000 + i as u64,
                client: format!("client-{i}"),
                tool: "balance".into(),
                arguments: format!("{{\"n\":{i}}}"),
                outcome: *o,
            })
            .collect();
        for r in &written {
            log.append(r.clone());
        }
        assert_eq!(lines(&log.io).len(), written.len());
        // No plaintext on disk: the client names appear in no line.
        assert!(!log.io.bytes.windows(7).any(|w| w == b"client-"));
        let tail = log.last(SHOW_ROWS).unwrap();
        assert_eq!(tail, Tail { rows: written, skipped: 0 });
        assert_eq!(log.write_failures(), 0);
    }

    #[test]
    fn a_tampered_line_is_skipped_alone_and_never_returned() {
        let sealer = MemorySealer;
        let mut log = AuditLog::new(&sealer, MemoryFile::default());
        for i in 0..3 {
            log.append(row(i, "balance", Outcome::Read));
        }
        // Damage the middle line: flip one base64 character and add garbage.
        let text = String::from_utf8(log.io.bytes.clone()).unwrap();
        let mut parts: Vec<String> = text.lines().map(str::to_owned).collect();
        parts[1] = format!("{}!!", &parts[1][..parts[1].len() - 4]);
        log.io.bytes = (parts.join("\n") + "\n").into_bytes();
        let tail = log.last(SHOW_ROWS).unwrap();
        assert_eq!(tail.skipped, 1);
        assert_eq!(tail.rows.iter().map(|r| r.at_ms).collect::<Vec<_>>(), vec![0, 2]);
        // A line sealed under the right purpose but with an unknown field is also skipped.
        let sealed = sealer.seal(AUDIT_PURPOSE, br#"{"v":1,"at_ms":9,"client":"x","tool":"t","arguments":"","outcome":"read","extra":1}"#).unwrap();
        log.io.append_line(STANDARD.encode(sealed).as_bytes()).unwrap();
        let unknown_outcome = sealer.seal(AUDIT_PURPOSE, br#"{"v":1,"at_ms":9,"client":"x","tool":"t","arguments":"","outcome":"paid"}"#).unwrap();
        log.io.append_line(STANDARD.encode(unknown_outcome).as_bytes()).unwrap();
        let tail = log.last(SHOW_ROWS).unwrap();
        assert_eq!(tail.skipped, 3);
        assert_eq!(tail.rows.len(), 2);
    }

    #[test]
    fn a_line_sealed_under_another_purpose_does_not_open() {
        let sealer = MemorySealer;
        let mut log = AuditLog::new(&sealer, MemoryFile::default());
        log.append(row(1, "balance", Outcome::Read));
        let plain = br#"{"v":1,"at_ms":2,"client":"x","tool":"t","arguments":"","outcome":"read"}"#;
        let other = sealer.seal("mcp-clients-v1", plain).unwrap();
        log.io.append_line(STANDARD.encode(other).as_bytes()).unwrap();
        // The same bytes under the right purpose do open: only the purpose differs.
        let right = sealer.seal(AUDIT_PURPOSE, plain).unwrap();
        log.io.append_line(STANDARD.encode(right).as_bytes()).unwrap();
        let tail = log.last(SHOW_ROWS).unwrap();
        assert_eq!(tail.skipped, 1);
        assert_eq!(tail.rows.iter().map(|r| r.at_ms).collect::<Vec<_>>(), vec![1, 2]);
        assert!(sealer.open(AUDIT_PURPOSE, &sealer.seal("mcp-clients-v1", plain).unwrap()).is_err());
    }

    #[test]
    fn last_returns_the_newest_rows_oldest_first_and_at_most_n() {
        let sealer = MemorySealer;
        let mut log = AuditLog::new(&sealer, MemoryFile::default());
        for i in 0..450u64 {
            log.append(row(i, "balance", Outcome::Read));
        }
        let tail = log.last(SHOW_ROWS).unwrap();
        assert_eq!(tail.rows.len(), SHOW_ROWS);
        assert_eq!(tail.rows.first().unwrap().at_ms, 250);
        assert_eq!(tail.rows.last().unwrap().at_ms, 449);
        assert!(tail.rows.windows(2).all(|w| w[0].at_ms < w[1].at_ms));
        assert_eq!(log.last(3).unwrap().rows.iter().map(|r| r.at_ms).collect::<Vec<_>>(), vec![447, 448, 449]);
        assert!(log.last(0).unwrap().rows.is_empty());
    }

    #[test]
    fn long_fields_are_capped_so_every_line_stays_bounded() {
        let sealer = MemorySealer;
        let mut log = AuditLog::new(&sealer, MemoryFile::default());
        log.append(AuditRow {
            at_ms: 1,
            client: "é".repeat(1_000),
            tool: "t".repeat(1_000),
            arguments: "\"".repeat(10_000),
            outcome: Outcome::Refused,
        });
        assert_eq!(log.write_failures(), 0);
        assert!(lines(&log.io)[0].len() <= MAX_LINE_BYTES);
        let r = &log.last(1).unwrap().rows[0];
        assert!(r.client.len() <= MAX_CLIENT && r.tool.len() == MAX_TOOL && r.arguments.len() == MAX_ARGUMENTS);
    }

    #[test]
    fn refused_handshakes_are_capped_per_minute_with_one_summary_row() {
        let sealer = MemorySealer;
        let mut log = AuditLog::new(&sealer, MemoryFile::default());
        // A flood: 100 refused handshakes within the first second.
        for i in 0..100u64 {
            log.append(handshake(10_000 + i));
            if i == 50 {
                // A tool call in the middle of the flood is still written.
                log.append(row(10_000 + i, "balance", Outcome::Read));
            }
        }
        assert_eq!(lines(&log.io).len(), REFUSED_HANDSHAKES_PER_MINUTE + 1);
        assert_eq!(log.held_handshakes(), 70);
        // Still inside the minute: more are held, no summary yet.
        log.append(handshake(69_000));
        assert_eq!(log.held_handshakes(), 71);
        assert_eq!(lines(&log.io).len(), REFUSED_HANDSHAKES_PER_MINUTE + 1);
        // Once the minute since the first held row has passed: one summary
        // row, then the new handshake, which the freed window admits.
        log.append(handshake(70_100));
        let rows = log.last(SHOW_ROWS).unwrap().rows;
        assert_eq!(rows.len(), REFUSED_HANDSHAKES_PER_MINUTE + 3);
        let summary = &rows[rows.len() - 2];
        assert_eq!(summary.tool, SUMMARY_TOOL);
        assert_eq!(summary.arguments, "71 refused handshakes not logged");
        assert_eq!(summary.at_ms, 70_100);
        assert_eq!(rows.last().unwrap(), &handshake(70_100));
        assert_eq!(log.held_handshakes(), 0);
        // Ordinary tool calls are never capped, refused or not.
        for i in 0..200u64 {
            log.append(row(80_000 + i, "balance", Outcome::Refused));
        }
        assert_eq!(log.last(SHOW_ROWS).unwrap().rows.iter().filter(|r| r.at_ms >= 80_000).count(), 200);
    }

    #[test]
    fn a_sustained_flood_writes_at_most_the_cap_plus_one_summary_per_minute() {
        let sealer = MemorySealer;
        let mut log = AuditLog::new(&sealer, MemoryFile::default());
        // Ten minutes, one refused handshake every 100 ms.
        for t in (0..600_000u64).step_by(100) {
            log.append(handshake(t));
        }
        log.flush(600_000);
        let n = lines(&log.io).len();
        assert!(n <= 10 * (REFUSED_HANDSHAKES_PER_MINUTE + 1) + 1, "{n} rows written");
        let rows = log.last(usize::MAX).unwrap().rows;
        let written = rows.iter().filter(|r| r.tool == HANDSHAKE_TOOL).count();
        let held: usize = rows
            .iter()
            .filter(|r| r.tool == SUMMARY_TOOL)
            .map(|r| r.arguments.split(' ').next().unwrap().parse::<usize>().unwrap())
            .sum();
        assert_eq!(written + held, 6_000, "every attempt is either a row or counted in a summary");
    }

    #[test]
    fn the_file_is_cut_back_to_whole_newest_lines() {
        let sealer = MemorySealer;
        let mut log = AuditLog::new(&sealer, MemoryFile::default());
        let mut i = 0u64;
        while log.io.bytes.len() <= MAX_FILE_BYTES - MAX_LINE_BYTES {
            log.append(AuditRow { at_ms: i, client: "c".into(), tool: "t".into(), arguments: "a".repeat(200), outcome: Outcome::Read });
            i += 1;
        }
        for _ in 0..50 {
            log.append(AuditRow { at_ms: i, client: "c".into(), tool: "t".into(), arguments: "a".repeat(200), outcome: Outcome::Read });
            i += 1;
        }
        assert!(log.io.bytes.len() <= MAX_FILE_BYTES);
        let all = log.last(usize::MAX).unwrap();
        assert_eq!(all.skipped, 0, "a cut leaves no partial line");
        assert_eq!(all.rows.last().unwrap().at_ms, i - 1);
        assert!(all.rows.windows(2).all(|w| w[1].at_ms == w[0].at_ms + 1));
        assert!(all.rows.len() < i as usize);
        assert_eq!(log.write_failures(), 0);
    }

    #[test]
    fn a_read_from_mid_file_drops_the_partial_first_line() {
        let sealer = MemorySealer;
        let mut log = AuditLog::new(&sealer, MemoryFile::default());
        for i in 0..5 {
            log.append(row(i, "balance", Outcome::Read));
        }
        // Junk ahead of the rows that is longer than any read of 2 rows.
        let mut junk = vec![b'x'; 3 * (MAX_LINE_BYTES + 1)];
        junk.push(b'\n');
        junk.extend_from_slice(&log.io.bytes);
        log.io.bytes = junk;
        let tail = log.last(2).unwrap();
        assert_eq!(tail.rows.iter().map(|r| r.at_ms).collect::<Vec<_>>(), vec![3, 4]);
        assert_eq!(tail.skipped, 0);
    }

    #[cfg(all(unix, not(target_os = "android")))]
    mod unix_file {
        use super::*;
        use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

        #[test]
        fn the_real_file_round_trips_and_is_owner_only() {
            let dir = tempfile::tempdir().unwrap();
            let logdir = dir.path().join("data");
            let sealer = MemorySealer;
            let mut log = AuditLog::new(&sealer, PrivateFile::open(&logdir).unwrap());
            for i in 0..3 {
                log.append(row(i, "balance", Outcome::Read));
            }
            assert_eq!(log.last(SHOW_ROWS).unwrap().rows.len(), 3);
            assert_eq!(log.write_failures(), 0);
            let meta = std::fs::metadata(logdir.join(FILE_NAME)).unwrap();
            assert_eq!(meta.mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(&logdir).unwrap().mode() & 0o777, 0o700);
            // A cut through the real file keeps it private.
            log.io.replace_all(b"").unwrap();
            assert_eq!(std::fs::metadata(logdir.join(FILE_NAME)).unwrap().mode() & 0o777, 0o600);
            assert!(log.last(SHOW_ROWS).unwrap().rows.is_empty());
        }

        #[test]
        fn a_widened_file_is_refused_for_read_and_append() {
            let dir = tempfile::tempdir().unwrap();
            let sealer = MemorySealer;
            let mut log = AuditLog::new(&sealer, PrivateFile::open(dir.path()).unwrap());
            log.append(row(1, "balance", Outcome::Read));
            let path = dir.path().join(FILE_NAME);
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            let before = std::fs::read(&path).unwrap();
            assert_eq!(log.last(SHOW_ROWS).unwrap_err().kind(), io::ErrorKind::PermissionDenied);
            log.append(row(2, "balance", Outcome::Read));
            assert_eq!(log.write_failures(), 1);
            assert_eq!(std::fs::read(&path).unwrap(), before, "a refused file is left as it is");
        }

        #[test]
        fn a_symlinked_file_is_refused_and_its_target_untouched() {
            let dir = tempfile::tempdir().unwrap();
            let target = dir.path().join("elsewhere");
            std::fs::write(&target, b"keep\n").unwrap();
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
            let logdir = dir.path().join("data");
            let file = PrivateFile::open(&logdir).unwrap();
            symlink(&target, logdir.join(FILE_NAME)).unwrap();
            let sealer = MemorySealer;
            let mut log = AuditLog::new(&sealer, file);
            log.append(row(1, "balance", Outcome::Read));
            assert_eq!(log.write_failures(), 1);
            assert!(log.last(SHOW_ROWS).is_err());
            assert_eq!(std::fs::read(&target).unwrap(), b"keep\n");
        }

        #[test]
        fn a_hard_linked_file_is_refused() {
            let dir = tempfile::tempdir().unwrap();
            let sealer = MemorySealer;
            let mut log = AuditLog::new(&sealer, PrivateFile::open(dir.path()).unwrap());
            log.append(row(1, "balance", Outcome::Read));
            std::fs::hard_link(dir.path().join(FILE_NAME), dir.path().join("copy")).unwrap();
            assert!(log.last(SHOW_ROWS).is_err());
        }

        #[test]
        fn a_symlinked_folder_is_refused() {
            let dir = tempfile::tempdir().unwrap();
            let real = dir.path().join("real");
            std::fs::create_dir(&real).unwrap();
            let link = dir.path().join("link");
            symlink(&real, &link).unwrap();
            assert!(PrivateFile::open(&link).is_err());
        }

        #[test]
        fn reads_are_bounded_by_the_request() {
            let dir = tempfile::tempdir().unwrap();
            let file = PrivateFile::open(dir.path()).unwrap();
            let path = dir.path().join(FILE_NAME);
            // One long junk line, then one line just over the line limit.
            let mut bytes = vec![b'a'; 100_000];
            bytes.push(b'\n');
            bytes.extend(vec![b'b'; MAX_LINE_BYTES + 100]);
            bytes.push(b'\n');
            std::fs::write(&path, &bytes).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            let tail = file.read_tail(1_000).unwrap().unwrap();
            assert_eq!(tail.bytes, bytes[bytes.len() - 1_000..]);
            assert!(!tail.from_start);
            let whole = file.read_tail(1_000_000).unwrap().unwrap();
            assert_eq!(whole.bytes, bytes);
            assert!(whole.from_start);
            // last(2) reads at most two lines' worth of bytes, however big the file.
            let sealer = MemorySealer;
            let log = AuditLog::new(&sealer, file);
            let tail = log.last(2).unwrap();
            assert!(tail.rows.is_empty());
            assert_eq!(tail.skipped, 1, "the oversized line is skipped, not parsed");
        }
    }

    #[cfg(windows)]
    mod windows_file {
        use super::*;
        use crate::private_fs::fixtures::{elevated, temp_root};

        #[test]
        fn the_real_file_round_trips_through_the_private_layer() {
            if elevated() {
                return;
            }
            let root = temp_root("mcp-audit");
            let sealer = MemorySealer;
            let mut log = AuditLog::new(&sealer, PrivateFile::open(&root.join("data")).unwrap());
            for i in 0..3 {
                log.append(row(i, "balance", Outcome::Read));
            }
            assert_eq!(log.write_failures(), 0);
            assert_eq!(log.last(SHOW_ROWS).unwrap().rows.iter().map(|r| r.at_ms).collect::<Vec<_>>(), vec![0, 1, 2]);
            crate::private_fs::verify_file(&root.join("data").join(FILE_NAME)).unwrap();
            let _ = std::fs::remove_dir_all(&root);
        }
    }
}
