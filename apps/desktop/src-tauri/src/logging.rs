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
}
