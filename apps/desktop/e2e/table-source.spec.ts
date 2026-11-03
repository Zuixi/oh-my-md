import { expect, test } from "@playwright/test"

// Click hit-testing on a rendered table: a click that lands on a cell is an intent
// to edit that cell, so it must flip the widget into the source grid with the caret
// in the clicked cell — while a click on the widget's padding/border/toolbar gap is
// an accident and must do nothing at all (no source flip, no caret jump).
const DOC = ["Intro.", "", "| A | B |", "| --- | --- |", "| a | b |", "", "Outro."].join("\n")
const docText = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as any).__view.state.doc.toString())

test("clicking a cell opens the in-cell session at that cell; clicking padding does nothing", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await expect(page.locator(".omd-table")).toBeVisible()

  // 点 padding（.omd-table 的 0.8em 上边距）不打开会话也不翻源码
  await page.locator(".omd-table").click({ position: { x: 4, y: 2 } })
  await expect(page.locator(".omd-table")).toBeVisible()
  await expect(page.locator(".omd-table-src")).toHaveCount(0)
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(0)

  // 点第 2 行第 2 格 → 格内会话（IME 锚 input + 投影）；不翻源码
  await page.locator(".omd-table tbody tr").first().locator("td").nth(1).click()
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(1)
  await expect(page.locator(".omd-table-cell-view")).toHaveCount(1)
  await expect(page.locator(".omd-table-src")).toHaveCount(0)
  expect(await docText(page)).toBe(DOC)

  // 会话先关闭（Escape）。外层选区落进表格时 follower 不再翻源码，而是钳到
  // 表首并重开被点格的会话，落点偏移随会话传递（脚注回跳/goto-line 回原位）。
  await page.keyboard.press("Escape")
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(0)
  const cellHead = DOC.indexOf("| a | b |") + 6
  await page.evaluate(head => {
    ;(window as any).__view.dispatch({ selection: { anchor: head } } )
  }, cellHead)
  // 外层光标被钳到 table.from，会话重开在被点的那一格（b）
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(1)
  await expect(page.locator(".omd-table-cell-input")).toHaveValue("b")
  const head = await page.evaluate(() => (window as any).__view.state.selection.main.head)
  expect(head).toBe(DOC.indexOf("| A | B |"))
  // 源码网格从不出现：直接编辑模式下表格只有两个状态（渲染投影 / 格内会话）；
  // 会话的 IME 锚 input 不在编辑区宿主上，而在格内。
  await expect(page.locator(".omd-table-src")).toHaveCount(0)
  await expect(page.locator(".editor-host > input")).toHaveCount(0)
  await expect(page.locator(".omd-table-cell-input")).toBeAttached()
})
