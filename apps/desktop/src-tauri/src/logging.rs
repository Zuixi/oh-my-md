//! Application logging: level policy, log-directory probing, and the
//! session-boundary record used to reconstruct the previous run's outcome.
//!
//! Spec: docs/superpowers/specs/2026-10-03-logging-and-diagnostics-design.md

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use tauri::Manager;

/// Rotate at 2 MiB and keep five archives. `tauri-plugin-log`'s own default is
/// 40 KB with `RotationStrategy::KeepOne`, which *deletes* the previous file
/// instead of archiving it — see spec §2.5.
pub const LOG_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Archived generations kept alongside the active file.
pub const LOG_KEEP_FILES: usize = 5;

/// How much of a log tail the session scanner reads. Bounded so the cost does
/// not grow if retention is reconfigured. See spec §3.4.5.
pub const LOG_TAIL_READ_BYTES: u64 = 64 * 1024;

/// Runtime level override, e.g. `OMD_LOG=debug` or `OMD_LOG=tao=warn,omd=debug`.
pub const LOG_LEVEL_ENV_VAR: &str = "OMD_LOG";

/// The persisted Settings key that turns on verbose logging. Owned by the
/// TypeScript settings shape (`UserSettings.verboseLogging` in `settings.ts`);
/// Rust only reads it. A bare literal on either side would let a rename silently
/// stop the toggle from working, so both sides name it and the cross-layer
/// constants guard tests the pair.
pub const VERBOSE_LOGGING_SETTINGS_KEY: &str = "verboseLogging";

/// Probe file created inside the target directory and removed immediately.
pub const PROBE_FILE_PREFIX: &str = ".write_test_";

/// Session-boundary lines, written by the exit lifecycle.
///
/// [`has_marker`] matches them anchored on their **right** boundary only: the
/// marker must be followed by a space or by the end of the line. There is
/// deliberately no left anchor. The scanner reads whole physical lines, whose
/// envelope (timestamp, target, level) precedes the message and is not this
/// module's to fix, so a left boundary would make the determination depend on
/// formatting we do not own. That means a left-adjacent occurrence matches too
/// (`xsession exit intent=user`), and it is why every producer that can carry
/// foreign text — the frontend sink and the structured path fields — runs it
/// through [`neutralize_boundary_markers`], which removes the token at *every*
/// position rather than trusting a left boundary. See spec §3.4.5.
pub const SESSION_START_MARKER: &str = "session start";
pub const SESSION_EXIT_MARKER: &str = "session exit";
pub const SESSION_END_MARKER: &str = "session end";

/// Compiled-in default. Release ships `Info`; debug ships `Debug`.
pub fn default_level() -> log::LevelFilter {
    if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    }
}

/// The level the process actually runs at: `OMD_LOG` when it names a valid
/// level, the persisted verbose flag next, otherwise the build default.
///
/// Anything else (a filter list, a typo) falls through rather than erroring — a
/// bad env var must not change behaviour, and it must not shadow the flag
/// either: `OMD_LOG=banana` means "I wanted a level", not "turn verbose off".
pub fn effective_level() -> log::LevelFilter {
    if let Some(level) = std::env::var(LOG_LEVEL_ENV_VAR)
        .ok()
        .and_then(|raw| raw.trim().parse::<log::LevelFilter>().ok())
    {
        return level;
    }
    if verbose_logging_enabled() {
        return log::LevelFilter::Debug;
    }
    default_level()
}

/// Whether the persisted Settings blob turned on verbose logging.
///
/// The settings shape lives in TypeScript and Rust has no typed settings
/// struct, so this reads the raw JSON `get_settings()` returns and looks for the
/// one key. Read-only and total: an unreadable file, non-JSON contents, a
/// missing key, or a value that is not the boolean `true` all answer `false`.
/// Logging must never fail to configure because a preference file is odd.
pub fn verbose_logging_enabled() -> bool {
    let Ok(raw) = crate::workspace::get_settings() else {
        return false;
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    parsed
        .get(VERBOSE_LOGGING_SETTINGS_KEY)
        .and_then(|v| v.as_bool())
        == Some(true)
}

/// Where logging falls back to when the real log directory is unusable.
/// Never the real directory's sibling: the failures this defends against
/// (read-only directory, full or unmounted volume) are exactly the ones that
/// make the real directory unwritable. See spec §3.9.
pub fn fallback_dir() -> PathBuf {
    std::env::temp_dir()
}

/// PID-suffixed so a leftover fallback file from a crashed run cannot block
/// the next one.
pub fn fallback_file_stem() -> String {
    format!("oh-my-md-{}", std::process::id())
}

/// Answers "can this process actually write here?" by writing.
///
/// `metadata().permissions().readonly()` answers a different question: on
/// Windows the read-only attribute is not the NTFS ACL, and on Unix the mode
/// bits say nothing about the effective uid, group, ACL, or a read-only
/// mount. The probe is subject to TOCTOU against the plugin's own open; it
/// reduces the risk rather than eliminating it.
pub fn probe_writable(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(format!("{PROBE_FILE_PREFIX}{}", std::process::id()));
    let wrote = std::fs::File::create(&probe)
        .and_then(|mut file| std::io::Write::write_all(&mut file, b"omd"))
        .is_ok();
    // Best effort: a failure to remove must not change the verdict.
    let _ = std::fs::remove_file(&probe);
    wrote
}

/// Which of the three mutually exclusive places this run's records go.
///
/// The distinction is load-bearing for the Settings copy. A boolean cannot
/// express it: the fallback case writes to a real file in the temp directory,
/// while the both-failed case writes nowhere at all — and the `Stdout` target
/// lives inside the same plugin dispatch as the file target, so when the plugin
/// never attaches, nothing reaches stdout either. Telling that user "your logs
/// are at <temp dir>" points at a file that is never created.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum LogDestination {
    /// The configured log directory, which answered the write probe and
    /// accepted the plugin.
    Directory,
    /// The real directory was unusable; the temp-dir fallback carries the file.
    Fallback,
    /// Both registrations failed. No logger is attached: no file, no stdout.
    Disabled,
}

impl LogDestination {
    /// The stable `kind` string: the tag `serde` puts on the wire, and the value
    /// `environment.txt` prints. One spelling for both, so a support reader and
    /// the Settings surface cannot disagree about the same state.
    pub fn kind(self) -> &'static str {
        match self {
            LogDestination::Directory => "directory",
            LogDestination::Fallback => "fallback",
            LogDestination::Disabled => "disabled",
        }
    }
}

/// What the rest of the app needs to know about where logs went.
pub struct LogState {
    /// True whenever `destination` is not [`LogDestination::Directory`].
    /// Surfaced in Settings and in the diagnostics bundle's `environment.txt`.
    pub degraded: bool,
    /// Resolved directory. The session scanner must read *this*, not a
    /// recomputed path — see spec §3.12. Empty when `destination` is
    /// [`LogDestination::Disabled`]: no directory holds this run's logs.
    pub dir: PathBuf,
    /// Resolved file stem, passed explicitly to the plugin so the writer and
    /// the scanner cannot disagree. Empty when `destination` is
    /// [`LogDestination::Disabled`].
    pub file_stem: String,
    /// The three-state destination, projected to the frontend as `{ kind }`.
    pub destination: LogDestination,
    /// The level this process actually runs at, resolved **once** by
    /// [`install`] and carried from there.
    ///
    /// [`effective_level`] re-reads the persisted `verboseLogging` flag, and the
    /// Settings toggle writes that file immediately. Anything that asked again
    /// later — the startup header, the diagnostics manifest, `environment.txt`
    /// — would name a level this run never ran at (§3.2: "a reader never has to
    /// guess what was filtered"). Carrying the resolved value is what makes
    /// that promise true.
    pub level: log::LevelFilter,
}

/// The stem `tauri-plugin-log` would derive on its own
/// (`app.package_info().name`, `tauri-plugin-log` `lib.rs:719`). We pass it
/// explicitly instead of relying on the default.
pub fn log_file_stem(app: &tauri::AppHandle) -> String {
    app.package_info().name.clone()
}

fn plugin(
    stem: &str,
    dir: &Path,
    level: log::LevelFilter,
) -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_log::Builder::new()
        .level(level)
        // Framework noise. `level_for` matches whole module-path prefixes, so
        // `wry` does not cover `tauri_runtime_wry`.
        .level_for("tao", log::LevelFilter::Warn)
        .level_for("wry", log::LevelFilter::Warn)
        .level_for("notify", log::LevelFilter::Warn)
        .level_for("ignore", log::LevelFilter::Warn)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("reqwest", log::LevelFilter::Warn)
        // Webview-crash signal; must survive into the shipped log.
        .level_for("tauri_runtime_wry", log::LevelFilter::Info)
        .level_for("tauri_runtime", log::LevelFilter::Info)
        .max_file_size(LOG_MAX_FILE_BYTES.into())
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(LOG_KEEP_FILES))
        .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
        .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                path: dir.to_path_buf(),
                file_name: Some(stem.to_string()),
            }),
        ])
        .build()
}

/// The decision half of [`install`], split out so the three-way result can be
/// tested without an `AppHandle` (which cannot be built outside a running app).
///
/// `level` is the value [`install`] already resolved; it travels into every
/// state this returns, because the diagnostics bundle reads it back rather than
/// calling [`effective_level`] again.
///
/// `register` is the seam: production passes a closure that runs
/// `AppHandle::plugin`, tests pass one that succeeds or fails on command.
fn prepare_file_logging(
    stem: &str,
    real_dir: &Path,
    level: log::LevelFilter,
    mut register: impl FnMut(&str, &Path) -> Result<(), String>,
) -> LogState {
    if probe_writable(real_dir) {
        match register(stem, real_dir) {
            Ok(()) => {
                return LogState {
                    degraded: false,
                    dir: real_dir.to_path_buf(),
                    file_stem: stem.to_string(),
                    destination: LogDestination::Directory,
                    level,
                }
            }
            Err(e) => eprintln!("omd: log plugin failed in {real_dir:?}: {e}"),
        }
    } else {
        eprintln!("omd: log directory {real_dir:?} is not writable; falling back");
    }
    install_into_fallback(level, register)
}

/// Registers the temp-dir fallback, or reports that no logger could be attached.
///
/// Both the directory *and* the stem must name the fallback: registering the
/// fallback directory under the real stem would make the session scanner and the
/// writer disagree about the file they are talking about.
fn install_into_fallback(
    level: log::LevelFilter,
    mut register: impl FnMut(&str, &Path) -> Result<(), String>,
) -> LogState {
    let fallback = fallback_dir();
    let fallback_stem = fallback_file_stem();
    match register(&fallback_stem, &fallback) {
        Ok(()) => LogState {
            degraded: true,
            dir: fallback,
            file_stem: fallback_stem,
            destination: LogDestination::Fallback,
            level,
        },
        Err(e) => {
            // No logger is attached at all. The app still starts; Settings
            // reports `disabled` and names no directory, because none holds this
            // run's records — and the plugin also owns the `Stdout` target, so
            // there is no console stream to fall back to either.
            eprintln!("omd: fallback logging failed in {fallback:?}: {e}");
            LogState {
                degraded: true,
                dir: PathBuf::new(),
                file_stem: String::new(),
                destination: LogDestination::Disabled,
                level,
            }
        }
    }
}

/// Register the log plugin, probing first and degrading instead of failing.
///
/// This runs from `.setup()`, not the builder chain, because the probe needs
/// `app_log_dir()`, which needs an `AppHandle`. `AppHandle::plugin()` runs a
/// plugin's setup immediately and returns a `Result` we can catch
/// (`tauri-2.11.5` `app.rs:527-542`) — which is what turns a lost probe race
/// from a startup panic into a caught error.
///
/// Never panics. Never returns an error for a logging reason: Tauri turns a
/// setup error into `panic!("Failed to setup app: {e}")`.
pub fn install(app: &tauri::AppHandle) -> LogState {
    let stem = log_file_stem(app);
    // Resolve the level exactly once, here, and let `LogState` carry it. The
    // plugin is configured with this value and so are the startup header and
    // the diagnostics bundle; a second `effective_level()` anywhere downstream
    // would re-read the persisted verbose flag and could name a level this run
    // never ran at (§3.2).
    let level = effective_level();
    let register = |stem: &str, dir: &Path| {
        app.plugin(plugin(stem, dir, level))
            .map_err(|e| e.to_string())
    };

    // An unresolvable log directory is the same class of failure as an
    // unwritable one: the real destination is unusable. Treating it as
    // "usable, just at the fallback path" would register the fallback
    // directory under the *real* stem and report `degraded: false`, naming a
    // directory the real configuration never chose — §3.9 defines degraded
    // logging as `temp_dir()/<app>-{pid}.log`. A directory that cannot be
    // created, or that disappears between the create and the probe, reaches the
    // same place through `probe_writable` returning false.
    let Ok(real_dir) = app.path().app_log_dir() else {
        eprintln!("omd: could not resolve a log directory; falling back");
        return install_into_fallback(level, register);
    };
    if let Err(e) = std::fs::create_dir_all(&real_dir) {
        eprintln!("omd: could not create log directory {real_dir:?}: {e}");
    }

    prepare_file_logging(&stem, &real_dir, level, register)
}

/// Reveals the resolved log directory in the OS file manager.
///
/// Reports the both-failed state as an error instead of opening a path that does
/// not exist: `LogState.dir` is empty there, and "Open Log Folder" has nothing
/// honest to open.
#[tauri::command]
pub fn open_log_dir(state: tauri::State<'_, LogState>) -> Result<(), String> {
    if state.destination == LogDestination::Disabled {
        return Err("file logging is disabled; there is no log folder to open".to_string());
    }
    tauri_plugin_opener::open_path(state.dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Reports where logging went, for the Settings surface.
#[tauri::command]
pub fn log_state(state: tauri::State<'_, LogState>) -> LogStateView {
    LogStateView {
        degraded: state.degraded,
        dir: state.dir.to_string_lossy().into_owned(),
        destination: state.destination,
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStateView {
    pub degraded: bool,
    pub dir: String,
    pub destination: LogDestination,
}

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
        };
        for token in line.split_whitespace() {
            if let Some(value) = token.strip_prefix("pid=") {
                facts.pid = value.parse().ok();
            } else if let Some(value) = token.strip_prefix("version=") {
                facts.version = Some(value.to_string());
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
fn marker_anchored_at(line: &str, index: usize, marker: &str) -> bool {
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
fn has_marker(line: &str, marker: &str) -> bool {
    line.match_indices(marker)
        .any(|(index, _)| marker_anchored_at(line, index, marker))
}

fn parse_markers(text: &str) -> Vec<Marker> {
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
    fn from_markers(markers: &[Marker]) -> Self {
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
pub fn scan_previous_session(dir: &Path, stem: &str) -> PreviousSession {
    let Some(files) = session_scan_files(dir, stem) else {
        return PreviousSession::unknown();
    };
    let mut markers = Vec::new();
    for file in files {
        markers.extend(parse_markers(&read_tail(&file, LOG_TAIL_READ_BYTES)));
    }
    PreviousSession::from_markers(&markers)
}

/// The files a scan would read, newest archive first.
///
/// `None` when there is no directory to scan. That case is not hypothetical:
/// in the `Disabled` logging state `LogState.dir` is empty *because* nothing was
/// written anywhere, and `Path::new("").join("oh-my-md.log")` is a *relative*
/// path — the scan would read `./oh-my-md.log` from the process's working
/// directory and report a determination sourced from a file this run never
/// wrote. Never accuse on evidence we did not produce.
fn session_scan_files(dir: &Path, stem: &str) -> Option<Vec<PathBuf>> {
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

    #[allow(dead_code)] // Spec §3.4.4's termination hook is not wired yet.
    pub fn is_exiting(&self) -> bool {
        self.0.load(Ordering::Acquire)
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

pub fn session_start_line(pid: u32, version: &str) -> String {
    let mode = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    format!("{SESSION_START_MARKER} pid={pid} version={version} mode={mode}")
}

pub fn write_session_start(pid: u32, version: &str) {
    log::info!("{}", session_start_line(pid, version));
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
        PreviousExit::Interrupted => "previous session was interrupted by the system",
        PreviousExit::Abnormal => "previous session ended abnormally",
        PreviousExit::Unknown => "previous session outcome unknown (no markers in range)",
    }
}

/// Reports what the previous run did, at the level `level_for_exit` picks.
pub fn log_previous_exit(outcome: PreviousExit) {
    let text = previous_exit_reason(outcome);
    match level_for_exit(outcome) {
        None => log::debug!("{text}"),
        Some(log::Level::Warn) => log::warn!("{text}"),
        Some(_) => log::info!("{text}"),
    }
}

/// Version, OS, arch and the resolved logging destination. One line each so
/// the header is greppable.
///
/// The level is read from `state`, never re-resolved: the header must report
/// what the process is filtering at, and `state.level` is the one value the
/// plugin was configured with (see [`LogState::level`]).
pub fn log_startup_header(state: &LogState) {
    log::info!("app started {}", env!("CARGO_PKG_VERSION"));
    log::info!(
        "environment os={} arch={} log_level={} log_dir={:?} degraded={} destination={:?}",
        os_info::get(),
        std::env::consts::ARCH,
        state.level,
        state.dir,
        state.degraded,
        state.destination
    );
}

/// Logs the panic message, its `file:line`, and the thread, then chains to the
/// default hook so stderr output is preserved. The `file:line` is what
/// identifies which of the ~200 `unwrap()` sites fired.
///
/// Safe before a logger exists (the chained hook is what prints to stderr) and
/// safe *in* a panic: every extraction below has a fallback, so the hook
/// cannot panic on its way to reporting one.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let thread = std::thread::current()
            .name()
            .unwrap_or("unnamed")
            .to_string();
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic payload".to_string());
        log::error!("panic at {location} thread={thread}: {message}");
        previous(info);
    }));
}

/// Command name; must match `LOG_FRONTEND_COMMAND` in `constants.ts`. Rust
/// dispatches a command by its function name, so this literal has no dispatch
/// reader; Task 6's `crossLayerConstants.test.ts` drift guard parses this file,
/// and the layer-4 collapse notice below uses it as its log target so a reader
/// can tell the sink's own line from the records it carried.
pub const LOG_FRONTEND_COMMAND: &str = "log_frontend";

/// Rust-side safety net over the frontend's own limits (spec §3.9 layer 4).
/// Must stay above the frontend token bucket (`LOG_RATE_LIMIT_PER_SEC`, 50 in
/// `constants.ts`), or this net silently truncates legitimate logs.
pub const LOG_FRONTEND_BUDGET_PER_SEC: u32 = 200;

/// One record the frontend facade offers for logging.
///
/// The field names are the §3.11 IPC contract. They are single words, so the
/// camelCase trap cannot bite here — the serialized-JSON test still pins the
/// shape, because TypeScript reads a renamed field as `undefined` without
/// failing to compile.
#[derive(serde::Deserialize, serde::Serialize)]
pub struct FrontendRecord {
    pub level: String,
    pub target: String,
    pub message: String,
}

/// Maps the five facade level names onto `log` levels. Anything else — a typo,
/// a level this build does not know — falls back to `Info` rather than
/// erroring or dropping the record: logging must never break its caller.
pub fn parse_level(raw: &str) -> log::Level {
    match raw.to_ascii_lowercase().as_str() {
        "error" => log::Level::Error,
        "warn" => log::Level::Warn,
        "debug" => log::Level::Debug,
        "trace" => log::Level::Trace,
        _ => log::Level::Info,
    }
}

/// Per-window record budget (spec §3.9 layer 4), the last line of defence
/// against a frontend that ignores its own rate control.
///
/// Only records *below* `Error` reach it: `log_records` parses the level first
/// and logs `Error` unconditionally, so the fatal record can never be collapsed
/// and a burst of errors can never eat the non-error allowance (the green
/// channel of spec §3.9).
///
/// Records over the limit are collapsed and counted rather than silently
/// dropped; [`Self::collapsed`] keeps the cumulative count, so a reader cannot
/// mistake "nothing was collapsed" for "the window happened to be quiet", and
/// [`Self::take_collapse_notice`] hands out the per-window count for the notice.
#[derive(Default)]
pub struct FrontendBudget {
    /// Start of the current one-second window; `None` until the first record.
    window_start: Mutex<Option<Instant>>,
    /// Records offered in the current window, consumed by `allow`.
    used: AtomicU32,
    /// Records collapsed since the process started, never reset.
    collapsed: AtomicU32,
    /// Records collapsed in the current window, reset when it rolls over.
    window_collapsed: AtomicU32,
    /// Whether the current window's collapse notice has been written, reset
    /// when the window rolls over.
    notice_sent: AtomicBool,
    limit: u32,
}

impl FrontendBudget {
    pub fn new(limit: u32) -> Self {
        Self {
            limit,
            ..Default::default()
        }
    }

    /// Consumes one record's allowance. `true` means log it, `false` means it
    /// was collapsed into [`Self::collapsed`].
    fn allow(&self) -> bool {
        let now = Instant::now();
        // The lock serializes the window check: without it two racing callers
        // could both decide the window rolled over and both reset `used`.
        let mut start = self.window_start.lock().unwrap_or_else(|e| e.into_inner());
        if start.is_none_or(|s| now.duration_since(s).as_secs() >= 1) {
            *start = Some(now);
            self.used.store(1, Ordering::Relaxed);
            // A fresh window is a fresh collapse allowance and a fresh notice
            // slot, so the reported count is per window, not per run.
            self.window_collapsed.store(0, Ordering::Relaxed);
            self.notice_sent.store(false, Ordering::Relaxed);
            return true;
        }
        let used = self.used.fetch_add(1, Ordering::Relaxed) + 1;
        if used > self.limit {
            self.collapsed.fetch_add(1, Ordering::Relaxed);
            self.window_collapsed.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        true
    }

    /// Records collapsed since the process started, never reset — a reader can
    /// tell an incomplete log from a quiet one.
    ///
    /// Tests are the only consumer today: a unit test cannot build a
    /// `tauri::State`, so `log_frontend` itself is not drivable here and this
    /// accessor is how "collapsed rather than dropped" is asserted. It stays
    /// public (not `cfg(test)`) because it is the count any reporting surface
    /// must read; `allow` increments it whether or not one exists yet. The
    /// notice reports the *window* count, so this cumulative one stays for the
    /// diagnostics bundle (Task 12).
    #[allow(dead_code)] // Asserted by the budget tests; the notice reports the per-window count.
    pub fn collapsed(&self) -> u32 {
        self.collapsed.load(Ordering::Relaxed)
    }

    /// The current window's collapsed count, if that window has not reported it
    /// yet. `Some(n)` means the caller owes one `n log records collapsed` line
    /// and takes the window's notice slot; every later call in the same window
    /// answers `None`.
    ///
    /// The count is read here, at the end of the batch whose first denial
    /// transitioned the window into the collapsed state, so a batch that
    /// overflows in one IPC call reports the whole batch's count instead of a
    /// bare `1`; a caller that offers one record per call still gets at most one
    /// line per window.
    fn take_collapse_notice(&self) -> Option<u32> {
        // Order matters: a batch that collapsed nothing must not burn the
        // window's notice slot.
        if self.window_collapsed.load(Ordering::Relaxed) == 0 {
            return None;
        }
        if self.notice_sent.swap(true, Ordering::Relaxed) {
            return None;
        }
        Some(self.window_collapsed.load(Ordering::Relaxed))
    }
}

/// Escapes a value for use inside a `path=<…>` / `paths=[…]` field (§3.7).
///
/// This is the one implementation of the field grammar: `\`, the field-closing
/// `>` and `]`, the `paths` separator `;`, and the record-splitting LF/CR. A
/// path carrying any of them is otherwise indistinguishable from the grammar
/// around it, so the field would truncate early and leak its remainder past the
/// export redactor.
///
/// Hand-written concatenation is forbidden for the same reason; the field
/// markers themselves are `LOG_PATH_FIELD_HELPERS` on the TS side and the
/// shared fixture is the cross-language contract.
///
/// [`escape_record_text`] routes record targets and messages through this too:
/// the log file is line-oriented, so an unescaped line break in either writes a
/// second physical line.
pub fn escape_path_field(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '>' => out.push_str("\\>"),
            ']' => out.push_str("\\]"),
            ';' => out.push_str("\\;"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            other => out.push(other),
        }
    }
    out
}

/// The exact inverse of [`escape_path_field`]: collapse each `\x` pair back to
/// the character it escaped, and treat a trailing lone `\` as a literal.
///
/// The redactor unescapes a located field with this before deciding what to
/// remove, so it must be total — an input the writer never produced still
/// answers a `String` rather than panicking mid-export.
///
/// `allow(dead_code)`: Task 12's redactor is the production reader; until it
/// lands only the tests below call this.
#[allow(dead_code)]
pub fn unescape_path_field(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('\\') => out.push('\\'),
            Some('>') => out.push('>'),
            Some(']') => out.push(']'),
            Some(';') => out.push(';'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            // Not an escape this grammar produces; keep both characters so a
            // hand-built or future-extended input is not silently mangled.
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Renders one path as a `path=<escaped>` field.
///
/// Two layers, and both are needed: [`escape_path_field`] keeps the path out of
/// the field/record grammar, and [`neutralize_boundary_markers`] keeps its
/// *content* from being read as a session boundary. A file named
/// `session end clean=true.md` is ordinary, and `parse_markers` scans every
/// physical line — without the second layer that filename alone forges a clean
/// quit and suppresses §3.4.5's abnormal-exit warning.
///
/// `allow(dead_code)`: the fence is the API boundary, not the call sites. The
/// save, export, and diagnostics lines consume [`path_field`] directly, while
/// [`paths_field`] is reached only where a watcher reconciles a path set; the
/// Rust and TypeScript guard tests assert both exist. Do not fold either into
/// `log_records`.
#[allow(dead_code)]
pub fn path_field(path: &Path) -> String {
    let escaped = escape_path_field(&path.to_string_lossy());
    format!("path={}", neutralize_boundary_markers(&escaped))
}

/// Renders a list as a `paths=[<escaped>;<escaped>]` field. `;` is escaped
/// inside each element, so the separator is unambiguous for a path containing
/// one. Boundary vocabulary is neutralized exactly as in [`path_field`].
/// `allow(dead_code)` for the same reason as [`path_field`].
#[allow(dead_code)]
pub fn paths_field(paths: &[PathBuf]) -> String {
    let joined = paths
        .iter()
        .map(|p| escape_path_field(&p.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(";");
    format!("paths=[{}]", neutralize_boundary_markers(&joined))
}

/// Removes the session-boundary vocabulary from record text, by escaping the
/// space inside every marker token [`has_marker`] would accept
/// (`session end` → `session\ end`).
///
/// [`escape_path_field`] alone does **not** make a forged boundary impossible.
/// `has_marker` scans a whole line — it is mid-line matching that keeps the
/// determination lines ("previous session ended abnormally") from parsing — and
/// anchors on the character *after* the token. So
/// `open failed\nsession end clean=true\n` still forges a clean end even with
/// its newlines escaped, because `session end` is followed by a space. Removing
/// the anchored token is the only escaping that closes the hole: afterwards the
/// text cannot contain an accepted `session start` / `session exit` /
/// `session end` at any position.
///
/// Only anchored occurrences are touched, so wording that merely contains a
/// marker as a prefix ("session ended abnormally") survives byte-for-byte. The
/// escaping stays readable, in the same backslash style as §3.7.
fn neutralize_boundary_markers(text: &str) -> String {
    let mut neutralized = String::with_capacity(text.len());
    let mut rest = text;
    while let Some((index, marker)) = first_anchored_marker(rest) {
        neutralized.push_str(&rest[..index]);
        neutralized.push_str(&marker.replace(' ', "\\ "));
        rest = &rest[index + marker.len()..];
    }
    neutralized.push_str(rest);
    neutralized
}

/// The earliest anchored boundary marker in `text`, with the marker it belongs
/// to. Anchors come from [`marker_anchored_at`], the same rule the scanner
/// classifies with.
fn first_anchored_marker(text: &str) -> Option<(usize, &'static str)> {
    let mut earliest: Option<(usize, &'static str)> = None;
    for marker in [
        SESSION_START_MARKER,
        SESSION_EXIT_MARKER,
        SESSION_END_MARKER,
    ] {
        let found = text
            .match_indices(marker)
            .map(|(index, _)| index)
            .find(|&index| marker_anchored_at(text, index, marker));
        if let Some(index) = found {
            if earliest.is_none_or(|(first, _)| index < first) {
                earliest = Some((index, marker));
            }
        }
    }
    earliest
}

/// Makes one frontend-supplied field safe to write into the line-oriented log:
/// one physical line, and no session-boundary vocabulary.
///
/// The line-break half is [`escape_path_field`], shared with the structured
/// path fields rather than reimplemented here (§3.7).
fn escape_record_text(raw: &str) -> String {
    neutralize_boundary_markers(&escape_path_field(raw))
}

/// The record loop behind [`log_frontend`], split out so tests can drive the
/// real sink without a `tauri::State` (which cannot be built outside an app).
///
/// The level is parsed before the budget is consulted, on purpose: an `Error`
/// is logged unconditionally and neither consults nor consumes the budget. That
/// is spec §3.9's green channel — a misbehaving component's warning storm can
/// exhaust layer 4, and the fatal record that follows must still get through.
///
/// Once per window the layer-4 notice is written, after the batch, reporting
/// how many records that window collapsed. The wording is `N log records
/// collapsed`, not the spec's `N error records collapsed`: with the `Error`
/// bypass above, layer 4 can no longer collapse an error at all, so the spec's
/// wording would be false.
fn log_records(records: impl IntoIterator<Item = FrontendRecord>, budget: &FrontendBudget) {
    for record in records {
        let level = parse_level(&record.level);
        if level != log::Level::Error && !budget.allow() {
            continue;
        }
        let target = escape_record_text(&record.target);
        let message = escape_record_text(&record.message);
        log::log!(target: target.as_str(), level, "{}", message);
    }
    if let Some(collapsed) = budget.take_collapse_notice() {
        log::warn!(target: LOG_FRONTEND_COMMAND, "{collapsed} log records collapsed");
    }
}

/// Frontend log sink. Batches arrive as one call so a burst costs one IPC
/// round trip rather than one per record.
///
/// Never `Err`: spec §3.9 says failures degrade rather than propagate, and the
/// budget's answer to pressure is to collapse, not to refuse. The `Result` is
/// the §3.11 IPC contract the TypeScript facade awaits.
#[tauri::command]
pub fn log_frontend(
    records: Vec<FrontendRecord>,
    budget: tauri::State<'_, FrontendBudget>,
) -> Result<(), String> {
    log_records(records, &budget);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // The facade capture lives at the crate root because the `documents`
    // boundary tests need it too; these are the frontend-record helpers that
    // only this module's sink tests use.
    use crate::log_capture::{
        capture_log, records_for_target, take_captured_records, CapturedRecord,
    };

    // Serializes the tests that mutate `OMD_LOG`. Cargo runs tests on parallel
    // threads, so without this the two level tests below interleave and fail
    // intermittently: a `set_var` landing between another test's `set_var` and
    // its assertion silently changes what that assertion reads.
    static LOG_LEVEL_ENV_LOCK: Mutex<()> = Mutex::new(());

    fn log_level_env_guard() -> std::sync::MutexGuard<'static, ()> {
        LOG_LEVEL_ENV_LOCK.lock().unwrap()
    }

    /// Both guards, in this order, for every test here that touches an env var
    /// `effective_level()` reads. `OMD_CONFIG_DIR` cannot be left unpinned: the
    /// persisted verbose flag is read through `workspace::get_settings()`, so an
    /// unpinned run consults the developer's real `settings.json` — and the
    /// shared `workspace` tests must not see this test's temp config dir either
    /// (`workspace::tests::settings_and_session_roundtrip` asserts it is empty).
    /// Lock order is config-then-level here and in the other test, so the two
    /// never invert; `workspace`'s tests take only the first.
    fn env_guards() -> (
        std::sync::MutexGuard<'static, ()>,
        std::sync::MutexGuard<'static, ()>,
    ) {
        (crate::workspace::config_env_guard(), log_level_env_guard())
    }

    #[test]
    fn effective_level_honours_the_env_var_and_ignores_nonsense() {
        let (_config_guard, _level_guard) = env_guards();
        // An empty config dir means no settings file, so `verbose_logging_enabled`
        // is provably false and the fallthrough below can only be the *build
        // default* — never the persisted flag. It also stops this test from
        // reading the developer's real settings (the persisted-flag path returns
        // `Debug`, which a release-profile run would misread as a failure).
        let config = tempfile::tempdir().unwrap();
        std::env::set_var("OMD_CONFIG_DIR", config.path());
        assert!(
            !verbose_logging_enabled(),
            "an empty config dir must not report the verbose flag"
        );

        std::env::set_var(LOG_LEVEL_ENV_VAR, "trace");
        assert_eq!(effective_level(), log::LevelFilter::Trace);
        std::env::set_var(LOG_LEVEL_ENV_VAR, "warn");
        assert_eq!(effective_level(), log::LevelFilter::Warn);
        // The flag is off (asserted above), so this is the build default. The
        // other test pins the flag-on case, where the same nonsense value must
        // resolve to `Debug` instead; together the pair tells the two fallbacks
        // apart even though they coincide under `debug_assertions`.
        std::env::set_var(LOG_LEVEL_ENV_VAR, "banana");
        assert_eq!(effective_level(), default_level());
        std::env::remove_var(LOG_LEVEL_ENV_VAR);
        assert_eq!(effective_level(), default_level());

        std::env::remove_var("OMD_CONFIG_DIR");
    }

    // `OMD_LOG` must keep winning over the persisted flag: it is the
    // per-invocation escape hatch a maintainer reaches for on a support call,
    // and the flag is a durable preference that must not be able to shadow it.
    // `OMD_LOG=banana` is not a level, so it must fall through to the flag
    // rather than pinning the build default — a typo must not silently disable
    // verbose logging any more than it may change the level.
    #[test]
    fn effective_level_lets_the_env_var_beat_the_persisted_verbose_flag() {
        let (_config_guard, _level_guard) = env_guards();
        let config = tempfile::tempdir().unwrap();
        std::env::set_var("OMD_CONFIG_DIR", config.path());
        std::fs::write(
            config.path().join("settings.json"),
            format!(r#"{{"{VERBOSE_LOGGING_SETTINGS_KEY}":true}}"#),
        )
        .unwrap();
        // The flag-on precondition that makes the `banana` case below
        // unambiguous: the value it resolves to is the flag's, not the build
        // default's (the two only coincide under `debug_assertions`).
        assert!(
            verbose_logging_enabled(),
            "the pinned settings file must report the verbose flag"
        );

        std::env::set_var(LOG_LEVEL_ENV_VAR, "warn");
        assert_eq!(
            effective_level(),
            log::LevelFilter::Warn,
            "the env var must beat verboseLogging: true"
        );
        std::env::set_var(LOG_LEVEL_ENV_VAR, "banana");
        assert_eq!(
            effective_level(),
            log::LevelFilter::Debug,
            "an unparseable env var must fall through to the persisted flag, not to the build default"
        );
        std::env::remove_var(LOG_LEVEL_ENV_VAR);
        assert_eq!(
            effective_level(),
            log::LevelFilter::Debug,
            "with no env var the persisted verbose flag is what raises the level"
        );

        // The persisted flag is a JSON key the TypeScript settings shape owns;
        // Rust only reads it. Missing, malformed, or non-boolean values must all
        // answer `false` rather than erroring — only a real boolean `true` may
        // change the level.
        std::fs::write(config.path().join("settings.json"), "{not json").unwrap();
        assert!(
            !verbose_logging_enabled(),
            "corrupt JSON must not enable verbose logging"
        );
        std::fs::write(
            config.path().join("settings.json"),
            format!(r#"{{"{VERBOSE_LOGGING_SETTINGS_KEY}":"true"}}"#),
        )
        .unwrap();
        assert!(
            !verbose_logging_enabled(),
            "the string \"true\" is not the boolean true"
        );
        std::fs::write(
            config.path().join("settings.json"),
            format!(r#"{{"{VERBOSE_LOGGING_SETTINGS_KEY}":false}}"#),
        )
        .unwrap();
        assert!(!verbose_logging_enabled(), "explicit false is not verbose");

        std::env::remove_var("OMD_CONFIG_DIR");
    }

    #[test]
    fn probe_writable_accepts_a_writable_directory_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        assert!(probe_writable(dir.path()));
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(leftovers.is_empty(), "the probe must remove its file");
    }

    #[test]
    fn probe_writable_rejects_a_missing_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!probe_writable(&dir.path().join("does-not-exist")));
    }

    #[cfg(unix)]
    #[test]
    fn probe_writable_rejects_a_directory_that_metadata_calls_writable() {
        use std::os::unix::fs::PermissionsExt;
        // Root bypasses mode bits, so this test's premise only holds for a
        // non-root process. Skipped (not failed) so root CI containers do not
        // flake.
        if std::env::var("USER").as_deref() == Ok("root") {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        // 0o200 = -w-------: the write bit is set, so
        // metadata().permissions().readonly() is false, but creating an entry
        // also needs search (x) permission, so the process cannot create a
        // file here. This is the case a metadata check gets wrong.
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o200)).unwrap();
        assert!(!std::fs::metadata(dir.path())
            .unwrap()
            .permissions()
            .readonly());
        assert!(!probe_writable(dir.path()));
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    // The `log_state` payload is consumed by TypeScript, which cannot catch
    // wire-format drift: a renamed field still compiles and reads `undefined`
    // at runtime. Pin the serialized shape instead of trusting the derive.
    //
    // The destination is an enum, so the casing trap applies twice: the
    // *variant* name is camelCased by the container attribute, and the `kind`
    // tag has to survive as its own field. A frontend reading `dest.kind`
    // compiles fine while getting `undefined` if any of that drifts.
    #[test]
    fn log_state_view_serializes_degraded_dir_and_destination() {
        let json = serde_json::to_string(&LogStateView {
            degraded: true,
            dir: "/tmp/logs".to_string(),
            destination: LogDestination::Fallback,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"degraded":true,"dir":"/tmp/logs","destination":{"kind":"fallback"}}"#
        );

        // The both-registrations-failed state must be distinguishable on the
        // wire, or Settings cannot avoid promising a directory nothing writes.
        let json = serde_json::to_string(&LogStateView {
            degraded: true,
            dir: "/tmp/logs".to_string(),
            destination: LogDestination::Disabled,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"degraded":true,"dir":"/tmp/logs","destination":{"kind":"disabled"}}"#
        );

        let json = serde_json::to_string(&LogStateView {
            degraded: false,
            dir: "/tmp/logs".to_string(),
            destination: LogDestination::Directory,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"degraded":false,"dir":"/tmp/logs","destination":{"kind":"directory"}}"#
        );
    }

    // The real directory answered the probe and the plugin attached there.
    #[test]
    fn prepare_file_logging_uses_the_real_directory_when_it_registers() {
        let dir = tempfile::tempdir().unwrap();
        let state =
            prepare_file_logging("oh-my-md", dir.path(), log::LevelFilter::Debug, |_, _| {
                Ok(())
            });
        assert_eq!(state.destination, LogDestination::Directory);
        assert!(!state.degraded);
        assert_eq!(state.dir, dir.path());
        assert_eq!(state.file_stem, "oh-my-md");
    }

    // The real registration failed, so the fallback carried the file. Both the
    // directory *and* the stem must name the fallback: a reader that recomputed
    // either would look in the wrong place.
    #[test]
    fn prepare_file_logging_falls_back_to_temp_when_the_real_dir_fails() {
        let dir = tempfile::tempdir().unwrap();
        // Only the real directory's registration fails; the fallback accepts, so
        // the file really is carried by the temp directory in this state.
        let mut first = true;
        let state =
            prepare_file_logging("oh-my-md", dir.path(), log::LevelFilter::Debug, |_, _| {
                if std::mem::take(&mut first) {
                    Err("nope".to_string())
                } else {
                    Ok(())
                }
            });
        assert_eq!(state.destination, LogDestination::Fallback);
        assert!(state.degraded);
        assert_eq!(state.dir, fallback_dir());
        assert_eq!(state.file_stem, fallback_file_stem());
    }

    // Both registrations failed: no logger is attached at all. `dir` and
    // `file_stem` stay empty, so Settings cannot print "your logs are here" over
    // a path that receives nothing — the state the old
    // `degraded: true`-for-everything return could not express. The `Stdout`
    // target lives inside the same plugin dispatch as the file target, so in
    // this state the facade's records do not reach stdout either.
    #[test]
    fn prepare_file_logging_reports_disabled_when_both_registrations_fail() {
        let dir = tempfile::tempdir().unwrap();
        let mut attempts = 0;
        let state =
            prepare_file_logging("oh-my-md", dir.path(), log::LevelFilter::Debug, |_, _| {
                attempts += 1;
                Err("both registrations fail".to_string())
            });
        assert_eq!(
            attempts, 2,
            "the real directory and the temp fallback must both have been tried"
        );
        assert_eq!(state.destination, LogDestination::Disabled);
        assert!(state.degraded);
        assert_eq!(state.dir, PathBuf::new());
        assert!(state.file_stem.is_empty());
    }

    // `install()` cannot be built without an `AppHandle`, so the seam is
    // `prepare_file_logging`: whatever level it is handed must travel into the
    // state in all three destinations. The diagnostics bundle reads it back
    // instead of re-resolving, which is what keeps the manifest from naming a
    // level a mid-session Settings toggle changed underneath it.
    #[test]
    fn prepare_file_logging_carries_the_resolved_level_into_every_state() {
        let dir = tempfile::tempdir().unwrap();
        let level = log::LevelFilter::Trace;

        let directory = prepare_file_logging("oh-my-md", dir.path(), level, |_, _| Ok(()));
        assert_eq!(directory.level, level);

        let mut first = true;
        let fallback = prepare_file_logging("oh-my-md", dir.path(), level, |_, _| {
            if std::mem::take(&mut first) {
                Err("nope".to_string())
            } else {
                Ok(())
            }
        });
        assert_eq!(fallback.destination, LogDestination::Fallback);
        assert_eq!(fallback.level, level);

        let disabled =
            prepare_file_logging(
                "oh-my-md",
                dir.path(),
                level,
                |_, _| Err("both".to_string()),
            );
        assert_eq!(disabled.destination, LogDestination::Disabled);
        assert_eq!(disabled.level, level);
    }

    fn write_log(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    fn take_captured() -> Vec<String> {
        take_captured_records()
            .into_iter()
            .map(|record| record.message)
            .collect()
    }

    fn frontend_record(level: &str, target: &str, message: &str) -> FrontendRecord {
        FrontendRecord {
            level: level.to_string(),
            target: target.to_string(),
            message: message.to_string(),
        }
    }

    fn info(message: &str) -> FrontendRecord {
        frontend_record("info", "frontend", message)
    }

    fn error(message: &str) -> FrontendRecord {
        frontend_record("error", "frontend", message)
    }

    /// The layer-4 notices in a capture, isolated by their target so a test can
    /// count them without the frontend records around them.
    fn collapse_notices(records: &[CapturedRecord]) -> Vec<String> {
        records
            .iter()
            .filter(|record| record.target == LOG_FRONTEND_COMMAND)
            .map(|record| record.message.clone())
            .collect()
    }

    /// The tests that drive the sink with the frontend's own target and level.
    fn frontend_records(records: &[CapturedRecord]) -> Vec<CapturedRecord> {
        records_for_target(records, "frontend")
    }

    fn frontend_messages(records: &[CapturedRecord]) -> Vec<String> {
        frontend_records(records)
            .into_iter()
            .map(|record| record.message)
            .collect()
    }

    /// The lines the file sink writes for `records`, in the sink's real
    /// envelope.
    ///
    /// `tauri-plugin-log` 2.9.0's default fern dispatch formats every record as
    /// `{timestamp}[{target}][{LEVEL}] {message}` (its `impl Default for
    /// Builder`, `src/lib.rs`; the timestamp renders as `[YYYY-MM-DD][HH:MM:SS]`).
    /// Target and message therefore share one physical line and the scanner
    /// reads both. An earlier form rendered only `"{target} {message}"` and so
    /// under-modelled what a forged boundary has to escape out of; the fixed
    /// timestamp keeps the output deterministic.
    fn written_lines(records: &[CapturedRecord]) -> String {
        records
            .iter()
            .map(|record| {
                format!(
                    "[2026-10-03][12:00:00][{}][{}] {}",
                    record.target, record.level, record.message
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    // The determination line is written *after* the `session start` of the run
    // that logs it, so the next launch's scanner reads it back. Driving the
    // real writers (not copies of their strings, as
    // `parse_markers_ignores_the_determination_lines` does) means a rewording
    // that ends a marker on a space — the change that turns a crash into a
    // phantom exit intent — fails here.
    #[test]
    fn session_boundary_writers_emit_lines_the_scanner_reads_back() {
        let _capture = capture_log();
        let _ = take_captured_records();

        write_session_start(4242, "0.0.1");
        note_clean_exit();
        let clean_quit = take_captured().join("\n");
        assert_eq!(
            classify(&parse_markers(&clean_quit)),
            PreviousExit::Clean,
            "got {clean_quit:?}"
        );

        for outcome in [
            PreviousExit::Clean,
            PreviousExit::Interrupted,
            PreviousExit::Abnormal,
            PreviousExit::Unknown,
        ] {
            log_previous_exit(outcome);
            let run = format!(
                "{}\n{}\n",
                session_start_line(4242, "0.0.1"),
                take_captured().join("\n")
            );
            assert_eq!(
                parse_markers(&run),
                vec![Marker {
                    kind: MarkerKind::Start,
                    clean: false,
                    start: Some(SessionStartFacts {
                        pid: Some(4242),
                        version: Some("0.0.1".to_string()),
                    }),
                }],
                "{outcome:?} logged a line the scanner reads as a marker"
            );
        }
    }

    #[test]
    fn read_tail_drops_the_partial_first_line_and_survives_split_utf8() {
        let dir = tempfile::tempdir().unwrap();
        // The seek start lands inside the ASCII filler, so the CJK line is
        // wholly inside the window; only the partial first line has to go.
        // `read_tail_drops_a_first_line_cut_inside_a_cjk_character` below
        // covers the boundary-lands-mid-character case.
        let filler = "x".repeat(LOG_TAIL_READ_BYTES as usize - 2);
        let body = format!("{filler}笔记.md\nsession end clean=true\n");
        let path = write_log(dir.path(), "oh-my-md.log", &body);
        let tail = read_tail(&path, LOG_TAIL_READ_BYTES);
        assert!(tail.ends_with("session end clean=true\n"));
        assert!(
            !tail.starts_with('x'),
            "the partial first line must be dropped"
        );
    }

    // The boundary test above seeks 31 bytes into pure ASCII, so it never
    // exercises the lossy half of trap 1. This one cuts 笔 in half.
    #[test]
    fn read_tail_drops_a_first_line_cut_inside_a_cjk_character() {
        let dir = tempfile::tempdir().unwrap();
        let limit = LOG_TAIL_READ_BYTES as usize;
        // 笔 occupies bytes 65535..65538, so the seek start (65536) is its
        // second byte and the tail opens on two orphaned continuation bytes.
        let body = format!(
            "{}笔记.md\n{}\nsession end clean=true\n",
            "x".repeat(limit - 1),
            "y".repeat(limit - 33)
        );
        let path = write_log(dir.path(), "oh-my-md.log", &body);
        assert_eq!(
            body.len(),
            limit * 2,
            "the fixture must straddle the boundary"
        );
        let tail = read_tail(&path, LOG_TAIL_READ_BYTES);
        assert_eq!(
            tail,
            format!("{}\nsession end clean=true\n", "y".repeat(limit - 33)),
            "the partial line (and its replacement characters) must be dropped"
        );
    }

    #[test]
    fn read_tail_reads_no_more_than_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let limit = LOG_TAIL_READ_BYTES as usize;
        // The start marker is far outside the window: a full-file read would
        // find it, a bounded tail read must not.
        let body = format!(
            "session start pid=1 version=0.0.1 mode=release\n{}\nsession end clean=true\n",
            "filler\n".repeat(limit)
        );
        let path = write_log(dir.path(), "oh-my-md.log", &body);
        assert!(body.len() > limit * 2);
        let tail = read_tail(&path, LOG_TAIL_READ_BYTES);
        assert!(tail.ends_with("session end clean=true\n"));
        assert!(
            !tail.contains(SESSION_START_MARKER),
            "a marker outside the window must not be read"
        );
    }

    // The whole-file case never enters the partial-line path: the seek start
    // is 0, so the first line is complete and must survive.
    #[test]
    fn read_tail_keeps_the_first_line_when_the_read_starts_at_offset_zero() {
        let dir = tempfile::tempdir().unwrap();
        let body = "session start pid=1 version=0.0.1 mode=release\nsession end clean=true\n";
        assert!((body.len() as u64) < LOG_TAIL_READ_BYTES);
        let path = write_log(dir.path(), "oh-my-md.log", body);
        assert_eq!(read_tail(&path, LOG_TAIL_READ_BYTES), body);
    }

    // The finding: the first line was dropped on *every* read that started above
    // offset 0, including one whose 64 KiB boundary landed exactly on a line
    // start. For a session split across the rotation boundary that silently
    // discards the archive's `session start` (→ `Unknown`) — or its
    // `session end clean=true` (→ `Abnormal`), the one outcome the design says
    // must never happen on missing evidence. Offset 0 and a preceding `\n` both
    // mean the first line is whole.
    #[test]
    fn read_tail_keeps_a_complete_first_line_at_a_line_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let limit = LOG_TAIL_READ_BYTES as usize;
        let head = format!("{}\n", "x".repeat(9));
        let first = "session start pid=7 version=0.0.1 mode=release\n";
        let filler = "y".repeat(limit - first.len());
        let body = format!("{head}{first}{filler}");
        let start = body.len() - limit;
        assert!(start > 0, "the premise: the read must start above offset 0");
        assert_eq!(
            body.as_bytes()[start - 1],
            b'\n',
            "the premise: the boundary must land exactly on a line start"
        );

        let path = write_log(dir.path(), "oh-my-md.log", &body);
        let tail = read_tail(&path, LOG_TAIL_READ_BYTES);
        assert_eq!(
            tail,
            format!("{first}{filler}"),
            "the complete first line must survive a boundary that lands on a line start"
        );
        assert!(
            parse_markers(&tail)
                .iter()
                .any(|marker| marker.kind == MarkerKind::Start),
            "the archived `session start` is the point of the window: {tail:?}"
        );
    }

    // Task 4 logs these human-readable determination lines into the same file,
    // *after* the `session start` line (spec §3.4.5). "session exited" and
    // "session ended" contain the "session exit"/"session end" markers as bare
    // substrings, so a `contains` match invents markers that were never
    // written. None of the three may parse.
    #[test]
    fn parse_markers_ignores_the_determination_lines() {
        let text = "previous session exited cleanly\n\
                    previous session ended abnormally\n\
                    previous session was interrupted by the system\n";
        assert!(
            parse_markers(text).is_empty(),
            "determination lines must not be read as session markers"
        );
    }

    #[test]
    fn newest_archive_is_lexicographically_last() {
        let dir = tempfile::tempdir().unwrap();
        write_log(dir.path(), "oh-my-md_2026-01-01_00-00-00.log", "old");
        write_log(dir.path(), "oh-my-md_2026-10-02_09-30-00.log", "new");
        write_log(dir.path(), "oh-my-md.log", "active");
        let found = newest_archive(dir.path(), "oh-my-md").unwrap();
        assert!(found.to_string_lossy().contains("2026-10-02"));
    }

    #[test]
    fn classify_covers_every_row_of_the_determination_table() {
        use MarkerKind::*;
        assert_eq!(classify(&[]), PreviousExit::Unknown);
        assert_eq!(
            classify(&[Marker {
                kind: Start,
                clean: false,
                start: None
            }]),
            PreviousExit::Abnormal
        );
        assert_eq!(
            classify(&[
                Marker {
                    kind: Start,
                    clean: false,
                    start: None
                },
                Marker {
                    kind: End,
                    clean: true,
                    start: None
                },
            ]),
            PreviousExit::Clean
        );
        assert_eq!(
            classify(&[
                Marker {
                    kind: Start,
                    clean: false,
                    start: None
                },
                Marker {
                    kind: Exit,
                    clean: false,
                    start: None
                },
            ]),
            PreviousExit::Interrupted
        );
        // An unmatched End (start rotated out of both windows) is unknown,
        // never an accusation.
        assert_eq!(
            classify(&[Marker {
                kind: End,
                clean: true,
                start: None
            }]),
            PreviousExit::Unknown
        );
    }

    // A user-initiated quit writes *both* lines: the intent at
    // `ExitRequested{code: None}` and the end at `RunEvent::Exit`. Reading
    // only the marker immediately after the start would call every clean quit
    // "interrupted".
    #[test]
    fn classify_lets_a_clean_end_win_over_an_earlier_exit_intent() {
        use MarkerKind::*;
        assert_eq!(
            classify(&[
                Marker {
                    kind: Start,
                    clean: false,
                    start: None
                },
                Marker {
                    kind: Exit,
                    clean: false,
                    start: None
                },
                Marker {
                    kind: End,
                    clean: true,
                    start: None
                },
            ]),
            PreviousExit::Clean
        );
    }

    #[test]
    fn scan_reports_clean_for_the_real_quit_sequence() {
        let dir = tempfile::tempdir().unwrap();
        write_log(
            dir.path(),
            "oh-my-md.log",
            "session start pid=1 version=0.0.1 mode=release\n\
             session exit intent=user\n\
             session end clean=true\n",
        );
        assert_eq!(
            scan_previous_session(dir.path(), "oh-my-md").outcome,
            PreviousExit::Clean
        );
    }

    #[test]
    fn scan_merges_a_split_session_across_the_rotation_boundary() {
        let dir = tempfile::tempdir().unwrap();
        // The session outgrew 2 MiB and rotated mid-session: its start is in
        // the archive, its end in the active log. A single-file reader would
        // see an unmatched end and could only answer "unknown".
        write_log(
            dir.path(),
            "oh-my-md_2026-10-02_09-30-00.log",
            "session start pid=1 version=0.0.1 mode=release\n",
        );
        write_log(dir.path(), "oh-my-md.log", "session end clean=true\n");
        assert_eq!(
            scan_previous_session(dir.path(), "oh-my-md").outcome,
            PreviousExit::Clean
        );
    }

    #[test]
    fn scan_reports_abnormal_when_a_later_start_has_no_exit() {
        let dir = tempfile::tempdir().unwrap();
        write_log(
            dir.path(),
            "oh-my-md_2026-10-02_09-30-00.log",
            "session start pid=1 version=0.0.1 mode=release\n",
        );
        write_log(
            dir.path(),
            "oh-my-md.log",
            "session end clean=true\nsession start pid=2 version=0.0.1 mode=release\n",
        );
        assert_eq!(
            scan_previous_session(dir.path(), "oh-my-md").outcome,
            PreviousExit::Abnormal
        );
    }

    // The path this feature exists for: run N−1 quits cleanly, so its log ends
    // with the (debug-level) "previous session exited cleanly" determination
    // line; run N scans it, writes `session start` plus the same line, then
    // dies with no exit intent and no clean end (SIGKILL / segfault /
    // force-kill). Parsing the determination line as a real `session exit`
    // makes run N+1 report Interrupted at Info and suppresses the Abnormal
    // warning the feature was built to raise.
    #[test]
    fn scan_reports_abnormal_for_a_crash_after_a_clean_run() {
        let dir = tempfile::tempdir().unwrap();
        write_log(
            dir.path(),
            "oh-my-md.log",
            "session start pid=1 version=0.0.1 mode=release\n\
             previous session exited cleanly\n",
        );
        assert_eq!(
            scan_previous_session(dir.path(), "oh-my-md").outcome,
            PreviousExit::Abnormal
        );
    }

    #[test]
    fn scan_reports_clean_when_the_last_start_is_followed_by_a_clean_end() {
        let dir = tempfile::tempdir().unwrap();
        write_log(
            dir.path(),
            "oh-my-md.log",
            "session start pid=1 version=0.0.1 mode=release\nsession end clean=true\n",
        );
        assert_eq!(
            scan_previous_session(dir.path(), "oh-my-md").outcome,
            PreviousExit::Clean
        );
    }

    #[test]
    fn scan_reports_interrupted_for_an_intent_without_an_end() {
        let dir = tempfile::tempdir().unwrap();
        write_log(
            dir.path(),
            "oh-my-md.log",
            "session start pid=1 version=0.0.1 mode=release\nsession exit intent=shutdown\n",
        );
        assert_eq!(
            scan_previous_session(dir.path(), "oh-my-md").outcome,
            PreviousExit::Interrupted
        );
    }

    #[test]
    fn scan_reports_unknown_when_no_start_survives() {
        let dir = tempfile::tempdir().unwrap();
        write_log(dir.path(), "oh-my-md.log", "session end clean=true\n");
        assert_eq!(
            scan_previous_session(dir.path(), "oh-my-md").outcome,
            PreviousExit::Unknown
        );
    }

    // Spec §3.8's `previous_exit` names the previous run's pid and version, and
    // the line the scanner already classifies carries both
    // (`session start pid=… version=…`). They must belong to the *same* start
    // `classify` keys off: reporting one session's outcome beside another's pid
    // is a fabricated fact in a support artifact.
    #[test]
    fn scan_retains_the_last_start_lines_pid_and_version() {
        let dir = tempfile::tempdir().unwrap();
        write_log(
            dir.path(),
            "oh-my-md.log",
            "session start pid=1 version=0.0.1 mode=release\n\
             session end clean=true\n\
             session start pid=4242 version=9.9.9 mode=release\n\
             session end clean=true\n",
        );
        let session = scan_previous_session(dir.path(), "oh-my-md");
        assert_eq!(session.outcome, PreviousExit::Clean);
        assert_eq!(
            session.pid,
            Some(4242),
            "the last start is the one classified"
        );
        assert_eq!(session.version.as_deref(), Some("9.9.9"));
    }

    // The other half of the honesty rule: a start line without pid/version (a
    // truncated or hand-edited record) answers `None`, which the manifest writes
    // as null rather than inventing a value.
    #[test]
    fn scan_reports_no_facts_when_the_start_line_carries_none() {
        let dir = tempfile::tempdir().unwrap();
        write_log(
            dir.path(),
            "oh-my-md.log",
            "session start\nsession end clean=true\n",
        );
        let session = scan_previous_session(dir.path(), "oh-my-md");
        assert_eq!(session.outcome, PreviousExit::Clean);
        assert_eq!(session.pid, None);
        assert_eq!(session.version, None);
    }

    // The `Disabled` logging state hands the scanner an empty dir, and
    // `Path::new("").join("oh-my-md.log")` is *relative*: a naive scan would read
    // `./oh-my-md.log` from the process's working directory and report a
    // determination sourced from a file this run never wrote. The scan target
    // list is `None` there, which is what makes the CWD unreachable.
    #[test]
    fn scan_has_no_targets_when_the_log_directory_is_empty() {
        assert!(session_scan_files(Path::new(""), "oh-my-md").is_none());
        assert!(session_scan_files(Path::new("/tmp/logs"), "").is_none());
        assert_eq!(
            scan_previous_session(Path::new(""), "oh-my-md").outcome,
            PreviousExit::Unknown
        );

        let dir = tempfile::tempdir().unwrap();
        let targets = session_scan_files(dir.path(), "oh-my-md").unwrap();
        assert_eq!(targets, vec![dir.path().join("oh-my-md.log")]);
    }

    // The destination is a three-state enum, and Task 12 prints its `kind` in
    // `environment.txt` while serde puts the same word on the wire. Two
    // spellings of one state is how Settings and a support reader end up
    // disagreeing about the same run.
    #[test]
    fn destination_kind_matches_the_serialized_tag() {
        for destination in [
            LogDestination::Directory,
            LogDestination::Fallback,
            LogDestination::Disabled,
        ] {
            assert_eq!(
                serde_json::to_value(destination).unwrap()["kind"],
                destination.kind(),
                "{destination:?}"
            );
        }
    }

    // The manifest's `previous_exit.state` is machine-read, so the variant names
    // are a wire format, not an implementation detail.
    #[test]
    fn previous_exit_serializes_as_the_manifest_state_and_reason() {
        for (outcome, state) in [
            (PreviousExit::Clean, "clean"),
            (PreviousExit::Interrupted, "interrupted"),
            (PreviousExit::Abnormal, "abnormal"),
            (PreviousExit::Unknown, "unknown"),
        ] {
            assert_eq!(serde_json::to_value(outcome).unwrap(), state);
            // The reason is the sentence the log carries; it must never be
            // empty, and it must never read as a boundary marker (see
            // `previous_exit_reason`).
            let reason = previous_exit_reason(outcome);
            assert!(!reason.is_empty(), "{outcome:?}");
            assert!(!has_marker(reason, SESSION_EXIT_MARKER), "{reason}");
            assert!(!has_marker(reason, SESSION_END_MARKER), "{reason}");
            assert!(!has_marker(reason, SESSION_START_MARKER), "{reason}");
        }
    }

    #[test]
    fn previous_exit_levels_match_the_spec_table() {
        assert_eq!(level_for_exit(PreviousExit::Clean), None);
        assert_eq!(
            level_for_exit(PreviousExit::Interrupted),
            Some(log::Level::Info)
        );
        assert_eq!(
            level_for_exit(PreviousExit::Abnormal),
            Some(log::Level::Warn)
        );
        assert_eq!(
            level_for_exit(PreviousExit::Unknown),
            Some(log::Level::Info)
        );
    }

    #[test]
    fn session_start_line_carries_pid_version_and_mode() {
        let line = session_start_line(4242, "0.0.1");
        assert!(line.contains("pid=4242"));
        assert!(line.contains("version=0.0.1"));
        assert!(line.starts_with(SESSION_START_MARKER));
    }

    // Writer and reader are two halves of one contract, so a format change
    // the scanner no longer recognizes must fail here instead of silently
    // degrading every later determination.
    #[test]
    fn session_start_line_round_trips_through_the_scanner() {
        let text = format!("{}\n", session_start_line(4242, "0.0.1"));
        assert_eq!(
            parse_markers(&text),
            vec![Marker {
                kind: MarkerKind::Start,
                clean: false,
                start: Some(SessionStartFacts {
                    pid: Some(4242),
                    version: Some("0.0.1".to_string()),
                }),
            }]
        );
    }

    // The flag is the only in-memory evidence that a teardown was intended,
    // and spec §3.4.4's termination hook exists to read it.
    #[test]
    fn exiting_state_starts_clear_and_stays_marked() {
        let state = ExitingState::default();
        assert!(!state.is_exiting());
        state.mark();
        assert!(state.is_exiting());
    }

    #[test]
    fn frontend_record_serializes_with_single_word_fields() {
        // The IPC wire format is a tested contract: TS types cannot catch
        // casing drift, and desktop tests mock services at the TS boundary.
        let record = FrontendRecord {
            level: "error".into(),
            target: "updates".into(),
            message: "boom".into(),
        };
        let json = serde_json::to_string(&record).unwrap();
        assert_eq!(
            json,
            r#"{"level":"error","target":"updates","message":"boom"}"#
        );
    }

    #[test]
    fn unknown_levels_fall_back_to_info_rather_than_erroring() {
        assert_eq!(parse_level("nonsense"), log::Level::Info);
        assert_eq!(parse_level("ERROR"), log::Level::Error);
    }

    #[test]
    fn budget_collapses_above_the_limit_instead_of_dropping() {
        let budget = FrontendBudget::new(2);
        assert!(budget.allow());
        assert!(budget.allow());
        assert!(!budget.allow());
        assert_eq!(budget.collapsed(), 1);
    }

    // The window rollover is what separates a per-second budget from a
    // permanent wall: without it, `limit` records would be the whole run's
    // allowance and every legitimate log after the first second would be
    // collapsed.
    #[test]
    fn budget_refills_when_the_window_rolls_over() {
        let budget = FrontendBudget::new(1);
        assert!(budget.allow());
        assert!(!budget.allow());
        assert_eq!(budget.collapsed(), 1);
        std::thread::sleep(std::time::Duration::from_millis(1100));
        assert!(budget.allow(), "a new window must refill the budget");
        assert_eq!(
            budget.collapsed(),
            1,
            "collapsed is cumulative, not per window"
        );
    }

    // Spec §3.9's green channel: a warning storm that exhausts the budget must
    // not take the fatal record with it. The budget is consulted *after* the
    // level is parsed, so an `Error` never even reaches `allow` — that is also
    // why it cannot count as a collapse.
    #[test]
    fn error_records_are_logged_even_when_the_budget_is_exhausted() {
        let _capture = capture_log();
        let _ = take_captured_records();
        let budget = FrontendBudget::new(1);
        log_records(vec![info("before"), info("over")], &budget);
        assert_eq!(budget.collapsed(), 1, "the second record must be collapsed");
        let _ = take_captured_records();

        log_records(vec![error("fatal")], &budget);
        let records = frontend_records(&take_captured_records());
        assert_eq!(records.len(), 1, "an Error must pass an exhausted budget");
        assert_eq!(records[0].level, log::Level::Error);
        assert_eq!(records[0].message, "fatal");
        assert_eq!(
            budget.collapsed(),
            1,
            "the bypass must neither collapse nor consume"
        );
    }

    // The other half of the green channel: because `Error` never calls
    // `allow`, a burst of fatal records cannot starve the records below it.
    #[test]
    fn bypassed_errors_do_not_consume_the_non_error_allowance() {
        let _capture = capture_log();
        let _ = take_captured_records();
        let budget = FrontendBudget::new(2);
        log_records(vec![info("a")], &budget);
        let _ = take_captured_records();

        log_records(vec![error("e1"), error("e2"), error("e3")], &budget);
        let records = frontend_records(&take_captured_records());
        assert_eq!(records.len(), 3, "every Error must reach the logger");
        assert!(records.iter().all(|r| r.level == log::Level::Error));

        // "a" used one of the window's two slots; if the errors had consumed
        // any, "b" could not still pass.
        log_records(vec![info("b"), info("c")], &budget);
        let messages = frontend_messages(&take_captured_records());
        assert!(
            messages.contains(&"b".to_string()),
            "a non-error record must still pass after a burst of errors: {messages:?}"
        );
        assert!(
            !messages.contains(&"c".to_string()),
            "only the slot left by \"a\" was available: {messages:?}"
        );
        assert_eq!(budget.collapsed(), 1);
    }

    // `N log records collapsed`, not the spec's `N error records collapsed`:
    // with the `Error` bypass above, layer 4 can no longer collapse an error,
    // so the spec's wording would be false.
    #[test]
    fn collapse_notice_is_emitted_once_per_window_with_that_windows_count() {
        let _capture = capture_log();
        let _ = take_captured_records();
        let budget = FrontendBudget::new(2);

        log_records(vec![info("a"), info("b"), info("c"), info("d")], &budget);
        let records = take_captured_records();
        assert_eq!(
            collapse_notices(&records),
            vec!["2 log records collapsed"],
            "the window's first collapse must be reported with its count"
        );
        assert_eq!(frontend_messages(&records), ["a", "b"]);

        // Same window, more collapses: the notice slot is already spent, so a
        // caller that bypasses the frontend cannot rotate the log away.
        log_records(vec![info("e"), info("f")], &budget);
        let records = take_captured_records();
        assert!(collapse_notices(&records).is_empty());
        assert!(frontend_messages(&records).is_empty());

        // A new window gets a fresh notice, and the count is that window's —
        // not the run's running total (`collapsed()` is 6 by now).
        std::thread::sleep(std::time::Duration::from_millis(1100));
        log_records(vec![info("g"), info("h"), info("i"), info("j")], &budget);
        assert_eq!(budget.collapsed(), 6);
        let records = take_captured_records();
        assert_eq!(
            collapse_notices(&records),
            vec!["2 log records collapsed"],
            "second window, its own count"
        );
        assert_eq!(frontend_messages(&records), ["g", "h"]);
    }

    #[test]
    fn record_text_escapes_line_breaks_losslessly() {
        assert_eq!(escape_path_field("a\nb\rc"), "a\\nb\\rc");
        assert_eq!(escape_record_text("笔记.md"), "笔记.md");
    }

    /// The escaped grammar is finite and decidable here, so assert the whole
    /// rule rather than one example.
    #[test]
    fn escaped_path_fields_close_every_delimiter() {
        // Every delimiter doubled-and-prefixed, and every backslash doubled.
        assert_eq!(
            escape_path_field("/tmp/a\\b>c]d;e\nf\rg"),
            "/tmp/a\\\\b\\>c\\]d\\;e\\nf\\rg"
        );

        // Round trip over the full grammar, not just a clean path. This is the
        // property §3.7 calls for and the one the fixture alone cannot state.
        for case in [
            "/tmp/a\\b>c]d;e\nf\rg",
            "/tmp/back\\",
            "/tmp/we\\nird.md",
            "/Volumes/My Vault/笔记.md",
        ] {
            assert_eq!(
                unescape_path_field(&escape_path_field(case)),
                case,
                "round trip for {case:?}"
            );
        }

        // A path ending in an odd backslash run must not swallow the closing
        // delimiters when the field is parsed.
        let trailing = path_field(Path::new("/tmp/back\\"));
        assert!(trailing.ends_with("\\\\"), "{trailing:?}");
        assert_eq!(
            unescape_path_field(&trailing["path=".len()..]),
            "/tmp/back\\"
        );
    }

    /// The redactor is Rust and some producers are TS, so the field grammar is
    /// a cross-language contract read from one shared fixture by this test and
    /// `apps/desktop/test/logPath.test.ts`. `CARGO_MANIFEST_DIR` is
    /// `apps/desktop/src-tauri`, so the path below resolves to
    /// `apps/desktop/test/fixtures/logPathCases.json`; the read is unwrapped on
    /// purpose — a silently skipped fixture would make this test vacuous.
    #[test]
    fn path_fields_round_trip_the_shared_fixture() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../test/fixtures/logPathCases.json"
        ))
        .unwrap();
        let cases: serde_json::Value = serde_json::from_str(&raw).unwrap();
        for case in cases["single"].as_array().unwrap() {
            let input = case["raw"].as_str().unwrap();
            let expected = case["field"].as_str().unwrap();
            assert_eq!(path_field(Path::new(input)), expected, "raw {input:?}");

            // `path=` is the whole field prefix, so what follows it must
            // unescape back to the original. This is the property Task 12's
            // redactor relies on, and it is the *field* form that is asserted:
            // asserting `unescape_path_field(input) == input` on the raw path
            // would pass coincidentally (a raw path is mostly not escaped) and
            // prove nothing about the grammar.
            let value = expected.strip_prefix("path=").unwrap();
            assert_eq!(unescape_path_field(value), input, "field {expected:?}");
        }
        for case in cases["multi"].as_array().unwrap() {
            let inputs: Vec<PathBuf> = case["raw"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| PathBuf::from(v.as_str().unwrap()))
                .collect();
            let expected = case["field"].as_str().unwrap();
            assert_eq!(paths_field(&inputs), expected, "raw {inputs:?}");

            // `paths=[…]` splits on `;` only where the separator is unescaped,
            // so each element must round trip on its own. Splitting on every
            // `;` is exactly the bug the escape exists to prevent: `/a\;semi.md`
            // is one path, not two.
            let body = expected
                .strip_prefix("paths=[")
                .and_then(|rest| rest.strip_suffix(']'))
                .unwrap();
            let parts = unescaped_semicolon_split(body);
            let wanted: Vec<String> = inputs
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            assert_eq!(parts, wanted, "field {expected:?}");
        }
    }

    /// Splits a `paths=[…]` body on `;` separators only, mirroring how a reader
    /// walks the escaped grammar: a `\\` pair is consumed whole (so the `;` in
    /// `/a\\;b.md` is a separator), while `\;` is an escaped literal.
    fn unescaped_semicolon_split(body: &str) -> Vec<String> {
        let mut parts = Vec::new();
        let mut current = String::new();
        let mut chars = body.chars().peekable();
        while let Some(ch) = chars.next() {
            match ch {
                ';' => {
                    parts.push(unescape_path_field(&current));
                    current.clear();
                }
                '\\' => {
                    current.push(ch);
                    if let Some(next) = chars.next() {
                        current.push(next);
                    }
                }
                other => current.push(other),
            }
        }
        parts.push(unescape_path_field(&current));
        parts
    }

    // The finding assumed `\n`/`\r` escaping was enough. It is not: `has_marker`
    // scans the whole line, so the bare marker vocabulary forges a boundary with
    // no line break at all. Pin both halves.
    #[test]
    fn record_text_neutralizes_the_boundary_vocabulary() {
        assert_eq!(
            escape_record_text("session end clean=true"),
            "session\\ end clean=true"
        );
        assert_eq!(
            escape_record_text("session start pid=1"),
            "session\\ start pid=1"
        );
        assert_eq!(
            escape_record_text("session exit intent=user"),
            "session\\ exit intent=user"
        );
        // End-of-line is the other anchor `has_marker` accepts.
        assert_eq!(escape_record_text("session end"), "session\\ end");
        // Wording that is not a boundary token must survive untouched.
        assert_eq!(
            escape_record_text("previous session ended abnormally"),
            "previous session ended abnormally"
        );
    }

    // Task 3's `parse_markers` matches `session end` as a right-anchored token
    // anywhere in a line, and a clean end suppresses §3.4.5's abnormal-exit
    // warning. Task 7's stack traces and macOS filenames both put newlines into
    // this sink through Task 6's facade, so an unescaped message could write a
    // second physical line that forges a clean quit.
    #[test]
    fn a_message_cannot_forge_a_session_boundary() {
        let _capture = capture_log();
        let _ = take_captured_records();
        let budget = FrontendBudget::new(10);

        log_records(
            vec![frontend_record(
                "info",
                "windows/open.rs",
                "open failed\nsession end clean=true\n",
            )],
            &budget,
        );

        // Filter on the target *this* test logged, and prove the filter found
        // it: with a filter the record does not match, `written` is empty and
        // both assertions below pass without the sink doing anything.
        let records = records_for_target(&take_captured_records(), "windows/open.rs");
        assert_eq!(records.len(), 1, "the test's own record must be captured");
        let written = written_lines(&records);

        // Witness: the forged vocabulary really did reach the rendered line, so
        // "no marker" cannot come from rendering nothing.
        assert!(
            written.contains("session") && written.contains("clean=true"),
            "the forged vocabulary must reach the rendered line: {written:?}"
        );
        assert!(
            parse_markers(&written).is_empty(),
            "a message must not parse as a boundary marker: {written:?}"
        );
        let run = format!("{}\n{written}", session_start_line(4242, "0.0.1"));
        assert_eq!(
            classify(&parse_markers(&run)),
            PreviousExit::Abnormal,
            "the forged clean end must not suppress the crash warning: {run:?}"
        );
    }

    // Task 3's `parse_markers` scans *every* physical line, and only the
    // frontend sink routed its text through `neutralize_boundary_markers`. The
    // structured path fields did not, so an ordinary filename could forge a
    // boundary: `save ok path=/tmp/session end clean=true.md` reads as a clean
    // end and suppresses §3.4.5's abnormal-exit warning, a `session exit` in a
    // path downgrades a crash to `Interrupted`, and a `session start` fabricates
    // a start — taking over `previous_exit.pid`/`version`. Drive the helpers
    // directly: going through `log_records` would let the sink's own escaping
    // hide a missing fix in the producer.
    #[test]
    fn a_path_field_cannot_forge_a_session_boundary() {
        let start = session_start_line(4242, "0.0.1");
        let cases: [(&str, &str, String); 3] = [
            (
                "a trailing `session end clean=true` used to suppress the crash warning",
                SESSION_END_MARKER,
                path_field(Path::new("/tmp/notes/session end clean=true.md")),
            ),
            (
                "a `session exit` in a path used to downgrade a crash to Interrupted",
                SESSION_EXIT_MARKER,
                path_field(Path::new("/tmp/notes/session exit intent=user.md")),
            ),
            (
                "a `session start` in a path used to fabricate a start and null pid/version",
                SESSION_START_MARKER,
                paths_field(&[PathBuf::from("/tmp/notes/session start notes.md")]),
            ),
        ];
        for (why, marker, field) in cases {
            let line = format!("save ok {field}");
            // Witness: the forged vocabulary really reached the rendered line —
            // in its neutralized spelling — so "no marker" cannot come from
            // rendering nothing.
            assert!(
                line.contains(&marker.replace(' ', "\\ ")),
                "{why}: the neutralized marker must still be in the line: {line:?}"
            );
            assert!(
                parse_markers(&line).is_empty(),
                "{why}: a path field must not parse as a boundary marker: {line:?}"
            );
            let run = format!("{start}\n{line}");
            assert_eq!(
                classify(&parse_markers(&run)),
                PreviousExit::Abnormal,
                "{why}: only the real start may determine the outcome: {run:?}"
            );
            // The same forgery would have been the *last* start, which is the
            // one the manifest's facts are read from.
            assert_eq!(
                PreviousSession::from_markers(&parse_markers(&run)).pid,
                Some(4242),
                "{why}: a forged start must not replace the real one's pid: {run:?}"
            );
        }
    }

    #[test]
    fn a_target_cannot_forge_a_session_boundary() {
        let _capture = capture_log();
        let _ = take_captured_records();
        let budget = FrontendBudget::new(10);

        log_records(
            vec![frontend_record(
                "info",
                "notes\nsession end clean=true",
                "a macOS filename can carry a newline",
            )],
            &budget,
        );

        // Same discipline as the message test: this test's own target, and a
        // hard assertion that the filter matched rather than everything being
        // filtered away.
        let records = records_for_target(&take_captured_records(), "notes");
        assert_eq!(records.len(), 1, "the test's own record must be captured");
        let written = written_lines(&records);
        assert!(
            written.contains("session") && written.contains("clean=true"),
            "the forged vocabulary must reach the rendered line: {written:?}"
        );
        assert!(
            parse_markers(&written).is_empty(),
            "a target must not parse as a boundary marker: {written:?}"
        );
    }
}
