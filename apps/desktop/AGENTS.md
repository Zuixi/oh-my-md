# Desktop Domain

> **Parent:** [`../../AGENTS.md`](../../AGENTS.md)
>
> **Scope:** React application lifecycle, CodeMirror host assembly, desktop styles, file dialogs, image paste, and the Tauri Rust host.

## Read This When

- You are changing `apps/desktop/src/**`.
- You are changing native commands, capabilities, or packaging under `apps/desktop/src-tauri/**`.
- You are debugging behavior that crosses React, CodeMirror, CSS, and Tauri IPC.

## Local Structure

```text
apps/desktop/
├── src/
│   ├── App.tsx              # Shell: files/export chrome, tabs, palette, search, session IO
│   ├── constants.ts         # TS↔Rust contract values + localStorage keys (drift-tested)
│   ├── shortcuts.ts         # Single source for command shortcut display + window key bindings
│   ├── transientStatus.ts   # Shared transient-status timer for save/normalization status lines
│   ├── fileTreeState.ts     # Sticky-root file tree: expand cache and visible rows
│   ├── FileTree.tsx         # Sidebar tree with Lucide icons
│   ├── session.ts           # EditorSession: path, dirty baseline, documentId
│   ├── workspace.ts         # Tab list, active tab, folder root
│   ├── Editor.ts            # Generic CM6 extensions, engine assembly, base theme
│   ├── imagePaste.ts        # Clipboard image → Tauri write_image → Markdown insertion
│   ├── normalizationState.ts    # Per-tab pending notice projection (pure reducers)
│   ├── normalizationCoordinator.ts  # Accept/reject/save orchestration, autosave gate
│   ├── NormalizationBanner.tsx  # Non-modal review banner + live region host
│   ├── documentSaveState.ts     # Per-tab save lifecycle + divergence reducer
│   ├── documentSaveCoordinator.ts  # canAutosave, topBanner, watcherIntent
│   ├── documentSaveRunner.ts    # Guarded save queue, poll, saveCopy
│   ├── documentSaveAppBridge.ts # App wiring for save runner
│   ├── conflictActions.ts       # Conflict action orchestration (compare/reload/overwrite/…)
│   ├── conflictSaveBinding.ts   # React hook: diff state + makeConflictActions deps
│   ├── ConflictSaveRegion.tsx   # Conflict/saveFailed banner + DocumentDiffPanel host
│   ├── SaveConflictBanner.tsx   # Non-modal conflict action buttons
│   ├── DocumentDiffPanel.tsx    # Read-only unified diff panel
│   ├── documentDiff.ts          # unifiedDiff for conflict compare
│   ├── main.tsx             # React mount
│   └── styles.css           # App styles, theme variables, and omd-* presentation
└── src-tauri/
    ├── src/lib.rs           # File IO, image write, asset scope, workspace commands, open-file events
    ├── src/export.rs        # PDF/PNG path checks and WKWebView capture
    ├── src/menu.rs          # Native File / Edit application menu
    ├── src/watcher.rs       # notify watcher: workspace-changed events (hint-only)
    ├── src/workspace.rs     # workspace tree commands, search, quick-open list, snapshots, config/recovery state
    ├── capabilities/        # Tauri permissions
    └── tauri.conf.json      # Desktop application configuration
```

## Frontend Boundaries

1. React owns application state and lifecycle; do not put React state or hooks in `@omd/engine`.
2. `Editor.ts` owns generic editing behavior and the base editor theme. Markdown language support and preview behavior must come from `editorExtensions`.
3. Do not duplicate Lezer traversal or Markdown syntax recognition in the desktop layer.
4. Engine-generated `omd-*` classes are styled in `styles.css`. Coordinate class changes with the engine in the same task.
5. Native filesystem effects must use narrow Tauri commands. Browser-side code may select paths and orchestrate calls, but must not emulate native path/file operations.
6. Keep `App.tsx` as the current default-export exception; use named exports for ordinary modules.
7. The i18n store lives in `apps/desktop/src/i18n/` (desktop-owned). Components use `useT()`; non-component modules use the module-level `t` (reads live locale at call time). The engine must NOT import the i18n store — localized engine strings (e.g. the broken-image fallback) are host-injected via `EngineOptions` Facet functions, preserving "引擎框架无关".
8. User-visible feedback goes through `services.reportError` / `services.notifySuccess` (toast-backed via react-toastify; container mounts only in `main.tsx`); never call `window.alert` directly in desktop code.

## CodeMirror Host Rules

- Do not enable `indentOnInput`, `closeBrackets`, or generic `autocompletion`; current live-preview decorations conflict with them. Emoji `:` completion comes from `editorExtensions`.
- Preserve history, selection drawing, drop cursor, active-line highlighting, and standard editing keymaps unless the task explicitly changes host behavior.
- Selection drawing is the vendored tight-selection extension (`src/tightSelection.ts`), not stock `drawSelection()` from `@codemirror/view`: multi-line highlights stop at each line's text end (+ `NUB_PX`) instead of running to the content right edge. Do not re-add stock `drawSelection()`, and re-diff the vendored geometry against upstream whenever `@codemirror/view` is bumped.
- Block decorations must not have vertical margins: CodeMirror excludes them from its height map, so the error accumulates until clicks target another line. Put visual spacing in wrapper padding and keep borders/overflow on `.omd-block-body`; `test/blockWidgetLayout.test.ts` guards the rule.
- Pass host-dependent behavior through engine options, such as resolving Markdown image sources to loadable URLs.
- Destroy `EditorView` during React cleanup and clear retained references.
- Window-level shortcuts must use stable listeners and refs to observe current mutable state without re-registering on each render.
- CodeMirror's keymap owns editing commands; window handlers should be limited to application-level commands such as open/save/command palette.
- Do not enable generic `autocompletion()`; ⇧⌘P is the command palette, and ⌘K is the engine's Markdown insert-link binding (live preview), not a CM completion or a window-level command.
- Replace an opened document with a fresh `EditorState`; synchronize the document path first so initial image resolution is correct and undo history cannot cross files.

## Ordered-list normalization (desktop)

1. `Editor.ts` binds each `EditorView` to a stable tab id and document id. Document-update callbacks carry the ids captured at view creation, not the currently active tab.
2. Before resetting a view for open/reload/restore, commit a bumped `documentId` to the tab session, then reset with that new id. Never reset before the identity bump — stale updates from the old view must be ignored. If reset throws, roll back session refs and projection.
3. While a tab has pending normalization, pause autosave to the on-disk path for that tab only; recovery writes to the crash-recovery directory continue on real document edits.
4. Accepting normalization runs through the explicit save queue (banner **Save normalization** or Cmd+S). Successful save dispatches `acceptOrderedListNormalization`; Save As cancel and save failure leave pending and re-sync idle banner state.
5. Reject dispatches only to the captured target view after re-validating tab, document, view, and notice id. Command completion must call `resyncNormalizationIdle` only after the same identity checks — the reducer does not validate ids itself.
6. `normalizationCoordinator.ts` owns accept/reject/save wiring; keep `App.tsx` under the file-size budget by extending the coordinator instead of inlining orchestration.

## Conflict-safe guarded save (desktop)

1. **Markdown document IO only through guarded IPC.** Open/read/save/version-probe must use `readDocument`, `readDocumentVersion`, and `saveDocument` (Rust: `read_document`, `read_document_version`, `save_document`). Do not call legacy `read_file` / `write_file` for editor documents. Export, recovery, and image writes use their own commands and paths.
2. **Watcher is early notification, not the truth boundary.** File-tab polling compares opaque disk fingerprints via `readDocumentVersion`; correctness comes from Rust double-compare at save time. Never treat a poll result as permission to overwrite.
3. **Session baseline updates atomically.** On `Saved` only, update the tab's on-disk version/fingerprint and clean baseline together through `documentSaveState` reducers. Conflict, save failure, and stale completions must not clear recovery or bump baseline.
4. **Single autosave gate.** `canAutosave` in `documentSaveCoordinator.ts` is the only autosave entry point (conflict, saveFailed, pending normalization, opening, and per-tab queues). Do not add parallel autosave checks in React effects.
5. **Conflict UI is non-modal.** `SaveConflictBanner` + `ConflictSaveRegion` host compare/reload/overwrite/save-copy/recreate actions. `Compare` opens a debounced read-only unified diff (`DIFF_RECOMPUTE_MS = 150` in `ConflictSaveRegion.tsx`). Path-changed and unexpected-symlink conflicts disable compare/overwrite.
6. **Normalization coexistence.** While a tab is in conflict or saveFailed, pending normalization stays visible but autosave to the on-disk path stays paused. Overwrite/recreate/successful guarded save may accept normalization; save copy and reload/discard clear stale pending per plan 01 rules.
7. **Orchestration lives outside `App.tsx`.** Extend `conflictActions.ts`, `conflictSaveBinding.ts`, or `documentSaveRunner.ts` rather than growing the shell component.

## Large-document tiers (Spec 05b + 2026-08-20 progressive rendering)

- Scale policy no longer forces source mode: over-scale docs open in Live with safe mode = render budget (`SAFE_MODE_RENDER_BUDGET_LINES` = 60) + windowed live decorations + on-demand stats + viewport-bounded ordered renumber. All applied through `applyDocumentScalePolicy` in `App.tsx` — every path that first hands a view real content must call it.
- The HUGE tier (≥ `OPEN_READONLY_THRESHOLD_BYTES`) also renders live, with `readOnly: true`. CodeMirror readOnly is advisory: engine keymaps, renumber dispatches, widget interactions, and paste handlers guard `state.readOnly` themselves (guard suite `packages/engine/test/readonly-guards.test.ts`; gotchas entry "CodeMirror `readOnly` is advisory").
- Outlines are per-tab cached (`docVersionsRef` / `outlineCacheRef` in `App.tsx`): tab switches hit the cache (version-checked), and over-scale tabs return immediately with the outline filled from an idle callback.
- LARGE opens stream (`readDocumentStreaming`) and assemble chunks into a CM `Text` directly (engine `docText.ts`; App's `docTextsRef` stash carries it to `ensureViews`/`resetTabDocument`), so `EditorState.create` skips the full-string line split. Streaming failure falls back to one-shot `readDocument`.
- Version probing is stat-first: `stat_document` tiers opens before any read, and Rust's `DocumentVersionCache` (`(mtime_ns, size) → fingerprint`) lets background polls of unchanged 50MB tabs skip the read entirely (`src-tauri/src/documents.rs`).

## Tauri and File Rules

Current Rust commands are:

- `read_document(path)` — read Markdown as UTF-8 with typed `DiskSnapshot` (missing or existing + opaque version).
- `stat_document(path)` — metadata-only probe (`missing` / `existing` + `sizeBytes`); used to tier opens (normal / LARGE stream / HUGE read-only) before any content read (Spec 05b).
- `read_document_streaming(path, onEvent)` — LARGE-tier open: chunk events (`{ kind: "chunk", index, text }`, 512 KiB UTF-8-aligned) plus byte progress over a Tauri channel; the frontend assembles chunks into a CM `Text` (engine `docText.ts`) and falls back to `read_document` on failure.
- `read_document_version(path)` — fingerprint probe only; used by watcher and pre-save checks. Stat-first: a `(mtime_ns, size)` cache hit returns the last fingerprint without reading (`DocumentVersionCache`).
- `save_document(path, contents, expected)` — guarded save with double-compare; returns typed `SaveDocumentResult` (saved, content/deleted/created/path-changed/unexpected-symlink conflict, permission/metadata/internal errors).
- `read_file(path)` — legacy UTF-8 read; not for editor document lifecycle.
- `write_file(path, contents)` — legacy atomic replace; not for editor document saves.
- `write_image(path, base64, documentPath)` — decode pasted image data into the current document's `assets/` directory. `documentPath` is required.
- `allow_document_assets(documentPath)` — grant the asset protocol access to that document's directory.
- `allow_workspace_dir(path)` — grant the asset protocol access to an opened folder root and authorize later create/rename/delete under that root.
- `list_dir(path)` — list directories and Markdown files in one folder (no `..`). The sidebar tree keeps a sticky workspace root and calls this per expanded directory.
- `search_markdown(root, query, case_sensitive)` — parallel scan of `.md` files under the folder (ripgrep `ignore` + `regex` crates). Returns `SearchResponse { hits, truncated }`; each `SearchHit` carries UTF-16 code-unit offsets `start`/`end` into a possibly truncated `text`. Case-insensitive by default; skips hidden files, `.gitignore`, non-UTF-8, and files over 5 MB; caps at 500 hits with `truncated=true`.
- `create_markdown(dir, name)` — create a new empty `.md` file under an authorized workspace root without overwriting.
- `create_dir(dir, name)` — create a new empty subdirectory under an authorized workspace root without overwriting.
- `rename_path(from, toName)` — rename a file or directory within its current parent under an authorized workspace root; Markdown files must keep `.md`.
- `delete_path(path)` — delete a file or an empty directory under an authorized workspace root.
- `write_recovery` / `list_recoveries` / `read_recovery` / `clear_recovery` — crash-recovery drafts under `OMD_RECOVERY_DIR` or the temp recovery directory.
- `write_png(path, base64)` — write raw PNG bytes. Path must end in `.png` and the bytes must be PNG.
- `export_preview(html, path, format)` — render exported HTML in an offscreen WKWebView, then write PDF (`createPDF`) or PNG (same PDF, rasterized). `format` is `"pdf"` or `"png"`. Missing `.pdf`/`.png` is appended; an existing directory is rejected. macOS only.
- `set_recent_files(paths)` — rebuild the Open Recent submenu (max 10, no traversal).
- `set_view_menu_state(state)` — mirror the frontend view-mode state (source/sidebar/outline/typewriter/focus) into the checkable View menu items (`CheckMenuItem::set_checked` on stable ids).
- `set_menu_locale(locale)` — update managed `MenuState.locale` and rebuild the native menu (zh/en; unknown → en). Called by the frontend `initLocale`/`setLocale`; single-field IPC (`{ locale }`), no multi-word casing trap.
- `set_window_theme(theme)` — push the resolved app theme onto the native window (`"light"`/`"dark"`; `null` = system-follow) so the title bar matches the in-app toggle. Deliberately sync (window mutation belongs on the main thread, like the menu setters). Called from the App theme effect via `desktopServices.setWindowTheme`, gated on initial settings load; the Rust `setup` hook also applies the persisted theme pre-paint (`startup_window_theme` reads `settings.json`) so cold start doesn't flash the OS appearance (tauri-apps/tauri#6027).
- `quit_app()` / `app_version()` — explicit quit and About-dialog version for the in-app menubar on Windows/Linux (macOS covers both with the native app menu).

The native menu (`menu.rs`) has File / Edit / Format / View / Window top-level menus and only installs as a menubar on macOS (`rebuild_from_state` early-returns off macOS). Item clicks emit `menu-command` to the webview, except the `window-*` items which are handled natively in Rust (`handle_window_command`) and never forwarded. Do not use `PredefinedMenuItem` for window actions — their macOS selectors go through the responder chain and do not act on the Tauri window. Do not reimplement those actions as sidebar buttons.

Off macOS the menu is the in-app horizontal menubar (`AppMenu.tsx` above the TopBar, one dropdown per top-level menu defined in `menuTree.ts`: File / Edit / Format / View / Help). It dispatches the same ids through `runMenuCommand`; `test/crossLayerMenu.test.ts` guards `menu.rs` ids ⊆ `menuTree.ts` ids. View toggles render as `menuitemcheckbox` from the `viewState` prop; `undo/redo/cut/copy/paste/select-all/quit/about` commands exist only in the webview layer (the clipboard ones are best-effort `navigator.clipboard` — Ctrl+C/X/V through the editor stay primary).

**Shortcut wiring is single-sourced and drift-guarded.** Window-level shortcuts live only in `shortcuts.ts` `WINDOW_SHORTCUTS` — the same table feeds the command palette display and the `App.tsx` keydown dispatch. Format/mode shortcut labels come from the engine (`markdownShortcutLabels`/`toggleShortcutLabels`) so the palette cannot drift from the CM keymap. `EDIT_SHORTCUT_BINDINGS` (undo/redo/cut/copy/paste/select-all) is display-only — the keys themselves are owned by the editor's default keymap, so those bindings must never enter `WINDOW_SHORTCUTS` or they would double-fire. Native menu item ids and accelerators must match `commands.ts` `MENU_TO_COMMAND` and the shortcut labels (window or engine format); `test/crossLayerMenu.test.ts` parses `src-tauri/src/menu.rs` (both `item(` and `check_item(`) and guards all. Note that macOS menu accelerators intercept keys before the webview, so a menu accelerator for an engine shortcut (e.g. ⌘E) makes the App command the only live path on the desktop. When adding or changing a shortcut, touch the single source and let the tests verify — never add a second literal.

When adding or changing a command:

1. Keep the IPC entrypoint thin and return `Result<_, String>` or a deliberately introduced shared error shape.
2. **Update both sides of the wire in the same change.** Any signature change (added/removed/renamed argument, changed return shape) must touch the Rust command, the `desktopServices.ts` invoke caller, and every TS consumer together. Leaving the frontend on the old contract makes Tauri reject the call (missing/extra arg) or the UI read the wrong shape silently — TypeScript compiles fine, and desktop tests mock services at the TS boundary, so they never catch it. Concrete failure: `search_markdown` gained `case_sensitive` and returned `SearchResponse` while `desktopServices.ts` still invoked `{ root, query }` and typed the result as `SearchHit[]` — folder search stopped working until both sides were aligned.
3. Validate frontend argument names against the Rust command signature (Tauri maps snake_case Rust params to camelCase JS keys).
4. Register the command in `tauri::generate_handler!`.
5. Check whether Tauri capabilities or plugins must change.
6. Add Rust tests for native behavior and failure paths.
7. For any payload with multi-word fields, add a Rust test asserting the **serialized JSON field names** (see IPC casing trap below).
8. **Shared limits stay in sync across the wire.** Limits that both sides enforce (image bytes, recent-files cap, search hit cap, markdown extensions, `assets` dir, `.md` create/rename rule) are named constants on each side — `apps/desktop/src/constants.ts` and the Rust `lib.rs`/`workspace.rs` — guarded by `apps/desktop/test/crossLayerConstants.test.ts`, which parses the Rust const definitions and asserts equality. Never change one side's literal without the other and the test.

**IPC casing trap (verified 2026-08-14).** `#[serde(tag = "kind", rename_all = "camelCase")]` on a Rust enum camelCases only the *variant names*, never fields inside struct variants — those need their own variant-level `#[serde(rename_all = "camelCase")]` (see `SaveDocumentResult` for the correct pattern). `DiskSnapshot` once relied on the enum-level attribute, so `read_document` sent `requested_path` while the webview read `requestedPath`; every opened file silently became an "unnamed" tab. TypeScript gives no protection: `snapshot.requestedPath` compiles fine and is `undefined` at runtime, and desktop tests mock `services.readDocument` at the TS boundary so they can never catch wire-format drift. Only a Rust-side `serde_json::to_string` assertion (e.g. `disk_snapshot_serializes_requested_path_as_camel_case`) guards the contract.

**Sync-command trap (verified 2026-08-19).** Non-`async` `#[tauri::command]` fns run on the Rust main thread and serialize behind each other; an IO-bound sync command (a 50MB `write_recovery` `fs::write`) stalls every queued command — `openPath` awaited `allow_document_assets` *after* the read succeeded, so the file was in hand and never displayed. IO-bound commands must be `async fn` + `tauri::async_runtime::spawn_blocking` (in-memory-only commands may stay sync; menu mutation must stay on the main thread, which is why `set_recent_files` is exempt — its rebuild is macOS-only).

Do not silently overwrite in-memory content after a failed read/write. Preserve the current document and surface the error. Do not add unconditional force-write APIs for conflict paths.

## Image Paste Invariants

- Non-image clipboard content must fall through to CodeMirror's default paste behavior.
- The document must have a saved path before inserting a relative `assets/...` reference.
- Write image bytes successfully before inserting Markdown into the document.
- Keep the stored Markdown path relative; resolve it for display through the engine host callback rather than rewriting source to an absolute file URL.
- Path handling must continue to account for slash normalization on supported desktop paths.
- Capture path, document identity, document value, and selection before asynchronous work. Serialize concurrent pastes and revalidate before writing and dispatching.
- Pass the current Markdown path as `documentPath` so Rust can bind the write to that document's `assets/` directory. The command rejects writes that omit it.
- After a successful open or save, call `allow_document_assets` before the first local image load.

## Verification

For TypeScript/React/CSS changes:

```sh
pnpm --filter @omd/desktop build
```

For engine behavior used by the desktop:

```sh
pnpm test
```

For Rust/Tauri command changes:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Use `pnpm dev` for manual interaction checks. Review the relevant sections of `docs/manual-qa.md`, especially file IO, IME, undo/redo, mode switching, and large-document scrolling.

## Common Pitfalls

- React state captured by a one-time window listener becomes stale; route changing handlers through refs.
- Dirty state is transaction-driven and compared with the last saved/opened text, so undoing to that baseline becomes clean again.
- Engine class names without matching CSS appear structurally correct in tests but broken in the desktop.
- Tauri dialog cancellation is a normal result, not an error.
- Image writing and Markdown insertion are asynchronous; inserting before a successful write or allowing concurrent operations to race creates broken or orphaned assets.
- Static window values in `tauri.conf.json` and runtime window behavior can drift if both are later used.
- Hidden iframe `print()` and `html-to-image` fail in WKWebView; PDF/PNG export must go through `export_preview`. Do not use `takeSnapshot` with `afterScreenUpdates` on an offscreen window — WindowServer never presents it, so the completion never fires and no file is written.

## Documentation Maintenance

Before concluding desktop work, check:

- [ ] Did the frontend/Rust ownership boundary or command list change?
- [ ] Did an `omd-*` class require a coordinated engine or CSS update?
- [ ] Did user-visible interaction require a `docs/manual-qa.md` update?
- [ ] Did a reusable integration trap belong in `docs/memory/known-gotchas.md`?
- [ ] Did setup, packaging, or supported behavior require README/spec updates?
