import { expect, test } from "@playwright/test"

// Real-browser regressions for the two reported Enter/caret problems:
//  1. clicking the new quoted line put the caret inside the folded `> ` (offset 0),
//     so typing landed *before* the marker and pushed it right (`abc> `);
//  2. Enter inside a code block left the caret on the previous line / lost the code
//     indentation, so the new line was neither at the line start nor aligned.
const state = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const sel = window.__view.state.selection.main
    const line = window.__view.state.doc.lineAt(sel.head)
    return { doc: window.__view.state.doc.toString(), head: sel.head, offset: sel.head - line.from }
  })

test("typing on a clicked quoted line stays inside the quote", async ({ page }) => {
  const doc = "> 引用第一行\n> "
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}`)

  // Click the left edge of the quoted empty line: the resolved position is line.from,
  // which sits inside the folded `> ` — the clamp must move it to the content start.
  const line = page.locator(".cm-line").nth(1)
  const box = (await line.boundingBox())!
  await page.mouse.click(box.x + 4, box.y + box.height / 2)
  await page.keyboard.type("abc")

  const after = await state(page)
  expect(after.doc).toBe("> 引用第一行\n> abc")
  expect(after.doc).not.toContain("abc>")
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("Enter on a prefix-only quoted line exits one level instead of leaving a bare marker", async ({ page }) => {
  const doc = "> 引用第一行\n> "
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}`)
  await page.keyboard.press("End")
  await page.keyboard.press("Enter")

  // Engine semantics (upstream insertNewlineContinueMarkup would leave ">\n> ").
  const after = await state(page)
  expect(after.doc).toBe("> 引用第一行\n")
  expect(after.offset).toBe(0)

  await page.keyboard.type("正文")
  expect((await state(page)).doc).toBe("> 引用第一行\n正文")
})

test("Enter inside a quoted code block keeps the prefix and the code indentation aligned", async ({ page }) => {
  // 两个前置条件（都是 harness 特性，不是被测行为）：
  // 1. 末尾留正文 → harness 的光标在文末；停在闭围栏 node.to 上会命中 blockSelected
  //    （含端）直接进编辑态，就点不到渲染态的 .omd-code-body；
  // 2. 前面先放一个引用段落 → 文档**首个块**就是“引用里的围栏”时，异步 Shiki 渲染
  //    不会落地（既有缺陷，main 上同样复现，见本次会话记录的 finding），
  //    本用例只验证 Enter 行为，不踩它。
  const doc = "> 引用段落\n>\n> ```js\n>   const a = 1\n> ```\n\noutro"
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}`)
  await page.locator(".omd-code-body .line").first().click()
  await expect(page.locator(".cm-line.omd-codeblock-num").first()).toBeVisible()
  await page.keyboard.press("End")
  await page.keyboard.press("Enter")

  const after = await state(page)
  expect(after.doc).toBe("> 引用段落\n>\n> ```js\n>   const a = 1\n>   \n> ```\n\noutro")

  // The caret must land on the new line, at the same visual left edge as the code above.
  const geometry = await page.evaluate(() => {
    const caret = window.__view.coordsAtPos(window.__view.state.selection.main.head)
    const lines = [...document.querySelectorAll(".cm-line.omd-codeblock-num")] as HTMLElement[]
    const first = lines[0]
    const node = [...first.childNodes].find(n => (n.textContent ?? "").trim().length > 0) ?? first
    const range = document.createRange()
    range.selectNodeContents(node)
    return { caretX: caret?.left ?? null, firstTextX: range.getBoundingClientRect().left }
  })
  expect(geometry.caretX).not.toBeNull()
  expect(Math.abs(geometry.caretX! - geometry.firstTextX)).toBeLessThan(2)
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("Enter after an opening bracket indents, and Tab / Shift-Tab adjust the code line", async ({ page }) => {
  const doc = "```js\nfunction f() {\n```\n\noutro"
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}`)
  await page.locator(".omd-code-body .line").first().click()
  await expect(page.locator(".cm-line.omd-codeblock-num").first()).toBeVisible()
  await page.keyboard.press("End")
  await page.keyboard.press("Enter")

  const indented = await state(page)
  expect(indented.doc).toBe("```js\nfunction f() {\n  \n```\n\noutro")
  expect(indented.offset).toBe(2)

  await page.keyboard.type("return 1")
  await page.keyboard.press("Shift+Tab")
  expect((await state(page)).doc).toBe("```js\nfunction f() {\nreturn 1\n```\n\noutro")

  await page.keyboard.press("Tab")
  expect((await state(page)).doc).toBe("```js\nfunction f() {\n  return 1\n```\n\noutro")
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})
