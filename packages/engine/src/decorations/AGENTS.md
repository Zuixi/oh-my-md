# Engine Decorations & Widgets

> **Parent:** [`../../AGENTS.md`](../../AGENTS.md)
> **Scope:** Live-preview `StateField`, progressive/windowed decoration building, `atomicRanges`, Route A folding, and `BlockWidget` contracts (`src/decorations/**`).

## StateField & Progressive Windowing

- **Block decorations must come from a `StateField`, never a `ViewPlugin`.** CodeMirror throws `Block decorations may not be specified via plugins` at measure time (`livePreviewField` in `build.ts`).
- **Seed + idle drain (`build.ts`, `buildDriver.ts`):** `create`/reconfigure builds only the cursor seed (`seedLiveDecorations`, ±`LIVE_SEED_RADIUS_LINES` / `LIVE_SEED_RADIUS_CHARS`); remaining spans go into `LiveDeco.pending` (sorted, disjoint, closed) and drain in microtask/idle slices via `liveBuildChunk`. Never dispatch inside `ViewPlugin.update`, and never call the test-only `drainPendingLiveBuild` in production.
- **Safe-mode windowing (`safeModeRendering.ts`):** When windowed, `liveBuildDriver` builds only pending inside `visibleRanges ± LIVE_WINDOW_CHARS` and dispatches `livePruneOutside` (± `LIVE_WINDOW_CHARS + LIVE_PRUNE_MARGIN_CHARS`) to return line-aligned outer specs to `pending`. Never assume decorations exist outside the viewport window.
- **Incremental rebuild boundaries (`build.ts`):** `expandRange` ends at `endLine.to + 1` (exclusive). Treat removal overlap as half-open (`from < range.to`) so point decorations at the next line's `from` (e.g., `line:omd-blockquote-N`) are not dropped. Deduplicate additions against retained keys. Keep `keep` predicate identical across `specs`, `deco`, and `atomic`.
- **Blank lines:** Emit zero `line:omd-empty` decorations and never `display:none` blank lines.

## `atomicRanges` Three Rules (`build.ts::isAtomicSpec`)

1. **No `mark:` or `line:` tags** — adding them locks the caret out of styled text.
2. **No `widget:block:*` tags** — block widgets span multiple lines; making them atomic causes ↑/↓ to jump whole blocks and right-click paste to expand across adjacent lines.
3. **Mid-line only (`spec.from > line.from && spec.to <= line.to`)** — never include line-start marks (`# `, `> `, list indent/marks) or cross-line replaces (Setext underline), or `skipAtomsForSelection` cascades across newlines during pointer selection. Exclude `HardBreak` trailing markers from `atomicRanges`.

## Route A Folding & Selection Stability (`inline.ts`, `blocks.ts`, `types.ts`)

- **Unconditional fold:** Paired emphasis (`**`, `*`, `~~`, `==`, `<u>`, `<kbd>`, `~`, `^`, `` ` ``), ATX/Setext heading marks, and list indent/marks fold unconditionally — never reveal them on caret entry.
- **Node-level `cursorInside` reveal (`sf === st && sf >= from && sf < to`):** Used only for syntax whose source is the sole editing entry (`Link`, `Autolink`, `Image`, `InlineMath`, `FootnoteReference`, `FootnoteMark`, `QuoteMark`, `QuoteIndent`, fence `CodeMark`/`CodeInfo`, `Entity`, `Emoji`, `Escape`, `HardBreak`). Gate `Link` at the whole node, never per child (`LinkMark` vs `URL`).
- **Selection is visual, caret is editing:** Non-empty selections never trigger `cursorInside` or `nearCursor`. A block is editable (`blockSelected`) when selection overlaps `[from, to]` (inclusive) **and does not fully cover it** (`!(sel.from <= from && sel.to >= to)`). Fully covering selections keep the widget mounted with `.omd-block-covered` (`blockSelectionOverlay.ts`).
- **Quotes & lists (`blocks.ts`):** Emit one `omd-blockquote-N` per line from the innermost `Blockquote` (capped at `MAX_QUOTE_DEPTH`). List indent inside a quote starts after `> `. List-in-quote uses `omd-li`; quote-in-list uses `omd-quote-in-li`; both pass real depth via `--omd-list-depth` (`tag: line:omd-li-${depth}`).
- **Fenced code (`blocks.ts::styleFencedCode`):** Keep exact branch order: single-line typing fence (plain text) → `mermaid` widget (`!blockSelected`) → `blockSelected` editing chrome (`styleEditingCodeblock` with `CodeChromeWidget` on opening line and real closing `CodeMark` lookup, never `lineAt(node.to)`) → language-less `styleCodeblockLines` → `CodeWidget`.

## `BlockWidget` Five Mandatory Contracts

Every `block: true` widget (`widgets/*.ts`) must wire all five:

1. **Selection rebuild (`build.ts::SELECTION_BLOCKS`):** Register the syntax node name so caret entry/exit rebuilds the block range.
2. **Height estimation (`widgetHeights.ts`):** Declare a positive `estimatedHeight` (guarded by `test/widgetHeights.test.ts`).
3. **Spec identity reuse (`build.ts` `removedByKey` + `WidgetType.eq`):** Implement `eq` comparing `src`, `embed`, and render-affecting inputs (`lang`, `title`, `tableEqualityKey`) — never `pos`. Preserving spec identity prevents CodeMirror from resetting measured heights to estimates on `measureBlockWidget`.
4. **Keyboard entry (`navigation/blockEntry.ts`):** Support ArrowUp/ArrowDown entry into source in `blockEntryPosition`.
5. **Covered selection & lifecycle (`blockSelectionOverlay.ts`, `blockWidget.ts`):** Register/unregister in `toDOM`/`updateDOM`/`destroy`. Separate instance lifetime from tile lifetime via `activateDom(wrap)` and `destroy(dom)`. Install synchronous placeholders in `toDOM` before async renders, refresh via `measureBlockWidget`, and expose `data-omd-highlight` / `data-omd-render` markers.

## Widget-Specific Invariants

- **`CodeWidget` (`widgets/code.ts`):** Lazy single-flight Shiki via `shiki/codeHighlighter.ts`; bounded LRU cache via `codeHtmlCache.ts` (128 entries / 8 MiB). Body click enters source at clicked `span.line` with 4px drift guard.
- **`MathBlockWidget` (`widgets/math.ts`):** `enterSourceOnClick` is `false`; click opens `.omd-math-popup` hosting an inner CM6 view (`__omdMathPopupView` on DOM, never on widget fields). Re-sync in `updateDOM` via `mathEditorTexOf`, skip while `view.composing` or when `liveRange` is stale, and guard close with `closed` flag to avoid synchronous `focusout` double-destroy.
- **`TableWidget` (`widgets/table.ts`):** See [`../tables/AGENTS.md`](../tables/AGENTS.md).
