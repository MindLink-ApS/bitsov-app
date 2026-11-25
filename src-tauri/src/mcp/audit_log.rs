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
//! - rows that record nothing read are held back past a per-minute allowance:
//!   at most [`NOT_AUTHORISED_ROWS_PER_MINUTE`] `NotAuthorised` rows in any
//!   60 s (all clients together: refused handshakes, unknown or revoked
//!   clients), and at most [`REFUSED_ROWS_PER_CLIENT_PER_MINUTE`] `Refused`
//!   or `RateLimited` rows per client. The rest are counted and written as one
//!   summary row per allowance ([`SUMMARY_TOOL`], naming the client) once a
//!   minute has passed since the first held row. `Read` and `ReadFailed` rows
//!   are always written. So a flood adds at most one allowance plus one
//!   summary row a minute per client.
//! - the file is cut by row count, not by bytes, so the history kept does not
//!   depend on how large one sealed line is (a DPAPI line is several times a
//!   test line): above [`MAX_ROWS`] rows it is cut back to the newest
//!   [`KEEP_ROWS`]. [`MAX_FILE_BYTES`] is only a hard ceiling for a file
//!   damaged or grown outside the log; it is sized at [`MAX_ROWS`] lines of the
//!   longest length written ([`MAX_LINE_BYTES`]), so rows always cut first.
//!
//! File access goes through [`AppendIo`], so tests use memory. [`PrivateFile`]
//! is the real file: owner-only and append-only on macOS, iOS and Linux, and
//! the verified private-file layer on Windows. Other platforms get a clear
//! `Unsupported` error.
//!
//! **For the wiring.** Each append syncs the file to disk, and on Windows
//! rewrites it (at most [`MAX_ROWS`] lines, 500 there: under 1 MiB at
//! realistic DPAPI line sizes, never more than [`MAX_FILE_BYTES`]). So
//! `append` must not run under the host lock: hand rows to a writer thread. Held counts live
//! in memory only: call [`AuditLog::flush_due`] from a periodic tick and
//! [`AuditLog::flush`] when the endpoint stops.

use std::collections::{BTreeMap, VecDeque};
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
/// `NotAuthorised` rows written in any 60 s, all clients together.
pub const NOT_AUTHORISED_ROWS_PER_MINUTE: usize = 30;
/// `Refused` and `RateLimited` rows written per client in any 60 s.
pub const REFUSED_ROWS_PER_CLIENT_PER_MINUTE: usize = 30;
/// Clients with their own allowance; later ones share one.
pub const MAX_TRACKED_CLIENTS: usize = 32;
/// The tool name a refused handshake is audited under (the endpoint's).
pub const HANDSHAKE_TOOL: &str = "handshake";
/// The tool name of a row that counts rows not written.
pub const SUMMARY_TOOL: &str = "rows_not_logged";
/// Longest line written or read (base64 of the sealed record, without `\n`).
pub const MAX_LINE_BYTES: usize = 8 * 1024;
/// Rows kept by a cut. More than [`SHOW_ROWS`], so the UI always has a full page.
#[cfg(not(windows))]
pub const KEEP_ROWS: usize = 1_000;
/// Windows rewrites the whole file on each append, so it keeps fewer rows.
#[cfg(windows)]
pub const KEEP_ROWS: usize = 250;
/// Above this many rows the file is cut back to [`KEEP_ROWS`].
pub const MAX_ROWS: usize = 2 * KEEP_ROWS;
/// Hard ceiling on the file's size, whatever its row count: [`MAX_ROWS`] lines
/// of the longest length written. Realistic lines are far shorter (about
/// 1.3 KiB for a typical row with DPAPI, less with the Apple sealers), so the
/// row cut comes first.
pub const MAX_FILE_BYTES: usize = MAX_ROWS * (MAX_LINE_BYTES + 1);
/// What a cut by the byte ceiling keeps.
pub const TRIM_TO_BYTES: usize = KEEP_ROWS * (MAX_LINE_BYTES + 1);

/// Format version inside each sealed record.
const VERSION: u32 = 1;
const WINDOW_MS: u64 = 60_000;
/// Field caps applied again here, so no caller can make a line grow unbounded.
const MAX_CLIENT: usize = 128;
const MAX_TOOL: usize = 64;
const MAX_ARGUMENTS: usize = 256;
/// The largest file the log ever leaves behind: a cut happens right after the
/// append that crossed a bound.
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
        Outcome::Removed => "removed",
    }
}

fn outcome_parse(code: &str) -> Option<Outcome> {
    [Outcome::Read, Outcome::ReadFailed, Outcome::Refused, Outcome::RateLimited, Outcome::NotAuthorised, Outcome::Removed]
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

/// The bytes of whole lines in a tail. A tail read from mid-file is one byte
/// longer than needed, so when it starts right after a `\n` the first whole
/// line is kept, and a partial first line is dropped, never parsed.
fn whole_lines(tail: &TailBytes) -> &[u8] {
    if tail.from_start {
        return &tail.bytes;
    }
    match tail.bytes.iter().position(|b| *b == b'\n') {
        Some(i) => &tail.bytes[i + 1..],
        None => &[],
    }
}

/// Rows that share one per-minute allowance. `Read` and `ReadFailed` rows
/// have none: they are always written.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Bucket {
    /// Every `NotAuthorised` row (refused handshakes, unknown or revoked
    /// clients). One shared allowance: these client names are not proven.
    NotAuthorised,
    /// `Refused` and `RateLimited` rows of one (authenticated) client.
    Client(String),
    /// The same, for clients beyond [`MAX_TRACKED_CLIENTS`].
    OtherClients,
}

#[derive(Debug, Default)]
struct Allowance {
    /// Times of rows written in the last 60 s.
    written: VecDeque<u64>,
    /// Rows counted but not written, and when the first of them was.
    held: usize,
    held_since_ms: u64,
}

impl Allowance {
    fn prune(&mut self, now: u64) {
        while self.written.front().is_some_and(|t| now.saturating_sub(*t) >= WINDOW_MS || *t > now) {
            self.written.pop_front();
        }
    }
}

fn summary_row(bucket: &Bucket, held: usize, now_ms: u64) -> AuditRow {
    let (client, arguments, outcome) = match bucket {
        Bucket::NotAuthorised => (String::new(), format!("{held} not-authorised attempts not logged"), Outcome::NotAuthorised),
        Bucket::Client(c) => (c.clone(), format!("{held} refused or rate-limited calls not logged"), Outcome::Refused),
        Bucket::OtherClients => {
            (String::new(), format!("{held} refused or rate-limited calls from other clients not logged"), Outcome::Refused)
        }
    };
    AuditRow { at_ms: now_ms, client, tool: SUMMARY_TOOL.to_owned(), arguments, outcome }
}

/// The sealed, append-only audit log.
pub struct AuditLog<'s, I: AppendIo> {
    sealer: &'s dyn Sealer,
    io: I,
    allowances: BTreeMap<Bucket, Allowance>,
    /// Rows in the file, counted once on the first append, then kept.
    rows: Option<usize>,
    write_failures: usize,
}

impl<'s, I: AppendIo> AuditLog<'s, I> {
    pub fn new(sealer: &'s dyn Sealer, io: I) -> Self {
        AuditLog { sealer, io, allowances: BTreeMap::new(), rows: None, write_failures: 0 }
    }

    /// Rows that could not be sealed or written since this log was made.
    /// `Audit::append` cannot return an error, so failures are counted here.
    pub fn write_failures(&self) -> usize {
        self.write_failures
    }

    /// Rows counted but not yet written as a summary row.
    pub fn held_rows(&self) -> usize {
        self.allowances.values().map(|a| a.held).sum()
    }

    /// Write a summary row for every allowance whose first held row is a
    /// minute old, and forget idle allowances. `append` does this itself; the
    /// wiring also calls it from a periodic tick, so a flood followed by
    /// silence is still summarised.
    pub fn flush_due(&mut self, now_ms: u64) {
        self.flush_where(now_ms, |a| now_ms >= a.held_since_ms.saturating_add(WINDOW_MS));
    }

    /// Write every pending summary row now (the wiring calls this when the
    /// endpoint stops). Counts held only in memory are lost on a crash.
    pub fn flush(&mut self, now_ms: u64) {
        self.flush_where(now_ms, |_| true);
    }

    fn flush_where(&mut self, now_ms: u64, due: impl Fn(&Allowance) -> bool) {
        let mut summaries = Vec::new();
        for (bucket, allowance) in self.allowances.iter_mut() {
            if allowance.held > 0 && due(allowance) {
                summaries.push(summary_row(bucket, allowance.held, now_ms));
                allowance.held = 0;
            }
        }
        self.allowances.retain(|_, a| {
            a.prune(now_ms);
            a.held > 0 || !a.written.is_empty()
        });
        for row in &summaries {
            self.write(row);
        }
    }

    fn bucket_of(&self, row: &AuditRow) -> Option<Bucket> {
        match row.outcome {
            // The owner's removals are rare and never come from a client.
            Outcome::Read | Outcome::ReadFailed | Outcome::Removed => None,
            Outcome::NotAuthorised => Some(Bucket::NotAuthorised),
            Outcome::Refused | Outcome::RateLimited => {
                let client = Bucket::Client(cap(&row.client, MAX_CLIENT));
                let tracked = self.allowances.keys().filter(|b| matches!(b, Bucket::Client(_))).count();
                Some(if self.allowances.contains_key(&client) || tracked < MAX_TRACKED_CLIENTS {
                    client
                } else {
                    Bucket::OtherClients
                })
            }
        }
    }

    /// At most `n` of the newest rows, oldest first. A line that does not
    /// decode, open or parse is skipped and counted.
    pub fn last(&self, n: usize) -> io::Result<Tail> {
        let budget = n.saturating_mul(MAX_LINE_BYTES + 1).min(READ_LIMIT).saturating_add(1);
        let Some(tail) = self.io.read_tail(budget)? else {
            return Ok(Tail { rows: Vec::new(), skipped: 0 });
        };
        let mut lines: Vec<&[u8]> = whole_lines(&tail).split(|b| *b == b'\n').collect();
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
        let size = match self.io.append_line(&line) {
            Ok(size) => size,
            Err(_) => {
                self.write_failures += 1;
                return;
            }
        };
        let rows = match self.rows {
            Some(rows) => Some(rows + 1),
            None => self.count_rows().ok(),
        };
        self.rows = rows;
        if (size > MAX_FILE_BYTES as u64 || rows.is_some_and(|r| r > MAX_ROWS)) && self.trim().is_err() {
            self.write_failures += 1;
        }
    }

    /// Whole lines in the (bounded) file, the one just appended included.
    fn count_rows(&self) -> io::Result<usize> {
        let tail = self.io.read_tail(READ_LIMIT)?;
        Ok(tail.map_or(0, |t| whole_lines(&t).iter().filter(|b| **b == b'\n').count()))
    }

    /// Keep the newest [`KEEP_ROWS`] whole lines, and at most
    /// [`TRIM_TO_BYTES`] of them.
    fn trim(&mut self) -> io::Result<()> {
        let Some(tail) = self.io.read_tail(TRIM_TO_BYTES + 1)? else {
            self.rows = Some(0);
            return Ok(());
        };
        let lines = whole_lines(&tail);
        let total = lines.iter().filter(|b| **b == b'\n').count();
        let skip = total.saturating_sub(KEEP_ROWS);
        let start = if skip == 0 {
            0
        } else {
            lines.iter().enumerate().filter(|(_, b)| **b == b'\n').nth(skip - 1).map_or(lines.len(), |(i, _)| i + 1)
        };
        self.io.replace_all(&lines[start..])?;
        self.rows = Some(total - skip);
        Ok(())
    }
}

impl<I: AppendIo> Audit for AuditLog<'_, I> {
    fn append(&mut self, row: AuditRow) {
        let now = row.at_ms;
        self.flush_due(now);
        if let Some(bucket) = self.bucket_of(&row) {
            let limit = match bucket {
                Bucket::NotAuthorised => NOT_AUTHORISED_ROWS_PER_MINUTE,
                _ => REFUSED_ROWS_PER_CLIENT_PER_MINUTE,
            };
            let allowance = self.allowances.entry(bucket).or_default();
            allowance.prune(now);
            if allowance.written.len() >= limit {
                if allowance.held == 0 {
                    allowance.held_since_ms = now;
                }
                allowance.held += 1;
                return;
            }
            allowance.written.push_back(now);
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
            std::fs::rename(&tmp, &self.path)?;
            // Best effort: make the rename itself durable.
            if let Some(dir) = self.path.parent() {
                let _ = File::open(dir).and_then(|d| d.sync_all());
            }
            Ok(())
        }
    }
}

/// Windows: the verified private-file layer. It has no append by handle, so an
/// append reads the file and replaces it with the line added, cutting it back
/// first when the line would take it past the byte ceiling. The row cut keeps
/// the file at most [`MAX_ROWS`] lines, which bounds the work per row. Reads
/// accept up to twice the ceiling, so a file left larger (for example by a
/// failed cut) is cut back, not refused for good.
#[cfg(windows)]
const WINDOWS_READ_LIMIT: u64 = 2 * MAX_FILE_BYTES as u64;

#[cfg(windows)]
impl AppendIo for PrivateFile {
    fn append_line(&mut self, line: &[u8]) -> io::Result<u64> {
        let existing = crate::private_fs::read_optional(&self.path, WINDOWS_READ_LIMIT)?
            .map(|b| b.to_vec())
            .unwrap_or_default();
        let mut bytes = if existing.len() + line.len() + 1 > MAX_FILE_BYTES {
            let start = existing.len().saturating_sub(TRIM_TO_BYTES + 1);
            let tail = TailBytes { bytes: existing[start..].to_vec(), from_start: start == 0 };
            whole_lines(&tail).to_vec()
        } else {
            existing
        };
        bytes.extend_from_slice(line);
        bytes.push(b'\n');
        self.replace_all(&bytes)?;
        Ok(bytes.len() as u64)
    }

    fn read_tail(&self, max_bytes: usize) -> io::Result<Option<TailBytes>> {
        let Some(all) = crate::private_fs::read_optional(&self.path, WINDOWS_READ_LIMIT)? else {
            return Ok(None);
        };
        let start = all.len().saturating_sub(max_bytes);
        Ok(Some(TailBytes { bytes: all[start..].to_vec(), from_start: start == 0 }))
    }

    /// A fresh random scratch name per rewrite: a scratch file left by a
    /// crash is never reused, so it cannot block later appends.
    fn replace_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        let tmp = scratch_path(&self.path)?;
        crate::private_fs::write_replacing_verified(&tmp, &self.path, bytes, |e| e, |readback| {
            if readback == bytes { Ok(()) } else { Err(io::Error::other("the audit file did not read back")) }
        })
    }
}

/// A fresh scratch name beside `path`: `<name>.<16 hex>.tmp`.
#[cfg(windows)]
fn scratch_path(path: &Path) -> io::Result<PathBuf> {
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|_| io::Error::other("no randomness"))?;
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", hex::encode(random)));
    Ok(path.with_file_name(name))
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
        assert_eq!(lines(&log.io).len(), NOT_AUTHORISED_ROWS_PER_MINUTE + 1);
        assert_eq!(log.held_rows(), 70);
        // Still inside the minute: more are held, no summary yet.
        log.append(handshake(69_000));
        assert_eq!(log.held_rows(), 71);
        assert_eq!(lines(&log.io).len(), NOT_AUTHORISED_ROWS_PER_MINUTE + 1);
        // Once the minute since the first held row has passed: one summary
        // row, then the new handshake, which the freed window admits.
        log.append(handshake(70_100));
        let rows = log.last(SHOW_ROWS).unwrap().rows;
        assert_eq!(rows.len(), NOT_AUTHORISED_ROWS_PER_MINUTE + 3);
        let summary = &rows[rows.len() - 2];
        assert_eq!(summary.tool, SUMMARY_TOOL);
        assert_eq!(summary.arguments, "71 not-authorised attempts not logged");
        assert_eq!(summary.at_ms, 70_100);
        assert_eq!(rows.last().unwrap(), &handshake(70_100));
        assert_eq!(log.held_rows(), 0);
        // Reads are never capped.
        for i in 0..200u64 {
            log.append(row(80_000 + i, "balance", Outcome::Read));
        }
        assert_eq!(log.last(SHOW_ROWS).unwrap().rows.iter().filter(|r| r.at_ms >= 80_000).count(), 200);
    }

    fn call(at_ms: u64, client: &str, outcome: Outcome) -> AuditRow {
        AuditRow { at_ms, client: client.into(), tool: "balance".into(), arguments: "{}".into(), outcome }
    }

    #[test]
    fn refused_and_rate_limited_rows_are_capped_per_client_with_a_named_summary() {
        let sealer = MemorySealer;
        let mut log = AuditLog::new(&sealer, MemoryFile::default());
        // Client a floods refused and rate-limited calls; client b makes a few.
        for i in 0..100u64 {
            let outcome = if i % 2 == 0 { Outcome::Refused } else { Outcome::RateLimited };
            log.append(call(1_000 + i, "a", outcome));
        }
        for i in 0..5u64 {
            log.append(call(2_000 + i, "b", Outcome::Refused));
            log.append(call(2_000 + i, "a", Outcome::Read));
            log.append(call(2_000 + i, "a", Outcome::ReadFailed));
        }
        let rows = log.last(usize::MAX).unwrap().rows;
        let count = |client: &str, outcome: Outcome| rows.iter().filter(|r| r.client == client && r.outcome == outcome).count();
        assert_eq!(count("a", Outcome::Refused) + count("a", Outcome::RateLimited), REFUSED_ROWS_PER_CLIENT_PER_MINUTE);
        assert_eq!(count("b", Outcome::Refused), 5, "another client has its own allowance");
        assert_eq!(count("a", Outcome::Read), 5);
        assert_eq!(count("a", Outcome::ReadFailed), 5);
        assert_eq!(log.held_rows(), 70);
        // A periodic tick after the minute writes one summary naming the client.
        log.flush_due(30_000);
        assert_eq!(log.held_rows(), 70, "not due yet");
        log.flush_due(62_000);
        assert_eq!(log.held_rows(), 0);
        let summary = log.last(1).unwrap().rows.pop().unwrap();
        assert_eq!(summary, AuditRow {
            at_ms: 62_000,
            client: "a".into(),
            tool: SUMMARY_TOOL.into(),
            arguments: "70 refused or rate-limited calls not logged".into(),
            outcome: Outcome::Refused,
        });
    }

    #[test]
    fn one_client_flooding_refused_calls_cannot_push_older_rows_out_of_the_history() {
        let sealer = MemorySealer;
        let mut log = AuditLog::new(&sealer, MemoryFile::default());
        for i in 0..50u64 {
            log.append(call(i, "owner-tool", Outcome::Read));
        }
        // Ten minutes of 100,000 refused and rate-limited calls (every 6 ms),
        // with the longest arguments a row can carry.
        let mut flood = 0;
        for t in (1_000..601_000u64).step_by(6) {
            let outcome = if t % 12 == 0 { Outcome::Refused } else { Outcome::RateLimited };
            log.append(AuditRow { at_ms: t, client: "flooder".into(), tool: "x".repeat(64), arguments: "y".repeat(256), outcome });
            flood += 1;
        }
        log.flush(601_000);
        // No cut was needed (on Windows, with its smaller cap, too), so nothing old was dropped.
        assert!(log.io.bytes.len() < MAX_FILE_BYTES * 3 / 4, "{} bytes after the flood", log.io.bytes.len());
        let rows = log.last(usize::MAX).unwrap().rows;
        assert_eq!(rows.iter().filter(|r| r.client == "owner-tool").count(), 50, "every earlier read is still there");
        assert!(rows.len() <= 50 + 10 * (REFUSED_ROWS_PER_CLIENT_PER_MINUTE + 1) + 1, "{} rows", rows.len());
        let written = rows.iter().filter(|r| r.client == "flooder" && r.tool != SUMMARY_TOOL).count();
        let held: usize = rows
            .iter()
            .filter(|r| r.tool == SUMMARY_TOOL)
            .map(|r| r.arguments.split(' ').next().unwrap().parse::<usize>().unwrap())
            .sum();
        assert_eq!(written + held, flood, "every call is either a row or counted in a summary");
    }

    /// Output at least as large as the Windows DPAPI sealer's: the same
    /// purpose frame and JSON envelope with base64url inside, and 512 bytes of
    /// blob overhead (a real current-user DPAPI blob adds about 300), padded to
    /// 16. Reversible, not encryption.
    struct DpapiSizedSealer;

    const DPAPI_SIZED_OVERHEAD: usize = 512;

    impl DpapiSizedSealer {
        fn frame(purpose: &str) -> Vec<u8> {
            let mut frame = b"bitsov-sealed-v1\0".to_vec();
            for label in ["a-reasonably-long-app-profile-name", purpose] {
                frame.extend_from_slice(&(label.len() as u32).to_be_bytes());
                frame.extend_from_slice(label.as_bytes());
            }
            frame
        }
    }

    impl Sealer for DpapiSizedSealer {
        fn seal(&self, purpose: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
            use base64::engine::general_purpose::URL_SAFE_NO_PAD;
            let mut blob = vec![0u8; DPAPI_SIZED_OVERHEAD];
            blob.extend(Self::frame(purpose));
            blob.extend_from_slice(&(plaintext.len() as u32).to_be_bytes());
            blob.extend(plaintext.iter().map(|b| b ^ 0x5a));
            blob.resize(blob.len().div_ceil(16) * 16, 0);
            let envelope = serde_json::json!({"v": 1, "backend": "dpapi-current-user", "ciphertext": URL_SAFE_NO_PAD.encode(&blob)});
            Ok(serde_json::to_vec(&envelope).unwrap())
        }

        fn open(&self, purpose: &str, sealed: &[u8]) -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
            use base64::engine::general_purpose::URL_SAFE_NO_PAD;
            let envelope: serde_json::Value = serde_json::from_slice(sealed).map_err(|e| e.to_string())?;
            let blob = URL_SAFE_NO_PAD.decode(envelope["ciphertext"].as_str().ok_or("no ciphertext")?).map_err(|e| e.to_string())?;
            let body = blob.get(DPAPI_SIZED_OVERHEAD..).ok_or("short")?.strip_prefix(Self::frame(purpose).as_slice()).ok_or("purpose")?;
            let (len, rest) = body.split_first_chunk::<4>().ok_or("short")?;
            let payload = rest.get(..u32::from_be_bytes(*len) as usize).ok_or("short")?;
            Ok(zeroize::Zeroizing::new(payload.iter().map(|b| b ^ 0x5a).collect()))
        }
    }

    #[test]
    fn with_dpapi_sized_lines_a_flood_still_cannot_push_older_rows_out() {
        let sealer = DpapiSizedSealer;
        let mut log = AuditLog::new(&sealer, MemoryFile::default());
        // The worst row fits a line, with room: every field at its cap, all
        // characters JSON-escaped.
        assert!(log.encode(&AuditRow {
            at_ms: u64::MAX,
            client: "\u{1}".repeat(MAX_CLIENT),
            tool: "\u{1}".repeat(MAX_TOOL),
            arguments: "\u{1}".repeat(MAX_ARGUMENTS),
            outcome: Outcome::NotAuthorised,
        }).is_some_and(|line| line.len() <= MAX_LINE_BYTES));
        for i in 0..50u64 {
            log.append(call(i, "owner-tool", Outcome::Read));
        }
        let typical = lines(&log.io)[0].len();
        assert!(typical > 4 * 200, "a DPAPI-sized line ({typical} bytes) is far larger than a test line");
        // Ten minutes of 100,000 refused and rate-limited calls at the field caps.
        let mut flood = 0;
        for t in (1_000..601_000u64).step_by(6) {
            let outcome = if t % 12 == 0 { Outcome::Refused } else { Outcome::RateLimited };
            log.append(AuditRow { at_ms: t, client: "flooder".into(), tool: "x".repeat(64), arguments: "y".repeat(256), outcome });
            flood += 1;
        }
        log.flush(601_000);
        assert!(log.rows.is_some_and(|r| r < MAX_ROWS), "no cut was needed");
        let rows = log.last(usize::MAX).unwrap().rows;
        assert_eq!(rows.iter().filter(|r| r.client == "owner-tool").count(), 50, "every earlier read is still there");
        let written = rows.iter().filter(|r| r.client == "flooder" && r.tool != SUMMARY_TOOL).count();
        let held: usize = rows
            .iter()
            .filter(|r| r.tool == SUMMARY_TOOL)
            .map(|r| r.arguments.split(' ').next().unwrap().parse::<usize>().unwrap())
            .sum();
        assert_eq!(written + held, flood);
        // And the kept history holds a full UI page however long the lines are.
        const { assert!(KEEP_ROWS >= SHOW_ROWS && TRIM_TO_BYTES >= KEEP_ROWS * (MAX_LINE_BYTES + 1)) };
    }

    #[test]
    fn clients_past_the_tracked_limit_share_one_allowance() {
        let sealer = MemorySealer;
        let mut log = AuditLog::new(&sealer, MemoryFile::default());
        for c in 0..MAX_TRACKED_CLIENTS + 40 {
            log.append(call(1_000, &format!("c{c}"), Outcome::Refused));
        }
        // The first 32 clients each got a row; the 40 others share 30.
        assert_eq!(lines(&log.io).len(), MAX_TRACKED_CLIENTS + REFUSED_ROWS_PER_CLIENT_PER_MINUTE);
        assert_eq!(log.held_rows(), 10);
        log.flush(2_000);
        let summary = log.last(1).unwrap().rows.pop().unwrap();
        assert_eq!(summary.client, "");
        assert_eq!(summary.arguments, "10 refused or rate-limited calls from other clients not logged");
        // Idle allowances are forgotten once their minute has passed.
        log.flush_due(100_000);
        assert!(log.allowances.is_empty());
    }

    #[test]
    fn a_cut_from_a_line_boundary_keeps_the_first_whole_line() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"old\nkeep1\nkeep2\n");
        // A tail read one byte longer than the kept part starts at the `\n`.
        let tail = TailBytes { bytes: bytes[3..].to_vec(), from_start: false };
        assert_eq!(whole_lines(&tail), b"keep1\nkeep2\n");
        let partial = TailBytes { bytes: bytes[5..].to_vec(), from_start: false };
        assert_eq!(whole_lines(&partial), b"keep2\n");
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
        assert!(n <= 10 * (NOT_AUTHORISED_ROWS_PER_MINUTE + 1) + 1, "{n} rows written");
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
    fn the_file_is_cut_back_by_rows_to_whole_newest_lines() {
        let sealer = MemorySealer;
        let mut log = AuditLog::new(&sealer, MemoryFile::default());
        let total = MAX_ROWS as u64 + 50;
        for i in 0..total {
            log.append(row(i, "balance", Outcome::Read));
        }
        // The cut ran once, at MAX_ROWS + 1 rows, keeping KEEP_ROWS; 49 more followed.
        assert_eq!(lines(&log.io).len(), KEEP_ROWS + 49);
        assert_eq!(log.rows, Some(KEEP_ROWS + 49));
        let all = log.last(usize::MAX).unwrap();
        assert_eq!(all.skipped, 0, "a cut leaves no partial line");
        assert_eq!(all.rows.last().unwrap().at_ms, total - 1);
        assert!(all.rows.windows(2).all(|w| w[1].at_ms == w[0].at_ms + 1));
        assert_eq!(log.write_failures(), 0);
    }

    #[test]
    fn rows_already_in_the_file_are_counted_and_cut_on_the_first_append() {
        let sealer = MemorySealer;
        let mut first = AuditLog::new(&sealer, MemoryFile::default());
        for i in 0..MAX_ROWS as u64 {
            first.append(row(i, "balance", Outcome::Read));
        }
        // A new log over the same file (a restart) counts what is there.
        let mut log = AuditLog::new(&sealer, std::mem::take(&mut first.io));
        log.append(row(MAX_ROWS as u64, "balance", Outcome::Read));
        assert_eq!(lines(&log.io).len(), KEEP_ROWS);
        assert_eq!(log.last(1).unwrap().rows[0].at_ms, MAX_ROWS as u64);
    }

    #[test]
    fn the_byte_ceiling_cuts_a_file_grown_outside_the_log() {
        let sealer = MemorySealer;
        let mut io = MemoryFile { exists: true, ..MemoryFile::default() };
        // Few lines, but each at the longest length: junk the log never wrote.
        let junk = vec![b'A'; MAX_LINE_BYTES];
        while io.bytes.len() <= MAX_FILE_BYTES {
            io.bytes.extend_from_slice(&junk);
            io.bytes.push(b'\n');
        }
        let mut log = AuditLog::new(&sealer, io);
        log.append(row(7, "balance", Outcome::Read));
        assert!(log.io.bytes.len() <= TRIM_TO_BYTES);
        assert_eq!(log.last(1).unwrap().rows[0].at_ms, 7);
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
        fn a_fifo_at_the_path_is_refused_without_hanging() {
            let dir = tempfile::tempdir().unwrap();
            let file = PrivateFile::open(dir.path()).unwrap();
            let path = dir.path().join(FILE_NAME);
            let made = std::process::Command::new("mkfifo").arg("-m").arg("600").arg(&path).status().unwrap();
            assert!(made.success());
            let sealer = MemorySealer;
            let mut log = AuditLog::new(&sealer, file);
            assert!(log.last(SHOW_ROWS).is_err());
            log.append(row(1, "balance", Outcome::Read));
            assert_eq!(log.write_failures(), 1);
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
            let dir = root.join("data");
            let sealer = MemorySealer;
            let mut log = AuditLog::new(&sealer, PrivateFile::open(&dir).unwrap());
            for i in 0..3 {
                log.append(row(i, "balance", Outcome::Read));
            }
            assert_eq!(log.write_failures(), 0);
            assert_eq!(log.last(SHOW_ROWS).unwrap().rows.iter().map(|r| r.at_ms).collect::<Vec<_>>(), vec![0, 1, 2]);
            crate::private_fs::verify_file(&dir.join(FILE_NAME)).unwrap();

            // A scratch file left by a crash (old fixed name, or a random one)
            // does not block the next append.
            for name in [format!("{FILE_NAME}.tmp"), format!("{FILE_NAME}.0011223344556677.tmp")] {
                let left = crate::private_fs::create_new(&dir.join(name)).unwrap();
                drop(left);
            }
            log.append(row(3, "balance", Outcome::Read));
            assert_eq!(log.write_failures(), 0);
            assert_eq!(log.last(SHOW_ROWS).unwrap().rows.len(), 4);

            // A file left larger than the cap (a failed cut) is cut back on
            // the next append, never refused for good.
            let line = log.encode(&row(9, "balance", Outcome::Read)).unwrap();
            let mut big = Vec::new();
            while big.len() < MAX_FILE_BYTES + 3 * MAX_LINE_BYTES {
                big.extend_from_slice(&line);
                big.push(b'\n');
            }
            log.io.replace_all(&big).unwrap();
            // A new log over the file (a restart) counts its rows and cuts.
            let mut log = AuditLog::new(&sealer, PrivateFile::open(&dir).unwrap());
            log.append(row(10, "balance", Outcome::Read));
            assert_eq!(log.write_failures(), 0);
            let size = std::fs::metadata(dir.join(FILE_NAME)).unwrap().len() as usize;
            assert!(size <= MAX_FILE_BYTES, "{size} bytes");
            let tail = log.last(SHOW_ROWS).unwrap();
            assert_eq!(tail.skipped, 0);
            assert_eq!(tail.rows.last().unwrap().at_ms, 10);
            assert_eq!(log.last(usize::MAX).unwrap().rows.len(), KEEP_ROWS);
            let _ = std::fs::remove_dir_all(&root);
        }
    }
}
