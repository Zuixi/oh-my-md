use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

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

#[test]
fn expected_missing_and_new_symlink_returns_unexpected_symlink() {
    let probe = DiskProbe::Existing {
        snapshot: sample_snapshot("/tmp/a.md", "body"),
        node_is_symlink: true,
    };
    match compare_expected(&ExpectedDocumentVersion::Missing, &probe, "/tmp/a.md") {
        VersionCheck::Conflict(SaveDocumentResult::UnexpectedSymlinkConflict {
            requested_path,
        }) => {
            assert_eq!(requested_path, "/tmp/a.md");
        }
        other => panic!("unexpected check: {other:?}"),
    }
}

#[test]
fn compare_table_returns_typed_variant_for_every_pair() {
    let disk = sample_snapshot("/tmp/a.md", "disk");
    let same = ExpectedDocumentVersion::Existing {
        version: disk.version.clone(),
    };
    let changed = ExpectedDocumentVersion::Existing {
        version: DocumentVersion {
            resolved_path: "/tmp/a.md".into(),
            fingerprint: fingerprint(b"mine"),
        },
    };
    let moved = ExpectedDocumentVersion::Existing {
        version: DocumentVersion {
            resolved_path: "/tmp/moved.md".into(),
            fingerprint: disk.version.fingerprint.clone(),
        },
    };
    let regular = DiskProbe::Existing {
        snapshot: disk.clone(),
        node_is_symlink: false,
    };
    let symlinked = DiskProbe::Existing {
        snapshot: disk,
        node_is_symlink: true,
    };

    assert!(matches!(
        compare_expected(
            &ExpectedDocumentVersion::Missing,
            &DiskProbe::Missing,
            "/tmp/a.md"
        ),
        VersionCheck::Match,
    ));
    assert!(matches!(
        compare_expected(&same, &regular, "/tmp/a.md"),
        VersionCheck::Match,
    ));
    assert!(matches!(
        compare_expected(&ExpectedDocumentVersion::Missing, &regular, "/tmp/a.md"),
        VersionCheck::Conflict(SaveDocumentResult::CreatedConflict { .. }),
    ));
    assert!(matches!(
        compare_expected(&ExpectedDocumentVersion::Missing, &symlinked, "/tmp/a.md"),
        VersionCheck::Conflict(SaveDocumentResult::UnexpectedSymlinkConflict { .. }),
    ));
    assert!(matches!(
        compare_expected(
            &ExpectedDocumentVersion::Missing,
            &DiskProbe::DanglingSymlink,
            "/tmp/a.md"
        ),
        VersionCheck::Conflict(SaveDocumentResult::UnexpectedSymlinkConflict { .. }),
    ));
    assert!(matches!(
        compare_expected(&same, &DiskProbe::Missing, "/tmp/a.md"),
        VersionCheck::Conflict(SaveDocumentResult::DeletedConflict { .. }),
    ));
    assert!(matches!(
        compare_expected(&same, &DiskProbe::DanglingSymlink, "/tmp/a.md"),
        VersionCheck::Conflict(SaveDocumentResult::PathChangedConflict { .. }),
    ));
    assert!(matches!(
        compare_expected(&moved, &regular, "/tmp/a.md"),
        VersionCheck::Conflict(SaveDocumentResult::PathChangedConflict { .. }),
    ));
    assert!(matches!(
        compare_expected(&changed, &regular, "/tmp/a.md"),
        VersionCheck::Conflict(SaveDocumentResult::ContentConflict { .. }),
    ));
}

#[test]
fn compare_symlink_conflicts_carry_only_the_requested_path() {
    let json = serde_json::to_string(&SaveDocumentResult::PathChangedConflict {
        requested_path: "/tmp/a.md".into(),
    })
    .unwrap();
    assert_eq!(
        json,
        r#"{"status":"pathChangedConflict","requestedPath":"/tmp/a.md"}"#
    );
    let symlink_json = serde_json::to_string(&SaveDocumentResult::UnexpectedSymlinkConflict {
        requested_path: "/tmp/a.md".into(),
    })
    .unwrap();
    assert_eq!(
        symlink_json,
        r#"{"status":"unexpectedSymlinkConflict","requestedPath":"/tmp/a.md"}"#,
    );
}

#[test]
fn same_resolved_path_serializes_and_lock_table_stays_bounded() {
    let coordinator = DocumentCoordinator::default();
    let file = write_temp("lock-serialize", "body");
    let key = resolve_path_key(&file).unwrap();
    let first = coordinator.lock_for(&key);
    let second = coordinator.lock_for(&key);
    assert!(Arc::ptr_eq(&first, &second));
    drop(first);
    drop(second);
    let other = write_temp("lock-other", "body");
    let _other = coordinator.lock_for(&resolve_path_key(&other).unwrap());
    assert_eq!(coordinator.tracked_paths(), 1);
}

#[test]
fn missing_path_key_uses_the_canonical_parent() {
    let directory = temp_dir("missing-key");
    let key = resolve_path_key(&directory.join("new.md")).unwrap();
    let canonical =
        resolve_path_key(&fs::canonicalize(&directory).unwrap().join("new.md")).unwrap();
    assert_eq!(key, canonical);
}

#[test]
fn missing_parent_directory_is_invalid_path() {
    let directory = temp_dir("missing-parent");
    assert!(matches!(
        resolve_path_key(&directory.join("absent-dir").join("new.md")),
        Err(DocumentError::InvalidPath(_)),
    ));
}

#[test]
fn lock_different_paths_do_not_share_a_lock() {
    let coordinator = DocumentCoordinator::default();
    let first = write_temp("lock-a", "a");
    let second = write_temp("lock-b", "b");
    let left = coordinator.lock_for(&resolve_path_key(&first).unwrap());
    let right = coordinator.lock_for(&resolve_path_key(&second).unwrap());
    assert!(!Arc::ptr_eq(&left, &right));
    assert_eq!(coordinator.tracked_paths(), 2);
}

#[test]
fn guarded_matching_version_saves_and_returns_a_new_version() {
    let coordinator = DocumentCoordinator::default();
    let file = write_temp("save-match", "original");
    let expected = existing_expected(&file);
    match guarded_save(&coordinator, &path_string_for(&file), "mine", &expected).unwrap() {
        SaveDocumentResult::Saved {
            version,
            durability,
        } => {
            assert_eq!(version.fingerprint, fingerprint(b"mine"));
            assert_eq!(version.resolved_path, canonical_string(&file));
            assert_eq!(durability, SaveDurability::Durable);
        }
        other => panic!("unexpected result: {other:?}"),
    }
    assert_eq!(fs::read_to_string(&file).unwrap(), "mine");
    assert_eq!(temp_siblings(&file), 0);
}

#[test]
fn guarded_stale_version_conflicts_without_touching_the_target() {
    let coordinator = DocumentCoordinator::default();
    let file = write_temp("save-stale", "original");
    let expected = existing_expected(&file);
    fs::write(&file, "theirs").unwrap();
    let result = guarded_save(&coordinator, &path_string_for(&file), "mine", &expected).unwrap();
    match result {
        SaveDocumentResult::ContentConflict { disk } => assert_eq!(disk.contents, "theirs"),
        other => panic!("unexpected result: {other:?}"),
    }
    assert_eq!(fs::read_to_string(&file).unwrap(), "theirs");
    assert_eq!(temp_siblings(&file), 0);
}

#[test]
fn external_write_during_temp_phase_is_caught_by_second_compare() {
    let coordinator = DocumentCoordinator::default();
    let file = write_temp("second-compare", "original");
    let expected = existing_expected(&file);
    let target = file.clone();
    let result = guarded_save_with_hook(
        &coordinator,
        &path_string_for(&file),
        "mine",
        &expected,
        &move || fs::write(&target, "theirs").unwrap(),
    )
    .unwrap();
    assert!(matches!(result, SaveDocumentResult::ContentConflict { .. }));
    assert_eq!(fs::read_to_string(&file).unwrap(), "theirs");
    assert_eq!(temp_siblings(&file), 0);
}

#[test]
fn guarded_expected_missing_creates_only_when_both_checks_are_missing() {
    let coordinator = DocumentCoordinator::default();
    let target = temp_dir("save-create").join("new.md");
    let result = guarded_save(
        &coordinator,
        &path_string_for(&target),
        "mine",
        &ExpectedDocumentVersion::Missing,
    )
    .unwrap();
    assert!(matches!(result, SaveDocumentResult::Saved { .. }));
    assert_eq!(fs::read_to_string(&target).unwrap(), "mine");
    assert_eq!(temp_siblings(&target), 0);
}

#[test]
fn guarded_missing_create_is_no_clobber_when_the_target_appears() {
    let coordinator = DocumentCoordinator::default();
    let target = temp_dir("save-no-clobber").join("new.md");
    let racing = target.clone();
    let result = guarded_save_with_hook(
        &coordinator,
        &path_string_for(&target),
        "mine",
        &ExpectedDocumentVersion::Missing,
        &move || fs::write(&racing, "theirs").unwrap(),
    )
    .unwrap();
    match result {
        SaveDocumentResult::CreatedConflict { disk } => assert_eq!(disk.contents, "theirs"),
        other => panic!("unexpected result: {other:?}"),
    }
    assert_eq!(fs::read_to_string(&target).unwrap(), "theirs");
    assert_eq!(temp_siblings(&target), 0);
}

#[test]
fn guarded_external_delete_returns_deleted_conflict() {
    let coordinator = DocumentCoordinator::default();
    let file = write_temp("save-deleted", "original");
    let expected = existing_expected(&file);
    fs::remove_file(&file).unwrap();
    let result = guarded_save(&coordinator, &path_string_for(&file), "mine", &expected).unwrap();
    assert!(matches!(result, SaveDocumentResult::DeletedConflict { .. }));
    assert!(!file.exists());
}

#[cfg(unix)]
#[test]
fn guarded_symlink_target_is_replaced_without_consuming_the_link() {
    use std::os::unix::fs::symlink;

    let coordinator = DocumentCoordinator::default();
    let directory = temp_dir("save-symlink");
    let target = directory.join("real.md");
    let link = directory.join("link.md");
    fs::write(&target, "original").unwrap();
    symlink(&target, &link).unwrap();
    let expected = existing_expected(&link);

    let result = guarded_save(&coordinator, &path_string_for(&link), "mine", &expected).unwrap();

    assert!(matches!(result, SaveDocumentResult::Saved { .. }));
    assert!(fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_to_string(&target).unwrap(), "mine");
}

#[cfg(unix)]
#[test]
fn guarded_retargeted_symlink_writes_neither_target() {
    use std::os::unix::fs::symlink;

    let coordinator = DocumentCoordinator::default();
    let directory = temp_dir("save-retarget");
    let first = directory.join("first.md");
    let second = directory.join("second.md");
    let link = directory.join("link.md");
    fs::write(&first, "first").unwrap();
    fs::write(&second, "second").unwrap();
    symlink(&first, &link).unwrap();
    let expected = existing_expected(&link);

    fs::remove_file(&link).unwrap();
    symlink(&second, &link).unwrap();
    let result = guarded_save(&coordinator, &path_string_for(&link), "mine", &expected).unwrap();

    assert!(matches!(
        result,
        SaveDocumentResult::PathChangedConflict { .. }
    ));
    assert_eq!(fs::read_to_string(&first).unwrap(), "first");
    assert_eq!(fs::read_to_string(&second).unwrap(), "second");
}

#[test]
fn guarded_parent_sync_failure_downgrades_durability_only() {
    let directory = temp_dir("parent-sync");
    assert_eq!(
        sync_parent(&directory.join("absent-dir")),
        SaveDurability::DirectorySyncFailed
    );
}

#[test]
fn guarded_saved_version_does_not_conflict_with_itself() {
    let coordinator = DocumentCoordinator::default();
    let file = write_temp("no-self-conflict", "original");
    let first = existing_expected(&file);
    let saved = guarded_save(&coordinator, &path_string_for(&file), "mine", &first).unwrap();
    let SaveDocumentResult::Saved { version, .. } = saved else {
        panic!("expected a saved result")
    };
    let again = guarded_save(
        &coordinator,
        &path_string_for(&file),
        "mine again",
        &ExpectedDocumentVersion::Existing { version },
    )
    .unwrap();
    assert!(matches!(again, SaveDocumentResult::Saved { .. }));
}

#[test]
fn guarded_unicode_contents_roundtrip_through_a_save() {
    let coordinator = DocumentCoordinator::default();
    let file = temp_dir("unicode-保存").join("文档-🦀.md");
    fs::write(&file, "旧内容").unwrap();
    let expected = existing_expected(&file);
    guarded_save(
        &coordinator,
        &path_string_for(&file),
        "新内容 🦀",
        &expected,
    )
    .unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "新内容 🦀");
}

#[test]
fn guarded_same_path_saves_serialize_and_the_loser_conflicts() {
    let coordinator = DocumentCoordinator::default();
    let file = write_temp("save-serialize", "original");
    let expected = existing_expected(&file);
    let path = path_string_for(&file);
    let left_coordinator = coordinator.clone();
    let right_coordinator = coordinator.clone();
    let left_expected = expected.clone();
    let right_expected = expected;
    let left_path = path.clone();

    let (left, right) = tauri::async_runtime::block_on(async move {
        let left = tauri::async_runtime::spawn(spawn_blocking_document(move || {
            guarded_save(&left_coordinator, &left_path, "left", &left_expected)
        }));
        let right = tauri::async_runtime::spawn(spawn_blocking_document(move || {
            guarded_save(&right_coordinator, &path, "right", &right_expected)
        }));
        (left.await.unwrap(), right.await.unwrap())
    });

    let statuses = [left.unwrap(), right.unwrap()];
    let saved = statuses
        .iter()
        .filter(|result| matches!(result, SaveDocumentResult::Saved { .. }))
        .count();
    let conflicts = statuses
        .iter()
        .filter(|result| matches!(result, SaveDocumentResult::ContentConflict { .. }))
        .count();
    assert_eq!((saved, conflicts), (1, 1));
    let final_contents = fs::read_to_string(&file).unwrap();
    assert!(final_contents == "left" || final_contents == "right");
}
