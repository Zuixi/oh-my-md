import { beforeEach, describe, expect, it, vi } from "vitest"

const createHighlighterCore = vi.fn()
const createJavaScriptRegexEngine = vi.fn()

vi.mock("shiki/core", () => ({ createHighlighterCore }))
vi.mock("shiki/engine/javascript", () => ({ createJavaScriptRegexEngine }))
vi.mock("shiki/themes/github-light.mjs", () => ({ default: { name: "light" } }))
vi.mock("shiki/themes/github-dark.mjs", () => ({ default: { name: "dark" } }))

describe("code highlighter loader", () => {
  beforeEach(() => {
    vi.resetModules()
    createHighlighterCore.mockReset()
    createJavaScriptRegexEngine.mockReset()
    createHighlighterCore.mockResolvedValue({ kind: "highlighter" })
    createJavaScriptRegexEngine.mockReturnValue({ kind: "engine" })
  })

  it("shares one initialization across concurrent callers", async () => {
    const { getCodeHighlighter } = await import("../src/shiki/codeHighlighter")

    const [a, b] = await Promise.all([getCodeHighlighter(), getCodeHighlighter()])

    expect(a).toBe(b)
    expect(createHighlighterCore).toHaveBeenCalledTimes(1)
    expect(createJavaScriptRegexEngine).toHaveBeenCalledTimes(1)
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
