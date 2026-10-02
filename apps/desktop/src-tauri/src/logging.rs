//! Application logging: level policy, log-directory probing, and the
//! session-boundary record used to reconstruct the previous run's outcome.
//!
//! Spec: docs/superpowers/specs/2026-10-03-logging-and-diagnostics-design.md

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

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

/// Probe file created inside the target directory and removed immediately.
pub const PROBE_FILE_PREFIX: &str = ".write_test_";

/// Session-boundary lines, written by the exit lifecycle and matched as whole
/// tokens when a log tail is scanned back. See spec §3.4.5.
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
/// level, otherwise the build default. Anything else (a filter list, a typo)
/// falls back rather than erroring — a bad env var must not change behaviour.
pub fn effective_level() -> log::LevelFilter {
    std::env::var(LOG_LEVEL_ENV_VAR)
        .ok()
        .and_then(|raw| raw.trim().parse::<log::LevelFilter>().ok())
        .unwrap_or_else(default_level)
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

/// What the rest of the app needs to know about where logs went.
pub struct LogState {
    /// True when the real log directory was unusable and the temp-dir
    /// fallback (or stdout only) is in effect. Surfaced in Settings and in
    /// the diagnostics bundle's `environment.txt`.
    pub degraded: bool,
    /// Resolved directory. The session scanner must read *this*, not a
    /// recomputed path — see spec §3.12.
    pub dir: PathBuf,
    /// Resolved file stem, passed explicitly to the plugin so the writer and
    /// the scanner cannot disagree.
    pub file_stem: String,
}

/// The stem `tauri-plugin-log` would derive on its own
/// (`app.package_info().name`, `tauri-plugin-log` `lib.rs:719`). We pass it
/// explicitly instead of relying on the default.
pub fn log_file_stem(app: &tauri::AppHandle) -> String {
    app.package_info().name.clone()
}

fn plugin(stem: &str, dir: &Path) -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_log::Builder::new()
        .level(effective_level())
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

    // An unresolvable log directory is the same class of failure as an
    // unwritable one: the real destination is unusable. Treating it as
    // "usable, just at the fallback path" would register the fallback
    // directory under the *real* stem and report `degraded: false`, naming a
    // directory the real configuration never chose — §3.9 defines degraded
    // logging as `temp_dir()/<app>-{pid}.log`.
    match app.path().app_log_dir() {
        Ok(real_dir) => {
            if let Err(e) = std::fs::create_dir_all(&real_dir) {
                eprintln!("omd: could not create log directory {real_dir:?}: {e}");
            }

            if probe_writable(&real_dir) {
                match app.plugin(plugin(&stem, &real_dir)) {
                    Ok(()) => {
                        return LogState {
                            degraded: false,
                            dir: real_dir,
                            file_stem: stem,
                        }
                    }
                    Err(e) => eprintln!("omd: log plugin failed in {real_dir:?}: {e}"),
                }
            } else {
                eprintln!("omd: log directory {real_dir:?} is not writable; falling back");
            }
        }
        Err(e) => eprintln!("omd: could not resolve a log directory ({e}); falling back"),
    }

    let fallback = fallback_dir();
    let fallback_stem = fallback_file_stem();
    if let Err(e) = app.plugin(plugin(&fallback_stem, &fallback)) {
        // Degraded to stdout only. The app still starts; the user is not
        // silently logging into the void — Settings reports this.
        eprintln!("omd: fallback logging failed in {fallback:?}: {e}");
    }

    LogState {
        degraded: true,
        dir: fallback,
        file_stem: fallback_stem,
    }
}

/// Reports whether logging degraded, for the Settings surface.
#[tauri::command]
pub fn log_state(state: tauri::State<'_, LogState>) -> LogStateView {
    LogStateView {
        degraded: state.degraded,
        dir: state.dir.to_string_lossy().into_owned(),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStateView {
    pub degraded: bool,
    pub dir: String,
}

/// What the previous run did. See spec §3.4.5.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Marker {
    pub kind: MarkerKind,
    pub clean: bool,
}

/// Read at most `limit` bytes from the end of `path`, lossily decoded.
///
/// Seeking to `End(-limit)` can land inside a multi-byte UTF-8 sequence —
/// log lines contain CJK file paths, so this is not hypothetical. Decoding is
/// therefore lossy *and* the first (partial) line is dropped.
pub fn read_tail(path: &Path, limit: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};

    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(limit);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if start == 0 {
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

/// Whether `line` contains `marker` as a whole token: followed by a space or
/// by the end of the line.
///
/// The boundary is load-bearing, not defensive. Task 4 logs the human-readable
/// determination lines *after* `session start`: "previous session exited
/// cleanly" and "previous session ended abnormally" contain
/// `SESSION_EXIT_MARKER` / `SESSION_END_MARKER` as bare substrings. A
/// `line.contains(marker)` match turns those into an invented exit intent, so a
/// run that died with no exit intent at all (SIGKILL, segfault, force-kill)
/// gets reported as `Interrupted` — a system shutdown — and the `Abnormal`
/// warning this feature exists to raise never fires. Do not simplify this back
/// to `contains`. See spec §3.4.5.
fn has_marker(line: &str, marker: &str) -> bool {
    line.match_indices(marker).any(|(index, _)| {
        line[index + marker.len()..]
            .chars()
            .next()
            .is_none_or(|ch| ch == ' ')
    })
}

fn parse_markers(text: &str) -> Vec<Marker> {
    let mut markers = Vec::new();
    for line in text.lines() {
        if has_marker(line, SESSION_START_MARKER) {
            markers.push(Marker {
                kind: MarkerKind::Start,
                clean: false,
            });
        } else if has_marker(line, SESSION_END_MARKER) {
            markers.push(Marker {
                kind: MarkerKind::End,
                clean: line.contains("clean=true"),
            });
        } else if has_marker(line, SESSION_EXIT_MARKER) {
            markers.push(Marker {
                kind: MarkerKind::Exit,
                clean: false,
            });
        }
    }
    markers
}

/// Apply the spec §3.4.5 table to a merged, chronological marker list.
///
/// A clean end wins over an earlier exit intent: a user-initiated quit writes
/// *both* lines (the intent at `ExitRequested`, the end at `RunEvent::Exit`),
/// so stopping at the first marker after the start would call every clean quit
/// "interrupted" — the table's row is an intent *with no* `session end`.
pub fn classify(markers: &[Marker]) -> PreviousExit {
    let Some(start) = markers.iter().rposition(|m| m.kind == MarkerKind::Start) else {
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

/// Reconstruct the previous run's outcome from the archive and active tails.
///
/// The archive's markers are older than the active log's, so they are
/// concatenated in that order and the rule is applied to the merged sequence:
/// a session that outgrows `LOG_MAX_FILE_BYTES` keeps its start in the archive
/// and its end in the active log. Only `LOG_TAIL_READ_BYTES` of each is read.
pub fn scan_previous_session(dir: &Path, stem: &str) -> PreviousExit {
    let mut markers = Vec::new();
    if let Some(archive) = newest_archive(dir, stem) {
        markers.extend(parse_markers(&read_tail(&archive, LOG_TAIL_READ_BYTES)));
    }
    let active = dir.join(format!("{stem}.log"));
    markers.extend(parse_markers(&read_tail(&active, LOG_TAIL_READ_BYTES)));
    classify(&markers)
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
pub struct PreviousExitState(pub PreviousExit);

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

/// Reports what the previous run did, at the level `level_for_exit` picks.
///
/// The wording is load-bearing, not cosmetic. Every sentence here is written
/// *after* this run's `session start`, so the next launch's scanner reads it
/// back; each one is deliberately phrased so that it cannot be re-parsed as a
/// marker ("session exited", "session ended" — never "session exit " /
/// "session end "). Rewording one to end a marker on a space would invent an
/// exit intent and suppress the abnormal-exit warning. See `has_marker`.
pub fn log_previous_exit(outcome: PreviousExit) {
    let text = match outcome {
        PreviousExit::Clean => "previous session exited cleanly",
        PreviousExit::Interrupted => "previous session was interrupted by the system",
        PreviousExit::Abnormal => "previous session ended abnormally",
        PreviousExit::Unknown => "previous session outcome unknown (no markers in range)",
    };
    match level_for_exit(outcome) {
        None => log::debug!("{text}"),
        Some(log::Level::Warn) => log::warn!("{text}"),
        Some(_) => log::info!("{text}"),
    }
}

/// Version, OS, arch and the resolved logging destination. One line each so
/// the header is greppable.
pub fn log_startup_header(level: log::LevelFilter, state: &LogState) {
    log::info!("app started {}", env!("CARGO_PKG_VERSION"));
    log::info!(
        "environment os={} arch={} log_level={} log_dir={:?} degraded={}",
        os_info::get(),
        std::env::consts::ARCH,
        level,
        state.dir,
        state.degraded
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

#[cfg(test)]
mod tests {
    use super::*;

    // One sequential test rather than two: `set_var`/`remove_var` mutate
    // process-global state and cargo runs tests on parallel threads, so two
    // env-mutating tests interleave and fail intermittently.
    #[test]
    fn effective_level_honours_the_env_var_and_ignores_nonsense() {
        // The env override is the only input; the build default is the other.
        std::env::set_var(LOG_LEVEL_ENV_VAR, "trace");
        assert_eq!(effective_level(), log::LevelFilter::Trace);
        std::env::set_var(LOG_LEVEL_ENV_VAR, "warn");
        assert_eq!(effective_level(), log::LevelFilter::Warn);
        std::env::set_var(LOG_LEVEL_ENV_VAR, "banana");
        let expected = if cfg!(debug_assertions) {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Info
        };
        assert_eq!(effective_level(), expected);
        std::env::remove_var(LOG_LEVEL_ENV_VAR);
        assert_eq!(effective_level(), expected);
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
    #[test]
    fn log_state_view_serializes_degraded_and_dir() {
        let json = serde_json::to_string(&LogStateView {
            degraded: true,
            dir: "/tmp/logs".to_string(),
        })
        .unwrap();
        assert_eq!(json, r#"{"degraded":true,"dir":"/tmp/logs"}"#);
    }

    fn write_log(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    /// What the `log` facade receives, so the writers can be exercised without
    /// a Tauri app: the writers emit through the facade, and the facade is
    /// what the plugin's file sink records.
    static CAPTURED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

    struct CapturingLogger;

    impl log::Log for CapturingLogger {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }

        fn log(&self, record: &log::Record) {
            CAPTURED
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(record.args().to_string());
        }

        fn flush(&self) {}
    }

    fn take_captured() -> Vec<String> {
        std::mem::take(&mut *CAPTURED.lock().unwrap_or_else(|e| e.into_inner()))
    }

    // The determination line is written *after* the `session start` of the run
    // that logs it, so the next launch's scanner reads it back. Driving the
    // real writers (not copies of their strings, as
    // `parse_markers_ignores_the_determination_lines` does) means a rewording
    // that ends a marker on a space — the change that turns a crash into a
    // phantom exit intent — fails here.
    #[test]
    fn session_boundary_writers_emit_lines_the_scanner_reads_back() {
        log::set_boxed_logger(Box::new(CapturingLogger)).expect("no logger in unit tests");
        log::set_max_level(log::LevelFilter::Trace);

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
                clean: false
            }]),
            PreviousExit::Abnormal
        );
        assert_eq!(
            classify(&[
                Marker {
                    kind: Start,
                    clean: false
                },
                Marker {
                    kind: End,
                    clean: true
                },
            ]),
            PreviousExit::Clean
        );
        assert_eq!(
            classify(&[
                Marker {
                    kind: Start,
                    clean: false
                },
                Marker {
                    kind: Exit,
                    clean: false
                },
            ]),
            PreviousExit::Interrupted
        );
        // An unmatched End (start rotated out of both windows) is unknown,
        // never an accusation.
        assert_eq!(
            classify(&[Marker {
                kind: End,
                clean: true
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
                    clean: false
                },
                Marker {
                    kind: Exit,
                    clean: false
                },
                Marker {
                    kind: End,
                    clean: true
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
            scan_previous_session(dir.path(), "oh-my-md"),
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
            scan_previous_session(dir.path(), "oh-my-md"),
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
            scan_previous_session(dir.path(), "oh-my-md"),
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
            scan_previous_session(dir.path(), "oh-my-md"),
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
            scan_previous_session(dir.path(), "oh-my-md"),
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
            scan_previous_session(dir.path(), "oh-my-md"),
            PreviousExit::Interrupted
        );
    }

    #[test]
    fn scan_reports_unknown_when_no_start_survives() {
        let dir = tempfile::tempdir().unwrap();
        write_log(dir.path(), "oh-my-md.log", "session end clean=true\n");
        assert_eq!(
            scan_previous_session(dir.path(), "oh-my-md"),
            PreviousExit::Unknown
        );
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
}
