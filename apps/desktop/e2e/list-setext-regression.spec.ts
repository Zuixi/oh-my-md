import { expect, test } from "@playwright/test"

test("typing paragraph + Enter + '- ' keeps caret on the bullet line without promoting paragraph to H2", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent("")}`)
  const content = page.locator(".cm-content")
  await content.click()

  await page.keyboard.type("dasfdas")
  await page.keyboard.press("Enter")
  await page.keyboard.type("-")

  await expect(page.locator(".cm-line.omd-h2")).toHaveCount(0)

  await page.keyboard.type(" ")
  await expect(page.locator(".cm-line.omd-h2")).toHaveCount(0)
  await expect(page.locator(".cm-line.omd-li")).toHaveCount(1)

  await page.keyboard.type("ok")
  const text = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-content .cm-line")]
    return lines.map(el => el.textContent ?? "")
  })
  expect(text[0]).toBe("dasfdas")
  expect(text[1]).toContain("ok")
})

test("backspacing through a list directly under a paragraph exits cleanly without creating a Setext H2", async ({ page }) => {
  const doc = "### Dashcam_NVP thread\n\nnvp的启动时机：\n- fdas\n- "
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}`)

  const lastLine = page.locator(".cm-content .cm-line").last()
  await lastLine.click()

  // Delete `- ` (1 Backspace), join newline (1), delete `s`, `a`, `d`, `f` (4), then exit `- ` (1) = 7 Backspaces.
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press("Backspace")
    await expect(page.locator(".cm-line.omd-h2")).toHaveCount(0)
  }

  await expect(page.locator(".cm-line.omd-li")).toHaveCount(0)
  const lines = await page.locator(".cm-content .cm-line").allTextContents()
  expect(lines).toContain("nvp的启动时机：")
})
