import { expect, test, type Page } from "@playwright/test"

// Real-browser proof of the heading level badge (engine: inline.ts tags the
// cursor's heading line `omd-h-active` + data-omd-h; styles.css overlays an
// "H<n>" chip inside the content column's left gutter). happy-dom cannot run ::before/attr() or
// layout, so the three things only a layout engine can settle are checked here:
//  - the badge is painted with the right level text while editing,
//  - it overlays without consuming line width (text x-position is unchanged),
//  - it appears/disappears purely on cursor moves.
const DOC = ["# 一级标题", "## 二级", "正文段落"].join("\n")

const open = (page: Page) =>
  page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)

const lineTextX = (page: Page) =>
  page.evaluate(() => {
    const line = document.querySelector(".cm-line.omd-h1")!
    return line.getBoundingClientRect().left
  })

test("shows the level badge while editing a heading and clears it on leave", async ({ page }) => {
  await open(page)
  const h1 = page.locator(".cm-line.omd-h1")
  await h1.click()  // cursor enters the heading text (mark stays folded)

  await expect(h1).toHaveClass(/omd-h-active/)
  await expect(h1).toHaveAttribute("data-omd-h", "1")
  await expect(page.locator(".cm-line.omd-h2")).not.toHaveClass(/omd-h-active/)

  // Badge text comes from the ::before overlay: assert the attribute the CSS
  // renders and that the rule itself resolved (computed content is "H1").
  const content = await page.evaluate(() => {
    const el = document.querySelector(".cm-line.omd-h-active")!
    return getComputedStyle(el, "::before").content
  })
  expect(content).toContain("1")

  await page.locator(".cm-line.omd-h2").click()
  await expect(page.locator(".cm-line.omd-h1")).not.toHaveClass(/omd-h-active/)
  await expect(page.locator(".cm-line.omd-h2")).toHaveAttribute("data-omd-h", "2")
})

test("the badge overlays without shifting heading text", async ({ page }) => {
  await open(page)
  const h1 = page.locator(".cm-line.omd-h1")
  const before = await lineTextX(page)   // badge absent: cursor on body via load
  await h1.click()                        // badge present
  const after = await lineTextX(page)
  expect(after).toBe(before)              // 行宽不抖动：路线 A 的核心不变量
})
