import { expect, test } from "@playwright/test"

// Table editing in a real browser: cell commits must patch the existing table DOM
// instead of re-rendering it, and no typed text may be lost when the user leaves a
// cell by any route.
// Regression classes covered here:
//  - one committed cell rebuilt the whole `.omd-table` element (focus/scroll jump,
//    DOM identity lost, visible flicker) — `TableWidget.updateDOM` now patches
//    only the changed cells;
//  - clicking another cell / the `</>` button / outside the block discarded the
//    text that was still sitting in the cell input.
const DOC = [
  "Intro paragraph.",
  "",
  "| A | B | C |",
  "| --- | --- | --- |",
  "| a1 | b1 | c1 |",
  "| a2 | b2 | c2 |",
  "| a3 | b3 | c3 |",
  "",
  "Outro paragraph.",
].join("\n")

const cellText = (page: import("@playwright/test").Page, row: number, col: number) =>
  page.evaluate(([r, c]) => {
    const rows = document.querySelectorAll(".omd-table tbody tr")
    return (rows[r]?.children[c] as HTMLElement | undefined)?.innerText ?? null
  }, [row, col] as const)

async function openCell(page: import("@playwright/test").Page, row: number, col: number) {
  await page.locator(".omd-table tbody tr").nth(row).locator("td").nth(col).click()
  const input = page.locator("input.omd-table-edit")
  await expect(input).toBeFocused()
  return input
}

test("committing a cell keeps the table DOM and moves focus into the next cell", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await expect(page.locator(".omd-table")).toBeVisible()

  // Stash the element identity: an in-place refresh must reuse this exact node.
  await page.evaluate(() => {
    (window as unknown as { __table: Element }).__table = document.querySelector(".omd-table")!
  })

  const input = await openCell(page, 0, 0)
  await input.fill("patched")
  await page.keyboard.press("Tab")

  const same = await page.evaluate(() =>
    (window as unknown as { __table: Element }).__table === document.querySelector(".omd-table"))
  expect(same).toBe(true)

  // Focus continued into the neighbour without an intermediate dead frame.
  await expect(page.locator("input.omd-table-edit")).toBeFocused()
  const focusedCell = await page.evaluate(() => {
    const input = document.querySelector("input.omd-table-edit")!
    return input.closest("td")!.cellIndex
  })
  expect(focusedCell).toBe(1)

  // The commit reached the document and the rendered cell.
  // Header stays untouched; the edited cell is the first body row.
  expect(await page.evaluate(() => window.__view.state.doc.toString())).toContain("| patched | b1 | c1 |")
  expect(await cellText(page, 0, 0)).toBe("patched")
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("clicking another cell commits the edited one instead of discarding it", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  const input = await openCell(page, 1, 1)
  await input.fill("kept")

  await page.locator(".omd-table tbody tr").nth(2).locator("td").nth(2).click()
  await expect(page.locator("input.omd-table-edit")).toBeFocused()

  expect(await page.evaluate(() => window.__view.state.doc.toString())).toContain("| a2 | kept | c2 |")
  expect(await cellText(page, 1, 1)).toBe("kept")
  // The newly clicked cell is the one being edited now.
  const editing = await page.evaluate(() =>
    (document.querySelector("input.omd-table-edit") as HTMLInputElement).value)
  expect(editing).toBe("c3")
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("taking the block into source with </> commits the pending cell first", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  const input = await openCell(page, 2, 0)
  await input.fill("before-source")

  await page.locator(".omd-block-edit").first().click()
  await expect(page.locator(".omd-table")).toHaveCount(0)

  const text = await page.evaluate(() => window.__view.state.doc.toString())
  expect(text).toContain("| before-source | b3 | c3 |")
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("an unmodified cell closes without touching the document", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  const before = await page.evaluate(() => window.__view.state.doc.toString())
  await openCell(page, 0, 0)
  await page.locator(".omd-table tbody tr").nth(1).locator("td").nth(0).click()
  await expect(page.locator("input.omd-table-edit")).toBeFocused()
  expect(await page.evaluate(() => window.__view.state.doc.toString())).toBe(before)
})
