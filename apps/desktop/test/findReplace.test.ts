import { describe, expect, it } from "vitest"
import { collectMatches, nextIndex, prevIndex, replaceAll } from "../src/findReplace"

describe("collectMatches", () => {
  it("finds overlapping-safe literal matches", () => {
    expect(collectMatches("aaa", "aa", false)).toEqual([
      { from: 0, to: 2 },
    ])
  })
  it("honors case sensitivity", () => {
    expect(collectMatches("Ab", "ab", false)).toHaveLength(1)
    expect(collectMatches("Ab", "ab", true)).toHaveLength(0)
  })
  it("empty query is empty", () => {
    expect(collectMatches("abc", "", false)).toEqual([])
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
    expect(replaceAll("foo foo", "foo", "bar", true)).toBe("bar bar")
  })
})
