# Per-Editor Performance Policy Spike Results

> Evidence report for [`2026-10-28-per-editor-policy-spike.md`](./2026-10-28-per-editor-policy-spike.md).
> Decision gates come from [`2026-10-28-editor-experience-spike-program-design.md`](../specs/2026-10-28-editor-experience-spike-program-design.md) (Spike 3).
>
> Every number below is copied from a run recorded in this worktree's session logs. Nothing is
> estimated. Each row is labelled with its evidence class:
>
> - **Unit** — Vitest in happy-dom with real `EditorView`s and stub visible ranges.
> - **Benchmark** — `vitest bench` in Node over a 10,000-line fixture.
> - **Chromium** — Playwright driving real Chrome with two live editors and `PerformanceObserver` long tasks.

## Environment and Commit

| Item | Value |
| --- | --- |
| Worktree | `.worktrees/editor-experience-spikes` |
| Branch | `codex/editor-experience-spikes` |
| Base commit | `80efba5` (Merge pull request #41). All spike code is uncommitted worktree state; the plan forbids committing during the spike. |
| OS / arch | darwin / arm64 |
| Node (unit + bench) | v26.7.0 |
| Vitest | 3.2.7 |
| Browser (Chromium evidence) | Google Chrome `156.0.8078.48` — the audit JSON stamps `chromium` and `channel: "chrome"` — viewport 1280×800, 10 warm-ups, 50 measured switches |
| Audit JSON port | `9474` (`PW_PORT=9474`), `failed: []` |
| Fixture | `makeBenchmarkDoc(10_000)` — 10,000 lines / 843,223 chars, scrollTop 0 |

## Commands

```sh
pnpm --filter @omd/engine exec vitest run test/performancePolicy.test.ts test/renderBudget.test.ts test/safeModeWindow.test.ts test/orderedRenumberSafeMode.test.ts
# -> 50 passed (50): 10 + 3 + 18 + 19
pnpm test                                            # engine tsc --noEmit + Vitest -> 950 passed across 73 files
pnpm --filter @omd/engine bench:policy-spike         # vitest bench --run bench/policy.bench.ts --reporter=verbose
pnpm --filter @omd/desktop test                      # tsc -p tsconfig.test.json && vitest run -> 915 passed across 90 files
pnpm --filter @omd/desktop build                     # PASS
pnpm --filter @omd/desktop test:e2e -- per-editor-policy-spike.spec.ts   # runs the whole suite -> 74 passed
# dev server must already be listening on the same port
PW_PORT=9474 pnpm --filter @omd/desktop audit:policy-spike
```

Suite results on the final tree: focused engine run `50 passed` across the four files (10 / 3 / 18 /
19), and the narrower pair `performancePolicy` + `safeModeWindow` is `28 passed` (10 + 18). Full
`pnpm test` is `950 passed` across 73 files; desktop is `915 passed` across 90 files; desktop E2E is
`74 passed` (the three policy tests included); `git diff --check` clean.

## Two-View Isolation

**Unit** — `performancePolicy.ts` is a `Facet<EditorPerformancePolicy | null>` mounted through one
module-level `Compartment`; `setEditorPerformancePolicy(view, policy)` dispatches a
`Compartment.reconfigure` to that view's state and nothing else. The Facet rejects two non-null
providers, rejects negative/`NaN`/infinite `blockRenderBudgetLines`, and `null` means "legacy global
fallback" (not "unlimited"). Covered by tests: exact standard/safe constants, validation without
reconfiguring, independent policies per state **and** per view, document/selection/undo-depth
survival, and 100 standard↔safe alternations with stable `EditorView` and DOM-root identity.

**Unit** — cross-view isolation in the driver and budget layers:

| Test file | Test | Proves |
| --- | --- | --- |
| `safeModeWindow.test.ts` | keeps another view's transactions, effects, pending, and DOM untouched | view A sees no transaction/effect/pending/spec/DOM change while B scrolls and flips policy |
| `safeModeWindow.test.ts` | drains every pending range after switching safe → standard | B resumes and completes its pending work |
| `renderBudget.test.ts` / `performancePolicy.test.ts` | renders an unlimited local view and defers a four-line limited one | budgets are read from each view's own state |
| `performancePolicy.test.ts` | flushes deferred renders only for the reconfigured view | the global pending `Set` stays lifecycle storage; eligibility comes from `entry.view.state` |

**Duplication cleanup:** the pure window builder has exactly one implementation. `expandedRegions(view, margin)`
is exported from `decorations/buildDriver.ts`, the driver's private `buildWindow()` delegates to it,
and `performancePolicyDiagnostics.ts` imports the same function instead of keeping a copy.

**Chromium** — `per-editor-policy-spike.spec.ts` mounts two real editors with the same 10,000-line
document, A standard and B safe, through a dedicated harness page (`window.__policySpike`):

| Test | Result |
| --- | --- |
| two editors mount identical 10,000-line documents with independent policies | pass |
| 100 policy alternations preserve both views and never touch view A | pass |
| view B keeps out-of-window pending in safe mode and drains fully in standard mode | pass |

The 100-alternation test asserts both `EditorView` objects and both `.cm-editor` DOM roots keep their
identity, view A's transaction count and DOM fingerprint do not change, and final source bytes and
selection equal the baseline. A harness debug dump taken while the spec was being developed shows
the same shape: A stayed at `transactionCount 7` with `pendingRanges 0` while B advanced
`7 → 9 → 11 → 16 → 18 → 23 → 25 → 30` across its own flips.

## Normal-Profile Parity

**Unit** — after a complete test-only drain, the local standard profile matches the legacy global
control exactly: source bytes (265,650), every decoration spec key, and pending ranges
(`0 pending`). The same comparison runs inside the benchmark and throws on any divergence:
`standard parity: 265650 bytes, 2700 decorations, 0 pending — exact match`.

**Benchmark** — `standard parity after drain (source bytes + decoration keys)` computes both
summaries in the same iteration and compares byte counts, spec counts, and every key in order. No
profile-dependent drift was observed in any run.

## Performance-Profile Parity

**Unit** — the local safe policy is compared with the legacy global safe mode at the *same*
document, selection, stubbed visible ranges, build window, prune window and scheduler checkpoint (two
checkpoints: after the first chunk pass and after a prune); decoration spec keys, pending ranges,
captured prune windows, pending-in-window diagnostics, and rendered block start positions all match.
No full-document decoration equivalence is claimed for a windowed profile.

**Unit** — ordered-list renumbering reads the same per-view resolver:
"scans the whole tree for a view whose local policy disables windowing" and "windows scans for a view
whose local policy enables windowing" both pass, so the ordered-scan policy is editor-local too, with
pending/suppression/reversibility rules unchanged.

## Synchronous Reconfiguration

**Benchmark** — `makeBenchmarkDoc(10_000)`, 10 warm-up + 100 measured standard↔safe dispatches per
run, gate `p95 ≤ 16 ms`:

| Run | p50 | p95 | peak | samples |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0.26 ms | **0.39 ms** | 1.74 ms | 100 |
| 2 | 0.20 ms | **0.27 ms** | 1.79 ms | 100 |
| 3 | 0.19 ms | **0.22 ms** | 0.80 ms | 100 |

All three runs pass the 16 ms gate with ~40× headroom. The bench throws if p95 exceeds 16 ms, so a
regression fails instead of printing quietly.

**Control path measured too.** A later rerun printed the legacy instrumented line for every iteration
(34 per path, so local and control come from the same process and fixture): local p95 0.18–0.45 ms
(median 0.20), legacy global control p95 0.17–0.29 ms (median 0.19). Both paths are gated by the same
16 ms budget, so the local policy is not paying for the Compartment dispatch. What the earlier captured
output did show, and what this run confirms, is that the vitest iteration rows time the whole bench
*body* (mount + 110 dispatches) and therefore do not compare single dispatches: local `19.3661 hz` /
mean 51.64 ms, legacy `19.7157 hz` / mean 50.72 ms, parity `14.7627 hz` / mean 67.74 ms. The control
comparison that carries the real evidence is the parity suite above.

## Viewport-Ready Comparison

**Chromium** — paired audit, fresh page per mode, identical viewport/document/scroll position,
10 warm-ups and 50 measured switches. Viewport-ready is defined as the first animation frame where
`pendingInWindow === 0` for two consecutive frames (the existing microtask/idle pipeline, not an
assumed single transaction). Gate: local p95 ≤ control p95 + max(5 ms, 10%).

| Run | sync p95 global / local | viewport-ready p95 global → local | regression | allowed | verdict |
| --- | --- | --- | ---: | ---: | --- |
| 1 (full JSON) | 2.3 / 2.2 ms | 33.3 → 33.1 ms | −0.2 ms | 5 ms | pass |
| 2 | 2.3 / 2.3 ms | 33.1 → 33.0 ms | −0.1 ms | 5 ms | pass |
| 3 | 2.4 / 2.3 ms | 32.8 → 32.9 ms | +0.1 ms | 5 ms | pass |
| 4 | 2.3 / 2.3 ms | 33.1 → 33.3 ms | +0.2 ms | 5 ms | pass |
| 5 (final) | 2.4 / 2.2 ms | 32.6 → 31.5 ms | −1.1 ms | 5 ms | pass |

Rows 1–4 are earlier runs kept as history; row 5 is the final run this decision uses.

Full JSON run detail (row 1): global sync p50 2.1 / p95 2.3 / peak 6.2 ms, local 2.0 / 2.2 / 2.3 ms; global
viewport-ready p50 31.2 / p95 33.3 / peak 33.4 ms, local 31.2 / 33.1 / 33.3 ms. The per-run p50
viewport-ready values in rows 1–4 are stable at 31.1–31.3 ms in both modes, and `allowedMs` resolved
to 5 ms every time because 10% of ~33 ms is below the 5 ms floor.

Note the honest split between evidence classes: Chromium sync p95 is 2.2–2.4 ms against the Node
benchmark's 0.2–0.4 ms for the same dispatch. Both are inside the 16 ms gate; the browser number is
the one a user would feel, and it includes real DOM work in a live editor.

## Long-Task Evidence

**Chromium** — `PerformanceObserver` long tasks per mode, budget 50 ms per individual task:

| Run | global (count / max) | local (count / max) |
| --- | --- | --- |
| 1 (full JSON) | 0 / 0 ms | 0 / 0 ms |
| 2 | 0 / 0 ms | 0 / 0 ms |
| 3 | 0 / 0 ms | 0 / 0 ms |
| 4 | 0 / 0 ms | 0 / 0 ms |
| 5 (final) | 0 / 0 ms | 0 / 0 ms |

No main-thread task crossed the 50 ms reporting threshold in either mode, which is stronger than
"under budget" — nothing was even recorded.

## Legacy Global Migration Inventory

`rg -n "safeModeRenderingEnabled|setSafeModeRendering|blockRenderBudget|setBlockRenderBudget" packages/engine/src apps/desktop/src packages/engine/test apps/desktop/test`
on the current tree, classified:

| Location | Current role | Migration |
| --- | --- | --- |
| `packages/engine/src/safeModeRendering.ts` | module-global flag + setter (the process-wide control) | **Delete** once every reader below is local; it is the thing this spike replaces |
| `packages/engine/src/decorations/renderBudget.ts` | global `blockRenderBudget()` / `setBlockRenderBudget()` **and** the new `blockRenderBudgetFor(state)` / `withinRenderBudget` resolver | **Keep the resolver, delete the global pair** at migration |
| `packages/engine/src/decorations/buildDriver.ts:209` | `policy ? policy.windowLiveDecorations : safeModeRenderingEnabled()` | **Keep as temporary fallback**; the `:` arm is the only production global read left |
| `packages/engine/src/lists/ordered.ts:507` | same resolver pattern for ordered-list scan ranges | **Keep as temporary fallback**; same one-line `:` arm |
| `packages/engine/src/index.ts` (budget + safe-mode exports) | public surface for the globals, plus the new policy exports | **Remove the global exports** last, after desktop stops importing them |
| `apps/desktop/src/App.tsx` (`setRenderBudget: setBlockRenderBudget`, `setSafeModeRendering`) | registry dependency wiring | **Replace** with `setEditorPerformancePolicy(activeView, policy)` |
| `apps/desktop/src/documentScaleRegistry.ts` (`setRenderBudget`, `setSafeModeRendering` in `applyRenderPolicy`) | per-tab classification pushed into process globals | **Rewrite** `applyRenderPolicy(tabId)` to dispatch to that tab's view; the classification logic itself is unchanged |
| `packages/engine/test/renderBudget.test.ts`, `test/safeModeWindow.test.ts`, `test/orderedRenumberSafeMode.test.ts` | use the globals as the **control** half of every parity assertion | **Keep until parity retires**; rewrite to local-config-only afterwards |
| `packages/engine/test/performancePolicy.test.ts` | uses globals as control | **Keep** (it is the parity harness) |
| `apps/desktop/test/App.largeDoc.test.tsx`, `App.largeDocOpen.test.tsx` | exercise the registry → global path indirectly | **Update** when the registry API changes; they are the natural home for the new multi-tab regression |

## Failed Cases

1. **First E2E attempt: 2 of 3 tests failed.**
   (a) `100 policy alternations…` asserted `policyB === "standard"` and received `"safe"` — the
   alternation loop's final-state assumption was wrong (flip parity), a spec bug.
   (b) `view B keeps out-of-window pending…` asserted `pendingInWindow === 0` and received `1` — the
   assertion ran before the driver had finished its prune slice; readiness was not awaited.
   Both were fixed **inside the harness and spec only** (no engine change) by defining
   viewport-ready as two consecutive frames with `pendingInWindow === 0` and waiting on it before
   asserting. The engine suite was green before and after (`945 passed`), and all three Chromium tests
   pass on every subsequent run.
2. **Not measured, recorded as such.** No heap measurement for the per-view policy: the gate set
   contains no policy heap budget, and a policy reconfiguration mounts no widgets by itself. The
   standard→safe idle-cancellation regression is proven in happy-dom with fake timers, not in
   Chromium.

## Decision

All Spike 3 `Go` conditions are satisfied:

| Gate | Result |
| --- | --- |
| View A and B hold independent policies in one process | pass (Unit + Chromium) |
| 100 alternations do not recreate either `EditorView` | pass (Unit + Chromium, DOM roots stable) |
| Normal parity after complete drain | pass (265,650 bytes / 2,700 decorations / 0 pending) |
| Performance parity at matched viewport, scroll, and scheduler checkpoint | pass (two checkpoints) |
| One view's reconfiguration changes nothing in the other | pass (Unit + Chromium: A unchanged through B's flips) |
| Sync reconfiguration p95 ≤ 16 ms on 10,000 lines | pass, local p95 0.18–0.45 ms vs legacy control p95 0.17–0.29 ms (Node, 34 paired iterations), and 2.4 / 2.2 ms p95 global/local in Chromium |
| Viewport-ready p95 ≤ control + max(5 ms, 10%) | pass in every run, including the final one at −1.1 ms against a 5 ms allowance |
| No individual main-thread task > 50 ms | pass, zero long tasks recorded |
| No React, Tauri, or module-global mutation inside `packages/engine` | pass (setter dispatches to the supplied view only) |

**Decision: Go**

Scope of that `Go`: **experimental per-editor policy only**. The Facet/Compartment boundary, the
per-view resolver and the isolation guarantees are proven; the production globals are still
authoritative and nothing is wired into `App.tsx` or `documentScaleRegistry`.

## Production Recommendation

Do **not** migrate inside this spike. The next step is a separate approved design that:

- changes `documentScaleRegistry.applyRenderPolicy` from `setRenderBudget` + `setSafeModeRendering`
  to `setEditorPerformancePolicy(tabView, policy)` and updates the registry dependency interface;
- decides what happens when a tab has no live view (background tab, closed tab, view recreated on
  tab switch) — the policy must be re-applied on mount or it silently reverts to the global default;
- updates `App.largeDoc*.test.tsx` and adds a **multi-tab regression** (two tabs, different policies,
  tab switching must not leak policy);
- removes `safeModeRendering.ts` and the `blockRenderBudget`/`setBlockRenderBudget` pair only after
  every reader routes locally, then drops the fallback arms in `buildDriver.ts` and `lists/ordered.ts`
  in the same change that deletes them (leaving a "temporarily unused" fallback is how it comes back);
- decides whether `performancePolicyDiagnostics.ts` stays experimental or becomes a supported
  diagnostic surface.

## Prototype Files: Keep, Rewrite, Delete

| File | Action | Why |
| --- | --- | --- |
| `packages/engine/src/performancePolicy.ts` | **Keep** | The whole mechanism: type, constants, validating Facet, Compartment, getter, per-view setter, `samePerformancePolicy`. Migration-ready as-is. |
| `packages/engine/src/performancePolicyDiagnostics.ts` | **Keep (experimental), revisit at migration** | Read-only counts used by parity/E2E; separate module avoids a `performancePolicy → decorations` cycle, and it imports the one shared `expandedRegions` builder instead of duplicating it. Decide keep-or-drop in the migration design. |
| `packages/engine/src/index.ts` (compartment mount + exports) | **Keep** | Mounting `performancePolicyExtension(null)` keeps shipped behaviour on the global fallback and the experimental surface narrow (Facet/Compartment stay unexported). |
| `packages/engine/src/decorations/renderBudget.ts` | **Rewrite** | Keep `blockRenderBudgetFor(state)` / `withinRenderBudget`; the legacy getter/setter pair is the fallback to delete at migration. |
| `packages/engine/src/decorations/buildDriver.ts` (windowed resolver + standard→safe cancel) | **Keep** | The idle-cancellation sequence (`cancelIdle` → `idleScheduled = false` → `windowDirty = true` before `arm()`) is the regression fix; deleting it loses the standard→safe prune. It also owns the single exported `expandedRegions` window builder the diagnostics reuse. |
| `packages/engine/src/lists/ordered.ts` (per-view scan policy) | **Keep** | Ordered renumbering must follow the same policy or it desyncs from windowing. |
| `packages/engine/src/safeModeRendering.ts` | **Delete at migration** | Process-global mutable policy; the point of this spike is to retire it. |
| `packages/engine/test/performancePolicy.test.ts` | **Keep** | Constants, validation, isolation, identity, and the parity assertions. |
| `packages/engine/test/safeModeWindow.test.ts`, `test/orderedRenumberSafeMode.test.ts`, `test/renderBudget.test.ts` | **Keep** | Contain the cross-view isolation, safe↔standard transition, idle-cancellation regression, and ordered-scan isolation cases. |
| `packages/engine/bench/policy.bench.ts` | **Keep** | 10k reconfiguration budget with a throwing gate (and the control path needed to close the evidence gap). |
| `apps/desktop/e2e/per-editor-policy-harness.html` + `-harness.ts` | **Keep (spike harness)** | Two simultaneous real editors plus diagnostics; nothing else can prove cross-view isolation in a browser. Keep the page out of production routes. |
| `apps/desktop/e2e/per-editor-policy-spike.spec.ts` | **Keep** | The three isolation/parity tests, including the 100-alternation identity check. |
| `apps/desktop/e2e/per-editor-policy-audit.mjs` | **Keep (manual tooling)** | Paired sync/viewport-ready/long-task gates with `PW_PORT`; keep out of CI like the other audits. |
| `package.json` `bench:policy-spike` / `audit:policy-spike` scripts | **Keep until migration** | Explicit re-measurement entry points. |
| `docs/superpowers/plans/2026-10-28-per-editor-policy-spike.md` | **Keep** | Historical plan; this report is its outcome. |

**Decision: Go**
