import { expect, test } from "@playwright/test"

// 源码态浮层工具栏：聚焦表格时整表以源码网格呈现，渲染态工具栏（住在块 widget 里）
// 不可达 —— 浮层必须在光标进入表格时出现，并且只改源码（不重写用户文本）。
const DOC = ["| A | B |", "| --- | --- |", "| a | b |", "", "after"].join("\n")

test("floating toolbar edits the focused table", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.locator(".omd-table tbody td").first().click()
  const bar = page.locator(".omd-table-toolbar-floating")
  await expect(bar).toBeVisible()
  await bar.locator("[data-act='insert-row']").click()
  const rows = await page.evaluate(() =>
    (window as any).__view.state.doc.toString().split("\n").filter((l: string) => l.startsWith("|")).length)
  expect(rows).toBe(4) // 表头 + 分隔行 + 2 数据行
})

test("floating toolbar hides once the caret leaves the table", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.locator(".omd-table tbody td").first().click()
  const bar = page.locator(".omd-table-toolbar-floating")
  await expect(bar).toBeVisible()
  // 把光标放回表格之后的段落：没有表格上下文，浮层必须收起。
  await page.evaluate(() => {
    const view = (window as any).__view
    view.dispatch({ selection: { anchor: view.state.doc.length } })
  })
  await expect(bar).toBeHidden()
})
