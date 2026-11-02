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

test("semantic HTML paste is one undoable editor transaction", async ({ page }) => {
  await page.goto("/e2e/harness.html?doc=tail")
  await page.evaluate(() => window.__view.dispatch({ selection: { anchor: 0 } }))
  await paste(
    page,
    "<h2>Title</h2><ul><li><strong>bold</strong></li></ul><p><a href='https://example.com'>link</a> <code>a|b</code></p>",
    "Title\nbold\nlink a|b",
  )
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe(
    "## Title\n\n- **bold**\n\n[link](https://example.com) `a|b`\n\ntail",
  )
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z")
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe("tail")
})

test("verbatim paste keeps exact plain text", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent("```\n\n```")}`)
  await page.evaluate(() => window.__view.dispatch({ selection: { anchor: 4 } }))
  await paste(page, "<strong># title</strong>", "# title")
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe("```\n# title\n```")
})

test("pasted HTML never executes script", async ({ page }) => {
  await page.goto("/e2e/harness.html")
  await paste(page, "<img src=x onerror='window.__pasteXss=1'><script>window.__pasteXss=1</script><b>safe</b>", "safe")
  await expect.poll(() => page.evaluate(() => window.__docText())).toContain("**safe**")
  expect(await page.evaluate(() => (window as Window & { __pasteXss?: number }).__pasteXss)).toBeUndefined()
})
