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
- Modify `packages/engine/src/links.ts`: share reference-destination lookup with images without changing the public `linkHref` contract.
- Modify `packages/engine/src/decorations/inline.ts`: consume Image/Escape/HardBreak accessors.
- Modify `packages/engine/src/parse/cell.ts`: consume the same accessors.
- Modify `packages/engine/src/export/html.ts`: use shared Image and cell models in both exporters.

---

### Task 1: Shared Link and Image semantics

**Files:**
- Create: `packages/engine/src/semantic/inlineText.ts`
- Create: `packages/engine/src/semantic/link.ts`
- Create: `packages/engine/src/semantic/image.ts`
- Modify: `packages/engine/src/links.ts`
- Modify: `packages/engine/src/decorations/inline.ts`
- Modify: `packages/engine/src/parse/cell.ts`
- Modify: `packages/engine/src/export/html.ts`
- Create: `packages/engine/test/semanticImage.test.ts`
- Create: `packages/engine/test/semanticLink.test.ts`
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
export function stringReferenceContext(source: string): MarkdownReferenceContext
```

- `linkParts` supports inline/reference links and autolinks, preserves optional title, normalizes autolink display/destination, and never scans outside its supplied snapshot.
- `imageParts` supports inline and reference images, decodes Entity/Escape in alt, removes formatting markers from alt, and uses the same normalized-label lookup. Whole-document callers use `editorReferenceContext(state)`; `parseCell` accepts that resolver so a table-cell reference can resolve a definition elsewhere in the same Markdown document. Standalone cell tests use `stringReferenceContext(source)` and remain bounded to their fragment.
- `linkHref(state, node)` remains source-compatible as a thin wrapper around `linkParts`; Preview, both exporters, and cell parsing stop carrying independent destination/title/autolink logic.

- [ ] **Step 1: Add failing accessor and exporter tests**

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

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
pnpm --filter @omd/engine exec vitest run test/semanticLink.test.ts test/semanticImage.test.ts test/export.test.ts test/export-rich.test.ts test/tables.test.ts
```

Expected: both exporters currently emit `alt=""`; Preview/cell parsing does not share one accessor.

- [ ] **Step 3: Implement visible-text and Image accessors**

Traverse only the bounded Link/Image label range. Skip syntax marks, recursively read semantic children, decode `Entity` with `decodeHtmlEntity`, and decode `Escape` by omitting its leading backslash. Resolve reference destinations/titles through one normalized-label lookup shared by links and images.

Replace the two `head.indexOf("](")` implementations and both exporter `alt=""` branches with `imageParts`. Replace exporter/cell autolink and link-title extraction branches with `linkParts` while keeping the existing public `linkHref` wrapper.

- [ ] **Step 4: Run focused and full engine tests**

```bash
pnpm --filter @omd/engine exec vitest run test/semanticLink.test.ts test/semanticImage.test.ts test/export.test.ts test/export-rich.test.ts test/tables.test.ts
pnpm test
```

- [ ] **Step 5: Commit the Image semantic unit**

```bash
git add packages/engine/src/semantic/inlineText.ts packages/engine/src/semantic/link.ts packages/engine/src/semantic/image.ts packages/engine/src/links.ts packages/engine/src/decorations/inline.ts packages/engine/src/parse/cell.ts packages/engine/src/export/html.ts packages/engine/test/semanticLink.test.ts packages/engine/test/semanticImage.test.ts packages/engine/test/export.test.ts packages/engine/test/export-rich.test.ts packages/engine/test/tables.test.ts
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

- [ ] **Step 1: Add failing cross-projection tests**

Use the exact source:

```ts
const source = "access\\_token before\\\nafter before  \nafter"
```

Assert:

- Preview text is `access_token before` + line break + `after before` + line break + `after`, with no visible backslash or trailing marker spaces.
- Both exporters contain `access_token before<br>after before<br>after`.
- `parseCell(String.raw`a \| b`)` produces visible `a | b`.
- An even backslash run before `|` preserves one literal backslash and does not use a string-level global replace.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @omd/engine exec vitest run test/semanticBreaks.test.ts test/view.test.ts test/export.test.ts test/export-rich.test.ts test/tables.test.ts
```

- [ ] **Step 3: Implement accessors and projections**

For `Escape`, hide/render only `[node.from, node.from + 1)` and keep the escaped character. Reveal that marker while a collapsed caret is inside the `Escape` node so users can edit or delete the source byte. For `HardBreak`, keep the newline and hide/render the marker range ending at `node.to - 1`; determine backslash vs spaces through the supplied `MarkdownSlice`, not from a regex over the entire cell. Reveal the marker while the caret is inside the node, and explicitly exclude the line-end replacement from `atomicRanges` so typing a trailing backslash cannot make the caret disappear or push a pointer selection across the newline.

Add explicit `Escape` and `HardBreak` cases to `parse/cell.ts` and both HTML renderers. Do not add them to generic `SKIP` sets, because they have visible semantic output.

- [ ] **Step 4: Run focused, full engine, and desktop build checks**

```bash
pnpm --filter @omd/engine exec vitest run test/semanticBreaks.test.ts test/view.test.ts test/export.test.ts test/export-rich.test.ts test/tables.test.ts
pnpm test
pnpm --filter @omd/desktop build
```

- [ ] **Step 5: Commit the break semantic unit**

```bash
git add packages/engine/src/semantic/breaks.ts packages/engine/src/decorations/inline.ts packages/engine/src/decorations/build.ts packages/engine/src/parse/cell.ts packages/engine/src/export/html.ts packages/engine/test/semanticBreaks.test.ts packages/engine/test/view.test.ts packages/engine/test/export.test.ts packages/engine/test/export-rich.test.ts packages/engine/test/tables.test.ts
git commit -m "fix: project escapes and hard breaks consistently"
```

### Task 3: One table-cell model for both exporters

**Files:**
- Modify: `packages/engine/src/parse/cell.ts`
- Modify: `packages/engine/src/export/html.ts`
- Test: `packages/engine/test/export.test.ts`
- Test: `packages/engine/test/export-rich.test.ts`
- Test: `packages/engine/test/tables.test.ts`

**Interfaces:**
- Keeps `parseCell` as the only cell parser and extends it without breaking current callers:

```ts
export interface CellParseOptions {
  readonly resolveReference?: MarkdownReferenceContext["resolveReference"]
}

export function parseCell(source: string, options?: CellParseOptions): CellNode[]
```

- Produces engine-internal helpers:

```ts
function tableCellNodes(node: SyntaxNode, state: EditorState): CellNode[]
function cellNodesHtml(nodes: readonly CellNode[]): string
async function richCellNodesHtml(
  nodes: readonly CellNode[],
  options: ExportRichHtmlOptions,
): Promise<string>
```

- [ ] **Step 1: Add failing rich-export parity tests**

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

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @omd/engine exec vitest run test/export.test.ts test/export-rich.test.ts test/tables.test.ts
```

Expected: `exportRichHtml` currently calls `richChildren(TableCell)` and bypasses `parseCell`.

- [ ] **Step 3: Route both Table branches through `parseCell`**

Delete the pre-parse `.replace(/\\\|/g, "|")`. Let Lezer produce `Escape`, and let Task 2 decode it in `parseCell`, which preserves odd/even backslash semantics. Build the whole-document reference resolver once per export snapshot and pass it into each cell parse; do not rescan definitions per cell.

Implement `richCellNodesHtml` as an exhaustive `CellNode` switch. Reuse existing KaTeX/image resolver functions; do not parse the original `TableCell` a second way.

- [ ] **Step 4: Run focused and full checks**

```bash
pnpm --filter @omd/engine exec vitest run test/export.test.ts test/export-rich.test.ts test/tables.test.ts
pnpm test
pnpm --filter @omd/desktop build
git diff --check
```

- [ ] **Step 5: Commit the table-cell convergence**

```bash
git add packages/engine/src/parse/cell.ts packages/engine/src/export/html.ts packages/engine/test/export.test.ts packages/engine/test/export-rich.test.ts packages/engine/test/tables.test.ts
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

- [ ] **Step 1: Add the browser smoke**

Mount a document containing an escaped underscore and both HardBreak forms. Assert rendered text contains no syntax backslash, line breaks remain visible, and toggling Source/Live twice leaves `view.state.doc.toString()` byte-identical.

- [ ] **Step 2: Run the focused browser test**

```bash
PW_PORT=9481 pnpm --filter @omd/desktop test:e2e -- e2e/paste-projection.spec.ts
```

- [ ] **Step 3: Record the reusable projection traps and manual matrix**

Add exact manual cases for inline/reference/autolink destination/title/label, Image alt, `access\_token`, backslash HardBreak, two-space HardBreak, table `\|`, table `<br>`, and PDF/PNG export parity. Record that rich table export must consume `parseCell`, never raw `TableCell` children.

- [ ] **Step 4: Run the baseline gate**

```bash
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
PW_PORT=9481 pnpm --filter @omd/desktop test:e2e -- e2e/paste-projection.spec.ts
git diff --check
```

- [ ] **Step 5: Commit documentation and smoke coverage**

```bash
git add packages/engine/AGENTS.md docs/memory/known-gotchas.md docs/memory/gotchas-engine.md docs/manual-qa.md apps/desktop/e2e/paste-projection.spec.ts
git commit -m "test: guard shared markdown projections"
```
