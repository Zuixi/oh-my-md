# Smart Paste Host Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every desktop paste entry through one clipboard controller, preserve asynchronous targets/assets safely, and atomically replace Turndown with the reviewed engine importer.

**Architecture:** Desktop acquires DOM or system clipboard flavors into one `ClipboardPayload`, owns image persistence and mapped paste jobs, and calls the pure engine importer. One CodeMirror extension replaces the current competing engine HTML handler plus desktop image/text handler; native/app menus invoke the same controller. A real-platform capability gate decides whether a separate native clipboard adapter is required.

**Tech Stack:** TypeScript, CodeMirror 6 StateField/StateEffect, React 19, Clipboard API, Vitest, Playwright, Tauri 2/Rust for paste-asset persistence.

**Spec:** `docs/superpowers/specs/2026-10-30-smart-paste-semantic-import-design.md`

## Global Constraints

- Desktop owns Clipboard API and host assets; engine owns HTML/Markdown semantics.
- Normal Paste and Paste as Plain Text are different commands with different payload policy.
- Image bytes are written successfully before Markdown references are inserted.
- Async completion revalidates view, tab, document ID, readOnly, and mapped selection.
- One completed paste dispatches one `input.paste` transaction and one undo step.
- Multi-range paste remains CodeMirror plain-text behavior.
- Window handlers stay stable and read mutable state through refs.
- Native menu IDs/accelerators, `commands.ts`, `shortcuts.ts`, palette, and AppMenu remain drift-guarded.
- Do not add a platform-specific branch outside `platform.ts` or Rust `cfg!(target_os = …)`.
- Do not delete Turndown until the cutover gate passes.
- Keep `App.tsx` and Rust `lib.rs` as thin wiring only. New controller logic lives in focused desktop modules; batch asset validation/state lives in a dedicated Rust module rather than enlarging either existing hotspot.

## File Map

- Create `apps/desktop/src/clipboardPayload.ts`: DOM/system flavor acquisition.
- Create `apps/desktop/src/pasteBookmark.ts`: mapped asynchronous target field.
- Create `apps/desktop/src/clipboardPaste.ts`: single controller and CM extension.
- Create `apps/desktop/src/pasteAssets.ts`: embedded asset persistence/cleanup adapter.
- Keep image drop/file-picker behavior in `imagePaste.ts`; move paste-event ownership out.
- Remove engine `htmlPaste()` registration only at the final cutover task.

---

### Task 1: Clipboard capability spike and payload readers

**Files:**
- Create: `apps/desktop/src/clipboardPayload.ts`
- Create: `apps/desktop/test/clipboardPayload.test.ts`
- Create during real-platform verification: `docs/superpowers/plans/2026-10-30-03a-smart-paste-clipboard-capability-results.md`

**Interfaces:**
- Produces:

```ts
export interface ClipboardPayload {
  readonly plainText: string
  readonly html: string | null
  readonly images: readonly File[]
  readonly source: "dom-event" | "async-clipboard"
}

export interface SystemClipboardReader {
  read(): Promise<readonly ClipboardItem[]>
  readText(): Promise<string>
}

export function payloadFromDataTransfer(data: DataTransfer): ClipboardPayload
export async function readClipboardPayload(reader: SystemClipboardReader): Promise<ClipboardPayload>
```

- [ ] **Step 1: Add failing deterministic reader tests**

Mock ClipboardItems with these exact combinations:

- HTML + plain text;
- PNG + HTML + plain text;
- multiple image items;
- `read()` rejection followed by successful `readText()`;
- unavailable HTML blob while plain text remains readable;
- empty clipboard.

Assert image order is stable, HTML/plain strings are read once, and fallback payload has `html: null`, no invented image, and `source: "async-clipboard"`.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @omd/desktop exec vitest run test/clipboardPayload.test.ts
```

- [ ] **Step 3: Implement Web Clipboard readers**

The default `SystemClipboardReader` wraps `navigator.clipboard.read/readText`; dependency injection keeps tests independent of browser permissions. `payloadFromDataTransfer` synchronously reads the DOM event before the event object becomes stale.

- [ ] **Step 4: Run the real-platform capability matrix**

On packaged/dev builds for macOS WKWebView, Windows WebView2, and Linux WebKitGTK, invoke system read from AppMenu/command palette user gestures and record:

- application and webview versions;
- HTML, plain text, single image, and HTML+image availability;
- permission/error shape;
- whether the call requires focus or a direct user gesture.

Write observed results, not predictions, into the results document. If any first-class platform cannot reliably obtain HTML/image flavors, stop this plan before Task 2 and create a narrow native clipboard adapter spec/plan for that platform. Plain-only fallback does not satisfy the cutover gate.

- [ ] **Step 5: Commit reader code and evidence**

```bash
git add apps/desktop/src/clipboardPayload.ts apps/desktop/test/clipboardPayload.test.ts docs/superpowers/plans/2026-10-30-03a-smart-paste-clipboard-capability-results.md
git commit -m "test: verify rich clipboard capabilities"
```

### Task 2: Mapped paste bookmarks

**Files:**
- Create: `apps/desktop/src/pasteBookmark.ts`
- Create: `apps/desktop/test/pasteBookmark.test.ts`
- Modify: `apps/desktop/src/Editor.ts`

**Interfaces:**
- Produces:

```ts
export interface PasteBookmarkHandle { readonly id: string }
export type MappedPasteRange =
  | { readonly kind: "active"; readonly from: number; readonly to: number }
  | { readonly kind: "invalid" }
  | null

export const pasteBookmarkExtension: Extension
export function startPasteBookmark(view: EditorView, from: number, to: number): PasteBookmarkHandle
export function readPasteBookmark(state: EditorState, handle: PasteBookmarkHandle): MappedPasteRange
export function clearPasteBookmark(view: EditorView, handle: PasteBookmarkHandle): void
```

- [ ] **Step 1: Add failing mapping tests**

Assert:

- collapsed target maps through insert/delete strictly before it;
- non-empty target maps through edits strictly before/after it;
- any transaction touching the original non-empty range marks it invalid;
- document replacement, reconfiguration, explicit clear, and view destroy leave no active handle;
- two queued bookmarks map independently.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @omd/desktop exec vitest run test/pasteBookmark.test.ts
```

- [ ] **Step 3: Implement StateEffect/StateField mapping**

Store only job ID plus `{from,to,invalid}`. Map untouched ranges with `tr.changes.mapPos`; use `touchesRange` to invalidate a non-empty range changed by another transaction. Do not store document text, DOM, File, or absolute tab identity in the field.

- [ ] **Step 4: Register and verify**

Register `pasteBookmarkExtension` once in `createEditor`; do not add it dynamically per paste.

```bash
pnpm --filter @omd/desktop exec vitest run test/pasteBookmark.test.ts test/Editor.test.ts
pnpm --filter @omd/desktop build
```

- [ ] **Step 5: Commit bookmark mapping**

```bash
git add apps/desktop/src/pasteBookmark.ts apps/desktop/test/pasteBookmark.test.ts apps/desktop/src/Editor.ts
git commit -m "feat: map asynchronous paste targets"
```

### Task 3: Single DOM/system paste controller

**Files:**
- Create: `apps/desktop/src/clipboardPaste.ts`
- Create: `apps/desktop/test/clipboardPaste.test.ts`
- Modify: `apps/desktop/src/constants.ts`
- Modify: `apps/desktop/src/imagePaste.ts`
- Modify: `apps/desktop/src/Editor.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/i18n/messages/en.ts`
- Modify: `apps/desktop/src/i18n/messages/zh.ts`
- Modify: `apps/desktop/test/Editor.test.ts`
- Test: `apps/desktop/test/imagePaste.test.ts`

**Interfaces:**
- Consumes `prepareSmartPaste`, `planSmartPaste`, ClipboardPayload readers, bookmarks, and existing `ImagePasteOptions`.
- Produces:

```ts
export interface ClipboardPasteOptions extends ImagePasteOptions {
  readonly getTabId: () => string
  readonly onNotice: (message: string) => void
  readonly onConvertingChange: (active: boolean) => void
}

export function clipboardPasteExtension(options: ClipboardPasteOptions): Extension
export async function pasteFromSystemClipboard(
  view: EditorView,
  reader: SystemClipboardReader,
  options: ClipboardPasteOptions,
): Promise<void>
```

- [ ] **Step 1: Add failing controller tests**

Cover exact routing/side effects:

- readOnly consumes DOM paste and performs no parse/write/dispatch;
- image flavor wins over HTML;
- HTML calls engine importer and dispatches one `input.paste` transaction;
- no HTML/image keyboard event returns `false` for CM plain-text/multi-range handling;
- a system/menu payload containing HTML at multiple selections ignores rich flavors and applies exact `plainText` with CodeMirror's multi-range semantics;
- verbatim range chooses exact plain text;
- two async jobs commit in invocation order;
- document/tab ID change cancels commit;
- non-overlapping edits map a collapsed bookmark;
- overlapping edits invalidate a selected-range paste;
- conversion error inserts exact plain text at the mapped range.
- HTML above the named large-paste threshold sets converting state before yielding to the browser, clears it in `finally` on success/failure/cancellation, and never dispatches a partial result.

Assert dropped presentation-only styles remain silent, while clipboard-permission fallback, unsupported merged-table downgrade, and partial asset failure each produce at most one localized summary notice per paste job.

- [ ] **Step 2: Add the macOS right-click regression test**

Replace the old contract in `Editor.test.ts`: right-click at position 6, paste `<p><b>XY</b></p>`/`XY`, and assert `hello **XY**world` at the saved target. Assert the event is consumed exactly once and no surrounding line disappears.

- [ ] **Step 3: Run tests and verify RED**

```bash
pnpm --filter @omd/desktop exec vitest run test/clipboardPaste.test.ts test/Editor.test.ts
```

- [ ] **Step 4: Implement one controller**

Move `contextMenuTarget` capture and all paste-event ownership into `clipboardPasteExtension`. At paste start, restore the saved CM selection, clear the one-shot target, capture `ClipboardPayload`, and route image → HTML → plain.

For HTML above `SMART_PASTE_STATUS_BYTES` in `constants.ts`, publish non-modal converting state and yield one animation frame before the synchronous DOM parse so the status can paint. `App.tsx` only wires that state into the existing status surface; conversion logic remains in `clipboardPaste.ts`. If the importer benchmark later requires a worker, stop at the benchmark gate rather than pretending this yield makes CPU work asynchronous.

Delete only the paste-event branch from `imagePasteHandler`; keep drop, picker, MIME limits, path handling, and public image helpers until Task 4 refactors assets. Do not leave engine `htmlPaste()` registered after final cutover; during this task, ensure only the new handler consumes HTML in test assembly.

- [ ] **Step 5: Run focused checks and commit**

```bash
pnpm --filter @omd/desktop exec vitest run test/clipboardPaste.test.ts test/Editor.test.ts test/imagePaste.test.ts
pnpm --filter @omd/desktop build
git diff --check
git add apps/desktop/src/clipboardPaste.ts apps/desktop/src/constants.ts apps/desktop/src/imagePaste.ts apps/desktop/src/Editor.ts apps/desktop/src/App.tsx apps/desktop/src/i18n/messages/en.ts apps/desktop/src/i18n/messages/zh.ts apps/desktop/test/clipboardPaste.test.ts apps/desktop/test/Editor.test.ts apps/desktop/test/imagePaste.test.ts
git commit -m "feat: unify desktop paste routing"
```

### Task 4: Embedded paste assets and cleanup

**Files:**
- Create: `apps/desktop/src/pasteAssets.ts`
- Create: `apps/desktop/test/pasteAssets.test.ts`
- Modify: `apps/desktop/src/clipboardPaste.ts`
- Modify: `apps/desktop/test/clipboardPaste.test.ts`
- Modify: `apps/desktop/src/imagePaste.ts`
- Modify: `apps/desktop/src/desktopServices.ts`
- Create: `apps/desktop/src-tauri/src/paste_assets.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/test/crossLayerConstants.test.ts`

**Interfaces:**
- Produces TS wire types:

```ts
export interface PasteAssetWrite { readonly key: string; readonly mime: string; readonly base64: string }
export interface PasteAssetResult { readonly key: string; readonly relativePath: string }
export interface PasteAssetFailure { readonly key: string; readonly kind: "unsupportedMime" | "invalidData" | "tooLarge" }
export interface PasteAssetBatch {
  readonly batchId: string | null
  readonly items: readonly PasteAssetResult[]
  readonly failures: readonly PasteAssetFailure[]
}

export interface PasteAssetStore {
  write(documentPath: string, assets: readonly PasteAssetWrite[]): Promise<PasteAssetBatch>
  commit(batchId: string): Promise<void>
  discard(batchId: string): Promise<void>
}
```

`ImagePasteOptions` replaces its path-oriented `writeImage` test seam with an injectable `assetStore: PasteAssetStore`; DOM image paste, drop, picker, and HTML-embedded assets therefore exercise one persistence contract.

- Produces Rust commands `write_paste_assets(document_path, assets)`, `commit_paste_assets(batch_id)`, and `discard_paste_assets(batch_id)` with camelCase serialized fields. `paste_assets.rs` owns validation, writes, rollback, pending-batch state, and unit tests; `lib.rs` only registers the module, managed state, and commands. Rust state owns the pending batch ID → exact created paths mapping, so cleanup cannot be abused as an arbitrary assets-directory delete API.

- [ ] **Step 1: Add failing TS/Rust contract tests**

Assert:

- one and multiple PNG/JPEG/WebP assets return collision-safe Rust-generated `assets/pasted-<unique>.<ext>` paths in input order, derived from validated MIME/signature and never a caller-supplied destination;
- the controller preserves multiple clipboard-image order and inserts all successful references in one transaction while summarizing failed items once;
- per-item MIME/signature/decoded-size rejection returns a typed failure while other valid items continue; symlinked assets directory, duplicate asset key, and batch-level structural errors fail the command;
- validation happens before the first write;
- an unexpected mid-write IO failure removes only files created by that batch and rejects the command rather than returning a half-registered batch;
- an unsaved document performs no write, preserves available alt/text, and emits one summary notice;
- discard removes exactly the pending batch's files and cannot accept caller-chosen paths;
- commit forgets cleanup ownership without deleting successfully referenced files;
- bounded recent terminal records make a repeated identical commit/discard idempotent; random unknown IDs and conflicting reuse (discard after commit or commit after discard) fail closed;
- Rust JSON serializes `batchId`, `relativePath`, and `documentPath`, never snake_case.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @omd/desktop exec vitest run test/pasteAssets.test.ts test/clipboardPaste.test.ts test/crossLayerConstants.test.ts
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml write_paste_assets
```

- [ ] **Step 3: Implement validated batch writes**

Move the existing image signature/size/path helpers and their Rust tests out of oversized `lib.rs` into `paste_assets.rs`. The batch command accepts no destination path: Rust validates MIME/signature and size for each item, records safe typed failures, then uses the existing `tempfile` dependency to create collision-safe `pasted-*.<ext>` files for the valid items directly under the current document's `assets/`. A batch with no successful item returns `batchId: null`; otherwise it registers the exact created paths under an opaque batch ID. An unexpected IO failure during the write phase rolls back every file created by that command and rejects it, so no half-registered batch escapes. `discard_paste_assets` repeats containment/symlink checks and removes only the registered batch; `commit_paste_assets` only drops cleanup ownership. Keep a small bounded terminal-ID set so an identical IPC retry is idempotent while a random or conflicting ID still fails closed.

Keep shared image byte/MIME/assets-directory limits named on both sides and update `crossLayerConstants.test.ts` to read their new Rust module home; moving the constant must not silently remove the drift guard.

Refactor single-image paste/drop to use the same store for persistence while preserving its current user-facing behavior. After the final TS consumer moves, remove the legacy caller-selected `write_image` command, invoke wrapper, registration, and redundant tests in this same task; do not leave two asset-write APIs.

- [ ] **Step 4: Resolve assets before Markdown dispatch**

In the controller, write `PreparedSmartPaste.assets`, build `PasteAssetResolution` from successful `batch.items`, leave failed keys unresolved so the importer emits alt text, and summarize `batch.failures` once. Then call `planSmartPaste`. On invalid bookmark/view/document/readOnly or a thrown dispatch after write, call `discard(batchId)` when non-null. The successful document dispatch is the commit point: afterward call `commit(batchId)` when non-null. If that acknowledgement fails or is ambiguous, never discard files now referenced by Markdown; report/log the cleanup-metadata failure and allow an idempotent commit retry. Undo does not remove committed assets.

- [ ] **Step 5: Run cross-layer checks and commit**

```bash
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
git diff --check
git add apps/desktop/src/pasteAssets.ts apps/desktop/src/clipboardPaste.ts apps/desktop/src/imagePaste.ts apps/desktop/src/desktopServices.ts apps/desktop/src-tauri/src/paste_assets.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/test/pasteAssets.test.ts apps/desktop/test/clipboardPaste.test.ts apps/desktop/test/crossLayerConstants.test.ts
git commit -m "feat: persist smart paste assets atomically"
```

### Task 5: Menus, commands, and Paste as Plain Text

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/shortcuts.ts`
- Modify: `apps/desktop/src/menuTree.ts`
- Modify: `apps/desktop/src-tauri/src/menu.rs`
- Modify: `apps/desktop/src/pastePlainText.ts`
- Test: `apps/desktop/test/crossLayerMenu.test.ts`
- Test: `apps/desktop/test/pastePlainText.test.ts`
- Test: `apps/desktop/test/App.test.tsx`

**Interfaces:**
- App command `paste` calls `pasteFromSystemClipboard`.
- App command `pastePlainText` calls `readText()` and exact insertion only.
- `pastePlainText` owns display/drift binding `Mod+Shift+V` in `EDIT_SHORTCUT_BINDINGS`; it must not enter `WINDOW_SHORTCUTS`, because editor/native paste dispatch owns the keystroke and a window handler would double-fire. Ordinary `paste` remains display-only `Mod+V` for the same reason.

- [ ] **Step 1: Add failing shortcut/menu tests**

Assert `pastePlainText` displays `Mod+Shift+V`, native menu uses `CmdOrCtrl+Shift+V`, AppMenu/palette point to the same command ID, and neither ordinary `Mod+V` nor `Mod+Shift+V` enters `WINDOW_SHORTCUTS`. Reserve the real-browser exactly-once keyboard assertion for Task 6's cutover E2E, where the native/editor paste path is available.

- [ ] **Step 2: Add command payload tests**

Mock a system payload with HTML + text and assert AppMenu/command palette `paste` produces semantic Markdown. Assert `pastePlainText` inserts the text bytes and never reads HTML/images or invokes asset persistence.

- [ ] **Step 3: Implement single-source wiring**

Add the display binding once in `shortcuts.ts`; pass the accelerator into the custom native menu item; update App command callbacks to call the shared controller through stable refs. Preserve native predefined Paste on macOS for ordinary `Cmd+V`. Do not add another global `keydown` paste implementation.

- [ ] **Step 4: Run menu/command checks and commit**

```bash
pnpm --filter @omd/desktop exec vitest run test/crossLayerMenu.test.ts test/pastePlainText.test.ts test/App.test.tsx
pnpm --filter @omd/desktop build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml menu
git diff --check
git add apps/desktop/src/App.tsx apps/desktop/src/shortcuts.ts apps/desktop/src/menuTree.ts apps/desktop/src-tauri/src/menu.rs apps/desktop/src/pastePlainText.ts apps/desktop/test/crossLayerMenu.test.ts apps/desktop/test/pastePlainText.test.ts apps/desktop/test/App.test.tsx
git commit -m "feat: align paste commands and shortcuts"
```

### Task 6: Atomic cutover and Turndown deletion

**Files:**
- Delete: `packages/engine/src/paste/htmlPaste.ts`
- Delete: `packages/engine/src/types/turndown-plugin-gfm.d.ts`
- Rewrite: `packages/engine/test/htmlPaste.test.ts`
- Modify: `packages/engine/src/index.ts`
- Modify: `packages/engine/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/desktop/e2e/smart-paste.spec.ts`
- Modify: `packages/engine/AGENTS.md`
- Modify: `apps/desktop/AGENTS.md`
- Modify: `docs/memory/known-gotchas.md`
- Modify: `docs/memory/gotchas-engine.md`
- Modify: `docs/memory/gotchas-desktop.md`
- Modify: `docs/memory/gotchas-rust.md`
- Modify: `docs/manual-qa.md`
- Modify: `docs/guides/keyboard-shortcuts.md`

**Interfaces:**
- Removes `convertHtmlToMarkdown`, `htmlPaste`, and `htmlPasteToMarkdown` exports.
- Keeps `prepareSmartPaste` and `planSmartPaste` as the engine public import API.

- [ ] **Step 1: Add real-browser cutover E2E**

Cover browser HTML heading/list/link/code/simple table, `access_token`, literal Markdown punctuation, style-noise/dark mode, verbatim plain text, right-click target, image priority, exact plain paste including one `Mod+Shift+V` dispatch, large-paste converting status, caret/scroll/IME composition, one undo, readOnly, and XSS non-execution.

- [ ] **Step 2: Run E2E against the new controller before deleting old code**

```bash
PW_PORT=9482 pnpm --filter @omd/desktop test:e2e -- e2e/smart-paste.spec.ts
```

- [ ] **Step 3: Delete the old pipeline and dependencies**

Remove `htmlPaste()` from `editorExtensions`, delete Turndown files/exports/tests, and remove `turndown`, `turndown-plugin-gfm`, and their types with pnpm so the lockfile changes mechanically. Retain `blockBoundaries.ts` because the new planner still owns block insertion boundaries.

- [ ] **Step 4: Update permanent ownership docs and QA**

Document the single desktop controller, two explicit paste commands, mapped target, asset cleanup, semantic importer, and capability evidence. Replace the old gotcha saying the desktop handler must run before engine rich paste: after cutover there is no competing engine event handler.

- [ ] **Step 5: Run the full cutover gate**

```bash
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
PW_PORT=9482 pnpm --filter @omd/desktop test:e2e -- e2e/smart-paste.spec.ts
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter @omd/engine bench
git diff --check
```

- [ ] **Step 6: Commit the cutover**

```bash
git add packages/engine/src/paste/htmlPaste.ts packages/engine/src/types/turndown-plugin-gfm.d.ts packages/engine/test/htmlPaste.test.ts packages/engine/src/index.ts packages/engine/package.json pnpm-lock.yaml apps/desktop/e2e/smart-paste.spec.ts packages/engine/AGENTS.md apps/desktop/AGENTS.md docs/memory/known-gotchas.md docs/memory/gotchas-engine.md docs/memory/gotchas-desktop.md docs/memory/gotchas-rust.md docs/manual-qa.md docs/guides/keyboard-shortcuts.md
git commit -m "feat: switch to semantic smart paste"
```
