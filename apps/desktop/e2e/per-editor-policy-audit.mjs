import { chromium } from "@playwright/test"

const PORT = process.env.PW_PORT ?? "9420"
const CHANNEL = process.env.PW_CHANNEL ?? "chrome"
const VIEWPORT = { width: 1280, height: 800 }
const MODES = ["global", "local"]
const CONTROL = "global"
const EXPERIMENT = "local"
const WARMUPS = 10
const SAMPLES = 50
const SYNC_P95_BUDGET_MS = 16
const LONG_TASK_BUDGET_MS = 50
const VIEWPORT_READY_FLOOR_MS = 5
const VIEWPORT_READY_REGRESSION = 0.1
const EVIDENCE_PATH = "/tmp/omd-policy-spike-audit.json"

function percentile(sorted, p) {
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    p50Ms: Number(percentile(sorted, 50).toFixed(3)),
    p95Ms: Number(percentile(sorted, 95).toFixed(3)),
    peakMs: Number(sorted[sorted.length - 1].toFixed(3)),
    samples: sorted.length,
  }
}

async function measureMode(browser, mode) {
  const page = await browser.newPage({ viewport: VIEWPORT })
  try {
    await page.goto(`http://localhost:${PORT}/e2e/per-editor-policy-harness.html?audit=${mode}`)
    await page.waitForFunction(() => window.__policyAudit !== undefined, null, { timeout: 30_000 })
    await page.evaluate(() => window.__policySpike.waitViewportReady("A"))
    const result = await page.evaluate(
      options => window.__policyAudit.run(options),
      { warmups: WARMUPS, samples: SAMPLES },
    )
    const document = await page.evaluate(() => {
      const view = window.__policySpike.viewA
      const scroller = document.querySelector("#host-a .cm-scroller")
      return {
        lines: view.state.doc.lines,
        chars: view.state.doc.length,
        scrollTop: scroller === null ? null : scroller.scrollTop,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }
    })
    return {
      mode,
      document,
      sync: summarize(result.syncMs),
      viewportReady: summarize(result.viewportReadyMs),
      longTasks: {
        count: result.longTasks.length,
        maxMs: Number((result.longTasks.length === 0 ? 0 : Math.max(...result.longTasks)).toFixed(3)),
      },
      samples: result,
    }
  } finally {
    await page.close()
  }
}

function gatesFor(modes) {
  const control = modes[CONTROL]
  const experiment = modes[EXPERIMENT]
  const allowedRegressionMs = Math.max(
    VIEWPORT_READY_FLOOR_MS,
    control.viewportReady.p95Ms * VIEWPORT_READY_REGRESSION,
  )
  const viewportRegressionMs = Number(
    (experiment.viewportReady.p95Ms - control.viewportReady.p95Ms).toFixed(3),
  )
  const modesPresent = MODES.every(mode => modes[mode] !== undefined)
  return {
    bothModesMeasured: modesPresent,
    syncP95WithinBudget: modesPresent
      && MODES.every(mode => modes[mode].sync.p95Ms <= SYNC_P95_BUDGET_MS),
    viewportReadyRegressionAllowed: {
      controlP95Ms: control?.viewportReady.p95Ms ?? null,
      experimentP95Ms: experiment?.viewportReady.p95Ms ?? null,
      regressionMs: viewportRegressionMs,
      allowedMs: Number(allowedRegressionMs.toFixed(3)),
      passed: modesPresent && viewportRegressionMs <= allowedRegressionMs,
    },
    longTaskBudget: {
      budgetMs: LONG_TASK_BUDGET_MS,
      controlMaxMs: control?.longTasks.maxMs ?? null,
      experimentMaxMs: experiment?.longTasks.maxMs ?? null,
      passed: modesPresent
        && control.longTasks.maxMs <= LONG_TASK_BUDGET_MS
        && experiment.longTasks.maxMs <= LONG_TASK_BUDGET_MS,
    },
  }
}

function failedGates(gates) {
  const failed = []
  if (!gates.bothModesMeasured) failed.push("bothModesMeasured")
  if (!gates.syncP95WithinBudget) failed.push("syncP95WithinBudget")
  if (!gates.viewportReadyRegressionAllowed.passed) failed.push("viewportReadyRegressionAllowed")
  if (!gates.longTaskBudget.passed) failed.push("longTaskBudget")
  return failed
}

const browser = await chromium.launch({ channel: CHANNEL })
try {
  const modes = {}
  for (const mode of MODES) {
    modes[mode] = await measureMode(browser, mode)
  }
  const gates = gatesFor(modes)
  const failed = failedGates(gates)
  const report = {
    chromium: browser.version(),
    channel: CHANNEL,
    platform: process.platform,
    arch: process.arch,
    port: PORT,
    viewport: VIEWPORT,
    warmups: WARMUPS,
    measuredSwitches: SAMPLES,
    limits: {
      syncP95Ms: SYNC_P95_BUDGET_MS,
      longTaskMs: LONG_TASK_BUDGET_MS,
      viewportReadyFloorMs: VIEWPORT_READY_FLOOR_MS,
      viewportReadyRegression: VIEWPORT_READY_REGRESSION,
    },
    modes,
    gates,
    failed,
  }
  if (failed.length > 0) {
    const { writeFileSync } = await import("node:fs")
    writeFileSync(EVIDENCE_PATH, JSON.stringify(report, null, 2))
    console.log(`audit evidence written to ${EVIDENCE_PATH}`)
  }
  console.log(JSON.stringify(report, null, 2))
  if (failed.length > 0) process.exitCode = 1
} finally {
  await browser.close()
}
