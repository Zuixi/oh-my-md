import { expect, test } from "@playwright/test"

test("repeated Ctrl+B toggles bold once per press in a real browser", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent("hello world")}`)

  const editor = page.locator(".cm-content")
  await expect(editor).toBeFocused()
  await page.evaluate(() => {
    window.__view.dispatch({ selection: { anchor: window.__view.state.doc.length } })
    window.__view.focus()
  })

  await page.keyboard.press("Control+b")
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe("hello **world**")
  await expect(page.locator(".omd-strong")).toHaveText("world")
  await expect
    .poll(() => page.evaluate(() => window.__view.state.selection.main.head))
    .toBe("hello **world**".length - 2)

  await page.keyboard.press("Control+b")
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe("hello world")
  await expect(page.locator(".omd-strong")).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => window.__view.state.selection.main.head))
    .toBe("hello world".length)
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("bold and italic stack as separate dimensions in a real browser", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent("text")}`)

  const editor = page.locator(".cm-content")
  await expect(editor).toBeFocused()
  await page.evaluate(() => {
    window.__view.dispatch({ selection: { anchor: 2 } })
    window.__view.focus()
  })

  await page.keyboard.press("Control+b")
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe("**text**")
  await expect(page.locator(".omd-strong")).toHaveText("text")

  await page.keyboard.press("Control+i")
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe("***text***")
  await expect(page.locator(".omd-strong")).toHaveText("text")
  await expect(page.locator(".omd-em")).toHaveText("text")

  await page.keyboard.press("Control+b")
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe("*text*")
  await expect(page.locator(".omd-strong")).toHaveCount(0)
  await expect(page.locator(".omd-em")).toHaveText("text")

  await page.keyboard.press("Control+i")
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe("text")
  await expect(page.locator(".omd-strong")).toHaveCount(0)
  await expect(page.locator(".omd-em")).toHaveCount(0)
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("Ctrl+U and Ctrl+backquote compose with bold in a real browser", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent("text")}`)

  const editor = page.locator(".cm-content")
  await expect(editor).toBeFocused()
  await page.evaluate(() => {
    window.__view.dispatch({ selection: { anchor: 0, head: 4 } })
    window.__view.focus()
  })

  await page.keyboard.press("Control+u")
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe("<u>text</u>")
  await expect(page.locator(".omd-u")).toHaveText("text")

  await page.keyboard.press("Control+u")
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe("text")
  await expect(page.locator(".omd-u")).toHaveCount(0)

  await page.keyboard.press("Control+`")
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe("`text`")
  await expect(page.locator(".omd-inline-code")).toHaveText("text")

  await page.keyboard.press("Control+b")
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe("**`text`**")
  await expect(page.locator(".omd-strong")).toHaveCount(1)
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("bold nests inside underline in a real browser", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent("皆源于真")}`)

  const editor = page.locator(".cm-content")
  await expect(editor).toBeFocused()
  await page.evaluate(() => {
    window.__view.dispatch({ selection: { anchor: 0, head: 4 } })
    window.__view.focus()
  })

  await page.keyboard.press("Control+u")
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe("<u>皆源于真</u>")

  await page.keyboard.press("Control+b")
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe("<u>**皆源于真**</u>")
  await expect(page.locator(".omd-u .omd-strong")).toHaveText("皆源于真")

  await page.keyboard.press("Control+b")
  await expect.poll(() => page.evaluate(() => window.__docText())).toBe("<u>皆源于真</u>")
  await expect(page.locator(".omd-u .omd-strong")).toHaveCount(0)
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})
