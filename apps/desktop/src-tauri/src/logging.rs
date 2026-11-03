//! Application logging: level policy, log-directory probing, and the
//! session-boundary record used to reconstruct the previous run's outcome.
//!
//! Spec: docs/superpowers/specs/2026-10-03-logging-and-diagnostics-design.md

use std::path::{Path, PathBuf};

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

/// Runtime level override, e.g. `OMD_LOG=debug`. Filter lists are ignored.
pub const LOG_LEVEL_ENV_VAR: &str = "OMD_LOG";

/// The persisted Settings key that turns logging on at all. Owned by the
/// TypeScript settings shape (`UserSettings.loggingEnabled` in `settings.ts`);
/// Rust only reads it. Default off, so a fresh install writes nothing until the
/// user opts in (Settings → Logging).
pub const LOGGING_SETTINGS_KEY: &str = "loggingEnabled";
pub const LOGGING_GENERATION_SETTINGS_KEY: &str = "loggingGeneration";

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

/// The persisted logging preferences, as data.
///
/// `logging` is the opt-in (Settings → Logging, default off); `verbose` raises
/// the level to `Debug`. Both live in the settings JSON that TypeScript owns, so
/// this struct is the *only* thing the logging module needs to know about that
/// file — it never opens it. The composition root (`lib.rs`) reads the blob once
/// and hands it over, the same way it already does for the startup window theme
/// (`startup_window_theme(raw_settings)`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoggingPreferences {
    pub logging: bool,
    pub verbose: bool,
    pub generation: u64,
}

impl LoggingPreferences {
    /// Nothing enabled: what a fresh install answers, and what an unreadable or
    /// malformed settings blob must degrade to.
    pub fn off() -> Self {
        LoggingPreferences {
            logging: false,
            verbose: false,
            generation: 0,
        }
    }
}

/// Reads the two logging keys out of the persisted settings blob.
///
/// Pure and total: no IO, and an unreadable, non-JSON, missing, or non-boolean
/// value all answer `off`. Keeping the *keys* here and the *file read* in the
/// composition root is what stops this module from depending on settings IO.
pub fn logging_preferences(raw_settings: &str) -> LoggingPreferences {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw_settings) else {
        return LoggingPreferences::off();
    };
    let flag = |key: &str| parsed.get(key).and_then(serde_json::Value::as_bool) == Some(true);
    LoggingPreferences {
        logging: flag(LOGGING_SETTINGS_KEY),
        verbose: flag(VERBOSE_LOGGING_SETTINGS_KEY),
        generation: parsed
            .get(LOGGING_GENERATION_SETTINGS_KEY)
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
    }
}

/// The level the process runs at: a pure function of the preferences, `OMD_LOG`,
/// and the build profile.
///
/// `OMD_LOG` is consulted only for an opted-in install: it is a maintainer's
/// level override, never the user's consent. Anything unparseable falls through
/// to the persisted preference instead of erroring — a typo must not silently
/// disable verbose logging, nor turn logging on.
pub fn effective_level(preferences: LoggingPreferences) -> log::LevelFilter {
    if !preferences.logging {
        return log::LevelFilter::Off;
    }
    if let Some(level) = std::env::var(LOG_LEVEL_ENV_VAR)
        .ok()
        .and_then(|raw| raw.trim().parse::<log::LevelFilter>().ok())
    {
        return level;
    }
    if preferences.verbose {
        return log::LevelFilter::Debug;
    }
    default_level()
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
    /// The user has not opted in (Settings → Logging). Nothing is written and
    /// no directory is created; this is not a failure state.
    Off,
    /// Logging was enabled in Settings, but OMD_LOG=off overrides it.
    LevelOff,
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
            LogDestination::Off => "off",
            LogDestination::LevelOff => "levelOff",
        }
    }
}

/// What the rest of the app needs to know about where logs went.
pub struct LogState {
    /// True for a destination that is not [`LogDestination::Directory`] **for a
    /// failed reason** (`Fallback` / `Disabled`). The user's own `Off` choice is
    /// not degradation and reports `false`. Surfaced in Settings and in the
    /// diagnostics bundle's `environment.txt`.
    pub degraded: bool,
    /// Resolved directory. The session scanner must read *this*, not a
    /// recomputed path — see spec §3.12. Empty when `destination` is
    /// [`LogDestination::Disabled`] (nothing could be opened) or
    /// [`LogDestination::Off`] (the user has not opted in): no directory holds
    /// this run's logs, so none may be named.
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
    // Logging is opt-in (Settings → Logging). When the level is `Off` nothing
    // is written, so the builder must not be handed a file target at all —
    // otherwise the plugin creates the log directory and an empty file before
    // the user has agreed to anything.
    let mut builder = tauri_plugin_log::Builder::new()
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
        .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal);
    if level != log::LevelFilter::Off {
        builder = builder.targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                path: dir.to_path_buf(),
                file_name: Some(stem.to_string()),
            }),
        ]);
    }
    builder.build()
}

/// The opted-out state: logging is a user choice, so this is not degradation.
/// It names no directory and carries no stem — nothing was created, so nothing
/// may be scanned, opened, or exported.
fn opted_out() -> LogState {
    LogState {
        degraded: false,
        dir: PathBuf::new(),
        file_stem: String::new(),
        destination: LogDestination::Off,
        level: log::LevelFilter::Off,
    }
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
    // The single decision point for consent: `effective_level` resolves `Off`
    // when the user has not opted in, and every caller reaches the branch
    // through this function (tests drive it with a level directly).
    if level == log::LevelFilter::Off {
        return opted_out();
    }
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
/// Registers the log plugin and the session-boundary startup choreography.
/// The setup-order comment lives on [`install_webview_termination_hook`]'s
/// sibling `setup_logging` below — kept here so `run()` reads as the happy
/// path while the load-bearing ordering stays documented at its owner.
pub fn install(app: &tauri::AppHandle, preferences: LoggingPreferences) -> LogState {
    let stem = log_file_stem(app);
    // Opted out: attach no plugin and resolve nothing on disk. The state still
    // travels (Settings must be able to say "logging is off"), but it names no
    // directory because nothing will be written.
    // Resolve the level exactly once, here, and let `LogState` carry it. The
    // plugin is configured with this value and so are the startup header and
    // the diagnostics bundle; a second `effective_level()` anywhere downstream
    // would re-read the persisted verbose flag and could name a level this run
    // never ran at (§3.2).
    //
    // `Off` is also the consent answer, so the opted-out path returns before any
    // directory is resolved or created.
    let level = effective_level(preferences);
    if level == log::LevelFilter::Off {
        let mut state = opted_out();
        if preferences.logging {
            state.destination = LogDestination::LevelOff;
        }
        return state;
    }
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

/// The logging half of `lib.rs`'s `.setup()`: install the plugin, scan the
/// previous session, write this run's boundary line, and manage the state
/// the diagnostics bundle reads back. Split out of `lib.rs` because that
/// file is growth-frozen; the order is load-bearing (spec §3.4.5 step 5):
/// the scan must run *before* our own `session start` lands in the tail,
/// or every launch would classify its own start as an abandoned session.
pub fn setup_logging(app: &tauri::AppHandle, raw_settings: &str) {
    use tauri::Manager;

    let preferences = logging_preferences(raw_settings);
    let log_state = install(app, preferences);
    let previous = if log_state.destination == LogDestination::Fallback {
        scan_previous_fallback_session(&log_state.dir, &log_state.file_stem, preferences.generation)
    } else {
        scan_previous_session(&log_state.dir, &log_state.file_stem, preferences.generation)
    };
    write_session_start(
        std::process::id(),
        env!("CARGO_PKG_VERSION"),
        preferences.generation,
    );
    log_startup_header(&log_state);
    log_previous_exit(previous.outcome);
    app.manage(PreviousExitState(previous));
    app.manage(log_state);
}

/// Reveals the resolved log directory in the OS file manager.
///
/// Reports the both-failed state as an error instead of opening a path that does
/// not exist: `LogState.dir` is empty there, and "Open Log Folder" has nothing
/// honest to open.
#[tauri::command]
pub fn open_log_dir(state: tauri::State<'_, LogState>) -> Result<(), String> {
    if matches!(
        state.destination,
        LogDestination::Off | LogDestination::LevelOff
    ) {
        return Err("logging is off; there is no log folder for this run".to_string());
    }
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

/// Rust-side process allowance over the frontend's ordinary rate limit.
/// Errors have a separate finite reserve; neither class can starve the other.
pub const LOG_FRONTEND_BUDGET_PER_SEC: u32 = 200;
pub const LOG_ERROR_BUDGET_PER_SEC: u32 = 50;
pub const LOG_MAX_BATCH_RECORDS: usize = 200;
pub const LOG_MAX_MESSAGE_CHARS: usize = 8192;
pub const LOG_MAX_TARGET_CHARS: usize = 128;

mod fields;
pub(crate) mod frontend;
mod session;

pub use fields::{escape_path_field, path_field, paths_field, unescape_path_field};
pub use frontend::FrontendBudget;
#[cfg(test)]
pub use session::PreviousExit;
pub use session::{
    log_previous_exit, note_clean_exit, note_exit_intent, previous_exit_reason,
    scan_previous_fallback_session, scan_previous_session, webview_termination_level,
    write_session_start, ExitingState, PreviousExitState, PreviousSession,
    PREVIOUS_EXIT_UNKNOWN_LOGGING_OFF,
};

/// The full logging half of `run()`'s `.setup()`, split out so the growth-
/// frozen `lib.rs` stays thin. Order inside is load-bearing (spec §3.4.5
/// step 5): install → scan the previous session → write this run's `session
/// start`. Scanning after the write would make our own start the last one in
/// the tail and report an abnormal exit on every launch.
///
/// Webview-termination hook for macOS. WebKit tears the content process down
/// on an ordinary quit, so an ungated hook reports a crash on every clean
/// exit; `ExitingState` is what keeps normal teardown at Info. Whether the
/// hook fires on normal teardown is unverified on real hardware (spec §8
/// Q1) and is a pre-release manual-QA gate, not a unit-testable fact.
#[cfg(target_os = "macos")]
pub(crate) fn install_webview_termination_hook<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    builder.on_web_content_process_terminate(|webview| {
        let exiting = webview.app_handle().state::<ExitingState>().is_exiting();
        let level = webview_termination_level(exiting);
        log::log!(
            target: "webview",
            level,
            "web content process terminated window={}",
            webview.label()
        );
    })
}

#[cfg(test)]
mod bootstrap_tests;
#[cfg(test)]
mod fields_tests;
#[cfg(test)]
mod frontend_tests;
#[cfg(test)]
mod session_tests;
#[cfg(test)]
mod test_support;
