use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

fn temp_dir(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("omd-doc-{}-{name}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    directory
}

fn write_temp(name: &str, contents: &str) -> PathBuf {
    let file = temp_dir(name).join("document.md");
    fs::write(&file, contents).unwrap();
    file
}

fn path_string_for(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

fn canonical_string(path: &Path) -> String {
    path_string_for(&fs::canonicalize(path).unwrap())
}

fn existing_expected(path: &Path) -> ExpectedDocumentVersion {
    match read_document_blocking(&path_string_for(path)).unwrap() {
        DiskSnapshot::Existing { version, .. } => ExpectedDocumentVersion::Existing { version },
        other => panic!("expected an existing snapshot: {other:?}"),
    }
}

fn sample_snapshot(resolved: &str, contents: &str) -> ExistingDiskSnapshot {
    ExistingDiskSnapshot {
        requested_path: resolved.to_owned(),
        contents: contents.to_owned(),
        version: DocumentVersion {
            resolved_path: resolved.to_owned(),
            fingerprint: fingerprint(contents.as_bytes()),
        },
    }
}

fn temp_siblings(file: &Path) -> usize {
    fs::read_dir(file.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with('.'))
        .count()
}

#[test]
fn fingerprint_is_stable_and_prefixed() {
    assert_eq!(fingerprint(b"abc"), fingerprint(b"abc"));
    assert_ne!(fingerprint(b"abc"), fingerprint(b"abd"));
    assert!(fingerprint(b"abc").starts_with("v1:"));
    assert_eq!(fingerprint(b"abc"), fingerprint(b"abc").to_lowercase());
}

#[test]
fn read_existing_returns_canonical_path_contents_and_version() {
    let file = write_temp("read-existing", "文档 body\n");
    let snapshot = read_document_blocking(&path_string_for(&file)).unwrap();
    match snapshot {
        DiskSnapshot::Existing {
            contents, version, ..
        } => {
            assert_eq!(contents, "文档 body\n");
            assert_eq!(version.fingerprint, fingerprint("文档 body\n".as_bytes()));
            assert_eq!(version.resolved_path, canonical_string(&file));
        }
        other => panic!("unexpected snapshot: {other:?}"),
    }
}

#[test]
fn read_missing_returns_a_missing_snapshot() {
    let file = temp_dir("read-missing").join("absent.md");
    match read_document_blocking(&path_string_for(&file)).unwrap() {
        DiskSnapshot::Missing { requested_path } => {
            assert_eq!(requested_path, path_string_for(&file));
        }
        other => panic!("unexpected snapshot: {other:?}"),
    }
}

#[test]
fn read_non_utf8_returns_not_utf8() {
    let file = temp_dir("read-non-utf8").join("binary.md");
    fs::write(&file, [0xff, 0xfe, 0x00]).unwrap();
    assert!(matches!(
        read_document_blocking(&path_string_for(&file)),
        Err(DocumentError::NotUtf8(_)),
    ));
}

#[test]
fn relative_and_traversal_paths_are_invalid() {
    assert!(matches!(
        read_document_blocking("notes/a.md"),
        Err(DocumentError::InvalidPath(_)),
    ));
    assert!(matches!(
        read_document_blocking("/tmp/../etc/hosts"),
        Err(DocumentError::InvalidPath(_)),
    ));
}

#[test]
fn unicode_paths_and_contents_read_back_exactly() {
    let file = temp_dir("unicode-读取").join("文档-🦀.md");
    fs::write(&file, "你好，Rust 🦀\n").unwrap();
    match read_document_blocking(&path_string_for(&file)).unwrap() {
        DiskSnapshot::Existing {
            contents, version, ..
        } => {
            assert_eq!(contents, "你好，Rust 🦀\n");
            assert_eq!(version.resolved_path, canonical_string(&file));
        }
        other => panic!("unexpected snapshot: {other:?}"),
    }
}

#[test]
fn version_probe_returns_the_fingerprint_without_contents() {
    let file = write_temp("version-probe", "body");
    let probe = read_document_version_blocking(&path_string_for(&file)).unwrap();
    match probe {
        ExpectedDocumentVersion::Existing { version } => {
            assert_eq!(version.fingerprint, fingerprint(b"body"));
            assert_eq!(version.resolved_path, canonical_string(&file));
        }
        other => panic!("unexpected probe: {other:?}"),
    }
}

#[cfg(unix)]
#[test]
fn dangling_symlink_is_not_reported_as_missing() {
    use std::os::unix::fs::symlink;

    let directory = temp_dir("dangling-read");
    let link = directory.join("link.md");
    symlink(directory.join("absent.md"), &link).unwrap();
    assert!(matches!(
        read_document_blocking(&path_string_for(&link)),
        Err(DocumentError::ReadFailed(_)),
    ));
}

#[allow(dead_code)]
fn _future_task_helpers() {
    let _ = (
        existing_expected,
        sample_snapshot,
        temp_siblings,
        AtomicBool::new(false),
        Ordering::SeqCst,
        Arc::new(Mutex::new(())),
        Condvar::new(),
        Duration::from_secs(1),
    );
}
