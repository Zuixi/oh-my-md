mod app_lifecycle;
mod auth_scope;
mod diagnostics;
mod documents;
pub mod export;
mod fonts;
#[cfg(test)]
mod log_capture;
mod logging;
mod menu;
mod paste_assets;
mod scoped_io;
mod session_flush;
mod temp_sweep;
mod updates;
mod watcher;
mod window_bounds;
mod windows;
mod workspace;

use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use tauri::{Emitter, Manager};

const MAX_RECENT_FILES: usize = 10;

// Sync commands run on the Rust main thread, so any of them doing IO can stall
// every later command (and every window's event loop) — see known-gotchas. All
// IO commands are async + spawn_blocking; the remaining sync commands are
// memory-only or deliberately main-thread-bound (window/menu mutation).
#[tauri::command]
async fn watch_paths(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.len() > watcher::MAX_WATCHED_PATHS {
        return Err("too many watch paths".into());
    }
    // The webview is injected from the caller's context, so each window owns
    // its own watch set without the TS contract changing shape; the OS
    // watcher reconciles to the union of all windows' sets.
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        // Missing or unauthorized paths are skipped: watching is best-effort
        // hinting, and a window may only watch its own workspace roots or open files.
        let canonical: Vec<PathBuf> = paths
            .iter()
            .filter_map(|path| auth_scope::authorized_watch_path(&label, Path::new(path)))
            .collect();
        watcher::set_watched_paths(&app, &label, &canonical)
    })
    .await
    .map_err(|error| format!("watch task failed: {error}"))?
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
fn set_view_menu_state(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: menu::ViewMenuState,
) {
    // Tauri injects the calling webview, so the state is stored against the
    // window that owns those toggles — zero frontend wiring changes.
    menu::set_window_view_state(&app, window.label(), state);
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
pub(crate) fn startup_window_theme(raw_settings: &str) -> Option<tauri::Theme> {
    let value: serde_json::Value = serde_json::from_str(raw_settings).ok()?;
    window_theme_from_arg(value.get("theme")?.as_str()?).ok()
}

// In-app menubar (non-macOS) needs an explicit quit entry and a version for
// the About dialog; macOS gets both from the native app menu instead. The
// menubar quit flushes session state first — `app.exit` skips ExitRequested,
// so the flush gate must run inline before exiting.
#[tauri::command]
fn session_flush_ack(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    // The webview is injected from the caller's context, so the ack lands on
    // the window that actually flushed, not a hardcoded label.
    app.state::<session_flush::FlushGate>().ack(window.label());
}

#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Opens a fresh editor window (palette/shortcut path). Synchronous on
/// purpose: window creation must run on the main thread, and Tauri keeps
/// non-async commands on it.
#[tauri::command]
fn create_editor_window(
    app: tauri::AppHandle,
    initial_paths: Option<Vec<String>>,
) -> Result<String, String> {
    windows::create_editor_window(
        &app,
        &windows::CreateWindowOptions {
            label: None,
            initial_paths: initial_paths.unwrap_or_default(),
            bounds: None,
            maximized: false,
        },
    )
    .map_err(|e| e.to_string())
}

// Every workspace command takes the calling webview and hands its label to
// `auth_scope`, which is what turned an unrestricted "read any directory the
// process can reach" IPC into a per-window grant. Tauri injects `window`
// automatically, so the TS contract is unchanged.

#[tauri::command]
async fn list_dir(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<Vec<workspace::DirEntry>, String> {
    workspace::list_dir(path, Some(window.label().to_string())).await
}

#[tauri::command]
async fn search_markdown(
    window: tauri::WebviewWindow,
    root: String,
    query: String,
    case_sensitive: bool,
) -> Result<workspace::SearchResponse, String> {
    workspace::search_markdown(
        root,
        query,
        case_sensitive,
        Some(window.label().to_string()),
    )
    .await
}

#[tauri::command]
async fn list_markdown_files(
    window: tauri::WebviewWindow,
    root: String,
) -> Result<workspace::QuickOpenResponse, String> {
    workspace::list_markdown_files(root, Some(window.label().to_string())).await
}

#[tauri::command]
async fn snapshot_document(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    let label = Some(window.label().to_string());
    tauri::async_runtime::spawn_blocking(move || workspace::snapshot_document(path, label))
        .await
        .map_err(|error| format!("snapshot task failed: {error}"))?
}

#[tauri::command]
async fn list_snapshots(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<Vec<workspace::SnapshotEntry>, String> {
    let label = Some(window.label().to_string());
    tauri::async_runtime::spawn_blocking(move || workspace::list_snapshots(path, label))
        .await
        .map_err(|error| format!("snapshot listing task failed: {error}"))?
}

#[tauri::command]
async fn read_snapshot(
    window: tauri::WebviewWindow,
    path: String,
    file_name: String,
) -> Result<String, String> {
    let label = Some(window.label().to_string());
    tauri::async_runtime::spawn_blocking(move || workspace::read_snapshot(path, file_name, label))
        .await
        .map_err(|error| format!("snapshot read task failed: {error}"))?
}

#[tauri::command]
async fn clear_snapshots(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    let label = Some(window.label().to_string());
    tauri::async_runtime::spawn_blocking(move || workspace::clear_snapshots(path, label))
        .await
        .map_err(|error| format!("snapshot clear task failed: {error}"))?
}

#[tauri::command]
async fn create_markdown(
    window: tauri::WebviewWindow,
    dir: String,
    name: String,
) -> Result<String, String> {
    let label = Some(window.label().to_string());
    tauri::async_runtime::spawn_blocking(move || workspace::create_markdown(dir, name, label))
        .await
        .map_err(|error| format!("create markdown task failed: {error}"))?
}

#[tauri::command]
async fn create_dir(
    window: tauri::WebviewWindow,
    dir: String,
    name: String,
) -> Result<String, String> {
    let label = Some(window.label().to_string());
    tauri::async_runtime::spawn_blocking(move || workspace::create_dir(dir, name, label))
        .await
        .map_err(|error| format!("create directory task failed: {error}"))?
}

#[tauri::command]
async fn rename_path(
    window: tauri::WebviewWindow,
    from: String,
    to_name: String,
) -> Result<String, String> {
    let label = Some(window.label().to_string());
    tauri::async_runtime::spawn_blocking(move || workspace::rename_path(from, to_name, label))
        .await
        .map_err(|error| format!("rename path task failed: {error}"))?
}

#[tauri::command]
async fn delete_path(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    let label = Some(window.label().to_string());
    tauri::async_runtime::spawn_blocking(move || workspace::delete_path(path, label))
        .await
        .map_err(|error| format!("delete path task failed: {error}"))?
}

#[tauri::command]
async fn write_recovery(key: String, path: Option<String>, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || workspace::write_recovery(key, path, contents))
        .await
        .map_err(|error| format!("recovery write task failed: {error}"))?
}

#[tauri::command]
async fn list_recoveries() -> Result<Vec<workspace::RecoveryRecord>, String> {
    tauri::async_runtime::spawn_blocking(workspace::list_recoveries)
        .await
        .map_err(|error| format!("recovery listing task failed: {error}"))?
}

#[tauri::command]
async fn read_recovery(key: String) -> Result<workspace::RecoveryContents, String> {
    tauri::async_runtime::spawn_blocking(move || workspace::read_recovery(key))
        .await
        .map_err(|error| format!("recovery read task failed: {error}"))?
}

#[tauri::command]
async fn clear_recovery(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || workspace::clear_recovery(key))
        .await
        .map_err(|error| format!("recovery clear task failed: {error}"))?
}

#[tauri::command]
async fn get_settings() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(workspace::get_settings)
        .await
        .map_err(|error| format!("settings read task failed: {error}"))?
}

#[tauri::command]
async fn save_settings(contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || workspace::save_settings(contents))
        .await
        .map_err(|error| format!("settings save task failed: {error}"))?
}

#[tauri::command]
async fn get_session_state(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        // The lock closes the atomic-replace gap: without it a read racing a
        // save's rename could observe a missing file as "no session". The
        // guard must be acquired inside the closure: a std MutexGuard is not
        // Send, so it cannot cross the spawn_blocking boundary.
        let lock = app.state::<workspace::SessionFileLock>();
        let _guard = lock.lock();
        get_session_state_impl(&label)
    })
    .await
    .map_err(|error| format!("session state read task failed: {error}"))?
}

fn get_session_state_impl(label: &str) -> Result<String, String> {
    Ok(workspace::session_payload_for(label)?.unwrap_or_else(|| "{}".to_string()))
}

#[tauri::command]
async fn save_session_state(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    contents: String,
) -> Result<(), String> {
    // Tauri window getters dispatch to the window's event loop but are
    // thread-safe; capture the geometry BEFORE spawn_blocking so the shard
    // records the moment this webview flushed.
    let label = window.label().to_string();
    // Logical pixels: the builder reads logical too, so a 2x display
    // round-trips instead of doubling on every restore.
    let bounds = window_bounds::capture_window_bounds(&window);
    let maximized = window.is_maximized().unwrap_or(false);
    let save_app = app.clone();
    let save_label = label.clone();
    let save_contents = contents.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = save_app.state::<workspace::SessionFileLock>();
        let _guard = lock.lock();
        workspace::save_session_shard(&save_label, &save_contents, bounds, maximized)
    })
    .await
    .map_err(|error| format!("session state task failed: {error}"))??;
    // The registry mirror follows the persisted payload so open-file routing
    // sees each window's latest open paths/folder without an extra round.
    windows::update_meta_from_payload(&app, &label, &contents);
    Ok(())
}

#[tauri::command]
async fn allow_workspace_dir(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), String> {
    use tauri::Manager;

    // Scope grants are in-memory Mutex updates; async keeps them off the main
    // thread so openPath never queues behind another sync command.
    let directory = auth_scope::workspace_directory(Path::new(&path))?;
    auth_scope::authorize_workspace_root(window.label(), &directory)?;
    app.asset_protocol_scope()
        .allow_directory(directory, true)
        .map_err(|e| format!("failed to allow workspace directory: {e}"))
}

#[tauri::command]
async fn allow_document_assets(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    document_path: String,
) -> Result<(), String> {
    use tauri::Manager;

    let document = Path::new(&document_path);
    let directory = auth_scope::authorized_document_directory(Some(window.label()), document)?;
    app.asset_protocol_scope()
        .allow_directory(directory, true)
        .map_err(|e| format!("failed to allow document assets: {e}"))?;
    // Version history follows the document, not the folder: authorizing this
    // exact file is what gives standalone (no workspace) files snapshots.
    if is_markdown_path(document) || document.exists() {
        if let Err(error) = auth_scope::authorize_document_file(window.label(), document) {
            log::warn!("document authorization failed: {error}");
        }
    }
    Ok(())
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
    // Durability (RUST-06): the rename itself is only durable once the parent
    // directory entry is on disk. Best effort — every platform that matters
    // for this app either supports it or (Windows) cannot open the directory,
    // and a failure here must never fail a write that already landed.
    #[cfg(not(windows))]
    if let Ok(directory) = std::fs::File::open(parent) {
        let _ = directory.sync_all();
    }
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
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("doc");
    // The embedded document name lets `temp_sweep` recognise a backup that is
    // the last copy of a file a crash left mid-rename.
    let stamp = format!(".{}-{}", std::process::id(), nanos);
    path.with_file_name(format!("{stamp}.{name}.omd-save-backup"))
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

/// Resolves one raw CLI arg to a canonical markdown path: strips `file://`
/// and stray quotes, joins relative args against `cwd` (or the process
/// working directory), and canonicalizes. Non-markdown or unresolvable args
/// return None. Shared by the launch argv loop and the second-instance
/// callback; routing the result is the caller's choice.
fn resolve_open_arg(raw_arg: &str, cwd: Option<&str>) -> Option<String> {
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
    if !is_markdown_path(&resolved) {
        return None;
    }
    Some(
        std::fs::canonicalize(&resolved)
            .unwrap_or(resolved)
            .to_string_lossy()
            .into_owned(),
    )
}

/// Drained by the webview after mount: launch-time Opened events can fire
/// before the frontend listener is registered. The webview is injected from
/// the caller's context, so each window drains its own queue.
#[tauri::command]
fn take_pending_open_files(window: tauri::WebviewWindow) -> Vec<String> {
    windows::take_pending(window.label())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before `build()`: a panic during startup must still identify its
    // `file:line`. The hook chains to the default one, so a panic raised
    // before the logger exists still reaches stderr.
    logging::install_panic_hook();
    let builder = export::builder_with_export_protocol();
    builder
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // Markdown file arguments open in this instance (macOS delivers
            // the same via RunEvent::Opened instead of a second process);
            // each routes to its best window. A bare second launch just
            // focuses the most recent window (or creates one).
            let mut routed_any = false;
            for arg in argv.iter().skip(1) {
                if !arg.starts_with('-') {
                    if let Some(canonical) = resolve_open_arg(arg, Some(&cwd)) {
                        windows::route_open_file(app, &canonical);
                        routed_any = true;
                    }
                }
            }
            if !routed_any {
                windows::ensure_window(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(documents::DocumentCoordinator::default())
        .manage(documents::DocumentVersionCache::default())
        .manage(session_flush::FlushGate::default())
        .manage(workspace::SessionFileLock::default())
        .manage(Mutex::<windows::WindowRegistry>::default())
        .manage(logging::ExitingState::default())
        // The frontend log sink's per-second budget (spec §3.9 layer 4). It
        // must outlive every IPC call, so it is process state, not a command
        // local.
        .manage(logging::FrontendBudget::new(
            logging::LOG_FRONTEND_BUDGET_PER_SEC,
        ))
        .setup(|app| {
            // One read for the whole setup (logging + pre-paint theme).
            let settings = workspace::get_settings().unwrap_or_default();
            // Logging first: Tauri turns a setup error into a panic. The
            // previous-session scan, boundary write, and managed state all
            // live in one helper so `run()` stays thin (lib.rs is
            // growth-frozen; the setup order is load-bearing there).
            logging::setup_logging(app.handle(), &settings);
            // Launch argv: the registry is empty and the config-declared main
            // window does not exist yet, so routing would spawn a duplicate
            // editor window. Queue straight for "main" and emit targeted at
            // it — the webview may not be listening yet, and the queue is
            // the durable path it drains after mount.
            for arg in std::env::args().skip(1) {
                if !arg.starts_with('-') {
                    if let Some(canonical) = resolve_open_arg(&arg, None) {
                        windows::queue_open_file("main", &canonical);
                        let _ = app.emit_to("main", windows::OPEN_FILE_EVENT, &canonical);
                    }
                }
            }
            {
                use std::sync::Mutex;
                let registry = app.state::<Mutex<windows::WindowRegistry>>();
                registry
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .register("main");
            }
            // Apply the persisted theme before the first paint; the webview's
            // set_window_theme push arrives only after React boots, which
            // leaves the title bar flashing the OS appearance at startup.
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.set_theme(startup_window_theme(&settings)) {
                    log::warn!("startup window theme failed: {e}");
                }
            }
            // Multi-window session restore: main is already created by
            // config (theme applied above); replay its saved geometry, then
            // spawn one window per remaining shard with its saved label so
            // labels stay deterministic across restarts.
            let session_windows = {
                // Same lock contract as get_session_state: a save's atomic
                // rename must not race this read.
                let lock = app.state::<workspace::SessionFileLock>();
                let _guard = lock.lock();
                workspace::list_session_windows()
            };
            match session_windows {
                Ok(entries) => {
                    for entry in &entries {
                        if entry.label == "main" {
                            if let Some(window) = app.get_webview_window("main") {
                                // Shards are logical DIP now; a legacy
                                // physical shard is converted and an
                                // offscreen placement is clamped back on.
                                if let Some(bounds) = entry.bounds {
                                    window_bounds::apply_bounds(&window, bounds);
                                }
                                if entry.maximized {
                                    let _ = window.maximize();
                                }
                            }
                            continue;
                        }
                        // One bad shard must not block the others: log and
                        // keep restoring.
                        if let Err(e) = windows::create_editor_window(
                            app.handle(),
                            &windows::CreateWindowOptions {
                                label: Some(entry.label.clone()),
                                initial_paths: Vec::new(),
                                bounds: entry.bounds,
                                maximized: entry.maximized,
                            },
                        ) {
                            log::warn!("session restore for window {} failed: {e}", entry.label);
                        }
                    }
                }
                Err(e) => log::warn!("session restore listing failed: {e}"),
            }
            menu::install(app)?;
            watcher::install(app.handle());
            if let Err(e) = workspace::migrate_legacy_config() {
                log::warn!("legacy config migration failed: {e}");
            }
            // Housekeeping (DATA-06): drop this app's own abandoned staging
            // files from the directories it owns, one level into the snapshot
            // buckets included. Age-guarded, so it cannot stall startup.
            temp_sweep::sweep_app_dirs(&workspace::config_dir(), &workspace::recovery_dir());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Export render hosts (`omd-export-*`) are offscreen single-purpose
            // pages: they have no session to flush, no menu to target, and no
            // place in the window registry. Filtering here is what lets them
            // close instantaneously instead of waiting out a flush timeout.
            if !windows::is_editor_window_label(window.label()) {
                return;
            }
            let app = window.app_handle();
            match event {
                tauri::WindowEvent::Focused(true) => {
                    let registry = app.state::<std::sync::Mutex<windows::WindowRegistry>>();
                    registry
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .note_focused(window.label());
                    // macOS has ONE menubar: follow focus so its checkmarks
                    // show this window's View toggles, not the last one's.
                    menu::sync_focused_window(app, window.label());
                }
                tauri::WindowEvent::Destroyed => {
                    let registry = app.state::<std::sync::Mutex<windows::WindowRegistry>>();
                    registry
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .unregister(window.label());
                    // A destroyed window's filesystem grants must not outlive
                    // it (SEC-04), nor its queued opens, watches, or View state.
                    auth_scope::revoke_window(window.label());
                    windows::drop_pending(window.label());
                    watcher::drop_window_watches(app, window.label());
                    menu::drop_window_state(app, window.label());
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Red X / Cmd+W: the webview's 1s debounced session save
                    // would be torn down with the window, so flush first and
                    // destroy after. Flushing THIS window only also drops its
                    // session shard; `drive_window_close` records a request
                    // that arrives mid-round instead of dropping it.
                    api.prevent_close();
                    app_lifecycle::drive_window_close(app, window.label());
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            documents::read_document,
            documents::read_document_version,
            documents::stat_document,
            documents::read_document_streaming,
            documents::save_document,
            scoped_io::read_custom_css,
            scoped_io::write_exported_html,
            watch_paths,
            paste_assets::write_paste_assets,
            paste_assets::commit_paste_assets,
            paste_assets::discard_paste_assets,
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
            updates::update_capability,
            updates::prepare_update_restart,
            app_lifecycle::quit_app,
            session_flush_ack,
            app_version,
            create_editor_window,
            take_pending_open_files,
            diagnostics::export_diagnostics,
            logging::log_state,
            logging::open_log_dir,
            logging::frontend::log_frontend,
            app_lifecycle::restart_app,
            menu::set_menu_locale,
            export::export_preview,
            export::cancel_export,
            fonts::list_system_fonts
        ])
        .manage(paste_assets::PasteAssetState::default())
        .build(export::app_context::context())
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
                    windows::route_open_file(app, &path.to_string_lossy());
                }
            }
            // macOS dock-icon click (no file): bring back the most recent
            // window, or create one when the user closed them all.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                windows::ensure_window(app);
            }
            // Terminal event: the event loop is exiting, so nothing can
            // outlive this line but the logger's own flush. Matched before
            // `ExitRequested` because that arm moves `api` out of `event`.
            if let tauri::RunEvent::Exit = event {
                logging::note_clean_exit();
            }
            // Cmd+Q / native quit arrives as ExitRequested without per-window
            // CloseRequested. code: None marks user-initiated exits; our own
            // post-flush `app.exit(0)` carries Some and passes through.
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                // First, before any flushing: a force-kill during the flush
                // round must still leave an intent behind to distinguish it
                // from a crash.
                logging::note_exit_intent(app, "user");
                let gate = app.state::<session_flush::FlushGate>();
                // A restart staged its own flush round: letting this request
                // through is what makes `request_restart` restart instead of
                // re-flushing and then exiting the process.
                if gate.consume_restart_flushed() {
                    return;
                }
                // Editor windows only: an offscreen export host is not a
                // document and must not keep the app alive or be flushed.
                if !app_lifecycle::has_editor_windows(app) {
                    return;
                }
                api.prevent_exit();
                // A quit that arrives mid-round is recorded, not dropped, and
                // the round's finish drains it.
                app_lifecycle::drive_app_exit(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn tmp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("omd-test-{}-{}", std::process::id(), name))
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_replaces_existing_file_and_leaves_no_staging_sibling() {
        use std::os::unix::fs::MetadataExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("existing.md");
        std::fs::write(&path, "old").unwrap();
        let old_inode = fs::metadata(&path).unwrap().ino();

        atomic_write(&path, b"new").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        // Replace-not-truncate: the destination is a different inode, so a
        // crash mid-write can never expose a half-written document.
        assert_ne!(fs::metadata(&path).unwrap().ino(), old_inode);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn atomic_write_creates_a_new_file_with_unicode_paths() {
        let directory = tmp_path("原子保存-目录");
        let path = directory.join("文档-🦀.md");
        fs::create_dir_all(&directory).unwrap();

        atomic_write(&path, "你好，Rust".as_bytes()).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "你好，Rust");
        fs::remove_dir_all(directory).ok();
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
    fn a_failed_atomic_write_preserves_the_original() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document.md");
        std::fs::write(&path, "original").unwrap();
        // A destination that is a directory makes the rename fail after the
        // staged bytes were written and synced.
        let blocked = dir.path().join("blocked");
        std::fs::create_dir(&blocked).unwrap();

        assert!(atomic_write(&blocked, b"replacement").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn save_backup_paths_are_unique_siblings() {
        let a = save_backup_path(Path::new("/tmp/notes/note.md"));
        let b = save_backup_path(Path::new("/tmp/notes/note.txt"));
        let name =
            |p: &std::path::PathBuf| p.file_name().and_then(|n| n.to_str()).unwrap().to_owned();
        let (a_name, b_name) = (name(&a), name(&b));
        // Hidden siblings (pid + nanos + document name), never the
        // extension-clobbering `with_extension` form that would collide.
        assert!(a_name.starts_with(&format!(".{}-", std::process::id())));
        assert!(a_name.ends_with(".note.md.omd-save-backup"));
        assert!(b_name.ends_with(".note.txt.omd-save-backup"));
        assert_ne!(a_name, b_name);
        assert_ne!(a_name, "note.omd-save-backup");
        assert_eq!(a.parent(), Some(Path::new("/tmp/notes")));
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
}
