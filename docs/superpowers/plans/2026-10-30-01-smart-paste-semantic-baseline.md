# Smart Paste Semantic Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the existing Link/Image, Escape, HardBreak, and table-cell semantic drift before changing the production paste pipeline.

**Architecture:** Add small, lazy semantic accessors over Lezer nodes and make Preview, sync export, rich export, and `parseCell` consume them. Keep `parse/cell.ts` as the only table-cell parser and leave Turndown/DOM paste behavior untouched in this plan.

**Tech Stack:** TypeScript, CodeMirror 6, Lezer Markdown, Vitest, happy-dom.

**Spec:** `docs/superpowers/specs/2026-10-30-smart-paste-semantic-import-design.md`

## Global Constraints

- Engine owns Markdown node interpretation; desktop must not parse Markdown.
- Accessors return facts/ranges, never Decoration, CSS, or HTML templates.
- `parse/cell.ts` remains the only table-cell mini-document parser.
- Do not build or cache a complete second AST.
- Do not advance the production syntax tree to the end of the document.
- Existing Markdown source bytes and export source state must remain unchanged.

## File Map

- Create `packages/engine/src/semantic/inlineText.ts`: visible inline text from a bounded Lezer subtree.
- Create `packages/engine/src/semantic/link.ts`: shared Link/Autolink destination, title, and visible-label extraction.
- Create `packages/engine/src/semantic/image.ts`: shared Image alt/src/title extraction over the same reference context.
- Create `packages/engine/src/semantic/breaks.ts`: Escape and HardBreak marker/value ranges.
- Create `packages/engine/src/semantic/references.ts`: incremental reference-definition index and snapshot contexts.
- Modify `packages/engine/src/links.ts`: share reference-destination lookup with images without changing the public `linkHref` contract.
- Modify `packages/engine/src/decorations/inline.ts`: consume Image/Escape/HardBreak accessors.
- Modify `packages/engine/src/parse/cell.ts`: consume the same accessors.
- Modify `packages/engine/src/tables/model.ts`: retain raw cell source without pipe pre-decoding.
- Create `packages/engine/src/decorations/widgets/tableCell.ts`: extract the existing cell DOM renderer and wire its semantic dependencies.
- Modify `packages/engine/src/decorations/widgets/table.ts`, `decorations/blocks.ts`, and `decorations/build.ts`: thin resolver/dependency wiring; frozen modules must not grow.
- Modify `packages/engine/src/export/html.ts`: use shared Image and cell models in both exporters.

---

### Task 1: Shared Link and Image semantics

**Files:**
- Create: `packages/engine/src/semantic/inlineText.ts`
- Create: `packages/engine/src/semantic/link.ts`
- Create: `packages/engine/src/semantic/image.ts`
- Create: `packages/engine/src/semantic/references.ts`
- Modify: `packages/engine/src/index.ts`
- Modify: `packages/engine/src/links.ts`
- Modify: `packages/engine/src/decorations/inline.ts`
- Modify: `packages/engine/src/decorations/build.ts`
- Modify: `packages/engine/src/decorations/widgets/image.ts`
- Modify: `packages/engine/src/parse/cell.ts`
- Modify: `packages/engine/src/export/html.ts`
- Create: `packages/engine/test/semanticImage.test.ts`
- Create: `packages/engine/test/semanticLink.test.ts`
- Create: `packages/engine/test/semanticReferences.test.ts`
- Test: `packages/engine/test/export.test.ts`
- Test: `packages/engine/test/export-rich.test.ts`
- Test: `packages/engine/test/tables.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ImageParts {
  readonly alt: string
  readonly src: string
  readonly title: string | null
}

export interface MarkdownSlice {
  sliceString(from: number, to: number): string
}

export interface MarkdownReferenceContext extends MarkdownSlice {
  resolveReference(label: string): { readonly href: string; readonly title: string | null } | null
}

export interface LinkParts {
  readonly href: string
  readonly title: string | null
  readonly text: string
  readonly labelFrom: number
  readonly labelTo: number
  readonly kind: "link" | "autolink"
}

export function visibleInlineText(
  source: MarkdownSlice,
  node: SyntaxNode,
  from: number,
  to: number,
): string

export function linkParts(node: SyntaxNode, source: MarkdownReferenceContext): LinkParts | null
export function imageParts(node: SyntaxNode, source: MarkdownReferenceContext): ImageParts | null
export function editorReferenceContext(state: EditorState): MarkdownReferenceContext
export function snapshotReferenceContext(state: EditorState): MarkdownReferenceContext
export function stringReferenceContext(source: string): MarkdownReferenceContext
export const referenceIndexExtension: Extension
```

- `linkParts` supports inline/reference links and autolinks, preserves optional title, normalizes autolink display/destination, and never scans outside its supplied snapshot.
- `imageParts` supports inline and reference images, decodes Entity/Escape in alt, removes formatting markers from alt, and uses the same normalized-label lookup. Live Preview uses `editorReferenceContext(state)` backed by one immutable reference-definition index in `referenceIndexExtension`, registered outside the live/source compartment. Seed from the available tree once; subsequent document/tree-progress updates map definition ranges and rescan only changed or newly covered top-level blocks. Retain the resolver snapshot when definitions have not changed. A new Lezer `Tree` alone must not trigger whole-document recollection.
- `snapshotReferenceContext(state)` is for export and standalone read-only snapshot queries, never live Preview invalidation: collect definitions once from the available snapshot tree and reuse the resolver across both inline and cell rendering. A per-Tree `WeakMap` is acceptable here, not as the live typing invalidation strategy. Neither context forces tree completion; unavailable definitions remain unresolved rather than using stale destinations. Standalone fragment tests use `stringReferenceContext(source)` bounded to the supplied fragment.
- Reuse only the definition resolver/index when definitions are unchanged, not an old context's source reader: `sliceString` must always read the requested state snapshot. Include a text-only edit with unchanged definitions to catch stale label/alt text.
- `linkHref(state, node)` remains source-compatible as a thin wrapper around `linkParts`; Preview, both exporters, and cell parsing stop carrying independent destination/title/autolink logic.
- Extend the existing CellNode link/image shapes with `title: string | null` in this task and update their constructors/tests. Task 3 wires title rendering through the actual table widget.
- `editorReferenceContext` uses the indexed snapshot when the extension is installed. Preserve existing standalone `linkHref` callers without that extension by using `snapshotReferenceContext` for those read-only queries; the production Preview path always installs the index.

- [x] **Step 1: Add failing accessor and exporter tests**

Create states containing these exact image sources and assert the exact parts/HTML:

```ts
const cases = [
  { source: "![plain](a.png)", alt: "plain", src: "a.png", title: null },
  { source: "![a *b* &amp; c](a.png \"caption\")", alt: "a b & c", src: "a.png", title: "caption" },
  { source: "![ref][id]\n\n[id]: img.png \"title\"", alt: "ref", src: "img.png", title: "title" },
  { source: "![](empty.png)", alt: "", src: "empty.png", title: null },
]
```

For every case, assert sync and rich export contain the same escaped `src` and `alt`; for reference images assert the resolved destination, not `[id]`.

Add inline/reference/autolink link cases with Entity/Escape/formatting in the label and optional titles. Assert Preview destination resolution, `parseCell`, sync export, and rich export agree on visible label, escaped href, and escaped title; email/`www.` autolinks use one normalization path.

In `semanticReferences.test.ts`, cover reference edits/removal, duplicate-label first-definition precedence, source/live toggles, and incremental tree coverage. Instrument visited source blocks: after initial indexing, repeated edits beside a reference image must not rescan unchanged document blocks or change the resolver snapshot when definitions are unchanged. Changing a definition must refresh an already-mounted dependent image without editing its own source.

- [x] **Step 2: Run the focused tests and verify RED**

```bash
pnpm --filter @omd/engine exec vitest run test/semanticLink.test.ts test/semanticImage.test.ts test/semanticReferences.test.ts test/export.test.ts test/export-rich.test.ts test/tables.test.ts
```

Expected: both exporters currently emit `alt=""`; Preview/cell parsing does not share one accessor.

- [x] **Step 3: Implement visible-text and Image accessors**

Traverse only the bounded Link/Image label range. Skip syntax marks, recursively read semantic children, decode `Entity` with `decodeHtmlEntity`, and decode `Escape` by omitting its leading backslash. Resolve reference destinations/titles through one normalized-label lookup shared by links and images.

Register `referenceIndexExtension` once in `editorExtensions()`. Keep the index to definition facts/ranges, not a second Markdown AST. When a definition changes or becomes available, invalidate dependent visible reference projections even if their source ranges were unchanged; keep pending/off-screen decoration behavior intact. Reference-image equality must include resolved destination/title inputs. Put supporting logic in `semantic/references.ts`, with only thin wiring in `decorations/build.ts`.

Replace the two `head.indexOf("](")` implementations and both exporter `alt=""` branches with `imageParts`. Replace exporter/cell autolink and link-title extraction branches with `linkParts` while keeping the existing public `linkHref` wrapper.

- [x] **Step 4: Run focused and full engine tests**

```bash
pnpm --filter @omd/engine exec vitest run test/semanticLink.test.ts test/semanticImage.test.ts test/semanticReferences.test.ts test/export.test.ts test/export-rich.test.ts test/tables.test.ts
pnpm test
pnpm --filter @omd/desktop test
pnpm check:quality
```

- [x] **Step 5: Commit the Image semantic unit**

```bash
git add packages/engine/src/semantic/inlineText.ts packages/engine/src/semantic/link.ts packages/engine/src/semantic/image.ts packages/engine/src/semantic/references.ts packages/engine/src/index.ts packages/engine/src/links.ts packages/engine/src/decorations/inline.ts packages/engine/src/decorations/build.ts packages/engine/src/decorations/widgets/image.ts packages/engine/src/parse/cell.ts packages/engine/src/export/html.ts packages/engine/test/semanticLink.test.ts packages/engine/test/semanticImage.test.ts packages/engine/test/semanticReferences.test.ts packages/engine/test/export.test.ts packages/engine/test/export-rich.test.ts packages/engine/test/tables.test.ts
git commit -m "fix: share link and image semantics across projections"
```

### Task 2: Escape and HardBreak parity

**Files:**
- Create: `packages/engine/src/semantic/breaks.ts`
- Modify: `packages/engine/src/decorations/inline.ts`
- Modify: `packages/engine/src/decorations/build.ts`
- Modify: `packages/engine/src/parse/cell.ts`
- Modify: `packages/engine/src/export/html.ts`
- Create: `packages/engine/test/semanticBreaks.test.ts`
- Test: `packages/engine/test/view.test.ts`
- Test: `packages/engine/test/export.test.ts`
- Test: `packages/engine/test/export-rich.test.ts`
- Test: `packages/engine/test/tables.test.ts`

**Interfaces:**
- Produces:

```ts
export interface EscapeParts {
  readonly markerFrom: number
  readonly markerTo: number
  readonly valueFrom: number
  readonly valueTo: number
}

export interface HardBreakParts {
  readonly markerFrom: number
  readonly markerTo: number
  readonly newlineFrom: number
  readonly newlineTo: number
  readonly kind: "backslash" | "spaces"
}

export function escapeParts(node: SyntaxNode): EscapeParts | null
export function hardBreakParts(node: SyntaxNode, source: MarkdownSlice): HardBreakParts | null
```

- [x] **Step 1: Add failing cross-projection tests**

Use the exact source:

```ts
const source = "access\\_token before\\\nafter before  \nafter"
```

Assert:

- Preview text is `access_token before` + line break + `after before` + line break + `after`, with no visible backslash or trailing marker spaces.
- Both exporters contain `access_token before<br>after before<br>after`.
- Standalone cell source `a \| b` produces visible `a | b` through `parseCell`.
- Standalone cell source with two backslashes before `|` preserves one literal backslash plus the pipe after Markdown Escape decoding. A full table row with three backslashes before `|` likewise keeps one cell containing `a \| b`; two backslashes before `|` split the outer row into two cells (`a \` and `b`) per GFM rules. Keep this ordinary Markdown decoding separate from the GFM opaque-value rule implemented in Task 3.

- [x] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @omd/engine exec vitest run test/semanticBreaks.test.ts test/view.test.ts test/export.test.ts test/export-rich.test.ts test/tables.test.ts
```

- [x] **Step 3: Implement accessors and projections**

For `Escape`, hide/render only `[node.from, node.from + 1)` and keep the escaped character. Reveal that marker while a collapsed caret is inside the `Escape` node so users can edit or delete the source byte. For `HardBreak`, keep the newline and hide/render the marker range ending at `node.to - 1`; determine backslash vs spaces through the supplied `MarkdownSlice`, not from a regex over the entire cell. Reveal the marker while the caret is inside the node, and explicitly exclude the line-end replacement from `atomicRanges` so typing a trailing backslash cannot make the caret disappear or push a pointer selection across the newline.

Add explicit `Escape` and `HardBreak` cases to `parse/cell.ts` and both HTML renderers. Do not add them to generic `SKIP` sets, because they have visible semantic output.

- [x] **Step 4: Run focused, full engine, and desktop build checks**

```bash
pnpm --filter @omd/engine exec vitest run test/semanticBreaks.test.ts test/view.test.ts test/export.test.ts test/export-rich.test.ts test/tables.test.ts
pnpm test
pnpm --filter @omd/desktop build
```

- [x] **Step 5: Commit the break semantic unit**

```bash
git add packages/engine/src/semantic/breaks.ts packages/engine/src/decorations/inline.ts packages/engine/src/decorations/build.ts packages/engine/src/parse/cell.ts packages/engine/src/export/html.ts packages/engine/test/semanticBreaks.test.ts packages/engine/test/view.test.ts packages/engine/test/export.test.ts packages/engine/test/export-rich.test.ts packages/engine/test/tables.test.ts
git commit -m "fix: project escapes and hard breaks consistently"
```

### Task 3: One table-cell model for Preview and both exporters

**Files:**
- Modify: `packages/engine/src/parse/cell.ts`
- Modify: `packages/engine/src/export/html.ts`
- Modify: `packages/engine/src/tables/model.ts`
- Create: `packages/engine/src/decorations/widgets/tableCell.ts`
- Modify: `packages/engine/src/decorations/widgets/table.ts`
- Modify: `packages/engine/src/decorations/blocks.ts`
- Modify: `packages/engine/src/decorations/build.ts`
- Create: `packages/engine/test/tableCellProjection.test.ts`
- Test: `packages/engine/test/export.test.ts`
- Test: `packages/engine/test/export-rich.test.ts`
- Test: `packages/engine/test/tables.test.ts`

**Interfaces:**
- Keeps `parseCell` as the only cell parser and extends it without breaking current callers:

```ts
export interface CellParseOptions {
  readonly resolveReference?: MarkdownReferenceContext["resolveReference"]
  readonly pipeEscapes?: "markdown" | "gfm-table"
}

export function parseCell(source: string, options?: CellParseOptions): CellNode[]
```

`source` is always raw cell Markdown; default `pipeEscapes: "markdown"` preserves standalone-call behavior. All source-backed GFM Table consumers pass `"gfm-table"`. Use the link/image title fields introduced in Task 1, and add subscript/superscript containers so the importer cannot emit cell semantics that its projections drop.

- Produces engine-internal helpers:

```ts
export function renderTableCellContent(
  parent: HTMLElement,
  source: string,
  resolveSrc?: (src: string) => string,
  options?: CellParseOptions,
): void

function tableCellNodes(
  node: SyntaxNode,
  state: EditorState,
  context: MarkdownReferenceContext,
): CellNode[]
function cellNodesHtml(nodes: readonly CellNode[]): string
async function richCellNodesHtml(
  nodes: readonly CellNode[],
  options: ExportRichHtmlOptions,
): Promise<string>
```

- [x] **Step 1: Add failing rich-export parity tests**

Use one table containing all affected constructs:

```md
| pipe | break | list | image | math |
|---|---|---|---|---|
| a \| b | before<br>after | - one | ![alt](x.png) | $x_1$ |
```

Assert rich export:

- contains `a | b`, never `a \| b`;
- contains `<br>`;
- contains `<ul><li>one</li></ul>`;
- contains `alt="alt"` and uses `resolveImageSrc` for the local image;
- resolves a cell reference link/image against a definition located after the table and preserves its optional title;
- uses KaTeX for cell math, while sync export keeps its documented code fallback.

Add `tableCellProjection.test.ts` cases for raw cell source `` `a \| b` `` rendering `<code>a | b</code>`, one-through-four backslash runs before a pipe inside/outside code, and unchanged table range-edit offsets. Assert DOM Preview plus both exports agree on title, reference destinations and sub/sup. Edit a definition after the table while its widget remains mounted; href/src/title must refresh without changing the table source. Include two identical tables so dependency refresh cannot confuse instance ranges.

- [x] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @omd/engine exec vitest run test/tableCellProjection.test.ts test/export.test.ts test/export-rich.test.ts test/tables.test.ts
```

Expected: `exportRichHtml` currently calls `richChildren(TableCell)` and bypasses `parseCell`.

- [x] **Step 3: Route Preview and both Table exporters through the raw-source cell contract**

Remove independent pipe pre-decoding from both `tables/model.ts` and `export/html.ts`; `TableCellData.text` becomes trimmed raw Markdown and `source`/range offsets remain byte-identical. Audit its consumers so none still expects a pre-decoded string. In `parseCell`, let Lezer interpret ordinary Escape nodes. For `"gfm-table"` only, remove the one outer-table shielding backslash from odd escaped-pipe runs inside opaque inline-code values before emitting their visible value; inline code itself has no Escape child. Preserve its other literal backslashes. Do not blanket-unescape the whole source and then decode it a second time.

Extract the existing cell DOM renderer into `widgets/tableCell.ts` and keep any existing `table.ts` export as a compatibility re-export. Thread `"gfm-table"` and `editorReferenceContext(state).resolveReference` from `blocks.ts` through TableWidget into every cell parse. Include the reference snapshot dependency in widget equality; `updateDOM` must re-render reference-dependent cells when that dependency changes, even when cell source is unchanged. The definition-change invalidation from Task 1 must reach these visible widgets. Keep `table.ts` and `blocks.ts` within their non-growth caps.

Make DOM/sync/rich CellNode switches exhaustive for title, subscript and superscript as well as existing kinds. Both exporters obtain one `snapshotReferenceContext(state)` per export and pass it into cells. Reuse existing KaTeX/image resolver functions; do not parse the original `TableCell` a second way. Importer table serialization in Plan 02 must round-trip through this same `"gfm-table"` contract, including code spans.

- [x] **Step 4: Run focused and full checks**

```bash
pnpm --filter @omd/engine exec vitest run test/tableCellProjection.test.ts test/export.test.ts test/export-rich.test.ts test/tables.test.ts
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
pnpm check:quality
git diff --check
```

- [x] **Step 5: Commit the table-cell convergence**

```bash
git add packages/engine/src/parse/cell.ts packages/engine/src/export/html.ts packages/engine/src/tables/model.ts packages/engine/src/decorations/widgets/tableCell.ts packages/engine/src/decorations/widgets/table.ts packages/engine/src/decorations/blocks.ts packages/engine/src/decorations/build.ts packages/engine/test/tableCellProjection.test.ts packages/engine/test/export.test.ts packages/engine/test/export-rich.test.ts packages/engine/test/tables.test.ts
git commit -m "fix: share table cell model with rich export"
```

### Task 4: Baseline documentation and browser smoke

**Files:**
- Modify: `packages/engine/AGENTS.md`
- Modify: `docs/memory/known-gotchas.md`
- Modify: `docs/memory/gotchas-engine.md`
- Modify: `docs/manual-qa.md`
- Create: `apps/desktop/e2e/paste-projection.spec.ts`

**Interfaces:**
- Documents `semantic/` as local fact accessors and reasserts `parse/cell.ts` as the only cell parser.

- [x] **Step 1: Add the browser smoke**

Mount a document containing an escaped underscore, both HardBreak forms, and a table with a code-span pipe plus titled reference links/images. Assert rendered text contains no syntax backslash, code keeps the literal pipe, titles/destinations refresh after editing an external definition, line breaks remain visible, and toggling Source/Live twice leaves `view.state.doc.toString()` byte-identical apart from the deliberate edit.

- [x] **Step 2: Run the focused browser test**

```bash
PW_PORT=9481 pnpm --filter @omd/desktop test:e2e -- e2e/paste-projection.spec.ts
```

- [x] **Step 3: Record the reusable projection traps and manual matrix**

Add exact manual cases for inline/reference/autolink destination/title/label, Image alt, `access\_token`, backslash HardBreak, two-space HardBreak, table `\|`, table `<br>`, and PDF/PNG export parity. Record that rich table export must consume `parseCell`, never raw `TableCell` children.

- [x] **Step 4: Run the baseline gate**

```bash
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
PW_PORT=9481 pnpm --filter @omd/desktop test:e2e -- e2e/paste-projection.spec.ts
pnpm check:quality
git diff --check
```

- [x] **Step 5: Commit documentation and smoke coverage**

```bash
git add packages/engine/AGENTS.md docs/memory/known-gotchas.md docs/memory/gotchas-engine.md docs/manual-qa.md apps/desktop/e2e/paste-projection.spec.ts
git commit -m "test: guard shared markdown projections"
```
