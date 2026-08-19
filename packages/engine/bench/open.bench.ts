import { bench, describe } from "vitest"
import { budgetLine, measureOpenIngestMs } from "./measure"
import { makeBenchmarkDocBytes } from "./generate"

// Spec 05b：冷打开 TTIE 的主线程分量（ingest + 首屏视口解析，steady 树）。
// 不含 IPC 与读盘；Windows WebView2 的完整口径走 manual-qa 记录。
const DOC_10MB = makeBenchmarkDocBytes(10 * 1024 * 1024)
const DOC_20MB = makeBenchmarkDocBytes(20 * 1024 * 1024)
const DOC_50MB = makeBenchmarkDocBytes(50 * 1024 * 1024)

const OPEN_INGEST_BUDGET_10MB_MS = 2000
const OPEN_INGEST_BUDGET_20MB_MS = 4000
const OPEN_INGEST_BUDGET_50MB_MS = 8000

describe("cold open benchmarks (advisory, Spec 05b)", () => {
  bench("open ingest 10MB (source, steady)", () => {
    const ms = measureOpenIngestMs(DOC_10MB)
    console.info(budgetLine("open ingest 10MB", ms, OPEN_INGEST_BUDGET_10MB_MS))
  })

  bench("open ingest 20MB (source, steady)", () => {
    const ms = measureOpenIngestMs(DOC_20MB)
    console.info(budgetLine("open ingest 20MB", ms, OPEN_INGEST_BUDGET_20MB_MS))
  })

  bench("open ingest 50MB (source, steady)", () => {
    const ms = measureOpenIngestMs(DOC_50MB)
    console.info(budgetLine("open ingest 50MB", ms, OPEN_INGEST_BUDGET_50MB_MS))
  })
})
