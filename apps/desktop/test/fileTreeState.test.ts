import { describe, expect, it } from "vitest"
import {
  emptyFileTree,
  pathsToRefresh,
  setChildren,
  toggleExpand,
  visibleRowRange,
  visibleRows,
  type TreeEntry,
} from "../src/fileTreeState"

const root = "/notes"
const drafts: TreeEntry = { name: "drafts", path: "/notes/drafts", is_dir: true }
const readme: TreeEntry = { name: "readme.md", path: "/notes/readme.md", is_dir: false }
const idea: TreeEntry = { name: "idea.md", path: "/notes/drafts/idea.md", is_dir: false }

function rooted() {
  return setChildren(emptyFileTree(), root, [drafts, readme])
}

describe("file tree model", () => {
  it("lists only the root folder until a directory is expanded", () => {
    const rows = visibleRows(root, rooted())
    expect(rows.map(row => row.entry.name)).toEqual(["drafts", "readme.md"])
    expect(rows.every(row => row.depth === 0)).toBe(true)
    expect(rows[0]?.expanded).toBe(false)
  })

  it("inserts children under an expanded directory without dropping siblings", () => {
    const expanded = setChildren(toggleExpand(rooted(), drafts.path), drafts.path, [idea])
    const rows = visibleRows(root, expanded)
    expect(rows.map(row => [row.depth, row.entry.name, row.expanded])).toEqual([
      [0, "drafts", true],
      [1, "idea.md", false],
      [0, "readme.md", false],
    ])
  })

  it("hides descendants when collapsing but keeps the cached listing", () => {
    const open = setChildren(toggleExpand(rooted(), drafts.path), drafts.path, [idea])
    const closed = toggleExpand(open, drafts.path)
    expect(visibleRows(root, closed).map(row => row.entry.name)).toEqual(["drafts", "readme.md"])
    expect(closed.childrenByPath[drafts.path]).toEqual([idea])
  })

  it("does not mutate the previous model when caching listings", () => {
    const before = rooted()
    const after = setChildren(before, drafts.path, [idea])
    expect(before.childrenByPath[drafts.path]).toBeUndefined()
    expect(after.childrenByPath[drafts.path]).toEqual([idea])
  })

  it("refreshes the root and every cached directory", () => {
    const model = setChildren(rooted(), drafts.path, [idea])
    expect(pathsToRefresh(root, model).sort()).toEqual(["/notes", "/notes/drafts"])
  })
})

describe("visibleRowRange", () => {
  it("covers a list that fits the viewport", () => {
    expect(visibleRowRange(5, 130, 0)).toEqual({ start: 0, end: 5 })
  })

  it("windows a tall list around the scroll offset with overscan", () => {
    // 1000 rows * 26px = 26000px; viewport 300px scrolled to 13000px.
    const window = visibleRowRange(1000, 300, 13000)
    expect(window.start).toBe(490)
    expect(window.end).toBe(522)
  })

  it("clamps start above zero near the top", () => {
    expect(visibleRowRange(100, 300, 0).start).toBe(0)
  })

  it("clamps to the end of the list when scrolled past the bottom", () => {
    const window = visibleRowRange(100, 300, 100000)
    expect(window.end).toBe(100)
    expect(window.start).toBeLessThan(window.end)
  })

  it("returns an empty window for an empty list", () => {
    expect(visibleRowRange(0, 300, 0)).toEqual({ start: 0, end: 0 })
  })
})
