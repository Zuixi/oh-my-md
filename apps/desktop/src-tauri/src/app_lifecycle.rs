//! App-level lifecycle commands: quit and restart.
//!
//! Both go through the session-flush gate, and both are here rather than in
//! `lib.rs` because that file is growth-frozen: the flush choreography is one
//! responsibility, and keeping it in its own module is what let `lib.rs` stay
//! at its size cap while the logging opt-in added a restart path.
use tauri::{Emitter, Manager};

/// Every live window label, used as the flush target set for app-wide rounds
/// (quit, update restart, exit). Per-window rounds pass the single closing
/// label instead.
pub(crate) fn all_window_labels<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<String> {
    app.webview_windows().keys().cloned().collect()
}

#[tauri::command]
pub(crate) fn quit_app(app: tauri::AppHandle) {
    app.state::<crate::logging::ExitingState>().mark();
    let gate = app.state::<crate::session_flush::FlushGate>();
    if gate.in_progress() {
        // The in-flight round's finish exits the app.
        return;
    }
    let exit_handle = app.clone();
    let targets = all_window_labels(&app);
    if gate.begin(
        crate::session_flush::SESSION_FLUSH_TIMEOUT,
        &targets,
        move |_outcome| exit_handle.exit(0),
    ) {
        // Targeted per window: only the labels registered as round targets
        // are asked to flush.
        for label in &targets {
            let _ = app.emit_to(label, crate::session_flush::SESSION_FLUSH_EVENT, ());
        }
    } else {
        app.exit(0);
    }
}

/// Restart the process so a startup-only setting takes effect (currently the
/// logging opt-in: the log plugin is attached once, during `setup`).
///
/// `request_restart` — not `restart` — because it emits `ExitRequested` and then
/// `Exit`, so this run still writes its `session end clean=true` marker. A bare
/// `restart()` skips both events, which would make the next launch report the
/// previous session as abnormal. The caller flushes first
/// (`prepare_update_restart`), so no pending edits ride on this path.
#[tauri::command]
pub(crate) fn restart_app(app: tauri::AppHandle) {
    app.request_restart();
}
