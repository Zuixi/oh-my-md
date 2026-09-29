import { syntaxTree } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { describe, expect, it } from "vitest"
// 先经 helpers→build 进入模块图：decoration 层有既有 ESM 环（blockWidget ↔ blockSelectionOverlay
// ↔ build ↔ blocks ↔ widgets），从 table.ts 直接进入会在 widgets.ts 里拿到未初始化的
// BlockWidget（"Class extends value undefined"）。现有 tables.test.ts 同序。
import { makeState } from "./helpers"
import { TableWidget } from "../src/decorations/widgets/table"
import { tableDataFromNode, type TableData } from "../src/tables/model"

// 关键契约（docview.ts findWidget）：pass-1 `widget.updateDOM(tile.dom, view, tile.widget)`
// 成功后返回 `new WidgetTile(tile.dom, length, widget, flags)` —— DOM 与其监听器仍是旧实例
// 建的，tile.widget 却换成了新实例。下面每个用例都在验证这条轮换契约的后果。
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
  const dispatches: unknown[] = []
  const view = {
    state: { readOnly: false },
    requestMeasure: () => {},
    focus: () => {},
    posAtCoords: () => 0,
    posAtDOM: () => 0,
    dispatch: (spec: { changes?: Change | Change[]; selection?: unknown }) => {
      dispatches.push(spec)
      const list = Array.isArray(spec.changes) ? spec.changes : spec.changes ? [spec.changes] : []
      // 多 change 事务按 from 降序应用（等价于 CM 的单事务语义，用于断言最终文档）。
      for (const change of [...list].sort((a, b) => b.from - a.from)) {
        doc = doc.slice(0, change.from) + change.insert + doc.slice(change.to)
      }
    },
  }
  return { view, dispatches, doc: () => doc }
}

async function mount(widget: TableWidget, view: unknown): Promise<HTMLElement> {
  const dom = widget.toDOM(view as never)
  await Promise.resolve()
  return dom
}

function cellOf(dom: HTMLElement, row: number, col: number): HTMLElement {
  if (row === 0) return dom.querySelectorAll("thead th")[col] as HTMLElement
  return dom.querySelectorAll("tbody tr")[row - 1].children[col] as HTMLElement
}

describe("table widget in-place updateDOM", () => {
  it("patches only the changed cell and keeps the table DOM alive", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |"
    const { view } = fakeView(src)
    const before = new TableWidget(src, 0, tableData(src))
    const dom = await mount(before, view)
    const tableEl = dom.querySelector("table")
    const untouched = cellOf(dom, 2, 1)

    const nextSrc = "| a | b |\n|---|---|\n| x | 2 |\n| 3 | 4 |"
    const after = new TableWidget(nextSrc, 0, tableData(nextSrc))
    expect(after.updateDOM(dom, view as never, before)).toBe(true)

    expect(dom.querySelector("table")).toBe(tableEl)
    expect(cellOf(dom, 1, 0).textContent).toBe("x")
    expect(cellOf(dom, 1, 0)).not.toBe(untouched)
    expect(cellOf(dom, 2, 1)).toBe(untouched)
  })

  it("returns false for structural changes so CodeMirror rebuilds via toDOM", async () => {
    const one = "| a |\n|---|\n| 1 |"
    const two = "| a |\n|---|\n| 1 |\n| 2 |"
    const { view } = fakeView(one)
    const before = new TableWidget(one, 0, tableData(one))
    const dom = await mount(before, view)
    const after = new TableWidget(two, 0, tableData(two))
    expect(after.updateDOM(dom, view as never, before)).toBe(false)
  })

  it("keeps dispatching to the current owner across repeated pass-1 reuse", async () => {
    const src1 = "| a | b |\n|---|---|\n| 1 | 2 |"
    const { view } = fakeView(src1)
    const first = new TableWidget(src1, 0, tableData(src1))
    const dom = await mount(first, view)
    const src2 = "| a | b |\n|---|---|\n| 1 | 9 |"
    const second = new TableWidget(src2, 0, tableData(src2))
    expect(second.updateDOM(dom, view as never, first)).toBe(true)
    const src3 = "| a | b |\n|---|---|\n| 8 | 9 |"
    const third = new TableWidget(src3, 0, tableData(src3))
    expect(third.updateDOM(dom, view as never, second)).toBe(true)

    // 监听器仍是 first 挂的：必须把编辑态开在 third（最新 table）上。
    cellOf(dom, 1, 0).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const input = dom.querySelector("input.omd-table-edit") as HTMLInputElement | null
    expect(input).toBeTruthy()
    expect(input!.value).toBe("8")
  })

  it("consumes a pending Tab edit synchronously on the surviving DOM", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |"
    const { view, doc, dispatches } = fakeView(src)
    const first = new TableWidget(src, 0, tableData(src))
    const dom = await mount(first, view)

    cellOf(dom, 1, 0).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const input = dom.querySelector("input.omd-table-edit") as HTMLInputElement
    input.value = "x"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))
    expect(doc()).toBe("| a | b |\n|---|---|\n| x | 2 |")
    // 只统计变更事务：toDOM 末尾还会 dispatch 一次 measureBlockWidget 测量 effect。
    expect(dispatches.filter(spec => (spec as { changes?: unknown }).changes !== undefined)).toHaveLength(1)

    const committed = doc()
    const second = new TableWidget(committed, 0, tableData(committed))
    expect(second.updateDOM(dom, view as never, first)).toBe(true)
    // pending 同步消费：目标格（同行第 2 列）当场拿到输入框，没有 queueMicrotask 空窗。
    const dest = cellOf(dom, 1, 1).querySelector("input.omd-table-edit") as HTMLInputElement | null
    expect(dest).toBeTruthy()
    expect(dest!.value).toBe("2")
  })

  it("refreshes alignment styling and the toolbar highlight in place", async () => {
    const src = "| a |\n|---|\n| 1 |"
    const { view } = fakeView(src)
    const before = new TableWidget(src, 0, tableData(src))
    const dom = await mount(before, view)
    expect(dom.querySelector("[data-act='align-left']")?.classList.contains("omd-table-tool-active")).toBe(false)

    const nextSrc = "| a |\n|:--|\n| 1 |"
    const next = tableData(nextSrc)
    expect(next.aligns[0]).toBe("left")
    const after = new TableWidget(nextSrc, 0, next)
    expect(after.updateDOM(dom, view as never, before)).toBe(true)

    expect(cellOf(dom, 0, 0).style.textAlign).toBe("left")
    expect(cellOf(dom, 1, 0).style.textAlign).toBe("left")
    expect(dom.querySelector("[data-act='align-left']")?.classList.contains("omd-table-tool-active")).toBe(true)
  })

  it("keeps editing state across a pass-1 hand-off that leaves the cell untouched", async () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |"
    const { view, doc } = fakeView(src)
    const first = new TableWidget(src, 0, tableData(src))
    const dom = await mount(first, view)
    cellOf(dom, 1, 0).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    const input = dom.querySelector("input.omd-table-edit") as HTMLInputElement
    input.value = "draft"

    // 表体别处变化（未触碰正在编辑的格）—— 经真实 dispatch 落到 fake view 的文档上，
    // 保证 nextSrc 与 view 的文档一致。
    const at = src.lastIndexOf("2")
    view.dispatch({ changes: { from: at, to: at + 1, insert: "7" } })
    const nextSrc = doc()
    expect(nextSrc).toBe("| a | b |\n|---|---|\n| 1 | 7 |")

    const second = new TableWidget(nextSrc, 0, tableData(nextSrc))
    expect(second.updateDOM(dom, view as never, first)).toBe(true)
    const kept = cellOf(dom, 1, 0).querySelector("input.omd-table-edit") as HTMLInputElement | null
    expect(kept).toBe(input)
    kept!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))
    expect(doc()).toBe("| a | b |\n|---|---|\n| draft | 7 |")
  })
})
