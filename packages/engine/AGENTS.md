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
│   ├── parse/                   # Lezer Markdown + dialect extensions (see src/parse/AGENTS.md)
│   ├── decorations/             # StateField live preview + widgets (see src/decorations/AGENTS.md)
│   ├── format/                  # Editing commands + keymaps (see src/format/AGENTS.md)
│   ├── tables/                  # Lezer-range table model + edits (see src/tables/AGENTS.md)
│   ├── paste/                   # Smart Paste pipeline + block-boundary normalization (blockBoundaries.ts)
│   ├── export/                  # html.ts (sync exportHtml + async exportRichHtml), styles.ts, shikiExport.ts, mathHtmlCache.ts
│   ├── shiki/ · highlight/      # Lazy single-flight Shiki highlighter + code syntax highlighting
│   └── cache/boundedLru.ts      # Bounded LRU cache
└── test/                        # Vitest suite + fixtures/
```

## Public Surface & Domain Rules

1. **Expose host APIs only through `src/index.ts`:** Desktop code must consume `editorExtensions(options)` and exported pure helpers (`collectOutline`, `exportHtml`, `exportRichHtml`, link/footnote nav, table range edits, ordered-list normalization commands) — never reach into internal engine submodules or re-parse Markdown.
2. **Pure command helpers:** Table edit helpers return range changes and formatting specs return `TransactionSpec | null`. Ordered-list accept/reject helpers return discriminated results: check `kind` before consuming `.transaction`; `stale` has no transaction. These helpers never dispatch.
3. **Host-injected capabilities:** Resolve image URLs via `EngineOptions.resolveImageSrc` and localized fallback strings via `EngineOptions.imageBrokenLabel` (never import desktop i18n or Tauri APIs).
4. **No stock completion/pairing:** Only the `:`-only `emojiCompletion` and `format/autoPair.ts` are permitted; never enable stock `closeBrackets`, `indentOnInput`, or generic `autocompletion`.
5. **Module boundaries:** Apply the root size policy. Keep parsing in `parse/`, projection in `decorations/`, and editing plans in `format/`/`tables/`; put new responsibilities in cohesive modules rather than growing the widget or block dispatchers.

## Ordered-List Normalization Invariants (`lists/ordered.ts`)

1. Mount `orderedNormalizationState` directly in `editorExtensions()`, never inside `livePreviewCompartment`, so pending notices and post-reject suppression survive Source/Live toggles.
2. Classify batches via `normalizationTrigger(hasUserDocChange, treeLength, docLength)`: passes while `treeLength < docLength` merge into one `preview-entry` notice (keeping first `original` and latest `normalized`); complete-tree passes after a user edit are `user-followup` and only refresh already-pending markers.
3. `rejectOrderedListNormalization` restores unedited markers, suppresses further rewrites for that `EditorState` session, and keeps consecutive preview numbers via `widget:ordered-mark`. Compare notices by `.id`, not object reference.

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
