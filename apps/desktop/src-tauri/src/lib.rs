mod app_lifecycle;
mod auth_scope;
mod diagnostics;
mod dialogs;
mod documents;
pub mod export;
mod fonts;
#[cfg(test)]
mod log_capture;
mod logging;
mod menu;
mod paste_assets;
mod recents;
mod scoped_io;
mod session_flush;
mod temp_sweep;
mod updates;
mod watcher;
mod window_bounds;
mod windows;
mod workspace;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{Emitter, Manager};

// `crate::atomic_write` is the call site every module already uses; the
// implementation lives in `scoped_io` with the other file primitives.
#[cfg(test)]
use scoped_io::save_backup_path;
pub(crate) use scoped_io::{atomic_write, replace_existing};

pub(crate) const MAX_RECENT_FILES: usize = 10;

// Sync commands run on the Rust main thread, so doing IO in one stalls every
// later command and every window's loop (known-gotchas). All IO commands are
// async and go through `blocked`; the remaining sync ones are memory-only or
// deliberately main-thread-bound (window/menu mutation).
/// Runs one blocking IO task off the runtime worker.
async fn blocked<T, F>(name: &str, task: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("{name} task failed: {error}"))?
}

#[tauri::command]
async fn watch_paths(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.len() > watcher::MAX_WATCHED_PATHS {
        return Err("too many watch paths".into());
    }
    // The webview is injected from the caller's context, so each window owns its
    // own watch set; the OS watcher reconciles to the union of all windows'.
    let label = window.label().to_string();
    blocked("watch", move || {
        // Unauthorized paths are skipped: a window may only watch its own scope.
        let canonical: Vec<PathBuf> = paths
            .iter()
            .filter_map(|path| auth_scope::authorized_watch_path(&label, Path::new(path)))
            .collect();
        watcher::set_watched_paths(&app, &label, &canonical)
    })
    .await
}

#[tauri::command]
fn set_recent_files(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    paths: Vec<String>,
) -> Result<(), String> {
    // The native menu is process-global: `recents` validates that every path is
    // authorized for this window or already persisted.
    recents::validate_recent_paths_for_menu(window.label(), &paths)?;
    menu::set_recent_files(&app, &paths).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_view_menu_state(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: menu::ViewMenuState,
) {
    // Tauri injects the calling webview, so the state lands on its window.
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
    // The injected webview is the window that actually flushed.
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
    window: tauri::WebviewWindow,
    initial_paths: Option<Vec<String>>,
) -> Result<String, String> {
    let paths = initial_paths.unwrap_or_default();
    let caller = window.label().to_string();
    // Reject before the window exists so a refused handoff leaves no empty editor
    // behind; the grants are copied to the new label below.
    for path in &paths {
        auth_scope::assert_file_or_workspace_authorized(Some(&caller), Path::new(path))?;
    }
    let label = windows::create_editor_window(
        &app,
        &windows::CreateWindowOptions {
            label: None,
            initial_paths: Vec::new(),
            bounds: None,
            maximized: false,
        },
    )
    .map_err(|e| e.to_string())?;
    auth_scope::copy_authorized_files_to_window(&caller, &label, &paths)?;
    for path in &paths {
        windows::queue_open_file(&label, path);
    }
    Ok(label)
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
    let label = Some(window.label().to_string());
    workspace::search_markdown(root, query, case_sensitive, label).await
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
    let task = move || workspace::snapshot_document(path, label);
    blocked("snapshot", task).await
}

#[tauri::command]
async fn list_snapshots(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<Vec<workspace::SnapshotEntry>, String> {
    let label = Some(window.label().to_string());
    let task = move || workspace::list_snapshots(path, label);
    blocked("snapshot listing", task).await
}

#[tauri::command]
async fn read_snapshot(
    window: tauri::WebviewWindow,
    path: String,
    file_name: String,
) -> Result<String, String> {
    let label = Some(window.label().to_string());
    let task = move || workspace::read_snapshot(path, file_name, label);
    blocked("snapshot read", task).await
}

#[tauri::command]
async fn clear_snapshots(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    let label = Some(window.label().to_string());
    let task = move || workspace::clear_snapshots(path, label);
    blocked("snapshot clear", task).await
}

#[tauri::command]
async fn create_markdown(
    window: tauri::WebviewWindow,
    dir: String,
    name: String,
) -> Result<String, String> {
    let label = Some(window.label().to_string());
    let task = move || workspace::create_markdown(dir, name, label);
    blocked("create markdown", task).await
}

#[tauri::command]
async fn create_dir(
    window: tauri::WebviewWindow,
    dir: String,
    name: String,
) -> Result<String, String> {
    let label = Some(window.label().to_string());
    let task = move || workspace::create_dir(dir, name, label);
    blocked("create directory", task).await
}

#[tauri::command]
async fn rename_path(
    window: tauri::WebviewWindow,
    from: String,
    to_name: String,
) -> Result<String, String> {
    let label = Some(window.label().to_string());
    let task = move || workspace::rename_path(from, to_name, label);
    blocked("rename path", task).await
}

#[tauri::command]
async fn delete_path(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    let label = Some(window.label().to_string());
    blocked("delete path", move || workspace::delete_path(path, label)).await
}

#[tauri::command]
async fn write_recovery(
    window: tauri::WebviewWindow,
    key: String,
    path: Option<String>,
    contents: String,
) -> Result<(), String> {
    // A draft records the document it belongs to, and adopting it grants that
    // path, so an arbitrary path here would launder itself into a grant.
    if let Some(target) = path.as_deref() {
        auth_scope::assert_file_or_workspace_authorized(Some(window.label()), Path::new(target))?;
    }
    let task = move || workspace::write_recovery(key, path, contents);
    blocked("recovery write", task).await
}

#[tauri::command]
async fn list_recoveries(
    window: tauri::WebviewWindow,
) -> Result<Vec<workspace::RecoveryRecord>, String> {
    let label = window.label().to_string();
    blocked("recovery listing", move || {
        let records = workspace::list_recoveries()?;
        // A crash-recovered standalone file has no other grant on this launch.
        auth_scope::authorize_recovered_paths(
            &label,
            records.iter().filter_map(|record| record.path.as_deref()),
        );
        Ok(records)
    })
    .await
}

#[tauri::command]
async fn read_recovery(
    window: tauri::WebviewWindow,
    key: String,
) -> Result<workspace::RecoveryContents, String> {
    let label = window.label().to_string();
    blocked("recovery read", move || {
        let contents = workspace::read_recovery(key)?;
        auth_scope::authorize_recovered_paths(&label, contents.path.as_deref());
        Ok(contents)
    })
    .await
}

#[tauri::command]
async fn clear_recovery(key: String) -> Result<(), String> {
    blocked("recovery clear", move || workspace::clear_recovery(key)).await
}

#[tauri::command]
async fn get_settings(window: tauri::WebviewWindow) -> Result<String, String> {
    let label = window.label().to_string();
    blocked("settings read", move || {
        let raw = workspace::get_settings()?;
        // The persisted `customCssPath` was picked in an earlier session.
        auth_scope::authorize_from_settings_json(&label, &raw);
        Ok(raw)
    })
    .await
}

#[tauri::command]
async fn save_settings(window: tauri::WebviewWindow, contents: String) -> Result<(), String> {
    let label = window.label().to_string();
    blocked("settings save", move || {
        // A `customCssPath` nobody picked must not be persisted into a grant.
        let existing = workspace::get_settings().unwrap_or_default();
        auth_scope::validate_settings_json_for_save(&label, &contents, &existing)?;
        workspace::save_settings(contents)
    })
    .await
}

#[tauri::command]
async fn get_session_state(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    let label = window.label().to_string();
    blocked("session state read", move || {
        // The lock closes the atomic-replace gap: a read racing a save's rename
        // could otherwise see "no session". It is acquired inside the closure
        // because a std MutexGuard is not Send.
        let lock = app.state::<workspace::SessionFileLock>();
        let _guard = lock.lock();
        get_session_state_impl(&label)
    })
    .await
}

fn get_session_state_impl(label: &str) -> Result<String, String> {
    let payload = workspace::session_payload_for(label)?.unwrap_or_else(|| "{}".to_string());
    // Replaying a shard grants its folder/files to this window.
    auth_scope::authorize_from_session_json(label, &payload);
    Ok(payload)
}

#[tauri::command]
async fn save_session_state(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    contents: String,
) -> Result<(), String> {
    // Capture the geometry BEFORE spawn_blocking so the shard records the moment
    // this webview flushed. Logical pixels: the builder reads logical too, so a
    // 2x display round-trips instead of doubling on every restore.
    let label = window.label().to_string();
    let bounds = window_bounds::capture_window_bounds(&window);
    let maximized = window.is_maximized().unwrap_or(false);
    let save_app = app.clone();
    let save_label = label.clone();
    let save_contents = contents.clone();
    blocked("session state", move || {
        let lock = save_app.state::<workspace::SessionFileLock>();
        let _guard = lock.lock();
        // A shard is webview-written JSON: validate under the same lock.
        let existing = workspace::session_payload_for(&save_label)?;
        auth_scope::validate_session_json_for_save(
            &save_label,
            &save_contents,
            existing.as_deref(),
        )?;
        workspace::save_session_shard(&save_label, &save_contents, bounds, maximized)
    })
    .await?;
    // Mirror the payload so open-file routing sees this window's latest state.
    windows::update_meta_from_payload(&app, &label, &contents);
    Ok(())
}

#[tauri::command]
async fn allow_workspace_dir(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), String> {
    // The path must already be a granted root (or a lone document's own folder):
    // a webview asking for `/` or `~/.ssh` gets nothing.
    let (directory, recursive) =
        auth_scope::authorize_requested_workspace_dir(window.label(), Path::new(&path))?;
    app.asset_protocol_scope()
        .allow_directory(directory, recursive)
        .map_err(|e| format!("failed to allow workspace directory: {e}"))
}

#[tauri::command]
async fn allow_document_assets(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    document_path: String,
) -> Result<(), String> {
    let document = Path::new(&document_path);
    let directory = auth_scope::authorized_document_directory(Some(window.label()), document)?;
    if auth_scope::is_document_inside_workspace(Some(window.label()), document) {
        app.asset_protocol_scope()
            .allow_directory(&directory, true)
            .map_err(|e| format!("failed to allow document assets: {e}"))?;
    } else {
        // SEC-02: a standalone document must not promote its whole tree. Its
        // folder is non-recursive; `assets/` is the one recursive exception.
        app.asset_protocol_scope()
            .allow_directory(&directory, false)
            .map_err(|e| format!("failed to allow document assets: {e}"))?;
        let assets = directory.join("assets");
        if assets.is_dir() {
            app.asset_protocol_scope()
                .allow_directory(assets, true)
                .map_err(|e| format!("failed to allow document assets: {e}"))?;
        }
    }
    // This grant is what gives a standalone file version history.
    if documents::is_markdown_path(document) || document.exists() {
        if let Err(error) = auth_scope::authorize_document_file(window.label(), document) {
            log::warn!("document authorization failed: {error}");
        }
    }
    Ok(())
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
                    if let Some(canonical) = windows::resolve_open_arg(arg, Some(&cwd)) {
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
                    if let Some(canonical) = windows::resolve_open_arg(&arg, None) {
                        // The OS opened this file for us: grant it to the startup
                        // window, which has no dialog history to inherit.
                        let _ = auth_scope::authorize_document_file("main", Path::new(&canonical));
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
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    // Native drops are a trusted origin: the user dragged these
                    // onto this window, so grant before the webview handler runs.
                    for path in paths {
                        if path.is_dir() {
                            let _ = auth_scope::authorize_workspace_root(window.label(), path);
                        } else if documents::is_markdown_path(path) {
                            let _ = auth_scope::authorize_document_file(window.label(), path);
                        }
                    }
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
            fonts::list_system_fonts,
            dialogs::pick_open_markdown,
            dialogs::pick_save_markdown,
            dialogs::pick_workspace_folder,
            dialogs::pick_custom_css,
            dialogs::pick_export_path,
            recents::get_recent_files,
            recents::save_recent_files
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
                    if !documents::is_markdown_path(&path) {
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
#[path = "lib_tests.rs"]
mod tests;
