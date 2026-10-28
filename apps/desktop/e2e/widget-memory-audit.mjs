// 一次性审计工具（不进 CI）：真实 Chromium 里量「块 widget 反复挂载/卸载」之后堆是否
// 真的留下无法回收的对象。happy-dom 侧的观察（见 docs/memory/gotchas-engine.md
// 「块 widget 反复挂载/卸载会持续占用内存」）在真实浏览器里可能是布局/CM tile 造成的，
// 所以在认定引擎有泄漏、动生命周期抽象之前，先用真实浏览器 + CDP 强制 GC 量一次。
//
// 用法：先起 vite dev server（PW_PORT，默认 9420），再
//   PW_PORT=9420 pnpm --filter @omd/desktop audit:widget-memory
// 输出：一个含 chromium 版本/平台 + 五个采样点 usedSize 的 JSON 对象。
//
// 可选快照（诊断产物，写到 /tmp，不进仓库）：
//   PW_PORT=9420 PW_HEAP_SNAPSHOTS=1 pnpm --filter @omd/desktop audit:widget-memory
// 在 baseline 与 flips1000 两个采样点后各流式落一份 .heapsnapshot，用 DevTools Memory 打开比对。
import fs from "node:fs"
import { chromium } from "@playwright/test"

const PORT = process.env.PW_PORT ?? "9420"
const CHANNEL = process.env.PW_CHANNEL ?? "chrome"
const SNAPSHOTS = process.env.PW_HEAP_SNAPSHOTS === "1"
const SNAPSHOT_PATHS = {
  baseline: "/tmp/omd-widget-baseline.heapsnapshot",
  after1000: "/tmp/omd-widget-after-1000.heapsnapshot",
}

// 引用内表格（20 行数据 + 尾随文本）：光标落在块内时 widget 卸载、落在文末时渲染，
// 一次「0 ↔ 文末」往返就是一次块 widget 卸载/挂载。
const DOC = [
  "> | a | b |",
  "> |---|---|",
  ...Array.from({ length: 20 }, (_, i) => `> | ${i} | ${i + 1} |`),
  "",
  "tail",
].join("\n")

const browser = await chromium.launch({ channel: CHANNEL })
let cdp = null
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  await page.goto(`http://localhost:${PORT}/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.waitForSelector(".omd-table table", { timeout: 15000 })

  cdp = await page.context().newCDPSession(page)
  await cdp.send("HeapProfiler.enable")

  async function collect(label) {
    await cdp.send("HeapProfiler.collectGarbage")
    await page.waitForTimeout(50)
    const usage = await cdp.send("Runtime.getHeapUsage")
    return {
      label,
      usedMB: Number((usage.usedSize / 1024 / 1024).toFixed(1)),
      usedSize: usage.usedSize,
      totalSize: usage.totalSize,
    }
  }

  // chunk 直接同步写 fd：整份快照不经过 Node 内存里的字符串拼接。
  async function captureSnapshot(path) {
    fs.rmSync(path, { force: true })
    const fd = fs.openSync(path, "w")
    const onChunk = ({ chunk }) => fs.writeSync(fd, chunk)
    try {
      cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk)
      await cdp.send("HeapProfiler.takeHeapSnapshot", {
        reportProgress: true,
        captureNumericValue: true,
      })
    } finally {
      cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk)
      fs.closeSync(fd)
    }
  }

  async function flip(count) {
    await page.evaluate(iterations => {
      const view = window.__view
      const end = view.state.doc.length
      for (let i = 0; i < iterations; i++) {
        view.dispatch({ selection: { anchor: i % 2 === 0 ? end : 0 } })
      }
    }, count)
    await page.waitForTimeout(100)
  }

  const samples = []
  const snapshotPaths = {}
  samples.push(await collect("baseline"))
  if (SNAPSHOTS) {
    await captureSnapshot(SNAPSHOT_PATHS.baseline)
    snapshotPaths.baseline = SNAPSHOT_PATHS.baseline
  }
  // 累计：100 → 500 → 1000 次翻转（增量 100 + 400 + 500）。
  await flip(100)
  samples.push(await collect("flips100"))
  await flip(400)
  samples.push(await collect("flips500"))
  await flip(500)
  samples.push(await collect("flips1000"))
  if (SNAPSHOTS) {
    await captureSnapshot(SNAPSHOT_PATHS.after1000)
    snapshotPaths.after1000 = SNAPSHOT_PATHS.after1000
  }
  await page.evaluate(() => window.__view.destroy())
  samples.push(await collect("afterDestroy"))

  console.log(
    JSON.stringify(
      {
        chromium: browser.version(),
        channel: CHANNEL,
        platform: process.platform,
        arch: process.arch,
        port: PORT,
        samples,
        ...(SNAPSHOTS ? { snapshots: snapshotPaths } : {}),
      },
      null,
      2,
    ),
  )
} finally {
  if (cdp) await cdp.detach().catch(() => {})
  await browser.close()
}
