import { bench, describe } from "vitest"
import { budgetLine, measureLiveToggleMs, TOGGLE_SEED_BUDGET_MS } from "./measure"
import { makeBenchmarkDocBytes } from "./generate"

// ⌘E 切换悬崖（source → live，Task 1 的动机场景）：Task 1 前 reconfigure 即
// 全量装饰构建（50MB 级秒级冻结）；现为 reconfigure + 光标种子构建，成本以
// 种子半径为界、与文档规模解耦 —— 10MB/20MB 两档数字基本持平即验证成功。
// advisory：超限只告警，不阻断。
const DOC_10MB = makeBenchmarkDocBytes(10 * 1024 * 1024)
const DOC_20MB = makeBenchmarkDocBytes(20 * 1024 * 1024)

describe("live toggle benchmarks (advisory)", () => {
  bench("live toggle 10MB (source → live, seed)", () => {
    const r = measureLiveToggleMs(DOC_10MB)
    console.info(budgetLine("toggle 10MB tx (reconfigure + seed) p95", r.toggleP95Ms, TOGGLE_SEED_BUDGET_MS))
    console.info(budgetLine("toggle 10MB pure seedLiveDecorations p95", r.seedP95Ms, TOGGLE_SEED_BUDGET_MS))
  })

  bench("live toggle 20MB (source → live, seed)", () => {
    const r = measureLiveToggleMs(DOC_20MB)
    console.info(budgetLine("toggle 20MB tx (reconfigure + seed) p95", r.toggleP95Ms, TOGGLE_SEED_BUDGET_MS))
    console.info(budgetLine("toggle 20MB pure seedLiveDecorations p95", r.seedP95Ms, TOGGLE_SEED_BUDGET_MS))
  })
})
