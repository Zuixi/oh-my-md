//! Test-only capture of what the `log` facade receives.
//!
//! Boundary lines ("save begin", "save failed", …) are written through `log`
//! from modules whose tests cannot build the plugin's file sink, so the facade
//! is the observable seam. Cargo runs tests on parallel threads and the logger
//! is process-global, so every capture test takes [`capture_log`] for its whole
//! body and filters the shared buffer by target.

use std::sync::Mutex;

/// What the facade received; the target and level travel with the message
/// because the file sink writes them into the same physical line.
#[derive(Clone, Debug)]
pub(crate) struct CapturedRecord {
    pub(crate) level: log::Level,
    pub(crate) target: String,
    pub(crate) message: String,
}

static CAPTURED: Mutex<Vec<CapturedRecord>> = Mutex::new(Vec::new());

/// Serializes the tests that drive the process-global facade: they share
/// `CAPTURED`, and `log::set_boxed_logger` can only succeed once.
static LOGGER_LOCK: Mutex<()> = Mutex::new(());

struct CapturingLogger;

impl log::Log for CapturingLogger {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        CAPTURED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(CapturedRecord {
                level: record.level(),
                target: record.target().to_string(),
                message: record.args().to_string(),
            });
    }

    fn flush(&self) {}
}

/// Installs the capturing logger once for the whole test binary and holds the
/// lock that keeps its tests from interleaving captured records. Cargo runs
/// tests on parallel threads, so the guard must live for the test.
pub(crate) fn capture_log() -> std::sync::MutexGuard<'static, ()> {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    let guard = LOGGER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    INSTALL.call_once(|| {
        log::set_boxed_logger(Box::new(CapturingLogger)).expect("no logger in unit tests");
        log::set_max_level(log::LevelFilter::Trace);
    });
    guard
}

pub(crate) fn take_captured_records() -> Vec<CapturedRecord> {
    std::mem::take(&mut *CAPTURED.lock().unwrap_or_else(|e| e.into_inner()))
}

/// The captured records whose target starts with `prefix`: the records the
/// calling test logged, and only those.
///
/// Other tests in the binary log through the same process-global facade (the
/// `ignore` crate is chatty at debug) and cargo runs them in parallel, so an
/// unfiltered assertion on the captured set is flaky. But the filter has to
/// name the target *that test* used: a helper with a hard-coded target returns
/// nothing at all for a test that logged somewhere else, which is how two
/// boundary tests came to assert on empty strings and stay green with
/// `neutralize_boundary_markers` deleted. Callers must assert the prefix
/// matched something.
pub(crate) fn records_for_target(records: &[CapturedRecord], prefix: &str) -> Vec<CapturedRecord> {
    records
        .iter()
        .filter(|record| record.target.starts_with(prefix))
        .cloned()
        .collect()
}
