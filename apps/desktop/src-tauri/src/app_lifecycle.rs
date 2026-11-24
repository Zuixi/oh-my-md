//! App-level lifecycle choreography: window close, app quit, and restart.
//!
//! Every one of these paths goes through the session-flush gate, and they live
//! here rather than in `lib.rs` because that file is growth-frozen: the flush
//! order is one responsibility, and keeping it in its own module is what let
//! `lib.rs` stay at its size cap while the logging opt-in added a restart path.

use tauri::{Emitter, Manager};

use crate::session_flush::{FlushFollowup, FlushGate, SESSION_FLUSH_EVENT, SESSION_FLUSH_TIMEOUT};

/// Every live **editor** window label. Export render hosts (`omd-export-*`)
/// are excluded: they belong to one export in flight, have no IPC capability,
/// so emitting `session-flush` at them would stall the round for the full
/// timeout and can never be acked.
pub(crate) fn all_window_labels<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<String> {
    app.webview_windows()
        .keys()
        .filter(|label| crate::windows::is_editor_window_label(label))
        .cloned()
        .collect()
}

/// Whether any editor window is still open. Export hosts must not keep the app
/// alive: an offscreen render window is not a user-visible document.
pub(crate) fn has_editor_windows<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    !all_window_labels(app).is_empty()
}

/// Flushes `label`, drops its session shard, and destroys it.
///
/// Called by `CloseRequested` and by the follow-up drain. A close that arrives
/// while another round is running is *recorded*, never dropped: the caller has
/// already prevented the close, so forgetting it would leave the window open.
pub(crate) fn drive_window_close<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    // Nothing left to flush or destroy (the window closed while it waited in
    // the queue): a round for a dead label could only wait out the timeout.
    if app.get_webview_window(label).is_none() {
        return;
    }
    let gate = app.state::<FlushGate>();
    let targets = vec![label.to_string()];
    let finishing_app = app.clone();
    let finishing_label = label.to_string();
    let started = gate.begin(SESSION_FLUSH_TIMEOUT, &targets, move |_outcome| {
        finish_window_close(&finishing_app, &finishing_label);
        drain_flush_followup(&finishing_app);
    });
    if !started {
        gate.queue_window_close(label);
        return;
    }
    // Begin before emit: an ack racing an unregistered round would no-op and
    // stall the close until the timeout.
    let _ = app.emit_to(label, SESSION_FLUSH_EVENT, ());
}

/// Shard removal is a read-modify-write over the shared `session.json`, so it
/// must hold the same lock as shard saves: a surviving window's debounced save
/// straddling this write would resurrect the closed shard. A failed removal
/// must not trap the window open, so it is logged and the window is destroyed.
fn finish_window_close<R: tauri::Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    {
        let lock = app.state::<crate::workspace::SessionFileLock>();
        let _guard = lock.lock();
        if let Err(error) = crate::workspace::remove_session_shard(label) {
            log::warn!("failed to remove session shard for {label}: {error}");
        }
    }
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.destroy();
    }
}

/// Flushes every editor window, then exits. Queued instead of forced when a
/// round is already running so a quit during a slow close is not swallowed.
pub(crate) fn drive_app_exit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let gate = app.state::<FlushGate>();
    let targets = all_window_labels(app);
    if targets.is_empty() {
        app.exit(0);
        return;
    }
    let exit_handle = app.clone();
    let started = gate.begin(SESSION_FLUSH_TIMEOUT, &targets, move |_outcome| {
        exit_handle.exit(0);
    });
    if !started {
        gate.queue_app_exit();
        return;
    }
    for label in &targets {
        let _ = app.emit_to(label, SESSION_FLUSH_EVENT, ());
    }
}

/// Runs whatever was queued while the last round was in flight. Deterministic
/// because every finish callback calls it: the queue is never left waiting for
/// an event that may never arrive.
pub(crate) fn drain_flush_followup<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let gate = app.state::<FlushGate>();
    if gate.in_progress() {
        return;
    }
    match gate.take_queued_followup() {
        FlushFollowup::None => {}
        FlushFollowup::AppExit => drive_app_exit(app),
        // The first close starts the next round; any close that still finds a
        // round running re-queues itself, so the driver drains to completion.
        FlushFollowup::CloseWindows(labels) => {
            for label in labels {
                drive_window_close(app, &label);
            }
        }
    }
}

/// The in-app menubar quit (non-macOS). Marked as a user exit first so a
/// force-kill during the round is still reported as an intentional quit.
#[tauri::command]
pub(crate) fn quit_app(app: tauri::AppHandle) {
    app.state::<crate::logging::ExitingState>().mark();
    drive_app_exit(&app);
}

/// Restart the process so a startup-only setting takes effect (currently the
/// logging opt-in: the log plugin is attached once, during `setup`).
///
/// `request_restart` — not `restart` — because it emits `ExitRequested` and then
/// `Exit`, so this run still writes its `session end clean=true` marker. A bare
/// `restart()` skips both events, which would make the next launch report the
/// previous session as abnormal. The caller flushes first
/// (`prepare_update_restart`), so this stages the restart marker that lets the
/// `ExitRequested` those windows emit pass through without a second round.
#[tauri::command]
pub(crate) fn restart_app(app: tauri::AppHandle) {
    app.state::<FlushGate>().mark_restart_flushed();
    app.request_restart();
}
