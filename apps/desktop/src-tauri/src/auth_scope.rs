//! Per-window filesystem authorization.
//!
//! The previous process-global root list outlived every window that asked for
//! it: closing a workspace left its directory readable by any surviving (or
//! future) webview for the rest of the process. Scope now belongs to the window
//! label that requested it and is dropped in `WindowEvent::Destroyed`.
//!
//! Two kinds of grant exist because the product has two kinds of document:
//! a **workspace root** (a folder the user opened → its whole subtree is
//! listed, searched, and mutated) and a **single document file** (opened or
//! saved outside any workspace → only its own version history is reachable).

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};

/// Scope used by Rust-side call sites that have no window (unit tests and
/// internal helpers). A missing label must never mean "anything is allowed".
const INTERNAL_SCOPE: &str = "test";

#[derive(Debug, Default)]
struct WindowAuth {
    roots: Vec<PathBuf>,
    files: Vec<PathBuf>,
}

static SCOPES: LazyLock<Mutex<BTreeMap<String, WindowAuth>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

fn scopes() -> std::sync::MutexGuard<'static, BTreeMap<String, WindowAuth>> {
    SCOPES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn scope_label(window_label: Option<&str>) -> &str {
    window_label.unwrap_or(INTERNAL_SCOPE)
}

/// Rejects `.`/`..` components before any filesystem call: canonicalization
/// alone would happily resolve `/docs/../etc` to `/etc`.
pub(crate) fn reject_traversal(path: &Path) -> Result<(), String> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("path must not contain traversal".into());
    }
    Ok(())
}

/// Absolute path without traversal components (workspace roots, assets).
/// `Path::components` already folds away `.`, so a raw segment scan is needed
/// to reject it at all.
pub(crate) fn absolute_path(path: &Path) -> Result<(), String> {
    let has_dot_segment = path
        .as_os_str()
        .to_string_lossy()
        .split(std::path::MAIN_SEPARATOR)
        .any(|segment| segment == "." || segment == "..");
    if !path.is_absolute()
        || has_dot_segment
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("path must be an absolute path without traversal".into());
    }
    Ok(())
}

pub(crate) fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    reject_traversal(path)?;
    let directory = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !directory.is_dir() {
        return Err("path is not a directory".into());
    }
    Ok(directory)
}

/// Canonical parent plus the final name. The name is not canonicalized: it may
/// legitimately not exist yet (create/rename/save-as).
pub(crate) fn canonical_parent_and_name(
    path: &Path,
) -> Result<(PathBuf, &std::ffi::OsStr), String> {
    reject_traversal(path)?;
    let name = path
        .file_name()
        .ok_or_else(|| "path must include a file or directory name".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "path must include a parent directory".to_string())?;
    Ok((canonical_directory(parent)?, name))
}

/// Owned form of [`canonical_parent_and_name`], for scopes that store the file.
fn resolve_parent_and_name(path: &Path) -> Result<(PathBuf, OsString), String> {
    let (parent, name) = canonical_parent_and_name(path)?;
    Ok((parent, name.to_os_string()))
}

/// Canonicalizes an existing file, or its parent plus name when it does not
/// exist yet. Canonicalizing one side keeps symlinks and macOS `/private/var`
/// aliases matching the paths a later save reports back.
fn canonical_file(path: &Path) -> Result<PathBuf, String> {
    reject_traversal(path)?;
    if let Ok(resolved) = std::fs::canonicalize(path) {
        return Ok(resolved);
    }
    let (parent, name) = resolve_parent_and_name(path)?;
    Ok(parent.join(name))
}

/// Grants `dir` (canonicalized) to one window's workspace scope.
pub fn authorize_workspace_root(window_label: &str, dir: &Path) -> Result<PathBuf, String> {
    let root = canonical_directory(dir)?;
    let mut scopes = scopes();
    let auth = scopes.entry(window_label.to_string()).or_default();
    if !auth.roots.iter().any(|existing| existing == &root) {
        auth.roots.push(root.clone());
    }
    Ok(root)
}

/// Grants one document file to a window's version-history scope. Called after
/// every successful open/save so a standalone file (no workspace folder) still
/// gets snapshots.
pub fn authorize_document_file(window_label: &str, file: &Path) -> Result<PathBuf, String> {
    let canonical = canonical_file(file)?;
    let mut scopes = scopes();
    let auth = scopes.entry(window_label.to_string()).or_default();
    if !auth.files.iter().any(|existing| existing == &canonical) {
        auth.files.push(canonical.clone());
    }
    Ok(canonical)
}

/// Drops everything `window_label` was granted. Called from
/// `WindowEvent::Destroyed` so a closed workspace stops being reachable.
pub fn revoke_window(window_label: &str) {
    scopes().remove(window_label);
}

/// Requires `dir` to be inside one of this window's workspace roots.
pub fn assert_dir_authorized(window_label: Option<&str>, dir: &Path) -> Result<PathBuf, String> {
    let canonical = canonical_directory(dir)?;
    let scope = scope_label(window_label);
    if is_inside_root(scope, &canonical) {
        Ok(canonical)
    } else {
        Err("path is outside the authorized workspace".into())
    }
}

/// Requires `file_path` to be inside a workspace root **or** to be a document
/// file this window opened/saved itself.
pub fn assert_file_or_workspace_authorized(
    window_label: Option<&str>,
    file_path: &Path,
) -> Result<(PathBuf, OsString), String> {
    let (parent, name) = resolve_parent_and_name(file_path)?;
    let canonical_file = parent.join(&name);
    let scope = scope_label(window_label);
    let authorized = {
        let scopes = scopes();
        scopes.get(scope).is_some_and(|auth| {
            auth.roots
                .iter()
                .any(|root| parent == *root || parent.starts_with(root))
                || auth.files.contains(&canonical_file)
        })
    };
    if authorized {
        Ok((parent, name))
    } else {
        Err("path is outside the authorized workspace".into())
    }
}

fn is_inside_root(scope: &str, canonical: &Path) -> bool {
    let scopes = scopes();
    scopes.get(scope).is_some_and(|auth| {
        auth.roots
            .iter()
            .any(|root| canonical == root || canonical.starts_with(root))
    })
}

/// Resolves a watch target only when it already exists and belongs to this
/// window's workspace roots or opened/saved document files.
pub fn authorized_watch_path(window_label: &str, path: &Path) -> Option<PathBuf> {
    reject_traversal(path).ok()?;
    let canonical = std::fs::canonicalize(path).ok()?;
    let scopes = scopes();
    let auth = scopes.get(window_label)?;
    let inside_root = auth
        .roots
        .iter()
        .any(|root| canonical == *root || canonical.starts_with(root));
    if inside_root || auth.files.contains(&canonical) {
        Some(canonical)
    } else {
        None
    }
}

/// Workspace root for `allow_workspace_dir`: absolute, no traversal, existing
/// directory.
pub(crate) fn workspace_directory(path: &Path) -> Result<PathBuf, String> {
    absolute_path(path)
        .map_err(|_| "workspace path must be an absolute path without traversal".to_string())?;
    std::fs::canonicalize(path).map_err(|e| format!("failed to resolve workspace directory: {e}"))
}

/// Asset scope is recursive and the asset protocol serves files back to the
/// webview, so only a document this window already opened/saved (or one inside
/// its workspace root) may widen it. Without this check any absolute path would
/// grant `allow_directory(parent, recursive)`.
pub fn authorized_document_directory(
    window_label: Option<&str>,
    document_path: &Path,
) -> Result<PathBuf, String> {
    assert_file_or_workspace_authorized(window_label, document_path)?;
    document_directory_for_assets(document_path)
}

/// Directory that holds a document's assets (and that the asset protocol needs
/// in scope): the canonical parent of the document path.
pub(crate) fn document_directory_for_assets(document_path: &Path) -> Result<PathBuf, String> {
    absolute_path(document_path)
        .map_err(|_| "document path must be an absolute path without traversal".to_string())?;
    let parent = document_path
        .parent()
        .ok_or_else(|| "document path must have a parent directory".to_string())?;
    std::fs::canonicalize(parent).map_err(|e| format!("failed to resolve document directory: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("omd-auth-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn workspace_root_authorization_is_scoped_per_window() {
        let root = tmp("per-window");
        let doc = root.join("note.md");
        std::fs::write(&doc, "x").unwrap();

        authorize_workspace_root("editor-1", &root).unwrap();
        assert!(assert_dir_authorized(Some("editor-1"), &root).is_ok());
        assert!(assert_file_or_workspace_authorized(Some("editor-1"), &doc).is_ok());
        // A different window was never granted this root.
        assert!(assert_dir_authorized(Some("editor-2"), &root).is_err());

        revoke_window("editor-1");
        assert!(assert_dir_authorized(Some("editor-1"), &root).is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn revoking_one_window_keeps_another_windows_grant() {
        let first = tmp("revoke-first");
        let second = tmp("revoke-second");
        authorize_workspace_root("editor-a", &first).unwrap();
        authorize_workspace_root("editor-b", &second).unwrap();

        revoke_window("editor-a");

        assert!(assert_dir_authorized(Some("editor-a"), &first).is_err());
        assert!(assert_dir_authorized(Some("editor-b"), &second).is_ok());
        std::fs::remove_dir_all(first).ok();
        std::fs::remove_dir_all(second).ok();
    }

    #[test]
    fn a_single_file_grant_does_not_open_its_directory() {
        let root = tmp("single-file");
        let doc = root.join("standalone.md");
        let sibling = root.join("sibling.md");
        std::fs::write(&doc, "x").unwrap();
        std::fs::write(&sibling, "y").unwrap();

        authorize_document_file("editor-file", &doc).unwrap();

        assert!(assert_file_or_workspace_authorized(Some("editor-file"), &doc).is_ok());
        // Siblings and the parent directory stay out of scope: the grant is for
        // version history of that one document, not for browsing the folder.
        assert!(assert_file_or_workspace_authorized(Some("editor-file"), &sibling).is_err());
        assert!(assert_dir_authorized(Some("editor-file"), &root).is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_saved_file_that_does_not_exist_yet_is_authorizable_by_parent_and_name() {
        let root = tmp("future-file");
        let future = root.join("not-written-yet.md");

        let canonical = authorize_document_file("editor-new", &future).unwrap();

        assert_eq!(
            canonical,
            std::fs::canonicalize(&root)
                .unwrap()
                .join("not-written-yet.md")
        );
        assert!(assert_file_or_workspace_authorized(Some("editor-new"), &future).is_ok());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn unauthorized_paths_and_traversal_are_rejected() {
        let root = tmp("reject");
        let doc = root.join("note.md");
        std::fs::write(&doc, "x").unwrap();

        assert!(assert_dir_authorized(Some("editor-none"), &root).is_err());
        assert!(assert_file_or_workspace_authorized(None, &doc).is_err());
        assert!(reject_traversal(&root.join("../etc")).is_err());
        assert!(canonical_parent_and_name(&root.join("../note.md")).is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn absolute_path_rejects_relative_and_dot_components() {
        assert!(absolute_path(Path::new("/tmp/notes")).is_ok());
        assert!(absolute_path(Path::new("notes")).is_err());
        assert!(absolute_path(Path::new("/tmp/./notes")).is_err());
        assert!(absolute_path(Path::new("/tmp/../notes")).is_err());
    }

    #[test]
    fn workspace_directory_helpers_reject_traversal_and_relative_paths() {
        let directory = tmp("workspace-dir");
        let document = directory.join("document.md");
        std::fs::write(&document, "x").unwrap();

        assert_eq!(
            workspace_directory(&directory).unwrap(),
            std::fs::canonicalize(&directory).unwrap()
        );
        assert_eq!(
            document_directory_for_assets(&document).unwrap(),
            std::fs::canonicalize(&directory).unwrap()
        );
        assert!(workspace_directory(&directory.join("..")).is_err());
        assert!(document_directory_for_assets(Path::new("relative/document.md")).is_err());
        assert!(document_directory_for_assets(&directory.join("../document.md")).is_err());
        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn authorized_watch_path_restricts_watches_to_window_scope() {
        let workspace = tmp("watch-ws");
        let outside = tmp("watch-outside");
        let inside_doc = workspace.join("a.md");
        let standalone_doc = outside.join("solo.md");
        let sibling_doc = outside.join("other.md");
        std::fs::write(&inside_doc, "a").unwrap();
        std::fs::write(&standalone_doc, "b").unwrap();
        std::fs::write(&sibling_doc, "c").unwrap();

        authorize_workspace_root("watch-w1", &workspace).unwrap();
        authorize_document_file("watch-w1", &standalone_doc).unwrap();

        assert_eq!(
            authorized_watch_path("watch-w1", &workspace),
            Some(std::fs::canonicalize(&workspace).unwrap())
        );
        assert_eq!(
            authorized_watch_path("watch-w1", &inside_doc),
            Some(std::fs::canonicalize(&inside_doc).unwrap())
        );
        assert_eq!(
            authorized_watch_path("watch-w1", &standalone_doc),
            Some(std::fs::canonicalize(&standalone_doc).unwrap())
        );
        assert_eq!(authorized_watch_path("watch-w1", &outside), None);
        assert_eq!(authorized_watch_path("watch-w1", &sibling_doc), None);
        assert_eq!(authorized_watch_path("watch-w2", &workspace), None);

        revoke_window("watch-w1");
        assert_eq!(authorized_watch_path("watch-w1", &workspace), None);
        std::fs::remove_dir_all(workspace).ok();
        std::fs::remove_dir_all(outside).ok();
    }
}
