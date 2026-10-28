import { expect, test, type Page } from "@playwright/test"

// Real-browser proof of the list-depth cascade. happy-dom (test/listDepthStyles.test.ts)
// runs the cascade but cannot resolve `calc()` with a second `var(…, fallback)`, so the
// two things only a layout engine can settle are checked here:
//  - the widget's own padding shorthand (padding: 0 / 0.5em 0 / 4px 0 / 0.8em 0) does
//    not erase the list offset a later rule adds, and
//  - the offset is added exactly once across wrapper → header → body, and the
//    quote-in-list bar lands on that one offset instead of a doubled one.
const LIST_DEPTH = 3

const LIST_CODE = [
  "- L1",
  "  - L2",
  `    - L${LIST_DEPTH}`,
  "",
  "      ```js",
  "      const x = 1",
  "      ```",
  "",
  "tail",
].join("\n")

const QUOTE_IN_LIST_CODE = [
  "- L1",
  "  - L2",
  "",
  "    > ```js",
  "    > const x = 1",
  "    > ```",
  "",
  "tail",
].join("\n")

const LIST_TABLE = [
  "- L1",
  "  - L2",
  "",
  "    | a | b |",
  "    |---|---|",
  "    | 1 | 2 |",
  "",
  "tail",
].join("\n")

const PLAIN_CODE = ["intro", "", "```js", "const x = 1", "```", "", "tail"].join("\n")

const open = (page: Page, doc: string) => page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}`)

test("a rendered code block in a list is indented by the depth exactly once", async ({ page }) => {
  await open(page, LIST_CODE)
  const code = page.locator(".omd-code")
  await expect(code).toBeVisible()
  await expect(code).toHaveClass(/omd-li/)
  await expect(code).toHaveAttribute("style", /--omd-list-depth:\s*3/)

  const geometry = await page.evaluate(() => {
    const wrapper = document.querySelector(".omd-code") as HTMLElement
    const header = wrapper.querySelector(".omd-code-header") as HTMLElement
    const body = wrapper.querySelector(".omd-code-body") as HTMLElement
    const title = wrapper.querySelector(".omd-code-title") as HTMLElement
    const px = (el: Element) => parseFloat(getComputedStyle(el).paddingLeft)
    return {
      em: parseFloat(getComputedStyle(wrapper).fontSize) * 1.2,
      wrapperPadding: px(wrapper),
      headerPadding: px(header),
      bodyPadding: px(body),
      border: parseFloat(getComputedStyle(wrapper).borderLeftWidth),
      wrapperLeft: wrapper.getBoundingClientRect().left,
      headerLeft: header.getBoundingClientRect().left,
      titleLeft: title.getBoundingClientRect().left,
    }
  })

  const offset = LIST_DEPTH * geometry.em
  // The shorthand (padding: 0) no longer erases the depth offset.
  expect(geometry.wrapperPadding).toBeCloseTo(offset, 1)
  // The wrapper owns the single offset: header/body only keep their base insets.
  expect(geometry.headerPadding).toBeCloseTo(10, 1)
  expect(geometry.bodyPadding).toBeCloseTo(0, 1)
  expect(geometry.headerLeft - geometry.wrapperLeft).toBeCloseTo(geometry.border + offset, 0)
  expect(geometry.titleLeft - geometry.wrapperLeft).toBeCloseTo(geometry.border + offset + 10, 0)
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("an ordinary block widget keeps its vertical padding and gains one list offset", async ({ page }) => {
  await open(page, LIST_TABLE)
  await expect(page.locator(".omd-table")).toBeVisible()

  const geometry = await page.evaluate(() => {
    const table = document.querySelector(".omd-table") as HTMLElement
    const style = getComputedStyle(table)
    return {
      em: parseFloat(style.fontSize) * 1.2,
      paddingLeft: parseFloat(style.paddingLeft),
      paddingTop: parseFloat(style.paddingTop),
    }
  })
  // .omd-table { padding: 0.8em 0 } must survive: only the left side is re-derived.
  expect(geometry.paddingLeft).toBeCloseTo(2 * geometry.em, 1)
  expect(geometry.paddingTop).toBeCloseTo(0.8 * 16, 1)
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("the quote-in-list bar sits on the one list offset, not a doubled one", async ({ page }) => {
  await open(page, QUOTE_IN_LIST_CODE)
  const code = page.locator(".omd-code")
  await expect(code).toBeVisible()
  await expect(code).toHaveClass(/omd-quote-in-li/)

  const geometry = await page.evaluate(() => {
    const wrapper = document.querySelector(".omd-code") as HTMLElement
    const header = wrapper.querySelector(".omd-code-header") as HTMLElement
    // The quote bar lives on `background-image` only: its first px stop is --omd-bq-bar.
    const gradientStart = (el: Element) =>
      Number(getComputedStyle(el).backgroundImage.match(/([\d.]+)px/)![1])
    const px = (el: Element) => parseFloat(getComputedStyle(el).paddingLeft)
    return {
      fontSize: parseFloat(getComputedStyle(wrapper).fontSize),
      wrapperPadding: px(wrapper),
      headerPadding: px(header),
      wrapperBarX: wrapper.getBoundingClientRect().left
        + parseFloat(getComputedStyle(wrapper).borderLeftWidth) + gradientStart(wrapper),
      headerBarX: header.getBoundingClientRect().left + gradientStart(header),
      wrapperLeft: wrapper.getBoundingClientRect().left,
    }
  })

  const offset = 2 * geometry.fontSize * 1.2
  expect(geometry.wrapperPadding).toBeCloseTo(offset, 1)
  // Quote pad stays on the header (it owns the opaque chrome background): 1em + 10px.
  expect(geometry.headerPadding).toBeCloseTo(geometry.fontSize + 10, 1)
  // Both boxes paint the bar at the same absolute x = the list offset, and neither
  // is 2 * offset: the wrapper's padding and the header's own bar origin agree.
  expect(geometry.wrapperBarX).toBeCloseTo(geometry.wrapperLeft + 1 + offset, 0)
  expect(geometry.headerBarX).toBeCloseTo(geometry.wrapperBarX, 0)
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("the editing chrome owns the whole indent, and a non-list block is unchanged", async ({ page }) => {
  await open(page, QUOTE_IN_LIST_CODE)
  // Shiki renders async: wait for the body before moving the caret, otherwise the
  // selection change can land while the block is still settling.
  await expect(page.locator(".omd-code-lines .line").first()).toBeVisible()
  // Caret inside a fence *content* line → the block becomes the editing chrome (a block
  // widget of its own, no .omd-code wrapper around it). A caret on the fence line itself
  // stays raw source by design, so target the body text.
  await page.evaluate(() => {
    const text = window.__view.state.doc.toString()
    window.__view.dispatch({ selection: { anchor: text.indexOf("const") } })
  })
  const header = page.locator(".cm-content > .omd-code-header")
  await expect(header).toBeVisible()

  const chrome = await page.evaluate(() => {
    const el = document.querySelector(".cm-content > .omd-code-header") as HTMLElement
    const style = getComputedStyle(el)
    return {
      fontSize: parseFloat(style.fontSize),
      paddingLeft: parseFloat(style.paddingLeft),
      barStart: Number(style.backgroundImage.match(/([\d.]+)px/)![1]),
    }
  })
  // Exactly one list offset of 2 levels, plus the 10px base inset and the quote pad.
  expect(chrome.paddingLeft).toBeCloseTo(2 * chrome.fontSize * 1.2 + chrome.fontSize + 10, 1)
  expect(chrome.barStart).toBeCloseTo(2 * chrome.fontSize * 1.2, 0)

  // Depth 0 / non-list stays byte-for-byte equivalent: no offset anywhere.
  await open(page, PLAIN_CODE)
  await expect(page.locator(".omd-code")).toBeVisible()
  const plain = await page.evaluate(() => {
    const wrapper = document.querySelector(".omd-code") as HTMLElement
    const header = wrapper.querySelector(".omd-code-header") as HTMLElement
    return {
      wrapperPadding: parseFloat(getComputedStyle(wrapper).paddingLeft),
      headerPadding: parseFloat(getComputedStyle(header).paddingLeft),
      hasListClass: wrapper.classList.contains("omd-li") || wrapper.classList.contains("omd-quote-in-li"),
    }
  })
  expect(plain.hasListClass).toBe(false)
  expect(plain.wrapperPadding).toBe(0)
  expect(plain.headerPadding).toBe(10)
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})
