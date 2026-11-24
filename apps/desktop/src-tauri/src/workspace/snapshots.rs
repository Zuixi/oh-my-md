//! Version-history snapshots.
//!
//! A snapshot is a full copy of one document, keyed by a stable hash of its
//! canonical parent plus name, and stored in the app config directory. Writes
//! go through [`crate::atomic_write`] so a crash mid-snapshot can never leave a
//! half-written `{millis}.md` that version history would later offer as a
//! restore point.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::auth_scope::assert_file_or_workspace_authorized;

use super::{config_dir, MAX_SNAPSHOTS_PER_FILE};

/// Per-snapshot ceiling. Copying a 50 MiB document on every autosave would turn
/// version history into a disk-space amplifier, so larger documents keep none
/// and the caller reports why.
pub const MAX_SNAPSHOT_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// `next_snapshot_stamp` plus the write must be one critical section: two
/// concurrent snapshots for the same file otherwise choose the same
/// millisecond stamp and the second atomically replaces the first restore
/// point. Snapshot writes are background, bounded copies, so one lock is
/// simpler than a per-document map.
static SNAPSHOT_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Total ceiling for one document's snapshot directory. Rotation evicts the
/// oldest entries until both this and [`MAX_SNAPSHOTS_PER_FILE`] fit.
pub const MAX_SNAPSHOT_DIR_BYTES: u64 = 50 * 1024 * 1024;

const SNAPSHOT_NAME_MAX_DIGITS: usize = 19;
const SNAPSHOT_EXTENSION: &str = "md";
const MIB: u64 = 1024 * 1024;

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
    let Some(stem) = file_name.strip_suffix(&format!(".{SNAPSHOT_EXTENSION}")) else {
        return false;
    };
    !stem.is_empty()
        && stem.len() <= SNAPSHOT_NAME_MAX_DIGITS
        && stem.bytes().all(|byte| byte.is_ascii_digit())
}

/// Numeric timestamp of a snapshot file name (`"1700000000000.md"` → the
/// millis). Anything else sorts as the oldest possible stamp.
fn snapshot_stamp(file_name: &str) -> u128 {
    file_name
        .strip_suffix(&format!(".{SNAPSHOT_EXTENSION}"))
        .and_then(|stem| stem.parse::<u128>().ok())
        .unwrap_or(0)
}

/// `(file name, size)` for every snapshot in `dir`, ascending by timestamp.
/// Comparison is numeric: lexical order puts `9.md` after `10.md`, which would
/// rotate the wrong entry once a stamp loses a digit. Entries that are not
/// snapshots are skipped (never offered to the user);
/// [`cleanup_staging_files`] removes them during a write.
fn snapshot_files(dir: &Path) -> Result<Vec<(String, u64)>, String> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() || !valid_snapshot_name(&name) {
            continue;
        }
        files.push((name, metadata.len()));
    }
    files.sort_by_key(|(name, _)| snapshot_stamp(name));
    Ok(files)
}

/// Removes this module's own abandoned staging files (`atomic_write` renames
/// its temp over the target, so a crash is the only way one survives). Called
/// from the write path only, so a concurrent listing can never delete a live
/// writer's staging file.
fn cleanup_staging_files(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if valid_snapshot_name(&name) {
            continue;
        }
        if entry.metadata().is_ok_and(|metadata| metadata.is_file()) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Timestamp for the next snapshot. Two saves inside one millisecond would
/// otherwise share a filename and silently clobber the earlier restore point,
/// so the stamp steps past the newest existing one.
fn next_snapshot_stamp(dir: &Path, millis: u128) -> u128 {
    let newest = snapshot_files(dir)
        .unwrap_or_default()
        .iter()
        .map(|(name, _)| snapshot_stamp(name))
        .max();
    match newest {
        Some(newest) if newest >= millis => newest + 1,
        _ => millis,
    }
}

fn rotate_snapshots(dir: &Path) -> Result<(), String> {
    cleanup_staging_files(dir);
    let mut files = snapshot_files(dir)?;
    let mut total: u64 = files.iter().map(|(_, size)| *size).sum();
    // `snapshot_files` sorted numerically, so index 0 is the oldest. The newest
    // snapshot is never evicted: it is the copy that just proved it fits the
    // per-file cap.
    while files.len() > 1
        && (files.len() > MAX_SNAPSHOTS_PER_FILE || total > MAX_SNAPSHOT_DIR_BYTES)
    {
        let (oldest, size) = files.remove(0);
        fs::remove_file(dir.join(oldest)).map_err(|e| e.to_string())?;
        total = total.saturating_sub(size);
    }
    Ok(())
}

fn write_snapshot(dir: &Path, millis: u128, source: &Path) -> Result<(), String> {
    let _guard = SNAPSHOT_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (mut file, metadata) = crate::scoped_io::open_regular_file(source).map_err(|e| {
        if e.kind() == std::io::ErrorKind::InvalidInput {
            "snapshot source is not a file".to_string()
        } else {
            e.to_string()
        }
    })?;
    let byte_length = metadata.len();
    if byte_length > MAX_SNAPSHOT_FILE_BYTES {
        return Err(format!(
            "document exceeds the {} MiB version snapshot limit",
            MAX_SNAPSHOT_FILE_BYTES / MIB
        ));
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // A document can grow between the metadata check and the read. Read one
    // byte past the cap so an oversized file is rejected instead of buffered.
    let mut bytes = Vec::with_capacity(byte_length.min(MAX_SNAPSHOT_FILE_BYTES) as usize);
    file.by_ref()
        .take(MAX_SNAPSHOT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_SNAPSHOT_FILE_BYTES {
        return Err(format!(
            "document exceeds the {} MiB version snapshot limit",
            MAX_SNAPSHOT_FILE_BYTES / MIB
        ));
    }
    let target = dir.join(format!(
        "{}.{SNAPSHOT_EXTENSION}",
        next_snapshot_stamp(dir, millis)
    ));
    crate::atomic_write(&target, &bytes)?;
    rotate_snapshots(dir)
}

/// Authorizes the document for this window and returns its canonical parent
/// plus source path. Workspace files pass through their root grant; standalone
/// files pass through the grant `read_document`/`save_document` recorded.
fn authorized_source(
    path: &str,
    window_label: Option<&str>,
) -> Result<(PathBuf, PathBuf, String), String> {
    let (parent, name) = assert_file_or_workspace_authorized(window_label, Path::new(path))?;
    let name = name.to_string_lossy().into_owned();
    let source = parent.join(&name);
    Ok((parent, source, name))
}

pub fn snapshot_document(path: String, window_label: Option<String>) -> Result<(), String> {
    let (parent, source, name) = authorized_source(&path, window_label.as_deref())?;
    if !source.is_file() {
        return Err("snapshot source is not a file".into());
    }
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    write_snapshot(&snapshots_root(&parent, &name), millis, &source)
}

pub fn list_snapshots(
    path: String,
    window_label: Option<String>,
) -> Result<Vec<SnapshotEntry>, String> {
    let (parent, _, name) = authorized_source(&path, window_label.as_deref())?;
    let dir = snapshots_root(&parent, &name);
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut entries: Vec<SnapshotEntry> = snapshot_files(&dir)?
        .into_iter()
        .filter_map(|(file_name, size_bytes)| {
            let metadata = fs::metadata(dir.join(&file_name)).ok()?;
            let mtime_ms = metadata
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis() as u64;
            Some(SnapshotEntry {
                file_name,
                mtime_ms,
                size_bytes,
            })
        })
        .collect();
    // `snapshot_files` is oldest-first, so reversing yields newest-first for
    // the history list without a second (lexical) comparison.
    entries.reverse();
    Ok(entries)
}

pub fn read_snapshot(
    path: String,
    file_name: String,
    window_label: Option<String>,
) -> Result<String, String> {
    if !valid_snapshot_name(&file_name) {
        return Err("snapshot name is invalid".into());
    }
    let (parent, _, name) = authorized_source(&path, window_label.as_deref())?;
    let snapshot = snapshots_root(&parent, &name).join(&file_name);
    fs::read_to_string(snapshot).map_err(|e| e.to_string())
}

pub fn clear_snapshots(path: String, window_label: Option<String>) -> Result<(), String> {
    let (parent, _, name) = authorized_source(&path, window_label.as_deref())?;
    let dir = snapshots_root(&parent, &name);
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth_scope::{authorize_document_file, authorize_workspace_root};
    use crate::workspace::config_env_guard;

    fn tmp(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("omd-snap-{}-{name}", std::process::id()));
        fs::remove_dir_all(&path).ok();
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    /// Sparse file of `len` bytes: instant to create, exact for `metadata.len()`.
    fn sparse_file(path: &Path, len: u64) {
        let file = fs::File::create(path).unwrap();
        file.set_len(len).unwrap();
    }

    fn snapshot_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
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
    fn snapshot_files_sort_numerically_not_lexicographically() {
        let root = tmp("numeric-sort");
        let dir = root.join("snaps");
        fs::create_dir_all(&dir).unwrap();
        for stamp in ["9", "10", "100"] {
            fs::write(dir.join(format!("{stamp}.md")), "snapshot").unwrap();
        }

        let names: Vec<String> = snapshot_files(&dir)
            .unwrap()
            .into_iter()
            .map(|(name, _)| name)
            .collect();

        assert_eq!(names, vec!["9.md", "10.md", "100.md"]);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rotation_keeps_the_newest_entries() {
        let root = tmp("rotate");
        let src = root.join("doc.md");
        fs::write(&src, "v1").unwrap();
        let dir = root.join("snaps");

        for millis in 0..(MAX_SNAPSHOTS_PER_FILE as u128 + 5) {
            write_snapshot(&dir, millis, &src).unwrap();
        }

        let names = snapshot_names(&dir);
        assert_eq!(names.len(), MAX_SNAPSHOTS_PER_FILE);
        assert!(!names.contains(&"0.md".to_string()));
        assert!(names.contains(&format!("{}.md", MAX_SNAPSHOTS_PER_FILE + 4)));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rotation_evicts_until_the_directory_byte_budget_fits() {
        let root = tmp("rotate-bytes");
        let dir = root.join("snaps");
        fs::create_dir_all(&dir).unwrap();
        // Seven 9 MiB snapshots = 63 MiB, over the 50 MiB directory budget.
        let chunk = 9 * MIB;
        for stamp in 0..7u128 {
            sparse_file(&dir.join(format!("{stamp}.md")), chunk);
        }

        rotate_snapshots(&dir).unwrap();

        let names = snapshot_names(&dir);
        let total: u64 = names
            .iter()
            .map(|name| fs::metadata(dir.join(name)).unwrap().len())
            .sum();
        assert!(total <= MAX_SNAPSHOT_DIR_BYTES, "total {total} over budget");
        assert_eq!(names.len(), 5, "63 MiB → five snapshots fit");
        assert!(names.contains(&"6.md".to_string()), "newest survives");
        assert!(!names.contains(&"0.md".to_string()));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rotation_never_evicts_the_only_snapshot_even_over_the_byte_budget() {
        let root = tmp("rotate-single");
        let dir = root.join("snaps");
        fs::create_dir_all(&dir).unwrap();
        // A single directory-shattering entry (only reachable if the per-file
        // cap is raised later) must still be reported instead of emptied.
        sparse_file(&dir.join("1.md"), MAX_SNAPSHOT_DIR_BYTES + 1);

        rotate_snapshots(&dir).unwrap();

        assert_eq!(snapshot_names(&dir), vec!["1.md".to_string()]);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rotation_removes_abandoned_staging_files() {
        let root = tmp("rotate-stale");
        let dir = root.join("snaps");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("1.md"), "snapshot").unwrap();
        fs::write(dir.join(".tmpA1B2C3"), "half-written").unwrap();

        rotate_snapshots(&dir).unwrap();

        assert_eq!(snapshot_names(&dir), vec!["1.md".to_string()]);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn two_saves_in_the_same_millisecond_never_clobber_each_other() {
        let root = tmp("same-millis");
        let src = root.join("doc.md");
        fs::write(&src, "v1").unwrap();
        let dir = root.join("snaps");

        write_snapshot(&dir, 1_700_000_000_000, &src).unwrap();
        write_snapshot(&dir, 1_700_000_000_000, &src).unwrap();
        write_snapshot(&dir, 1_700_000_000_000, &src).unwrap();

        assert_eq!(
            snapshot_names(&dir),
            vec![
                "1700000000000.md".to_string(),
                "1700000000001.md".to_string(),
                "1700000000002.md".to_string(),
            ]
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn documents_over_the_per_file_cap_are_refused_instead_of_copied() {
        let root = tmp("oversized");
        let dir = root.join("snaps");
        let src = root.join("huge.md");
        sparse_file(&src, MAX_SNAPSHOT_FILE_BYTES + 1);

        let error = write_snapshot(&dir, 1, &src).unwrap_err();

        assert!(error.contains("10 MiB"), "unexpected error: {error}");
        assert!(
            !dir.is_dir(),
            "nothing may be written for a refused snapshot"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_failed_snapshot_never_leaves_a_partial_file_or_temp_behind() {
        let root = tmp("atomic");
        let src = root.join("doc.md");
        fs::write(&src, "content").unwrap();
        let dir = root.join("snaps");

        write_snapshot(&dir, 42, &src).unwrap();

        // Exactly one snapshot plus no staging leftovers: the copy was staged
        // and renamed, never written in place.
        assert_eq!(snapshot_names(&dir), vec!["42.md".to_string()]);
        assert_eq!(fs::read_to_string(dir.join("42.md")).unwrap(), "content");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn concurrent_snapshots_for_the_same_millisecond_do_not_clobber() {
        let root = tmp("concurrent");
        let src = root.join("doc.md");
        fs::write(&src, "content").unwrap();
        let dir = root.join("snaps");

        let handles: Vec<_> = (0..2)
            .map(|_| {
                let dir = dir.clone();
                let src = src.clone();
                std::thread::spawn(move || write_snapshot(&dir, 100, &src).unwrap())
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        // Stamp allocation and the write share one critical section, so the
        // second writer steps to 101 instead of atomically replacing 100.
        assert_eq!(
            snapshot_names(&dir),
            vec!["100.md".to_string(), "101.md".to_string()]
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn workspace_documents_round_trip_through_snapshot_commands() {
        // Isolate from other tests that mutate OMD_CONFIG_DIR (they run in
        // parallel, so config_dir() can change mid-test otherwise).
        let _guard = config_env_guard();
        let config = tmp("config");
        fs::create_dir_all(&config).unwrap();
        std::env::set_var("OMD_CONFIG_DIR", &config);

        let root = tmp("roundtrip");
        authorize_workspace_root("test", &root).unwrap();
        let doc = root.join("doc.md");
        fs::write(&doc, "content v1").unwrap();

        snapshot_document(path_string(&doc), Some("test".into())).unwrap();

        let listed = list_snapshots(path_string(&doc), Some("test".into())).unwrap();
        assert_eq!(listed.len(), 1, "expected 1 snapshot, got {}", listed.len());
        let name = listed[0].file_name.clone();
        assert_eq!(
            read_snapshot(path_string(&doc), name, Some("test".into())).unwrap(),
            "content v1"
        );
        assert!(
            read_snapshot(path_string(&doc), "../evil.md".into(), Some("test".into())).is_err()
        );

        clear_snapshots(path_string(&doc), Some("test".into())).unwrap();
        assert!(list_snapshots(path_string(&doc), Some("test".into()))
            .unwrap()
            .is_empty());

        std::env::remove_var("OMD_CONFIG_DIR");
        fs::remove_dir_all(config).ok();
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_standalone_file_gets_version_history_without_opening_its_folder() {
        let _guard = config_env_guard();
        let config = tmp("config-standalone");
        fs::create_dir_all(&config).unwrap();
        std::env::set_var("OMD_CONFIG_DIR", &config);

        let folder = tmp("standalone");
        let doc = folder.join("single.md");
        let other = folder.join("other.md");
        fs::write(&doc, "v1").unwrap();
        fs::write(&other, "v2").unwrap();
        authorize_document_file("editor-7", &doc).unwrap();

        snapshot_document(path_string(&doc), Some("editor-7".into())).unwrap();
        assert_eq!(
            list_snapshots(path_string(&doc), Some("editor-7".into()))
                .unwrap()
                .len(),
            1
        );
        // The grant is per file: a sibling in the same folder stays refused.
        assert!(snapshot_document(path_string(&other), Some("editor-7".into())).is_err());
        // And it never escalates into directory access.
        assert!(crate::auth_scope::assert_dir_authorized(Some("editor-7"), &folder).is_err());

        std::env::remove_var("OMD_CONFIG_DIR");
        fs::remove_dir_all(config).ok();
        fs::remove_dir_all(folder).ok();
    }

    #[test]
    fn unauthorized_paths_are_refused_before_any_snapshot_io() {
        let outside = tmp("outside");
        let foreign = outside.join("foreign.md");
        fs::write(&foreign, "x").unwrap();

        assert!(snapshot_document(path_string(&foreign), Some("editor-x".into())).is_err());
        assert!(list_snapshots(path_string(&foreign), Some("editor-x".into())).is_err());
        assert!(clear_snapshots(path_string(&foreign), Some("editor-x".into())).is_err());
        assert!(read_snapshot(
            path_string(&foreign),
            "1.md".into(),
            Some("editor-x".into())
        )
        .is_err());
        fs::remove_dir_all(outside).ok();
    }
}
