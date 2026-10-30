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

- Blank lines emit zero line decorations and keep full natural height at all times, avoiding any layout jitter or viewport jump when entering or leaving an empty line. Never `display:none` a blank line: CM's heightmap and click mapping need a real box. Safe-mode pruning returns blank-line pending ranges like any other span.
- Decorative marks fold unconditionally (Route A, see `types.ts`): paired emphasis/strike/highlight/underline/sub/sup/inline-code marks, heading marks, and list marks never flip on caret movement. Link/image/inline-math/footnote reveals use node-level `cursorInside` (same rule in and out of quotes). Editing affordance for folded marks: format toggle commands (`format/commands.ts`) and Backspace at a folded boundary (mid-line atoms delete whole via `skipAtomic`; line-start marks like `### ` delete one char per press = progressive demotion).
- QuoteMark is the exception among block marks: it folds unless the **caret** is inside `>` / `> ` itself, so typing `> ` hides the marker while the cursor stays on the same line. Non-empty selections never count as `cursorInside` — selection is visual.
- Nested quotes take their depth from the innermost `Blockquote` that owns the line (`omd-blockquote-N`). Do not paint every ancestor onto the same line.
- List indent inside a quote must start after the folded `> `; using `line.from` overlaps `replace:QuoteMark` and can make `Decoration.set` throw. List marks fold unconditionally (Route A) in and out of quotes.
- A list inside a quote and a quote inside a list must not share `omd-li`. List-in-quote keeps `omd-blockquote-N` + `omd-li` (bar at `--omd-bq-bar: 0`, hanging indent on). Quote-in-list emits `omd-quote-in-li` instead, which sets `--omd-bq-bar` to the list indent and disables hang. (These were numbered `omd-li-N` classes capped at four until depth became a CSS variable — see the depth entry below — so old symptoms name the numbered classes.) Reusing the list class for both makes the quote bar jump inward on list lines. Fold leading spaces before `>` as `QuoteIndent`.
- Fenced code splits by state, not by location: **rendered** language blocks (in or out of a quote) are a `widget:block:code`; a **rendered** language-less block stays line styles (`omd-codeblock` + quote classes) because there is nothing to highlight and an opaque widget would collapse character-level positions; the **editing** state (caret inside, any language, language-less included) replaces only the opening fence line with `CodeChromeWidget` (`styleEditingCodeblock`), which is also the only GUI path to add a language to a block that has none. Fold `CodeMark` / `CodeInfo` with `cursorInside`. Mermaid still needs a widget; put quote/list depth on `BlockWidget.embed` so its chrome aligns (that is what makes an in-quote code block render like any other block — the older "in-quote fences stay line-styled" rule is gone). Two consequences worth remembering: the opening-line replace drops that line's `line:omd-blockquote-N` decoration, so the chrome must carry its own quote classes; and `.omd-code` / `.omd-code-header` set an opaque `background` shorthand that erases the quote bar painted by `.omd-blockquote*` (see the desktop gotcha on `--omd-bq-image`).
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

The rendered and source-editing forms can still have different per-row heights
under WebKit or user font/line-height settings. A click on rendered row N must
record that row's viewport top, dispatch the source selection, then use
`requestMeasure` to read the new `.cm-line` top and adjust `scrollDOM.scrollTop`
by the delta. Fixed pixel heights only hide the problem for one font; immediate
DOM reads race CodeMirror's measure phase. The real-browser guard deliberately
changes source-row line height and asserts that the clicked row stays anchored.

## Block widgets must declare `estimatedHeight` — CM assumes one line otherwise

Verified 2026-09-09 against `@codemirror/view` 6.43.8 source (root cause of scroll jank on table-heavy ~200 KB documents). `WidgetType.estimatedHeight` defaults to `-1`, and the height mapper estimates any block widget with an unknown height as **one line height** (`HeightMapper.point`: `if (height < 0) height = this.oracle.lineHeight`). A 20-row table (~900 px) is estimated at ~26 px until first draw. The viewport (visible px ± 1000 px `VP.Margin`) is converted to a character range **using those estimates**, so under-estimation makes one scroll step cover far more content than fits: many heavy widgets get `toDOM()` in a single update, then `measureVisibleLineHeights` (forced layout reads) corrects the map, `contentHeight` jumps, the viewport recomputes, and the redraw/measure loop repeats — the classic "scroll through big block widgets is janky and the scrollbar jumps" (upstream: codemirror/CodeMirror#5873, discuss.codemirror.net/t/9372).

Rules:

- Every `block: true` widget declares `estimatedHeight` via the named constants in `src/decorations/widgetHeights.ts`. The table estimate is **wrap-aware** (per-cell text length → estimated wrapped lines at an even column split, capped): a flat 42px/row looked calibrated on single-line cells (0.15% on a synthetic table) but underestimated a real 5-column doc by **8.4%** of total content height — enough to visibly desync the scrollbar thumb; wrap-awareness brings real docs to ~1–2%. New block widgets must register an estimate there — `test/widgetHeights.test.ts` fails on a block widget without a positive estimate.
- Estimates only need to be within ~2x: first draw replaces them with measured heights, and heights of out-of-viewport blocks persist in the height map, so the estimate matters only for never-drawn or re-entered blocks. User font scaling skews px constants proportionally — acceptable.
- Bench `bench/tables.bench.ts` reports the regression guard: `tableEstimateGain` (estimated px vs a line-only baseline) collapses to ~1x if someone removes the estimates; `measureTableDrawsMs` is the per-table viewport-entry cost baseline for the follow-up render-cache work (a table re-renders from scratch on every re-entry — no cache, unlike code HTML).

## Decoration rebuilds must preserve equivalent widget identity — CM resets measured heights otherwise

Verified 2026-09-10 against `@codemirror/view` 6.43.8 (the "wheel down, position rolls back a bit / scrollbar thumb drifts while dragging" symptom on table-heavy documents). CM's `ViewState.update` derives height-relevant ranges via `heightRelevantDecoChanges`, whose `DecorationComparator.comparePoint` does **not** call `eq()` — any point-decoration **identity** change marks the range height-relevant, and `applyChanges` then rebuilds that region of the height map from `estimatedHeight`, **discarding measured heights**. Our `measureBlockWidget` effect (dispatched after every block render) rebuilds the block's specs: before the fix the old spec was dropped and a brand-new equivalent widget added, so every rendered block oscillated measured → estimate → measured — visible as scroll rollback and thumb/content desync.

Rules:

- `updateLiveDecorations` reuses the dropped spec object when a rebuilt spec has the same `tag`/`from`/`to` and `oldWidget.eq(newWidget)` (`build.ts`, `removedByKey` pass). Decoration identity preserved ⇒ no height-relevant change ⇒ height map untouched.
- Reuse is equivalence-gated on widgets only: non-widget decorations (line/mark/inline replace) churn harmlessly (`compareRange` is a no-op for the height map), and a widget whose inputs changed (`eq` false — edited cell text, changed label) must rotate to a new instance so CM refreshes DOM.
- `test/specIdentity.test.ts` guards both directions: `measureBlockWidget` keeps the instance identical (and `view.contentHeight` stable); a content edit rotates it.
- Estimate calibration matters too: with identity reuse, the estimate→measured correction happens exactly once per block (first draw), so a well-calibrated estimate makes even that one-time correction small. Calibration tooling: `apps/desktop/e2e/calibrate-heights.mjs` (block heights in real Chromium) and `apps/desktop/e2e/scroll-audit.mjs` (`估算总高 vs 全文测量后的实际总高` on a real document — the direct thumb-desync metric). Residual error is inherent: never-drawn regions are estimated, so dragging the thumb into them lands within ~2% and converges as CM measures.

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
- Reference-style links and images (`[text][id]`, `![alt][img]`) resolve inside cells only
  when the caller supplies a document-scoped resolver: `parseCell` takes
  `{ resolveReference }`, and the table widget (`decorations/blocks.ts` → `TableWidget` →
  `renderCellSlot`), `exportHtml`, and `exportRichHtml` all pass one from the same
  `MarkdownReferenceContext`. The no-resolver convenience `renderTableCellContent(parent, text)`
  has only the cell itself as context, so a cell referencing a definition elsewhere renders
  the reference as literal text — not a bug, but do not call it from a document-backed path.
  Unresolved references stay visible source in every path.
- Image `src` is threaded through the host `imageResolver` facet into `TableWidget` (constructor arg, not part of `eq` — it is stable per editor config). `renderTableCellContent(parent, text)` is the public no-resolver convenience used by tests.
- Widget `eq` compares `src` + `embed` first and then the cheap lazy `tableEqualityKey` (cell `source`s + alignments + shape) — never `JSON.stringify(table)`, which serialized every cell on every rebuild pass. An unchanged table reuses its DOM; a changed cell reaches `updateDOM`, which patches only the changed cells in place (see the table in-place-refresh entry below). The model is extracted once per build by `tableDataFromNode` (Lezer-derived); never re-derive it from re-serialized strings, and never store it in a module-global.
- **Rendered state has no per-cell event intercept.** `BlockWidget.toDOM` moves the selection into the table on wrap `mousedown`; that is the only path that turns a cell click into source editing (`TableWidget.clickPos` maps the clicked `td/th` to its exact source offset). A `mousedown` listener on the cells that calls `stopPropagation`/`preventDefault` swallows it — that legacy in-cell input handler is exactly what kept `e2e/table-source.spec.ts` red. Toolbar buttons are the opposite case: they must `preventDefault` + `stopPropagation` on `mousedown`, else the wrap handler unmounts the widget before the `click` lands.
- **Do not reintroduce a cell `<input>` overlay.** The table has two states only (rendered widget / `omd-table-src` source grid); "which cell is being edited" is `state.selection`, never widget state. An in-cell input needs its own commit/cancel/pending-focus state machine (~320 lines, deleted in the table-source-editing work) and silently breaks undo, find, autosave and crash recovery for table edits.

## Table edits are Lezer-range-based and validated at dispatch; ragged cells are deliberate placeholders

The GFM render parser accepts ragged rows (missing tail cells) and escaped pipes, while the edit model (`tables/model.ts::tableDataFromNode`) is stricter: it needs a real header + separator, and a ragged row's missing tail is a `null` cell in `TableData`. The preview grid therefore shows synthetic cells that have no source slot — they render with `omd-table-cell-missing` / `aria-disabled="true"`, never take a toolbar hover target, and are skipped by source-mode navigation because `tables/navigate.ts::slotsOf` only emits slots that have a source range. That visibility-without-editability is intentional; refining ragged cells (e.g. filling slots on Tab) is a deferred manual-check follow-up, never hidden support.

- **Never restore a whole-table `splitCells`/serialize parser for edits.** All structural helpers (`insertTableRow`, `insertTableColumn`, `deleteTableRow`, `deleteTableColumn`, `setTableColumnAlignment`) return table-relative `TableSourceChange` ranges; `tables/sourceToolbar.ts::applyTableToolAt` converts them to absolute offsets, so every source byte outside the edited row/column — spacing, one-sided outer pipes, alignment markers, quote/list prefixes — stays byte-identical.
- **Rendered-toolbar targets come from hover, never from remembered state.** `TableWidget` records row/col on `td/th` `mouseover`, keeps the buttons `disabled` until `hasRowCol()`, and each click calls `applyTableToolAt(view, livePos(), src, table, row, col, act)`. That core re-checks `(from, source)` against the live document and returns `false` on any mismatch — a widget that rendered before an unrelated edit must never write its stale offsets. Never re-add a pending-action queue: a remembered target that outlives the click is how two views "steal" each other's edits.
- **Real `EditorView` tests are mandatory.** Mock dispatch proves the transaction shape, but only a real view proves hover → toolbar → `applyTableToolAt` lands on the right table/row/column after a widget passes through `updateDOM` instance rotation (`view.test.ts`, `tableUpdateDOM.test.ts`, and `tables.test.ts`'s two-view isolation case); `exceptionSink` must stay empty across rebuilds.

## A focused table must skip its subtree after emitting source lines

`decorations/blocks.ts` 的 `case "Table"` 有两个分支：`blockSelected` 为真时它调用
`styleTableSource()` 产出 `line:omd-table-src*` 源码网格，然后**必须 `return true`**
跳过子树。`return false` 会让 `inlineRules` 走进单元格，折叠 `**` 并加粗文字 ——
源码态直接变成"半个预览"（用户要看的是原始标记，不是渲染效果）。渲染态分支同样
`return true`（推完 `widget:block:table` 就返回），所以漏写这行的改动在渲染态测试里
毫无反应，只在源码态可见。

唯一守卫：`test/tableSourceDecorations.test.ts` 的 `INLINE_DOC` 用例 —— 先证明表格
确实在源码态（三条 `line:omd-table-src`、无 `replace:`），再断言没有 `mark:omd-strong`。
前两条断言不是凑数：删掉它们，"没有 mark"会因为"什么都没生成"而假绿。

## Table keymap only sees non-composing keydown

`@codemirror/view` 6.43.8（`dist/index.js:4553`）在派发 keymap **之前**调用
`this.ignoreDuringComposition(event)`：`this.composing > 0` 的按键直接丢弃；Safari 上
还包括 `compositionend` 之后 100ms 内的 `compositionPendingKey`（那台浏览器会把
compositionend 与 keydown 的顺序颠倒，确认用的 Enter 因此晚到）。组词中的 Enter/Tab
根本不会进入 `tableKeymap` —— "IME 会不会被抢键"这个问题上游已经答了。

不要因为这份担心在 `format/tableKeymap.ts` 的命令里再加一层 `isComposing` 守卫：
重复守卫会让输入法在 Windows 上丢候选确认（Enter 被吞，候选字永远不落格），
而这正是已删除的 cell `<input>` 曾经需要自带守卫的原因 —— 主机级 keymap 不需要。

## Table Tab must not fall through to indentation when the tree is unresolved

`tables/navigate.ts::tableAt` 依赖 `syntaxTreeAvailable`：大文档刚打开、刚滚到未解析区、
或刚粘贴时，语法树还没覆盖光标，查表一律返回 `null`。此时 `Tab` 若直接 `return null`，
按键会落到 `defaultKeymap` 的 `indentMore` —— 它把空白写进表格行首，静默破坏表结构
（`| a | b |` 变成 `  | a | b |`，缩进超过 3 空格 GFM 就不再认这一行）。

`format/tableKeymap.ts::unresolvedTableRowSpec` 因此只在**树答不上来**时启用一条形状
兜底：光标所在行匹配 `^[ \t]*(?:>[ \t]*)*\|` 就吞掉 Tab/Shift-Tab（返回一个
selection-only spec），否则照常放行。树可用时一律以语法树为准，绝不把"以 `|` 开头的
普通段落"也吞掉。Enter/Shift-Enter 刻意不套这条兜底：换行是用户可见、可撤销的常规
编辑，吞掉它比让用户重敲一次更意外。

守卫：`test/tableKeymap.test.ts`「unresolved syntax tree inside a table row」三条用例
（构造 12KB 未解析文档，断言 Tab 被吞、Shift-Tab 被吞、普通段落仍放行）。

## Table Enter exits on the final row; only Tab appends

Enter 在表格里只做「同列下移」。到了末行（以及 `Table.to` 边界 —— 末行 End / Cmd+→ 可达）
它必须复用 `exitTableSpec`，和 Mod-Enter 同一套幂等规则：后面已有空行就只移光标，表格
在文末则补 `\n\n`。曾经的末行分支是 `appendRowSpec`：手指停在 Enter 上就把表无限加长
（每按一次多一行 `|  |  |`），而这份源码增长用户完全没要。加行因此是 Tab 的专属动作
（`tableNextCellSpec` 仍走 `appendRowSpec`），Enter 与 Shift-Enter 一行都不会加。

死路一条：末行 `return null` 会落到上游 `insertNewlineContinueMarkup` / host 的
`insertNewlineAndIndent`，那不是「不做事」而是往表格源码里写一个原始换行 —— 表被拆开。
表格分支返回 null 和返回「什么都不做」是两件不同的事。

守卫：`test/tableKeymap.test.ts`（末行两格都退出、末行文末补空段、非末行照常下移、
`Table.to` 与前一字符等价）+ `test/tableKeymapWiring.test.ts`（真实 keymap 链下末行 Enter
文档不变、光标落到空段，末格 Tab 仍加行）+ `apps/desktop/e2e/table-navigation.spec.ts`。

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

CodeMirror concatenates keymap facets in extension order and **runs earlier bindings first**. Desktop `createEditorState` mounts `keymap.of([...defaultKeymap, ...historyKeymap])` *before* `editorExtensions()`, so `Enter` is `insertNewlineAndIndent` unless the engine binding carries an explicit `Prec`.

`Prec.high` is the right level only for bindings nothing upstream competes for (`blockMotionKeymap`, `caretClampKeymap`, the auto-pair Backspace). Every structural **Enter**, list `Tab`/`Shift-Tab`, and empty top-level list Backspace must sit at **`Prec.highest`**: `@codemirror/lang-markdown` pushes its own `Prec.high` Enter (`insertNewlineContinueMarkup`) and Backspace (`deleteMarkupBackward`), and `markdownLanguageSupport()` is the first extension, so at equal precedence the upstream command wins. The upstream Backspace deliberately replaces an empty `2. ` marker with three spaces to make nesting convenient; in Live editing this means replacing `2. ` with `- ` silently produces `   - ` under item 1. The engine owns the narrower Typora-style rule: only a prefix-only, top-level list line with the caret at its end exits the list; nested items, non-empty items, and explicit marker editing still yield upstream. Spec-only tests cannot prove ownership — use the real keymap chain and browser E2E (`test/enter-ownership.test.ts`, `e2e/list-editing.spec.ts`).

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

## 逐键基准有三种口径，不能互相替代

`bench/measure.ts::measureTyping` 的 `{ tree, drain }` 组合是三个**不同**问题，报告时
必须写明是哪一种（`prepareTypingView` 就是这段准备逻辑的导出形态，`measureTyping`
只计时 dispatch 循环）：

| 口径 | 组合 | 回答的问题 |
|---|---|---|
| 种子后立刻打字 | `tree:"steady"`（默认） | 挂载/切 Live 后 pending 还满着时的最坏瞬时成本 |
| 生产窗口已消化 | `tree:"steady", drain:true` | 用户停留一瞬后逐键面对的稳态（树仍在 ParseWindow，未推到 `doc.length`） |
| 全树 + 全量装饰 | `tree:"complete", drain:true` | 绝对上限参考；生产禁止制造该状态，**永不作为优化门禁** |

本机实测（`makeBenchmarkDoc` 档位，2026-10-27，happy-dom 无布局，含增量重解析，
不含 layout/paint；两轮完整 bench 的采样区间）。三档 steady drained 统一从
`bench/typing.bench.ts::STEADY_DRAINED_CARET = 50_000` 起笔：

| 用例 | p50 | p95 |
|---|---|---|
| steady drained 10k（175k 字符） | 8.03–8.88ms | 9.37–11.51ms |
| steady drained 30k（531k 字符） | 7.98–9.34ms | 9.10–11.81ms |
| steady drained 50k（899k 字符） | 8.08–9.06ms | 8.97–11.14ms |
| complete drained 10k（worst case，无预算） | 12.15–13.38ms | 13.81–17.48ms |

**起点必须落在已 materialize 的区间内，否则三档不可比。** 树只解析到
`viewport.to + 100000`（happy-dom 无布局 ⇒ 约前 10 万字符），而 `measureTyping` 的默认
起点是 `doc.length / 2`：10k 档（175k 字符）的中点还在解析窗口内，30k/50k 的中点已经在
窗口外。只改 `drain` 不改起点时量到的「30k/50k 比 10k 快好几倍」，测的是**窗口外**的一次
编辑（那里没有装饰要映射），不是同一稳态。固定同一 `caret` 后三档都在同一个 materialized
生产窗口内编辑，数字基本持平（p50 8–9ms、p95 9–12ms，区间重叠）；剩下的差异只能归因于
文档/解析器状态，而不是「窗口外的活」。

门禁（本计划 Task 1，只用修正后的 steady drained 30k p95）：两轮最大 11.81ms，
≪ `TYPING_P95_BUDGET_MS`(16ms) ⇒ **不做 always-on windowing**；complete-tree 数字再差
也不触发生产改动。

## `documentStats` 用一条全局 Unicode 词法正则，别回到逐字符测试

原实现是「每个字符跑一次 CJK 脚本正则 + sticky Latin 正则」，即 175k 字符的 50k 档要做
~90 万次单字符 `test`。改成一条 `/CJK脚本|[A-Za-z0-9]+/gu` 全量扫描（`while
(WORD.exec(text))` 循环计数）后语义完全不变（`test/stats.test.ts` 覆盖混合 Latin/CJK/Hangul/Katakana、em dash 分词、
front-matter 剔除），成本减半。

`documentStats 50k` 本机两轮（同一命令 `vitest bench --run bench/typing.bench.ts -t
"documentStats 50k" --reporter=verbose`，报告列为 vitest 的 mean / p75）：

| | mean | p75 |
|---|---|---|
| 改前 run1 / run2 | 11.74 / 11.91ms | 11.93 / 11.96ms |
| 改后 run1 / run2 | 8.15 / 8.08ms | 8.42 / 8.24ms |
| 提升 | 30.6% / 32.1% | 29.4% / 31.1% |

两轮均 ≥25% ⇒ **采纳该实现**。仍然贴着 `STATS_BUDGET_MS`(8ms) 上限：50k 档单次
`measureStatsMs` 实测 7.7–9.2ms，`documentStats 50k` 用例会继续报 OVER BUDGET 是预期的
advisory 结果，不要为把它压到 8ms 以内引入 StateField/worker/增量统计（纯函数 + debounce
已经够用）。

**陷阱：全局正则带 `lastIndex`，跨调用会残留。** `WORD.test()`/`exec()` 循环前必须
`WORD.lastIndex = 0`，否则同一进程里第二次统计更长/更短的文档会从上次的偏移开始，词数
静默偏低。sticky Latin→global 全扫描的迁移最容易漏这一行。

## Pasted blocks normalize their own boundaries — never "fix" paste rendering in the decoration layer

Rich-paste (turndown HTML→Markdown) used to dispatch with the caret at
`from + insert.length` — exactly the `Table` node's `to` whenever the pasted
content ends with a table. `blockSelected` counts both boundaries as inside
the block (load-bearing: a hand-typed closing fence rests its caret on
`node.to`, and a half-open check made the widget swallow the block mid-typing,
M2 root cause C), so a pasted table stayed in source state until the user
pressed Enter. The two tempting fixes are both wrong:

1. **A decoration-layer exception for "caret exactly at `node.to`"** — a paste
   and a hand-typed row's last pipe are indistinguishable in
   `state.selection`; the exception re-creates the M2 swallow for hand typing.
2. **Appending a newline to every paste** — mutates plain-paragraph pastes
   that must stay byte-identical (the plain-equivalence heuristic).

The fix is paste-side (`src/paste/blockBoundaries.ts`, wired in
`src/paste/htmlPaste.ts`, Markdown conversion results only): block-shaped
inserts (conservative line-start markers: table row, fence, ATX heading, hr,
list, quote, `$$`) get

- a blank line **before** (mid-line insert → `\n\n`; line start after a
  non-blank line → `\n` — tables/fences cannot interrupt a paragraph),
- `\n\n` **after** when same-line text follows the insertion point (without it
  the trailing text was absorbed into the table's last cell — content
  corruption, not just cosmetics: `| 1 | 2 |tail` parses as one row), and
- one trailing `\n` when the insert **ends with an opaque block** (table row /
  fence close / `$$` / hr on the last line) so the caret rests on a fresh
  empty line instead of the widget's replace boundary — that is what makes the
  table render with no Enter.

Position arithmetic in tests is the local trap: in `"prev\ntext"`, position 4
is the **end of `prev`** (mid-line), not the start of `text`; a `|` in a test
doc string is literal content. Guards: the real-view paste test in
`test/htmlPaste.test.ts` (`.omd-table` renders with no Enter), and
`test/tables.test.ts` "keeps a caret resting exactly on the end boundary in
source editing" — the decoration rule must never grow a paste exception.

Rich conversion must also stop before `preventDefault` when the selection is
inside the shared verbatim set (`InlineCode`, `FencedCode`, `CodeBlock`,
`InlineMath`, `MathBlock`, `FrontMatter`). IDEs and rendered math pages put
styled HTML beside the plain clipboard flavor; turndown turns each HTML row
into a paragraph and escapes identifiers/LaTeX such as `DASHCAM_CMD_NONE` or
`\frac{a_b}{c}`, corrupting literal source with blank lines, `\_`, and doubled
backslashes. Let CodeMirror (or the desktop right-click paste owner) insert
`text/plain` instead. The named set and tree walk live in
`parse/verbatim.ts`; auto-pair, emoji completion, and paste must reuse it rather
than declaring local node sets. When Markdown is mounted but the syntax tree
does not cover the selection yet, preserve bytes rather than guessing that rich
conversion is safe; an isolated `htmlPaste()` extension with no language keeps
its existing rich-conversion behavior.

## Multi-line link constructs leave a dangling empty preview row

Multi-line link constructs (`[text](url\n"title")` — a newline in the
URL/title separator) leave a dangling empty visual row in live preview because
the title fold's backward scan correctly stops at `line.from`; this is
cosmetic and rare with no crash (verified: StateField-provided replaces
spanning line breaks are safe in CM 6.43.8).

## Link/Image/Escape/HardBreak/cell semantics are one shared projection

`src/semantic/` is the only place that turns an inline node into facts. Preview
(`decorations/inline.ts`, `decorations/widgets/tableCell.ts`), sync export
(`exportHtml`), rich export (`exportRichHtml`), `parse/cell.ts`, and `links.ts::linkHref`
all consume `semantic/link.ts`, `semantic/image.ts`, `semantic/breaks.ts`, and
`semantic/references.ts`. Re-deriving a destination, alt, or title locally (the old
`node.getChild("URL")` + `head.indexOf("](")` shape) is exactly what made preview, sync
export, rich export, and table cells disagree on titles, formatted/entity alt text, and
autolink normalization.

Rules that must survive refactors:

- **One reference index, not one scan per tree.** `semantic/references.ts`
  (`referenceIndexField`) seeds definitions from the committed tree, maps every definition
  range through edits, and rescans only the changed or newly covered top-level blocks
  (`referenceIndexScanStats.scannedBlocks` is the test counter: a concrete edit must not
  rescan the document; tree growth may only add blocks). It is mounted **outside**
  `livePreviewCompartment` (`index.ts`) so a Source/Live toggle never re-seeds it.
- **No per-new-Tree live scan.** `growIndex` compares coverage against
  `treeExtent(state)` (`min(tree.length, doc.length)`, never a forced parse) and scans only
  the gaps — a fresh `Tree` object with the same coverage is a no-op. `snapshotReferenceContext`
  collects every definition on a tree cache miss and is for export / one-off reads only; call
  it from an update path and every keystroke pays a whole-document definition scan (same family
  as the complete-tree trap).
- **Current-state slice with a stable resolver.** `resolve` is reused whenever
  `sameTargets` holds, so resolver identity survives text edits — but `sliceString` is rebuilt
  per call from the state being asked (`contextFor(state, resolve)`). Caching a whole context,
  or a slice bound to an older `EditorState`, reads stale label/alt text after an edit that
  changed no definitions (`test/semanticReferences.test.ts`).
- **Escape/HardBreak markers are explicit two-part semantics.** `escapeParts` = leading `\`
  marker + escaped value; `hardBreakParts` = marker (one `\` or a run of ≥2 spaces) +
  `newlineFrom/To` covering LF or CRLF, with `kind` read from the marker bytes only. Preview
  folds `[markerFrom, markerTo)` and nothing else: replacing the newline would merge two
  rendered lines, and replacing the escaped character would hide real content. Cell projection
  keeps only the escaped value; export emits the value / `<br>`.
- **`replace:HardBreakMark` is never atomic (atomicRanges Rule 4).** The marker ends flush
  against the line break, so `skipAtomsForSelection` would push a line-end cursor across the
  newline (end-of-line click or ← landing on the next line, drag selection grabbing it). The
  exclusion in `build.ts::isAtomicTag` is by tag on purpose — do not re-derive it from boundary
  arithmetic.
- **Raw table-cell source stays raw; GFM pipe shielding is a separate pass.**
  `tables/model.ts` keeps the Lezer `TableCell` source verbatim (`source.trim()`, no `\\|`
  pre-decode). Two distinct domains: outside inline code the cell's own parser yields an
  `Escape` node and `semantic/breaks.ts` drops exactly one backslash (`a\|b` → `a|b`); inside
  inline code the backslash is opaque content (`InlineCode` has no `Escape` child), yet GFM
  says the shielding backslash is not part of the code text — so
  `parseCell(..., { pipeEscapes: "gfm-table" })` removes exactly one backslash from an
  odd-length run followed by `|` (`decodeShieldedPipes`) and leaves even-length runs
  untouched (an even run escapes itself, so the pipe is not shielded). The default
  `pipeEscapes: "markdown"` performs no such rewrite — a cell string handed to `parseCell`
  by an independent caller is a Markdown
  fragment, not a GFM row. Never restore `replace(/\\\|/g, "|")` over a whole cell (the old
  `cellText`), which also decoded literal backslashes in code.
- **Reference-dependent widgets invalidate by resolver identity, not by source bytes.**
  Editing a definition changes no `[text][id]` bytes, so `src`-based reuse would freeze the
  old destination: `TableWidget.eq` compares `resolveReference`, `updateDOM` re-renders every
  inactive cell when the resolver identity changed, and `build.ts::semanticProjections` maps
  `widget:image` / `widget:block:table` specs to the resolver identity and rebuilds the ranges
  of specs that are already built (never a document scan to find candidates). Accepted
  boundary: a reference image that never rendered (unresolved ⇒ no spec) does not appear when
  its definition is added later; only ranges still pending mount on their own chunk. Do not
  "fix" that with a whole-document `Image` walk on definition change.
- **Unresolved references stay visible as source.** `imageParts`/`linkParts` return `null` when
  there is no definition; callers keep the raw text rather than rendering an empty
  `![]()` widget or a link with no destination.

## Smart Paste importer: one owner per rule, one parse per candidate

`packages/engine/src/paste/` is the semantic clipboard importer. It deliberately mounts no DOM
handler: the desktop controller calls `prepareSmartPaste` and `planSmartPaste`, while other
hosts can reuse the same pure boundary. An edit here has to keep all seven contracts true.

1. **Trigger policy drifts silently when the parser changes.** `paste/triggerPolicy.ts::
   escapePasteText` is the only Markdown rule source for serialized literal text: `minimal`
   escapes only where the engine would read semantics (`access_token` stays intact), `strict`
   escapes every CommonMark-escaped ASCII punctuation and entity-encodes ambiguous line-start
   indentation. It mirrors `parse/` extensions one by one, and
   `test/pasteTriggerPolicy.test.ts` enumerates `markdownLanguageSupport()`'s extension list so
   adding a syntax extension without a matching policy class fails the suite. Never add a
   second escaping layer in the serializer "for safety" — double escaping is a visible defect,
   and a locally invented rule (regex `*`/`_` handling in `serialize.ts`) is exactly the drift
   the test exists to catch.
2. **One paste performs at most one parse, and the candidate is final before it.** The candidate
   is chosen before validation (plain fast path, else the minimal serializer), boundary-normalized
   once by `blockBoundaries.ts::normalizeBlockPaste`, then handed to
   `validate.ts::validatePasteCandidate` unchanged; the validator reads only the committed
   context window (`MAX_PASTE_VALIDATION_CONTEXT_CHARS`) and parses `prefix + candidate + suffix`
   once. A rejection is final: the plan goes straight to whole-fragment strict literal. Do not
   add a retry, a second candidate, a trim, or an "accept anyway" branch; `planSmartPaste`
   already cannot produce a second parse because `pasteValidationTestParseCalls` is asserted at
   ≤ 1 in `test/pasteValidation.test.ts` and in `bench/paste.bench.ts`.
3. **The Paste AST has no node identity, no source map, no DOM path.** `model.ts` nodes are
   temporary, readonly, and positionless; asset keys (`paste-embedded-N`, `paste-unavailable-N`)
   identify bytes only — never an output range, never a correspondence to clipboard `File`
   array order (`normalizeHtml.ts` explicitly refuses to imply one). Once normalized, a node
   cannot be traced back to the DOM element it came from, so no consumer may ask "which source
   element changed" or diff a candidate against a tree; the planner re-derives the whole plan
   from the AST plus the host boundary. Anything that needs per-node reconciliation is a new
   design, not a small fix.
4. **Presentation styles are dropped, not translated.** Only `font-weight`, `font-style`, and
   `text-decoration` are read as strong-semantic facts; every other declaration (color,
   background, font size/family, letter spacing, class, `data-*`) is counted in
   `droppedStyle` and discarded. Unknown/media/form elements keep only their safe visible
   descendants — no attribute strings, no `<span>` passthrough. "Preserve this one style as
   HTML" reopens the whole escape hatch the importer exists to close.
5. **Unresolved image identity is never guessed.** `data:image/(png|jpeg|webp)` is extracted into
   `PasteAsset` before the URL gate; `blob:`/`file:` become an `unavailable` key plus alt and are
   listed in `unavailableImageKeys`; when no resolver supplies bytes the image lowers to its alt
   text with one `unresolvedAsset` diagnostic. Equal counts or matching MIME types do not prove
   identity between HTML images and clipboard `File` entries — never zipper them by index.
6. **Fallback is whole-fragment strict literal, never partial and never a fragment rewrite.**
   Limit overflow, a host conversion failure, a rejected candidate, or an uncovered tree all end
   in `serializePasteDocument(document, { mode: "strict" })` plus block isolation; the visible
   text is preserved and every Markdown trigger is escaped. That is also why a large candidate is
   *not* inserted as Markdown: `MAX_PASTE_VALIDATED_INSERT_CHARS` (262,144 chars) is a cost gate,
   so a 1 MiB or 5 MiB clipboard fragment normalizes/serializes and then takes the strict path
   with **zero** validation parses (measured in `bench/paste.bench.ts`). Do not "fix" that by
   raising the guard to fit the benchmark.
7. **`DOMParser` allocation is not bounded by the traversal guards.** `MAX_PASTE_DOM_DEPTH` /
   `MAX_PASTE_DOM_NODES` are counted **after** `parseFromString` has already built the whole
   detached document, so an oversize clipboard pays the allocation first and only then degrades
   to `preparePlainTextFallback` (one `strictFallback` diagnostic, never a truncated AST).
   Measured density for the bench generator: ~31 nodes/KiB for the mixed paragraph+table shape,
   i.e. `MAX_PASTE_DOM_NODES = 200_000` sits near ~6.4 MiB of that shape but is reached at ~2.8 MiB
   of a table-only (Sheets-shaped) fragment. A tag-dense 5 MiB fragment therefore parses fully and
   then falls back — the guard bounds traversal, not the freeze. Escape hatch if a real user hits
   it: bound the input by length before parsing (a new guard in `limits.ts`), never by weakening
   the tree checks.

Evidence and advisory baselines: `bench/paste.bench.ts` (raw `DOMParser`, `prepareSmartPaste`,
serialization, one-parse planning, and the large-document reference index).

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

## CodeMirror's widget reuse keeps the NEW instance but the OLD DOM and listeners

`docview.findWidget` reuses a widget tile's DOM when pass 0 finds an `eq` match
(no `updateDOM`, no `destroy`), and on pass 1 — constructor match with a failed
`eq` — it calls `tile.widget.updateDOM(tile.dom, view, newWidget)` where `this`
is the **new** widget and the third argument is the **old** one, then stores
`new WidgetTile(tile.dom, length, widget, flags)`. So after any in-place refresh
the DOM, its event listeners, and any closure state belong to the *previous*
instance while CodeMirror holds the *new* one. A listener that closes over
`this.row` / `this.col` / `this.hovered` reads state that no longer exists once the
widget is replaced, which is why `TableWidget` resolves its live owner through the
module-level `domOwner` WeakMap — registered under **both** the wrap returned by
`toDOM` and the `.omd-block-body` that `renderInto` actually hands to the
renderer (registering only the wrap silently drops every cell/toolbar click) —
and re-registers both keys inside `updateDOM`. Never close over `this` in widget
DOM listeners; never key that lookup on a captured position.

Related: `updateDOM` may run against detached DOM (CodeMirror diffs before it
inserts), so "migration" checks must be structural — `TableWidget.updateDOM`
migrates the hover target (`row` / `col` / `hovered`) from the previous instance
because the shape (and therefore every index) still means the same thing — never
`el.isConnected`. There is no in-cell editor left to "still be inside that cell":
the table's two states are the widget and `omd-table-src` source lines.

## Resolve a fence's enclosing node from the line END, not the line start

`tree.resolveInner(line.from, …)` on a quoted or indented fence lands on the
`QuoteMark`/`QuoteIndent` that *starts* the line, and the parent walk from there
never sees the `FencedCode` or `ListItem` that owns the fence — so
`continueFenceSpec` never completed `> ```js`. Resolving from `Math.max(line.from,
line.to - 1)` (the caret at the line end, where Enter actually fires) finds the
real parent, and then the explicit range guards (`node.from < line.from ||
node.from > line.to`, `mark.from < line.from || mark.to > line.to`) are what keep
the command from hijacking a fence whose CodeMark belongs to another line. Same
family as the earlier entry about `lineAt(node.to)` for unterminated fences:
line-start/line-end position choice *is* the bug in tree-driven commands.

## Fence tokens must resolve on BOTH highlight paths

Rendered code uses Shiki (`src/shiki/languages.ts`), the editing state uses
Lezer/legacy grammars (`src/parse/codeLanguages.ts`). A token that only one side
knows makes the same block change appearance when the caret enters it (highlight
present in preview, plain text while editing, or the reverse). `test/
codeLanguages.test.ts` asserts the CM table covers **every** token
`LANGUAGE_ALIASES` resolves, except an explicit five-token gap list (`tf`, `gql`,
`latex`, `lt`, `vim`) — adding a Shiki language means either adding the CM side or
justifying the gap there. Legacy grammars are wrapped as `new
LanguageSupport(StreamLanguage.define(parser))`: `LanguageDescription.load()` is
typed (and consumed) as a `LanguageSupport`, and the loader stays a dynamic
`import()` inside `legacyMode` so no legacy mode reaches the main bundle.

## A line-start regex cannot see the real block prefix

Quote/list line handling used `/^(?:> )*/` and `line.text.startsWith("> ")`. Both
only ever matched the canonical `> ` spelling, so `>x`, `  > x` (indented),
`- > x` (quote in a list item), `> > nested` and `> - [x] task` silently lost
their prefix on Enter, and the toggle un-quoted lines it never recognized.
`format/blockPrefix.ts::blockPrefixOf` reads the prefix from the Lezer tree
instead: leading indent + each `QuoteMark`/`ListMark`/`TaskMarker` plus the
whitespace that follows it, stopping at the first non-prefix content. Both
`continueQuote` (Enter) and `toggleQuoteSpec` (Mod-Alt-9) consume that one model —
do not reintroduce regexes. Two consequences: removing a mark deletes the mark
plus exactly **one** following space (`markRemovalRange`; the remaining
whitespace is content indentation, and eating it turned `  >   x` into `x`), and
prefix-only lines exit one level by rebuilding the source up to the *second to
last* mark's end rather than by deleting a fixed number of characters.

## `markdown()` bundles its own `Prec.high` Enter keymap

`@codemirror/lang-markdown`'s `markdown()` support pushes
`Prec.high(keymap.of(markdownKeymap))` (Enter → `insertNewlineContinueMarkup`)
into the returned support — and `markdownLanguageSupport()` is the FIRST entry of
`editorExtensions()`. For equal precedence the earlier keymap wins, so an engine
Enter binding left at `Prec.high` is silently shadowed: the engine's
`continueQuote` / `continueList` only ran where upstream bails (inside fences,
`getContext` returns early on `FencedCode`). The symptom is subtle because both
implementations agree on the happy path (`> hello` → `> hello\n> `) — what
differs is the prefix-only line (upstream leaves a bare `>` line, the engine
exits one level), the `>x` (space-less) style, and in-fence caret placement.
Engine Enter commands therefore sit at **`Prec.highest`**, ordered
`codeLineKeymap` → `fenceKeymap` → `quoteKeymap` → `listKeymap`, each returning
`false` for lines it does not own.

The testing lesson is the reusable part: assert **ownership signatures** — an
outcome only one implementation can produce (exit-one-level on `> `, caret moved
onto the new code line, style-faithful `>x\n>x`) — never just the visible result
both produce. `test/enter-ownership.test.ts` drives the real keymap chain
(`keymap.of([...defaultKeymap, ...historyKeymap])` before `editorExtensions()`)
for exactly this reason.

## A continuation command must set an explicit selection

`changes: {from: head, to: head, insert: "\n> "}` does NOT move the caret: a
collapsed selection maps through an insertion at its own position with
`assoc = -1`, so the caret stays on the **previous** line. Upstream's
`insertNewlineContinueMarkup` sets the selection explicitly, which is why the
missing `selection` in `continueQuoteSpec`/`continueListSpec` went unnoticed
until the engine actually took Enter ownership — and why it showed up first in
quoted code lines (the one place upstream had already bailed, so the engine's
command was live). Every continuation spec returns
`selection: { anchor: insertStart + insert.length }`; `test/enter-ownership.test.ts`
asserts the caret's line and offset, not just the document text.

## List editing columns are CommonMark structure, not source offsets

列表 Enter/Tab/Shift-Tab 的每一处宽度都来自树，不来自正则或源码偏移。旧实现用一条
`LINE` 正则 + 固定两个空格：它看不到嵌套层级（空子项该退到哪层）、把 `10. ` 和
`-\t` 当同样宽、也判不出 `> - ` 这行到底归引用还是归列表。现在 `format/lists.ts` 只
向 `format/blockPrefix.ts::listFrameAt` 要结构：行块前缀 + 最内层 `ListItem` + 父
`ListItem`，另加 `itemMarkAt`（父/兄弟条目**自己**的 `ListMark`）与
`listContentColumn`（标记的 CommonMark 内容列）。四条容易踩的前提：

- **同一物理行可以有多个 `ListItem`**（`- - x`、`> - - [x] x`）。父条目那一行的前缀
  含多个列表标记，所以退层/对齐的截断点必须是 `itemMarkAt(item)` 找到的那个
  `ListMark`，拿整行最内层标记会把子层当父层（退层变成原地不动）。
- **引用/列表归属看最内层非任务标记**（`enterOwnerMark`）。`> - ` 的空条目归列表：
  `continueQuote` 返回 `null`，`continueList` 退一层列表并保留 `> `；`- > x` 归引用。
  任务框永远不是 owner（`> - [x] x` 是列表语义）。
- **列是视觉列**：制表位每 4 列（`visualColumn`），`-\t- x` 的父层内容列是 4，不是
  `mark.text.length` 的 2。源码偏移相减在含 tab 的行上直接把新条目写成外层兄弟。
- **标记后的空白不全是内容缩进**：CommonMark 只有 1–4 列算 padding；0 列或 5+ 列退化
  成一列（`-     parent` 的正文其实是缩进代码块）。`BlockPrefixMark.to` 含全部后随
  空白，直接当内容列会让 Tab 插六格、新条目重解析成 `CodeBlock`。
- **不同 marker 类型是相邻列表容器，不是同一组 siblings**：`1. parent` 后紧跟
  `- child` 时，Lezer 给出相邻 `OrderedList` / `BulletList`；当前 bullet 是自己容器的
  首项，单查 `item.prevSibling` 必然得不到 parent。Tab 只允许跨到**紧邻且物理行连续**
  的前一列表容器末项；空行或其它块会切断关系。
- **新建的有序子列表必须从 `1` 开始**：`1. parent\n2. child` 仅插三格会得到
  `1. parent\n   2. child`，CommonMark/GFM 把 `2. child` 当段落，不是子列表。Tab 在
  parent 尚无末尾 `OrderedList` 时把当前 marker 改为 `1.`/`1)`；若 parent 已以有序
  子列表结尾，则保留 marker，作为该子列表的下一项。
- **spec 的 `null` 不等于按键可以交还浏览器**：首项或已在目标列时不应改文档，但
  list command 仍返回 `true` 消费 Tab；返回 `false` 会触发原生 focus navigation。
- **空顶层条目的 Backspace 不能交给 lang-markdown**：其 `deleteMarkupBackward` 会把
  `2. ` 替换成三个空格并把光标留在第 3 列；用户接着输入 `- ` 就得到 `   - `，被解析为
  上一项的嵌套列表。`deleteEmptyTopLevelListSpec` 只接管“无父 `ListItem` + 前缀为空内容
  + 光标在行末”，删除当前列表前缀并保留外层引用；嵌套项与 marker 内编辑继续 fail closed。

有序标记上限 1–9 位数字（`ORDERED_MARKER_MAX`）：递增到 `999999999` 就**重复**该
标记而不是回绕到 1 —— 回绕像列表重新开始，超限标记会重解析成段落。

失败一律 fail closed：多个 range（哪怕都是空光标）或非空选区返回 `null`，树没覆盖该
行/祖先也返回 `null`（复写选区是破坏性操作、猜层级会插错空格），绝不猜。唯一的命令层
例外是“已确认处于列表、但没有合法 Tab rewrite”：不 dispatch、仍消费按键以保持焦点。
其余交给上游或 host 命令。

守卫都在解析层，不要只测“看起来对”：`test/list-continue.test.ts` 断言每个 spec 的精确
文档与选区（含同一行嵌套、tab 列、padding 兜底、9 位上限、各类拒绝），
`test/enter-ownership.test.ts` 走真实 keymap 链（`defaultKeymap` 先注册）确认同一批
用例在 `Prec.highest` 下确实由引擎命令拿下。

## Dynamic list depth crosses engine DOM reuse and desktop cascade

列表深度现在是一个**值**而不是一组类：引擎发稳定类 `omd-li` / `omd-quote-in-li` +
行内自定义属性 `--omd-list-depth`（行装饰与块 widget 都一样），视觉换算全在 desktop
CSS。深度**不封顶**（`BlockEmbed.listDepth` 是 `ListItem` 祖先计数；`MAX_QUOTE_DEPTH`
只管引用）。行装饰的 `tag` 仍带深度（`line:omd-li-N`）：增量装饰身份必须随深度变化，
否则缩进变了旧行装饰会被复用。

块 widget 这条路上有两个真实坑：

- **`applyBlockEmbed` 必须跑在每一条成功的 `updateDOM` 路径里。** CM pass-1 复用旧 DOM
  配新实例（`eq` 失败才调 `updateDOM`），新实例的 `embed` 才是当前深度；漏掉一次同步，
  源码缩进已经变了、widget 还停在旧缩进。该函数同时负责**先清后写**：先移除 `omd-li` /
  `omd-quote-in-li` / `omd-blockquote*` 与 `--omd-list-depth`，再写当前值 —— 叠加式写法
  会留下旧深度、或让 `omd-li` 与 `omd-quote-in-li` 并存。
- **desktop 的 `padding` 简写会静默吃掉左侧缩进。** `.omd-block` / `.omd-math` /
  `.omd-table` / `.omd-code` 在列表规则之后用同特异性重声明 `padding` 简写，把左侧
  padding 归零过 —— 深度属性写了却“从来没生效”。现在的规则在这些简写之后按更高特异性
  重新声明左侧，并且**只偏移一次**：代码块 wrapper 独占那一次偏移（header 在它里面，
  不再加一次），编辑态 chrome 是 `.cm-content` 的直接子节点、没有 wrapper，所以由它
  自己承担偏移 + 10px 基准内缩。改动这块要连带看引用条位置（`--omd-bq-bar`）。

守卫：`packages/engine/test/blocks.test.ts`（第 5 级发出 `--omd-list-depth: 5`，类仍是
`omd-li`）+ `test/tableUpdateDOM.test.ts` / `test/blockwidgets.test.ts`（updateDOM 后
嵌入类与深度是新值）+ `apps/desktop/test/listDepthStyles.test.ts`（把真实 styles.css
挂进 happy-dom 跑级联，并断言没有 per-depth 类）+ `apps/desktop/e2e/list-depth.spec.ts`
（happy-dom 解不了带 fallback 的第二层 `var()`，所以 padding 简写存活、偏移只加一次、
引用条落在同一次偏移上，这三件事只在真实 Chromium 里断言）。

## Line block prefixes are structural — clamp the caret, never make them atomic

The folded `> ` / `> - ` / `- [ ] ` prefix is block structure, but `cursorInside`
reveals a marker whose range contains the caret (invariant 10). Clicking the left
edge of a quoted line (or pressing Home) resolves to `line.from` = inside the
prefix, so the marker unfolds and the next typed character lands **before** it —
the user sees the `>` being pushed right (`abc> `). `navigation/caretClamp.ts`
clamps the three accidental entry points (mousedown via `posAtCoords`, Home /
Shift-Home, ArrowUp/Down after running the host command) to
`format/blockPrefix.ts::lineContentStart`. Two rules:

- Do **not** try `EditorView.atomicRanges` for line-start prefixes: the
  atomicRanges invariants forbid line-start and cross-line atoms (they break
  cross-line selection and drag endpoints).
- "Prefix" means each mark plus **exactly one** following space
  (`markRemovalRange`). The remaining whitespace is content indentation —
  classifying it as prefix breaks Tab/Shift-Tab on quoted code lines and makes
  indentation inheritance accidental.

## There is no indentation service inside a fence

`getIndentation(new IndentContext(state, { simulateBreak: pos }), pos)` returns
`null` at every position inside a fenced code block: `@codemirror/lang-markdown`
only declares `indentNodeProp: { Document: () => null }`, and the nested language
does not contribute one through the mounted tree. So `insertNewlineAndIndent`'s
"copy the current line's leading whitespace" fallback is all CM can offer, and
`{`-style auto-indent has to come from the engine:
`format/codeLines.ts` (`continueCodeLineSpec`) copies the current line's content
indentation and adds one level when the text before the caret ends with
`{ ( [ :`. Making this language-aware means providing an `indentService` (or a
per-language provider table) — a deliberate follow-up, not a config flag.

Auto-pair and that Enter branch are two independent handlers, so each can be
green alone while the pair is wrong: typing `{` leaves `{|}` (the closer on the
*same* line), and plain continuation pushes `}` onto the indented new line —
`{\n  }`. `continueCodeLineSpec` therefore checks the two adjacent content
characters around the caret: `{|}` inserts `\n<prefix><base><INDENT>\n<prefix><base>`
and selects the inner line, leaving the existing `}` in place (never
reinserted, and `base` is the line's own leading content whitespace so `  {}`
keeps its indent). Keep this branch O(1) and stateless — it runs before the
ordinary continuation path and after the terminal-blank-line exit.

The same highest-priority command must not treat every empty content line as
"continue forever". When the caret is at the end of the final blank content line
and the next line is the closing fence, Enter preserves that blank source line
and moves after the closing fence. It reuses an existing blank line after the
block, or inserts one with the same quote prefix. Empty lines with later code
content still use ordinary continuation. The real-keymap cases live in
`test/enter-ownership.test.ts`; testing only `continueCodeLineSpec` misses
ownership conflicts with the bundled Markdown Enter command.

## `alive` is instance-scoped, but CM's `destroy` is tile-scoped

Async block widgets (code / mermaid / math) end their render with
`if (this.isActive(el)) el.innerHTML = html`, and `isActive()` is
`BlockWidget.alive`. That flag was set by `destroy()` — but CodeMirror's
`destroy(dom)` fires when a **tile** is dropped, which is not the same event as
"this widget instance is finished": the live-decoration rebuild reuses the same
`Decoration`/widget object (the `removedByKey` pass in `decorations/build.ts`)
while CM still re-creates the tile, so `toDOM` runs a second time **on the same
instance** and the previous tile's `destroy` can arrive after it. Instrumented
timeline in a real browser for a quoted fence that starts the document:

```
toDOM#1 pos=2 body=false     ← first tile
toDOM#2 pos=2 body=true      ← same instance re-tiled (this.wrap already set)
destroy#2 pos=2              ← previous tile dropped → alive = false
render  alive=false elConnected=true elProbe=2   ← new DOM is connected and on screen
after debounce alive=false → EARLY-RETURN dead after debounce
```

Result: the synchronous placeholder `<pre>` stayed forever — no Shiki, no
`.line` spans, no error (the `catch {}` swallowed everything). The same block
preceded by any paragraph built once and rendered fine, which is why the bug hid
in "obvious" fixtures.

Rules:

- `toDOM` **reactivates** the instance: set `alive = true` and record the DOM it
  produced (`BlockWidget.activateDom`). Every `toDOM` override must call it —
  `CodeWidget` builds its own wrap and therefore calls it directly instead of
  going through `super.toDOM`.
- `destroy(dom)` only retires the instance when `dom` is the **current** DOM (or
  when called without a DOM); a stale tile's destroy must never kill a widget
  that has already been re-added. Same idea as `domOwner` in the table widget,
  in the opposite direction.
- Never gate the *final* DOM write on a bare connectivity check either
  (`isConnected` is transiently false while CM diffs/measures) — after the two
  rules above, `isActive()` is the correct predicate.

## Async widgets must expose an observable degrade marker

`if (!lang) return` plus a `catch {}` made "the async render never landed" a
silent, invisible failure: the DOM simply kept the synchronous `<pre>`, and the
only way to notice was asserting Shiki's `.line` spans. Emit an explicit marker
instead — `.omd-code-body[data-omd-highlight]` = `placeholder | shiki |
unknown-lang | error` and `.omd-block-body[data-omd-render]` = `placeholder |
svg | katex | error` (mermaid/math) — and log the swallowed error once via
`console.debug`. This is what turned the doc-start quoted fence into a failing
e2e assertion (`Received: "placeholder"`, 14 retries) instead of a mystery.

## Auto pair: decide type-over before insertion, or the closing marker doubles

Hand-typing `*bold*` only converges if the closing keystroke is compared against the
character after the caret **before** the insertion gate runs. Insertion first turns that
final `*` into a fresh pair (`*bold**`, caret parked between the two new markers); the
type-over check first sees the marker the extension already inserted, steps the caret
over it, and the document stays `*bold*`. `format/autoPair.ts::autoPairExtension` only
ever tries `autoPairTypeOverSpec` and *then* `autoPairSpec` — swapping those two lines is
silent one-character source corruption on the most common Markdown gesture, and no
happy-path test notices. The adapter's dispatch order is mirrored and pinned by
`test/autoPair.test.ts` (`typeAll`, the character-by-character `**bold**` case); the same
rule covers the folded-emphasis path in the editor.

## Auto pair: a pair-delete Backspace binding must `return false` when it does not apply

`deletePairSpec` is bound at `Prec.high` because desktop's `defaultKeymap`
(`deleteCharBackward`) is registered first and would otherwise always win. But a
high-priority binding that claims *every* Backspace steals the key from `skipAtomic`'s
whole-atom delete at folded marker boundaries. With the caret at the right edge of the
folded `**` in `foo **bold** baz`, `deletePairSpec` returns `null` (prev is `*`, next is
`b`); the binding must `return false` so `deleteCharBackward` removes the whole atom
(→ `foo bold** baz`), not one character (→ `foo *bold** baz`). Pinned by
`test/autoPairView.test.ts` ("yields to skipAtomic at a folded mid-line marker
boundary"), which drives the real keymap chain — a spec-only test cannot see precedence.

## Auto pair: on an empty line `*` and `$` are block structure, not typing convenience

Rule 2b (`EMPTY_LINE_MARKERS` in `format/autoPair.ts`) suppresses pairing for exactly `*`
and `$` when the caret's line is empty before the caret:

- `*` plus a space would become `* *`, which Lezer parses as an unordered **list item**
  whose content is a literal `*` (muya carries a dedicated special case for the same
  trap).
- `$` would pair into `$$`, and `parse/math.ts` claims `rest.startsWith("$$")` as a
  **MathBlock**; an unclosed one swallows to EOF (KaTeX error widget plus the whole rest
  of the document inside one block).

`` ` `` and `_` are deliberately **not** suppressed: a single line-start backtick has no
block semantics (and `` `npm run build` `` at line start is the highest-frequency case),
and `_` has no block meaning at all. The recorded cost is that a suppressed `*`/`$`
becomes a manually closed marker, so the closing keystroke may still pair once (one extra
character to delete) — a known limitation, not something to "fix" with marker-parity
tracking. Covered by `test/autoPair.test.ts` (the 2b matrix) and `e2e/auto-pair.spec.ts`
(asserts the document text *and* that no `.omd-math` widget appears, with a real `$$`
control that must mount one).

## `EditorView.inputHandler` returning `true` is `preventDefault` — and you are not the only handler

`@codemirror/view` asks the facet with `.some(...)`: the first handler returning `true`
wins and the default DOM-change pipeline is skipped entirely. Two consequences for the
auto pair adapter (`format/autoPair.ts::autoPairExtension`):

- **The facet is not ours alone.** `markdown()` mounts the default `htmlTagLanguage` —
  the module-level `html({ matchClosingTags: false })` — into its **own** support list
  (`@codemirror/lang-markdown/dist/index.js:402,407,411`), and `html()` bundles
  `autoCloseTags` (`@codemirror/lang-html/dist/index.js:604-609`, the handler itself at
  `:627`), so `state.facet(EditorView.inputHandler)[0]` is *not* the auto pair handler
  even for a plain Markdown document. `markdownCodeLanguages()` cannot be the source: it
  returns lazy `LanguageDescription`s, and lang-markdown feeds a code region only
  `found.support.language.parser` to its own parser
  (`@codemirror/lang-markdown/dist/index.js:85-86`), so a code
  language's `LanguageSupport` extensions are never mounted on the view. Tests must mirror
  CM's dispatch (`facet(...).some(h => h(view, from, to, text, insert))`) instead of indexing.
- **`from`/`to` always describe the focused (main) range.** The other cursors' DOM diffs
  never reach the handler, so returning `true` after handling only the main range silently
  drops every character the other cursors typed. Every path (insert, type-over, and the
  pair-delete keymap) therefore runs through `state.changeByRange(...)` and bails out
  *entirely* (`null` → `return false` → CM's default pipeline inserts the bare character
  for every range) when any range fails its gates (D10). No partial dispatch is allowed.

`test/autoPairView.test.ts` drives the real facet chain for exactly this (its `input()`
helper), including the "bail out without any side effect" case. The e2e specs add no
multi-cursor case on purpose: the host never enables
`EditorState.allowMultipleSelections`, so CM6 collapses multi-range selections and such a
test would assert nothing.

## An unparsed tree makes `resolveInner` lie — marker gating must fail safe

`inVerbatim()` walks `syntaxTree().resolveInner(pos, -1)` up to find
`InlineCode`/`FencedCode`/`CodeBlock`/`InlineMath`/`MathBlock`/`FrontMatter`. On a large
document, or right after open/paste, the tree is not parsed up to the caret and
`resolveInner` resolves the position inside whatever ancestor *is* known — frequently the
wrong one — so a purely tree-based marker gate would pair `*`/`$` inside a code block.
`format/autoPair.ts` checks `syntaxTreeAvailable(state, pos + 1)` first and returns `true`
(suppress) when the tree is not there: the failure directions are asymmetric (a missing
pair costs one keystroke; a wrong pair inserts characters the user never asked for), which
is the same "do not guess structure from an incomplete tree" rule as
`format/blockPrefix.ts`. `syntaxTreeAvailable` is O(1) and does not force parsing, so it
does not violate the complete-tree rule; keep it on the marker branch only, so T1
brackets/quotes stay tree-free.

Suppression is deliberate, and one boundary is easy to misread: `syntaxTreeAvailable` *is*
`ParseContext.isDone`, which requires the parse to have started at 0. A document whose
parse context began at a skipped/restored position therefore reports the tree as
unavailable for the whole viewport, turning D9 into silent suppression of the four
Markdown markers (`*`, `_`, `` ` ``, `$`); brackets and quotes are unaffected. Do not
"fix" that by scanning backwards for markers — the manual-qa auto-pair block records the
matching caret-at-the-end-boundary case (see "verbatim 结束边界").

## The engine and desktop tsconfigs disagree about dead code

`packages/engine/tsconfig.json` sets `strict` but neither `noUnusedLocals` nor
`noUnusedParameters`, while `apps/desktop/tsconfig.json` sets both — and type-checks the
engine sources transitively, because the workspace `@omd/engine` import resolves to
`packages/engine/src/index.ts`. A dead parameter or unused local added inside the engine
therefore passes `pnpm test` (engine `tsc --noEmit` + Vitest) and fails
`pnpm --filter @omd/desktop build`. This blocked a whole round on the auto pair work:
`rangeAccepts` kept an `options: AutoPairOptions` argument it no longer read, and only the
desktop build caught it. When touching engine sources, run the desktop build (or
`pnpm verify`) before concluding — the engine's own green gate is not sufficient
evidence.
## 块 tile 会在挂载稳定期被重建 —— 同一个 widget 实例会收到 destroy + 二次 toDOM

实测（文档首块是「引用内的围栏」时，widget DOM 在挂载期被插入 3 次；前面有段落的同样
块只插入 1 次）。插桩得到的更新序列：

```
update#1  doc=false sel=true effects=(none) ranges=0-8,29-34   ← 宿主把光标从 0 移到文末
update#2  doc=false sel=true effects=measure ranges=
```

- `rebuildRanges` 的**选择分支**会为旧选区和新区各扩出一段
  （`expandRange(..., SELECTION_BLOCKS)`）。初始光标在 0，于是重建区间是 `0-8`；而该块的
  replace 区间是 `2-27` —— 二者相交，移除范围必须覆盖整块（新块 widget 可能从脏区内开始
  却吞并后续旧块），于是这个块在同一次更新里被丢弃并重建。
- 重建后 CodeMirror 丢弃旧 tile 并重新构建 DOM（调用栈：`CodeWidget.toDOM` ←
  `_WidgetTile.of` ← `Object.point`，即 CM 自己的内容构建，**不是引擎直接调用 toDOM**）。
  由于引擎的 spec 身份复用会把**同一个 widget 对象**交回给新 tile，这个实例会先收到
  `destroy(旧 dom)`、再收到第二次 `toDOM`。这正是上面「`alive` 是实例级、destroy 是 tile 级」
  那条 gotcha 的触发源。
- 这是**设计使然**，不是缺陷：邻域重建用于重新评估 `blockSelected`（光标进入块必须卸载
  widget）。不要为了消除重建去改这条路径。

两个被实测否掉的"顺手优化"，记下来避免重复走：

1. **`measureBlockWidget` 的连线不是原因**：临时切断"measure 效果 → 重建该块"后，
   挂载期插入次数仍是 3（挂载期第 3 次插入来自 CM 自身的首次布局）。
2. **"等价 widget spec 不删不增"也是无效的**：在 `updateLiveDecorations` 里对脏区内的
   等价 block widget 做保留（跳过 filter-remove + add）后，插入次数不变 —— 因为 CM 重建
   tile 是因为**与块相交的行被重建**，与 deco 对象的身份无关（reuse pass 早已保证身份一致）。

要真正减少这次重建，只能改 `rebuildRanges` 的选择分支（例如只在块的 `blockSelected`
真正翻转时才重建该块）—— 那是核心热路径，需单独设计并配 `blockSelected` 全套回归。

回归守卫：`apps/desktop/e2e/code-block-rendered.spec.ts` 的「a block widget is rebuilt a
bounded number of times and not after settling」——插入次数 ≤ 3 + 稳定后 DOM 身份不变 +
最终 `data-omd-highlight="shiki"`（即异步渲染没有被 tile 重建吞掉）。

## `coordsAtPos` throws inside `ViewPlugin.update` — read layout in `requestMeasure`

任何"跟着光标/块跑的浮层"（`tables/sourceToolbar.ts` 的表格浮层工具栏就是第一例）都会
在 `update(update: ViewUpdate)` 里算坐标。那里调 `view.coordsAtPos(pos)` 会穿到
`readMeasured()`，而 `updateState === Updating` 时它**直接抛**
`Reading the editor layout isn't allowed during an update`；`view.dom.getBoundingClientRect()`
这类布局读取同样是更新期禁读的。

危险之处是它安静地失败：按 Task 7 草案的写法（`update()` 里 `try { coordsAtPos } catch { hidden = true }`）
浮层在**每一次**事务后都走 catch 分支，于是永远不显示，而引擎单元测试（happy-dom 无布局、
且断言只看 `applyTableTool()` 的文档结果）全绿。只有真实浏览器的 e2e 才看得见。

正确形状：

```ts
update(update: ViewUpdate) {
  if (!tableAt(update.state, update.state.selection.main.head)) { this.dom.hidden = true; return } // 纯 state 查询，随时可做
  this.view.requestMeasure<Placement | null>({
    key: this,                          // 同一插件实例，连续 update 合并成一次测量
    read: view => /* coordsAtPos + getBoundingClientRect，Idle 态可读 */,
    write: placement => /* 只写 dom.hidden/style，不再读布局 */,
  })
}
```

`read` 在测量后、`write` 在 Updating 期执行，所以 `write` 里**不能再读布局**。`read`
返回 `null` 时 `write` 仍会被调用（只有抛异常才是 `BadMeasure`），"算不出来就收起"可以直接
用 `null` 表达。定位基准取 `view.dom`（`.cm-editor` 在 CM 基础主题里是 `position: relative`），
坐标用 `coords - hostRect` 换算。

回归守卫：`apps/desktop/e2e/table-toolbar.spec.ts`（光标进入表格 → 浮层可见 → 点按钮改源码 →
光标离开 → 收起）。写这类浮层时先跑一次真实浏览器探针，别只信 happy-dom。


## 「缩小选择分支的重建范围」不能消除挂载期重建 —— 但沿路挖出一个真实泄漏

针对上一条（块 tile 在挂载稳定期被重建），曾有一个看起来天经地义的优化：既然是邻域重建
把块卷进去，那就**把「前后两态都没被选中」的块从选择分支的重建范围里扣掉**。实现了
（`stableRenderedBlocks` + `selectionRebuildRanges`：只对纯选区事务、只扣块自己的 replace
区间、块外同一行的部分仍重建）并且全量 669 条引擎测试通过 —— 但实测把假设证伪：

| 量测 | 有优化 | 无优化 |
|---|---|---|
| 文档首块引用围栏：挂载期 widget DOM 插入次数 | 3 | 3 |
| 目标场景（引用围栏 + 光标在前缀里往返）p50 / p95 | 0.322 / 0.738 ms | 0.334 / 0.743 ms |
| 同场景 `toDOM` 次数 | 0 | 0 |

**原因**：挂载期那几次重建来自 CM 自己的内容构建（DOM 插入栈全部落在 `DocTile.sync`），
而光标离开块首行时该行的 QuoteMark 折叠状态**必须**改变 —— 行被重建，CM 就顺带重建了
起始于该行的块 tile。选择分支范围窄不窄改变不了这一点；而目标场景本来就不产生重建
（`toDOM = 0`），所以扣不扣都一样。**结论：不要为了减少 tile 重建去动 `rebuildRanges`
的选择分支。**

## 块 widget 反复挂载/卸载会持续占用内存（聚合增长仍复现，根因 `inconclusive`）

同一次排查中撞到的**真实缺陷**：让光标在"块内（编辑态）↔ 块外（渲染态）"之间反复翻转，
每次翻转都会重建整块 DOM（设计使然：光标进块必须卸载 widget），但**强制 GC 后堆仍线性增长**：

```
NODE_OPTIONS=--expose-gc（每轮 500 次翻转后显式 global.gc() 两次）
round 1 ( 500 flips):  480.3MB
round 2 (1000 flips):  927.4MB
round 3 (1500 flips): 1374.0MB
round 4 (2000 flips): 1820.5MB
after view.destroy() + gc: 1820.5MB     ← 不回收 ⇒ 强引用保留，不是 GC 滞后
```

复现用的文档只需一张引用内表格（`> | a | b |` + 若干行），光标在 `0` 与文末之间往返即可。

**有界的部分**（别再从这儿查）：

- `livePreviewField` 的 `specs` / `deco` / `pending` / `atomic`：400 次翻转后逐一相等
  （`test/widgetChurnBounds.test.ts` 第一条用例把这条钉死）；
- `blockSelectionOverlay` 的 `liveWraps`：条目数恒定（按 widget 实例存 DOM，注销只走
  `destroy()`，`refresh` 每轮还清扫未连接的 DOM）；
- 引擎侧没有按 pos/按 transaction 累积的容器（`widgetMeasure` 只有一个 `StateEffect` 定义）。

⚠️ 本条早期版本把 `liveRanges` 也算进“有界”（当时读到 `wraps=0 ranges=1` 恒定）。那个
采样是错的：它只数了**当前一轮**的条目，而 `liveRanges` 是模块级 `Map`，历史条目一直在堆里
累积 —— 这一点由 pre-change 快照证实（见下文“所有权缺陷”一节），但它只解释那批 detached
DOM，**不足以**解释聚合增长。凡是“注册表条目数恒定”这类结论，都必须在**churn 之后**重新数，
不能在单轮快照里数。

**当时的排查方向（历史）**：表/代码 widget 自己在 `toDOM` 里挂的观察者或闭包、
`decorations/widgets/*` 里的模块级缓存、以及 CM 侧 tile/DOM 是否被我们的实例字段或
注册表间接强引用。定位手法：逐个把可疑注册/观察者改成 `WeakMap`/显式解绑后跑同一段
复现脚本看堆是否回落；修好后把上面那段脚本变成带 `global.gc` 守卫的回归用例。

### 真实浏览器复核：不是 happy-dom 独有的假象

上面的数字来自 happy-dom，真实浏览器里可能的保留者是布局/CM tile 而不是引擎，所以在动
生命周期抽象之前先量了一次真实 Chromium。工具：`apps/desktop/e2e/widget-memory-audit.mjs`
（手动工具，不在 `test:e2e` 里）：

```bash
PW_PORT=9420 pnpm --filter @omd/desktop dev --port 9420 --strictPort   # 终端 A
PW_PORT=9420 pnpm --filter @omd/desktop audit:widget-memory            # 终端 B
```

需要堆快照时加 `PW_HEAP_SNAPSHOTS=1`（同一终端 B 命令）：

```bash
PW_PORT=9420 PW_HEAP_SNAPSHOTS=1 pnpm --filter @omd/desktop audit:widget-memory
```

快照写到 `/tmp/omd-widget-baseline.heapsnapshot` 与
`/tmp/omd-widget-after-1000.heapsnapshot`（脚本每次先删旧文件，`addHeapSnapshotChunk`
的 chunk 同步写 fd，不在 Node 里拼整份字符串）。这两份是诊断产物，**不进仓库**。

脚本用 `e2e/harness.html` 载入一张引用内表格（20 行 + 尾随 `tail`），光标在 `0` 与文末
之间往返（每次往返 = 一次块 widget 卸载/挂载），累计 100 / 500 / 1000 次翻转；每个采样点
前 `HeapProfiler.collectGarbage`，再用 `Runtime.getHeapUsage` 取值。

实测（2026-10-27 macOS 26.2 arm64，Chrome 156.0.8078.48，同一会话内独立两次运行，字节值
相差 <32 KB）：

```text
baseline        6.6 MB   (6,876,232)
flips  100      7.6 MB   (7,969,720)
flips  500      9.1 MB   (9,575,068)
flips 1000     10.7 MB  (11,246,292)
afterDestroy   10.7 MB  (11,229,856)   ← 峰值 10.73 MB 的 99.9%，仍在堆上
```

**分类：`production-browser reproduced`** —— 100→500 与 500→1000 两个窗口都单调增长，且
`view.destroy()` 后 used heap 仍是峰值的 ~100%（判定阈值为 >75%）。即：happy-dom 里看到的
「翻转让堆线性增长且 destroy 不回收」在真实 Chromium 同样成立，不是测试环境的假象。

**这里不下结论**：上面这批数字只量了总量，快照只能回答“谁强引用着哪批对象”，不能单独把
聚合增长归因到某一条路径（下文的分析最终落在 `inconclusive`）。真实浏览器复现的意义是：
即便最终根因落在 CM tile 或某个 widget 的观察者上，也不能用「happy-dom 的锅」推掉这条缺陷。

### 已确认的一处所有权缺陷：`liveRanges` 是模块级 `Map`，DOM 作键就是强引用

`PW_HEAP_SNAPSHOTS=1` 在 baseline / after-1000 各取一份快照，按
“谁强引用着 detached DOM”排序，直接指认了 `packages/engine/src/decorations/blockSelectionOverlay.ts`
里那个模块级缓存。

**快照证据（pre-change，1000 次翻转后）**：

```text
system / Context / scope #28797 --(context:liveRanges)--> Map #35608
Map #35608 keys = 1002
  ↳ 1000 个键是 detachedness=2 的
     <div class="omd-block omd-table omd-blockquote omd-blockquote-1"
          title="Click to edit source" contenteditable="false">
  ↳ 1001 个键本身带 {from,to} 值对象；每个键对应一次翻转
```

即：每翻转一次就 `liveRanges.set(dom, {...})`，而 `dom` 是下一次翻转就会被卸载的整块
widget wrap。条目数 = 翻转次数（1000 次 → 1000 个 detached 块 div），`view.destroy()` 也不
回收（模块级 `Map` 的键是强引用，跟 view 生命周期无关）。

这批死键在 pre-change 快照里确实由 `Map` 强引用住：单个死键的直接 retainer 是
`_WidgetTile.dom` 与它自己的 `<div class="omd-block-body">`（一个自引用的 tile/DOM 环），
而该环唯一的模块级入口是 `Map` 的 table 数组；采样到的 1000 个 detached 键全部经由该
`Map` 可达。`liveWraps` 在同一次 churn 里条目数为 1。

**但这只说明“这 1000 个 wrap 被一个强引用钉住”，不说明聚合增长的来源**：同一脚本在换成
`WeakMap` 之后聚合增长一点没变（见下节），所以它是需要修掉的所有权缺陷，不是那条聚合
增长的根因。

**修法：一处，`Map` → `WeakMap`**

```ts
// 前
const liveRanges = new Map<HTMLElement, { from: number; to: number }>()
// 后
const liveRanges = new WeakMap<HTMLElement, { from: number; to: number }>()
```

`get` / `set` / `delete` 的用法一行没改（`WeakMap` 三者都有），缓存语义不变：键是 DOM，值
只是一个 `{from, to}` 的小对象，没有“需要按 DOM 回收时跑清理”的东西。`liveWraps` 保持
`Map`：它按 widget 实例存 DOM 且要被 `refresh` 遍历清扫，弱化会让“实例还在但 DOM 已被 GC”
这种状态不可见。

### 改完之后：聚合增长没有变化（独立复核）

同一脚本、同一文档、同样的 100 / 500 / 1000 次翻转，`liveRanges` 换成 `WeakMap` 之后重新
量了一次（2026-10-28 macOS 26.2 arm64，Chrome 156.0.8078.48，端口 9438，
`PW_PORT=9438 pnpm --filter @omd/desktop audit:widget-memory`）：

```text
baseline        6.6 MB   (6,866,952)
flips  100      7.6 MB   (7,960,528)
flips  500      9.1 MB   (9,566,068)
flips 1000     10.7 MB  (11,237,248)
afterDestroy   10.7 MB  (11,220,844)
```

和上面那批 pre-change 数字（6,876,232 / 7,969,720 / 9,575,068 / 11,246,292 / 11,229,856）
逐点比对：**没有变化**。100 → 1000 仍是 +41%（11,237,248 / 7,960,528 = 1.41）。

判定阈值 `afterDestroy / flips100 ≤ 1.20`：

```text
pre-change : 11,229,856 / 7,969,720 = 1.41     ✗
post-change: 11,220,844 / 7,960,528 = 1.4096   ✗
```

把 GC 次数加码也救不回来：每采样点三次 `HeapProfiler.collectGarbage`、`view.destroy()` 之后
再追加五次，终点仍是 **11,316,564 bytes**。增量的来源不是“GC 没跑够”。

**聚合增长的分类仍是 `production-browser reproduced`，并且未解决。**

### 修正后的快照分析：根因 `inconclusive`

早期版本把 pre-change 快照里 `Map #35608 keys = 1002` 当作整条缺陷的根因，这是错的：它只
解释被它钉住的那批 detached DOM，解释不了同时出现的 MB 级聚合增长 —— 换成 `WeakMap` 之后
聚合增长纹丝不动，就是反证。

重做 retainer 分析时还纠正了一个方法学错误：**V8 的 heap snapshot 会把 `WeakMap` 的键经
ephemeron table 边画进图里，但那条边不是强引用。** 按“图上可达”统计，会把只是尚未回收、
已经不可强达的键算成“仍被强引用”，从而把 `WeakMap` 之后残留的 DOM 误读成仍在泄漏。
排除 ephemeron 边、只保留真正的强引用路径后：

```text
采样的 retained islands：16
  14 / 16：没有任何强根路径（只剩 ephemeron 边 / 快照残留）
   2 / 16：由浏览器自身（DevTools/CDP 会话）持有
   0 / 16：能证明存在 OMD 侧的强根路径
```

**结论：`inconclusive`。** 聚合堆增长能稳定复现，但现有证据不能把它归到任何一条 OMD 强
引用上：既不能证明保留者在引擎/CM 侧，也不能证明不在。这类场景下“堆总量 + 快照可达性”
不是有效证据 —— 它把未回收但不可强达的对象和真正被强保留的对象画在同一张图里。

### 现状：保留的所有权修正 vs 未满足的验收阈值

- **保留 `Map` → `WeakMap`**：它是行为安全的**所有权修正**（模块级 `Map` 用 DOM 作键把卸载
  后的 wrap 强引用住，这一点由 pre-change 快照确凿证实；`get` / `set` / `delete` 用法一行
  没改，缓存语义不变）。但它**没有**满足聚合内存验收阈值（`1.4096` > 1.20）。
- **保留 `liveWraps` 为 `Map`**：它按 widget 实例存 DOM 且要被 `refresh` 遍历清扫，弱化会
  让“实例还在但 DOM 已被 GC”这种状态不可见。
- **推迟 disposer / per-view 注册表**：`BlockWidget.own(disposer)` 或 per-view 注册表只有在
  **某条 OMD 强根路径被证明之后**才值得加；在根因 `inconclusive` 时加，等于给未知保留者
  套一层“每条 destroy 路径都必须正确”的新失败面。同理不要加 `liveRanges.clear()`：模块级
  缓存不认识 view 生命周期。
- **回归防线**：`test/widgetChurnBounds.test.ts` 第三条用例读源码，要求 `liveRanges` 声明为
  `WeakMap<HTMLElement, { from: number; to: number }>` 且 `liveWraps` 仍是
  `Map<BlockWidget, HTMLElement>`。它守的是**所有权**（有人手滑改回 `Map` 会立刻红），**不**
  守内存 —— 堆大小依赖 GC 时机，不适合做断言，真实数值只走上面的手动审计。

## Complex Table `HTMLBlock` is a closed Type 6 contract, never general HTML

Why a pasted `<table>` with `rowspan`/`colspan` has four strict invariants across `paste/`, `parse/`, `decorations/`, and `export/`:

1. **CommonMark Type 6 HTML blocks end at the first blank line.** If `serializeComplexTable` ever emits an empty physical line inside `<table>...</table>` (for example from multi-paragraph cell content), Lezer terminates the `HTMLBlock` mid-table and parses the remainder as paragraphs. And if the block is followed immediately by text without a blank line, Type 6 swallows the following paragraph into the `HTMLBlock`. `serializeComplexTable` therefore flattens multi-block cells with `<br>`, strips any internal blank lines, and sets `boundary: { start: "block", end: "htmlBlock" }` so `normalizeBlockPaste` always closes with `\n\n`.
2. **Container nesting breaks block closure.** Inside `BulletList`, `OrderedList`, or `Blockquote`, a multi-line `HTMLBlock` without container continuation prefixes splits the enclosing container. `smartPaste.ts::canHostComplexTable` inspects the syntax tree at `from` and only permits `allowComplexTable` at top-level `Document` or a top-level `Paragraph`; any other host context downgrades to a GFM table or plain text and increments `unsupportedTable`.
3. **One closed validator (`parse/complexTable.ts::parseComplexTableBlock`) gates both preview and export.** Only a single top-level `<table>` with whitelisted tags (`thead`, `tbody`, `tfoot`, `tr`, `th`, `td`, `br`, `strong`/`b`, `em`/`i`, `del`/`s`, `mark`, `u`, `kbd`, `sub`, `sup`, `code`, `a`, `img`), whitelisted attributes (`rowspan`, `colspan`, `scope`, `align`, `href`, `src`, `alt`, `title`), URLs accepted by `normalizePasteUrl`, and a rectangular 2D span occupancy grid (no overlap, no dangling row/col span, bounded dimensions) produces a `ComplexTableModel`. Anything else returns `null`, leaving the `HTMLBlock` as raw source in preview and escaped text in `exportHtml` / `exportRichHtml`.
4. **`HTMLBlock` must be in `SELECTION_BLOCKS` (`decorations/build.ts`).** Because `ComplexTableWidget` replaces the full `HTMLBlock` when unselected and unmounts to `line:omd-table-src` when selected, selection transitions into/out of an `HTMLBlock` must expand the decoration rebuild range to the full block node.
