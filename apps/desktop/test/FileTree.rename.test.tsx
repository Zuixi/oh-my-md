import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { FileTree } from "../src/FileTree"
import { ROW_HEIGHT, type VisibleRow } from "../src/fileTreeState"

function file(name = "doc.md", folder = "/notes"): VisibleRow {
  return { entry: { name, path: `${folder}/${name}`, is_dir: false }, depth: 0, expanded: false }
}

function treeProps(rows = [file()]) {
  return {
    folder: "/notes",
    rows,
    activePath: null,
    onOpenFile: vi.fn(),
    onToggleDir: vi.fn(),
    onSearch: vi.fn(),
    onRename: vi.fn(async (_entry: VisibleRow["entry"], name: string) => `/notes/${name}`),
  }
}

function startRename(name = "doc.md"): HTMLInputElement {
  fireEvent.contextMenu(screen.getByRole("button", { name }))
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }))
  return screen.getByRole<HTMLInputElement>("textbox", { name: "Rename" })
}

describe("文件树原地重命名", () => {
  it("在原行聚焦输入框，只选中文件名主体，不嵌套到按钮中", () => {
    render(<FileTree {...treeProps()} />)
    const input = startRename()
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe("doc.md")
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3])
    expect(input.closest("button")).toBeNull()
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("目录名称全选，Escape 取消后把焦点还给原行", () => {
    const props = treeProps([{ ...file("drafts"), entry: { name: "drafts", path: "/notes/drafts", is_dir: true } }])
    render(<FileTree {...props} />)
    const input = startRename("drafts")
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6])
    fireEvent.change(input, { target: { value: "ideas" } })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()
    expect(props.onRename).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "drafts" }))
  })

  it("失焦保留草稿，不打开文件，也不触发全局快捷键", () => {
    const props = treeProps()
    render(<FileTree {...props} />)
    const input = startRename()
    fireEvent.change(input, { target: { value: "notes.md" } })
    const keydown = vi.fn()
    window.addEventListener("keydown", keydown)
    try {
      fireEvent.keyDown(input, { key: "h", ctrlKey: true })
      fireEvent.blur(input)
      expect(input.value).toBe("notes.md")
      expect(props.onRename).not.toHaveBeenCalled()
      expect(props.onOpenFile).not.toHaveBeenCalled()
      expect(keydown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener("keydown", keydown)
    }
  })

  it("点击其他文件或目录时关闭未提交的输入框，并执行行操作", () => {
    const directory: VisibleRow = {
      entry: { name: "drafts", path: "/notes/drafts", is_dir: true }, depth: 0, expanded: false,
    }
    const props = treeProps([file(), file("other.md"), directory])
    render(<FileTree {...props} />)
    fireEvent.change(startRename(), { target: { value: "draft.md" } })
    fireEvent.click(screen.getByRole("button", { name: "other.md" }))
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()
    expect(props.onOpenFile).toHaveBeenCalledWith("/notes/other.md")
    expect(props.onRename).not.toHaveBeenCalled()

    fireEvent.change(startRename(), { target: { value: "draft.md" } })
    fireEvent.click(screen.getByRole("button", { name: "drafts" }))
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()
    expect(props.onToggleDir).toHaveBeenCalledWith("/notes/drafts")
    expect(props.onRename).not.toHaveBeenCalled()
  })

  it("右键另一行或从标签切换活动文件时取消草稿", () => {
    const props = treeProps([file(), file("other.md")])
    const view = render(<FileTree {...props} />)
    fireEvent.change(startRename(), { target: { value: "draft.md" } })
    fireEvent.contextMenu(screen.getByRole("button", { name: "other.md" }))
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()
    expect(props.onRename).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Rename" }), { target: { value: "another.md" } })
    view.rerender(<FileTree {...props} activePath="/notes/doc.md" />)
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()
    expect(props.onRename).not.toHaveBeenCalled()
  })

  it("提交期间切换文件立即退出，失败经外部反馈且不会重开旧输入框", async () => {
    let fail!: (error: Error) => void
    const props = treeProps([file(), file("other.md")])
    props.onRename.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    const onRenameError = vi.fn()
    render(<FileTree {...props} onRenameError={onRenameError} />)
    fireEvent.change(startRename(), { target: { value: "taken.md" } })
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename" }), { key: "Enter" })
    fireEvent.click(screen.getByRole("button", { name: "other.md" }))
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()
    expect(props.onOpenFile).toHaveBeenCalledWith("/notes/other.md")
    await act(async () => { fail(new Error("path already exists")) })
    expect(onRenameError).toHaveBeenCalledWith("path already exists")
    expect(props.onRename).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()
  })

  it("提交期间切换文件后成功，不抢回新行焦点", async () => {
    let complete!: (path: string) => void
    const props = treeProps([file(), file("other.md")])
    props.onRename.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const onRenameError = vi.fn()
    render(<FileTree {...props} onRenameError={onRenameError} />)
    fireEvent.keyDown(startRename(), { key: "Enter" })
    const nextRow = screen.getByRole("button", { name: "other.md" })
    nextRow.focus()
    fireEvent.click(nextRow)
    await act(async () => { complete("/notes/renamed.md") })
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()
    expect(document.activeElement).toBe(nextRow)
    expect(onRenameError).not.toHaveBeenCalled()
  })

  it("提交期间标签切换会退出，而原文件路径更新不会提前取消成功态", async () => {
    let complete!: (path: string) => void
    const props = treeProps([file(), file("other.md")])
    props.onRename.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const view = render(<FileTree {...props} activePath="/notes/doc.md" activeTabId={1} />)
    fireEvent.keyDown(startRename(), { key: "Enter" })
    view.rerender(<FileTree {...props} activePath="/notes/other.md" activeTabId={2} />)
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()
    await act(async () => { complete("/notes/renamed.md") })
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()

    fireEvent.keyDown(startRename(), { key: "Enter" })
    view.rerender(<FileTree {...props} activePath="/notes/renamed.md" activeTabId={2} />)
    expect(screen.getByRole("textbox", { name: "Rename" })).toBeTruthy()
    await act(async () => { complete("/notes/renamed.md") })
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()
  })

  it("侧栏收起再展开不会恢复旧输入框", () => {
    const props = treeProps()
    const view = render(<FileTree {...props} visible />)
    fireEvent.change(startRename(), { target: { value: "draft.md" } })
    view.rerender(<FileTree {...props} visible={false} />)
    view.rerender(<FileTree {...props} visible />)
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()
    expect(props.onRename).not.toHaveBeenCalled()
  })

  it("组合输入的 Enter 和 Escape 不提交或取消", async () => {
    const props = treeProps()
    render(<FileTree {...props} />)
    const input = startRename()
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: "中文.md" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(screen.getByRole("textbox", { name: "Rename" })).toBe(input)
    expect(props.onRename).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })
    expect(props.onRename).not.toHaveBeenCalled()
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })
    expect(props.onRename).toHaveBeenCalledWith(props.rows[0].entry, "中文.md")
  })

  it("同步锁阻止连续 Enter、blur 和提交中的 Escape", async () => {
    let complete!: (path: string) => void
    const props = treeProps()
    props.onRename.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    render(<FileTree {...props} />)
    const input = startRename()
    fireEvent.change(input, { target: { value: "new.md" } })
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" })
      fireEvent.keyDown(input, { key: "Enter" })
      fireEvent.blur(input)
      fireEvent.keyDown(input, { key: "Escape" })
    })
    expect(props.onRename).toHaveBeenCalledTimes(1)
    expect(input.readOnly).toBe(true)
    expect(screen.getByRole("textbox", { name: "Rename" })).toBe(input)
    await act(async () => { complete("/notes/new.md") })
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()
  })

  it("失败保留输入，显示关联错误，修改后可以重试", async () => {
    const props = treeProps()
    props.onRename.mockRejectedValueOnce(new Error("path already exists"))
    render(<FileTree {...props} />)
    const input = startRename()
    fireEvent.change(input, { target: { value: "taken.md" } })
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })
    expect(input.value).toBe("taken.md")
    expect(input.readOnly).toBe(false)
    expect(input.getAttribute("aria-invalid")).toBe("true")
    expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent)
      .toBe("path already exists")
    fireEvent.change(input, { target: { value: "available.md" } })
    expect(input.getAttribute("aria-invalid")).toBe("false")
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })
    expect(props.onRename).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()
  })

  it("提交期间用户移到其他输入框，完成后不抢回焦点", async () => {
    let complete!: (path: string) => void
    const props = treeProps()
    props.onRename.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    render(<><FileTree {...props} /><input aria-label="Other input" /></>)
    fireEvent.keyDown(startRename(), { key: "Enter" })
    const outside = screen.getByRole("textbox", { name: "Other input" })
    outside.focus()
    await act(async () => { complete("/notes/new.md") })
    expect(document.activeElement).toBe(outside)
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()
  })

  it("虚拟行卸载及列表排序后按路径恢复草稿", () => {
    const rows = Array.from({ length: 100 }, (_, i) => file(`doc-${i}.md`))
    const props = treeProps(rows)
    const view = render(<FileTree {...props} />)
    const input = startRename("doc-0.md")
    fireEvent.change(input, { target: { value: "draft.md" } })
    const tree = screen.getByRole("tree")
    fireEvent.scroll(tree, { target: { scrollTop: 60 * ROW_HEIGHT } })
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()
    fireEvent.scroll(tree, { target: { scrollTop: 0 } })
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Rename" }).value).toBe("draft.md")
    view.rerender(<FileTree {...props} rows={[rows[1], rows[0], ...rows.slice(2)]} />)
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Rename" }).value).toBe("draft.md")
    expect(props.onRename).not.toHaveBeenCalled()
  })

  it("父目录折叠不丢草稿，目标从已展开列表消失时取消并提示", () => {
    const directory: VisibleRow = {
      entry: { name: "drafts", path: "/notes/drafts", is_dir: true }, depth: 0, expanded: true,
    }
    const child = { ...file("doc.md", "/notes/drafts"), depth: 1 }
    const props = treeProps([directory, child])
    const view = render(<FileTree {...props} />)
    fireEvent.change(startRename(), { target: { value: "ideas.md" } })
    view.rerender(<FileTree {...props} rows={[{ ...directory, expanded: false }]} />)
    view.rerender(<FileTree {...props} />)
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Rename" }).value).toBe("ideas.md")
    view.rerender(<FileTree {...props} rows={[directory, file("replacement.md")]} />)
    expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull()
    expect(screen.getByRole("status").textContent).toMatch(/no longer available/)
    expect(props.onRename).not.toHaveBeenCalled()
  })

  it("切换工作区后，旧请求失败不能影响新编辑会话", async () => {
    let reject!: (error: Error) => void
    const props = treeProps()
    props.onRename.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const view = render(<FileTree {...props} />)
    fireEvent.keyDown(startRename(), { key: "Enter" })
    view.rerender(<FileTree {...props} folder="/other" rows={[file("other.md", "/other")]} />)
    const input = startRename("other.md")
    fireEvent.change(input, { target: { value: "new draft.md" } })
    await act(async () => { reject(new Error("old failure")) })
    expect(input.value).toBe("new draft.md")
    expect(input.readOnly).toBe(false)
    expect(screen.queryByText("old failure")).toBeNull()
  })
})
