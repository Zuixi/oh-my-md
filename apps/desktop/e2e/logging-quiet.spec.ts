import { expect, test } from "@playwright/test"

// The real CodeMirror host must stay outside the logging path. Install a live
// facade with an observable transport so a zero count cannot pass vacuously.
test("typing, selection and scrolling generate no log traffic", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent("# Heading\n\nbody\n".repeat(60))}`)
  await page.evaluate(async () => {
    const { createLogger, setGlobalLogger } = await import("/src/logger.ts")
    const batches: unknown[][] = []
    const logger = createLogger({ now: () => performance.now(), mirrorToConsole: false,
      send: async records => { batches.push(records) } })
    setGlobalLogger(logger)
    logger.info("probe", "transport works")
    await logger.flush()
    if (batches.length !== 1) throw new Error("logging transport was not observed")
    batches.length = 0
    Object.assign(window, { logBatches: batches })
  })
  const content = page.locator(".cm-content").first()
  await content.press("End")
  await page.keyboard.insertText("typing still works")
  await page.keyboard.press("ArrowLeft")
  await page.keyboard.press("Shift+ArrowLeft")
  await page.mouse.wheel(0, -300)
  const result = await page.evaluate(async () => {
    const { getGlobalLogger } = await import("/src/logger.ts")
    await getGlobalLogger().flush()
    return {
      text: window.__view.state.doc.toString(),
      batches: Reflect.get(window, "logBatches") as unknown[][],
    }
  })
  expect(result.text).toContain("typing still works")
  expect(result.batches).toEqual([])
})
