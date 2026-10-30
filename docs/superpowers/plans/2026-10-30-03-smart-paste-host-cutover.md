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
- Every asynchronous paste command, including Paste as Plain Text, captures its target before clipboard reads and revalidates view, tab, document ID, readOnly, and mapped ranges before dispatch.
- Asset jobs additionally capture the document path/assets base and revalidate it before write, after write, and immediately before dispatch; Save As and rename do not necessarily change document ID.
- Mixed rich HTML never binds unresolved image keys to File items by position, equal counts, MIME, or filenames.
- One completed paste dispatches one `input.paste` transaction and one undo step.
- Multi-range paste remains CodeMirror plain-text behavior.
- Window handlers stay stable and read mutable state through refs.
- Native menu IDs/accelerators, `commands.ts`, `shortcuts.ts`, palette, and AppMenu remain drift-guarded.
- Do not add a platform-specific branch outside `platform.ts` or Rust `cfg!(target_os = …)`.
- Do not delete Turndown until the cutover gate passes.
- Keep `App.tsx` and Rust `lib.rs` as thin wiring only. New controller logic lives in focused desktop modules; batch asset validation/state lives in a dedicated Rust module rather than enlarging either existing hotspot.
- Respect `scripts/module-size-baseline.json` caps on legacy oversized files (`apps/desktop/test/Editor.test.ts` is capped at 801 lines, `apps/desktop/src-tauri/src/menu.rs` at 846, `apps/desktop/src/App.tsx` at 2858, `apps/desktop/test/App.test.tsx` at 1422, `apps/desktop/src-tauri/src/lib.rs` at 1957). Never add net lines to these files; put new tests in dedicated `test/clipboardPaste.test.ts` / `test/pasteBookmark.test.ts` files and only replace existing assertions in place.

## File Map

- Create `apps/desktop/src/clipboardPayload.ts`: DOM/system flavor acquisition.
- Create `apps/desktop/src/pasteBookmark.ts`: mapped asynchronous target field.
- Create `apps/desktop/src/pasteJob.ts`: shared target capture, per-view commit queue, current-target checks, and error containment for both paste commands and image insertion.
- Create `apps/desktop/src/clipboardPaste.ts`: single controller and CM extension.
- Create `apps/desktop/src/pasteAssets.ts`: embedded asset persistence/cleanup adapter.
- Keep image drop/file-picker behavior in `imagePaste.ts`; move paste-event ownership out.
- Remove engine `htmlPaste()` registration only at the final cutover task.

---

### Task 1: Clipboard capability spike and payload readers

Execute this preflight before Plan 02 replacement work; it has no dependency on the new importer. Plan 01 projection fixes may proceed independently. Do not invent capability evidence from browser mocks or Chromium E2E.

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
  readonly diagnostics: readonly ("richReadFailed" | "flavorUnavailable")[]
}

export interface SystemClipboardReader {
  read(): Promise<readonly ClipboardItem[]>
  readText(): Promise<string>
}

export function payloadFromDataTransfer(data: DataTransfer): ClipboardPayload
export async function readClipboardPayload(reader: SystemClipboardReader): Promise<ClipboardPayload>
```

- [x] **Step 1: Add failing deterministic reader tests**

Mock ClipboardItems with these exact combinations:

- HTML + plain text;
- PNG + HTML + plain text;
- multiple image items;
- mixed rich HTML with two unreadable image sources but one File representation, plus equal-count files whose source order differs;
- `read()` rejection followed by successful `readText()`;
- unavailable HTML blob while plain text remains readable;
- empty clipboard.

Assert image order is stable, HTML/plain strings are read once, and fallback payload has `html: null`, no invented image, `source: "async-clipboard"`, and one aggregate read diagnostic. Genuine plain-only or empty clipboards have no failure diagnostic. Readers never infer File-to-HTML-image identity.

- [x] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @omd/desktop exec vitest run test/clipboardPayload.test.ts
```

- [x] **Step 3: Implement Web Clipboard readers**

The default `SystemClipboardReader` wraps `navigator.clipboard.read/readText`; dependency injection keeps tests independent of browser permissions. `payloadFromDataTransfer` synchronously reads the DOM event before the event object becomes stale.

- [x] **Step 4: Run the real-platform capability matrix**

On packaged/dev builds for macOS WKWebView, Windows WebView2, and Linux WebKitGTK, invoke system read from AppMenu/command palette user gestures and record:

- application and webview versions;
- HTML, plain text, single image, and HTML+image availability;
- permission/error shape;
- whether the call requires focus or a direct user gesture.
- raw flavor/item counts and whether copied images are individual files, a single composite representation, or unavailable; include mixed text/images and two differently labeled images, not just a single screenshot.

Write observed results, not predictions, into the results document. Count/order observations are not a portable identity guarantee; the Web Clipboard reader leaves ambiguous associations unresolved. A future native adapter may supply explicit identity only after its contract is separately specified and tested. If any first-class platform cannot reliably obtain HTML/image flavors, stop this plan before Task 2 and block importer-replacement approval pending a narrow native clipboard adapter spec/plan for that platform. Plain-only fallback does not satisfy the cutover gate.

- [x] **Step 5: Commit reader code and evidence**

```bash
git add apps/desktop/src/clipboardPayload.ts apps/desktop/test/clipboardPayload.test.ts docs/superpowers/plans/2026-10-30-03a-smart-paste-clipboard-capability-results.md
git commit -m "test: verify rich clipboard capabilities"
```

### Task 2: Mapped paste bookmarks and shared job lifetime

**Files:**
- Create: `apps/desktop/src/pasteBookmark.ts`
- Create: `apps/desktop/test/pasteBookmark.test.ts`
- Create: `apps/desktop/src/pasteJob.ts`
- Create: `apps/desktop/test/pasteJob.test.ts`
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

export interface PasteJobOptions {
  readonly getTabId: () => number
  readonly getDocumentId: () => number
  readonly getDocPath: () => string | null
  readonly onError: (message: string) => void
}

export type PasteJobTarget =
  | {
      readonly kind: "active"
      readonly ranges: readonly PasteRange[]
      readonly documentPath: string | null
    }
  | { readonly kind: "cancelled" }

export function runPasteJob<T>(
  view: EditorView,
  options: PasteJobOptions,
  acquire: () => Promise<T>,
  apply: (payload: T, currentTarget: () => PasteJobTarget) => Promise<void>,
): Promise<void>
```

`PasteRange` is the exported engine `{ from, to }` type from Plan 02. The job helper is host-only and does not parse Markdown, read clipboard flavors, or write assets itself. `pastePlainText`, the rich controller and image insertion all reuse it rather than maintaining independent queues.

- [x] **Step 1: Add failing mapping tests**

Assert:

- collapsed target maps through insert/delete strictly before it;
- selection-only transactions do not redirect an already-captured job to a new caret;
- non-empty target maps through edits strictly before/after it;
- any transaction touching the original non-empty range marks it invalid;
- document replacement, reconfiguration, explicit clear, and view destroy leave no active handle;
- two queued bookmarks map independently;
- collapsed bookmarks at the same offset use explicit insertion association so successive queued pastes A then B produce AB, not BA;
- job capture happens before the first await; document replacement, view destruction, readOnly becoming true, tab identity change and Save As to another directory cancel completion;
- multiple ranges map independently; changing any original selected range cancels the command instead of partially applying it;
- readOnly at invocation performs no clipboard read; acquisition rejection reports once and releases the queue so a later job can proceed.
- acquisition for job B rejects while job A is still pending: attach rejection handling immediately, emit no unhandled rejection, and preserve queue recovery.

- [x] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @omd/desktop exec vitest run test/pasteBookmark.test.ts test/pasteJob.test.ts
```

- [x] **Step 3: Implement StateEffect/StateField mapping**

Store only job ID plus `{from,to,invalid}`. Map untouched ranges with `tr.changes.mapPos`; use `touchesRange` to invalidate a non-empty range changed by another transaction. Do not store document text, DOM, File, or absolute tab identity in the field.

`runPasteJob` captures view/tab/document/path and one bookmark per initial selection synchronously. Invoke `acquire` immediately in the user-gesture tick, before waiting for an earlier job; queue only application/commit. `currentTarget()` reads the live bookmarks and returns cancelled for a stale identity/path, destroyed view, invalid selection or readOnly. Treat path comparison conservatively: a changed document path cancels even if document ID stayed the same.

Keep all job-owned cleanup in `finally`. Attach fulfillment/rejection handling to acquisition immediately, even while its application waits behind another job. Contain and report operational errors through `onError`, without an unhandled keymap promise; cancellation is not a successful insertion. This helper is the only per-view paste commit queue. It must not swallow a failed predecessor without reporting it, or let that failure poison later jobs.

- [x] **Step 4: Register and verify**

Register `pasteBookmarkExtension` once in `createEditor`; do not add it dynamically per paste. Do not add new test cases to `test/Editor.test.ts` (capped at 801 lines in `module-size-baseline.json`); keep field mapping cases in `test/pasteBookmark.test.ts` and shared lifecycle/queue cases in `test/pasteJob.test.ts`.

```bash
pnpm --filter @omd/desktop exec vitest run test/pasteBookmark.test.ts test/pasteJob.test.ts test/Editor.test.ts
pnpm --filter @omd/desktop build
pnpm check:quality
```

- [x] **Step 5: Commit bookmark mapping**

```bash
git add apps/desktop/src/pasteBookmark.ts apps/desktop/src/pasteJob.ts apps/desktop/test/pasteBookmark.test.ts apps/desktop/test/pasteJob.test.ts apps/desktop/src/Editor.ts
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
- Consumes `prepareSmartPaste`, `preparePlainTextFallback`, `planSmartPaste`, ClipboardPayload readers, `runPasteJob`, and existing `ImagePasteOptions`.
- Produces:

```ts
export interface ClipboardPasteOptions extends ImagePasteOptions, PasteJobOptions {
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

- [x] **Step 1: Add failing controller tests**

Cover exact routing/side effects:

- readOnly consumes DOM paste and performs no parse/write/dispatch;
- after readOnly/multi-range/verbatim guards, image flavor wins when there is no HTML; a payload with exactly one File and `isSingleImageOnly: true` is treated as the explicit single-image clipboard representation, preserving its HTML alt;
- mixed rich HTML always runs the importer: embedded data-image assets may be written, remote URLs remain URLs, and unresolved blob/file images retain alt plus one notice. Never bind its File array to HTML image keys by order, including equal-count and reversed-order cases; a single-image HTML wrapper with multiple Files also must not guess;
- HTML calls engine importer and dispatches one `input.paste` transaction;
- no HTML/image keyboard event returns `false` for CM plain-text/multi-range handling;
- a system/menu payload containing HTML at multiple selections ignores rich flavors and applies exact `plainText` with CodeMirror's multi-range semantics;
- verbatim range chooses exact plain text;
- two async jobs commit in invocation order and produce AB for two same-position pastes;
- document/tab ID change cancels commit;
- a changed document path with unchanged document ID cancels before write or dispatch;
- non-overlapping edits map a collapsed bookmark;
- overlapping edits invalidate a selected-range paste;
- conversion error calls `preparePlainTextFallback` then `planSmartPaste` at the mapped range: literal `# title`, `$x$` and `**x**` stay visible text, with one downgrade notice and no retry parse;
- rich-read permission/flavor fallback uses the payload diagnostic for one localized notice, while an ordinary plain-only clipboard stays silent;
- HTML above the named large-paste threshold sets converting state before yielding to the browser, clears it in `finally` on success/failure/cancellation, and never dispatches a partial result.

Assert dropped presentation-only styles remain silent, while clipboard-permission fallback, unsupported merged-table downgrade, and partial asset failure each produce at most one localized summary notice per paste job.

- [x] **Step 2: Add the macOS right-click regression test**

Replace the old contract in `Editor.test.ts` in place (without increasing `Editor.test.ts` line count past its 801-line baseline cap): right-click at position 6, paste `<p><b>XY</b></p>`/`XY`, and assert `hello **XY**world` at the saved target. Assert the event is consumed exactly once and no surrounding line disappears.

- [x] **Step 3: Run tests and verify RED**

```bash
pnpm --filter @omd/desktop exec vitest run test/clipboardPaste.test.ts test/Editor.test.ts
```

- [x] **Step 4: Implement one controller**

Move `contextMenuTarget` capture and all paste-event ownership into `clipboardPasteExtension`. At paste start, restore the saved CM selection, clear the one-shot target, and synchronously capture `ClipboardPayload` before the event expires. Check readOnly, multiple ranges and verbatim policy before starting conversion/assets. Then choose the image-only representation, rich HTML, or plain-text path using the tested priority above. Run asynchronous work through `runPasteJob`; call `currentTarget()` immediately before every native write and final dispatch.

Catch HTML preparation/planning errors at the conversion boundary only, report the failure through the domain diagnostic channel, and plan `preparePlainTextFallback(payload.plainText)` as strict literal output. Do not catch asset-write failures or stale-target cancellation as if they were conversion failures, and do not retry an already-failed fallback. Explicit Paste as Plain Text and genuine no-HTML paste remain exact plain insertion rather than strict literal encoding.

For HTML above `SMART_PASTE_STATUS_BYTES` in `constants.ts`, publish non-modal converting state and yield one animation frame before the synchronous DOM parse so the status can paint. `App.tsx` only wires that state into the existing status surface; conversion logic remains in `clipboardPaste.ts`. If the importer benchmark later requires a worker, stop at the benchmark gate rather than pretending this yield makes CPU work asynchronous.

Delete only the paste-event branch from `imagePasteHandler`; keep drop, picker, MIME limits, path handling, and public image helpers until Task 4 refactors assets. Do not leave engine `htmlPaste()` registered after final cutover; during this task, ensure only the new handler consumes HTML in test assembly.

- [x] **Step 5: Run focused checks and commit**

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
- Modify: `apps/desktop/src/Editor.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/test/imagePaste.test.ts`
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

`ImagePasteOptions` extends `PasteJobOptions` and replaces its path-oriented `writeImage` test seam with an injectable `assetStore: PasteAssetStore`; DOM image paste, drop, picker, and HTML-embedded assets therefore exercise one persistence contract and the same job queue. Update all host/test options, including numeric stable tab ID, instead of casting missing fields.

- Produces Rust commands `write_paste_assets(document_path, assets)`, `commit_paste_assets(batch_id)`, and `discard_paste_assets(batch_id)` with camelCase serialized fields. `paste_assets.rs` owns validation, writes, rollback, pending-batch state, and unit tests; `lib.rs` only registers the module, managed state, and commands. Rust state owns the pending batch ID → exact created paths mapping, so cleanup cannot be abused as an arbitrary assets-directory delete API.

- [x] **Step 1: Add failing TS/Rust contract tests**

Assert:

- one and multiple PNG/JPEG/WebP assets return collision-safe Rust-generated `assets/pasted-<unique>.<ext>` paths in input order, derived from validated MIME/signature and never a caller-supplied destination;
- the controller preserves multiple clipboard-image order and inserts all successful references in one transaction while summarizing failed items once;
- per-item MIME/signature/decoded-size rejection returns a typed failure while other valid items continue; symlinked assets directory, duplicate asset key, and batch-level structural errors fail the command;
- validation happens before the first write;
- an unexpected mid-write IO failure removes only files created by that batch and rejects the command rather than returning a half-registered batch;
- an unsaved document performs no write, preserves available alt/text, and emits one summary notice;
- Save As/rename before write performs no old-path write; path change while write is pending discards the returned batch and inserts no reference, even if tab/document IDs are unchanged;
- discard removes exactly the pending batch's files and cannot accept caller-chosen paths;
- commit forgets cleanup ownership without deleting successfully referenced files;
- bounded recent terminal records make a repeated identical commit/discard idempotent; random unknown IDs and conflicting reuse (discard after commit or commit after discard) fail closed;
- Rust JSON serializes `batchId`, `relativePath`, and `documentPath`, never snake_case.

- [x] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @omd/desktop exec vitest run test/pasteAssets.test.ts test/clipboardPaste.test.ts test/crossLayerConstants.test.ts
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml write_paste_assets
```

- [x] **Step 3: Implement validated batch writes**

Move the existing image signature/size/path helpers and their Rust tests out of oversized `lib.rs` into `paste_assets.rs`. The batch command accepts no destination path: Rust validates MIME/signature and size for each item, records safe typed failures, then uses the existing `tempfile` dependency to create collision-safe `pasted-*.<ext>` files for the valid items directly under the current document's `assets/`. A batch with no successful item returns `batchId: null`; otherwise it registers the exact created paths under an opaque batch ID. An unexpected IO failure during the write phase rolls back every file created by that command and rejects it, so no half-registered batch escapes. `discard_paste_assets` repeats containment/symlink checks and removes only the registered batch; `commit_paste_assets` only drops cleanup ownership. Keep a small bounded terminal-ID set so an identical IPC retry is idempotent while a random or conflicting ID still fails closed.

Keep shared image byte/MIME/assets-directory limits named on both sides and update `crossLayerConstants.test.ts` to read their new Rust module home; moving the constant must not silently remove the drift guard.

Refactor single-image paste/drop to use the same store for persistence while preserving its current user-facing behavior. After the final TS consumer moves, remove the legacy caller-selected `write_image` command, invoke wrapper, registration, and redundant tests in this same task; do not leave two asset-write APIs.

- [x] **Step 4: Resolve assets before Markdown dispatch**

For rich documents, write only the embedded assets actually identified by `PreparedSmartPaste.assets` (`data:image/*`); do not consume unassociated clipboard Files. Unavailable blob/file keys remain unresolved and produce alt text. The no-HTML image channel and explicit single-image representation create their own asset keys from their selected File input, not by matching HTML-node order.

Capture the document path at invocation. Read `currentTarget()` before the write, use its still-matching captured path, and revalidate after the write and again immediately before dispatch. Build `PasteAssetResolution` from successful items and call `planSmartPaste` only after asset resolution is final, so URLs never change after validation. On invalid bookmark/view/tab/document/path/readOnly or a thrown dispatch after write, discard the non-null batch. Tests must include `markSaved` changing path without changing document ID and equivalent rename behavior.

The successful document dispatch is the commit point: afterward call `commit(batchId)` when non-null. If that acknowledgement fails or is ambiguous, never discard files now referenced by Markdown; report/log the cleanup-metadata failure and allow an idempotent commit retry. Undo does not remove committed assets. Drop/picker paths use the same path validation and cleanup, not the old independent image-paste queue.

- [x] **Step 5: Run cross-layer checks and commit**

```bash
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
git diff --check
git add apps/desktop/src/pasteAssets.ts apps/desktop/src/clipboardPaste.ts apps/desktop/src/imagePaste.ts apps/desktop/src/Editor.ts apps/desktop/src/App.tsx apps/desktop/src/desktopServices.ts apps/desktop/src-tauri/src/paste_assets.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/test/imagePaste.test.ts apps/desktop/test/pasteAssets.test.ts apps/desktop/test/clipboardPaste.test.ts apps/desktop/test/crossLayerConstants.test.ts
git commit -m "feat: persist smart paste assets atomically"
```

### Task 5: Menus, commands, and Paste as Plain Text

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/Editor.ts`
- Modify: `apps/desktop/src/shortcuts.ts`
- Modify: `apps/desktop/src/menuTree.ts`
- Modify: `apps/desktop/src-tauri/src/menu.rs`
- Modify: `apps/desktop/src/pastePlainText.ts`
- Test: `apps/desktop/test/pasteJob.test.ts`
- Modify: `apps/desktop/test/crossLayerMenu.test.ts`
- Modify: `apps/desktop/test/pastePlainText.test.ts`
- Test: `apps/desktop/test/App.test.tsx`

**Interfaces:**
- App command `paste` calls `pasteFromSystemClipboard`.
- App command `pastePlainText` calls the guarded helper below; it reads `readText()` only, with no HTML conversion, boundary normalization or asset write:

```ts
export function pastePlainText(
  view: EditorView,
  options: PasteJobOptions,
): Promise<void>
```

- Implement it through `runPasteJob`: capture all targets before readText starts, map while awaiting it, and perform one readOnly/identity/path/range check immediately before a single multi-range paste dispatch. Build changes from the captured mapped ranges, not whatever selection happens to be active after await; preserve CodeMirror's multiline/multi-cursor plain-paste policy. Empty text is a no-op; stale targets cancel; acquisition failures use `onError` once. Every App/native/palette/editor caller must supply the same stable target options.
- `pastePlainText` owns display/drift binding `Mod+Shift+v` (lowercase `v` matching `shortcuts.ts` convention) in `EDIT_SHORTCUT_BINDINGS`; it must not enter `WINDOW_SHORTCUTS`, because a window keydown handler would double-fire alongside the native macOS menu accelerator. Ordinary `paste` remains display-only `Mod+v` for the same reason.
- Register `{ key: "Mod-Shift-v", run: view => { void pastePlainText(view, options); return true } }` in the editor CodeMirror keymap. The helper contains/report errors through `runPasteJob`; do not launch the current unguarded helper. Windows/Linux handle Ctrl+Shift+V in the editor; packaged macOS uses the native accelerator. Chromium E2E can verify only the editor path, so native exactly-once behavior additionally requires the real WKWebView matrix.

- [x] **Step 1: Add failing shortcut/menu tests**

Update `shortcutDisplay` in `test/crossLayerMenu.test.ts` so it also checks `EDIT_SHORTCUT_BINDINGS` (previously it only checked `WINDOW_SHORTCUTS` and `FORMAT_SHORTCUT_BINDINGS`, which would fail once `paste-plain-text` gets `Some("CmdOrCtrl+Shift+V")` in `menu.rs`). Assert `pastePlainText` displays `Mod+Shift+v`, native menu uses `CmdOrCtrl+Shift+V` (single-line replacement in `menu.rs` to stay within its 846-line cap), AppMenu/palette point to the same command ID, and neither ordinary `Mod+v` nor `Mod+Shift+v` enters `WINDOW_SHORTCUTS`. Task 6 verifies the editor path in Chromium and the native accelerator separately on WKWebView.

- [x] **Step 2: Add command payload tests**

In `test/pastePlainText.test.ts` (avoiding net line additions to `test/App.test.tsx`), mock a system payload with HTML + text and assert AppMenu/command palette `paste` produces semantic Markdown while `pastePlainText` (and `Mod-Shift-v` keymap dispatch) inserts the text bytes and never reads HTML/images or invokes asset persistence.

Use real EditorState updates rather than a dispatch-only mock for readOnly and stale-state tests. Cover readOnly at invocation and during acquisition, a fresh document replacing the state while readText is pending, view destruction, non-overlapping edits, overlapping selected ranges, multiple selections, and a rejected read followed by a successful command. Assert no unhandled rejection and no dispatch to the wrong document. Explicit plain text containing `# title`, `$x$`, `**x**` remains unescaped, unlike the ordinary-paste conversion-failure cases in Task 3.

- [x] **Step 3: Implement single-source wiring**

First replace `pastePlainText` with the guarded implementation and migrate every caller, then add `"pastePlainText": "Mod+Shift+v"` in `EDIT_SHORTCUT_BINDINGS` (`shortcuts.ts`); pass `Some("CmdOrCtrl+Shift+V")` into the custom `paste-plain-text` item in `menu.rs` without adding lines; register `Mod-Shift-v` in the editor keymap; update App command callbacks in place through stable refs. Preserve native predefined Paste on macOS for ordinary `Cmd+V`. Do not add another global `keydown` paste implementation.

- [x] **Step 4: Run menu/command checks and commit**

```bash
pnpm --filter @omd/desktop exec vitest run test/crossLayerMenu.test.ts test/pastePlainText.test.ts test/App.test.tsx
pnpm --filter @omd/desktop build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml menu
pnpm check:quality
git diff --check
git add apps/desktop/src/App.tsx apps/desktop/src/Editor.ts apps/desktop/src/shortcuts.ts apps/desktop/src/menuTree.ts apps/desktop/src-tauri/src/menu.rs apps/desktop/src/pastePlainText.ts apps/desktop/test/crossLayerMenu.test.ts apps/desktop/test/pastePlainText.test.ts
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
- Keeps `prepareSmartPaste`, `preparePlainTextFallback`, and `planSmartPaste` as the engine public import API.

- [x] **Step 1: Add real-browser cutover E2E**

Cover browser HTML heading/list/link/code/simple table, `access_token`, literal Markdown punctuation, style-noise/dark mode, verbatim plain text, right-click target, image priority, exact plain paste including one `Mod+Shift+V` dispatch, large-paste converting status, caret/scroll/IME composition, one undo, readOnly, and XSS non-execution.

Carry forward human-authored old-pipeline expectations for heading/list/link/code/simple tables, particularly escaped pipes in code spans. Name intentional differences (semantic literal escaping, dropped presentation styles, safe image fallback) explicitly. Add conversion-failure literal text and delayed plain-paste document-replacement regressions. Use injected asset services for browser tests; they do not prove native IPC or clipboard capability.

- [x] **Step 2: Run E2E against the new controller before deleting old code**

```bash
PW_PORT=9482 pnpm --filter @omd/desktop test:e2e -- e2e/smart-paste.spec.ts
```

- [x] **Step 3: Delete the old pipeline and dependencies**

Remove `htmlPaste()` from `editorExtensions`, delete Turndown files/exports/tests, and remove `turndown`, `turndown-plugin-gfm`, and their types with pnpm so the lockfile changes mechanically. Retain `blockBoundaries.ts` because the new planner still owns block insertion boundaries.

- [x] **Step 4: Update permanent ownership docs and QA**

Document the single desktop controller, two explicit paste commands, mapped target, asset cleanup, semantic importer, and capability evidence. Replace the old gotcha saying the desktop handler must run before engine rich paste: after cutover there is no competing engine event handler.

Extend the real-platform evidence with native/menu/palette/keyboard/context-menu routes after wiring lands, including exactly one Cmd+Shift+V insertion on macOS, Ctrl+Shift+V on Windows/Linux, and cross-directory Save As during delayed asset writes. Missing evidence on any first-class platform blocks cutover; Chromium alone cannot close this gate.

- [x] **Step 5: Run the full cutover gate**

```bash
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
PW_PORT=9482 pnpm --filter @omd/desktop test:e2e -- e2e/smart-paste.spec.ts
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter @omd/engine bench
pnpm check:quality
pnpm verify
git diff --check
```

- [x] **Step 6: Commit the cutover**

```bash
git add packages/engine/src/paste/htmlPaste.ts packages/engine/src/types/turndown-plugin-gfm.d.ts packages/engine/test/htmlPaste.test.ts packages/engine/src/index.ts packages/engine/package.json pnpm-lock.yaml apps/desktop/e2e/smart-paste.spec.ts packages/engine/AGENTS.md apps/desktop/AGENTS.md docs/memory/known-gotchas.md docs/memory/gotchas-engine.md docs/memory/gotchas-desktop.md docs/memory/gotchas-rust.md docs/manual-qa.md docs/guides/keyboard-shortcuts.md
git commit -m "feat: switch to semantic smart paste"
```
