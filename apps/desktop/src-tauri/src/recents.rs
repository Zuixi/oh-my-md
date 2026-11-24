//! Recent-file list persistence.
//!
//! The list used to live in `localStorage`, so the webview both wrote it and
//! re-read it as "trusted": whatever it stored came back as a path the editor
//! was willing to open. It now lives in `config_dir/recents.json`, is validated
//! on write (authorized for the calling window, or already persisted), and every
//! loaded entry is granted to the window that asked for it.

use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};

const RECENTS_FILE_NAME: &str = "recents.json";

/// Serializes read/write of the one file. `atomic_write` keeps the file itself
/// consistent; this lock closes the read-modify-write window between two windows
/// saving their own lists.
static RECENTS_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn lock() -> std::sync::MutexGuard<'static, ()> {
    RECENTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn recents_path() -> PathBuf {
    crate::workspace::config_dir().join(RECENTS_FILE_NAME)
}

/// A recent entry is an absolute path without `.`/`..` components. Anything else
/// is a caller bug or an injection attempt, never a document.
fn valid_recent_path(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path).is_absolute()
        && !Path::new(path)
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
}

fn read_persisted() -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(recents_path()) else {
        return Vec::new();
    };
    let Ok(paths) = serde_json::from_str::<Vec<String>>(&raw) else {
        // A corrupt list is not worth failing a startup over: the user loses
        // ordering, not documents, and the next save rewrites it.
        return Vec::new();
    };
    paths
        .into_iter()
        .filter(|path| valid_recent_path(path))
        .take(crate::MAX_RECENT_FILES)
        .collect()
}

fn write_persisted(paths: &[String]) -> Result<(), String> {
    let directory = crate::workspace::config_dir();
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let json = serde_json::to_string(paths).map_err(|error| error.to_string())?;
    crate::atomic_write(&recents_path(), json.as_bytes())
}

/// Validates a list the native menu is about to show. Every path must either be
/// authorized for the calling window or already be in the persisted file —
/// otherwise a compromised renderer could seed the menu with arbitrary paths and
/// rely on the menu item to open them. Callers that also write hold the lock.
pub fn validate_recent_paths_for_menu(window_label: &str, paths: &[String]) -> Result<(), String> {
    if paths.len() > crate::MAX_RECENT_FILES {
        return Err("too many recent files".into());
    }
    let persisted = read_persisted();
    for path in paths {
        if !valid_recent_path(path) {
            return Err("recent path is invalid".into());
        }
        if persisted.iter().any(|entry| entry == path) {
            continue;
        }
        let authorized = crate::auth_scope::assert_file_or_workspace_authorized(
            Some(window_label),
            Path::new(path),
        );
        if authorized.is_err() {
            return Err("recent path was not authorized".into());
        }
    }
    Ok(())
}

/// Reads the persisted list and grants every entry to the asking window, so a
/// recent file opens after a restart without a dialog.
fn load_for_window(window_label: &str) -> Vec<String> {
    let _guard = lock();
    let paths = read_persisted();
    for path in &paths {
        let _ = crate::auth_scope::authorize_document_file(window_label, Path::new(path));
    }
    paths
}

#[tauri::command]
pub async fn get_recent_files(window: tauri::WebviewWindow) -> Result<Vec<String>, String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || Ok(load_for_window(&label)))
        .await
        .map_err(|error| format!("recent files task failed: {error}"))?
}

#[tauri::command]
pub async fn save_recent_files(
    window: tauri::WebviewWindow,
    paths: Vec<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock();
        validate_recent_paths_for_menu(&label, &paths)?;
        write_persisted(&paths)
    })
    .await
    .map_err(|error| format!("recent files task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::config_env_guard;

    fn tmp(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("omd-recents-{}-{name}", std::process::id()));
        std::fs::remove_dir_all(&path).ok();
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// Redirects the config dir for one test and returns both directories.
    fn isolated(name: &str) -> (PathBuf, PathBuf) {
        let config = tmp(&format!("{name}-config"));
        std::env::set_var("OMD_CONFIG_DIR", &config);
        (tmp(&format!("{name}-notes")), config)
    }

    fn cleanup(notes: &Path, config: &Path) {
        std::env::remove_var("OMD_CONFIG_DIR");
        std::fs::remove_dir_all(config).ok();
        std::fs::remove_dir_all(notes).ok();
    }

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn recent_paths_round_trip_through_the_config_file() {
        let _guard = config_env_guard();
        let (notes, config) = isolated("roundtrip");
        let paths = vec![
            path_string(&notes.join("a.md")),
            path_string(&notes.join("b.md")),
        ];

        write_persisted(&paths).unwrap();

        assert_eq!(read_persisted(), paths);
        assert!(recents_path().starts_with(&config));
        cleanup(&notes, &config);
    }

    #[test]
    fn missing_and_corrupt_state_degrade_to_an_empty_list() {
        let _guard = config_env_guard();
        let (notes, config) = isolated("degrade");
        assert!(read_persisted().is_empty());

        std::fs::write(
            recents_path().parent().unwrap().join(RECENTS_FILE_NAME),
            "not json {{{",
        )
        .unwrap();
        assert!(read_persisted().is_empty());

        // Entries that are not absolute paths are dropped on read, and the list
        // is capped so a hostile file cannot grow it without bound.
        let poisoned: Vec<String> = std::iter::once("relative.md".to_string())
            .chain(
                (0..crate::MAX_RECENT_FILES + 5)
                    .map(|i| path_string(&notes.join(format!("{i}.md")))),
            )
            .collect();
        std::fs::write(recents_path(), serde_json::to_string(&poisoned).unwrap()).unwrap();
        let loaded = read_persisted();
        assert_eq!(loaded.len(), crate::MAX_RECENT_FILES);
        assert!(!loaded.iter().any(|path| path == "relative.md"));
        cleanup(&notes, &config);
    }

    #[test]
    fn malformed_and_oversized_lists_are_refused() {
        let _guard = config_env_guard();
        let (notes, config) = isolated("refuse");
        let too_many: Vec<String> = (0..crate::MAX_RECENT_FILES + 1)
            .map(|i| path_string(&notes.join(format!("{i}.md"))))
            .collect();

        assert!(validate_recent_paths_for_menu("recents-w", &too_many).is_err());
        assert!(validate_recent_paths_for_menu("recents-w", &[String::new()]).is_err());
        assert!(validate_recent_paths_for_menu("recents-w", &["relative.md".into()]).is_err());
        assert!(validate_recent_paths_for_menu(
            "recents-w",
            &[path_string(&notes.join("../etc.md"))]
        )
        .is_err());
        // A path the window never opened is not a recent file yet.
        assert!(
            validate_recent_paths_for_menu("recents-w", &[path_string(&notes.join("a.md"))])
                .is_err()
        );

        crate::auth_scope::authorize_document_file("recents-w", &notes.join("a.md")).unwrap();
        assert!(
            validate_recent_paths_for_menu("recents-w", &[path_string(&notes.join("a.md"))])
                .is_ok()
        );
        cleanup(&notes, &config);
    }

    #[test]
    fn a_persisted_path_stays_valid_for_another_window() {
        let _guard = config_env_guard();
        let (notes, config) = isolated("persisted");
        let doc = notes.join("kept.md");
        std::fs::write(&doc, "x").unwrap();
        let paths = vec![path_string(&doc)];

        // A second window has no grant for the file, but the list is already on
        // disk, so re-saving it stays allowed (it can only shrink, never grow).
        write_persisted(&paths).unwrap();

        assert!(validate_recent_paths_for_menu("other-w", &paths).is_ok());
        assert!(
            validate_recent_paths_for_menu("other-w", &[path_string(&notes.join("new.md"))])
                .is_err()
        );
        cleanup(&notes, &config);
    }

    #[test]
    fn loading_grants_every_persisted_path_to_the_asking_window() {
        let _guard = config_env_guard();
        let (notes, config) = isolated("grant");
        let doc = notes.join("opened.md");
        std::fs::write(&doc, "x").unwrap();
        let paths = vec![path_string(&doc)];
        write_persisted(&paths).unwrap();

        assert_eq!(load_for_window("load-w"), paths);
        assert!(
            crate::auth_scope::assert_file_or_workspace_authorized(Some("load-w"), &doc).is_ok()
        );
        // Only the asking window is granted.
        assert!(
            crate::auth_scope::assert_file_or_workspace_authorized(Some("other-w"), &doc).is_err()
        );
        cleanup(&notes, &config);
    }
}
