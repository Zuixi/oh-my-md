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
const DOCUMENT_READ_ONLY: &str = "document is read-only";

// Mutation-gate rejections (`assert_workspace_entry_mutable`).
const HIDDEN_ENTRY: &str = "workspace entry name must not start with '.'";
const SYMLINK_ENTRY: &str = "symbolic links cannot be modified in a workspace";
const NON_MARKDOWN_ENTRY: &str = "only markdown files and folders can be modified in a workspace";
const SPECIAL_ENTRY: &str = "special files cannot be modified in a workspace";
const WORKSPACE_ROOT_ENTRY: &str = "the workspace root itself cannot be renamed or deleted";

#[derive(Debug, Default)]
struct WindowAuth {
    roots: Vec<PathBuf>,
    files: Vec<PathBuf>,
    css_files: Vec<PathBuf>,
    export_targets: Vec<PathBuf>,
    /// Documents the host opened read-only (huge tier). Lives and dies with the
    /// window, like every other grant.
    read_only_files: Vec<PathBuf>,
}

/// Write access the host decided for one open document.
///
/// The renderer's `view.state.readOnly` only drives the UI: this value is set
/// from the byte size the host measured itself, so bypassing the frontend
/// policy cannot make a huge document writable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccessMode {
    ReadOnly,
    ReadWrite,
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

pub(crate) fn has_markdown_extension(path: &Path) -> bool {
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
        && has_visible_components(relative)
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
///
/// Listing, search, create, rename, and delete all funnel through here, so
/// refusing a hidden component once closes `/ws/.git` and `/ws/.env` for every
/// caller instead of per command. The rejection reuses the out-of-scope message
/// so a probe cannot tell "hidden" from "not granted".
pub fn assert_dir_authorized(window_label: Option<&str>, dir: &Path) -> Result<PathBuf, String> {
    let canonical = canonical_directory(dir)?;
    if !reaches_visible_root(scope_label(window_label), &canonical) {
        return Err(FILE_UNAUTHORIZED.into());
    }
    Ok(canonical)
}

/// An entry that passed the mutation gate: the entry's own path and the
/// metadata taken without following a symlink. The parent is the canonical
/// directory the caller already resolved.
pub(crate) struct MutableEntry {
    pub target: PathBuf,
    pub metadata: std::fs::Metadata,
}

/// The one gate for rename and delete.
///
/// The parent must be an authorized workspace directory, and the entry itself a
/// visible Markdown file or a visible subdirectory. Refusing symlinks stops a
/// link planted in a workspace from turning a rename into a move of
/// `~/.ssh/id_rsa`; refusing non-Markdown files stops
/// `rename("/ws/.env", "leak.md")` from laundering a hidden secret into a
/// readable document.
pub(crate) fn assert_workspace_entry_mutable(
    window_label: Option<&str>,
    parent: &Path,
    name: impl AsRef<Path>,
) -> Result<MutableEntry, String> {
    let name = name.as_ref();
    let parent = assert_dir_authorized(window_label, parent)?;
    if name.as_os_str().to_string_lossy().starts_with('.') {
        return Err(HIDDEN_ENTRY.into());
    }
    let target = parent.join(name);
    let metadata = std::fs::symlink_metadata(&target).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(SYMLINK_ENTRY.into());
    }
    if metadata.is_file() {
        if !has_markdown_extension(&target) {
            return Err(NON_MARKDOWN_ENTRY.into());
        }
        // A read-only document is not mutable either: rename and trash both
        // detach the bytes the host classified (trash is a delete). Also check
        // the already-fetched on-disk size so a renderer that skips stat/read
        // cannot bypass the threshold by directly renaming or trashing.
        if metadata.len() >= crate::documents::OPEN_READONLY_THRESHOLD_BYTES
            || is_document_read_only(window_label, &target)
        {
            return Err(DOCUMENT_READ_ONLY.into());
        }
    } else if metadata.is_dir() {
        // A visible folder may legitimately hold `.DS_Store` or images, so its
        // contents are not inspected. Only the root itself is off limits:
        // renaming or trashing it would detach every grant in the window.
        if is_granted_root(scope_label(window_label), &canonical_directory(&target)?) {
            return Err(WORKSPACE_ROOT_ENTRY.into());
        }
    } else {
        return Err(SPECIAL_ENTRY.into());
    }
    Ok(MutableEntry { target, metadata })
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

/// Records whether this window opened `file` read-only.
///
/// Crate-internal on purpose: a `#[tauri::command]` wrapper here would let a
/// compromised renderer clear its own protection. Only the host's own
/// stat/read results may call this.
pub fn set_document_access_mode(window_label: &str, file: &Path, mode: AccessMode) {
    let keys = access_mode_keys(file);
    let mut scopes = scopes();
    let auth = scopes.entry(window_label.to_string()).or_default();
    for key in keys {
        match mode {
            AccessMode::ReadOnly => push_unique(&mut auth.read_only_files, key),
            AccessMode::ReadWrite => auth.read_only_files.retain(|existing| existing != &key),
        }
    }
}

/// Whether this window opened `file` read-only; another window's verdict for
/// the same file never applies here.
pub fn is_document_read_only(window_label: Option<&str>, file_path: &Path) -> bool {
    let keys = access_mode_keys(file_path);
    let scopes = scopes();
    scopes
        .get(scope_label(window_label))
        .is_some_and(|auth| keys.iter().any(|key| auth.read_only_files.contains(key)))
}

/// The path forms one document can be granted under: its canonical form and,
/// for a symlinked node, the link itself. A path that cannot be resolved falls
/// back to its literal form, so an unclassifiable path is still matchable
/// rather than silently losing its read-only verdict.
fn access_mode_keys(file: &Path) -> Vec<PathBuf> {
    let mut keys = Vec::with_capacity(2);
    match resolve_canonical_with_missing_tail(file) {
        Ok(resolved) => keys.push(resolved),
        Err(_) => keys.push(file.to_path_buf()),
    }
    if let Some(lexical) = lexical_path(file) {
        keys.push(lexical);
    }
    keys
}

/// A document this window may write: authorized, not opened read-only, and not
/// already at or above the read-only size threshold on disk.
///
/// Resolves the path and acquires the scope lock once, and checks the on-disk
/// size directly so a renderer that skips `stat_document` / `read_document`
/// cannot bypass the read-only tier by invoking write commands directly.
/// Reads keep using `assert_file_or_workspace_authorized`, so a read-only
/// document still opens, exports, and resolves its assets.
pub fn assert_file_writable(
    window_label: Option<&str>,
    file_path: &Path,
) -> Result<(PathBuf, OsString), String> {
    let target = resolve_canonical_with_missing_tail(file_path)?;
    let lexical = lexical_path(file_path);
    let (authorized, read_only) = {
        let scopes = scopes();
        match scopes.get(scope_label(window_label)) {
            Some(auth) => {
                let explicit = auth.files.contains(&target)
                    || lexical
                        .as_ref()
                        .is_some_and(|path| auth.files.contains(path));
                let inside_root = auth.roots.iter().any(|root| root_grants(root, &target));
                let read_only = auth.read_only_files.contains(&target)
                    || lexical
                        .as_ref()
                        .is_some_and(|path| auth.read_only_files.contains(path));
                (explicit || inside_root, read_only)
            }
            None => (false, false),
        }
    };
    if !authorized {
        return Err(FILE_UNAUTHORIZED.into());
    }
    if read_only || exceeds_read_only_threshold(&target) {
        return Err(DOCUMENT_READ_ONLY.into());
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

fn exceeds_read_only_threshold(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| {
        meta.is_file() && meta.len() >= crate::documents::OPEN_READONLY_THRESHOLD_BYTES
    })
}

fn is_inside_root(scope: &str, canonical: &Path) -> bool {
    let scopes = scopes();
    scopes.get(scope).is_some_and(|auth| {
        auth.roots
            .iter()
            .any(|root| canonical == root || canonical.starts_with(root))
    })
}

/// The root itself, or a descendant whose components relative to the root are
/// all visible. Only the relative part is checked, so a grant whose own path
/// lives under a hidden ancestor (`~/.worktrees/notes`) stays usable.
fn reaches_visible_root(scope: &str, canonical: &Path) -> bool {
    let scopes = scopes();
    scopes.get(scope).is_some_and(|auth| {
        auth.roots.iter().any(|root| {
            canonical
                .strip_prefix(root)
                .is_ok_and(has_visible_components)
        })
    })
}

/// Whether every component of a root-relative path is visible. Dotfiles and
/// dot-directories are never reached through a recursive grant.
fn has_visible_components(relative: &Path) -> bool {
    !relative
        .components()
        .any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
}

fn is_granted_root(scope: &str, canonical: &Path) -> bool {
    let scopes = scopes();
    scopes
        .get(scope)
        .is_some_and(|auth| auth.roots.iter().any(|root| root == canonical))
}

/// A workspace root or a visible folder inside one. Existence is not required: a
/// folder deleted while its tab is open must still validate its session shard.
fn is_authorized_directory(window_label: Option<&str>, directory: &Path) -> bool {
    resolve_canonical_with_missing_tail(directory)
        .is_ok_and(|target| reaches_visible_root(scope_label(window_label), &target))
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
#[path = "auth_scope_tests.rs"]
mod tests;
