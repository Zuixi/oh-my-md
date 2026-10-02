# Logging and Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a failure on someone else's machine diagnosable — turn an empty log file into a support artifact, and close the three channels through which failures currently escape without a trace.

**Architecture:** One `tauri-plugin-log` dispatch, written by both Rust (via the `log` facade) and TypeScript (via a narrow `log_frontend` command). The plugin is registered from inside `.setup()` so a write probe can run first and a failure can be caught instead of panicking. Session boundaries are recorded as log lines, and the previous session's outcome is reconstructed by reading the log tails at startup.

**Tech Stack:** Rust (Tauri 2.11, `log`, `tauri-plugin-log` 2.x, `zip`, `blake3`, `os_info`), TypeScript (React 19, Vitest, happy-dom).

**Spec:** `docs/superpowers/specs/2026-10-03-logging-and-diagnostics-design.md`

## Global Constraints

- **Log file name is `oh-my-md.log`** — the plugin derives it from `app.package_info().name` (`tauri-plugin-log` `lib.rs:719`, `764`, `780`). Pass it explicitly as `file_name: Some(stem)` so the writer and the scanner can never disagree.
- **Archives are `{stem}_{YYYY-MM-DD_HH-MM-SS}.log`** (`rename_file_to_dated`, `lib.rs:280-301`). Zero-padded, so lexicographic order is chronological. Never numbered.
- **Rotation:** `LOG_MAX_FILE_BYTES = 2 * 1024 * 1024`, `LOG_KEEP_FILES = 5`, `TimezoneStrategy::UseLocal`, `FileOpenStrategy::Append`. `RotationStrategy::KeepOne` is forbidden — it *deletes* the log at 40 KB.
- **Level policy:** debug builds default to `Debug`, release to `Info`. `level_for` → `Warn` for `tao`, `wry`, `notify`, `ignore`, `hyper`, `reqwest`. `level_for` → `Info` for `tauri_runtime_wry` and `tauri_runtime`. `level_for` matches whole module-path prefixes, so a rule for `wry` does **not** cover `tauri_runtime_wry`.
- **`OMD_LOG`** overrides the compiled level at runtime (`debug`, `trace`, or a comma-separated `target=level` list).
- **Values that cross TS ↔ Rust** are defined on both sides and drift-guarded in `apps/desktop/test/crossLayerConstants.test.ts`: `LOG_MAX_FILE_BYTES` 2 MiB, `LOG_KEEP_FILES` 5, `LOG_LEVEL_ENV_VAR` `OMD_LOG`, `LOG_FRONTEND_COMMAND` `log_frontend`, `DIAGNOSTICS_BUNDLE_FORMAT_VERSION` 1, `LOG_FRONTEND_BUDGET_PER_SEC` 200, `LOG_TAIL_READ_BYTES` 65536, `LOG_PATH_FIELD_HELPERS` `path=`/`paths=`.
- **Frontend-only limits** live in `constants.ts`: `LOG_RATE_LIMIT_PER_SEC` 50, `LOG_BREAKER_DROPS` 1000, `LOG_BREAKER_WINDOW_MS` 5000, `LOG_BREAKER_COOLDOWN_MS` 30000, `LOG_ALWAYS_PASS_LEVEL` `error`.
- **`Error` always passes layers 2, 3 and 4.** Deduplication (layer 1) still applies to it. A bypassed `Error` does not count toward breaker thresholds.
- **`.setup()` must never return `Err` for a logging reason.** Tauri turns that into `panic!("Failed to setup app: {e}")` (`tauri-2.11.5` `app.rs:1475-1476`).
- **The scan must run after plugin registration and before writing our own `session start`.** Registration may rotate the file; writing first makes every launch report an abnormal exit.
- **Never log document content.** Boundary helpers take structured fields only.
- **Path fields are never hand-concatenated.** `format!("path={}", …)` and `` `path=${…}` `` are forbidden; use the helpers from Task 9.
- **No new npm dependency and no new capability for logging.** App-defined `invoke_handler` commands are not gated by the ACL.
- Repo conventions: strict TypeScript, no `any`, named exports (except framework files), `pnpm` for JS and `cargo` for Rust.

---

### Task 1: Logging module — constants, level policy, write probe

**Files:**
- Create: `apps/desktop/src-tauri/src/logging.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs:1-11` (add `mod logging;`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub const LOG_MAX_FILE_BYTES: u64`
  - `pub const LOG_KEEP_FILES: usize`
  - `pub const LOG_TAIL_READ_BYTES: u64`
  - `pub const LOG_LEVEL_ENV_VAR: &str`
  - `pub const LOG_FALLBACK_FILE_STEM: &str` (format string, `{pid}` placeholder is *not* used — see the helper)
  - `pub fn fallback_file_stem() -> String` → `format!("oh-my-md-{}", std::process::id())`
  - `pub fn fallback_dir() -> PathBuf` → `std::env::temp_dir()`
  - `pub fn effective_level() -> log::LevelFilter`
  - `pub fn probe_writable(dir: &Path) -> bool`

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src-tauri/src/logging.rs` (create the file with only the `tests` module first, so the test run fails on missing items):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_level_defaults_to_info_in_release_and_debug_when_asked() {
        // The env override is the only input; the build default is the other.
        std::env::set_var(LOG_LEVEL_ENV_VAR, "trace");
        assert_eq!(effective_level(), log::LevelFilter::Trace);
        std::env::set_var(LOG_LEVEL_ENV_VAR, "warn");
        assert_eq!(effective_level(), log::LevelFilter::Warn);
        std::env::remove_var(LOG_LEVEL_ENV_VAR);
        let expected = if cfg!(debug_assertions) {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Info
        };
        assert_eq!(effective_level(), expected);
    }

    #[test]
    fn effective_level_ignores_a_nonsense_value() {
        std::env::set_var(LOG_LEVEL_ENV_VAR, "banana");
        let expected = if cfg!(debug_assertions) {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Info
        };
        assert_eq!(effective_level(), expected);
        std::env::remove_var(LOG_LEVEL_ENV_VAR);
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
        let dir = tempfile::tempdir().unwrap();
        // 0o555 = r-xr-xr-x: metadata().permissions().readonly() is false,
        // but the process cannot create a file here. This is the case a
        // metadata check gets wrong.
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        assert!(!std::fs::metadata(dir.path()).unwrap().permissions().readonly());
        assert!(!probe_writable(dir.path()));
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml logging::`
Expected: FAIL — unresolved items `LOG_LEVEL_ENV_VAR`, `effective_level`, `probe_writable`.

- [ ] **Step 3: Write the implementation**

Prepend above the `tests` module in `apps/desktop/src-tauri/src/logging.rs`:

```rust
//! Application logging: level policy, log-directory probing, and the
//! session-boundary record used to reconstruct the previous run's outcome.
//!
//! Spec: docs/superpowers/specs/2026-10-03-logging-and-diagnostics-design.md

use std::path::{Path, PathBuf};

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
```

Add `mod logging;` to `apps/desktop/src-tauri/src/lib.rs` in the module block (alphabetical: after `mod fonts;`, before `mod menu;`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml logging::`
Expected: PASS, 5 tests (4 on non-Unix).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/logging.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat: add logging constants, level policy and a write probe"
```

---

### Task 2: Bootstrap — register the log plugin from setup, with a fallback

**Files:**
- Modify: `apps/desktop/src-tauri/src/logging.rs` (add `LogState`, `install`)
- Modify: `apps/desktop/src-tauri/src/lib.rs:975-984` (remove the builder-chain plugin), `lib.rs:990` (call `install` first in setup), `lib.rs` (`manage` the state)

**Interfaces:**
- Consumes: Task 1's constants and `probe_writable`.
- Produces:
  - `pub struct LogState { pub degraded: bool, pub dir: PathBuf, pub file_stem: String }`
  - `pub fn install(app: &tauri::AppHandle) -> LogState` — never panics; falls back once; if both fail, installs no file target.
  - `pub fn log_file_stem(app: &tauri::AppHandle) -> String`

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `logging.rs`:

```rust
    #[test]
    fn fallback_stem_is_pid_suffixed_and_distinct_from_the_real_stem() {
        let stem = fallback_file_stem();
        assert!(stem.starts_with("oh-my-md-"));
        assert!(stem.ends_with(&std::process::id().to_string()));
        assert_ne!(stem, "oh-my-md");
    }

    #[test]
    fn fallback_dir_is_the_system_temp_dir() {
        assert_eq!(fallback_dir(), std::env::temp_dir());
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml logging::`
Expected: FAIL — `fallback_file_stem`, `fallback_dir` unresolved.

(`fallback_*` are defined in Task 1; if you are implementing Task 2 in a fresh
context, confirm they exist before writing the test.)

- [ ] **Step 3: Implement `install` and `LogState`**

Add to `logging.rs`:

```rust
use tauri::Manager;

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
        .max_file_size(LOG_MAX_FILE_BYTES)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(
            LOG_KEEP_FILES,
        ))
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
    let real_dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| fallback_dir());

    if let Err(e) = std::fs::create_dir_all(&real_dir) {
        eprintln!("omd: could not create log directory {real_dir:?}: {e}");
    }

    if probe_writable(&real_dir) {
        match app.handle().plugin(plugin(&stem, &real_dir)) {
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

    let fallback = fallback_dir();
    let fallback_stem = fallback_file_stem();
    if let Err(e) = app.handle().plugin(plugin(&fallback_stem, &fallback)) {
        // Degraded to stdout only. The app still starts; the user is not
        // silently logging into the void — Settings reports this.
        eprintln!("omd: fallback logging failed in {fallback:?}: {e}");
        return LogState {
            degraded: true,
            dir: fallback,
            file_stem: fallback_stem,
        };
    }

    LogState {
        degraded: true,
        dir: fallback,
        file_stem: fallback_stem,
    }
}
```

- [ ] **Step 4: Wire it into `lib.rs`**

Delete the `.plugin(tauri_plugin_log::Builder::new() … .build())` call from the builder chain (`lib.rs:975-984`).

At the **top** of the `.setup(|app| {` closure, before the launch-argv loop:

```rust
            // Logging first: the probe needs the AppHandle, and Tauri turns a
            // setup error into a panic, so install() swallows its own failures.
            let log_state = logging::install(app.handle());
            let degraded = log_state.degraded;
            app.manage(log_state);
```

Then add to the `invoke_handler` list (near `diagnostics::export_diagnostics`):

```rust
            logging::log_state,
```

and in `logging.rs`:

```rust
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
```

- [ ] **Step 5: Verify the app still builds and starts**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS.
Run: `pnpm --filter @omd/desktop tauri dev` (or `pnpm dev`), let it start, quit.
Expected: `~/Library/Logs/md.ohmy.desktop/oh-my-md.log` gains an `app started` line, and **no `tao` TRACE lines** appear for the new run.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/logging.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "fix: probe the log directory and register the logger without panicking"
```

---

### Task 3: Session scanning — tail reader and outcome classifier

**Files:**
- Modify: `apps/desktop/src-tauri/src/logging.rs`

**Interfaces:**
- Consumes: `LOG_TAIL_READ_BYTES`.
- Produces:
  - `pub const SESSION_START_MARKER: &str = "session start"`
  - `pub const SESSION_EXIT_MARKER: &str = "session exit"`
  - `pub const SESSION_END_MARKER: &str = "session end"`
  - `pub enum PreviousExit { Clean, Interrupted, Abnormal, Unknown }`
  - `pub fn read_tail(path: &Path, limit: u64) -> String`
  - `pub fn newest_archive(dir: &Path, stem: &str) -> Option<PathBuf>`
  - `pub fn classify(markers: &[Marker]) -> PreviousExit` with `pub struct Marker { pub kind: MarkerKind, pub clean: bool }` and `pub enum MarkerKind { Start, Exit, End }`
  - `pub fn scan_previous_session(dir: &Path, stem: &str) -> PreviousExit`

- [ ] **Step 1: Write the failing tests**

```rust
    fn write_log(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn read_tail_drops_the_partial_first_line_and_survives_split_utf8() {
        let dir = tempfile::tempdir().unwrap();
        // A CJK path makes the 64 KiB boundary land mid-character.
        let filler = "x".repeat(LOG_TAIL_READ_BYTES as usize - 2);
        let body = format!("{filler}笔记.md\nsession end clean=true\n");
        let path = write_log(dir.path(), "oh-my-md.log", &body);
        let tail = read_tail(&path, LOG_TAIL_READ_BYTES);
        assert!(tail.ends_with("session end clean=true\n"));
        assert!(!tail.starts_with('x'), "the partial first line must be dropped");
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
            classify(&[Marker { kind: Start, clean: false }]),
            PreviousExit::Abnormal
        );
        assert_eq!(
            classify(&[
                Marker { kind: Start, clean: false },
                Marker { kind: End, clean: true },
            ]),
            PreviousExit::Clean
        );
        assert_eq!(
            classify(&[
                Marker { kind: Start, clean: false },
                Marker { kind: Exit, clean: false },
            ]),
            PreviousExit::Interrupted
        );
        // An unmatched End (start rotated out of both windows) is unknown,
        // never an accusation.
        assert_eq!(
            classify(&[Marker { kind: End, clean: true }]),
            PreviousExit::Unknown
        );
        // The exact sequence an ordinary Cmd+Q writes: intent from
        // ExitRequested, then the clean end from RunEvent::Exit. A clean end
        // must win, or every normal quit reports as interrupted.
        assert_eq!(
            classify(&[
                Marker { kind: Start, clean: false },
                Marker { kind: Exit, clean: false },
                Marker { kind: End, clean: true },
            ]),
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml logging::`
Expected: FAIL — `read_tail`, `classify`, `scan_previous_session` unresolved.

- [ ] **Step 3: Implement**

```rust
pub const SESSION_START_MARKER: &str = "session start";
pub const SESSION_EXIT_MARKER: &str = "session exit";
pub const SESSION_END_MARKER: &str = "session end";

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

fn parse_markers(text: &str) -> Vec<Marker> {
    let mut markers = Vec::new();
    for line in text.lines() {
        if line.contains(SESSION_START_MARKER) {
            markers.push(Marker { kind: MarkerKind::Start, clean: false });
        } else if line.contains(SESSION_END_MARKER) {
            markers.push(Marker {
                kind: MarkerKind::End,
                clean: line.contains("clean=true"),
            });
        } else if line.contains(SESSION_EXIT_MARKER) {
            markers.push(Marker { kind: MarkerKind::Exit, clean: false });
        }
    }
    markers
}

/// Apply the spec §3.4.5 table to a merged, chronological marker list.
pub fn classify(markers: &[Marker]) -> PreviousExit {
    let Some(start) = markers.iter().rposition(|m| m.kind == MarkerKind::Start) else {
        return PreviousExit::Unknown;
    };
    let after = &markers[start + 1..];
    // A clean end anywhere in the tail wins. Task 4 writes BOTH an exit
    // intent (from `ExitRequested`) and a clean end (from `RunEvent::Exit`)
    // on every ordinary quit, so examining only the first following marker
    // would report every clean quit as interrupted.
    if after.iter().any(|m| m.kind == MarkerKind::End && m.clean) {
        return PreviousExit::Clean;
    }
    if after.iter().any(|m| m.kind == MarkerKind::Exit) {
        return PreviousExit::Interrupted;
    }
    PreviousExit::Abnormal
}

/// Reconstruct the previous run's outcome from the archive and active tails.
///
/// The archive's markers are older than the active log's, so they are
/// concatenated in that order and the rule is applied to the merged sequence.
pub fn scan_previous_session(dir: &Path, stem: &str) -> PreviousExit {
    let mut markers = Vec::new();
    if let Some(archive) = newest_archive(dir, stem) {
        markers.extend(parse_markers(&read_tail(&archive, LOG_TAIL_READ_BYTES)));
    }
    let active = dir.join(format!("{stem}.log"));
    markers.extend(parse_markers(&read_tail(&active, LOG_TAIL_READ_BYTES)));
    classify(&markers)
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml logging::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/logging.rs
git commit -m "feat: reconstruct the previous session outcome from log tails"
```

---

### Task 4: Wire the session record, panic hook, and environment header

**Files:**
- Modify: `apps/desktop/src-tauri/src/logging.rs` (exiting flag, header, marker writers)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (`run()`, `ExitRequested` arm, new `Exit` arm, setup)

**Interfaces:**
- Consumes: Task 3's `scan_previous_session`, `PreviousExit`.
- Produces:
  - `pub struct ExitingState(pub std::sync::atomic::AtomicBool)`
  - `pub fn note_exit_intent(app: &tauri::AppHandle, reason: &str)`
  - `pub fn note_clean_exit()`
  - `pub fn write_session_start(pid: u32, version: &str)`
  - `pub fn log_startup_header(level: log::LevelFilter, state: &LogState)`
  - `pub fn log_previous_exit(outcome: PreviousExit)`
  - `pub fn install_panic_hook()`

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn previous_exit_levels_match_the_spec_table() {
        assert_eq!(level_for_exit(PreviousExit::Clean), None);
        assert_eq!(level_for_exit(PreviousExit::Interrupted), Some(log::Level::Info));
        assert_eq!(level_for_exit(PreviousExit::Abnormal), Some(log::Level::Warn));
        assert_eq!(level_for_exit(PreviousExit::Unknown), Some(log::Level::Info));
    }

    #[test]
    fn session_start_line_carries_pid_version_and_mode() {
        let line = session_start_line(4242, "0.0.1");
        assert!(line.contains("pid=4242"));
        assert!(line.contains("version=0.0.1"));
        assert!(line.starts_with(SESSION_START_MARKER));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml logging::`
Expected: FAIL — `level_for_exit`, `session_start_line` unresolved.

- [ ] **Step 3: Implement**

```rust
use std::sync::atomic::{AtomicBool, Ordering};

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

pub fn level_for_exit(outcome: PreviousExit) -> Option<log::Level> {
    match outcome {
        PreviousExit::Clean => None,
        PreviousExit::Interrupted => Some(log::Level::Info),
        PreviousExit::Abnormal => Some(log::Level::Warn),
        PreviousExit::Unknown => Some(log::Level::Info),
    }
}

pub fn session_start_line(pid: u32, version: &str) -> String {
    let mode = if cfg!(debug_assertions) { "debug" } else { "release" };
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
```

- [ ] **Step 4: Wire into `lib.rs`**

In `run()`, before `tauri::Builder::default()`:

```rust
    logging::install_panic_hook();
```

Add `.manage(logging::ExitingState::default())` to the builder chain.

In the setup closure, immediately after `logging::install`:

```rust
            // Scan BEFORE writing our own `session start`. Writing first makes
            // the scan find a start with no end and report an abnormal exit on
            // every single launch (spec §3.12 step 5).
            let previous = logging::scan_previous_session(&log_state.dir, &log_state.file_stem);
            logging::write_session_start(std::process::id(), env!("CARGO_PKG_VERSION"));
            logging::log_startup_header(logging::effective_level(), &log_state);
            logging::log_previous_exit(previous);
            app.manage(PreviousExitState(previous));
```

with, in `logging.rs`:

```rust
/// Carries the startup determination to the diagnostics bundle (Task 12).
pub struct PreviousExitState(pub PreviousExit);
```

Replace the **first** `log::info!("app started {}", env!("CARGO_PKG_VERSION"));` at `lib.rs:1075` with nothing (the header logs it) — delete that line.

In the `RunEvent::ExitRequested { code: None, .. }` arm, as the first statement inside the `if let`:

```rust
                logging::note_exit_intent(app, "user");
```

Add a new arm to the same `run()` callback:

```rust
            if let tauri::RunEvent::Exit = event {
                logging::note_clean_exit();
            }
```

- [ ] **Step 5: Verify by observation**

Run: `pnpm dev`, let it start, then quit with Cmd+Q.
Expected, in `~/Library/Logs/md.ohmy.desktop/oh-my-md.log`:
- a `session exit intent=user` line,
- a `session end clean=true` line,
- an `environment …` line naming the level and directory.

Run: `pnpm dev`, then `kill -9 <pid>`.
Expected on the *next* start: `previous session ended abnormally` at WARN.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/logging.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat: record session boundaries and capture panics"
```

---

### Task 5: `log_frontend` command

**Files:**
- Modify: `apps/desktop/src-tauri/src/logging.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (invoke handler)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: Tauri command `log_frontend(records: Vec<FrontendRecord>) -> Result<(), String>`, where `FrontendRecord { level: String, target: String, message: String }`, plus `LOG_FRONTEND_COMMAND = "log_frontend"` and `LOG_FRONTEND_BUDGET_PER_SEC = 200`.

- [ ] **Step 1: Write the failing test**

```rust
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
        assert_eq!(json, r#"{"level":"error","target":"updates","message":"boom"}"#);
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml logging::`
Expected: FAIL — `FrontendRecord`, `parse_level`, `FrontendBudget` unresolved.

- [ ] **Step 3: Implement**

```rust
/// Command name; must match `LOG_FRONTEND_COMMAND` in constants.ts.
pub const LOG_FRONTEND_COMMAND: &str = "log_frontend";

/// Rust-side safety net over the frontend's own limits (spec §3.9 layer 4).
/// Must stay above the TS rate limit, or it silently truncates legitimate
/// logs.
pub const LOG_FRONTEND_BUDGET_PER_SEC: u32 = 200;

#[derive(serde::Deserialize, serde::Serialize)]
pub struct FrontendRecord {
    pub level: String,
    pub target: String,
    pub message: String,
}

pub fn parse_level(raw: &str) -> log::Level {
    match raw.to_ascii_lowercase().as_str() {
        "error" => log::Level::Error,
        "warn" => log::Level::Warn,
        "debug" => log::Level::Debug,
        "trace" => log::Level::Trace,
        _ => log::Level::Info,
    }
}

/// Per-window record budget. Ordering records are collapsed and counted
/// rather than silently dropped, so `Error` is never lost without a trace.
#[derive(Default)]
pub struct FrontendBudget {
    window_start: std::sync::Mutex<Option<std::time::Instant>>,
    used: std::sync::atomic::AtomicU32,
    collapsed: std::sync::atomic::AtomicU32,
    limit: u32,
}

impl FrontendBudget {
    pub fn new(limit: u32) -> Self {
        Self { limit, ..Default::default() }
    }

    fn allow(&self) -> bool {
        let now = std::time::Instant::now();
        let mut start = self.window_start.lock().unwrap_or_else(|e| e.into_inner());
        if start.is_none_or(|s| now.duration_since(s).as_secs() >= 1) {
            *start = Some(now);
            self.used.store(1, Ordering::Relaxed);
            return true;
        }
        let used = self.used.fetch_add(1, Ordering::Relaxed) + 1;
        if used > self.limit {
            self.collapsed.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        true
    }

    pub fn collapsed(&self) -> u32 {
        self.collapsed.load(Ordering::Relaxed)
    }
}

/// Frontend log sink. Batches arrive as one call so a burst costs one IPC
/// round trip rather than one per record.
#[tauri::command]
pub fn log_frontend(records: Vec<FrontendRecord>, budget: tauri::State<'_, FrontendBudget>) {
    for record in records {
        if !budget.allow() {
            continue;
        }
        let level = parse_level(&record.level);
        log::log!(target: &record.target, level, "{}", record.message);
    }
}
```

Register `.manage(logging::FrontendBudget::new(LOG_FRONTEND_BUDGET_PER_SEC))` and add `logging::log_frontend` to the invoke handler.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml logging::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/logging.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat: add a narrow log_frontend command with a per-window budget"
```

---

### Task 6: TypeScript logger facade

**Files:**
- Create: `apps/desktop/src/logger.ts`
- Modify: `apps/desktop/src/constants.ts`
- Modify: `apps/desktop/src/desktopServices.ts` (add `logRecords`)
- Create: `apps/desktop/test/logger.test.ts`
- Modify: `apps/desktop/test/crossLayerConstants.test.ts`

**Interfaces:**
- Consumes: Task 5's command and payload shape.
- Produces:
  - `export type LogLevel = "error" | "warn" | "info" | "debug" | "trace"`
  - `export interface LogRecord { level: LogLevel; target: string; message: string }`
  - `export function createLogger(deps: LoggerDeps): Logger`
  - `export interface Logger { error(target: string, message: string): void; warn(...): void; info(...): void; debug(...): void; trace(...): void; flush(): Promise<void> }`
  - `export function setGlobalLogger(logger: Logger): void`
  - `export function getGlobalLogger(): Logger`

- [ ] **Step 1: Add the constants**

In `apps/desktop/src/constants.ts`:

```ts
/** Application log file name stem; matches the Rust `log_file_stem`. */
export const LOG_FILE_STEM = "oh-my-md"

/** Rotation ceiling per file; must match Rust `LOG_MAX_FILE_BYTES`. */
export const LOG_MAX_FILE_BYTES = 2 * 1024 * 1024

/** Archived generations kept; must match Rust `LOG_KEEP_FILES`. */
export const LOG_KEEP_FILES = 5

/** Runtime level override; must match Rust `LOG_LEVEL_ENV_VAR`. */
export const LOG_LEVEL_ENV_VAR = "OMD_LOG"

/** IPC command for frontend records; must match Rust `LOG_FRONTEND_COMMAND`. */
export const LOG_FRONTEND_COMMAND = "log_frontend"

/** Diagnostics bundle format; must match the Rust writer. */
export const DIAGNOSTICS_BUNDLE_FORMAT_VERSION = 1

/** Rust-side per-window budget; must stay above LOG_RATE_LIMIT_PER_SEC. */
export const LOG_FRONTEND_BUDGET_PER_SEC = 200

/** Log tail the session scanner reads; must match Rust `LOG_TAIL_READ_BYTES`. */
export const LOG_TAIL_READ_BYTES = 64 * 1024

/** Structured path field markers; must match the Rust helpers. */
export const LOG_PATH_FIELD_HELPERS = ["path=", "paths="] as const

/** Records offered to the IPC per second. */
export const LOG_RATE_LIMIT_PER_SEC = 50

/** Drops within the window that trip the breaker. */
export const LOG_BREAKER_DROPS = 1000

/** Breaker measurement window. */
export const LOG_BREAKER_WINDOW_MS = 5000

/** How long the breaker stays open. */
export const LOG_BREAKER_COOLDOWN_MS = 30000

/** Level that always bypasses rate limiting and the breaker. */
export const LOG_ALWAYS_PASS_LEVEL = "error"
```

- [ ] **Step 2: Write the failing tests**

Create `apps/desktop/test/logger.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { createLogger, type LogRecord } from "../src/logger"
import {
  LOG_BREAKER_COOLDOWN_MS,
  LOG_BREAKER_DROPS,
  LOG_BREAKER_WINDOW_MS,
  LOG_RATE_LIMIT_PER_SEC,
} from "../src/constants"

function harness(now = { t: 0 }) {
  const batches: LogRecord[][] = []
  const logger = createLogger({
    now: () => now.t,
    send: async records => { batches.push(records) },
  })
  const sent = () => batches.flat()
  return { logger, batches, sent, now }
}

describe("logger facade", () => {
  it("collapses consecutive identical records into a repeat count", async () => {
    const { logger, sent } = harness()
    for (let i = 0; i < 5; i += 1) logger.warn("save", "retrying")
    await logger.flush()
    const records = sent()
    expect(records.filter(r => r.message === "retrying")).toHaveLength(1)
    expect(records.some(r => r.message.includes("repeated 5"))).toBe(true)
  })

  it("caps the offered rate at LOG_RATE_LIMIT_PER_SEC", async () => {
    const { logger, sent } = harness()
    for (let i = 0; i < LOG_RATE_LIMIT_PER_SEC * 3; i += 1) {
      logger.debug("tick", `distinct-${i}`)
    }
    await logger.flush()
    expect(sent().filter(r => r.message.startsWith("distinct-")).length)
      .toBeLessThanOrEqual(LOG_RATE_LIMIT_PER_SEC)
  })

  it("delivers error records while the breaker is open", async () => {
    const { logger, sent, now } = harness()
    for (let i = 0; i < LOG_BREAKER_DROPS + 10; i += 1) logger.debug("tick", `d-${i}`)
    await logger.flush()
    now.t += 100
    logger.error("boot", "fatal")
    await logger.flush()
    expect(sent().some(r => r.message === "fatal")).toBe(true)
  })

  it("still collapses repeated identical errors while the breaker is open", async () => {
    const { logger, sent } = harness()
    for (let i = 0; i < LOG_BREAKER_DROPS + 10; i += 1) logger.debug("tick", `d-${i}`)
    await logger.flush()
    for (let i = 0; i < 4; i += 1) logger.error("boot", "same failure")
    await logger.flush()
    expect(sent().filter(r => r.message.includes("same failure"))).toHaveLength(1)
  })

  it("reopens after the cooldown elapses", async () => {
    const { logger, sent, now } = harness()
    for (let i = 0; i < LOG_BREAKER_DROPS + 10; i += 1) logger.debug("tick", `d-${i}`)
    await logger.flush()
    now.t += LOG_BREAKER_COOLDOWN_MS + LOG_BREAKER_WINDOW_MS + 1
    logger.info("back", "resumed")
    await logger.flush()
    expect(sent().some(r => r.message === "resumed")).toBe(true)
  })

  it("never throws when the transport rejects", async () => {
    const logger = createLogger({
      now: () => 0,
      send: async () => { throw new Error("ipc down") },
    })
    expect(() => logger.error("x", "y")).not.toThrow()
    await expect(logger.flush()).resolves.toBeUndefined()
  })

  it("does not send an empty batch", async () => {
    const { logger, batches } = harness()
    await logger.flush()
    expect(batches).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @omd/desktop test -- logger`
Expected: FAIL — cannot resolve `../src/logger`.

- [ ] **Step 4: Implement the facade**

Create `apps/desktop/src/logger.ts`:

```ts
/**
 * Frontend logging facade.
 *
 * Four layers bound what this can cost the webview (spec §3.9):
 *   1. dedupe   — consecutive identical records collapse into a repeat count
 *   2. rate     — a token bucket caps records/second
 *   3. breaker  — enough drops and the facade goes quiet for a cooldown
 *   4. (Rust)   — a per-window budget on the command itself
 *
 * `error` bypasses 2, 3 and 4: a fatal record must survive a warnings storm.
 * Layer 1 still applies to it, so a fatal error in a render loop is not an
 * unbounded flood.
 */
import {
  LOG_ALWAYS_PASS_LEVEL,
  LOG_BREAKER_COOLDOWN_MS,
  LOG_BREAKER_DROPS,
  LOG_BREAKER_WINDOW_MS,
  LOG_RATE_LIMIT_PER_SEC,
} from "./constants"

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace"

export interface LogRecord {
  level: LogLevel
  target: string
  message: string
}

export interface Logger {
  error(target: string, message: string): void
  warn(target: string, message: string): void
  info(target: string, message: string): void
  debug(target: string, message: string): void
  trace(target: string, message: string): void
  /** Delivers everything queued. Never rejects. */
  flush(): Promise<void>
}

export interface LoggerDeps {
  send: (records: LogRecord[]) => Promise<void>
  now: () => number
  /** Mirrors to the console in dev; defaults to `import.meta.env.DEV`. */
  mirrorToConsole?: boolean
}

const LEVELS: LogLevel[] = ["error", "warn", "info", "debug", "trace"]

export function createLogger(deps: LoggerDeps): Logger {
  const mirror = deps.mirrorToConsole ?? Boolean(import.meta.env?.DEV)
  const queue: LogRecord[] = []
  let pending: { level: LogLevel; target: string; message: string; count: number } | null = null
  let inFlight: Promise<void> | null = null

  let bucketStart = deps.now()
  let bucketUsed = 0
  let dropWindowStart = deps.now()
  let drops = 0
  let openUntil = 0
  let announcedCollapse = false

  function breakerOpen(): boolean {
    return deps.now() < openUntil
  }

  function noteDrop(): void {
    const now = deps.now()
    if (now - dropWindowStart > LOG_BREAKER_WINDOW_MS) {
      dropWindowStart = now
      drops = 0
    }
    drops += 1
    if (drops >= LOG_BREAKER_DROPS) {
      openUntil = now + LOG_BREAKER_COOLDOWN_MS
      drops = 0
      dropWindowStart = now
      announcedCollapse = false
      pending = {
        level: "warn",
        target: "logger",
        message: `logging suppressed for ${LOG_BREAKER_COOLDOWN_MS}ms after ${LOG_BREAKER_DROPS} drops`,
        count: 1,
      }
    }
  }

  function takeToken(): boolean {
    const now = deps.now()
    if (now - bucketStart >= 1000) {
      bucketStart = now
      bucketUsed = 0
    }
    bucketUsed += 1
    return bucketUsed <= LOG_RATE_LIMIT_PER_SEC
  }

  function push(record: LogRecord): void {
    if (
      pending &&
      pending.level === record.level &&
      pending.target === record.target &&
      pending.message === record.message
    ) {
      pending.count += 1
      return
    }
    if (pending) {
      queue.push({
        level: pending.level,
        target: pending.target,
        message:
          pending.count > 1
            ? `${pending.message} (last message repeated ${pending.count} times)`
            : pending.message,
      })
      pending = null
    }
    pending = { ...record, count: 1 }
  }

  function emit(level: LogLevel, target: string, message: string): void {
    const isFatal = level === LOG_ALWAYS_PASS_LEVEL
    if (!isFatal) {
      if (breakerOpen()) {
        if (!announcedCollapse) {
          announcedCollapse = true
          noteDrop()
        } else {
          noteDrop()
        }
        return
      }
      if (!takeToken()) {
        noteDrop()
        return
      }
    }
    push({ level, target, message })
  }

  async function flush(): Promise<void> {
    if (inFlight) await inFlight
    if (pending) {
      queue.push({
        level: pending.level,
        target: pending.target,
        message:
          pending.count > 1
            ? `${pending.message} (last message repeated ${pending.count} times)`
            : pending.message,
      })
      pending = null
    }
    if (queue.length === 0) return
    const batch = queue.splice(0, queue.length)
    if (mirror) {
      for (const record of batch) console[record.level === "trace" ? "debug" : record.level](
        `[${record.target}] ${record.message}`,
      )
    }
    inFlight = deps
      .send(batch)
      .catch(() => { /* a lost batch must never reach the caller */ })
      .finally(() => { inFlight = null })
    await inFlight
  }

  const logger = {
    flush,
  } as Logger
  for (const level of LEVELS) {
    logger[level] = (target: string, message: string) => { emit(level, target, message) }
  }
  return logger
}

let globalLogger: Logger | null = null

export function setGlobalLogger(logger: Logger): void {
  globalLogger = logger
}

export function getGlobalLogger(): Logger {
  if (!globalLogger) {
    globalLogger = createLogger({
      now: () => Date.now(),
      send: async () => { /* no transport installed yet */ },
    })
  }
  return globalLogger
}
```

- [ ] **Step 5: Add the transport and the drift guard**

In `apps/desktop/src/desktopServices.ts`, extend the `DesktopServices` interface and object:

```ts
  logRecords?: (records: LogRecord[]) => Promise<void>
```

```ts
  logRecords: async records => {
    await invoke(LOG_FRONTEND_COMMAND, { records })
  },
```

In `apps/desktop/test/crossLayerConstants.test.ts`, add assertions that every constant in the Global Constraints list is present in `constants.ts` with the specified value, and that `LOG_FRONTEND_BUDGET_PER_SEC > LOG_RATE_LIMIT_PER_SEC`.

- [ ] **Step 6: Run to verify pass**

Run: `pnpm --filter @omd/desktop test -- logger crossLayerConstants`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/logger.ts apps/desktop/src/constants.ts apps/desktop/src/desktopServices.ts apps/desktop/test/logger.test.ts apps/desktop/test/crossLayerConstants.test.ts
git commit -m "feat: add a rate-limited frontend logging facade"
```

---

### Task 7: Global error capture and the error boundary

**Files:**
- Create: `apps/desktop/src/ErrorBoundary.tsx`
- Create: `apps/desktop/src/globalErrorHandlers.ts`
- Modify: `apps/desktop/src/main.tsx`
- Create: `apps/desktop/test/globalErrorHandlers.test.tsx`

**Interfaces:**
- Consumes: Task 6's `Logger`, `setGlobalLogger`.
- Produces:
  - `export function installGlobalErrorHandlers(logger: Logger, win?: Window): () => void`
  - `export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }>`

- [ ] **Step 1: Write the failing tests**

```tsx
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { installGlobalErrorHandlers } from "../src/globalErrorHandlers"
import { ErrorBoundary } from "../src/ErrorBoundary"

function fakeLogger() {
  const calls: string[] = []
  return {
    calls,
    logger: {
      error: (_t: string, m: string) => { calls.push(m) },
      warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
      flush: async () => {},
    },
  }
}

describe("global error handlers", () => {
  it("forwards window errors with their stack", () => {
    const { logger, calls } = fakeLogger()
    const uninstall = installGlobalErrorHandlers(logger, window)
    const event = new ErrorEvent("error", { message: "boom", error: new Error("boom") })
    window.dispatchEvent(event)
    expect(calls.some(m => m.includes("boom"))).toBe(true)
    uninstall()
  })

  it("forwards unhandled rejections", () => {
    const { logger, calls } = fakeLogger()
    const uninstall = installGlobalErrorHandlers(logger, window)
    window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", {
      promise: Promise.resolve(),
      reason: new Error("rejected"),
    }))
    expect(calls.some(m => m.includes("rejected"))).toBe(true)
    uninstall()
  })

  it("does not register twice", () => {
    const { logger, calls } = fakeLogger()
    const first = installGlobalErrorHandlers(logger, window)
    const second = installGlobalErrorHandlers(logger, window)
    window.dispatchEvent(new ErrorEvent("error", { message: "once", error: new Error("once") }))
    expect(calls.filter(m => m.includes("once"))).toHaveLength(1)
    second()
    first()
  })
})

describe("error boundary", () => {
  it("logs the error and renders a recovery surface", () => {
    const { logger, calls } = fakeLogger()
    const Boom = () => { throw new Error("render failed") }
    render(
      <ErrorBoundary logger={logger}>
        <Boom />
      </ErrorBoundary>,
    )
    expect(calls.some(m => m.includes("render failed"))).toBe(true)
    expect(screen.getByRole("alert")).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @omd/desktop test -- globalErrorHandlers`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`apps/desktop/src/globalErrorHandlers.ts`:

```ts
import type { Logger } from "./logger"

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.message}\n${value.stack ?? ""}`.trim()
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Forwards uncaught errors to the logger, bypassing the facade's flush queue:
 * the queue's timer is exactly what a dying webview never reaches.
 *
 * Tauri v2 has no synchronous IPC, so this removes the timer delay but cannot
 * guarantee delivery. The guaranteed path is the exit flush that rides the
 * existing FlushGate round.
 *
 * Idempotent: installing twice does not double-report.
 */
export function installGlobalErrorHandlers(logger: Logger, win: Window = window): () => void {
  const onError = (event: ErrorEvent) => {
    logger.error("window", `uncaught: ${event.message}\n${describe(event.error)}`)
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    logger.error("window", `unhandled rejection: ${describe(event.reason)}`)
  }
  win.addEventListener("error", onError)
  win.addEventListener("unhandledrejection", onRejection)
  return () => {
    win.removeEventListener("error", onError)
    win.removeEventListener("unhandledrejection", onRejection)
  }
}
```

`apps/desktop/src/ErrorBoundary.tsx`:

```tsx
import React from "react"
import type { Logger } from "./logger"

interface Props {
  children: React.ReactNode
  logger: Logger
  onExportDiagnostics?: () => void
}

interface State {
  failed: boolean
}

/**
 * Catches render-phase errors, logs them, and shows a recovery surface that
 * offers the diagnostics export. It must not swallow the error silently, and
 * it must not replace last-known-good document state — the document lives in
 * the editor, which this only unmounts as a last resort.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.logger.error(
      "render",
      `react error boundary: ${error.message}\n${error.stack ?? ""}\n${info.componentStack ?? ""}`,
    )
    void this.props.logger.flush()
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="omd-error-boundary">
        <p>The editor hit an unexpected error.</p>
        <button type="button" onClick={() => this.props.onExportDiagnostics?.()}>
          Export Diagnostics
        </button>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
```

- [ ] **Step 4: Wire into `main.tsx`**

```tsx
const logger = createLogger({
  now: () => Date.now(),
  send: async records => { await services.logRecords?.(records) },
})
setGlobalLogger(logger)
installGlobalErrorHandlers(logger)
```

Wrap `<App />` in `<ErrorBoundary logger={logger} onExportDiagnostics={() => void services.exportDiagnostics?.()}>`.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @omd/desktop test -- globalErrorHandlers`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/ErrorBoundary.tsx apps/desktop/src/globalErrorHandlers.ts apps/desktop/src/main.tsx apps/desktop/test/globalErrorHandlers.test.tsx
git commit -m "feat: capture uncaught frontend errors and render failures"
```

---

### Task 8: Flush the log queue on every clean exit

**Files:**
- Modify: `apps/desktop/src/App.tsx:1080-1100`
- Modify: `apps/desktop/test/App.diagnostics.test.tsx` (or a new `App.logFlush.test.tsx`)

**Interfaces:**
- Consumes: Task 6's `getGlobalLogger()`, the existing `SESSION_FLUSH_EVENT` handler.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

```tsx
it("flushes the log queue before acknowledging the session flush", async () => {
  const order: string[] = []
  const flush = vi.fn(async () => { order.push("logs") })
  setGlobalLogger({ error(){}, warn(){}, info(){}, debug(){}, trace(){}, flush })
  harness.services.sessionFlushAck = vi.fn(async () => { order.push("ack") })
  // …drive the session-flush listener…
  await waitFor(() => { expect(order).toEqual(["logs", "ack"]) })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @omd/desktop test -- logFlush`
Expected: FAIL — `flush` is not called.

- [ ] **Step 3: Implement**

In the `services.listenSessionFlush` handler in `App.tsx`, immediately before
`await services.sessionFlushAck()`:

```tsx
      // Deliver queued log records on the same round that persists session
      // state: the webview is about to be destroyed, and the facade's own
      // timer is exactly what never fires. Rust bounds the whole round at
      // SESSION_FLUSH_TIMEOUT and proceeds on timeout, so a lost log flush
      // can never trap the user in the app.
      try {
        await getGlobalLogger().flush()
      } catch {
        // A logging failure must never block the quit.
      }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @omd/desktop test -- logFlush`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/test/App.logFlush.test.tsx
git commit -m "feat: deliver queued log records before the webview is torn down"
```

---

### Task 9: Structured path fields

**Files:**
- Modify: `apps/desktop/src-tauri/src/logging.rs`
- Create: `apps/desktop/src/logPath.ts`
- Create: `apps/desktop/test/fixtures/logPathCases.json`
- Create: `apps/desktop/test/logPath.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Rust: `pub fn escape_path_field(raw: &str) -> String`, `pub fn path_field(path: &Path) -> String`, `pub fn paths_field(paths: &[PathBuf]) -> String`, `pub fn unescape_path_field(raw: &str) -> String`, macro `log_path!`
  - TS: `export function pathField(path: string): string`, `export function pathsField(paths: string[]): string`

- [ ] **Step 1: Create the shared fixture**

`apps/desktop/test/fixtures/logPathCases.json` — consumed by both languages:

```json
{
  "single": [
    { "raw": "/Users/alice/notes/a.md", "field": "path=/Users/alice/notes/a.md" },
    { "raw": "C:\\Users\\alice\\a.md", "field": "path=C:\\Users\\alice\\a.md" },
    { "raw": "/Volumes/My Vault/sub dir/笔记.md", "field": "path=/Volumes/My Vault/sub dir/笔记.md" },
    { "raw": "/tmp/we>ird.md", "field": "path=/tmp/we\\>ird.md" },
    { "raw": "/tmp/back\\slash.md", "field": "path=/tmp/back\\\\slash.md" },
    { "raw": "/tmp/br]acket.md", "field": "path=/tmp/br\\]acket.md" },
    { "raw": "/tmp/new\nline.md", "field": "path=/tmp/new\\nline.md" }
  ],
  "multi": [
    { "raw": ["/a/b.md", "/c/d.md"], "field": "paths=[/a/b.md;/c/d.md]" },
    { "raw": ["/a;semi.md"], "field": "paths=[/a\\;semi.md]" }
  ]
}
```

- [ ] **Step 2: Write the failing Rust test**

```rust
    #[test]
    fn path_fields_round_trip_the_shared_fixture() {
        let raw = std::fs::read_to_string(
            concat!(env!("CARGO_MANIFEST_DIR"), "/../test/fixtures/logPathCases.json"),
        )
        .unwrap();
        let cases: serde_json::Value = serde_json::from_str(&raw).unwrap();
        for case in cases["single"].as_array().unwrap() {
            let input = case["raw"].as_str().unwrap();
            assert_eq!(path_field(Path::new(input)), case["field"].as_str().unwrap());
            assert_eq!(unescape_path_field(input), input);
        }
        for case in cases["multi"].as_array().unwrap() {
            let inputs: Vec<PathBuf> = case["raw"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| PathBuf::from(v.as_str().unwrap()))
                .collect();
            assert_eq!(paths_field(&inputs), case["field"].as_str().unwrap());
        }
    }
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml logging::`
Expected: FAIL — `path_field`, `paths_field`, `unescape_path_field` unresolved.

- [ ] **Step 4: Implement the Rust helpers**

```rust
/// Escape a value for use inside a `path=<…>` / `paths=[…]` field.
///
/// Hand-written concatenation is forbidden — a path containing the delimiter,
/// a quote, or a newline would silently truncate the field and leak the
/// remainder past the export redactor.
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

pub fn unescape_path_field(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

pub fn path_field(path: &Path) -> String {
    format!("path={}", escape_path_field(&path.to_string_lossy()))
}

pub fn paths_field(paths: &[PathBuf]) -> String {
    let joined = paths
        .iter()
        .map(|p| escape_path_field(&p.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(";");
    format!("paths=[{joined}]")
}
```

Call sites use `logging::path_field(&p)` inside a format string. No macro is
introduced: the source-grep guard in Step 6 is what enforces the rule, and an
unused macro would be dead API (YAGNI).

- [ ] **Step 5: Write the TypeScript side and its test**

`apps/desktop/src/logPath.ts`:

```ts
const ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  ">": "\\>",
  "]": "\\]",
  ";": "\\;",
  "\n": "\\n",
  "\r": "\\r",
}

export function escapePathField(raw: string): string {
  return raw.replace(/[\\>\];\n\r]/g, ch => ESCAPES[ch] ?? ch)
}

export function pathField(path: string): string {
  return `path=${escapePathField(path)}`
}

export function pathsField(paths: readonly string[]): string {
  return `paths=[${paths.map(escapePathField).join(";")}]`
}
```

`apps/desktop/test/logPath.test.ts` reads the same fixture and asserts the same
`field` values, so the two implementations cannot drift.

- [ ] **Step 6: Add the source-grep guard**

Add to `apps/desktop/test/crossLayerConstants.test.ts` (or a small new test): walk `apps/desktop/src/**` and `apps/desktop/src-tauri/src/**`, and fail if any file outside `logPath.ts` / `logging.rs` contains a `path=` or `paths=` string literal.

- [ ] **Step 7: Run to verify pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml logging::`
Run: `pnpm --filter @omd/desktop test -- logPath crossLayerConstants`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src-tauri/src/logging.rs apps/desktop/src/logPath.ts apps/desktop/test/fixtures/logPathCases.json apps/desktop/test/logPath.test.ts apps/desktop/test/crossLayerConstants.test.ts
git commit -m "feat: add escaped structured path fields with a shared fixture"
```

---

### Task 10: Boundary instrumentation

**Files:**
- Modify: `apps/desktop/src-tauri/src/documents/coordinator.rs`, `save.rs`, `lib.rs`, `watcher.rs`
- Modify: `apps/desktop/src/recoveryWriter.ts`, `documentSaveAppBridge.ts`, `i18n/index.ts`, `App.tsx:286-292`

**Interfaces:**
- Consumes: Task 6's `getGlobalLogger()`, Task 9's `pathField`/`pathsField`.
- Produces: no new exports. Replaces the four `console.*` sites and the updater's `logFailure` sink.

- [ ] **Step 1: Route the existing frontend call sites through the facade**

Replace each of these with `getGlobalLogger()`, and delete the now-false comments:

| File | Current | Replace with |
| ---- | ------- | ------------ |
| `recoveryWriter.ts:38` (comment) | "the app has no logger yet" | delete |
| `recoveryWriter.ts:86` | `console.error(message, {…}, error)` | `getGlobalLogger().error("recovery", \`${message} ${pathField(draft.path)}\`)` |
| `App.tsx:286` (comment) | "no structured logger yet" | delete |
| `App.tsx:291` | ``console.error(`[updates] startup check failed: ${failure}`)`` | `getGlobalLogger().warn("updates", \`startup check failed: ${failure}\`)` |
| `documentSaveAppBridge.ts:83,96` | `console.error(error)` | `getGlobalLogger().error("save", String(error))` |
| `i18n/index.ts:58` | `console.warn(...)` | `getGlobalLogger().warn("i18n", \`set_menu_locale failed: ${String(e)}\`)` |
| `i18n/index.ts:72,85` | `console.warn` under DEV | `getGlobalLogger().debug("i18n", \`missing key: ${key}\`)` |

- [ ] **Step 2: Add Rust boundary lines**

One line per event, at these sites:

| Event | Site | Line |
| ----- | ---- | ---- |
| document save begin | `documents/save.rs`, before the write | `log::info!("save begin {}", logging::path_field(&path));` |
| save completed | after a successful write | `log::info!("save ok {} bytes={}", logging::path_field(&path), len);` |
| save failed | the `Err` arm | `log::error!("save failed {} error={e}", logging::path_field(&path));` |
| export written | `export.rs`, after the write | `log::info!("export ok {}", logging::path_field(&path));` |
| watcher reconcile failure | `watcher.rs:157` (exists) | keep, add the path field |
| diagnostics export | `diagnostics.rs` | `log::info!("diagnostics export {}", logging::path_field(path));` |

- [ ] **Step 3: Verify no `console.*` remains in `apps/desktop/src`**

Run: `grep -rn "console\." apps/desktop/src` — expected: only the intentional dev mirror inside `logger.ts`.

- [ ] **Step 4: Run the suites**

Run: `pnpm --filter @omd/desktop test`
Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src apps/desktop/src-tauri/src
git commit -m "refactor: route existing error paths through the logger and log boundaries"
```

---

### Task 11: Open Log Folder, the verbose toggle, and the degradation warning

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (new command), `menu.rs`
- Modify: `apps/desktop/src/desktopServices.ts`, `App.tsx`, `SettingsModal.tsx`
- Modify: `apps/desktop/src/i18n/messages/*`

**Interfaces:**
- Consumes: Task 2's `LogState`, Task 5's command.
- Produces: Tauri command `open_log_dir(app)`; menu/palette entry `open-log-folder`; service `openLogDir`.

- [ ] **Step 1: Rust command**

```rust
#[tauri::command]
fn open_log_dir(app: tauri::AppHandle, state: tauri::State<'_, logging::LogState>) -> Result<(), String> {
    tauri_plugin_opener::open_path(state.dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Menu entries**

Add `open_log_folder` to the `menu.rs` label struct beside `export_diagnostics`
(`menu.rs:87`, `160`, `230`, `473`) with zh `"打开日志目录"` and en
`"Open Log Folder"`, plus the `MENU_TO_COMMAND` entry in `commands.ts`, and
assert both labels in the existing `menu.rs` tests.

- [ ] **Step 3: Settings toggle**

Add a persisted `verboseLogging: boolean` to the settings shape, a Settings
checkbox "启用详细日志 / Enable verbose logging" with the note that it takes
effect after a restart, and a warning row shown when `logState.degraded` is
true, reading the resolved directory from the same call.

- [ ] **Step 4: Honour the toggle in Rust**

`effective_level()` reads `OMD_LOG` first, then the persisted flag:

```rust
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
```

- [ ] **Step 5: Test and verify**

Add a Rust test that the env var wins over the persisted flag; add a Vitest test
that the menu command reaches `openLogDir`.

Run: `pnpm --filter @omd/desktop test` and `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop
git commit -m "feat: add Open Log Folder, a verbose toggle and a degradation warning"
```

---

### Task 12: Enrich the diagnostics bundle and its redaction

**Files:**
- Modify: `apps/desktop/src-tauri/src/diagnostics.rs`
- Modify: `apps/desktop/src/desktopServices.ts` (pre-export notice)

**Interfaces:**
- Consumes: Task 4's `PreviousExitState`, Task 2's `LogState`.
- Produces: bundle entries per spec §3.8, and a **closed** entry set.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn bundle_entries_are_a_closed_set() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path().join("b.zip");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("oh-my-md.log"), "session end clean=true\n").unwrap();
        write_diagnostics_bundle(&bundle, &logs, dir.path().to_str().unwrap(), None).unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&bundle).unwrap()).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        assert!(names.contains(&"manifest.json".to_string()));
        assert!(names.contains(&"version.txt".to_string()));
        assert!(names.contains(&"os.txt".to_string()));
        assert!(names.contains(&"diagnostics.txt".to_string()));
        assert!(
            !names.iter().any(|n| n.contains("abnormal-exit")),
            "the previous-exit record lives in manifest.json, not its own file"
        );
    }

    #[test]
    fn redaction_collapses_outside_home_paths_and_strips_secrets() {
        let line = "open D:\\Vault\\Client Work\\a.md token=abc key=SECRET";
        let out = redact_line(line, "/Users/alice");
        assert!(!out.contains("Vault\\Client Work"), "got {out}");
        assert!(!out.contains("SECRET"));
    }

    #[test]
    fn redaction_handles_unc_and_volumes() {
        for line in [
            r"open \\server\share\a.md",
            "open /Volumes/My Vault/sub/笔记.md",
            r#"open "C:\Users\alice\My Notes\x.md""#,
        ] {
            let out = redact_line(line, "/Users/alice");
            assert!(out.contains("a.md") || out.contains("笔记.md") || out.contains("x.md"), "got {out}");
            assert!(!out.contains("My Vault"));
            assert!(!out.contains("My Notes"));
            assert!(!out.contains("server"));
        }
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml diagnostics::`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement**

Extend `write_diagnostics_bundle` with the §3.8 entries: `manifest.json` (format
version, generated-at, app version, OS/arch, level, per-file size + blake3 hash,
and a `previous_exit` object), `environment.txt` (webview version, locale,
dev/release, log dir, degraded flag), `settings.json`, `session.json`. All pass
through `redact_text` except `manifest.json`'s hashes, which are of already-redacted
bytes.

Extend `redact_line` to run the §3.7 rules in order: home → `<home>`; `file:///`
URLs → basename (existing); structured `path=<…>`/`paths=[…]` fields collapse
non-home absolute paths to `<path>/…/<basename>` after unescaping; secret-shaped
tokens (`*_KEY`, `*_TOKEN`, `*_PASSWORD`, `Authorization:`) are stripped; and a
final best-effort `Path`-based sweep over free text.

- [ ] **Step 4: Add the pre-export notice**

In `exportDiagnostics`, show a confirmation naming what will be included and
offering the opt-in "include full file paths" checkbox (default off), mapping to
an extra `include_full_paths: bool` argument on the command.

- [ ] **Step 5: Run to verify pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml diagnostics::`
Run: `pnpm --filter @omd/desktop test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/diagnostics.rs apps/desktop/src/desktopServices.ts
git commit -m "feat: enrich the diagnostics bundle and tighten export redaction"
```

---

### Task 13: Documentation maintenance

**Files:**
- Create: `docs/guides/troubleshooting.md`
- Modify: `docs/memory/known-gotchas.md`, `docs/memory/gotchas-rust.md`
- Modify: `apps/desktop/AGENTS.md`, `docs/manual-qa.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Write `docs/guides/troubleshooting.md`**

Per-platform log locations (macOS `~/Library/Logs/md.ohmy.desktop/`, Windows
`%LOCALAPPDATA%\md.ohmy.desktop\logs\`, Linux
`~/.local/share/md.ohmy.desktop/logs/`), how to enable verbose logging, how to
export a bundle, and what the `session start` / `session exit` / `session end`
lines mean.

- [ ] **Step 2: File the three gotchas**

Into `known-gotchas.md`'s tooling section (one-line index) and `gotchas-rust.md`
(full entries), per spec §11 and the plan's Global Constraints.

- [ ] **Step 3: Update `apps/desktop/AGENTS.md`**

Add the logging ownership rule, the `log_frontend` IPC contract, and the
bootstrap constraint (registered from `.setup()`; a setup error must never
propagate).

- [ ] **Step 4: Add the six manual-QA checks**

From spec §10.

- [ ] **Step 5: Run the full gate**

Run: `pnpm verify`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs apps/desktop/AGENTS.md
git commit -m "docs: add troubleshooting guidance and file the logging gotchas"
```

---

### Task 14: macOS webview-termination hook (spec §3.4.4)

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (`run()`, builder chain)
- Modify: `apps/desktop/src-tauri/src/logging.rs` (remove `#[allow(dead_code)]` from `is_exiting`)

**Interfaces:**
- Consumes: Task 4's `ExitingState` (`mark()`, `is_exiting()`).
- Produces: no new public surface.

**This task is gated on an observation, not on code.** Spec §8 open question 1 is
unresolved: nobody has confirmed whether `on_web_content_process_terminate` fires
during a *normal* quit. WebKit tears the content process down on ordinary
teardown, so an ungated hook would report a crash on **every** clean exit. The
hook is therefore only correct if the `is_exiting()` gate actually suppresses
those.

- [ ] **Step 1: Observe before implementing**

Temporarily log unconditionally from the hook and run the app three times: a
normal Cmd+Q, a Cmd+W with another window open, and a forced webview kill. Record
for each whether the hook fired and whether it fired before or after the
`session exit intent=user` line.

- [ ] **Step 2: Rule on the observation**

If the hook fires after the intent line on normal quits, the gate is load-bearing
and the hook ships as written below. If it never fires on normal quits, the gate
is defensive only and the hook may log at `Warn` unconditionally. If it fires
*before* the intent line on normal quits, **do not ship the hook** — the gate
cannot work, and the finding goes back to the spec as a design defect.

- [ ] **Step 3: Implement, gated**

```rust
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn install_webview_termination_hook(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.on_web_content_process_terminate(|webview| {
        // WebKit tears the content process down on an ordinary quit, so an
        // ungated hook reports a crash on every clean exit.
        let exiting = webview
            .app_handle()
            .state::<logging::ExitingState>()
            .is_exiting();
        if exiting {
            log::info!("webview process terminated label={}", webview.label());
        } else {
            log::error!(
                "webview process terminated unexpectedly label={}",
                webview.label()
            );
        }
    })
}
```

Wrap the builder chain in `run()` so the call is `#[cfg]`-gated for
macOS/iOS only — the method does not exist on Windows or Linux, so it must not
be referenced there.

- [ ] **Step 4: Verify**

Run: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features`
Expected: PASS with **no** dead-code warning for `is_exiting`.
Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS.
Re-run Step 1's three scenarios and confirm the gate produces `Info` on clean
quits and `Error` on a forced kill.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src
git commit -m "feat: report an unexpected webview termination as an error"
```
