# Desktop Gotchas

Deep-dive traps for `apps/desktop/src` (React host, CodeMirror hosting, CSS, IPC callers,
paste, theme). Condensed rules live in [`apps/desktop/AGENTS.md`](../../apps/desktop/AGENTS.md).
One-line index: [`known-gotchas.md`](./known-gotchas.md).

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

## Normalization banner accessibility traps

Native `disabled` on banner buttons drops keyboard focus to `document.body` the moment the button is clicked. Use `aria-disabled="true"` plus a handler guard so Tab focus stays on the control while save/reject runs.

The live region host must exist in the DOM from the first frame. Inserting `role="status"` together with its announcement text often stays silent in VoiceOver and NVDA. `NormalizationBanner` mounts an empty status region for the whole session; only the message `<span>` carries `role="status"`, keeping action button names out of the announced region.

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

## Cross-layer constants must stay in sync (TS ↔ Rust)

Behavioral limits exist on both sides of the IPC boundary and nothing in the build connects them: `MAX_IMAGE_BYTES` (paste), `MAX_RECENT_FILES`, `MAX_SEARCH_HITS`, the markdown extension list, the `.md` create/rename requirement, and the `assets` directory name. TypeScript compiles fine against a stale value and desktop tests mock services at the TS boundary, so drift only shows at runtime — an oversized paste rejected by Rust after the frontend allowed it, or a search cap that stops matching the UI's "Results limited to N" text.

Both sides define named constants (`apps/desktop/src/constants.ts`; Rust `lib.rs`/`workspace.rs`), and `apps/desktop/test/crossLayerConstants.test.ts` parses the Rust `const` definitions and asserts they equal the TS values. When a shared limit changes or a new one is added, update the TS constant, the Rust constant, and the test together; do not leave one side as a bare literal.

## Shortcut sources: menu, window, keymap, palette

A shortcut can live in four places that must agree: the native menu accelerator (`menu.rs`), the window keydown handler (`App.tsx`, driven by `shortcuts.ts` `WINDOW_SHORTCUTS`), the CodeMirror keymap (engine `markdownKeyBindings`/`toggleKeyBindings`), and the command-palette display. Adding a second literal for the same shortcut is how they drift — e.g. the native menu shows `Cmd+N` while the palette shows another key, or a menu item id is renamed in `menu.rs` and `MENU_TO_COMMAND` no longer maps it, so the item silently does nothing.

Sources of truth and guards: window shortcuts and their display live only in `shortcuts.ts`; format/mode labels are derived in the engine and imported by the desktop (`markdownShortcutLabels`/`toggleShortcutLabels`); `packages/engine/test/shortcuts.test.ts` asserts each `display` matches its CM `key`; `apps/desktop/test/crossLayerMenu.test.ts` parses `menu.rs` (both `item(` and `check_item(`) and asserts every item id maps via `MENU_TO_COMMAND` and every accelerator matches the shortcut label — window or engine format. Change a shortcut in one binding entry, never in the consumer.

Since the menu gained Format/View items, macOS menu accelerators also bind engine-owned shortcuts (⌘B, ⌘E, …). The native menu intercepts the key before the webview, so on the desktop those toggles always route through `menu-command` → App command (and the engine keymap binding never fires there — it still works in browser/tests). The View menu checkboxes are mirrored by the frontend pushing `ViewMenuState` through `set_view_menu_state` (Rust `CheckMenuItem::set_checked` on stable ids); source mode is tracked in React (`sourceMode`) because every toggle path now funnels through the App "source" command.

**Do not use `PredefinedMenuItem` for window actions.** `minimize`/`maximize`/`fullscreen`/`bring_all_to_front` set macOS selectors (`performMiniaturize:`/`performZoom:`/…) that are sent through the responder chain and do not act on the Tauri window — the items render but clicking does nothing. Tauri itself does not handle predefined item events either (its docs show the app matching `event.id() == "quit"` manually), and on macOS muda assigns predefined items opaque counter ids, so they cannot be matched by a stable id anyway. Use regular `MenuItem`s with stable ids (`window-minimize`, …) and handle them in `handle_window_command` in `menu.rs`. Window items are exempt from the `MENU_TO_COMMAND`/shortcut drift guards; `crossLayerMenu.test.ts` skips ids prefixed `window-` and asserts the exact native set.

## Statusbar word count is debounced; find scans are memoized

`documentStats` is a full-document scan, so `App.tsx` computes it from `deferredDoc`, which lags `doc` by `STATS_DEBOUNCE_MS` (250 ms). A test that emits an edit and synchronously asserts the statusbar text (`"N words · M chars"`) will fail — wait out the window (`waitFor`) or advance fake timers past 250 ms (`test/App.stats.test.tsx` is the pattern). `collectMatches`/`validateFindPattern` run in `useMemo` keyed on the find inputs and `doc`, so they rerun only on real changes, not per render; assertions about match counts after typing are unaffected because `doc` changes on every edit.

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

## Stock drawSelection extends line ends to the content right edge (not configurable)

CM6's stock `drawSelection()` deliberately extends every open line end of a selection to the content-box right edge and covers the lines between the first and last selected line with one full-width band. That geometry is hard-coded — there is no config to clamp it (discuss.codemirror.net threads 9495/9735).

Selection drawing is therefore vendored in `apps/desktop/src/tightSelection.ts` (ported from `@codemirror/view` 6.43.8, `NUB_PX` = 2): open line ends stop at the text end + nub (Modification A); open line starts share one `leftSide` for every fully-selected row, matching VS Code / Typora even when live-preview list/heading folds hide leading syntax, and that edge sits flush with the text because it includes `.cm-content`'s own horizontal padding (Modification D); intermediate lines draw per-line bars (Modification B). Multi-row selections snap bars vertically outward onto estimated row boxes inside their own block (Modification C), so glyph-sized `coordsAtPos` rects abut under `line-height` > 1. **Do not apply that estimate when both endpoints resolve to the same visual row.** The row count comes from `block.height / defaultLineHeight`; WKWebView/font metrics can make that ratio differ from the actual wrap count, and outward snapping then turns one selected visual row into two. Same-row ranges keep their endpoint y coordinates, which are already exact. Rows of a soft-wrapped (or widget line-broken) start/end document line that fall outside the drawn top/bottom row are painted as full-width remainder bands — intentional, since soft-wrapped rows reach the wrap margin anyway; the start-block and end-block remainders are deduplicated because the selection background is translucent and a doubly-painted row reads darker than its neighbours. Block widgets fully covered by the selection keep the rendered widget and add `omd-block-covered` overlay (`blockSelectionOverlay.ts`) — that full-block tint is separate from per-line tight geometry. `Editor.ts` mounts `tightSelection()` — never re-add stock `drawSelection()`; `apps/desktop/test/Editor.test.ts` fails if it returns because stock's `RectangleMarker.forRange` entry point fires for every cursor/selection draw while the vendored layer never calls it.

Whenever `@codemirror/view` is bumped, re-diff the vendored geometry and the copied blink/cursor code against the new upstream `drawSelection.ts`/`cursor.ts` and port upstream changes — otherwise the vendored copy silently drifts from the installed version's layer semantics. A guard in `apps/desktop/test/tightSelection.test.ts` compares the installed package version against the version recorded in the vendored file header and fails on a bump, so this is no longer a convention someone has to remember. It matters: upstream 6.43.7 shipped *"Fix incorrectly drawn selection when a line wrap point lies between widgets"* to `drawSelection.ts`, and vendored code receives no such fix automatically.

## highlightActiveLine paints nothing but is still load-bearing

`styles.css` overrides `.cm-activeLine` to a transparent background. CodeMirror's base theme paints it `#cceeff44`, a blue tied to no palette here, and because `highlightActiveLine()` emits a **line** decoration the tint covers every soft-wrapped row of a paragraph and the whole of a rendered block widget — so clicking a code block or table lit the entire block, which reads as "the block is selected". CodeMirror also applies it at `lineBlockAt(range.head)` with no empty-selection check, so it stays lit while dragging a selection; a screenshot showing two differently-tinted paragraphs is usually the selection in one and this in the other, not a selection bug.

The extension must stay mounted anyway: focus mode is `html[data-focus="on"] .cm-line:not(.cm-activeLine) { opacity: 0.35 }`, so the class is the only thing marking the line to keep bright. Removing the now-invisible extension would dim the entire document. `apps/desktop/test/Editor.test.ts` asserts both halves — the decoration reaches the DOM, and the override neutralizes it.

The override needs three classes (`.editor-host .cm-content .cm-activeLine`) because CodeMirror injects its base theme into the head *after* this stylesheet, so an equally specific rule loses on order. This applies to any base-theme override, not just this one.

That transparent override also strips **any** line-level background on the caret line: `.omd-codeblock` paints `--omd-code-bg`, so the code-block line the caret sits on went white while every neighbouring block line stayed gray — users read it as "the caret is outside the code block" (reported 2026-08-28). `.editor-host .cm-content .cm-line.omd-codeblock.cm-activeLine { background: var(--omd-code-bg) }` repaints it (four classes needed for the same order reason); if a future line-level class gains a background, it needs the same exemption. `blockWidgetLayout.test.ts` guards the rule.

## contentRect is the border box, and the theme pads .cm-content on all four sides

Stock `.cm-content` has `padding: 4px 0` — no horizontal padding — and upstream selection geometry is written against that, so `leftSide`/`rightSide` in `drawSelection.ts` add only the `.cm-line` padding to `contentRect.left`/`.right`. Our theme (`Editor.ts`) sets `padding: 16px 24px`, so every borrowed formula that treats `contentRect` as the content box is off by that padding. Symptom: fully-selected rows started 24px left of the text, so the highlight had a visible left overhang instead of Typora's flush edge. The vendored copy adds the content's own padding back (Modification D).

The vertical half is the same mistake with a different API. `BlockInfo.top`/`.bottom`/`.height` (from `lineBlockAt`, `viewportLineBlocks`, `blockAt`) are measured from `view.documentTop`, documented as *"the top of the first line, **not above the padding**"* — i.e. `contentRect.top + paddingTop`. `elementAtHeight(h)` likewise takes an offset from `documentTop`, not a client y. Upstream's own `drawForWidget` conflates the two; do not carry that over.

The editor theme sets `.cm-content { padding: 16px 24px }`, so the two origins differ by 16px against a ~25.6px line box — 0.63 of a row. When Modification C snapped marker geometry onto a grid anchored at `contentRect.top`, every single-row bar became two line-heights tall and shifted a row up, so selecting inside one line visibly highlighted three. The symptom is diagnostic: the displacement was a constant 16px regardless of font size, DPI, or display, because it equalled a hard-coded CSS constant. Geometry errors that scale with font size or differ per monitor are a different class of bug; ones pinned to a constant are arithmetic.

Related: `view.defaultLineHeight` is a default, not a document row pitch. This editor's line boxes are non-uniform (`.omd-h1/h2/h3` are 1.8/1.5/1.25em; table, code, math, and image widgets have arbitrary heights), so any synthesized document-wide grid drifts and the error accumulates downward. Read each block's real box and clamp into it — that bounds the worst case to over-painting inside the same block instead of bleeding onto a neighbour.

The fake-view harness in `apps/desktop/test/tightSelection.test.ts` originally modeled zero content padding and one uniform line height, encoding exactly the assumptions the code got wrong, so the suite stayed green through the bug. A test double for layout must carry the properties that break naive geometry — non-zero padding and non-uniform line boxes — or it only re-asserts the implementation.

## Selection colors must be driven by `--omd-selection-bg`; CM's dark flag is never set

Selections are painted by two systems. Editor text is drawn by the vendored `tightSelection()` layer as `.cm-selectionLayer .cm-selectionBackground` rectangles behind the text; block-widget DOM (table cells, code blocks) and focused nested editors (the table cell `<input>`) paint through the browser's native `::selection`. The two diverge the moment either stops consuming the theme token (verified 2026-08-28: dark mode painted light lavender behind light text; light mode painted native blue inside tables/code):

- CM's `&light`/`&dark` base-theme rules key off the editor's internal dark flag (`EditorView.theme(spec, {dark: true})` → `darkTheme` facet). Nothing in the app ever sets it, and `html[data-theme]` is CSS-only, so the editor is permanently "light" as far as CM is concerned: base `#d7d4f0` (focused layer) / `#d9d9d9` behind dark-mode text `#e8e8e8` is light-on-light, contrast ~1.2:1.
- `tightSelection.ts` vendors upstream's `.cm-content :focus ::selection → Highlight !important` rule for focused nested editors, and widget DOM outside `.cm-line` keeps native selection while dragging — both are native blue unless overridden.

`styles.css` therefore drives every surface from `--omd-selection-bg`: the full-chain `.editor-host .cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground` override (6 class selectors must outrank the base theme's 5 — CM injects its styles after this stylesheet, so ties lose on order, same as the active-line gotcha above), an `.editor-host .cm-editor .cm-content :focus ::selection` `!important` override against the vendored Highlight rule, and `.editor-host .omd-block ::selection` for drag-selection inside widgets. `apps/desktop/test/selectionTheme.test.ts` guards the pairing — if you touch selection styling, keep the test and this file in sync. The token stays translucent (0.55 alpha) on purpose: tightSelection's remainder-band dedup assumes translucent backgrounds (a doubly-painted row reads darker than its neighbours).

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

## CM base-theme `&dark` variants never apply — theme via CSS variables

No extension in the app ever passes `{dark: true}` to `EditorView.theme`, so every `&dark` rule in CodeMirror's built-in base theme is dead here: the caret stays `1.2px solid black`, the focused selection would be light `#d7d4f0`. On dark backgrounds this made the caret and selections invisible — the pre-fix dark selection token composited to 1.13:1 on `#1e1e1e` (spotted 2026-09-02).

This is deliberate architecture, not an oversight: all editor chrome colors flow through `html[data-theme]` CSS variables in `apps/desktop/src/styles.css` (the same tokens the "Load Custom CSS" feature overrides), and stylesheet rules outrank the base theme by selector specificity. Never fix dark mode by re-enabling the dark facet or adding a theme Compartment — that forks the color source and breaks single-token user theming.

- The caret is the vendored tightSelection overlay (`.cm-cursor` border-left boxes), not the native caret; `.cm-content`/`.cm-line` keep `caret-color: transparent` by design. Width/color overrides live in styles.css beside the selection rules.
- Focused vs unfocused selections are two separate rules: the 6-class focused chain must outrank CM's base 5-class focused rule; the plain 3-class rule carries the unfocused token.
- Nested editors inside `.cm-content` (the math popup's CodeMirror, the code-title input) draw **native** carets; the `caret-color: var(--omd-cursor) !important` rule on `.cm-content :focus` must keep `!important` to beat tightSelection's own `!important` restore. If a nested editor ever adopts overlay cursors, exclude its `.cm-content` there or carets double-paint.
- `apps/desktop/test/selectionTheme.test.ts` pins both the selector structure and WCAG contrast floors (computed with colord, alpha composited over `--omd-bg`) — update it together with any token change.
