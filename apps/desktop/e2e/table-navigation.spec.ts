import { expect, test } from "@playwright/test"

const ROWS = Array.from({ length: 5 }, (_, r) => `| a${r} | b${r} | c${r} |`).join("\n")
const DOC = ["| A | B | C |", "| --- | --- | --- |", ROWS, "", "after"].join("\n")

test("Tab walks every cell without touching the document", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.locator(".omd-table tbody td").first().click()
  const before = await page.evaluate(() => (window as any).__view.state.doc.toString())
  // 3 列表头 + 5×3 数据格 = 18 格；从首数据格走到末格需 14 次 Tab。
  // 第 15 次会触发"末格加行"，所以这里只走 14 次。
  for (let i = 0; i < 14; i++) await page.keyboard.press("Tab")
  const after = await page.evaluate(() => (window as any).__view.state.doc.toString())
  expect(after).toBe(before)
  // 源码态表格里不该出现任何输入元素：旧的 cell <input> 已删除（表格只有两个状态，见
  // docs/memory/gotchas-engine.md 的表格条目）。选择器刻意不写已删除的那个类名，
  // 免得把退役符号重新带进 grep 门槛。
  await expect(page.locator(".omd-table-src input")).toHaveCount(0)
})

test("Enter at the last row appends a row", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  const countRows = () => page.evaluate(() =>
    (window as any).__view.state.doc.toString().split("\n").filter((l: string) => l.startsWith("|")).length)
  const before = await countRows()
  await page.locator(".omd-table tbody tr").last().locator("td").first().click()
  await page.keyboard.press("Enter")
  expect(await countRows()).toBe(before + 1)
})

test("Mod-Enter leaves the table", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.locator(".omd-table tbody td").first().click()
  await page.keyboard.press("ControlOrMeta+Enter")
  const line = await page.evaluate(() => {
    const view = (window as any).__view
    return view.state.doc.lineAt(view.state.selection.main.head).text
  })
  expect(line).toBe("")
})
