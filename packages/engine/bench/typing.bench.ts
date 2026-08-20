import { bench, describe } from "vitest"
import {
  budgetLine, fullyParsedLiveState, measureColdParseMs,
  measureDecoRebuildMs, measureStatsMs, measureTyping, STATS_BUDGET_MS, TYPING_P95_BUDGET_MS,
} from "./measure"
import {
  SAFE_MODE_RENDER_BUDGET_LINES, setBlockRenderBudget, setSafeModeRendering,
} from "../src/index"
import { makeBenchmarkDoc, makeBenchmarkDocBytes } from "./generate"

const DOC_10K = makeBenchmarkDoc(10000)
const DOC_50K = makeBenchmarkDoc(50000)
// Spec 05a：超大文档档（UTF-8 字节精确，确定性生成）。
const DOC_10MB = makeBenchmarkDocBytes(10 * 1024 * 1024)
const DOC_20MB = makeBenchmarkDocBytes(20 * 1024 * 1024)

describe("large document benchmarks (advisory)", () => {
  // 主口径 = steady（部分树，镜像生产 MaxParseAhead 行为）。
  bench("typing 10k lines (live, steady)", () => {
    const r = measureTyping(DOC_10K, { mode: "live", tree: "steady" })
    console.info(budgetLine("typing p95 10k live steady", r.p95Ms, TYPING_P95_BUDGET_MS))
  })

  bench("typing 10k lines (source, steady)", () => {
    const r = measureTyping(DOC_10K, { mode: "source", tree: "steady" })
    console.info(budgetLine("typing p95 10k source steady", r.p95Ms, TYPING_P95_BUDGET_MS))
  })

  bench("typing 50k lines (source, safe mode, steady)", () => {
    const r = measureTyping(DOC_50K, { mode: "source", tree: "steady", keystrokes: 100 })
    console.info(budgetLine("typing p95 50k source steady", r.p95Ms, TYPING_P95_BUDGET_MS))
  })

  bench("typing 10MB (source, steady)", () => {
    const r = measureTyping(DOC_10MB, { mode: "source", tree: "steady", keystrokes: 60 })
    console.info(budgetLine("typing p95 10MB source steady", r.p95Ms, TYPING_P95_BUDGET_MS))
  })

  bench("typing 20MB (source, steady)", () => {
    const r = measureTyping(DOC_20MB, { mode: "source", tree: "steady", keystrokes: 40 })
    console.info(budgetLine("typing p95 20MB source steady", r.p95Ms, TYPING_P95_BUDGET_MS))
  })

  // 安全模式窗口化稳态（Task 3）：live 模式 + 「窗口内已建、窗口外归还 pending」。
  // 生产中 desktop 对超大文档开安全模式后用户切 Live，装饰以视口窗口为界 ——
  // 每键的装饰映射/过滤成本不再随全文档装饰数增长。全局档位（安全模式开关 +
  // 块渲染预算）测完必须复位：模块级全局会跨场景、跨 bench 文件泄漏。
  bench("typing 10MB (live, safe mode windowed, steady)", () => {
    setSafeModeRendering(true)
    setBlockRenderBudget(SAFE_MODE_RENDER_BUDGET_LINES)
    try {
      const r = measureTyping(DOC_10MB, {
        mode: "live", tree: "steady", keystrokes: 60, safeWindow: true,
      })
      console.info(budgetLine("typing p95 10MB live windowed steady", r.p95Ms, TYPING_P95_BUDGET_MS))
    } finally {
      setSafeModeRendering(false)
      setBlockRenderBudget(Infinity)
    }
  })

  // worst-case 上限参考：完整树后每键 fragment 重启随文档规模增长（无预算断言）。
  bench("typing 10k lines (live, complete tree — worst case)", () => {
    const r = measureTyping(DOC_10K, { mode: "live", tree: "complete", keystrokes: 50 })
    console.info(`[worst-case] typing p95 10k live complete-tree: ${r.p95Ms.toFixed(2)}ms`)
  })

  bench("cold parse 10k", () => {
    console.info(`cold parse 10k: ${measureColdParseMs(DOC_10K).toFixed(2)}ms`)
  })

  bench("cold parse 50k", () => {
    console.info(`cold parse 50k: ${measureColdParseMs(DOC_50K).toFixed(2)}ms`)
  })

  bench("decoration rebuild 10k (live)", () => {
    const state = fullyParsedLiveState(DOC_10K)
    console.info(`deco rebuild 10k: ${measureDecoRebuildMs(state).toFixed(2)}ms`)
  })

  bench("documentStats 50k", () => {
    console.info(budgetLine("documentStats 50k", measureStatsMs(DOC_50K), STATS_BUDGET_MS))
  })
})
