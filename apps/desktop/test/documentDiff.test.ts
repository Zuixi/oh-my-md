import { describe, expect, it } from "vitest"
import { unifiedDiff } from "../src/documentDiff"

describe("document diff", () => {
  it("produces one hunk with context and line numbers", () => {
    const hunks = unifiedDiff("a\nmine\nc\n", "a\ntheirs\nc\n")
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines.map(line => [line.kind, line.text])).toEqual([
      ["context", "a"],
      ["removed", "theirs"],
      ["added", "mine"],
      ["context", "c"],
    ])
    expect(hunks[0].lines.find(line => line.kind === "added")?.localLine).toBe(2)
  })

  it("marks a deleted file as fully added", () => {
    const hunks = unifiedDiff("only mine\n", "")
    expect(hunks[0].lines.every(line => line.kind === "added")).toBe(true)
  })

  it("returns no hunk for identical documents", () => {
    expect(unifiedDiff("same\n", "same\n")).toEqual([])
  })

  it("splits distant changes into separate hunks", () => {
    const local = ["mine", "b", "c", "d", "e", "f", "g", "h", "i", "mine tail"].join("\n")
    const dsk = ["theirs", "b", "c", "d", "e", "f", "g", "h", "i", "theirs tail"].join("\n")
    const hunks = unifiedDiff(local, dsk)
    expect(hunks).toHaveLength(2)
    expect(hunks[0].localStart).toBe(1)
    expect(hunks[1].lines.some(line => line.text === "mine tail")).toBe(true)
  })

  it("falls back to a single replacement hunk for very large changes", () => {
    const local = Array.from({ length: 2500 }, (_, index) => `mine ${index}`).join("\n")
    const dsk = Array.from({ length: 2500 }, (_, index) => `theirs ${index}`).join("\n")
    const hunks = unifiedDiff(local, dsk)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines.filter(line => line.kind === "removed")).toHaveLength(2500)
    expect(hunks[0].lines.filter(line => line.kind === "added")).toHaveLength(2500)
  })
})
