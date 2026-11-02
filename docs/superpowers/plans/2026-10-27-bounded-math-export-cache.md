# Bounded Math Export Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound KaTeX export-cache retention while preserving repeat-export reuse and rich-export output.

**Architecture:** Extract the cache construction into a small export-owned module that uses the existing generic `BoundedLru`. Keep cache keys and error fallback behavior unchanged; only successful KaTeX HTML enters the bounded cache.

**Tech Stack:** TypeScript, Vitest, KaTeX, existing `BoundedLru`.

**Spec:** [`docs/superpowers/specs/2026-08-10-oh-my-md-design.md`](../specs/2026-08-10-oh-my-md-design.md)

## Global Constraints

- Do not clear the cache after every export; repeat exports should remain fast.
- Do not cache KaTeX failures or fallback `<code>` output.
- Count retained UTF-16 HTML as `html.length * 2`, matching `codeHtmlCache`.
- Use both an entry limit and a byte limit.

---

### Task 1: Specify the math cache limits

**Files:**
- Create: `packages/engine/src/export/mathHtmlCache.ts`
- Create: `packages/engine/test/mathHtmlCache.test.ts`
- Read: `packages/engine/src/cache/boundedLru.ts`
- Read: `packages/engine/src/decorations/widgets/codeHtmlCache.ts`

**Interfaces:**
- Produces:

```ts
export const MATH_HTML_CACHE_MAX_ENTRIES = 128
export const MATH_HTML_CACHE_MAX_BYTES = 8 * 1024 * 1024
export function createMathHtmlCache(): BoundedLru<string, string>
```

- [ ] **Step 1: Write the failing cache tests**

```ts
import { describe, expect, it } from "vitest"
import {
  createMathHtmlCache,
  MATH_HTML_CACHE_MAX_BYTES,
  MATH_HTML_CACHE_MAX_ENTRIES,
} from "../src/export/mathHtmlCache"

describe("mathHtmlCache", () => {
  it("evicts least-recently-used entries by count", () => {
    const cache = createMathHtmlCache()
    for (let i = 0; i <= MATH_HTML_CACHE_MAX_ENTRIES; i++) {
      cache.set(`k${i}`, `v${i}`)
    }
    expect(cache.entryCount).toBe(MATH_HTML_CACHE_MAX_ENTRIES)
    expect(cache.get("k0")).toBeUndefined()
    expect(cache.get(`k${MATH_HTML_CACHE_MAX_ENTRIES}`)).toBeDefined()
  })

  it("does not retain one result larger than the byte budget", () => {
    const cache = createMathHtmlCache()
    cache.set("oversized", "x".repeat(MATH_HTML_CACHE_MAX_BYTES / 2 + 1))
    expect(cache.entryCount).toBe(0)
    expect(cache.retainedSize).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test and confirm the module is missing**

```bash
pnpm --filter @omd/engine exec vitest run test/mathHtmlCache.test.ts
```

Expected: FAIL because `src/export/mathHtmlCache.ts` does not exist.

- [ ] **Step 3: Implement the factory**

```ts
import { BoundedLru } from "../cache/boundedLru"

export const MATH_HTML_CACHE_MAX_ENTRIES = 128
export const MATH_HTML_CACHE_MAX_BYTES = 8 * 1024 * 1024

export function createMathHtmlCache() {
  return new BoundedLru<string, string>({
    maxEntries: MATH_HTML_CACHE_MAX_ENTRIES,
    maxSize: MATH_HTML_CACHE_MAX_BYTES,
    sizeOf: html => html.length * 2,
  })
}
```

- [ ] **Step 4: Run the focused test**

```bash
pnpm --filter @omd/engine exec vitest run \
  test/mathHtmlCache.test.ts \
  test/boundedLru.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/export/mathHtmlCache.ts \
  packages/engine/test/mathHtmlCache.test.ts
git commit -m "test: specify bounded math export cache"
```

### Task 2: Replace the unbounded export map

**Files:**
- Modify: `packages/engine/src/export/html.ts:194-204`
- Modify: `packages/engine/test/export-rich.test.ts`
- Test: `packages/engine/test/mathHtmlCache.test.ts`

**Interfaces:**
- Preserves: `exportRichHtml(state, options)`.
- Replaces: `Map<string, string>` with `BoundedLru<string, string>`.

- [ ] **Step 1: Add an output regression before changing the cache**

Add a test that exports the same inline and block TeX twice and asserts identical KaTeX output:

```ts
it("keeps repeat math exports byte-identical", async () => {
  const state = makeState("$x_1$\n\n$$\ny^2\n$$")
  const first = await exportRichHtml(state)
  const second = await exportRichHtml(state)
  expect(second).toBe(first)
  expect(second).toMatch(/katex|<math/)
})
```

- [ ] **Step 2: Replace the cache**

In `html.ts`:

```ts
import { createMathHtmlCache } from "./mathHtmlCache"

const mathHtmlCache = createMathHtmlCache()
```

Keep the existing `get`/`set` calls and catch behavior unchanged.

- [ ] **Step 3: Run focused export tests**

```bash
pnpm --filter @omd/engine exec vitest run \
  test/mathHtmlCache.test.ts \
  test/export-rich.test.ts \
  test/export.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run the engine suite**

```bash
pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/export/html.ts \
  packages/engine/test/export-rich.test.ts
git commit -m "fix: bound retained math export html"
```

## Why This Plan, Not the Alternatives

- **Why `BoundedLru`:** it is already tested, tracks both count and retained bytes, and matches the code-highlighting cache pattern.
- **Why 128 entries / 8 MiB:** it uses the repository's existing rich-HTML cache budget instead of introducing an unrelated policy; the byte limit remains authoritative for large equations.
- **Why not clear per export:** users commonly export repeatedly while editing, and KaTeX output for unchanged equations is deterministic and reusable.
- **Why not cache failures:** a later export may run after the invalid source is fixed or after a transient module-loading problem; retaining fallback output would hide recovery.
