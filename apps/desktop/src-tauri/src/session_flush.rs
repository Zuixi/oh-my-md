//! Quit-time session flush protocol.
//!
//! The webview owns session state and persists it via a 1s debounced save
//! (App.tsx). Window close and app exit destroy the webview before that
//! debounce can fire, so `session.json` keeps the last snapshot that had a
//! full second of quiet. This gate coordinates the fix: Rust prevents the
//! close, emits `SESSION_FLUSH_EVENT`, waits for `session_flush_ack`
//! (bounded), then runs the finish action (destroy window / exit app). A
//! timeout still finishes — a hung webview must never trap the user in the
//! app.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Must match `SESSION_FLUSH_EVENT` in `apps/desktop/src/constants.ts`
/// (drift-guarded by `crossLayerConstants.test.ts`).
pub const SESSION_FLUSH_EVENT: &str = "session-flush";

pub const SESSION_FLUSH_TIMEOUT: Duration = Duration::from_millis(2000);

/// How a flush round ended. Ordinary quit paths ignore the outcome (a
/// timeout must still finish), but the update-restart command reports it so
/// the coordinator can abort the install on timeout instead of exiting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlushOutcome {
    /// The webview called `session_flush_ack` before the deadline.
    Acknowledged,
    /// No ack arrived inside the timeout; the round still finished.
    TimedOut,
}

#[derive(Clone, Default)]
pub struct FlushGate {
    pending: Arc<Mutex<Option<mpsc::Sender<()>>>>,
    flushed: Arc<AtomicBool>,
}

impl FlushGate {
    /// Starts one flush round; returns `false` (and does nothing) when a
    /// round is already in flight. `finish` runs exactly once — after ack
    /// or timeout, whichever comes first — and receives the `FlushOutcome`
    /// so callers can distinguish acked persistence from a timeout.
    pub fn begin(
        &self,
        timeout: Duration,
        finish: impl FnOnce(FlushOutcome) + Send + 'static,
    ) -> bool {
        let (tx, rx) = mpsc::channel();
        let mut guard = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return false;
        }
        *guard = Some(tx);
        drop(guard);

        let pending = Arc::clone(&self.pending);
        let flushed = Arc::clone(&self.flushed);
        std::thread::spawn(move || {
            let outcome = match rx.recv_timeout(timeout) {
                Ok(()) => FlushOutcome::Acknowledged,
                Err(_) => FlushOutcome::TimedOut,
            };
            *pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
            flushed.store(true, Ordering::Release);
            finish(outcome);
        });
        true
    }

    /// The webview finished persisting; completes the pending round early.
    pub fn ack(&self) {
        if let Some(tx) = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = tx.send(());
        }
    }

    pub fn in_progress(&self) -> bool {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// One-shot pass-through flag: consumed by the ExitRequested handler
    /// right after a window-path flush tore the last window down, so the
    /// follow-up exit request is allowed through without re-flushing.
    pub fn consume_flushed(&self) -> bool {
        self.flushed.swap(false, Ordering::AcqRel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Waits for the finish callback and returns the outcome it reported.
    fn await_finish(done: mpsc::Receiver<FlushOutcome>) -> FlushOutcome {
        done.recv_timeout(Duration::from_secs(2))
            .expect("finish ran with an outcome")
    }

    #[test]
    fn ack_outcome_is_acknowledged_and_finish_runs() {
        let gate = FlushGate::default();
        let (done_tx, done_rx) = mpsc::channel();
        assert!(gate.begin(Duration::from_secs(5), move |outcome| {
            let _ = done_tx.send(outcome);
        }));
        gate.ack();
        assert_eq!(await_finish(done_rx), FlushOutcome::Acknowledged);
        assert!(!gate.in_progress());
    }

    #[test]
    fn timeout_outcome_is_timed_out_and_finish_still_runs() {
        let gate = FlushGate::default();
        let (done_tx, done_rx) = mpsc::channel();
        assert!(gate.begin(Duration::from_millis(20), move |outcome| {
            let _ = done_tx.send(outcome);
        }));
        assert_eq!(await_finish(done_rx), FlushOutcome::TimedOut);
        assert!(!gate.in_progress());
    }

    #[test]
    fn begin_while_in_progress_is_ignored() {
        let gate = FlushGate::default();
        let (first_tx, first_rx) = mpsc::channel();
        let (second_tx, second_rx) = mpsc::channel();
        assert!(gate.begin(Duration::from_millis(200), move |outcome| {
            let _ = first_tx.send(outcome);
        }));
        assert!(!gate.begin(Duration::from_secs(5), move |outcome| {
            let _ = second_tx.send(outcome);
        }));
        gate.ack();
        assert_eq!(await_finish(first_rx), FlushOutcome::Acknowledged);
        assert!(
            second_rx.recv_timeout(Duration::from_millis(300)).is_err(),
            "the ignored begin's finish must not run"
        );
    }

    #[test]
    fn flushed_flag_is_consumed_once() {
        let gate = FlushGate::default();
        let (done_tx, done_rx) = mpsc::channel();
        assert!(gate.begin(Duration::from_secs(5), move |outcome| {
            let _ = done_tx.send(outcome);
        }));
        gate.ack();
        assert_eq!(await_finish(done_rx), FlushOutcome::Acknowledged);
        assert!(gate.consume_flushed());
        assert!(!gate.consume_flushed());
    }

    #[test]
    fn ack_without_pending_round_is_noop() {
        let gate = FlushGate::default();
        gate.ack();
        assert!(!gate.in_progress());
    }

    #[test]
    fn update_round_outcome_is_observable_and_marker_clears_before_next_quit() {
        // Mirrors prepare_update_restart: the update command runs its own
        // round, observes Acknowledged, keeps the app running, and clears the
        // round's one-shot marker so a later ordinary quit still flushes.
        let gate = FlushGate::default();
        let (done_tx, done_rx) = mpsc::channel();
        assert!(gate.begin(Duration::from_secs(5), move |outcome| {
            let _ = done_tx.send(outcome);
        }));
        gate.ack();
        assert_eq!(await_finish(done_rx), FlushOutcome::Acknowledged);
        assert!(gate.consume_flushed());
        assert!(!gate.consume_flushed());
    }
}
