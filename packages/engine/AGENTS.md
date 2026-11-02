# Engine Domain

> **Parent:** [`../../AGENTS.md`](../../AGENTS.md)
> **Scope:** Markdown parsing, CodeMirror live-preview state, decorations, block widgets, HTML export, and engine tests (`packages/engine/**`). Framework-independent (no React/Tauri), browser-DOM-aware.

## Subdomain Guides (Proximity Scoped)

Read the applicable subdomain guides for source changes and the tests exercising them; `test/**` does not inherit guides under `src/**`. Table work spans parsing, formatting, and widgets: read the tables guide as well as each file's ancestor guides.

| Subdirectory | Guide | Covers |
| --- | --- | --- |
| `src/decorations/**` | [`src/decorations/AGENTS.md`](./src/decorations/AGENTS.md) | `StateField` progressive/windowed build, `atomicRanges`, Route A folding, `BlockWidget` 5 contracts |
| `src/format/**` | [`src/format/AGENTS.md`](./src/format/AGENTS.md) | `Prec.highest` Enter/Tab/Backspace chain, `blockPrefixOf`, `autoPair`, shortcut derivation |
| `src/tables/**` | [`src/tables/AGENTS.md`](./src/tables/AGENTS.md) | Two-state table model, Lezer-range edits, hover/source toolbars, `parseCell` |
| `src/parse/**` | [`src/parse/AGENTS.md`](./src/parse/AGENTS.md) | Lezer extensions, `chars.ts`, `isEscaped`/`skipInlineCode`, `inVerbatim`, no full-tree parses |

## Local Structure

```text
packages/engine/
├── src/
│   ├── index.ts                 # Public barrel: editorExtensions, collectOutline, exportHtml, shortcuts, nav/table APIs
│   ├── outline.ts · stats.ts    # Read-only heading outline and word/character counts
│   ├── docText.ts               # Streamed-chunk → CM Text assembly (LARGE-tier open ingest)
│   ├── safeModeRendering.ts · performancePolicy.ts · performancePolicyDiagnostics.ts
│   ├── links.ts · footnotesNav.ts · fenceInfo.ts
│   ├── lists/ordered.ts         # Ordered-list display labels and reversible normalization StateField
│   ├── modes/livePreview.ts     # Live/source compartment, Mod-e keymap, toggleShortcutLabels
│   ├── navigation/              # caretClamp.ts (lineContentStart clamp) + blockEntry.ts (ArrowUp/Down into blocks)
│   ├── parse/                   # Lezer Markdown + dialect extensions + complexTable.ts (see src/parse/AGENTS.md)
│   ├── semantic/                # linkParts, imageParts, escapeParts, hardBreakParts, referenceIndexExtension
│   ├── decorations/             # StateField live preview + widgets (see src/decorations/AGENTS.md)
│   ├── format/                  # Editing commands + keymaps (see src/format/AGENTS.md)
│   ├── tables/                  # Lezer-range table model + edits (see src/tables/AGENTS.md)
│   ├── paste/                   # Semantic clipboard importer (prepareSmartPaste, planSmartPaste, serializeComplexTable, blockBoundaries)
│   ├── export/                  # html.ts (sync exportHtml + async exportRichHtml), styles.ts, shikiExport.ts, mathHtmlCache.ts
│   ├── shiki/ · highlight/      # Lazy single-flight Shiki highlighter + code syntax highlighting
│   └── cache/boundedLru.ts      # Bounded LRU cache
└── test/                        # Vitest suite + fixtures/
```

## Public Surface & Domain Rules

1. **Expose host APIs only through `src/index.ts`:** Desktop code must consume `editorExtensions(options)` and exported pure helpers (`collectOutline`, `exportHtml`, `exportRichHtml`, `prepareSmartPaste`, `planSmartPaste`, `preparePlainTextFallback`, `normalizeBlockPaste`, semantic accessors/reference contexts, link/footnote nav, table range edits, ordered-list normalization commands) — never reach into internal engine submodules or re-parse Markdown.
2. **Pure command helpers:** Table edit helpers return range changes and formatting specs return `TransactionSpec | null`. Ordered-list accept/reject helpers return discriminated results: check `kind` before consuming `.transaction`; `stale` has no transaction. These helpers never dispatch.
3. **Host-injected capabilities:** Resolve image URLs via `EngineOptions.resolveImageSrc` and localized fallback strings via `EngineOptions.imageBrokenLabel` (never import desktop i18n or Tauri APIs).
4. **No stock completion/pairing:** Only the `:`-only `emojiCompletion` and `format/autoPair.ts` are permitted; never enable stock `closeBrackets`, `indentOnInput`, or generic `autocompletion`.
5. **Module boundaries:** Apply the root size policy. Keep parsing in `parse/`, projection in `decorations/`, and editing plans in `format/`/`tables/`; put new responsibilities in cohesive modules rather than growing the widget or block dispatchers.

## Ordered-List Normalization Invariants (`lists/ordered.ts`)

1. Mount `orderedNormalizationState` directly in `editorExtensions()`, never inside `livePreviewCompartment`, so pending notices and post-reject suppression survive Source/Live toggles.
2. Classify batches via `normalizationTrigger(hasUserDocChange, treeLength, docLength)`: passes while `treeLength < docLength` merge into one `preview-entry` notice (keeping first `original` and latest `normalized`); complete-tree passes after a user edit are `user-followup` and only refresh already-pending markers.
3. `rejectOrderedListNormalization` restores unedited markers, suppresses further rewrites for that `EditorState` session, and keeps consecutive preview numbers via `widget:ordered-mark`. Compare notices by `.id`, not object reference.

## Semantic Projection & Smart Paste Invariants

1. **One semantic reader per syntax family (`src/semantic/`, `parse/cell.ts`):** `linkParts`, `imageParts`, `escapeParts`/`hardBreakParts`, and `parseCell` are the sole owners of Link/Autolink, Image, Escape/HardBreak, and table-cell inline semantics. `referenceIndexExtension` is mounted at top level in `editorExtensions()` (incremental over changed/newly covered blocks; never scans the full document or calls `ensureSyntaxTree`). `widgets/tableCell.ts` is the sole preview cell DOM projection; reference-dependent widgets (`Image`, `Table`) invalidate on `resolveReference` identity in `build.ts::semanticProjections` and `TableWidget.eq`.
2. **One-parse validated Smart Paste (`src/paste/`):** `normalizeHtml.ts` (iterative DOM walk bounded by `MAX_PASTE_DOM_DEPTH`/`MAX_PASTE_DOM_NODES`), `urlPolicy.ts::normalizePasteUrl`, `triggerPolicy.ts::escapePasteText`, `serialize.ts`, `validate.ts::validatePasteCandidate`, and `smartPaste.ts::planSmartPaste` each have a single owner. Candidate validation performs at most one synthetic parse on `prefix + candidate + suffix` from the already-covered syntax tree; rejected or over-limit candidates degrade directly to whole-fragment strict literal.
3. **Closed Complex Table HTMLBlock (`parse/complexTable.ts`, `paste/serializeComplexTable.ts`, `decorations/widgets/complexTable.ts`):** Spanned/multi-block tables at top-level `Document`/`Paragraph` serialize to canonical CommonMark Type 6 `<table>...</table>` `HTMLBlock` (`boundary.end === "htmlBlock"`, no blank lines inside); inside lists/blockquotes they downgrade to GFM/plain text (`unsupportedTable`). `parseComplexTableBlock` is the closed-whitelist validator (2D occupancy grid, `normalizePasteUrl`, zero `innerHTML`) shared by `ComplexTableWidget` (`HTMLBlock` in `SELECTION_BLOCKS`) and `exportHtml`/`exportRichHtml`; non-conforming `HTMLBlock`s stay raw source in preview and escaped text in export.

## Testing

```sh
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/engine bench
```

- Use `test/helpers.ts::makeState` when a test requires a complete syntax tree (`ensureSyntaxTree`). Production code must **never** force full-document parsing (`apps/desktop/test/crossLayerNoFullTree.test.ts`).
- Use `drainPendingLiveBuild(view)` in tests that need all progressive decorations built synchronously.
- Every new widget type must have a real `EditorView` smoke test in `test/view.test.ts` asserting `EditorView.exceptionSink` stays empty.
- For decoration changes, compare incremental updates with a fresh rebuild and cover collapsed, partial, and fully covering selections. Async widgets need explicit completion/degradation assertions, not incidental microtask timing.
- Mock `mermaid` for happy-dom SVG success cases; keep the real library for invalid-syntax fallback tests.
