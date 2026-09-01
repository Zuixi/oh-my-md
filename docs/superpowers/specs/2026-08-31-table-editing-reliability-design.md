# Table Editing Reliability Design

**Date:** 2026-08-31
**Status:** Approved direction from the table implementation review
**Supersedes:** The whole-table rewrite architecture in [`2026-08-16-15-table-editing-design.md`](./2026-08-16-15-table-editing-design.md)

## Goal

Make Live Preview table editing continuous and trustworthy: editing one cell changes only that cell, Lezer-recognized ragged tables remain editable where a source cell exists, keyboard navigation survives widget rebuilds, and row/column operations preserve untouched Markdown.

## Scope

This milestone keeps the existing CodeMirror block-widget presentation. It improves its editing model rather than replacing it with an Excel-like grid or an inline-decoration table renderer.

Included:

- Lezer-derived table row, cell, delimiter, and alignment ranges.
- Exact cell-range replacement with pipe escaping and whitespace preservation.
- Per-`EditorView` edit continuation for Enter, Tab, and Shift-Tab.
- Tab from the final cell inserts one row and focuses its first cell.
- Range-based insert/delete row and column operations.
- Disabled toolbar actions when the last row or column cannot be deleted.
- Active row/column highlighting while a cell is being edited.
- Real `EditorView` tests for dispatch, rebuild, focus, and multiple-view isolation.

Excluded:

- Dragging rows or columns.
- Column-width resizing.
- Multi-cell selection, formulas, merged cells, or spreadsheet paste.
- Context menus and an alignment picker.
- Replacing the block-widget architecture.
- Changes to `apps/desktop/src/Editor.ts`.

## Current Problems

1. `blocks.ts` uses Lezer to render tables, but `tables/edit.ts` reparses the source with stricter equal-column rules. A ragged table can render successfully and reject every edit.
2. A cell commit replaces the entire table source. This rebuilds more state than necessary and risks source-format drift.
3. Keyboard continuation uses one module-global `resumeEdit`, so unrelated editor views can consume each other's pending destination.
4. Structural operations serialize every line instead of changing only the affected row/column ranges.
5. Failed toolbar actions are silent, and the current row/column target is not visually clear.

## Architecture

### Lezer-derived table model

`decorations/blocks.ts` remains the single place that translates the current syntax tree into widget data. Table offsets are relative to the `Table` node so they remain valid when text is inserted before the widget.

```ts
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
```

`from`, `to`, `lineFrom`, and `lineTo` are table-relative source ranges. `lineFrom`/`lineTo` include the continuation prefix for rows inside a blockquote/list when that prefix is inside the `Table` span. A `null` cell represents a visually padded column that has no source slot in a ragged row. An empty but source-backed slot is a zero-length `TableCellData`, so users can still click and fill `|  |`. Existing cells remain editable; synthetic missing cells are rendered but not opened as inputs until a column/row operation creates source for them.

The delimiter row uses the same row envelope but its `cells` describe alignment marker ranges. Move these types and the syntax-tree extraction into `packages/engine/src/tables/model.ts`; `blocks.ts` calls that single extractor instead of retaining display-only parsing. The extractor derives slots from Lezer row children and the already-validated separator node; it does not reparse the whole table with independent equal-column acceptance rules.

### Source changes

`tables/edit.ts` becomes a range-change module. Pure functions consume `TableData` and return CodeMirror-compatible table-relative changes:

```ts
export interface TableSourceChange {
  readonly from: number
  readonly to: number
  readonly insert: string
}

export function replaceTableCell(
  source: string,
  cell: TableCellData,
  value: string,
): TableSourceChange | null

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

All functions are pure and never dispatch. They validate every range against the captured table source and return `null` on stale or unsupported input. Unchanged source bytes are never serialized.

Cell input is source text. An unescaped `|` typed by the user is written as `\|`; already escaped pipes remain escaped. Existing leading and trailing whitespace around the cell node is outside the Lezer `TableCell` range and therefore remains byte-identical.

### Widget dispatch and continuation

`TableWidget` converts table-relative changes to live document positions with `livePos()` immediately before dispatch. It dispatches one transaction containing one or more non-overlapping changes.

Pending keyboard focus is scoped by editor view:

```ts
const pendingTableEdits = new WeakMap<
  EditorView,
  { readonly pos: number; readonly row: number; readonly col: number }
>()
```

Before a committing transaction, the old widget records the destination for its own view. The rebuilt widget consumes and deletes the entry only when its live position matches. No module-global destination can cross tabs.

Enter and Tab move forward; Shift-Tab moves backward. When Tab is pressed in the final editable cell, the same transaction commits that cell and appends one data row, then the rebuilt widget focuses the first cell of the new row. Shift-Tab at the first cell commits without moving outside the table.

### Structural operations

Row insertion/deletion changes one contiguous row boundary and preserves quote/list continuation prefixes recorded from the syntax tree.

Column insertion/deletion returns one change per header, delimiter, and data row. Changes are applied in one CodeMirror transaction. Ragged rows are handled per row: insertion creates the missing separators/cell slot required at the requested position; deletion ignores a missing slot but still removes the corresponding delimiter when present. The result must remain a Lezer-recognized GFM table.

The hand-written `splitCells`/`parseTable`/`serialize` implementation is removed after all five exported operations use Lezer-derived ranges.

## UX Rules

- Clicking a real source-backed cell opens the existing single-line input.
- A synthetic missing cell has `aria-disabled="true"` and a tooltip directing the user to add a column or edit source; it does not silently open an input that cannot commit.
- While editing, cells in the active row and column receive semantic classes; CSS supplies a subtle highlight without changing dimensions.
- Delete-row is disabled when there is one data row; delete-column is disabled when there is one column.
- Read-only documents keep all editing controls disabled, and every dispatch path retains an explicit `state.readOnly` guard.
- Cell mousedown continues to prevent the block wrapper from revealing source.

## Testing

Use three layers:

1. Parser-shape tests prove exact relative ranges for leading/trailing pipes, no outer pipes, escaped pipes, empty cells, ragged rows, and blockquotes.
2. Pure transform tests prove minimal changes, source fidelity, pipe escaping, row/column boundaries, quote prefixes, stale-range rejection, and one-row/one-column limits.
3. Real `EditorView` tests prove a cell commit changes only the cell range, the widget rebuild focuses the next cell, final-cell Tab adds a row, Shift-Tab works, edits before the table do not break positioning, two views do not share pending focus, and `exceptionSink` stays empty.

Run `pnpm test`; because this changes interaction behavior, also run `pnpm --filter @omd/desktop build` and execute the table items in `docs/manual-qa.md`.

## Documentation

Update:

- `packages/engine/AGENTS.md` to replace the whole-table transform contract with Lezer-range ownership.
- `docs/memory/known-gotchas.md` with the parser-mismatch and per-view continuation invariants.
- `docs/manual-qa.md` with ragged-table editing, final-cell Tab insertion, disabled destructive actions, and multi-tab isolation checks.
