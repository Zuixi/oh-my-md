# Live Performance Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure the real non-safe-mode live-preview steady state after its current parse window has drained, and remove the known `documentStats` hot loop without changing decoration semantics prematurely.

**Architecture:** Extend the existing advisory benchmark harness so it can drain decorations for the production partial parse window before typing. Keep a separate unbudgeted complete-tree case as an absolute worst-case reference. Optimize word counting as a self-contained pure function.

**Tech Stack:** TypeScript, CodeMirror 6, Vitest Bench, Vitest unit tests.

**Spec:** [`docs/superpowers/specs/2026-08-10-oh-my-md-design.md`](../specs/2026-08-10-oh-my-md-design.md)

## Global Constraints

- Benchmark-only code may call `drainPendingLiveBuild`; production code may not.
- Keep benchmarks advisory (`continue-on-error`); record budgets but do not make noisy wall-clock checks unit-test gates.
- Preserve exact `documentStats` behavior, including front matter exclusion and CJK counting.
- Do not enable always-on safe mode/windowing in this plan.

---

### Task 1: Expose a production-window-drained live typing measurement

**Files:**
- Modify: `packages/engine/bench/measure.ts:60-105`
- Modify: `packages/engine/bench/typing.bench.ts:1-90`
- Test: `packages/engine/test/progressive.test.ts`

**Interfaces:**
- Extends:

```ts
measureTyping(doc, {
  mode: "live",
  tree: "steady",
  drain: true,
})
```

- `drain: true` means the test-only driver has emptied `LiveDeco.pending` for the syntax tree currently available before timing begins. With `tree: "steady"`, this mirrors production's partial parse window; it does not force or pretend that the whole document is parsed.

- [ ] **Step 1: Add a failing benchmark-helper unit test**

Add a small exported helper in `bench/measure.ts`:

```ts
export function prepareTypingView(
  doc: string,
  opts: {
    mode: "live" | "source"
    tree: "steady" | "complete"
    drain?: boolean
    safeWindow?: boolean
  },
): EditorView
```

In a bench-focused test file `packages/engine/test/benchMeasure.test.ts`, assert:

```ts
const view = prepareTypingView(makeBenchmarkDoc(500), {
  mode: "live",
  tree: "complete",
  drain: true,
})
expect(view.state.field(livePreviewField).pending).toEqual([])
expect(view.state.field(livePreviewField).specs.length).toBeGreaterThan(100)
view.destroy()
```

Expected initial failure: `prepareTypingView` does not exist.

- [ ] **Step 2: Implement the preparation helper**

Move the setup portion of `measureTyping` into `prepareTypingView`. After `forceParsing`, add:

```ts
if (opts.drain) drainPendingLiveBuild(view)
```

Keep `syncSafeWindowReady(view)` in the helper when `opts.safeWindow` is true. `measureTyping` must call the helper and keep timing only the dispatch loop.

- [ ] **Step 3: Add realistic benchmark cases**

Add:

```ts
const DOC_30K = makeBenchmarkDoc(30000)

bench("typing 10k lines (live, steady drained)", () => {
  const r = measureTyping(DOC_10K, {
    mode: "live", tree: "steady", drain: true, keystrokes: 100,
  })
  console.info(budgetLine(
    "typing p95 10k live steady drained",
    r.p95Ms,
    TYPING_P95_BUDGET_MS,
  ))
})

bench("typing 30k lines (live, steady drained)", () => {
  const r = measureTyping(DOC_30K, {
    mode: "live", tree: "steady", drain: true, keystrokes: 60,
  })
  console.info(budgetLine(
    "typing p95 30k live steady drained",
    r.p95Ms,
    TYPING_P95_BUDGET_MS,
  ))
})

bench("typing 50k lines (live, steady drained)", () => {
  const r = measureTyping(DOC_50K, {
    mode: "live", tree: "steady", drain: true, keystrokes: 40,
  })
  console.info(budgetLine(
    "typing p95 50k live steady drained",
    r.p95Ms,
    TYPING_P95_BUDGET_MS,
  ))
})

bench("typing 10k lines (live, complete tree drained — worst case)", () => {
  const r = measureTyping(DOC_10K, {
    mode: "live", tree: "complete", drain: true, keystrokes: 50,
  })
  console.info(
    `[worst-case] typing p95 10k live complete-tree drained: ${r.p95Ms.toFixed(2)}ms`,
  )
})
```

The complete-tree case is deliberately unbudgeted. It isolates the absolute cost of mapping a fully materialized decoration set, but production is forbidden from forcing that parse state.

- [ ] **Step 4: Run tests and benchmark**

```bash
pnpm test
pnpm --filter @omd/engine bench
```

Record p50/p95 for all three drained cases in `docs/memory/gotchas-engine.md`.

- [ ] **Step 5: Apply the decision gate**

- If steady-drained 30k p95 is at or below `TYPING_P95_BUDGET_MS`, do not change the decoration pipeline.
- If steady-drained 30k p95 exceeds the budget in two local runs, write a separate always-on-windowing design spec.
- If only steady-drained 50k exceeds the budget, first reconsider `SAFE_MODE_LINES`; do not redesign the pipeline.
- Never use the complete-tree result as an optimization gate.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/bench/measure.ts \
  packages/engine/bench/typing.bench.ts \
  packages/engine/test/benchMeasure.test.ts \
  docs/memory/gotchas-engine.md
git commit -m "perf: measure drained live typing window"
```

### Task 2: Replace per-character stats matching

**Files:**
- Modify: `packages/engine/src/stats.ts`
- Modify: `packages/engine/test/stats.test.ts`
- Modify: `packages/engine/bench/typing.bench.ts`

**Interfaces:**
- Preserves:

```ts
export function documentStats(text: string): {
  readonly words: number
  readonly chars: number
}
```

- [ ] **Step 1: Expand semantic tests before changing the algorithm**

Add cases for:

```ts
expect(documentStats("abc123 中文 한글 カナ")).toEqual({ words: 7, chars: 15 })
expect(documentStats("hello—world")).toEqual({ words: 2, chars: 11 })
expect(documentStats("---\ntitle: ignored words\n---\n正文 test")).toEqual({
  words: 3,
  chars: 7,
})
```

Calculate exact `chars` values from the trimmed post-front-matter string in the test, rather than copying the numbers above if TypeScript string length differs.

- [ ] **Step 2: Capture the current benchmark baseline**

```bash
pnpm --filter @omd/engine bench -- --testNamePattern="documentStats 50k"
```

Record the current median in the commit message body or PR description.

- [ ] **Step 3: Implement one-pass token matching**

Replace separate per-character regex calls with:

```ts
const WORD =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[A-Za-z0-9]+/gu

export function documentStats(text: string): DocumentStats {
  const trimmed = text.replace(FRONT_MATTER, "").trim()
  if (!trimmed) return { words: 0, chars: 0 }
  WORD.lastIndex = 0
  let words = 0
  while (WORD.exec(trimmed)) words += 1
  return { words, chars: trimmed.length }
}
```

Do not introduce a StateField or worker in this task.

- [ ] **Step 4: Verify semantics and measure improvement**

```bash
pnpm --filter @omd/engine exec vitest run test/stats.test.ts test/frontMatter.test.ts
pnpm --filter @omd/engine bench -- --testNamePattern="documentStats 50k"
```

Accept the change only if semantic tests pass and median time improves by at least 25% in two runs. Otherwise revert the algorithm and retain only the expanded tests.

- [ ] **Step 5: Run full engine tests**

```bash
pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/stats.ts \
  packages/engine/test/stats.test.ts
git commit -m "perf: reduce document stats scan cost"
```

## Why This Plan, Not the Alternatives

- **Why benchmark first:** the suspected O(N) decoration cost is plausible but currently unmeasured after production's available parse window has drained.
- **Why keep a separate complete-tree case:** it isolates worst-case decoration-set mapping, but it remains unbudgeted because production must never force a complete tree.
- **Why not always-on windowing now:** it changes when off-screen decorations exist and can affect navigation or widget assumptions.
- **Why regex optimization before incremental stats:** stats are pure, debounced, and already disabled on-demand in safe mode. Incremental stats would add invalidation state for a UI convenience.
- **Why advisory timing:** CI hardware variance makes strict millisecond unit tests flaky; repeated local benchmark improvement is sufficient for this isolated algorithm.
