import { expect, test, type Page } from "@playwright/test"

async function paste(page: Page, html: string, text: string): Promise<void> {
  await page.evaluate(({ html, text }) => {
    const data = new DataTransfer()
    data.setData("text/html", html)
    data.setData("text/plain", text)
    window.__view.contentDOM.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }))
  }, { html, text })
}

const COMPLEX_HTML = [
  "<table>",
  "<thead><tr><th scope='col' colspan='2' align='center'>Summary</th></tr></thead>",
  "<tbody>",
  "<tr><td rowspan='2'>Group</td><td><strong>Row 1</strong><br><a href='https://example.com'>Link</a></td></tr>",
  "<tr><td>Row 2</td></tr>",
  "</tbody>",
  "</table>",
].join("")

test("pasting a rowspan/colspan HTML table renders ComplexTableWidget, toggles source on click, and undoes in one step", async ({ page }) => {
  const initialDoc = "Before\n\n\n\nAfter"
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(initialDoc)}`)
  await page.evaluate(() => window.__view.dispatch({ selection: { anchor: 8 } }))

  await paste(page, COMPLEX_HTML, "Summary\nGroup\tRow 1 Link\nRow 2")

  // Move cursor to "After" so the pasted HTMLBlock is not selected and mounts ComplexTableWidget
  await page.evaluate(() => window.__view.dispatch({ selection: { anchor: window.__docText().length } }))

  const widget = page.locator(".omd-complex-table")
  await expect(widget).toBeVisible()
  await expect(widget.locator(".omd-table-toolbar")).toHaveCount(0)
  await expect(widget.locator("thead th")).toHaveAttribute("colspan", "2")
  await expect(widget.locator("tbody tr").first().locator("td").first()).toHaveAttribute("rowspan", "2")

  // Verify real-browser span geometry: the colspan=2 header spans at least the width of a body cell
  const boxes = await page.evaluate(() => {
    const th = document.querySelector<HTMLElement>(".omd-complex-table thead th")!
    const tdSpan = document.querySelector<HTMLElement>(".omd-complex-table tbody tr:first-child td:first-child")!
    const tdRow1 = document.querySelector<HTMLElement>(".omd-complex-table tbody tr:first-child td:nth-child(2)")!
    const tdRow2 = document.querySelector<HTMLElement>(".omd-complex-table tbody tr:nth-child(2) td:first-child")!
    return {
      thWidth: th.getBoundingClientRect().width,
      row1Width: tdSpan.getBoundingClientRect().width + tdRow1.getBoundingClientRect().width,
      spanHeight: tdSpan.getBoundingClientRect().height,
      row2Height: tdRow2.getBoundingClientRect().height,
    }
  })
  expect(boxes.thWidth).toBeGreaterThanOrEqual(boxes.row1Width - 4)
  expect(boxes.spanHeight).toBeGreaterThan(boxes.row2Height)

  // Clicking a cell reveals the raw HTMLBlock source
  await widget.locator("tbody td").first().click()
  await expect(page.locator(".omd-complex-table")).toHaveCount(0)
  await expect(page.locator(".omd-table-src").first()).toBeVisible()

  // Moving the cursor back out re-mounts the widget
  await page.evaluate(() => window.__view.dispatch({ selection: { anchor: window.__docText().length } }))
  await expect(widget).toBeVisible()

  // Single undo restores the document before the paste
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z")
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe(initialDoc)
})
