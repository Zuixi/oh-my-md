//! Per-window filesystem authorization.
//!
//! The previous process-global root list outlived every window that asked for
//! it: closing a workspace left its directory readable by any surviving (or
//! future) webview. Scope now belongs to the window label that requested it and
//! is dropped in `WindowEvent::Destroyed`.
//!
//! Grants come only from trusted Rust origins: a native dialog pick, a CLI/OS
//! open, native drag-drop, or a path already persisted in settings/session. The
//! webview can never grant itself a path — `allow_workspace_dir`,
//! `save_settings`, `save_session_state`, and `save_recent_files` validate
//! against existing grants or persisted state instead.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};

/// Scope for call sites with no window; never means "anything is allowed".
const INTERNAL_SCOPE: &str = "test";

/// What a recursive root grant may reach: never `Cargo.toml`, scripts, or bins.
const MARKDOWN_EXTENSIONS: [&str; 3] = ["md", "markdown", "mdx"];

const FILE_UNAUTHORIZED: &str = "path is outside the authorized workspace";
const WORKSPACE_UNAUTHORIZED: &str = "workspace directory was not authorized by user selection";
const CSS_UNAUTHORIZED: &str = "custom CSS path is outside authorized scope";
const EXPORT_UNAUTHORIZED: &str = "export path is outside authorized scope";
const SESSION_UNAUTHORIZED: &str = "session state contains unauthorized path";

#[derive(Debug, Default)]
struct WindowAuth {
    roots: Vec<PathBuf>,
    files: Vec<PathBuf>,
    css_files: Vec<PathBuf>,
    export_targets: Vec<PathBuf>,
}

/// Which per-window list a grant/assert operates on (one code path, three scopes).
#[derive(Clone, Copy)]
enum PathKind {
    Files,
    Css,
    ExportTargets,
}

impl WindowAuth {
    fn paths(&self, kind: PathKind) -> &[PathBuf] {
        match kind {
            PathKind::Files => &self.files,
            PathKind::Css => &self.css_files,
            PathKind::ExportTargets => &self.export_targets,
        }
    }

    fn paths_mut(&mut self, kind: PathKind) -> &mut Vec<PathBuf> {
        match kind {
            PathKind::Files => &mut self.files,
            PathKind::Css => &mut self.css_files,
            PathKind::ExportTargets => &mut self.export_targets,
        }
    }
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

fn push_unique(list: &mut Vec<PathBuf>, path: PathBuf) {
    if !list.iter().any(|existing| existing == &path) {
        list.push(path);
    }
}

/// Rejects `.`/`..` before any filesystem call: `canonicalize` alone resolves
/// `/docs/../etc` to `/etc`.
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
/// `Path::components` folds away `.`, so a raw segment scan is needed.
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

/// `canonical parent + name`: a symlinked document matches both through its
/// link node and through its resolved target.
fn lexical_path(path: &Path) -> Option<PathBuf> {
    let (parent, name) = canonical_parent_and_name(path).ok()?;
    Some(parent.join(name))
}

/// Canonical form that tolerates a path which does not exist (yet).
///
/// A save-as/export target has no inode, and a document whose folder was deleted
/// while its tab is open must still resolve to *itself* so the read answers
/// `Missing` instead of `PermissionDenied`. Canonicalizing the deepest existing
/// ancestor and re-appending the missing tail serves both, and keeps symlink and
/// macOS `/private/var` aliases aligned with what a later save reports back.
pub(crate) fn resolve_canonical_with_missing_tail(path: &Path) -> Result<PathBuf, String> {
    reject_traversal(path)?;
    absolute_path(path)?;
    if let Ok(resolved) = std::fs::canonicalize(path) {
        return Ok(resolved);
    }
    for ancestor in path.ancestors() {
        let Ok(existing) = std::fs::canonicalize(ancestor) else {
            continue;
        };
        if !existing.is_dir() {
            continue;
        }
        let tail = path
            .strip_prefix(ancestor)
            .map_err(|error| error.to_string())?;
        return Ok(existing.join(tail));
    }
    Err("path has no resolvable ancestor directory".into())
}

fn has_markdown_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            MARKDOWN_EXTENSIONS
                .iter()
                .any(|allowed| ext.eq_ignore_ascii_case(allowed))
        })
}

/// A root is recursive, so it refuses hidden paths (`.ssh/id_rsa`) and non-Markdown.
fn root_grants(root: &Path, target: &Path) -> bool {
    let Ok(relative) = target.strip_prefix(root) else {
        return false;
    };
    !relative.as_os_str().is_empty()
        && !relative
            .components()
            .any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
        && has_markdown_extension(target)
}

fn grant_path(window_label: &str, file: &Path, kind: PathKind) -> Result<PathBuf, String> {
    let resolved = resolve_canonical_with_missing_tail(file)?;
    let lexical = lexical_path(file);
    let mut scopes = scopes();
    let granted = scopes
        .entry(window_label.to_string())
        .or_default()
        .paths_mut(kind);
    push_unique(granted, resolved.clone());
    if let Some(lexical) = lexical {
        push_unique(granted, lexical);
    }
    Ok(resolved)
}

fn assert_path(
    window_label: Option<&str>,
    file: &Path,
    kind: PathKind,
    message: &str,
) -> Result<PathBuf, String> {
    let target = resolve_canonical_with_missing_tail(file)?;
    let lexical = lexical_path(file);
    let scopes = scopes();
    let authorized = scopes.get(scope_label(window_label)).is_some_and(|auth| {
        let granted = auth.paths(kind);
        granted.contains(&target) || lexical.is_some_and(|path| granted.contains(&path))
    });
    if authorized {
        Ok(target)
    } else {
        Err(message.into())
    }
}

/// Grants `dir` (canonicalized) to one window's workspace scope.
pub fn authorize_workspace_root(window_label: &str, dir: &Path) -> Result<PathBuf, String> {
    let root = canonical_directory(dir)?;
    let mut scopes = scopes();
    let auth = scopes.entry(window_label.to_string()).or_default();
    push_unique(&mut auth.roots, root.clone());
    Ok(root)
}

/// Grants one document file to a window. Called after a trusted pick, an OS
/// open, or a successful read/save so a standalone file (no workspace folder)
/// stays editable and keeps version history.
pub fn authorize_document_file(window_label: &str, file: &Path) -> Result<PathBuf, String> {
    grant_path(window_label, file, PathKind::Files)
}

/// Grants one custom stylesheet to a window (native CSS picker, or the path
/// already persisted in settings).
pub fn authorize_custom_css(window_label: &str, file: &Path) -> Result<PathBuf, String> {
    grant_path(window_label, file, PathKind::Css)
}

/// Grants one export destination to a window (native save-dialog pick).
pub fn authorize_export_target(window_label: &str, file: &Path) -> Result<PathBuf, String> {
    grant_path(window_label, file, PathKind::ExportTargets)
}

/// Requires `file` to be a stylesheet this window was allowed to read.
pub fn assert_custom_css_authorized(
    window_label: Option<&str>,
    file: &Path,
) -> Result<PathBuf, String> {
    assert_path(window_label, file, PathKind::Css, CSS_UNAUTHORIZED)
}

/// Requires `file` to be an export destination this window picked.
pub fn assert_export_target_authorized(
    window_label: Option<&str>,
    file: &Path,
) -> Result<PathBuf, String> {
    assert_path(
        window_label,
        file,
        PathKind::ExportTargets,
        EXPORT_UNAUTHORIZED,
    )
}

/// Drops everything `window_label` was granted. Called from
/// `WindowEvent::Destroyed` so a closed workspace stops being reachable.
pub fn revoke_window(window_label: &str) {
    scopes().remove(window_label);
}

/// Requires `dir` to be inside one of this window's workspace roots.
pub fn assert_dir_authorized(window_label: Option<&str>, dir: &Path) -> Result<PathBuf, String> {
    let canonical = canonical_directory(dir)?;
    if is_inside_root(scope_label(window_label), &canonical) {
        Ok(canonical)
    } else {
        Err(FILE_UNAUTHORIZED.into())
    }
}

/// A document this window may read or write: an explicit file grant, or a
/// Markdown file inside a granted workspace root.
pub fn assert_file_or_workspace_authorized(
    window_label: Option<&str>,
    file_path: &Path,
) -> Result<(PathBuf, OsString), String> {
    let target = resolve_canonical_with_missing_tail(file_path)?;
    let explicit = assert_path(window_label, file_path, PathKind::Files, FILE_UNAUTHORIZED).is_ok();
    let inside_root = {
        let scopes = scopes();
        scopes
            .get(scope_label(window_label))
            .is_some_and(|auth| auth.roots.iter().any(|root| root_grants(root, &target)))
    };
    if !explicit && !inside_root {
        return Err(FILE_UNAUTHORIZED.into());
    }
    let name = target
        .file_name()
        .ok_or_else(|| "path must include a file name".to_string())?
        .to_os_string();
    let parent = target
        .parent()
        .ok_or_else(|| "path must include a parent directory".to_string())?
        .to_path_buf();
    Ok((parent, name))
}

fn is_inside_root(scope: &str, canonical: &Path) -> bool {
    let scopes = scopes();
    scopes.get(scope).is_some_and(|auth| {
        auth.roots
            .iter()
            .any(|root| canonical == root || canonical.starts_with(root))
    })
}

/// A workspace root or a folder inside one. Existence is not required: a folder
/// deleted while its tab is open must still validate its session shard.
fn is_authorized_directory(window_label: Option<&str>, directory: &Path) -> bool {
    resolve_canonical_with_missing_tail(directory)
        .is_ok_and(|target| is_inside_root(scope_label(window_label), &target))
}

/// A watch target, only when it exists and belongs to this window's scope.
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

/// `allow_workspace_dir` root: absolute, no traversal, existing directory.
pub(crate) fn workspace_directory(path: &Path) -> Result<PathBuf, String> {
    absolute_path(path)
        .map_err(|_| "workspace path must be an absolute path without traversal".to_string())?;
    std::fs::canonicalize(path).map_err(|e| format!("failed to resolve workspace directory: {e}"))
}

/// Validates a webview-requested workspace grant. Only two requests are
/// legitimate: a folder a trusted Rust origin already granted (native picker,
/// restored session), or — for the first standalone file of an empty window —
/// that file's own parent folder, which is how the sidebar reveals a lone
/// document. The filesystem root and `$HOME` are never promoted implicitly, so a
/// compromised webview cannot turn the user profile into a workspace. The second
/// value says whether to widen the asset scope recursively.
pub fn authorize_requested_workspace_dir(
    window_label: &str,
    path: &Path,
) -> Result<(PathBuf, bool), String> {
    let directory = workspace_directory(path)?;
    let mut scopes = scopes();
    let auth = scopes.entry(window_label.to_string()).or_default();
    if auth.roots.contains(&directory) {
        return Ok((directory, true));
    }
    let home = dirs::home_dir().and_then(|home| std::fs::canonicalize(home).ok());
    let standalone_parent = auth.roots.is_empty()
        && directory.parent().is_some()
        && home.as_deref() != Some(directory.as_path())
        && auth
            .files
            .iter()
            .any(|file| file.parent() == Some(directory.as_path()));
    if !standalone_parent {
        return Err(WORKSPACE_UNAUTHORIZED.into());
    }
    auth.roots.push(directory.clone());
    Ok((directory, true))
}

/// Whether `document_path` lives in a workspace root; standalone answers false.
pub fn is_document_inside_workspace(window_label: Option<&str>, document_path: &Path) -> bool {
    resolve_canonical_with_missing_tail(document_path)
        .is_ok_and(|target| is_inside_root(scope_label(window_label), &target))
}

/// Asset scope is recursive and serves files back to the webview, so only a
/// document this window opened/saved (or one inside its root) may widen it.
pub fn authorized_document_directory(
    window_label: Option<&str>,
    document_path: &Path,
) -> Result<PathBuf, String> {
    assert_file_or_workspace_authorized(window_label, document_path)?;
    document_directory_for_assets(document_path)
}

/// Directory the asset protocol needs in scope: the canonical parent.
pub(crate) fn document_directory_for_assets(document_path: &Path) -> Result<PathBuf, String> {
    absolute_path(document_path)
        .map_err(|_| "document path must be an absolute path without traversal".to_string())?;
    let parent = document_path
        .parent()
        .ok_or_else(|| "document path must have a parent directory".to_string())?;
    std::fs::canonicalize(parent).map_err(|e| format!("failed to resolve document directory: {e}"))
}

fn json_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|entry| entry.as_str())
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
}

/// Every document path a `SavedSessionState` payload references.
fn session_paths(value: &serde_json::Value) -> Vec<String> {
    let open = value.get("openPaths").and_then(|entry| entry.as_array());
    let tabs = value.get("hotExitTabs").and_then(|entry| entry.as_array());
    open.into_iter()
        .flatten()
        .filter_map(|path| path.as_str())
        .map(str::to_owned)
        .chain(
            tabs.into_iter()
                .flatten()
                .filter_map(|tab| json_string(tab, "path")),
        )
        .filter(|path| !path.is_empty())
        .collect()
}

/// Grants a restored session's folder and files to the window replaying it, so
/// crash-recovered tabs and standalone documents stay readable and saveable.
pub fn authorize_from_session_json(window_label: &str, payload_json: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload_json) else {
        return;
    };
    if let Some(folder) = json_string(&value, "folder") {
        if Path::new(&folder).is_dir() {
            let _ = authorize_workspace_root(window_label, Path::new(&folder));
        }
    }
    for path in session_paths(&value) {
        let _ = authorize_document_file(window_label, Path::new(&path));
    }
}

/// Grants the stylesheet a persisted settings payload points at.
pub fn authorize_from_settings_json(window_label: &str, settings_json: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(settings_json) else {
        return;
    };
    if let Some(path) = json_string(&value, "customCssPath") {
        let _ = authorize_custom_css(window_label, Path::new(&path));
    }
}

/// Refuses a session shard that introduces a path this window never had.
///
/// A shard is just JSON the webview can write, so without this check a
/// compromised renderer could persist `"/etc/passwd"` as an `openPath` and read
/// it back as "restored state". A path already on disk keeps passing, so an
/// existing shard stays saveable instead of wedging the flush.
pub fn validate_session_json_for_save(
    window_label: &str,
    candidate_json: &str,
    existing_disk_json: Option<&str>,
) -> Result<(), String> {
    let candidate: serde_json::Value = serde_json::from_str(candidate_json)
        .map_err(|_| "session state is not valid JSON".to_string())?;
    let existing: Option<serde_json::Value> =
        existing_disk_json.and_then(|raw| serde_json::from_str(raw).ok());
    let persisted_folder = existing
        .as_ref()
        .and_then(|value| json_string(value, "folder"));
    let persisted_paths = existing.as_ref().map(session_paths).unwrap_or_default();
    if let Some(folder) = json_string(&candidate, "folder") {
        let unchanged = persisted_folder.as_deref() == Some(folder.as_str());
        if !unchanged && !is_authorized_directory(Some(window_label), Path::new(&folder)) {
            return Err(SESSION_UNAUTHORIZED.into());
        }
    }
    for path in session_paths(&candidate) {
        if persisted_paths.contains(&path) {
            continue;
        }
        if assert_file_or_workspace_authorized(Some(window_label), Path::new(&path)).is_err() {
            return Err(SESSION_UNAUTHORIZED.into());
        }
    }
    Ok(())
}

/// Refuses a settings write that smuggles in an unvetted `customCssPath`; the
/// already-persisted value keeps passing.
pub fn validate_settings_json_for_save(
    window_label: &str,
    candidate_json: &str,
    existing_disk_json: &str,
) -> Result<(), String> {
    let candidate: serde_json::Value = serde_json::from_str(candidate_json)
        .map_err(|_| "settings are not valid JSON".to_string())?;
    let Some(path) = json_string(&candidate, "customCssPath") else {
        return Ok(());
    };
    let existing: Option<serde_json::Value> = serde_json::from_str(existing_disk_json).ok();
    if existing
        .as_ref()
        .and_then(|value| json_string(value, "customCssPath"))
        .as_deref()
        == Some(path.as_str())
    {
        return Ok(());
    }
    assert_custom_css_authorized(Some(window_label), Path::new(&path)).map(|_| ())
}

/// Hands opens from one window to another; every path must already be
/// authorized for the source window.
pub fn copy_authorized_files_to_window(
    from_label: &str,
    to_label: &str,
    paths: &[String],
) -> Result<(), String> {
    for path in paths {
        assert_file_or_workspace_authorized(Some(from_label), Path::new(path))?;
    }
    for path in paths {
        authorize_document_file(to_label, Path::new(path))?;
    }
    Ok(())
}

/// Grants a crash-recovery record's document path to the window adopting it.
pub fn authorize_recovered_paths<'a>(window_label: &str, paths: impl IntoIterator<Item = &'a str>) {
    for path in paths {
        let _ = authorize_document_file(window_label, Path::new(path));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("omd-auth-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn write(path: &Path) {
        std::fs::write(path, "x").unwrap();
    }

    fn canonical(path: &Path) -> PathBuf {
        std::fs::canonicalize(path).unwrap()
    }

    #[test]
    fn workspace_root_authorization_is_scoped_per_window() {
        let root = tmp("per-window");
        let doc = root.join("note.md");
        write(&doc);

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
        write(&doc);
        write(&sibling);

        authorize_document_file("editor-file", &doc).unwrap();

        assert!(assert_file_or_workspace_authorized(Some("editor-file"), &doc).is_ok());
        // Siblings and the folder stay out of scope; the grant is that one file.
        assert!(assert_file_or_workspace_authorized(Some("editor-file"), &sibling).is_err());
        assert!(assert_dir_authorized(Some("editor-file"), &root).is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_file_that_does_not_exist_yet_is_authorizable_by_parent_and_name() {
        let root = tmp("future-file");
        let future = root.join("not-written-yet.md");

        let resolved = authorize_document_file("editor-new", &future).unwrap();

        assert_eq!(resolved, canonical(&root).join("not-written-yet.md"));
        assert!(assert_file_or_workspace_authorized(Some("editor-new"), &future).is_ok());
        // A deleted tail still resolves against its deepest existing ancestor,
        // so an open tab whose folder vanished reads as missing, not forbidden.
        let gone = root.join("gone/deep/note.md");
        assert_eq!(
            resolve_canonical_with_missing_tail(&gone).unwrap(),
            canonical(&root).join("gone/deep/note.md")
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn paths_must_be_absolute_existing_and_free_of_traversal() {
        let root = tmp("reject");
        let doc = root.join("note.md");
        write(&doc);
        let base = std::env::temp_dir();

        assert!(assert_dir_authorized(Some("editor-none"), &root).is_err());
        assert!(assert_file_or_workspace_authorized(None, &doc).is_err());
        assert!(resolve_canonical_with_missing_tail(Path::new("relative/x.md")).is_err());
        for traversal in [root.join("../etc"), root.join("../note.md")] {
            assert!(reject_traversal(&traversal).is_err());
            assert!(canonical_parent_and_name(&traversal).is_err());
            assert!(resolve_canonical_with_missing_tail(&traversal).is_err());
        }
        assert!(absolute_path(&base.join("notes")).is_ok());
        assert!(absolute_path(Path::new("notes")).is_err());
        assert!(absolute_path(&base.join(".").join("notes")).is_err());
        assert!(absolute_path(&base.join("..").join("notes")).is_err());
        assert_eq!(workspace_directory(&root).unwrap(), canonical(&root));
        assert_eq!(
            document_directory_for_assets(&doc).unwrap(),
            canonical(&root)
        );
        assert!(workspace_directory(&root.join("..")).is_err());
        assert!(document_directory_for_assets(Path::new("relative/document.md")).is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn authorized_watch_path_restricts_watches_to_window_scope() {
        let workspace = tmp("watch-ws");
        let outside = tmp("watch-outside");
        let inside_doc = workspace.join("a.md");
        let standalone_doc = outside.join("solo.md");
        let sibling_doc = outside.join("other.md");
        for path in [&inside_doc, &standalone_doc, &sibling_doc] {
            write(path);
        }

        authorize_workspace_root("watch-w1", &workspace).unwrap();
        authorize_document_file("watch-w1", &standalone_doc).unwrap();

        assert_eq!(
            authorized_watch_path("watch-w1", &workspace),
            Some(canonical(&workspace))
        );
        assert_eq!(
            authorized_watch_path("watch-w1", &inside_doc),
            Some(canonical(&inside_doc))
        );
        assert_eq!(
            authorized_watch_path("watch-w1", &standalone_doc),
            Some(canonical(&standalone_doc))
        );
        assert_eq!(authorized_watch_path("watch-w1", &outside), None);
        assert_eq!(authorized_watch_path("watch-w1", &sibling_doc), None);
        assert_eq!(authorized_watch_path("watch-w2", &workspace), None);

        revoke_window("watch-w1");
        assert_eq!(authorized_watch_path("watch-w1", &workspace), None);
        std::fs::remove_dir_all(workspace).ok();
        std::fs::remove_dir_all(outside).ok();
    }

    #[test]
    fn a_requested_workspace_dir_must_have_been_granted() {
        let root = tmp("requested");
        let doc = root.join("note.md");
        write(&doc);

        assert!(authorize_requested_workspace_dir("req-w", &root).is_err());

        // A standalone file promotes its own folder once, which is how the tree
        // reveals a lone document.
        authorize_document_file("req-w", &doc).unwrap();
        assert_eq!(
            authorize_requested_workspace_dir("req-w", &root).unwrap().0,
            canonical(&root)
        );
        // One-way and root-scoped: a sibling folder and `/` are both refused.
        let sibling = tmp("requested-sibling");
        assert!(authorize_requested_workspace_dir("req-w", &sibling).is_err());
        assert!(authorize_requested_workspace_dir("req-w", Path::new("/")).is_err());
        if let Some(home) = dirs::home_dir() {
            if authorize_document_file("req-home", &home.join("omd-auth-probe.md")).is_ok() {
                assert!(authorize_requested_workspace_dir("req-home", &home).is_err());
            }
        }
        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(sibling).ok();
    }

    #[test]
    fn session_and_settings_state_cannot_launder_an_unauthorized_path() {
        let root = tmp("config-state");
        let doc = root.join("note.md");
        let css = root.join("theme.css");
        write(&doc);
        write(&css);
        let session = format!(
            r#"{{"folder":{:?},"openPaths":[{:?}],"hotExitTabs":[{{"path":{doc:?}}}]}}"#,
            root.to_string_lossy(),
            doc.to_string_lossy(),
        );
        let settings = format!(r#"{{"customCssPath":{:?}}}"#, css.to_string_lossy());

        // Nothing is granted yet, so no persisted payload may claim these paths.
        assert!(validate_session_json_for_save("state-w", &session, None).is_err());
        assert!(validate_session_json_for_save("state-w", "{not json", None).is_err());
        assert!(validate_settings_json_for_save("state-w", &settings, "{}").is_err());

        authorize_from_session_json("state-w", &session);
        authorize_from_settings_json("state-w", &settings);
        validate_session_json_for_save("state-w", &session, None).unwrap();
        validate_settings_json_for_save("state-w", &settings, "{}").unwrap();

        // Laundering: state that names a path this window never had. It has to
        // be outside the granted root — a Markdown file inside it is legitimate.
        let other =
            std::env::temp_dir().join(format!("omd-auth-laundered-{}.md", std::process::id()));
        let laundered_session = format!(r#"{{"openPaths":[{:?}]}}"#, other.to_string_lossy());
        let laundered_settings = format!(r#"{{"customCssPath":{:?}}}"#, other.to_string_lossy());
        assert!(validate_session_json_for_save("state-w", &laundered_session, None).is_err());
        assert!(validate_settings_json_for_save("state-w", &laundered_settings, "{}").is_err());
        // ...unless that exact path is already on disk (keeps a flush alive).
        let on_disk = Some(laundered_session.as_str());
        validate_session_json_for_save("state-w", &laundered_session, on_disk).unwrap();
        validate_settings_json_for_save("state-w", &laundered_settings, &laundered_settings)
            .unwrap();
        validate_settings_json_for_save("state-w", r#"{"fontSize":18}"#, "{}").unwrap();
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_window_handoff_copies_only_authorized_files() {
        let root = tmp("handoff");
        let doc = root.join("note.md");
        let foreign = root.join("foreign.md");
        write(&doc);
        write(&foreign);
        authorize_document_file("handoff-from", &doc).unwrap();

        let copy =
            |paths: &[String]| copy_authorized_files_to_window("handoff-from", "handoff-to", paths);
        copy(&[doc.to_string_lossy().into_owned()]).unwrap();
        assert!(assert_file_or_workspace_authorized(Some("handoff-to"), &doc).is_ok());

        let foreign_paths = [foreign.to_string_lossy().into_owned()];
        assert!(copy(&foreign_paths).is_err());
        assert!(assert_file_or_workspace_authorized(Some("handoff-to"), &foreign).is_err());

        authorize_recovered_paths("handoff-to", [foreign.to_string_lossy().as_ref()]);
        assert!(assert_file_or_workspace_authorized(Some("handoff-to"), &foreign).is_ok());
        assert!(!is_document_inside_workspace(Some("handoff-to"), &foreign));
        std::fs::remove_dir_all(root).ok();
    }
}
