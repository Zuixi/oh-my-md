// 一次性审计工具（不进 CI）：表格直接编辑 spike 的配对堆审计。
//
// 同一份 canonical 表格 fixture、同一个 harness 页面，跑两组 bounded 循环：
//   control    —— 预览格 mousedown 进源码（整表 widget 卸载），外层选区回文末重新挂载预览；
//   experiment —— 格 mousedown 开输入框，一次输入提交改掉该格，外层 undo 还原成逐字节
//                 相同的 fixture（输入框仍存活），Escape 关闭。
// 五对 fresh page 交替顺序（experiment/control、control/experiment、…），每个采样点先
// CDP 强制 GC 再读 Runtime.getHeapUsage：baseline / 累计 100 / 500 / 1000 / after destroy。
//
// 用法：先起隔离的 vite dev server，再
//   PW_PORT=9434 pnpm --filter @omd/desktop audit:table-direct-edit-spike
// 输出：格式化 JSON（同时写到 /tmp/omd-table-direct-edit-audit.json），gate 失败时 exit 1。
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import { chromium } from "@playwright/test"

const PORT = process.env.PW_PORT ?? "9420"
const CHANNEL = process.env.PW_CHANNEL ?? "chrome"
const VIEWPORT = { width: 1200, height: 900 }
const MIB = 1024 * 1024
const PAIRS = 5
/** 累计循环数的采样点（顺序执行，增量喂给 harness）。 */
const CYCLE_SAMPLES = [100, 500, 1000]
/** GC 后固定短等待：两组完全一致，不做任何负载生成。 */
const GC_SETTLE_MS = 50
const MAX_EXPERIMENT_MEDIAN_GROWTH = 32 * MIB
const MAX_EXPERIMENT_MEDIAN_OVER_CONTROL = 8 * MIB
const MAX_EXPERIMENT_RUN_GROWTH = 64 * MIB
const REPORT_PATH = "/tmp/omd-table-direct-edit-audit.json"

// 固定 canonical 表格 fixture（与 table-direct-edit-spike.spec.ts 的 CANONICAL 一致）。
const FIXTURE = ["| A | B |", "| --- | --- |", "| 1 | 2 |", "", "tail"].join("\n")

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const toMiB = bytes => Number((bytes / MIB).toFixed(2))

function harnessUrl(mode) {
  const params = new URLSearchParams({ tableMemorySpike: "1", doc: FIXTURE })
  if (mode === "experiment") params.set("tableDirectEdit", "1")
  return `http://127.0.0.1:${PORT}/e2e/harness.html?${params.toString()}`
}

function readCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  } catch {
    return "unknown"
  }
}

async function collect(cdp, page, label) {
  await cdp.send("HeapProfiler.collectGarbage")
  await page.waitForTimeout(GC_SETTLE_MS)
  const usage = await cdp.send("Runtime.getHeapUsage")
  const snapshot = await page.evaluate(() => window.__tableDirectEditAudit.snapshot())
  return {
    label,
    usedSize: usage.usedSize,
    totalSize: usage.totalSize,
    usedMB: Number((usage.usedSize / 1024 / 1024).toFixed(2)),
    inputCount: snapshot.inputCount,
    controllerCount: snapshot.controllerCount,
    docEqualsFixture: snapshot.docEqualsFixture,
  }
}

async function runCycles(page, mode, cycles) {
  if (cycles <= 0) return
  await page.evaluate(({ mode, cycles }) => {
    const audit = window.__tableDirectEditAudit
    if (!audit) throw new Error("table audit helper missing: load the harness with tableMemorySpike=1")
    return mode === "control" ? audit.runControl(cycles) : audit.runExperiment(cycles)
  }, { mode, cycles })
}

/** 一个 fresh page 跑完一组（control 或 experiment）的全部采样点。 */
async function runMember(browser, mode) {
  const page = await browser.newPage({ viewport: VIEWPORT })
  let cdp = null
  try {
    await page.goto(harnessUrl(mode))
    await page.waitForSelector(".omd-table table", { timeout: 15000 })
    await page.waitForFunction(() => Boolean(window.__tableDirectEditAudit), undefined, { timeout: 15000 })
    const seen = await page.evaluate(() => ({
      fixture: window.__tableDirectEditAudit.fixture,
      doc: window.__view.state.doc.toString(),
    }))
    if (seen.fixture !== FIXTURE || seen.doc !== FIXTURE) {
      throw new Error(`harness fixture drifted from the audit fixture (${seen.fixture.length} bytes)`)
    }

    cdp = await page.context().newCDPSession(page)
    await cdp.send("HeapProfiler.enable")

    const samples = [await collect(cdp, page, "baseline")]
    let done = 0
    for (const target of CYCLE_SAMPLES) {
      await runCycles(page, mode, target - done)
      done = target
      samples.push(await collect(cdp, page, `cycles${target}`))
    }
    await page.evaluate(() => window.__tableDirectEditAudit.destroy())
    samples.push(await collect(cdp, page, "afterDestroy"))

    const drifted = samples.filter(sample => sample.docEqualsFixture === false)
    if (drifted.length > 0) {
      throw new Error(`document drifted from the fixture at ${drifted.map(sample => sample.label).join(", ")}`)
    }
    const at = label => samples.find(sample => sample.label === label)
    return {
      mode,
      growth100to1000: at("cycles1000").usedSize - at("cycles100").usedSize,
      samples,
    }
  } finally {
    if (cdp) await cdp.detach().catch(() => {})
    await page.close().catch(() => {})
  }
}

const browser = await chromium.launch({ channel: CHANNEL })
const environment = {
  chromium: browser.version(),
  channel: CHANNEL,
  platform: process.platform,
  arch: process.arch,
  viewport: VIEWPORT,
  port: PORT,
  commit: readCommit(),
  harness: "/e2e/harness.html?tableMemorySpike=1[&tableDirectEdit=1]",
}

const pairs = []
const discarded = []
let discardBudget = 1
let aborted = null

try {
  for (let index = 0; index < PAIRS; index++) {
    const order = index % 2 === 0 ? ["experiment", "control"] : ["control", "experiment"]
    let attempt = 0
    let valid = false
    while (!valid) {
      attempt += 1
      try {
        const runs = {}
        for (const mode of order) runs[mode] = await runMember(browser, mode)
        pairs.push({ pair: index + 1, attempt, order, runs })
        valid = true
      } catch (error) {
        // 只有导航/选择器/页面 helper/CDP 采集抛异常才允许丢一次重试；
        // 堆数字不理想永远不是重跑的理由。
        const reason = error instanceof Error ? error.message : String(error)
        if (discardBudget === 0) {
          aborted = `pair ${index + 1} (attempt ${attempt}): ${reason}`
          break
        }
        discardBudget -= 1
        discarded.push({ pair: index + 1, attempt, order, reason })
      }
    }
    if (aborted) break
  }
} finally {
  await browser.close().catch(() => {})
}

const controlGrowth = pairs.map(entry => entry.runs.control.growth100to1000)
const experimentGrowth = pairs.map(entry => entry.runs.experiment.growth100to1000)
const controlMedian = controlGrowth.length === 0 ? null : median(controlGrowth)
const experimentMedian = experimentGrowth.length === 0 ? null : median(experimentGrowth)
const experimentMax = experimentGrowth.length === 0 ? null : Math.max(...experimentGrowth)
const medianDelta = controlMedian === null || experimentMedian === null
  ? null
  : experimentMedian - controlMedian

const metrics = {
  validPairs: pairs.length,
  controlMedian: { bytes: controlMedian, MiB: controlMedian === null ? null : toMiB(controlMedian) },
  experimentMedian: { bytes: experimentMedian, MiB: experimentMedian === null ? null : toMiB(experimentMedian) },
  experimentMax: { bytes: experimentMax, MiB: experimentMax === null ? null : toMiB(experimentMax) },
  experimentMinusControlMedianDelta: {
    bytes: medianDelta,
    MiB: medianDelta === null ? null : toMiB(medianDelta),
  },
  controlGrowth100to1000: controlGrowth,
  experimentGrowth100to1000: experimentGrowth,
}

const afterDestroyClean = pairs.every(entry => ["control", "experiment"].every(mode => {
  const sample = entry.runs[mode].samples.find(candidate => candidate.label === "afterDestroy")
  return sample.inputCount === 0 && sample.controllerCount === 0
}))

const gates = {
  fiveValidPairs: pairs.length === PAIRS,
  experimentMedianAtMost32MiB: experimentMedian !== null && experimentMedian <= MAX_EXPERIMENT_MEDIAN_GROWTH,
  experimentMedianWithinControlMedianPlus8MiB: experimentMedian !== null
    && controlMedian !== null
    && experimentMedian <= controlMedian + MAX_EXPERIMENT_MEDIAN_OVER_CONTROL,
  everyExperimentRunAtMost64MiB: experimentGrowth.length === PAIRS
    && experimentGrowth.every(growth => growth <= MAX_EXPERIMENT_RUN_GROWTH),
  afterDestroyZeroInputsAndControllers: afterDestroyClean,
}

const failed = Object.entries(gates).filter(([, ok]) => !ok).map(([name]) => name)

const report = {
  environment,
  fixture: FIXTURE,
  pairs,
  discarded,
  metrics,
  gates,
  failed,
  ...(aborted === null ? {} : { aborted }),
}

const json = JSON.stringify(report, null, 2)
fs.writeFileSync(REPORT_PATH, `${json}\n`)
console.log(json)
process.exitCode = failed.length > 0 ? 1 : 0
