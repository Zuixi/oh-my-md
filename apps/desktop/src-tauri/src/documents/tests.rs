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
        stats: DocumentFileStats {
            byte_length: contents.len() as u64,
            line_count: count_lines(contents.as_bytes()),
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

// The webview reads `requestedPath`; enum-level `rename_all` only renames
// variant names, so each struct variant needs its own `rename_all`.
#[test]
fn disk_snapshot_serializes_requested_path_as_camel_case() {
    let existing = DiskSnapshot::Existing {
        requested_path: "/tmp/a.md".into(),
        contents: "body".into(),
        version: DocumentVersion {
            resolved_path: "/tmp/a.md".into(),
            fingerprint: "v1:x".into(),
        },
        stats: DocumentFileStats {
            byte_length: 4,
            line_count: 1,
        },
    };
    let json = serde_json::to_string(&existing).unwrap();
    assert!(
        json.contains(r#""requestedPath":"/tmp/a.md""#),
        "payload: {json}"
    );
    assert!(
        json.contains(r#""stats":{"byteLength":4,"lineCount":1}"#),
        "payload: {json}"
    );
    assert!(!json.contains("requested_path"), "payload: {json}");
    assert!(!json.contains("byte_length"), "payload: {json}");

    let missing = DiskSnapshot::Missing {
        requested_path: "/tmp/a.md".into(),
    };
    let missing_json = serde_json::to_string(&missing).unwrap();
    assert!(
        missing_json.contains(r#""requestedPath":"/tmp/a.md""#),
        "payload: {missing_json}"
    );
}

#[test]
fn stat_document_reports_size_and_missing_without_reading_contents() {
    let file = write_temp("stat-document", "a\nb\nc");
    match stat_document_blocking(&path_string_for(&file)).unwrap() {
        DocumentStat::Existing {
            requested_path,
            size_bytes,
        } => {
            assert_eq!(requested_path, path_string_for(&file));
            assert_eq!(size_bytes, 5);
        }
        other => panic!("unexpected stat: {other:?}"),
    }

    let missing = temp_dir("stat-document").join("absent.md");
    match stat_document_blocking(&path_string_for(&missing)).unwrap() {
        DocumentStat::Missing { requested_path } => {
            assert_eq!(requested_path, path_string_for(&missing));
        }
        other => panic!("unexpected stat: {other:?}"),
    }
}

#[test]
fn document_stat_serializes_size_bytes_as_camel_case() {
    let stat = DocumentStat::Existing {
        requested_path: "/tmp/a.md".into(),
        size_bytes: 11,
    };
    let json = serde_json::to_string(&stat).unwrap();
    assert!(json.contains(r#""sizeBytes":11"#), "payload: {json}");
    assert!(!json.contains("size_bytes"), "payload: {json}");
}

#[test]
fn read_document_stats_match_contents() {
    let contents = "one\ntwo\nthree\n";
    let file = write_temp("read-stats", contents);
    match read_document_blocking(&path_string_for(&file)).unwrap() {
        DiskSnapshot::Existing { stats, .. } => {
            assert_eq!(stats.byte_length, contents.len() as u64);
            // Three trailing newlines delimit three lines plus an empty last
            // line, matching CM's doc.lines convention.
            assert_eq!(stats.line_count, 4);
        }
        other => panic!("unexpected snapshot: {other:?}"),
    }
    assert_eq!(count_lines(b""), 1);
    assert_eq!(count_lines(b"no newline"), 1);
    assert_eq!(count_lines(b"a\n"), 2);
    // CM DefaultSplit /\r\n?|\n/: CRLF and lone CR are both single separators.
    assert_eq!(count_lines(b"a\r\nb"), 2);
    assert_eq!(count_lines(b"a\rb"), 2);
    assert_eq!(count_lines(b"a\r\nb\r\n"), 3);
    assert_eq!(count_lines(b"\r\r"), 3);
    assert_eq!(count_lines(b"\n\r"), 3);
}

#[test]
fn streaming_line_count_matches_cm_convention_across_chunk_boundaries() {
    // `\r` at a chunk boundary must not be misread as a lone separator when
    // the next chunk starts with `\n`.
    let contents = "a\r\nb\rc\r\nd";
    let file = write_temp("stream-crlf", contents);
    let meta = read_document_streaming_blocking(&path_string_for(&file), 2, &|_| {}).unwrap();
    match meta {
        // "a\r\nb\rc\r\nd" = CRLF + lone CR + CRLF = 3 separators → 4 lines.
        DocumentOpenStream::Existing { stats, .. } => {
            assert_eq!(stats.line_count, 4, "CM would report 4 lines");
            assert_eq!(stats.byte_length, contents.len() as u64);
        }
        other => panic!("unexpected stream meta: {other:?}"),
    }
}

#[test]
fn streaming_chunks_reassemble_to_the_original_text_across_char_boundaries() {
    // 每块 4 字节会反复切在多字节序列中间：验证边界扣留逻辑。
    let contents = "a文\nb档\nend";
    let file = write_temp("stream-chunks", contents);
    let chunks: std::cell::RefCell<Vec<String>> = std::cell::RefCell::new(Vec::new());
    let meta = read_document_streaming_blocking(&path_string_for(&file), 4, &|event| {
        if let OpenStreamEvent::Chunk { text, .. } = event {
            chunks.borrow_mut().push(text);
        }
    })
    .unwrap();
    assert_eq!(chunks.borrow().concat(), contents);
    match meta {
        DocumentOpenStream::Existing { stats, version, .. } => {
            assert_eq!(stats.byte_length, contents.len() as u64);
            assert_eq!(stats.line_count, 3);
            assert_eq!(version.fingerprint, fingerprint(contents.as_bytes()));
        }
        other => panic!("unexpected stream meta: {other:?}"),
    }
}

#[test]
fn streaming_reports_progress_and_missing() {
    let contents = "0123456789";
    let file = write_temp("stream-progress", contents);
    let progress: std::cell::RefCell<Vec<(u64, u64)>> = std::cell::RefCell::new(Vec::new());
    read_document_streaming_blocking(&path_string_for(&file), 4, &|event| {
        if let OpenStreamEvent::Progress {
            bytes_read,
            byte_length,
        } = event
        {
            progress.borrow_mut().push((bytes_read, byte_length));
        }
    })
    .unwrap();
    let progress = progress.borrow();
    assert_eq!(progress.first(), Some(&(4, 10)));
    assert_eq!(progress.last(), Some(&(10, 10)));

    let missing = temp_dir("stream-progress").join("absent.md");
    assert!(matches!(
        read_document_streaming_blocking(&path_string_for(&missing), 4, &|_| {}).unwrap(),
        DocumentOpenStream::Missing { .. }
    ));
}

#[test]
fn streaming_rejects_non_utf8() {
    let file = temp_dir("stream-utf8").join("binary.md");
    fs::write(&file, [0x61, 0xff, 0xfe]).unwrap();
    assert!(matches!(
        read_document_streaming_blocking(&path_string_for(&file), 2, &|_| {}),
        Err(DocumentError::NotUtf8(_))
    ));
}

#[test]
fn open_stream_event_serializes_as_camel_case() {
    let json = serde_json::to_string(&OpenStreamEvent::Progress {
        bytes_read: 5,
        byte_length: 10,
    })
    .unwrap();
    assert!(json.contains(r#""bytesRead":5"#), "payload: {json}");
    let json = serde_json::to_string(&OpenStreamEvent::Chunk {
        index: 1,
        text: "a".into(),
    })
    .unwrap();
    assert!(json.contains(r#""index":1"#), "payload: {json}");
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

#[cfg(unix)]
#[test]
fn metadata_permission_bits_survive_a_guarded_save() {
    use std::os::unix::fs::PermissionsExt;

    let coordinator = DocumentCoordinator::default();
    let file = write_temp("permission-bits", "original");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
    let expected = existing_expected(&file);
    guarded_save(&coordinator, &path_string_for(&file), "mine", &expected).unwrap();
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o640
    );
}

#[cfg(target_os = "macos")]
#[test]
fn metadata_required_user_xattrs_survive_a_guarded_save() {
    let coordinator = DocumentCoordinator::default();
    let file = write_temp("xattr-keep", "original");
    xattr::set(&file, "com.apple.metadata:_kMDItemUserTags", b"tag").unwrap();
    let expected = existing_expected(&file);

    guarded_save(&coordinator, &path_string_for(&file), "mine", &expected).unwrap();

    assert_eq!(
        xattr::get(&file, "com.apple.metadata:_kMDItemUserTags")
            .unwrap()
            .as_deref(),
        Some(b"tag".as_slice()),
    );
}

#[cfg(target_os = "macos")]
#[test]
fn metadata_required_xattr_failure_reports_metadata_failed_and_keeps_the_target() {
    let file = write_temp("xattr-fail", "original");
    xattr::set(&file, "com.apple.metadata:_kMDItemUserTags", b"tag").unwrap();
    let absent = file.parent().unwrap().join("absent.tmp");
    assert!(matches!(
        copy_metadata(&file, &absent),
        Err(DocumentError::MetadataFailed(_))
    ));
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

    assert_eq!(
        fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        expected_mode
    );
}

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
