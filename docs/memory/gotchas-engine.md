# Engine Gotchas

Deep-dive traps for `packages/engine` (parsing, decorations, widgets, live preview).
Condensed invariants live in [`packages/engine/AGENTS.md`](../../packages/engine/AGENTS.md); this
file holds the full stories. One-line index: [`known-gotchas.md`](./known-gotchas.md).

## Decoration ranges can invalidate the whole preview

CodeMirror replace decorations cannot overlap arbitrarily. A block widget that replaces a syntax node must suppress decorations from its subtree, and enclosing decorations wholly covered by the block must also be filtered.

Symptoms include `Decoration.set` throwing, disappearing preview content, or a feature working alone but failing inside blockquotes/lists.

Relevant code:

- `packages/engine/src/decorations/build.ts`
- `packages/engine/src/decorations/blocks.ts`

When adding a block rule, test the block by itself and nested under another Markdown construct.

## Editing state depends on selection, not only document text

Live preview rebuilds after selection changes. **Route A folding**: decorative marks (paired `**`/`~~`/`` ` ``, ATX/Setext heading marks, list marks) fold **unconditionally** — the caret never reveals them, so clicking text only places the caret and lines never reflow. The caret still reveals syntax whose source is the only editing entry (link URL/title, image, inline math, footnote reference/definition) when it enters that syntax's **own span** (node-level `cursorInside`; line-level reveal made any click in a soft-wrapped paragraph unfold every link on the line — the click-flash), and block widgets disappear when the caret (or a partially-overlapping selection) enters their source range **including both boundaries**. A selection that **fully covers** a block (`sel.from <= from && sel.to >= to` — Cmd+A, drag across, Shift+↓) keeps the widget rendered with the `omd-block-covered` overlay (`decorations/blockSelectionOverlay.ts`).

Rebuild ranges use `endLine.to + 1` as an **exclusive** end (the next line's `from`). Removal overlap must be half-open (`from < range.to`). A closed check drops the next line's point decorations (`line:omd-blockquote-N` at `line.from`). The incremental iterate does not re-enter the inner `Blockquote` that starts after that boundary, so a click on an empty `>` line leaves the following nested quote looking like a plain paragraph (marks still folded, bar gone). Deduplicate rebuilt specs against retained keys so decorations that only touch `range.to` are not added twice. Empty ranges (`from === to`, last empty line) stay closed so that line can still rebuild.

Boundary positions are intentionally different:

- Blank lines (no syntax node — scanned outside the tree iteration in `collectDecorationSpecs`) get `line:omd-empty` and render ~half height (Typora density), except the caret's own blank line (full height, the caret needs a line box; typing into a gap expands it). Non-empty selections never expand one — mid-drag height flips move `posAtCoords` endpoints (atomicRanges Rule 3 family). Never `display:none` a blank line: CM's heightmap and click mapping need a real box. Safe-mode pruning returns blank-line specs like any other decoration, which shifts line-aligned pending boundaries by the span of the blank line.
- Decorative marks fold unconditionally (Route A, see `types.ts`): paired emphasis/strike/highlight/underline/sub/sup/inline-code marks, heading marks, and list marks never flip on caret movement. Link/image/inline-math/footnote reveals use node-level `cursorInside` (same rule in and out of quotes). Editing affordance for folded marks: format toggle commands (`format/commands.ts`) and Backspace at a folded boundary (mid-line atoms delete whole via `skipAtomic`; line-start marks like `### ` delete one char per press = progressive demotion).
- QuoteMark is the exception among block marks: it folds unless the **caret** is inside `>` / `> ` itself, so typing `> ` hides the marker while the cursor stays on the same line. Non-empty selections never count as `cursorInside` — selection is visual.
- Nested quotes take their depth from the innermost `Blockquote` that owns the line (`omd-blockquote-N`). Do not paint every ancestor onto the same line.
- List indent inside a quote must start after the folded `> `; using `line.from` overlaps `replace:QuoteMark` and can make `Decoration.set` throw. List marks fold unconditionally (Route A) in and out of quotes.
- A list inside a quote and a quote inside a list must not share `omd-li-N`. List-in-quote keeps `omd-blockquote-N` + `omd-li-N` (bar at `--omd-bq-bar: 0`, hanging indent on). Quote-in-list emits `omd-quote-in-li-N` instead, which sets `--omd-bq-bar` to the list indent and disables hang. Reusing `omd-li-N` for both makes the quote bar jump inward on list lines. Fold leading spaces before `>` as `QuoteIndent`.
- Ordinary fenced code without language or inside a quote must stay as line styles (`omd-codeblock` + optional quote classes). Without a language specified, rendering an opaque `widget:block:code` collapses character-level line positions and breaks coordinate mapping / right-click cursor placement. A `widget:block:code` replace inside a quote also removes those lines from the document view and splits the quote into fragments. Fold `CodeMark` / `CodeInfo` with `cursorInside`. Mermaid still needs a widget; put quote/list depth on `BlockWidget.embed` so its chrome aligns. Quote-bar CSS should use `background-image` so it composes with `omd-codeblock`'s `background-color`.
- HTML entities (`&#x1f4da;`, `&#128218;`, `&copy;`) are built-in Lezer `Entity` nodes. Preview-replace them with `widget:entity` when the cursor is not inside the entity; do not rewrite the source. Decode numeric references with `String.fromCodePoint` (DOMParser in happy-dom truncates supplementary-plane emoji). Do not render arbitrary HTML tags. Unicode emoji in the source are already literal text.
- GitHub gemoji shortcodes (`:tada:`, `:+1:`) are a Lezer `Emoji` node only when the alias is in `parse/emoji.json` (unicode gemoji, no `:octocat:` images). Preview-replace with `widget:emoji` using `cursorInside`, not line-based `nearCursor`. Typing `:` opens a dedicated completion override that inserts Unicode and replaces the `:query`; do not enable generic `autocompletion()` in `createEditor`. Do not parse inside code, after a word character (`12:00`, `hello:smi`), or as `:)` emoticons.
- Headings fold `#` / Setext underlines unconditionally (Route A), in and out of quotes — the title can always be edited without showing the ATX marks.
- Block editing uses an **inclusive** range overlap in `blockSelected`.

The inclusive boundary is load-bearing: when the user finishes typing a closing fence, the cursor rests exactly at `node.to`. A strict (half-open) check treats that as "outside" and the widget swallows the block mid-typing, bricking the cursor at the boundary (M2 incident, root cause C). The block only renders once the cursor leaves it entirely (Typora behavior).

Do **not** keep a fenced `CodeWidget` mounted while the caret is inside the block. In-widget `contenteditable` plus `view.dispatch` during CodeMirror's update (blur/`ignoreEvent` keydown) throws `Calls to EditorView.update are not allowed while an update is in progress` and can freeze ArrowUp/Down. Lang fences must unmount to `styleCodeblockLines` when `blockSelected`; native source editing is entered by keyboard (↑/↓) **and by mouse**: the body click handler maps the clicked `span.line` to its content line and dispatches on **click** (not mousedown — browsers fire click after drags too, so a 4px drift guard separates enter-edit from native drag-select-copy; mousedown dispatch would unmount the widget mid-drag). The mousedown coordinate recorder runs in the capture phase so the header's own `stopPropagation` cannot leave stale coordinates. Widget chrome persists in both states: the mounted CodeWidget carries the header, and the editing state renders the same controls via `CodeChromeWidget` over the opening fence line (`buildCodeChromeControls` is shared; the editing header has no copy button — native text is selectable). Fenced content parses with its nested language (`parse/codeLanguages.ts`, lazy LanguageDescriptions) and highlights through `highlight/codeHighlight.ts` (CSS-variable palette, drift-tested in styles.css); lazy-load re-parse is driven by the view's measure loop, so happy-dom tests must `preloadMarkdownCodeLanguages()` first. Fence metadata writes go through `replaceFenceInfo` on the live widget range — constructor `infoFrom`/`contentFrom` drift after a prefix insert. Language picker option nodes must stay connected on `mouseenter` (toggle the active class); `replaceChildren` on hover drops the node under the pointer so a real click never fires. Shiki HTML includes `\n` between `span.line` blocks: if those spans are `display:block`, the extra text nodes become blank line boxes — put `display:flex; flex-direction:column` on `.omd-code pre code` so whitespace-only nodes are not flex items.

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

## Unclosed fences run to document end — never infer the close fence from `node.to`

CommonMark: an unterminated ```/~~~ fence swallows every following line into the FencedCode node. Two consumers got this wrong before:

1. **Enter completion** (`format/fences.ts`) must decide "unterminated" by counting CodeMark children (exactly one = no closing fence) — never by `node.to > line.to`, which is false for every mid-document fence (the node always reaches EOF), so completion silently never fired mid-document and users typed raw source.
2. **Editing-state decorations** (`blocks.ts styleEditingCodeblock`) must locate the closing fence via the real closing CodeMark child. Using `lineAt(node.to)` treats the last content line as the close fence and collapses (hides) it.



Replacing a whole line with a widget has two non-obvious traps (both verified against `@codemirror/view`'s line builder):

1. **Inline replace (`block` unset) leaves the line's strut.** It replaces only the text; the CM line box keeps the prose line-height alongside the widget, leaking a background-less band. This was the code-block "断档": the editing-state chrome header showed a gap between header and first content line.
2. **Block replace that includes the trailing newline swallows the next line's `line` decorations.** With a newline-inclusive range `[line.from, line.to+1]`, CM attaches the position at `to` (the next line's start) to the replaced block, so `line:` classes on the following line silently vanish from the DOM. Range-inclusive filters on spec lists have the same off-by-one at `to`.

Correct form for "this line becomes a widget": `Decoration.replace({widget, block: true})` over the line's text `[line.from, line.to]` — the builder gives the widget its own line box (height = widget height, no strut) and the next line keeps its classes. The CloseFence collapse (`replace:CloseFence`, no widget) is the opposite case: it must stay newline-inclusive to remove the line entirely.

## atomicRanges: only inline replacements — never block widgets

The `atomicRanges` facet makes ranges un-enterable for cursor motion and deletion. Two rules govern what belongs there:

**Rule 1 — no `mark:`/`line:` tags.** Feeding those into the atomic set locks the user out of every styled region (arrow keys skip, Backspace refuses; M2 incident, root cause B).

**Rule 2 — no `widget:block:*` tags.** Block widgets span multiple lines. Adding them to `atomicRanges` causes two user-visible bugs:
- **↑/↓ jumps multiple lines**: when the cursor is below a code/math/table widget and the user presses Up, CodeMirror skips the entire atomic range and lands at the first line before the widget — which can be the very start of the document.
- **Right-click paste inserts extra line**: when the paste position is adjacent to a block widget boundary, CodeMirror expands the replacement range to cover the atomic unit, pulling in the next line.
Block widgets use `Decoration.replace({ block: true })`, which CodeMirror already handles for layout and cursor positioning. Atomic constraints are redundant and harmful on top.

**Rule 3 — no line-start or cross-line atoms.** `skipAtomsForSelection` (pointer-origin selection sync) pushes selection endpoints outward to atomic boundaries in a loop. A line-start atom (`# `, `> `, `- `, list indent/mark) lets a pushed endpoint cross the newline and land inside the next line's line-start atom, cascading again — "clicking a line highlights the next one". A cross-line atom (Setext `replace:HeaderMark`, `block: true` spanning `line.to + 1`) does the same. Excluding them stays safe under Route A: a caret resting inside a folded line-start mark is invisible (the mark never reveals) and harmless — there is no reveal left to make atomicity redundant-or-needed; do not widen the atomic set to "fix" it.

`buildLiveDecorations` therefore emits two sets: `deco` (everything) and `atomic` (`isAtomicSpec`: tags starting with `replace:` or `widget:`, **excluding** `widget:block:*`, and only when the range is mid-line — `spec.from > line.from && spec.to <= line.to`). Never widen it without re-reading this entry.

## Selection is visual, the caret is editing

The reveal policy (Route A): **a non-empty selection never reveals anything; decorative marks never reveal even to a collapsed caret; the caret reveals only link/image/math/footnote spans (node-level) and block sources**:

- `nearCursor` returns false for any non-empty selection (no line reveal while dragging) and is used only by blank-line density (`build.ts`) — its unit is a line by definition.
- `cursorInside` is collapsed-caret-only (`sf === st && sf >= from && sf < to`); the old non-empty overlap branch and its triple-click special case are gone. It serves QuoteMark, fence marks, entities/emoji, and every link/image/inline-math/footnote reveal. Link-family gating is **node-level, never per-child**: the caret in link text is inside the LinkMark span but outside the URL span, so per-child gating produces a half-revealed `[text](` state.
- Decorative marks (emphasis pairs, heading marks, list marks) consult neither — they fold unconditionally (`decorations/types.ts` documents the split).
- `blockSelected` treats full coverage (`sel.from <= from && sel.to >= to`) as "not editing": the widget stays mounted and `blockSelectionOverlay` toggles `omd-block-covered` on its wrap. Partial overlap (one endpoint poking into the block) is still edit intent and reveals source.

Why beyond taste: during a drag, reveal/fold flips relayout the lines under the pointer, so `posAtCoords` maps the same mouse position to shifting document positions — the endpoint drifts across newlines (feeding the atomicRanges Rule 3 cascade). Keeping the preview stable during selection removes that jitter at the source.

Companion: ArrowUp/ArrowDown (`navigation/blockEntry.ts`, `Prec.high`, Live-only) dispatch a caret inside an adjacent block widget — the keyboard path into a block mirrors the mouse click. `blockEntryPosition` skips fence/delimiter lines (```/~~~/$$) so the caret lands on the first/last content line. Shift+arrows deliberately fall through to default motion so cross-block selections cover rendered blocks.

## Tests may need to force the syntax tree

Lezer parsing is incremental. Directly creating an `EditorState` does not guarantee that the full document tree is available at the point a test inspects it.

Use `packages/engine/test/helpers.ts::makeState` for parser/decoration tests that require the complete tree. When the initial synchronous parse is incomplete (large docs), it mounts a temporary `EditorView` and calls `forceParsing` to completion, then detaches.

Note: production decorations are provided by a `StateField` and updated incrementally from changed ranges, selection, and syntax-tree progress. Tests that inspect a complete tree should still use `makeState`.

`ensureSyntaxTree` without an `EditorView` only advances parsing to the viewport boundary (near zero for a fresh state), because `@codemirror/language`'s `ParseWorker` schedules background work via `requestIdle`/`setTimeout` only when a view is attached. For large documents in `incremental.test.ts`, this caused flaky failures under CPU load: the `livePreviewField` StateField captured a partial `treeLength` at creation and only added decorations for newly-parsed regions on update, so `specKeys(incremental)` vs `specKeys(fresh)` diverged depending on how far the fresh state's initial parse got. The fix is `liveState` in that file: mount a temporary `EditorView`, call `forceParsing(view, doc.length, 10000)`, then detach — the complete tree survives `view.destroy()`. Compare the incremental field against `buildLiveDecorations(state)` (a direct full rebuild on the same state) rather than a freshly created state, which avoids both the view-attachment requirement and happy-dom DOM lifecycle issues from repeated view creation. The same partial-tree trap applied to `makeState` + `large.md` in `snapshot.test.ts` (the recorded snapshot only covered the first ~3000 chars of a 50 KB doc, passing only because the parse boundary happened to be stable); `makeState` now completes the parse and that test snapshots a deterministic `[0, 3000)` prefix.

When comparing decoration specs across an edit, `changedSpecCount` must map before-specs through the transaction's `ChangeDesc` so specs that merely shifted position (same tag, moved by the edit delta) don't count as "changed." Without this, any edit in a fully-parsed large document reports a near-total change count because every spec after the edit point shifts.

## Block widget geometry can desync CodeMirror's heightmap; clicks land far from the pointer

Verified 2026-08-26 in real-browser reproductions (Chrome + `@codemirror/view` 6.43.8). Four independent defects affected block-widget geometry and click-to-edit:

1. **Stale heightmap (the "huge" offsets).** `CodeWidget`, `MathBlockWidget`, and `MermaidWidget` render into the widget DOM asynchronously (dynamic imports plus Shiki/Mermaid debounce). If `toDOM()` returns an empty body, CM's first measure records near-zero height. The engine calls `view.requestMeasure()` after the DOM write, but CM's `ViewState.measure()` only re-reads DOM heights when `measureContent` is true — set by `Content.updateInner` (a DOM-redrawing transaction), a metrics refresh, or a content-box resize. `.cm-content`'s inline height is pinned to the stale map (`tile.dom.style.height = contentHeight`), so the resize check never fires. Measured: widget DOM 250 px tall while `viewState.docHeight` counted it as ~one line (148 px total for a 900 px document). Every `posAtCoords`/`elementAtHeight` under the widget is then shifted by the overflow (~200 px ≈ many lines); a click on rendered row 1 resolved to the line *after the whole block*. The map heals on the next content-editing transaction (`mustMeasureContent`), which is why the first click on a freshly opened document is the worst and the bug looks intermittent.
2. **Opaque replace quantizes interior clicks (±N lines even with a correct map).** For a `block: true` replace range, CM's `posAtCoords` can only return `block.from` (click in top half) or `block.to` (bottom half) — rendered Shiki rows have no position mapping. With a healed map, clicking rendered row 1 returns the opening-fence start (one line above the first code line); clicking lower rows returns the closing-fence end. The comment in `blockWidget.ts` claiming `posAtCoords` "单击和双击均落到正确位置" is wrong for block widgets. This is the same reason no-language fenced code stays as line styles (see the earlier fenced-code entry); with-language blocks get the widget and therefore the quantization.
3. **Vertical margins are outside CM's measured block DOM.** CodeMirror explicitly forbids vertical margins on block decorations; put whitespace inside the widget instead. `styles.css` had `margin: 0.5em 0` on every `.omd-block`, plus table/hr overrides. In a 30-code-block browser reproduction, `contentDOM.getBoundingClientRect().height` exceeded `view.contentHeight` by the mounted margins and virtualized rows no longer lined up with the scroll viewport. Clicking a visible row near the bottom could target another row several blocks away. Replace wrapper margins with vertical padding; borders/overflow that should not surround that padding belong on `.omd-block-body`. `apps/desktop/test/blockWidgetLayout.test.ts` guards this CSS contract.
4. **`eq()` is not identity.** Decoration rebuilds intentionally reuse a widget DOM when `src`/`embed` are equal, but two distinct blocks may also have identical source. A range lookup that accepts the first `candidate.eq(widget)` binds the second DOM to the first block. Always prefer `candidate === widget`; for a rebuilt instance, use the DOM's structural position (or its validated range cache) to choose the equivalent spec at that exact `from`. Never use an unqualified first-`eq()` fallback. `view.test.ts` covers two identical code blocks.

Before the fix, clicks could land on an arbitrary nearby line (depending on document layout), while arrow-key entry remained correct because `navigation/blockEntry.ts::blockEntryPosition` maps to source itself. The two required paths are: code rows map to source lines directly (skipping fences), while opaque blocks map to the current replacement range start. Every async widget must also render a synchronous placeholder and refresh the decoration StateField after its final DOM write; bare `requestMeasure()` is not sufficient.

Status update (implemented): code, math, and Mermaid blocks install synchronous source placeholders during `toDOM()` before CodeMirror's first layout measurement, then refresh the owning StateField after async DOM changes. Generic opaque blocks enter source from their current `livePreviewField.specs` range instead of stale constructor offsets or quantized `posAtCoords`; code clicks additionally map rendered `.line` rows to source lines. Identity-first lookup keeps duplicate blocks separate. All block whitespace is padding inside the measured DOM, never a vertical wrapper margin.

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
- Widget `eq` compares the full `TableData` model via `JSON.stringify` — every cell's `source` and table-relative range (`model.ts`), not just display strings — so an unchanged table reuses its DOM and any authored range change rebuilds. The model is extracted once per build by `tableDataFromNode` (Lezer-derived, see the table-editing entry below); never re-derive it from re-serialized strings, and never store it in a module-global.
- Cell `mousedown` must `preventDefault` + `stopPropagation`. `BlockWidget.toDOM` moves selection into the table source on wrap `mousedown`, which unmounts the widget; without stopping the bubble, in-place `input.omd-table-edit` never stays mounted.
- Opening the cell input must place a collapsed caret, not call `input.select()`: native selected input text is a dark-blue rectangle that looks like a selected table cell. The input chrome is intentionally transparent/borderless. With `table-layout:auto`, `input { width:100% }` also contributes its default 20ch intrinsic width and makes the column jump; use `width:0; min-width:100%` to fill the already-sized cell without changing the table's intrinsic column calculation.

## Table edits are Lezer-range-based and per-view; ragged cells are deliberate placeholders

The GFM render parser accepts ragged rows (missing tail cells) and escaped pipes, while the edit model (`tables/model.ts::tableDataFromNode`) is stricter: it needs a real header + separator, and a ragged row's missing tail is a `null` cell in `TableData`. The preview grid therefore shows synthetic cells that have no source slot — they render with `omd-table-cell-missing` / `aria-disabled="true"` and cannot open an input (there is no source range to commit). That visibility-without-editability is intentional: ragged synthetic cells stay disabled, and Tab from a real cell toward a synthetic slot commits the current cell without opening it. Refining ragged cells (e.g. filling slots on Tab) is a deferred manual-check follow-up, never hidden support.

- **Never restore a whole-table `splitCells`/serialize parser for edits.** All five helpers (`replaceTableCell`, `insertTableRow`, `insertTableColumn`, `deleteTableRow`, `deleteTableColumn`) return table-relative `TableSourceChange` ranges; the widget adds `livePos()` only at dispatch, so every source byte outside the edited cell/row/column — spacing, one-sided outer pipes, alignment markers, quote/list prefixes — stays byte-identical.
- **Never use module-global focus continuation.** `pendingTableEdits`/`pendingTableTools` are `WeakMap<EditorView, …>` values keyed to the table's live position (`livePos()`, not a captured constructor offset), consumed in the rebuild's microtask. A module-global resume token makes one tab's Tab/Shift-Tab continuation open an input in another tab's table (two tabs "steal" each other's focus).
- **Real `EditorView` tests are mandatory.** Mock dispatch proves the transaction shape, but only a real view rebuild proves the widget focuses the next cell, final-cell Tab appends a row, prefix insertion keeps positioning, and two views never share pending focus (`view.test.ts`); `exceptionSink` must stay empty across rebuilds.

## Async widgets can outlive their original DOM

Mermaid, Shiki, and other renderers may resolve after CodeMirror has replaced or removed a widget because the user moved the cursor or continued typing.

Check `el.isConnected` after meaningful awaits and before writing DOM. Keep errors inside the widget fallback instead of allowing rejected promises to escape into the editor.

`BlockWidget.eq` compares source text and `embed` (not `pos`). The `pos` field was removed from equality after the click handler was switched from a captured constructor offset to `view.posAtCoords`, making the captured position no longer load-bearing for correct click behavior. Removing `pos` prevents spurious Shiki/KaTeX/Mermaid re-renders when text is inserted before a widget (pos shifts, src unchanged). `embed` must stay in equality so a widget that moves into or out of a quote/list rebuilds its chrome. `ImageWidget` never included `pos` in `eq`; `BlockWidget` now follows the same rule for `pos`.

If rendering depends on an input beyond `src` (e.g., `lang` for `CodeWidget`, cell data for `TableWidget`, resolver output for `ImageWidget`), that input must still participate in the subclass `eq` override.

If output also depends on theme, resolver, or another option, include that dependency in equality or trigger an explicit rebuild.

Valid Mermaid diagrams can stall inside `mermaid.render` under `happy-dom` without producing SVG or an error. Cover success SVG with a mocked `mermaid` module; keep the real library for the invalid-syntax view test.

## Lezer has runtime-only internals missing from the typings

`Line.depth` and `BlockContext.stack` exist at runtime (the built-in parsers use them) but are absent from `@lezer/markdown`'s public type declarations. `vitest run` does not typecheck, so such misuse passes tests and only explodes under `tsc --noEmit` (which `pnpm --filter @omd/engine test` now runs first) or the stricter desktop tsconfig (`noUnusedLocals` etc., which also typechecks engine sources through the workspace import).

Pattern used in `parse/footnotes.ts` and `parse/math.ts`: cast `(line as unknown as { depth: number }).depth`, and prefer the public equivalent when one exists (`cx.depth` === internal `stack.length`). Always leave a comment on the cast.

## Desktop `defaultKeymap` is registered before engine keymaps

CodeMirror concatenates keymap facets in extension order and **runs earlier bindings first**. Desktop `createEditorState` mounts `keymap.of([...defaultKeymap, ...historyKeymap])` *before* `editorExtensions()`, so `Enter` is `insertNewlineAndIndent` unless the engine binding uses `Prec.high`.

`@codemirror/lang-markdown` already wraps its markup-continue Enter in `Prec.high`. `listKeymap` must do the same (`packages/engine/src/format/lists.ts`), or list Tab/Enter lose whenever the markdown command returns false (incomplete syntax tree, non-list markup). Spec-only `continueListSpec` tests cannot see this — instantiate a real `EditorView` with host keymaps first.

## Parser character codes are named, not magic

The hand-written Lezer inline parsers compare `cx.char(i)` against ASCII codes. Bare numbers (`61`, `95`, `92`, …) are unreadable and easy to mistype; `packages/engine/src/parse/chars.ts` names them (`CHAR_EQ`, `CHAR_UNDERSCORE`, `CHAR_BACKSLASH`, …). New parse rules must import these constants instead of literal codes — the engine build has no lint gate, so follow the convention by review.

## Doc-start `---` is front matter, not a thematic rule

Since the FrontMatter parser landed, the first line `---` of a document always opens a front matter block (unclosed blocks swallow to EOF, matching the math-block tolerance). A document that merely starts with a horizontal rule is therefore rendered as front-matter source until a second `---` appears — this flipped `blocks.test.ts`'s hr-at-doc-start case, which now uses a mid-doc rule. The same ambiguity drives the stats stripper in `stats.ts` (leading `---`…`---` pair stripped from counts) and exists in every front-matter-aware renderer.

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

## Multi-line link constructs leave a dangling empty preview row

Multi-line link constructs (`[text](url\n"title")` — a newline in the
URL/title separator) leave a dangling empty visual row in live preview because
the title fold's backward scan correctly stops at `line.from`; this is
cosmetic and rare with no crash (verified: StateField-provided replaces
spanning line breaks are safe in CM 6.43.8).

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
