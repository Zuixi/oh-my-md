# Conflict-Safe Guarded Save Test Appendix

**Plan:** `docs/superpowers/plans/2026-08-13-02-conflict-safe-save.md`

**Spec:** `docs/superpowers/specs/2026-08-13-02-conflict-safe-save-design.md`

本附录给出主计划各 Task 引用的可执行测试代码。适配 import 与既有 helper 时必须保留断言语义。除非用例本身要求，测试不得放宽断言。

## Rust 测试基础

`apps/desktop/src-tauri/src/documents/tests.rs` 顶部：

```rust
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
```

`DiskProbe`、`VersionCheck`、`PathKey` 必须 derive `Debug`；`PathKey` 还需 `PartialEq`、`Eq`、`Hash`、`Clone`，`SaveDurability` 需 `PartialEq`，否则上述断言无法编译。

## Task 1: 读取与 fingerprint

```rust
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
        DiskSnapshot::Existing { contents, version, .. } => {
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
```

## Task 2: 穷尽比较表

```rust
#[test]
fn compare_table_returns_typed_variant_for_every_pair() {
    let disk = sample_snapshot("/tmp/a.md", "disk");
    let same = ExpectedDocumentVersion::Existing { version: disk.version.clone() };
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
    let regular = DiskProbe::Existing { snapshot: disk.clone(), node_is_symlink: false };
    let symlinked = DiskProbe::Existing { snapshot: disk, node_is_symlink: true };

    assert!(matches!(
        compare_expected(&ExpectedDocumentVersion::Missing, &DiskProbe::Missing, "/tmp/a.md"),
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
        compare_expected(&ExpectedDocumentVersion::Missing, &DiskProbe::DanglingSymlink, "/tmp/a.md"),
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
    assert_eq!(json, r#"{"status":"pathChangedConflict","requestedPath":"/tmp/a.md"}"#);
    let symlink_json = serde_json::to_string(&SaveDocumentResult::UnexpectedSymlinkConflict {
        requested_path: "/tmp/a.md".into(),
    })
    .unwrap();
    assert_eq!(
        symlink_json,
        r#"{"status":"unexpectedSymlinkConflict","requestedPath":"/tmp/a.md"}"#,
    );
}
```

## Task 3: path key 与锁表

```rust
#[test]
fn missing_path_key_uses_the_canonical_parent() {
    let directory = temp_dir("missing-key");
    let key = resolve_path_key(&directory.join("new.md")).unwrap();
    let canonical = resolve_path_key(&fs::canonicalize(&directory).unwrap().join("new.md")).unwrap();
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
```

`tracked_paths` 在计数前先 sweep 死 weak entry，因此上一条与主计划的 `lock_table_stays_bounded` 断言都是确定性的。

## Task 4: guarded save

```rust
#[test]
fn guarded_matching_version_saves_and_returns_a_new_version() {
    let coordinator = DocumentCoordinator::default();
    let file = write_temp("save-match", "original");
    let expected = existing_expected(&file);
    match guarded_save(&coordinator, &path_string_for(&file), "mine", &expected).unwrap() {
        SaveDocumentResult::Saved { version, durability } => {
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
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
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

    assert!(matches!(result, SaveDocumentResult::PathChangedConflict { .. }));
    assert_eq!(fs::read_to_string(&first).unwrap(), "first");
    assert_eq!(fs::read_to_string(&second).unwrap(), "second");
}

#[test]
fn guarded_parent_sync_failure_downgrades_durability_only() {
    let directory = temp_dir("parent-sync");
    assert_eq!(sync_parent(&directory.join("absent-dir")), SaveDurability::DirectorySyncFailed);
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
    guarded_save(&coordinator, &path_string_for(&file), "新内容 🦀", &expected).unwrap();
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
    let saved = statuses.iter().filter(|result| matches!(result, SaveDocumentResult::Saved { .. })).count();
    let conflicts = statuses
        .iter()
        .filter(|result| matches!(result, SaveDocumentResult::ContentConflict { .. }))
        .count();
    assert_eq!((saved, conflicts), (1, 1));
    let final_contents = fs::read_to_string(&file).unwrap();
    assert!(final_contents == "left" || final_contents == "right");
}
```

## Task 5: metadata 与真实并发

```rust
#[cfg(target_os = "macos")]
#[test]
fn metadata_required_user_xattrs_survive_a_guarded_save() {
    let coordinator = DocumentCoordinator::default();
    let file = write_temp("xattr-keep", "original");
    xattr::set(&file, "com.apple.metadata:_kMDItemUserTags", b"tag").unwrap();
    let expected = existing_expected(&file);

    guarded_save(&coordinator, &path_string_for(&file), "mine", &expected).unwrap();

    assert_eq!(
        xattr::get(&file, "com.apple.metadata:_kMDItemUserTags").unwrap().as_deref(),
        Some(b"tag".as_slice()),
    );
}

#[cfg(target_os = "macos")]
#[test]
fn metadata_required_xattr_failure_reports_metadata_failed_and_keeps_the_target() {
    let file = write_temp("xattr-fail", "original");
    xattr::set(&file, "com.apple.metadata:_kMDItemUserTags", b"tag").unwrap();
    let absent = file.parent().unwrap().join("absent.tmp");
    assert!(matches!(copy_metadata(&file, &absent), Err(DocumentError::MetadataFailed(_))));
    assert_eq!(fs::read_to_string(&file).unwrap(), "original");
}

#[cfg(target_os = "macos")]
#[test]
fn metadata_skips_quarantine_and_tolerates_other_xattr_failures() {
    let coordinator = DocumentCoordinator::default();
    let file = write_temp("xattr-skip", "original");
    xattr::set(&file, "com.apple.quarantine", b"0081;0;;").unwrap();
    let expected = existing_expected(&file);

    guarded_save(&coordinator, &path_string_for(&file), "mine", &expected).unwrap();

    assert_eq!(fs::read_to_string(&file).unwrap(), "mine");
    assert!(xattr::get(&file, "com.apple.quarantine").unwrap().is_none());
}

#[cfg(unix)]
#[test]
fn metadata_read_only_directory_returns_permission_denied() {
    use std::os::unix::fs::PermissionsExt;

    let coordinator = DocumentCoordinator::default();
    let file = write_temp("permission-denied", "original");
    let directory = file.parent().unwrap().to_path_buf();
    let expected = existing_expected(&file);
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o555)).unwrap();

    let result = guarded_save(&coordinator, &path_string_for(&file), "mine", &expected);

    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(result, Err(DocumentError::PermissionDenied(_))));
    assert_eq!(fs::read_to_string(&file).unwrap(), "original");
    assert_eq!(temp_siblings(&file), 0);
}

#[cfg(unix)]
#[test]
fn metadata_created_file_permissions_follow_the_process_umask() {
    use std::os::unix::fs::PermissionsExt;

    let coordinator = DocumentCoordinator::default();
    let directory = temp_dir("umask-create");
    let reference = directory.join("reference.md");
    let target = directory.join("new.md");
    fs::File::create(&reference).unwrap();
    let expected_mode = fs::metadata(&reference).unwrap().permissions().mode() & 0o777;

    guarded_save(
        &coordinator,
        &path_string_for(&target),
        "mine",
        &ExpectedDocumentVersion::Missing,
    )
    .unwrap();

    assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, expected_mode);
}
```

不同路径必须在 blocking pool 内真正重叠。hook 在临界区内会合，若有人退回全局锁，会合超时并让断言失败，而不会死锁：

```rust
fn meet(rendezvous: &(Mutex<usize>, Condvar)) -> bool {
    let (lock, signal) = rendezvous;
    let mut arrived = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *arrived += 1;
    signal.notify_all();
    while *arrived < 2 {
        let (next, timeout) = signal
            .wait_timeout(arrived, Duration::from_secs(5))
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        arrived = next;
        if timeout.timed_out() {
            break;
        }
    }
    *arrived >= 2
}

#[test]
fn metadata_different_paths_overlap_inside_the_blocking_pool() {
    let coordinator = DocumentCoordinator::default();
    let first = write_temp("overlap-a", "a");
    let second = write_temp("overlap-b", "b");
    let first_expected = existing_expected(&first);
    let second_expected = existing_expected(&second);
    let first_path = path_string_for(&first);
    let second_path = path_string_for(&second);
    let rendezvous = Arc::new((Mutex::new(0_usize), Condvar::new()));
    let left_met = Arc::new(AtomicBool::new(false));
    let right_met = Arc::new(AtomicBool::new(false));

    let left_rendezvous = Arc::clone(&rendezvous);
    let right_rendezvous = Arc::clone(&rendezvous);
    let left_flag = Arc::clone(&left_met);
    let right_flag = Arc::clone(&right_met);
    let left_coordinator = coordinator.clone();
    let right_coordinator = coordinator.clone();

    let (left, right) = tauri::async_runtime::block_on(async move {
        let left = tauri::async_runtime::spawn(spawn_blocking_document(move || {
            guarded_save_with_hook(
                &left_coordinator,
                &first_path,
                "mine a",
                &first_expected,
                &|| left_flag.store(meet(&left_rendezvous), Ordering::SeqCst),
            )
        }));
        let right = tauri::async_runtime::spawn(spawn_blocking_document(move || {
            guarded_save_with_hook(
                &right_coordinator,
                &second_path,
                "mine b",
                &second_expected,
                &|| right_flag.store(meet(&right_rendezvous), Ordering::SeqCst),
            )
        }));
        (left.await.unwrap(), right.await.unwrap())
    });

    assert!(left_met.load(Ordering::SeqCst) && right_met.load(Ordering::SeqCst));
    assert!(matches!(left.unwrap(), SaveDocumentResult::Saved { .. }));
    assert!(matches!(right.unwrap(), SaveDocumentResult::Saved { .. }));
    assert_eq!(fs::read_to_string(&first).unwrap(), "mine a");
    assert_eq!(fs::read_to_string(&second).unwrap(), "mine b");
}
```

## Task 7: session baseline

```ts
const version = { resolvedPath: "/notes/a.md", fingerprint: "v1:aa" } as const
const nextVersion = { resolvedPath: "/notes/a.md", fingerprint: "v1:bb" } as const

it("exposes no path or version for untitled sessions", () => {
  const untitled = createSession(1)
  expect(sessionPath(untitled)).toBeNull()
  expect(sessionVersion(untitled)).toBeNull()
  expect(sessionSavedContents(untitled)).toBe("")
})

it("advances identity while preserving persistence", () => {
  const session = createFileSession(1, "/notes/a.md", "body", version)
  expect(advanceDocumentIdentity(session)).toEqual({
    ...session,
    documentId: session.documentId + 1,
  })
})

it("replaces path, baseline, and version together", () => {
  const saved = markSaved(createSession(1), "/notes/a.md", "body", version)
  const resaved = markSaved(saved, "/notes/a.md", "next", nextVersion)
  expect(sessionSavedContents(resaved)).toBe("next")
  expect(sessionVersion(resaved)).toEqual(nextVersion)
  expect(sessionDirty(resaved, "next")).toBe(false)
})

it("derives label and recovery key from persistence", () => {
  const session = createFileSession(3, "/notes/a b.md", "body", version)
  expect(sessionLabel(session)).toBe("a b.md")
  expect(recoveryKey(session)).toBe("_notes_a_b.md")
})
```

## Task 8: 保存状态 reducer

```ts
const disk = {
  requestedPath: "/notes/a.md",
  contents: "theirs",
  version: { resolvedPath: "/notes/a.md", fingerprint: "v1:bb" },
} as const

it("keeps divergence and dirty context when a save fails", () => {
  const conflicted = applyDivergence(initialSaveState(), {
    kind: "contentConflict", localSnapshot: "mine", disk,
  })
  const failed = failSave(beginSave(conflicted, 1, "mine"), 1, "disk full")
  expect(failed.lifecycle).toEqual({ kind: "saveFailed", message: "disk full" })
  expect(failed.divergence.kind).toBe("contentConflict")
})

it("clears only divergence", () => {
  const failed = failSave(beginSave(initialSaveState(), 1, "mine"), 1, "disk full")
  const conflicted = applyDivergence(failed, { kind: "deletedExternally", localSnapshot: "mine" })
  const cleared = clearDivergence(conflicted)
  expect(cleared.divergence).toEqual({ kind: "none" })
  expect(cleared.lifecycle.kind).toBe("saveFailed")
})

it("discards observations captured before a newer io generation", () => {
  const state = initialSaveState()
  expect(isFreshObservation(state, state.ioGeneration)).toBe(true)
  const saving = beginSave(state, 1, "mine")
  expect(isFreshObservation(saving, state.ioGeneration)).toBe(false)
  expect(isFreshObservation(saving, saving.ioGeneration)).toBe(false)
  const done = completeSave(saving, 1)
  expect(isFreshObservation(done, saving.ioGeneration)).toBe(false)
  expect(isFreshObservation(done, done.ioGeneration)).toBe(true)
})

it("adds and removes tab entries immutably", () => {
  const states = updateTabSaveState({}, 2, beginSave(initialSaveState(), 1, "mine"))
  expect(tabSaveState(states, 2).lifecycle.kind).toBe("saving")
  expect(tabSaveState(states, 3)).toEqual(initialSaveState())
  expect(removeTabSaveState(states, 2)[2]).toBeUndefined()
  expect(states[2]).toBeDefined()
})
```

## Task 9: 协调纯函数

每个测试文件各自声明所需夹具，不跨文件共享；下面的 `version`、`nextVersion`、`disk` 与 Task 7/8 段落里的字面量相同，需在本文件顶部重新声明。

```ts
const pathChanged = { kind: "pathChanged", localSnapshot: "mine" } as const
const unexpectedSymlink = { kind: "unexpectedSymlinkAtTarget", localSnapshot: "mine" } as const

it("requires tab, document, and view identity for completion", () => {
  const view = {} as EditorView
  const workspace = addTab(createWorkspace(), {
    ...createFileSession(2, "/notes/b.md", "b", version),
    documentId: 8,
  })
  const views = new Map<number, EditorView>([[2, view]])
  const capture = { tabId: 2, documentId: 8, view, operationId: 1, normalizationId: null }
  expect(isCurrentSaveTarget(capture, workspace, views)).toBe(true)
  expect(isCurrentSaveTarget({ ...capture, documentId: 9 }, workspace, views)).toBe(false)
  expect(isCurrentSaveTarget({ ...capture, tabId: 3 }, workspace, views)).toBe(false)
  expect(isCurrentSaveTarget(capture, workspace, new Map())).toBe(false)
})

it("classifies watcher probes without fetching contents", () => {
  const session = createFileSession(1, "/notes/a.md", "body", version)
  expect(watcherIntent(session, { kind: "existing", version })).toEqual({ kind: "ignore" })
  expect(watcherIntent(session, { kind: "missing" })).toEqual({ kind: "deleted" })
  expect(watcherIntent(session, {
    kind: "existing",
    version: { resolvedPath: "/notes/other.md", fingerprint: version.fingerprint },
  })).toEqual({ kind: "pathChanged" })
  expect(watcherIntent(session, { kind: "existing", version: nextVersion }))
    .toEqual({ kind: "fetchContents" })
})

it("maps every save result to a divergence", () => {
  expect(divergenceFromSaveResult({ status: "saved", version, durability: "durable" }, "mine")).toBeNull()
  expect(divergenceFromSaveResult({ status: "contentConflict", disk }, "mine"))
    .toEqual({ kind: "contentConflict", localSnapshot: "mine", disk })
  expect(divergenceFromSaveResult({ status: "createdConflict", disk }, "mine"))
    .toEqual({ kind: "createdAtMissingTarget", localSnapshot: "mine", disk })
  expect(divergenceFromSaveResult({ status: "deletedConflict", requestedPath: "/notes/a.md" }, "mine"))
    .toEqual({ kind: "deletedExternally", localSnapshot: "mine" })
  expect(divergenceFromSaveResult({ status: "pathChangedConflict", requestedPath: "/notes/a.md" }, "mine"))
    .toEqual(pathChanged)
  expect(divergenceFromSaveResult({ status: "unexpectedSymlinkConflict", requestedPath: "/notes/a.md" }, "mine"))
    .toEqual(unexpectedSymlink)
})

it("chooses divergence by local dirty state", () => {
  expect(divergenceFromSnapshot(disk, false, "body")).toEqual({ kind: "externalChanged", disk })
  expect(divergenceFromSnapshot(disk, true, "mine"))
    .toEqual({ kind: "contentConflict", localSnapshot: "mine", disk })
})

it("announces one banner by priority", () => {
  const deleted = applyDivergence(initialSaveState(), { kind: "deletedExternally", localSnapshot: "mine" })
  const conflict = applyDivergence(initialSaveState(), { kind: "contentConflict", localSnapshot: "mine", disk })
  const failed = failSave(beginSave(initialSaveState(), 1, "mine"), 1, "disk full")
  expect(topBanner(deleted, true)).toBe("conflict")
  expect(topBanner(conflict, true)).toBe("conflict")
  expect(topBanner(failed, true)).toBe("saveFailed")
  expect(topBanner(initialSaveState(), true)).toBe("normalization")
  expect(topBanner(initialSaveState(), false)).toBeNull()
})

it("labels every conflict action", () => {
  for (const action of Object.values(CONFLICT_ACTION_LABELS)) {
    expect(action.length).toBeGreaterThan(0)
  }
  expect(CONFLICT_ACTION_LABELS.reopenPrevious).toBe("Reopen previous file")
})
```

## Task 10: unified diff

```ts
it("splits distant changes into separate hunks", () => {
  const local = ["mine", "b", "c", "d", "e", "f", "g", "h", "i", "mine tail"].join("\n")
  const dsk = ["theirs", "b", "c", "d", "e", "f", "g", "h", "i", "theirs tail"].join("\n")
  const hunks = unifiedDiff(local, dsk)
  expect(hunks).toHaveLength(2)
  expect(hunks[0].localStart).toBe(1)
  expect(hunks[1].lines.some(line => line.text === "mine tail")).toBe(true)
})

it("falls back to a single replacement hunk for very large changes", () => {
  const local = Array.from({ length: 2500 }, (_, index) => `mine ${index}`).join("\n")
  const dsk = Array.from({ length: 2500 }, (_, index) => `theirs ${index}`).join("\n")
  const hunks = unifiedDiff(local, dsk)
  expect(hunks).toHaveLength(1)
  expect(hunks[0].lines.filter(line => line.kind === "removed")).toHaveLength(2500)
  expect(hunks[0].lines.filter(line => line.kind === "added")).toHaveLength(2500)
})
```

## Task 11: 组件

`SaveConflictBanner` 用 `role="status"` 且 `aria-label="Save conflict"`，与 01 的 normalization banner 区分。`DocumentDiffPanel` 用 `role="region"` 且 `aria-label="Document differences"`。

```tsx
it("renders hunks as text and jumps to the local line", () => {
  const onJump = vi.fn()
  render(<DocumentDiffPanel
    hunks={unifiedDiff("a\nmine\n", "a\ntheirs\n")}
    deleted={false}
    refreshed={false}
    onJump={onJump}
    onClose={vi.fn()} />)
  const panel = screen.getByRole("region", { name: "Document differences" })
  expect(panel.innerHTML).not.toContain("<script")
  expect(panel.textContent).toContain("theirs")
  fireEvent.click(screen.getByRole("button", { name: "Go to line 2" }))
  expect(onJump).toHaveBeenCalledWith(2)
})

it("marks a deleted file and a refreshed snapshot", () => {
  render(<DocumentDiffPanel
    hunks={unifiedDiff("mine\n", "")}
    deleted
    refreshed
    onJump={vi.fn()}
    onClose={vi.fn()} />)
  expect(screen.getByText("This file was deleted on disk.")).toBeTruthy()
  expect(screen.getByText("Disk contents were refreshed.")).toBeTruthy()
})

it("shows a conflict badge with an accessible name", () => {
  render(<TabBar tabs={[createFileSession(1, "/notes/a.md", "body", version)]}
    activeId={1} dirtyIds={[]} conflictIds={[1]}
    onFocus={vi.fn()} onClose={vi.fn()} onNew={vi.fn()} />)
  expect(screen.getByLabelText("Conflict")).toBeTruthy()
})

it("keeps path and dirty in one node while save status is separate", () => {
  render(<StatusBar path="/notes/a.md" dirty words={0} cursor="1:1" mode="live" saveStatus="conflict" />)
  expect(screen.getByText("/notes/a.md •")).toBeTruthy()
  expect(screen.getByText("conflict")).toBeTruthy()
})
```

## Task 12: harness 扩展

`appHarness.ts` 增加内存磁盘夹具；`saveDocument` 按 Rust 比较表返回 typed result，让 App 测试跑真实冲突分类：

```ts
export interface DiskFixture {
  set: (contents: string) => void
  remove: () => void
  contents: () => string | null
  version: () => DocumentVersion
  saveCalls: () => readonly {
    path: string
    contents: string
    expected: ExpectedDocumentVersion
  }[]
}

function fakeFingerprint(contents: string): string {
  return `v1:${contents.length}:${contents}`
}

export function makeFakeDisk() {
  const files = new Map<string, string>()
  const calls: { path: string; contents: string; expected: ExpectedDocumentVersion }[] = []
  const versionFor = (path: string, contents: string): DocumentVersion => ({
    resolvedPath: path,
    fingerprint: fakeFingerprint(contents),
  })

  function readDocument(path: string): DiskSnapshot {
    const contents = files.get(path)
    return contents === undefined
      ? { kind: "missing", requestedPath: path }
      : { kind: "existing", requestedPath: path, contents, version: versionFor(path, contents) }
  }

  function saveDocument(
    path: string,
    contents: string,
    expected: ExpectedDocumentVersion,
  ): SaveDocumentResult {
    calls.push({ path, contents, expected })
    const current = files.get(path)
    if (expected.kind === "missing") {
      if (current === undefined) {
        files.set(path, contents)
        return { status: "saved", version: versionFor(path, contents), durability: "durable" }
      }
      return {
        status: "createdConflict",
        disk: { requestedPath: path, contents: current, version: versionFor(path, current) },
      }
    }
    if (current === undefined) return { status: "deletedConflict", requestedPath: path }
    if (expected.version.resolvedPath !== path) {
      return { status: "pathChangedConflict", requestedPath: path }
    }
    if (expected.version.fingerprint !== fakeFingerprint(current)) {
      return {
        status: "contentConflict",
        disk: { requestedPath: path, contents: current, version: versionFor(path, current) },
      }
    }
    files.set(path, contents)
    return { status: "saved", version: versionFor(path, contents), durability: "durable" }
  }

  return { files, calls, readDocument, saveDocument, versionFor }
}
```

`AppHarness` 新成员：

```ts
export interface AppHarness {
  // ...01 的成员保持不变...
  disk: (path: string) => DiskFixture
  openFileTab: (path: string, contents: string) => Promise<void>
  saveActive: () => Promise<void>
  runWatcher: () => Promise<void>
  nextSaveResult: (result: SaveDocumentResult) => void
  failNextSave: (error: DocumentCommandError) => void
}
```

- `services.readDocument` / `readDocumentVersion` / `saveDocument` 默认代理到 fake disk；`readDocumentVersion` 只返回 version。
- `disk(path)` 返回该路径的视图：`contents()` 读 `files.get(path) ?? null`，`saveCalls()` 只返回 `calls` 中 `call.path === path` 的记录，`version()` 在文件缺失时抛错以暴露测试写错的前置条件。
- `nextSaveResult` / `failNextSave` 只影响下一次调用，用于制造 second-compare 与 IO 失败分支。
- `openFileTab(path, contents)` 先 `disk(path).set(contents)`，再走真实打开流程。
- `saveActive()` 触发 `Cmd+S`，`runWatcher()` 直接调用 watcher 一轮并 flush microtask。
- `writeFile` 保留但只用于 export 断言；任何 Markdown 保存断言必须走 `disk(path).saveCalls()`。

## Task 12: 打开、保存与 watcher 集成

```ts
it("opens a document through readDocument and saves the exact expected version", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openFileTab("/notes/a.md", "disk body")
  const opened = harness.disk("/notes/a.md").version()
  expect(harness.services.readDocument).toHaveBeenCalledWith("/notes/a.md")
  expect(harness.services.readFile).not.toHaveBeenCalled()

  harness.editorForTab(1).emit({ doc: "mine", docChanged: true, pendingNormalization: null })
  await harness.saveActive()

  expect(harness.disk("/notes/a.md").saveCalls().at(-1)).toEqual({
    path: "/notes/a.md",
    contents: "mine",
    expected: { kind: "existing", version: opened },
  })
  expect(screen.getByText("/notes/a.md")).toBeTruthy()
})

it("sends expected missing for an untitled document", async () => {
  const harness = makeAppHarness()
  vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/new.md")
  harness.renderApp()
  harness.editorForTab(1).emit({ doc: "mine", docChanged: true, pendingNormalization: null })
  await harness.saveActive()
  expect(harness.disk("/notes/new.md").saveCalls().at(-1)?.expected).toEqual({ kind: "missing" })
})

it("uses the check-time version for an existing Save As target", async () => {
  const harness = makeAppHarness()
  harness.disk("/notes/target.md").set("target body")
  vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/target.md")
  harness.renderApp()
  harness.editorForTab(1).emit({ doc: "mine", docChanged: true, pendingNormalization: null })
  await harness.saveActive()
  expect(harness.disk("/notes/target.md").saveCalls().at(-1)?.expected).toEqual({
    kind: "existing",
    version: { resolvedPath: "/notes/target.md", fingerprint: "v1:11:target body" },
  })
})

it("keeps content and recovery and pauses retries when autosave conflicts", async () => {
  vi.useFakeTimers()
  const harness = makeAppHarness()
  harness.renderApp({ autosaveMs: 100 })
  await harness.openFileTab("/notes/a.md", "saved")
  harness.disk("/notes/a.md").set("theirs")
  harness.editorForTab(1).emit({ doc: "mine", docChanged: true, pendingNormalization: null })

  await vi.advanceTimersByTimeAsync(100)

  expect(screen.getByRole("status", { name: "Save conflict" }).textContent).toContain("changed on disk")
  expect(harness.services.writeRecovery).toHaveBeenCalled()
  expect(harness.services.reportError).not.toHaveBeenCalled()
  expect(harness.disk("/notes/a.md").contents()).toBe("theirs")
  const attempts = harness.disk("/notes/a.md").saveCalls().length
  await vi.advanceTimersByTimeAsync(1000)
  expect(harness.disk("/notes/a.md").saveCalls().length).toBe(attempts)
  vi.useRealTimers()
})

it("focuses the conflict banner instead of overwriting on Cmd+S", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openFileTab("/notes/a.md", "saved")
  harness.disk("/notes/a.md").set("theirs")
  harness.editorForTab(1).emit({ doc: "mine", docChanged: true, pendingNormalization: null })
  await harness.saveActive()
  const attempts = harness.disk("/notes/a.md").saveCalls().length

  fireEvent.keyDown(window, { key: "s", metaKey: true })

  expect(document.activeElement?.textContent).toBe("Compare")
  expect(harness.disk("/notes/a.md").saveCalls().length).toBe(attempts)
})

it("polls every file tab and fetches contents only after a version change", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openFileTab("/notes/a.md", "a body")
  await harness.openInNewTab("/notes/b.md", "b body")
  vi.mocked(harness.services.readDocument).mockClear()

  await harness.runWatcher()
  expect(harness.services.readDocumentVersion).toHaveBeenCalledWith("/notes/a.md")
  expect(harness.services.readDocumentVersion).toHaveBeenCalledWith("/notes/b.md")
  expect(harness.services.readDocument).not.toHaveBeenCalled()

  harness.disk("/notes/b.md").set("b changed")
  await harness.runWatcher()
  expect(harness.services.readDocument).toHaveBeenCalledWith("/notes/b.md")
})

it("does not report an external change for the app's own save", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openFileTab("/notes/a.md", "saved")
  harness.editorForTab(1).emit({ doc: "mine", docChanged: true, pendingNormalization: null })
  await harness.saveActive()

  await harness.runWatcher()

  expect(screen.queryByRole("status", { name: "Save conflict" })).toBeNull()
  expect(screen.getByText("/notes/a.md")).toBeTruthy()
})

it("records a durability warning without failing the save", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openFileTab("/notes/a.md", "saved")
  harness.editorForTab(1).emit({ doc: "mine", docChanged: true, pendingNormalization: null })
  harness.nextSaveResult({
    status: "saved",
    version: { resolvedPath: "/notes/a.md", fingerprint: "v1:4:mine" },
    durability: "directorySyncFailed",
  })

  await harness.saveActive()

  expect(screen.getByText("/notes/a.md")).toBeTruthy()
  expect(screen.getByText("Saved, but the folder could not be flushed to disk.")).toBeTruthy()
  expect(screen.queryByRole("status", { name: "Save conflict" })).toBeNull()
})

it("completes two tabs in either order without polluting the active tab", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openFileTab("/notes/a.md", "a saved")
  await harness.openInNewTab("/notes/b.md", "b saved")
  harness.editorForTab(1).emit({ doc: "a mine", docChanged: true, pendingNormalization: null })
  harness.editorForTab(2).emit({ doc: "b mine", docChanged: true, pendingNormalization: null })

  harness.activateTab(1)
  const first = harness.saveActive()
  harness.activateTab(2)
  const second = harness.saveActive()
  await Promise.all([first, second])

  expect(harness.disk("/notes/a.md").contents()).toBe("a mine")
  expect(harness.disk("/notes/b.md").contents()).toBe("b mine")
  expect(screen.getByText("/notes/b.md")).toBeTruthy()
  expect(screen.queryByText("/notes/b.md •")).toBeNull()
})

it("shows a clean external update without reloading automatically", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openFileTab("/notes/a.md", "saved")
  harness.disk("/notes/a.md").set("theirs")

  await harness.runWatcher()

  const banner = screen.getByRole("status", { name: "Save conflict" })
  expect(banner.textContent).toContain("updated on disk")
  expect(screen.getByRole("button", { name: "Keep current" })).toBeTruthy()
  expect(harness.editorForTab(1).getOptions().doc).toBe("saved")
})
```

## Task 13: 冲突操作

```ts
async function openConflict(harness: AppHarness) {
  harness.renderApp()
  await harness.openFileTab("/notes/a.md", "saved")
  harness.disk("/notes/a.md").set("theirs")
  harness.editorForTab(1).emit({ doc: "mine", docChanged: true, pendingNormalization: null })
  await harness.saveActive()
}

it("compare opens the diff panel without touching disk or state", async () => {
  const harness = makeAppHarness()
  await openConflict(harness)
  const attempts = harness.disk("/notes/a.md").saveCalls().length

  fireEvent.click(screen.getByRole("button", { name: "Compare" }))

  const panel = screen.getByRole("region", { name: "Document differences" })
  expect(panel.textContent).toContain("theirs")
  expect(panel.textContent).toContain("mine")
  expect(harness.disk("/notes/a.md").contents()).toBe("theirs")
  expect(harness.disk("/notes/a.md").saveCalls().length).toBe(attempts)
})

it("save copy keeps the original path, version, and conflict", async () => {
  const harness = makeAppHarness()
  await openConflict(harness)
  vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/copy.md")

  fireEvent.click(screen.getByRole("button", { name: "Save copy" }))
  await waitFor(() => expect(harness.disk("/notes/copy.md").contents()).toBe("mine"))

  expect(harness.disk("/notes/a.md").contents()).toBe("theirs")
  expect(screen.getByText("/notes/a.md •")).toBeTruthy()
  expect(screen.getByRole("status", { name: "Save conflict" })).toBeTruthy()
})

it("save copy refuses the original resolved path", async () => {
  const harness = makeAppHarness()
  await openConflict(harness)
  vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/a.md")

  fireEvent.click(screen.getByRole("button", { name: "Save copy" }))

  await waitFor(() => expect(screen.getByText("Choose a different file for the copy.")).toBeTruthy())
  expect(harness.disk("/notes/a.md").contents()).toBe("theirs")
})

it("reload re-reads on click and asks before discarding local edits", async () => {
  const harness = makeAppHarness()
  await openConflict(harness)
  harness.disk("/notes/a.md").set("newest")

  fireEvent.click(screen.getByRole("button", { name: "Reload disk" }))

  await waitFor(() => expect(harness.services.confirmDiscard).toHaveBeenCalled())
  await waitFor(() => expect(harness.editorForTab(1).getOptions().doc).toBe("newest"))
  expect(screen.queryByRole("status", { name: "Save conflict" })).toBeNull()
  expect(harness.services.clearRecovery).toHaveBeenCalled()
})

it("reload cancellation keeps the conflict and the local text", async () => {
  const harness = makeAppHarness()
  await openConflict(harness)
  vi.mocked(harness.services.confirmDiscard).mockReturnValue(false)

  fireEvent.click(screen.getByRole("button", { name: "Reload disk" }))

  await waitFor(() => expect(harness.services.confirmDiscard).toHaveBeenCalled())
  expect(screen.getByRole("status", { name: "Save conflict" })).toBeTruthy()
  expect(harness.editorForTab(1).getOptions().doc).toBe("saved")
})

it("overwrite uses the conflict version and replaces it when disk changes again", async () => {
  const harness = makeAppHarness()
  await openConflict(harness)
  const conflictVersion = harness.disk("/notes/a.md").version()

  harness.disk("/notes/a.md").set("newer theirs")
  fireEvent.click(screen.getByRole("button", { name: "Overwrite disk" }))

  await waitFor(() => expect(harness.disk("/notes/a.md").saveCalls().at(-1)?.expected).toEqual({
    kind: "existing", version: conflictVersion,
  }))
  expect(harness.disk("/notes/a.md").contents()).toBe("newer theirs")
  const banner = screen.getByRole("status", { name: "Save conflict" })
  expect(banner.textContent).toContain("changed on disk")

  fireEvent.click(screen.getByRole("button", { name: "Overwrite disk" }))
  await waitFor(() => expect(harness.disk("/notes/a.md").contents()).toBe("mine"))
  expect(screen.queryByRole("status", { name: "Save conflict" })).toBeNull()
  expect(screen.getByText("/notes/a.md")).toBeTruthy()
})

it("recreate uses expected missing and stays in conflict when the path reappears", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openFileTab("/notes/a.md", "saved")
  harness.editorForTab(1).emit({ doc: "mine", docChanged: true, pendingNormalization: null })
  harness.disk("/notes/a.md").remove()
  await harness.saveActive()
  expect(screen.getByRole("button", { name: "Recreate file" })).toBeTruthy()

  harness.disk("/notes/a.md").set("someone else")
  fireEvent.click(screen.getByRole("button", { name: "Recreate file" }))

  await waitFor(() => expect(harness.disk("/notes/a.md").saveCalls().at(-1)?.expected)
    .toEqual({ kind: "missing" }))
  expect(harness.disk("/notes/a.md").contents()).toBe("someone else")
  expect(screen.getByRole("button", { name: "Choose another path" })).toBeTruthy()
})

it("close and discard confirms, clears recovery, and cancels safely", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openFileTab("/notes/a.md", "saved")
  await harness.openInNewTab("/notes/b.md", "b body")
  harness.activateTab(1)
  harness.editorForTab(1).emit({ doc: "mine", docChanged: true, pendingNormalization: null })
  harness.disk("/notes/a.md").remove()
  await harness.saveActive()

  vi.mocked(harness.services.confirmClose).mockReturnValueOnce(false)
  fireEvent.click(screen.getByRole("button", { name: "Close and discard" }))
  expect(screen.getByRole("status", { name: "Save conflict" })).toBeTruthy()

  vi.mocked(harness.services.confirmClose).mockReturnValueOnce(true)
  fireEvent.click(screen.getByRole("button", { name: "Close and discard" }))
  await waitFor(() => expect(screen.queryByText("a.md")).toBeNull())
  expect(harness.services.clearRecovery).toHaveBeenCalled()
})

it("path changed reopens only the previous resolved path after confirmation", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openFileTab("/notes/a.md", "saved")
  harness.editorForTab(1).emit({ doc: "mine", docChanged: true, pendingNormalization: null })
  harness.nextSaveResult({ status: "pathChangedConflict", requestedPath: "/notes/a.md" })
  await harness.saveActive()

  expect(screen.queryByRole("button", { name: "Compare" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Overwrite disk" })).toBeNull()

  vi.mocked(harness.services.confirmDiscard).mockReturnValueOnce(false)
  fireEvent.click(screen.getByRole("button", { name: "Reopen previous file" }))
  expect(harness.editorForTab(1).getOptions().doc).toBe("saved")

  vi.mocked(harness.services.confirmDiscard).mockReturnValueOnce(true)
  fireEvent.click(screen.getByRole("button", { name: "Reopen previous file" }))
  await waitFor(() => expect(harness.services.readDocument).toHaveBeenLastCalledWith("/notes/a.md"))
})

it("unexpected symlink offers only another path and never resets the editor", async () => {
  const harness = makeAppHarness()
  vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/new.md")
  harness.renderApp()
  harness.editorForTab(1).emit({ doc: "mine", docChanged: true, pendingNormalization: null })
  harness.nextSaveResult({ status: "unexpectedSymlinkConflict", requestedPath: "/notes/new.md" })
  await harness.saveActive()

  expect(screen.queryByRole("button", { name: "Compare" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Overwrite disk" })).toBeNull()
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy()

  vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/other.md")
  fireEvent.click(screen.getByRole("button", { name: "Choose another path" }))

  await waitFor(() => expect(harness.disk("/notes/other.md").contents()).toBe("mine"))
  expect(harness.editorForTab(1).getOptions().doc).toBe("")
  expect(harness.editorForTab(1).view.dispatch).not.toHaveBeenCalled()
})

it("permission denied offers retry, save copy, and reveal in Finder", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openFileTab("/notes/a.md", "saved")
  harness.editorForTab(1).emit({ doc: "mine", docChanged: true, pendingNormalization: null })
  harness.failNextSave({ code: "permissionDenied", message: "cannot write to this location" })
  await harness.saveActive()

  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Save copy" })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Reveal in Finder" }))
  expect(harness.services.revealInFinder).toHaveBeenCalledWith("/notes/a.md")

  fireEvent.click(screen.getByRole("button", { name: "Retry" }))
  await waitFor(() => expect(harness.disk("/notes/a.md").contents()).toBe("mine"))
})

it("shows a background conflict as a tab badge and reveals the banner after switching", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openFileTab("/notes/a.md", "a saved")
  await harness.openInNewTab("/notes/b.md", "b saved")
  harness.editorForTab(2).emit({ doc: "b mine", docChanged: true, pendingNormalization: null })
  harness.disk("/notes/b.md").set("b theirs")
  await harness.saveActive()

  harness.activateTab(1)
  expect(screen.queryByRole("status", { name: "Save conflict" })).toBeNull()
  expect(screen.getByLabelText("Conflict")).toBeTruthy()

  harness.activateTab(2)
  expect(screen.getByRole("status", { name: "Save conflict" })).toBeTruthy()
})

it("accepts normalization only after a successful guarded save", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openFileTab("/notes/a.md", "1. a\n3. b")
  harness.emitPending(1, normalizationId(1))
  harness.disk("/notes/a.md").set("theirs")

  await harness.saveNormalization(1)

  expect(vi.mocked(acceptOrderedListNormalization)).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "Save normalization" })).toBeTruthy()

  harness.disk("/notes/a.md").set("1. a\n3. b")
  fireEvent.click(screen.getByRole("button", { name: "Overwrite disk" }))

  await waitFor(() => expect(vi.mocked(acceptOrderedListNormalization)).toHaveBeenCalledOnce())
  expect(harness.editorForTab(1).view.dispatch).toHaveBeenCalledOnce()
})

it("recomputes the local diff after a debounce instead of on every keystroke", async () => {
  vi.useFakeTimers()
  const harness = makeAppHarness()
  await openConflict(harness)
  fireEvent.click(screen.getByRole("button", { name: "Compare" }))

  harness.editorForTab(1).emit({ doc: "mine edited", docChanged: true, pendingNormalization: null })
  expect(screen.getByRole("region", { name: "Document differences" }).textContent)
    .not.toContain("mine edited")

  await vi.advanceTimersByTimeAsync(150)

  expect(screen.getByRole("region", { name: "Document differences" }).textContent)
    .toContain("mine edited")
  vi.useRealTimers()
})

it("refreshes the diff when the watcher sees a newer disk snapshot", async () => {
  const harness = makeAppHarness()
  await openConflict(harness)
  fireEvent.click(screen.getByRole("button", { name: "Compare" }))
  harness.disk("/notes/a.md").set("newest theirs")

  await harness.runWatcher()

  const panel = screen.getByRole("region", { name: "Document differences" })
  expect(panel.textContent).toContain("newest theirs")
  expect(screen.getByText("Disk contents were refreshed.")).toBeTruthy()
})

it("save copy does not accept normalization and reload clears stale pending", async () => {
  const harness = makeAppHarness()
  harness.renderApp()
  await harness.openFileTab("/notes/a.md", "1. a\n3. b")
  harness.emitPending(1, normalizationId(1))
  harness.disk("/notes/a.md").set("theirs")
  await harness.saveNormalization(1)

  vi.mocked(harness.services.pickSavePath).mockResolvedValue("/notes/copy.md")
  fireEvent.click(screen.getByRole("button", { name: "Save copy" }))
  await waitFor(() => expect(harness.disk("/notes/copy.md").contents()).toBe("1. a\n2. b"))
  expect(vi.mocked(acceptOrderedListNormalization)).not.toHaveBeenCalled()

  vi.mocked(harness.services.confirmDiscard).mockReturnValue(true)
  fireEvent.click(screen.getByRole("button", { name: "Reload disk" }))

  await waitFor(() => expect(screen.queryByRole("button", { name: "Save normalization" })).toBeNull())
})
```

## 覆盖对照

宣布完成前，逐条对照规格三张矩阵与本附录、主计划中的测试名：

- Rust 矩阵 1–22：Task 1（1–3、15、22 的读取部分）、Task 2（16、17、22 的分类部分）、Task 3（8、14）、Task 4（4–7、9–11、18、19、21）、Task 5（12、13、19、20）。
- Desktop state/coordinator 矩阵 1–11：Task 8（1–3、10）、Task 9（4–7、11）、Task 7（8、9）。
- App/UI 矩阵 1–25：Task 12（1–4、12、13、15、16、19–21）、Task 13（5–11、14、17、22–24）、Task 11（18）、Task 6 与 Task 13（25）。

`SaveDurability::DirectorySyncFailed` 的两端行为分别由 Rust 的 `guarded_parent_sync_failure_downgrades_durability_only` 与 Desktop 的 `records a durability warning without failing the save` 覆盖。
