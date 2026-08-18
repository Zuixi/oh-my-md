import { describe, expect, it } from "vitest"
import {
  collectMatches,
  nextIndex,
  prevIndex,
  replaceAll,
  validateFindPattern,
  type FindQuery,
} from "../src/findReplace"

function textQuery(query: string, opts: Partial<FindQuery> = {}): FindQuery {
  return {
    query,
    caseSensitive: false,
    regex: false,
    wholeWord: false,
    ...opts,
  }
}

describe("collectMatches", () => {
  it("finds overlapping-safe literal matches", () => {
    expect(collectMatches("aaa", textQuery("aa"))).toEqual([
      { from: 0, to: 2 },
    ])
  })
  it("honors case sensitivity", () => {
    expect(collectMatches("Ab", textQuery("ab"))).toHaveLength(1)
    expect(collectMatches("Ab", textQuery("ab", { caseSensitive: true }))).toHaveLength(0)
  })
  it("empty query is empty", () => {
    expect(collectMatches("abc", textQuery(""))).toEqual([])
  })
  it("treats literal special characters as text", () => {
    expect(collectMatches("a.b axb", textQuery("a.b"))).toEqual([{ from: 0, to: 3 }])
  })
  it("matches whole ASCII words only when wholeWord is on", () => {
    const doc = "cat category concatenate"
    expect(collectMatches(doc, textQuery("cat", { wholeWord: true }))).toEqual([
      { from: 0, to: 3 },
    ])
    expect(collectMatches(doc, textQuery("cat"))).toHaveLength(3)
  })
  it("wholeWord never blocks CJK queries (no \\b next to Han characters)", () => {
    expect(collectMatches("中文片段中", textQuery("中文", { wholeWord: true }))).toEqual([
      { from: 0, to: 2 },
    ])
  })
  it("regex mode matches patterns case-insensitively by default", () => {
    expect(collectMatches("a1b2", textQuery("\\d", { regex: true }))).toHaveLength(2)
    expect(collectMatches("ABC", textQuery("abc", { regex: true, caseSensitive: true }))).toHaveLength(0)
  })
  it("invalid regex yields no matches without throwing", () => {
    expect(collectMatches("abc", textQuery("[", { regex: true }))).toEqual([])
  })
  it("skips zero-length regex matches", () => {
    expect(collectMatches("abc", textQuery("x*", { regex: true }))).toEqual([])
  })
})

describe("validateFindPattern", () => {
  it("reports invalid regex only in regex mode", () => {
    expect(validateFindPattern(textQuery("["))).toBeNull()
    expect(validateFindPattern(textQuery("[", { regex: true }))).toBeTruthy()
    expect(validateFindPattern(textQuery("", { regex: true }))).toBeNull()
  })
})

describe("index wrap", () => {
  it("wraps next and prev", () => {
    expect(nextIndex(3, 2)).toBe(0)
    expect(prevIndex(3, 0)).toBe(2)
    expect(nextIndex(0, 0)).toBe(0)
  })
})

describe("replaceAll", () => {
  it("replaces every non-overlapping match", () => {
    expect(replaceAll("foo foo", textQuery("foo", { caseSensitive: true }), "bar")).toBe("bar bar")
  })
  it("keeps text-mode replacements literal ($& is not interpreted)", () => {
    expect(replaceAll("foo", textQuery("foo"), "$&!")).toBe("$&!")
  })
  it("honors capture references in regex mode", () => {
    expect(replaceAll("a1 b2", textQuery("(\\w)(\\d)", { regex: true }), "$2$1")).toBe("1a 2b")
  })
  it("invalid regex leaves the document unchanged", () => {
    expect(replaceAll("abc", textQuery("[", { regex: true }), "x")).toBe("abc")
  })
})
