import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileTree } from "../src/FileTree"
import type { VisibleRow } from "../src/fileTreeState"

function file(name: string, folder = "/notes"): VisibleRow {
  return { entry: { name, path: `${folder}/${name}`, is_dir: false }, depth: 0, expanded: false }
}

function child(name: string): VisibleRow {
  return {
    entry: { name, path: `/notes/drafts/${name}`, is_dir: false },
    depth: 1,
    expanded: false,
  }
}

function drafts(expanded: boolean): VisibleRow {
  return { entry: { name: "drafts", path: "/notes/drafts", is_dir: true }, depth: 0, expanded }
}

function treeProps(rows: VisibleRow[]) {
  return {
    folder: "/notes",
    rows,
    activePath: null as string | null,
    onOpenFile: vi.fn(),
    onToggleDir: vi.fn(),
    onSearch: vi.fn(),
    onRename: vi.fn(async () => "/notes/renamed.md"),
    onDelete: vi.fn(),
    onReveal: vi.fn(),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

const row = (name: string) => screen.getByRole("treeitem", { name })

describe("file tree WAI-ARIA tree navigation", () => {
  it("exposes one roving tab stop with level/expanded/selected semantics", () => {
    const props = treeProps([drafts(false), file("doc.md")])
    render(<FileTree {...props} />)

    const tree = screen.getByRole("tree", { name: "Files" })
    expect(tree.getAttribute("aria-label")).toBe("Files")

    const draftsRow = row("drafts")
    expect(draftsRow.getAttribute("aria-level")).toBe("1")
    expect(draftsRow.getAttribute("aria-expanded")).toBe("false")
    expect(draftsRow.getAttribute("aria-selected")).toBe("false")
    expect(draftsRow.tabIndex).toBe(0)
    expect(row("doc.md").tabIndex).toBe(-1)
  })

  it("moves focus with ArrowDown/ArrowUp and keeps a single tab stop", () => {
    const props = treeProps([drafts(false), file("doc.md"), file("other.md")])
    render(<FileTree {...props} />)

    fireEvent.keyDown(row("drafts"), { key: "ArrowDown" })
    expect(document.activeElement).toBe(row("doc.md"))
    expect(row("doc.md").tabIndex).toBe(0)
    expect(row("drafts").tabIndex).toBe(-1)

    fireEvent.keyDown(row("doc.md"), { key: "ArrowDown" })
    expect(document.activeElement).toBe(row("other.md"))

    fireEvent.keyDown(row("other.md"), { key: "ArrowUp" })
    expect(document.activeElement).toBe(row("doc.md"))

    fireEvent.keyDown(row("doc.md"), { key: "Home" })
    expect(document.activeElement).toBe(row("drafts"))
    fireEvent.keyDown(row("drafts"), { key: "End" })
    expect(document.activeElement).toBe(row("other.md"))
  })

  it("expands a collapsed directory, enters children, and jumps back to the parent", () => {
    const props = treeProps([drafts(false), file("doc.md")])
    const { rerender } = render(<FileTree {...props} />)

    fireEvent.keyDown(row("drafts"), { key: "ArrowRight" })
    expect(props.onToggleDir).toHaveBeenCalledWith("/notes/drafts")

    props.rows = [drafts(true), child("a.md"), file("doc.md")]
    rerender(<FileTree {...props} />)

    fireEvent.keyDown(row("drafts"), { key: "ArrowRight" })
    expect(document.activeElement).toBe(row("a.md"))

    // Left on a child returns to its ancestor row without toggling anything.
    fireEvent.keyDown(row("a.md"), { key: "ArrowLeft" })
    expect(document.activeElement).toBe(row("drafts"))
    expect(props.onToggleDir).toHaveBeenCalledTimes(1)

    // Left on an expanded directory collapses it.
    fireEvent.keyDown(row("drafts"), { key: "ArrowLeft" })
    expect(props.onToggleDir).toHaveBeenLastCalledWith("/notes/drafts")
    expect(props.onToggleDir).toHaveBeenCalledTimes(2)
  })

  it("opens the row menu from the keyboard and returns focus on Escape", async () => {
    const props = treeProps([drafts(false), file("doc.md")])
    render(<FileTree {...props} />)

    fireEvent.keyDown(row("doc.md"), { key: "F10", shiftKey: true })
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())

    // Disabled items (no create callbacks here) are outside the roving focus.
    const rename = screen.getByRole("menuitem", { name: "Rename" })
    expect(document.activeElement).toBe(rename)
    fireEvent.keyDown(rename, { key: "ArrowDown" })
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }))
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Delete" }), { key: "ArrowUp" })
    expect(document.activeElement).toBe(rename)

    fireEvent.keyDown(rename, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(document.activeElement).toBe(row("doc.md"))
  })

  it("clamps the menu inside the viewport at the bottom-right corner", async () => {
    const props = treeProps([drafts(false), file("doc.md")])
    render(<FileTree {...props} />)

    // happy-dom has no layout engine: give the menu box real dimensions so the
    // clamp has something to measure.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const isMenu = this.getAttribute("role") === "menu"
      const width = isMenu ? 200 : 0
      const height = isMenu ? 150 : 0
      return {
        x: 0, y: 0, width, height,
        top: 0, left: 0, right: width, bottom: height,
        toJSON: () => ({}),
      } as DOMRect
    })

    fireEvent.contextMenu(row("doc.md"), { clientX: 1010, clientY: 760 })

    const menu = await screen.findByRole("menu")
    const expectedLeft = window.innerWidth - 200 - 8
    const expectedTop = window.innerHeight - 150 - 8
    expect(menu.style.left).toBe(`${expectedLeft}px`)
    expect(menu.style.top).toBe(`${expectedTop}px`)
  })
})
