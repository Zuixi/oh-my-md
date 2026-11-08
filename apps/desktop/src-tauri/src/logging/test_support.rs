use super::{frontend::FrontendRecord, LOG_FRONTEND_COMMAND};
use crate::log_capture::{records_for_target, take_captured_records, CapturedRecord};
use std::path::{Path, PathBuf};

pub(super) fn write_log(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    path
}

pub(super) fn take_captured() -> Vec<String> {
    take_captured_records()
        .into_iter()
        .map(|record| record.message)
        .collect()
}

pub(super) fn frontend_record(level: &str, target: &str, message: &str) -> FrontendRecord {
    FrontendRecord {
        level: level.to_string(),
        target: target.to_string(),
        message: message.to_string(),
    }
}

pub(super) fn info(message: &str) -> FrontendRecord {
    frontend_record("info", "frontend", message)
}

pub(super) fn error(message: &str) -> FrontendRecord {
    frontend_record("error", "frontend", message)
}

/// The layer-4 notices in a capture, isolated by their target so a test can
/// count them without the frontend records around them.
pub(super) fn collapse_notices(records: &[CapturedRecord]) -> Vec<String> {
    records
        .iter()
        .filter(|record| record.target == LOG_FRONTEND_COMMAND)
        .map(|record| record.message.clone())
        .collect()
}

/// The tests that drive the sink with the frontend's own target and level.
pub(super) fn frontend_records(records: &[CapturedRecord]) -> Vec<CapturedRecord> {
    records_for_target(records, "frontend")
}

pub(super) fn frontend_messages(records: &[CapturedRecord]) -> Vec<String> {
    frontend_records(records)
        .into_iter()
        .map(|record| record.message)
        .collect()
}

/// The lines the file sink writes for `records`, in the sink's real
/// envelope.
///
/// `tauri-plugin-log` 2.9.0's default fern dispatch formats every record as
/// `{timestamp}[{target}][{LEVEL}] {message}` (its `impl Default for
/// Builder`, `src/lib.rs`; the timestamp renders as `[YYYY-MM-DD][HH:MM:SS]`).
/// Target and message therefore share one physical line and the scanner
/// reads both. An earlier form rendered only `"{target} {message}"` and so
/// under-modelled what a forged boundary has to escape out of; the fixed
/// timestamp keeps the output deterministic.
pub(super) fn written_lines(records: &[CapturedRecord]) -> String {
    records
        .iter()
        .map(|record| {
            format!(
                "[2026-10-03][12:00:00][{}][{}] {}",
                record.target, record.level, record.message
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// The determination line is written *after* the `session start` of the run
// that logs it, so the next launch's scanner reads it back. Driving the
// real writers (not copies of their strings, as
// `parse_markers_ignores_the_determination_lines` does) means a rewording
// that ends a marker on a space — the change that turns a crash into a
// phantom exit intent — fails here.
