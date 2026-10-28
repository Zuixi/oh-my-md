import { syntaxTree } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { describe, expect, it } from "vitest"
// 先经 helpers→build 进入模块图：decoration 层有既有 ESM 环（blockWidget ↔ blockSelectionOverlay
// ↔ build ↔ blocks ↔ widgets），从 table.ts 直接进入会在 widgets.ts 里拿到未初始化的
// BlockWidget（"Class extends value undefined"）。现有 tables.test.ts 同序。
import { makeState } from "./helpers"
import { TableWidget } from "../src/decorations/widgets/table"
import { applyBlockEmbed } from "../src/decorations/blockWidget"
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
    // sliceDoc：渲染态工具栏经 applyTableToolAt 校验 (from, source) 后才派发。
    state: { readOnly: false, sliceDoc: (from: number, to: number) => doc.slice(from, to) },
    requestMeasure: () => {},
    focus: () => {},
    posAtCoords: () => 0,
    posAtDOM: () => 0,
    dispatch: (spec: { changes?: Change | Change[]; selection?: unknown; effects?: unknown }) => {
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

  it("returns false for structural changes so CodeMirror rebuilds via toDOM", async () => {    const one = "| a |\n|---|\n| 1 |"
    const two = "| a |\n|---|\n| 1 |\n| 2 |"
    const { view } = fakeView(one)
    const before = new TableWidget(one, 0, tableData(one))
    const dom = await mount(before, view)
    const after = new TableWidget(two, 0, tableData(two))
    expect(after.updateDOM(dom, view as never, before)).toBe(false)
  })

  it("keeps the toolbar target and the current owner across repeated pass-1 reuse", async () => {
    const src1 = "| a | b |\n|---|---|\n| 1 | 2 |"
    const src2 = "| a | b |\n|---|---|\n| 1 | 9 |"
    const src3 = "| a | b |\n|---|---|\n| 8 | 9 |"
    const { view, doc } = fakeView(src3)
    const first = new TableWidget(src1, 0, tableData(src1))
    const dom = await mount(first, view)
    // hover 由 first 挂的监听器记录，随后两次 pass-1 轮换都要把它迁到新 owner 上。
    cellOf(dom, 1, 1).dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))

    const second = new TableWidget(src2, 0, tableData(src2))
    expect(second.updateDOM(dom, view as never, first)).toBe(true)
    const third = new TableWidget(src3, 0, tableData(src3))
    expect(third.updateDOM(dom, view as never, second)).toBe(true)

    // 监听器仍是 first 挂的：动作必须按最新 owner 的 (src/table/row/col) 派发 ——
    // 目标列来自 hover 的 col 1，源码来自 third（不是监听器闭包里的旧 src1）。
    const btn = dom.querySelector("[data-act='delete-col']") as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    expect(doc()).toBe("| a |\n|---|\n| 8 |")
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

  // 嵌入状态（列表深度/引用类）是两个实例之间唯一不在 src 里的 DOM 输入：
  // updateDOM 复用的旧 DOM 必须被重新同步，而不是停在上一层的类与深度上。
  it("re-synchronizes embed classes and depth on a reused DOM", async () => {
    const src = "| a |\n|---|\n| 1 |"
    const { view } = fakeView(src)
    const table = tableData(src)
    const before = new TableWidget(src, 0, table, { quoteDepth: 0, listDepth: 1, quoteInList: false })
    const dom = await mount(before, view)
    const tableEl = dom.querySelector("table")
    const body = dom.querySelector(".omd-block-body")
    expect(dom.style.getPropertyValue("--omd-list-depth")).toBe("1")

    const deeper = new TableWidget(src, 0, table, { quoteDepth: 0, listDepth: 5, quoteInList: false })
    expect(deeper.updateDOM(dom, view as never, before)).toBe(true)
    // DOM 身份仍复用（补丁路径），但深度与类已换成新嵌入值。
    expect(dom.querySelector("table")).toBe(tableEl)
    expect(dom.querySelector(".omd-block-body")).toBe(body)
    expect(dom.classList.contains("omd-li")).toBe(true)
    expect(dom.style.getPropertyValue("--omd-list-depth")).toBe("5")

    const quoteInList = new TableWidget(src, 0, table, { quoteDepth: 1, listDepth: 2, quoteInList: true })
    expect(quoteInList.updateDOM(dom, view as never, deeper)).toBe(true)
    expect(dom.classList.contains("omd-li")).toBe(false)
    expect(dom.classList.contains("omd-quote-in-li")).toBe(true)
    expect(dom.classList.contains("omd-blockquote-1")).toBe(true)
    expect(dom.style.getPropertyValue("--omd-list-depth")).toBe("2")

    const plain = new TableWidget(src, 0, table, { quoteDepth: 0, listDepth: 0, quoteInList: false })
    expect(plain.updateDOM(dom, view as never, quoteInList)).toBe(true)
    expect(dom.className).toBe("omd-block omd-table")
    expect(dom.style.getPropertyValue("--omd-list-depth")).toBe("")
  })

})
