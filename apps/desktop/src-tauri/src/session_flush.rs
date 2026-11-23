//! Quit-time session flush protocol.
//!
//! The webview owns session state and persists it via a 1s debounced save
//! (App.tsx). Window close and app exit destroy the webview before that
//! debounce can fire, so `session.json` keeps the last snapshot that had a
//! full second of quiet. This gate coordinates the fix: Rust prevents the
//! close, emits `SESSION_FLUSH_EVENT`, waits for every target window's
//! `session_flush_ack` (bounded by one global deadline, never per-window
//! serial timeouts), then runs the finish action (destroy window / exit
//! app). A timeout still finishes — a hung webview must never trap the user
//! in the app.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// Must match `SESSION_FLUSH_EVENT` in `apps/desktop/src/constants.ts`
/// (drift-guarded by `crossLayerConstants.test.ts`).
pub const SESSION_FLUSH_EVENT: &str = "session-flush";

/// One global deadline for a whole flush round, however many target
/// windows it covers.
pub const SESSION_FLUSH_TIMEOUT: Duration = Duration::from_millis(2000);

/// How a flush round ended. Ordinary quit paths ignore the outcome (a
/// timeout must still finish), but the update-restart command reports it so
/// the coordinator can abort the install on timeout instead of exiting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlushOutcome {
    /// Every target window called `session_flush_ack` before the deadline.
    Acknowledged,
    /// Some target did not ack inside the timeout; the round still finished.
    TimedOut,
}

#[derive(Default)]
pub struct FlushGate {
    round: Arc<(Mutex<Option<Round>>, Condvar)>,
    flushed: Arc<AtomicBool>,
    queued: Mutex<FlushQueue>,
    restart_flushed: Mutex<Option<Instant>>,
}

struct Round {
    deadline: Instant,
    pending: HashSet<String>,
}

/// Runtime work a caller asked for while a flush round was already running.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FlushFollowup {
    None,
    /// An app exit supersedes every individual window close.
    AppExit,
    CloseWindows(Vec<String>),
}

#[derive(Default)]
struct FlushQueue {
    app_exit: bool,
    windows: Vec<String>,
}

/// A restart flush is only valid for the `ExitRequested` it was staged for.
/// If the restart is cancelled (or superseded) the marker must expire instead
/// of poisoning a later ordinary quit with a skipped flush.
pub const RESTART_FLUSHED_TTL: Duration = Duration::from_secs(5);

impl FlushGate {
    /// Starts one flush round over `targets`; returns `false` (and does
    /// nothing) when a round is already in flight. `finish` runs exactly
    /// once — after every target acked or after the single global deadline,
    /// whichever comes first — and receives the `FlushOutcome` so callers
    /// can distinguish acked persistence from a timeout. Empty `targets`
    /// completes immediately with `Acknowledged`.
    pub fn begin(
        &self,
        timeout: Duration,
        targets: &[String],
        finish: impl FnOnce(FlushOutcome) + Send + 'static,
    ) -> bool {
        let round = Round {
            deadline: Instant::now() + timeout,
            pending: targets.iter().cloned().collect(),
        };
        {
            let (lock, _) = &*self.round;
            let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_some() {
                return false;
            }
            *guard = Some(round);
        }
        let state = Arc::clone(&self.round);
        let flushed = Arc::clone(&self.flushed);
        std::thread::spawn(move || {
            let (lock, cond) = &*state;
            let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            let outcome = loop {
                let Some(round) = guard.as_ref() else {
                    break FlushOutcome::Acknowledged; // unreachable defensive arm
                };
                if round.pending.is_empty() {
                    break FlushOutcome::Acknowledged;
                }
                let now = Instant::now();
                if now >= round.deadline {
                    break FlushOutcome::TimedOut;
                }
                let remaining = round.deadline - now;
                let (g, _timeout) = cond
                    .wait_timeout(guard, remaining)
                    .unwrap_or_else(|e| e.into_inner());
                guard = g;
            };
            *guard = None;
            drop(guard);
            flushed.store(true, Ordering::Release);
            finish(outcome);
        });
        true
    }

    /// A target window finished persisting; completes the pending round
    /// early once every target has acked. Acks from labels outside the
    /// round's target set are ignored.
    pub fn ack(&self, window_label: &str) {
        let (lock, cond) = &*self.round;
        let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(round) = guard.as_mut() {
            round.pending.remove(window_label);
            if round.pending.is_empty() {
                cond.notify_all();
            }
        }
    }

    pub fn in_progress(&self) -> bool {
        self.round
            .0
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

    /// Records that a restart staged its own flush. `ExitRequested` then lets
    /// the restart through untouched — re-flushing there would run a second
    /// round whose finish exits the process instead of restarting it.
    pub fn mark_restart_flushed(&self) {
        *self
            .restart_flushed
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    }

    /// Consumes the restart marker once, and only while it is fresh. Consuming
    /// an expired marker still clears it: a cancelled restart must not leave
    /// anything behind for a future quit to trust.
    pub fn consume_restart_flushed(&self) -> bool {
        let mut marker = self
            .restart_flushed
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match marker.take() {
            Some(staged) => staged.elapsed() <= RESTART_FLUSHED_TTL,
            None => false,
        }
    }

    /// Remembers a close that arrived mid-round. Preventing the close without
    /// recording the intent used to drop the request: holding Cmd+W during a
    /// slow flush made the window refuse to close at all.
    pub fn queue_window_close(&self, window_label: &str) {
        let mut queued = self.queued.lock().unwrap_or_else(|e| e.into_inner());
        if !queued.windows.iter().any(|label| label == window_label) {
            queued.windows.push(window_label.to_string());
        }
    }

    /// Remembers an app exit that arrived mid-round (Cmd+Q during a window
    /// close).
    pub fn queue_app_exit(&self) {
        self.queued
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .app_exit = true;
    }

    /// Drains the queued follow-up. An exit supersedes individual closes, and
    /// each label is reported once.
    pub fn take_queued_followup(&self) -> FlushFollowup {
        let mut queued = self.queued.lock().unwrap_or_else(|e| e.into_inner());
        if queued.app_exit {
            queued.app_exit = false;
            queued.windows.clear();
            return FlushFollowup::AppExit;
        }
        if queued.windows.is_empty() {
            return FlushFollowup::None;
        }
        FlushFollowup::CloseWindows(std::mem::take(&mut queued.windows))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// Waits for the finish callback and returns the outcome it reported.
    fn await_finish(done: mpsc::Receiver<FlushOutcome>) -> FlushOutcome {
        done.recv_timeout(Duration::from_secs(2))
            .expect("finish ran with an outcome")
    }

    #[test]
    fn all_targets_ack_before_deadline_is_acknowledged() {
        let gate = FlushGate::default();
        let (done_tx, done_rx) = mpsc::channel();
        let targets = vec!["main".into(), "editor-2".into()];
        assert!(
            gate.begin(Duration::from_secs(5), &targets, move |outcome| {
                let _ = done_tx.send(outcome);
            })
        );
        gate.ack("editor-2");
        assert!(gate.in_progress());
        gate.ack("main");
        assert_eq!(await_finish(done_rx), FlushOutcome::Acknowledged);
        assert!(!gate.in_progress());
    }

    #[test]
    fn partial_acks_time_out_but_finish_still_runs() {
        let gate = FlushGate::default();
        let (done_tx, done_rx) = mpsc::channel();
        let targets = vec!["main".into(), "editor-2".into()];
        assert!(gate.begin(Duration::from_millis(30), &targets, move |o| {
            let _ = done_tx.send(o);
        }));
        gate.ack("main");
        assert_eq!(await_finish(done_rx), FlushOutcome::TimedOut);
        assert!(!gate.in_progress());
    }

    #[test]
    fn ack_from_non_target_window_is_ignored() {
        let gate = FlushGate::default();
        let (done_tx, done_rx) = mpsc::channel();
        let targets = vec!["main".into()];
        assert!(gate.begin(Duration::from_millis(200), &targets, move |o| {
            let _ = done_tx.send(o);
        }));
        gate.ack("editor-9");
        assert!(gate.in_progress());
        gate.ack("main");
        assert_eq!(await_finish(done_rx), FlushOutcome::Acknowledged);
    }

    #[test]
    fn empty_targets_complete_immediately_acknowledged() {
        let gate = FlushGate::default();
        let (done_tx, done_rx) = mpsc::channel();
        assert!(gate.begin(Duration::from_secs(5), &[], move |o| {
            let _ = done_tx.send(o);
        }));
        assert_eq!(await_finish(done_rx), FlushOutcome::Acknowledged);
    }

    #[test]
    fn begin_while_in_progress_is_ignored() {
        let gate = FlushGate::default();
        let (first_tx, first_rx) = mpsc::channel();
        let (second_tx, second_rx) = mpsc::channel();
        let targets = vec!["main".into()];
        assert!(
            gate.begin(Duration::from_millis(200), &targets, move |outcome| {
                let _ = first_tx.send(outcome);
            })
        );
        assert!(
            !gate.begin(Duration::from_secs(5), &targets, move |outcome| {
                let _ = second_tx.send(outcome);
            })
        );
        gate.ack("main");
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
        let targets = vec!["main".into()];
        assert!(
            gate.begin(Duration::from_secs(5), &targets, move |outcome| {
                let _ = done_tx.send(outcome);
            })
        );
        gate.ack("main");
        assert_eq!(await_finish(done_rx), FlushOutcome::Acknowledged);
        assert!(gate.consume_flushed());
        assert!(!gate.consume_flushed());
    }

    #[test]
    fn ack_without_pending_round_is_noop() {
        let gate = FlushGate::default();
        gate.ack("main");
        assert!(!gate.in_progress());
    }

    #[test]
    fn queued_window_closes_are_deduplicated_and_drained_once() {
        let gate = FlushGate::default();
        assert_eq!(gate.take_queued_followup(), FlushFollowup::None);
        gate.queue_window_close("editor-2");
        gate.queue_window_close("editor-2");
        gate.queue_window_close("editor-3");
        assert_eq!(
            gate.take_queued_followup(),
            FlushFollowup::CloseWindows(vec!["editor-2".into(), "editor-3".into()])
        );
        assert_eq!(gate.take_queued_followup(), FlushFollowup::None);
    }

    #[test]
    fn a_queued_app_exit_supersedes_queued_window_closes() {
        let gate = FlushGate::default();
        gate.queue_window_close("editor-2");
        gate.queue_app_exit();
        assert_eq!(gate.take_queued_followup(), FlushFollowup::AppExit);
        // The superseded closes must not resurrect on the next drain.
        assert_eq!(gate.take_queued_followup(), FlushFollowup::None);
    }

    #[test]
    fn restart_marker_is_consumed_once_and_expires() {
        let gate = FlushGate::default();
        assert!(!gate.consume_restart_flushed());
        gate.mark_restart_flushed();
        assert!(gate.consume_restart_flushed());
        assert!(
            !gate.consume_restart_flushed(),
            "a restart marker is one-shot"
        );

        // A cancelled restart leaves a marker behind; once stale it must not
        // let a later ordinary quit skip its flush.
        let gate = FlushGate::default();
        gate.mark_restart_flushed();
        *gate.restart_flushed.lock().unwrap() =
            Some(Instant::now() - RESTART_FLUSHED_TTL - Duration::from_secs(1));
        assert!(!gate.consume_restart_flushed());
        assert!(!gate.consume_restart_flushed(), "expired marker is cleared");
    }

    #[test]
    fn a_finished_round_leaves_the_queue_ready_for_the_next_driver() {
        // Mirrors the real choreography: a close arrives mid-round, the round
        // finishes, and the queued intent survives until the driver drains it.
        let gate = FlushGate::default();
        let (done_tx, done_rx) = mpsc::channel();
        let targets = vec!["main".into()];
        assert!(
            gate.begin(Duration::from_secs(5), &targets, move |outcome| {
                let _ = done_tx.send(outcome);
            })
        );
        gate.queue_window_close("editor-2");
        gate.ack("main");
        assert_eq!(await_finish(done_rx), FlushOutcome::Acknowledged);
        assert!(!gate.in_progress());
        assert_eq!(
            gate.take_queued_followup(),
            FlushFollowup::CloseWindows(vec!["editor-2".into()])
        );
    }

    #[test]
    fn update_round_outcome_is_observable_and_marker_clears_before_next_quit() {
        // Mirrors prepare_update_restart: the update command runs its own
        // round, observes Acknowledged, keeps the app running, and clears the
        // round's one-shot marker so a later ordinary quit still flushes.
        let gate = FlushGate::default();
        let (done_tx, done_rx) = mpsc::channel();
        let targets = vec!["main".into()];
        assert!(
            gate.begin(Duration::from_secs(5), &targets, move |outcome| {
                let _ = done_tx.send(outcome);
            })
        );
        gate.ack("main");
        assert_eq!(await_finish(done_rx), FlushOutcome::Acknowledged);
        assert!(gate.consume_flushed());
        assert!(!gate.consume_flushed());
    }
}
