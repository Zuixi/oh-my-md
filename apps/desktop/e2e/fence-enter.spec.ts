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
  await page.keyboard.type("  return 0;")
  // Two content lines now; the trailing closing fence stays collapsed.
  await expect(page.locator(".cm-line.omd-codeblock-num")).toHaveCount(2)
  const text = await page.evaluate(() => window.__view.state.doc.toString())
  expect(text).toContain("int main() {")
  expect(text).toContain("  return 0;")
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
