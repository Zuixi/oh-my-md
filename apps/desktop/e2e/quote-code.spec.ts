import { expect, test } from "@playwright/test"

// In-quote fenced code in a real browser. Two things can only be checked with a
// layout engine:
//  - the code widget keeps its own quote classes (the opening fence line's
//    `line:omd-blockquote-N` decoration is dropped by the block replace), and
//  - the quote bar survives `.omd-code` / `.omd-code-header`, which set an opaque
//    `background` shorthand that erases `background-image`.
const DOC = [
  "> Quoted paragraph before the block.",
  ">",
  "> ```js",
  "> const a = 1",
  "> const b = 2",
  "> ```",
  ">",
  "> Quoted paragraph after the block.",
].join("\n")

const backgroundImage = (selector: string) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? getComputedStyle(el).backgroundImage : null })()`

test("an in-quote code block renders highlighted, inside the quote bar", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)

  const code = page.locator(".omd-code")
  await expect(code).toBeVisible()
  await expect(code).toHaveClass(/omd-blockquote-1/)
  // Shiki renders async (debounce + lazy import).
  await expect(page.locator(".omd-code-lines .line").first().locator("span").first()).toBeVisible()
  await expect(page.locator(".omd-code-lines .line")).toHaveCount(2)

  // The quote bar is a gradient on background-image; the code container and its
  // header must both repaint it, otherwise the bar is visibly interrupted.
  for (const selector of [".omd-code", ".omd-code-header"]) {
    const image = await page.evaluate(backgroundImage(selector))
    expect(image, `${selector} lost the quote bar`).toContain("linear-gradient")
  }

  // And it stays visible: a gradient string can also mean a zero-size box.
  const barWidth = await page.evaluate(() => {
    const el = document.querySelector(".omd-code-header")!
    const style = getComputedStyle(el)
    // The bar is the first 3px of the padding box's background.
    return { height: el.getBoundingClientRect().height, paddingLeft: parseFloat(style.paddingLeft) }
  })
  expect(barWidth.height).toBeGreaterThan(10)
  expect(barWidth.paddingLeft).toBeGreaterThan(10)

  // The surrounding quote paragraphs still carry their own bar.
  const neighbours = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line.omd-blockquote-1")]
      .filter(el => !el.querySelector(".omd-code"))
    return lines.map(el => getComputedStyle(el).backgroundImage)
  })
  expect(neighbours.length).toBeGreaterThan(0)
  for (const image of neighbours) expect(image).toContain("linear-gradient")
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("clicking an in-quote code block keeps the chrome and the bar while editing", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  const body = page.locator(".omd-code-body")
  await expect(body).toBeVisible()
  await body.locator(".line").first().click()

  // Editing state: chrome header + numbered rows replacing the opening fence.
  const numbered = page.locator(".cm-line.omd-codeblock-num")
  await expect(numbered).toHaveCount(2)
  const header = page.locator(".omd-code-header")
  await expect(header).toBeVisible()
  await expect(header).toHaveClass(/omd-blockquote-1/)

  const image = await page.evaluate(backgroundImage(".omd-code-header"))
  expect(image).toContain("linear-gradient")

  // The quote indentation is part of the chrome's own padding, so the title must
  // not drift away from the code content below it (before the CSS fix it sat a
  // full indent to the left of it).
  const geometry = await page.evaluate(() => {
    const title = document.querySelector(".omd-code-title")!.getBoundingClientRect()
    const line = document.querySelector(".cm-line.omd-codeblock-num") as HTMLElement
    // 折叠掉的 `> ` 前缀在行首留下空的 widget 占位节点，量宽度必须取第一个有
    // 文字的节点（空节点的 rect 落在 0/行首，会把差值算成整屏）。
    const node = [...line.childNodes].find(n => (n.textContent ?? "").trim().length > 0) ?? line
    const text = document.createRange()
    text.selectNodeContents(node)
    return {
      titleLeft: title.left,
      lineLeft: line.getBoundingClientRect().left,
      textLeft: text.getBoundingClientRect().left,
      lineText: line.innerText,
    }
  })
  expect(geometry.textLeft).not.toBeNull()
  expect(Math.abs(geometry.textLeft! - geometry.titleLeft)).toBeLessThan(16)
  // And the entry point is the content, not the quote marker: a caret landing on
  // line.from sits inside the QuoteMark and unfolds the raw `> ` on that line.
  expect(geometry.lineText.startsWith(">")).toBe(false)

  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("Enter at the end of an in-quote fence line completes the block", async ({ page }) => {
  // The caret rests at the document end = the end of the opening fence line, which
  // is the line Typora/`continueFence` owns.
  const doc = ["> Quoted paragraph.", ">", "> ```js"].join("\n")
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}`)
  await page.keyboard.press("Enter")
  const text = await page.evaluate(() => window.__view.state.doc.toString())
  // Every fence line keeps the quote prefix, and the block is closed.
  const lines = text.split("\n")
  const fences = lines.filter(line => line.includes("```"))
  expect(fences.length).toBe(2)
  for (const fence of fences) expect(fence.startsWith("> ")).toBe(true)
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})
