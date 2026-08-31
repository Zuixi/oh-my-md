import { describe, expect, it } from "vitest"
import { createCodeHtmlCache } from "../src/decorations/widgets/codeHtmlCache"

describe("code html cache", () => {
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
})
