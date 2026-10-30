import { expect, test, type Page } from "@playwright/test"
import type { EditorView } from "@codemirror/view"

type SpikeView = "A" | "B"
type PolicyName = "standard" | "safe"

interface SpikeDiagnostics {
  readonly policy: PolicyName | null
  readonly pendingInWindow: number
  readonly pendingRanges: number
  readonly decorationSpecs: number
  readonly transactionCount: number
  readonly domFingerprint: string
}

interface SpikeApi {
  readonly viewA: EditorView
  readonly viewB: EditorView
  readonly set: (view: SpikeView, policy: PolicyName) => void
  readonly diagnostics: (view: SpikeView) => SpikeDiagnostics
  readonly waitViewportReady: (view: SpikeView) => Promise<number>
}

declare const window: Window & {
  __policySpike: SpikeApi
  __policySpikeErrors: string[]
}

const SPIKE_URL = "/e2e/per-editor-policy-harness.html"
const SPIKE_LINES = 10_000
const ALTERNATIONS = 100
const SETTLE_TIMEOUT_MS = 20_000

const diagnosticsOf = (page: Page, view: SpikeView) =>
  page.evaluate(key => window.__policySpike.diagnostics(key), view)

const waitReady = (page: Page, view: SpikeView) =>
  page.evaluate(key => window.__policySpike.waitViewportReady(key), view)

const setPolicy = (page: Page, view: SpikeView, policy: PolicyName) =>
  page.evaluate(request => window.__policySpike.set(request.view, request.policy), { view, policy })

async function expectPendingInWindow(page: Page, view: SpikeView, expected: number): Promise<void> {
  await expect
    .poll(async () => (await diagnosticsOf(page, view)).pendingInWindow, { timeout: SETTLE_TIMEOUT_MS })
    .toBe(expected)
}

async function openSpike(page: Page): Promise<void> {
  await page.goto(SPIKE_URL)
  await expect(page.locator(".cm-editor")).toHaveCount(2)
  await page.waitForFunction(() => window.__policySpike !== undefined, null, { timeout: 30_000 })
  await waitReady(page, "A")
  await waitReady(page, "B")
  await expectPendingInWindow(page, "A", 0)
  await expectPendingInWindow(page, "B", 0)
  await expect
    .poll(async () => (await diagnosticsOf(page, "A")).pendingRanges, { timeout: SETTLE_TIMEOUT_MS })
    .toBe(0)
}

test("two editors mount identical 10,000-line documents with independent policies", async ({ page }) => {
  await openSpike(page)

  const state = await page.evaluate(() => ({
    linesA: window.__policySpike.viewA.state.doc.lines,
    linesB: window.__policySpike.viewB.state.doc.lines,
    identical: window.__policySpike.viewA.state.doc.eq(window.__policySpike.viewB.state.doc),
    a: window.__policySpike.diagnostics("A"),
    b: window.__policySpike.diagnostics("B"),
    errors: window.__policySpikeErrors,
  }))

  expect(state.linesA).toBe(SPIKE_LINES)
  expect(state.linesB).toBe(SPIKE_LINES)
  expect(state.identical).toBe(true)
  expect(state.errors).toEqual([])
  expect(state.a.policy).toBe("standard")
  expect(state.b.policy).toBe("safe")
  expect(state.a.pendingRanges).toBe(0)
  expect(state.b.pendingRanges).toBeGreaterThan(0)
})

test("100 policy alternations preserve both views and never touch view A", async ({ page }) => {
  await openSpike(page)

  const result = await page.evaluate(count => {
    const spike = window.__policySpike
    const sourceHash = () => {
      const text = spike.viewA.state.doc.toString()
      let hash = 0
      for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 31 + text.charCodeAt(index)) | 0
      }
      return `${spike.viewA.state.doc.lines}:${text.length}:${hash}`
    }
    const selectionOf = () => {
      const selection = spike.viewA.state.selection.main
      return `${selection.from}:${selection.to}:${selection.anchor}:${selection.head}`
    }
    const viewA = spike.viewA
    const viewB = spike.viewB
    const domA = viewA.dom
    const domB = viewB.dom
    const baseline = spike.diagnostics("A")
    const baselineSource = sourceHash()
    const baselineSelection = selectionOf()
    const violations: string[] = []

    for (let index = 0; index < count; index += 1) {
      spike.set("B", index % 2 === 0 ? "standard" : "safe")
      const current = spike.diagnostics("A")
      if (spike.viewA !== viewA || spike.viewB !== viewB) violations.push(`view identity at ${index}`)
      if (spike.viewA.dom !== domA || spike.viewB.dom !== domB) violations.push(`dom identity at ${index}`)
      if (current.policy !== baseline.policy) violations.push(`view A policy at ${index}`)
      if (current.transactionCount !== baseline.transactionCount) {
        violations.push(`view A transactions at ${index}: ${current.transactionCount}`)
      }
      if (current.domFingerprint !== baseline.domFingerprint) {
        violations.push(`view A dom fingerprint at ${index}`)
      }
      if (current.pendingInWindow !== baseline.pendingInWindow) {
        violations.push(`view A pendingInWindow at ${index}`)
      }
      if (current.pendingRanges !== baseline.pendingRanges) {
        violations.push(`view A pendingRanges at ${index}`)
      }
    }

    return {
      violations: violations.slice(0, 10),
      baselineTransactions: baseline.transactionCount,
      finalTransactions: spike.diagnostics("A").transactionCount,
      baselineSource,
      finalSource: sourceHash(),
      baselineSelection,
      finalSelection: selectionOf(),
      policyB: spike.diagnostics("B").policy,
    }
  }, ALTERNATIONS)

  expect(result.violations).toEqual([])
  expect(result.finalTransactions).toBe(result.baselineTransactions)
  expect(result.finalSource).toBe(result.baselineSource)
  expect(result.finalSelection).toBe(result.baselineSelection)
  expect(result.policyB).toBe("safe")
})

test("view B keeps out-of-window pending in safe mode and drains fully in standard mode", async ({ page }) => {
  await openSpike(page)

  const baselineA = await diagnosticsOf(page, "A")
  const safe = await diagnosticsOf(page, "B")
  expect(safe.policy).toBe("safe")
  expect(safe.pendingRanges).toBeGreaterThan(0)

  await setPolicy(page, "B", "standard")
  await waitReady(page, "B")
  expect((await diagnosticsOf(page, "B")).policy).toBe("standard")
  await expect
    .poll(async () => (await diagnosticsOf(page, "B")).pendingRanges, { timeout: SETTLE_TIMEOUT_MS })
    .toBe(0)
  await expectPendingInWindow(page, "B", 0)

  await setPolicy(page, "B", "safe")
  await waitReady(page, "B")
  await expectPendingInWindow(page, "B", 0)
  expect((await diagnosticsOf(page, "B")).pendingRanges).toBeGreaterThan(0)

  const finalA = await diagnosticsOf(page, "A")
  expect(finalA.transactionCount).toBe(baselineA.transactionCount)
  expect(finalA.pendingRanges).toBe(0)
  expect(finalA.domFingerprint).toBe(baselineA.domFingerprint)
})
