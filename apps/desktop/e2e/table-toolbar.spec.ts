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

test("floating toolbar hides when a selection covering a revealed table renders it again", async ({ page }) => {
  // Text on both sides, so both covering selections are anchored outside the table, with
  // the head on the table's edge (where the old check still found "the revealed table").
  const doc = `before\n\n${DOC}`
  const tableFrom = doc.indexOf("| A")
  const tableTo = doc.indexOf("\n\nafter")
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}`)
  const bar = page.locator(".omd-table-toolbar-floating")
  for (const [anchor, head] of [[doc.length, tableFrom], [0, tableTo]]) {
    await page.locator(".omd-table .omd-block-edit").click()
    await expect(bar).toBeVisible()
    // Still meets the table, so the reveal is kept, but covers it whole: the widget is back.
    await page.evaluate(([a, h]) => {
      const view = (window as any).__view
      view.dispatch({ selection: { anchor: a, head: h } })
      view.focus()
    }, [anchor, head])
    await expect(page.locator(".omd-table")).toBeVisible()
    await expect(bar).toBeHidden()
    // Leave the table so the next round reveals it from scratch.
    await page.evaluate(() => {
      const view = (window as any).__view
      view.dispatch({ selection: { anchor: view.state.doc.length } })
    })
  }
})

test("global Source mode keeps the floating toolbar for a table under the caret or head", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.evaluate(() => (window as any).__setLivePreview(false))
  await expect(page.locator(".omd-table")).toHaveCount(0)
  const bar = page.locator(".omd-table-toolbar-floating")
  // No widget in Source mode: the toolbar serves the table at the head, whatever covers it.
  for (const [anchor, head] of [[2, 2], [DOC.length, 0]]) {
    await page.evaluate(([a, h]) => {
      const view = (window as any).__view
      view.dispatch({ selection: { anchor: a, head: h } })
      view.focus()
    }, [anchor, head])
    await expect(bar).toBeVisible()
  }
})
