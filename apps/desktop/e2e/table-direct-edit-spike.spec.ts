import { expect, test, type Locator, type Page } from "@playwright/test"
import type { EditorView } from "@codemirror/view"

type HarnessWindow = Window & {
  __view: EditorView
  __docText: () => string
  __docChangeCount: number
}

declare const window: HarnessWindow

const CANONICAL = "| A | B |\n| --- | --- |\n| 1 | 2 |\n\ntail"
const INTRO = "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\ntail"
const NONCANONICAL = "A|  B\n:-----|---:\nC | D\n\ntail"
const NONCANONICAL_EDITED = "| XA | B |\n| :--- | ---: |\n| C | D |\n\ntail"
const TWO_TABLES = "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nmiddle\n\n| C | D |\n| --- | --- |\n| 3 | 4 |\n\ntail"
const ORDERED_TABLE = "1. first\n\n   | A | B |\n   | --- | --- |\n   | 1 | 2 |\n\n7. second"
const REPORTED = "## Tables and Tasks\n\n| Layer | Role |\n| --- | --- |\n| Engine | Markdown parsing, decorations, widgets |\n| Desktop | React shell, styes, shortcuts, IPC |\n| Tauri | Filesystem, nativemenus, packaging |\n\nShip checklist:\n\n- [x] Live Preview with folded inline code\n- [x] File tree, outline, and folder search\n- [x] KaTeX, Mermaid, and fenced code blocks\n- [ ] Your next feature here—keep typing"

const url = (doc: string) => `/e2e/harness.html?doc=${encodeURIComponent(doc)}`
const editUrl = (doc: string) => `/e2e/harness.html?tableDirectEdit=1&doc=${encodeURIComponent(doc)}`

const docText = (page: Page) =>
  page.evaluate(() => window.__docText())
const docChangeCount = (page: Page) =>
  page.evaluate(() => window.__docChangeCount)
const caretHead = (page: Page) =>
  page.evaluate(() => window.__view.state.selection.main.head)

function cellOf(page: Page, table: number, row: number, column: number): Locator {
  const root = page.locator(".omd-table").nth(table)
  return row === 0
    ? root.locator("thead th").nth(column)
    : root.locator("tbody tr").nth(row - 1).locator("td").nth(column)
}

/** Opens a cell session: the IME-anchor input mounts with the cell's source. */
async function openCell(page: Page, table: number, row: number, column: number): Promise<Locator> {
  await cellOf(page, table, row, column).click()
  const input = page.locator(".omd-table-cell-input")
  await expect(input).toHaveCount(1)
  return input
}

test("one click opens exactly one cell session for canonical and noncanonical tables", async ({ page }) => {
  for (const [doc, value] of [[CANONICAL, "2"], [NONCANONICAL, "D"]] as const) {
    await page.goto(editUrl(doc))
    await expect(page.locator(".omd-table")).toHaveCount(1)
    const input = await openCell(page, 0, 1, 1)
    await expect(input).toHaveValue(value)
    // 格内会话不翻源码：投影网格还在，源码网格不出现。
    await expect(page.locator(".omd-table-cell-view")).toHaveCount(1)
    await expect(page.locator(".omd-table-src")).toHaveCount(0)
    expect(await docText(page)).toBe(doc)

    await cellOf(page, 0, 0, 0).click()
    await expect(page.locator(".omd-table-cell-input")).toHaveCount(1)
    await expect(page.locator(".omd-table-cell-input")).toHaveValue("A")
    expect(await docText(page)).toBe(doc)
  }
})

test("typing lands at the caret and only changes the target table", async ({ page }) => {
  await page.goto(editUrl(TWO_TABLES))
  await expect(page.locator(".omd-table")).toHaveCount(2)
  const input = await openCell(page, 1, 1, 0)
  await expect(input).toHaveValue("3")
  // 会话光标落在格内容起点：输入前插到既有文本之前（probe 实测语义）。
  await page.keyboard.type("9")

  expect(await docText(page)).toBe(TWO_TABLES.replace("| 3 | 4 |", "| 93 | 4 |"))
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(1)
})

test("editing one cell keeps the other column geometry stable", async ({ page }) => {
  await page.goto(editUrl(REPORTED))
  const other = cellOf(page, 0, 2, 0)
  const before = await other.boundingBox()
  const input = await openCell(page, 0, 1, 1)
  const opened = await other.boundingBox()
  await page.keyboard.type(" extra words that extend the active cell by a lot")
  const after = await other.boundingBox()
  expect(input).toBeFocused()
  expect(before).not.toBeNull()
  expect(opened?.width).toBe(before?.width)
  expect(after?.width).toBe(opened?.width)
})

test("typing after a space inside the reported table cell stays responsive", async ({ page }) => {
  await page.goto(editUrl(REPORTED))
  const input = await openCell(page, 0, 2, 1)
  const value = "React shell, styes, shortcuts, IPC"
  const caret = value.indexOf("styes") + 2
  await input.evaluate((el, pos) => (el as HTMLInputElement).setSelectionRange(pos, pos), caret)
  await page.keyboard.press("Space")
  await page.keyboard.type("x")
  const expected = `${value.slice(0, caret)} x${value.slice(caret)}`
  await expect(input).toHaveValue(expected)
  expect(await docText(page)).toContain(`| Desktop | ${expected} |`)
})

test("a composition sequence produces exactly one document transaction after compositionend", async ({ page }) => {
  await page.goto(editUrl(CANONICAL))
  const input = await openCell(page, 0, 1, 1)

  await input.evaluate(el => {
    el.dispatchEvent(new Event("compositionstart", { bubbles: true }))
    el.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "にほん" }))
  })
  expect(await docChangeCount(page)).toBe(0)
  expect(await docText(page)).toBe(CANONICAL)

  await input.evaluate(el => {
    const field = el as HTMLInputElement
    field.value = "日本"
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }))
  })
  expect(await docChangeCount(page)).toBe(1)

  await input.evaluate(el => {
    el.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertCompositionText",
      data: "日本",
      isComposing: false,
    }))
  })
  expect(await docChangeCount(page)).toBe(1)
  // 会话光标在格首；compositionend 用整值替换该格（日本 替换 2）。
  expect(await docText(page)).toBe(CANONICAL.replace("| 2 |", "| 日本 |"))
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(1)
})

test("input Backspace and Enter cannot edit a parked outer selection", async ({ page }) => {
  await page.goto(editUrl(INTRO))
  await page.evaluate(() => window.__view.dispatch({ selection: { anchor: 0 } }))
  const input = await openCell(page, 0, 1, 1)
  await input.evaluate(el => (el as HTMLInputElement).setSelectionRange(0, 0))
  const before = await docText(page)

  await page.keyboard.press("Backspace")
  await page.keyboard.press("Enter")

  expect(await docText(page)).toBe(before)
  expect(await caretHead(page)).toBe(0)
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(1)
})

test("inserting before the table does not redirect the active cell edit", async ({ page }) => {
  await page.goto(editUrl(INTRO))
  await openCell(page, 0, 1, 1)

  await page.evaluate(() => window.__view.dispatch({ changes: { from: 0, insert: "prefix\n" } }))
  await page.keyboard.type("9")

  expect(await docText(page)).toBe(`prefix\n${INTRO.replace("| 2 |", "| 92 |")}`)
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(1)
})

test("input-focused undo and redo keep the same cell session alive", async ({ page }) => {
  await page.goto(editUrl(NONCANONICAL))
  const input = await openCell(page, 0, 0, 0)

  await page.keyboard.type("X")
  // 首次编辑整表归一化，当前格的值原样保留（前插语义：A → XA）。
  expect(await docText(page)).toBe(NONCANONICAL_EDITED)
  // 第二个历史组必须在 >500ms（CM newGroupDelay）之后：本用例要两次撤销，
  // 不是一次撤销掉全部的相同格连续输入。
  await page.waitForTimeout(600)
  await page.keyboard.type("Y")
  expect(await docText(page)).toBe(NONCANONICAL_EDITED.replace("| XA |", "| XYA |"))

  await page.keyboard.press("ControlOrMeta+z")
  expect(await docText(page)).toBe(NONCANONICAL_EDITED)
  await expect(input).toHaveCount(1)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("XA")

  await page.keyboard.press("ControlOrMeta+Shift+z")
  expect(await docText(page)).toBe(NONCANONICAL_EDITED.replace("| XA |", "| XYA |"))
  await expect(input).toHaveValue("XYA")
})

// probe 实测：会话打开时光标在格内容起点（selectionStart=0），输入是前插；
// End 后光标到格尾，输入变追加。Y 在 X 之后 → XYA。

test("switching cells does not run a second whole-table normalization", async ({ page }) => {
  await page.goto(editUrl(CANONICAL))
  const first = await openCell(page, 0, 1, 0)

  // 前插语义下输入 "9 " 得 "9 1"；整表归一化会 trim 非当前格，而当前格必须
  // 原样保留 —— 尾随空格留在格中间正是「没有第二次整表重写」的证据。
  await page.keyboard.type("9 ")
  const afterFirst = await docText(page)
  expect(afterFirst).toBe(CANONICAL.replace("| 1 |", "| 9 1 |"))
  expect(await first.inputValue()).toBe("9 1")

  await page.keyboard.press("Tab")
  const second = page.locator(".omd-table-cell-input")
  await expect(second).toHaveValue("2")
  await page.keyboard.type("8")

  // 只有目标格变化；整表再次归一化会把上一格的 "9 1" 擦成 "9 1"→"91"。
  expect(await docText(page)).toBe(CANONICAL.replace("| 1 | 2 |", "| 9 1 | 82 |"))
  // 单元格切换同时开启新历史组：一次撤销回到切格之后的文档，再撤销才回到原文。
  await page.keyboard.press("ControlOrMeta+z")
  expect(await docText(page)).toBe(afterFirst)
  await page.keyboard.press("ControlOrMeta+z")
  expect(await docText(page)).toBe(CANONICAL)
})

test("Tab on the final cell closes the session history group", async ({ page }) => {
  await page.goto(editUrl(CANONICAL))
  await openCell(page, 0, 1, 1)

  await page.keyboard.type("9")
  const afterFirst = await docText(page)
  expect(afterFirst).toBe(CANONICAL.replace("| 2 |", "| 92 |"))
  // 末格 Tab 没有相邻格可去：它仍必须结束当前历史组（probe 实测：会话留在原格）。
  await page.keyboard.press("Tab")
  const input = page.locator(".omd-table-cell-input")
  await page.keyboard.type("8")
  expect(await docText(page)).toBe(CANONICAL.replace("| 2 |", "| 982 |"))

  await page.keyboard.press("ControlOrMeta+z")
  expect(await docText(page)).toBe(afterFirst)
  await expect(page.locator(".omd-table-cell-input")).toHaveValue("92")
})

test("Shift-Tab on the first cell closes the session history group", async ({ page }) => {
  await page.goto(editUrl(CANONICAL))
  await openCell(page, 0, 0, 0)

  await page.keyboard.type("X")
  const afterFirst = await docText(page)
  expect(afterFirst).toBe(CANONICAL.replace("| A |", "| XA |"))
  // 首格 Shift-Tab 没有前置格可去：它仍必须结束当前历史组。
  await page.keyboard.press("Shift+Tab")
  await page.keyboard.type("Y")
  expect(await docText(page)).toBe(CANONICAL.replace("| A |", "| XYA |"))

  await page.keyboard.press("ControlOrMeta+z")
  expect(await docText(page)).toBe(afterFirst)
  await expect(page.locator(".omd-table-cell-input")).toHaveValue("XA")
})

test("canonical bytes stay after clearing a cell to empty and typing", async ({ page }) => {
  await page.goto(editUrl(CANONICAL))
  const input = await openCell(page, 0, 1, 0)
  await expect(input).toHaveValue("1")

  // 光标在格首时 Backspace 无字符可删：先 End 到格尾，再逐字符清空。
  await page.keyboard.press("End")
  await page.keyboard.press("Backspace")
  await expect(input).toHaveValue("")
  expect(await docText(page)).toBe(CANONICAL.replace("| 1 |", "|  |"))

  await page.keyboard.type("9")
  expect(await docText(page)).toBe(CANONICAL.replace("| 1 |", "| 9 |"))
  await expect(input).toHaveValue("9")
})

test("a table inside an ordered-list item leaves its markers alone", async ({ page }) => {
  await page.goto(editUrl(ORDERED_TABLE))
  await expect(page.locator(".omd-table")).toHaveCount(1)
  await expect.poll(() => docText(page)).toContain("2. second")
  const settled = await docText(page)

  await openCell(page, 0, 1, 1)
  await page.keyboard.type("9")
  await page.waitForTimeout(300)

  const after = await docText(page)
  expect(after).toBe(settled.replace("   | 1 | 2 |", "   | 1 | 92 |"))
  expect(after).toContain("2. second")
  expect(after).not.toContain("7. second")
})

test("switching cells then undoing and redoing moves the live session across cells and keeps focus", async ({ page }) => {
  await page.goto(editUrl(CANONICAL))
  await openCell(page, 0, 1, 0)
  await page.keyboard.type("9")
  expect(await docText(page)).toBe(CANONICAL.replace("| 1 | 2 |", "| 91 | 2 |"))

  await openCell(page, 0, 1, 1)
  await page.keyboard.type("8")
  expect(await docText(page)).toBe(CANONICAL.replace("| 1 | 2 |", "| 91 | 82 |"))

  await page.keyboard.press("ControlOrMeta+z")
  let input = page.locator(".omd-table-cell-input")
  await expect(input).toHaveCount(1)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("2")
  expect(await docText(page)).toBe(CANONICAL.replace("| 1 | 2 |", "| 91 | 2 |"))

  await page.keyboard.press("ControlOrMeta+z")
  input = page.locator(".omd-table-cell-input")
  await expect(input).toHaveCount(1)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("1")
  expect(await docText(page)).toBe(CANONICAL)

  await page.keyboard.press("ControlOrMeta+Shift+z")
  input = page.locator(".omd-table-cell-input")
  await expect(input).toHaveCount(1)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("91")
  expect(await docText(page)).toBe(CANONICAL.replace("| 1 | 2 |", "| 91 | 2 |"))

  await page.keyboard.press("ControlOrMeta+Shift+z")
  input = page.locator(".omd-table-cell-input")
  await expect(input).toHaveCount(1)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("82")
  expect(await docText(page)).toBe(CANONICAL.replace("| 1 | 2 |", "| 91 | 82 |"))
})

test("clicking a cell in a second table closes the first table session without losing the new session", async ({ page }) => {
  await page.goto(editUrl(TWO_TABLES))
  await openCell(page, 0, 1, 0)

  const input = await openCell(page, 1, 1, 0)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("3")

  await page.keyboard.type("7")
  expect(await docText(page)).toBe(TWO_TABLES.replace("| 3 | 4 |", "| 73 | 4 |"))
})

test("the default harness URL opens a cell session; tableDirectEdit=0 keeps source-on-click", async ({ page }) => {
  // 生产默认（harness 与 Editor.ts 一致）：点格 = 格内会话。
  await page.goto(url(CANONICAL))
  await expect(page.locator(".omd-table")).toHaveCount(1)

  await cellOf(page, 0, 1, 1).click()
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(1)
  await expect(page.locator(".omd-table-src")).toHaveCount(0)
  expect(await docText(page)).toBe(CANONICAL)

  // 显式关掉 cell 会话才回到旧的「点格进源码」路径。
  await page.goto(`/e2e/harness.html?tableDirectEdit=0&doc=${encodeURIComponent(CANONICAL)}`)
  await expect(page.locator(".omd-table")).toHaveCount(1)
  await cellOf(page, 0, 1, 1).click()
  await expect(page.locator(".omd-table-src")).toHaveCount(3)
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(0)
  expect(await docText(page)).toBe(CANONICAL)
})
