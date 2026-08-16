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
    ├── src/lib.rs           # File IO, image write, asset scope, workspace commands
    ├── src/export.rs        # PDF/PNG path checks and WKWebView capture
    ├── src/menu.rs          # Native File / Edit application menu
    ├── src/workspace.rs     # workspace tree commands, search, crash-recovery files
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

## CodeMirror Host Rules

- Do not enable `indentOnInput`, `closeBrackets`, or generic `autocompletion`; current live-preview decorations conflict with them. Emoji `:` completion comes from `editorExtensions`.
- Preserve history, selection drawing, drop cursor, active-line highlighting, and standard editing keymaps unless the task explicitly changes host behavior.
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

## Tauri and File Rules

Current Rust commands are:

- `read_document(path)` — read Markdown as UTF-8 with typed `DiskSnapshot` (missing or existing + opaque version).
- `read_document_version(path)` — fingerprint probe only; used by watcher and pre-save checks.
- `save_document(path, contents, expected)` — guarded save with double-compare; returns typed `SaveDocumentResult` (saved, content/deleted/created/path-changed/unexpected-symlink conflict, permission/metadata/internal errors).
- `read_file(path)` — legacy UTF-8 read; not for editor document lifecycle.
- `write_file(path, contents)` — legacy atomic replace; not for editor document saves.
- `write_image(path, base64, documentPath)` — decode pasted image data into the current document's `assets/` directory. `documentPath` is required.
- `allow_document_assets(documentPath)` — grant the asset protocol access to that document's directory.
- `allow_workspace_dir(path)` — grant the asset protocol access to an opened folder root and authorize later create/rename/delete under that root.
- `list_dir(path)` — list directories and Markdown files in one folder (no `..`). The sidebar tree keeps a sticky workspace root and calls this per expanded directory.
- `search_markdown(root, query)` — scan `.md` files under the folder for a string.
- `create_markdown(dir, name)` — create a new empty `.md` file under an authorized workspace root without overwriting.
- `create_dir(dir, name)` — create a new empty subdirectory under an authorized workspace root without overwriting.
- `rename_path(from, toName)` — rename a file or directory within its current parent under an authorized workspace root; Markdown files must keep `.md`.
- `delete_path(path)` — delete a file or an empty directory under an authorized workspace root.
- `write_recovery` / `list_recoveries` / `read_recovery` / `clear_recovery` — crash-recovery drafts under `OMD_RECOVERY_DIR` or the temp recovery directory.
- `write_png(path, base64)` — write raw PNG bytes. Path must end in `.png` and the bytes must be PNG.
- `export_preview(html, path, format)` — render exported HTML in an offscreen WKWebView, then write PDF (`createPDF`) or PNG (same PDF, rasterized). `format` is `"pdf"` or `"png"`. Missing `.pdf`/`.png` is appended; an existing directory is rejected. macOS only.
- `set_recent_files(paths)` — rebuild the Open Recent submenu (max 10, no traversal).
- `set_menu_locale(locale)` — update managed `MenuState.locale` and rebuild the native menu (zh/en; unknown → en). Called by the frontend `initLocale`/`setLocale`; single-field IPC (`{ locale }`), no multi-word casing trap.

The native File menu (New, Open, Open Folder, Open Recent, Close, Save, Save As, Export HTML/PDF/Image) emits `menu-command` to the webview. Do not reimplement those actions as sidebar buttons.

When adding or changing a command:

1. Keep the IPC entrypoint thin and return `Result<_, String>` or a deliberately introduced shared error shape.
2. Validate frontend argument names against the Rust command signature.
3. Register the command in `tauri::generate_handler!`.
4. Check whether Tauri capabilities or plugins must change.
5. Add Rust tests for native behavior and failure paths.
6. For any payload with multi-word fields, add a Rust test asserting the **serialized JSON field names** (see IPC casing trap below).

**IPC casing trap (verified 2026-08-14).** `#[serde(tag = "kind", rename_all = "camelCase")]` on a Rust enum camelCases only the *variant names*, never fields inside struct variants — those need their own variant-level `#[serde(rename_all = "camelCase")]` (see `SaveDocumentResult` for the correct pattern). `DiskSnapshot` once relied on the enum-level attribute, so `read_document` sent `requested_path` while the webview read `requestedPath`; every opened file silently became an "unnamed" tab. TypeScript gives no protection: `snapshot.requestedPath` compiles fine and is `undefined` at runtime, and desktop tests mock `services.readDocument` at the TS boundary so they can never catch wire-format drift. Only a Rust-side `serde_json::to_string` assertion (e.g. `disk_snapshot_serializes_requested_path_as_camel_case`) guards the contract.

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
