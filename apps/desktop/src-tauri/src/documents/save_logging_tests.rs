use super::tests::{existing_expected, path_string_for, temp_dir};
use super::*;
use std::fs;

#[test]
fn a_save_has_one_info_result_with_a_duration_and_no_document_body() {
    let _capture = crate::log_capture::capture_log();
    let coordinator = DocumentCoordinator::default();
    let file = temp_dir("log-success").join("document.md");
    let _ = guarded_save(
        &coordinator,
        &path_string_for(&file),
        "private document body",
        &ExpectedDocumentVersion::Missing,
    )
    .unwrap();
    let records = save_log_records(&file);
    let info: Vec<_> = records
        .iter()
        .filter(|record| record.level == log::Level::Info)
        .collect();
    assert_eq!(info.len(), 1);
    assert!(info[0].message.starts_with("save ok "));
    assert!(info[0].message.contains("duration_ms="));
    assert!(!info[0].message.contains("private document body"));
    assert!(records.iter().any(
        |record| record.level == log::Level::Debug && record.message.starts_with("save begin ")
    ));
}

#[test]
fn an_initial_compare_conflict_has_one_terminal_record() {
    let _capture = crate::log_capture::capture_log();
    let coordinator = DocumentCoordinator::default();
    let file = temp_dir("log-conflict").join("document.md");
    fs::write(&file, "baseline").unwrap();
    let expected = existing_expected(&file);
    fs::write(&file, "external").unwrap();
    let result = guarded_save(&coordinator, &path_string_for(&file), "mine", &expected).unwrap();
    assert!(!matches!(result, SaveDocumentResult::Saved { .. }));
    let records = save_log_records(&file);
    assert_eq!(
        records
            .iter()
            .filter(|record| record.message.starts_with("save conflict "))
            .count(),
        1
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), "external");
}

/// The log target of `documents/save.rs`'s boundary lines, as `log` records it.
fn save_log_target() -> &'static str {
    super::save::log_target()
}

/// The captured `save` boundary records for one path, in capture order.
///
/// The facade buffer is process-global and cargo runs these tests in parallel,
/// so both the target *and* the path are filtered: another save test's lines
/// carry a different `path=` field.
fn save_log_records(path: &Path) -> Vec<crate::log_capture::CapturedRecord> {
    let field = crate::logging::path_field(path);
    crate::log_capture::records_for_target(
        &crate::log_capture::take_captured_records(),
        save_log_target(),
    )
    .into_iter()
    .filter(|record| record.message.contains(field.as_str()))
    .collect()
}

/// A save that fails after `save begin` must not leave the begin dangling: the
/// error path writes its terminal line before returning.
///
/// A document changed externally to non-UTF-8 is the reachable case —
/// `probe_disk` answers `NotUtf8` before anything is written.
#[test]
fn guarded_save_logs_begin_and_failure_when_the_probe_rejects_the_disk() {
    let _capture = crate::log_capture::capture_log();
    let coordinator = DocumentCoordinator::default();
    let file = temp_dir("log-not-utf8").join("document.md");
    fs::write(&file, [0xff, 0xfe, 0xfd]).unwrap();
    let field = crate::logging::path_field(&file);

    let result = guarded_save(
        &coordinator,
        &path_string_for(&file),
        "mine",
        &ExpectedDocumentVersion::Missing,
    );

    assert!(matches!(result, Err(DocumentError::NotUtf8(_))));
    let records = save_log_records(&file);
    let messages: Vec<&str> = records.iter().map(|r| r.message.as_str()).collect();
    assert_eq!(
        messages,
        vec![
            format!("save begin {field}"),
            format!("save failed {field} error=document bytes are not valid UTF-8"),
        ],
        "a failed save must keep begin and the failure line together"
    );
    assert_eq!(records[1].level, log::Level::Error);
}

/// A save rejected before `save begin` is reached must still leave a structured
/// failure line: spec §3.6 guarantees the `Err` arm, not the begin pairing. The
/// previous behaviour left the log silent for exactly these setup failures.
///
/// The fixture is a real one — the target's parent directory is gone, so the
/// save is rejected while resolving the per-path lock, before any probe.
#[test]
fn guarded_save_logs_a_failure_when_the_request_is_rejected_before_the_begin() {
    let _capture = crate::log_capture::capture_log();
    let coordinator = DocumentCoordinator::default();
    let directory = temp_dir("log-rejected-request");
    let file = directory.join("document.md");
    fs::write(&file, "original").unwrap();
    fs::remove_dir_all(&directory).unwrap();
    let field = crate::logging::path_field(&file);

    let result = guarded_save(
        &coordinator,
        &path_string_for(&file),
        "mine",
        &ExpectedDocumentVersion::Missing,
    );

    assert!(
        matches!(result, Err(DocumentError::InvalidPath(_))),
        "the fixture must produce a rejected save: {result:?}"
    );
    let records = save_log_records(&file);
    assert_eq!(
        records.len(),
        1,
        "a rejected request leaves exactly the failure line: {:?}",
        records
            .iter()
            .map(|r| r.message.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(records[0].level, log::Level::Error);
    assert!(
        records[0]
            .message
            .starts_with(&format!("save failed {field} error=")),
        "got {:?}",
        records[0].message
    );
}

// A save whose directory sync failed is a durability warning, not a full
// success. The log is the only artifact a support reader gets, so it must say
// which of the two happened.
#[test]
fn a_saved_record_names_the_durability_of_the_write() {
    let _capture = crate::log_capture::capture_log();
    let coordinator = DocumentCoordinator::default();
    let file = temp_dir("log-durability").join("document.md");
    guarded_save(
        &coordinator,
        &path_string_for(&file),
        "body",
        &ExpectedDocumentVersion::Missing,
    )
    .unwrap();

    let records = save_log_records(&file);
    let ok = records
        .iter()
        .find(|record| record.message.starts_with("save ok "))
        .expect("a successful save must record one terminal line");
    assert!(
        ok.message.contains("durability=durable"),
        "got {:?}",
        ok.message
    );
}
