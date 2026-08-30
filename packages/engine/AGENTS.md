# Engine Domain

> **Parent:** [`../../AGENTS.md`](../../AGENTS.md)
>
> **Scope:** Markdown parsing, CodeMirror live-preview state, decorations, block widgets, and engine tests. The package is framework-independent but browser-DOM-aware.

## Read This When

- You are changing `packages/engine/src/**` or `packages/engine/test/**`.
- You are adding or changing Markdown syntax, folded markers, widgets, or live/source behavior.
- A rendering defect appears to come from the syntax tree or decoration ranges rather than CSS.

## Local Structure

```text
packages/engine/
├── src/
│   ├── index.ts                 # Public editorExtensions, collectOutline, exportHtml
│   ├── outline.ts               # Read-only heading outline from the Lezer tree
│   ├── docText.ts               # Streamed-chunk → Text assembly (LARGE-tier open ingest; parity-guarded)
│   ├── safeModeRendering.ts     # Safe-mode globals: render budget + windowed live decorations (LIVE_WINDOW_*, prune margins)
│   ├── lists/ordered.ts         # Ordered-list display labels and live-preview source renumbering
│   ├── parse/                   # Lezer Markdown, math, footnote, HTML-entity, and gemoji helpers
│   │   └── chars.ts             # Named ASCII char-code constants (no magic numbers)
│   ├── modes/livePreview.ts     # Live/source compartment and Mod-e keymap
│   ├── export/html.ts           # Document → HTML projection (not CM widget DOM)
│   └── decorations/
│       ├── build.ts             # StateField live decorations (seed + pending model) and incremental updates
│       ├── buildDriver.ts       # Idle-sliced ViewPlugin that drains LiveDeco.pending (viewport priority)
│       ├── inline.ts            # Inline and marker decorations
│       ├── blocks.ts            # Block detection and widget selection
│       ├── blockWidget.ts       # Shared widget lifecycle and edit transition
│       └── widgets/             # Code, math, table, Mermaid, and image renderers
├── test/                        # Vitest tests
└── test/fixtures/               # Markdown regression inputs
```

## Domain Boundaries

1. Keep Markdown syntax knowledge, Lezer tree inspection, and Markdown-specific CodeMirror decorations in this package.
2. Do not import React, Tauri APIs, desktop modules, or native filesystem APIs.
3. DOM use is allowed inside CodeMirror widgets. Keep it localized and compatible with the `happy-dom` test environment.
4. The engine emits semantic `omd-*` class names; visual declarations belong in `apps/desktop/src/styles.css`.
5. Expose desktop-facing behavior through `src/index.ts`: `editorExtensions(options)`, plus read-only `collectOutline(state)` and `exportHtml(state)`, plus the ordered-list normalization commands (`getPendingOrderedListNormalization`, `acceptOrderedListNormalization`, `rejectOrderedListNormalization`), plus navigation lookups (`classifyLink`, `footnoteAt`, `footnoteDefinitionPosition`, `footnoteReferencePosition`), plus table source transforms (`replaceTableCell`, `insertTableRow`, `insertTableColumn`, `deleteTableRow`, `deleteTableColumn`). Do not make desktop consumers assemble engine internals or re-parse Markdown. Commands stay pure: they return a `TransactionSpec` (or a `"stale"` result) and never dispatch. Read pending and build accept/reject transactions in the same tick as the triggering update; stale offsets if deferred.
6. Keep generic host choices such as editor dimensions, base typography, history, and non-Markdown keymaps in `apps/desktop/src/Editor.ts`.
7. **Shortcut labels are derived, not duplicated.** The formatting keymap is data: `markdownKeyBindings` (`format/commands.ts`) and `toggleKeyBindings` (`modes/livePreview.ts`) carry `id`/`key`/`display`/`run`; the CM keymap uses `key` and the desktop palette imports the derived `markdownShortcutLabels` / `toggleShortcutLabels` via `src/index.ts`. Change a shortcut in the binding entry only and keep `display` matching `key` — `test/shortcuts.test.ts` guards the pair.

## Ordered-list normalization invariants

1. `orderedNormalizationState` is a top-level `StateField` mounted directly in `editorExtensions()`, never inside `livePreviewCompartment`, so pending and post-reject session suppression survive Source/Live toggles.
2. Preview-entry batches merge under one pending id: keep the first `original`, take the latest `normalized`, leave `markerCount` unchanged. Follow-up batches (complete tree after a user edit) may refresh markers already pending but must not add new pending entries.
3. `rejectOrderedListNormalization` restores first-recorded `original` markers; markers the user edited in Source (or that follow-up batches overwrote) are skipped. Preview labels stay consecutive via `widget:ordered-mark` even when source markers are gapped after reject.
4. Session-local suppression after reject prevents further auto-renumbering until a fresh `EditorState` (reopen/reload). A new tab or document gets default behavior.
5. Compare pending notices by `id`, not object reference — `getPendingOrderedListNormalization` returns a new object each call.

## Decoration and Widget Invariants

1. Decorations must be sorted and non-overlapping where CodeMirror requires it.
2. When a block widget replaces a syntax node, skip that node's subtree and filter enclosed outer decorations; overlapping replace ranges can make `Decoration.set` throw.
3. Provide block/replacing decorations from a `StateField`, never a `ViewPlugin`. Update incrementally from mapped unchanged ranges, changed syntax blocks, selection-adjacent lines/blocks, and syntax-tree progress. Off-screen widgets are left to CodeMirror's DOM virtualization. Rebuild ranges end at `endLine.to + 1` (exclusive). Treat removal overlap as half-open so the next line's point decorations stay put; dedupe additions against retained specs. Empty ranges stay closed.
3a. Live decoration builds are progressive: field create/reconfigure only builds the cursor seed (`seedLiveDecorations`), the rest is `LiveDeco.pending` (sorted, disjoint, closed; point ranges are valid targets). `liveBuildDriver` (in `livePreviewExt()`, same compartment as the field) drains pending in microtask/idle callbacks only — never dispatch inside `ViewPlugin.update`. Never call `drainPendingLiveBuild` from production code; it is the synchronous test-only drain.
3b. Safe-mode windowing (`src/safeModeRendering.ts`, Task 3): when `setSafeModeRendering(true)`, the driver no longer drains to completion — it builds only pending inside the build window (each visible range ± `LIVE_WINDOW_CHARS`) and, after viewport/doc/selection changes, dispatches `livePruneOutside` with the prune window (± `LIVE_WINDOW_CHARS` + `LIVE_PRUNE_MARGIN_CHARS`; the margin is hysteresis so edge decorations do not flip between built and pending). The field removes specs/deco/atomic entries entirely outside every prune region and returns their line-aligned spans to pending; decorations partially overlapping a region stay. Default off keeps Task 2 drain-to-completion semantics byte-identical. Consequence of 3a+3b: decorations far from the viewport may be absent at any moment — production code must never assume a decoration exists outside the viewport window, and tests needing a complete build use the test-only `drainPendingLiveBuild` (see the「装饰不得假设已全量构建」entry in `docs/memory/known-gotchas.md`).
4. Preserve the source document, except for live-preview ordered-list marker normalization in `lists/ordered.ts`. That rewrite must stay reversible: every batch carries a trigger from `normalizationTrigger` (preview entry while the syntax tree does not yet cover the document, follow-up only for a complete-tree pass after a user edit) and records the replaced markers in `orderedNormalizationState`, which is mounted directly in `editorExtensions()` (never inside `livePreviewCompartment`) so a pending notice and its post-reject suppression survive Source/Live toggles. Preview-entry batches merge under one id; follow-up batches only refresh markers already pending. Never gate reversibility on pass count. A preview widget renders a projection and enters source editing from its current decoration range, never a captured constructor offset or opaque-block `posAtCoords`. `TableWidget` also edits cells in place: cell/toolbar `mousedown` must `stopPropagation` so the wrap handler does not unmount the widget; opening a cell editor places a caret instead of calling `input.select()` (which misleadingly paints the whole cell dark blue).
5. Treat a block as editable when the selection overlaps its source range **including both boundaries** *and does not fully cover it* (`!(sel.from <= from && sel.to >= to)`). A fully-covering selection (Cmd+A, drag across, Shift+↓) keeps the widget mounted with the `omd-block-covered` overlay from `decorations/blockSelectionOverlay.ts`; only a caret entering or a partial overlap reveals source. Do not replace selected source with a widget.
6. Fold `QuoteMark` unless the selection is inside `>` / `> ` itself. Do not reuse line-based `nearCursor` for quote markers; the cursor stays on the quote line while typing content. Inline marks inside a quote (`**`, links, images) also use `cursorInside`, so clicking quote content does not unfold syntax. A whole-line selection (triple-click) is not "inside" a mark. Nested quotes emit one `omd-blockquote-N` class per line from the innermost quote. List indent inside a quote starts after `> `, never from `line.from`. A list inside a quote keeps `omd-li-N` (hanging indent, quote bar at x=0). A quote inside a list item emits `omd-quote-in-li-N` instead, so the bar starts at the list indent and hanging indent stays off. Fold leading spaces before `>` as `QuoteIndent`. Fenced code in Live mode: lang blocks use `CodeWidget` only while the caret is outside (`blockSelected` → `styleCodeblockLines` so ↑/↓ edits native source). Fence label + language live in the info string (`parseFenceInfo` / `formatFenceInfo` / `replaceFenceInfo`); never write a title as the language token. Code chrome header (title, lang, copy) is always visible while the widget is mounted; click does not enter source; metadata writes use the live widget range, never constructor offsets. Mermaid/table/math still use block widgets and inherit quote/list depth via `BlockWidget.embed`.
7. `BlockWidget.eq` compares source text and `embed`. If rendering also depends on another input (`lang`, `alt`, table cells, resolver output), that input must participate in widget equality or trigger a safe rebuild. Range lookup must prefer widget identity before `eq()` because two distinct blocks can have identical source.
8. Async block widgets must install a synchronous source-shaped placeholder during `toDOM()` before CodeMirror's first layout measurement, then refresh the decoration StateField after the final DOM write. Failures must stay contained inside the widget and display actionable fallback content; they must not reject into the editor lifecycle.
9. Image paths are resolved through the `EngineOptions.resolveImageSrc` host callback. The engine must not assume Tauri file URLs.
10. **Route A mark folding** (`decorations/types.ts` documents the split): paired emphasis marks, ATX/Setext heading marks, and list marks fold **unconditionally** — the caret never reveals them, so clicking text only places the caret and lines never reflow. Editing goes through `format/commands.ts` toggles, or Backspace at a folded boundary (mid-line atoms delete whole via `skipAtomic`; line-start marks delete one char = progressive demotion). `nearCursor` survives only where source is the sole editing entry (link URL/title, image, inline math, footnote reference/definition); `cursorInside` serves QuoteMark, fence marks, entities/emoji, and links/images inside quotes. Never reintroduce caret-driven reveal for decorative marks — that is the click-flash regression this model removed.

## Parsing Rules

- Extend Lezer Markdown instead of introducing a second Markdown parser.
- Preserve existing syntax limitations unless the task explicitly changes them; encode intentional limitations in tests.
- Keep format-specific parsing in `parse/` and rendering decisions in `decorations/`.
- Use the named ASCII constants in `parse/chars.ts` (`CHAR_EQ`, `CHAR_UNDERSCORE`, …) when inspecting `cx.char(...)` — never bare character codes.
- Check child and parent node behavior when adding rules; block replacements can suppress inline decorations by design.

## Testing

Run:

```sh
pnpm test
pnpm --filter @omd/engine bench
```

- `pnpm test` performs `tsc --noEmit` and then runs Vitest.
- `pnpm --filter @omd/engine bench` 跑 advisory 大文档基准（typing p95 / 冷解析 / 装饰重建 / 字数统计 / 切 Live 种子（toggle.bench）/ open-live 摄入与分块 Text 对照（open.bench）/ 安全模式窗口化 typing）；预算超限只告警不阻断，CI 中 continue-on-error。
- Use `test/helpers.ts::makeState` when tests require a fully available syntax tree; it forces synchronous parsing with `ensureSyntaxTree`.
- Production code must never advance parsing to `doc.length` (`forceParsing`/`ensureSyntaxTree`) — the complete-tree trap in `docs/memory/known-gotchas.md` makes every subsequent keystroke O(fragment restart) at MB scale; `apps/desktop/test/crossLayerNoFullTree.test.ts` guards it.
- Add focused tests for parser node shapes, decoration tags/ranges, widget editing state, and live/source round trips.
- Add a fixture when a Markdown sample is useful across snapshot or regression tests. Keep fixtures deterministic and small unless testing large-document behavior.
- Async widgets require explicit timing/error assertions; do not rely on incidental microtask completion.
- Valid Mermaid diagrams can stall in `happy-dom`; mock `mermaid` for success SVG and keep the real library for invalid-syntax view tests.
- Incremental updates should match a full rebuild on the affected document and keep selection/local-edit spec churn far below the full spec list, plus a lenient `large.md` timing gate.
- For changes affecting appearance or interaction, also build the desktop frontend and perform the relevant items in `docs/manual-qa.md`.

## Common Pitfalls

- A correct parser node does not guarantee a valid decoration set; inspect overlaps and ordering separately.
- Cursor proximity and selection are part of rendering state. Test both collapsed cursors and non-empty selections.
- CodeMirror widgets create real DOM even though the package has no React dependency.
- CSS regressions cannot usually be fixed in this package because engine tests assert structure and ranges, not final desktop appearance.
- Mermaid, Shiki, and KaTeX may render asynchronously or throw on invalid source; preserve the original Markdown in error output.
- Do not add `indentOnInput`, `closeBrackets`, or generic `autocompletion` to compensate for preview behavior. Fix the underlying parse/decoration interaction. A `:`-only emoji completion override in `parse/emojiComplete.ts` is the exception; keep it in the engine and do not turn on default word completion in `createEditor`.
- Engine keymaps that must beat desktop `defaultKeymap` (`Enter`, `Tab`, `ArrowUp`/`ArrowDown`) need `Prec.high`. Desktop registers `defaultKeymap` before `editorExtensions()`, and earlier bindings win.
- **Selection is visual, the caret is editing**: `nearCursor`/`cursorInside` return false for any non-empty selection, and a fully-covering selection keeps block widgets rendered (see known-gotchas). Never reintroduce selection-driven source reveal — it relayouts lines mid-drag and pushes pointer-selection endpoints across newlines (atomicRanges Rule 3). Under Route A (invariant 10), decorative marks also never reveal to a collapsed caret.

## Documentation Maintenance

Before concluding engine work, check:

- [ ] Did public engine options or exports change?
- [ ] Did a parser or widget invariant change?
- [ ] Does a new regression belong in `docs/memory/known-gotchas.md`?
- [ ] Do fixtures, snapshots, or `docs/manual-qa.md` need updating?
- [ ] Did an approved architecture decision in the product spec change?
