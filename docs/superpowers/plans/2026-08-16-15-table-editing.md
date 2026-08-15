# 15 Table Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit GFM table cells in Live Preview and insert/delete rows and columns.

**Architecture:** Pure string transforms on the table source block; `TableWidget` hosts an input and toolbar that dispatch a single replacement of the table range.

**Tech Stack:** TypeScript, CodeMirror widgets, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-15-table-editing-design.md`

## Global Constraints

- Engine-only Markdown table knowledge.
- Preserve alignment separator and unedited cell source (including `\|`).
- Header is row 0. Keep at least one header cell and one data row if the source had a data row; never delete the separator.
- `pnpm test`.

---

### Task 1: table source transforms

**Files:**
- Create: `packages/engine/src/tables/edit.ts`
- Create: `packages/engine/test/table-edit.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- `replaceTableCell`, `insertTableRow`, `insertTableColumn`, `deleteTableRow`, `deleteTableColumn`

- [ ] **Step 1: Failing tests on**

```md
| A | B |
| --- | ---: |
| 1 | 2 |
```

`replaceTableCell(src, 1, 1, "x")` → cell `2` becomes `x`.  
`insertTableRow(src, 1)` adds `|  |  |`.  
`insertTableColumn(src, 1)` adds a column.  
`deleteTableColumn` down to one column.  
Malformed `| no sep` returns `null`.

- [ ] **Step 2: Fail**
- [ ] **Step 3: Split rows on `\n`, cells on unescaped `|`**
- [ ] **Step 4: Pass `pnpm --filter @omd/engine exec vitest run test/table-edit.test.ts`**
- [ ] **Step 5: Commit** `feat: transform markdown table cells and axes`

---

### Task 2: TableWidget editor chrome

**Files:**
- Modify: `packages/engine/src/decorations/widgets/table.ts`
- Modify: `packages/engine/test/tables.test.ts` or `view.test.ts`

- [ ] **Step 1: Test that widget DOM includes `omd-table-edit` input after click simulation, and dispatch updates doc**
- [ ] **Step 2: Fail**
- [ ] **Step 3: Click cell → input; Enter commits `replaceTableCell`; toolbar buttons call insert/delete**
- [ ] **Step 4: `pnpm test`**
- [ ] **Step 5: Commit** `feat: edit live-preview tables in place`

Update `docs/manual-qa.md`.
