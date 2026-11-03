use super::*;
use std::sync::Mutex;

// Serializes the tests that mutate `OMD_LOG`. Cargo runs tests on parallel
// threads, so without this the two level tests below interleave and fail
// intermittently: a `set_var` landing between another test's `set_var` and
// its assertion silently changes what that assertion reads.
static LOG_LEVEL_ENV_LOCK: Mutex<()> = Mutex::new(());

/// Everything here that touches the environment mutates `OMD_LOG`, and cargo
/// runs tests on parallel threads: a `set_var` landing between another test's
/// `set_var` and its assertion silently changes what that assertion reads.
///
/// The persisted preferences are *not* part of this problem any more. They are a
/// value (`LoggingPreferences`) the composition root passes in, so these tests
/// no longer pin `OMD_CONFIG_DIR` and no longer hold the settings-file lock —
/// level policy is exercised as a pure function.
fn level_env_guard() -> std::sync::MutexGuard<'static, ()> {
    LOG_LEVEL_ENV_LOCK.lock().unwrap()
}

/// An opted-in install without verbose mode: the baseline every level rule is
/// measured from. Written as data because that is what it now is.
fn opted_in() -> LoggingPreferences {
    LoggingPreferences {
        logging: true,
        verbose: false,
        generation: 0,
    }
}

#[test]
fn logging_is_off_until_the_user_opts_in() {
    let _guard = level_env_guard();
    // A fresh install: no settings file, so nothing is enabled.
    let fresh = logging_preferences("{}");
    assert_eq!(fresh, LoggingPreferences::off());
    assert_eq!(
        logging_preferences(r#"{"loggingEnabled":true,"loggingGeneration":7}"#).generation,
        7
    );
    assert_eq!(effective_level(fresh), log::LevelFilter::Off);

    // The env var is a maintainer's level override inside a consented install,
    // never the consent itself.
    std::env::set_var(LOG_LEVEL_ENV_VAR, "trace");
    assert_eq!(
        effective_level(fresh),
        log::LevelFilter::Off,
        "OMD_LOG must not turn logging on"
    );
    std::env::remove_var(LOG_LEVEL_ENV_VAR);

    // Only the exact boolean `true` opts in; everything else is absent.
    assert_eq!(
        logging_preferences(r#"{"loggingEnabled":"true"}"#),
        LoggingPreferences::off()
    );
    assert_eq!(
        logging_preferences(r#"{"loggingEnabled":1}"#),
        LoggingPreferences::off()
    );
    assert!(logging_preferences(r#"{"loggingEnabled":true}"#).logging);
    assert_ne!(
        effective_level(logging_preferences(r#"{"loggingEnabled":true}"#)),
        log::LevelFilter::Off
    );
    // Malformed blobs degrade to off rather than failing to configure logging.
    assert_eq!(logging_preferences("{not json"), LoggingPreferences::off());
    assert_eq!(logging_preferences(""), LoggingPreferences::off());
}

// `OMD_LOG` is the per-invocation escape hatch a maintainer reaches for on a
// support call; a typo in it must not silently change the level in either
// direction, and must not shadow the persisted preference either.
#[test]
fn effective_level_honours_the_env_var_and_ignores_nonsense() {
    let _guard = level_env_guard();

    std::env::set_var(LOG_LEVEL_ENV_VAR, "trace");
    assert_eq!(effective_level(opted_in()), log::LevelFilter::Trace);
    std::env::set_var(LOG_LEVEL_ENV_VAR, "warn");
    assert_eq!(effective_level(opted_in()), log::LevelFilter::Warn);
    // The preference is not verbose, so this is the build default.
    std::env::set_var(LOG_LEVEL_ENV_VAR, "banana");
    assert_eq!(effective_level(opted_in()), default_level());
    std::env::remove_var(LOG_LEVEL_ENV_VAR);
    assert_eq!(effective_level(opted_in()), default_level());
}

#[test]
fn effective_level_lets_the_env_var_beat_the_verbose_preference() {
    let _guard = level_env_guard();
    let verbose = LoggingPreferences {
        logging: true,
        verbose: true,
        generation: 0,
    };
    assert_eq!(
        effective_level(verbose),
        log::LevelFilter::Debug,
        "the verbose preference raises the level"
    );

    std::env::set_var(LOG_LEVEL_ENV_VAR, "warn");
    assert_eq!(
        effective_level(verbose),
        log::LevelFilter::Warn,
        "the env var must beat the verbose preference"
    );
    std::env::set_var(LOG_LEVEL_ENV_VAR, "banana");
    assert_eq!(
        effective_level(verbose),
        log::LevelFilter::Debug,
        "an unparseable env var falls through to the preference, not the build default"
    );
    std::env::remove_var(LOG_LEVEL_ENV_VAR);
    assert_eq!(effective_level(verbose), log::LevelFilter::Debug);
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
    let state = prepare_file_logging("oh-my-md", dir.path(), log::LevelFilter::Debug, |_, _| {
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
    let state = prepare_file_logging("oh-my-md", dir.path(), log::LevelFilter::Debug, |_, _| {
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
    let state = prepare_file_logging("oh-my-md", dir.path(), log::LevelFilter::Debug, |_, _| {
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

// Logging is opt-in, so installation has one more terminal state: the user has
// not agreed to anything. It must not probe, not create a directory, and not
// report itself as degraded — nothing failed.
#[test]
fn prepare_file_logging_creates_nothing_when_the_user_opted_out() {
    let dir = tempfile::tempdir().unwrap();
    let mut registrations = 0;
    let state = prepare_file_logging("oh-my-md", dir.path(), log::LevelFilter::Off, |_, _| {
        registrations += 1;
        Ok(())
    });
    assert_eq!(
        registrations, 0,
        "no plugin may be registered when opted out"
    );
    assert_eq!(state.destination, LogDestination::Off);
    assert!(!state.degraded, "opt-out is a choice, not a failure");
    assert_eq!(state.dir, PathBuf::new());
    assert!(state.file_stem.is_empty());
    assert_eq!(state.level, log::LevelFilter::Off);
}

// The serialized view is what Settings reads; `off` must travel as its own
// kind, or the UI cannot tell "you turned it off" from "it is broken".
#[test]
fn log_state_view_serializes_the_opt_out_state() {
    let json = serde_json::to_string(&LogStateView {
        degraded: false,
        dir: String::new(),
        destination: LogDestination::Off,
    })
    .unwrap();
    assert_eq!(
        json,
        r#"{"degraded":false,"dir":"","destination":{"kind":"off"}}"#
    );
}
