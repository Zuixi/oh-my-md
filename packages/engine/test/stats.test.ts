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

// The bounds-based implementation must stay byte-for-byte equivalent to the
// previous `text.replace(FRONT_MATTER, "").trim()` version, which allocated two
// full-document strings per call.
const LEGACY_FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/
const LEGACY_WORD =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[A-Za-z0-9]+/gu

function legacyDocumentStats(text: string): { words: number; chars: number } {
  const trimmed = text.replace(LEGACY_FRONT_MATTER, "").trim()
  if (!trimmed) return { words: 0, chars: 0 }
  LEGACY_WORD.lastIndex = 0
  let words = 0
  while (LEGACY_WORD.exec(trimmed)) words += 1
  return { words, chars: trimmed.length }
}

describe("documentStats bounds parity", () => {
  const cases: readonly string[] = [
    "",
    " ",
    "\n\t\n",
    "   hello world   ",
    "\u00a0hello\u3000world\ufeff",
    "---\n---\n",
    "---\n---",
    "---\ntitle: x\n---",
    "---\ntitle: x\n---\n",
    "---\ntitle: x\n---\nbody",
    "---\ntitle: x\n---\n\n\nbody text here\n\n",
    "---\r\ntitle: x\r\n---\r\nbody text",
    "---\r\ntitle: x\r\n---\r\n",
    "---\na\n----\nbody",
    "---\na\n---\rbody",
    "---\na\n---\n   \n",
    "---\ntitle: unclosed\nbody text",
    "\n---\ntitle: x\n---\nnot front matter",
    "正文 test",
    "中文测试",
    "𠀀",
    "写 hello 文档",
    "abc123 中文 한글 カナ",
    "hello—world",
    "a@b.co and https://example.com",
    "trailing spaces   ",
    "\n\n# Heading\n\nbody with **bold** and `code`\n",
  ]

  it.each(cases.map(text => [JSON.stringify(text), text] as const))(
    "matches the legacy result for %s",
    (_label, text) => {
      expect(documentStats(text)).toEqual(legacyDocumentStats(text))
    },
  )

  it("counts a large body without trimming a copy of it", () => {
    const body = "word ".repeat(20_000)
    expect(documentStats(`---\ntitle: x\n---\n${body}`)).toEqual({
      words: 20_000,
      chars: body.trimEnd().length,
    })
  })
})
