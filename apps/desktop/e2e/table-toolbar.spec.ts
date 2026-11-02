import { expect, test } from "@playwright/test"

const DOC = ["| A | B |", "| --- | --- |", "| a | b |", "", "after"].join("\n")

test("floating toolbar edits the focused table", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.locator(".omd-table tbody td").first().click()
  await expect(page.locator(".omd-table-toolbar-floating")).toBeHidden()
  await expect(page.locator(".omd-table-toolbar")).toBeVisible()
  await page.locator(".omd-table .omd-block-edit").click()
  const bar = page.locator(".omd-table-toolbar-floating")
  await expect(bar).toBeVisible()
  await bar.locator("[data-act='insert-row']").click()
  const rows = await page.evaluate(() =>
    (window as any).__view.state.doc.toString().split("\n").filter((l: string) => l.startsWith("|")).length)
  expect(rows).toBe(4)
})

test("floating toolbar hides once the caret leaves the table", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.locator(".omd-table .omd-block-edit").click()
  const bar = page.locator(".omd-table-toolbar-floating")
  await expect(bar).toBeVisible()
  await page.evaluate(() => {
    const view = (window as any).__view
    view.dispatch({ selection: { anchor: view.state.doc.length } })
  })
  await expect(bar).toBeHidden()
})
