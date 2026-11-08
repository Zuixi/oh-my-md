import { describe, expect, it } from "vitest"
import {
  draftRowIndex,
  emptyFileTree,
  pathsToRefresh,
  removeTreePath,
  renameTreePath,
  replaceTreePrefix,
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

describe("draftRowIndex", () => {
  it("appends a root draft after every visible row", () => {
    expect(draftRowIndex([], root, root)).toBe(0)
    const rows = visibleRows(root, rooted())
    expect(draftRowIndex(rows, root, root)).toBe(rows.length)
  })

  it("inserts the draft after a directory's last visible descendant", () => {
    const model = setChildren(toggleExpand(rooted(), drafts.path), drafts.path, [idea])
    const rows = visibleRows(root, model)
    // drafts, idea.md, readme.md → the child belongs between idea.md and readme.md.
    expect(rows.map(row => row.entry.name)).toEqual(["drafts", "idea.md", "readme.md"])
    expect(draftRowIndex(rows, drafts.path, root)).toBe(2)
  })

  it("inserts directly after a collapsed directory", () => {
    const rows = visibleRows(root, rooted())
    expect(draftRowIndex(rows, drafts.path, root)).toBe(1)
  })

  it("returns -1 when the target directory is not visible", () => {
    const rows = visibleRows(root, rooted())
    expect(draftRowIndex(rows, "/notes/missing", root)).toBe(-1)
  })

  it("matches paths across Windows separators", () => {
    const windowsRoot = "C:\\notes"
    const dirRow = {
      entry: { name: "drafts", path: "C:\\notes\\drafts", is_dir: true },
      depth: 0,
      expanded: true,
    }
    const childRow = {
      entry: { name: "idea.md", path: "C:\\notes\\drafts\\idea.md", is_dir: false },
      depth: 1,
      expanded: false,
    }
    expect(draftRowIndex([dirRow, childRow], "C:/notes/drafts", windowsRoot)).toBe(2)
  })
})

describe("tree path rewrites", () => {
  it("replaceTreePrefix keeps native paths native and leaves siblings alone", () => {
    expect(replaceTreePrefix("C:\\notes\\drafts\\a.md", "C:\\notes\\drafts", "C:\\notes\\ideas"))
      .toBe("C:\\notes\\ideas\\a.md")
    expect(replaceTreePrefix("C:\\notes\\drafts", "C:\\notes\\drafts", "C:\\notes\\ideas"))
      .toBe("C:\\notes\\ideas")
    expect(replaceTreePrefix("C:\\notes\\other.md", "C:\\notes\\drafts", "C:\\notes\\ideas"))
      .toBe("C:\\notes\\other.md")
  })

  it("replaceTreePrefix accepts either side in extended-length form", () => {
    expect(replaceTreePrefix("C:\\notes\\drafts\\a.md", "\\\\?\\C:\\notes\\drafts", "C:\\notes\\ideas"))
      .toBe("C:\\notes\\ideas\\a.md")
    expect(replaceTreePrefix("\\\\?\\C:\\notes\\drafts\\a.md", "C:\\notes\\drafts", "C:\\notes\\ideas"))
      .toBe("C:\\notes\\ideas\\a.md")
  })

  it("replaceTreePrefix preserves a verbatim target instead of simplifying it", () => {
    // The IPC boundary already rebased the result onto the tree's own form;
    // stripping a verbatim prefix here would desynchronize cached keys from
    // the next list_dir refresh of a verbatim-root workspace.
    expect(replaceTreePrefix(
      "\\\\?\\C:\\notes\\drafts\\a.md",
      "\\\\?\\C:\\notes\\drafts",
      "\\\\?\\C:\\notes\\ideas",
    )).toBe("\\\\?\\C:\\notes\\ideas\\a.md")
  })

  it("replaceTreePrefix keeps POSIX separators when the target name has a backslash", () => {
    expect(replaceTreePrefix("/notes/drafts/idea.md", "/notes/drafts", "/notes/a\\b"))
      .toBe("/notes/a\\b/idea.md")
  })

  it("removeTreePath drops a native-Windows subtree from listings and expansion", () => {
    const dir = "C:\\notes\\drafts"
    const model = setChildren(
      setChildren(toggleExpand(emptyFileTree(), dir), "C:\\notes", [
        { name: "drafts", path: dir, is_dir: true },
        { name: "readme.md", path: "C:\\notes\\readme.md", is_dir: false },
      ]),
      dir,
      [{ name: "idea.md", path: "C:\\notes\\drafts\\idea.md", is_dir: false }],
    )
    const removed = removeTreePath(model, dir)
    expect(removed.childrenByPath[dir]).toBeUndefined()
    expect(removed.childrenByPath["C:\\notes"]).toEqual([
      { name: "readme.md", path: "C:\\notes\\readme.md", is_dir: false },
    ])
    expect(removed.expanded.has(dir)).toBe(false)
  })

  it("removeTreePath removes descendants in a different separator form", () => {
    const dir = "C:/notes/drafts"
    const model = setChildren(emptyFileTree(), dir, [
      { name: "idea.md", path: "C:\\notes\\drafts\\idea.md", is_dir: false },
    ])
    expect(removeTreePath(model, dir).childrenByPath[dir]).toBeUndefined()
  })

  it("removeTreePath keeps sibling prefixes and POSIX backslash names", () => {
    const sibling = "/notes/drafts-2"
    const model = setChildren(emptyFileTree(), "/notes", [
      { name: "drafts-2", path: sibling, is_dir: true },
      { name: "drafts\\old", path: "/notes/drafts\\old", is_dir: true },
    ])
    expect(removeTreePath(model, "/notes/drafts").childrenByPath["/notes"]).toEqual([
      { name: "drafts-2", path: sibling, is_dir: true },
      { name: "drafts\\old", path: "/notes/drafts\\old", is_dir: true },
    ])
  })

  it("renameTreePath moves cached listings, expansion, and the entry name", () => {
    const rootPath = "C:\\notes"
    const draftsPath = "C:\\notes\\drafts"
    const model = setChildren(
      toggleExpand(emptyFileTree(), draftsPath),
      draftsPath,
      [{ name: "idea.md", path: "C:\\notes\\drafts\\idea.md", is_dir: false }],
    )
    const renamed = renameTreePath(model, draftsPath, "C:\\notes\\ideas")
    expect(renamed.childrenByPath["C:\\notes\\ideas"]).toEqual([
      { name: "idea.md", path: "C:\\notes\\ideas\\idea.md", is_dir: false },
    ])
    expect(renamed.childrenByPath[draftsPath]).toBeUndefined()
    expect(renamed.expanded.has("C:\\notes\\ideas")).toBe(true)
    expect(renamed.expanded.has(draftsPath)).toBe(false)

    const listed = setChildren(
      emptyFileTree(),
      rootPath,
      [{ name: "drafts", path: draftsPath, is_dir: true }],
    )
    expect(renameTreePath(listed, draftsPath, "C:\\notes\\ideas").childrenByPath[rootPath])
      .toEqual([{ name: "ideas", path: "C:\\notes\\ideas", is_dir: true }])
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
