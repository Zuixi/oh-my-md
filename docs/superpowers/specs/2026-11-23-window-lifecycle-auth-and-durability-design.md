# Window Lifecycle, Authorization & Durability Hardening (Design)

> **Status:** implemented (`fix/wave1-stability`, Mission 3)
> **Scope:** `apps/desktop/src-tauri` (Rust host) plus the four TS/engine call
> sites that had to move with it.
> **Supersedes:** the process-global authorization model in `workspace.rs` and
> the physical-pixel window geometry contract.

## Problem

Five independent defects shared one root cause: the Rust host treated every
window, every grant, and every persisted value as process-global.

1. **Auxiliary windows were treated as editors.** The Windows/Linux exporters
   render offscreen `omd-export-*` windows. `WindowEvent::CloseRequested` called
   `api.prevent_close()` for *every* window, so an exporter's own `window.close()`
   was blocked and waited out the 2 s session-flush timeout for a page that has
   no IPC capability and no flush listener. `all_window_labels` and the menu
   router also iterated them.
2. **A prevented close was dropped.** When a flush round was already running,
   `CloseRequested`/`ExitRequested` returned after preventing the close, so a
   second `Cmd+W`/`Cmd+Q` did nothing.
3. **`restart_app` could become quit.** It flushed, then `request_restart()`,
   which emits `ExitRequested` while editor windows are still open. The old
   `consume_flushed() && webview_windows().is_empty()` guard ignored the marker,
   ran a second round, and that round's finish called `exit(0)`.
4. **Geometry mixed physical and logical units.** `outer_position`/`inner_size`
   report physical pixels; the builder's `position`/`inner_size` take logical
   ones. Restored windows doubled on 2x displays, and a shard saved on an
   unplugged monitor restored fully offscreen.
5. **Authorizations were permanent and partial.** `AUTHORIZED_ROOTS` was a
   process-global list that outlived every window, and
   `list_dir`/`search_markdown`/`list_markdown_files` skipped the check
   entirely — any webview could enumerate and search the disk. Conversely,
   standalone files (opened outside a folder) were never authorized, so version
   history silently failed for them.
6. **Two unrestricted file commands.** `read_file`/`write_file` accepted any
   absolute path; `write_png` was dead. Export pages additionally allowed
   `script-src 'unsafe-inline'`, so a `<script>` in raw Markdown could run.

## Decisions

### Editor vs auxiliary windows

`windows::is_editor_window_label` (`!label.starts_with(EXPORT_WINDOW_PREFIX)`) is
the single predicate. Flush targets, `ExitRequested`, menu routing, and the
focus/destroyed handlers filter through it; `on_window_event` returns **before**
any `prevent_close()` for a non-editor window, which is what makes an export
window close instantaneously. `export_host.rs` builds its label from
`EXPORT_WINDOW_PREFIX` so the classification cannot drift.

### Flush queueing and restart handoff

`FlushGate` (pure, unit-tested without a runtime) gains:

- `queue_window_close(label)` / `queue_app_exit()` / `take_queued_followup()`
  returning `FlushFollowup::{None, AppExit, CloseWindows(Vec<String>)}`. An exit
  supersedes individual closes; labels are deduplicated.
- `mark_restart_flushed()` / `consume_restart_flushed()` with a 5 s TTL, so a
  cancelled restart cannot poison a later quit with a skipped flush.

`app_lifecycle.rs` owns the choreography: `drive_window_close` (flush → remove
shard under `SessionFileLock` → destroy → drain), `drive_app_exit`
(flush all editor windows → `exit(0)`), and `drain_flush_followup`, which every
round's finish calls. Queueing terminates because the first close starts the
next round and the rest re-queue. A queued label whose window is already gone is
skipped instead of waiting out a timeout.

`ExitRequested` checks `consume_restart_flushed()` first, then
`has_editor_windows`, then the one-shot `flushed` marker, and finally
`drive_app_exit`.

### Per-window View menu state

macOS has one global menubar. `MenuState` now keeps
`view_states: HashMap<String, ViewMenuState>` plus the last focused label;
`set_window_view_state` stores the caller's state and repaints only when that
window owns the menubar (it is focused, or no window is recorded yet).
`sync_focused_window` repaints on focus, `drop_window_state` prunes on destroy.
`set_view_menu_state` takes the injected `tauri::WebviewWindow`, so the TS
contract is unchanged.

### Logical window bounds

`window_bounds.rs` owns `WindowBounds { x, y, width, height, logical }`:

- `#[serde(default)] logical` reads legacy shards as physical; conversion
  divides by the window scale exactly once (idempotent for logical input).
- `normalize_and_clamp_bounds` enforces a 400×300 logical minimum and requires a
  120×80 logical titlebar strip to reach some monitor; an unreachable window is
  shrunk to and pinned inside the primary monitor. Negative coordinates on a
  left-hand monitor are preserved.
- `capture_window_bounds` (session save), `apply_bounds` (existing `main`
  window) and `builder_geometry` (new windows, primary scale only) are the only
  entry points.

### Window-scoped authorization

`auth_scope.rs` replaces the global list with
`BTreeMap<String, WindowAuth { roots, files }>`:

- `authorize_workspace_root(window_label, dir)` on `allow_workspace_dir`.
- `authorize_document_file(window_label, file)` after a successful
  `read_document`/`read_document_streaming`/`save_document` and from
  `allow_document_assets`. Canonicalizes the file, or its canonical parent plus
  name when it does not exist yet.
- `revoke_window(label)` in `WindowEvent::Destroyed`.
- `assert_dir_authorized` guards listing, search, quick-open, and every
  mutation; `assert_file_or_workspace_authorized` guards version history
  (workspace root **or** that window's single-document grant).
- Rust-side call sites without a window use the `"test"` scope; a missing label
  never means "anything".

Commands take the injected `tauri::WebviewWindow`, so no TS wire change was
needed. The only frontend change is ordering: `allow_workspace_dir` must land
before `list_dir`, so `appSessionInit.ts` awaits the grant inside its `try`, and
the `workspace.folder` effect authorizes before listing (`revealFolder` therefore
no longer fires a redundant background grant).

### Narrow file commands and hash-pinned export CSP

`scoped_io.rs` replaces `read_file`/`write_file`/`write_png` with
`read_custom_css` (`.css`, ≤1 MiB, regular file, UTF-8) and
`write_exported_html` (`.html`/`.htm`, ≤`MAX_EXPORT_HTML_BYTES`, atomic write).
Both reject relative paths and `.`/`..` components.

`export_host.rs` mints protocol tokens from 128 CSPRNG bits (`getrandom`, with a
clock/pid/counter hash only if the entropy source fails), and its CSP pins
`EXPORT_READY_SCRIPT` by SHA-256 instead of `'unsafe-inline'`. The engine emits
`EXPORT_NATIVE_CSP_META` (hash-pinned) for native renders and
`EXPORT_CSP_META` (`script-src 'none'`) for standalone `.html` files, so macOS
`loadHTMLString` — which has no response headers — is covered too.
`crossLayerConstants.test.ts` recomputes the digest from `readyScript.ts` and
asserts the Rust copy, which is the drift guard for a security boundary.

The app CSP drops `ws:` (Vite dev serves the page itself; production loads from
`tauri://localhost`) and adds `object-src`/`base-uri`/`form-action`/
`frame-ancestors 'none'`.

### Snapshot durability

`workspace/snapshots.rs`:

- Writes go through `crate::atomic_write` (previously `fs::copy`, which could
  leave a half-written `{millis}.md` visible as a restore point).
- `MAX_SNAPSHOT_FILE_BYTES` = 10 MiB per snapshot (refuse instead of copying a
  50 MB document on every autosave) and `MAX_SNAPSHOT_DIR_BYTES` = 50 MiB per
  document directory (evict oldest until both caps fit, always keeping the
  newest).
- The millisecond stamp steps past the newest existing snapshot, so two saves
  inside one millisecond cannot clobber each other.
- Invalid names in the snapshot directory (this module's own abandoned staging
  files) are removed during a write, never during a listing.

`lib.rs::atomic_write` now syncs the parent directory after the rename
(best effort, `not(windows)`), so `session.json`, `settings.json`, recovery
drafts and exports have durable directory entries.

`temp_sweep.rs` removes `.tmp*`, `.omd-save-*.tmp`, `.omd-save-backup` and
`.omd-rename-*` staging files older than an hour from app-owned directories at
setup, and from a document's parent after a successful save.

## Verification

`cargo fmt --check`, `cargo clippy --all-targets -D warnings` (default and
`export-smoke`), 314 Rust unit tests (316 with `export-smoke`), 1 735 engine
tests, 1 301 desktop tests, `pnpm check:quality`, and `pnpm verify` (binary
link). Both growth-frozen files shrank: `lib.rs` 1 624 → 965 lines,
`workspace.rs` 1 737 → 1 544.

## Residual risks

- A window closed after its last flush can still be restored after a crash
  (unchanged, accepted: the shard is removed before destroy).
- Directory `sync_all` is skipped on Windows (the platform cannot open a
  directory handle); NTFS metadata ordering is relied on instead.
- Snapshot directory accounting is a readdir sum, not a lock-protected quota: a
  concurrent snapshot for the same document can exceed the cap transiently.
- `read_document` still accepts any path the frontend asks for; opening is the
  user's dialog/CLI/drag-drop capability, and only the *stored* grant is scoped.

## Related

- [`../../memory/gotchas-rust.md`](../../memory/gotchas-rust.md) — the traps this
  design removes (auxiliary windows, prevented closes, unit mixing, per-window
  grants, hash-pinned CSP).
- [`../../../apps/desktop/src-tauri/AGENTS.md`](../../../apps/desktop/src-tauri/AGENTS.md)
  — the mandatory rules extracted from this design.
- [`../../manual-qa.md`](../../manual-qa.md) — the multi-window matrix that
  covers the user-visible half.
