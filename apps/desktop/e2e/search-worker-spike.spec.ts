import { expect, test, type Page } from "@playwright/test"
import type { EditorView } from "@codemirror/view"

type SpikeResponse =
  | { readonly id: number; readonly revision: number; readonly match: { readonly from: number; readonly to: number } | null }
  | { readonly id: number; readonly revision: number; readonly error: string }

type SpikeHandle = {
  readonly run: (source: string, flags: string, text: string) => Promise<SpikeResponse>
  readonly setRevision: (revision: number) => void
  readonly pending: () => number
  readonly accepted: () => readonly SpikeResponse[]
  readonly discarded: () => readonly SpikeResponse[]
  readonly terminate: () => void
  readonly terminated: () => boolean
}

type HarnessWindow = Window & {
  __view: EditorView
  __startSearchSpike?: (revision: number) => SpikeHandle
  __searchSpike?: SpikeHandle
}

declare const window: HarnessWindow

const DOC = "a😀needle😀b"
const RESPONSIVE_DOC = "0123456789\n\ntail"
const CATASTROPHIC = { source: "(a+)+b", flags: "", text: "a".repeat(45) }

const spikeUrl = (doc: string) => `/e2e/harness.html?searchSpike=1&doc=${encodeURIComponent(doc)}`

const startSpike = (page: Page, revision: number) =>
  page.evaluate(initial => {
    window.__searchSpike = window.__startSearchSpike!(initial)
  }, revision)

const runSpike = (page: Page, request: { source: string; flags: string; text: string }) =>
  page.evaluate(async r => window.__searchSpike!.run(r.source, r.flags, r.text), request)

const caret = (page: Page) =>
  page.evaluate(() => window.__view.state.selection.main.head)

test("the spike helper only exists behind the opt-in param", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await expect(page.locator(".cm-content")).toBeVisible()
  expect(await page.evaluate(() => window.__startSearchSpike === undefined)).toBe(true)
  expect(await page.evaluate(() => window.__searchSpike === undefined)).toBe(true)
})

test("an invalid regex returns a structured error", async ({ page }) => {
  await page.goto(spikeUrl(DOC))
  await startSpike(page, 1)

  const response = await runSpike(page, { source: "(", flags: "", text: DOC })

  if (!("error" in response)) throw new Error(`expected a structured error, got ${JSON.stringify(response)}`)
  expect(response.error.length).toBeGreaterThan(0)
  expect(response.id).toBe(0)
  expect(response.revision).toBe(1)
  expect(await page.evaluate(() => window.__searchSpike!.accepted().length)).toBe(1)
})

test("an ordinary regex returns UTF-16 offsets, including surrogate pairs", async ({ page }) => {
  await page.goto(spikeUrl(DOC))
  await startSpike(page, 4)

  const literal = await runSpike(page, { source: "needle", flags: "", text: DOC })
  const emoji = await runSpike(page, { source: "😀", flags: "", text: DOC })
  const missing = await runSpike(page, { source: "zzz", flags: "", text: DOC })

  expect(literal).toEqual({ id: 0, revision: 4, match: { from: 3, to: 9 } })
  expect(emoji).toEqual({ id: 1, revision: 4, match: { from: 1, to: 3 } })
  expect(missing).toEqual({ id: 2, revision: 4, match: null })
  expect(DOC.slice(3, 9)).toBe("needle")
  expect(DOC.slice(1, 3)).toBe("😀")
})

test("a catastrophic regex stays off the main thread until terminate()", async ({ page }) => {
  await page.goto(spikeUrl(RESPONSIVE_DOC))
  await startSpike(page, 2)
  await page.evaluate(r => {
    void window.__searchSpike!.run(r.source, r.flags, r.text)
  }, CATASTROPHIC)

  const dispatchedAt = Date.now()
  await page.evaluate(() => window.__view.dispatch({ selection: { anchor: 7 } }))

  expect(await caret(page)).toBe(7)
  expect(Date.now() - dispatchedAt).toBeLessThan(2_000)
  expect(await page.evaluate(() => window.__searchSpike!.pending())).toBe(1)
  expect(await page.evaluate(() => window.__searchSpike!.accepted().length)).toBe(0)

  await page.evaluate(() => window.__searchSpike!.terminate())

  expect(await page.evaluate(() => window.__searchSpike!.terminated())).toBe(true)
  expect(await caret(page)).toBe(7)
})

test("a response carrying an old revision is ignored", async ({ page }) => {
  await page.goto(spikeUrl(DOC))
  await startSpike(page, 3)

  await page.evaluate(text => {
    const spike = window.__searchSpike!
    void spike.run("needle", "", text)
    spike.setRevision(5)
  }, DOC)

  await expect.poll(() => page.evaluate(() => window.__searchSpike!.discarded().length)).toBe(1)

  const discarded = await page.evaluate(() => window.__searchSpike!.discarded())
  expect(discarded[0]?.revision).toBe(3)
  expect(await page.evaluate(() => window.__searchSpike!.accepted().length)).toBe(0)
  expect(await page.evaluate(() => window.__searchSpike!.pending())).toBe(0)
})
