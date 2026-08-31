use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use regex::RegexBuilder;

static AUTHORIZED_ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
// Serializes tests that mutate OMD_CONFIG_DIR / OMD_RECOVERY_DIR so parallel
// runs cannot observe each other's env vars (config_dir() reads them live).
#[cfg(test)]
static CONFIG_ENV_LOCK: Mutex<()> = Mutex::new(());

const MARKDOWN_EXT: &[&str] = &["md", "markdown", "mdx"];
const MARKDOWN_FILE_EXTENSION: &str = "md";

const MAX_SEARCH_HITS: usize = 500;
const MAX_LINE_BYTES: usize = 200;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct SearchHit {
    pub path: String,
    pub line: usize,
    pub text: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct QuickOpenResponse {
    pub paths: Vec<String>,
    pub truncated: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct RecoveryRecord {
    pub key: String,
    pub label: String,
}

// Must match `identifier` in tauri.conf.json; the log plugin already resolves
// its LogDir from the same identifier, so config and logs share one root.
const APP_DATA_DIR_NAME: &str = "md.ohmy.desktop";

pub fn recovery_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("OMD_RECOVERY_DIR") {
        return PathBuf::from(dir);
    }
    config_dir().join("recovery")
}

pub fn write_recovery(key: String, contents: String) -> Result<(), String> {
    if key.is_empty() || key.contains("..") {
        return Err("recovery key is invalid".into());
    }
    let dir = recovery_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(&key), contents).map_err(|e| e.to_string())
}

pub fn list_recoveries() -> Result<Vec<RecoveryRecord>, String> {
    let dir = recovery_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut records = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        records.push(RecoveryRecord {
            key: name.clone(),
            label: name,
        });
    }
    records.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(records)
}

pub fn read_recovery(key: String) -> Result<String, String> {
    fs::read_to_string(recovery_dir().join(valid_key(&key)?)).map_err(|e| e.to_string())
}

pub fn clear_recovery(key: String) -> Result<(), String> {
    let path = recovery_dir().join(valid_key(&key)?);
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("OMD_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    // The OS may purge temp dirs at any time; user state must live in app data.
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(APP_DATA_DIR_NAME)
}

fn legacy_config_dir() -> PathBuf {
    std::env::temp_dir().join("oh-my-md-config")
}

fn legacy_recovery_dir() -> PathBuf {
    std::env::temp_dir().join("oh-my-md-recovery")
}

/// One-time move of pre-app-data state out of the temp dir. File-level and
/// idempotent: an interrupted run leaves the remainder for the next launch,
/// and a rerun never overwrites an already-migrated file.
pub fn migrate_legacy_config() -> Result<(), String> {
    // Env overrides pin directories for tests and dev; never touch them.
    if std::env::var_os("OMD_CONFIG_DIR").is_some()
        || std::env::var_os("OMD_RECOVERY_DIR").is_some()
    {
        return Ok(());
    }
    migrate_dir_files(&legacy_config_dir(), &config_dir())?;
    migrate_dir_files(&legacy_recovery_dir(), &recovery_dir())
}

fn migrate_dir_files(legacy: &Path, target: &Path) -> Result<(), String> {
    if !legacy.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(legacy).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let dest = target.join(entry.file_name());
        if dest.exists() {
            continue;
        }
        move_file(&entry.path(), &dest)?;
    }
    // Only removes when empty; a leftover subdir keeps the dir for a rerun.
    fs::remove_dir(legacy).ok();
    Ok(())
}

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    // Cross-volume fallback: copy first, delete only after the copy lands.
    fs::copy(from, to).map_err(|e| e.to_string())?;
    fs::remove_file(from).map_err(|e| e.to_string())
}

// --- Version-history snapshots -------------------------------------------------

const MAX_SNAPSHOTS_PER_FILE: usize = 20;
const SNAPSHOT_NAME_MAX_DIGITS: usize = 19;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub file_name: String,
    pub mtime_ms: u64,
    pub size_bytes: u64,
}

fn snapshots_root(parent: &Path, name: &str) -> PathBuf {
    let mut hasher = blake3::Hasher::new();
    hasher.update(parent.to_string_lossy().as_bytes());
    hasher.update(name.as_bytes());
    let key: String = hasher.finalize().to_hex().chars().take(16).collect();
    config_dir().join("snapshots").join(key)
}

fn valid_snapshot_name(file_name: &str) -> bool {
    let Some(stem) = file_name.strip_suffix(".md") else {
        return false;
    };
    !stem.is_empty()
        && stem.len() <= SNAPSHOT_NAME_MAX_DIGITS
        && stem.bytes().all(|byte| byte.is_ascii_digit())
}

fn rotate_snapshots(dir: &Path) -> Result<(), String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if valid_snapshot_name(&name) {
                Some(name)
            } else {
                None
            }
        })
        .collect();
    names.sort();
    // Timestamp names sort chronologically; drop the oldest beyond the cap.
    while names.len() > MAX_SNAPSHOTS_PER_FILE {
        let oldest = names.remove(0);
        fs::remove_file(dir.join(oldest)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_snapshot(dir: &Path, millis: u128, source: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let target = dir.join(format!("{millis}.md"));
    fs::copy(source, &target).map_err(|e| e.to_string())?;
    rotate_snapshots(dir)
}

pub fn snapshot_document(path: String) -> Result<(), String> {
    let (parent, name) = canonical_parent_and_name(Path::new(&path))?;
    assert_inside_authorized(&parent)?;
    let name = name.to_string_lossy().into_owned();
    let source = parent.join(&name);
    if !source.is_file() {
        return Err("snapshot source is not a file".into());
    }
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    write_snapshot(&snapshots_root(&parent, &name), millis, &source)
}

pub fn list_snapshots(path: String) -> Result<Vec<SnapshotEntry>, String> {
    let (parent, name) = canonical_parent_and_name(Path::new(&path))?;
    assert_inside_authorized(&parent)?;
    let name = name.to_string_lossy().into_owned();
    let dir = snapshots_root(&parent, &name);
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut entries: Vec<SnapshotEntry> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if !valid_snapshot_name(&file_name) {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            let mtime_ms = metadata
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis() as u64;
            Some(SnapshotEntry {
                file_name,
                mtime_ms,
                size_bytes: metadata.len(),
            })
        })
        .collect();
    // Newest first for the history list.
    entries.sort_by(|a, b| b.file_name.cmp(&a.file_name));
    Ok(entries)
}

pub fn read_snapshot(path: String, file_name: String) -> Result<String, String> {
    if !valid_snapshot_name(&file_name) {
        return Err("snapshot name is invalid".into());
    }
    let (parent, name) = canonical_parent_and_name(Path::new(&path))?;
    assert_inside_authorized(&parent)?;
    let name = name.to_string_lossy().into_owned();
    let snapshot = snapshots_root(&parent, &name).join(&file_name);
    fs::read_to_string(snapshot).map_err(|e| e.to_string())
}

pub fn clear_snapshots(path: String) -> Result<(), String> {
    let (parent, name) = canonical_parent_and_name(Path::new(&path))?;
    assert_inside_authorized(&parent)?;
    let name = name.to_string_lossy().into_owned();
    let dir = snapshots_root(&parent, &name);
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn get_settings() -> Result<String, String> {
    let path = config_dir().join("settings.json");
    if !path.exists() {
        return Ok("{}".into());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

pub fn save_settings(contents: String) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::atomic_write(&dir.join("settings.json"), contents.as_bytes())
}

pub fn get_session_state() -> Result<String, String> {
    let path = config_dir().join("session.json");
    if !path.exists() {
        return Ok("{}".into());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

pub fn save_session_state(contents: String) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::atomic_write(&dir.join("session.json"), contents.as_bytes())
}

fn valid_key(key: &str) -> Result<&str, String> {
    if key.is_empty() || key.contains("..") || key.contains('/') || key.contains('\\') {
        return Err("recovery key is invalid".into());
    }
    Ok(key)
}

pub fn authorize_workspace_root(path: &Path) -> Result<PathBuf, String> {
    let root = canonical_directory(path)?;
    let mut roots = AUTHORIZED_ROOTS
        .lock()
        .map_err(|_| "workspace authorization lock is poisoned".to_string())?;
    if !roots.iter().any(|existing| existing == &root) {
        roots.push(root.clone());
    }
    Ok(root)
}

fn assert_inside_authorized(path: &Path) -> Result<(), String> {
    let roots = AUTHORIZED_ROOTS
        .lock()
        .map_err(|_| "workspace authorization lock is poisoned".to_string())?;
    if roots
        .iter()
        .any(|root| path == root || path.starts_with(root))
    {
        Ok(())
    } else {
        Err("path is outside the authorized workspace".into())
    }
}

fn reject_traversal(path: &Path) -> Result<(), String> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("path must not contain traversal".into());
    }
    Ok(())
}

fn validate_single_segment(name: &str) -> Result<&str, String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("name must be a single path segment".into());
    }
    if Path::new(name).components().count() != 1 {
        return Err("name must be a single path segment".into());
    }
    Ok(name)
}

fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    reject_traversal(path)?;
    let directory = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !directory.is_dir() {
        return Err("path is not a directory".into());
    }
    Ok(directory)
}

fn canonical_parent_and_name(path: &Path) -> Result<(PathBuf, &std::ffi::OsStr), String> {
    reject_traversal(path)?;
    let name = path
        .file_name()
        .ok_or_else(|| "path must include a file or directory name".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "path must include a parent directory".to_string())?;
    Ok((canonical_directory(parent)?, name))
}

pub fn create_markdown(dir: String, name: String) -> Result<String, String> {
    let name = validate_single_segment(&name)?;
    if Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        != Some(MARKDOWN_FILE_EXTENSION)
    {
        return Err("markdown files must use a .md extension".into());
    }
    let parent = canonical_directory(Path::new(&dir))?;
    assert_inside_authorized(&parent)?;
    let target = parent.join(name);
    if target.exists() {
        return Err("path already exists".into());
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

pub fn create_dir(dir: String, name: String) -> Result<String, String> {
    let name = validate_single_segment(&name)?;
    let parent = canonical_directory(Path::new(&dir))?;
    assert_inside_authorized(&parent)?;
    let target = parent.join(name);
    if target.exists() {
        return Err("path already exists".into());
    }
    fs::create_dir(&target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

pub fn rename_path(from: String, to_name: String) -> Result<String, String> {
    let to_name = validate_single_segment(&to_name)?;
    let (parent, current_name) = canonical_parent_and_name(Path::new(&from))?;
    assert_inside_authorized(&parent)?;
    let source = parent.join(current_name);
    let source_metadata = fs::metadata(&source).map_err(|e| e.to_string())?;
    if source_metadata.is_file()
        && source
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case(MARKDOWN_FILE_EXTENSION))
        && Path::new(to_name)
            .extension()
            .and_then(|extension| extension.to_str())
            != Some(MARKDOWN_FILE_EXTENSION)
    {
        return Err("markdown files must keep a .md extension".into());
    }
    let target = parent.join(to_name);
    if target.exists() {
        return Err("path already exists".into());
    }
    fs::rename(&source, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

pub fn delete_path(path: String) -> Result<(), String> {
    let (parent, name) = canonical_parent_and_name(Path::new(&path))?;
    assert_inside_authorized(&parent)?;
    let name = name.to_string_lossy().into_owned();
    let target = parent.join(name);
    // Fail fast on a missing target so callers keep their not-found semantics.
    fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    // Tree deletion moves to the OS Trash; the app never deletes permanently.
    trash::delete(&target).map_err(|e| e.to_string())
}

pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_dir_sync(&path))
        .await
        .map_err(|error| format!("directory listing task failed: {error}"))?
}

pub(crate) fn list_dir_sync(path: &str) -> Result<Vec<DirEntry>, String> {
    let root = Path::new(path);
    reject_traversal(root)?;
    if !root.is_dir() {
        return Err("path is not a directory".into());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = file_type.is_dir();
        if !is_dir && !is_markdown(&name) {
            continue;
        }
        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(entries)
}

pub async fn search_markdown(
    root: String,
    query: String,
    case_sensitive: bool,
) -> Result<SearchResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_markdown_sync(&root, &query, case_sensitive)
    })
    .await
    .map_err(|error| format!("markdown search task failed: {error}"))?
}

pub(crate) fn search_markdown_sync(
    root: &str,
    query: &str,
    case_sensitive: bool,
) -> Result<SearchResponse, String> {
    if query.trim().is_empty() {
        return Ok(SearchResponse {
            hits: vec![],
            truncated: false,
        });
    }
    let dir = Path::new(root);
    reject_traversal(dir)?;
    let matcher = build_matcher(query, case_sensitive)?;

    let mut builder = ignore::WalkBuilder::new(dir);
    builder
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .max_filesize(Some(MAX_FILE_BYTES));
    let walker = builder.build_parallel();

    let results = Mutex::new(Vec::new());
    let truncated = AtomicBool::new(false);

    walker.run(|| {
        Box::new(|entry| {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => return ignore::WalkState::Continue,
            };
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return ignore::WalkState::Continue;
            }
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !is_markdown(name) {
                return ignore::WalkState::Continue;
            }
            let content = match std::fs::read(path) {
                Ok(bytes) => bytes,
                Err(_) => return ignore::WalkState::Continue,
            };
            let content = match std::str::from_utf8(&content) {
                Ok(text) => text,
                Err(_) => return ignore::WalkState::Continue,
            };
            let mut hits = results.lock().unwrap();
            if hits.len() >= MAX_SEARCH_HITS {
                truncated.store(true, Ordering::Relaxed);
                return ignore::WalkState::Quit;
            }
            let remaining = MAX_SEARCH_HITS - hits.len();
            let file_hits = collect_file_hits(path, content, &matcher, remaining);
            let capped = file_hits.len() >= remaining;
            hits.extend(file_hits);
            if capped {
                truncated.store(true, Ordering::Relaxed);
                return ignore::WalkState::Quit;
            }
            ignore::WalkState::Continue
        })
    });

    let mut hits = results.into_inner().unwrap();
    hits.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    let capped = hits.len() >= MAX_SEARCH_HITS;
    hits.truncate(MAX_SEARCH_HITS);
    Ok(SearchResponse {
        hits,
        truncated: truncated.load(Ordering::Relaxed) || capped,
    })
}

const MAX_QUICK_OPEN_FILES: usize = 5000;

pub async fn list_markdown_files(root: String) -> Result<QuickOpenResponse, String> {
    tauri::async_runtime::spawn_blocking(move || list_markdown_files_sync(&root))
        .await
        .map_err(|error| format!("markdown listing task failed: {error}"))?
}

pub(crate) fn list_markdown_files_sync(root: &str) -> Result<QuickOpenResponse, String> {
    let dir = Path::new(root);
    reject_traversal(dir)?;

    let mut builder = ignore::WalkBuilder::new(dir);
    builder
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .max_filesize(Some(MAX_FILE_BYTES));
    let walker = builder.build_parallel();

    let paths = Mutex::new(Vec::new());
    let truncated = AtomicBool::new(false);
    walker.run(|| {
        Box::new(|entry| {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => return ignore::WalkState::Continue,
            };
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return ignore::WalkState::Continue;
            }
            let name = entry.file_name().to_str().unwrap_or("");
            if !is_markdown(name) {
                return ignore::WalkState::Continue;
            }
            let mut guard = paths.lock().unwrap();
            if guard.len() >= MAX_QUICK_OPEN_FILES {
                truncated.store(true, Ordering::Relaxed);
                return ignore::WalkState::Quit;
            }
            guard.push(entry.path().to_string_lossy().into_owned());
            ignore::WalkState::Continue
        })
    });

    let mut list = paths.into_inner().unwrap();
    list.sort();
    Ok(QuickOpenResponse {
        paths: list,
        truncated: truncated.load(Ordering::Relaxed),
    })
}

fn build_matcher(query: &str, case_sensitive: bool) -> Result<regex::Regex, String> {
    RegexBuilder::new(&regex::escape(query))
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| e.to_string())
}

fn byte_to_utf16(s: &str, byte: usize) -> usize {
    s[..byte].encode_utf16().count()
}

fn floor_char_boundary(s: &str, byte: usize) -> usize {
    let mut b = byte.min(s.len());
    while b > 0 && !s.is_char_boundary(b) {
        b -= 1;
    }
    b
}

fn truncate_line(line: &str, start: usize, end: usize) -> (String, usize, usize) {
    let start = start.min(line.len());
    let end = end.max(start).min(line.len());
    if line.len() <= MAX_LINE_BYTES {
        return (
            line.to_string(),
            byte_to_utf16(line, start),
            byte_to_utf16(line, end),
        );
    }
    let from = floor_char_boundary(line, start.saturating_sub(MAX_LINE_BYTES / 2));
    let mut to = (from + MAX_LINE_BYTES).min(line.len());
    while to > from && !line.is_char_boundary(to) {
        to -= 1;
    }
    let slice = &line[from..to];
    let prefix = if from > 0 { "…" } else { "" };
    let suffix = if to < line.len() { "…" } else { "" };
    let pad = prefix.encode_utf16().count();
    let text = format!("{prefix}{slice}{suffix}");
    let start_u = byte_to_utf16(slice, start.saturating_sub(from)) + pad;
    let end_u = byte_to_utf16(slice, end.saturating_sub(from)) + pad;
    (text, start_u, end_u)
}

fn is_markdown(name: &str) -> bool {
    name.rsplit('.')
        .next()
        .map(|ext| MARKDOWN_EXT.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn collect_file_hits(
    path: &Path,
    content: &str,
    matcher: &regex::Regex,
    max_hits: usize,
) -> Vec<SearchHit> {
    let mut hits = Vec::with_capacity(max_hits.min(16));
    let display_path = path.to_string_lossy().into_owned();
    for (index, line) in content.lines().enumerate() {
        if hits.len() >= max_hits {
            break;
        }
        if let Some(found) = matcher.find(line) {
            let (text, start, end) = truncate_line(line, found.start(), found.end());
            hits.push(SearchHit {
                path: display_path.clone(),
                line: index + 1,
                text,
                start,
                end,
            });
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("omd-ws-{}-{}", std::process::id(), name))
    }

    fn reset_dir(path: &Path) {
        fs::remove_dir_all(path).ok();
        fs::create_dir_all(path).unwrap();
        authorize_workspace_root(path).unwrap();
    }

    /// Holds the CONFIG_ENV_LOCK so tests that set/remove OMD_CONFIG_DIR /
    /// OMD_RECOVERY_DIR cannot race with each other in parallel runs.
    fn config_env_guard() -> std::sync::MutexGuard<'static, ()> {
        CONFIG_ENV_LOCK.lock().unwrap()
    }

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn canonical_string(path: &Path) -> String {
        fs::canonicalize(path)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn list_dir_rejects_traversal() {
        assert!(list_dir_sync("/tmp/../etc").is_err());
    }

    #[test]
    fn lists_markdown_and_directories_only() {
        let root = tmp("list");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("note.md"), "hi").unwrap();
        fs::write(root.join("skip.txt"), "no").unwrap();
        let entries = list_dir_sync(&root.to_string_lossy()).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"sub"));
        assert!(names.contains(&"note.md"));
        assert!(!names.contains(&"skip.txt"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn searches_markdown_lines() {
        let root = tmp("search");
        reset_dir(&root);
        fs::write(root.join("a.md"), "alpha\nfind me\n").unwrap();
        let response = search_markdown_sync(&root.to_string_lossy(), "find", false).unwrap();
        assert_eq!(response.hits.len(), 1);
        assert_eq!(response.hits[0].line, 2);
        assert_eq!(response.hits[0].start, 0);
        assert_eq!(response.hits[0].end, 4);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn search_matches_case_insensitive_by_default() {
        let root = tmp("search-case");
        reset_dir(&root);
        fs::write(root.join("note.md"), "Hello world\n").unwrap();
        let response = search_markdown_sync(&root.to_string_lossy(), "hello", false).unwrap();
        assert_eq!(response.hits.len(), 1);
        assert_eq!(response.hits[0].line, 1);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn search_case_sensitive_respects_case() {
        let root = tmp("search-case-sens");
        reset_dir(&root);
        fs::write(root.join("note.md"), "Hello\nhello\n").unwrap();
        let response = search_markdown_sync(&root.to_string_lossy(), "hello", true).unwrap();
        assert_eq!(response.hits.len(), 1);
        assert_eq!(response.hits[0].line, 2);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn search_skips_hidden_files() {
        let root = tmp("search-hidden");
        reset_dir(&root);
        fs::write(root.join("visible.md"), "needle").unwrap();
        fs::write(root.join(".secret.md"), "needle").unwrap();
        let response = search_markdown_sync(&root.to_string_lossy(), "needle", false).unwrap();
        assert_eq!(response.hits.len(), 1);
        assert!(response.hits[0].path.ends_with("visible.md"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn search_caps_results_and_marks_truncated() {
        let root = tmp("search-cap");
        reset_dir(&root);
        for i in 0..600 {
            fs::write(root.join(format!("f{i}.md")), "needle").unwrap();
        }
        let response = search_markdown_sync(&root.to_string_lossy(), "needle", false).unwrap();
        assert!(response.truncated);
        assert_eq!(response.hits.len(), MAX_SEARCH_HITS);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn search_truncates_long_lines_and_reports_offsets() {
        let root = tmp("search-truncate");
        reset_dir(&root);
        let long = format!("prefix {} needle", "a".repeat(500));
        fs::write(root.join("long.md"), &long).unwrap();
        let response = search_markdown_sync(&root.to_string_lossy(), "needle", false).unwrap();
        let hit = &response.hits[0];
        assert!(hit.text.len() <= MAX_LINE_BYTES + 6);
        let units: Vec<u16> = hit.text.encode_utf16().skip(hit.start).take(6).collect();
        assert_eq!(units, "needle".encode_utf16().collect::<Vec<_>>());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn search_reports_utf16_offsets_across_emoji() {
        let root = tmp("search-emoji");
        reset_dir(&root);
        fs::write(root.join("emoji.md"), "🦀 needle\n").unwrap();
        let response = search_markdown_sync(&root.to_string_lossy(), "needle", false).unwrap();
        let hit = &response.hits[0];
        assert_eq!(hit.start, 3);
        assert_eq!(hit.end, 9);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn search_response_json_uses_plain_field_names() {
        let response = SearchResponse {
            hits: vec![SearchHit {
                path: "/a.md".into(),
                line: 1,
                text: "x needle y".into(),
                start: 2,
                end: 8,
            }],
            truncated: false,
        };
        let json = serde_json::to_string(&response).unwrap();
        for key in [
            "\"path\"",
            "\"line\"",
            "\"text\"",
            "\"start\"",
            "\"end\"",
            "\"hits\"",
            "\"truncated\"",
        ] {
            assert!(json.contains(key), "missing {key} in {json}");
        }
    }

    #[test]
    fn create_markdown_creates_an_empty_md_file() {
        let root = tmp("create-markdown");
        reset_dir(&root);

        let created = create_markdown(path_string(&root), "draft.md".into()).unwrap();

        assert_eq!(created, canonical_string(&root.join("draft.md")));
        assert_eq!(fs::read_to_string(created).unwrap(), "");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn create_markdown_rejects_invalid_names_and_overwrite() {
        let root = tmp("create-markdown-invalid");
        reset_dir(&root);
        fs::write(root.join("draft.md"), "existing").unwrap();

        assert!(create_markdown(path_string(&root), "../draft.md".into()).is_err());
        assert!(create_markdown(path_string(&root), "nested/draft.md".into()).is_err());
        assert!(create_markdown(path_string(&root), "draft.txt".into()).is_err());
        assert!(create_markdown(path_string(&root), "draft.md".into()).is_err());

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn create_dir_creates_a_directory() {
        let root = tmp("create-dir");
        reset_dir(&root);

        let created = create_dir(path_string(&root), "notes".into()).unwrap();

        assert_eq!(created, canonical_string(&root.join("notes")));
        assert!(Path::new(&created).is_dir());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rename_path_renames_markdown_files_without_overwrite() {
        let root = tmp("rename-path");
        reset_dir(&root);
        let source = root.join("draft.md");
        fs::write(&source, "hello").unwrap();
        fs::write(root.join("taken.md"), "occupied").unwrap();

        assert!(rename_path(path_string(&source), "renamed".into()).is_err());
        assert!(rename_path(path_string(&source), "taken.md".into()).is_err());

        let renamed = rename_path(path_string(&source), "renamed.md".into()).unwrap();

        assert_eq!(renamed, canonical_string(&root.join("renamed.md")));
        assert_eq!(fs::read_to_string(&renamed).unwrap(), "hello");
        assert!(!source.exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn delete_path_rejects_missing_targets() {
        let root = tmp("delete-missing");
        reset_dir(&root);

        assert!(delete_path(path_string(&root.join("absent.md"))).is_err());

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn mutations_reject_paths_outside_authorized_workspace() {
        let root = tmp("unauthorized");
        fs::remove_dir_all(&root).ok();
        fs::create_dir_all(&root).unwrap();

        assert!(create_markdown(path_string(&root), "draft.md".into()).is_err());
        assert!(create_dir(path_string(&root), "notes".into()).is_err());
        let file = root.join("draft.md");
        fs::write(&file, "hello").unwrap();
        assert!(rename_path(path_string(&file), "other.md".into()).is_err());
        assert!(delete_path(path_string(&file)).is_err());
        assert!(file.exists());

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn recovery_roundtrip() {
        let _guard = config_env_guard();
        let dir = tmp("recovery");
        reset_dir(&dir);
        std::env::set_var("OMD_RECOVERY_DIR", &dir);
        write_recovery("untitled_1".into(), "draft".into()).unwrap();
        let listed = list_recoveries().unwrap();
        assert_eq!(listed[0].key, "untitled_1");
        assert_eq!(read_recovery("untitled_1".into()).unwrap(), "draft");
        clear_recovery("untitled_1".into()).unwrap();
        assert!(list_recoveries().unwrap().is_empty());
        std::env::remove_var("OMD_RECOVERY_DIR");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn settings_and_session_roundtrip() {
        let _guard = config_env_guard();
        let dir = tmp("config");
        reset_dir(&dir);
        std::env::set_var("OMD_CONFIG_DIR", &dir);

        assert_eq!(get_settings().unwrap(), "{}");
        assert_eq!(get_session_state().unwrap(), "{}");

        save_settings(r#"{"fontSize":18}"#.into()).unwrap();
        assert_eq!(get_settings().unwrap(), r#"{"fontSize":18}"#);

        save_session_state(r#"{"folder":"/test"}"#.into()).unwrap();
        assert_eq!(get_session_state().unwrap(), r#"{"folder":"/test"}"#);

        std::env::remove_var("OMD_CONFIG_DIR");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn recovery_dir_defaults_under_config_dir() {
        let _guard = config_env_guard();
        let dir = tmp("config-recovery");
        reset_dir(&dir);
        std::env::set_var("OMD_CONFIG_DIR", &dir);
        let had_recovery = std::env::var_os("OMD_RECOVERY_DIR");
        std::env::remove_var("OMD_RECOVERY_DIR");

        assert_eq!(recovery_dir(), dir.join("recovery"));

        if let Some(v) = had_recovery {
            std::env::set_var("OMD_RECOVERY_DIR", v);
        }
        std::env::remove_var("OMD_CONFIG_DIR");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn migrate_dir_files_moves_legacy_files_idempotently() {
        let legacy = tmp("migrate-legacy");
        let target = tmp("migrate-target");
        reset_dir(&legacy);
        reset_dir(&target);
        fs::write(legacy.join("settings.json"), r#"{"fontSize":18}"#).unwrap();
        fs::write(legacy.join("session.json"), r#"{"folder":"/notes"}"#).unwrap();

        migrate_dir_files(&legacy, &target).unwrap();

        assert_eq!(
            fs::read_to_string(target.join("settings.json")).unwrap(),
            r#"{"fontSize":18}"#
        );
        assert_eq!(
            fs::read_to_string(target.join("session.json")).unwrap(),
            r#"{"folder":"/notes"}"#
        );
        assert!(!legacy.exists());

        // A rerun with a stale leftover never overwrites the migrated file.
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("settings.json"), r#"{"stale":true}"#).unwrap();
        migrate_dir_files(&legacy, &target).unwrap();
        assert_eq!(
            fs::read_to_string(target.join("settings.json")).unwrap(),
            r#"{"fontSize":18}"#
        );

        fs::remove_dir_all(&legacy).ok();
        fs::remove_dir_all(&target).ok();
    }

    #[test]
    fn migrate_dir_files_keeps_non_empty_legacy_dirs() {
        let legacy = tmp("migrate-legacy-nested");
        let target = tmp("migrate-target-nested");
        reset_dir(&legacy);
        reset_dir(&target);
        fs::write(legacy.join("untitled_1"), "draft").unwrap();
        fs::create_dir_all(legacy.join("sub")).unwrap();

        migrate_dir_files(&legacy, &target).unwrap();

        assert!(target.join("untitled_1").is_file());
        // The leftover subdir keeps the legacy dir in place for a rerun.
        assert!(legacy.is_dir());

        fs::remove_dir_all(&legacy).ok();
        fs::remove_dir_all(&target).ok();
    }

    #[test]
    fn quick_open_response_serializes_plain_field_names() {
        let response = QuickOpenResponse {
            paths: vec!["/notes/a.md".into()],
            truncated: true,
        };
        let json = serde_json::to_string(&response).unwrap();
        assert_eq!(json, r#"{"paths":["/notes/a.md"],"truncated":true}"#);
    }

    #[test]
    fn quick_open_lists_markdown_only_sorted_without_hidden() {
        let root = tmp("quick-open");
        reset_dir(&root);
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("b.md"), "b").unwrap();
        fs::write(root.join("sub/a.md"), "a").unwrap();
        fs::write(root.join("note.txt"), "x").unwrap();
        fs::write(root.join(".hidden.md"), "h").unwrap();

        let response = list_markdown_files_sync(&path_string(&root)).unwrap();

        assert_eq!(response.paths.len(), 2);
        // Normalize path separators for cross-platform comparison.
        let p0 = response.paths[0].replace('\\', "/");
        let p1 = response.paths[1].replace('\\', "/");
        assert!(p0.ends_with("b.md"), "expected b.md, got: {p0}");
        assert!(p1.ends_with("sub/a.md"), "expected sub/a.md, got: {p1}");
        assert!(!response.truncated);

        // A missing root walks to nothing (matching search), traversal is rejected.
        let missing = list_markdown_files_sync(&path_string(&root.join("nope"))).unwrap();
        assert!(missing.paths.is_empty());
        assert!(
            list_markdown_files_sync(&root.join("..").join("elsewhere").to_string_lossy()).is_err()
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn snapshot_entry_serializes_camel_case() {
        let entry = SnapshotEntry {
            file_name: "123.md".into(),
            mtime_ms: 45,
            size_bytes: 67,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert_eq!(json, r#"{"fileName":"123.md","mtimeMs":45,"sizeBytes":67}"#);
    }

    #[test]
    fn snapshot_rotation_keeps_the_newest_entries() {
        let root = tmp("snapshot-rotate");
        reset_dir(&root);
        let src = root.join("doc.md");
        fs::write(&src, "v1").unwrap();
        let dir = root.join("snaps");

        for millis in 0..(MAX_SNAPSHOTS_PER_FILE as u128 + 5) {
            write_snapshot(&dir, millis, &src).unwrap();
        }

        let mut names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names.len(), MAX_SNAPSHOTS_PER_FILE);
        assert!(!names.contains(&"0.md".to_string()));
        assert!(names.contains(&format!("{}.md", MAX_SNAPSHOTS_PER_FILE + 4)));

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn snapshot_names_reject_traversal_and_non_timestamps() {
        assert!(valid_snapshot_name("1700000000000.md"));
        assert!(!valid_snapshot_name("../evil.md"));
        assert!(!valid_snapshot_name("sub/evil.md"));
        assert!(!valid_snapshot_name("abc.md"));
        assert!(!valid_snapshot_name("1.md.exe"));
        assert!(!valid_snapshot_name(".md"));
        assert!(!valid_snapshot_name("12345678901234567890.md"));
    }

    #[test]
    fn snapshot_document_roundtrip_under_authorized_root() {
        // Isolate from other tests that mutate OMD_CONFIG_DIR (they run in
        // parallel, so config_dir() can change mid-test otherwise).
        let _guard = config_env_guard();
        let config = tmp("snapshot-config");
        fs::create_dir_all(&config).unwrap();
        std::env::set_var("OMD_CONFIG_DIR", &config);

        let root = tmp("snapshot-doc");
        reset_dir(&root);
        let doc = root.join("doc.md");
        fs::write(&doc, "content v1").unwrap();

        snapshot_document(path_string(&doc)).unwrap();

        // Verify snapshot was written by checking the directory directly.
        let (parent, name) = canonical_parent_and_name(&doc).unwrap();
        let snap_dir = snapshots_root(&parent, &name.to_string_lossy());
        assert!(
            snap_dir.is_dir(),
            "snapshot dir should exist: {}",
            snap_dir.display()
        );
        let direct_entries: Vec<_> = fs::read_dir(&snap_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert!(
            !direct_entries.is_empty(),
            "snapshot dir should have entries"
        );

        let listed = list_snapshots(path_string(&doc)).unwrap();
        assert_eq!(listed.len(), 1, "expected 1 snapshot, got {}", listed.len());
        let name = listed[0].file_name.clone();
        assert_eq!(
            read_snapshot(path_string(&doc), name).unwrap(),
            "content v1"
        );
        assert!(read_snapshot(path_string(&doc), "../evil.md".into()).is_err());

        clear_snapshots(path_string(&doc)).unwrap();
        assert!(list_snapshots(path_string(&doc)).unwrap().is_empty());

        // Outside the authorized roots the commands refuse to touch anything.
        // (reset_dir would authorize the directory, so create it bare.)
        let outside = tmp("snapshot-outside");
        fs::remove_dir_all(&outside).ok();
        fs::create_dir_all(&outside).unwrap();
        let foreign = outside.join("foreign.md");
        fs::write(&foreign, "x").unwrap();
        assert!(snapshot_document(path_string(&foreign)).is_err());

        std::env::remove_var("OMD_CONFIG_DIR");
        fs::remove_dir_all(config).ok();
        fs::remove_dir_all(root).ok();
        fs::remove_dir_all(outside).ok();
    }

    #[test]
    fn collect_file_hits_stops_at_the_local_limit() {
        let matcher = build_matcher("needle", false).unwrap();
        let hits = collect_file_hits(
            Path::new("/notes/a.md"),
            "needle\nneedle\nneedle\n",
            &matcher,
            2,
        );
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].line, 1);
        assert_eq!(hits[1].line, 2);
    }

    #[test]
    fn collect_file_hits_preserves_utf16_offsets_and_truncated_text() {
        let matcher = build_matcher("needle", false).unwrap();
        let content = format!("🦀 {} needle", "a".repeat(500));
        let hits = collect_file_hits(Path::new("/notes/a.md"), &content, &matcher, 10);
        let hit = &hits[0];
        let selected: Vec<u16> = hit
            .text
            .encode_utf16()
            .skip(hit.start)
            .take(hit.end - hit.start)
            .collect();
        assert_eq!(selected, "needle".encode_utf16().collect::<Vec<_>>());
    }
}
