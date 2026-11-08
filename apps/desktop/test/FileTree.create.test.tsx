import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { FileTree } from "../src/FileTree"
import {
  DEPTH_INDENT, ROW_HEIGHT, ROW_INSET, TreeEditError, type CreateKind, type VisibleRow,
} from "../src/fileTreeState"

function file(name = "doc.md", folder = "/notes"): VisibleRow {
  return { entry: { name, path: `${folder}/${name}`, is_dir: false }, depth: 0, expanded: false }
}

function folder(path: string, depth = 0, expanded = false): VisibleRow {
  return {
    entry: { name: path.split("/").pop() ?? path, path, is_dir: true },
    depth,
    expanded,
  }
}

function treeProps(rows: VisibleRow[]) {
  return {
    folder: "/notes",
    rows,
    activePath: null as string | null,
    onOpenFile: vi.fn(),
    onToggleDir: vi.fn(),
    onSearch: vi.fn(),
    onCreateFile: vi.fn(async (dir: string, name: string) => `${dir}/${name}`),
    onCreateFolder: vi.fn(async (dir: string, name: string) => `${dir}/${name}`),
    onSuggestName: vi.fn(async (kind: CreateKind): Promise<string> =>
      kind === "create-file" ? "untitled.md" : "untitled-folder"),
    onEditError: vi.fn(),
  }
}

function openCreate(label: string, item: "New File" | "New Folder"): HTMLInputElement {
  fireEvent.contextMenu(screen.getByRole("button", { name: label }))
  fireEvent.click(screen.getByRole("menuitem", { name: item }))
  return screen.getByRole<HTMLInputElement>("textbox", {
    name: item === "New File" ? "New file name" : "New folder name",
  })
}

describe("文件树内联新建", () => {
  it("进入即聚焦并选中文件名主体，异步建议替换占位名后同样全选", async () => {
    const props = treeProps([file()])
    props.onSuggestName.mockResolvedValue("untitled-2.md")
    render(<FileTree {...props} />)

    const input = openCreate("doc.md", "New File")
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe("untitled.md")
    await waitFor(() => expect(input.value).toBe("untitled-2.md"))
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "untitled-2".length])
  })

  it("Enter 才落盘：调用新建回调并退出输入态", async () => {
    const props = treeProps([file()])
    render(<FileTree {...props} />)

    const input = openCreate("doc.md", "New File")
    fireEvent.change(input, { target: { value: "notes" } })
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })

    expect(props.onCreateFile).toHaveBeenCalledWith("/notes", "notes.md")
    expect(props.onCreateFolder).not.toHaveBeenCalled()
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("Escape 什么也不建，并把焦点还给来源目录行", () => {
    const props = treeProps([folder("/notes/drafts", 0, true), file("doc.md", "/notes/drafts")])
    render(<FileTree {...props} />)

    const input = openCreate("drafts", "New File")
    fireEvent.change(input, { target: { value: "draft.md" } })
    fireEvent.keyDown(input, { key: "Escape" })

    expect(screen.queryByRole("textbox")).toBeNull()
    expect(props.onCreateFile).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "drafts" }))
  })

  it("失焦取消新建，不落盘也不抢回焦点", async () => {
    const props = treeProps([file()])
    render(<FileTree {...props} />)

    const input = openCreate("doc.md", "New File")
    await waitFor(() => expect(input.value).toBe("untitled.md"))
    fireEvent.change(input, { target: { value: "abandoned" } })
    fireEvent.blur(input)

    expect(screen.queryByRole("textbox")).toBeNull()
    expect(props.onCreateFile).not.toHaveBeenCalled()
  })

  it("点击其他行、右键、切换活动文件或收起侧栏都会丢弃草稿", () => {
    const props = treeProps([file(), file("other.md")])
    const view = render(<FileTree {...props} />)

    fireEvent.change(openCreate("doc.md", "New File"), { target: { value: "a.md" } })
    fireEvent.click(screen.getByRole("button", { name: "other.md" }))
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(props.onCreateFile).not.toHaveBeenCalled()
    expect(props.onOpenFile).toHaveBeenCalledWith("/notes/other.md")

    fireEvent.change(openCreate("doc.md", "New File"), { target: { value: "b.md" } })
    fireEvent.contextMenu(screen.getByRole("button", { name: "other.md" }))
    expect(screen.queryByRole("textbox")).toBeNull()

    fireEvent.change(openCreate("doc.md", "New File"), { target: { value: "c.md" } })
    view.rerender(<FileTree {...props} activePath="/notes/other.md" />)
    expect(screen.queryByRole("textbox")).toBeNull()

    fireEvent.change(openCreate("doc.md", "New File"), { target: { value: "d.md" } })
    view.rerender(<FileTree {...props} activePath="/notes/other.md" visible={false} />)
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(props.onCreateFile).not.toHaveBeenCalled()
  })

  it("标签切换取消草稿，提交中的标签切换不会重复写入", async () => {
    let complete!: (path: string) => void
    const props = treeProps([file()])
    props.onCreateFile.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const view = render(<FileTree {...props} activeTabId={1} />)

    fireEvent.change(openCreate("doc.md", "New File"), { target: { value: "late.md" } })
    view.rerender(<FileTree {...props} activeTabId={2} />)
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(props.onCreateFile).not.toHaveBeenCalled()

    const input = openCreate("doc.md", "New File")
    fireEvent.change(input, { target: { value: "kept.md" } })
    fireEvent.keyDown(input, { key: "Enter" })
    view.rerender(<FileTree {...props} activeTabId={3} />)
    expect(screen.queryByRole("textbox")).toBeNull()
    await act(async () => { complete("/notes/kept.md") })
    expect(props.onCreateFile).toHaveBeenCalledTimes(1)
    expect(props.onEditError).not.toHaveBeenCalled()
  })

  it("同步锁阻止连续 Enter 和失焦，提交完成后退出", async () => {
    let complete!: (path: string) => void
    const props = treeProps([file()])
    props.onCreateFile.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    render(<FileTree {...props} />)

    const input = openCreate("doc.md", "New File")
    fireEvent.change(input, { target: { value: "once.md" } })
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" })
      fireEvent.keyDown(input, { key: "Enter" })
      fireEvent.blur(input)
    })
    expect(props.onCreateFile).toHaveBeenCalledTimes(1)
    expect(input.readOnly).toBe(true)
    expect(screen.getByRole("textbox", { name: "New file name" })).toBe(input)

    await act(async () => { complete("/notes/once.md") })
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("未输入时异步建议可以替换占位名，已输入或会话过期后不得覆盖", async () => {
    const pending: Array<(name: string) => void> = []
    const props = treeProps([file(), file("untitled.md")])
    props.onSuggestName.mockImplementation(() =>
      new Promise(resolve => { pending.push(resolve) }))
    const view = render(<FileTree {...props} />)

    const typed = openCreate("doc.md", "New File")
    fireEvent.change(typed, { target: { value: "my notes" } })
    await act(async () => { pending[0]!("untitled-2.md") })
    expect(typed.value).toBe("my notes")

    fireEvent.keyDown(typed, { key: "Escape" })
    const untouched = openCreate("doc.md", "New File")
    await act(async () => { pending[1]!("untitled-3.md") })
    expect(untouched.value).toBe("untitled-3.md")
    expect([untouched.selectionStart, untouched.selectionEnd])
      .toEqual([0, "untitled-3".length])

    fireEvent.keyDown(untouched, { key: "Escape" })
    const third = openCreate("doc.md", "New File")
    view.rerender(<FileTree {...props} activePath="/notes/other.md" />)
    expect(screen.queryByRole("textbox")).toBeNull()
    await act(async () => { pending[2]!("untitled-4.md") })
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(third.isConnected).toBe(false)
  })

  it("建议名失败时退回占位名，仍可正常创建", async () => {
    const props = treeProps([file()])
    props.onSuggestName.mockRejectedValue(new Error("listing failed"))
    render(<FileTree {...props} />)

    const input = openCreate("doc.md", "New File")
    await act(async () => { await Promise.resolve() })
    expect(input.value).toBe("untitled.md")
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })
    expect(props.onCreateFile).toHaveBeenCalledWith("/notes", "untitled.md")
  })

  it("重名在行内提示且不调用创建；改名后错误清除并可重试", async () => {
    const props = treeProps([file(), file("ideas.md")])
    render(<FileTree {...props} />)

    const input = openCreate("doc.md", "New File")
    fireEvent.change(input, { target: { value: "ideas" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(props.onCreateFile).not.toHaveBeenCalled()
    expect(input.getAttribute("aria-invalid")).toBe("true")
    expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent)
      .toBe("\"ideas.md\" already exists in this folder.")

    fireEvent.change(input, { target: { value: "more ideas" } })
    expect(input.getAttribute("aria-invalid")).toBe("false")
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })
    expect(props.onCreateFile).toHaveBeenCalledWith("/notes", "more ideas.md")
  })

  it("非法名称留在行内提示，不产生任何文件系统调用", () => {
    const props = treeProps([file()])
    render(<FileTree {...props} />)

    const input = openCreate("doc.md", "New File")
    fireEvent.change(input, { target: { value: "a/b" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(props.onCreateFile).not.toHaveBeenCalled()
    expect(input.getAttribute("aria-invalid")).toBe("true")
    expect(screen.getByRole("status").textContent).toBe("Names cannot contain '/' or '\\'.")
  })

  it("IO 失败走外部 toast，草稿保留且可以再试", async () => {
    const props = treeProps([file()])
    props.onCreateFile.mockRejectedValueOnce(new TreeEditError("io", "disk full"))
    render(<FileTree {...props} />)

    const input = openCreate("doc.md", "New File")
    fireEvent.change(input, { target: { value: "retry.md" } })
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })

    expect(props.onEditError).toHaveBeenCalledWith("disk full")
    expect(input.value).toBe("retry.md")
    expect(input.readOnly).toBe(false)
    expect(input.getAttribute("aria-invalid")).toBe("false")
  })

  it("服务端判定的重名转换为行内错误而非 toast", async () => {
    const props = treeProps([file()])
    props.onCreateFile.mockRejectedValueOnce(
      new TreeEditError("duplicate", "\"taken.md\" already exists in this folder."))
    render(<FileTree {...props} />)

    const input = openCreate("doc.md", "New File")
    fireEvent.change(input, { target: { value: "taken" } })
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })

    expect(props.onEditError).not.toHaveBeenCalled()
    expect(input.getAttribute("aria-invalid")).toBe("true")
    expect(screen.getByRole("status").textContent)
      .toBe("\"taken.md\" already exists in this folder.")
  })

  it("右键折叠目录时先展开，草稿按子级缩进渲染在目录下", async () => {
    const props = treeProps([folder("/notes/drafts")])
    render(<FileTree {...props} />)

    const input = openCreate("drafts", "New Folder")
    expect(props.onToggleDir).toHaveBeenCalledWith("/notes/drafts")
    const row = input.closest(".filetree-item") as HTMLElement
    expect(row.style.paddingLeft).toBe(`${ROW_INSET + DEPTH_INDENT}px`)
    expect(input.value).toBe("untitled-folder")

    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })
    expect(props.onCreateFolder).toHaveBeenCalledWith("/notes/drafts", "untitled-folder")
  })

  it("新建目录选中并聚焦新行，但不自动展开", async () => {
    const props = treeProps([folder("/notes/drafts")])
    const view = render(<FileTree {...props} />)

    const input = openCreate("drafts", "New Folder")
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })
    const created = folder("/notes/drafts/untitled-folder", 1)
    view.rerender(<FileTree {...props} rows={[folder("/notes/drafts"), created]} />)

    const row = screen.getByRole("button", { name: "untitled-folder" })
    await waitFor(() => expect(document.activeElement).toBe(row))
    expect(row.className).toContain("is-selected")
    expect(row.getAttribute("aria-expanded")).toBe("false")
    expect(props.onToggleDir).toHaveBeenCalledTimes(1)
  })

  it("行刷新先于创建完成时，关闭会话仍会聚焦新目录", async () => {
    let complete!: (path: string) => void
    const props = treeProps([folder("/notes/drafts", 0, true)])
    props.onCreateFolder.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const view = render(<FileTree {...props} />)

    const input = openCreate("drafts", "New Folder")
    fireEvent.keyDown(input, { key: "Enter" })
    await act(async () => {
      view.rerender(<FileTree {...props} rows={[
        folder("/notes/drafts", 0, true),
        folder("/notes/drafts/untitled-folder", 1),
      ]} />)
      complete("/notes/drafts/untitled-folder")
    })

    const row = screen.getByRole("button", { name: "untitled-folder" })
    await waitFor(() => expect(document.activeElement).toBe(row))
    expect(row.className).toContain("is-selected")
  })

  it("新建文件不抢行焦点，只在树中选中新节点", async () => {
    const props = treeProps([file()])
    const view = render(<FileTree {...props} />)

    const input = openCreate("doc.md", "New File")
    fireEvent.change(input, { target: { value: "fresh" } })
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })
    view.rerender(<FileTree {...props} rows={[file(), file("fresh.md")]} />)

    const row = screen.getByRole("button", { name: "fresh.md" })
    expect(row.className).toContain("is-selected")
    expect(document.activeElement).not.toBe(row)
  })

  it("空白区菜单在根目录末尾创建", async () => {
    const props = treeProps([folder("/notes/drafts", 0, true), file("doc.md", "/notes/drafts")])
    render(<FileTree {...props} />)

    fireEvent.contextMenu(screen.getByRole("tree"))
    expect(screen.getByRole("menu", { name: "Folder actions" })).toBeTruthy()
    fireEvent.click(screen.getByRole("menuitem", { name: "New File" }))
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "New file name" })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(props.onCreateFile).toHaveBeenCalledWith("/notes", "untitled.md")
    expect(props.onToggleDir).not.toHaveBeenCalled()
  })

  it("长列表中新草稿位于虚拟窗口之外时仍可聚焦，并滚动到可视区", () => {
    const rows = Array.from({ length: 100 }, (_, i) => file(`doc-${i}.md`))
    const props = treeProps(rows)
    render(<FileTree {...props} />)
    const tree = screen.getByRole("tree")
    Object.defineProperty(tree, "clientHeight", { configurable: true, value: 5 * ROW_HEIGHT })

    const input = openCreate("doc-0.md", "New File")
    expect(input.isConnected).toBe(true)
    expect(document.activeElement).toBe(input)
    // Bottom-aligned just above the last visible row, with the draft slot
    // positioned after every existing root entry.
    expect((input.closest(".filetree-item")!.parentElement as HTMLElement).style.top)
      .toBe(`${rows.length * ROW_HEIGHT}px`)
    expect(tree.scrollTop).toBe((rows.length + 1) * ROW_HEIGHT - 5 * ROW_HEIGHT)
    expect(screen.getByRole("button", { name: "doc-99.md" })).toBeTruthy()
  })

  it("缺少新建服务时菜单项禁用", () => {
    const props = treeProps([file()])
    render(<FileTree {...props} onCreateFile={undefined} onCreateFolder={undefined} />)

    fireEvent.contextMenu(screen.getByRole("button", { name: "doc.md" }))
    expect(screen.getByRole("menuitem", { name: "New File" })).toHaveProperty("disabled", true)
    expect(screen.getByRole("menuitem", { name: "New Folder" })).toHaveProperty("disabled", true)
  })
})
