import { writeFileSync } from "node:fs"
import { chromium } from "@playwright/test"

const EVIDENCE_PATH = "/tmp/omd-search-audit.json"
const PORT = process.env.PW_PORT ?? "9420"
const CHANNEL = process.env.PW_CHANNEL ?? "chrome"
const MIB = 1024 * 1024
const HEAP_LIMIT_BYTES = 32 * MIB
const DISPLAY_CAP = 10_000
const UNBOUNDED_CAP = 10_000_000
const FIXTURES = [
  { name: "dense-100m", expectedCount: 10_000, expectComplete: false, heapGate: true },
  { name: "normal-100m", expectedCount: 1600, expectComplete: true, heapGate: false },
]

const mb = bytes => Number((bytes / MIB).toFixed(1))

async function collect(cdp, page, samples, label) {
  await cdp.send("HeapProfiler.collectGarbage")
  await page.waitForTimeout(50)
  const usage = await cdp.send("Runtime.getHeapUsage")
  samples.push({ label, usedMB: mb(usage.usedSize), usedSize: usage.usedSize, totalSize: usage.totalSize })
  return usage.usedSize
}

async function measureScenario(browser, fixtureName) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send("HeapProfiler.enable")
    await page.goto(`http://localhost:${PORT}/e2e/harness.html?searchSpike=1`)
    await page.waitForFunction(() => window.__searchSpikeFixtures !== undefined, null, { timeout: 30000 })

    const samples = []
    const baseline = await collect(cdp, page, samples, "baseline")
    const fixture = await page.evaluate(name => window.__searchSpikeFixtures.build(name), fixtureName)
    const postConstruction = await collect(cdp, page, samples, "post-construction")

    const next = await page.evaluate(() => window.__searchSpikeFixtures.navigate("next", 0))
    const previous = await page.evaluate(() =>
      window.__searchSpikeFixtures.navigate("previous", window.__view.state.doc.length),
    )

    const count = await page.evaluate(cap => window.__searchSpikeFixtures.count({ cap }), DISPLAY_CAP)
    const postCount = await collect(cdp, page, samples, "post-count")

    await page.evaluate(cap => {
      void window.__searchSpikeFixtures.count({ cap })
    }, UNBOUNDED_CAP)
    await page.waitForTimeout(150)
    const cancellation = await page.evaluate(() => window.__searchSpikeFixtures.cancelCount())
    await collect(cdp, page, samples, "post-cancellation")

    await page.waitForTimeout(150)
    const guards = await page.evaluate(() => window.__searchSpikeFixtures.guards())

    await page.evaluate(() => window.__searchSpikeFixtures.release())
    const postRelease = await collect(cdp, page, samples, "post-release")

    return {
      fixture,
      samples,
      navigation: { next, previous },
      count,
      cancellation,
      guards,
      heap: {
        fixtureDeltaBytes: postConstruction - baseline,
        fixtureDeltaMB: mb(postConstruction - baseline),
        countDeltaBytes: postCount - postConstruction,
        countDeltaMB: mb(postCount - postConstruction),
        releaseDeltaBytes: postRelease - baseline,
        releaseDeltaMB: mb(postRelease - baseline),
      },
    }
  } finally {
    await cdp.detach().catch(() => {})
    await page.close()
  }
}

function checksFor(scenario, expectation) {
  const checks = {
    countMatchesCap: scenario.count.count === expectation.expectedCount,
    countCompleteness: scenario.count.complete === expectation.expectComplete,
    noStringify: scenario.guards.stringifyCalls === 0,
    noWholeDocumentSlice: scenario.guards.wholeDocumentSliceCalls === 0,
    noRetainedMatchArrays: scenario.guards.matchArraysRetained === 0,
    noStalePublishAfterCancel:
      scenario.cancellation.stalePublish === false &&
      scenario.guards.countPublishes === scenario.cancellation.publishedAfter,
  }
  if (expectation.heapGate) {
    checks.countHeapUnderLimit = scenario.heap.countDeltaBytes < HEAP_LIMIT_BYTES
  }
  return checks
}

const browser = await chromium.launch({ channel: CHANNEL })
try {
  const scenarios = []
  for (const expectation of FIXTURES) {
    const scenario = await measureScenario(browser, expectation.name)
    scenarios.push({
      name: expectation.name,
      ...scenario,
      checks: checksFor(scenario, expectation),
    })
  }

  const failed = scenarios.flatMap(scenario =>
    Object.entries(scenario.checks)
      .filter(([, passed]) => passed !== true)
      .map(([check]) => `${scenario.name}:${check}`),
  )

  const json = JSON.stringify(
    {
      chromium: browser.version(),
      channel: CHANNEL,
      platform: process.platform,
      arch: process.arch,
      port: PORT,
      limits: { heapGrowthBytes: HEAP_LIMIT_BYTES, displayCap: DISPLAY_CAP },
      scenarios,
      failed,
    },
    null,
    2,
  )
  writeFileSync(EVIDENCE_PATH, `${json}\n`)
  console.log(json)

  if (failed.length > 0) process.exitCode = 1
} finally {
  await browser.close()
}
