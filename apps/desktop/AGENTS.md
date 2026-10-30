# Desktop Domain

> **Parent:** [`../../AGENTS.md`](../../AGENTS.md)
> **Scope:** Desktop assembly and tests (`apps/desktop/**`). Frontend-specific rules below apply to React/CodeMirror code; native implementations additionally use the Rust guide.
> **Rust / Tauri host rules:** See [`src-tauri/AGENTS.md`](./src-tauri/AGENTS.md).

## Local Structure

```text
apps/desktop/
├── src/
│   ├── App.tsx                  # Shell wiring (growth-frozen: put new logic in focused modules)
│   ├── main.tsx                 # React mount + single react-toastify container
│   ├── Editor.ts                # CM6 host assembly, engine options, link activation, status reporter
│   ├── tightSelection.ts        # Vendored tight selection drawing (never re-add stock drawSelection)
│   ├── styles.css               # Theme tokens (--omd-*), color-scheme, and omd-* presentation
│   ├── constants.ts             # TS↔Rust shared limits and localStorage keys (drift-tested)
│   ├── desktopServices.ts       # All Tauri invoke/listen callers (wire boundary)
│   ├── platform.ts              # The ONLY platform branch in TS (unknown → macOS)
│   ├── shortcuts.ts · commands.ts · menuTree.ts  # Single-sourced shortcuts and menu command mapping
│   ├── i18n/                    # useT() for components, module-level t() elsewhere
│   ├── clipboardPaste.ts · clipboardPayload.ts · pasteAssets.ts · pasteBookmark.ts · pasteJob.ts
│   ├── imagePaste.ts · pastePlainText.ts         # Image drop/picker & plain-text paste
│   ├── documentMaterializer.ts · documentScaleRegistry.ts · editorStatus.ts · editorStatusStore.ts
│   ├── documentSave*.ts · conflict*.ts · documentDiff.ts · normalization*.ts
│   ├── updateCoordinator.ts · updateRestartReadiness.ts · updateAdapter.ts
│   ├── findReplace.ts · currentDocumentSearch.ts · searchCountJob.ts · useWorkspaceSearch.ts
│   ├── session.ts · sessionRestore.ts · workspace.ts · recoveryWriter.ts · fileTreeState.ts
│   └── *.tsx                    # Focused UI components (TopBar, StatusBar, FileTree, Modals, Banners)
└── src-tauri/                   # Rust backend (see src-tauri/AGENTS.md)
```

## Frontend & Module Boundaries

1. **Keep `App.tsx` thin (growth-frozen):** Put state machines, coordinators, and IO workflows in dedicated modules (`*Coordinator.ts`, `*Runner.ts`, `pasteController.ts`); apply the root size policy rather than adding orchestration to the shell.
2. **Hot-path performance (`documentMaterializer.ts`, `editorStatusStore.ts`):** `EditorDocumentUpdate` never carries a full document string. Pull `view.state.doc.toString()` on the 250ms trailing materializer cadence and flush before save/close/delete. Route cursor/mode updates through `editorStatusStore` (`sameEditorStatus` deduplicated).
3. **Feedback & i18n:** Route user notifications through `services.reportError` / `services.notifySuccess` (never call `window.alert` directly; rate-limit per-change recovery errors in `recoveryWriter.ts`). Keep i18n in desktop (`useT` / `t`) and pass localized labels to the engine via `EngineOptions`.
4. **Multi-window safety:** Scope window-targeted Tauri listeners (`menu-command`, `open-file`, `session-flush`) with `listenTarget()` (`AnyLabel`) in `desktopServices.ts`. Gate `restoreDraft()` on `windowScope.isMainWindow()`, while `restoreSavedSession()` runs per window shard.

## CodeMirror Host & CSS Rules (`Editor.ts`, `tightSelection.ts`, `styles.css`)

- **No stock `drawSelection()`, `closeBrackets`, `indentOnInput`, or `autocompletion()`:** Mount vendored `tightSelection()` (guarded by version/geometry tests in `test/tightSelection.test.ts` — account for `.cm-content` 16px/24px padding and `view.documentTop`).
- **Keep `highlightActiveLine()` mounted** with `.editor-host .cm-content .cm-activeLine { background: transparent }` in `styles.css` (required by focus mode `.cm-line:not(.cm-activeLine)`). Repaint `.cm-line.omd-codeblock.cm-activeLine` background and `.cm-line.omd-blockquote.cm-activeLine` `--omd-bq-image` quote bar.
- **No vertical margins on `.omd-block`:** Use wrapper vertical padding and put borders/overflow on `.omd-block-body` (`test/blockWidgetLayout.test.ts`).
- **Theme via CSS variables only:** Never enable CodeMirror's `{ dark: true }` facet. Drive selection and caret colors from `--omd-selection-bg` and `--omd-cursor`, declare `color-scheme` on every theme block in `styles.css`, quote font names via `settings.ts::cssFamily`, and sync native window appearance via `setWindowTheme` only after initial settings load.
- **Read-only is advisory:** Guard document-changing commands and asset writes with `view.state.readOnly`; selection/status-only transactions remain permitted.
- **View lifecycle (`Editor.ts`, `App.tsx`):** Open/reload uses a fresh `EditorState`, with the path synchronized before initial image resolution; undo history must not cross documents. Destroy views and clear retained references on cleanup. Keep window listeners stable and read changing state through refs.

## Shortcuts, Paste & Image Handling

- **Shortcut single source (`shortcuts.ts`, `commands.ts`):** `WINDOW_SHORTCUTS` drives both palette labels and `App.tsx` window keydown dispatch. Editor-owned bindings (`undo`, `redo`, `cut`, `copy`, `paste`, `pastePlainText`, `select-all`) belong in `EDIT_SHORTCUT_BINDINGS` (display/drift-only, never `WINDOW_SHORTCUTS` to avoid double-fire). Guarded by `test/crossLayerMenu.test.ts`.
- **Paste & image invariants (`clipboardPaste.ts`, `pasteAssets.ts`, `imagePaste.ts`, `Editor.ts`):**
  - `clipboardPasteExtension` is the single rich-paste event owner (captures macOS context-menu target, reads clipboard payloads, runs engine `prepareSmartPaste`/`planSmartPaste`); `imagePasteHandler` handles image drag-and-drop and the file picker.
  - Write pasted image batches via `write_paste_assets` → `commit_paste_assets` / `discard_paste_assets` (requires saved `documentPath` and grants asset scope before inserting relative `assets/...` Markdown).
  - Serialize per-view async paste operations via `pasteJob.ts`, capture/revalidate `tabId`, `documentId`, and selection ranges, and always pass an explicit `selection: { anchor }` on custom `view.dispatch` calls (prevents `assoc = -1` leaving the caret before the insert).

## Guarded Save, Scale Tiers & Updates

- **Guarded document IO & single autosave gate:** Use only `statDocument`, `readDocument`, `readDocumentStreaming`, `readDocumentVersion`, and `saveDocument`. Gate all autosaves through `documentSaveCoordinator.ts::canAutosave` (paused during conflict, save failure, or pending ordered-list normalization). Update session baseline atomically on `Saved` only.
- **Identity before reset (`App.tsx::resetTabDocument`):** Keep tab ids stable, bump `documentId` for a new/reloaded document, and commit that identity before resetting the view. Roll back session/projection on reset failure; discard pending materialization after successful reset. Update callbacks carry their captured identities, never the active tab's.
- **Async completion (`normalizationCoordinator.ts`, `documentSaveRunner.ts`):** Revalidate tab, document, view, and normalization notice via the existing target guards before dispatch or UI resync. Accept normalization only after a successful explicit save; cancellation/failure keeps it pending. Recovery continues while normalization pauses disk autosave. Old save completions must not clear newer edits, recovery, or dirty state.
- **Conflict boundary:** Watcher/poll results are hints, not permission to overwrite; Rust's guarded save owns the final compare. Use save-state reducers to update version and clean baseline together for the same document, preserving edits made during the save.
- **Large-document scale policy (`documentScaleRegistry.ts`):** Call `applyDocumentScalePolicy` in both `resetTabDocument` and `ensureViews`. Only the active tab (`tabId === activeId`) may push process-global `setBlockRenderBudget` / `setSafeModeRendering`.
- **Updater (`updateCoordinator.ts`, `updateRestartReadiness.ts`):** Never silent or automatic. Both `requestInstall()` and `install()` run the session-flush and readiness gate (`dirty`, `conflict`, `saveFailed`, `pendingNormalization`, `opening`, `saving` block install).

## Verification

```sh
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
PW_PORT=9431 pnpm --filter @omd/desktop test:e2e
```

- Let Playwright start and stop Vite in the foreground (use a free `PW_PORT` per worktree; never run `pkill chrome`).
- For engine-owned behavior, also read the corresponding [engine guide](../../packages/engine/AGENTS.md) and run its checks. For IPC changes, follow [Rust verification](./src-tauri/AGENTS.md#verification) as well.
