# Per-Editor Performance Policy Feasibility Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that live-decoration windowing and block-render budget can be configured independently per `EditorView` without recreating views, leaking policy between tabs, or changing current normal/safe-mode rendering semantics.

**Architecture:** Introduce an experimental editor-local policy Facet mounted through a CodeMirror Compartment. Rendering code reads a single resolver that prefers an explicit local policy and otherwise falls back to the current process-global controls, preserving production behavior during the spike. Tests compare the local path with the existing global control before any production migration is proposed.

**Tech Stack:** TypeScript, CodeMirror 6 Facet/Compartment/StateEffect, existing live-preview StateField/ViewPlugin pipeline, Vitest + happy-dom, Playwright Chromium performance instrumentation.

**Spec:** `docs/superpowers/specs/2026-10-28-editor-experience-spike-program-design.md`

## Global Constraints

- The spike covers only windowed live decorations and block render budget.
- `blockRenderBudgetLines: null` means unlimited; numeric values must be finite and non-negative.
- The experimental setter may dispatch only to the supplied view; it must not mutate module-global policy.
- Default production assembly continues to use the current globals until a later approved migration plan.
- Policy reconfiguration must not recreate `EditorView`, reset document/history/selection, or change another view.
- Normal-profile parity is compared after complete test-only drain. Performance-profile parity is compared only at the same document, selection, visible ranges, build/prune windows, and scheduler checkpoint.
- Synchronous reconfiguration p95 must be ≤ 16 ms on the 10,000-line fixture.
- Viewport-ready latency has no absolute 50 ms gate; the local path may not regress beyond the larger of 5 ms or 10% versus the global control. No experimental main-thread task may exceed 50 ms.
- Do not commit during execution unless the user separately authorizes commits.

---

## File Structure

- Create `packages/engine/src/performancePolicy.ts` — policy types, validation, Facet, Compartment, resolver, and per-view reconfiguration API.
- Create `packages/engine/src/performancePolicyDiagnostics.ts` — experimental read-only diagnostics for parity/E2E evidence without desktop imports of engine internals.
- Modify `packages/engine/src/index.ts` — mount the policy compartment and export the experimental setter/types.
- Modify `packages/engine/src/safeModeRendering.ts` — keep legacy globals as control/fallback only.
- Modify `packages/engine/src/decorations/renderBudget.ts` — resolve budget from each view state.
- Modify `packages/engine/src/decorations/buildDriver.ts` — resolve windowing from each view state and react to policy reconfiguration.
- Modify `packages/engine/src/lists/ordered.ts` — use editor-local windowing for ordered-list scan ranges.
- Create `packages/engine/test/performancePolicy.test.ts` — policy validation, state isolation, and reconfiguration.
- Modify `packages/engine/test/renderBudget.test.ts` — two-view budget isolation/parity.
- Modify `packages/engine/test/safeModeWindow.test.ts` — local/global windowing parity and transitions.
- Modify `packages/engine/test/orderedRenumberSafeMode.test.ts` — per-view ordered-scan isolation.
- Create `packages/engine/bench/policy.bench.ts` — 10,000-line synchronous reconfiguration benchmark.
- Create `apps/desktop/e2e/per-editor-policy-harness.html` and `.ts` — two simultaneous real DOM editors plus diagnostics.
- Create `apps/desktop/e2e/per-editor-policy-spike.spec.ts` — Chromium isolation/parity checks.
- Create `apps/desktop/e2e/per-editor-policy-audit.mjs` — paired global/local viewport-ready and long-task measurements.
- Modify `apps/desktop/package.json` — audit command only.
- Create `docs/superpowers/plans/2026-10-28-per-editor-policy-spike-results.md` — evidence, migration inventory, and decision.

### Task 1: Policy Type, Validation, and Reconfiguration

**Files:**
- Create: `packages/engine/src/performancePolicy.ts`
- Modify: `packages/engine/src/index.ts`
- Modify: `packages/engine/src/decorations/renderBudget.ts`
- Create: `packages/engine/test/performancePolicy.test.ts`

**Interfaces:**
- Produces:

```ts
export interface EditorPerformancePolicy {
  readonly windowLiveDecorations: boolean
  readonly blockRenderBudgetLines: number | null
}

export const STANDARD_PERFORMANCE_POLICY: EditorPerformancePolicy
export const SAFE_PERFORMANCE_POLICY: EditorPerformancePolicy
export const SAFE_MODE_RENDER_BUDGET_LINES: number
export function performancePolicyExtension(
  policy: EditorPerformancePolicy | null,
): Extension
export function editorPerformancePolicy(state: EditorState): EditorPerformancePolicy | null
export function setEditorPerformancePolicy(
  view: EditorView,
  policy: EditorPerformancePolicy,
): void
export function samePerformancePolicy(
  left: EditorPerformancePolicy | null,
  right: EditorPerformancePolicy | null,
): boolean
```

- `STANDARD_PERFORMANCE_POLICY = { windowLiveDecorations: false, blockRenderBudgetLines: null }`.
- `SAFE_PERFORMANCE_POLICY = { windowLiveDecorations: true, blockRenderBudgetLines: SAFE_MODE_RENDER_BUDGET_LINES }`.
- `null` from `editorPerformancePolicy` means legacy global fallback for the spike, not unlimited budget.

- [ ] **Step 1: Write failing policy tests**

Assert:

- standard and safe constants have exact values;
- negative, `NaN`, and infinite numeric budgets are rejected;
- two states can hold different policies;
- reconfiguring one real view changes only that view;
- document, selection, and undo depth survive reconfiguration;
- the `EditorView` object and DOM root identities remain unchanged through 100 alternations.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @omd/engine exec vitest run test/performancePolicy.test.ts`

Expected: FAIL because the policy module does not exist.

- [ ] **Step 3: Implement the Facet and Compartment**

Move `SAFE_MODE_RENDER_BUDGET_LINES = 60` from `decorations/renderBudget.ts` into `performancePolicy.ts`; re-export it through the existing engine barrel so desktop imports do not change. This keeps the dependency one-way when `renderBudget.ts` starts importing the policy resolver.

Define a Facet value of `EditorPerformancePolicy | null` with a combine function that rejects multiple non-null providers. Mount one module-level Compartment in `editorExtensions`; a Compartment is immutable configuration identity, not mutable policy state, and remains isolated per EditorState.

`setEditorPerformancePolicy` validates and dispatches only:

```ts
view.dispatch({
  effects: performancePolicyCompartment.reconfigure(
    performancePolicyFacet.of(policy),
  ),
})
```

Keep the default compartment value `null` so shipped behavior still uses the global control path during the spike.

- [ ] **Step 4: Export only the experimental host surface**

Export the policy type, constants, getter, and setter from `packages/engine/src/index.ts`. Do not export the Facet or Compartment.

- [ ] **Step 5: Run the focused test**

Run: `pnpm --filter @omd/engine exec vitest run test/performancePolicy.test.ts`

Expected: PASS, including 100 alternations with stable view/DOM identity.

- [ ] **Step 6: Review the task diff**

Run: `git diff --check && git diff -- packages/engine/src/performancePolicy.ts packages/engine/src/index.ts packages/engine/test/performancePolicy.test.ts`

Expected: no React/Tauri import and no mutable module-level policy value.

### Task 2: Per-View Block Render Budget

**Files:**
- Modify: `packages/engine/src/decorations/renderBudget.ts`
- Modify: `packages/engine/test/renderBudget.test.ts`
- Modify: `packages/engine/test/performancePolicy.test.ts`

**Interfaces:**
- Consumes: `editorPerformancePolicy(state)`.
- Produces:

```ts
export function blockRenderBudgetFor(state: EditorState): number | null
export function withinRenderBudget(view: EditorView, pos: number): boolean
```

- Existing `blockRenderBudget()` and `setBlockRenderBudget()` remain temporarily for the global control and production fallback.

- [ ] **Step 1: Write two-view failing tests**

Mount View A with standard local policy and View B with a four-line budget. Use marker widgets at known line distances. Assert A starts every render while B defers distant renders. Reconfigure B to unlimited and assert only B flushes its pending entries.

Also run the same fixture sequentially through the legacy global control and local policy; compare started marker positions exactly.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/renderBudget.test.ts test/performancePolicy.test.ts
```

Expected: new isolation tests FAIL because `withinRenderBudget` still reads the global variable.

- [ ] **Step 3: Implement per-state resolution**

`blockRenderBudgetFor(state)` returns the explicit local budget when a local policy exists; otherwise it maps legacy finite global values to numbers and legacy `Infinity` to `null`.

Update `withinRenderBudget` to treat `null` as unlimited. Keep the existing visible-range and no-layout rules unchanged.

- [ ] **Step 4: Flush on policy changes**

Extend `renderBudgetFlush` so an update whose resolved policy changed calls `flushDeferredBlockRenders`, even when it has no doc/selection/viewport change. Because each pending entry carries its own view, the global pending Set may remain as lifecycle storage; eligibility must be evaluated from `entry.view.state`.

- [ ] **Step 5: Run budget tests**

Run: `pnpm --filter @omd/engine exec vitest run test/renderBudget.test.ts test/performancePolicy.test.ts`

Expected: PASS; existing global tests remain the control.

- [ ] **Step 6: Review the task diff**

Run: `git diff --check && git diff -- packages/engine/src/decorations/renderBudget.ts packages/engine/test/renderBudget.test.ts`

Expected: no view consults another view's policy.

### Task 3: Per-View Windowed Decoration Driver

**Files:**
- Modify: `packages/engine/src/decorations/buildDriver.ts`
- Modify: `packages/engine/src/lists/ordered.ts`
- Modify: `packages/engine/test/safeModeWindow.test.ts`
- Modify: `packages/engine/test/orderedRenumberSafeMode.test.ts`

**Interfaces:**
- Consumes: `editorPerformancePolicy(state)` and `samePerformancePolicy`.
- Produces no new public API.

- [ ] **Step 1: Write local/global parity tests**

For one deterministic document and stubbed visible range, capture `liveBuildChunk` and `livePruneOutside` effects for:

1. legacy global safe mode;
2. explicit local safe policy with legacy global off.

Compare chunk/prune sequences, pending ranges, spec keys, and atomic ranges at the same scheduler checkpoint. Repeat normal-profile comparison after `drainPendingLiveBuild`.

- [ ] **Step 2: Write two-view isolation and in-flight transition tests**

Mount View A standard and View B safe. Scroll/reconfigure B through stubbed visible ranges and assert A receives no transaction, effect, pending-range change, spec change, or DOM change. Reconfigure B safe→standard and assert B resumes draining to completion; standard→safe must schedule prune work even if pending was empty.

For the standard→safe regression, leave standard mode with pending work and a captured idle callback so the driver is observably in its `idleScheduled === true` state. Reconfigure to safe before running that callback. Assert the old idle callback is cancelled and cannot drain after cancellation, a new first pass is armed, and `livePruneOutside` is dispatched even when the new build window contains no pending range. This fixture must fail if `arm()` returns early merely because the pre-reconfiguration idle callback is still marked scheduled.

- [ ] **Step 3: Run the focused tests and verify failure**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/safeModeWindow.test.ts test/orderedRenumberSafeMode.test.ts
```

Expected: local-policy cases FAIL because both modules still read `safeModeRenderingEnabled()`.

- [ ] **Step 4: Resolve windowing from each driver view**

Replace every runtime global read in `LiveBuildDriver` with a private `windowed(state = this.view.state)` helper. In `update`, compare `windowed(update.startState)` with `windowed(update.state)`. On a standard→safe transition, perform this sequence before `arm()`:

```ts
if (!wasWindowed && isWindowed) {
  this.cancelIdle?.()
  this.cancelIdle = null
  this.idleScheduled = false
  this.windowDirty = true
}
```

Do not cancel an already queued first-pass microtask: it reads the current view state and can perform the safe-mode prune. On safe→standard, preserve the existing scheduled work and allow the non-windowed driver to drain all pending ranges. For viewport/document/selection changes while already windowed, keep setting `windowDirty = true` as today. Call `arm()` only after the transition state is coherent.

Do not change `LIVE_WINDOW_CHARS`, `LIVE_PRUNE_MARGIN_CHARS`, chunk size, idle slice budget, prune semantics, or the rule that dispatch never occurs inside `ViewPlugin.update`.

- [ ] **Step 5: Resolve ordered-list scan policy per view**

In `orderedRenumber.consumeScanRanges`, choose full-tree versus visible/changed ranges from `editorPerformancePolicy(this.view.state)` when explicit, otherwise use the legacy global. Preserve all pending/suppression/reversibility rules.

- [ ] **Step 6: Run window, ordered-list, and build-driver tests**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/safeModeWindow.test.ts test/orderedRenumberSafeMode.test.ts test/buildDriver.test.ts
```

Expected: PASS; local/global effect sequences match.

- [ ] **Step 7: Review the task diff**

Run: `git diff --check && git diff -- packages/engine/src/decorations/buildDriver.ts packages/engine/src/lists/ordered.ts packages/engine/test/safeModeWindow.test.ts`

Expected: global functions remain only the fallback/control path, not the experimental path.

### Task 4: Engine Parity and Reconfiguration Benchmark

**Files:**
- Create: `packages/engine/bench/policy.bench.ts`
- Create: `packages/engine/src/performancePolicyDiagnostics.ts`
- Modify: `packages/engine/package.json`
- Modify: `packages/engine/test/performancePolicy.test.ts`

**Interfaces:**
- Consumes: policy setter, live field diagnostics, existing benchmark generator.
- Produces:

```ts
export interface PerformancePolicyDiagnostics {
  readonly policy: EditorPerformancePolicy | null
  readonly pendingInBuildWindow: number
  readonly pendingRanges: number
  readonly decorationSpecs: number
}

export function getPerformancePolicyDiagnostics(
  view: EditorView,
): PerformancePolicyDiagnostics
```

- Also produces paired global/local sync-reconfiguration metrics and exact parity summaries.

- [ ] **Step 1: Add the experimental read-only diagnostic API**

Implement diagnostics in a separate module that may import `livePreviewField`, `pendingInWindow`, and the public policy getter. Export it from the engine barrel with an `experimental` doc comment. Do not make `performancePolicy.ts` import decoration modules; that would create a cycle because the driver imports the policy resolver.

- [ ] **Step 2: Add final parity assertions**

For normal control/local standard, compare source bytes and full drained decoration keys. For safe control/local safe, compare source bytes, visible-window decoration keys, pending ranges, prune results, and rendered block start positions at matched visible range and scheduler checkpoint.

- [ ] **Step 3: Implement the 10,000-line benchmark**

Use `makeBenchmarkDoc(10_000)`. Warm 10 alternations, then record at least 100 standard↔safe reconfiguration dispatch durations. Report p50, p95, and peak; require p95 ≤ 16 ms.

Benchmark the legacy control sequentially and local experiment sequentially because the global control cannot represent two simultaneous policies. Do not include background drain in synchronous dispatch timing.

- [ ] **Step 4: Add the focused benchmark script**

Add to the engine package:

```json
"bench:policy-spike": "vitest bench --run bench/policy.bench.ts --reporter=verbose"
```

- [ ] **Step 5: Run tests and benchmark**

Run:

```bash
pnpm --filter @omd/engine exec vitest run test/performancePolicy.test.ts test/renderBudget.test.ts test/safeModeWindow.test.ts test/orderedRenumberSafeMode.test.ts
pnpm --filter @omd/engine bench:policy-spike
```

Expected: tests PASS; benchmark prints both control and experiment with experimental p95 ≤ 16 ms.

- [ ] **Step 6: Review the task diff**

Run: `git diff --check && git diff -- packages/engine/src/performancePolicyDiagnostics.ts packages/engine/bench/policy.bench.ts packages/engine/package.json packages/engine/test/performancePolicy.test.ts`

Expected: benchmark setup is outside timed regions.

### Task 5: Real Chromium Two-View and Viewport-Ready Evidence

**Files:**
- Create: `apps/desktop/e2e/per-editor-policy-harness.html`
- Create: `apps/desktop/e2e/per-editor-policy-harness.ts`
- Create: `apps/desktop/e2e/per-editor-policy-spike.spec.ts`
- Create: `apps/desktop/e2e/per-editor-policy-audit.mjs`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Consumes: `createEditor`, `setEditorPerformancePolicy`, policy constants, and `getPerformancePolicyDiagnostics` from the engine barrel.
- Produces: two mounted editors plus a harness API for policy switching, pending-in-window readiness, transaction counts, DOM fingerprints, and timing.

- [ ] **Step 1: Build the isolated two-view harness**

Mount View A and View B side by side with the same 10,000-line deterministic document. Apply standard to A and safe to B through the per-view setter. Expose only under this dedicated harness page:

```ts
window.__policySpike = {
  viewA,
  viewB,
  set(view: "A" | "B", policy: "standard" | "safe"): void,
  diagnostics(view: "A" | "B"): {
    pendingInWindow: number
    transactionCount: number
    domFingerprint: string
  },
  waitViewportReady(view: "A" | "B"): Promise<number>,
}
```

Define viewport-ready as the first animation frame where `pendingInWindow === 0` for two consecutive frames. This measures the existing microtask/idle pipeline instead of assuming one transaction completes it.

- [ ] **Step 2: Write real-browser isolation tests**

Assert:

- both view and `.cm-editor` DOM identities survive 100 policy alternations;
- switching B produces no transaction or DOM fingerprint change in A;
- A drains beyond the safe window while B retains out-of-window pending;
- switching B back to standard drains it to completion;
- selection and document bytes remain unchanged.

- [ ] **Step 3: Implement paired global/local audit**

Add:

```json
"audit:policy-spike": "node e2e/per-editor-policy-audit.mjs"
```

For global control and local experiment, use fresh pages, identical viewport/document/scroll position, 10 warm-ups, and at least 50 measured switches. Record synchronous dispatch, viewport-ready p50/p95/peak, and `PerformanceObserver` long tasks.

Gate experimental viewport-ready p95 against `controlP95 + max(5 ms, controlP95 * 0.10)`. Keep the absolute 50 ms gate only for individual main-thread tasks.

- [ ] **Step 4: Run E2E and audit**

Run:

```bash
pnpm --filter @omd/desktop build
pnpm --filter @omd/desktop test:e2e -- per-editor-policy-spike.spec.ts
PW_PORT=9435 pnpm --filter @omd/desktop audit:policy-spike
```

Expected: build/E2E PASS; audit emits paired JSON with no experimental task over 50 ms.

- [ ] **Step 5: Review the task diff**

Run: `git diff --check && git diff -- apps/desktop/e2e/per-editor-policy-harness.html apps/desktop/e2e/per-editor-policy-harness.ts apps/desktop/e2e/per-editor-policy-spike.spec.ts apps/desktop/e2e/per-editor-policy-audit.mjs apps/desktop/package.json`

Expected: no production App wiring and no global policy mutation in the local path.

### Task 6: Migration Inventory, Full Verification, and Decision

**Files:**
- Create: `docs/superpowers/plans/2026-10-28-per-editor-policy-spike-results.md`
- Read: `apps/desktop/src/documentScaleRegistry.ts`
- Read: `apps/desktop/src/App.tsx`
- Read: `apps/desktop/test/App.largeDoc.test.tsx`
- Read: `apps/desktop/test/App.largeDocOpen.test.tsx`

**Interfaces:**
- Consumes: all tests/bench/audit evidence and a grep inventory of legacy global readers/writers.
- Produces: one reviewed decision and exact production migration list.

- [ ] **Step 1: Generate the legacy-global inventory**

Run:

```bash
rg -n "safeModeRenderingEnabled|setSafeModeRendering|blockRenderBudget|setBlockRenderBudget" packages/engine/src apps/desktop/src packages/engine/test apps/desktop/test
```

Classify every production hit as: replace with local state, retain temporarily as fallback, or delete in production migration. Include `documentScaleRegistry.applyRenderPolicy`, App registry construction, and large-document tests.

- [ ] **Step 2: Run full relevant verification**

Run:

```bash
pnpm test
pnpm --filter @omd/engine bench:policy-spike
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
pnpm --filter @omd/desktop test:e2e -- per-editor-policy-spike.spec.ts
PW_PORT=9435 pnpm --filter @omd/desktop audit:policy-spike
```

Expected: correctness/build/E2E PASS; benchmark/audit contain all required rows.

- [ ] **Step 3: Create the result report**

```markdown
# Per-Editor Performance Policy Spike Results

## Environment and Commit
## Commands
## Two-View Isolation
## Normal-Profile Parity
## Performance-Profile Parity
## Synchronous Reconfiguration
## Viewport-Ready Comparison
## Long-Task Evidence
## Legacy Global Migration Inventory
## Failed Cases
## Decision
## Production Recommendation
## Prototype Files: Keep, Rewrite, Delete
```

- [ ] **Step 4: Apply the decision gate**

- `Go`: independent policies, 100 stable reconfigurations, exact matched parity, no cross-view change, sync p95 ≤ 16 ms, comparative viewport-ready gate, and ≤ 50 ms tasks all pass.
- `Revise`: isolation works but parity needs one additional StateEffect/Compartment boundary; name the smallest missing primitive.
- `Stop`: local ownership requires duplicating the decoration pipeline, recreating views, or sharing mutable policy between views.

- [ ] **Step 5: State production follow-up boundaries**

On `Go`, recommend a separate migration design that changes `documentScaleRegistry` from global setters to `setEditorPerformancePolicy(activeView, policy)`, updates all large-document tests, removes fallback globals only after parity, and adds a multi-tab regression. Do not perform that migration in this spike.

- [ ] **Step 6: Final plan checkpoint**

Run: `git status --short && rg -n "^## |^### " docs/superpowers/plans/2026-10-28-per-editor-policy-spike-results.md`

Expected: report complete; inventory covers every production global access; no unrelated changes.
