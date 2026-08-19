mod diagnostics;
mod documents;
mod export;
mod menu;
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

#[tauri::command]
fn watch_paths(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    if paths.len() > watcher::MAX_WATCHED_PATHS {
        return Err("too many watch paths".into());
    }
    // Missing paths are skipped: watching is best-effort hinting, and a file
    // may legitimately not exist yet (fresh tab about to save its first copy).
    let canonical: Vec<PathBuf> = paths
        .iter()
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .collect();
    watcher::set_watched_paths(&app, &canonical)
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

// In-app menubar (non-macOS) needs an explicit quit entry and a version for
// the About dialog; macOS gets both from the native app menu instead.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
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
fn write_recovery(key: String, contents: String) -> Result<(), String> {
    workspace::write_recovery(key, contents)
}

#[tauri::command]
fn list_recoveries() -> Result<Vec<workspace::RecoveryRecord>, String> {
    workspace::list_recoveries()
}

#[tauri::command]
fn read_recovery(key: String) -> Result<String, String> {
    workspace::read_recovery(key)
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
fn save_session_state(contents: String) -> Result<(), String> {
    workspace::save_session_state(contents)
}

#[tauri::command]
fn allow_workspace_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri::Manager;

    let directory = workspace_directory(Path::new(&path))?;
    workspace::authorize_workspace_root(&directory)?;
    app.asset_protocol_scope()
        .allow_directory(directory, true)
        .map_err(|e| format!("failed to allow workspace directory: {e}"))
}

#[tauri::command]
fn allow_document_assets(app: tauri::AppHandle, document_path: String) -> Result<(), String> {
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
        if pending.len() < MAX_PENDING_OPEN_FILES {
            pending.push(path);
        }
    }
}

fn record_open_file(app: &tauri::AppHandle, path: String) {
    queue_open_file(path.clone());
    let _ = app.emit(OPEN_FILE_EVENT, path);
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
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch focuses the running window; markdown file
            // arguments open in this instance (macOS delivers the same via
            // RunEvent::Opened instead of a second process).
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            for arg in argv.iter().skip(1) {
                let path = arg.strip_prefix("file://").unwrap_or(arg);
                if is_markdown_path(Path::new(path)) {
                    record_open_file(app, path.to_string());
                }
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
        .setup(|app| {
            menu::install(app)?;
            watcher::install(app.handle());
            if let Err(e) = workspace::migrate_legacy_config() {
                log::warn!("legacy config migration failed: {e}");
            }
            log::info!("app started {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            documents::read_document,
            documents::read_document_version,
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
            quit_app,
            app_version,
            take_pending_open_files,
            diagnostics::export_diagnostics,
            menu::set_menu_locale,
            export::export_preview
        ])
        .build(tauri::generate_context!())
        .expect("error while building oh-my-md")
        .run(|app, event| {
            // macOS "open with"/double-click/Finder-dock drops arrive here.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
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
}
