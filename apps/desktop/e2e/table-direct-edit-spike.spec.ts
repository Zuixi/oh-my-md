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
const NONCANONICAL_EDITED = "| X | B |\n| :--- | ---: |\n| C | D |\n\ntail"
const TWO_TABLES = "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nmiddle\n\n| C | D |\n| --- | --- |\n| 3 | 4 |\n\ntail"
const ORDERED_TABLE = "1. first\n\n   | A | B |\n   | --- | --- |\n   | 1 | 2 |\n\n7. second"

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

async function openCell(page: Page, table: number, row: number, column: number): Promise<Locator> {
  await cellOf(page, table, row, column).click()
  const input = page.locator(".omd-table-cell-input")
  await expect(input).toHaveCount(1)
  return input
}

test("one click opens exactly one cell input for canonical and noncanonical tables", async ({ page }) => {
  for (const [doc, value] of [[CANONICAL, "2"], [NONCANONICAL, "D"]] as const) {
    await page.goto(editUrl(doc))
    await expect(page.locator(".omd-table")).toHaveCount(1)
    const input = await openCell(page, 0, 1, 1)
    await expect(input).toHaveValue(value)
    await expect(page.locator(".omd-table-src")).toHaveCount(0)
    expect(await docText(page)).toBe(doc)

    await cellOf(page, 0, 0, 0).click()
    await expect(page.locator(".omd-table-cell-input")).toHaveCount(1)
    await expect(page.locator(".omd-table-cell-input")).toHaveValue("A")
    expect(await docText(page)).toBe(doc)
  }
})

test("typing only changes the target table", async ({ page }) => {
  await page.goto(editUrl(TWO_TABLES))
  await expect(page.locator(".omd-table")).toHaveCount(2)
  const input = await openCell(page, 1, 1, 0)
  await expect(input).toHaveValue("3")

  await page.keyboard.type("9")

  expect(await docText(page)).toBe(TWO_TABLES.replace("| 3 | 4 |", "| 9 | 4 |"))
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(1)
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

  expect(await docText(page)).toBe(`prefix\n${INTRO.replace("| 2 |", "| 9 |")}`)
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(1)
})

test("input-focused undo and redo keep the same cell input alive", async ({ page }) => {
  await page.goto(editUrl(NONCANONICAL))
  const input = await openCell(page, 0, 0, 0)

  await page.keyboard.type("X")
  expect(await docText(page)).toBe(NONCANONICAL_EDITED)
  // 第二个历史组必须在 >500ms（CM newGroupDelay）之后：本用例要两次撤销，
  // 不是一次撤销掉全部的相同格连续输入。
  await page.waitForTimeout(600)
  await page.keyboard.type("Y")
  expect(await docText(page)).toBe(NONCANONICAL_EDITED.replace("| X |", "| XY |"))

  await page.keyboard.press("ControlOrMeta+z")
  expect(await docText(page)).toBe(NONCANONICAL_EDITED)
  await expect(input).toHaveCount(1)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("X")

  await page.keyboard.press("ControlOrMeta+Shift+z")
  expect(await docText(page)).toBe(NONCANONICAL_EDITED.replace("| X |", "| XY |"))
  await expect(input).toHaveValue("XY")
})

test("switching cells does not run a second whole-table normalization", async ({ page }) => {
  await page.goto(editUrl(CANONICAL))
  const first = await openCell(page, 0, 1, 0)

  // 首格首次输入本来就会整表归一化，这里故意带上尾随空格：归一化会原样保留
  // 当前格的值，而整表重写会把**非当前格**的 source trim 掉。
  await page.keyboard.type("9 ")
  const afterFirst = await docText(page)
  expect(afterFirst).toBe(CANONICAL.replace("| 1 |", "| 9  |"))
  expect(await first.inputValue()).toBe("9 ")

  await page.keyboard.press("Tab")
  const second = page.locator(".omd-table-cell-input")
  await expect(second).toHaveValue("2")
  await page.keyboard.type("8")

  // 只有目标格变化；整表再次归一化会把上一格的 "9 " 变成 "9"。
  expect(await docText(page)).toBe(CANONICAL.replace("| 1 | 2 |", "| 9  | 8 |"))
  // 单元格切换同时开启新历史组：一次撤销回到切格之后的文档，再撤销才回到原文。
  await page.keyboard.press("ControlOrMeta+z")
  expect(await docText(page)).toBe(afterFirst)
  await page.keyboard.press("ControlOrMeta+z")
  expect(await docText(page)).toBe(CANONICAL)
})

test("Tab on the final cell closes the input history group", async ({ page }) => {
  await page.goto(editUrl(CANONICAL))
  await openCell(page, 0, 1, 1)

  await page.keyboard.type("9")
  const afterFirst = await docText(page)
  expect(afterFirst).toBe(CANONICAL.replace("| 2 |", "| 9 |"))
  // 末格 Tab 没有相邻格可去：它仍必须结束当前历史组。
  await page.keyboard.press("Tab")
  await page.keyboard.type("8")
  expect(await docText(page)).toBe(CANONICAL.replace("| 2 |", "| 98 |"))

  await page.keyboard.press("ControlOrMeta+z")
  expect(await docText(page)).toBe(afterFirst)
  await expect(page.locator(".omd-table-cell-input")).toHaveValue("9")
})

test("Shift-Tab on the first cell closes the input history group", async ({ page }) => {
  await page.goto(editUrl(CANONICAL))
  await openCell(page, 0, 0, 0)

  await page.keyboard.type("X")
  const afterFirst = await docText(page)
  expect(afterFirst).toBe(CANONICAL.replace("| A |", "| X |"))
  // 首格 Shift-Tab 没有前置格可去：它仍必须结束当前历史组。
  await page.keyboard.press("Shift+Tab")
  await page.keyboard.type("Y")
  expect(await docText(page)).toBe(CANONICAL.replace("| A |", "| XY |"))

  await page.keyboard.press("ControlOrMeta+z")
  expect(await docText(page)).toBe(afterFirst)
  await expect(page.locator(".omd-table-cell-input")).toHaveValue("X")
})

test("canonical bytes stay after clearing a cell to empty and typing", async ({ page }) => {
  await page.goto(editUrl(CANONICAL))
  const input = await openCell(page, 0, 1, 0)
  await expect(input).toHaveValue("1")

  // 输入框激活时整格已选中：Backspace 把该格清成空串。
  await page.keyboard.press("Backspace")
  await expect(input).toHaveValue("")

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
  expect(after).toBe(settled.replace("   | 1 | 2 |", "   | 1 | 9 |"))
  expect(after).toContain("2. second")
  expect(after).not.toContain("7. second")
})

test("switching cells then undoing and redoing moves the live input across cells and keeps focus", async ({ page }) => {
  await page.goto(editUrl(CANONICAL))
  await openCell(page, 0, 1, 0)
  await page.keyboard.type("9")
  expect(await docText(page)).toBe(CANONICAL.replace("| 1 | 2 |", "| 9 | 2 |"))

  await openCell(page, 0, 1, 1)
  await page.keyboard.type("8")
  expect(await docText(page)).toBe(CANONICAL.replace("| 1 | 2 |", "| 9 | 8 |"))

  await page.keyboard.press("ControlOrMeta+z")
  let input = page.locator(".omd-table-cell-input")
  await expect(input).toHaveCount(1)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("2")
  expect(await docText(page)).toBe(CANONICAL.replace("| 1 | 2 |", "| 9 | 2 |"))

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
  await expect(input).toHaveValue("9")
  expect(await docText(page)).toBe(CANONICAL.replace("| 1 | 2 |", "| 9 | 2 |"))

  await page.keyboard.press("ControlOrMeta+Shift+z")
  input = page.locator(".omd-table-cell-input")
  await expect(input).toHaveCount(1)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("8")
  expect(await docText(page)).toBe(CANONICAL.replace("| 1 | 2 |", "| 9 | 8 |"))
})

test("clicking a cell in a second table closes the first table input without losing the new session", async ({ page }) => {
  await page.goto(editUrl(TWO_TABLES))
  await openCell(page, 0, 1, 0)

  const input = await openCell(page, 1, 1, 0)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("3")

  await page.keyboard.type("7")
  expect(await docText(page)).toBe(TWO_TABLES.replace("| 3 | 4 |", "| 7 | 4 |"))
})

test("the default harness URL still enters source instead of opening an input", async ({ page }) => {
  await page.goto(url(CANONICAL))
  await expect(page.locator(".omd-table")).toHaveCount(1)

  await cellOf(page, 0, 1, 1).click()

  await expect(page.locator(".omd-table-src")).toHaveCount(3)
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(0)
  expect(await docText(page)).toBe(CANONICAL)
})
