import { describe, expect, it } from "vitest"
import { EditorView } from "@codemirror/view"
import { EditorState, type Extension } from "@codemirror/state"
import { editorExtensions } from "../src/index"

function makeView(doc: string, anchor = doc.length, extraExtensions: Extension[] = []) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const errors: unknown[] = []
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },   // 默认光标放文末，块处于渲染态
      extensions: [...extraExtensions, editorExtensions(), EditorView.exceptionSink.of(e => { errors.push(e) })],
    }),
    parent,
  })
  return { view, errors }
}

const tick = (ms = 100) => new Promise(r => setTimeout(r, ms))

async function waitFor(selector: string, view: EditorView, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const match = view.dom.querySelector(selector)
    if (match) return match
    await tick(20)
  }
  return null
}

/** 渲染态工具栏：hover 目标格后才 enabled，点击经 applyTableToolAt 改写源码。 */
async function hoverCell(view: EditorView, selector: string, index: number) {
  const cell = (await waitFor(selector, view)) && view.dom.querySelectorAll(selector)[index]
  expect(cell).toBeTruthy()
  cell!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
}

function clickTool(view: EditorView, tableIndex: number, act: string) {
  const wrap = view.dom.querySelectorAll(".omd-table")[tableIndex]
  expect(wrap).toBeTruthy()
  const btn = wrap!.querySelector(`.omd-table-toolbar [data-act='${act}']`) as HTMLButtonElement
  expect(btn).toBeTruthy()
  btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
  btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
}

describe("rendered table toolbar", () => {
  function makeInteractView(doc: string) {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const errors: unknown[] = []
    let docChanged = 0
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [
          editorExtensions(),
          EditorView.exceptionSink.of(e => { errors.push(e) }),
          EditorView.updateListener.of(u => { if (u.docChanged) docChanged++ }),
        ],
      }),
      parent,
    })
    return { view, errors, count: () => docChanged }
  }

  it("inserts a row below the hovered one from the rendered toolbar in one transaction", async () => {
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n\ntail"
    const { view, errors, count } = makeInteractView(doc)
    try {
      await hoverCell(view, ".omd-table tbody td", 0)
      const before = count()
      clickTool(view, 0, "insert-row")
      await tick()
      // 一次点击 = 一个文档事务（渲染态工具栏不再需要"先提交单元格、再补结构操作"）。
      expect(count() - before).toBe(1)
      expect(view.state.doc.toString()).toContain("| 1 | 2 |\n|  |  |")
      expect(errors.map(String)).toEqual([])
    } finally { view.destroy() }
  })
  it("inserts a column right of the hovered one from the rendered toolbar in one transaction", async () => {
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n\ntail"
    const { view, errors, count } = makeInteractView(doc)
    try {
      await hoverCell(view, ".omd-table tbody td", 0)
      const before = count()
      clickTool(view, 0, "insert-col")
      await tick()
      expect(count() - before).toBe(1)
      expect(view.state.doc.toString()).toContain("| a |  | b |")
      expect(view.state.doc.toString()).toContain("| 1 |  | 2 |")
      expect(errors.map(String)).toEqual([])
    } finally { view.destroy() }
  })
  it("deletes the hovered row in a single transaction", async () => {
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\ntail"
    const { view, errors, count } = makeInteractView(doc)
    try {
      await hoverCell(view, ".omd-table tbody td", 0)
      const before = count()
      clickTool(view, 0, "delete-row")
      await tick()
      expect(count() - before).toBe(1)
      // 删掉的是 hover 的那一行（首数据行）；第二行原样保留。
      expect(view.state.doc.toString()).toBe("| a | b |\n|---|---|\n| 3 | 4 |\n\ntail")
      expect(errors.map(String)).toEqual([])
    } finally { view.destroy() }
  })
  it("deletes the hovered column in a single transaction", async () => {
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\ntail"
    const { view, errors, count } = makeInteractView(doc)
    try {
      await hoverCell(view, ".omd-table tbody td", 1)  // 第二列
      const before = count()
      clickTool(view, 0, "delete-col")
      await tick()
      expect(count() - before).toBe(1)
      // 删掉的是 hover 的那一列（b）；a 列原样保留。
      expect(view.state.doc.toString()).toBe("| a |\n|---|\n| 1 |\n| 3 |\n\ntail")
      expect(errors.map(String)).toEqual([])
    } finally { view.destroy() }
  })
  it("applies a toolbar action only to the table whose DOM owns it", async () => {
    const doc = [
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "| 3 | 4 |",
      "",
      "intro",
      "",
      "| c | d |",
      "|---|---|",
      "| 5 | 6 |",
      "",
      "tail",
    ].join("\n")
    const { view, errors } = makeInteractView(doc)
    try {
      // 光标在表外 → 两张表都是渲染态 widget；hover 的目标格属于第一张表。
      await hoverCell(view, ".omd-table tbody td", 0)
      clickTool(view, 0, "delete-row")
      await tick()
      const out = view.state.doc.toString()
      expect(out).toContain("| a | b |\n|---|---|\n| 3 | 4 |\n\nintro")
      // 第二张表逐字节未动：按钮经 domOwner 解析出的是自己那张表的 livePos/src。
      expect(out).toContain("| c | d |\n|---|---|\n| 5 | 6 |")
      expect(errors.map(String)).toEqual([])
    } finally { view.destroy() }
  })
  it("disables delete-row for a single data row and delete-column for a single column", async () => {
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n\ntail"
    const { view, errors } = makeView(doc)
    try {
      // 未 hover 时全部 disabled（没有目标格）；hover 之后才只剩结构边界造成的禁用。
      const buttons = [...view.dom.querySelectorAll<HTMLButtonElement>(".omd-table-toolbar button")]
      expect(buttons.every(btn => btn.disabled)).toBe(true)
      await hoverCell(view, ".omd-table tbody td", 0)
      const delRow = view.dom.querySelector("[data-act='delete-row']") as HTMLButtonElement
      expect(delRow.disabled).toBe(true)
      const delCol = view.dom.querySelector("[data-act='delete-col']") as HTMLButtonElement
      expect(delCol.disabled).toBe(false)
      expect(errors.map(String)).toEqual([])
    } finally { view.destroy() }
  })
  it("renders synthetic ragged cells disabled and input-less", async () => {
    const doc = "| a | b |\n|---|---|\n| only |\n\ntail"
    const { view, errors } = makeView(doc)
    try {
      await waitFor(".omd-table tbody td", view)
      const missing = view.dom.querySelector(".omd-table tbody tr td:nth-child(2)") as HTMLElement
      expect(missing).toBeTruthy()
      expect(missing.classList.contains("omd-table-cell-missing")).toBe(true)
      expect(missing.getAttribute("aria-disabled")).toBe("true")
      expect(missing.title).toBe("Missing source cell; add a column or edit Markdown source")
      expect(missing.querySelector("input")).toBeNull()
      expect(errors.map(String)).toEqual([])
    } finally { view.destroy() }
  })
})
