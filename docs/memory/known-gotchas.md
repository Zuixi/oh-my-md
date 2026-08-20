# Known Gotchas

Persistent traps for agents working on oh-my-md. Keep this file limited to verified behaviors that are easy to forget and costly to rediscover.

## Decoration ranges can invalidate the whole preview

CodeMirror replace decorations cannot overlap arbitrarily. A block widget that replaces a syntax node must suppress decorations from its subtree, and enclosing decorations wholly covered by the block must also be filtered.

Symptoms include `Decoration.set` throwing, disappearing preview content, or a feature working alone but failing inside blockquotes/lists.

Relevant code:

- `packages/engine/src/decorations/build.ts`
- `packages/engine/src/decorations/blocks.ts`

When adding a block rule, test the block by itself and nested under another Markdown construct.

## Editing state depends on selection, not only document text

Live preview rebuilds after selection changes. Only a **collapsed caret** reveals source: inline marks unfold on the caret's line, and block widgets disappear when the caret (or a partially-overlapping selection) enters their source range **including both boundaries**. A selection that **fully covers** a block (`sel.from <= from && sel.to >= to` — Cmd+A, drag across, Shift+↓) keeps the widget rendered with the `omd-block-covered` overlay (`decorations/blockSelectionOverlay.ts`).

Rebuild ranges use `endLine.to + 1` as an **exclusive** end (the next line's `from`). Removal overlap must be half-open (`from < range.to`). A closed check drops the next line's point decorations (`line:omd-blockquote-N` at `line.from`). The incremental iterate does not re-enter the inner `Blockquote` that starts after that boundary, so a click on an empty `>` line leaves the following nested quote looking like a plain paragraph (marks still folded, bar gone). Deduplicate rebuilt specs against retained keys so decorations that only touch `range.to` are not added twice. Empty ranges (`from === to`, last empty line) stay closed so that line can still rebuild.

Boundary positions are intentionally different:

- Inline folding uses a line-based `nearCursor` check.
- QuoteMark is the exception: it folds unless the **caret** is inside `>` / `> ` itself, so typing `> ` hides the marker while the cursor stays on the same line. Inline marks inside a quote follow the same mark-range rule; line-based `nearCursor` would unfold `**` when the user clicks the quote text. Non-empty selections never count as `cursorInside` — selection is visual.
- Nested quotes take their depth from the innermost `Blockquote` that owns the line (`omd-blockquote-N`). Do not paint every ancestor onto the same line.
- List indent inside a quote must start after the folded `> `; using `line.from` overlaps `replace:QuoteMark` and can make `Decoration.set` throw. List marks inside quotes also use mark-range activation, not line-based `nearCursor`.
- A list inside a quote and a quote inside a list must not share `omd-li-N`. List-in-quote keeps `omd-blockquote-N` + `omd-li-N` (bar at `--omd-bq-bar: 0`, hanging indent on). Quote-in-list emits `omd-quote-in-li-N` instead, which sets `--omd-bq-bar` to the list indent and disables hang. Reusing `omd-li-N` for both makes the quote bar jump inward on list lines. Fold leading spaces before `>` as `QuoteIndent`.
- Ordinary fenced code without language or inside a quote must stay as line styles (`omd-codeblock` + optional quote classes). Without a language specified, rendering an opaque `widget:block:code` collapses character-level line positions and breaks coordinate mapping / right-click cursor placement. A `widget:block:code` replace inside a quote also removes those lines from the document view and splits the quote into fragments. Fold `CodeMark` / `CodeInfo` with `cursorInside`. Mermaid still needs a widget; put quote/list depth on `BlockWidget.embed` so its chrome aligns. Quote-bar CSS should use `background-image` so it composes with `omd-codeblock`'s `background-color`.
- HTML entities (`&#x1f4da;`, `&#128218;`, `&copy;`) are built-in Lezer `Entity` nodes. Preview-replace them with `widget:entity` when the cursor is not inside the entity; do not rewrite the source. Decode numeric references with `String.fromCodePoint` (DOMParser in happy-dom truncates supplementary-plane emoji). Do not render arbitrary HTML tags. Unicode emoji in the source are already literal text.
- GitHub gemoji shortcodes (`:tada:`, `:+1:`) are a Lezer `Emoji` node only when the alias is in `parse/emoji.json` (unicode gemoji, no `:octocat:` images). Preview-replace with `widget:emoji` using `cursorInside`, not line-based `nearCursor`. Typing `:` opens a dedicated completion override that inserts Unicode and replaces the `:query`; do not enable generic `autocompletion()` in `createEditor`. Do not parse inside code, after a word character (`12:00`, `hello:smi`), or as `:)` emoticons.
- Headings inside a quote fold `#` with mark-range `cursorInside`, not line-based `nearCursor`, so the title can be edited without showing the ATX marks.
- Block editing uses an **inclusive** range overlap in `blockSelected`.

The inclusive boundary is load-bearing: when the user finishes typing a closing fence, the cursor rests exactly at `node.to`. A strict (half-open) check treats that as "outside" and the widget swallows the block mid-typing, bricking the cursor at the boundary (M2 incident, root cause C). The block only renders once the cursor leaves it entirely (Typora behavior).

Test the start, inside, end-boundary, past-end, and non-empty selection cases before changing either rule.

## Engine is React-free, not DOM-free

`@omd/engine` does not depend on React or Tauri, but CodeMirror widgets call `document.createElement`, attach events, and inspect `HTMLElement`.

Engine tests run in `happy-dom`, which is **not** a complete DOM: e.g. `table.createTHead()` / `insertRow()` are missing. Prefer portable `createElement`/`appendChild` over convenience APIs. Beware: the `BlockWidget` error boundary will catch such gaps and show the fallback, which can make a broken render look like a passing test if you only assert "no exception".

A test that works with `EditorState` alone may still miss widget lifecycle and DOM behavior.

## Block decorations are illegal in ViewPlugins — and spec-only tests cannot see it

CodeMirror throws `RangeError: Block decorations may not be specified via plugins` when any `block: true` decoration (block widgets, block replaces) is provided through a `ViewPlugin` decorations facet. Block decorations change document height structure and **must** come from a `StateField` via `EditorView.decorations.from(field)`.

This was M2's most expensive bug: every document containing a table/code/math block crashed at measure time in the real app while all 57 pure-function tests stayed green, because they only asserted `collectDecorationSpecs` output and never instantiated a view.

Defense, in `packages/engine/test/view.test.ts` (keep it alive and growing):

1. Instantiate a real `EditorView` with `editorExtensions()`.
2. Route exceptions via `EditorView.exceptionSink.of(...)` and assert it stays empty.
3. Assert widget containers exist in `view.dom`.

Any new widget type must get a smoke case there before the task is considered done.

## atomicRanges: only inline replacements — never block widgets

The `atomicRanges` facet makes ranges un-enterable for cursor motion and deletion. Two rules govern what belongs there:

**Rule 1 — no `mark:`/`line:` tags.** Feeding those into the atomic set locks the user out of every styled region (arrow keys skip, Backspace refuses; M2 incident, root cause B).

**Rule 2 — no `widget:block:*` tags.** Block widgets span multiple lines. Adding them to `atomicRanges` causes two user-visible bugs:
- **↑/↓ jumps multiple lines**: when the cursor is below a code/math/table widget and the user presses Up, CodeMirror skips the entire atomic range and lands at the first line before the widget — which can be the very start of the document.
- **Right-click paste inserts extra line**: when the paste position is adjacent to a block widget boundary, CodeMirror expands the replacement range to cover the atomic unit, pulling in the next line.
Block widgets use `Decoration.replace({ block: true })`, which CodeMirror already handles for layout and cursor positioning. Atomic constraints are redundant and harmful on top.

**Rule 3 — no line-start or cross-line atoms.** `skipAtomsForSelection` (pointer-origin selection sync) pushes selection endpoints outward to atomic boundaries in a loop. A line-start atom (`# `, `> `, `- `, list indent/mark) lets a pushed endpoint cross the newline and land inside the next line's line-start atom, cascading again — "clicking a line highlights the next one". A cross-line atom (Setext `replace:HeaderMark`, `block: true` spanning `line.to + 1`) does the same. Excluding them is safe: a caret landing inside a folded line-start mark is revealed by the line-based `nearCursor` rule (self-healing), so atomicity was redundant there anyway.

`buildLiveDecorations` therefore emits two sets: `deco` (everything) and `atomic` (`isAtomicSpec`: tags starting with `replace:` or `widget:`, **excluding** `widget:block:*`, and only when the range is mid-line — `spec.from > line.from && spec.to <= line.to`). Never widen it without re-reading this entry.

## Selection is visual, the caret is editing

Three reveal paths share one Typora-style rule — **only a collapsed caret reveals Markdown source; a non-empty selection never does**:

- `nearCursor` returns false for any non-empty selection (no line reveal while dragging).
- `cursorInside` is collapsed-caret-only (`sf === st && sf >= from && sf < to`); the old non-empty overlap branch and its triple-click special case are gone.
- `blockSelected` treats full coverage (`sel.from <= from && sel.to >= to`) as "not editing": the widget stays mounted and `blockSelectionOverlay` toggles `omd-block-covered` on its wrap. Partial overlap (one endpoint poking into the block) is still edit intent and reveals source.

Why beyond taste: during a drag, reveal/fold flips relayout the lines under the pointer, so `posAtCoords` maps the same mouse position to shifting document positions — the endpoint drifts across newlines (feeding the atomicRanges Rule 3 cascade). Keeping the preview stable during selection removes that jitter at the source.

Companion: ArrowUp/ArrowDown (`navigation/blockEntry.ts`, `Prec.high`, Live-only) dispatch a caret inside an adjacent block widget — the keyboard path into a block mirrors the mouse click. `blockEntryPosition` skips fence/delimiter lines (```/~~~/$$) so the caret lands on the first/last content line. Shift+arrows deliberately fall through to default motion so cross-block selections cover rendered blocks.

## Right-click paste on macOS deletes extra lines (WebKit selectionchange + skipAtomsForSelection)

On macOS WKWebView (Tauri), right-clicking fires this synchronous chain **before** `contextmenu` fires:

```
mousedown (button=2)
  → CM's mousedown: setSelectionOrigin("select.pointer"), flush()
selectionchange (WebKit moves/extends native selection to the clicked line)
  → onSelectionChange → flush(false) → applyDOMChange
    → lastSelectionOrigin == "select.pointer" → skipAtomsForSelection(atomicRanges, newSel)
    → view.dispatch({ selection: expandedSel })   ← CM state is now corrupted
contextmenu fires
paste fires
  → CM's doPaste uses view.state.selection.main (the corrupted, expanded selection)
  → replaces 2 lines instead of inserting at cursor
```

The `skipAtomsForSelection` call expands the WebKit selection outward to the nearest atomic-range boundary, which can push `selection.to` past one or more newlines on empty lines.

**Fix**: in `imagePasteHandler` (`apps/desktop/src/imagePaste.ts`), a `contextmenu` handler captures `view.posAtCoords({ x, y })` (pixel coordinates are immune to native-selection state). The `paste` handler, when `contextMenuTarget` is set, dispatches its own transaction from the saved position and returns `true`, preventing CM's `doPaste` from running at all. Keyboard paste (`Ctrl/Cmd-V`) leaves `contextMenuTarget = null` and falls through to CM's default handler unchanged. An `updateListener` drops the saved target as soon as the selection moves off it — without that, right-click (without pasting) followed by moving the caret and pressing `Ctrl/Cmd-V` pastes at the stale right-click position.

## Dispatching changes without a selection leaves the caret before the insert

CodeMirror maps the old selection through a transaction's changes when the spec carries no `selection`: `Transaction.newSelection` falls back to `startState.selection.map(changes)`, which uses `assoc = -1` for empty ranges. A caret sitting exactly at an insertion boundary therefore stays **before** the inserted text instead of moving to its end.

Every custom insert path that bypasses CM's default commands must set the caret explicitly:

```ts
view.dispatch({
  changes: { from, to, insert },
  selection: { anchor: from + insert.length },  // matches CM doPaste / replaceSelection
  userEvent: "input.paste",
  scrollIntoView: true,
})
```

Do not "simplify" this to `view.state.replaceSelection(insert)` on async paths (rich-paste conversion, clipboard reads, image writes): `replaceSelection` re-reads the selection at dispatch time, racing the user moving the caret during the `await`. The captured `from`/`to` plus an explicit anchor is the correct shape. Verified 2026-08-20 across `htmlPaste.ts`, `pastePlainText.ts`, `imagePaste.ts` (text and image inserts), and the App menu-paste command; view-level caret assertions live in `packages/engine/test/htmlPaste.test.ts` and `apps/desktop/test/imagePaste.test.ts`.

Related trap: `ViewUpdate` exposes `selectionSet`, not `selectionChanged` — the latter is `undefined` at runtime and vitest does not type-check, so the mistake only surfaces as a silently inert listener.

## Tests may need to force the syntax tree

Lezer parsing is incremental. Directly creating an `EditorState` does not guarantee that the full document tree is available at the point a test inspects it.

Use `packages/engine/test/helpers.ts::makeState` for parser/decoration tests that require the complete tree. When the initial synchronous parse is incomplete (large docs), it mounts a temporary `EditorView` and calls `forceParsing` to completion, then detaches.

Note: production decorations are provided by a `StateField` and updated incrementally from changed ranges, selection, and syntax-tree progress. Tests that inspect a complete tree should still use `makeState`.

`ensureSyntaxTree` without an `EditorView` only advances parsing to the viewport boundary (near zero for a fresh state), because `@codemirror/language`'s `ParseWorker` schedules background work via `requestIdle`/`setTimeout` only when a view is attached. For large documents in `incremental.test.ts`, this caused flaky failures under CPU load: the `livePreviewField` StateField captured a partial `treeLength` at creation and only added decorations for newly-parsed regions on update, so `specKeys(incremental)` vs `specKeys(fresh)` diverged depending on how far the fresh state's initial parse got. The fix is `liveState` in that file: mount a temporary `EditorView`, call `forceParsing(view, doc.length, 10000)`, then detach — the complete tree survives `view.destroy()`. Compare the incremental field against `buildLiveDecorations(state)` (a direct full rebuild on the same state) rather than a freshly created state, which avoids both the view-attachment requirement and happy-dom DOM lifecycle issues from repeated view creation. The same partial-tree trap applied to `makeState` + `large.md` in `snapshot.test.ts` (the recorded snapshot only covered the first ~3000 chars of a 50 KB doc, passing only because the parse boundary happened to be stable); `makeState` now completes the parse and that test snapshots a deterministic `[0, 3000)` prefix.

When comparing decoration specs across an edit, `changedSpecCount` must map before-specs through the transaction's `ChangeDesc` so specs that merely shifted position (same tag, moved by the edit delta) don't count as "changed." Without this, any edit in a fully-parsed large document reports a near-total change count because every spec after the edit point shifts.

## Structure and appearance live in different packages

The engine emits `omd-*` class names and tests structural ranges/widgets. Desktop CSS in `apps/desktop/src/styles.css` supplies the visual result, including KaTeX CSS.

When adding or renaming a class:

1. Update the engine output.
2. Update desktop CSS in the same task.
3. Run engine tests and the desktop build.
4. Manually inspect the rendered state when appearance matters.

A passing engine test does not prove the desktop looks correct.

## Ordered list preview numbers are written back to the source

CommonMark (and Typora) display 1, 2, 3 even when the source is `1.` / `3.` / `7.`. The sequence starts at the first item's number. Live preview also rewrites those markers in the document so the cursor line matches the preview (`1.` / `2.` / `3.`). Opening a skipped-number list in live preview can therefore dirty the buffer and show a non-modal review banner. Source mode leaves skipped numbers alone. Do not style the raw `ListMark` text as the preview number; unselected marks still use `widget:ordered-mark`. Skip the rewrite while `view.composing` is true.

That rewrite must stay revertible, so every pass is classified rather than counted. **Do not gate reversibility on "the first pass after entering live preview."** Lezer parses incrementally: the first microtask can run before the tree reaches the lists, return zero changes, and consume a one-shot entry flag — then the tree-progress pass rewrites markers with no record at all, leaving a silently modified document with no pending notice and no way to reject. `normalizationTrigger(hasUserDocChange, treeLength, docLength)` in `lists/ordered.ts` instead treats any pass as preview entry while `treeLength < docLength`, and only a pass over a complete tree after a user document change as a follow-up. Preview-entry batches merge into one pending id (first `original` kept, latest `normalized` taken, count unchanged); follow-up batches refresh markers already pending but never add new ones, or a later rewrite of a pending marker would make reject skip it as "user-edited".

While pending, autosave to the on-disk file is paused; only an explicit save (banner button or Cmd+S) accepts the normalization and writes consecutive markers. **Keep original** runs a targeted reject and session-local suppression: the source returns to the first-recorded markers, but preview labels stay consecutive (1, 2, 3) via `widget:ordered-mark`. Suppression survives Source/Live toggles until the tab gets a fresh `EditorState` (reopen or reload). **Keep original** restores the first-recorded `original` per marker, not hand-typed numbers that a follow-up normalization batch overwrote — those are treated as user-edited and skipped on reject.

On large documents, tree-progress classification can still surface a preview-entry notice after the user has already edited: `treeLength < docLength` keeps batches mergeable even once `hasUserDocChange` is true. That is intentional — losing reversibility is worse than an occasional extra banner after paste on a huge file.

App integration tests use a fake pending emitter that only throws on a few flat `1. / 3.` shapes. Nested lists, mixed `)` / `.` delimiters, and numbered lines inside fenced code blocks are not rejected and can silently reorder with the wrong `markerCount`. Do not trust the harness comment that "all divergent shapes fail loudly."

## Normalization banner accessibility traps

Native `disabled` on banner buttons drops keyboard focus to `document.body` the moment the button is clicked. Use `aria-disabled="true"` plus a handler guard so Tab focus stays on the control while save/reject runs.

The live region host must exist in the DOM from the first frame. Inserting `role="status"` together with its announcement text often stays silent in VoiceOver and NVDA. `NormalizationBanner` mounts an empty status region for the whole session; only the message `<span>` carries `role="status"`, keeping action button names out of the announced region.

## Underscore emphasis next to CJK is not CommonMark

Lezer follows CommonMark: Han/Kana/Hangul count as letters, so `__粗体__` and `_斜体_` cannot open or close. Asterisk delimiters (`**` / `*`) still work in the same position.

`parse/cjkUnderscore.ts` intercepts underscore runs that the built-in Emphasis parser would reject and treats those scripts as punctuation. ASCII intra-word underscores (`foo_bar_`) stay literal. Do not drop that extension to "simplify" emphasis.

## Horizontal rules are block widgets when unselected

`line:omd-hr` only paints a border on top of the source markers (`---`, `***`, `* * *`, …). Live preview replaces an unselected `HorizontalRule` with `widget:block:hr`. Keep `HorizontalRule` in `SELECTION_BLOCKS` so moving the cursor onto the rule rebuilds into source.

## Table cells are a single-line Markdown mini-document

`TableWidget` no longer regex-parses cells. `parse/cell.ts::parseCell` parses each cell string with the engine's own Lezer parser (one cached `Language`), producing a `CellNode` AST that both the preview DOM renderer and `export/html.ts` consume. Never reintroduce a second inline parser in `widgets/table.ts`, and never let the export cell path diverge from the AST.

Facts to remember:

- Because cells parse as a **block-level mini-document**, cells are a superset of GFM: `- item` → `ul>li`, `> quote` → `blockquote`, `` ```js ... ``` `` → `pre>code`, `# h` → `strong`, `<br>` → real `<br>`, plus every inline form (bold/italic/del/mark/u/code/math/autolink/emoji/entity/image). Paragraph nodes are flattened (no `<p>` in `<td>`), and the space after a list/quote marker is trimmed from `li`/`blockquote` text.
- Cells are **single-line**, so multi-row block content cannot be expressed; list/quote/fence content in a cell comes only from markers on that one line.
- Reference-style links (`[text][id]`) do not resolve inside cells: the cell parse is isolated from the document tree, so `linkHref`'s document-scoped reference lookup does not run. Only inline `[text](url)` and autolinks work.
- Image `src` is threaded through the host `imageResolver` facet into `TableWidget` (constructor arg, not part of `eq` — it is stable per editor config). `renderTableCellContent(parent, text)` is the public no-resolver convenience used by tests.
- Widget `eq` compares `TableData` strings via `JSON.stringify`; parsing happens at render time from the current strings, so there is no stale-state risk and no cell re-parse churn when the table is unchanged.
- Cell `mousedown` must `preventDefault` + `stopPropagation`. `BlockWidget.toDOM` moves selection into the table source on wrap `mousedown`, which unmounts the widget; without stopping the bubble, in-place `input.omd-table-edit` never stays mounted.

## Async widgets can outlive their original DOM

Mermaid, Shiki, and other renderers may resolve after CodeMirror has replaced or removed a widget because the user moved the cursor or continued typing.

Check `el.isConnected` after meaningful awaits and before writing DOM. Keep errors inside the widget fallback instead of allowing rejected promises to escape into the editor.

`BlockWidget.eq` compares source text and `embed` (not `pos`). The `pos` field was removed from equality after the click handler was switched from a captured constructor offset to `view.posAtCoords`, making the captured position no longer load-bearing for correct click behavior. Removing `pos` prevents spurious Shiki/KaTeX/Mermaid re-renders when text is inserted before a widget (pos shifts, src unchanged). `embed` must stay in equality so a widget that moves into or out of a quote/list rebuilds its chrome. `ImageWidget` never included `pos` in `eq`; `BlockWidget` now follows the same rule for `pos`.

If rendering depends on an input beyond `src` (e.g., `lang` for `CodeWidget`, cell data for `TableWidget`, resolver output for `ImageWidget`), that input must still participate in the subclass `eq` override.

If output also depends on theme, resolver, or another option, include that dependency in equality or trigger an explicit rebuild.

Valid Mermaid diagrams can stall inside `mermaid.render` under `happy-dom` without producing SVG or an error. Cover success SVG with a mocked `mermaid` module; keep the real library for the invalid-syntax view test.

## Relative image source and filesystem path are different concerns

Image paste writes bytes beside the document and inserts a relative Markdown path such as `assets/pasted-....png`. The engine deliberately does not guess how that path becomes a browser-loadable URL.

`editorExtensions({ resolveImageSrc })` is the host integration point. Its default is identity. In a Tauri WebView, leaving a document-relative filesystem path unresolved can make the image load relative to the application origin rather than the Markdown file.

Keep the Markdown source relative; resolve only for preview display.

## Image paste is a two-step consistency operation

`imagePaste.ts` first calls the Rust `write_image` command, then inserts the Markdown reference. Reversing this order can leave a document pointing to a file that was never written.

The operation also requires a saved document path. It captures the path, document identity/value, and selection before asynchronous work, then passes that path to `write_image` as required `documentPath`. Paste operations for one view are serialized and revalidated before filesystem writes and editor dispatches; do not remove that queue without replacing its race guarantees. Clipboard content that is not an image must fall through to CodeMirror's default paste behavior. Local preview URLs require `allow_document_assets` for the opened/saved document directory; the static asset protocol scope stays empty.

## Window listeners can capture stale React state

Open/save shortcuts are registered once at window scope. The stable listener must call functions stored in refs so it sees the current document path and editor instance.

Adding changing React values to the listener effect can cause repeated registration; capturing them with an empty dependency array causes stale behavior.

## Tab identity and document identity are different

`EditorSession.id` is the stable tab key (one `EditorView` / host per tab). `documentId` increments when a file is opened or reloaded so in-flight image paste and save operations can detect a stale session. Do not increment `id` on open: React would remount the host and destroy undo history.

Cmd+O replaces the active tab. File-tree / search open in a new tab, or focus an existing tab with the same path. Switching tabs hides hosts; do not stuff multiple documents into one `EditorState`. The Files sidebar is always mounted; opening a file also `ensureFolder`s its parent so the tree is not gated on an explicit Open folder command. Expanding a directory lists that folder in place and must not replace `workspace.folder`. Open / Open Folder / Save / Save As / Export live in the native File menu and Cmd+K, not in a chrome export panel.

PDF and image export cannot use a hidden iframe `print()` or `html-to-image`. Tauri on macOS is WKWebView/Safari: `display:none` iframes do not print, and `html-to-image` depends on SVG `foreignObject`, which WebKit does not rasterize. Load the HTML projection in an offscreen `WKWebView` and call `createPDFWithConfiguration`, then write the bytes in Rust. PNG is that PDF rasterized with `NSImage` — do not use `takeSnapshotWithConfiguration` with `afterScreenUpdates` on an offscreen window; WindowServer never presents it, the completion never fires, and no file is written. Save panels often omit the extension; append `.png`/`.pdf` when missing. Do not capture the live CodeMirror widget DOM.

Autosave (about 1.5s, pathed documents only) and Cmd+S share the same save queue. Untitled buffers go to recovery files only. Startup recovery must prompt; never silently overwrite. External file changes are detected by fingerprint polling: clean tabs get a non-modal external-changed notice; dirty tabs and conflict states keep local text and show the conflict/save banner — never silent overwrite. StatusBar path + dirty ` •` must stay one text node so session tests can `getByText` the exact path.

`services.reportError` is `window.alert` in production, so anything on a per-document-change path must not report every failure. Recovery writes run on every change: `recoveryWriter.ts` reports the first failure per tab, logs the rest with key and path, and re-arms after a successful write or when the tab closes. Swallowing the rejection instead hides a broken recovery directory; reporting each one makes the editor unusable.

## Dirty state needs a saved-content baseline

`App.tsx` receives every document change through `EditorView.updateListener` and compares the current text with the last successfully opened or saved snapshot. A one-way boolean ("a change happened") is insufficient because undo can return to the clean baseline.

Opening a document creates a new `EditorState` after synchronizing its path. This both resets undo history and lets relative-image resolution use the correct path during the first decoration build. Save completion may update the clean baseline only for the same document session; edits made during a pending save must remain dirty.

## Lezer has runtime-only internals missing from the typings

`Line.depth` and `BlockContext.stack` exist at runtime (the built-in parsers use them) but are absent from `@lezer/markdown`'s public type declarations. `vitest run` does not typecheck, so such misuse passes tests and only explodes under `tsc --noEmit` (which `pnpm --filter @omd/engine test` now runs first) or the stricter desktop tsconfig (`noUnusedLocals` etc., which also typechecks engine sources through the workspace import).

Pattern used in `parse/footnotes.ts` and `parse/math.ts`: cast `(line as unknown as { depth: number }).depth`, and prefer the public equivalent when one exists (`cx.depth` === internal `stack.length`). Always leave a comment on the cast.

## Guarded save is double-compare + atomic replace, not strict CAS

Rust `save_document` compares the expected opaque version twice around temp-file write and rename. That catches most external edits, but standard file APIs cannot merge "compare against arbitrary other processes" with "persist" into one indivisible step. A cooperating or racing writer can still change the file after the last compare and before `persist`. Document and logs must call this **residual race**; never describe guarded-save as strict compare-and-swap.

## Expected version binds to resolved path, not the symlink node

`DocumentVersion.resolved_path` is the canonical target at open/save time. If a symlink later points elsewhere, the next save returns `PathChangedConflict` instead of writing either target. `PathChanged` and `UnexpectedSymlinkConflict` do not expose the new target; desktop must offer reopen-previous / choose-another-path, never silently adopt the new identity.

## Missing-file publish uses a same-filesystem hard link

Creating a file from `ExpectedDocumentVersion::Missing` writes a temp file, hard-links it into place, then removes the temp link. A crash between link and temp cleanup can leave an extra temp hard-link alias on disk (recorded residual risk). Parent-directory `fsync` failure returns `Saved` with a `directorySyncFailed` durability warning — the save succeeded but directory metadata may not be durable across power loss.

## macOS metadata and xattr expectations

Required user metadata (`com.apple.FinderInfo`, `com.apple.metadata:_kMDItemUserTags`) must copy on overwrite; failure returns `MetadataFailed` and does not replace the target. Quarantine, provenance, ACLs, and birthtime are intentionally not copied. Other xattrs are best-effort (ENOTSUP/EPERM logged, save continues).

## Watcher fingerprints are hints; conflict banner replaces silent reload

File-tab polling uses `readDocumentVersion` only. External changes on a clean tab surface a non-modal **external changed** notice; dirty tabs and active conflicts keep editing/recovery and pause autosave until the user resolves via banner actions. Do not auto-reload disk over local edits.

## Manual QA baselines can become stale

`docs/manual-qa.md` is valuable for IME, undo/redo, scrolling, and file workflows, but embedded test counts and milestone labels are snapshots of the time they were written.

Treat its interaction checklist as guidance and obtain current automated counts from command output. Update the document when supported behavior changes.

## Cursor hook `permission: ask` is not enforced

As of Cursor 3.15, `beforeShellExecution` returning `permission: "ask"` does not prompt; the command still runs (sandbox and autorun included). Only `deny` reliably blocks. The project guard in `.cursor/hooks/guard-dangerous.sh` therefore denies dangerous commands. Commands typed in the integrated terminal do not go through hooks.

## `.githooks/` does nothing until `core.hooksPath` is set

The repo stores hooks in `.githooks/`, not `.git/hooks`. Git ignores that directory unless `core.hooksPath=.githooks`. The root `prepare` script sets this on `pnpm install`. A clone that never ran install still uses the sample hooks under `.git/hooks`, so `commit-msg` will not strip Cursor co-author trailers.

## Stale Rust target artifacts break the link after a toolchain upgrade

After upgrading the Rust toolchain (e.g. Homebrew `brew upgrade rust`), `pnpm dev` / `cargo build` can fail at the final link with:

```
Undefined symbols for architecture arm64:
  "alloc::slice::stable_sort::hcaebff4dcd0e3274", referenced from:
      alloc::slice::...::sort_by::... in libappsdesktop_lib.rlib
ld: warning: object file ... was built for newer 'macOS' version (15.0) than being linked (11.0)
```

Cause: `src-tauri/target/` holds `.rlib`s compiled against the previous toolchain's std; mixing them with the new std leaves the shared `stable_sort` instantiation unresolved. `cargo test` can still pass from cached test artifacts, so a green test run does not prove the bin links.

Fix: `cargo clean --manifest-path apps/desktop/src-tauri/Cargo.toml` and rebuild. A minimal `rustc` program using `sort_by` links fine on a fresh build, so this is stale-state, not a code or std defect. If `pnpm dev` reports `Port 9420 is already in use` instead, a stale dev server holds the Vite port — kill the leftover `pnpm dev`/`tauri dev`/`vite.js` processes.

Prevention: the repo-wide `pnpm verify` gate links the app binary (`cargo build --no-default-features`) before `cargo test`, so a toolchain-upgrade breakage surfaces there instead of at `pnpm dev`.

Related trap: hand-declared C functions that are actually macros do not link. `dispatch_get_main_queue` is a macro expanding to `(&_dispatch_main_q)`; declaring `extern "C" { fn dispatch_get_main_queue() -> ... }` compiles but the symbol does not exist in libdispatch, so the bin link fails with `Undefined symbols: "_dispatch_get_main_queue"`. `cargo test` misses it when the calling code is dead-code-eliminated (its tests only assert the timeout constants). Reference the exported global object instead: `extern "C" { static _dispatch_main_q: c_void }` then take its address (`&raw const _dispatch_main_q`). Verify FFI additions with `cargo build`, not just `cargo test`.

## happy-dom test env needs explicit globals (Node 25 + KaTeX)

Two environment gaps produce stray warnings in `pnpm verify` if you break their setup files:

- **Node 25 shadows `localStorage`.** Node 25 ships an experimental file-backed `globalThis.localStorage` that warns `--localstorage-file was provided without a valid path` on any access, and the happy-dom vitest env wires `window.localStorage` to that same Node object — so a bare `localStorage.getItem()` in app code (recents, outline toggle) warns in every desktop worker. Fix: `apps/desktop/test/setup.ts` installs an in-memory `Storage` on both `globalThis.localStorage` and `window.localStorage`. If you drop that override, the warning returns and tests still pass.
- **happy-dom leaves `document.compatMode` undefined.** KaTeX checks `document.compatMode !== "CSS1Compat"` at module load and warns "doesn't work in quirks mode" (rendering still works because `renderToString` bypasses the disabled DOM `render`). Fix: `packages/engine/test/setup.ts` pins `compatMode` to `"CSS1Compat"` via `Object.defineProperty`. Keep the engine's `setupFiles` entry in `vitest.config.ts`.
- **happy-dom's default user agent advertises `X11`, so `isMacOS()` is false in every desktop test.** The default agent is `Mozilla/5.0 (X11; Darwin arm64) …` and `detectPlatform` maps `X11` to linux — even on a Mac dev machine. Any test exercising macOS-only behavior (e.g. the `MACOS_ONLY_COMMANDS` export gating in `exportGating.test.ts`, `App.test.tsx`'s native export tests) must stub the agent with `Object.defineProperty(window.navigator, "userAgent", { value: <mac UA>, configurable: true })` before `renderApp()` and restore it in `afterEach`. Tests that don't care about platform run as "linux" — do not assert mac glyphs or mac-only commands in them. When restoring, note the stub may be the *only own* property on `navigator` (the real `userAgent` lives on the prototype): if `getOwnPropertyDescriptor` returned `undefined` before the stub, restore with `delete (window.navigator as { userAgent?: string }).userAgent` — skipping the restore leaves the stub active and silently breaks every later test in the file (a mac stub makes `AppMenu` render `null`).


## Desktop `defaultKeymap` is registered before engine keymaps

CodeMirror concatenates keymap facets in extension order and **runs earlier bindings first**. Desktop `createEditorState` mounts `keymap.of([...defaultKeymap, ...historyKeymap])` *before* `editorExtensions()`, so `Enter` is `insertNewlineAndIndent` unless the engine binding uses `Prec.high`.

`@codemirror/lang-markdown` already wraps its markup-continue Enter in `Prec.high`. `listKeymap` must do the same (`packages/engine/src/format/lists.ts`), or list Tab/Enter lose whenever the markdown command returns false (incomplete syntax tree, non-list markup). Spec-only `continueListSpec` tests cannot see this — instantiate a real `EditorView` with host keymaps first.

## serde enum-level `rename_all` does not rename variant fields

`#[serde(tag = "kind", rename_all = "camelCase")]` on a Rust enum only camelCases the **variant names**, not the fields inside struct variants. `DiskSnapshot` shipped with `Existing { requested_path, .. }` relying on the enum-level attribute, so `read_document` returned `requested_path` over IPC while the webview read `requestedPath` — every opened file tab silently became "unnamed" (path `undefined`), with duplicate tabs on re-open and no autosave. Symptom looked frontend; cause was wire-format.

Fix pattern (already used by `SaveDocumentResult`): put `#[serde(rename_all = "camelCase")]` on **each struct variant**. Regression guard: `documents::tests::disk_snapshot_serializes_requested_path_as_camel_case` asserts the JSON field names. TS-side tests mock `services.readDocument`, so they cannot catch IPC casing drift — assert serialized JSON in Rust tests for any new IPC payload with multi-word fields.

## Folder search IPC is `SearchResponse`, offsets are UTF-16

`search_markdown(root, query, case_sensitive)` returns `{ hits, truncated }`, not a bare array, and each `SearchHit.start`/`end` is a **UTF-16 code-unit offset** into the possibly truncated `text` so the frontend can `text.slice(start, end)` to highlight the match. Slicing by byte offset in Rust tests will fail on non-BMP text (emoji); assert with `text.encode_utf16().skip(start).take(len)` instead. `start`/`end` are plain single-word fields, so they serialize as-is, but a Rust `serde_json::to_string` test still locks the whole contract. The frontend caller must pass `caseSensitive` and destructure `.hits`/`.truncated` — an invoke missing the arg or reading the old array shape fails silently.

`ignore`/`globset` are pinned (`ignore = "=0.4.22"`) because 0.4.33+/0.4.20+ require rustc 1.88; the local toolchain is 1.87. Do not `cargo update` these without also bumping the documented toolchain floor.

## Cross-layer constants must stay in sync (TS ↔ Rust)

Behavioral limits exist on both sides of the IPC boundary and nothing in the build connects them: `MAX_IMAGE_BYTES` (paste), `MAX_RECENT_FILES`, `MAX_SEARCH_HITS`, the markdown extension list, the `.md` create/rename requirement, and the `assets` directory name. TypeScript compiles fine against a stale value and desktop tests mock services at the TS boundary, so drift only shows at runtime — an oversized paste rejected by Rust after the frontend allowed it, or a search cap that stops matching the UI's "Results limited to N" text.

Both sides define named constants (`apps/desktop/src/constants.ts`; Rust `lib.rs`/`workspace.rs`), and `apps/desktop/test/crossLayerConstants.test.ts` parses the Rust `const` definitions and asserts they equal the TS values. When a shared limit changes or a new one is added, update the TS constant, the Rust constant, and the test together; do not leave one side as a bare literal.

## Shortcut sources: menu, window, keymap, palette

A shortcut can live in four places that must agree: the native menu accelerator (`menu.rs`), the window keydown handler (`App.tsx`, driven by `shortcuts.ts` `WINDOW_SHORTCUTS`), the CodeMirror keymap (engine `markdownKeyBindings`/`toggleKeyBindings`), and the command-palette display. Adding a second literal for the same shortcut is how they drift — e.g. the native menu shows `Cmd+N` while the palette shows another key, or a menu item id is renamed in `menu.rs` and `MENU_TO_COMMAND` no longer maps it, so the item silently does nothing.

Sources of truth and guards: window shortcuts and their display live only in `shortcuts.ts`; format/mode labels are derived in the engine and imported by the desktop (`markdownShortcutLabels`/`toggleShortcutLabels`); `packages/engine/test/shortcuts.test.ts` asserts each `display` matches its CM `key`; `apps/desktop/test/crossLayerMenu.test.ts` parses `menu.rs` (both `item(` and `check_item(`) and asserts every item id maps via `MENU_TO_COMMAND` and every accelerator matches the shortcut label — window or engine format. Change a shortcut in one binding entry, never in the consumer.

Since the menu gained Format/View items, macOS menu accelerators also bind engine-owned shortcuts (⌘B, ⌘E, …). The native menu intercepts the key before the webview, so on the desktop those toggles always route through `menu-command` → App command (and the engine keymap binding never fires there — it still works in browser/tests). The View menu checkboxes are mirrored by the frontend pushing `ViewMenuState` through `set_view_menu_state` (Rust `CheckMenuItem::set_checked` on stable ids); source mode is tracked in React (`sourceMode`) because every toggle path now funnels through the App "source" command.

**Do not use `PredefinedMenuItem` for window actions.** `minimize`/`maximize`/`fullscreen`/`bring_all_to_front` set macOS selectors (`performMiniaturize:`/`performZoom:`/…) that are sent through the responder chain and do not act on the Tauri window — the items render but clicking does nothing. Tauri itself does not handle predefined item events either (its docs show the app matching `event.id() == "quit"` manually), and on macOS muda assigns predefined items opaque counter ids, so they cannot be matched by a stable id anyway. Use regular `MenuItem`s with stable ids (`window-minimize`, …) and handle them in `handle_window_command` in `menu.rs`. Window items are exempt from the `MENU_TO_COMMAND`/shortcut drift guards; `crossLayerMenu.test.ts` skips ids prefixed `window-` and asserts the exact native set.

## Parser character codes are named, not magic

The hand-written Lezer inline parsers compare `cx.char(i)` against ASCII codes. Bare numbers (`61`, `95`, `92`, …) are unreadable and easy to mistype; `packages/engine/src/parse/chars.ts` names them (`CHAR_EQ`, `CHAR_UNDERSCORE`, `CHAR_BACKSLASH`, …). New parse rules must import these constants instead of literal codes — the engine build has no lint gate, so follow the convention by review.

## The notify watcher is a hint; FSEvents latency and dropped events are expected

`watcher.rs` coalesces notify events for 300 ms before emitting `workspace-changed`, and macOS FSEvents may batch or reorder paths. The webview handler therefore probes **all** open tabs (fingerprint compare in Rust decides) instead of trusting event paths, and the old poll survives as a 30 s fallback (`watchMs` default in `App.tsx`). Never make an event path the basis for a reload decision — only `read_document_version`/guarded-save comparisons may change document state. Watch paths are canonicalized on both set and update; a non-canonical path in `state.watched` would make `diff_watches` leak watches that `unwatch` can never remove.

`read_document_version` is stat-first (2026-08-20, Spec 05b §14.9 follow-up): Rust keeps a `(mtime_ns, size) → version` cache (`DocumentVersionCache`, keyed by requested path). A matching stat returns the cached fingerprint **without reading the file**; a mismatch pays the full read + blake3 and refreshes the cache (re-stat after read — a torn mid-read write is not cached); a missing/deleted file returns `Missing` and evicts its entry. Guarded-save still always reads fresh. Residual risk (accepted): on coarse-mtime filesystems (HFS+ 1s ticks) a same-size external write inside one mtime tick is invisible until the next stat change — the poll under-reports external changes for that window; likewise a symlink retargeted to a file with an identical (mtime_ns, size) pair.

## Doc-start `---` is front matter, not a thematic rule

Since the FrontMatter parser landed, the first line `---` of a document always opens a front matter block (unclosed blocks swallow to EOF, matching the math-block tolerance). A document that merely starts with a horizontal rule is therefore rendered as front-matter source until a second `---` appears — this flipped `blocks.test.ts`'s hr-at-doc-start case, which now uses a mid-doc rule. The same ambiguity drives the stats stripper in `stats.ts` (leading `---`…`---` pair stripped from counts) and exists in every front-matter-aware renderer.

## Statusbar word count is debounced; find scans are memoized

`documentStats` is a full-document scan, so `App.tsx` computes it from `deferredDoc`, which lags `doc` by `STATS_DEBOUNCE_MS` (250 ms). A test that emits an edit and synchronously asserts the statusbar text (`"N words · M chars"`) will fail — wait out the window (`waitFor`) or advance fake timers past 250 ms (`test/App.stats.test.tsx` is the pattern). `collectMatches`/`validateFindPattern` run in `useMemo` keyed on the find inputs and `doc`, so they rerun only on real changes, not per render; assertions about match counts after typing are unaffected because `doc` changes on every edit.


## Benchmark jitter is real — budgets warn, they never gate

CI runner and local numbers differ by multiples; any machine under load can
double a p95. That is why `bench/typing.bench.ts` logs budget verdicts
(`budgetLine` prints `OK` / `OVER BUDGET (> Nms)` for `TYPING_P95_BUDGET_MS =
16` and `STATS_BUDGET_MS = 8`) instead of using `expect`, and the CI bench job
sets `continue-on-error: true`. Never convert these to hard assertions;
regressions are judged by comparing runs on the same machine (same
`makeBenchmarkDoc` input, which is deterministic by design — do not introduce
randomness into the generator).

## The complete-tree trap: never force a full parse in production

Steady-state CM only parses up to `viewport.to + 100000` (`Work.MaxParseAhead` in
@codemirror/language's idle worker); partial-tree typing is O(edit) — 1.5ms p95 at
10MB/380k lines. If any production path forces the tree to `doc.length`
(`forceParsing`/`ensureSyntaxTree`), every subsequent keystroke restarts fragment
matching over the whole tree: measured 23.5ms at 1MB and 70.6ms at 10MB per
keystroke. `apps/desktop/test/crossLayerNoFullTree.test.ts` guards this by scanning
`packages/engine/src` and `apps/desktop/src` for those calls; test helpers and
benchmarks may force full parses (they own their docs). Also mind the
giant-paragraph cliff: one Lezer `advance()` parses an entire leaf block, so a
multi-MB single paragraph (no blank lines) costs seconds per keystroke.

## Decorations are seeded and windowed — never assume a full build

Live decorations are **not** built synchronously for the whole document. Field
create/reconfigure builds only the cursor seed (`LIVE_SEED_RADIUS_LINES` /
`LIVE_SEED_RADIUS_CHARS` around the selection, `packages/engine/src/decorations/build.ts`);
everything else lands in `LiveDeco.pending` and is drained progressively by
`decorations/buildDriver.ts` (viewport-first microtask pass, then idle slices
dispatching `liveBuildChunk`). Over-scale documents add **windowing**
(`src/safeModeRendering.ts`): only pending inside the build window
(`visibleRanges ± LIVE_WINDOW_CHARS`) is ever built, and after viewport/doc/
selection changes `livePruneOutside` returns decorations outside the prune
window back to pending. Consequence: at any moment decorations far from the
viewport may legitimately be absent. Production code must never assume a
decoration exists outside the viewport window (or that `pending` is empty).
Tests that need a complete build must use the exported `drainPendingLiveBuild`
helper — the synchronous test-only drain (production must never call it; same
guard family as `crossLayerNoFullTree.test.ts`).

## CodeMirror `readOnly` is advisory — every dispatch site must guard itself

`EditorState.readOnly.of(true)` only blocks typed input in the view layer.
Keymap commands (engine format/lists `dispatchSpec`s, `markdownKeymap`),
`orderedRenumber` normalization dispatches, widget interactions (checkbox
click, table toolbar/cell edit), and `domEventHandlers` all dispatch
transactions directly and sail past the view's readOnly interception. The
`domEventHandlers` family covers more than `htmlPaste` (which runs **before**
the builtin paste handler's readOnly branch; handlers are first-true-wins):
the image **drop** handler in `apps/desktop/src/imagePaste.ts` likewise runs
before the builtin drop branch, and the drop/paste/pick paths all funnel
through `insertImageFile` — which guards `state.readOnly` itself before any
asset read/write. Belt and braces: `pickAndInsertImage` refuses to open the
file picker, the App insert-image command checks `readonlyTabsRef`, and App
autosave never schedules for a readonly tab, so no mutation path can persist
changes to the user's ≥50MiB HUGE file. Every doc-changing dispatch site must
still check `state.readOnly` itself. Guard suite:
`packages/engine/test/readonly-guards.test.ts` plus the desktop cases in
`apps/desktop/test/imagePaste.test.ts` and
`apps/desktop/test/App.largeDocOpen.test.tsx` ("read-only tabs never mutate or
persist") — add a case there whenever a new mutation path lands.

## Editing hot path owns zero O(doc) work (Spec 05a)

The per-keystroke path must never materialize the document: `EditorDocumentUpdate`
carries no `doc` string (rope flattening cost 5-15ms at 10MB + GC churn), App
materializes content on a 250ms trailing cadence (`DOC_MATERIALIZE_MS`) by pulling
`view.state.doc.toString()`, and every consumer of `docsRef` flushes first — the
save bridges do it inside `getContents`, plus `runOpen`/`requestCloseTab`/
`deleteTreeEntry` (the tree-delete dirty check missed it once and could delete a
file whose edits were still inside the 250ms window; the regression test renders
`docMaterializeMs: 250` to keep the window real). Recovery
writes are an 800ms trailing debounce with same-content dedupe
(`RECOVERY_DEBOUNCE_MS`); a crash may lose at most ~1s of typing. When tests need
synchronous docsRef visibility after `emit`, render the harness with
`docMaterializeMs: 0` (the `autosaveMs`/`watchMs` seam precedent) — timing tests
pass the real 250.

## Tauri 2 sync commands run on the Rust main thread (Spec 05b)

Non-`async` `#[tauri::command]` fns execute on the main thread and serialize
behind each other (and window event processing). During the 50MB open bug this
meant `openPath` could hang forever with content already in hand: it
`await allow_document_assets` after a successful read, and that sync command sat
queued behind a synchronous 50MB `write_recovery` `fs::write`. IO-bound commands
must be `async fn` + `tauri::async_runtime::spawn_blocking` (see the document
commands; `write_recovery`/`read_recovery`/`save_session_state`/
`watch_paths`/`allow_*` were converted). `set_recent_files` stayed sync on
purpose: its menu rebuild is macOS-only (no-op on Windows/Linux, menu.rs gates
on `target_os`), and menu mutation must stay on the main thread.

## A debounced save cannot persist quit-time state; Rust must gate the quit

The 1s trailing debounce on `SavedSessionState` (App.tsx) resets on every
workspace change and is *cancelled* by teardown, so a rapid close-tabs-then-quit
lost every close — `session.json` kept the last snapshot that had a full second
of quiet (this restored 10 tabs after the user closed 9 and quit). WKWebView
teardown runs no JS and fires no `beforeunload` you can rely on, so the flush
must be coordinated from Rust: prevent close/exit → emit `session-flush` →
wait for the `session_flush_ack` command (bounded, 2s timeout; timeout still
finishes so a hung webview never traps the user). Three exit paths need three
hooks: `WindowEvent::CloseRequested` (red X / Cmd+W; finish with
`window.destroy()` — `close()` would re-trigger CloseRequested),
`RunEvent::ExitRequested` with `code: None` (user-initiated, macOS Cmd+Q;
prevent_exit → flush → `app.exit(0)`), and the `quit_app` command itself
(`app.exit` skips ExitRequested, so it must run the gate inline). Order inside
the gate is load-bearing: register the round *before* emitting, or an ack
racing an unregistered round no-ops and stalls the close until the timeout.
The webview handler must ack even when persistence throws — an escaping
rejection from an event handler is an unhandled webview rejection and the
un-acked quit burns the full timeout.

## Open-path scale policy has one entry point; entry paths must not bypass it

`applyDocumentScalePolicy` (safe mode by lines OR bytes, render budget,
LargeDocBanner, on-demand stats) is applied by `resetTabDocument` **and**
`ensureViews` — the two places a view first holds real content. Before Spec 05b,
only the replace-tab path called it, so file-tree / search-panel new-tab opens
and session restore ran 50MB documents in full live preview with an infinite
render budget, and the restored active tab even kept its empty mount-time view
(no `resetTabDocument` at all — content lived only in `docsRef`). Line counts
come from `view.state.doc.lines`, never `contents.split("\n")` (a 1M-element
allocation just to count). Restore also persists non-primary tabs as
`lazyFile` sessions: `sessionDirty` is hardcoded false for them and
`saveFile` refuses to run until activation loads them, otherwise an explicit
save would write the empty placeholder over the on-disk file.

`resolveOpenTier` must return `"normal"` below `OPEN_STREAM_THRESHOLD_BYTES`.
A fall-through `return "large"` after the LARGE confirm block classified every
file as LARGE: tree/tab switches flashed `OpeningOverlay` and paid for
streaming + confirm. Overlay is only for LARGE/HUGE. Since the progressive
decoration build landed (2026-08-20), LARGE/HUGE views construct in Live mode
on purpose — the engine seeds decorations around the cursor (~0.3ms at 20MB)
and drains the rest in idle slices, so the old "construct with
`defaultLivePreview: false`, `setLivePreview(false)` after create is too late
on a 50MB live pass" freeze recipe is obsolete; do not reintroduce mode
forcing in `applyDocumentScalePolicy` (safe-mode budget/windowing is orthogonal
to mode). Streaming failures must fall back to `readDocument`.

**The budget/windowing globals are process-global; only the ACTIVE tab's tier
may drive them.** `setBlockRenderBudget`/`setSafeModeRendering` mutate engine
module state shared by every view, while the desktop app mounts one
`EditorView` per tab. `applyDocumentScalePolicy` therefore applies the globals
only when `tabId === workspaceRef.current.activeId` (per-tab marking always
runs), `ensureViews` re-applies for the current `activeId` after creating
views, and the `[workspace.activeId]` effect is the mid-session corrector.
This ordering is load-bearing: session restore reuses `tabs[0]`'s id for the
primary tab, so `activeId` never changes during restore and the corrector
effect never fires — letting a restored lazy placeholder's empty-view policy
application flip the globals silently disabled windowing on the active 50MB
tab (unbounded decoration memory, full-tree renumber scans, budget Infinity).
Regression: `App.largeDocOpen.test.tsx` "keeps the active over-scale tab's
safe mode when restore creates lazy placeholder views".

## Path containment checks must normalize separators

`sessionPath` inputs carry native separators on Windows (`C:\a\b.md`) while
folder strings often use `/`. A plain `path.startsWith(folder + "/")` guard is
always false there, so every open file was watched twice (recursive folder
watch + the file itself), doubling watcher events into `pollFileTabs` — which
has no cross-round coalescing of its own and re-probes every tab per round.
Use `pathWithinDir` (workspace.ts); `runFileTabsPoll` adds the in-flight
dedupe. The version probe itself is stat-first (see the watcher entry: unchanged
files cost a stat, not a 50MB read), but poll still re-reads **changed** files
in full (correctness first): a banner-without-contents divergence for huge docs
is a recorded follow-up.

## Bounded waits on the save queue; a timed-out open races the save

`runOpen` awaits the active tab's in-flight save queue through
`awaitWithTimeout` (`OPEN_SAVE_QUEUE_TIMEOUT_MS` = 3s in constants.ts): a large
save (double probe + fsync) can run for minutes under Windows antivirus
scanning, and an unbounded await turned "reopen file" into a permanent silent
hang. The timeout **proceeds with the open while the save chain keeps running**
— the save promise is never cancelled. Two consequences to preserve: (1) the
guarded save still owns correctness (its own double-compare rejects stale
writes), so a timed-out open cannot corrupt anything; (2) reopening the *same*
path within the window can briefly read pre-save disk content, which the next
watcher poll then surfaces as an external-change banner. If you add another
waiter on `tabSaveQueues`, bound it the same way instead of awaiting bare.

## Rust line_count must match CM's DefaultSplit, including lone CR

`DocumentFileStats.line_count` promises CM's `doc.lines` convention, and CM
splits on `/\r\n?|\n/` — a lone `\r` (classic Mac file) is a separator too.
Counting only `b'\n'` under-reports for such files; use
`count_line_separators` (documents.rs), which also carries a chunk-trailing
`\r` across streaming chunk boundaries so a CRLF split mid-stream is not
misread as two separators.

## Tauri plugin commands are wire contracts; raw `invoke("plugin:…")` drifts silently

`tauri-plugin-opener`'s `reveal_item_in_dir` expects `paths: Vec<PathBuf>`
(a JSON array), but `desktopServices.ts` raw-invoked it with `{ path }` — the
invoke rejected during argument deserialization before any OS code ran, so
"Reveal in File Manager" (file-tree context menu + save-conflict banner) was a
silent no-op on every platform since it landed (66be269). Both call sites fired
it with `void` and no `.catch`, so the rejection was invisible: the bug read as
"the button does nothing" instead of surfacing an error.

Plugin commands are wire contracts exactly like custom IPC (same trap family as
the `search_markdown` casing drift). Rules:

- Prefer the official JS binding (`revealItemInDir`, `openUrl` from
  `@tauri-apps/plugin-opener`) over hand-written `invoke("plugin:…", …)` — the
  binding owns the argument shape and evolves with the plugin.
- Never fire-and-forget a plugin invoke with `void` and no `.catch`; attach a
  handler that reports through `services.reportError` so payload drift becomes
  a visible error, not a dead button.
- `apps/desktop/test/desktopServices.test.ts` pins the delegation
  (`revealInFinder` → `revealItemInDir(path)`); add the same pin when wiring
  another plugin binding.

## Multi-line link constructs leave a dangling empty preview row

Multi-line link constructs (`[text](url\n"title")` — a newline in the
URL/title separator) leave a dangling empty visual row in live preview because
the title fold's backward scan correctly stops at `line.from`; this is
cosmetic and rare with no crash (verified: StateField-provided replaces
spanning line breaks are safe in CM 6.43.8).

## Stock drawSelection extends line ends to the content right edge (not configurable)

CM6's stock `drawSelection()` deliberately extends every open line end of a selection to the content-box right edge and covers the lines between the first and last selected line with one full-width band. That geometry is hard-coded — there is no config to clamp it (discuss.codemirror.net threads 9495/9735).

Selection drawing is therefore vendored in `apps/desktop/src/tightSelection.ts` (ported from `@codemirror/view` 6.43.8, `NUB_PX` = 2): open line ends stop at the text end + nub, and intermediate lines draw per-line bars. Rows of a soft-wrapped (or widget line-broken) start/end document line that fall outside the drawn top/bottom row are painted as full-width remainder bands — intentional, since soft-wrapped rows reach the wrap margin anyway. `Editor.ts` mounts `tightSelection()` — never re-add stock `drawSelection()`; `apps/desktop/test/Editor.test.ts` fails if it returns because stock's `RectangleMarker.forRange` entry point fires for every cursor/selection draw while the vendored layer never calls it.

Whenever `@codemirror/view` is bumped, re-diff the vendored geometry and the copied blink/cursor code against the new upstream `drawSelection.ts`/`cursor.ts` and port upstream changes — otherwise the vendored copy silently drifts from the installed version's layer semantics.

## macOS font enumeration must use CoreText, not NSFontManager

`list_system_fonts` (`apps/desktop/src-tauri/src/fonts.rs`) is an `async`
command whose enumeration body runs under
`tauri::async_runtime::spawn_blocking` (the blocking-work rule from
"Tauri 2 sync commands run on the Rust main thread (Spec 05b)"). That pool
thread is not the main thread, and AppKit's `NSFontManager` / `NSFont` are
**main-thread-confined**: enumeration written against them compiles and then
misbehaves at runtime. macOS font enumeration under `spawn_blocking` must use
CoreText, which is thread-safe for read-only enumeration:
`CTFontCollection::from_available_fonts` → `matching_font_descriptors()` →
read the `kCTFontFamilyNameAttribute` attribute (via `objc2-core-text` /
`objc2-core-foundation`, already Cargo dependencies).

The other platforms follow the same shape: Windows uses DirectWrite
(`GetSystemFontCollection` on the shared factory, callable from any thread,
en-US preferred name); Linux shells out to `fc-list : family` best-effort and
reports an empty list when fontconfig is absent — the picker then offers
presets only, which is the designed degradation, not an error to fix.

## Font family names must be quoted before entering `--omd-font-family`

`App.tsx` copies `settings.fontFamily` verbatim into the `--omd-font-family`
custom property (`document.documentElement.style.setProperty`) and
`styles.css` consumes it as `font-family: var(--omd-font-family, …)`. A
multi-word family name written unquoted (`Microsoft YaHei`, `Times New
Roman`) degrades into a run of bare identifiers in the declaration: a name
that cannot form a CSS identifier (leading digit, dot-prefixed system names)
invalidates the whole `font-family` value, and a name colliding with a
keyword (`serif`) resolves to the wrong family — either way the picked font
silently does not apply.

Route every system family through `cssFamily`
(`apps/desktop/src/settings.ts`), which wraps the name into a single-quoted
token and escapes embedded single quotes; `familyFromCssValue` maps a stored
value back to a family through the same quoting, so an unquoted value also
breaks the round-trip and the trigger label falls back to "Custom".
`FONT_FAMILY_PRESETS` are the exception: they are hand-written multi-family
stacks that already carry their own quoting and must pass through unchanged.

## Text.append continues the last line; batched Text assembly needs a junction line

`Text.append(other)` is `replace(length, length, other)` semantics: the first
line of `other` is string-concatenated onto the accumulator's last line — no
line break is inserted at the junction. `Text.of(["a"]).append(Text.of(["b"]))`
is the single line `"ab"`, not `"a\nb"`. Any incremental assembly that appends
line batches must prepend an empty "junction" line to each appended batch
(`Text.of(["", ...batch])`: `last + ""` stays `last`, the following break is the
real one) — that is what `packages/engine/src/docText.ts` does, and its parity
suite (`test/docText.test.ts`, every-chunk-boundary scans against
`Text.of(s.split(/\r\n?|\n/))`) is the guard. Related trap in the same file:
an empty streaming chunk must not adjudicate a pending chunk-trailing `\r`
(`"\r" + "" + "\n"` is one `\r\n` separator, not two).

## `html[data-theme]` only restyles the webview; native chrome needs `color-scheme` + window theme sync

The in-app theme toggle sets `document.documentElement.dataset.theme`, which
swaps `--omd-*` CSS variables — nothing else. Three families of UI ignore
those variables entirely and used to stay light in dark mode (verified
2026-08-21):

- **Native scrollbars** (editor `.cm-scroller`, modal bodies) follow the CSS
  `color-scheme` property, which defaults to `light` no matter what
  `data-theme` says.
- **Unstyled form controls** render in the `color-scheme` appearance: the
  settings footer buttons had drifted to `settings-btn-*` classes while
  `styles.css` still defined the old `.settings-done-btn`, so Reset/Done fell
  back to browser-default light buttons even in light mode.
- **The native title bar** follows the *window's* appearance, which only
  `WebviewWindow::set_theme` can change; the DOM cannot reach it at all.

Rules:

- Every theme block in `styles.css` declares `color-scheme` next to the
  `--omd-*` variables; `test/crossLayerConstants.test.ts` guards both blocks
  plus the settings footer class pair against TSX/CSS drift.
- The App theme effect pushes the resolved theme over IPC
  (`set_window_theme`, `null` for "system" so the window keeps following the
  OS); `desktopServices.setWindowTheme` owns the wire call.
- When renaming a CSS class in a TSX file, grep `styles.css` in the same
  change — dead selectors compile fine and read as styling at a glance.

Startup corollary (verified 2026-08-21): applying the theme only from the
webview still flashes — the window paints its first frame following the *OS*
appearance, because the saved theme reaches the frontend only after React
boots and `get_settings` resolves (tauri-apps/tauri#6027). The Rust `setup`
hook therefore reads `settings.json` and calls `set_theme` on the main window
before the event loop starts (`startup_window_theme` in `lib.rs`). Two rules
keep that fix honest:

- The frontend effect must not push `set_window_theme` until initial settings
  have loaded — the `"light"` default state would otherwise flip the title bar
  dark→light→dark right after the pre-paint application
  (`App.windowTheme.test.tsx` pins the no-push-before-load behavior).
- New startup-time native appearance must read the same persisted source Rust
  owns (`workspace::get_settings`), not a second copy of the theme state.
