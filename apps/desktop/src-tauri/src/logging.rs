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
}
