//! Native file, folder, and export-destination pickers.
//!
//! Every picker here is a **trusted origin** for `auth_scope`: the path comes
//! from an OS dialog the user actually clicked, so the grant is made in Rust and
//! the webview only receives the resulting path string. Before this module
//! existed the webview drove the dialog plugin itself and then told Rust "trust
//! this path" (`allow_workspace_dir`, and the open/save flows), which let a
//! compromised renderer point the editor — and the recursive asset scope — at
//! any file on disk.

use std::path::{Path, PathBuf};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// Extensions the open picker offers: the same list the engine treats as
/// documents.
const MARKDOWN_EXTENSIONS: [&str; 3] = ["md", "markdown", "mdx"];
const MARKDOWN_SAVE_EXTENSION: &str = "md";
const CSS_EXTENSION: &str = "css";

/// Runs one blocking dialog off the runtime worker and flattens the nested
/// `Option<Result<..>>` a cancelled dialog produces.
async fn pick_with_dialog<T, F>(task: F) -> Result<Option<T>, String>
where
    F: FnOnce() -> Option<Result<T, String>> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("dialog task failed: {error}"))?
        .transpose()
}

/// Export pickers are format-specific: the extension is both the dialog filter
/// and the suffix appended when the user types a bare or mismatched name.
fn export_extension(format: &str) -> Option<&'static str> {
    match format {
        "html" => Some("html"),
        "pdf" => Some("pdf"),
        "png" => Some("png"),
        "zip" => Some("zip"),
        _ => None,
    }
}

fn ensure_markdown_save_extension(path: &Path) -> PathBuf {
    if crate::documents::is_markdown_path(path) {
        path.to_path_buf()
    } else {
        PathBuf::from(format!(
            "{}.{MARKDOWN_SAVE_EXTENSION}",
            path.to_string_lossy()
        ))
    }
}

fn ensure_export_extension(path: &Path, extension: &str) -> PathBuf {
    let matches = if extension == "html" {
        crate::scoped_io::has_extension(path, &["html", "htm"])
    } else {
        crate::scoped_io::has_extension(path, &[extension])
    };
    if matches {
        path.to_path_buf()
    } else {
        PathBuf::from(format!("{}.{extension}", path.to_string_lossy()))
    }
}

/// Splits a save dialog's default into `(starting directory, file name)`.
///
/// A bare name (`export.png`) has no directory to start from, and a directory
/// that no longer exists must not become the dialog's position.
fn default_path_parts(default_path: &str) -> (Option<PathBuf>, String) {
    let path = Path::new(default_path);
    if let Some(parent) = path.parent().filter(|parent| parent.is_dir()) {
        if let Some(name) = path.file_name() {
            return (
                Some(parent.to_path_buf()),
                name.to_string_lossy().into_owned(),
            );
        }
    }
    (None, default_path.to_string())
}

#[tauri::command]
pub async fn pick_open_markdown(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    filter_label: Option<String>,
) -> Result<Option<String>, String> {
    let label = filter_label.unwrap_or_else(|| "Markdown".to_string());
    let window_label = window.label().to_string();
    let picked = pick_with_dialog(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .add_filter(label, &MARKDOWN_EXTENSIONS)
            .blocking_pick_file()
            .map(|file| file.into_path().map_err(|error| error.to_string()))
    })
    .await?;
    let Some(path) = picked else {
        return Ok(None);
    };
    crate::auth_scope::authorize_document_file(&window_label, &path)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn pick_save_markdown(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    filter_label: Option<String>,
) -> Result<Option<String>, String> {
    let label = filter_label.unwrap_or_else(|| "Markdown".to_string());
    let window_label = window.label().to_string();
    let picked = pick_with_dialog(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .add_filter(label, &[MARKDOWN_SAVE_EXTENSION])
            .blocking_save_file()
            .map(|file| file.into_path().map_err(|error| error.to_string()))
    })
    .await?;
    let Some(path) = picked else {
        return Ok(None);
    };
    // Ensure the save target always carries a Markdown extension (including
    // dotted stems like `release-v1.0` -> `release-v1.0.md`) and never grants
    // an arbitrary non-Markdown file.
    let final_path = ensure_markdown_save_extension(&path);
    crate::auth_scope::authorize_document_file(&window_label, &final_path)?;
    Ok(Some(final_path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn pick_workspace_folder(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let window_label = window.label().to_string();
    let dialog_app = app.clone();
    let picked = pick_with_dialog(move || {
        dialog_app
            .dialog()
            .file()
            .set_parent(&window)
            .blocking_pick_folder()
            .map(|folder| folder.into_path().map_err(|error| error.to_string()))
    })
    .await?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let directory = crate::auth_scope::authorize_workspace_root(&window_label, &path)?;
    // The asset protocol serves files back to the webview, so the recursive
    // scope the user just consented to has to be registered here as well.
    app.asset_protocol_scope()
        .allow_directory(&directory, true)
        .map_err(|error| format!("failed to allow workspace directory: {error}"))?;
    // The user-facing form stays as picked; canonicalization is internal.
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn pick_custom_css(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    filter_label: Option<String>,
) -> Result<Option<String>, String> {
    let label = filter_label.unwrap_or_else(|| "CSS".to_string());
    let window_label = window.label().to_string();
    let picked = pick_with_dialog(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .add_filter(label, &[CSS_EXTENSION])
            .blocking_pick_file()
            .map(|file| file.into_path().map_err(|error| error.to_string()))
    })
    .await?;
    let Some(path) = picked else {
        return Ok(None);
    };
    crate::auth_scope::authorize_custom_css(&window_label, &path)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn pick_export_path(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    format: String,
    default_path: Option<String>,
    filter_label: Option<String>,
) -> Result<Option<String>, String> {
    let extension = export_extension(&format)
        .ok_or_else(|| "export format must be html, pdf, png or zip".to_string())?;
    let label = filter_label.unwrap_or_else(|| format.to_ascii_uppercase());
    let window_label = window.label().to_string();
    let picked = pick_with_dialog(move || {
        let mut builder = app
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter(label, &[extension]);
        if let Some(default_path) = default_path {
            let (directory, file_name) = default_path_parts(&default_path);
            if let Some(directory) = directory {
                builder = builder.set_directory(directory);
            }
            builder = builder.set_file_name(file_name);
        }
        builder
            .blocking_save_file()
            .map(|file| file.into_path().map_err(|error| error.to_string()))
    })
    .await?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let final_path = ensure_export_extension(&path, extension);
    crate::auth_scope::authorize_export_target(&window_label, &final_path)?;
    Ok(Some(final_path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("omd-dialogs-{}-{name}", std::process::id()));
        std::fs::remove_dir_all(&path).ok();
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn export_formats_map_to_their_own_extension() {
        assert_eq!(export_extension("html"), Some("html"));
        assert_eq!(export_extension("pdf"), Some("pdf"));
        assert_eq!(export_extension("png"), Some("png"));
        assert_eq!(export_extension("zip"), Some("zip"));
        // Anything else is a caller bug or an injection attempt, never a filter.
        for refused in ["", "HTML", "docx", "../png", "md"] {
            assert_eq!(export_extension(refused), None, "{refused} must be refused");
        }
    }

    #[test]
    fn save_and_export_extensions_enforce_the_target_format() {
        assert_eq!(
            ensure_export_extension(Path::new("/notes/export"), "png"),
            PathBuf::from("/notes/export.png")
        );
        assert_eq!(
            ensure_export_extension(Path::new("/notes/export.png"), "png"),
            PathBuf::from("/notes/export.png")
        );
        assert_eq!(
            ensure_export_extension(Path::new("/notes/export.htm"), "html"),
            PathBuf::from("/notes/export.htm")
        );
        // Dotted stems and mismatched extensions receive the required suffix.
        assert_eq!(
            ensure_export_extension(Path::new("/notes/export-v1.0"), "pdf"),
            PathBuf::from("/notes/export-v1.0.pdf")
        );
        assert_eq!(
            ensure_markdown_save_extension(Path::new("/notes/release-v1.0")),
            PathBuf::from("/notes/release-v1.0.md")
        );
        assert_eq!(
            ensure_markdown_save_extension(Path::new("/notes/readme.markdown")),
            PathBuf::from("/notes/readme.markdown")
        );
    }

    #[test]
    fn the_default_path_splits_into_a_existing_directory_and_a_name() {
        let dir = tmp("default-path");
        let existing = dir.join("note.png");
        let (directory, name) = default_path_parts(&existing.to_string_lossy());
        assert_eq!(directory.as_deref(), Some(dir.as_path()));
        assert_eq!(name, "note.png");

        // A directory that is gone must not become the dialog's position.
        let stale = dir.join("absent").join("note.png");
        let (directory, name) = default_path_parts(&stale.to_string_lossy());
        assert_eq!(directory, None);
        assert_eq!(name, stale.to_string_lossy());

        // A bare name has no parent directory at all.
        let (directory, name) = default_path_parts("export.pdf");
        assert_eq!(directory, None);
        assert_eq!(name, "export.pdf");
        std::fs::remove_dir_all(dir).ok();
    }
}
