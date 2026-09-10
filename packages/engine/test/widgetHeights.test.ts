import { describe, expect, it } from "vitest"
import type { EditorState } from "@codemirror/state"
import type { WidgetType } from "@codemirror/view"
import { makeState } from "./helpers"
import { collectDecorationSpecs } from "../src/decorations/build"
import type { DecoSpec } from "../src/decorations/types"
import { TableWidget } from "../src/decorations/widgets/table"
import { CodeWidget } from "../src/decorations/widgets/code"
import { estimateTableHeightPx, estimateCodeBlockHeightPx } from "../src/decorations/widgetHeights"

// 从块 widget 装饰 spec 取出 widget 实例：Decoration.replace 的 spec 带 widget。
function widgetOf(spec: DecoSpec): WidgetType | undefined {
  return (spec.deco.spec as { widget?: WidgetType }).widget
}

// 光标移到文末（远离全部块），全量收集装饰 spec。
function allSpecsAtDocEnd(doc: string): DecoSpec[] {
  let state: EditorState = makeState(doc)
  state = state.update({ selection: { anchor: doc.length } }).state
  return collectDecorationSpecs(state, 0, state.doc.length)
}

function blockWidgetSpecs(doc: string, tag: string): DecoSpec[] {
  return allSpecsAtDocEnd(doc).filter(s => s.tag === tag)
}

// 滚动性能回归守护：块 widget 必须给 CodeMirror 提供高度估算（estimatedHeight）。
// 缺省 -1 时 CM 按**一行行高**估算整块 —— 表格/代码块在视口像素→字符换算中
// 严重欠估，一次滚动过绘多个重块 + 实测修正回环（滚动卡顿主因，见
// src/decorations/widgetHeights.ts 头注）。本文件锁两件事：
//   1) 全部块 widget 类型都声明了 >0 的估算（缺省 -1 直接失败）；
//   2) 估算随内容规模线性增长（表格按行数、代码块按行数）。
describe("block widget estimatedHeight (scroll performance)", () => {
  it("every mounted block widget declares a positive height estimate", () => {
    const doc = [
      "---",
      "title: t",
      "---",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "```js",
      "let a = 1",
      "```",
      "",
      "$$E=mc^2$$",
      "",
      "---",
      "",
      "```mermaid",
      "graph TD",
      "A-->B",
      "```",
      "",
      "text",
    ].join("\n")
    const blockSpecs = allSpecsAtDocEnd(doc).filter(s => s.tag.startsWith("widget:block:"))
    const tags = [...new Set(blockSpecs.map(s => s.tag))]
    expect(tags).toEqual(expect.arrayContaining([
      "widget:block:front-matter",
      "widget:block:table",
      "widget:block:code",
      "widget:block:math",
      "widget:block:hr",
      "widget:block:mermaid",
    ]))
    for (const spec of blockSpecs) {
      const widget = widgetOf(spec)
      expect(widget, spec.tag).toBeTruthy()
      expect(widget!.estimatedHeight, `${spec.tag} must declare an estimate`).toBeGreaterThan(0)
    }
  })

  it("table estimate scales with data rows and wrapped cell text", () => {
    const small = "| a | b |\n|---|---|\n| x | y |"
    // 单元格长文本（软换行多行）应显著抬高该行估算
    const wrappedCell = "一".repeat(60)
    const rows20 = Array.from({ length: 20 }, (_, i) => `| ${wrappedCell}${i} | x |`).join("\n")
    const big = `| a | b |\n|---|---|\n${rows20}`
    const tables = blockWidgetSpecs(`${small}\n\ntext\n\n${big}\n\ntail`, "widget:block:table")
      .map(spec => widgetOf(spec) as TableWidget)
    expect(tables).toHaveLength(2)
    expect(tables[0].table.rows.length).toBe(1)
    expect(tables[1].table.rows.length).toBe(20)
    expect(tables[0].estimatedHeight).toBe(estimateTableHeightPx(tables[0].table))
    expect(tables[1].estimatedHeight).toBe(estimateTableHeightPx(tables[1].table))
    // 行数 20 倍 → 估算显著增长（欠估回环守护：缺省时两者同为 ~一行行高）。
    expect(tables[1].estimatedHeight / tables[0].estimatedHeight).toBeGreaterThan(5)
    // 换行感知：含 60 字长格的表估算高于同规模全单行表（固定 42px/行的旧公式
    // 看不出差异 —— 真实文档曾因此低估全文总高 8.4%，thumb 对齐失真）。
    const plain20 = `| a | b |\n|---|---|\n${Array.from({ length: 20 }, (_, i) => `| ${i} | x |`).join("\n")}`
    const plain = blockWidgetSpecs(`${plain20}\n\ntail`, "widget:block:table")
      .map(spec => widgetOf(spec) as TableWidget)
    expect(plain).toHaveLength(1)
    expect(tables[1].estimatedHeight).toBeGreaterThan(plain[0].estimatedHeight * 1.3)
  })

  it("code estimate scales with source lines", () => {
    const longLines = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i}`).join("\n")
    const doc = "```js\nlet a = 1\n```\n\ntext\n\n```js\n" + longLines + "\n```\n\ntail"
    const blocks = blockWidgetSpecs(doc, "widget:block:code")
      .map(spec => widgetOf(spec) as CodeWidget)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].estimatedHeight).toBe(estimateCodeBlockHeightPx(1))
    expect(blocks[1].estimatedHeight).toBe(estimateCodeBlockHeightPx(60))
    expect(blocks[1].estimatedHeight).toBeGreaterThan(10 * blocks[0].estimatedHeight)
  })
})
