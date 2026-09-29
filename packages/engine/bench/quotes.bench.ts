import { forceParsing } from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { bench, describe } from "vitest"
import { continueQuote, editorExtensions } from "../src/index"
import { budgetLine, measureTyping, TYPING_P95_BUDGET_MS } from "./measure"

// Task 3/4 的回归护栏：Enter 续行改为「读语法树的行块前缀 + 重新拼接」后，每笔
// Enter 的成本必须仍是行局部的（O(行内 mark 数)），不能随引用块规模增长；同时
// 引用块存在时的逐键输入（装饰重建路径）也要留在 16ms 预算内。
function makeQuoteDoc(lines: number, depth = 1): string {
  const prefix = "> ".repeat(depth)
  const body: string[] = []
  for (let i = 0; i < lines; i++) {
    body.push(`${prefix}引用第 ${i} 行：中文正文与 English mixed content，用于逐键输入负载。`)
  }
  return body.join("\n")
}

const QUOTE_200 = makeQuoteDoc(200)
const QUOTE_200_NESTED = makeQuoteDoc(200, 3)

function measureQuoteEnter(doc: string, presses: number): { p50Ms: number; p95Ms: number } {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc, selection: { anchor: doc.indexOf("\n") + 2 }, extensions: editorExtensions(),
    }),
    parent,
  })
  // 完整树。每轮 = 「Enter 续写引用行 + 输入一个字」：只按 Enter 会在第一轮落到
  // 前缀空行上（此时回车是「退出一层引用」，命令随即不再接管），基准必须有内容。
  // 命令返回 false 时直接抛错 —— vitest bench 会静默丢弃抛错的用例（汇总里只剩
  // "NaNx faster"），绝不能让基准悄悄测成空操作。
  forceParsing(view, view.state.doc.length, 60_000)
  const samples: number[] = []
  for (let i = 0; i < presses; i++) {
    const t0 = performance.now()
    if (!continueQuote(view)) throw new Error("continueQuote stopped continuing — bench would measure a no-op")
    const head = view.state.selection.main.head
    view.dispatch({ changes: { from: head, insert: "字" }, selection: { anchor: head + 1 } })
    samples.push(performance.now() - t0)
  }
  view.destroy()
  parent.remove()
  const sorted = [...samples].sort((a, b) => a - b)
  return { p50Ms: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] }
}

describe("blockquote editing benchmarks (advisory)", () => {
  bench("typing inside a 200-line quote (live, steady)", () => {
    const r = measureTyping(QUOTE_200, { mode: "live", tree: "steady", keystrokes: 200 })
    console.info(budgetLine("quote typing p95 200 lines", r.p95Ms, TYPING_P95_BUDGET_MS))
  })

  bench("Enter continuation in a 200-line quote", () => {
    const r = measureQuoteEnter(QUOTE_200, 200)
    console.info(budgetLine("quote Enter p95 200 lines", r.p95Ms, TYPING_P95_BUDGET_MS))
  })

  bench("Enter continuation in a 200-line nested quote", () => {
    const r = measureQuoteEnter(QUOTE_200_NESTED, 200)
    console.info(budgetLine("nested quote Enter p95 200 lines", r.p95Ms, TYPING_P95_BUDGET_MS))
  })
})
