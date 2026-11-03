//! The diagnostics bundle: what a support request gets, and what it must not.
//!
//! Spec: `docs/superpowers/specs/2026-10-03-logging-and-diagnostics-design.md`
//! §3.7 (export-time redaction) and §3.8 (the bundle layout).

use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::logging::{LogDestination, LogState, PreviousSession};

/// Layout version recorded in `manifest.json`. A support reader keys off this,
/// not off the file list it happens to find, so it is bumped whenever an entry
/// is added, removed, or changes shape.
const BUNDLE_FORMAT_VERSION: u64 = 1;

/// The runtime facts the writer cannot derive from the log directory.
///
/// A struct rather than four more parameters because these travel together: the
/// command reads them off managed state and the persisted blobs, and the tests
/// hand-build them so every §3.8 entry can be asserted byte-for-byte.
struct BundleContext<'a> {
    /// Task 11's three-state destination. `environment.txt` reports it as-is,
    /// including the `Disabled` state where no directory may be named.
    log_state: &'a LogState,
    /// Task 4's startup determination, and the pid/version of the start line it
    /// keyed off, summarized into `manifest.json`.
    previous_session: PreviousSession,
    /// The persisted settings blob, redacted into `settings.json`.
    settings_json: &'a str,
    /// The persisted session shards, redacted into `session.json`.
    session_json: &'a str,
}

// --- §3.8 the bundle -----------------------------------------------------------

fn os_summary() -> String {
    let os = os_info::get();
    format!("{} {} ({})", os.os_type(), os.version(), os.bitness())
}

/// The webview runtime's version (WKWebView / WebView2 / WebKitGTK).
///
/// Without it a support reader cannot separate a webview regression from an app
/// bug. Failure is not fatal: an unknown version is reported as such.
fn webview_version() -> String {
    tauri::webview_version().unwrap_or_else(|_| "unknown".to_string())
}

/// Unix epoch seconds. No date/time crate is a dependency, and an epoch is the
/// honest machine-readable value a reader can format itself.
fn generated_at() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// A string field of the persisted settings blob, when it is present and a
/// string. The settings shape is owned by TypeScript, so this is read-only and
/// total: anything unexpected answers `None`.
fn settings_string(settings_json: &str, key: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(settings_json)
        .ok()?
        .get(key)?
        .as_str()
        .map(str::to_string)
}

/// Whether the persisted blob carries exactly the boolean `true` for `key`.
fn settings_bool(settings_json: &str, key: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(settings_json)
        .ok()
        .and_then(|value| value.get(key).and_then(serde_json::Value::as_bool))
        == Some(true)
}

/// The resolved log directory, or an explicit statement that there is none.
///
/// `LogState.dir` is empty in the `Disabled` state *because* no directory holds
/// this run's records. Printing `log_dir=` there would read as "your logs are at
/// <nothing>", the lie Task 11's three-state destination exists to prevent.
fn log_dir_line(state: &LogState) -> String {
    if state.destination == LogDestination::Disabled || state.dir.as_os_str().is_empty() {
        "log_dir=<none: file logging is disabled>".to_string()
    } else {
        format!("log_dir={}", state.dir.display())
    }
}

/// `environment.txt`: the facts a maintainer would otherwise have to ask for
/// (§3.8). One `key=value` per line, greppable like the startup header, and it
/// records which redaction this bundle used.
fn environment_text(context: &BundleContext<'_>, include_full_paths: bool) -> String {
    let state = context.log_state;
    [
        format!("app_version={}", env!("CARGO_PKG_VERSION")),
        format!(
            "build={}",
            if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            }
        ),
        format!("webview_version={}", webview_version()),
        format!(
            "locale={}",
            settings_string(context.settings_json, "locale").unwrap_or_else(|| "unknown".into())
        ),
        // The level the process actually ran at, carried on the managed state.
        // Never `effective_level()`: that re-reads the persisted verbose flag,
        // which the Settings toggle writes immediately, so an export after a
        // mid-session change would name a level this run never used (§3.2).
        format!("log_level={}", state.level),
        format!("log_destination={}", state.destination.kind()),
        log_dir_line(state),
        format!("degraded={}", state.degraded),
        format!(
            "verbose_logging={}",
            settings_bool(
                context.settings_json,
                crate::logging::VERBOSE_LOGGING_SETTINGS_KEY
            )
        ),
        format!("full_paths_included={include_full_paths}"),
    ]
    .join("\n")
}

/// The `*.log` files of `log_dir` that belong to `stem`: the active
/// `{stem}.log` and its `{stem}_<timestamp>.log` rotation archives, in a stable
/// order.
///
/// The stem filter is the privacy boundary, not tidiness. In
/// [`LogDestination::Fallback`] the directory is `std::env::temp_dir()` —
/// `/tmp` on Linux — so a stem-less sweep packs every unrelated application's
/// log, and whatever secrets it holds, into the user's support bundle. The
/// bundle's contract is privacy by default; only this writer's own files may
/// ship. The match is on the writer's own naming (`newest_archive`'s
/// `{stem}_` prefix and the plugin's `{stem}.log`), so a same-prefix foreign
/// name like `{stem}-notes.log` stays out too.
fn log_files(log_dir: &Path, stem: &str) -> Vec<PathBuf> {
    let mut log_files: Vec<PathBuf> = Vec::new();
    if stem.is_empty() || !log_dir.is_dir() {
        return log_files;
    }
    if let Ok(entries) = std::fs::read_dir(log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if is_own_log_name(name, stem) {
                log_files.push(path);
            }
        }
    }
    log_files.sort();
    log_files
}

/// Whether `name` is a file this writer produces: the active `{stem}.log` or a
/// rotation archive `{stem}_{YYYY-MM-DD_HH-MM-SS}.log`.
///
/// A bare `{stem}_` prefix is not enough. In the `Fallback` state the directory
/// is the shared temp directory, where `oh-my-md_notes.log` (another tool's
/// file, or a user's own export) matches the prefix and would ship in the
/// bundle. The archive shape is the plugin's own naming, so it is checked
/// exactly: 19 characters of `YYYY-MM-DD_HH-MM-SS` between the prefix and the
/// extension.
fn is_own_log_name(name: &str, stem: &str) -> bool {
    if name == format!("{stem}.log") {
        return true;
    }
    let Some(rest) = name.strip_prefix(&format!("{stem}_")) else {
        return false;
    };
    let Some(stamp) = rest.strip_suffix(".log") else {
        return false;
    };
    let mut chars = stamp.chars();
    const ARCHIVE_STAMP_CHARS: usize = 19;
    if stamp.len() != ARCHIVE_STAMP_CHARS {
        return false;
    }
    chars.all(|ch| ch.is_ascii_digit() || ch == '-' || ch == '_')
}

/// `manifest.json`, built from the entries that actually go into the zip.
///
/// The hashes are of the *redacted* bytes a reader can verify, not of the live
/// log, which never leaves the machine.
fn manifest_json(
    entries: &[(String, Vec<u8>)],
    skipped: &[serde_json::Value],
    context: &BundleContext<'_>,
) -> Result<String, String> {
    let files: Vec<serde_json::Value> = entries
        .iter()
        .map(|(name, bytes)| {
            serde_json::json!({
                "name": name,
                "size_bytes": bytes.len(),
                "blake3": blake3::hash(bytes).to_hex().to_string(),
            })
        })
        .collect();
    let manifest = serde_json::json!({
        "bundle_format_version": BUNDLE_FORMAT_VERSION,
        "generated_at": generated_at(),
        "app_version": env!("CARGO_PKG_VERSION"),
        "os": os_summary(),
        "arch": std::env::consts::ARCH,
        // The level carried on the managed state, not a fresh read of the
        // persisted flag — see `environment_text`.
        "log_level": context.log_state.level.to_string(),
        "files": files,
        // Present (and possibly empty) so a reader can tell "no logs existed"
        // from "some logs could not be read".
        "skipped_logs": skipped,
        // §3.4.5's determination, and the facts of the start line it keyed off.
        // The scanner retains the pid and version in the same traversal that
        // classified the line (`PreviousSession`), so these are read, not
        // guessed. `started_at` / `ended_at` stay null because there genuinely
        // is no source: the markers carry no timestamps and no time crate is a
        // dependency. Null there reads as "not recorded", which is the truth;
        // a fabricated value would be read as evidence.
        "previous_exit": {
            "state": context.previous_session.outcome,
            // With logging off nothing was written, so `Unknown` means "never
            // recorded", not "the evidence rotated away". Saying which keeps a
            // support reader from looking for a crash that was never observed.
            "reason": previous_exit_reason(context),
            "started_at": serde_json::Value::Null,
            "ended_at": serde_json::Value::Null,
            "pid": context.previous_session.pid,
            "version": context.previous_session.version,
        },
    });
    serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())
}

/// The human sentence for `previous_exit.reason`.
///
/// `Off` is the only branch that overrides `PreviousExit::Unknown`: it is the
/// one case where the absence of markers is explained by the user's own choice
/// rather than by rotation.
fn previous_exit_reason(context: &BundleContext<'_>) -> &'static str {
    if matches!(
        context.log_state.destination,
        LogDestination::Off | LogDestination::LevelOff
    ) {
        return crate::logging::PREVIOUS_EXIT_UNKNOWN_LOGGING_OFF;
    }
    crate::logging::previous_exit_reason(context.previous_session.outcome)
}

/// The log text, read leniently: a corrupt byte in the middle of a file must
/// not lose the rest of it. A file that cannot be opened at all answers `Err`
/// with the reason the manifest reports.
fn read_log_lossy(path: &Path) -> Result<String, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_diagnostics_bundle(
    path: &Path,
    log_dir: &Path,
    home: &str,
    include_full_paths: bool,
    context: &BundleContext<'_>,
) -> Result<(), String> {
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    entries.push((
        "version.txt".to_string(),
        env!("CARGO_PKG_VERSION").as_bytes().to_vec(),
    ));
    entries.push(("os.txt".to_string(), os_summary().into_bytes()));

    // A bundle exists for a failure investigation, so one unreadable or corrupt
    // log must not take the whole artifact with it. Unreadable files are listed
    // in the manifest instead, so a reader knows the evidence is incomplete.
    let mut combined = String::new();
    let mut skipped: Vec<serde_json::Value> = Vec::new();
    for log_path in log_files(log_dir, &context.log_state.file_stem) {
        let name = log_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("log")
            .to_string();
        let contents = match read_log_lossy(&log_path) {
            Ok(contents) => contents,
            Err(error) => {
                skipped.push(serde_json::json!({ "name": name, "reason": error }));
                continue;
            }
        };
        let redacted = redact_text_with(&contents, home, include_full_paths);
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(&redacted);
        entries.push((name, redacted.into_bytes()));
    }
    entries.push(("diagnostics.txt".to_string(), combined.into_bytes()));

    // Every entry carries the same redaction, including the ones this task adds:
    // a settings blob or a session shard holds the same paths the logs do.
    // `environment.txt` goes through its own entry point because its `log_dir=`
    // line is the writer's own statement, not third-party free text.
    entries.push((
        "environment.txt".to_string(),
        redact_text_with(
            &environment_text(context, include_full_paths),
            home,
            include_full_paths,
        )
        .into_bytes(),
    ));
    entries.push((
        "settings.json".to_string(),
        redact_text_with(context.settings_json, home, include_full_paths).into_bytes(),
    ));
    entries.push((
        "session.json".to_string(),
        redact_text_with(context.session_json, home, include_full_paths).into_bytes(),
    ));

    let manifest = manifest_json(&entries, &skipped, context)?;

    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    for (name, bytes) in &entries {
        zip.start_file(name.as_str(), options)
            .map_err(|e| e.to_string())?;
        zip.write_all(bytes).map_err(|e| e.to_string())?;
    }
    // The manifest is written last and is not one of the files it lists: a hash
    // of itself cannot be computed, and a reader can tell the two apart.
    zip.start_file("manifest.json", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(manifest.as_bytes())
        .map_err(|e| e.to_string())?;

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// The persisted session shards, raw.
///
/// Read as a file rather than through one window's shard: the bundle is a
/// whole-app artifact, and every shard holds only the paths a tab had open. A
/// missing or unreadable file answers `{}` — an export must never fail because
/// session restore has nothing to say.
fn session_json() -> String {
    std::fs::read_to_string(
        crate::workspace::config_dir().join(crate::workspace::SESSION_FILE_NAME),
    )
    .unwrap_or_else(|_| "{}".to_string())
}

#[tauri::command]
pub async fn export_diagnostics(
    app: tauri::AppHandle,
    path: String,
    include_full_paths: bool,
) -> Result<(), String> {
    // Capture everything the zipper needs before leaving the IPC thread: a
    // `tauri::State` guard is not `Send`, and a command must not hold managed
    // state across the await.
    let (log_dir, destination, degraded, file_stem, level) = {
        let state = app.state::<LogState>();
        (
            state.dir.clone(),
            state.destination,
            state.degraded,
            state.file_stem.clone(),
            state.level,
        )
    };
    // A `PreviousSession` is not `Copy`, and a `tauri::State` guard must not be
    // held across the await, so the facts are cloned out here with the rest of
    // the managed state.
    let previous_session = app.state::<crate::logging::PreviousExitState>().0.clone();
    let target = PathBuf::from(&path);

    // Redacting and hashing every log is IO-bound, and this command runs on the
    // crash path it exists for: spawn_blocking keeps the main thread serving
    // IPC (AGENTS.md, "Sync-command trap").
    tauri::async_runtime::spawn_blocking(move || {
        let home = dirs::home_dir()
            .map(|home| home.to_string_lossy().into_owned())
            .unwrap_or_default();
        let log_state = LogState {
            degraded,
            dir: log_dir.clone(),
            file_stem,
            destination,
            level,
        };
        let settings_json = crate::workspace::get_settings().unwrap_or_else(|_| "{}".to_string());
        let session_json = session_json();
        let context = BundleContext {
            log_state: &log_state,
            previous_session,
            settings_json: &settings_json,
            session_json: &session_json,
        };
        write_diagnostics_bundle(&target, &log_dir, &home, include_full_paths, &context)?;
        // Boundary: the support bundle was written; only a successful export is
        // worth a line, since a failure already surfaces to the caller.
        log::info!("diagnostics export {}", crate::logging::path_field(&target));
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| format!("diagnostics export task failed: {error}"))?
}

mod redaction;
use redaction::redact_text_with;

#[cfg(test)]
mod bundle_tests;
