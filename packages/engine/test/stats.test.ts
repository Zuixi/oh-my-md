import { describe, expect, it } from "vitest"
import { documentStats } from "../src/stats"

describe("documentStats", () => {
  it("counts latin words and trimmed chars", () => {
    expect(documentStats("  hello world  ")).toEqual({ words: 2, chars: 11 })
  })
  it("counts each CJK character as a word", () => {
    expect(documentStats("中文测试")).toEqual({ words: 4, chars: 4 })
  })
  it("mixes CJK and latin", () => {
    expect(documentStats("写 hello 文档")).toEqual({ words: 4, chars: 10 })
  })
  it("empty is zero", () => {
    expect(documentStats("   ")).toEqual({ words: 0, chars: 0 })
  })
})
