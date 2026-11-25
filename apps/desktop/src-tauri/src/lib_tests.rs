use super::*;
use std::fs;
use std::path::{Path, PathBuf};

fn tmp_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("omd-test-{}-{}", std::process::id(), name))
}

#[cfg(unix)]
#[test]
fn atomic_write_replaces_existing_file_and_leaves_no_staging_sibling() {
    use std::os::unix::fs::MetadataExt;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("existing.md");
    std::fs::write(&path, "old").unwrap();
    let old_inode = fs::metadata(&path).unwrap().ino();

    atomic_write(&path, b"new").unwrap();

    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    // Replace-not-truncate: the destination is a different inode, so a
    // crash mid-write can never expose a half-written document.
    assert_ne!(fs::metadata(&path).unwrap().ino(), old_inode);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn atomic_write_creates_a_new_file_with_unicode_paths() {
    let directory = tmp_path("原子保存-目录");
    let path = directory.join("文档-🦀.md");
    fs::create_dir_all(&directory).unwrap();

    atomic_write(&path, "你好，Rust".as_bytes()).unwrap();

    assert_eq!(fs::read_to_string(&path).unwrap(), "你好，Rust");
    fs::remove_dir_all(directory).ok();
}

#[test]
fn replace_existing_preserves_persist_stage_io_error_kind() {
    // On Windows, renaming a file over a directory returns PermissionDenied
    // rather than IsADirectory, so only Unix asserts the exact ErrorKind.
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
fn a_failed_atomic_write_preserves_the_original() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("document.md");
    std::fs::write(&path, "original").unwrap();
    // A destination that is a directory makes the rename fail after the
    // staged bytes were written and synced.
    let blocked = dir.path().join("blocked");
    std::fs::create_dir(&blocked).unwrap();

    assert!(atomic_write(&blocked, b"replacement").is_err());
    assert!(blocked.is_dir());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
}

#[test]
fn save_backup_paths_are_unique_siblings() {
    let notes_dir = std::env::temp_dir().join("notes");
    let a = save_backup_path(&notes_dir.join("note.md"));
    let b = save_backup_path(&notes_dir.join("note.txt"));
    let name = |p: &Path| p.file_name().and_then(|n| n.to_str()).unwrap().to_owned();
    let (a_name, b_name) = (name(&a), name(&b));
    // Hidden siblings (pid + nanos + document name), never the
    // extension-clobbering `with_extension` form that would collide.
    assert!(a_name.starts_with(&format!(".{}-", std::process::id())));
    assert!(a_name.ends_with(".note.md.omd-save-backup"));
    assert!(b_name.ends_with(".note.txt.omd-save-backup"));
    assert_ne!(a_name, b_name);
    assert_ne!(a_name, "note.omd-save-backup");
    assert_eq!(a.parent(), Some(notes_dir.as_path()));
}

#[test]
fn window_theme_from_arg_maps_wire_values_and_rejects_unknown() {
    assert!(matches!(
        window_theme_from_arg("light"),
        Ok(tauri::Theme::Light)
    ));
    assert!(matches!(
        window_theme_from_arg("dark"),
        Ok(tauri::Theme::Dark)
    ));
    assert!(window_theme_from_arg("system").is_err());
    assert!(window_theme_from_arg("").is_err());
}

#[test]
fn startup_window_theme_reads_persisted_theme_tolerantly() {
    assert!(matches!(
        startup_window_theme(r#"{"theme":"dark"}"#),
        Some(tauri::Theme::Dark)
    ));
    assert!(matches!(
        startup_window_theme(r#"{"theme":"light","fontSize":18}"#),
        Some(tauri::Theme::Light)
    ));
    // "system", absent, malformed, and non-string values all fall back to
    // following the OS rather than guessing a theme.
    assert!(startup_window_theme("{}").is_none());
    assert!(startup_window_theme(r#"{"theme":"system"}"#).is_none());
    assert!(startup_window_theme(r#"{"theme":null}"#).is_none());
    assert!(startup_window_theme(r#"{"theme":42}"#).is_none());
    assert!(startup_window_theme("not json").is_none());
    assert!(startup_window_theme("").is_none());
}

/// The command registry drift guard; reads the shipped manifest and `lib.rs`.
#[path = "command_inventory_tests.rs"]
mod command_inventory_tests;
