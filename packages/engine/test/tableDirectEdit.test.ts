import { describe, expect, it } from "vitest"
import { forceParsing } from "@codemirror/language"
import { EditorState, Transaction, type Extension, type TransactionSpec } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { history, isolateHistory, redo, undo } from "@codemirror/commands"
import { makeState } from "./helpers"
import { drainPendingLiveBuild } from "../src/decorations/build"
import { activeTableInputControllerCountForTest, TableWidget } from "../src/decorations/widgets/table"
import { editorExtensions } from "../src/index"
import { tableAt } from "../src/tables/navigate"
import {
  beginTableEdit,
  closeTableEdit,
  experimentalTableDirectEdit,
  getTableEditSession,
  setTableComposition,
  suppressOrderedRenumberForTableEdit,
  tableCellInputSpec,
  type TableEditTarget,
} from "../src/tables/directEdit"

const RAW = "A|  B\n:-----|---:\nC | D"
const NORMALIZED = "| X | B |\n| :--- | ---: |\n| C | D |"
const CANONICAL = "| A | B |\n| --- | --- |\n| 1 | 2 |"

function mount(doc: string) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: makeState(doc, [history(), experimentalTableDirectEdit]),
    parent,
  })
  return { view, cleanup: () => { view.destroy(); parent.remove() } }
}

function targetOf(view: EditorView, row: number, column: number, pos = 0): TableEditTarget {
  const table = tableAt(view.state, pos)
  if (!table) throw new Error("expected a table")
  return { tableFrom: table.from, tableTo: table.to, row, column, source: table.source }
}

function dispatchInput(
  view: EditorView,
  value: string,
  time: number,
  kind: "typing" | "composition" = "typing",
): Transaction {
  const spec: TransactionSpec | null = tableCellInputSpec(view.state, value, kind)
  if (!spec) throw new Error("expected a table edit spec")
  const transaction = view.state.update(spec, { annotations: Transaction.time.of(time) })
  view.dispatch(transaction)
  return transaction
}

function changeList(transaction: Transaction): [number, number, string][] {
  const changes: [number, number, string][] = []
  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changes.push([fromA, toA, inserted.toString()])
  })
  return changes
}

describe("table edit session state", () => {
  it("opens and closes a session without changing the document", () => {
    const { view, cleanup } = mount(RAW)
    view.dispatch({ effects: beginTableEdit(targetOf(view, 0, 0)) })
    expect(view.state.doc.toString()).toBe(RAW)
    expect(getTableEditSession(view.state)).toMatchObject({
      revision: 0,
      composing: false,
      hasCommittedInput: false,
    })
    view.dispatch({ effects: setTableComposition(true) })
    expect(getTableEditSession(view.state)?.composing).toBe(true)
    expect(view.state.doc.toString()).toBe(RAW)
    view.dispatch({ effects: closeTableEdit() })
    expect(getTableEditSession(view.state)).toBeNull()
    cleanup()
  })

  it("maps the target through a shift and closes once the table is gone", () => {
    const doc = `intro\n\n${CANONICAL}`
    const { view, cleanup } = mount(doc)
    view.dispatch({ effects: beginTableEdit(targetOf(view, 1, 1, 7)) })
    view.dispatch({ changes: { from: 0, insert: "abc\n" } })
    expect(getTableEditSession(view.state)?.target).toMatchObject({
      tableFrom: 11,
      tableTo: 11 + CANONICAL.length,
    })
    expect(tableCellInputSpec(view.state, "9", "typing")).not.toBeNull()
    view.dispatch({ changes: { from: 11, to: 11 + CANONICAL.length, insert: "plain" } })
    expect(getTableEditSession(view.state)).toBeNull()
    expect(tableCellInputSpec(view.state, "9", "typing")).toBeNull()
    cleanup()
  })

  it("keeps a mapped session through a change before the table", () => {
    const { view, cleanup } = mount(`intro\n\n${CANONICAL}`)
    view.dispatch({ effects: beginTableEdit(targetOf(view, 1, 1, 7)) })
    view.dispatch({ changes: { from: 0, insert: "abc\n" } })
    expect(getTableEditSession(view.state)?.target).toMatchObject({
      tableFrom: 11,
      tableTo: 11 + CANONICAL.length,
      source: CANONICAL,
    })
    dispatchInput(view, "9", 1_000)
    expect(view.state.doc.toString()).toBe(`abc\nintro\n\n| A | B |\n| --- | --- |\n| 1 | 9 |`)
    cleanup()
  })

  it("closes the session when an external edit changes the table source", () => {
    const { view, cleanup } = mount(CANONICAL)
    view.dispatch({ effects: beginTableEdit(targetOf(view, 1, 1)) })
    view.dispatch({ changes: { from: 30, to: 31, insert: "3" } })
    expect(view.state.doc.toString()).toBe("| A | B |\n| --- | --- |\n| 1 | 3 |")
    expect(getTableEditSession(view.state)).toBeNull()
    expect(tableCellInputSpec(view.state, "9", "typing")).toBeNull()
    cleanup()
  })

  // 关闭会话后的撤销/重做只回放文档历史：历史效应里的会话快照不得把编辑面
  // 复活（快照只在会话当时存活的前提下才生效）。
  it("does not resurrect a closed session through undo or redo", () => {
    const { view, cleanup } = mount(CANONICAL)
    view.dispatch({ effects: beginTableEdit(targetOf(view, 1, 1)) })
    dispatchInput(view, "9", 1_000)
    const edited = "| A | B |\n| --- | --- |\n| 1 | 9 |"
    expect(view.state.doc.toString()).toBe(edited)

    view.dispatch({ effects: closeTableEdit() })
    expect(getTableEditSession(view.state)).toBeNull()

    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(CANONICAL)
    expect(getTableEditSession(view.state)).toBeNull()

    expect(redo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(edited)
    expect(getTableEditSession(view.state)).toBeNull()
    cleanup()
  })

  it("returns null for a stale target without changing the document", () => {
    const { view, cleanup } = mount(CANONICAL)
    const target = targetOf(view, 1, 1)
    for (const stale of [
      { ...target, source: "stale" },
      { ...target, row: 9 },
      { ...target, column: 9 },
    ]) {
      view.dispatch({ effects: beginTableEdit(stale) })
      expect(tableCellInputSpec(view.state, "9", "typing")).toBeNull()
      expect(view.state.doc.toString()).toBe(CANONICAL)
    }
    cleanup()
  })
})

describe("table cell input transactions", () => {
  it("normalizes the whole table once on the first input", () => {
    const { view, cleanup } = mount(RAW)
    view.dispatch({ effects: beginTableEdit(targetOf(view, 0, 0)) })
    const first = dispatchInput(view, "X", 1_000)
    expect(changeList(first)).toEqual([[0, RAW.length, NORMALIZED]])
    expect(first.annotation(Transaction.userEvent)).toBe("input.type")
    expect(first.annotation(suppressOrderedRenumberForTableEdit)).toBe(true)
    expect(first.annotation(isolateHistory)).toBe("before")
    expect(view.state.doc.toString()).toBe(NORMALIZED)
    expect(getTableEditSession(view.state)).toMatchObject({
      revision: 1,
      hasCommittedInput: true,
    })
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(RAW)
    expect(redo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(NORMALIZED)
    cleanup()
  })

  it("uses one cell range and no table normalization for later input", () => {
    const { view, cleanup } = mount(CANONICAL)
    view.dispatch({ effects: beginTableEdit(targetOf(view, 1, 1)) })
    dispatchInput(view, "9", 1_000)
    const later = dispatchInput(view, "98", 1_400)
    expect(changeList(later)).toEqual([[30, 31, "98"]])
    expect(later.annotation(Transaction.userEvent)).toBe("input.type")
    expect(later.annotation(suppressOrderedRenumberForTableEdit)).toBe(true)
    expect(later.annotation(isolateHistory)).toBeUndefined()
    expect(view.state.doc.toString()).toBe("| A | B |\n| --- | --- |\n| 1 | 98 |")
    expect(getTableEditSession(view.state)?.revision).toBe(2)
    cleanup()
  })

  // 切换单元格只重开「编辑哪一格」，不得重置这张表已经提交过一次输入的状态：
  // 否则每格的第一次输入都会重写整张表（第二次 whole-table 替换），而不是一格的范围改动。
  it("keeps the committed table state when the edit moves to another cell", () => {
    const { view, cleanup } = mount(RAW)
    view.dispatch({ effects: beginTableEdit(targetOf(view, 0, 0)) })
    const first = dispatchInput(view, "X", 1_000)
    expect(changeList(first)).toEqual([[0, RAW.length, NORMALIZED]])

    view.dispatch({ effects: beginTableEdit(targetOf(view, 0, 1)) })
    const next = dispatchInput(view, "Y", 1_400)
    // 与整表归一化同一秒内发生（同一历史延迟内）：只有单元格切换的隔离分隔它们。
    expect(next.annotation(isolateHistory)).toBe("before")
    const table = tableAt(view.state, 0)
    const cell = table?.data.header.cells[1]
    if (!table || !cell) throw new Error("expected the table header cell")
    expect(changeList(next)).toEqual([[table.from + cell.from, table.from + cell.to, "Y"]])
    expect(view.state.doc.toString()).toBe("| X | Y |\n| :--- | ---: |\n| C | D |")
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(NORMALIZED)
    cleanup()
  })

  it("stamps composition input as its own user event", () => {
    const { view, cleanup } = mount(CANONICAL)
    view.dispatch({ effects: beginTableEdit(targetOf(view, 1, 1)) })
    view.dispatch({ effects: setTableComposition(true) })
    const composed = dispatchInput(view, "日", 2_000, "composition")
    expect(composed.annotation(Transaction.userEvent)).toBe("input.type.compose")
    expect(getTableEditSession(view.state)?.composing).toBe(true)
    expect(view.state.doc.toString()).toBe("| A | B |\n| --- | --- |\n| 1 | 日 |")
    cleanup()
  })
})

describe("table cell input history grouping", () => {
  it("groups same-cell input inside the history delay", () => {
    const { view, cleanup } = mount(CANONICAL)
    view.dispatch({ effects: beginTableEdit(targetOf(view, 1, 1)) })
    dispatchInput(view, "9", 1_000)
    dispatchInput(view, "9x", 1_000)
    dispatchInput(view, "9xy", 1_400)
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(CANONICAL)
    cleanup()
  })

  it("starts a new group after a 600 ms gap", () => {
    const { view, cleanup } = mount(CANONICAL)
    view.dispatch({ effects: beginTableEdit(targetOf(view, 1, 1)) })
    dispatchInput(view, "9", 1_000)
    dispatchInput(view, "9x", 1_600)
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe("| A | B |\n| --- | --- |\n| 1 | 9 |")
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(CANONICAL)
    cleanup()
  })

  it("starts a new group after closing and reopening a cell", () => {
    const { view, cleanup } = mount(CANONICAL)
    view.dispatch({ effects: beginTableEdit(targetOf(view, 1, 1)) })
    dispatchInput(view, "9", 1_000)
    const committed = view.state.doc.toString()
    view.dispatch({ effects: closeTableEdit() })
    view.dispatch({ effects: beginTableEdit(targetOf(view, 1, 1)) })
    dispatchInput(view, "9x", 1_400)
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(committed)
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(CANONICAL)
    cleanup()
  })
})

const INPUT_DOC = "intro\n\n| **A** | B |\n| --- | --- |\n| 1 | 2 |\n\ntail"

interface DirectView {
  view: EditorView
  changes: Transaction[]
  cleanup: () => void
}

function mountDirect(experimental = true, doc = INPUT_DOC): DirectView {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const changes: Transaction[] = []
  const extensions: Extension[] = [
    history(),
    editorExtensions({ experimentalTableDirectEdit: experimental }),
    EditorView.updateListener.of(update => {
      for (const transaction of update.transactions) {
        if (transaction.docChanged) changes.push(transaction)
      }
    }),
  ]
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions,
    }),
    parent,
  })
  forceParsing(view, view.state.doc.length, 10_000)
  drainPendingLiveBuild(view)
  return { view, changes, cleanup: () => { view.destroy(); parent.remove() } }
}

function cellElements(view: EditorView): HTMLElement[][] {
  const head = Array.from(view.dom.querySelectorAll<HTMLElement>(".omd-table thead th"))
  const rows = Array.from(view.dom.querySelectorAll<HTMLElement>(".omd-table tbody tr"))
    .map(tr => Array.from(tr.children) as HTMLElement[])
  return head.length > 0 ? [head, ...rows] : rows
}

async function renderedCells(view: EditorView): Promise<HTMLElement[][]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const cells = cellElements(view)
    if (cells.length > 0) return cells
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error("expected a rendered table")
}

function activate(cells: HTMLElement[][], row: number, column: number): void {
  cells[row][column].dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
  )
}

function onlyInput(view: EditorView): HTMLInputElement {
  const inputs = Array.from(view.dom.querySelectorAll<HTMLInputElement>(".omd-table-cell-input"))
  expect(inputs).toHaveLength(1)
  return inputs[0]
}

function press(
  target: EventTarget,
  key: string,
  options: { shift?: boolean; meta?: boolean; ctrl?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    shiftKey: options.shift ?? false,
    metaKey: options.meta ?? false,
    ctrlKey: options.ctrl ?? false,
  })
  target.dispatchEvent(event)
  return event
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }))
}

describe("table direct edit DOM controller", () => {
  it("keeps the default source entry when the experiment is off", async () => {
    const { view, changes, cleanup } = mountDirect(false)
    const cells = await renderedCells(view)
    activate(cells, 1, 0)
    expect(view.dom.querySelector(".omd-table-cell-input")).toBeNull()
    expect(view.state.doc.toString()).toBe(INPUT_DOC)
    expect(view.state.selection.main.head).toBeGreaterThan(INPUT_DOC.indexOf("| --- |"))
    expect(changes).toHaveLength(0)
    expect(activeTableInputControllerCountForTest()).toBe(0)
    cleanup()
  })

  it("opens exactly one source-backed input for the activated cell", async () => {
    const { view, changes, cleanup } = mountDirect()
    const cells = await renderedCells(view)
    activate(cells, 0, 0)
    const input = onlyInput(view)
    expect(input.value).toContain("**A**")
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    expect(document.activeElement).toBe(input)
    expect(view.state.selection.main.head).toBe(0)
    expect(view.state.doc.toString()).toBe(INPUT_DOC)
    expect(getTableEditSession(view.state)).toMatchObject({ target: { row: 0, column: 0 } })
    expect(activeTableInputControllerCountForTest()).toBe(1)
    expect(changes).toHaveLength(0)

    type(input, "Z")
    expect(changes).toHaveLength(1)
    expect(view.state.doc.toString()).toBe("intro\n\n| Z | B |\n| --- | --- |\n| 1 | 2 |\n\ntail")
    expect(onlyInput(view)).toBe(input)
    expect(input.value).toBe("Z")

    cleanup()
    expect(activeTableInputControllerCountForTest()).toBe(0)
  })

  it("keeps keyboard and pointer events of the input out of the outer pipeline", async () => {
    const { view, changes, cleanup } = mountDirect()
    const cells = await renderedCells(view)
    activate(cells, 1, 0)
    const input = onlyInput(view)

    const backspace = press(input, "Backspace")
    const enter = press(input, "Enter")
    input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))
    input.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "x" }))
    const bold = press(input, "b", { ctrl: true })

    expect(backspace.defaultPrevented).toBe(false)
    expect(bold.defaultPrevented).toBe(false)
    expect(enter.defaultPrevented).toBe(true)
    expect(view.state.doc.toString()).toBe(INPUT_DOC)
    expect(view.state.selection.main.head).toBe(0)
    expect(changes).toHaveLength(0)
    expect(onlyInput(view)).toBe(input)
    expect(document.activeElement).toBe(input)
    cleanup()
  })

  it("commits a Chromium composition exactly once", async () => {
    const { view, changes, cleanup } = mountDirect()
    const cells = await renderedCells(view)
    activate(cells, 1, 1)
    const input = onlyInput(view)

    input.dispatchEvent(new Event("compositionstart", { bubbles: true }))
    expect(getTableEditSession(view.state)?.composing).toBe(true)
    input.value = "日本"
    input.dispatchEvent(new Event("compositionupdate", { bubbles: true }))
    expect(changes).toHaveLength(0)
    input.dispatchEvent(new Event("compositionend", { bubbles: true }))
    expect(changes).toHaveLength(1)
    expect(getTableEditSession(view.state)?.composing).toBe(false)
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertCompositionText",
      data: "日本",
      isComposing: false,
    }))
    expect(changes).toHaveLength(1)
    expect(view.state.doc.toString()).toBe("intro\n\n| **A** | B |\n| --- | --- |\n| 1 | 日本 |\n\ntail")
    cleanup()
  })

  it("preserves the input across a decoration refresh while composing", async () => {
    const { view, cleanup } = mountDirect()
    const cells = await renderedCells(view)
    activate(cells, 1, 1)
    const input = onlyInput(view)
    input.value = "日"
    input.setSelectionRange(1, 1)
    input.dispatchEvent(new Event("compositionstart", { bubbles: true }))

    view.dispatch({ changes: { from: 0, insert: "abc\n" } })

    expect(onlyInput(view)).toBe(input)
    expect(input.value).toBe("日")
    expect(input.selectionStart).toBe(1)
    expect(input.selectionEnd).toBe(1)
    expect(document.activeElement).toBe(input)
    expect(activeTableInputControllerCountForTest()).toBe(1)
    expect(getTableEditSession(view.state)?.target.tableFrom).toBe(INPUT_DOC.indexOf("| **A**") + 4)

    input.dispatchEvent(new Event("compositionend", { bubbles: true }))
    expect(view.state.doc.toString()).toBe(
      "abc\nintro\n\n| **A** | B |\n| --- | --- |\n| 1 | 日 |\n\ntail",
    )
    cleanup()
  })

  it("moves between existing cells on Tab and never appends a row", async () => {
    const { view, changes, cleanup } = mountDirect()
    const cells = await renderedCells(view)
    activate(cells, 1, 0)
    const first = onlyInput(view)

    press(first, "Tab")
    const second = onlyInput(view)
    expect(second).not.toBe(first)
    expect(second.value.trim()).toBe("2")
    expect(getTableEditSession(view.state)?.target).toMatchObject({ row: 1, column: 1 })

    press(second, "Tab")
    expect(onlyInput(view)).toBe(second)
    press(second, "Tab", { shift: true })
    expect(onlyInput(view).value.trim()).toBe("1")
    expect(view.state.doc.toString()).toBe(INPUT_DOC)
    expect(changes).toHaveLength(0)
    expect(activeTableInputControllerCountForTest()).toBe(1)
    cleanup()
  })

  it("closes the session on Escape and restores the rendered cell", async () => {
    const { view, changes, cleanup } = mountDirect()
    const cells = await renderedCells(view)
    activate(cells, 1, 0)
    press(onlyInput(view), "Escape")

    expect(view.dom.querySelector(".omd-table-cell-input")).toBeNull()
    expect(getTableEditSession(view.state)).toBeNull()
    expect(activeTableInputControllerCountForTest()).toBe(0)
    expect(view.dom.querySelector(".omd-table tbody td")?.textContent).toBe("1")
    expect(view.state.doc.toString()).toBe(INPUT_DOC)
    expect(changes).toHaveLength(0)
    cleanup()
  })

  // 光标进表会卸载渲染态 widget 与它的输入框；会话必须随之关闭，否则
  // `tableEditSession` 会在没有任何编辑面时继续存活并接受后续输入。
  it("clears the session when the outer selection moves into the table", async () => {
    const { view, changes, cleanup } = mountDirect()
    const cells = await renderedCells(view)
    activate(cells, 1, 0)
    onlyInput(view)
    const table = tableAt(view.state, view.state.doc.toString().indexOf("| **A**"))
    if (!table) throw new Error("expected a table")

    view.dispatch({ selection: { anchor: table.from + 2 } })
    drainPendingLiveBuild(view)

    expect(view.dom.querySelector(".omd-table")).toBeNull()
    expect(view.dom.querySelector(".omd-table-cell-input")).toBeNull()
    expect(activeTableInputControllerCountForTest()).toBe(0)
    expect(getTableEditSession(view.state)).toBeNull()
    expect(changes).toHaveLength(0)
    cleanup()
  })

  it("routes Mod-z to the outer history", async () => {
    const { view, changes, cleanup } = mountDirect()
    const cells = await renderedCells(view)
    activate(cells, 1, 0)
    const input = onlyInput(view)

    type(input, "9")
    expect(changes).toHaveLength(1)
    expect(view.state.doc.toString()).toContain("| 9 | 2 |")

    press(input, "z", { meta: true })
    expect(view.state.doc.toString()).toBe(INPUT_DOC)
    cleanup()
  })

  // 撤销回到只有一个尾空格的格 `"X "` 之前的版本：输入框内容必须精确同步回 `"X"`，
  // 不能因为两边 trim 后相等就被当成"用户自己输入"而留下 `"X "`。
  it("syncs the live input to the exact restored cell after undo", async () => {
    const { view, changes, cleanup } = mountDirect()
    const cells = await renderedCells(view)
    activate(cells, 1, 0)
    const input = onlyInput(view)

    type(input, "X")
    expect(view.state.doc.toString()).toBe(INPUT_DOC.replace("| 1 | 2 |", "| X | 2 |"))
    // 显式历史边界：Enter 结束当前历史组，尾空格那一次输入因此是独立的一步。
    press(input, "Enter")
    type(input, "X ")
    expect(view.state.doc.toString()).toBe(INPUT_DOC.replace("| 1 | 2 |", "| X  | 2 |"))
    expect(changes).toHaveLength(2)

    press(input, "z", { meta: true })
    drainPendingLiveBuild(view)

    expect(onlyInput(view)).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe("X")
    const table = tableAt(view.state, view.state.doc.toString().indexOf("| X"))
    expect(table?.data.rows[0]?.cells[0]?.source).toBe("X")
    expect(view.state.doc.toString()).toBe(INPUT_DOC.replace("| 1 | 2 |", "| X | 2 |"))
    cleanup()
  })

  // 首格第一次输入走整表归一化，归一化原样保留当前格的尾空格：文档里该格解析值虽然
  // 是 `"X"`，但这次变化是用户自己输入的，输入框必须留在 `"X "`。
  it("keeps the user's own trailing space through the first whole-table normalization", async () => {
    const { view, cleanup } = mountDirect()
    const cells = await renderedCells(view)
    activate(cells, 1, 0)
    const input = onlyInput(view)

    type(input, "X ")
    drainPendingLiveBuild(view)

    expect(view.state.doc.toString()).toBe(INPUT_DOC.replace("| 1 | 2 |", "| X  | 2 |"))
    expect(onlyInput(view)).toBe(input)
    expect(input.value).toBe("X ")
    cleanup()
  })

  it("closes the history group on Enter", async () => {
    const { view, changes, cleanup } = mountDirect()
    const cells = await renderedCells(view)
    activate(cells, 1, 0)
    const input = onlyInput(view)

    type(input, "9")
    const afterFirst = view.state.doc.toString()
    expect(afterFirst).toContain("| 9 | 2 |")
    press(input, "Enter")
    type(input, "98")
    expect(changes).toHaveLength(2)
    expect(view.state.doc.toString()).toContain("| 98 | 2 |")

    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(afterFirst)
    cleanup()
  })

  it("moves the live input across cells on cross-cell undo and redo without losing focus", async () => {
    const { view, cleanup } = mountDirect()
    const cells = await renderedCells(view)
    activate(cells, 1, 0)
    const first = onlyInput(view)
    type(first, "9")

    press(first, "Tab")
    const second = onlyInput(view)
    expect(second).not.toBe(first)
    type(second, "8")
    expect(view.state.doc.toString()).toContain("| 9 | 8 |")

    // First undo: reverts (1, 1) to "2", input stays in (1, 1)
    press(second, "z", { meta: true })
    expect(onlyInput(view).value).toBe("2")
    expect(getTableEditSession(view.state)?.target).toMatchObject({ row: 1, column: 1 })

    // Second undo: reverts (1, 0) to "1", input moves to (1, 0) and keeps focus
    press(onlyInput(view), "z", { meta: true })
    const restoredFirst = onlyInput(view)
    expect(restoredFirst.value).toBe("1")
    expect(document.activeElement).toBe(restoredFirst)
    expect(getTableEditSession(view.state)?.target).toMatchObject({ row: 1, column: 0 })
    expect(activeTableInputControllerCountForTest()).toBe(1)

    // Redo twice: restores (1, 0)="9" then moves back to (1, 1)="8"
    press(restoredFirst, "z", { meta: true, shift: true })
    expect(onlyInput(view).value).toBe("9")
    press(onlyInput(view), "z", { meta: true, shift: true })
    expect(onlyInput(view).value).toBe("8")
    expect(getTableEditSession(view.state)?.target).toMatchObject({ row: 1, column: 1 })
    cleanup()
  })

  it("switches cleanly from one table to another without focusout killing the new session", async () => {
    const twoTablesDoc = "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nmiddle\n\n| C | D |\n| --- | --- |\n| 3 | 4 |\n\ntail"
    const { view, cleanup } = mountDirect(true, twoTablesDoc)
    for (let attempt = 0; attempt < 100; attempt++) {
      if (view.dom.querySelectorAll(".omd-table table").length === 2) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const tables = Array.from(view.dom.querySelectorAll<HTMLElement>(".omd-table"))
    expect(tables).toHaveLength(2)
    const firstCell = tables[0].querySelector<HTMLElement>("tbody td")!
    const secondCell = tables[1].querySelector<HTMLElement>("tbody td")!

    firstCell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))
    expect(onlyInput(view).value).toBe("1")
    expect(activeTableInputControllerCountForTest()).toBe(1)

    secondCell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))
    const active = onlyInput(view)
    expect(active.value).toBe("3")
    expect(activeTableInputControllerCountForTest()).toBe(1)
    expect(getTableEditSession(view.state)).not.toBeNull()

    type(active, "9")
    expect(view.state.doc.toString()).toBe(twoTablesDoc.replace("| 3 | 4 |", "| 9 | 4 |"))
    cleanup()
  })

  it("moves the live input across two tables on cross-table undo and redo", async () => {
    const twoTablesDoc = "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nmiddle\n\n| C | D |\n| --- | --- |\n| 3 | 4 |\n\ntail"
    const { view, cleanup } = mountDirect(true, twoTablesDoc)
    for (let attempt = 0; attempt < 100; attempt++) {
      if (view.dom.querySelectorAll(".omd-table table").length === 2) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const tables = Array.from(view.dom.querySelectorAll<HTMLElement>(".omd-table"))
    expect(tables).toHaveLength(2)

    tables[0].querySelector<HTMLElement>("tbody td")!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
    )
    type(onlyInput(view), "9")

    tables[1].querySelector<HTMLElement>("tbody td")!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
    )
    type(onlyInput(view), "8")
    expect(view.state.doc.toString()).toContain("| 9 | 2 |")
    expect(view.state.doc.toString()).toContain("| 8 | 4 |")

    // First undo: reverts table 2 cell to "3"
    press(onlyInput(view), "z", { meta: true })
    expect(onlyInput(view).value).toBe("3")
    expect(tables[1].contains(onlyInput(view))).toBe(true)

    // Second undo: reverts table 1 cell to "1" and moves the live input back to table 1
    press(onlyInput(view), "z", { meta: true })
    const movedToFirst = onlyInput(view)
    expect(movedToFirst.value).toBe("1")
    expect(tables[0].contains(movedToFirst)).toBe(true)
    expect(document.activeElement).toBe(movedToFirst)
    expect(activeTableInputControllerCountForTest()).toBe(1)

    // Redo twice: restores table 1 ("9") then moves back to table 2 ("8")
    press(movedToFirst, "z", { meta: true, shift: true })
    expect(onlyInput(view).value).toBe("9")
    expect(tables[0].contains(onlyInput(view))).toBe(true)

    press(onlyInput(view), "z", { meta: true, shift: true })
    expect(onlyInput(view).value).toBe("8")
    expect(tables[1].contains(onlyInput(view))).toBe(true)
    expect(activeTableInputControllerCountForTest()).toBe(1)
    cleanup()
  })

  it("does not steal the active input when another table with identical source updates", async () => {
    const identicalTwoTables = "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nmiddle\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\ntail"
    const { view, cleanup } = mountDirect(true, identicalTwoTables)
    for (let attempt = 0; attempt < 100; attempt++) {
      if (view.dom.querySelectorAll(".omd-table table").length === 2) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const tables = Array.from(view.dom.querySelectorAll<HTMLElement>(".omd-table"))
    expect(tables).toHaveLength(2)

    tables[1].querySelector<HTMLElement>("tbody td")!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
    )
    expect(tables[1].contains(onlyInput(view))).toBe(true)

    const tableSrc = "| A | B |\n| --- | --- |\n| 1 | 2 |"
    const firstTablePos = identicalTwoTables.indexOf(tableSrc)
    const firstTableData = tableAt(view.state, firstTablePos)!.data
    const firstWidget = new TableWidget(tableSrc, firstTablePos, firstTableData, undefined, undefined, true)
    const prevFirstWidget = new TableWidget(tableSrc, firstTablePos, firstTableData, undefined, undefined, true)
    expect(firstWidget.updateDOM(tables[0], view, prevFirstWidget)).toBe(true)
    expect(tables[1].contains(onlyInput(view))).toBe(true)
    expect(activeTableInputControllerCountForTest()).toBe(1)
    cleanup()
  })

  it("ignores toolbar structural actions while composing and closes the session cleanly when not composing", async () => {
    const { view, cleanup } = mountDirect()
    const cells = await renderedCells(view)
    // Hover over cell (1, 0) so toolbar buttons become enabled
    cells[1][0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    activate(cells, 1, 0)
    const input = onlyInput(view)

    // While composing, clicking a toolbar button is ignored so un-committed IME text is not wiped
    input.dispatchEvent(new CompositionEvent("compositionstart"))
    input.value = "你"
    const alignRightBtn = view.dom.querySelector<HTMLButtonElement>("[data-act='align-right']")!
    alignRightBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    alignRightBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    expect(getTableEditSession(view.state)?.composing).toBe(true)
    expect(onlyInput(view).value).toBe("你")
    expect(view.state.doc.toString()).not.toContain("---:")

    // Finish composition, then click toolbar button -> closes input session and applies alignment
    input.dispatchEvent(new CompositionEvent("compositionend", { data: "你" }))
    expect(view.state.doc.toString()).toContain("| 你 | 2 |")
    alignRightBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    alignRightBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    expect(getTableEditSession(view.state)).toBeNull()
    expect(activeTableInputControllerCountForTest()).toBe(0)
    expect(view.state.doc.toString()).toContain("---:")
    cleanup()
  })
})
