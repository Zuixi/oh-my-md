// One-off audit tool (not in CI): measures in real Chromium whether repeated
// block-widget mount/unmount cycles leave objects a forced GC cannot reclaim.
// The happy-dom observation (docs/memory/gotchas-engine.md) may really be
// layout/CM tile cost, so confirm a leak with CDP before touching lifecycle.
//
// Usage: start the vite dev server yourself (PW_PORT, default 9420), then:
//   PW_PORT=9420 pnpm --filter @omd/desktop audit:widget-memory
// Output: chromium/platform identity + tableFlipChurn (caret flips across a
// 20-row quoted GFM table) and richWidgetCycles (all five block-widget families).
// Optional snapshots (diagnostic artifacts under /tmp, never committed):
//   PW_PORT=9420 PW_HEAP_SNAPSHOTS=1 pnpm --filter @omd/desktop audit:widget-memory
import fs from "node:fs"
import { withManagedChromium } from "./browserLifecycle.mjs"

const PORT = process.env.PW_PORT ?? "9420"
const CHANNEL = process.env.PW_CHANNEL ?? "chrome"
const SNAPSHOTS = process.env.PW_HEAP_SNAPSHOTS === "1"
// 127.0.0.1, not localhost: on Windows localhost may resolve to IPv6 only.
const HARNESS_URL = `http://127.0.0.1:${PORT}/e2e/harness.html`
const GC_SETTLE_MS = 50
const FLIP_SETTLE_MS = 100
const WIDGET_RENDER_SETTLE_MS = 25
const CYCLES_PER_SETTLE = 10
const SNAPSHOT_PATHS = {
  tableBaseline: "/tmp/omd-widget-baseline.heapsnapshot",
  tableFlips: "/tmp/omd-widget-after-1000.heapsnapshot",
  richBaseline: "/tmp/omd-rich-widget-baseline.heapsnapshot",
  richCycles: "/tmp/omd-rich-widget-cycles.heapsnapshot",
}

// Quoted table (20 rows + tail): the caret inside the block unmounts the
// widget, the document end renders it. One 0 <-> end trip = one unmount/mount.
const TABLE_DOC = [
  "> | a | b |",
  "> |---|---|",
  ...Array.from({ length: 20 }, (_, i) => `> | ${i} | ${i + 1} |`),
  "",
  "tail",
].join("\n")

// All five families: GFM table, raw HTML table (rowspan/colspan), display math,
// Mermaid, and a highlighted TypeScript fence.
const RICH_DOC = [
  "# Rich widget suite",
  "",
  "| Column | Value |",
  "| --- | --- |",
  ...Array.from({ length: 12 }, (_, i) => `| row ${i} | ${i} |`),
  "",
  "<table>",
  '  <tr><td rowspan="2">Merged</td><td colspan="2">Wide</td></tr>',
  "  <tr><td>C</td><td>D</td></tr>",
  "</table>",
  "",
  "$$",
  "\\int_0^\\infty x^2 e^{-x}\\,dx = 2",
  "$$",
  "",
  "```mermaid",
  "graph TD",
  "  A[Start] --> B[End]",
  "```",
  "",
  "```ts",
  "export const answer: number = 42",
  "```",
  "",
].join("\n")

const PLAIN_DOC = "# Plain\n\nReset buffer."
async function openHarness(browser, readySelector, doc) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const suffix = doc === undefined ? "" : `?doc=${encodeURIComponent(doc)}`
  await page.goto(`${HARNESS_URL}${suffix}`)
  await page.waitForSelector(readySelector, { timeout: 15000 })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("HeapProfiler.enable")
  return { page, cdp }
}

async function collectSample(page, cdp, label) {
  // Two passes: the first clears the young generation, the second collects the
  // objects the first pass itself promoted. Settle so finalizers can run.
  await cdp.send("HeapProfiler.collectGarbage")
  await cdp.send("HeapProfiler.collectGarbage")
  await page.waitForTimeout(GC_SETTLE_MS)
  const usage = await cdp.send("Runtime.getHeapUsage")
  const blockWidgets = await page.evaluate(() =>
    document.querySelectorAll(".omd-block").length)
  return {
    label,
    usedMB: Number((usage.usedSize / 1024 / 1024).toFixed(1)),
    usedSize: usage.usedSize,
    totalSize: usage.totalSize,
    domBlockWidgets: blockWidgets,
  }
}

// Chunks go straight to a file descriptor, so the snapshot never becomes one
// huge Node string. "w" truncates an older snapshot without rmSync.
async function captureSnapshot(cdp, path) {
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

async function maybeSnapshot(cdp, snapshots, key, path) {
  if (!SNAPSHOTS) return
  await captureSnapshot(cdp, path)
  snapshots[key] = path
}

// Drop every global reference the harness holds to the EditorView.
async function releaseHarnessGlobals(page) {
  await page.evaluate(() => {
    window.__view = undefined
    window.__docText = undefined
    window.__setLivePreview = undefined
    document.body.replaceChildren()
  })
}

async function runTableFlipChurn(browser) {
  const { page, cdp } = await openHarness(browser, ".omd-table table", TABLE_DOC)
  const samples = []
  const snapshots = {}
  async function flip(iterations) {
    await page.evaluate(count => {
      const view = window.__view
      const end = view.state.doc.length
      for (let i = 0; i < count; i++) {
        view.dispatch({ selection: { anchor: i % 2 === 0 ? end : 0 } })
      }
    }, iterations)
    await page.waitForTimeout(FLIP_SETTLE_MS)
  }

  samples.push(await collectSample(page, cdp, "baseline"))
  await maybeSnapshot(cdp, snapshots, "baseline", SNAPSHOT_PATHS.tableBaseline)
  // Cumulative: 100 -> 500 -> 1000 flips (increments of 100, 400, 500).
  await flip(100)
  samples.push(await collectSample(page, cdp, "flips100"))
  await flip(400)
  samples.push(await collectSample(page, cdp, "flips500"))
  await flip(500)
  samples.push(await collectSample(page, cdp, "flips1000"))
  await maybeSnapshot(cdp, snapshots, "flips1000", SNAPSHOT_PATHS.tableFlips)

  await page.evaluate(() => window.__view.destroy())
  samples.push(await collectSample(page, cdp, "afterViewDestroy"))
  // The destroyed view must not stay pinned by harness globals or its host DOM.
  await releaseHarnessGlobals(page)
  samples.push(await collectSample(page, cdp, "afterHostRelease"))
  await page.close()
  return { samples, ...(SNAPSHOTS ? { snapshots } : {}) }
}

async function runRichWidgetCycles(browser) {
  const { page, cdp } = await openHarness(browser, ".cm-editor", undefined)
  const samples = []
  const snapshots = {}
  async function replaceDocument(nextDoc) {
    await page.evaluate(doc => {
      const view = window.__view
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        selection: { anchor: doc.length },
      })
    }, nextDoc)
  }

  // Warm up lazy grammar/diagram/math bundles once and verify all 5 widget
  // families (GFM table, complex HTML table, KaTeX, Mermaid, Shiki code) mount.
  await replaceDocument(RICH_DOC)
  await page.waitForSelector(".omd-table table", { timeout: 15000 })
  await page.waitForSelector(".omd-math .katex", { timeout: 15000 })
  await page.waitForSelector(".omd-mermaid svg", { timeout: 15000 })
  await page.waitForSelector(".omd-code pre code", { timeout: 15000 })
  const warmedBlocks = await page.evaluate(() => document.querySelectorAll(".omd-block").length)
  if (warmedBlocks < 5) {
    throw new Error(`expected all 5 rich widget families to mount, got ${warmedBlocks}`)
  }
  await replaceDocument(PLAIN_DOC)
  await page.waitForTimeout(WIDGET_RENDER_SETTLE_MS)

  async function cycle(rounds) {
    for (let i = 0; i < rounds; i++) {
      await replaceDocument(RICH_DOC)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())))
      if ((i + 1) % CYCLES_PER_SETTLE === 0) await page.waitForTimeout(WIDGET_RENDER_SETTLE_MS)
      await replaceDocument(PLAIN_DOC)
    }
  }

  samples.push(await collectSample(page, cdp, "baselineAfterWarmup"))
  await maybeSnapshot(cdp, snapshots, "baseline", SNAPSHOT_PATHS.richBaseline)
  await cycle(15)
  samples.push(await collectSample(page, cdp, "cycles15"))
  await cycle(30)
  samples.push(await collectSample(page, cdp, "cycles45"))
  await cycle(45)
  samples.push(await collectSample(page, cdp, "cycles90"))
  await maybeSnapshot(cdp, snapshots, "cycles90", SNAPSHOT_PATHS.richCycles)

  // Plain document: every widget family must be unmounted from the DOM.
  await replaceDocument(PLAIN_DOC)
  await page.waitForTimeout(WIDGET_RENDER_SETTLE_MS)
  const afterPlainReset = await collectSample(page, cdp, "afterPlainReset")
  if (afterPlainReset.domBlockWidgets !== 0) {
    throw new Error(`plain reset left ${afterPlainReset.domBlockWidgets} .omd-block nodes`)
  }
  samples.push(afterPlainReset)

  // Destroy, then drop the globals that pin the view so this sample reflects a
  // fully released host (the same end state as the table suite).
  await page.evaluate(() => window.__view?.destroy())
  await releaseHarnessGlobals(page)
  samples.push(await collectSample(page, cdp, "afterHostRelease"))
  await page.close()
  return { warmedBlocks, samples, ...(SNAPSHOTS ? { snapshots } : {}) }
}
await withManagedChromium({ channel: CHANNEL }, async browser => {
  const tableFlipChurn = await runTableFlipChurn(browser)
  const richWidgetCycles = await runRichWidgetCycles(browser)
  console.log(JSON.stringify({
    chromium: browser.version(),
    channel: CHANNEL,
    platform: process.platform,
    arch: process.arch,
    port: PORT,
    tableFlipChurn,
    richWidgetCycles,
  }, null, 2))
})
