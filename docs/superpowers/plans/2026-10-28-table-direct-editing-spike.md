# Table Direct-Editing Feasibility Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine whether one rendered Markdown table cell can be edited directly without creating a second document authority, breaking outer undo/find/autosave semantics, triggering ordered-list normalization, or retaining unbounded widget state.

**Architecture:** Add an opt-in, harness-only engine extension that keeps `TableWidget` mounted and stores the logical edit session in CodeMirror state. The only composition draft lives on a DOM-owned controller; every durable edit is an outer `EditorView` transaction. The first edit normalizes the whole table and later edits use existing range-based cell replacement.

**Tech Stack:** TypeScript, CodeMirror 6 state/view/history, Lezer Markdown, Vitest + happy-dom, Playwright Chromium + CDP heap sampling.

**Spec:** `docs/superpowers/specs/2026-10-28-editor-experience-spike-program-design.md`

## Global Constraints

- This spike deliberately challenges `packages/engine/AGENTS.md` invariant 12; production remains two-state unless a later approved design replaces that invariant.
- `EditorState.doc` remains the only durable document authority; no widget, input controller, or React state may own committed cell text.
- The experiment is disabled by default and must not alter shipped table behavior without the explicit `experimentalTableDirectEdit` option.
- Events originating in `.omd-table-cell-input` belong to the nested input controller. `TableWidget.ignoreEvent` must keep keyboard, input, and composition events out of CodeMirror's outer event pipeline while the input's own listeners translate approved actions into outer transactions.
- The input surface has no independent history. Plain input uses `userEvent: "input.type"`; composition commit uses `userEvent: "input.type.compose"`. Same-cell input inside CodeMirror's current 500 ms `newGroupDelay` may merge; delay expiry or cell navigation starts a new group.
- The first successful input performs whole-table normalization and cell replacement in one outer transaction. Undo must restore the byte-identical pre-edit document.
- Ordered-list renumbering may be suppressed only by a narrow transaction annotation on this edit; process-global suppression is forbidden.
- Do not use `forceParsing` or `ensureSyntaxTree` in production code. Tests may use existing helpers.
- No busy loops or unbounded churn. Heap runs are fixed at baseline, 100, 500, and 1000 cycles.
- Do not commit during execution unless the user separately authorizes commits. End each task with a diff/test checkpoint instead.

---

## File Structure

- Create `packages/engine/src/tables/directEdit.ts` — experimental Facet, session StateField/effects, transaction annotations, and history grouping.
- Create `packages/engine/src/tables/normalize.ts` — pure whole-table canonicalization using `TableData` source ranges.
- Modify `packages/engine/src/decorations/widgets/table.ts` — opt-in cell activation, stable DOM controller ownership, and in-place input preservation.
- Modify `packages/engine/src/decorations/blocks.ts` — pass the experiment flag/session-aware widget inputs without changing the default two-state branch.
- Modify `packages/engine/src/lists/ordered.ts` — skip only transactions carrying the experimental table-edit suppression annotation.
- Modify `packages/engine/src/index.ts` — expose the opt-in `EngineOptions.experimentalTableDirectEdit` assembly point; do not export spike internals as supported public API.
- Modify `apps/desktop/src/Editor.ts` — pass the optional experiment flag from `CreateEditorOptions` only for the E2E harness.
- Modify `apps/desktop/e2e/harness.ts` — enable the spike with `?tableDirectEdit=1`.
- Create `apps/desktop/e2e/table-direct-edit-spike.spec.ts` — real Chromium click, typing, IME, undo, and stale-session evidence.
- Create `apps/desktop/e2e/table-direct-edit-memory.mjs` — five paired control/experiment CDP heap runs.
- Create `packages/engine/test/tableNormalize.test.ts` — source-shape normalization fixtures.
- Create `packages/engine/test/tableDirectEdit.test.ts` — real-`EditorView` state, transaction, history, ordered-list, and DOM-rotation tests.
- Create `docs/superpowers/plans/2026-10-28-table-direct-editing-spike-results.md` — measured evidence and `Go`/`Revise`/`Stop` decision.

### Task 1: Pure Table Normalization Contract

**Files:**
- Create: `packages/engine/src/tables/normalize.ts`
- Create: `packages/engine/test/tableNormalize.test.ts`
- Read: `packages/engine/src/tables/model.ts`
- Read: `packages/engine/src/tables/edit.ts`

**Interfaces:**
- Consumes: `TableData`, table source, active row/column, and raw input value.
- Produces:

```ts
export interface NormalizedTableEdit {
  readonly source: string
  readonly activeCell: { readonly from: number; readonly to: number }
}

export function normalizeTableForFirstEdit(
  source: string,
  table: TableData,
  row: number,
  column: number,
  value: string,
): NormalizedTableEdit | null
```

- [ ] **Step 1: Write the source-shape matrix tests**

Create table-driven cases for canonical source, no outer pipes, irregular spaces, alignment markers with long hyphen runs, escaped pipes, CRLF, and a parsed table inside an ordered-list item. Each assertion must compare the full expected source, not snapshots.

```ts
const cases = [
  {
    name: "normalizes missing outer pipes and untouched cells",
    before: "A|  B\n:-----|---:\nC | D",
    row: 0,
    column: 0,
    value: "X",
    after: "| X | B |\n| :--- | ---: |\n| C | D |",
  },
  {
    name: "preserves escaped pipe content",
    before: "| A | B |\n| --- | --- |\n| C\\|D | E |",
    row: 0,
    column: 0,
    value: "X",
    after: "| X | B |\n| --- | --- |\n| C\\|D | E |",
  },
]
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @omd/engine exec vitest run test/tableNormalize.test.ts`

Expected: FAIL because `normalizeTableForFirstEdit` does not exist.

- [ ] **Step 3: Implement deterministic row serialization**

Use `TableRowData.cells`, `TableData.aligns`, and the existing `escapeTableCellValue`; do not split on `|` or introduce a second parser. Preserve each row's `prefix` and the original document line separator. Serialize content rows as `| ${escapedCellSource.trim()} |` and delimiter cells as left colon + exactly three hyphens + right colon.

```ts
function delimiter(align: TableAlignment): string {
  if (align === "left") return ":---"
  if (align === "right") return "---:"
  if (align === "center") return ":---:"
  return "---"
}
```

Reject ragged synthetic cells, stale ranges, an out-of-range row/column, and table data whose captured source ranges no longer match `source`.

- [ ] **Step 4: Run focused and existing table transform tests**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/tableNormalize.test.ts test/table-model.test.ts test/table-edit.test.ts
```

Expected: PASS; existing range-based transforms remain unchanged.

- [ ] **Step 5: Review the task diff**

Run: `git diff --check && git diff -- packages/engine/src/tables/normalize.ts packages/engine/test/tableNormalize.test.ts`

Expected: no whitespace errors; normalization is isolated from existing byte-minimal edit helpers.

### Task 2: Experimental Session and History Contract

**Files:**
- Create: `packages/engine/src/tables/directEdit.ts`
- Create: `packages/engine/test/tableDirectEdit.test.ts`
- Modify: `packages/engine/src/lists/ordered.ts`
- Test: `packages/engine/test/orderedRenumberSafeMode.test.ts`

**Interfaces:**
- Consumes: `normalizeTableForFirstEdit`, `replaceTableCell`, `tableAt`, and CodeMirror transaction/history APIs.
- Produces:

```ts
export interface TableEditTarget {
  readonly tableFrom: number
  readonly tableTo: number
  readonly row: number
  readonly column: number
  readonly source: string
}

export interface TableEditSession {
  readonly target: TableEditTarget
  readonly revision: number
  readonly composing: boolean
  readonly hasCommittedInput: boolean
}

export const experimentalTableDirectEdit: Extension
export const suppressOrderedRenumberForTableEdit: Annotation<boolean>
export function getTableEditSession(state: EditorState): TableEditSession | null
export function beginTableEdit(target: TableEditTarget): StateEffect<TableEditTarget>
export function setTableComposition(composing: boolean): StateEffect<boolean>
export function closeTableEdit(): StateEffect<null>
export function tableCellInputSpec(
  state: EditorState,
  value: string,
  kind: "typing" | "composition",
): TransactionSpec | null
```

- [ ] **Step 1: Write failing state and history tests**

Cover: session opens without changing the doc; first input yields one doc-changing transaction; immediate undo restores exact noncanonical source; redo restores normalized edited source; same-cell events at 0 ms and 400 ms group; a 600 ms gap creates a second undo group; closing/reopening another cell starts a new group; stale table source returns `null`.

Use explicit `Transaction.time` annotations to make grouping deterministic instead of sleeping.

```ts
const first = tableCellInputSpec(view.state, "X", "typing")
if (!first) throw new Error("expected first table edit")
view.dispatch(view.state.update(first, { annotations: Transaction.time.of(1_000) }))
const second = tableCellInputSpec(view.state, "XY", "typing")
if (!second) throw new Error("expected second table edit")
view.dispatch(view.state.update(second, { annotations: Transaction.time.of(1_400) }))
expect(undo(view)).toBe(true)
expect(view.state.doc.toString()).toBe(original)
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @omd/engine exec vitest run test/tableDirectEdit.test.ts`

Expected: FAIL because the session extension and transaction builder do not exist.

- [ ] **Step 3: Implement the StateField and validated transaction builder**

Map `tableFrom`/`tableTo` through every transaction. On a doc change, re-resolve `tableAt` at the mapped position and close the session when row/column/source validation fails. Set `hasCommittedInput` only after the first successful doc change.

The first input uses one whole-table change from `normalizeTableForFirstEdit`; later inputs use one range change from `replaceTableCell`. Stamp:

```ts
annotations: [
  Transaction.userEvent.of(kind === "composition" ? "input.type.compose" : "input.type"),
  suppressOrderedRenumberForTableEdit.of(true),
]
```

Use `isolateHistory.of("before")` on the first edit after cell activation; do not alter the editor-wide history configuration.

- [ ] **Step 4: Isolate ordered renumbering narrowly**

In `orderedRenumber.update`, ignore a document-change transaction only when it carries `suppressOrderedRenumberForTableEdit`. Do not change preview-entry normalization, ordinary source edits, ordered-list commands, or safe-mode range scanning.

Add two real-view cases using the same ordered-list-contained table with safe mode off/on. After first edit, wait for queued microtasks, assert the list marker is unchanged, undo once, and assert the entire document equals its original bytes.

- [ ] **Step 5: Run state, history, and ordered-list tests**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/tableDirectEdit.test.ts test/ordered-renumber.test.ts test/orderedRenumberSafeMode.test.ts
```

Expected: PASS; ordinary ordered renumber tests retain their current results.

- [ ] **Step 6: Review the task diff**

Run: `git diff --check && git diff -- packages/engine/src/tables/directEdit.ts packages/engine/src/lists/ordered.ts packages/engine/test/tableDirectEdit.test.ts`

Expected: the only ordered-list behavior exception is annotation-scoped.

### Task 3: DOM-Owned Input Controller

**Files:**
- Modify: `packages/engine/src/decorations/widgets/table.ts`
- Modify: `packages/engine/src/decorations/blocks.ts`
- Modify: `packages/engine/src/index.ts`
- Modify: `packages/engine/test/tableUpdateDOM.test.ts`
- Modify: `packages/engine/test/tableDirectEdit.test.ts`

**Interfaces:**
- Consumes: Task 2 session/effects/spec builder.
- Produces:

```ts
export interface EngineOptions {
  // existing fields remain unchanged
  experimentalTableDirectEdit?: boolean
}

interface TableInputController {
  readonly input: HTMLInputElement
  composing: boolean
  destroy(): void
}

export function activeTableInputControllerCountForTest(): number
```

- [ ] **Step 1: Write failing DOM-rotation tests**

Mount a real `EditorView` with `experimentalTableDirectEdit: true`, activate one real source-backed cell, and assert exactly one `.omd-table-cell-input`. Dispatch a document change before the table and a decoration refresh while composition is active; assert the same input node, value, selection, and controller remain attached.

Keep the outer selection on a non-table line, focus the cell input, and dispatch bubbling `keydown` events for `Backspace` and `Enter`, plus `beforeinput`, `input`, `compositionstart`, `compositionupdate`, and `compositionend`. Assert that the outer keymap never edits at the outer selection and that document changes occur only through the table controller's explicit transaction path.

Model Chromium's completed-composition sequence exactly: `compositionstart` → `compositionupdate` → `compositionend` → `input` with `inputType: "insertCompositionText"`. Count `docChanged` transactions and assert the composed text is committed exactly once.

Also mount without the flag and assert cell mousedown still enters plain source with no input, preserving production behavior.

- [ ] **Step 2: Run the focused widget tests and verify failure**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/tableDirectEdit.test.ts test/tableUpdateDOM.test.ts test/tableSourceDecorations.test.ts
```

Expected: new direct-edit DOM assertions FAIL; existing two-state assertions PASS.

- [ ] **Step 3: Add the opt-in engine assembly point**

Mount `experimentalTableDirectEdit` outside `livePreviewCompartment` only when the option is true. Pass a boolean Facet into table widget construction so default widgets do not import or consult mutable process state.

Do not barrel-export the StateField, effects, annotation, or controller. The supported engine API addition is only the experimental option used by the harness.

- [ ] **Step 4: Implement DOM controller ownership**

Store controllers in a module-local `WeakMap<HTMLElement, TableInputController>` keyed by the active input host. Event listeners resolve the current `TableWidget` through the existing `domOwner` map; they never close over widget `this`.

Maintain a scalar active-controller count incremented at controller creation and decremented exactly once by `destroy()`. Export its reader only from `table.ts` for the spike harness; do not re-export it from `packages/engine/src/index.ts`.

On cell activation:

1. stop the block wrapper's source-entry mousedown only when the experiment is enabled;
2. dispatch `beginTableEdit`;
3. replace that cell's rendered children with one text input initialized from cell source;
4. attach composition/input/keydown/focusout listeners;
5. focus and select the input without changing the outer document selection.

On `updateDOM`, if the same session target remains active, move/rebind the existing host rather than calling `renderCellSlot`. Return `false` during active composition if preserving the input would be impossible; the test must then fail feasibility rather than silently recreating it.

Override `TableWidget.ignoreEvent(event)`. If `event.target` is the active `.omd-table-cell-input` or one of its descendants, return `true` for `keydown`, `keyup`, `keypress`, `beforeinput`, `input`, `click`, `compositionstart`, `compositionupdate`, and `compositionend`; otherwise delegate to `super.ignoreEvent(event)`. The input's target listeners still run before bubbling reaches CodeMirror, but `eventBelongsToEditor` must reject the event before outer keymaps or input handlers see it. Do not broaden `BlockWidget.ignoreEvent`, because other block widgets still need its current behavior.

- [ ] **Step 5: Route input and navigation to outer transactions**

- The `input` listener receives an `InputEvent`. If `event.isComposing` is true or `event.inputType === "insertCompositionText"`, it returns without dispatching; otherwise it dispatches `tableCellInputSpec(view.state, input.value, "typing")` immediately.
- `compositionstart` dispatches `setTableComposition(true)` and does not change the document.
- `compositionend` is the sole composition commit point: it dispatches exactly one `tableCellInputSpec(view.state, input.value, "composition")`, then `setTableComposition(false)`.
- Do not use a microtask flag to swallow the trailing Chromium `input`; the guard is derived only from `InputEvent.isComposing` and `InputEvent.inputType`.
- `Enter` prevents its native action, closes the current outer history group, and keeps the same cell active; it never falls through to the outer keymap or dispatches a document change by itself.
- `Tab`/`Shift-Tab` close the current history group, activate the adjacent real cell, and never append rows in this spike.
- `Escape` closes the session without reverting already committed outer changes.
- `Mod-z`/`Mod-Shift-z` invoke outer undo/redo commands.

- [ ] **Step 6: Run all table-focused tests**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/tableDirectEdit.test.ts test/tableUpdateDOM.test.ts test/tableWidgetEquality.test.ts test/tables.test.ts test/tableKeymap.test.ts
```

Expected: PASS; no default table behavior changes without the option.

- [ ] **Step 7: Review the task diff**

Run: `git diff --check && git diff -- packages/engine/src/decorations/widgets/table.ts packages/engine/src/decorations/blocks.ts packages/engine/src/index.ts`

Expected: no React/Tauri import; no widget instance owns draft/history/session state.

### Task 4: Real Chromium Interaction Evidence

**Files:**
- Modify: `apps/desktop/src/Editor.ts`
- Modify: `apps/desktop/e2e/harness.ts`
- Create: `apps/desktop/e2e/table-direct-edit-spike.spec.ts`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: `EngineOptions.experimentalTableDirectEdit`.
- Produces: `CreateEditorOptions.experimentalTableDirectEdit?: boolean` for the E2E harness only.

- [ ] **Step 1: Add the disabled-by-default harness switch**

Read `tableDirectEdit=1` from the harness query string and pass it through `createEditor` to `editorExtensions`. Production callers omit the field.

- [ ] **Step 2: Write the Chromium scenarios**

Test the canonical and noncanonical fixtures through the real `.omd-table table` DOM:

- one click opens exactly one input;
- printable input changes only the intended table;
- Chromium's `compositionend` followed by `inputType: "insertCompositionText"` produces no document change before `compositionend` and exactly one `docChanged` transaction after the full sequence;
- with the outer selection parked outside the table, `Backspace` and `Enter` inside the input do not trigger outer CodeMirror keymaps or edit the parked position;
- an edit before the table does not redirect the active cell;
- immediate outer undo restores the exact original document and redo restores the normalized edit;
- a table inside an out-of-order ordered-list item does not rewrite the marker after microtasks settle;
- default harness URL without the query flag still enters source instead of an input.

- [ ] **Step 3: Add minimal spike styling**

Add `.omd-table-cell-input` rules that inherit the cell font/color/background, fill the cell, and introduce no vertical margin. Do not add production toolbar or accessibility polish.

- [ ] **Step 4: Run focused E2E and desktop build**

Run:

```bash
pnpm --filter @omd/desktop build
pnpm --filter @omd/desktop test:e2e -- table-direct-edit-spike.spec.ts
```

Expected: build PASS; Chromium scenarios PASS with zero `window.__harnessErrors`.

- [ ] **Step 5: Review the task diff**

Run: `git diff --check && git diff -- apps/desktop/src/Editor.ts apps/desktop/e2e/harness.ts apps/desktop/e2e/table-direct-edit-spike.spec.ts apps/desktop/src/styles.css`

Expected: the experiment is reachable only through the explicit option/query flag.

### Task 5: Paired Heap Audit

**Files:**
- Create: `apps/desktop/e2e/table-direct-edit-memory.mjs`
- Modify: `apps/desktop/package.json`
- Read: `apps/desktop/e2e/widget-memory-audit.mjs`

**Interfaces:**
- Consumes: E2E harness control mode and `?tableDirectEdit=1` experiment mode.
- Produces: one JSON report containing environment, five paired runs, baseline/100/500/1000/after-destroy samples, controller/input counts, medians, maxima, and gate evaluation.

- [ ] **Step 1: Add the bounded audit command**

Add:

```json
"audit:table-direct-edit-spike": "node e2e/table-direct-edit-memory.mjs"
```

- [ ] **Step 2: Implement paired-run sampling**

Run five fresh-page pairs and alternate order: experiment/control, control/experiment. For control, enter/exit source through the existing table cell path. For experiment, click a cell, insert one character through the input, Escape, then invoke outer undo so every cycle returns to the byte-identical fixture. Assert the document equals the fixture after every batch before sampling. Sample after explicit CDP GC at baseline, 100, 500, 1000, and after `view.destroy()`.

Permit one discarded run only when navigation, selector lookup, or CDP collection throws; record the reason in JSON. Never rerun based on an unfavorable heap number.

- [ ] **Step 3: Compute the exact decision metrics**

For each valid run compute `growth100to1000 = usedSize1000 - usedSize100`. Report:

- experiment/control medians;
- experiment maximum;
- median delta;
- live `.omd-table-cell-input` count;
- retained controller count from `activeTableInputControllerCountForTest()` imported directly by the spike harness, never from the supported engine barrel;
- gates: experiment median ≤ 32 MiB, experiment median ≤ control median + 8 MiB, every run ≤ 64 MiB, after-destroy counts equal control.

- [ ] **Step 4: Run the audit twice only for the required evidence**

Start the isolated Vite server on a unique port, then run:

```bash
PW_PORT=9434 pnpm --filter @omd/desktop dev -- --host 127.0.0.1 --port 9434
PW_PORT=9434 pnpm --filter @omd/desktop audit:table-direct-edit-spike
```

Expected: one complete five-pair JSON result. A second invocation is allowed only to satisfy the spec's repeated-evidence requirement, not to replace a failed result.

- [ ] **Step 5: Review the audit script**

Run: `git diff --check && git diff -- apps/desktop/e2e/table-direct-edit-memory.mjs apps/desktop/package.json`

Expected: fixed iteration counts; browser/page cleanup in `finally`; no heap snapshot unless an explicit environment flag enables it.

### Task 6: Full Verification and Decision Report

**Files:**
- Create: `docs/superpowers/plans/2026-10-28-table-direct-editing-spike-results.md`
- Modify only if the result is `Go`: none; production docs remain unchanged until a separate design is approved.

**Interfaces:**
- Consumes: all test output, E2E output, heap JSON, source before/after samples.
- Produces: one reviewed `Go`, `Revise`, or `Stop` report.

- [ ] **Step 1: Run engine and desktop verification**

Run:

```bash
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
pnpm --filter @omd/desktop test:e2e -- table-direct-edit-spike.spec.ts
```

Expected: all PASS. Do not call the spike `Go` if any focused correctness test is skipped or flaky.

- [ ] **Step 2: Create the evidence report with fixed headings**

```markdown
# Table Direct-Editing Spike Results

## Environment and Commit
## Commands
## Source and Transaction Evidence
## IME and History Evidence
## Ordered-List Isolation Evidence
## Heap Evidence
## Failed Cases
## Decision
## Production Recommendation
## Prototype Files: Keep, Rewrite, Delete
```

Populate every heading with measured values or `None observed`; do not preselect a decision.

- [ ] **Step 3: Apply the decision gate literally**

- `Go`: every correctness, IME, ordered-list, history, stale-range, and heap gate passes.
- `Revise`: correctness passes but one bounded OMD-owned focus/IME/heap cause is identified; name one smaller follow-up spike.
- `Stop`: correctness needs independent durable state/history, per-keystroke whole-table replacement, CodeMirror internals, or process-global suppression.

- [ ] **Step 4: Record prototype disposition**

List each experimental file under Keep/Rewrite/Delete. Even on `Go`, state explicitly that production work requires a new approved design that revises invariant 12 and the table gotchas.

- [ ] **Step 5: Final plan checkpoint**

Run: `git status --short && rg -n "^## |^### " docs/superpowers/plans/2026-10-28-table-direct-editing-spike-results.md`

Expected: report headings complete; no unrelated working-tree changes.
