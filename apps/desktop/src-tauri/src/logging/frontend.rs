//! Bounded frontend IPC sink. File logging runs on a blocking worker, never
//! on Tauri's main thread. Ordinary messages and fatal errors have separate
//! budgets so a warning storm cannot starve the first fatal report.
use super::{
    fields::escape_record_text, LOG_ERROR_BUDGET_PER_SEC, LOG_FRONTEND_COMMAND,
    LOG_MAX_BATCH_RECORDS, LOG_MAX_MESSAGE_CHARS, LOG_MAX_TARGET_CHARS,
};
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc, Mutex,
};
use std::time::Instant;

#[derive(serde::Deserialize, serde::Serialize)]
pub struct FrontendRecord {
    pub level: String,
    pub target: String,
    pub message: String,
}

pub(super) fn parse_level(raw: &str) -> log::Level {
    match raw.to_ascii_lowercase().as_str() {
        "error" => log::Level::Error,
        "warn" => log::Level::Warn,
        "debug" => log::Level::Debug,
        "trace" => log::Level::Trace,
        _ => log::Level::Info,
    }
}

#[derive(Clone)]
pub struct FrontendBudget {
    ordinary: Arc<RecordBudget>,
    errors: Arc<RecordBudget>,
}

impl FrontendBudget {
    pub fn new(limit: u32) -> Self {
        Self {
            ordinary: Arc::new(RecordBudget::new(limit)),
            errors: Arc::new(RecordBudget::new(LOG_ERROR_BUDGET_PER_SEC)),
        }
    }

    pub(super) fn allow(&self) -> bool {
        self.ordinary.allow()
    }

    #[cfg(test)]
    pub(super) fn collapsed(&self) -> u32 {
        self.ordinary.collapsed.load(Ordering::Relaxed)
            + self.errors.collapsed.load(Ordering::Relaxed)
    }
}

struct RecordBudget {
    window: Mutex<BudgetWindow>,
    collapsed: AtomicU32,
    limit: u32,
}

struct BudgetWindow {
    start: Instant,
    used: u32,
    collapsed: u32,
    notice_sent: bool,
}

impl RecordBudget {
    fn new(limit: u32) -> Self {
        Self {
            window: Mutex::new(BudgetWindow::new()),
            collapsed: AtomicU32::new(0),
            limit,
        }
    }

    fn allow(&self) -> bool {
        let mut window = self.window.lock().unwrap_or_else(|e| e.into_inner());
        if window.start.elapsed().as_secs() >= 1 {
            *window = BudgetWindow::new();
        }
        window.used = window.used.saturating_add(1);
        if window.used <= self.limit {
            return true;
        }
        window.collapsed = window.collapsed.saturating_add(1);
        self.collapsed.fetch_add(1, Ordering::Relaxed);
        false
    }

    fn take_notice(&self) -> Option<u32> {
        let mut window = self.window.lock().unwrap_or_else(|e| e.into_inner());
        if window.collapsed == 0 || window.notice_sent {
            return None;
        }
        window.notice_sent = true;
        Some(window.collapsed)
    }
}

impl BudgetWindow {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            used: 0,
            collapsed: 0,
            notice_sent: false,
        }
    }
}

pub(super) fn log_records(
    records: impl IntoIterator<Item = FrontendRecord>,
    budget: &FrontendBudget,
) {
    for record in records.into_iter().take(LOG_MAX_BATCH_RECORDS) {
        let level = parse_level(&record.level);
        if !log::log_enabled!(level) {
            continue;
        }
        let allowed = if level == log::Level::Error {
            budget.errors.allow()
        } else {
            budget.allow()
        };
        if !allowed {
            continue;
        }
        let target = escape_record_text(truncate_utf16(&record.target, LOG_MAX_TARGET_CHARS));
        let message = escape_record_text(&bounded_message(&record.message));
        log::log!(target: target.as_str(), level, "{}", message);
    }
    let ordinary = budget.ordinary.take_notice().unwrap_or(0);
    let errors = budget.errors.take_notice().unwrap_or(0);
    if ordinary + errors > 0 {
        log::warn!(target: LOG_FRONTEND_COMMAND, "{} log records collapsed", ordinary + errors);
    }
}

fn bounded_message(raw: &str) -> String {
    const SUFFIX: &str = "… [truncated]";
    let text = truncate_utf16(raw, LOG_MAX_MESSAGE_CHARS);
    if text.len() == raw.len() {
        return text.to_string();
    }
    format!(
        "{}{SUFFIX}",
        truncate_utf16(raw, LOG_MAX_MESSAGE_CHARS - SUFFIX.encode_utf16().count())
    )
}

// Match JS string limits without slicing through a UTF-8 character.
fn truncate_utf16(raw: &str, limit: usize) -> &str {
    if raw.len() <= limit {
        return raw;
    }
    let mut units = 0;
    for (index, ch) in raw.char_indices() {
        units += ch.len_utf16();
        if units > limit {
            return &raw[..index];
        }
    }
    raw
}

#[tauri::command]
pub async fn log_frontend(
    records: Vec<FrontendRecord>,
    budget: tauri::State<'_, FrontendBudget>,
) -> Result<(), String> {
    if records.len() > LOG_MAX_BATCH_RECORDS {
        return Err("frontend log batch exceeds the record limit".to_string());
    }
    let budget = budget.inner().clone();
    tauri::async_runtime::spawn_blocking(move || log_records(records, &budget))
        .await
        .map_err(|error| format!("log delivery task failed: {error}"))
}
