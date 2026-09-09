//! Multi-window host state: window registry, focus order (MRU), and the
//! per-window mirror used by open-file routing. Pure core — no Tauri types
//! in the registry itself so behavior is unit-testable on any host.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
    fn window_with_path_matches_exact_mirror_entry() {
        let mut r = WindowRegistry::default();
        r.register("main");
        r.set_meta("main", meta(&["/tmp/a.md"], None));
        r.register("editor-2");
        r.set_meta("editor-2", meta(&[], Some("/tmp/docs")));
        assert_eq!(r.window_with_path("/tmp/a.md"), Some("main"));
        assert_eq!(r.window_with_path("/tmp/other.md"), None);
    }
}
