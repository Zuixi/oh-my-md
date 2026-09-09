# Multi-Window Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let oh-my-md open multiple editor windows in one process — each window an independent workspace with its own tabs, session shard, and watch set — with correct flush/exit, menu routing, file-open routing, and session restore.

**Architecture:** Single Tauri process, multi-`WebviewWindow`. Every window loads the same frontend and runs its own React `Workspace`. A Rust `WindowRegistry` (managed state) owns window labels, a focus MRU, and a per-window mirror of open paths/folder. Rust events become window-targeted (`emit_to`); the session flush gate becomes a counting round across windows; the session file becomes per-window shards merged under a lock. File opens route by mirror + scoring (already-open → focus; folder +5; sibling +1; tie → MRU).

**Tech Stack:** Tauri 2 (Rust), React 19 + TypeScript (vitest), cargo test. No new crate dependencies.

**Spec:** No formal spec doc exists. Design rationale + verified constraints are embedded in the Background section below and in §Global Constraints; treat those as the spec. (Ledger note: rulings without an external spec are provisional.)

## Background (verified facts — read before doubting the plan)

- The app currently has exactly one window, config label `"main"` (`apps/desktop/src-tauri/tauri.conf.json`), and `tauri-plugin-single-instance` (registered first, per official docs requirement — keep it first) forwards second-launch args to it.
- Frontend is already tab-based: `Workspace { tabs: EditorSession[], activeId, nextId, folder }` (`apps/desktop/src/workspace.ts`). Per-window state isolation comes free: each webview runs its own React app.
- **P0 trap (verified):** `capabilities/default.json` has `"windows": ["main"]`. Tauri capabilities match by window label; a dynamically created `editor-2` gets **no permissions** and every invoke fails. The generated schema at `apps/desktop/src-tauri/gen/schemas/desktop-schema.json` documents that the `windows` array "Can be a glob pattern" — so `["main", "editor-*"]` works.
- `FlushGate` (`src-tauri/src/session_flush.rs`) is single-window: one ack channel. Multi-window needs a counting round (parallel emit, one global deadline — NOT per-window serial timeouts).
- All Rust→frontend events are broadcasts (`app.emit`): `open-file`, `menu-command`, `session-flush`, `workspace-changed`. The first three must become `emit_to`; `workspace-changed` stays broadcast (all windows watch).
- Pending open files is a global `Vec` drained by whoever mounts first; must become per-label.
- `watcher.rs` `set_watched_paths` replaces the global watch set — a second window would unwatch the first window's folder. Must become per-window sets with a union diff.
- Session state is one file `session.json` with `{folder, openPaths, activePath}` (frontend `SavedSessionState`, `apps/desktop/src/sessionRestore.ts`), saved debounced + at quit via the flush gate.
- The macOS native menu lives in `src-tauri/src/menu.rs` and only renders on macOS (`rebuild_from_state` no-ops elsewhere; non-macOS uses the in-app menu `menuTree.ts` + `AppMenu.tsx`). `test/crossLayerMenu.test.ts` parses menu.rs source and cross-checks every non-`window-` item id against `MENU_TO_COMMAND` + accelerator against `WINDOW_SHORTCUTS` — adding `new-window` to menu.rs without the TS side (or vice versa) turns this test red, so Task 8 adds both sides in one commit.
- Mount flow (`App.tsx` mount effect): `takePendingOpenFiles` → if empty `restoreSavedSession()` → if false `restoreDraft()`. **A new window must not fall through to `restoreDraft()`** — it would resurrect the last draft into the wrong window. Non-`main` windows skip draft restore (Task 8).
- `apps/desktop/AGENTS.md` IPC casing rule: every Rust payload with multi-word fields needs a serialized-JSON assertion in Rust tests. Single-word fields (`bounds` sub-fields, `label`, `maximized`) still get assertions here where they are new wire types.
- Known non-goals (deferred, do NOT implement): per-window View-menu checkmark refresh on macOS focus switch (last writer wins for now), `settings-changed` broadcast, "Move Tab to New Window", window title per document, untitled content in session shards, multi-window e2e.

## Global Constraints

- pnpm is NOT on PATH on this machine — use `npx pnpm …` (packageManager is pnpm@11.22.0).
- Rust checks: `cargo fmt --check` and `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` (run inside the worktree).
- Desktop TS checks: `npx pnpm --filter @omd/desktop test`. Engine checks: `npx pnpm test`. Engine package must NOT be touched (no imports of React/Tauri, no window concepts).
- Windows baseline (record in ledger, do not chase): ~13 desktop tests fail from autocrlf CRLF in `crossLayerConstants` / `releaseWorkflow` / `prepareUpdaterKey`; `readonly-guards` paste is flaky. If your run fails, compare against the baseline failure list, not against zero.
- Commit subjects must match `<type>: <why>` (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`); the `commit-msg` hook strips `Co-authored-by:` trailers.
- IPC argument casing: JS invoke uses camelCase keys mapping to snake_case Rust params (e.g. `initialPaths` ↔ `initial_paths`), as `allow_document_assets`/`documentPath` already proves.
- Shared cross-layer values get named constants with a drift test; do not introduce bare literals on one side only.
- Platform checks only via `cfg!(target_os = …)` (Rust) or `apps/desktop/src/platform.ts` (TS).
- No `indentOnInput`/`closeBrackets`/`autocompletion` anywhere; strict TS, no `any`.
- Do not modify `packages/engine/**` at all in this plan.

## File Structure (created/modified map)

```
apps/desktop/src-tauri/src/
  windows.rs          # NEW — registry core, MRU, pending queue, create/route/restore, bounds
  session_flush.rs    # REWORK — counting FlushGate
  workspace.rs        # EXTEND — session shard store (schema v2 + migration)
  watcher.rs          # REWORK — per-window watch sets, union diff
  menu.rs             # EXTEND — new-window item + focused-window routing
  lib.rs              # WIRE — commands, lifecycle events, single-instance/Opened routing
  capabilities/default.json  # windows: ["main", "editor-*"]
apps/desktop/src/
  windowScope.ts      # NEW — current window label / isMainWindow()
  desktopServices.ts  # EXTEND — createNewWindow
  commands.ts menuTree.ts shortcuts.ts i18n/messages/{en,zh}.ts  # new-window wiring
  App.tsx             # EXTEND — new-window palette command; non-main mount flow
docs/memory/known-gotchas.md + gotchas-rust.md + docs/manual-qa.md   # docs
```

---

### Task 1: Window registry core

**Files:**
- Create: `apps/desktop/src-tauri/src/windows.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (add `mod windows;`, manage state, register `main` in setup)

**Interfaces:**
- Produces: `WindowMeta { open_paths: Vec<String>, folder: Option<String> }`; `WindowRegistry` with `register(&str)`, `unregister(&str)`, `note_focused(&str)`, `focused(&self) -> Option<&str>`, `next_label(&self) -> String`, `set_meta(&str, WindowMeta)`, `meta(&self, &str) -> Option<&WindowMeta>`, `labels(&self) -> &[String]`, `window_with_path(&self, &str) -> Option<&str>`; managed as `Mutex<WindowRegistry>`.

- [ ] **Step 1: Write failing tests** — append to `windows.rs`:

```rust
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
```

- [ ] **Step 2: Run to verify failure** — `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml windows` → compile error (module missing).
- [ ] **Step 3: Implement** in `windows.rs`:

```rust
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
```

- [ ] **Step 4: Wire into lib.rs** — add `mod windows;` to the module list; in `run()` add `.manage(std::sync::Mutex::windows::WindowRegistry::default())`; in `setup()` after the argv loop add:

```rust
{
    use std::sync::Mutex;
    let registry = app.state::<Mutex<windows::WindowRegistry>>();
    registry
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .register("main");
}
```

- [ ] **Step 5: Run tests** — `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` → all pass (including existing suites). `cargo fmt` before commit.
- [ ] **Step 6: Commit** — `git add apps/desktop/src-tauri/src/windows.rs apps/desktop/src-tauri/src/lib.rs && git commit -m "feat: window registry for multi-window host"`

---

### Task 2: Counting flush gate

**Files:**
- Modify: `apps/desktop/src-tauri/src/session_flush.rs` (rework `FlushGate`)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (four call sites adapt to target lists)

**Interfaces:**
- Produces: `FlushGate::begin(&self, timeout: Duration, targets: &[String], finish: impl FnOnce(FlushOutcome) + Send + 'static) -> bool`; `FlushGate::ack(&self, window_label: &str)`; empty `targets` completes immediately with `Acknowledged`. `SESSION_FLUSH_TIMEOUT` unchanged (2000ms) — it is ONE global deadline for the whole round, never per-window serial.
- Consumes: nothing new.

- [ ] **Step 1: Rework tests first** — replace the gate tests in `session_flush.rs` `mod tests` (keep `await_finish` helper and the flushed-flag tests adapted):

```rust
    #[test]
    fn all_targets_ack_before_deadline_is_acknowledged() {
        let gate = FlushGate::default();
        let (done_tx, done_rx) = mpsc::channel();
        let targets = vec!["main".into(), "editor-2".into()];
        assert!(gate.begin(Duration::from_secs(5), &targets, move |outcome| {
            let _ = done_tx.send(outcome);
        }));
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
```

Keep (adapted to the new signature): `begin_while_in_progress_is_ignored`, `flushed_flag_is_consumed_once`, `ack_without_pending_round_is_noop`.

- [ ] **Step 2: Run** → compile errors (signature mismatch) = expected failure.
- [ ] **Step 3: Implement** — replace the mpsc-channel gate with a condvar round:

```rust
use std::collections::HashSet;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct FlushGate {
    round: Arc<(Mutex<Option<Round>>, Condvar)>,
    flushed: Arc<AtomicBool>,
}

struct Round {
    deadline: Instant,
    pending: HashSet<String>,
}

impl FlushGate {
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
                let (g, _timeout) = cond
                    .wait_timeout(guard, round.deadline - now)
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

    pub fn consume_flushed(&self) -> bool {
        self.flushed.swap(false, Ordering::AcqRel)
    }
}
```

- [ ] **Step 4: Adapt the four call sites in lib.rs** (mechanical, no behavior change beyond targeting):
  - `quit_app`: targets = `all_window_labels(&app)` (new helper: `fn all_window_labels<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<String> { app.webview_windows().keys().cloned().collect() }`); emit stays `app.emit(SESSION_FLUSH_EVENT, ())` **for now** (broadcast reaches every target; Task 7 makes it targeted).
  - `prepare_update_restart`: same targets; keep the no-exit semantics and `gate.consume_flushed()`.
  - `on_window_event` CloseRequested: `let targets = vec![window.label().to_string()];`
  - `ExitRequested`: targets = `all_window_labels(app)`.
- [ ] **Step 5: Run** — `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` → pass; `cargo fmt --check`.
- [ ] **Step 6: Commit** — `git commit -am "feat: counting flush gate across windows"`

---

### Task 3: Window-scoped flush ack and pending opens

**Files:**
- Modify: `apps/desktop/src-tauri/src/windows.rs` (pending map moves here from lib.rs)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (queue/record/commands)

**Interfaces:**
- Produces: `windows::queue_open_file(label: &str, path: &str)` (bounded per window at `MAX_PENDING_OPEN_FILES = 16`, de-duplicated per window); `windows::take_pending(label: &str) -> Vec<String>`; `pub(crate) const OPEN_FILE_EVENT: &str = "open-file"` moves to windows.rs (update the comment that mirrors `desktopServices.listenOpenFile`); commands `take_pending_open_files(window: tauri::WebviewWindow) -> Vec<String>` and `session_flush_ack(app, window: tauri::WebviewWindow)` resolve the calling window server-side — the TS contracts (`takePendingOpenFiles`, `sessionFlushAck` take no args) stay unchanged.
- Consumes: Task 1 registry (not yet needed here), Task 2 `ack(&str)`.

- [ ] **Step 1: Failing tests** in windows.rs:

```rust
use std::sync::Mutex;

const MAX_PENDING_OPEN_FILES: usize = 16;
static PENDING_OPEN_FILES: Mutex<std::collections::HashMap<String, Vec<String>>> =
    Mutex::new(std::collections::HashMap::new());

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
}
```

- [ ] **Step 2: Run** → fails (functions missing).
- [ ] **Step 3: Implement** `queue_open_file`/`take_pending` in windows.rs per the test; delete `PENDING_OPEN_FILES`, `MAX_PENDING_OPEN_FILES`, `OPEN_FILE_EVENT`, `queue_open_file` from lib.rs; re-point lib.rs uses: `record_open_file` becomes:

```rust
fn record_open_file(app: &tauri::AppHandle, path: String) {
    // Still single-target for now: the only window is main. Task 9 replaces
    // this call site with windows::route_open_file.
    windows::queue_open_file("main", &path);
    let _ = app.emit(windows::OPEN_FILE_EVENT, path);
}
```

  Commands become:

```rust
#[tauri::command]
fn take_pending_open_files(window: tauri::WebviewWindow) -> Vec<String> {
    windows::take_pending(window.label())
}

#[tauri::command]
fn session_flush_ack(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    app.state::<session_flush::FlushGate>()
        .ack(window.label());
}
```

- [ ] **Step 4: Run full cargo suite** → pass (the old lib.rs pending test is deleted in favor of the windows.rs one).
- [ ] **Step 5: Commit** — `git commit -am "feat: window-scoped flush ack and pending opens"`

---

### Task 4: Capabilities cover editor windows

**Files:**
- Modify: `apps/desktop/src-tauri/capabilities/default.json`
- Modify: `apps/desktop/src-tauri/tauri.conf.json` (make the implicit `main` label explicit)
- Test: `apps/desktop/test/windowCapabilities.test.ts` (new)

**Interfaces:** none (config + guard).

- [ ] **Step 1: Write the drift test** `apps/desktop/test/windowCapabilities.test.ts`:

```ts
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Tauri capabilities match by window label. Dynamically created editor
 * windows (`editor-N`, see src-tauri/src/windows.rs) get IPC permissions
 * only if a capability pattern covers them — without this, every invoke in
 * a new window fails while tests (which mock at the TS boundary) stay green.
 */
describe("window capabilities", () => {
  const capability = JSON.parse(
    readFileSync(resolve(process.cwd(), "src-tauri/capabilities/default.json"), "utf8"),
  ) as { windows: string[] }

  it("covers main and dynamically created editor windows", () => {
    expect(capability.windows).toContain("main")
    expect(
      capability.windows.some(pattern => pattern === "editor-*" || pattern === "*"),
    ).toBe(true)
  })

  it("does not widen capabilities to every possible window label", () => {
    // editor-* is the documented glob form; a bare "*" would also match
    // future utility windows that may need tighter scopes.
    expect(capability.windows).toContain("editor-*")
  })
})
```

- [ ] **Step 2: Run** — `npx pnpm --filter @omd/desktop test windowCapabilities` → FAIL.
- [ ] **Step 3: Change config** — `capabilities/default.json`: `"windows": ["main", "editor-*"]` (update the description to mention editor windows); `tauri.conf.json` window entry gains `"label": "main"`.
- [ ] **Step 4: Run** desktop suite → new test passes; baseline failures unchanged. Also run `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` once to prove the capability file still parses (build.rs validates it).
- [ ] **Step 5: Add the gotcha** — append to `docs/memory/gotchas-rust.md` (and index line in `docs/memory/known-gotchas.md`): capability `windows` is label-matched with glob support (`editor-*`); a new window label not covered by any capability fails every invoke at runtime while TS tests stay green — cite this test.
- [ ] **Step 6: Commit** — `git add -A apps/desktop/src-tauri apps/desktop/test docs/memory && git commit -m "feat: capabilities cover editor windows"`

---

### Task 5: Per-window session shards

**Files:**
- Modify: `apps/desktop/src-tauri/src/workspace.rs` (session store)
- Modify: `apps/desktop/src-tauri/src/windows.rs` (WindowBounds type lives with windows)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (commands get/save become window-aware; save updates the registry mirror)

**Interfaces:**
- Produces (workspace.rs): `SessionWindowEntry { label: String, bounds: Option<WindowBounds>, maximized: bool }` (serde camelCase); `session_payload_for(label: &str) -> Result<Option<String>, String>` (returns the window's `SavedSessionState` JSON — `None` when no shard); `save_session_shard(label: &str, contents: &str, bounds: Option<WindowBounds>, maximized: bool) -> Result<(), String>`; `remove_session_shard(label: &str) -> Result<(), String>`; `list_session_windows() -> Result<Vec<SessionWindowEntry>, String>` (deterministic order: `main` first, then `editor-N` ascending). File format `session.json`:

```json
{ "schema": 2, "windows": { "main": { "payload": { "folder": null, "openPaths": [], "activePath": null }, "bounds": { "x": 0, "y": 0, "width": 800, "height": 600 }, "maximized": false } } }
```

  Legacy migration: a file without `"schema": 2` is a bare v1 `SavedSessionState` and becomes `main`'s payload on first read.
- Produces (windows.rs): `WindowBounds { x: i32, y: i32, width: u32, height: u32 }` (serde camelCase — single-word fields, but the struct assertion is still written) and `update_meta_from_payload(app: &tauri::AppHandle, label: &str, payload_json: &str)` which parses `openPaths`/`folder` and calls `set_meta`.
- Commands: `get_session_state(window: WebviewWindow) -> Result<String, String>` (payload or `"{}"`); `save_session_state(window: WebviewWindow, contents: String)` — captures `window.outer_position()`, `window.inner_size()`, `window.is_maximized()` (skip bounds when minimized/unavailable), saves the shard, then `update_meta_from_payload`.

- [ ] **Step 1: Failing tests** in workspace.rs `mod tests` (use `tempfile::tempdir` + point `config_dir` at it — `config_dir()` is `pub fn`; add a test-only override or write via the new functions and monkey-patch the dir by making the store take a root: prefer extracting `fn session_file_at(root: &Path) -> &Path`-style pure helpers so tests pass a temp root):

```rust
    #[test]
    fn session_shard_roundtrip_and_removal() {
        let root = tempfile::tempdir().unwrap();
        save_session_shard_at(root.path(), "main", r#"{"folder":null,"openPaths":["/a.md"],"activePath":"/a.md"}"#, None, false).unwrap();
        save_session_shard_at(root.path(), "editor-2", r#"{"folder":"/d","openPaths":[],"activePath":null}"#, Some(WindowBounds { x: 10, y: 20, width: 800, height: 600 }), true).unwrap();
        // second save for the same label merges, not clobbers other windows
        save_session_shard_at(root.path(), "main", r#"{"folder":null,"openPaths":[],"activePath":null}"#, None, false).unwrap();
        assert_eq!(list_session_windows_at(root.path()).unwrap().len(), 2);
        assert_eq!(
            list_session_windows_at(root.path()).unwrap()[0].label,
            "main",
            "main is always first"
        );
        assert!(session_payload_for_at(root.path(), "editor-2").unwrap().unwrap().contains("/d"));
        assert!(session_payload_for_at(root.path(), "editor-3").unwrap().is_none());
        remove_session_shard_at(root.path(), "editor-2").unwrap();
        assert!(session_payload_for_at(root.path(), "editor-2").unwrap().is_none());
    }

    #[test]
    fn legacy_session_file_migrates_to_main_shard() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("session.json"),
            r#"{"folder":"/tmp","openPaths":["/tmp/x.md"],"activePath":"/tmp/x.md"}"#,
        )
        .unwrap();
        let payload = session_payload_for_at(root.path(), "main").unwrap();
        assert!(payload.unwrap().contains("/tmp/x.md"));
    }

    #[test]
    fn window_bounds_and_entry_serialize_camel_case() {
        // IPC wire assertion (AGENTS.md casing rule).
        assert_eq!(
            serde_json::to_string(&WindowBounds { x: 1, y: 2, width: 3, height: 4 }).unwrap(),
            r#"{"x":1,"y":2,"width":3,"height":4}"#
        );
        assert_eq!(
            serde_json::to_string(&SessionWindowEntry { label: "editor-2".into(), bounds: None, maximized: true }).unwrap(),
            r#"{"label":"editor-2","bounds":null,"maximized":true}"#
        );
    }
```

  (Name the `_at(root, …)` variants as the real internal functions; the managed-state wrappers `session_payload_for` etc. call them with `config_dir()`.)

- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement** — add `WindowBounds` to windows.rs; add the shard store to workspace.rs (read-modify-write under a new managed `Mutex<()>` (`SessionFileLock`) in lib.rs `.manage()`; use `crate::atomic_write`; treat unreadable/missing file as empty snapshot; keep `create_dir_all(config_dir())` on save).
- [ ] **Step 4: Rewire the two commands in lib.rs** to the signatures above. The frontend `getSessionState`/`saveSessionState` TS contracts are unchanged (Rust resolves the calling window).
- [ ] **Step 5: Run** full cargo suite + `npx pnpm --filter @omd/desktop test` (desktop mocks don't hit Rust; should be baseline-only failures).
- [ ] **Step 6: Commit** — `git commit -am "feat: per-window session shards"`

---

### Task 6: Per-window close/exit lifecycle

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (window events, close/exit rounds)

**Interfaces:**
- Consumes: Task 2 gate, Task 5 `remove_session_shard`.
- Produces: CloseRequested → counting round over that one window → finish destroys the window and removes its shard (a closed window must not come back on restore); `WindowEvent::Focused(bool=true)` → `registry.note_focused`; `WindowEvent::Destroyed` → `registry.unregister`; ExitRequested/`quit_app`/`prepare_update_restart` → one round over all window labels.

- [ ] **Step 1: There is no pure unit test to write first** (this task is event wiring over Tauri); the guard is the full existing suite plus the lifecycle review checklist below. Keep the diff mechanical.
- [ ] **Step 2: Implement** in `on_window_event`:

```rust
.on_window_event(|window, event| match event {
    tauri::WindowEvent::Focused(true) => {
        let app = window.app_handle();
        let registry = app.state::<std::sync::Mutex<windows::WindowRegistry>>();
        registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .note_focused(window.label());
    }
    tauri::WindowEvent::Destroyed => {
        let app = window.app_handle();
        let registry = app.state::<std::sync::Mutex<windows::WindowRegistry>>();
        registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .unregister(window.label());
    }
    tauri::WindowEvent::CloseRequested { api, .. } => {
        // Red X / Cmd+W: flush THIS window only, then destroy it and drop
        // its session shard (a closed window must not restore). App exit
        // keeps all shards — see ExitRequested.
        api.prevent_close();
        let app = window.app_handle();
        let gate = app.state::<session_flush::FlushGate>();
        if gate.in_progress() {
            return;
        }
        let label = window.label().to_string();
        let closing = window.clone();
        let targets = vec![label.clone()];
        if !gate.begin(session_flush::SESSION_FLUSH_TIMEOUT, &targets, move |_outcome| {
            let _ = workspace::remove_session_shard(&label);
            let _ = closing.destroy();
        }) {
            return;
        }
        let _ = app.emit_to(&window.label(), session_flush::SESSION_FLUSH_EVENT, ());
    }
    _ => {}
})
```

  In `ExitRequested`/`quit_app`/`prepare_update_restart`, emit the flush event **to each target** (`for label in &targets { let _ = app.emit_to(label, session_flush::SESSION_FLUSH_EVENT, ()); }`) instead of `app.emit`. Keep every existing guard (`consume_flushed`, `in_progress`, empty-windows early return, no-exit-on-timeout update semantics) exactly as-is — only the targeting changes.
- [ ] **Step 3: Review checklist (verify in code, note in report):** (a) closing one of two windows does not exit the app; (b) macOS: closing the last window keeps the process alive (ExitRequested still only fires on quit); (c) Windows/Linux: closing the last window still exits through the existing empty-windows path; (d) `quit_app` from either window flushes both.
- [ ] **Step 4: Run** cargo suite; `cargo fmt --check`.
- [ ] **Step 5: Commit** — `git commit -am "feat: per-window close and exit flush"`

---

### Task 7: Native menu routes to the focused window

**Files:**
- Modify: `apps/desktop/src-tauri/src/menu.rs`

**Interfaces:**
- Consumes: Task 1 `focused()`, Task 6 focus events.
- Produces: `MENU_EVENT` (`menu-command`) is emitted only to the focused window; window commands act on the focused window; `new-window` menu clicks create a window natively (the menu item itself arrives in Task 8; the dispatch arm must exist now so Task 8 is pure wiring).

- [ ] **Step 1: Failing test** — menu.rs has no tests today; add one for a pure helper extracted in Step 3:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focused_label_prefers_mru_then_any_registered_window() {
        let mut r = crate::windows::WindowRegistry::default();
        assert_eq!(focused_label(&r, &[]), None);
        r.register("main");
        r.register("editor-2");
        r.note_focused("main");
        assert_eq!(focused_label(&r, &["main".to_string(), "editor-2".to_string()]), Some("main".to_string()));
        let mut r2 = crate::windows::WindowRegistry::default();
        r2.register("editor-2");
        // mru empty-cased via note_focused; fallback: any live webview label
        r2.note_focused("editor-2");
        assert_eq!(focused_label(&r2, &["editor-2".to_string()]), Some("editor-2".to_string()));
    }
}
```

- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement** in menu.rs:

```rust
/// Menu actions target the focused window: macOS's app-level menu has no
/// window identity, so the registry's MRU decides (fallback: any live webview).
fn focused_label<R: tauri::Runtime>(
    registry: &crate::windows::WindowRegistry,
    live_labels: &[String],
) -> Option<String> {
    if let Some(focused) = registry.focused() {
        if live_labels.iter().any(|l| l == focused) {
            return Some(focused.to_string());
        }
    }
    live_labels.first().cloned()
}
```

  In `install`'s `on_menu_event`:

```rust
    app.on_menu_event(|handle, event| {
        let id = event.id().as_ref();
        if id == "new-window" {
            let _ = crate::windows::create_editor_window(
                handle,
                &crate::windows::CreateWindowOptions::default(),
            );
            return;
        }
        if handle_window_command(handle, id) {
            return;
        }
        let label = {
            let registry = handle.state::<std::sync::Mutex<crate::windows::WindowRegistry>>();
            let guard = registry.lock().unwrap_or_else(|e| e.into_inner());
            let live: Vec<String> = handle.webview_windows().keys().cloned().collect();
            focused_label(&guard, &live)
        };
        if let Some(label) = label {
            let _ = handle.emit_to(&label, MENU_EVENT, id);
        }
        // Zero windows (macOS): no webview to receive the command — drop it.
    });
```

  `handle_window_command` switches from `app.get_webview_window("main")` to the same `focused_label` resolution (compute live labels + registry inside it); `window-bring-all-to-front` keeps iterating all windows.
- [ ] **Step 4:** `create_editor_window`/`CreateWindowOptions` don't exist yet — add a minimal placeholder in windows.rs that this task compiles against is NOT allowed (no stubs). Instead: implement `CreateWindowOptions` + `create_editor_window` NOW in windows.rs (it is this task's dependency) exactly as Task 8 specifies it, and let Task 8 be pure menu/TS wiring. That means this task also contains:

```rust
#[derive(Debug, Default)]
pub struct CreateWindowOptions {
    /// Restore path only: reuse a label from the session snapshot.
    pub label: Option<String>,
    pub initial_paths: Vec<String>,
    pub bounds: Option<WindowBounds>,
    pub maximized: bool,
}

pub fn create_editor_window(
    app: &tauri::AppHandle,
    opts: &CreateWindowOptions,
) -> tauri::Result<String> {
    let label = opts.label.clone().unwrap_or_else(|| {
        let registry = app
            .state::<Mutex<WindowRegistry>>();
        registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .next_label()
    });
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::default(),
    )
    .title("oh-my-md");
    match opts.bounds {
        Some(b) => {
            builder = builder
                .position(b.x as f64, b.y as f64)
                .inner_size(b.width as f64, b.height as f64);
        }
        None => builder = builder.inner_size(800.0, 600.0),
    }
    builder = builder.maximize(opts.maximized);
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
```

  (`startup_window_theme` in lib.rs changes from `fn` to `pub(crate) fn`.) No new test for `create_editor_window` itself — it needs a live app; the registry interplay is covered by Task 1 tests + Task 8's frontend test.
- [ ] **Step 5: Run** cargo suite + fmt; commit — `git commit -am "feat: route native menu to focused window"`

---

### Task 8: New Window command, end to end

**Files:**
- Modify: `apps/desktop/src-tauri/src/menu.rs` (menu item + labels)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (`create_editor_window` command)
- Create: `apps/desktop/src/windowScope.ts`
- Modify: `apps/desktop/src/desktopServices.ts`, `commands.ts`, `menuTree.ts`, `shortcuts.ts`, `i18n/messages/en.ts`, `i18n/messages/zh.ts`, `App.tsx`
- Test: `apps/desktop/test/windowScope.test.ts` (new), plus updates to `commands.test.ts` / `desktopServices.test.ts` if they enumerate mappings

**Interfaces:**
- Produces: Rust command `create_editor_window(app, initial_paths: Option<Vec<String>>) -> Result<String, String>` (sync — window creation must run on the main thread); TS `services.createNewWindow?(initialPaths?: string[]): Promise<void>`; palette command id `new-window`; menu item id `new-window` (native macOS + in-app tree); shortcut `Mod+Shift+n`; `windowScope.ts` exports `currentWindowLabel(): string` (defaults `"main"` outside Tauri) and `isMainWindow(): boolean`.
- Consumes: Task 7 `create_editor_window` fn; Task 4 capabilities.

- [ ] **Step 1: Failing TS test** `apps/desktop/test/windowScope.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"

describe("windowScope", () => {
  it("defaults to main outside Tauri", async () => {
    vi.resetModules()
    const { currentWindowLabel, isMainWindow } = await import("../src/windowScope")
    expect(currentWindowLabel()).toBe("main")
    expect(isMainWindow()).toBe(true)
  })
})
```

  And in `commands.test.ts` add (follow that file's existing import/describe style):

```ts
it("maps the native new-window item to the palette command", () => {
  expect(MENU_TO_COMMAND["new-window"]).toBe("new-window")
})
```

- [ ] **Step 2: Run** → both fail.
- [ ] **Step 3: Implement frontend**:

  `windowScope.ts`:

```ts
/**
 * Identity of the webview this app instance runs in. The label is assigned
 * by Rust (`main` from tauri.conf.json, `editor-N` from
 * src-tauri/src/windows.rs). Outside Tauri (tests, browser builds) every
 * instance behaves as the main window.
 */
export function currentWindowLabel(): string {
  const internals = (window as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: unknown } } } })
    .__TAURI_INTERNALS__
  const label = internals?.metadata?.currentWindow?.label
  return typeof label === "string" && label ? label : "main"
}

export function isMainWindow(): boolean {
  return currentWindowLabel() === "main"
}
```

  `desktopServices.ts`: add to the interface `createNewWindow?: (initialPaths?: string[]) => Promise<void>` and to `defaultServices`:

```ts
  createNewWindow: async initialPaths => {
    await invoke("create_editor_window", { initialPaths })
  },
```

  `commands.ts`: add `"new-window": "new-window",` to `MENU_TO_COMMAND`. `menuTree.ts`: add `{ id: "new-window" }` directly after `{ id: "new" }`. `shortcuts.ts`: add `{ id: "new-window", binding: "Mod+Shift+n", key: "N", shift: true }` to `WINDOW_SHORTCUTS`. i18n: add the palette label `cmd.label.newWindow` ("New Window" / "新建窗口") and the in-app menu label under the same nesting the `new` entry uses in `en.ts`/`zh.ts` (follow the exact structure of the existing `menu.*` keys — check how AppMenu resolves `menu.<id>` and add the matching `"new-window"` key). `App.tsx`: next to the `tab` command in `allCommands` add:

```ts
    {
      id: "new-window",
      label: t("cmd.label.newWindow"),
      shortcut: shortcutFor("new-window"),
      run: () => { void services.createNewWindow?.() },
    },
```

- [ ] **Step 4: Mount-flow branch** — in the mount effect (`takePendingOpenFiles` block), non-main windows must never fall through to `restoreDraft()`:

```ts
      if (pendingOpen.length > 0) {
        for (const path of pendingOpen) {
          await openExternalRef.current(path)
        }
      } else if (isMainWindow()) {
        const restored = await restoreSavedSession()
        if (!restored) {
          await restoreDraft()
        }
      }
      // Non-main windows without pending files and without a session shard
      // (get_session_state returns "{}") keep their fresh untitled tab.
```

  (`restoreSavedSession` already returns false for `{}` payloads — verify while implementing; if an empty-shard window would still call it, that path is harmless because the shard payload is empty.)
- [ ] **Step 5: Implement Rust menu item** — menu.rs: add `new_window: &'static str` to `MenuLabels` with `"New Window"` / `"新建窗口"`, add to both locale structs, and in `file_submenu` directly after the `new` item:

```rust
        .item(&item(
            app,
            "new-window",
            l.new_window,
            Some("CmdOrCtrl+Shift+N"),
        )?)
```

  Add the command in lib.rs `invoke_handler` + definition:

```rust
#[tauri::command]
fn create_editor_window(
    app: tauri::AppHandle,
    initial_paths: Option<Vec<String>>,
) -> Result<String, String> {
    windows::create_editor_window(
        &app,
        &windows::CreateWindowOptions {
            label: None,
            initial_paths: initial_paths.unwrap_or_default(),
            bounds: None,
            maximized: false,
        },
    )
    .map_err(|e| e.to_string())
}
```

- [ ] **Step 6: Run** — `npx pnpm --filter @omd/desktop test` (new tests pass; `crossLayerMenu.test.ts` now validates the menu.rs item against `MENU_TO_COMMAND` + `WINDOW_SHORTCUTS` and must pass — it failing means the TS/Rust accelerator pair drifted); full cargo suite; `cargo fmt --check`.
- [ ] **Step 7: Commit** — `git add -A apps/desktop && git commit -m "feat: new window command end to end"`

---

### Task 9: Open-file routing across windows

**Files:**
- Modify: `apps/desktop/src-tauri/src/windows.rs` (pick_window + route_open_file)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (single-instance callback, macOS Opened, setup argv)

**Interfaces:**
- Produces: `pick_window<'a>(registry: &'a WindowRegistry, path: &str) -> Option<&'a str>` (pure scoring: exact mirror match wins; else +5 path-inside-window-folder, +1 per open path sharing the parent dir; ties resolve to MRU order; `None` only with no windows); `route_open_file(app: &AppHandle, path: &str)` — resolves a target window, shows+focuses it, queues the pending file, and `emit_to`s `OPEN_FILE_EVENT`; creates a window (with the file as `initial_paths`) when none exists; `ensure_window(app: &AppHandle)` — focuses the MRU window or creates an empty one (used by no-arg second launches and macOS Reopen).
- Consumes: Task 1 registry + Task 7 `create_editor_window`.

- [ ] **Step 1: Failing tests** in windows.rs:

```rust
    #[test]
    fn pick_window_prefers_exact_match_then_folder_then_mru() {
        let mut r = WindowRegistry::default();
        r.register("main");
        r.set_meta("main", meta(&["/docs/a.md"], Some("/docs")));
        r.register("editor-2");
        r.set_meta("editor-2", meta(&["/notes/b.md"], Some("/notes")));
        r.note_focused("editor-2"); // MRU tie-break favors editor-2
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
        // "/docs-extra/x.md" must NOT count as inside "/docs"
        assert_eq!(pick_window(&r, "/docs-extra/x.md"), Some("main")); // still MRU fallback: only window
        // prove the +5 did not come from a prefix bug: with a competitor the
        // boundary decides
        r.register("editor-2");
        r.set_meta("editor-2", meta(&["/docs-extra/y.md"], None));
        assert_eq!(pick_window(&r, "/docs-extra/x.md"), Some("editor-2"));
    }
```

  Note: paths compare after `\` → `/` normalization on both sides.
- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement**:

```rust
fn normalized(path: &str) -> String {
    path.replace('\\', "/")
}

fn parent_dir(path: &str) -> Option<&str> {
    let n = normalized(path);
    n.rfind('/').map(|i| &n[..i])
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
    let order: Vec<&str> = registry
        .mru
        .iter()
        .map(|s| s.as_str())
        .collect();
    let mut best: Option<(&str, i32)> = None;
    for label in order {
        let Some(meta) = registry.meta(label) else { continue };
        let mut score = 0;
        if let Some(folder) = meta.folder.as_deref() {
            let folder = normalized(folder);
            let folder = folder.trim_end_matches('/');
            if target.starts_with(&format!("{folder}/")) {
                score += 5;
            }
        }
        if let Some(dir) = target_dir {
            score += meta
                .open_paths
                .iter()
                .filter(|p| parent_dir(p) == Some(dir))
                .count() as i32;
        }
        if best.is_none_or(|(_, s)| score > s {
            true
        } else {
            false
        }) {
            // (write plainly: `if best.map_or(true, |(_, s)| score > s) { … }`)
        }
    }
    best.map(|(label, _)| label)
}
```

  (The last loop is written confusingly above — implement it plainly as: track `best: Option<(&str, i32)>`, replace when `best.map_or(true, |(_, s)| score > s)`.) `mru` needs a private accessor or make `pick_window` a method-free friend: simplest is `pub(crate) fn mru_order(&self) -> &[String]` on the registry.

```rust
pub fn route_open_file(app: &tauri::AppHandle, path: &str) {
    use tauri::Manager;
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

pub fn ensure_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    let focused = {
        let registry = app.state::<Mutex<WindowRegistry>>();
        registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .focused()
            .map(str::to_string)
    };
    if let Some(window) = focused.as_deref().and_then(|l| app.get_webview_window(l)) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else {
        let _ = create_editor_window(app, &CreateWindowOptions::default());
    }
}
```

- [ ] **Step 4: Rewire lib.rs call sites** — single-instance callback: drop the `get_webview_window("main")` block; `for arg in argv.iter().skip(1) { if !arg.starts('-') { resolve_and_record_open_arg(app, arg, Some(&cwd)) } }` and then `windows::ensure_window(app)` only when argv carried no file args; `resolve_and_record_open_arg`'s tail calls `windows::route_open_file(app, canonical)` instead of `record_open_file`. macOS `RunEvent::Opened`: `windows::route_open_file(app, path)` per markdown path. `setup()` argv loop: keep resolving but route through `windows::queue_open_file("main", …)` + `app.emit_to("main", …)` (the webview may not be listening yet — the queue is the durable path). Delete `record_open_file`/`queue_open_file` leftovers in lib.rs. Add macOS `RunEvent::Reopen` handling (dock icon click): `windows::ensure_window(app)` (cfg(target_os = "macos"), mirroring the Opened block's style).
- [ ] **Step 5: Run** cargo suite + fmt; desktop suite baseline check.
- [ ] **Step 6: Commit** — `git commit -am "feat: route file opens across windows"`

---

### Task 10: Startup restore from the session snapshot

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (setup: apply main geometry, spawn extra windows)

**Interfaces:**
- Consumes: Task 5 `list_session_windows`, Task 7 `create_editor_window`, Task 1 counter seeding (register already seeds from labels).
- Produces: at startup, every non-`main` shard becomes a window with its saved label/bounds/maximized; `main`'s saved geometry is applied to the config-declared window.

- [ ] **Step 1: No unit-testable surface** (needs a live app); guard = full suites + manual matrix (Task 13). Keep the wiring minimal and mirror the existing setup style:

```rust
            // Multi-window session restore: main is already created by
            // config (theme applied above); replay its saved geometry, then
            // spawn one window per remaining shard with its saved label so
            // labels stay deterministic across restarts.
            match workspace::list_session_windows() {
                Ok(entries) => {
                    for entry in &entries {
                        if entry.label == "main" {
                            if let Some(window) = app.get_webview_window("main") {
                                if let Some(b) = entry.bounds {
                                    let _ = window.set_position(tauri::Position::Physical(
                                        tauri::PhysicalPosition::new(b.x, b.y),
                                    ));
                                    let _ = window.set_size(tauri::Size::Physical(
                                        tauri::PhysicalSize::new(b.width, b.height),
                                    ));
                                }
                                if entry.maximized {
                                    let _ = window.maximize();
                                }
                            }
                            continue;
                        }
                        let _ = windows::create_editor_window(
                            app.handle(),
                            &windows::CreateWindowOptions {
                                label: Some(entry.label.clone()),
                                initial_paths: Vec::new(),
                                bounds: entry.bounds,
                                maximized: entry.maximized,
                            },
                        );
                    }
                }
                Err(e) => log::warn!("session restore listing failed: {e}"),
            }
```

  Insert after the theme block, before `menu::install`. Bounds saved via `outer_position`/`inner_size` are physical pixels — `set_position`/`set_size` with `Physical*` types round-trip correctly.
- [ ] **Step 2: Ghost-window rule** — a shard exists only while its window was alive at the last flush; windows closed via CloseRequested drop their shard (Task 6), so a clean quit restores exactly the live set. A crash may restore a window the user closed after the last flush — acceptable (VS Code behaves the same); note it in the report, no code.
- [ ] **Step 3: Run** cargo + desktop suites, fmt.
- [ ] **Step 4: Commit** — `git commit -am "feat: restore windows from session snapshot"`

---

### Task 11: Per-window watch sets

**Files:**
- Modify: `apps/desktop/src-tauri/src/watcher.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (`watch_paths` takes the calling window; Destroyed hook)

**Interfaces:**
- Produces: `set_watched_paths(app: &AppHandle, window_label: &str, paths: &[PathBuf])` — per-window cap still `MAX_WATCHED_PATHS = 64`; the OS watcher tracks the **union** of all windows' sets; `drop_window_watches(app: &AppHandle, label: &str)` recomputes without that window (wired into `WindowEvent::Destroyed` from Task 6). Command `watch_paths(app, window: WebviewWindow, paths: Vec<String>)`.
- Consumes: existing `diff_watches`.

- [ ] **Step 1: Failing tests** — replace/extend watcher.rs tests:

```rust
    #[test]
    fn union_of_two_windows_keeps_both_sets() {
        let state = WatcherState::default(); // pure part tested via helper below
        // see Step 3: extract `apply_window_set(state, label, paths) -> (to_unwatch, to_watch, union)`
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
```

- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement** — add a pure `PureWatchSets { per_window: HashMap<String, Vec<PathBuf>> }` with `set` (cap per window), `drop_window`, `union` (sorted, deduped); `WatcherState` gains `sets: PureWatchSets`; `set_watched_paths` updates `sets`, computes `union()`, runs the existing `diff_watches(state.watched, &union)` apply, stores `state.watched = union`. `drop_window_watches` does the same minus a set() call. In lib.rs, `watch_paths` passes `window.label()`; the Destroyed handler from Task 6 additionally calls `watcher::drop_window_watches(&app, window.label())`.
- [ ] **Step 4: Run** cargo suite + fmt.
- [ ] **Step 5: Commit** — `git commit -am "feat: per-window watch sets"`

---

### Task 12: Move blocking-IO commands off the main thread

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:** command names, args, and return types unchanged; only sync→async. Multi-window makes the lib.rs:33 warning bite harder: one window's sync IO stalls every window.

- [ ] **Step 1: Convert** these sync commands doing disk IO to `async fn` + `tauri::async_runtime::spawn_blocking`, extracting the bodies into private sync fns so the existing unit tests keep calling them unchanged: `read_file`, `write_file`, `write_png`, `write_image`, `get_settings`, `save_settings`, `get_session_state`, `list_recoveries`, `clear_recovery`. Pattern (matches `snapshot_document` upstream):

```rust
#[tauri::command]
async fn write_file(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_file_impl(&path, contents))
        .await
        .map_err(|error| format!("write task failed: {error}"))?
}

fn write_file_impl(path: &str, contents: String) -> Result<(), String> {
    atomic_write(Path::new(path), contents.as_bytes())
}
```

  Update the lib.rs:33 comment to say ALL IO commands are async (no "document commands" carve-out). Existing tests call `write_file(...)` directly — repoint them to the `_impl` fns (mechanical rename in the test module).
- [ ] **Step 2: Run** full cargo suite (tests now target `_impl`) + `cargo fmt --check`.
- [ ] **Step 3: Commit** — `git commit -am "refactor: move blocking IO commands off main thread"`

---

### Task 13: Docs — gotchas + manual QA matrix

**Files:**
- Modify: `docs/memory/gotchas-rust.md`, `docs/memory/gotchas-desktop.md`, `docs/memory/known-gotchas.md`, `docs/manual-qa.md`

**Interfaces:** none.

- [ ] **Step 1: gotchas-rust.md** — add entries (one paragraph each, following the file's existing format): (a) capabilities are label-matched/globbed — see Task 4 if missing; (b) menu events carry no window identity — route via registry MRU (menu.rs `focused_label`); (c) FlushGate rounds are counting — one global deadline over the target set, `ack` carries the calling window label; (d) session shards: closed windows drop shards in the CloseRequested finisher, app exit keeps them.
- [ ] **Step 2: gotchas-desktop.md** — add: non-`main` windows must never `restoreDraft()` (mount-flow branch, `windowScope.isMainWindow`); `localStorage` is shared across same-origin webviews, so `STORAGE_KEY_SESSION` is a last-writer-wins fallback only (Rust shard is the truth).
- [ ] **Step 3: known-gotchas.md** — add index lines pointing at the four entries above.
- [ ] **Step 4: manual-qa.md** — append a "Multi-window (2026-09)" matrix (historical-style, like existing sections): New Window opens a second independent workspace; tab/file ops isolated per window; closing one window flushes only it (other window keeps 1s-debounced state unsaved-safe); quit flushes all; update-restart flushes all; OS open of an already-open file focuses its window+tab; OS open of a fresh file lands per scoring; restart restores all windows incl. geometry; macOS: last-window close keeps app alive, dock click reopens; Windows: last-window close exits. Mark each as pending manual verification.
- [ ] **Step 5: Run** `npx pnpm --filter @omd/desktop test` (docs only — suites untouched), commit — `git add docs && git commit -m "docs: multi-window gotchas and QA matrix"`

---

## Self-Review (completed by plan author)

- **Spec coverage:** every Background trap has a task — capabilities (4), gate (2), pending (3), targeting (6/7), menu (7/8), routing (9), watcher (11), shards+geometry+restore (5/10), draft-restore bug (8), IO audit (12), docs (13). Deferred items are listed under Background non-goals.
- **Type consistency:** `WindowRegistry`/`WindowMeta`/`WindowBounds`/`CreateWindowOptions`/`pick_window`/`route_open_file`/`create_editor_window`/`ensure_window`/`session_payload_for`/`save_session_shard`/`remove_session_shard`/`list_session_windows`/`SessionWindowEntry`/`PureWatchSets` names are used identically across tasks; `queue_open_file`/`take_pending` move from lib.rs to windows.rs in Task 3 and lib.rs call sites are updated in the same task.
- **Ordering hazards checked:** Task 8 adds the menu.rs item and the full TS drift trio in one commit so `crossLayerMenu.test.ts` never sees half the contract; Task 7 implements `create_editor_window` (needed by its own dispatch arm) so no stub exists; Task 6's shard removal requires Task 5's store (ordered after).
- **Known plan text flaws, ruled on:** Task 9 Step 3 contains a deliberately-corrected confusing loop snippet with the plain form stated inline — implementers must write the plain `map_or` form. Task 5's test names use `_at(root, …)` variants; the managed wrappers delegate to them.
