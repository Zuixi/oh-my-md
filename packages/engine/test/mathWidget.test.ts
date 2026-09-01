import { describe, expect, it, vi } from "vitest"
import { MathBlockWidget, mathTexOf, rebuildMathSrc } from "../src/decorations/widgets/math"

// MathBlockWidget's base imports the live decoration field, which is irrelevant to these tests.
vi.mock("../src/decorations/build", () => ({
  livePreviewField: {},
}))

describe("math source helpers", () => {
  it("extracts tex from single-line and multi-line blocks", () => {
    expect(mathTexOf("$$x+y$$")).toBe("x+y")
    expect(mathTexOf("$$\na = b\n$$")).toBe("a = b")
    expect(mathTexOf("$$ x $$")).toBe("x")
  })

  it("rebuilds preserving the original delimiter shape", () => {
    expect(rebuildMathSrc("$$a$$", "b+c")).toBe("$$b+c$$")
    expect(rebuildMathSrc("$$\na\n$$", "b\nc")).toBe("$$\nb\nc\n$$")
    // 单行形态收到多行草稿时保留单行包裹（Lezer 仍解析为 MathBlock）
    expect(rebuildMathSrc("$$a$$", "b\nc")).toBe("$$b\nc$$")
  })
})

describe("MathBlockWidget identity stability", () => {
  it("eq ignores src and compares embed only", () => {
    const a = new MathBlockWidget("$$a$$", 0)
    const b = new MathBlockWidget("$$totally different$$", 0)
    expect(a.eq(b)).toBe(true)
    const nested = new MathBlockWidget("$$a$$", 0, { quoteDepth: 1, listDepth: 0, quoteInList: false })
    expect(a.eq(nested)).toBe(false)
  })
})
