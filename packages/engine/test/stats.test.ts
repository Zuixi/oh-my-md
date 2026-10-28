import { describe, expect, it } from "vitest"
import { documentStats } from "../src/stats"

describe("documentStats", () => {
  it("counts latin words and trimmed chars", () => {
    expect(documentStats("  hello world  ")).toEqual({ words: 2, chars: 11 })
  })
  it("counts each CJK character as a word", () => {
    expect(documentStats("中文测试")).toEqual({ words: 4, chars: 4 })
  })
  it("counts a supplementary-plane Han code point as a word", () => {
    expect(documentStats("𠀀")).toEqual({ words: 1, chars: 2 })
  })
  it("mixes CJK and latin", () => {
    expect(documentStats("写 hello 文档")).toEqual({ words: 4, chars: 10 })
  })
  it("counts Latin runs, Han, Hangul and Katakana as separate words", () => {
    expect(documentStats("abc123 中文 한글 カナ")).toEqual({ words: 7, chars: 15 })
  })
  it("splits words on an em dash without counting it", () => {
    expect(documentStats("hello—world")).toEqual({ words: 2, chars: 11 })
  })
  it("excludes front matter from words and chars", () => {
    const body = "正文 test"
    expect(documentStats("---\ntitle: ignored words\n---\n正文 test")).toEqual({
      words: 3,
      chars: body.length,
    })
  })
  it("excludes front matter without a trailing newline", () => {
    expect(documentStats("---\ntitle: x\n---")).toEqual({ words: 0, chars: 0 })
  })
  it("empty is zero", () => {
    expect(documentStats("   ")).toEqual({ words: 0, chars: 0 })
  })
})
