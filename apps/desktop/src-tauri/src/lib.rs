mod diagnostics;
mod documents;
mod export;
mod fonts;
mod menu;
mod session_flush;
mod watcher;
mod workspace;

use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use tauri::{Emitter, Manager};

const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_ENCODED_IMAGE_BYTES: usize = MAX_IMAGE_BYTES.div_ceil(3) * 4;
const MAX_EXPORT_PNG_BYTES: usize = 20 * 1024 * 1024;
const MAX_ENCODED_EXPORT_PNG_BYTES: usize = MAX_EXPORT_PNG_BYTES.div_ceil(3) * 4;
const MAX_RECENT_FILES: usize = 10;
const ASSETS_DIR_NAME: &str = "assets";

// Mirrors the event name in apps/desktop/src/desktopServices.ts listenOpenFile.
const OPEN_FILE_EVENT: &str = "open-file";
const MAX_PENDING_OPEN_FILES: usize = 16;
static PENDING_OPEN_FILES: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

// Sync commands run on the Rust main thread, so any of them doing IO can stall
// every later command (and the window event loop) — see known-gotchas. IO-bound
// commands must be async + spawn_blocking, like the document commands already are.
#[tauri::command]
async fn watch_paths(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    if paths.len() > watcher::MAX_WATCHED_PATHS {
        return Err("too many watch paths".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Missing paths are skipped: watching is best-effort hinting, and a file
        // may legitimately not exist yet (fresh tab about to save its first copy).
        let canonical: Vec<PathBuf> = paths
            .iter()
            .filter_map(|path| std::fs::canonicalize(path).ok())
            .collect();
        watcher::set_watched_paths(&app, &canonical)
    })
    .await
    .map_err(|error| format!("watch task failed: {error}"))?
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    atomic_write(Path::new(&path), contents.as_bytes())
}

#[tauri::command]
fn write_png(path: String, base64: String) -> Result<(), String> {
    reject_export_png_path(&path)?;
    if base64.len() > MAX_ENCODED_EXPORT_PNG_BYTES {
        return Err(format!(
            "encoded export image exceeds the {} byte size limit",
            MAX_ENCODED_EXPORT_PNG_BYTES
        ));
    }
    let bytes = decode_png_base64(&base64)?;
    atomic_write(Path::new(&path), &bytes)
}

fn decode_png_base64(base64: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64)
        .map_err(|e| format!("invalid image base64: {e}"))?;
    if bytes.len() > MAX_EXPORT_PNG_BYTES {
        return Err(format!(
            "export image exceeds the {} byte size limit",
            MAX_EXPORT_PNG_BYTES
        ));
    }
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("export image must be PNG".into());
    }
    Ok(bytes)
}

fn reject_export_png_path(path: &str) -> Result<(), String> {
    let target = Path::new(path);
    if target
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("path must not contain traversal".into());
    }
    let png = target
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"));
    if png {
        Ok(())
    } else {
        Err("export image must use a .png extension".into())
    }
}

#[tauri::command]
fn set_recent_files(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    if paths.len() > MAX_RECENT_FILES {
        return Err("too many recent files".into());
    }
    for path in &paths {
        if path.is_empty()
            || Path::new(path)
                .components()
                .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
        {
            return Err("recent path is invalid".into());
        }
    }
    menu::set_recent_files(&app, &paths).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_view_menu_state(app: tauri::AppHandle, state: menu::ViewMenuState) {
    menu::set_view_state(&app, &state);
}

// The in-app theme toggle only flips a DOM attribute; the native title bar
// follows the window's own appearance, so the resolved theme must be pushed
// here. `None` (frontend "system") removes the override so the window keeps
// following the OS appearance. Window mutation stays on the main thread, which
// is why this command is deliberately sync like the menu setters.
fn window_theme_from_arg(value: &str) -> Result<tauri::Theme, String> {
    match value {
        "light" => Ok(tauri::Theme::Light),
        "dark" => Ok(tauri::Theme::Dark),
        other => Err(format!("unknown theme: {other}")),
    }
}

#[tauri::command]
fn set_window_theme(window: tauri::WebviewWindow, theme: Option<String>) -> Result<(), String> {
    let theme = match theme {
        Some(value) => Some(window_theme_from_arg(&value)?),
        None => None,
    };
    window.set_theme(theme).map_err(|e| e.to_string())
}

// Startup no-flash source of truth: the window must carry the saved theme
// before its first paint, because the webview only learns the theme after
// React loads settings over IPC (tauri-apps/tauri#6027). Anything unreadable,
// missing, or "system" maps to None so the window keeps following the OS.
fn startup_window_theme(raw_settings: &str) -> Option<tauri::Theme> {
    let value: serde_json::Value = serde_json::from_str(raw_settings).ok()?;
    window_theme_from_arg(value.get("theme")?.as_str()?).ok()
}

// In-app menubar (non-macOS) needs an explicit quit entry and a version for
// the About dialog; macOS gets both from the native app menu instead. The
// menubar quit flushes session state first — `app.exit` skips ExitRequested,
// so the flush gate must run inline before exiting.
// ---------------------------------------------------------------------------
// Automatic updates: install capability + non-destructive update flush.
//
// The coordinator (Task 4/5) asks Rust for one platform-owned capability
// result instead of scattering UA/path checks, and asks for a session-flush
// round that must NOT force exit (spec §10/§12/§13): a timed-out update flush
// aborts the install and keeps the app running, unlike an OS-driven quit.
// ---------------------------------------------------------------------------

/// Platform family the policy keys on. Derived from `cfg!(target_os)` at the
/// command site so the pure policy function stays testable on any host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UpdatePlatform {
    MacOs,
    Windows,
    Linux,
    Other,
}

/// Why an update path is restricted. Serializes camelCase to match the TS
/// union `reason?: "development" | "manualPackage" | "unsupported"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum UpdateCapabilityReason {
    /// A debug/unpackaged build — never show the updater.
    Development,
    /// Check works, but the user installs manually from the Release page
    /// (MSI, deb, rpm and other packaged Linux never consume an installer
    /// updater that would mix ownership).
    ManualPackage,
    /// Unknown platform or an unpackaged release binary; fail closed.
    Unsupported,
}

/// Wire payload for `update_capability`; the reason enum values need
/// camelCase and None must be omitted (optional in TS), guarded by the
/// serialization tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCapability {
    check: bool,
    install: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<UpdateCapabilityReason>,
}

/// The update flush reports whether the webview acked in time; it never
/// forces exit or restart. Serializes to `{ kind: "ready" | "timedOut" }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum PrepareUpdateRestartResult {
    Ready,
    TimedOut,
}

/// Pure policy inputs assembled by the `update_capability` command. Every
/// platform/installer row of the spec §13 table is a distinct combination,
/// so the policy tests pin the full table on any host.
#[derive(Debug)]
struct UpdateCapabilityRuntime {
    debug: bool,
    platform: UpdatePlatform,
    /// The actual runtime bundle type reported by
    /// `tauri::utils::platform::bundle_type()`: `None` means the process is
    /// not running from a recognized bundle artifact (dev build, plain
    /// binary, unknown). Configured `bundle.targets` are deliberately not
    /// part of the policy — `"all"` expands to NSIS on Windows, so the
    /// configured set cannot tell an actual MSI install from an NSIS one.
    bundle_type: Option<tauri::utils::config::BundleType>,
    /// macOS runtime fact: the process runs from a `.app` bundle. Kept
    /// separate because on macOS `bundle_type()` falls back to `App` even
    /// for unpackaged binaries and therefore cannot distinguish them.
    inside_macos_app: bool,
}

fn current_platform() -> UpdatePlatform {
    if cfg!(target_os = "macos") {
        UpdatePlatform::MacOs
    } else if cfg!(target_os = "windows") {
        UpdatePlatform::Windows
    } else if cfg!(target_os = "linux") {
        UpdatePlatform::Linux
    } else {
        UpdatePlatform::Other
    }
}

/// macOS runtime fact: the updater can only replace an installation that came
/// from a bundle, so a bare release binary is unpackaged and fails closed.
fn inside_macos_app_bundle() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    std::env::current_exe()
        .ok()
        .map(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"))
        .unwrap_or(false)
}

/// Install-capability policy per spec §13. Pure: every platform/installer
/// row is a distinct input combination, so tests pin the full table on any
/// host without touching Tauri globals. Windows/Linux key on the actual
/// runtime bundle type (the marker the bundler patches into the installed
/// binary) — never on configured `bundle.targets`, which cannot distinguish
/// an MSI install from an NSIS one under `targets: "all"`.
fn update_capability_policy(runtime: &UpdateCapabilityRuntime) -> UpdateCapability {
    if runtime.debug {
        return UpdateCapability {
            check: false,
            install: false,
            reason: Some(UpdateCapabilityReason::Development),
        };
    }
    let full = UpdateCapability {
        check: true,
        install: true,
        reason: None,
    };
    let check_only = UpdateCapability {
        check: true,
        install: false,
        reason: Some(UpdateCapabilityReason::ManualPackage),
    };
    let unsupported = UpdateCapability {
        check: false,
        install: false,
        reason: Some(UpdateCapabilityReason::Unsupported),
    };
    use tauri::utils::config::BundleType;
    match runtime.platform {
        UpdatePlatform::MacOs => {
            if runtime.inside_macos_app {
                full
            } else {
                unsupported
            }
        }
        UpdatePlatform::Windows => match &runtime.bundle_type {
            // Actual installer type: only an NSIS install may auto-update;
            // an actual MSI install must stay check-only so the user grabs
            // installers from the Release page (spec §13 MSI ruling).
            Some(BundleType::Nsis) => full,
            Some(BundleType::Msi) => check_only,
            // Unknown artifact (dev build, plain exe): fail closed.
            _ => unsupported,
        },
        UpdatePlatform::Linux => match &runtime.bundle_type {
            Some(BundleType::AppImage) => full,
            // Deb/rpm and other packaged Linux consume installers manually.
            Some(BundleType::Deb) | Some(BundleType::Rpm) => check_only,
            _ => unsupported,
        },
        UpdatePlatform::Other => unsupported,
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    let gate = app.state::<session_flush::FlushGate>();
    if gate.in_progress() {
        // The in-flight round's finish exits the app.
        return;
    }
    let exit_handle = app.clone();
    if gate.begin(session_flush::SESSION_FLUSH_TIMEOUT, move |_outcome| {
        exit_handle.exit(0)
    }) {
        let _ = app.emit(session_flush::SESSION_FLUSH_EVENT, ());
    } else {
        app.exit(0);
    }
}

#[tauri::command]
fn session_flush_ack(app: tauri::AppHandle) {
    app.state::<session_flush::FlushGate>().ack();
}

#[tauri::command]
fn update_capability(_app: tauri::AppHandle) -> UpdateCapability {
    let runtime = UpdateCapabilityRuntime {
        debug: cfg!(debug_assertions),
        platform: current_platform(),
        // Actual artifact the process runs from: the bundler patches a
        // bundle-type marker into each artifact's binary, so an MSI install
        // reports Msi and an NSIS install reports Nsis regardless of how
        // `bundle.targets` was configured.
        bundle_type: tauri::utils::platform::bundle_type(),
        inside_macos_app: inside_macos_app_bundle(),
    };
    update_capability_policy(&runtime)
}

#[tauri::command]
async fn prepare_update_restart(app: tauri::AppHandle) -> PrepareUpdateRestartResult {
    let gate = app.state::<session_flush::FlushGate>();
    if gate.in_progress() {
        // Another flush round is in flight (e.g. an OS-driven quit). Never
        // steal or perturb it; fail closed so the update flow aborts.
        return PrepareUpdateRestartResult::TimedOut;
    }
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let started = gate.begin(session_flush::SESSION_FLUSH_TIMEOUT, move |outcome| {
        // Update rounds never exit or restart the app: report the outcome
        // and let the caller decide. A timeout must leave the editor open.
        let _ = done_tx.send(outcome);
    });
    if !started {
        return PrepareUpdateRestartResult::TimedOut;
    }
    // Register the round before emitting: an ack racing an unregistered
    // round would no-op and stall the flush until the timeout.
    let _ = app.emit(session_flush::SESSION_FLUSH_EVENT, ());

    // Async so the webview's session_flush_ack IPC can still be processed
    // while this command waits on the gate.
    let result = tauri::async_runtime::spawn_blocking(move || {
        match done_rx.recv_timeout(session_flush::SESSION_FLUSH_TIMEOUT) {
            Ok(session_flush::FlushOutcome::Acknowledged) => PrepareUpdateRestartResult::Ready,
            Ok(session_flush::FlushOutcome::TimedOut) | Err(_) => {
                PrepareUpdateRestartResult::TimedOut
            }
        }
    })
    .await
    .unwrap_or(PrepareUpdateRestartResult::TimedOut);

    // This round kept the app running, so it must not leave the one-shot
    // "already flushed" marker behind — otherwise the next ordinary quit
    // would skip its own flush and lose the session snapshot.
    gate.consume_flushed();
    result
}

#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
fn write_image(path: String, base64: String, document_path: String) -> Result<(), String> {
    use base64::Engine;

    let target = Path::new(&path);
    let document = Path::new(&document_path);
    validate_image_target(target, document)?;
    if base64.len() > MAX_ENCODED_IMAGE_BYTES {
        return Err(format!(
            "encoded image exceeds the {} byte size limit",
            MAX_ENCODED_IMAGE_BYTES
        ));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64)
        .map_err(|e| format!("invalid image base64: {e}"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "image exceeds the {} byte size limit",
            MAX_IMAGE_BYTES
        ));
    }
    validate_image_format(target, &bytes)?;

    let assets_dir = target
        .parent()
        .ok_or_else(|| "image target must have a parent directory".to_string())?;
    std::fs::create_dir_all(assets_dir)
        .map_err(|e| format!("failed to create image assets directory: {e}"))?;
    reject_symlink_directory(assets_dir)?;
    validate_document_assets_directory(assets_dir, document)?;

    atomic_write(target, &bytes)
}

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<workspace::DirEntry>, String> {
    workspace::list_dir(path).await
}

#[tauri::command]
async fn search_markdown(
    root: String,
    query: String,
    case_sensitive: bool,
) -> Result<workspace::SearchResponse, String> {
    workspace::search_markdown(root, query, case_sensitive).await
}

#[tauri::command]
async fn list_markdown_files(root: String) -> Result<workspace::QuickOpenResponse, String> {
    workspace::list_markdown_files(root).await
}

#[tauri::command]
async fn snapshot_document(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || workspace::snapshot_document(path))
        .await
        .map_err(|error| format!("snapshot task failed: {error}"))?
}

#[tauri::command]
async fn list_snapshots(path: String) -> Result<Vec<workspace::SnapshotEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || workspace::list_snapshots(path))
        .await
        .map_err(|error| format!("snapshot listing task failed: {error}"))?
}

#[tauri::command]
async fn read_snapshot(path: String, file_name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || workspace::read_snapshot(path, file_name))
        .await
        .map_err(|error| format!("snapshot read task failed: {error}"))?
}

#[tauri::command]
async fn clear_snapshots(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || workspace::clear_snapshots(path))
        .await
        .map_err(|error| format!("snapshot clear task failed: {error}"))?
}

#[tauri::command]
async fn create_markdown(dir: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || workspace::create_markdown(dir, name))
        .await
        .map_err(|error| format!("create markdown task failed: {error}"))?
}

#[tauri::command]
async fn create_dir(dir: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || workspace::create_dir(dir, name))
        .await
        .map_err(|error| format!("create directory task failed: {error}"))?
}

#[tauri::command]
async fn rename_path(from: String, to_name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || workspace::rename_path(from, to_name))
        .await
        .map_err(|error| format!("rename path task failed: {error}"))?
}

#[tauri::command]
async fn delete_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || workspace::delete_path(path))
        .await
        .map_err(|error| format!("delete path task failed: {error}"))?
}

#[tauri::command]
async fn write_recovery(key: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || workspace::write_recovery(key, contents))
        .await
        .map_err(|error| format!("recovery write task failed: {error}"))?
}

#[tauri::command]
fn list_recoveries() -> Result<Vec<workspace::RecoveryRecord>, String> {
    workspace::list_recoveries()
}

#[tauri::command]
async fn read_recovery(key: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || workspace::read_recovery(key))
        .await
        .map_err(|error| format!("recovery read task failed: {error}"))?
}

#[tauri::command]
fn clear_recovery(key: String) -> Result<(), String> {
    workspace::clear_recovery(key)
}

#[tauri::command]
fn get_settings() -> Result<String, String> {
    workspace::get_settings()
}

#[tauri::command]
fn save_settings(contents: String) -> Result<(), String> {
    workspace::save_settings(contents)
}

#[tauri::command]
fn get_session_state() -> Result<String, String> {
    workspace::get_session_state()
}

#[tauri::command]
async fn save_session_state(contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || workspace::save_session_state(contents))
        .await
        .map_err(|error| format!("session state task failed: {error}"))?
}

#[tauri::command]
async fn allow_workspace_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri::Manager;

    // Scope grants are in-memory Mutex updates; async keeps them off the main
    // thread so openPath never queues behind another sync command.
    let directory = workspace_directory(Path::new(&path))?;
    workspace::authorize_workspace_root(&directory)?;
    app.asset_protocol_scope()
        .allow_directory(directory, true)
        .map_err(|e| format!("failed to allow workspace directory: {e}"))
}

#[tauri::command]
async fn allow_document_assets(app: tauri::AppHandle, document_path: String) -> Result<(), String> {
    use tauri::Manager;

    let directory = document_directory_for_assets(Path::new(&document_path))?;
    app.asset_protocol_scope()
        .allow_directory(directory, true)
        .map_err(|e| format!("failed to allow document assets: {e}"))
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("failed to create temporary file: {e}"))?;
    temporary
        .write_all(bytes)
        .map_err(|e| format!("failed to write temporary file: {e}"))?;
    temporary
        .flush()
        .map_err(|e| format!("failed to flush temporary file: {e}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|e| format!("failed to sync temporary file: {e}"))?;
    replace_existing(temporary, path)
        .map_err(|e| format!("failed to atomically replace destination: {e}"))?;
    Ok(())
}

/// Returns io::Error (not a formatted String) so callers that classify errors
/// by `ErrorKind` — e.g. save.rs mapping PermissionDenied to the recovery UI —
/// keep the persist-stage kind. `atomic_write`, which only reports to the user,
/// converts to String itself.
pub(crate) fn replace_existing(
    temporary: tempfile::NamedTempFile,
    path: &Path,
) -> Result<(), std::io::Error> {
    match temporary.persist(path) {
        Ok(_) => Ok(()),
        Err(first) => {
            if !cfg!(windows) {
                return Err(first.error);
            }
            // Windows can refuse to rename over a destination another handle
            // holds (indexer, antivirus); retry via a backup rename so the
            // write still lands, restoring the original if the retry fails.
            // The backup is a unique sibling (pid + nanos, mirroring the
            // `.omd-save-{pid}-{nanos}.tmp` save temps) so targets differing
            // only by extension never share one backup name.
            let backup = save_backup_path(path);
            if let Err(rename_error) = std::fs::rename(path, &backup) {
                return Err(std::io::Error::other(format!(
                    "failed to atomically replace destination: {} (backup rename failed: {})",
                    first.error, rename_error
                )));
            }
            match first.file.persist(path) {
                Ok(_) => {
                    let _ = std::fs::remove_file(&backup);
                    Ok(())
                }
                Err(retry) => {
                    let _ = std::fs::rename(&backup, path);
                    Err(retry.error)
                }
            }
        }
    }
}

fn save_backup_path(path: &Path) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    path.with_file_name(format!(".{}-{}.omd-save-backup", std::process::id(), nanos))
}

fn validate_image_target(target: &Path, document_path: &Path) -> Result<(), String> {
    if !target.is_absolute() {
        return Err("image target must be an absolute path".into());
    }
    if target
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("image target must not contain path traversal".into());
    }

    let assets_dir = target
        .parent()
        .ok_or_else(|| "image target must have a parent directory".to_string())?;
    if assets_dir.file_name().and_then(|name| name.to_str()) != Some(ASSETS_DIR_NAME) {
        return Err("image target must be a direct child of an assets directory".into());
    }

    if !document_path.is_absolute()
        || document_path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("document path must be an absolute path without traversal".into());
    }
    let expected_assets = document_path
        .parent()
        .ok_or_else(|| "document path must have a parent directory".to_string())?
        .join(ASSETS_DIR_NAME);
    if assets_dir != expected_assets {
        return Err("image target must be inside the current document's assets directory".into());
    }

    Ok(())
}

fn reject_symlink_directory(directory: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(directory)
        .map_err(|e| format!("failed to inspect image assets directory: {e}"))?;
    if metadata.file_type().is_symlink() {
        return Err("image assets directory must not be a symbolic link".into());
    }
    Ok(())
}

fn validate_document_assets_directory(
    assets_dir: &Path,
    document_path: &Path,
) -> Result<(), String> {
    let document_dir = document_path
        .parent()
        .ok_or_else(|| "document path must have a parent directory".to_string())?;
    let canonical_document_dir = std::fs::canonicalize(document_dir)
        .map_err(|e| format!("failed to resolve document directory: {e}"))?;
    let canonical_assets_dir = std::fs::canonicalize(assets_dir)
        .map_err(|e| format!("failed to resolve image assets directory: {e}"))?;
    if canonical_assets_dir != canonical_document_dir.join(ASSETS_DIR_NAME) {
        return Err("image assets directory resolves outside the document directory".into());
    }
    Ok(())
}

fn workspace_directory(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("workspace path must be an absolute path without traversal".into());
    }
    std::fs::canonicalize(path).map_err(|e| format!("failed to resolve workspace directory: {e}"))
}

fn document_directory_for_assets(document_path: &Path) -> Result<PathBuf, String> {
    if !document_path.is_absolute()
        || document_path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("document path must be an absolute path without traversal".into());
    }
    let parent = document_path
        .parent()
        .ok_or_else(|| "document path must have a parent directory".to_string())?;
    std::fs::canonicalize(parent).map_err(|e| format!("failed to resolve document directory: {e}"))
}

fn validate_image_format(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "image target must have a supported extension".to_string())?;

    let matches = match extension.as_str() {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => return Err("supported image extensions are png, jpg, jpeg, and webp".into()),
    };
    if !matches {
        return Err(format!(
            "image bytes do not match the .{extension} extension"
        ));
    }
    Ok(())
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ext.eq_ignore_ascii_case("md")
                || ext.eq_ignore_ascii_case("markdown")
                || ext.eq_ignore_ascii_case("mdx")
        })
}

fn queue_open_file(path: String) {
    if let Ok(mut pending) = PENDING_OPEN_FILES.lock() {
        if !pending.contains(&path) && pending.len() < MAX_PENDING_OPEN_FILES {
            pending.push(path);
        }
    }
}

fn record_open_file(app: &tauri::AppHandle, path: String) {
    queue_open_file(path.clone());
    let _ = app.emit(OPEN_FILE_EVENT, path);
}

fn resolve_and_record_open_arg(app: &tauri::AppHandle, raw_arg: &str, cwd: Option<&str>) {
    let clean = raw_arg
        .strip_prefix("file://")
        .unwrap_or(raw_arg)
        .trim_matches('"');
    let path = Path::new(clean);
    let resolved = if path.is_relative() {
        if let Some(base) = cwd {
            Path::new(base).join(path)
        } else if let Ok(base) = std::env::current_dir() {
            base.join(path)
        } else {
            path.to_path_buf()
        }
    } else {
        path.to_path_buf()
    };
    if is_markdown_path(&resolved) {
        let canonical = std::fs::canonicalize(&resolved)
            .unwrap_or(resolved)
            .to_string_lossy()
            .into_owned();
        record_open_file(app, canonical);
    }
}

/// Drained by the webview after mount: launch-time Opened events can fire
/// before the frontend listener is registered.
#[tauri::command]
fn take_pending_open_files() -> Vec<String> {
    PENDING_OPEN_FILES
        .lock()
        .map(|mut pending| std::mem::take(&mut *pending))
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // A second launch focuses the running window; markdown file
            // arguments open in this instance (macOS delivers the same via
            // RunEvent::Opened instead of a second process).
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            for arg in argv.iter().skip(1) {
                if !arg.starts_with('-') {
                    resolve_and_record_open_arg(app, arg, Some(&cwd));
                }
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .build(),
        )
        .manage(documents::DocumentCoordinator::default())
        .manage(documents::DocumentVersionCache::default())
        .manage(session_flush::FlushGate::default())
        .setup(|app| {
            for arg in std::env::args().skip(1) {
                if !arg.starts_with('-') {
                    resolve_and_record_open_arg(app.handle(), &arg, None);
                }
            }
            // Apply the persisted theme before the first paint; the webview's
            // set_window_theme push arrives only after React boots, which
            // leaves the title bar flashing the OS appearance at startup.
            if let Some(window) = app.get_webview_window("main") {
                let raw = workspace::get_settings().unwrap_or_default();
                if let Err(e) = window.set_theme(startup_window_theme(&raw)) {
                    log::warn!("startup window theme failed: {e}");
                }
            }
            menu::install(app)?;
            watcher::install(app.handle());
            if let Err(e) = workspace::migrate_legacy_config() {
                log::warn!("legacy config migration failed: {e}");
            }
            log::info!("app started {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Red X / Cmd+W: the webview's 1s debounced session save would be
            // torn down with the window, so flush first and destroy after.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let gate = window.app_handle().state::<session_flush::FlushGate>();
                if gate.in_progress() {
                    return;
                }
                let app = window.app_handle();
                let closing = window.clone();
                if !gate.begin(session_flush::SESSION_FLUSH_TIMEOUT, move |_outcome| {
                    let _ = closing.destroy();
                }) {
                    return;
                }
                // Begin before emit: an ack racing an unregistered round
                // would no-op and stall the close until the timeout.
                let _ = app.emit(session_flush::SESSION_FLUSH_EVENT, ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            documents::read_document,
            documents::read_document_version,
            documents::stat_document,
            documents::read_document_streaming,
            documents::save_document,
            read_file,
            write_file,
            watch_paths,
            write_png,
            write_image,
            allow_document_assets,
            list_dir,
            search_markdown,
            list_markdown_files,
            snapshot_document,
            list_snapshots,
            read_snapshot,
            clear_snapshots,
            create_markdown,
            create_dir,
            rename_path,
            delete_path,
            write_recovery,
            list_recoveries,
            read_recovery,
            clear_recovery,
            get_settings,
            save_settings,
            get_session_state,
            save_session_state,
            allow_workspace_dir,
            set_recent_files,
            set_view_menu_state,
            set_window_theme,
            update_capability,
            prepare_update_restart,
            quit_app,
            session_flush_ack,
            app_version,
            take_pending_open_files,
            diagnostics::export_diagnostics,
            menu::set_menu_locale,
            export::export_preview,
            fonts::list_system_fonts
        ])
        .build(tauri::generate_context!())
        .expect("error while building oh-my-md")
        .run(|app, event| {
            // macOS "open with"/double-click/Finder-dock drops arrive here.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { ref urls } = event {
                for url in urls {
                    let Ok(path) = url.to_file_path() else {
                        continue;
                    };
                    if !is_markdown_path(&path) {
                        continue;
                    }
                    record_open_file(app, path.to_string_lossy().into_owned());
                }
            }
            // Cmd+Q / native quit arrives as ExitRequested without per-window
            // CloseRequested. code: None marks user-initiated exits; our own
            // post-flush `app.exit(0)` carries Some and passes through.
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                let gate = app.state::<session_flush::FlushGate>();
                if gate.consume_flushed() {
                    return;
                }
                if app.webview_windows().is_empty() {
                    return;
                }
                api.prevent_exit();
                if gate.in_progress() {
                    // The window-path round destroys the last window, which
                    // re-runs this handler with `flushed` set.
                    return;
                }
                let exit_handle = app.clone();
                if !gate.begin(session_flush::SESSION_FLUSH_TIMEOUT, move |_outcome| {
                    exit_handle.exit(0)
                }) {
                    return;
                }
                let _ = app.emit(session_flush::SESSION_FLUSH_EVENT, ());
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use std::fs;
    use std::path::{Path, PathBuf};

    const PNG_BYTES: &[u8] = b"\x89PNG\r\n\x1a\n";

    fn tmp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("omd-test-{}-{}", std::process::id(), name))
    }

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn encoded(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn prepare_document(name: &str) -> (PathBuf, PathBuf) {
        let directory = tmp_path(name);
        let document = directory.join("document.md");
        fs::create_dir_all(&directory).unwrap();
        fs::write(&document, "# document").unwrap();
        (directory, document)
    }

    fn document_image(name: &str, image_name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let (directory, document) = prepare_document(name);
        let image = directory.join("assets").join(image_name);
        (directory, document, image)
    }

    #[test]
    fn write_then_read_roundtrip() {
        let path = tmp_path("roundtrip.md");
        let contents = "# 标题\n\nbody with **bold** and 🦀\n".to_string();
        write_file(path_string(&path), contents.clone()).unwrap();
        assert_eq!(read_file(path_string(&path)).unwrap(), contents);
        fs::remove_file(path).ok();
    }

    #[test]
    fn write_png_accepts_png_payload() {
        let path = tmp_path("export.png");
        write_png(path_string(&path), encoded(PNG_BYTES)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), PNG_BYTES);
        fs::remove_file(path).ok();
    }

    #[test]
    fn write_png_rejects_traversal_and_non_png() {
        assert!(write_png("/tmp/../etc/x.png".into(), encoded(PNG_BYTES)).is_err());
        assert!(write_png(path_string(&tmp_path("export.jpg")), encoded(PNG_BYTES)).is_err());
        assert!(write_png(path_string(&tmp_path("export.png")), encoded(b"not-png")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn write_file_atomically_replaces_existing_file() {
        use std::os::unix::fs::MetadataExt;

        let path = tmp_path("atomic-replace.md");
        fs::write(&path, "old").unwrap();
        let old_inode = fs::metadata(&path).unwrap().ino();

        write_file(path_string(&path), "new".into()).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_ne!(fs::metadata(&path).unwrap().ino(), old_inode);
        fs::remove_file(path).ok();
    }

    #[test]
    fn atomic_write_replaces_existing_file_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("existing.md");
        std::fs::write(&path, "old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    }

    #[test]
    fn replace_existing_preserves_persist_stage_io_error_kind() {
        // On Windows, replace_existing has special retry logic that may succeed
        // or give a different error when renaming over a directory.
        if cfg!(windows) {
            return;
        }
        use std::io::Write;

        let dir = tempfile::tempdir().unwrap();
        // Renaming a file over a directory fails at the persist (rename) stage,
        // not at temp creation, so the returned io::Error kind must survive.
        let target = dir.path().join("target-is-a-directory");
        std::fs::create_dir(&target).unwrap();
        let mut temp = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        temp.write_all(b"new").unwrap();

        let error = replace_existing(temp, &target).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::IsADirectory);
    }

    #[test]
    fn save_backup_paths_are_unique_siblings() {
        let a = save_backup_path(Path::new("/tmp/notes/note.md"));
        let b = save_backup_path(Path::new("/tmp/notes/note.txt"));
        let name =
            |p: &std::path::PathBuf| p.file_name().and_then(|n| n.to_str()).unwrap().to_owned();
        let (a_name, b_name) = (name(&a), name(&b));
        // Unique hidden siblings (pid + nanos), never the extension-clobbering
        // `with_extension` form where note.md and note.txt would collide.
        assert!(a_name.starts_with(&format!(".{}-", std::process::id())));
        assert!(a_name.ends_with(".omd-save-backup"));
        assert_ne!(a_name, b_name);
        assert_ne!(a_name, "note.omd-save-backup");
        assert_eq!(a.parent(), Some(Path::new("/tmp/notes")));
    }

    #[test]
    fn write_file_supports_unicode_paths() {
        let directory = tmp_path("原子保存-目录");
        let path = directory.join("文档-🦀.md");
        fs::create_dir_all(&directory).unwrap();

        write_file(path_string(&path), "你好，Rust".into()).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "你好，Rust");
        fs::remove_dir_all(directory).ok();
    }

    #[cfg(unix)]
    #[test]
    fn write_file_failure_preserves_original_and_leaves_no_temp_file() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tmp_path("atomic-failure");
        let path = directory.join("document.md");
        fs::create_dir_all(&directory).unwrap();
        fs::write(&path, "original").unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o555)).unwrap();

        let result = write_file(path_string(&path), "replacement".into());

        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn read_missing_file_errors() {
        assert!(read_file(path_string(&tmp_path("does-not-exist.md"))).is_err());
    }

    #[test]
    fn write_image_decodes_base64_and_creates_dirs() {
        let (directory, document, path) = document_image("image-success", "pixel.png");

        write_image(
            path_string(&path),
            encoded(PNG_BYTES),
            path_string(&document),
        )
        .unwrap();

        assert_eq!(fs::read(&path).unwrap(), PNG_BYTES);
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn write_image_accepts_jpeg_and_webp_signatures() {
        let (directory, document) = prepare_document("image-formats");
        let jpeg_path = directory.join("assets/photo.jpeg");
        let webp_path = directory.join("assets/photo.webp");
        let jpeg = b"\xff\xd8\xff\xe0jpeg";
        let webp = b"RIFF\x04\x00\x00\x00WEBP";

        write_image(
            path_string(&jpeg_path),
            encoded(jpeg),
            path_string(&document),
        )
        .unwrap();
        write_image(
            path_string(&webp_path),
            encoded(webp),
            path_string(&document),
        )
        .unwrap();

        assert_eq!(fs::read(jpeg_path).unwrap(), jpeg);
        assert_eq!(fs::read(webp_path).unwrap(), webp);
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn write_image_accepts_current_documents_assets_directory() {
        let (directory, document, image) = document_image("document-assets", "pixel.png");

        write_image(
            path_string(&image),
            encoded(PNG_BYTES),
            path_string(&document),
        )
        .unwrap();

        assert_eq!(fs::read(image).unwrap(), PNG_BYTES);
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn write_image_rejects_another_documents_assets_directory() {
        let (first_directory, document) = prepare_document("first-document");
        let second_directory = tmp_path("second-document");
        let image = second_directory.join("assets/pixel.png");

        assert!(write_image(
            path_string(&image),
            encoded(PNG_BYTES),
            path_string(&document),
        )
        .is_err());
        assert!(!image.exists());
        fs::remove_dir_all(first_directory).ok();
        fs::remove_dir_all(second_directory).ok();
    }

    #[test]
    fn write_image_rejects_path_traversal() {
        let (directory, document) = prepare_document("image-traversal");
        let path = directory.join("assets/../pixel.png");

        assert!(write_image(
            path_string(&path),
            encoded(PNG_BYTES),
            path_string(&document)
        )
        .is_err());
        assert!(!directory.join("pixel.png").exists());
        fs::remove_dir_all(directory).ok();
    }

    #[cfg(unix)]
    #[test]
    fn write_image_rejects_symlinked_assets_directory() {
        use std::os::unix::fs::symlink;

        let (directory, document) = prepare_document("symlinked-assets");
        let outside = tmp_path("symlinked-assets-outside");
        let assets = directory.join("assets");
        let image = assets.join("pixel.png");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, &assets).unwrap();

        assert!(write_image(
            path_string(&image),
            encoded(PNG_BYTES),
            path_string(&document)
        )
        .is_err());
        assert!(!outside.join("pixel.png").exists());
        fs::remove_dir_all(directory).ok();
        fs::remove_dir_all(outside).ok();
    }

    #[test]
    fn write_image_rejects_bad_base64() {
        let (directory, document, path) = document_image("bad-base64", "x.png");
        assert!(write_image(
            path_string(&path),
            "!!!not-base64!!!".into(),
            path_string(&document)
        )
        .is_err());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn write_image_rejects_unsupported_extension() {
        let (directory, document, path) = document_image("bad-extension", "x.gif");
        assert!(write_image(
            path_string(&path),
            encoded(PNG_BYTES),
            path_string(&document)
        )
        .is_err());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn write_image_rejects_mismatched_format() {
        let (directory, document, path) = document_image("bad-format", "x.jpg");
        assert!(write_image(
            path_string(&path),
            encoded(PNG_BYTES),
            path_string(&document)
        )
        .is_err());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn write_image_rejects_destination_outside_assets() {
        let (directory, document) = prepare_document("outside-assets");
        let path = directory.join("pixel.png");
        assert!(write_image(
            path_string(&path),
            encoded(PNG_BYTES),
            path_string(&document)
        )
        .is_err());
        assert!(!path.exists());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn write_image_rejects_nested_destination_inside_assets() {
        let (directory, document) = prepare_document("nested-assets");
        let path = directory.join("assets/nested/pixel.png");
        assert!(write_image(
            path_string(&path),
            encoded(PNG_BYTES),
            path_string(&document)
        )
        .is_err());
        assert!(!path.exists());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn write_image_rejects_oversized_decoded_payload() {
        let (directory, document, path) = document_image("oversized", "large.png");
        let payload = vec![0_u8; 10 * 1024 * 1024 + 1];
        assert!(write_image(
            path_string(&path),
            encoded(&payload),
            path_string(&document)
        )
        .is_err());
        assert!(!path.exists());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn document_directory_for_assets_canonicalizes_existing_parent() {
        let directory = tmp_path("asset-scope-dir");
        let document = directory.join("document.md");
        fs::create_dir_all(&directory).unwrap();
        fs::write(&document, "# document").unwrap();

        let resolved = document_directory_for_assets(&document).unwrap();
        assert_eq!(resolved, fs::canonicalize(&directory).unwrap());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn workspace_directory_canonicalizes_existing_dir() {
        let directory = tmp_path("workspace-scope-dir");
        fs::create_dir_all(&directory).unwrap();
        let resolved = workspace_directory(&directory).unwrap();
        assert_eq!(resolved, fs::canonicalize(&directory).unwrap());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn workspace_directory_rejects_traversal() {
        let directory = tmp_path("workspace-scope-traversal");
        fs::create_dir_all(&directory).unwrap();
        assert!(workspace_directory(&directory.join("..")).is_err());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn document_directory_for_assets_rejects_traversal() {
        let directory = tmp_path("asset-scope-traversal");
        fs::create_dir_all(&directory).unwrap();
        let document = directory.join("../document.md");
        assert!(document_directory_for_assets(&document).is_err());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn pending_open_files_queue_is_bounded_and_drains_once() {
        for i in 0..(MAX_PENDING_OPEN_FILES + 5) {
            queue_open_file(format!("/tmp/doc-{i}.md"));
        }

        let drained = take_pending_open_files();
        assert_eq!(drained.len(), MAX_PENDING_OPEN_FILES);
        assert_eq!(drained[0], "/tmp/doc-0.md");
        assert_eq!(
            drained[MAX_PENDING_OPEN_FILES - 1],
            format!("/tmp/doc-{}.md", MAX_PENDING_OPEN_FILES - 1)
        );
        // A drain consumes the queue; a second drain sees nothing.
        assert!(take_pending_open_files().is_empty());
    }

    #[test]
    fn window_theme_from_arg_maps_wire_values_and_rejects_unknown() {
        assert!(matches!(
            window_theme_from_arg("light"),
            Ok(tauri::Theme::Light)
        ));
        assert!(matches!(
            window_theme_from_arg("dark"),
            Ok(tauri::Theme::Dark)
        ));
        assert!(window_theme_from_arg("system").is_err());
        assert!(window_theme_from_arg("").is_err());
    }

    #[test]
    fn startup_window_theme_reads_persisted_theme_tolerantly() {
        assert!(matches!(
            startup_window_theme(r#"{"theme":"dark"}"#),
            Some(tauri::Theme::Dark)
        ));
        assert!(matches!(
            startup_window_theme(r#"{"theme":"light","fontSize":18}"#),
            Some(tauri::Theme::Light)
        ));
        // "system", absent, malformed, and non-string values all fall back to
        // following the OS rather than guessing a theme.
        assert!(startup_window_theme("{}").is_none());
        assert!(startup_window_theme(r#"{"theme":"system"}"#).is_none());
        assert!(startup_window_theme(r#"{"theme":null}"#).is_none());
        assert!(startup_window_theme(r#"{"theme":42}"#).is_none());
        assert!(startup_window_theme("not json").is_none());
        assert!(startup_window_theme("").is_none());
    }
    // ---- Automatic updates (Task 2): install capability policy + IPC shape ----

    /// Builds a pure runtime-fact input; every field mirrors what the
    /// `update_capability` command assembles at runtime.
    fn capability_runtime(
        debug: bool,
        platform: UpdatePlatform,
        bundle_type: Option<tauri::utils::config::BundleType>,
        inside_macos_app: bool,
    ) -> UpdateCapabilityRuntime {
        UpdateCapabilityRuntime {
            debug,
            platform,
            bundle_type,
            inside_macos_app,
        }
    }

    #[test]
    fn update_capability_policy_matches_product_table() {
        let full = UpdateCapability {
            check: true,
            install: true,
            reason: None,
        };
        let check_only = |reason| UpdateCapability {
            check: true,
            install: false,
            reason: Some(reason),
        };
        let disabled = |reason| UpdateCapability {
            check: false,
            install: false,
            reason: Some(reason),
        };

        use tauri::utils::config::BundleType;
        let cases: Vec<(UpdateCapabilityRuntime, UpdateCapability)> = vec![
            // Packaged macOS application (.app): yes / yes
            (
                capability_runtime(false, UpdatePlatform::MacOs, Some(BundleType::App), true),
                full,
            ),
            // Windows NSIS install: yes / yes
            (
                capability_runtime(
                    false,
                    UpdatePlatform::Windows,
                    Some(BundleType::Nsis),
                    false,
                ),
                full,
            ),
            // Windows MSI install: yes / no (open Release)
            (
                capability_runtime(false, UpdatePlatform::Windows, Some(BundleType::Msi), false),
                check_only(UpdateCapabilityReason::ManualPackage),
            ),
            // Linux AppImage: yes / yes
            (
                capability_runtime(
                    false,
                    UpdatePlatform::Linux,
                    Some(BundleType::AppImage),
                    false,
                ),
                full,
            ),
            // Linux deb package: yes / no (open Release)
            (
                capability_runtime(false, UpdatePlatform::Linux, Some(BundleType::Deb), false),
                check_only(UpdateCapabilityReason::ManualPackage),
            ),
            // Linux rpm package: yes / no (open Release)
            (
                capability_runtime(false, UpdatePlatform::Linux, Some(BundleType::Rpm), false),
                check_only(UpdateCapabilityReason::ManualPackage),
            ),
            // Development build: no / no
            (
                capability_runtime(true, UpdatePlatform::MacOs, Some(BundleType::App), true),
                disabled(UpdateCapabilityReason::Development),
            ),
            // Unpackaged macOS binary: no / no
            (
                capability_runtime(false, UpdatePlatform::MacOs, Some(BundleType::App), false),
                disabled(UpdateCapabilityReason::Unsupported),
            ),
            // Unknown platform: no / no (fail closed)
            (
                capability_runtime(false, UpdatePlatform::Other, None, false),
                disabled(UpdateCapabilityReason::Unsupported),
            ),
        ];

        for (runtime, expected) in cases {
            assert_eq!(
                update_capability_policy(&runtime),
                expected,
                "policy mismatch for {runtime:?}"
            );
        }
    }

    #[test]
    fn runtime_bundle_type_distinguishes_actual_nsis_from_actual_msi() {
        // Root-cause regression for the MSI gap: `bundle.targets: "all"`
        // expands to NSIS on Windows, so the old configured-target inference
        // reported install=true for actual MSI installations. The policy must
        // key only on the runtime bundle type, which the bundler patches into
        // the installed binary — Nsis when installed from the NSIS setup exe,
        // Msi when installed from an MSI.
        use tauri::utils::config::BundleType;

        let nsis = capability_runtime(
            false,
            UpdatePlatform::Windows,
            Some(BundleType::Nsis),
            false,
        );
        assert_eq!(
            update_capability_policy(&nsis),
            UpdateCapability {
                check: true,
                install: true,
                reason: None,
            }
        );

        let msi = capability_runtime(false, UpdatePlatform::Windows, Some(BundleType::Msi), false);
        assert_eq!(
            update_capability_policy(&msi),
            UpdateCapability {
                check: true,
                install: false,
                reason: Some(UpdateCapabilityReason::ManualPackage),
            }
        );
    }

    #[test]
    fn runtime_bundle_type_distinguishes_appimage_from_deb_and_rpm() {
        // Actual runtime bundle types decide on Linux too: an AppImage install
        // gets auto-update, while deb/rpm installs stay check-only. The old
        // implementation consulted configured targets plus the APPIMAGE env
        // var; the runtime bundle type alone is decisive.
        use tauri::utils::config::BundleType;

        let appimage = capability_runtime(
            false,
            UpdatePlatform::Linux,
            Some(BundleType::AppImage),
            false,
        );
        assert_eq!(
            update_capability_policy(&appimage),
            UpdateCapability {
                check: true,
                install: true,
                reason: None,
            }
        );

        for bundle in [BundleType::Deb, BundleType::Rpm] {
            let runtime =
                capability_runtime(false, UpdatePlatform::Linux, Some(bundle.clone()), false);
            assert_eq!(
                update_capability_policy(&runtime),
                UpdateCapability {
                    check: true,
                    install: false,
                    reason: Some(UpdateCapabilityReason::ManualPackage),
                },
                "installed Linux bundle {bundle:?} must be check-only"
            );
        }
    }

    #[test]
    fn policy_keys_only_on_runtime_bundle_type_not_configured_targets() {
        // The old inference read `bundle.targets` ("all" → [nsis] on Windows),
        // which cannot tell an actual MSI install from an NSIS one — any mixed
        // or "all" configured-target combination made the MSI row report
        // install=true. The runtime input now carries only the detected bundle
        // type; configured targets are no longer part of the policy at all.
        // This pins that contract: for a given installed artifact, the
        // capability is decided by the artifact alone.
        use tauri::utils::config::BundleType;

        for bundle in [BundleType::Nsis, BundleType::Msi] {
            let install_expectation = matches!(&bundle, BundleType::Nsis);
            let runtime =
                capability_runtime(false, UpdatePlatform::Windows, Some(bundle.clone()), false);
            let capability = update_capability_policy(&runtime);
            assert_eq!(capability.check, true);
            assert_eq!(
                capability.install, install_expectation,
                "install for Windows must follow the detected bundle type only"
            );
        }
    }

    #[test]
    fn update_capability_policy_windows_without_runtime_bundle_type_fails_closed() {
        // Unpatched binary (dev build / plain exe) on Windows: no recognized
        // bundle type → no / no.
        let runtime = capability_runtime(false, UpdatePlatform::Windows, None, false);
        assert_eq!(
            update_capability_policy(&runtime),
            UpdateCapability {
                check: false,
                install: false,
                reason: Some(UpdateCapabilityReason::Unsupported),
            }
        );
    }

    #[test]
    fn update_capability_policy_linux_without_runtime_bundle_type_fails_closed() {
        let runtime = capability_runtime(false, UpdatePlatform::Linux, None, false);
        assert_eq!(
            update_capability_policy(&runtime),
            UpdateCapability {
                check: false,
                install: false,
                reason: Some(UpdateCapabilityReason::Unsupported),
            }
        );
    }

    #[test]
    fn update_capability_policy_serializes_camel_case_fields_and_reasons() {
        // Multi-word reason values and absent-None must match the TS interface
        // (`reason?: "development" | "manualPackage" | "unsupported"`).
        let manual = UpdateCapability {
            check: true,
            install: false,
            reason: Some(UpdateCapabilityReason::ManualPackage),
        };
        assert_eq!(
            serde_json::to_string(&manual).unwrap(),
            r#"{"check":true,"install":false,"reason":"manualPackage"}"#
        );
        assert_eq!(
            serde_json::to_string(&UpdateCapability {
                check: false,
                install: false,
                reason: Some(UpdateCapabilityReason::Development),
            })
            .unwrap(),
            r#"{"check":false,"install":false,"reason":"development"}"#
        );
        // None must omit the field (optional in TS), never send null.
        assert_eq!(
            serde_json::to_string(&UpdateCapability {
                check: true,
                install: true,
                reason: None,
            })
            .unwrap(),
            r#"{"check":true,"install":true}"#
        );
    }

    #[test]
    fn prepare_update_restart_result_serializes_camel_case_variants() {
        // The tag + variant names must serialize exactly to the TS union
        // `{ kind: "ready" } | { kind: "timedOut" }`.
        assert_eq!(
            serde_json::to_string(&PrepareUpdateRestartResult::Ready).unwrap(),
            r#"{"kind":"ready"}"#
        );
        assert_eq!(
            serde_json::to_string(&PrepareUpdateRestartResult::TimedOut).unwrap(),
            r#"{"kind":"timedOut"}"#
        );
    }
}
