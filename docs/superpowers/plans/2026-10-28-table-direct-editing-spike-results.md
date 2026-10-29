# Table Direct-Editing Spike Results

> Evidence report for [`2026-10-28-table-direct-editing-spike.md`](./2026-10-28-table-direct-editing-spike.md).
> Decision gates come from [`2026-10-28-editor-experience-spike-program-design.md`](../specs/2026-10-28-editor-experience-spike-program-design.md) (Spike 1).
>
> Every number and every quoted byte string below comes from a run recorded in this worktree
> (focused Vitest output, Playwright output, and `/tmp/omd-table-direct-edit-audit.json`).
> Nothing is estimated. Each row is labelled with its evidence class:
>
> - **Unit** — Vitest in happy-dom with real `EditorView` instances.
> - **Chromium** — Playwright driving real Chrome through `apps/desktop/e2e/harness.html`.
> - **Heap** — Chromium CDP `Runtime.getHeapUsage` after `HeapProfiler.collectGarbage`.

## Environment and Commit

| Item | Value |
| --- | --- |
| Worktree | `.worktrees/editor-experience-spikes` |
| Branch | `codex/editor-experience-spikes` |
| Baseline commit | `80efba580102856fefde43de4c4b9468d5d8fee6` (Merge pull request #41), as stamped in the audit JSON |
| Working tree | **Contains uncommitted spike changes.** The plan forbids committing during the spike, so the commit above is the *baseline*, not the complete patch identity. The experimental code, tests, harness hook, and audit script all live in the working tree. |
| OS / arch | darwin / arm64 |
| Node | v26.7.0 |
| Vitest | 3.2.7 |
| Browser (audit JSON) | Chromium `156.0.8078.48`, `channel: "chrome"` |
| Viewport (audit JSON) | 1200 × 900 |
| Heap-audit port | 9473 (isolated Vite dev server) |
| Final E2E port | 9474 (`PW_PORT`, Playwright-owned dev server) |
| Harness URL (audit JSON) | `/e2e/harness.html?tableMemorySpike=1[&tableDirectEdit=1]` |
| Heap fixture | `\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2 \|\n\ntail` |

## Commands

Focused engine RED (test-only diff, production untouched):

```sh
pnpm --filter @omd/engine exec vitest run test/tableDirectEdit.test.ts test/orderedRenumberSafeMode.test.ts
# -> 4 failed | 37 passed
```

Focused Chromium RED:

```sh
pnpm --filter @omd/desktop build
PW_PORT=9471 pnpm --filter @omd/desktop test:e2e -- table-direct-edit-spike.spec.ts
# -> 5 failed | 67 passed
```

Focused engine GREEN (the five-file acceptance set from the fix task):

```sh
pnpm --filter @omd/engine exec tsc --noEmit
pnpm --filter @omd/engine exec vitest run test/tableDirectEdit.test.ts test/orderedRenumberSafeMode.test.ts test/tableNormalize.test.ts test/tables.test.ts test/tableUpdateDOM.test.ts
# -> 81 passed (81) at the acceptance run; 89 passed (89) on the final tree
```

`81` is the historical acceptance count. The follow-up history-sync task, the synchronous-dispatch
regression, and the cross-cell/cross-table undo/redo + multi-table focus-switch + toolbar composition guard regressions then added tests to
`tableDirectEdit.test.ts` (24, then 25, now 30) and `orderedRenumberSafeMode.test.ts` (now 19), so
rerunning the identical five-file command on the final tree is **89/89**: 30 + 19 + 14 + 20 + 6.

Final focused table run:

```sh
pnpm --filter @omd/engine exec vitest run test/tableDirectEdit.test.ts test/tableUpdateDOM.test.ts test/tableNormalize.test.ts
# -> 50 passed (50): 30 + 6 + 14
```

Whole engine suite, desktop suite, build, and the final Chromium invocation:

```sh
pnpm test                                                                    # engine tsc --noEmit + Vitest -> 950 passed across 73 files
pnpm --filter @omd/desktop test                                              # test TS compile + Vitest -> 915 passed across 90 files
pnpm --filter @omd/desktop build                                             # PASS
PW_PORT=9474 pnpm --filter @omd/desktop test:e2e -- table-direct-edit-spike.spec.ts
# -> 74 passed; `test:e2e` has no per-file filter, so this command still runs the whole suite
#    and simply reports the table-direct-edit tests inside it (14 tests, 15 scenarios: the first
#    test walks a canonical and a noncanonical document)
```

Paired heap audit (isolated Vite on its own port, then the one-off audit script):

```sh
PW_PORT=9473 pnpm --filter @omd/desktop dev -- --host 127.0.0.1 --port 9473
PW_PORT=9473 pnpm --filter @omd/desktop audit:table-direct-edit-spike        # writes /tmp/omd-table-direct-edit-audit.json
```

JSON of record: `/tmp/omd-table-direct-edit-audit.json` (all metrics and gates in this report are
read from it).

Whitespace check:

```sh
git diff --check                                                             # clean
```

No repository lint or format command exists, and none is claimed here.

## Source and Transaction Evidence

**Design under test (Unit)** — `EditorState.doc` stays the only durable authority:

- `experimentalTableDirectEdit` is a single opt-in extension: `[tableEditSession, tableSessionHistory]`
  (`packages/engine/src/tables/directEdit.ts`). The session is a `StateField`, the table decoration
  stays mounted, and the only draft outside the document is the browser composition text in the DOM
  input.
- The first accepted input dispatches **one** whole-table change built by
  `normalizeTableForFirstEdit`; every later input dispatches **one** narrow `replaceTableCell` range
  change. Opening, focusing, `Tab`/`Shift-Tab`, `Enter`, `Escape`, and clicking a second cell never
  change the document.
- Beginning another cell of the already-open table retargets the session and preserves
  `hasCommittedInput` and `revision`, so switching cells cannot trigger a second normalization.
- Every write re-validates the live table range, row/column, and expected `table.source`; a mismatch
  returns `null` and no transaction is dispatched.

**Normalization contract (Unit)** — `packages/engine/test/tableNormalize.test.ts`, 14 tests over the
program's source-shape matrix. Full expected sources, not snapshots:

| Fixture case | Before | Active cell → value | After |
| --- | --- | --- | --- |
| no outer pipes + irregular spacing | `A\|  B` / `:-----\|---:` / `C \| D` | `(0,0)` ← `X` | `\| X \| B \|` / `\| :--- \| ---: \|` / `\| C \| D \|` |
| canonical, irregular inner spacing | `\|A\|B\|` / `\|---\|---\|` / `\|  1  \|  2\|` | `(1,1)` ← `Y` | `\| A \| B \|` / `\| --- \| --- \|` / `\| 1 \| Y \|` |
| long alignment hyphen runs | `:--------` / `--------:` / `:-------:` | `(1,0)` ← `X` | `:---` / `---:` / `:---:` |
| escaped pipe in untouched cell | `... \| C\\\|D \| E \|` | `(0,0)` ← `X` | `C\\\|D` preserved verbatim |
| pipe typed into the active cell | `\| 1 \| 2 \|` | `(1,1)` ← `P\|Q` | `\| 1 \| P\\\|Q \|` |
| CRLF source | CRLF table | `(0,1)` ← `X` | CRLF separators preserved byte-for-byte |
| ordered-list continuation prefix | `\| :--- \| ---: \|` with `   ` prefix | `(1,1)` ← `Y` | `   ` prefix kept on every row |

Rejections are asserted too: table data captured from a different source, ragged rows with a
`null` cell slot, out-of-bounds row/column, and `aligns` width mismatch all return `null`.

**RED defects (recorded before the fixes)** — `4 failed | 37 passed` for the two focused engine
files, `5 failed | 67 passed` for the focused Chromium file:

| # | Class | Failing case | Assertion observed | Audited cause |
| --- | --- | --- | --- | --- |
| 1 | Unit | `table cell input transactions > keeps the committed table state when the edit moves to another cell` | expected one change `[[6,7,"Y"]]`, got one whole-table change `[0,35,"\| X \| Y \|…"]` | cell switch reset `hasCommittedInput` → second whole-table normalization |
| 2 | Unit | `table direct edit DOM controller > clears the session when the outer selection moves into the table` | expected `null`, got `{target:{row:1,column:0,…}, revision:0}` | widget/input unmounted but `tableEditSession` stayed alive |
| 3 | Unit | `orderedRenumber safe-mode windowed scans > keeps a stale ordered-list marker unchanged when the table edit is undone` | expected `7. second`, got `2. second` | undo of the suppressed edit re-triggered marker renumbering |
| 4 | Unit | `… the table edit is undone in safe mode` | same byte diff | same defect on the windowed policy path |
| 5 | Chromium | `input-focused undo and redo keep the same cell input alive` | `toHaveCount(1)` failed after two >500 ms groups | undo destroyed the nested input; the old `window.__view.focus()` workaround was removed |
| 6 | Chromium | `switching cells does not run a second whole-table normalization` | `\| 9 \| 8 \|` instead of `\| 9  \| 8 \|` | whole-table rewrite trimmed the other cell |
| 7 | Chromium | `Tab on the final cell closes the input history group` | undo took both edits (`\| 1 \| 2 \|`) | boundary `Tab` with no adjacent cell did not isolate history |
| 8 | Chromium | `Shift-Tab on the first cell closes the input history group` | undo took both edits (`\| A \| B \|`) | boundary `Shift-Tab` did not isolate history |
| 9 | Chromium | `canonical bytes stay after clearing a cell to empty and typing` | `\|9  \| 2 \|` instead of `\| 9 \| 2 \|` | empty cell had no Lezer `TableCell`; insertion landed before the boundary space |

**GREEN outcomes:** 81/81 focused engine acceptance at the fix run, **84/84 on the final tree**
(25 + 19 + 14 + 20 + 6), 25/25 `tableDirectEdit.test.ts`, 45/45 focused table driver run, 945/945
whole engine suite across 73 files, 913/913 desktop suite across 90 files, desktop build PASS, and
72/72 Chromium including all 12 table-direct-edit tests (13 scenarios).

**Exact original / normalized / undo / redo semantics (Chromium,**
`input-focused undo and redo keep the same cell input alive`**)**:

| Step | Document bytes |
| --- | --- |
| original | `A\|  B\n:-----\|---:\nC \| D\n\ntail` |
| after typing `X` in cell (0,0) | `\| X \| B \|\n\| :--- \| ---: \|\n\| C \| D \|\n\ntail` |
| after a >500 ms gap, typing `Y` | `\| XY \| B \|\n\| :--- \| ---: \|\n\| C \| D \|\n\ntail` |
| one `Mod-z` | back to `\| X \| B \|…`, same input node still focused, `input.value === "X"` |
| `Mod-Shift-z` | back to `\| XY \| B \|…`, same input, `input.value === "XY"` |

One undo of the *first* edit restores the byte-identical, non-canonical original — the
normalization text and the cell value travel in the same transaction, so there is no second history
event to undo. `redo` restores the normalized edited table, never the pre-normalization spelling.

**Default-off behavior:**

- **Unit** — `keeps the default source entry when the experiment is off`: without
  `experimentalTableDirectEdit`, a cell `mousedown` still enters plain source and no
  `.omd-table-cell-input` exists.
- **Chromium** — `the default harness URL still enters source instead of opening an input`: without
  `?tableDirectEdit=1`, clicking a cell yields 3 `.omd-table-src` blocks, 0 cell inputs, and
  unchanged bytes.
- The flag is read through a `Facet` supplied at assembly (`state.facet(tableDirectEditEnabled)` in
  `blocks.ts`); no default widget consults process-global mutable state.

**Stale-range / selection cleanup (Unit):**

| Case | Result |
| --- | --- |
| session maps through an unrelated shift and closes once the table is gone | `getTableEditSession → null`, document untouched |
| change before the table | target `tableFrom`/`tableTo` map correctly; input continues to edit the right cell (also Chromium: `inserting before the table does not redirect the active cell edit`) |
| external edit mutating the table source | session closes |
| stale target (source mismatch / out-of-range) | `tableCellInputSpec` returns `null`; no transaction |
| outer selection moves into/overlapping the active table | selection-only transaction clears the session in the `StateField` (widget lifecycle does not own cleanup) |
| undo/redo after an explicit `closeTableEdit()` | document history works, session stays `null` — no resurrection |

## IME and History Evidence

**IME exactly-once (Chromium,**
`a composition sequence produces exactly one document transaction after compositionend`**)**:

| Event | `window.__docChangeCount` | Document |
| --- | --- | --- |
| `compositionstart` + `compositionupdate("にほん")` | `0` | original `\| A \| B \|…\| 2 \|…tail` |
| `compositionend("日本")` | `1` | `\| A \| B \|\n\| --- \| --- \|\n\| 日本 \| 2 \|\n\ntail` |
| trailing `input` (`inputType: "insertCompositionText"`) | `1` (unchanged) | unchanged |

Composition commits use `userEvent: "input.type.compose"`; per-character input uses
`userEvent: "input.type"`. No microtask-based suppression exists — the guard is derived only from
`InputEvent.isComposing` / `InputEvent.inputType`. **Unit** additionally proves a decoration refresh
during active composition keeps the same input node, draft, and selection, and still commits once
(`preserves the input across a decoration refresh while composing`).

**No inner history:** the nested input installs no `history()`; `Mod-z` / `Mod-Shift-z` in the input
invoke the outer view's `undo`/`redo` commands. Undo/redo of a table input carries a mapped
`restoreSession` effect supplied by CodeMirror's supported `invertedEffects` extension point, so the
pre-edit session is restored on undo and the post-edit session on redo while the input stays mounted,
focused, and re-synchronized from the restored cell.

**History-group boundaries:**

| Boundary | Evidence | Result |
| --- | --- | --- |
| same cell, input at 0 ms and 400 ms | Unit, `Transaction.time` annotations | one undo group |
| same cell, 600 ms gap | Unit + Chromium (600 ms wait) | new group; one undo reverts only the second edit |
| `Enter` | Unit, `closes the history group on Enter` | current group closed, same cell still active, no document change |
| cell switch (`Tab` to a real neighbour) | Chromium, `switching cells does not run a second whole-table normalization` | new group; first undo returns to the post-first-cell document, second undo returns to the original |
| `Tab` on the final cell (no neighbour) | Chromium, `Tab on the final cell closes the input history group` | group isolated anyway: undo returns `\| 1 \| 9 \|` while `input.value === "9"` |
| `Shift-Tab` on the first cell (no neighbour) | Chromium, `Shift-Tab on the first cell closes the input history group` | group isolated anyway: undo returns `\| X \| B \|` while `input.value === "X"` |
| `Escape` / `focusout` | Unit, `closes the session on Escape and restores the rendered cell` | session closed with `isolateHistory.of("after")`; committed edits stay |
| exact value after history replay | Unit, `syncs the live input to the exact restored cell after undo` | undoing `"X "` to `"X"` leaves `input.value === "X"` (exact, not trimmed) |

**Synchronous dispatch vs. the live input value (Chromium RED → green):** the last regression this
spike found was caught by the full E2E run at **71/72**. In
`switching cells does not run a second whole-table normalization`, typing `9 ` produced the correct
document bytes `| 9  |`, but `expect(await first.inputValue()).toBe("9 ")` failed: the `dispatch`
issued by the cell controller runs CodeMirror's widget `updateDOM` synchronously, still inside the
controller's own write, and the parser-trimmed cell value (`9`) was written back over the input.
The accepted fix is a local `TableInputController.committing` flag set around `view.dispatch` with
`try`/`finally`; `updateDOM` skips the parser-value write-back while that flag is set, and the
`finally` block then re-reads `getTableEditSession(view.state).revision`. Undo/redo stay exact
because history replay never runs through `commit()`, so the exact-value synchronization path still
applies (`syncs the live input to the exact restored cell after undo`).

**Outer-pipeline isolation (Unit + Chromium):** `TableWidget.ignoreEvent` rejects keyboard, input,
click, and composition events whose target is the active `.omd-table-cell-input`. With the outer
selection parked at offset `0` outside the table, `Backspace` and `Enter` inside the input leave the
document and `selection.main.head === 0` unchanged (`input Backspace and Enter cannot edit a parked
outer selection`). `Mod-z` is routed to the outer history — `routes Mod-z to the outer history`
(Unit).

## Ordered-List Isolation Evidence

Suppression is narrow and transaction-scoped: input transactions carry
`suppressOrderedRenumberForTableEdit`, and `orderedRenumber` additionally skips transactions that
replay `isTableSessionRestore(effect)`. There is no process-global suppression and no change to
ordinary source edits, preview-entry normalization, ordered-list commands, or safe-mode range
scanning.

**Unit** — `packages/engine/test/orderedRenumberSafeMode.test.ts` (19 tests total; the five
table-related cases below use a real `EditorView` and settle queued microtasks before asserting):

| Case | Policy | Result |
| --- | --- | --- |
| `keeps an ordered-list table marker unchanged through the first direct edit` | standard | marker byte-identical after the first whole-table normalization |
| `keeps an ordered-list table marker unchanged in safe mode too` | safe / windowed | same bytes |
| `leaves a stale ordered-list marker alone after a suppressed table edit` | standard | stale `7.` marker not rewritten to `2.` |
| `keeps a stale ordered-list marker unchanged when the table edit is undone` | standard | RED was `2. second`; now `7. second`, and the full document equals its original bytes |
| `keeps a stale ordered-list marker unchanged when the table edit is undone in safe mode` | safe / windowed | same as above |

**Chromium** — `a table inside an ordered-list item leaves its markers alone`: after typing `9`
into a cell of a table nested in item `1.` whose following item is `7.`, the document equals
`settled.replace("   | 1 | 2 |", "   | 1 | 9 |")`, still contains `2. second`, and never contains
`7. second`. Decoration-only rebuilds produce no document change, so one undo still removes exactly
the table edit.

## Heap Evidence

**Method (Heap):** `apps/desktop/e2e/table-direct-edit-memory.mjs` runs five fresh-page pairs with
alternating order, one fixed canonical fixture, identical GC (`HeapProfiler.collectGarbage` + 50 ms
settle) then `Runtime.getHeapUsage` at baseline, cumulative 100, 500, 1000 cycles, and after
`view.destroy()`. Control cycles use today's preview→source enter/exit; experiment cycles open the
cell input, commit one character, undo back to the byte-identical fixture (input must stay alive),
then `Escape`. The document is asserted equal to the fixture after every batch.

Per-run growth `usedSize1000 − usedSize100` (bytes, MiB):

| Pair | Order | Experiment | Control |
| ---: | --- | ---: | ---: |
| 1 | experiment → control | 566,576 (0.54) | 504,844 (0.48) |
| 2 | control → experiment | 567,604 (0.54) | 504,972 (0.48) |
| 3 | experiment → control | 567,632 (0.54) | 504,804 (0.48) |
| 4 | control → experiment | 567,628 (0.54) | 504,804 (0.48) |
| 5 | experiment → control | 568,412 (0.54) | 504,820 (0.48) |

Aggregates from the JSON `metrics` object: valid pairs **5**; control median **504,820 B
(0.48 MiB)**; experiment median **567,628 B (0.54 MiB)**; experiment max **568,412 B (0.54 MiB)**;
experiment − control median delta **62,808 B (0.06 MiB)**.

Sampled `usedMB` (all five pairs, both modes): baseline 6.58 → 100 cycles 7.74 exp / 7.61 control →
500 cycles 8.17 / 8.00 → 1000 cycles 8.28 / 8.09 → after destroy 8.27 / 8.08. `inputCount` and
`controllerCount` are `0` at **every** sample in both modes, and `docEqualsFixture` is `true` at
every live sample (`null` after destroy).

| Gate (literal, from JSON `gates`) | Limit | Measured | Result |
| --- | --- | --- | --- |
| `fiveValidPairs` | 5 valid pairs | 5 pairs, `discarded: []` | true |
| `experimentMedianAtMost32MiB` | ≤ 32 MiB | 0.54 MiB | true |
| `experimentMedianWithinControlMedianPlus8MiB` | ≤ control + 8 MiB (8.48 MiB) | 0.54 MiB | true |
| `everyExperimentRunAtMost64MiB` | ≤ 64 MiB per run | max 0.54 MiB | true |
| `afterDestroyZeroInputsAndControllers` | 0 inputs / 0 controllers, both modes | 0 / 0 in every run | true |

`failed: []` — the audit exited 0 and no pair was discarded.

Note the honest reading of these numbers: the experiment's 100→1000 growth is slightly *higher*
than the control's (0.06 MiB median delta, i.e. ~12%), which is the cost of keeping one table widget
mounted with an input host across undo cycles rather than unmounting it. Both are far inside the
32 MiB / +8 MiB / 64 MiB gates, and nothing is retained after destroy.

## Failed Cases

Recorded failures during this spike, in order:

1. **4 focused engine failures** (before the fix): cross-cell whole-table normalization, zombie
   session after the outer selection entered the table, and stale ordered-marker renumbering on undo
   in both standard and safe modes — exact assertions in the [Source and Transaction
   Evidence](#source-and-transaction-evidence) RED table.
2. **5 focused Chromium failures** (before the fix): input destroyed on `Mod-z`, second cross-cell
   normalization, missing final-cell `Tab` history boundary, missing first-cell `Shift-Tab` history
   boundary, and malformed `|9  | 2 |` after clearing a cell to empty.
3. **1 follow-up Unit failure** found by the history-sync task:
   `syncs the live input to the exact restored cell after undo` — `expected 'X ' to be 'X'`. Undoing
   a whitespace-only history change left the draft at `"X "` because `updateDOM` only re-synchronized
   when `input.value.trim() !== source.trim()`. Fixed by comparing exact values once the session
   revision already proves history moved the document.
4. **1 full-suite Chromium failure found last** (`71/72`): typed trailing whitespace survived in the
   document but not in the input, because the synchronous `updateDOM` triggered by the controller's
   own `dispatch` wrote the parser-trimmed value back. Fixed by the local
   `TableInputController.committing` guard (`try`/`finally`), not by any change to the document
   transaction; the same E2E test now passes and the document bytes were never wrong.
5. **No audit-triggered failure remained:** the five-pair heap run has `discarded: []`,
   `failed: []`, and every gate `true`. No correctness test was skipped, quarantined, or loosened to
   reach green; the RED assertions listed above are the ones that now pass.

Not measured, recorded as such rather than filled: no accessibility, multi-cursor, row/column
mutation, or paste evidence — those are outside the spike's prototype boundary, not failures.

## Decision

Applying the Spike 1 gate literally:

| Gate | Evidence | Result |
| --- | --- | --- |
| one click enters the cell; printable input changes only the intended table | Chromium `one click opens exactly one cell input…`, `typing only changes the target table` | pass |
| Chinese IME commits exactly once at `compositionend` | Chromium doc-change count `0 → 1 → 1`; Unit composition tests | pass |
| one undo of the first edit restores byte-identical original bytes, including the list marker | Chromium undo/redo test; Unit `normalizes the whole table once on the first input`; ordered-list undo tests (standard + safe) | pass |
| a table edit produces no follow-up ordered-marker rewrite | 5 ordered-list Unit cases + Chromium ordered-list test | pass |
| same-cell input inside `newGroupDelay` groups; delay expiry, cell navigation, `Enter`, `Tab`/`Shift-Tab` boundaries start new groups; no inner history | Unit grouping tests + 4 Chromium boundary tests | pass |
| moving the table before a cell edit does not corrupt another range | Chromium `inserting before the table does not redirect the active cell edit`; Unit mapped-target tests | pass |
| stale source closes the session and leaves the document unchanged | Unit stale-target / external-edit / table-gone / selection-into-table tests | pass |
| decoration rebuild during composition preserves the draft and commits once | Unit `preserves the input across a decoration refresh while composing` | pass |
| five paired heap runs: median growth ≤ 32 MiB, ≤ control + 8 MiB, no run > 64 MiB | 0.54 / 8.48 / 0.54 MiB against 32 / 8 / 64 | pass |
| after close + `view.destroy()`, inputs and controllers return to control count | 0 / 0 at every sample, both modes | pass |

**Decision: Go**

Scope of that `Go`: **the experimental spike only.** It means the third presentation state
(mounted widget + one ephemeral input whose edits are ordinary outer transactions) is technically
viable under the gates above. It does **not** approve production table direct editing, does not
revise `packages/engine/AGENTS.md` invariant 12, does not revise the table gotchas or superseded
table specs, and does not change shipped table UX. Production work remains **blocked** until a new
approved table design explicitly revises invariant 12 and incorporates this spike's history, session,
IME, and memory evidence.

## Production Recommendation

Do not promote code from this spike as-is. The next step is a separate approved design that:

- explicitly replaces invariant 12 with the three-state rule this spike proved (rendered widget /
  direct cell edit / explicit whole-table source), updates `docs/memory/known-traps` table entries and
  reconciles `2026-08-16-15-table-editing.md` with `2026-10-21-table-source-editing.md`;
- decides how row/column operations, resize, paste, accessibility, and the explicit source route
  coexist with an active cell session (all out of scope here);
- makes the session/history contract a supported, documented engine surface instead of an
  experimental flag: the `invertedEffects` provider, the mapped `restoreSession` effect,
  `isolateHistory` boundaries, and the "selection into the table closes the session" rule are the
  load-bearing parts — dropping any one of them reintroduces a recorded RED failure;
- keeps the whole-table normalization rule explicit (first real input only, same outer transaction,
  undo restores exact bytes) and states the ordered-renumber suppression as a transaction annotation,
  never as global suppression;
- replaces the spike's test-only hooks (`activeTableInputControllerCountForTest`,
  `window.__tableDirectEditAudit`) with a production-appropriate memory/regression check, and keeps
  the paired heap audit as release evidence for the real editor, not only the harness;
- re-runs the five-pair heap audit against the production wiring, because this audit measured the
  harness page and not the full desktop app shell.

## Prototype Files: Keep, Rewrite, Delete

| File | Action | Why |
| --- | --- | --- |
| `packages/engine/src/tables/directEdit.ts` | **Keep (rewrite for production)** | Holds the whole proven contract: session `StateField`, `initial`/retarget rules, `isolateNext`, `restoreSession` + `invertedEffects` provider, `suppressOrderedRenumberForTableEdit`, and the validated transaction builder. Keep the semantics; re-cut the public surface (no barrel export of field/effects) during the production design. |
| `packages/engine/src/tables/normalize.ts` | **Keep** | Deterministic reserialization from `TableData` ranges, CRLF/prefix preservation, escaped-value handling, and `null` on stale/ragged/out-of-range input. Production-ready as the first-edit normalizer. |
| `packages/engine/src/decorations/widgets/table.ts` | **Rewrite** | The controller ownership, `WeakMap` binding, `ignoreEvent` boundary, navigation/history-boundary handling, and history value sync are the value; the `tableDirectEditEnabled` `Facet`, the `activeTableInputControllerCountForTest` counter, and the spike-only CSS class wiring are experimental scaffolding. |
| `packages/engine/src/tables/model.ts` (empty-cell insertion point) | **Keep** | Inserting after the first boundary space is the fix for `\|9  \|`; it is a correctness fix to canonical empty cells, not spike cruft. |
| `packages/engine/src/tables/edit.ts` (`tableSourceMatches` export + line-break-aware row bounds) | **Keep** | Shared validator reused by `normalize.ts`; the line-break fix keeps CRLF tables valid for `deleteTableRow`. |
| `packages/engine/src/lists/ordered.ts` (annotation-scoped skip) | **Keep** | Two narrow conditions (`suppressOrderedRenumberForTableEdit`, `isTableSessionRestore`); no global suppression, ordinary renumbering untouched. |
| `packages/engine/src/decorations/blocks.ts` (flag passthrough) | **Rewrite** | Only job today is passing the experimental `Facet` into `TableWidget`; becomes a normal assembly input once the feature is real, or disappears if the experiment stops. |
| `packages/engine/src/index.ts` (`experimentalTableDirectEdit` option) | **Rewrite** | Correctly experimental (no internals exported), but the option and the `tableDirectEditEnabled` mount are not a production API shape. |
| `packages/engine/test/tableDirectEdit.test.ts` | **Keep** | 25 state/transaction/history/DOM tests including the audited REDs (cell retarget, selection cleanup, history replay, exact value sync, synchronous-commit guard, Enter/`Tab`/`Escape`). |
| `packages/engine/test/tableNormalize.test.ts` | **Keep** | 14 tests over the source-shape matrix plus rejection cases. |
| `packages/engine/test/tableUpdateDOM.test.ts`, `test/orderedRenumberSafeMode.test.ts` (added cases) | **Keep** | Widget rotation/controller-count assertions and the standard+safe stale-marker undo cases. |
| `apps/desktop/src/Editor.ts` + `apps/desktop/e2e/harness.ts` (`?tableDirectEdit=1`, `?tableMemorySpike=1`, `window.__tableDirectEditAudit`) | **Rewrite** | **The internal harness hook is spike evidence, not production API.** `__tableDirectEditAudit` and the `tableMemorySpike` query gate exist only to drive paired heap sampling; production needs a real regression path. |
| `apps/desktop/e2e/table-direct-edit-spike.spec.ts` | **Keep** | The 12 Chromium tests (13 scenarios) are the interaction contract (default-off, IME, undo/redo, boundaries, ordered list, position shift, trailing-whitespace input value). |
| `apps/desktop/e2e/table-direct-edit-memory.mjs` + `audit:table-direct-edit-spike` script | **Keep (manual tooling)** | **One-off audit script, not production API**; paired GC'd CDP sampling with literal gates. Keep it out of CI like the other audits and re-run it against production wiring. |
| `apps/desktop/src/styles.css` (`.omd-table-cell-input`) | **Rewrite** | Deliberately minimal (fill the cell, inherit font/color, no vertical margin). Production needs real focus/selection/accessibility styling. |
| `docs/superpowers/plans/2026-10-28-table-direct-editing-spike.md` | **Keep** | Historical plan; this report is its outcome. |

**Decision: Go** — experimental spike only; production table direct editing stays blocked until a
new approved design revises invariant 12.
