import { syntaxTree } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { describe, expect, it } from "vitest"
// 先经 helpers→build 进入模块图（既有 ESM 环，见 tableUpdateDOM.test.ts 注释）。
import { makeState } from "./helpers"
import { TableWidget } from "../src/decorations/widgets/table"
import { tableDataFromNode, type TableData } from "../src/tables/model"

function tableData(source: string): TableData {
  const state = makeState(source)
  let table: SyntaxNode | null = null
  const cursor = syntaxTree(state).cursor()
  do {
    if (cursor.name === "Table") {
      table = cursor.node
      break
    }
  } while (cursor.next())
  if (!table) throw new Error("expected a Table node")
  const data = tableDataFromNode(table, state)
  if (!data) throw new Error("expected table data")
  return data
}

type Change = { from: number; to: number; insert: string }

function fakeView(initial: string) {
  let doc = initial
  const dispatches: { changes?: Change | Change[]; selection?: unknown }[] = []
  const view = {
    state: { readOnly: false },
    requestMeasure: () => {},
    focus: () => {},
    posAtCoords: () => 0,
    posAtDOM: () => 0,
    dispatch: (spec: { changes?: Change | Change[]; selection?: unknown }) => {
      dispatches.push(spec)
      const list = Array.isArray(spec.changes) ? spec.changes : spec.changes ? [spec.changes] : []
      for (const change of [...list].sort((a, b) => b.from - a.from)) {
        doc = doc.slice(0, change.from) + change.insert + doc.slice(change.to)
      }
    },
  }
  return {
    view,
    dispatches,
    doc: () => doc,
    changes: () => dispatches.filter(spec => spec.changes !== undefined),
  }
}

function cellOf(dom: HTMLElement, row: number, col: number): HTMLElement {
  if (row === 0) return dom.querySelectorAll("thead th")[col] as HTMLElement
  return dom.querySelectorAll("tbody tr")[row - 1].children[col] as HTMLElement
}

const SRC = "| a | b |\n|---|---|\n| 1 | 2 |"

async function mountCellEditing(view: unknown, src = SRC, row = 1, col = 0) {
  const widget = new TableWidget(src, 0, tableData(src))
  const dom = widget.toDOM(view as never)
  await Promise.resolve()
  cellOf(dom, row, col).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
  const input = cellOf(dom, row, col).querySelector("input.omd-table-edit") as HTMLInputElement
  return { widget, dom, input }
}

describe("table cell input commit", () => {
  it("commits the typed value when the cell input loses focus", async () => {
    const { view, doc, changes } = fakeView(SRC)
    const { input } = await mountCellEditing(view)
    input.value = "x"
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))

    expect(doc()).toBe("| a | b |\n|---|---|\n| x | 2 |")
    expect(changes()).toHaveLength(1)
  })

  it("closes an unmodified cell without dispatching a transaction", async () => {
    const { view, doc, changes } = fakeView(SRC)
    const { input } = await mountCellEditing(view)
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))

    expect(doc()).toBe(SRC)
    expect(changes()).toHaveLength(0)
  })

  it("does not resurrect a cancelled edit when the input blurs", async () => {
    const { view, doc, changes } = fakeView(SRC)
    const { input } = await mountCellEditing(view)
    input.value = "discard me"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))

    expect(doc()).toBe(SRC)
    expect(changes()).toHaveLength(0)
  })

  it("ignores Enter while an IME composition is active", async () => {
    const { view, doc, changes } = fakeView(SRC)
    const { input } = await mountCellEditing(view)
    input.value = "ni hao"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }))

    expect(doc()).toBe(SRC)
    expect(changes()).toHaveLength(0)
    expect(input.isConnected || input.parentElement).toBeTruthy()
  })

  it("ignores the legacy 229 keydown emitted by IME candidate windows", async () => {
    const { view, doc, changes } = fakeView(SRC)
    const { input } = await mountCellEditing(view)
    input.value = "ni hao"
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    Object.defineProperty(event, "keyCode", { value: 229 })
    input.dispatchEvent(event)

    expect(doc()).toBe(SRC)
    expect(changes()).toHaveLength(0)
  })

  it("commits the open cell and moves the editor when another cell is clicked", async () => {
    const { view, doc } = fakeView(SRC)
    const { widget, dom, input } = await mountCellEditing(view)
    input.value = "x"

    cellOf(dom, 1, 1).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    expect(doc()).toBe("| a | b |\n|---|---|\n| x | 2 |")

    // 模拟 CM 的 pass-1 复用：新 widget 接手同一 DOM 并消费 pending 落点。
    const committed = doc()
    const next = new TableWidget(committed, 0, tableData(committed))
    expect(next.updateDOM(dom, view as never, widget)).toBe(true)
    const moved = cellOf(dom, 1, 1).querySelector("input.omd-table-edit") as HTMLInputElement | null
    expect(moved).toBeTruthy()
    expect(moved!.value).toBe("2")
    expect(cellOf(dom, 1, 0).querySelector("input.omd-table-edit")).toBeNull()
  })

  it("commits the open cell before the </> button takes the block into source", async () => {
    const { view, doc } = fakeView(SRC)
    const { dom, input } = await mountCellEditing(view)
    input.value = "x"
    dom.querySelector(".omd-block-edit")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))

    expect(doc()).toBe("| a | b |\n|---|---|\n| x | 2 |")
  })
})
