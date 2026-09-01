# Table Editing Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Live Preview table edits source-faithful, Lezer-consistent, keyboard-continuous, and isolated per editor view.

**Architecture:** Extract a table-relative source model from the existing Lezer syntax tree, then have pure edit helpers return minimal CodeMirror changes instead of serialized whole-table strings. Keep the current block widget, but scope pending keyboard focus with a `WeakMap<EditorView, ...>` and prove rebuild behavior with real `EditorView` tests.

**Tech Stack:** TypeScript, CodeMirror 6, Lezer Markdown GFM, Vitest, happy-dom, desktop CSS.

**Spec:** `docs/superpowers/specs/2026-08-31-table-editing-reliability-design.md`

## Global Constraints

- Engine owns all Markdown table semantics; `apps/desktop/src/Editor.ts` remains unchanged.
- Use the existing Lezer GFM tree; do not add a third-party table/grid dependency or a second whole-table parser.
- All table offsets stored in widget data are relative to the `Table` node; dispatch resolves the current absolute start with `livePos()`.
- Preserve every source byte outside the explicit edit ranges.
- Keep block decorations in `livePreviewField`, skip the replaced table subtree, and do not add block widgets to `atomicRanges`.
- Never force a complete syntax parse in production.
- Every mutation path checks `view.state.readOnly` immediately before dispatch.
- Keep the existing `parseCell` preview/export path; this plan does not change the supported cell Markdown subset.
- No drag/reorder, resize, multi-cell selection, context menu, alignment picker, or block-widget replacement.
- Run focused tests after every task and `pnpm test` before completion.

## File Structure

- Create `packages/engine/src/tables/model.ts`: table-relative Lezer extraction and shared table data types.
- Rewrite `packages/engine/src/tables/edit.ts`: pure range-based cell/row/column changes only.
- Modify `packages/engine/src/decorations/blocks.ts`: call `tableDataFromNode()` and pass the model to `TableWidget`.
- Modify `packages/engine/src/decorations/widgets/table.ts`: render `TableCellData`, dispatch minimal changes, and restore focus per view.
- Modify `packages/engine/src/index.ts`: export the new pure interfaces/functions without exposing syntax-tree extraction.
- Add `packages/engine/test/table-model.test.ts`: exact Lezer range and ragged/quoted shape tests.
- Rewrite `packages/engine/test/table-edit.test.ts`: minimal-change and source-fidelity tests.
- Modify `packages/engine/test/tables.test.ts`: widget DOM, toolbar state, and mocked-dispatch tests.
- Modify `packages/engine/test/view.test.ts`: real rebuild/focus/multi-view integration tests.
- Modify `apps/desktop/src/styles.css`: active row/column and disabled/synthetic-cell styling only.
- Update `packages/engine/AGENTS.md`, `docs/memory/known-gotchas.md`, and `docs/manual-qa.md` after behavior is verified.

---

### Task 1: Extract one Lezer-derived table source model

**Files:**
- Create: `packages/engine/src/tables/model.ts`
- Create: `packages/engine/test/table-model.test.ts`
- Modify: `packages/engine/src/decorations/blocks.ts:252-288`
- Modify: `packages/engine/src/decorations/widgets/table.ts:13-20`
- Modify: `packages/engine/test/blockwidgets.test.ts:104-119`

**Interfaces:**
- Consumes: `SyntaxNode`, `EditorState`, and the current Lezer GFM `Table` tree.
- Produces:

```ts
export type TableAlignment = "left" | "center" | "right" | ""

export interface TableCellData {
  readonly text: string
  readonly source: string
  readonly from: number
  readonly to: number
}

export interface TableRowData {
  readonly from: number
  readonly to: number
  readonly lineFrom: number
  readonly lineTo: number
  readonly prefix: string
  readonly leadingPipe: boolean
  readonly trailingPipe: boolean
  readonly cells: readonly (TableCellData | null)[]
}

export interface TableData {
  readonly header: TableRowData
  readonly delimiter: TableRowData
  readonly rows: readonly TableRowData[]
  readonly aligns: readonly TableAlignment[]
}

export function tableDataFromNode(node: SyntaxNode, state: EditorState): TableData | null
```

All ranges are relative to `node.from`. `lineFrom`/`lineTo` include quote/list continuation source inside the table span. Empty source-backed slots must be represented by zero-length `TableCellData`; only a missing ragged tail is `null`.

- [ ] **Step 1: Write failing parser-shape tests**

Create `packages/engine/test/table-model.test.ts` with a helper that obtains the first `Table` node from `syntaxTree(makeState(doc))`, calls `tableDataFromNode`, and asserts these exact cases:

```ts
const regular = `| A | B |
| --- | ---: |
| 1 | 2 |`
expect(data.header.cells.map(cell => cell && [cell.source, cell.from, cell.to])).toEqual([
  ["A", 2, 3],
  ["B", 6, 7],
])
expect(data.rows[0].cells.map(cell => cell?.source)).toEqual(["1", "2"])
expect(data.aligns).toEqual(["", "right"])

const noOuterPipes = `A | B
--- | ---
1 | 2`
expect(data.header.leadingPipe).toBe(false)
expect(data.header.trailingPipe).toBe(false)
expect(data.header.cells.map(cell => cell?.source)).toEqual(["A", "B"])

const escapedAndRagged = `| a\\|b | c |
| --- | --- |
| 1 | |
| only |`
expect(data.header.cells[0]?.source).toBe("a\\|b")
expect(data.header.cells[0]?.text).toBe("a|b")
expect(data.rows[0].cells).toHaveLength(2)
expect(data.rows[0].cells[1]).toMatchObject({ source: "", text: "" })
expect(data.rows[1].cells).toEqual([
  expect.objectContaining({ source: "only", text: "only" }),
  null,
])

const quoted = `> | A | B |
> | --- | --- |
> | 1 | 2 |`
expect(data.rows[0].prefix).toBe("> ")
expect(quoted.slice(tableFrom + data.rows[0].lineFrom, tableFrom + data.rows[0].from)).toBe("> ")
```

Also assert delimiter cell ranges map to `---`/`---:` rather than the full separator line.

- [ ] **Step 2: Run the model test to verify it fails**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/table-model.test.ts
```

Expected: FAIL because `tables/model.ts` and `tableDataFromNode` do not exist.

- [ ] **Step 3: Implement the minimal model extractor**

In `packages/engine/src/tables/model.ts`:

- Walk only direct `TableHeader`, separator `TableDelimiter`, and `TableRow` children.
- For header/data rows, collect direct `TableCell` children and direct pipe `TableDelimiter` children.
- Use delimiter positions plus the row boundary to distinguish a zero-length empty slot from a missing ragged tail.
- Read `source` directly from the `TableCell` range; derive `text` with the existing `source.replace(/\\\|/g, "|").trim()` behavior.
- Derive row `prefix`, `lineFrom`, and `lineTo` from `state.doc.lineAt(row.from)`, clamped to the `Table` range.
- Derive alignment marker slots from the separator node and map `:---:`, `---:`, and `:---` to the existing union.
- Pad each row's `cells` to `header.cells.length` with `null`; never reject a ragged data row.
- Return `null` only if there is no header, no separator, or zero header columns.

Remove `directCells()` and `tableData()` from `blocks.ts`; import and call `tableDataFromNode(node.node, state)` instead. Move `TableAlignment`/`TableData` imports in `table.ts` and tests to `tables/model.ts`.

- [ ] **Step 4: Run focused model and decoration tests**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/table-model.test.ts test/tables.test.ts test/blockwidgets.test.ts test/view.test.ts
```

Expected: PASS; the existing ragged rendering test still renders four body cells and no `EditorView.exceptionSink` errors.

- [ ] **Step 5: Commit the model boundary**

```bash
git add packages/engine/src/tables/model.ts packages/engine/src/decorations/blocks.ts packages/engine/src/decorations/widgets/table.ts packages/engine/test/table-model.test.ts packages/engine/test/blockwidgets.test.ts
git commit -m "refactor: derive table editing data from lezer"
```

---

### Task 2: Replace cell commits with exact range changes

**Files:**
- Modify: `packages/engine/src/tables/edit.ts`
- Modify: `packages/engine/src/decorations/widgets/table.ts:216-327`
- Modify: `packages/engine/src/index.ts:63-71`
- Rewrite: `packages/engine/test/table-edit.test.ts`
- Modify: `packages/engine/test/tables.test.ts:121-253`

**Interfaces:**
- Consumes: `TableCellData` from Task 1 and the table source captured by the widget.
- Produces:

```ts
export interface TableSourceChange {
  readonly from: number
  readonly to: number
  readonly insert: string
}

export function escapeTableCellValue(value: string): string

export function replaceTableCell(
  source: string,
  cell: TableCellData,
  value: string,
): TableSourceChange | null
```

`replaceTableCell` returns a table-relative change. It validates `0 <= from <= to <= source.length` and `source.slice(from, to) === cell.source`; stale metadata returns `null`. `escapeTableCellValue` converts every pipe not already preceded by an odd number of backslashes to `\|`.

- [ ] **Step 1: Rewrite cell-edit tests for minimal changes**

Replace the cell-replacement cases in `table-edit.test.ts` with direct range fixtures:

```ts
const source = `| A | B |
| --- | ---: |
| 1 | 2 |`
const cell: TableCellData = { text: "2", source: "2", from: 31, to: 32 }

expect(replaceTableCell(source, cell, "x")).toEqual({ from: 31, to: 32, insert: "x" })
expect(replaceTableCell(source, cell, "a|b")).toEqual({ from: 31, to: 32, insert: "a\\|b" })
expect(replaceTableCell(source, cell, "a\\|b")).toEqual({ from: 31, to: 32, insert: "a\\|b" })
expect(replaceTableCell(source, { ...cell, source: "stale" }, "x")).toBeNull()
expect(replaceTableCell(source, { ...cell, from: -1 }, "x")).toBeNull()
```

Add an empty-cell case using `{ source: "", from: n, to: n }`; applying the returned change must fill only that slot. Add a ragged-table case obtained from `tableDataFromNode`: replacing the existing `only` cell must succeed even though the second visual cell is `null`.

- [ ] **Step 2: Run the edit tests to verify they fail**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/table-edit.test.ts
```

Expected: FAIL because the current function accepts row/column indexes and returns a whole string.

- [ ] **Step 3: Implement exact cell changes and widget dispatch**

In `tables/edit.ts`, remove the current `replaceTableCell` implementation and add `TableSourceChange`, `escapeTableCellValue`, range validation, stale-slice validation, and the exact returned change. Leave the four structural functions temporarily in the file for Task 4.

In `TableWidget`:

- Render `cell.text` and make `cellSource()` return `cell?.source`.
- Do not call `startEdit` for a `null` synthetic cell.
- Replace `replace(next: string, ...)` with a dispatcher that accepts `readonly TableSourceChange[]`, translates each range by `livePos()`, and sends one transaction.
- Make `commitEdit()` call `replaceTableCell(this.src, cell, input.value)`.
- Delete the post-dispatch `this.startEdit(this.cells[...])` call; the old DOM may already be detached.
- Keep the read-only guard at the dispatch funnel.

Update the widget test to assert the first commit dispatch is the cell range, not `{ from: tableStart, to: tableStart + src.length }`:

```ts
expect(dispatches[0]).toMatchObject({ from: tableStart + cell.from, to: tableStart + cell.to, insert: "x" })
```

- [ ] **Step 4: Run focused transform and widget tests**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/table-edit.test.ts test/tables.test.ts test/readonly-guards.test.ts
```

Expected: PASS; Enter commits a cell without replacing unrelated table bytes, moved-widget positioning still uses `posAtDOM`, and read-only tests remain green.

- [ ] **Step 5: Commit exact cell writes**

```bash
git add packages/engine/src/tables/edit.ts packages/engine/src/decorations/widgets/table.ts packages/engine/src/index.ts packages/engine/test/table-edit.test.ts packages/engine/test/tables.test.ts
git commit -m "fix: update only the edited table cell"
```

---

### Task 3: Scope keyboard continuation to each EditorView

**Files:**
- Modify: `packages/engine/src/decorations/widgets/table.ts:10-12,205-215,270-327`
- Modify: `packages/engine/test/tables.test.ts`
- Modify: `packages/engine/test/view.test.ts`

**Interfaces:**
- Consumes: Task 2's exact cell changes.
- Produces module-private state:

```ts
interface PendingTableEdit {
  readonly pos: number
  readonly row: number
  readonly col: number
}

const pendingTableEdits = new WeakMap<EditorView, PendingTableEdit>()
```

- [ ] **Step 1: Add failing real-view keyboard tests**

In `view.test.ts`, add a helper that waits for `.omd-table` and dispatches a cell `mousedown`. Add tests that:

1. Open the first body cell, type `x`, press Tab, wait for rebuild, then assert the document changed and the only `input.omd-table-edit` is in the next body cell.
2. Press Shift-Tab from that cell and assert focus returns to the previous body cell after rebuild.
3. Insert `"prefix\n\n"` before the table, repeat Tab, and assert focus restoration still matches the table's live position.
4. Create two views, start Tab continuation in the first, cause the second to rebuild, and assert the second never opens an input.
5. Assert both views' `errors.map(String)` stay empty and destroy both views in `finally`/test cleanup.

- [ ] **Step 2: Run the real-view cases to verify they fail**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/view.test.ts -t "table cell keyboard"
```

Expected: at least the multiple-view isolation case fails with the module-global `resumeEdit`, or the real rebuild loses focus because the old widget attempts to edit detached DOM.

- [ ] **Step 3: Implement per-view pending focus**

Replace `resumeEdit` with `pendingTableEdits`.

Before dispatch:

```ts
if (dest) pendingTableEdits.set(this.view, { pos: from, ...dest })
```

In `renderInto()`:

```ts
const pending = this.view && pendingTableEdits.get(this.view)
if (pending && pending.pos === this.livePos()) {
  pendingTableEdits.delete(this.view!)
  const cell = this.cells[pending.row]?.[pending.col]
  if (cell) queueMicrotask(() => {
    if (cell.isConnected) this.startEdit(cell, pending.row, pending.col)
  })
}
```

Consume/delete before scheduling. If the table position does not match, leave the entry for the correct table in the same synchronous rebuild pass; clear it when a dispatch fails or when the destination cell does not exist. Do not compare against captured constructor `this.pos`.

- [ ] **Step 4: Run widget and real-view tests**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/tables.test.ts test/view.test.ts
```

Expected: PASS; Tab/Shift-Tab focus survives rebuild, prefix insertion is safe, views are isolated, and exception sinks are empty.

- [ ] **Step 5: Commit isolated keyboard continuation**

```bash
git add packages/engine/src/decorations/widgets/table.ts packages/engine/test/tables.test.ts packages/engine/test/view.test.ts
git commit -m "fix: isolate table edit focus per editor"
```

---

### Task 4: Convert row and column operations to Lezer-derived changes

**Files:**
- Modify: `packages/engine/src/tables/edit.ts`
- Modify: `packages/engine/src/decorations/widgets/table.ts`
- Modify: `packages/engine/src/index.ts`
- Modify: `packages/engine/test/table-edit.test.ts`
- Modify: `packages/engine/test/tables.test.ts`

**Interfaces:**
- Consumes: `TableData`, `TableRowData`, and `TableSourceChange` from Tasks 1-2.
- Produces:

```ts
export function insertTableRow(
  source: string,
  table: TableData,
  afterRow: number,
): readonly TableSourceChange[] | null

export function deleteTableRow(
  source: string,
  table: TableData,
  row: number,
): readonly TableSourceChange[] | null

export function insertTableColumn(
  source: string,
  table: TableData,
  afterColumn: number,
): readonly TableSourceChange[] | null

export function deleteTableColumn(
  source: string,
  table: TableData,
  column: number,
): readonly TableSourceChange[] | null
```

Rows use `row.lineFrom/lineTo/prefix`; columns return sorted, non-overlapping changes for header, separator, and each data row. At least one data row and one column remain.

- [ ] **Step 1: Add failing structural source-fidelity tests**

Extend `table-edit.test.ts` with an `applyChanges(source, changes)` test helper that sorts descending by `from` before applying. Assert:

- Inserting a row after row 1 preserves all existing lines byte-for-byte and appends a row matching the header's outer-pipe style.
- Deleting one of two data rows removes exactly that row plus one newline; deleting the last data row returns `null`.
- Inserting a column into `A | B` style does not add outer pipes to untouched rows.
- Inserting a column into a quoted table emits `> ` on every inserted/replaced row.
- Deleting a column preserves alignment markers in the remaining separator cells.
- A ragged row gains a valid slot when inserting at/after its missing tail; deleting a missing ragged-tail column does not throw.
- Every function returns `null` when a referenced row/cell slice is stale or indexes are out of range.
- `changes` are pairwise non-overlapping.

- [ ] **Step 2: Run structural tests to verify they fail**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/table-edit.test.ts
```

Expected: FAIL because current structural functions parse/serialize the whole table and use the old signatures.

- [ ] **Step 3: Implement row range changes**

Implement `insertTableRow` and `deleteTableRow` first:

- Build a blank row with the selected neighboring row's `prefix`, `leadingPipe`, and `trailingPipe`, and one blank slot per header column.
- Insert after the requested data row, or immediately after the separator for `afterRow === 0`.
- Own exactly one adjacent newline in the insertion/deletion range so the next block is never glued to the table.
- Validate the current source slices against model metadata before returning changes.

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/table-edit.test.ts -t "row"
```

Expected: PASS for all row insertion/deletion cases.

- [ ] **Step 4: Implement column range changes**

For each row, use its delimiter/cell metadata to create the smallest replacement around the target boundary:

- Header/data insertion adds ` |  ` or `  | ` according to outer-pipe position without rewriting unrelated cells.
- Separator insertion adds ` | --- ` with the same local spacing convention as the neighboring marker.
- Ragged rows create enough delimiters/blank slots to reach the requested insertion point.
- Deletion removes the target cell plus one adjacent delimiter, choosing the right delimiter except for the final column, which uses the left delimiter.
- Missing ragged-tail cells yield no data-cell change, but separator/header changes still occur.
- Return changes sorted ascending; CodeMirror accepts one transaction with multiple ranges.

Delete `Line`, `Table`, `splitCells`, `parseLine`, `parseTable`, `serialize`, and the old whole-source signatures after all five operations use model ranges.

- [ ] **Step 5: Update toolbar dispatch and focused widget tests**

In `TableWidget.tool()`:

- Commit an open cell by adding its exact cell change to the transaction.
- Call the structural helper with `this.src` and `this.table`.
- If either change set is `null`, keep the current input mounted and do not dispatch.
- Merge and dispatch once when the cell change and structural changes are pairwise non-overlapping (row/column insertion normally follows this path).
- For delete-current-row/delete-current-column, the structural range can overlap the active cell. Add a per-view `pendingTableTools: WeakMap<EditorView, { pos: number; act: TableToolAction }>`: dispatch the exact cell commit first, then let the rebuilt widget consume the pending action in a microtask and dispatch the structural delete against fresh Lezer metadata. One click still completes both operations; no stale model is reparsed inside the widget. Add a real-view test that the two transactions preserve the edited value in remaining source and do not leak the pending action to another view.

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/table-edit.test.ts test/tables.test.ts test/view.test.ts
```

Expected: PASS; toolbar actions preserve untouched source and ragged tables no longer silently reject supported operations.

- [ ] **Step 6: Commit range-based structural edits**

```bash
git add packages/engine/src/tables/edit.ts packages/engine/src/decorations/widgets/table.ts packages/engine/src/index.ts packages/engine/test/table-edit.test.ts packages/engine/test/tables.test.ts
git commit -m "fix: preserve table source during row and column edits"
```

---

### Task 5: Complete the keyboard flow and expose valid toolbar state

**Files:**
- Modify: `packages/engine/src/decorations/widgets/table.ts`
- Modify: `packages/engine/test/tables.test.ts`
- Modify: `packages/engine/test/view.test.ts`
- Modify: `apps/desktop/src/styles.css:258-327`
- Modify: `apps/desktop/test/blockWidgetLayout.test.ts` if it snapshots/guards the touched CSS selectors

**Interfaces:**
- Consumes: exact cell/row changes and per-view continuation.
- Produces no new public API. DOM contracts:
  - active row cells: `.omd-table-row-active`
  - active column cells: `.omd-table-col-active`
  - synthetic missing cells: `.omd-table-cell-missing[aria-disabled="true"]`
  - unavailable toolbar buttons use native `disabled`.

- [ ] **Step 1: Add failing behavior tests**

Add widget and real-view tests for:

```ts
// final-cell Tab
// document gains one blank row and rebuilt input is first cell of that row

// first-cell Shift-Tab
// current value commits; no input opens outside the table

// disabled actions
expect(deleteRow.disabled).toBe(true) // one data row
expect(deleteCol.disabled).toBe(true) // one column

// active target classes
expect(activeCell.classList).toContain("omd-table-row-active")
expect(columnPeers.every(cell => cell.classList.contains("omd-table-col-active"))).toBe(true)

// missing ragged tail
expect(missingCell).toHaveAttribute("aria-disabled", "true")
expect(missingCell.querySelector("input")).toBeNull()
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/tables.test.ts test/view.test.ts -t "table"
```

Expected: FAIL for final-cell Tab, disabled controls, active classes, and synthetic-cell behavior.

- [ ] **Step 3: Implement final-cell Tab and boundary behavior**

In `commitEdit()`:

- If `move === 1` and `neighbor()` returns `null`, combine the exact cell commit with `insertTableRow(..., lastRow)` only when the key was Tab; set pending focus to `{ row: oldRowCount + 1, col: 0 }`.
- Enter in the final cell commits without inserting a row.
- Shift-Tab in the first cell commits without a destination.
- Pass the triggering key intent explicitly; do not infer final-cell insertion from `move` alone.

- [ ] **Step 4: Implement active/disabled/synthetic DOM state**

- During `startEdit`, apply row/column classes to the current `cells` matrix; clear them in `cancelEdit` and before dispatch.
- Render `null` cells with `.omd-table-cell-missing`, `aria-disabled="true"`, and `title="Missing source cell; add a column or edit Markdown source"`.
- Disable delete-row when `table.rows.length <= 1`, delete-column when `table.header.cells.length <= 1`, and all toolbar buttons when read-only.
- Add CSS that changes only background/color/opacity; do not change padding, borders, width, or line-height and therefore do not cause layout jumps.

- [ ] **Step 5: Run engine and desktop CSS guards**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/tables.test.ts test/view.test.ts test/readonly-guards.test.ts
pnpm --filter @omd/desktop test
```

Expected: PASS; disabled controls are inert, active styling classes are stable, and no block layout guard regresses.

- [ ] **Step 6: Commit the completed interaction baseline**

```bash
git add packages/engine/src/decorations/widgets/table.ts packages/engine/test/tables.test.ts packages/engine/test/view.test.ts apps/desktop/src/styles.css apps/desktop/test/blockWidgetLayout.test.ts
git commit -m "feat: complete keyboard table editing flow"
```

---

### Task 6: Lock in documentation and full verification

**Files:**
- Modify: `packages/engine/AGENTS.md`
- Modify: `docs/memory/known-gotchas.md`
- Modify: `docs/manual-qa.md`

**Interfaces:**
- Consumes: verified behavior from Tasks 1-5.
- Produces: durable ownership, regression, and manual QA guidance.

- [ ] **Step 1: Update engine invariants**

In `packages/engine/AGENTS.md`:

- Replace the public whole-table-transform wording with the range-change signatures.
- State that `tables/model.ts` owns Lezer-derived table ranges and `blocks.ts` must not reduce editable tables to display-only strings.
- State that widget continuation is per `EditorView`, table-relative offsets become live absolute offsets only at dispatch, and cell edits preserve source outside their exact range.

- [ ] **Step 2: Record reusable traps**

In `docs/memory/known-gotchas.md`, add one concise table-editing entry:

- A render parser and stricter edit parser made ragged tables visible but uneditable.
- Never restore a whole-table `splitCells` parser; use Lezer ranges.
- Never use module-global focus continuation across tabs; use per-view state.
- Real `EditorView` tests are mandatory because mock dispatch cannot prove widget rebuild/focus behavior.

Update the existing sentence claiming `TableData` is only strings and compared as such.

- [ ] **Step 3: Expand manual QA**

In `docs/manual-qa.md`, update the table checklist to include:

- edit an escaped-pipe and ragged-row table;
- verify changing one cell preserves unusual spacing/outer-pipe style elsewhere;
- Tab/Shift-Tab continuity and final-cell Tab row insertion;
- delete buttons disabled at one row/one column;
- active row/column highlight does not resize the table;
- two tabs with tables do not steal each other's input focus;
- quoted/list-embedded table row and column actions preserve prefixes.

- [ ] **Step 4: Run full automated verification**

Run:

```bash
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
```

Expected: all commands exit 0. Do not claim lint/format checks; this repository has no repository-wide lint/format command.

- [ ] **Step 5: Run advisory performance check**

Run:

```bash
pnpm --filter @omd/engine bench
```

Expected: command completes; budget warnings are advisory. Confirm table changes did not introduce full-document parsing or a new large-document hot path.

- [ ] **Step 6: Perform the table manual QA matrix**

Execute the updated `docs/manual-qa.md` table items in the desktop app, including light/dark themes and a 20×10 table with repeated Tab edits. Record any failure before completion; do not substitute happy-dom results for WKWebView interaction checks.

- [ ] **Step 7: Commit documentation**

```bash
git add packages/engine/AGENTS.md docs/memory/known-gotchas.md docs/manual-qa.md
git commit -m "docs: document reliable table editing invariants"
```

## Deferred Work

The plan intentionally stops after the reliable keyboard-editing baseline. Add alignment UI, context menus, drag/reorder, resize, or a non-block-widget table architecture only after manual QA shows the remaining block-widget limits are user-visible and worth their complexity.
