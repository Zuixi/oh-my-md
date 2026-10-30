# Engine Tables

> **Parent:** [`../../AGENTS.md`](../../AGENTS.md)
> **Scope:** GFM table model, Lezer-range edits, source toolbar, and navigation (`src/tables/**`). Related consumers must explicitly read this guide: `decorations/widgets/table.ts`, `parse/cell.ts`, and `format/tableKeymap.ts`; they do not inherit it by path.

## Two-State Model & Subtree Skipping

- **Two states only:** Caret outside → `TableWidget` projection; caret inside (`blockSelected`) → `styleTableSource` (`line:omd-table-src*` classes).
- **Skip subtree in source state:** `blocks.ts` `case "Table"` **must `return true`** after calling `styleTableSource` so `inlineRules` does not fold `**` or links inside raw source cells (`test/tableSourceDecorations.test.ts`).
- **Opt-in direct edit (`directEdit.ts`):** In-cell `<input>` editing is strictly behind the `experimentalTableDirectEdit` facet. In standard mode, clicking a `td`/`th` enters source at the exact cell offset via `TableWidget.clickPos`; never attach a cell `mousedown` listener that stops propagation.

## Lezer-Range Model & Stale-Checked Edits

- **Single model extractor (`model.ts::tableDataFromNode`):** Produces `TableData` with table-relative offsets (`lineFrom`/`lineTo` include quote/list prefixes). Empty source slots are zero-length `TableCellData`; missing ragged tail cells are `null` (rendered with `.omd-table-cell-missing` / `aria-disabled="true"`).
- **Byte-minimal range edits (`edit.ts`, `tools.ts`):** `replaceTableCell`, `insertTableRow`, `insertTableColumn`, `deleteTableRow`, `deleteTableColumn`, and `setTableColumnAlignment` return pure table-relative `TableSourceChange[]` ranges — never re-serialize the whole table string.
- **Single dispatch gate (`sourceToolbar.ts::applyTableToolAt`):** Validates `(from, source)` against the live document and checks `view.state.readOnly` before dispatching. Row indices are **0-based** on both sides (`0` = header, `1` = first data row).
- **Hover-driven widget toolbar (`widgets/table.ts`):** Rendered toolbar target comes only from `mouseover` on real `td`/`th` (`row`, `col`, `hovered`). Buttons stay `disabled` until `hasRowCol()`. Never store a cross-view pending-action queue.

## `TableWidget` Instance Rotation & In-Place `updateDOM`

- **Lazy equality key (`tableEqualityKey`):** `eq` compares `src` + `embed` first, then `tableEqualityKey` (never `JSON.stringify`).
- **`domOwner` WeakMap:** CodeMirror pass-1 `updateDOM` keeps the old DOM/listeners but swaps the widget instance to `this`. Register **both** the outer `.omd-block` wrap and `.omd-block-body` in `domOwner` during `toDOM` and `updateDOM`, migrate `row`/`col`/`hovered` from `prev`, and resolve the active owner via `domOwner.get(...)` inside every event listener — never close over `this`.
- **Shape changes:** `updateDOM` patches only changed cells when `sameTableShape(before, after)` holds, and returns `false` when row/column counts change so CodeMirror falls back to `toDOM`.

## Shared Cell Semantics & Table Keymap

- **Single cell parser (`parse/cell.ts::parseCell`):** Both `TableWidget` (`renderTableCellContent`) and HTML exports (`exportHtml` / `exportRichHtml`) must consume the shared cell model — never regex-parse cells or bypass `parseCell` in rich export.
- **Navigation (`navigate.ts`, `format/tableKeymap.ts`):** `tableAt`, `cellAt`, `nextCell`, `cellBelow` are read-only tree queries (`null` when tree is unavailable; never advance parsing). `Enter` on the final row (or at `Table.to`) exits the table via `exitTableSpec`; only `Tab` on the final cell appends a row. Never add a redundant `isComposing` guard in `tableKeymap` (CodeMirror already filters composition keydowns).
- **Future complex HTML tables:** Dedicated complex-table modules are not implemented. If an approved task introduces `rowspan`/`colspan` editing, design a separate model/widget rather than silently extending the GFM range-edit contract; future plans are not current requirements.

## Related Guides & Verification

- Read [decorations](../decorations/AGENTS.md) for widget lifecycle, [parsing](../parse/AGENTS.md) for `parseCell`, and [formatting](../format/AGENTS.md) for table keymaps when those consumers change.
- Follow [engine verification](../../AGENTS.md#testing). Cover byte preservation outside edit ranges, stale/read-only rejection, source/rendered transitions, and shared cell semantics in HTML export.
