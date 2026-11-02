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
