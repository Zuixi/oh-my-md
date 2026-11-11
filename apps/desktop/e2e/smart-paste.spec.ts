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

test("pasting GitHub issue #53 HTML and web math renders live KaTeX widgets without escaped fences", async ({ page }) => {
  await page.goto("/e2e/harness.html?doc=tail")
  await page.evaluate(() => window.__view.dispatch({ selection: { anchor: 0 } }))
  const html = [
    "<p>Problem. Display math written right after a text line does not render:</p>",
    "<p>The energy is:<br>$$<br>E = mc^2<br>$$<br>MathBlock has no endLeaf rule.</p>",
    "<p>Fix. MathBlock.endLeaf ends on <mjx-container class=\"MathJax\" data-latex=\", except when the paragraph already has an unclosed\"><mjx-math><mjx-mtext>,exceptwhentheparagraphalreadyhasanunclosed</mjx-mtext></mjx-math></mjx-container> or <span class=\"katex\"><span class=\"katex-mathml\"><math><semantics><annotation encoding=\"application/x-tex\">x_1 + y_1</annotation></semantics></math></span><span class=\"katex-html\">x1+y1</span></span>.</p>",
    "<p>```ts<br>const ok = true<br>```</p>",
    "<div>$$</div><div>\\int_0^1 x^2 dx</div><div>$$</div>",
  ].join("")
  await paste(page, html, "fallback")

  await expect.poll(() => page.evaluate(() => window.__docText())).toBe([
    "Problem. Display math written right after a text line does not render:",
    "",
    "The energy is:",
    "",
    "$$",
    "E = mc^2",
    "$$",
    "",
    "MathBlock has no endLeaf rule.",
    "",
    "Fix. MathBlock.endLeaf ends on $, except when the paragraph already has an unclosed$ or $x_1 + y_1$.",
    "",
    "```ts",
    "const ok = true",
    "```",
    "",
    "$$",
    "\\int_0^1 x^2 dx",
    "$$",
    "",
    "tail",
  ].join("\n"))

  // Move caret to position 0 so neither the MathBlock nor InlineMath nor FencedCode is active/focused
  await page.evaluate(() => window.__view.dispatch({ selection: { anchor: 0 } }))
  await expect(page.locator(".omd-math .katex-display")).toHaveCount(2)
  await expect(page.locator(".omd-inline-math .katex")).toHaveCount(2)
})

