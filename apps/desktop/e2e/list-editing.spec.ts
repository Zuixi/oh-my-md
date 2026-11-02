import { expect, test, type Page } from "@playwright/test"

function editorState(page: Page) {
  return page.evaluate(() => {
    const view = window.__view
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    return {
      doc: view.state.doc.toString(),
      line: line.number,
      offset: head - line.from,
    }
  })
}

test("Backspace on a fresh ordered item exits the list before typing a bullet", async ({ page }) => {
  await page.goto("/e2e/harness.html")
  await page.keyboard.type("1. hello 1")
  await page.keyboard.press("Enter")

  expect(await editorState(page)).toEqual({
    doc: "1. hello 1\n2. ",
    line: 2,
    offset: 3,
  })

  await page.keyboard.press("Backspace")
  expect(await editorState(page)).toEqual({
    doc: "1. hello 1\n",
    line: 2,
    offset: 0,
  })

  await page.keyboard.type("- 12")
  expect(await editorState(page)).toEqual({
    doc: "1. hello 1\n- 12",
    line: 2,
    offset: 4,
  })
  await expect(page.locator(".cm-line").nth(1)).toHaveCSS("--omd-list-depth", "1")
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("Tab nests a bullet under an immediately preceding ordered item", async ({ page }) => {
  const doc = "1. hello 1\n- fda"
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}`)
  await page.keyboard.press("Tab")

  expect(await editorState(page)).toEqual({
    doc: "1. hello 1\n   - fda",
    line: 2,
    offset: 8,
  })
  await expect(page.locator(".cm-line").nth(1)).toHaveCSS("--omd-list-depth", "2")
  await expect(page.locator(".cm-content")).toBeFocused()
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("Tab makes an ordered item the first child of its preceding ordered item", async ({ page }) => {
  const doc = "1. fda\n2. f"
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}`)
  await page.keyboard.press("Tab")

  expect(await editorState(page)).toEqual({
    doc: "1. fda\n   1. f",
    line: 2,
    offset: 7,
  })
  await expect(page.locator(".cm-line").nth(1)).toHaveCSS("--omd-list-depth", "2")
  await expect(page.locator(".cm-content")).toBeFocused()
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("Tab on a list item without a previous item keeps editor focus", async ({ page }) => {
  const doc = "- only"
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}`)
  await page.keyboard.press("Tab")

  expect(await editorState(page)).toEqual({
    doc,
    line: 1,
    offset: doc.length,
  })
  await expect(page.locator(".cm-content")).toBeFocused()
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})
