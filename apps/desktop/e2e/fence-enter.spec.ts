import { expect, test } from "@playwright/test"

// The Typora creation flow: type ```cpp + Enter anywhere → land inside the
// rendered editing state immediately (chrome + numbers), never raw source.
test("```lang + Enter mid-document creates the rendered block in place", async ({ page }) => {
  const doc = "Intro paragraph.\n\nOutro paragraph.\n\n"
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}`)

  await page.keyboard.type("```cpp")
  await page.keyboard.press("Enter")

  // Editing state renders immediately: chrome header + one numbered empty row.
  await expect(page.locator(".omd-code-header")).toBeVisible()
  await expect(page.locator(".cm-line.omd-codeblock-num")).toHaveCount(1)
  // Raw fence text must be hidden by the chrome widget.
  expect(await page.evaluate(() => window.__view.dom.textContent)).not.toContain("```")

  await page.keyboard.type("int main() {")
  await page.keyboard.press("Enter")
  await page.keyboard.type("return 0;")
  // Smart Enter expands the auto-paired braces into opener / indented body / closer.
  await expect(page.locator(".cm-line.omd-codeblock-num")).toHaveCount(3)
  const text = await page.evaluate(() => window.__view.state.doc.toString())
  expect(text).toContain("```cpp\nint main() {\n  return 0;\n}\n```")
  // Fences wrap the code; existing paragraphs stay outside the block.
  const open = text.indexOf("```cpp")
  const close = text.lastIndexOf("```")
  // The caret sat at the document end, so the block grows after the outro;
  // every paragraph stays outside the fences, byte-identical.
  expect(text.indexOf("Intro paragraph.")).toBeLessThan(text.indexOf("Outro paragraph."))
  expect(text.indexOf("Outro paragraph.")).toBeLessThan(open)
  expect(open).toBeLessThan(text.indexOf("int main() {"))
  expect(text.indexOf("  return 0;")).toBeLessThan(close)
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("rendered math block popup has a visible caret, click-to-offset placement, and works inside a blockquote", async ({ page }) => {
  const doc = [
    "> $$",
    "> abcdefghij",
    "> $$",
    "",
    "Energy $x+y+z$ formula.",
    "",
    "Tail.",
  ].join("\n")
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}`)

  const mathBody = page.locator(".omd-math .omd-block-body")
  await expect(mathBody).toHaveAttribute("data-omd-render", "katex")

  // Click near the left-middle (30%) of the rendered KaTeX formula
  const box = await mathBody.boundingBox()
  expect(box).toBeTruthy()
  await page.mouse.click(box!.x + box!.width * 0.3, box!.y + box!.height * 0.5)

  const popup = page.locator(".omd-math-popup")
  await expect(popup).toBeVisible()

  // Native caret inside popup must NOT be transparent (tightSelection must not bleed into nested editors)
  const popupCaretColor = await page.locator(".omd-math-popup .cm-line").first().evaluate(
    el => getComputedStyle(el).caretColor,
  )
  expect(popupCaretColor).not.toBe("rgba(0, 0, 0, 0)")
  expect(popupCaretColor).not.toBe("transparent")

  // Clicking inside the popup editor keeps the popup open and moves the caret within the popup,
  // and the popup's .cm-content does NOT inherit the outer editor's 50vh bottom padding!
  const popupEditor = page.locator(".omd-math-popup .cm-content")
  const editorBox = await popupEditor.boundingBox()
  expect(editorBox).toBeTruthy()
  expect(editorBox!.height).toBeLessThan(60)
  await page.mouse.click(editorBox!.x + 12, editorBox!.y + editorBox!.height * 0.5)
  await expect(popup).toBeVisible()

  // Type inside the popup and verify live write-back to the quoted MathBlock
  await page.keyboard.type("K")
  const updatedDoc = await page.evaluate(() => window.__view.state.doc.toString())
  expect(updatedDoc).toMatch(/^> \$\$\n> [a-z]*K[a-z]*\n> \$\$/m)

  // Clicking an inline math widget unfolds it into source at the clicked offset
  const inlineMath = page.locator(".omd-inline-math")
  await expect(inlineMath).toBeVisible()
  const inlineBox = await inlineMath.boundingBox()
  expect(inlineBox).toBeTruthy()
  await page.mouse.click(inlineBox!.x + inlineBox!.width * 0.5, inlineBox!.y + inlineBox!.height * 0.5)
  await expect(inlineMath).toHaveCount(0)

  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

