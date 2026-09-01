# Engine Highlight Cache and Lazy Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound code-highlight memory, move Shiki initialization off the eager path, and eliminate proven widget/interval overhead without changing rendered Markdown.

**Architecture:** A small engine-local LRU owns rendered HTML retention. A single-flight loader dynamically imports Shiki core, regex engine, and themes on first use. Table equality removes repeated serialization through a construction-time token; build-driver work remains benchmark-gated.

**Tech Stack:** TypeScript, CodeMirror 6, Shiki 4, Vitest, Vite.

**Spec:** `docs/superpowers/specs/2026-08-31-runtime-and-maintainability-optimization-design.md`

## Global Constraints

- Keep `@omd/engine` React- and Tauri-independent.
- Preserve synchronous source-shaped placeholders and contained async failures.
- Cache maximums are exactly 128 entries and 8 MiB estimated UTF-16 HTML storage.
- A cache entry larger than 8 MiB is returned but not retained.
- Do not export cache controls from `packages/engine/src/index.ts`.
- Do not change Markdown source text or rendered HTML semantics.
- Do not optimize `buildDriver` unless the new fragmented-range benchmark demonstrates material scaling cost.

---

### Task 1: Implement the bounded LRU

**Files:**
- Create: `packages/engine/src/cache/boundedLru.ts`
- Create: `packages/engine/test/boundedLru.test.ts`

**Interfaces:**

```ts
export interface CacheSize<T> {
  (value: T): number
}

export class BoundedLru<K, V> {
  constructor(options: {
    maxEntries: number
    maxSize: number
    sizeOf: CacheSize<V>
  })
  get(key: K): V | undefined
  set(key: K, value: V): void
  get entryCount(): number
  get retainedSize(): number
}
```

- [ ] **Step 1: Write failing LRU tests**

```ts
import { describe, expect, it } from "vitest"
import { BoundedLru } from "../src/cache/boundedLru"

const cache = () => new BoundedLru<string, string>({
  maxEntries: 2,
  maxSize: 10,
  sizeOf: value => value.length,
})

describe("BoundedLru", () => {
  it("evicts the least recently used entry by count", () => {
    const subject = cache()
    subject.set("a", "aa")
    subject.set("b", "bb")
    expect(subject.get("a")).toBe("aa")
    subject.set("c", "cc")
    expect(subject.get("b")).toBeUndefined()
    expect(subject.get("a")).toBe("aa")
    expect(subject.get("c")).toBe("cc")
  })

  it("evicts by retained size and does not retain an oversize value", () => {
    const subject = cache()
    subject.set("a", "123456")
    subject.set("b", "123456")
    expect(subject.get("a")).toBeUndefined()
    expect(subject.retainedSize).toBe(6)
    subject.set("huge", "12345678901")
    expect(subject.get("huge")).toBeUndefined()
    expect(subject.entryCount).toBe(1)
  })

  it("updates retained size when replacing a key", () => {
    const subject = cache()
    subject.set("a", "12")
    subject.set("a", "12345")
    expect(subject.entryCount).toBe(1)
    expect(subject.retainedSize).toBe(5)
  })
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```sh
pnpm --filter @omd/engine test -- boundedLru.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement LRU using Map insertion order**

```ts
export class BoundedLru<K, V> {
  private readonly values = new Map<K, { value: V; size: number }>()
  private size = 0

  constructor(private readonly options: {
    maxEntries: number
    maxSize: number
    sizeOf(value: V): number
  }) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive integer")
    }
    if (!Number.isFinite(options.maxSize) || options.maxSize <= 0) {
      throw new RangeError("maxSize must be positive")
    }
  }

  get entryCount() { return this.values.size }
  get retainedSize() { return this.size }

  get(key: K): V | undefined {
    const entry = this.values.get(key)
    if (!entry) return undefined
    this.values.delete(key)
    this.values.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): void {
    const entrySize = this.options.sizeOf(value)
    const previous = this.values.get(key)
    if (previous) {
      this.values.delete(key)
      this.size -= previous.size
    }
    if (entrySize > this.options.maxSize) return
    this.values.set(key, { value, size: entrySize })
    this.size += entrySize
    while (this.values.size > this.options.maxEntries || this.size > this.options.maxSize) {
      const oldest = this.values.entries().next().value as [K, { value: V; size: number }]
      this.values.delete(oldest[0])
      this.size -= oldest[1].size
    }
  }
}
```

Validate constructor limits are positive integers and throw an explicit
`RangeError` for invalid values; add matching tests.

- [ ] **Step 4: Run the focused test**

Run:

```sh
pnpm --filter @omd/engine test -- boundedLru.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/engine/src/cache/boundedLru.ts packages/engine/test/boundedLru.test.ts
git commit -m "perf: add bounded engine cache"
```

### Task 2: Integrate bounded code HTML caching

**Files:**
- Modify: `packages/engine/src/decorations/widgets/code.ts:16-27,244-268`
- Create: `packages/engine/test/codeCache.test.ts`

**Interfaces:**
- Consumes: `BoundedLru<string, string>`.
- Produces internal constants:

```ts
const CODE_HTML_CACHE_MAX_ENTRIES = 128
const CODE_HTML_CACHE_MAX_BYTES = 8 * 1024 * 1024
```

- [ ] **Step 1: Write failing integration tests against an internal factory**

Extract an engine-internal factory from `code.ts`:

```ts
export function createCodeHtmlCache() {
  return new BoundedLru<string, string>({
    maxEntries: CODE_HTML_CACHE_MAX_ENTRIES,
    maxSize: CODE_HTML_CACHE_MAX_BYTES,
    sizeOf: html => html.length * 2,
  })
}
```

Test exact limits and UTF-16 accounting:

```ts
it("uses the declared code cache limits", () => {
  const cache = createCodeHtmlCache()
  for (let i = 0; i < 129; i++) cache.set(String(i), "x")
  expect(cache.entryCount).toBe(128)
})

it("does not retain one HTML result above 8 MiB estimated storage", () => {
  const cache = createCodeHtmlCache()
  const html = "x".repeat((8 * 1024 * 1024) / 2 + 1)
  cache.set("large", html)
  expect(cache.get("large")).toBeUndefined()
})
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```sh
pnpm --filter @omd/engine test -- codeCache.test.ts
```

Expected: FAIL because `createCodeHtmlCache` is absent.

- [ ] **Step 3: Replace the unbounded map**

Replace:

```ts
const htmlCache = new Map<string, string>()
```

with:

```ts
const htmlCache = createCodeHtmlCache()
```

Replace the `has` plus non-null `get` pair with one lookup:

```ts
const cached = htmlCache.get(cacheKey)
if (cached !== undefined) {
  if (this.isActive(el)) el.innerHTML = cached
  return
}
```

Keep cache insertion after successful `codeToHtml`.

- [ ] **Step 4: Run code-widget and cache tests**

Run:

```sh
pnpm --filter @omd/engine test -- codeCache.test.ts blockwidgets.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/engine/src/decorations/widgets/code.ts packages/engine/test/codeCache.test.ts
git commit -m "perf: bound code highlight cache"
```

### Task 3: Dynamically load Shiki core with single-flight retry

**Files:**
- Create: `packages/engine/src/shiki/codeHighlighter.ts`
- Create: `packages/engine/test/codeHighlighter.test.ts`
- Modify: `packages/engine/src/decorations/widgets/code.ts:1-31,253-267`

**Interfaces:**

```ts
import type { HighlighterCore } from "shiki/core"

export function getCodeHighlighter(): Promise<HighlighterCore>
```

- [ ] **Step 1: Write failing loader tests with mocked dynamic modules**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest"

const createHighlighterCore = vi.fn(async () => ({ kind: "highlighter" }))
const createJavaScriptRegexEngine = vi.fn(() => ({ kind: "engine" }))

vi.mock("shiki/core", () => ({ createHighlighterCore }))
vi.mock("shiki/engine/javascript", () => ({ createJavaScriptRegexEngine }))
vi.mock("shiki/themes/github-light.mjs", () => ({ default: { name: "light" } }))
vi.mock("shiki/themes/github-dark.mjs", () => ({ default: { name: "dark" } }))

describe("code highlighter loader", () => {
  beforeEach(() => {
    vi.resetModules()
    createHighlighterCore.mockClear()
  })

  it("shares one initialization across concurrent callers", async () => {
    const { getCodeHighlighter } = await import("../src/shiki/codeHighlighter")
    const [a, b] = await Promise.all([getCodeHighlighter(), getCodeHighlighter()])
    expect(a).toBe(b)
    expect(createHighlighterCore).toHaveBeenCalledOnce()
  })

  it("clears a rejected initialization so a later call can retry", async () => {
    createHighlighterCore
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValueOnce({ kind: "highlighter" })
    const { getCodeHighlighter } = await import("../src/shiki/codeHighlighter")
    await expect(getCodeHighlighter()).rejects.toThrow("load failed")
    await expect(getCodeHighlighter()).resolves.toEqual({ kind: "highlighter" })
    expect(createHighlighterCore).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run the loader test and verify failure**

Run:

```sh
pnpm --filter @omd/engine test -- codeHighlighter.test.ts
```

Expected: FAIL because the loader module does not exist.

- [ ] **Step 3: Implement dynamic single-flight loading**

```ts
import type { HighlighterCore } from "shiki/core"

let highlighterPromise: Promise<HighlighterCore> | null = null

async function createCodeHighlighter(): Promise<HighlighterCore> {
  const [core, engine, light, dark] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-light.mjs"),
    import("shiki/themes/github-dark.mjs"),
  ])
  return core.createHighlighterCore({
    themes: [light.default, dark.default],
    langs: [],
    engine: engine.createJavaScriptRegexEngine(),
  })
}

export function getCodeHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createCodeHighlighter().catch(error => {
      highlighterPromise = null
      throw error
    })
  }
  return highlighterPromise
}
```

- [ ] **Step 4: Remove static Shiki runtime imports from code widget**

Keep only type imports if needed and import `getCodeHighlighter` from the new
module. The existing `try/catch` in `renderShiki` continues to preserve the
plain `<pre>` fallback.

- [ ] **Step 5: Run loader and widget tests**

Run:

```sh
pnpm --filter @omd/engine test -- codeHighlighter.test.ts blockwidgets.test.ts
```

Expected: PASS.

- [ ] **Step 6: Build desktop and record bundle delta**

Run:

```sh
pnpm --filter @omd/desktop build
find apps/desktop/dist/assets -maxdepth 1 -name 'index-*.js' -exec ls -lh {} \;
```

Expected:

- build passes;
- the main raw chunk is below the 1,226.70 kB baseline;
- target is at least 10% reduction;
- Shiki core appears in a lazy chunk rather than the main entry.

- [ ] **Step 7: Commit**

```sh
git add packages/engine/src/shiki/codeHighlighter.ts \
  packages/engine/src/decorations/widgets/code.ts \
  packages/engine/test/codeHighlighter.test.ts
git commit -m "perf: lazy load shiki highlighter"
```

### Task 4: Remove repeated TableWidget serialization

**Files:**
- Modify: `packages/engine/src/decorations/widgets/table.ts:105-125`
- Modify: `packages/engine/test/blockwidgets.test.ts:90-125`
- Create: `packages/engine/test/tableWidgetEquality.test.ts`

**Interfaces:**
- Produces internal helper:

```ts
export function tableEqualityKey(table: TableData): string
```

- [ ] **Step 1: Write failing equality-key tests**

```ts
it("distinguishes every table DOM input", () => {
  expect(tableEqualityKey({ header: ["a"], rows: [["1"]], aligns: [""] }))
    .not.toBe(tableEqualityKey({ header: ["b"], rows: [["1"]], aligns: [""] }))
  expect(tableEqualityKey({ header: ["a"], rows: [["1"]], aligns: [""] }))
    .not.toBe(tableEqualityKey({ header: ["a"], rows: [["2"]], aligns: [""] }))
  expect(tableEqualityKey({ header: ["a"], rows: [["1"]], aligns: [""] }))
    .not.toBe(tableEqualityKey({ header: ["a"], rows: [["1"]], aligns: ["right"] }))
})

it("reuses a construction-time key across repeated equality checks", () => {
  const table = { header: ["a"], rows: [["1"]], aligns: [""] } satisfies TableData
  const left = new TableWidget("| a |", 0, table)
  const right = new TableWidget("| a |", 10, table)
  expect(left.eq(right)).toBe(true)
  expect(left.eq(right)).toBe(true)
})
```

- [ ] **Step 2: Run the focused tests**

Run:

```sh
pnpm --filter @omd/engine test -- tableWidgetEquality.test.ts blockwidgets.test.ts
```

Expected: FAIL because `tableEqualityKey` and the cached key are absent.

- [ ] **Step 3: Compute the token once**

```ts
export function tableEqualityKey(table: TableData): string {
  return JSON.stringify(table)
}

export class TableWidget extends BlockWidget {
  private readonly equalityKey: string

  constructor(/* existing args */) {
    super(src, pos, embed)
    this.equalityKey = tableEqualityKey(table)
  }

  eq(other: TableWidget) {
    return super.eq(other) && this.equalityKey === other.equalityKey
  }
}
```

This preserves current defensive equality semantics while removing
serialization from repeated comparisons.

- [ ] **Step 4: Run table and block-widget tests**

Run:

```sh
pnpm --filter @omd/engine test -- tableWidgetEquality.test.ts blockwidgets.test.ts tables.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/engine/src/decorations/widgets/table.ts \
  packages/engine/test/tableWidgetEquality.test.ts \
  packages/engine/test/blockwidgets.test.ts
git commit -m "perf: cache table widget equality keys"
```

### Task 5: Benchmark fragmented build-driver ranges

**Files:**
- Modify: `packages/engine/bench/measure.ts`
- Create: `packages/engine/bench/buildDriver.bench.ts`
- Modify only if justified: `packages/engine/src/decorations/buildDriver.ts`
- Modify only if implementation changes: `packages/engine/test/buildDriver.test.ts`

**Interfaces:**
- Produces:

```ts
export function measureFragmentedRangeSelection(options: {
  pendingCount: number
  regionCount: number
  iterations: number
}): number
```

- [ ] **Step 1: Add a deterministic advisory benchmark**

Export the existing helpers from the internal module only (do not re-export
them from `src/index.ts`):

```ts
export function pendingInWindow(
  pending: ClosedRange[],
  window: ClosedRange[],
): ClosedRange[]

export function nearestChunk(
  pending: ClosedRange[],
  regions: ClosedRange[],
): ClosedRange
```

Generate sorted disjoint closed ranges:

```ts
function ranges(count: number, width: number, gap: number) {
  return Array.from({ length: count }, (_, index) => {
    const from = index * (width + gap)
    return { from, to: from + width - 1 }
  })
}
```

Implement the measurement in `bench/measure.ts`:

```ts
export function measureFragmentedRangeSelection(options: {
  pendingCount: number
  regionCount: number
  iterations: number
}): number {
  const pending = ranges(options.pendingCount, 32, 32)
  const regions = ranges(options.regionCount, 16, 1000)
  const started = performance.now()
  for (let i = 0; i < options.iterations; i++) {
    const targets = pendingInWindow(pending, regions)
    if (targets.length > 0) nearestChunk(targets, regions)
  }
  return (performance.now() - started) / options.iterations
}
```

Keep the range generator beside this function or export a benchmark-local
equivalent; do not add it to the engine public API.

Measure the same operations used by safe-mode scheduling over:

- 1 pending / 1 region;
- 1,000 pending / 1 region;
- 1,000 pending / 64 regions.

Print milliseconds and relative scaling. Do not add a hard timing assertion.

- [ ] **Step 2: Run the benchmark and record the result**

Run:

```sh
pnpm --filter @omd/engine bench -- buildDriver.bench.ts
```

Expected: benchmark completes and prints all three scenarios.

- [ ] **Step 3: Apply the benchmark gate**

If the 1,000 × 64 scenario is below 1ms per selection pass on the development
machine, make no production change and commit only the benchmark.

If it is 1ms or greater, replace nested intersection scans with this
two-pointer helper:

```ts
function intersectSortedRanges(
  pending: readonly ClosedRange[],
  regions: readonly ClosedRange[],
): ClosedRange[] {
  const result: ClosedRange[] = []
  let i = 0
  let j = 0
  while (i < pending.length && j < regions.length) {
    const left = pending[i]
    const right = regions[j]
    const from = Math.max(left.from, right.from)
    const to = Math.min(left.to, right.to)
    if (from <= to) result.push({ from, to })
    if (left.to < right.to) i++
    else j++
  }
  return result
}
```

Compute `visibleRegions`, `buildWindow`, and `pruneWindow` once per driver pass
and pass them into helper functions. Preserve point ranges.

- [ ] **Step 4: If production code changed, add equivalence tests**

Cover multiple disjoint ranges, point ranges, no intersections, and exact
boundary intersections in `buildDriver.test.ts`.

- [ ] **Step 5: Run full engine tests and benchmarks**

Run:

```sh
pnpm test
pnpm --filter @omd/engine bench
```

Expected: tests pass and no existing advisory budget gains a warning.

- [ ] **Step 6: Update engine rules and commit**

Add bounded cache and lazy loader invariants to `packages/engine/AGENTS.md`,
then commit:

```sh
git add packages/engine/bench packages/engine/src/decorations/buildDriver.ts \
  packages/engine/test/buildDriver.test.ts packages/engine/AGENTS.md
git commit -m "perf: benchmark fragmented live build ranges"
```
