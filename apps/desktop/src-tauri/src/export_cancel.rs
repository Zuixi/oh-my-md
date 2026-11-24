//! Cooperative cancellation for native exports.
//!
//! The frontend allocates one request id per export and posts it with
//! `export_preview`. `cancel_export` flips the matching flag; platform renderers
//! poll it and close their offscreen surface promptly. Entries are owned by the
//! export command and removed when it returns, so a completed export leaves no
//! state behind.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub(crate) const EXPORT_CANCELLED: &str = "export cancelled";

/// Frontend request ids are UUIDs; anything longer is not a legitimate export.
const MAX_REQUEST_ID_CHARS: usize = 128;
/// Cancelled ids that raced ahead of `export_preview` are swept after 60 s; cap
/// the map so a flood of distinct ids cannot grow it without bound.
const MAX_PENDING_TOKENS: usize = 256;

pub(crate) fn valid_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= MAX_REQUEST_ID_CHARS
        && request_id.chars().all(|ch| ch.is_ascii_graphic())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CancelOutcome {
    /// Flipped an already-registered export token (no new cleanup timer needed).
    MarkedExisting,
    /// Pre-registered a cancelled token ahead of `export_preview` (caller should sweep if never claimed).
    PreRegistered,
    /// Invalid request id or pending-token table full (caller must not spawn a cleanup task).
    Rejected,
}

struct CancelEntry {
    flag: Arc<AtomicBool>,
    /// True once `export_preview` has claimed this entry via `token()`.
    /// Pre-cancel timers only sweep unclaimed entries so a slow export (>60s)
    /// never loses its live cancel token mid-print.
    claimed: bool,
}

#[derive(Default)]
pub struct ExportCancelState {
    tokens: Mutex<HashMap<String, CancelEntry>>,
}

impl ExportCancelState {
    /// Returns the token for an export, creating and claiming it if this is the
    /// first call. A cancel that arrived before registration stays visible.
    pub(crate) fn token(&self, request_id: &str) -> Option<Arc<AtomicBool>> {
        let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = tokens.get_mut(request_id) {
            entry.claimed = true;
            return Some(entry.flag.clone());
        }
        if tokens.len() >= MAX_PENDING_TOKENS {
            return None;
        }
        let flag = Arc::new(AtomicBool::new(false));
        tokens.insert(
            request_id.to_owned(),
            CancelEntry {
                flag: flag.clone(),
                claimed: true,
            },
        );
        Some(flag)
    }

    /// Marks `request_id` cancelled, distinguishing existing tokens, newly
    /// pre-registered tokens, and rejected inputs.
    pub(crate) fn cancel(&self, request_id: &str) -> CancelOutcome {
        if !valid_request_id(request_id) {
            return CancelOutcome::Rejected;
        }
        let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = tokens.get(request_id) {
            entry.flag.store(true, Ordering::SeqCst);
            return CancelOutcome::MarkedExisting;
        }
        if tokens.len() >= MAX_PENDING_TOKENS {
            return CancelOutcome::Rejected;
        }
        tokens.insert(
            request_id.to_owned(),
            CancelEntry {
                flag: Arc::new(AtomicBool::new(true)),
                claimed: false,
            },
        );
        CancelOutcome::PreRegistered
    }

    pub(crate) fn remove(&self, request_id: &str) {
        self.tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(request_id);
    }

    /// Drops a pre-registered cancel token only if `export_preview` never claimed it.
    pub(crate) fn remove_unclaimed(&self, request_id: &str) {
        let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        if tokens.get(request_id).is_some_and(|entry| !entry.claimed) {
            tokens.remove(request_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_before_registration_is_observable() {
        let state = ExportCancelState::default();
        assert_eq!(state.cancel("later"), CancelOutcome::PreRegistered);
        assert!(state.token("later").unwrap().load(Ordering::SeqCst));
        // Once claimed by `token()`, `remove_unclaimed` must not drop it.
        state.remove_unclaimed("later");
        assert_eq!(state.cancel("later"), CancelOutcome::MarkedExisting);
        state.remove("later");
        assert!(!state.token("later").unwrap().load(Ordering::SeqCst));
    }

    #[test]
    fn cancel_marks_an_existing_token() {
        let state = ExportCancelState::default();
        let token = state.token("now").unwrap();
        assert_eq!(state.cancel("now"), CancelOutcome::MarkedExisting);
        assert!(token.load(Ordering::SeqCst));
    }

    #[test]
    fn cancel_rejects_invalid_ids_and_sweeps_only_unclaimed_entries() {
        let state = ExportCancelState::default();
        assert_eq!(state.cancel(""), CancelOutcome::Rejected);
        assert_eq!(state.cancel("has space"), CancelOutcome::Rejected);
        assert_eq!(
            state.cancel(&"x".repeat(MAX_REQUEST_ID_CHARS + 1)),
            CancelOutcome::Rejected
        );

        assert_eq!(state.cancel("orphan"), CancelOutcome::PreRegistered);
        state.remove_unclaimed("orphan");
        assert!(!state.token("orphan").unwrap().load(Ordering::SeqCst));
    }
}
