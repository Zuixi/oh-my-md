import { bench, describe } from "vitest"
import { budgetLine, measureChunkedTextBuildMs, measureOpenIngestChunksMs, measureOpenIngestMs } from "./measure"
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

  // Task 5：live 摄入（live 构造 + 挂载首帧，首帧含光标种子构建 —— Task 1 后
  // 不再全量，剩余区间由 idle 分片消化、不在本同步边界内）。与 source 档同
  // 预算：种子成本有界，live 打开不应显著劣于 source 打开。
  bench("open ingest 10MB (live, steady)", () => {
    const ms = measureOpenIngestMs(DOC_10MB, "live")
    console.info(budgetLine("open ingest 10MB live", ms, OPEN_INGEST_BUDGET_10MB_MS))
  })

  bench("open ingest 20MB (live, steady)", () => {
    const ms = measureOpenIngestMs(DOC_20MB, "live")
    console.info(budgetLine("open ingest 20MB live", ms, OPEN_INGEST_BUDGET_20MB_MS))
  })
})

// Task 10 摄入路径对比（advisory，无预算门）：现行「整串 → EditorState.create
// 内部 regex 切行」vs「IPC 分块到达即切行组 Text → Text 构造」。分块按
// 512*1024 字符近似 Rust 侧 OPEN_CHUNK_BYTES 的 512KiB 字节分块 —— 真实 IPC
// 是 UTF-8 字节切、JS 侧收到字符串，字符数口径只在块数上略有偏差，不影响
// 两路径的量级对比。
const CHUNK_CHARS = 512 * 1024

function chunkDoc(doc: string): string[] {
  const chunks: string[] = []
  for (let i = 0; i < doc.length; i += CHUNK_CHARS) chunks.push(doc.slice(i, i + CHUNK_CHARS))
  return chunks
}

describe("chunked Text ingest comparison (advisory, Task 10)", () => {
  const chunks10 = chunkDoc(DOC_10MB)
  const chunks50 = chunkDoc(DOC_50MB)

  bench("open ingest 10MB (string split, current)", () => {
    console.info(`open ingest 10MB string-split: ${measureOpenIngestMs(DOC_10MB).toFixed(2)}ms`)
  })

  bench("open ingest 10MB (chunked Text assembly)", () => {
    console.info(`open ingest 10MB chunked-text: ${measureOpenIngestChunksMs(chunks10).toFixed(2)}ms`)
  })

  bench("open ingest 50MB (string split, current)", () => {
    console.info(`open ingest 50MB string-split: ${measureOpenIngestMs(DOC_50MB).toFixed(2)}ms`)
  })

  bench("open ingest 50MB (chunked Text assembly)", () => {
    console.info(`open ingest 50MB chunked-text: ${measureOpenIngestChunksMs(chunks50).toFixed(2)}ms`)
  })

  bench("chunk splitter standalone 50MB", () => {
    console.info(`chunked text build 50MB: ${measureChunkedTextBuildMs(chunks50).toFixed(2)}ms`)
  })
})
