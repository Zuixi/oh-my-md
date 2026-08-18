//! Native filesystem watching. The watcher is an early-notification hint
//! only; save correctness is always settled by the fingerprint double-compare
//! in `documents` — a dropped event must never cause a silent overwrite.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

// Mirrors the event name in apps/desktop/src/desktopServices.ts listenWorkspaceChange.
pub const WORKSPACE_CHANGED_EVENT: &str = "workspace-changed";

/// Coalescing window: bursts (git checkout, builds) arrive as one event.
const DEBOUNCE_MS: u64 = 300;
/// Upper bound on paths per emitted event; extras are dropped after the wait.
const MAX_EVENT_PATHS: usize = 200;
/// Guard for the watch-set command input.
pub const MAX_WATCHED_PATHS: usize = 64;

struct WatcherState {
    watcher: Option<notify::RecommendedWatcher>,
    watched: Vec<PathBuf>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            watcher: None,
            watched: Vec::new(),
        }
    }
}

pub fn install(app: &AppHandle) {
    app.manage(Mutex::new(WatcherState::default()));
}

/// Pure watch-set diff so the transition stays unit-testable.
pub fn diff_watches(current: &[PathBuf], next: &[PathBuf]) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let to_unwatch = current
        .iter()
        .filter(|path| !next.contains(path))
        .cloned()
        .collect();
    let to_watch = next
        .iter()
        .filter(|path| !current.contains(path))
        .cloned()
        .collect();
    (to_unwatch, to_watch)
}

fn spawn_event_loop(app: AppHandle, receiver: Receiver<PathBuf>) {
    std::thread::spawn(move || loop {
        let first = match receiver.recv() {
            Ok(path) => path,
            Err(_) => return,
        };
        let mut batch = vec![first];
        let deadline = Instant::now() + Duration::from_millis(DEBOUNCE_MS);
        while let Ok(path) =
            receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            if batch.len() < MAX_EVENT_PATHS {
                batch.push(path);
            }
        }
        let mut seen = HashSet::new();
        let paths: Vec<String> = batch
            .into_iter()
            .filter_map(|path| {
                let text = path.to_string_lossy().into_owned();
                if seen.insert(text.clone()) {
                    Some(text)
                } else {
                    None
                }
            })
            .collect();
        if !paths.is_empty() {
            let _ = app.emit(WORKSPACE_CHANGED_EVENT, paths);
        }
    });
}

/// Replace the watched path set. Paths must already be canonical. Creating the
/// OS watcher and the debounce thread happens lazily on first use.
pub fn set_watched_paths(app: &AppHandle, paths: &[PathBuf]) -> Result<(), String> {
    let state_guard = app.state::<Mutex<WatcherState>>();
    let mut state = state_guard.lock().map_err(|e| e.to_string())?;

    if state.watcher.is_none() {
        let (sender, receiver) = channel();
        let watcher =
            notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
                if let Ok(event) = result {
                    for path in event.paths {
                        let _ = sender.send(path);
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        spawn_event_loop(app.clone(), receiver);
        state.watcher = Some(watcher);
        state.watched = Vec::new();
    }

    let (to_unwatch, to_watch) = diff_watches(&state.watched, paths);
    let watcher = state
        .watcher
        .as_mut()
        .expect("watcher was just created or already present");
    for path in &to_unwatch {
        let _ = watcher.unwatch(path);
    }
    for path in &to_watch {
        watcher
            .watch(path, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
    }
    state.watched = paths.to_vec();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(text: &str) -> PathBuf {
        PathBuf::from(text)
    }

    #[test]
    fn diff_watches_adds_removes_and_keeps_paths() {
        let (unwatch, watch) = diff_watches(&[p("/a"), p("/b")], &[p("/b"), p("/c")]);
        assert_eq!(unwatch, vec![p("/a")]);
        assert_eq!(watch, vec![p("/c")]);
    }

    #[test]
    fn diff_watches_is_noop_for_reordered_sets() {
        let (unwatch, watch) = diff_watches(&[p("/a"), p("/b")], &[p("/b"), p("/a")]);
        assert!(unwatch.is_empty());
        assert!(watch.is_empty());
    }

    #[test]
    fn max_watched_paths_is_bounded() {
        assert_eq!(MAX_WATCHED_PATHS, 64);
    }
}
