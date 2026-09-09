//! Native filesystem watching. The watcher is an early-notification hint
//! only; save correctness is always settled by the fingerprint double-compare
//! in `documents` — a dropped event must never cause a silent overwrite.

use std::collections::{HashMap, HashSet};
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
    sets: PureWatchSets,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            watcher: None,
            watched: Vec::new(),
            sets: PureWatchSets::default(),
        }
    }
}

/// Pure per-window watch-set bookkeeping. The OS watcher never sees windows;
/// it tracks the union of these sets, so a second window opening a folder
/// extends watching instead of replacing the first window's watches.
#[derive(Default)]
pub struct PureWatchSets {
    per_window: HashMap<String, Vec<PathBuf>>,
}

impl PureWatchSets {
    /// Replace one window's set. Oversize input is clamped to
    /// `MAX_WATCHED_PATHS` defensively; the command boundary rejects it
    /// before this runs, and the cap is per window because every invoke
    /// carries exactly one window's paths.
    pub fn set(&mut self, window: &str, paths: Vec<PathBuf>) {
        let mut paths = paths;
        paths.truncate(MAX_WATCHED_PATHS);
        self.per_window.insert(window.to_string(), paths);
    }

    /// Remove a destroyed window's set entirely.
    pub fn drop_window(&mut self, window: &str) {
        self.per_window.remove(window);
    }

    /// Sorted, deduplicated union of every window's set: exactly what the OS
    /// watcher must be watching right now.
    pub fn union(&self) -> Vec<PathBuf> {
        let mut all: Vec<PathBuf> = self.per_window.values().flatten().cloned().collect();
        all.sort();
        all.dedup();
        all
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

/// Replace one window's watched path set; the OS watcher is reconciled to the
/// union of all windows' sets. Paths must already be canonical. Creating the
/// OS watcher and the debounce thread happens lazily on first use.
pub fn set_watched_paths(
    app: &AppHandle,
    window_label: &str,
    paths: &[PathBuf],
) -> Result<(), String> {
    let state_guard = app.state::<Mutex<WatcherState>>();
    let mut state = state_guard.lock().map_err(|e| e.to_string())?;
    state.sets.set(window_label, paths.to_vec());
    apply_union(app, &mut state)
}

/// Remove a destroyed window's set and reconcile: a watch is released only
/// when no surviving window still needs it. Best-effort like every watcher
/// path — a failed reconcile is logged, never fatal to window teardown.
pub fn drop_window_watches(app: &AppHandle, label: &str) {
    let state_guard = app.state::<Mutex<WatcherState>>();
    let mut state = match state_guard.lock() {
        Ok(state) => state,
        Err(_) => return,
    };
    state.sets.drop_window(label);
    if state.watcher.is_none() {
        // The watcher is created lazily on first use, so no OS watches exist
        // to reconcile; syncing the bookkeeping is enough on a destroy path.
        state.watched = state.sets.union();
        return;
    }
    if let Err(e) = apply_union(app, &mut state) {
        log::warn!("failed to reconcile watches after dropping window {label}: {e}");
    }
}

/// Reconcile the OS watcher to the union of all window sets via the pure
/// diff, then record that union as watched.
fn apply_union(app: &AppHandle, state: &mut WatcherState) -> Result<(), String> {
    let union = state.sets.union();

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

    let (to_unwatch, to_watch) = diff_watches(&state.watched, &union);
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
    state.watched = union;
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

    #[test]
    fn union_of_two_windows_keeps_both_sets() {
        let mut state = PureWatchSets::default();
        state.set("main", vec![p("/a")]);
        state.set("editor-2", vec![p("/b")]);
        assert_eq!(state.union(), vec![p("/a"), p("/b")]);
        state.set("main", vec![p("/a"), p("/c")]);
        assert_eq!(state.union(), vec![p("/a"), p("/b"), p("/c")]);
        state.drop_window("editor-2");
        assert_eq!(state.union(), vec![p("/a"), p("/c")]);
    }

    #[test]
    fn shared_path_survives_one_window_dropping_it() {
        let mut state = PureWatchSets::default();
        state.set("main", vec![p("/shared")]);
        state.set("editor-2", vec![p("/shared")]);
        state.drop_window("editor-2");
        assert_eq!(state.union(), vec![p("/shared")]);
    }

    #[test]
    fn set_clamps_each_window_to_the_cap_independently() {
        let mut state = PureWatchSets::default();
        let oversized: Vec<PathBuf> = (0..=MAX_WATCHED_PATHS)
            .map(|i| p(&format!("/w/{i}")))
            .collect();
        state.set("main", oversized);
        state.set("editor-2", vec![p("/b")]);
        // The cap bounds each window's own set; the union is uncapped because
        // the guard is per command input and every invoke is a single window.
        assert_eq!(state.per_window["main"].len(), MAX_WATCHED_PATHS);
        assert_eq!(state.union().len(), MAX_WATCHED_PATHS + 1);
    }
}
