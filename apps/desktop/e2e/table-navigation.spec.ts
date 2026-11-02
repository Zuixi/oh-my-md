import { expect, test, type Page } from "@playwright/test"

const ROWS = Array.from({ length: 5 }, (_, r) => `| a${r} | b${r} | c${r} |`).join("\n")
const DOC = ["| A | B | C |", "| --- | --- | --- |", ROWS, "", "after"].join("\n")
const TABLE_LINES = DOC.split("\n").filter(line => line.startsWith("|")).length

const docText = (page: Page) =>
  page.evaluate(() => (window as any).__view.state.doc.toString())
const caretHead = (page: Page) =>
  page.evaluate(() => (window as any).__view.state.selection.main.head as number)

async function revealTableSource(page: Page) {
  await page.locator(".omd-table .omd-block-edit").click()
  await expect(page.locator(".omd-table-src")).toHaveCount(TABLE_LINES)
}

test("Tab walks every cell without touching the document", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.locator(".omd-table tbody td").first().click()
  await expect(page.locator(".omd-table table")).toBeVisible()
  await expect(page.locator(".omd-table-src")).toHaveCount(0)
  await expect(page.locator(".omd-table-caret").first()).toBeVisible()
  const before = await docText(page)
  for (let i = 0; i < 14; i++) await page.keyboard.press("Tab")
  expect(await docText(page)).toBe(before)
  const lastCell = page.locator(".omd-table tbody tr").last().locator("td").last()
  await expect(lastCell.locator(".omd-table-caret")).toBeVisible()
})

test("typing inside a rendered cell edits the document and undo restores it byte-identically", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.locator(".omd-table tbody tr").first().locator("td").nth(1).click()
  await expect(page.locator(".omd-table table")).toBeVisible()
  await expect(page.locator(".omd-table-src")).toHaveCount(0)
  const before = await docText(page)

  await page.keyboard.type("X")
  const typed = await docText(page)
  const lineOf = (text: string) => text.split("\n").find(line => line.includes("b0"))
  expect(lineOf(typed)).toBe("| a0 | Xb0 | c0 |")

  await page.keyboard.press("ControlOrMeta+Z")
  expect(await docText(page)).toBe(before)
})

test("End reaches the table end boundary, where Tab still belongs to the table", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await revealTableSource(page)
  const before = await docText(page)
  const tableEnd = DOC.indexOf("| a4 | b4 | c4 |") + "| a4 | b4 | c4 |".length

  await page.evaluate((pos) => {
    const view = (window as any).__view
    view.dispatch({ selection: { anchor: pos } })
  }, tableEnd)

  await page.keyboard.press("End")
  expect(await caretHead(page)).toBe(tableEnd)

  await page.keyboard.press("Tab")
  const after = await docText(page)
  const tableRows = (text: string) => text.split("\n").filter(line => line.startsWith("|")).length
  expect(tableRows(after)).toBe(tableRows(before) + 1)
  expect(after).not.toContain("\t")
  expect(after.startsWith(before.slice(0, tableEnd))).toBe(true)
  expect(after.endsWith(before.slice(tableEnd))).toBe(true)
  await expect(page.locator(".omd-table-src")).toHaveCount(TABLE_LINES + 1)
  expect(await caretHead(page)).toBeGreaterThan(tableEnd)
})

test("Enter at the last row exits to the blank paragraph", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await revealTableSource(page)
  const lastRowStart = DOC.indexOf("| a4 | b4 | c4 |") + 2
  await page.evaluate((pos) => {
    const view = (window as any).__view
    view.dispatch({ selection: { anchor: pos } })
  }, lastRowStart)

  await page.keyboard.press("Enter")
  expect(await docText(page)).toBe(DOC)
  const caret = await page.evaluate(() => {
    const view = (window as any).__view
    return { line: view.state.doc.lineAt(view.state.selection.main.head).number,
      text: view.state.doc.lineAt(view.state.selection.main.head).text }
  })
  expect(caret).toEqual({ line: TABLE_LINES + 1, text: "" })

  await page.keyboard.press("Enter")
  await page.keyboard.type("outside")
  const after = await docText(page)
  expect(after).toBe(DOC.replace("\n\nafter", "\n\noutside\nafter"))
  expect(after.split("\n").filter(line => line.startsWith("|"))).toHaveLength(TABLE_LINES)
})

test("Mod-Enter leaves the table", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await revealTableSource(page)
  const cellStart = DOC.indexOf("| a0 |")
  await page.evaluate((pos) => {
    const view = (window as any).__view
    view.dispatch({ selection: { anchor: pos } })
  }, cellStart + 2)
  await page.keyboard.press("ControlOrMeta+Enter")
  const line = await page.evaluate(() => {
    const view = (window as any).__view
    return view.state.doc.lineAt(view.state.selection.main.head).text
  })
  expect(line).toBe("")
})
