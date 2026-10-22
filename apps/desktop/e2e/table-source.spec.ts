import { expect, test } from "@playwright/test"

// Click hit-testing on a rendered table: a click that lands on a cell is an intent
// to edit that cell, so it must flip the widget into the source grid with the caret
// in the clicked cell — while a click on the widget's padding/border/toolbar gap is
// an accident and must do nothing at all (no source flip, no caret jump).
const DOC = ["Intro.", "", "| A | B |", "| --- | --- |", "| a | b |", "", "Outro."].join("\n")

test("clicking a cell enters source at that cell; clicking padding does nothing", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await expect(page.locator(".omd-table")).toBeVisible()

  // 点 padding（.omd-table 的 0.8em 上边距）不翻转
  await page.locator(".omd-table").click({ position: { x: 4, y: 2 } })
  await expect(page.locator(".omd-table")).toBeVisible()
  await expect(page.locator(".omd-table-src")).toHaveCount(0)

  // 点第 2 行第 2 格 → 进源码；进源码不该打开任何内联输入框（编辑区里没有任何 input）
  await page.locator(".omd-table tbody tr").first().locator("td").nth(1).click()
  await expect(page.locator(".omd-table-src")).toHaveCount(3)
  await expect(page.locator(".editor-host input")).toHaveCount(0)

  // 光标必须停在**被点的那一格**（`b`），不是"表格里随便哪个位置"。
  const head = await page.evaluate(() => (window as any).__view.state.selection.main.head)
  expect(head).toBe(DOC.indexOf("| a | b |") + 6)
})
