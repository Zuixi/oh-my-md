# Smart Paste Complex Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve rowspan/colspan tables as deterministic, safe HTML with a complete source-first block-widget and export contract.

**Architecture:** Serialize only the closed complex-table model into canonical Type 6 HTML without blank physical lines. Persisted HTML is reparsed into a typed model from one complete `HTMLBlock`; the widget and exporters render that model through DOM APIs/escaped strings. Invalid, split, unknown, or dangerous HTML fails closed to source with no sibling-node stitching.

**Tech Stack:** TypeScript, DOMParser, Lezer Markdown HTMLBlock, CodeMirror 6 BlockWidget, Vitest, Playwright, desktop CSS.

**Spec:** `docs/superpowers/specs/2026-10-30-smart-paste-semantic-import-design.md`

## Global Constraints

- Complex table is additive; the common Smart Paste cutover does not depend on this plan.
- No blank physical line may occur inside canonical `<table>…</table>` source.
- Never stitch multiple `HTMLBlock`/Paragraph siblings into one logical table.
- Only table structure and a fixed inline subset are accepted; no arbitrary tag, style, class, id, `data-*`, event, script, media, or iframe.
- Rendering uses typed nodes and DOM APIs/escaped output, never raw clipboard/source `innerHTML`.
- Complex table never enters Markdown TableWidget edit/toolbar/range-edit protocols.
- Every block-widget infrastructure gate is mandatory.
- Keep the typed parser, serializer, and widget in separate focused modules. `decorations/blocks.ts` receives only thin dispatch, and the existing large Markdown-table widget is not extended with complex-table logic.

## File Map

- Create `packages/engine/src/parse/complexTable.ts`: typed model plus fail-closed persisted-source parser.
- Create `packages/engine/src/paste/serializeComplexTable.ts`: Paste AST → canonical HTML.
- Create `packages/engine/src/decorations/widgets/complexTable.ts`: read-only rendered block with source entry.
- Modify block-decoration, selection, navigation, height, export, and CSS layers explicitly.

---

### Task 1: Closed model, parser, and canonical serializer

**Files:**
- Create: `packages/engine/src/parse/complexTable.ts`
- Create: `packages/engine/src/paste/serializeComplexTable.ts`
- Modify: `packages/engine/src/paste/serialize.ts`
- Create: `packages/engine/test/complexTableParse.test.ts`
- Create: `packages/engine/test/complexTableSerialize.test.ts`
- Test: `packages/engine/test/pasteSerialize.test.ts`

**Interfaces:**
- Produces:

```ts
export type ComplexTableInline =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "strong" | "emphasis" | "strike" | "underline" | "highlight" | "kbd"; readonly children: readonly ComplexTableInline[] }
  | { readonly type: "subscript" | "superscript"; readonly children: readonly ComplexTableInline[] }
  | { readonly type: "code"; readonly value: string }
  | { readonly type: "link"; readonly href: string; readonly title: string | null; readonly children: readonly ComplexTableInline[] }
  | { readonly type: "image"; readonly src: string; readonly alt: string; readonly title: string | null }
  | { readonly type: "break" }

export interface ComplexTableCell {
  readonly header: boolean
  readonly rowSpan: number
  readonly colSpan: number
  readonly scope: "row" | "col" | null
  readonly align: "left" | "center" | "right" | null
  readonly children: readonly ComplexTableInline[]
}

export interface ComplexTableModel {
  readonly rows: readonly (readonly ComplexTableCell[])[]
}

export function parseComplexTableBlock(source: string): ComplexTableModel | null
export function serializeComplexTable(table: PasteTable): string
```

- [ ] **Step 1: Add failing canonical round-trip tests**

Use a table with header cells, `rowspan=2`, `colspan=2`, underline, kbd, inline code, titled link, image alt/title, and `<br>`. Assert:

- serialization is deterministic and contains no `\n\s*\n`;
- the base Markdown parser returns exactly one `HTMLBlock`;
- `parseComplexTableBlock(serializeComplexTable(model))` returns the expected typed model;
- output contains no `style=`, `class=`, `id=`, `data-`, or event attributes.

- [ ] **Step 2: Add failing rejection tests**

Assert `null` for blank-line-split tables, missing close tag, extra root siblings, invalid/huge spans, overlapping grid occupancy, unknown tags, script/style/svg/form/media, unsafe URLs, unknown attributes, nested table, and text outside the table root.

- [ ] **Step 3: Run tests and verify RED**

```bash
pnpm --filter @omd/engine exec vitest run test/complexTableParse.test.ts test/complexTableSerialize.test.ts
```

- [ ] **Step 4: Implement typed parse and canonical output**

Use detached DOM parsing only to read source. Rebuild a fresh typed model, cap spans with named constants, validate the occupied cell grid, normalize allowed enum attributes, and apply `paste/urlPolicy.ts`. Unsupported cell blocks flatten to text/breaks during Paste AST normalization; persisted unknown HTML fails closed.

Emit one tag line per structural element with no empty line. Escape text/attributes; emit only the fixed inline tags. After this plan lands, update `serialize.ts` so `requiresComplexHtml` tables use this serializer instead of the temporary visible-text downgrade; cell blocks outside the closed inline subset flatten deterministically to visible text and `<br>`.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter @omd/engine exec vitest run test/complexTableParse.test.ts test/complexTableSerialize.test.ts test/pasteSerialize.test.ts
pnpm test
git diff --check
git add packages/engine/src/parse/complexTable.ts packages/engine/src/paste/serializeComplexTable.ts packages/engine/src/paste/serialize.ts packages/engine/test/complexTableParse.test.ts packages/engine/test/complexTableSerialize.test.ts packages/engine/test/pasteSerialize.test.ts
git commit -m "feat: serialize closed complex tables"
```

### Task 2: Complete BlockWidget integration

**Files:**
- Create: `packages/engine/src/decorations/widgets/complexTable.ts`
- Modify: `packages/engine/src/decorations/blocks.ts`
- Modify: `packages/engine/src/decorations/build.ts`
- Modify: `packages/engine/src/decorations/widgetHeights.ts`
- Modify: `packages/engine/src/navigation/blockEntry.ts`
- Modify: `apps/desktop/src/styles.css`
- Create: `packages/engine/test/complexTableWidget.test.ts`
- Test: `packages/engine/test/widgetHeights.test.ts`
- Test: `packages/engine/test/navigation.test.ts`
- Test: `packages/engine/test/view.test.ts`
- Test: `packages/engine/test/specIdentity.test.ts`

**Interfaces:**
- Produces `ComplexTableWidget extends BlockWidget` and:

```ts
export function estimateComplexTableHeightPx(table: ComplexTableModel): number
```

- [ ] **Step 1: Add the block-infrastructure gate tests**

Assert a valid single `HTMLBlock` emits `widget:block:complex-table`; caret at either boundary shows source; moving out mounts the widget; ArrowUp/Down enters the first/last source position; a full selection keeps the widget and adds `omd-block-covered`; two identical tables keep distinct ranges; invalid/split HTML emits no widget. Assert the source-entry control is keyboard-focusable with an accessible name, `th` keeps the validated `scope`, images expose the shared alt, and hidden source plus projected table are not both exposed to assistive technology.

Extend `widgetHeights.test.ts` so its “every mounted block widget” list includes complex table and a 20-row/wrapped-cell case has a materially larger estimate than a 2-row table.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @omd/engine exec vitest run test/complexTableWidget.test.ts test/widgetHeights.test.ts test/navigation.test.ts test/view.test.ts test/specIdentity.test.ts
```

- [ ] **Step 3: Implement the widget and all five registrations**

In `blocks.ts`, handle `HTMLBlock` only when `parseComplexTableBlock` succeeds. Construct table elements/cells with DOM APIs and `textContent`; apply rowSpan/colSpan/scope/align properties from enums/validated integers.

Register `HTMLBlock` selection rebuilding only for the complex-table branch (refactor the current set to a predicate/registry if adding every generic HTMLBlock would broaden work), add content-aware height estimation, add `blockEntryPosition`, retain generic covered-overlay registration, and inherit the existing render budget/click-to-source/embed lifecycle.

- [ ] **Step 4: Add desktop CSS and run cross-layer checks**

Style `.omd-complex-table` with theme variables and the same typography/overflow principles as `.omd-table`; do not expose the Markdown table toolbar or direct-edit affordances.

```bash
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
git diff --check
```

- [ ] **Step 5: Commit the widget unit**

```bash
git add packages/engine/src/decorations/widgets/complexTable.ts packages/engine/src/decorations/blocks.ts packages/engine/src/decorations/build.ts packages/engine/src/decorations/widgetHeights.ts packages/engine/src/navigation/blockEntry.ts apps/desktop/src/styles.css packages/engine/test/complexTableWidget.test.ts packages/engine/test/widgetHeights.test.ts packages/engine/test/navigation.test.ts packages/engine/test/view.test.ts packages/engine/test/specIdentity.test.ts
git commit -m "feat: render complex table blocks safely"
```

### Task 3: Export and browser interaction parity

**Files:**
- Modify: `packages/engine/src/export/html.ts`
- Test: `packages/engine/test/export.test.ts`
- Test: `packages/engine/test/export-rich.test.ts`
- Create: `apps/desktop/e2e/complex-table.spec.ts`

**Interfaces:**
- Both exporters consume `ComplexTableModel`; neither passes the source HTML through.

- [ ] **Step 1: Add failing exporter tests**

Assert sync/rich export preserve table structure, spans, scope, align, inline semantics, links, images, alt, and breaks. Assert dangerous source that fails typed parsing is HTML-escaped/visible rather than active. Assert source bytes are unchanged after both exports.

- [ ] **Step 2: Implement exhaustive typed exporters**

Create escaped HTML from the typed model. Rich export may resolve local image sources but cannot add a second table parser or trust raw attributes.

- [ ] **Step 3: Add real-browser interaction E2E**

Assert initial render, click/keyboard source entry, accessible name/header scope/image alt, ArrowUp/Down entry, Cmd/Ctrl+A covered overlay, readOnly behavior, horizontal overflow, dark mode, same-content double instance identity, and source fallback after inserting a blank line inside the table.

- [ ] **Step 4: Run focused/full checks and commit**

```bash
pnpm --filter @omd/engine exec vitest run test/export.test.ts test/export-rich.test.ts
PW_PORT=9483 pnpm --filter @omd/desktop test:e2e -- e2e/complex-table.spec.ts
pnpm test
pnpm --filter @omd/desktop build
git diff --check
git add packages/engine/src/export/html.ts packages/engine/test/export.test.ts packages/engine/test/export-rich.test.ts apps/desktop/e2e/complex-table.spec.ts
git commit -m "feat: export and navigate complex tables"
```

### Task 4: Complex-table documentation and release gate

**Files:**
- Modify: `packages/engine/AGENTS.md`
- Modify: `docs/memory/known-gotchas.md`
- Modify: `docs/memory/gotchas-engine.md`
- Modify: `docs/manual-qa.md`

**Interfaces:**
- Documents canonical Type 6/no-blank-line ownership and the complete block-widget checklist.

- [ ] **Step 1: Record permanent constraints**

Add the verified CommonMark/Lezer split behavior, no sibling stitching, fixed allowlist, source fallback, no Markdown table toolbar, and all five block-widget registrations.

- [ ] **Step 2: Add manual QA**

Cover Word/Sheets merged tables, nested formatting, links/images, blank-line edit fallback, Source/Live byte stability, PDF/PNG/HTML export, keyboard entry, select-all overlay, dark mode, and malformed/XSS samples.

- [ ] **Step 3: Run the complex-table release gate**

```bash
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
PW_PORT=9483 pnpm --filter @omd/desktop test:e2e -- e2e/complex-table.spec.ts
pnpm --filter @omd/engine bench
git diff --check
```

- [ ] **Step 4: Commit documentation**

```bash
git add packages/engine/AGENTS.md docs/memory/known-gotchas.md docs/memory/gotchas-engine.md docs/manual-qa.md
git commit -m "docs: record complex table invariants"
```
