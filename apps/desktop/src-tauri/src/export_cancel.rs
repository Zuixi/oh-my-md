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

#[derive(Default)]
pub struct ExportCancelState {
    tokens: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl ExportCancelState {
    /// Returns the token for an export, creating it if this is the first call.
    /// A cancel that arrives before registration must still be visible.
    pub(crate) fn token(&self, request_id: &str) -> Arc<AtomicBool> {
        self.tokens
            .lock()
            .expect("export cancel state poisoned")
            .entry(request_id.to_owned())
            .or_default()
            .clone()
    }

    /// Returns false when the id was not registered yet, allowing the command
    /// to schedule cleanup for a cancel that raced ahead of `export_preview`.
    pub(crate) fn cancel(&self, request_id: &str) -> bool {
        let mut tokens = self.tokens.lock().expect("export cancel state poisoned");
        let existed = tokens.contains_key(request_id);
        tokens
            .entry(request_id.to_owned())
            .or_default()
            .store(true, Ordering::SeqCst);
        existed
    }

    pub(crate) fn remove(&self, request_id: &str) {
        self.tokens
            .lock()
            .expect("export cancel state poisoned")
            .remove(request_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_before_registration_is_observable() {
        let state = ExportCancelState::default();
        assert!(!state.cancel("later"));
        assert!(state.token("later").load(Ordering::SeqCst));
        state.remove("later");
        assert!(!state.token("later").load(Ordering::SeqCst));
    }

    #[test]
    fn cancel_marks_an_existing_token() {
        let state = ExportCancelState::default();
        let token = state.token("now");
        assert!(state.cancel("now"));
        assert!(token.load(Ordering::SeqCst));
    }
}
