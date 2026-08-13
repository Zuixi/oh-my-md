import { describe, expect, it } from "vitest"
import {
  emptyFileTree,
  pathsToRefresh,
  setChildren,
  toggleExpand,
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
