import { expect, test } from "@playwright/test"

// Editing state: click into the code body — the widget unmounts into native CM
// lines with the persistent chrome header and numbered container.
// Regression class: the chrome header was an inline replace and leaked a
// full-line strut band between header and first content line; blank content
// lines were half-height. Real layout only.
const DOC = [
  "Intro paragraph.",
  "",
  "```js",
  "const a = 1",
  "",
  "const b = 2",
  "```",
  "",
  "Outro paragraph.",
].join("\n")

test("clicking the code body enters the numbered editing state without a seam", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  const body = page.locator(".omd-code-body")
  await expect(body).toBeVisible()
  // Click a rendered row: the widget's click handler places the caret there.
  await body.locator(".line").first().click()

  const numbered = page.locator(".cm-line.omd-codeblock-num")
  await expect(numbered).toHaveCount(3) // "const a = 1", blank, "const b = 2"
  await expect(page.locator(".omd-code-header")).toBeVisible()

  // Seam: the chrome header must sit flush against the first content line.
  const gap = await page.evaluate(() => {
    const header = document.querySelector(".omd-code-header")!.getBoundingClientRect()
    const first = document.querySelector(".cm-line.omd-codeblock-num")!.getBoundingClientRect()
    return first.top - header.bottom
  })
  expect(Math.abs(gap)).toBeLessThan(1.5)

  // Blank content line keeps full height next to text lines.
  const heights = await numbered.evaluateAll(nodes => nodes.map(n => (n as HTMLElement).getBoundingClientRect().height))
  expect(heights.length).toBe(3)
  const ratio = heights[1] / ((heights[0] + heights[2]) / 2)
  expect(ratio).toBeGreaterThan(0.7)
  expect(ratio).toBeLessThan(1.4)
})

test("typing inside the editing state writes into the code block", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  const body = page.locator(".omd-code-body")
  await expect(body).toBeVisible()
  await body.locator(".line").first().click()
  await expect(page.locator(".cm-line.omd-codeblock-num").first()).toBeVisible()
  await page.keyboard.type("let z = 9\n")
  const text = await page.evaluate(() => window.__view.state.doc.toString())
  expect(text).toContain("let z = 9")
  // The caret line plus the new one: numbered rows grow, header stays.
  await expect(page.locator(".cm-line.omd-codeblock-num")).toHaveCount(4)
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})
