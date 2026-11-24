import { describe, expect, it } from "vitest"
import { treeKeyIntent, type TreeKeyInput } from "../src/fileTreeKeyboard"
import type { VisibleRow } from "../src/fileTreeState"

function file(name: string, folder: string, depth: number): VisibleRow {
  return { entry: { name, path: `${folder}/${name}`, is_dir: false }, depth, expanded: false }
}

function dir(path: string, depth: number, expanded: boolean): VisibleRow {
  return { entry: { name: path.split("/").pop() ?? path, path, is_dir: true }, depth, expanded }
}

function key(pressed: string, overrides: Partial<TreeKeyInput> = {}): TreeKeyInput {
  return {
    key: pressed,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 0,
    ...overrides,
  }
}

const collapsed: VisibleRow[] = [dir("/notes/drafts", 0, false), file("doc.md", "/notes", 0)]
const expanded: VisibleRow[] = [
  dir("/notes/drafts", 0, true),
  file("a.md", "/notes/drafts", 1),
  file("b.md", "/notes/drafts", 1),
  file("doc.md", "/notes", 0),
]

describe("treeKeyIntent", () => {
  it("walks the visible rows with Up/Down and clamps at the ends", () => {
    expect(treeKeyIntent(key("ArrowDown"), collapsed, "/notes/drafts"))
      .toEqual({ kind: "focus", index: 1 })
    expect(treeKeyIntent(key("ArrowDown"), collapsed, "/notes/doc.md"))
      .toEqual({ kind: "focus", index: 1 })
    expect(treeKeyIntent(key("ArrowUp"), collapsed, "/notes/doc.md"))
      .toEqual({ kind: "focus", index: 0 })
    expect(treeKeyIntent(key("ArrowUp"), collapsed, "/notes/drafts"))
      .toEqual({ kind: "focus", index: 0 })
  })

  it("jumps to the first and last row with Home/End", () => {
    expect(treeKeyIntent(key("End"), expanded, "/notes/drafts"))
      .toEqual({ kind: "focus", index: 3 })
    expect(treeKeyIntent(key("Home"), expanded, "/notes/doc.md"))
      .toEqual({ kind: "focus", index: 0 })
  })

  it("expands a collapsed directory, then enters its first child", () => {
    expect(treeKeyIntent(key("ArrowRight"), collapsed, "/notes/drafts"))
      .toEqual({ kind: "toggle", path: "/notes/drafts" })
    expect(treeKeyIntent(key("ArrowRight"), expanded, "/notes/drafts"))
      .toEqual({ kind: "focus", index: 1 })
    // A file, or an expanded directory with no children, does not move.
    expect(treeKeyIntent(key("ArrowRight"), expanded, "/notes/doc.md")).toBeNull()
  })

  it("collapses an expanded directory, otherwise jumps to the ancestor row", () => {
    expect(treeKeyIntent(key("ArrowLeft"), expanded, "/notes/drafts"))
      .toEqual({ kind: "toggle", path: "/notes/drafts" })
    expect(treeKeyIntent(key("ArrowLeft"), expanded, "/notes/drafts/b.md"))
      .toEqual({ kind: "focus", index: 0 })
    expect(treeKeyIntent(key("ArrowLeft"), expanded, "/notes/doc.md")).toBeNull()
  })

  it("activates with Enter and opens the menu with ContextMenu / Shift+F10", () => {
    expect(treeKeyIntent(key("Enter"), collapsed, "/notes/doc.md"))
      .toEqual({ kind: "open", path: "/notes/doc.md" })
    expect(treeKeyIntent(key("Enter"), collapsed, "/notes/drafts"))
      .toEqual({ kind: "toggle", path: "/notes/drafts" })
    expect(treeKeyIntent(key("ContextMenu"), collapsed, "/notes/doc.md"))
      .toEqual({ kind: "contextMenu", index: 1 })
    expect(treeKeyIntent(key("F10", { shiftKey: true }), collapsed, "/notes/doc.md"))
      .toEqual({ kind: "contextMenu", index: 1 })
    expect(treeKeyIntent(key("F10"), collapsed, "/notes/doc.md")).toBeNull()
  })

  it("never hijacks IME, modifier or unrelated keys", () => {
    expect(treeKeyIntent(key("ArrowDown", { isComposing: true }), collapsed, null)).toBeNull()
    expect(treeKeyIntent(key("ArrowDown", { keyCode: 229 }), collapsed, null)).toBeNull()
    expect(treeKeyIntent(key("ArrowDown", { metaKey: true }), collapsed, null)).toBeNull()
    expect(treeKeyIntent(key("ArrowDown", { ctrlKey: true }), collapsed, null)).toBeNull()
    expect(treeKeyIntent(key("ArrowDown", { altKey: true }), collapsed, null)).toBeNull()
    expect(treeKeyIntent(key("a"), collapsed, null)).toBeNull()
    expect(treeKeyIntent(key("ArrowDown"), [], null)).toBeNull()
  })
})
