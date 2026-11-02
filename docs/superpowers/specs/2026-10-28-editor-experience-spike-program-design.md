# Editor Experience Spike Program Design

## Status

Proposed for review. This document defines three feasibility spikes only. It does not approve production implementation of table direct editing, a replacement search subsystem, or a new large-document policy.

## Purpose

The editor-experience roadmap depends on three architectural claims that are not yet proven in this repository:

1. A rendered table cell can host direct editing without creating a second document authority, a second undo history, IME corruption, or unbounded widget retention.
2. Current-document search can operate directly on CodeMirror `Text` with bounded main-thread work at 100 MiB scale, including a safe policy for regular expressions.
3. Large-document rendering policy can be owned per `EditorView` without process-global leakage, feature flicker, or semantic drift between tabs.

Each spike must answer one claim with measured evidence. A successful spike produces a recommendation and a production design delta. Prototype code is disposable unless a later, separately approved implementation plan explicitly promotes a small, reviewed portion.

## Shared Architectural Invariants

- `EditorState.doc` is the sole authority after an editor view is mounted.
- A spike may mirror or snapshot text for measurement, but the copy is never writable authority and every result is revision-tagged.
- Markdown semantics stay in `packages/engine`; React and Tauri must not be imported there.
- Generic CodeMirror search orchestration stays in `apps/desktop/src`; it must not re-parse Markdown.
- Native filesystem effects stay in `apps/desktop/src-tauri` and are out of scope for these three spikes.
- No spike may change the saved Markdown format, autosave behavior, recovery protocol, or guarded-save contract.
- No spike may silently rewrite source text. Spike 1 is the only explicit exception under test: after the user makes the first cell edit, that one table may be normalized in the same outer transaction. Opening, focusing, or navigating the table never rewrites it, and undo must restore the exact pre-edit bytes.
- Every experiment is bounded. No busy loops, load generators, or unbounded churn are permitted.
- Timing evidence is advisory and must record hardware, OS, browser engine, fixture shape, warm-up, sample count, p50, p95, and peak observed value.
- Heap evidence must use explicit garbage collection in a real Chromium E2E harness; happy-dom heap growth is not sufficient evidence.
- Every spike ends in exactly one decision: `Go`, `Revise`, or `Stop`.

## Program Structure

The spikes are independent subprojects with separate plans and review gates:

1. **Table Direct-Editing Feasibility**
2. **100 MiB Search Feasibility**
3. **Per-Editor Performance Policy Feasibility**

They may be executed in any order, but production table work cannot start until the widget-memory gate in Spike 1 is resolved. No result from one spike may silently broaden another spike's scope.

## Spike 1: Table Direct-Editing Feasibility

### Architectural Conflict Under Test

The current production architecture deliberately has exactly two table states: a rendered `TableWidget` while the caret is outside, and plain source lines while the caret is inside. `packages/engine/AGENTS.md` invariant 12, the table gotchas, and `2026-10-21-table-source-editing.md` prohibit an in-cell `<input>` because the removed implementation created independent commit, cancel, pending-focus, undo, find, and autosave behavior. That current rule supersedes the older in-cell direction in `2026-08-16-15-table-editing-design.md` and `2026-08-31-table-editing-reliability-design.md`.

This spike deliberately challenges that prohibition; it is not compatible with the current invariant by default. A `Go` means only that a stricter third presentation state is technically viable: clicking a rendered cell may enter direct cell editing, every durable edit still enters the outer document transaction stream immediately (or once at IME `compositionend`), and the explicit whole-table source route remains available. Before production work, a separately approved design must explicitly replace invariant 12, update the table gotchas, reconcile the superseded table specs, and define how row/column operations coexist with direct editing. Without that follow-up decision, the production two-state architecture remains authoritative.

### Question

Can OMD keep the rendered table mounted while one cell is edited through a single ephemeral input surface, with all durable changes committed to the outer `EditorView` transaction stream?

### Hypothesis

A thin table-edit session can reuse the existing `TableData`, cell ranges, `TableWidget.updateDOM`, and outer history. The input surface has no history and no durable document state. The first actual edit intentionally normalizes the entire target table and applies the cell input in one outer transaction; later plain-text edits patch only the active cell range.

### Prototype Boundary

The prototype supports only:

- one active table at a time;
- one active cell at a time;
- 2×2 GFM tables from the source-shape matrix below;
- plain text plus escaped `|` input;
- mouse activation, `Tab`, `Shift-Tab`, `Escape`, and outer undo/redo;
- Chinese IME composition;
- edits before the table that move its absolute position.

The prototype does not support row/column mutation, rectangular selection, CSV/TSV paste, inline live-preview styling inside the cell, column resizing, multi-cursor, accessibility polish, or production toolbar integration.

### Source-Shape Matrix

Every interaction and undo assertion runs against deterministic 2×2 fixtures covering:

| Fixture | Required source property |
|---|---|
| `canonical` | leading/trailing pipes, one boundary space, `---` delimiter |
| `no-outer-pipes` | neither leading nor trailing pipe |
| `irregular-spacing` | zero, one, and multiple boundary spaces across cells |
| `alignment` | `:---`, `---:`, and `:---:` markers with non-canonical hyphen counts |
| `escaped-pipe` | an untouched cell containing `\|` |
| `ordered-list` | the table is parsed inside an ordered-list item whose marker would otherwise be eligible for automatic renumbering |

The spike asserts semantic cell content and alignment before and after normalization. It also asserts the exact source bytes before edit, after edit, after undo, and after redo. The `ordered-list` case runs with safe-mode windowing both off and on because ordered-marker follow-up scanning takes different paths.

### Session Contract Under Test

```ts
interface TableEditTarget {
  readonly tableFrom: number
  readonly tableTo: number
  readonly row: number
  readonly column: number
  readonly source: string
}

interface TableEditSession {
  readonly target: TableEditTarget
  readonly revision: number
  readonly composing: boolean
  readonly hasCommittedInput: boolean
}
```

- The session is a CodeMirror state value, not a mutable property on `TableWidget`.
- The table decoration remains mounted because session state, not the outer selection, owns the editing state.
- The only uncommitted text permitted is the browser composition draft while `composing === true`.
- `hasCommittedInput` is false until the first document-changing input transaction succeeds; that transaction performs whole-table normalization. Later input transactions must use range-based cell replacement and never normalize the table again.
- That draft has one owner: the live input DOM host, referenced through a DOM-attached controller or module-local `WeakMap`, following the existing math-popup ownership pattern. It is never stored on a `TableWidget` instance and is never duplicated into another mutable model.
- `TableWidget.updateDOM` must rebind the reused DOM host to the new widget owner without replacing the active input. A decoration refresh during composition must preserve the same input node, draft, selection, and composition lifecycle; inability to do so is a failed feasibility result, not a reason to add widget-instance state.
- `TableWidget.ignoreEvent` owns the nested-input boundary: keyboard, input, and composition events from the live cell input must not reach CodeMirror's outer keymaps or input handlers. The input controller may translate only its explicitly supported actions into outer transactions.
- `compositionend` produces one outer transaction. Chromium's trailing `input` with `inputType === "insertCompositionText"` must not produce a second transaction; the input handler ignores events whose `isComposing` flag is true or whose `inputType` is `insertCompositionText`.
- Non-composition input produces an outer transaction immediately. No microtask-based event suppression is permitted.
- Plain typing transactions use the joinable `input.type` user event. Composition commits use `input.type.compose`. Consecutive edits in the same cell may form one outer-history group only while they remain within the configured history `newGroupDelay` (currently CodeMirror's 500 ms default) and satisfy CodeMirror's adjacency rule.
- Enter, `Tab`, `Shift-Tab`, `Escape`, or activating another cell closes the current history group before any edit in the new cell. An input after `newGroupDelay` starts a new group. These boundaries are expected behavior and are asserted explicitly; "no inner history" alone is not sufficient evidence.
- The inner surface does not install `history()`.
- Undo and redo commands invoke the outer view.
- Every write validates the live table range and the expected table source. A mismatch closes the session without dispatching a document change.

### Source-Normalization Rule Under Test

The spike uses one deterministic table spelling:

```md
| A | B |
| --- | --- |
| C | D |
```

- leading and trailing pipes are present;
- each cell has one boundary space;
- delimiter cells use three hyphens plus optional alignment colons;
- source width does not follow rendered width;
- literal pipes are escaped;
- normalization intentionally rewrites pipe presence, boundary spacing, and delimiter spelling across the edited table, including cells the user did not open;
- cell content, escaped pipes, alignment meaning, line endings, and any quote/list continuation prefix remain semantically unchanged;
- normalization is limited to the edited table;
- opening or focusing a cell does not normalize;
- the first real input and normalization are one dispatched, undoable outer transaction. CodeMirror's inverse of that transaction must restore the byte-identical pre-edit table; redo must restore the normalized edited table. Normalization must not be dispatched as a separate history event.
- that first transaction must not cause `orderedRenumber` to dispatch an additional marker rewrite merely because the table is inside an ordered-list item. If isolation requires a narrow transaction annotation, the spike must prototype and report it; process-global suppression is forbidden.

### Evidence

The spike must produce:

- real-`EditorView` tests for transaction, undo, history-group boundaries, stale-range, composition behavior, and ordered-list interaction with safe-mode windowing both off and on;
- one real Chromium interaction script using the existing E2E harness;
- five paired Chromium heap runs, each in a fresh page, comparing the current preview/source enter-exit control with the direct-edit experiment at baseline, 100, 500, and 1000 cycles; order alternates between runs, explicit GC is applied identically, and only one run may be discarded for a recorded harness failure;
- a result report containing source before/after, transaction count, undo behavior, heap samples, and observed failures.

### Decision Gate

`Go` requires all of the following:

- one click enters the cell and printable input updates only the intended table;
- Chinese IME input commits exactly once at `compositionend`;
- one undo of the first edit restores the byte-identical original document, including the containing ordered-list marker;
- a table edit does not produce a follow-up ordered-marker rewrite; transaction evidence distinguishes the table edit, decoration-only work, and any document-changing follow-up;
- same-cell input inside `newGroupDelay` forms one outer-history group; input after the delay or after cell navigation forms a new group; no inner history exists;
- moving the table before a cell edit does not corrupt another range;
- stale source closes the session and leaves the document unchanged;
- a decoration rebuild during active composition preserves the same draft and commits it exactly once;
- across the five paired heap runs, median experimental growth from 100 to 1000 cycles is at most 32 MiB, is no more than 8 MiB above the control median, and no run exceeds 64 MiB growth;
- after closing the session and destroying the outer view, live input hosts, DOM listeners, and table-edit controllers return to the control count.

`Revise` applies when correctness passes but heap, focus, or IME evidence fails with an identifiable OMD-owned cause. The result must name the cause and propose one smaller follow-up spike.

`Stop` applies when correct behavior requires independent durable cell state, independent history, whole-table replacement on every keystroke, or changes to CodeMirror internals.

## Spike 2: 100 MiB Search Feasibility

### Question

Can current-document navigation and bounded match counting operate over CodeMirror `Text` without `doc.toString()`, full match materialization, or unacceptable main-thread stalls at 100 MiB?

### Hypothesis

Literal navigation can use `SearchCursor` directly over `Text` and stop at the first result. Counting can retain a cursor across short scheduled slices and stop at a display cap. Regular-expression policy needs separate evidence because JavaScript regex execution is not preemptible on the main thread.

### Fixture Matrix

The benchmark generator creates deterministic fixtures without committing large files:

| Fixture | Size | Shape |
|---|---:|---|
| `normal-10m` | 10 MiB | short Markdown paragraphs, one hit every 64 KiB |
| `normal-100m` | 100 MiB | same distribution |
| `dense-100m` | 100 MiB | one short literal hit every 128 bytes |
| `long-line-20m` | 20 MiB | one logical line, sparse hits |
| `unicode-100m` | 100 MiB | CJK and emoji around sparse hits |

Fixtures are built directly as CodeMirror `Text` in bounded chunks. The timed path must not build or stringify the fixture.

### Prototype Boundary

The prototype measures and semantically validates:

- literal next/previous navigation with wrapping;
- case-sensitive and case-insensitive literal matching;
- whole-word matching with the current ASCII-boundary/CJK behavior;
- cancellable counting capped at 10,000 matches;
- document revision invalidation;
- viewport-range match enumeration;
- active-match behavior after query changes, document edits, wrap-around, and truncated counts;
- current-match replacement for literal and regular-expression queries;
- replace-all construction on bounded semantic fixtures without using the display-count cap as the replacement limit;
- invalid-regex reporting with navigation and replacement disabled;
- regex navigation on normal input;
- one deliberately pathological regex executed in a disposable Worker to prove that cancellation can terminate the worker.

It does not implement the production React find bar, workspace search, persistent worker mirrors, or Rust search. It prototypes replacement semantics only far enough to prove that the new search kernel can preserve the delivered find/replace contract; production UI and large-document replace-all policy remain a follow-up design decision.

### Search Contract Under Test

```ts
interface SearchRequest {
  readonly query: string
  readonly caseSensitive: boolean
  readonly regexp: boolean
  readonly wholeWord: boolean
  readonly revision: number
}

interface SearchCount {
  readonly count: number
  readonly complete: boolean
  readonly revision: number
}

interface SearchMatch {
  readonly from: number
  readonly to: number
  readonly revision: number
}
```

- Literal navigation consumes `Text` directly.
- Navigation does not depend on a completed count.
- Previous navigation starts with the 256 KiB range immediately before the anchor and doubles that backward window only when no match is present. It applies the same strategy from the document end for wrap; it must not scan `[0, anchor)` on every invocation merely to emulate a missing reverse-cursor API.
- Counting yields after a maximum 4 ms scheduling budget per slice.
- Count storage is O(1); matches are not accumulated.
- Counting stops at 10,000 and reports `complete: false`.
- A new request or document revision cancels the old scheduled task.
- Navigation and replace-current operate on `SearchMatch`, never on a numeric index into a completed match array.
- Changing the query invalidates the prior active match and deterministically searches from the current editor selection; count completion or truncation cannot change that match.
- Whole-word behavior remains compatible with the delivered contract: ASCII word edges use word boundaries, while CJK queries are not rejected by adding `\b` around Han characters.
- Invalid regex syntax produces the existing visible error state and yields no navigation or replacement transaction.
- Literal replacement treats replacement text literally; regex replacement preserves capture expansion such as `$1`.
- Replace-all performs its own revision-tagged scan and is atomic when dispatched. The 10,000 display-count cap never means "replace only 10,000". If an exact, bounded 100 MiB replace-all cannot be demonstrated, the result must recommend an explicit large-document availability rule rather than silently changing semantics.
- Worker regex results are accepted only when their revision still matches.
- The main thread never attempts to enforce a regex timeout around synchronous `RegExp` execution.

### Evidence

The spike must record:

- construction time outside the timed search path;
- first-hit latency at start, middle, end, and wrap-around;
- count completion or capped-count time;
- maximum observed slice duration;
- cancellation latency after query change;
- peak heap before and after dense counting;
- parity results against the current search tests for next/previous wrapping, query reset, ASCII/CJK whole-word behavior, invalid regex, literal replacement, regex captures, and replace-all;
- behavior of navigation and replace-current while count is pending and while it is capped;
- whether Worker termination stops the pathological regex without affecting the editor view.

### Decision Gate

`Go` requires:

- no timed search path calls `Text.toString`, `sliceString(0, doc.length)`, or builds a full match array;
- sparse literal first-hit p95 is at most 100 ms on `normal-100m` when the hit is within the next 1 MiB;
- worst observed count slice is at most 12 ms after warm-up;
- query cancellation is observed before any stale count is published;
- current match, next/previous wrapping, replace-current, and query-reset behavior are correct while count is pending or capped;
- bounded semantic fixtures preserve the current ASCII/CJK whole-word behavior, invalid-regex error behavior, literal replacement, regex capture replacement, and exact replace-all results;
- replace-all either produces one revision-validated outer transaction without using the display-count cap, or the result identifies a user-visible large-document restriction that requires separate product approval before migration;
- dense counting caps at 10,000 with bounded heap growth below 32 MiB over the baseline search harness;
- the long-line fixture remains responsive and produces the correct offsets;
- the pathological regex is isolated to a Worker and can be terminated.

`Revise` applies when literal search passes but regex isolation or scheduling misses the gate. The production recommendation must then ship literal search first and keep large-document regex disabled.

`Stop` applies when literal navigation requires full string materialization or retained match arrays at the target size.

## Spike 3: Per-Editor Performance Policy Feasibility

### Question

Can safe-mode rendering policy move from process-global mutable variables to an editor-local CodeMirror configuration without changing normal rendering semantics or leaking policy between tabs?

### Hypothesis

An editor-local `Facet` supplies the configured capability profile, and a `StateField` or compartment reconfiguration carries policy changes through normal CodeMirror transactions. Existing rendering code reads policy from `EditorState` rather than module globals.

### Prototype Boundary

The prototype covers only the two existing global rendering controls:

- safe-mode windowed live decorations;
- block render budget lines.

It uses two simultaneous real `EditorView` instances:

- View A: standard profile, full pending drain and unlimited block render budget.
- View B: performance profile, windowed decorations and bounded block render budget.

It does not redesign threshold calculation, disable table/math/Mermaid features, change open tiers, remove the 50 MiB read-only tier, or add adaptive runtime heuristics.

### Policy Contract Under Test

```ts
interface EditorPerformancePolicy {
  readonly windowLiveDecorations: boolean
  readonly blockRenderBudgetLines: number | null
}
```

- Policy is read from `EditorState`.
- `blockRenderBudgetLines: null` means unlimited and is the explicit representation of the current `Infinity` default; a number must be finite and non-negative.
- Every `EditorView` participating in the editor-local experiment has an explicit policy and does not consult the process-global fallback after state creation. Unmodified production assembly keeps the legacy global path only as the paired control for this spike.
- Reconfiguration is a CodeMirror transaction and does not recreate the view.
- A policy change schedules the minimum required decoration rebuild or prune.
- A standard→windowed transition cancels any in-flight standard-mode idle callback, clears the driver's idle-scheduled state, marks the window dirty, and re-arms the first pass so pruning cannot be skipped when the new window contains no pending build range.
- Changing View B cannot alter View A's pending decorations, rendered widgets, or budget.
- Source bytes remain identical under both profiles.
- After test-only pending drain, normal-profile decorations remain set-equivalent to the current default behavior.
- Performance-profile decorations and pending ranges remain equivalent to current safe-mode behavior only for the same document, selection, visible ranges, build window, prune window, and scheduler checkpoint; no full-document decoration equivalence is claimed for a windowed profile.

### Evidence

The spike must produce:

- unit tests with two simultaneous states;
- real-view tests with two simultaneous DOM editors;
- a parity comparison against the existing global implementation before its experimental replacement;
- a bounded tab-switch stress test that alternates policy 100 times;
- paired timing for policy reconfiguration and first viewport-ready render under the current global control and the editor-local experiment, including p50, p95, peak, and individual main-thread task duration;
- a result report listing every production read of `safeModeRenderingEnabled`, `blockRenderBudget`, or equivalent global state that would require migration.

### Decision Gate

`Go` requires:

- View A and View B maintain independent policies in the same process;
- 100 policy alternations do not recreate either `EditorView`;
- normal parity passes after complete test drain, and performance parity passes at matched viewport, scroll position, and scheduler checkpoint;
- one view's reconfiguration produces no transaction, decoration, or DOM change in the other view;
- the synchronous policy-reconfiguration transaction p95 is at most 16 ms for a 10,000-line fixture;
- viewport-ready latency is recorded but has no absolute 50 ms gate because the current driver intentionally spreads work across a microtask and idle slices. In paired runs, the editor-local p95 must be no worse than the global-control p95 by more than the larger of 5 ms or 10%; background work outside the build window is excluded from both measurements;
- no individual main-thread task exceeds 50 ms in the experimental path;
- the experimental API needs no React, Tauri, or module-global mutation in `packages/engine`.

`Revise` applies when isolation works but parity requires a more explicit effect or compartment boundary. The result must identify the smallest additional state primitive.

`Stop` applies when windowing and budget ownership cannot be expressed per state without duplicating the decoration pipeline or recreating editor views.

## Result Reports

Each spike produces one report beside its implementation plan:

```text
docs/superpowers/plans/2026-10-28-table-direct-editing-spike-results.md
docs/superpowers/plans/2026-10-28-search-100m-spike-results.md
docs/superpowers/plans/2026-10-28-per-editor-policy-spike-results.md
```

Reports must contain:

1. environment and commit;
2. exact commands;
3. evidence table;
4. failed cases;
5. `Go`, `Revise`, or `Stop`;
6. production recommendation;
7. prototype files to keep, rewrite, or delete.

An implementation plan may create the empty report with its final headings, but it must not preselect the decision.

## Program Exit

The program is complete when all three reports exist and each has a reviewed decision. No production roadmap may claim table direct editing, 100 MiB search, or per-editor policy as approved until its corresponding result is `Go` and a separate production design spec incorporates the evidence.
