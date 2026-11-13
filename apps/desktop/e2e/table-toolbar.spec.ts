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

test("floating toolbar stays hidden when a selection only ends at a rendered table", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await expect(page.locator(".omd-table tbody td").first()).toBeVisible()
  const tableTo = DOC.indexOf("\n\nafter")
  const bar = page.locator(".omd-table-toolbar-floating")
  // Selections whose head lands on the rendered table's edges: the widget has its own
  // toolbar, so the source-mode one must not float over the table's corner.
  for (const [anchor, head] of [[0, tableTo], [tableTo, 0], [DOC.length, 0]]) {
    await page.evaluate(([a, h]) => {
      const view = (window as any).__view
      view.dispatch({ selection: { anchor: a, head: h } })
      view.focus()
    }, [anchor, head])
    await page.waitForTimeout(100)
    await expect(bar).toBeHidden()
  }
})
