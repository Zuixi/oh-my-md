use super::{LOG_TAIL_READ_BYTES, SESSION_END_MARKER, SESSION_EXIT_MARKER, SESSION_START_MARKER};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

/// What the previous run did. See spec §3.4.5.
///
/// Serialized for the diagnostics manifest's `previous_exit.state`: the variant
/// names are the stable machine-readable answer, and `previous_exit_reason`
/// carries the sentence a human reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviousExit {
    /// The last session reached `session end clean=true`.
    Clean,
    /// The last session recorded an exit intent but never reached the end —
    /// typically a logout/shutdown force-kill.
    Interrupted,
    /// The last session started and never recorded any exit.
    Abnormal,
    /// No `session start` survived in either window. Never accuse.
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkerKind {
    Start,
    Exit,
    End,
}

/// The facts a `session start` line carries beyond being a marker.
///
/// Spec §3.8's `previous_exit` names the pid and version of the run being
/// reported on, and the line the scanner already classifies is exactly
/// `session start pid={pid} version={version} mode={mode}`
/// ([`session_start_line`]). Retaining them here keeps one traversal of the log
/// rather than a second pass that could disagree with [`classify`] about which
/// start is the last one.
///
/// Both are `Option`: the writers always emit them, but a truncated or
/// hand-edited record may not, and a missing fact must stay missing rather than
/// become a fabricated value in a support artifact.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionStartFacts {
    pub pid: Option<u32>,
    pub version: Option<String>,
    pub generation: u64,
}

impl SessionStartFacts {
    /// The pid and version of one `session start` line.
    ///
    /// Whole whitespace-delimited tokens only, so `app_version=` on the startup
    /// header line can never be read as this line's `version=`.
    fn parse(line: &str) -> Self {
        let mut facts = SessionStartFacts {
            pid: None,
            version: None,
            generation: 0,
        };
        for token in line.split_whitespace() {
            if let Some(value) = token.strip_prefix("pid=") {
                facts.pid = value.parse().ok();
            } else if let Some(value) = token.strip_prefix("version=") {
                facts.version = Some(value.to_string());
            } else if let Some(value) = token.strip_prefix("generation=") {
                facts.generation = value.parse().unwrap_or(0);
            }
        }
        facts
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Marker {
    pub kind: MarkerKind,
    pub clean: bool,
    /// Present exactly when `kind` is `Start`.
    pub start: Option<SessionStartFacts>,
}

/// Read at most `limit` bytes from the end of `path`, lossily decoded.
///
/// Seeking to `End(-limit)` can land inside a multi-byte UTF-8 sequence —
/// log lines contain CJK file paths, so this is not hypothetical. Decoding is
/// therefore lossy *and* the first line is dropped **when it is partial**: the
/// window is kept whole when the read started at offset 0, and also when the
/// byte just before the window is a newline, because then the window opens
/// exactly on a line boundary and its first line is complete. Dropping that
/// line unconditionally discarded the archive's `session start` (→ `Unknown`)
/// and, for a session split across the rotation boundary, its
/// `session end clean=true` (→ `Abnormal`) — the very outcome the design says
/// must never be reported on missing evidence. See spec §3.4.5.
pub fn read_tail(path: &Path, limit: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};

    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(limit);
    // Include the byte before the window, when there is one: whether it is a
    // newline is what distinguishes a complete first line from a partial one.
    let read_from = if start == 0 { 0 } else { start - 1 };
    if file.seek(SeekFrom::Start(read_from)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let (first_line_is_complete, window): (bool, &[u8]) = if start == 0 {
        (true, &bytes)
    } else {
        match bytes.split_first() {
            Some((&b'\n', rest)) => (true, rest),
            Some((_, rest)) => (false, rest),
            // The file shrank between `metadata` and the read; there is no
            // window to salvage either way.
            None => (true, &[]),
        }
    };
    let text = String::from_utf8_lossy(window).into_owned();
    if first_line_is_complete {
        return text;
    }
    match text.find('\n') {
        Some(index) => text[index + 1..].to_string(),
        None => String::new(),
    }
}

/// The newest archive for `stem`. Archive names are zero-padded timestamps
/// (`rename_file_to_dated`), so lexicographic order is chronological.
pub fn newest_archive(dir: &Path, stem: &str) -> Option<PathBuf> {
    let prefix = format!("{stem}_");
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".log"))
        })
        .collect();
    candidates.sort();
    candidates.pop()
}

/// Whether `marker`, found at `index` in `line`, is anchored on its right: the
/// character after it is a space or there is none.
///
/// Deliberately *not* left-anchored — see [`SESSION_START_MARKER`]. This is the
/// single definition of "anchored", shared by [`has_marker`] (which classifies
/// lines) and by the record-text escaper below (which must remove exactly what
/// `has_marker` accepts). Two copies of this predicate could drift apart and
/// silently reopen the forgery it exists to close.
pub(super) fn marker_anchored_at(line: &str, index: usize, marker: &str) -> bool {
    line[index + marker.len()..]
        .chars()
        .next()
        .is_none_or(|ch| ch == ' ')
}

/// Whether `line` contains `marker` anchored on its right (see
/// [`marker_anchored_at`]).
///
/// The right boundary is load-bearing, not defensive. Task 4 logs the
/// human-readable determination lines *after* `session start`: "previous session
/// exited cleanly" and "previous session ended abnormally" contain
/// `SESSION_EXIT_MARKER` / `SESSION_END_MARKER` as bare prefixes. A
/// `line.contains(marker)` match turns those into an invented exit intent, so a
/// run that died with no exit intent at all (SIGKILL, segfault, force-kill)
/// gets reported as `Interrupted` — a system shutdown — and the `Abnormal`
/// warning this feature exists to raise never fires. Do not simplify this back
/// to `contains`. See spec §3.4.5.
pub(super) fn has_marker(line: &str, marker: &str) -> bool {
    line.match_indices(marker)
        .any(|(index, _)| marker_anchored_at(line, index, marker))
}

pub(super) fn parse_markers(text: &str) -> Vec<Marker> {
    let mut markers = Vec::new();
    for line in text.lines() {
        if has_marker(line, SESSION_START_MARKER) {
            markers.push(Marker {
                kind: MarkerKind::Start,
                clean: false,
                // The line that was just classified is also the only source of
                // the facts the diagnostics manifest reports; read them in the
                // same traversal so the two can never name different sessions.
                start: Some(SessionStartFacts::parse(line)),
            });
        } else if has_marker(line, SESSION_END_MARKER) {
            markers.push(Marker {
                kind: MarkerKind::End,
                clean: line.contains("clean=true"),
                start: None,
            });
        } else if has_marker(line, SESSION_EXIT_MARKER) {
            markers.push(Marker {
                kind: MarkerKind::Exit,
                clean: false,
                start: None,
            });
        }
    }
    markers
}

/// The index of the start marker the determination keys off: the last one.
///
/// One definition, because `PreviousSession::from_markers` answers for the
/// same start line; two `rposition` calls could drift and report one session's
/// outcome beside another session's pid.
fn last_start(markers: &[Marker]) -> Option<usize> {
    markers
        .iter()
        .rposition(|marker| marker.kind == MarkerKind::Start)
}

/// Apply the spec §3.4.5 table to a merged, chronological marker list.
///
/// A clean end wins over an earlier exit intent: a user-initiated quit writes
/// *both* lines (the intent at `ExitRequested`, the end at `RunEvent::Exit`),
/// so stopping at the first marker after the start would call every clean quit
/// "interrupted" — the table's row is an intent *with no* `session end`.
pub fn classify(markers: &[Marker]) -> PreviousExit {
    let Some(start) = last_start(markers) else {
        return PreviousExit::Unknown;
    };
    let after = &markers[start + 1..];
    if after.iter().any(|m| m.kind == MarkerKind::End && m.clean) {
        PreviousExit::Clean
    } else if after.iter().any(|m| m.kind == MarkerKind::Exit) {
        PreviousExit::Interrupted
    } else {
        PreviousExit::Abnormal
    }
}

/// The previous run's determination plus the facts its `session start` line
/// carried (spec §3.8's `previous_exit`).
///
/// Both travel together because they answer about one session: the outcome
/// [`classify`] derived from the last `session start` and the pid/version that
/// very line named.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviousSession {
    pub outcome: PreviousExit,
    /// The pid of the start line `classify` keyed off, when the line had one.
    pub pid: Option<u32>,
    /// That same line's version.
    pub version: Option<String>,
}

impl PreviousSession {
    pub(super) fn from_markers(markers: &[Marker]) -> Self {
        let facts = last_start(markers).and_then(|index| markers[index].start.as_ref());
        PreviousSession {
            outcome: classify(markers),
            pid: facts.and_then(|facts| facts.pid),
            version: facts.and_then(|facts| facts.version.clone()),
        }
    }

    /// No start survived in range, so there is nothing to report: never accuse,
    /// and never name a pid we did not read.
    fn unknown() -> Self {
        PreviousSession {
            outcome: PreviousExit::Unknown,
            pid: None,
            version: None,
        }
    }
}

/// Reconstruct the previous run's outcome from the archive and active tails.
///
/// The archive's markers are older than the active log's, so they are
/// concatenated in that order and the rule is applied to the merged sequence:
/// a session that outgrows `LOG_MAX_FILE_BYTES` keeps its start in the archive
/// and its end in the active log. Only `LOG_TAIL_READ_BYTES` of each is read.
pub fn scan_previous_session(dir: &Path, stem: &str, generation: u64) -> PreviousSession {
    // An empty stem means this run has no writer (logging is off or disabled);
    // never read a neighbouring install's file to answer for it.
    let Some(files) = session_scan_files(dir, stem) else {
        return PreviousSession::unknown();
    };
    let mut markers = Vec::new();
    for file in files {
        markers.extend(parse_markers(&read_tail(&file, LOG_TAIL_READ_BYTES)));
    }
    if last_start(&markers)
        .and_then(|index| markers[index].start.as_ref())
        .is_some_and(|start| start.generation != generation)
    {
        return PreviousSession::unknown();
    }
    PreviousSession::from_markers(&markers)
}

/// The fallback writer uses a PID in its stem. Find the latest earlier writer
/// in the same temporary directory; the current PID's empty file is excluded.
pub fn scan_previous_fallback_session(
    dir: &Path,
    current_stem: &str,
    generation: u64,
) -> PreviousSession {
    let prefix = "oh-my-md-";
    let previous = std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            let stem = name.strip_suffix(".log")?;
            let pid = stem.strip_prefix(prefix)?;
            if stem == current_stem
                || pid.is_empty()
                || !pid.bytes().all(|byte| byte.is_ascii_digit())
            {
                return None;
            }
            Some((stem.to_string(), entry.metadata().ok()?.modified().ok()?))
        })
        .max_by_key(|(_, modified)| *modified);
    previous.map_or_else(PreviousSession::unknown, |(stem, _)| {
        scan_previous_session(dir, &stem, generation)
    })
}

/// The files a scan would read, newest archive first.
///
/// `None` when there is no directory to scan. That case is not hypothetical:
/// in the `Disabled` logging state `LogState.dir` is empty *because* nothing was
/// written anywhere, and `Path::new("").join("oh-my-md.log")` is a *relative*
/// path — the scan would read `./oh-my-md.log` from the process's working
/// directory and report a determination sourced from a file this run never
/// wrote. Never accuse on evidence we did not produce.
pub(super) fn session_scan_files(dir: &Path, stem: &str) -> Option<Vec<PathBuf>> {
    if dir.as_os_str().is_empty() || stem.is_empty() {
        return None;
    }
    let mut files = Vec::new();
    if let Some(archive) = newest_archive(dir, stem) {
        files.push(archive);
    }
    files.push(dir.join(format!("{stem}.log")));
    Some(files)
}

/// Whether the app is on its way out. Consulted by the webview-termination
/// hook (spec §3.4.4) so a normal teardown is not reported as a crash.
#[derive(Default)]
pub struct ExitingState(pub AtomicBool);

impl ExitingState {
    pub fn mark(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_exiting(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

pub fn webview_termination_level(exiting: bool) -> log::Level {
    if exiting {
        log::Level::Info
    } else {
        log::Level::Error
    }
}

/// Carries the startup determination to the diagnostics bundle (Task 12).
#[allow(dead_code)] // Read by the diagnostics bundle, which Task 12 adds.
pub struct PreviousExitState(pub PreviousSession);

/// The level a determination is logged at, per the spec §3.4.5 table. `None`
/// means the common case (a clean exit) and is logged at `debug`.
pub fn level_for_exit(outcome: PreviousExit) -> Option<log::Level> {
    match outcome {
        PreviousExit::Clean => None,
        PreviousExit::Interrupted => Some(log::Level::Info),
        PreviousExit::Abnormal => Some(log::Level::Warn),
        PreviousExit::Unknown => Some(log::Level::Info),
    }
}

pub fn session_start_line(pid: u32, version: &str, generation: u64) -> String {
    let mode = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    format!(
        "{SESSION_START_MARKER} pid={pid} version={version} mode={mode} generation={generation}"
    )
}

pub fn write_session_start(pid: u32, version: &str, generation: u64) {
    // `LevelFilter::Off` makes this a cheap no-op; logging is opt-in.
    log::info!("{}", session_start_line(pid, version, generation));
}

/// Written the moment an exit is requested — before any flushing — so a
/// force-killed shutdown is still distinguishable from a crash.
pub fn note_exit_intent(app: &tauri::AppHandle, reason: &str) {
    app.state::<ExitingState>().mark();
    log::info!("{SESSION_EXIT_MARKER} intent={reason}");
}

/// Written from `RunEvent::Exit`, the terminal event. `app.exit(0)` skips
/// `ExitRequested` (`lib.rs:186`), so this cannot live there.
pub fn note_clean_exit() {
    log::info!("{SESSION_END_MARKER} clean=true");
}

/// The sentence that describes a determination, in the one wording both the log
/// and the diagnostics manifest use.
///
/// The wording is load-bearing, not cosmetic. Every sentence here is written
/// *after* this run's `session start`, so the next launch's scanner reads it
/// back; each one is deliberately phrased so that it cannot be re-parsed as a
/// marker ("session exited", "session ended" — never "session exit " /
/// "session end "). Rewording one to end a marker on a space would invent an
/// exit intent and suppress the abnormal-exit warning. See `has_marker`.
pub fn previous_exit_reason(outcome: PreviousExit) -> &'static str {
    match outcome {
        PreviousExit::Clean => "previous session exited cleanly",
        PreviousExit::Interrupted => "previous session quit was interrupted",
        PreviousExit::Abnormal => "previous session ended abnormally",
        PreviousExit::Unknown => "previous session outcome unknown (no markers in range)",
    }
}

/// The reason a determination cannot be made because logging was off.
///
/// `PreviousExit::Unknown` also covers "the markers rotated away", and this is
/// not that: with logging off nothing was ever written, so a reader must not
/// conclude the evidence was lost. The bundle carries this sentence instead of
/// `previous_exit_reason(Unknown)` whenever the destination is `Off`.
pub const PREVIOUS_EXIT_UNKNOWN_LOGGING_OFF: &str =
    "not determined: logging was off, so no session markers were written";

/// Reports what the previous run did, at the level `level_for_exit` picks.
pub fn log_previous_exit(outcome: PreviousExit) {
    let text = previous_exit_reason(outcome);
    match level_for_exit(outcome) {
        None => log::debug!("{text}"),
        Some(log::Level::Warn) => log::warn!("{text}"),
        Some(_) => log::info!("{text}"),
    }
}
