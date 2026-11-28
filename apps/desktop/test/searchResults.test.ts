import { describe, expect, it } from "vitest"
import { groupSearchHits } from "../src/searchResults"
import type { SearchHit } from "../src/SearchPanel"

function hit(path: string, line: number, text = "match line"): SearchHit {
  return { path, line, text, start: 0, end: 5 }
}

describe("groupSearchHits", () => {
  it("returns an empty list for empty hits", () => {
    expect(groupSearchHits([], "/notes")).toEqual([])
  })

  it("groups hits by file while preserving first-seen file and hit order", () => {
    const groups = groupSearchHits(
      [
        hit("/notes/sub/a.md", 10, "first"),
        hit("/notes/root.md", 2, "root"),
        hit("/notes/sub/a.md", 24, "second"),
      ],
      "/notes",
    )
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual({
      path: "/notes/sub/a.md",
      name: "a.md",
      relativeDir: "sub",
      hits: [
        hit("/notes/sub/a.md", 10, "first"),
        hit("/notes/sub/a.md", 24, "second"),
      ],
    })
    expect(groups[1]).toEqual({
      path: "/notes/root.md",
      name: "root.md",
      relativeDir: "",
      hits: [hit("/notes/root.md", 2, "root")],
    })
  })

  it("formats nested relative directories and handles null folder", () => {
    const nested = groupSearchHits([hit("/notes/a/b/c.md", 1)], "/notes")
    expect(nested[0]?.relativeDir).toBe("a/b")

    const noFolder = groupSearchHits([hit("/notes/a/c.md", 1)], null)
    expect(noFolder[0]?.relativeDir).toBe("/notes/a")
  })
})
