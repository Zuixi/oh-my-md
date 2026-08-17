import { describe, expect, it } from "vitest"
import { MAX_RECENTS, rememberPath } from "../src/recents"

describe("recent files", () => {
  it("puts a newly opened path first and drops duplicates", () => {
    expect(rememberPath(["/b.md", "/a.md"], "/a.md")).toEqual(["/a.md", "/b.md"])
  })

  it("keeps only the most recent files", () => {
    const recents = Array.from({ length: MAX_RECENTS }, (_, index) => `/${index}.md`)
    expect(rememberPath(recents, "/new.md")).toEqual(["/new.md", ...recents.slice(0, MAX_RECENTS - 1)])
  })
})
