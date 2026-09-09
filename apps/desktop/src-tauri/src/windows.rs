//! Multi-window host state: window registry, focus order (MRU), the
//! per-window mirror used by open-file routing, and the per-window
//! pending-open-files queue. Pure core — no Tauri types in the registry
//! itself so behavior is unit-testable on any host.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::{Emitter, Manager};

/// Persisted window geometry captured at session-save time for restore.
/// Fields are single words today, but the camelCase attribute plus the
/// serialization test pin the wire shape for any future multi-word field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Per-window mirror of what the frontend last flushed. Routing decisions
/// tolerate staleness: the frontend owns tab truth, so a stale mirror at
/// worst opens a duplicate tab (the frontend still dedupes in-window via
/// findTabByPath).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowMeta {
    pub open_paths: Vec<String>,
    pub folder: Option<String>,
}

/// Labels are `main` (config-declared) and `editor-N` from a counter seeded
/// from the highest restored label, so labels are deterministic across
/// restarts while the counter never collides with live labels.
#[derive(Default)]
pub struct WindowRegistry {
    labels: Vec<String>,
    mru: Vec<String>,
    metas: HashMap<String, WindowMeta>,
    counter: u64,
}

impl WindowRegistry {
    pub fn register(&mut self, label: &str) {
        if self.labels.iter().any(|l| l == label) {
            return;
        }
        if let Some(n) = label
            .strip_prefix("editor-")
            .and_then(|n| n.parse::<u64>().ok())
        {
            self.counter = self.counter.max(n);
        }
        self.labels.push(label.to_string());
        self.mru.insert(0, label.to_string());
    }

    pub fn unregister(&mut self, label: &str) {
        self.labels.retain(|l| l != label);
        self.mru.retain(|l| l != label);
        self.metas.remove(label);
    }

    pub fn note_focused(&mut self, label: &str) {
        if !self.labels.iter().any(|l| l == label) {
            return;
        }
        self.mru.retain(|l| l != label);
        self.mru.insert(0, label.to_string());
    }

    pub fn focused(&self) -> Option<&str> {
        self.mru.first().map(|s| s.as_str())
    }

    pub fn next_label(&self) -> String {
        format!("editor-{}", self.counter + 1)
    }

    pub fn set_meta(&mut self, label: &str, meta: WindowMeta) {
        if self.labels.iter().any(|l| l == label) {
            self.metas.insert(label.to_string(), meta);
        }
    }

    pub fn meta(&self, label: &str) -> Option<&WindowMeta> {
        self.metas.get(label)
    }

    pub fn labels(&self) -> &[String] {
        &self.labels
    }

    /// MRU order, most recently focused first. Read access for open-file
    /// routing: `pick_window` iterates this order so score ties resolve to
    /// the most recently used window.
    pub fn mru_order(&self) -> &[String] {
        &self.mru
    }

    pub fn window_with_path(&self, path: &str) -> Option<&str> {
        self.labels
            .iter()
            .find(|label| {
                self.metas
                    .get(*label)
                    .is_some_and(|m| m.open_paths.iter().any(|p| p == path))
            })
            .map(|s| s.as_str())
    }
}

/// Mirrors the event name in apps/desktop/src/desktopServices.ts listenOpenFile.
pub(crate) const OPEN_FILE_EVENT: &str = "open-file";

fn normalized(path: &str) -> String {
    path.replace('\\', "/")
}

/// Parent directory of a path after `\` → `/` normalization. Owned because
/// the normalization allocates; callers compare via `as_deref`.
fn parent_dir(path: &str) -> Option<String> {
    let n = normalized(path);
    n.rfind('/').map(|i| n[..i].to_string())
}

/// MarkText-style scoring, simplified: exact mirror match, else folder
/// containment (+5) and open-file sibling dirs (+1); ties fall to MRU
/// because iteration follows MRU order and only strictly-greater scores
/// displace the incumbent.
pub fn pick_window<'a>(registry: &'a WindowRegistry, path: &str) -> Option<&'a str> {
    if let Some(existing) = registry.window_with_path(path) {
        return Some(existing);
    }
    let target = normalized(path);
    let target_dir = parent_dir(path);
    let mut best: Option<(&str, i32)> = None;
    for label in registry.mru_order() {
        let Some(meta) = registry.meta(label) else {
            continue;
        };
        let mut score = 0;
        if let Some(folder) = meta.folder.as_deref() {
            let folder = normalized(folder);
            let folder = folder.trim_end_matches('/');
            // Separator boundary: "/docs" must not claim "/docs-extra/x.md".
            if target.starts_with(&format!("{folder}/")) {
                score += 5;
            }
        }
        if let Some(dir) = target_dir.as_deref() {
            score += meta
                .open_paths
                .iter()
                .filter(|p| parent_dir(p).as_deref() == Some(dir))
                .count() as i32;
        }
        if best.map_or(true, |(_, s)| score > s) {
            best = Some((label.as_str(), score));
        }
    }
    best.map(|(label, _)| label)
}

/// Open-file handoff queue, keyed by window label. `HashMap::new` is not a
/// const fn (RandomState seeds at runtime), hence the LazyLock.
const MAX_PENDING_OPEN_FILES: usize = 16;
static PENDING_OPEN_FILES: LazyLock<Mutex<HashMap<String, Vec<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Queues `path` for `label`'s webview. Launch-time and second-instance
/// opens can fire before the webview registered its listener, so paths wait
/// here until drained. Bounded per window and de-duplicated per window, so
/// a burst of repeats cannot evict distinct files.
pub(crate) fn queue_open_file(label: &str, path: &str) {
    let mut pending = PENDING_OPEN_FILES.lock().unwrap_or_else(|e| e.into_inner());
    let queue = pending.entry(label.to_string()).or_default();
    if !queue.iter().any(|p| p == path) && queue.len() < MAX_PENDING_OPEN_FILES {
        queue.push(path.to_string());
    }
}

/// Takes (drains) `label`'s queued open files in FIFO order. A second drain
/// sees nothing; other windows' queues are untouched.
pub(crate) fn take_pending(label: &str) -> Vec<String> {
    PENDING_OPEN_FILES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(label)
        .unwrap_or_default()
}

/// Drops `label`'s queue outright instead of draining it. Called when a
/// window is destroyed: a window torn down before its webview drained must
/// not leak stale paths into a future window reusing the label.
pub(crate) fn drop_pending(label: &str) {
    PENDING_OPEN_FILES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(label);
}

/// Mirrors a saved session payload into the registry so open-file routing
/// sees each window's latest open paths/folder without an extra IPC round.
/// Called by the `save_session_state` command after the shard lands.
pub fn update_meta_from_payload(app: &tauri::AppHandle, label: &str, payload_json: &str) {
    let meta = meta_from_payload(payload_json);
    let registry = app.state::<Mutex<WindowRegistry>>();
    registry
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .set_meta(label, meta);
}

/// Pure payload → mirror extraction. The payload is the frontend's
/// `SavedSessionState` JSON (`openPaths`/`folder`/`activePath`); anything
/// malformed or wrong-typed degrades to an empty mirror rather than guessing.
fn meta_from_payload(payload_json: &str) -> WindowMeta {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload_json) else {
        return WindowMeta::default();
    };
    WindowMeta {
        open_paths: value
            .get("openPaths")
            .and_then(|paths| paths.as_array())
            .map(|paths| {
                paths
                    .iter()
                    .filter_map(|path| path.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        folder: value
            .get("folder")
            .and_then(|folder| folder.as_str())
            .map(str::to_string),
    }
}

/// Options for creating an editor window. Defaults describe the plain
/// `new-window` case: fresh `editor-N` label, 800x600, no queued files.
#[derive(Debug, Default)]
pub struct CreateWindowOptions {
    /// Restore path only: reuse a label from the session snapshot.
    pub label: Option<String>,
    pub initial_paths: Vec<String>,
    pub bounds: Option<WindowBounds>,
    pub maximized: bool,
}

/// Creates an editor window, registers it, and queues any initial opens.
/// Called by the `new-window` menu item now; window restore (later tasks)
/// supplies a session label/bounds/paths instead of the defaults.
pub fn create_editor_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    opts: &CreateWindowOptions,
) -> tauri::Result<String> {
    let label = opts.label.clone().unwrap_or_else(|| {
        let registry = app.state::<Mutex<WindowRegistry>>();
        let guard = registry.lock().unwrap_or_else(|e| e.into_inner());
        guard.next_label()
    });
    let mut builder =
        tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("index.html".into()))
            .title("oh-my-md");
    match opts.bounds {
        Some(b) => {
            builder = builder
                .position(b.x as f64, b.y as f64)
                .inner_size(b.width as f64, b.height as f64);
        }
        None => builder = builder.inner_size(800.0, 600.0),
    }
    builder = builder.maximized(opts.maximized);
    let window = builder.build()?;
    // Match the no-flash startup theme (same source of truth as setup):
    // "system"/missing → None keeps following the OS appearance.
    if let Err(e) = window.set_theme(crate::startup_window_theme(
        &crate::workspace::get_settings().unwrap_or_default(),
    )) {
        log::warn!("new window theme failed: {e}");
    }
    {
        let registry = app.state::<Mutex<WindowRegistry>>();
        registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .register(&label);
    }
    for path in &opts.initial_paths {
        queue_open_file(&label, path);
    }
    Ok(label)
}

/// Routes one open-file request to the best window: the pick_window score,
/// falling back to the focused (MRU) window when nothing scores. The chosen
/// window is shown and focused, the path is queued (the webview may not have
/// its listener registered yet), and a targeted event pokes already-running
/// webviews. With no live window at all (macOS after closing everything), a
/// new window is created carrying the file as its initial tab.
pub fn route_open_file(app: &tauri::AppHandle, path: &str) {
    let target = {
        let registry = app.state::<Mutex<WindowRegistry>>();
        let guard = registry.lock().unwrap_or_else(|e| e.into_inner());
        pick_window(&guard, path)
            .map(str::to_string)
            .or_else(|| guard.focused().map(str::to_string))
    };
    match target.and_then(|label| app.get_webview_window(&label)) {
        Some(window) => {
            let _ = window.show();
            let _ = window.set_focus();
            queue_open_file(window.label(), path);
            let _ = app.emit_to(window.label(), OPEN_FILE_EVENT, path);
        }
        None => {
            // No window at all (macOS after closing all): open a new one
            // carrying the file as its initial tab.
            let _ = create_editor_window(
                app,
                &CreateWindowOptions {
                    initial_paths: vec![path.to_string()],
                    ..Default::default()
                },
            );
        }
    }
}

/// Focuses the MRU window (also unminimizing it) or creates an empty one.
/// Used by no-arg second launches and the macOS dock-icon Reopen event,
/// where there is no file to route but the user expects a visible window.
pub fn ensure_window(app: &tauri::AppHandle) {
    let focused = {
        let registry = app.state::<Mutex<WindowRegistry>>();
        let guard = registry.lock().unwrap_or_else(|e| e.into_inner());
        guard.focused().map(str::to_string)
    };
    if let Some(window) = focused.as_deref().and_then(|l| app.get_webview_window(l)) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else {
        let _ = create_editor_window(app, &CreateWindowOptions::default());
    }
}

#[cfg(test)]
mod pending_tests {
    use super::*;

    #[test]
    fn pending_queue_is_per_window_bounded_and_deduped() {
        queue_open_file("main", "/tmp/a.md");
        queue_open_file("main", "/tmp/a.md"); // dedupe
        queue_open_file("editor-2", "/tmp/b.md");
        for i in 0..(MAX_PENDING_OPEN_FILES + 5) {
            queue_open_file("main", &format!("/tmp/m{i}.md"));
        }
        assert_eq!(take_pending("main").len(), MAX_PENDING_OPEN_FILES);
        assert!(take_pending("main").is_empty(), "drain consumes");
        assert_eq!(
            take_pending("editor-2"),
            vec!["/tmp/b.md".to_string()],
            "other window's queue untouched"
        );
    }

    #[test]
    fn drop_pending_discards_only_that_windows_queue() {
        // Distinct labels from the other pending test: the queue map is a
        // shared static and cargo runs this module's tests in parallel.
        queue_open_file("editor-31", "/tmp/a.md");
        queue_open_file("editor-32", "/tmp/b.md");
        drop_pending("editor-31");
        assert!(
            take_pending("editor-31").is_empty(),
            "dropped queue drains nothing"
        );
        assert_eq!(
            take_pending("editor-32"),
            vec!["/tmp/b.md".to_string()],
            "other window's queue untouched"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(paths: &[&str], folder: Option<&str>) -> WindowMeta {
        WindowMeta {
            open_paths: paths.iter().map(|s| s.to_string()).collect(),
            folder: folder.map(str::to_string),
        }
    }

    #[test]
    fn register_seeds_counter_from_editor_labels() {
        let mut r = WindowRegistry::default();
        r.register("main");
        r.register("editor-7");
        assert_eq!(r.next_label(), "editor-8");
    }

    #[test]
    fn register_is_idempotent_and_unregister_prunes_everywhere() {
        let mut r = WindowRegistry::default();
        r.register("main");
        r.register("main");
        r.note_focused("main");
        assert_eq!(r.labels(), &["main".to_string()]);
        r.unregister("main");
        assert!(r.labels().is_empty());
        assert_eq!(r.focused(), None);
        assert!(r.meta("main").is_none());
    }

    #[test]
    fn mru_moves_focused_window_first() {
        let mut r = WindowRegistry::default();
        r.register("main");
        r.register("editor-2");
        r.register("editor-3");
        assert_eq!(r.focused(), Some("editor-3"));
        r.note_focused("main");
        assert_eq!(r.focused(), Some("main"));
        r.note_focused("unknown"); // no-op for unregistered labels
        assert_eq!(r.focused(), Some("main"));
    }

    #[test]
    fn pick_window_prefers_exact_match_then_folder_then_mru() {
        let mut r = WindowRegistry::default();
        r.register("main");
        r.set_meta("main", meta(&["/docs/a.md"], Some("/docs")));
        r.register("editor-2");
        r.set_meta("editor-2", meta(&["/notes/b.md"], Some("/notes")));
        // MRU tie-break favors editor-2
        r.note_focused("editor-2");
        // exact mirror match wins even unfocused
        assert_eq!(pick_window(&r, "/docs/a.md"), Some("main"));
        // folder containment +5 beats sibling-dir +1
        assert_eq!(pick_window(&r, "/docs/new.md"), Some("main"));
        // sibling dir of editor-2's open file (+1) beats nothing; MRU also editor-2
        assert_eq!(pick_window(&r, "/notes/c.md"), Some("editor-2"));
        // no signal at all → MRU window
        assert_eq!(pick_window(&r, "/other/x.md"), Some("editor-2"));
        // and an empty registry has no opinion
        assert_eq!(pick_window(&WindowRegistry::default(), "/other/x.md"), None);
    }

    #[test]
    fn folder_match_requires_separator_boundary() {
        let mut r = WindowRegistry::default();
        r.register("main");
        r.set_meta("main", meta(&[], Some("/docs")));
        // "/docs-extra/x.md" must NOT count as inside "/docs"; still the MRU
        // fallback here because main is the only window
        assert_eq!(pick_window(&r, "/docs-extra/x.md"), Some("main"));
        // prove the +5 did not come from a prefix bug: with a competitor the
        // boundary decides
        r.register("editor-2");
        r.set_meta("editor-2", meta(&["/docs-extra/y.md"], None));
        assert_eq!(pick_window(&r, "/docs-extra/x.md"), Some("editor-2"));
    }

    #[test]
    fn window_with_path_matches_exact_mirror_entry() {
        let mut r = WindowRegistry::default();
        r.register("main");
        r.set_meta("main", meta(&["/tmp/a.md"], None));
        r.register("editor-2");
        r.set_meta("editor-2", meta(&[], Some("/tmp/docs")));
        assert_eq!(r.window_with_path("/tmp/a.md"), Some("main"));
        assert_eq!(r.window_with_path("/tmp/other.md"), None);
    }

    #[test]
    fn meta_from_payload_parses_paths_and_folder_tolerantly() {
        let parsed = meta_from_payload(
            r#"{"folder":"/d","openPaths":["/a.md","/b.md"],"activePath":"/a.md"}"#,
        );
        assert_eq!(
            parsed.open_paths,
            vec!["/a.md".to_string(), "/b.md".to_string()]
        );
        assert_eq!(parsed.folder.as_deref(), Some("/d"));

        // Malformed JSON and wrong-typed fields degrade to an empty mirror
        // instead of panicking or guessing.
        assert_eq!(meta_from_payload("not json"), WindowMeta::default());
        assert_eq!(
            meta_from_payload(r#"{"openPaths":"nope","folder":7}"#),
            WindowMeta::default()
        );
        assert_eq!(meta_from_payload("{}"), WindowMeta::default());
    }
}
