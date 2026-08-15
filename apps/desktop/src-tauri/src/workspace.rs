use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

const MARKDOWN_EXT: &[&str] = &["md", "markdown", "mdx"];

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
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct RecoveryRecord {
    pub key: String,
    pub label: String,
}

pub fn recovery_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("OMD_RECOVERY_DIR") {
        return PathBuf::from(dir);
    }
    std::env::temp_dir().join("oh-my-md-recovery")
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
    std::env::temp_dir().join("oh-my-md-config")
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
        != Some("md")
    {
        return Err("markdown files must use a .md extension".into());
    }
    let parent = canonical_directory(Path::new(&dir))?;
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
    let source = parent.join(current_name);
    let source_metadata = fs::metadata(&source).map_err(|e| e.to_string())?;
    if source_metadata.is_file()
        && source
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        && Path::new(to_name)
            .extension()
            .and_then(|extension| extension.to_str())
            != Some("md")
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
    let target = parent.join(name);
    let metadata = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    if metadata.file_type().is_dir() {
        fs::remove_dir(target).map_err(|e| e.to_string())
    } else {
        fs::remove_file(target).map_err(|e| e.to_string())
    }
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

pub async fn search_markdown(root: String, query: String) -> Result<Vec<SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || search_markdown_sync(&root, &query))
        .await
        .map_err(|error| format!("markdown search task failed: {error}"))?
}

pub(crate) fn search_markdown_sync(root: &str, query: &str) -> Result<Vec<SearchHit>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let dir = Path::new(root);
    reject_traversal(dir)?;
    let mut hits = Vec::new();
    walk_markdown(dir, query, &mut hits)?;
    Ok(hits)
}

fn walk_markdown(dir: &Path, query: &str, hits: &mut Vec<SearchHit>) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            walk_markdown(&path, query, hits)?;
            continue;
        }
        if !is_markdown(&name) {
            continue;
        }
        let contents = fs::read_to_string(&path).unwrap_or_default();
        for (index, line) in contents.lines().enumerate() {
            if line.contains(query) {
                hits.push(SearchHit {
                    path: path.to_string_lossy().into_owned(),
                    line: index + 1,
                    text: line.to_string(),
                });
            }
        }
    }
    Ok(())
}

fn is_markdown(name: &str) -> bool {
    name.rsplit('.')
        .next()
        .map(|ext| MARKDOWN_EXT.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
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
        let hits = search_markdown_sync(&root.to_string_lossy(), "find").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
        fs::remove_dir_all(root).ok();
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
    fn delete_path_removes_files_and_empty_dirs_but_not_non_empty_dirs() {
        let root = tmp("delete-path");
        reset_dir(&root);
        let file = root.join("draft.md");
        fs::write(&file, "hello").unwrap();
        delete_path(path_string(&file)).unwrap();
        assert!(!file.exists());

        let empty_dir = root.join("empty");
        fs::create_dir(&empty_dir).unwrap();
        delete_path(path_string(&empty_dir)).unwrap();
        assert!(!empty_dir.exists());

        let non_empty_dir = root.join("non-empty");
        fs::create_dir_all(&non_empty_dir).unwrap();
        fs::write(non_empty_dir.join("draft.md"), "hello").unwrap();
        assert!(delete_path(path_string(&non_empty_dir)).is_err());

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn recovery_roundtrip() {
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
}
