import { expect, test, type Page } from "@playwright/test"

// Real-browser smoke for the shared Markdown semantic projections (see plan
// 2026-10-30-01 Task 4): one document is projected through the live editor, and
// the assertions are DOM/source-level only — no pixel snapshots.
//
// Scope note: Chromium here proves the *editor/browser* projection (decorations,
// inline widgets, block table-cell DOM, source entry). It says nothing about
// native clipboard capability; that lives in the host/Rust layer and is not
// reachable from this harness.
//
// Fixture note: the images are 1×1 data URIs on purpose. A large image loads
// asynchronously and changes line heights after the first measure, which can push
// the table block widget out of the viewport (CodeMirror then renders a `.cm-gap`
// instead of the widget). Tiny images keep the mount deterministic.

const IMG_A = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg=="
const IMG_B = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYPj/HwADAgH/OSkZvgAAAABJRU5ErkJggg=="

// Row 1 carries the escaped pipe (inline code and plain text), a reference link
// with a title, and sub/superscript. Row 2 carries a reference image with a
// title and an inline `<br>`.
const TABLE = [
  "| code pipe | plain pipe | refs | marks |",
  "| --- | --- | --- | --- |",
  "| `a \\| b` | a \\| b | [link][ref-link] | H~2~O x^2^ |",
  "| ![table image][ref-img] | plain | `x` | a<br>b |",
].join("\n")

const DEFS = [
  `[ref-img]: ${IMG_A} "Ref image title"`,
  `[ref-link]: https://example.com/ref?q=1 "Ref link title"`,
].join("\n")

const DEFS_EDITED = [
  `[ref-img]: ${IMG_B} "Ref image title v2"`,
  `[ref-link]: https://example.com/ref?q=2 "Ref link title v2"`,
].join("\n")

const INLINE_IMAGE_LINE = `![plain alt](${IMG_A} "plain title")`

const DOC = [
  // Escape: the hidden marker is the backslash, the escaped `_` stays.
  "access\\_token",
  "",
  // Both HardBreak forms: a trailing backslash and a trailing two-space run.
  "backslash\\",
  "after-backslash before  ",
  "after-spaces",
  "",
  // Inline image with formatted + entity alt, then a reference image.
  `![a *b* &amp; c](${IMG_A} "inline title")`,
  "",
  "![ref image][ref-img]",
  "",
  // Two byte-identical tables: dependency refresh must not confuse instances.
  TABLE,
  "",
  TABLE,
  "",
  INLINE_IMAGE_LINE,
  "",
  // Definitions after the tables, referenced from inside table cells.
  DEFS,
].join("\n")

const TABLE_START = DOC.indexOf(TABLE)
const TABLE_END = TABLE_START + TABLE.length
const DEFS_START = DOC.indexOf(DEFS)
const IMAGE_LINE_START = DOC.indexOf(INLINE_IMAGE_LINE)
const IMAGE_LINE_END = IMAGE_LINE_START + INLINE_IMAGE_LINE.length

const docText = (page: Page): Promise<string> => page.evaluate(() => window.__docText())
const tables = (page: Page) => page.locator(".omd-table")
const visibleLines = (page: Page): Promise<string[]> =>
  page.locator(".cm-line").evaluateAll(nodes => nodes.map(node => node.textContent ?? ""))

async function openHarness(page: Page): Promise<void> {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  // The table block widget mounting proves both the parse and the decoration
  // build ran; every other projection hangs off the same document state.
  await expect(tables(page)).toHaveCount(2)
}

const select = (page: Page, anchor: number, head = anchor): Promise<void> =>
  page.evaluate(({ anchor, head }) => {
    window.__view.dispatch({ selection: { anchor, head } })
  }, { anchor, head })

const selection = (page: Page) => page.evaluate(() => {
  const main = window.__view.state.selection.main
  return { from: main.from, to: main.to, head: main.head }
})

test("inline and reference images project alt, title and resolved src", async ({ page }) => {
  await openHarness(page)
  const images = page.locator(".cm-line img.omd-image")
  await expect(images).toHaveCount(3)

  // Inline image: alt is visible label text — emphasis markers dropped, the
  // Entity decoded — while the source bytes keep both.
  const inline = images.nth(0)
  await expect(inline).toHaveAttribute("alt", "a b & c")
  await expect(inline).toHaveAttribute("title", "inline title")
  await expect(inline).toHaveAttribute("src", IMG_A)

  // Reference image: src/title come from the definition, not from `[ref-img]`.
  const reference = images.nth(1)
  await expect(reference).toHaveAttribute("alt", "ref image")
  await expect(reference).toHaveAttribute("src", IMG_A)
  await expect(reference).toHaveAttribute("title", "Ref image title")

  // The plain inline image used by the source-entry case projects verbatim.
  await expect(images.nth(2)).toHaveAttribute("alt", "plain alt")
  await expect(images.nth(2)).toHaveAttribute("title", "plain title")

  // Nothing degraded to the broken-image fallback.
  await expect(page.locator(".omd-image-broken")).toHaveCount(0)
  expect(await docText(page)).toBe(DOC)
})

test("escape and both hard break forms hide their markers, keep exact line text", async ({ page }) => {
  await openHarness(page)

  // Exact visible text: `access\_token` has no backslash, the backslash
  // HardBreak and the two-space HardBreak each leave one visible line break and
  // no marker characters at the line end.
  const head = (await visibleLines(page)).slice(0, 5)
  expect(head).toEqual([
    "access_token",
    "",
    "backslash",
    "after-backslash before",
    "after-spaces",
  ])
  for (const line of head) expect(line).not.toContain("\\")

  // The markers are hidden, not deleted: the same transaction leaves the
  // document bytes untouched.
  const doc = await docText(page)
  expect(doc).toBe(DOC)
  expect(doc).toContain("access\\_token")
  expect(doc).toContain("backslash\\\nafter-backslash before  \nafter-spaces")
})

test("table cells project escaped pipes, reference title, sub/sup and br", async ({ page }) => {
  await openHarness(page)
  const table = tables(page).first()
  await expect(table.locator("thead th")).toHaveCount(4)
  await expect(table.locator("tbody td")).toHaveCount(8)

  const firstRow = table.locator("tbody tr").nth(0)
  const cells = firstRow.locator("td")

  // `\|` inside inline code keeps the literal pipe as code text, with no
  // shielding backslash left behind.
  await expect(cells.nth(0).locator("code")).toHaveText("a | b")
  await expect(cells.nth(0)).toHaveText("a | b")
  // Same for plain cell text.
  await expect(cells.nth(1)).toHaveText("a | b")

  // Reference link resolves destination + optional title from the definition.
  const link = cells.nth(2).locator("a")
  await expect(link).toHaveText("link")
  await expect(link).toHaveAttribute("href", "https://example.com/ref?q=1")
  await expect(link).toHaveAttribute("title", "Ref link title")

  // Sub/superscript containers are real elements, not flattened text.
  await expect(cells.nth(3).locator("sub")).toHaveText("2")
  await expect(cells.nth(3).locator("sup")).toHaveText("2")
  expect(await cells.nth(3).innerHTML()).toBe("H<sub>2</sub>O x<sup>2</sup>")

  const secondRow = table.locator("tbody tr").nth(1).locator("td")
  const image = secondRow.nth(0).locator("img.omd-image")
  await expect(image).toHaveAttribute("alt", "table image")
  await expect(image).toHaveAttribute("src", IMG_A)
  await expect(image).toHaveAttribute("title", "Ref image title")
  await expect(secondRow.nth(2).locator("code")).toHaveText("x")
  expect(await secondRow.nth(3).innerHTML()).toBe("a<br>b")

  // Cell projections never rewrite the table source.
  expect(await docText(page)).toBe(DOC)
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("a definition edit refreshes both mounted tables without touching table source", async ({ page }) => {
  await openHarness(page)

  // Tag the two live widgets: refresh has to happen in place (updateDOM) rather
  // than by rebuilding the block, and both instances must be reached.
  await page.evaluate(() => {
    document.querySelectorAll(".omd-table").forEach((node, index) => {
      ;(node as HTMLElement).dataset.projectionProbe = `table-${index}`
    })
  })

  // One dispatch that edits only the definition block, through the live view.
  await page.evaluate(({ from, length, insert }) => {
    window.__view.dispatch({ changes: { from, to: from + length, insert } })
  }, { from: DEFS_START, length: DEFS.length, insert: DEFS_EDITED })

  for (const index of [0, 1]) {
    const table = tables(page).nth(index)
    const link = table.locator("tbody tr").nth(0).locator("td").nth(2).locator("a")
    await expect(link).toHaveAttribute("href", "https://example.com/ref?q=2")
    await expect(link).toHaveAttribute("title", "Ref link title v2")
    const image = table.locator("tbody tr").nth(1).locator("td").nth(0).locator("img.omd-image")
    await expect(image).toHaveAttribute("src", IMG_B)
    await expect(image).toHaveAttribute("title", "Ref image title v2")
  }

  // The paragraph-level reference image follows the same definition change.
  await expect(page.locator(".cm-line img.omd-image").nth(1)).toHaveAttribute("src", IMG_B)

  // Both tables are still the same mounted widgets.
  expect(await page.evaluate(() =>
    Array.from(document.querySelectorAll(".omd-table")).map(node =>
      (node as HTMLElement).dataset.projectionProbe ?? null))).toEqual(["table-0", "table-1"])

  // Every byte outside the deliberate definition edit is unchanged, including
  // both table sources.
  const doc = await docText(page)
  expect(doc).toBe(DOC.replace(DEFS, DEFS_EDITED))
  expect(doc.slice(TABLE_START, TABLE_END)).toBe(TABLE)
  expect(doc.slice(0, DEFS_START)).toBe(DOC.slice(0, DEFS_START))
  expect(doc.slice(DEFS_START)).toBe(DEFS_EDITED)
})

test("table and image source entry expose source without rewriting bytes", async ({ page }) => {
  await openHarness(page)

  // A cell click is an intent to edit that cell: the whole table flips to the
  // source grid (this one only — the identical second table keeps its preview).
  await tables(page).first().locator("tbody tr").nth(0).locator("td").nth(1).click()
  await expect(page.locator(".omd-table-src")).toHaveCount(4)
  await expect(tables(page)).toHaveCount(1)

  // The caret lands at the clicked cell's source, not at the block start, so
  // the cell boundaries stay addressable.
  const expectedHead = TABLE_START + TABLE.indexOf("| a \\| b |") + "| ".length
  expect(await selection(page)).toEqual({ from: expectedHead, to: expectedHead, head: expectedHead })
  expect(expectedHead).toBeGreaterThan(TABLE_START)
  expect(expectedHead).toBeLessThan(TABLE_END)

  // Both block boundaries are reachable: a full-table selection is accepted
  // verbatim (the block is not atomic) and still rewrites nothing.
  await select(page, TABLE_START, TABLE_END)
  expect(await selection(page)).toEqual({ from: TABLE_START, to: TABLE_END, head: TABLE_END })
  expect(await docText(page)).toBe(DOC)

  // Leaving the table re-mounts its preview; the document is byte-identical.
  await select(page, 0)
  await expect(tables(page)).toHaveCount(2)
  await expect(page.locator(".omd-table-src")).toHaveCount(0)
  expect(await docText(page)).toBe(DOC)

  // Image source entry is caret-driven: the inline widget owns the pointer
  // event, so a click moves neither caret nor source — a caret inside the Image
  // node is what reveals its raw Markdown.
  const visibleEditorImages = page.locator(".cm-line img.omd-image")
  await expect(visibleEditorImages).toHaveCount(3)
  const parked = await selection(page)
  await visibleEditorImages.nth(2).click()
  await expect(visibleEditorImages).toHaveCount(3)
  expect(await selection(page)).toEqual(parked)

  await select(page, IMAGE_LINE_START + 3)
  expect(await visibleLines(page)).toContain(INLINE_IMAGE_LINE)
  await expect(visibleEditorImages).toHaveCount(2)

  // The closing boundary stays addressable: the widget returns right after it.
  await select(page, IMAGE_LINE_END)
  await expect(visibleEditorImages).toHaveCount(3)
  expect((await visibleLines(page)).filter(line => line === INLINE_IMAGE_LINE)).toHaveLength(0)

  // Source entry is a projection only — not one document byte moved.
  expect(await docText(page)).toBe(DOC)
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("Source/Live toggled twice shows and restores the same bytes", async ({ page }) => {
  await openHarness(page)
  // The toggle is the real keymap binding (Mod-e), not a harness shortcut.
  const toggle = process.platform === "darwin" ? "Meta+e" : "Control+e"

  await page.keyboard.press(toggle)
  // Source mode: no widgets, and every line is its literal Markdown — the
  // escape marker, both hard break markers and the table's `\|` shielding are
  // visible again.
  await expect(tables(page)).toHaveCount(0)
  expect(await visibleLines(page)).toEqual(DOC.split("\n"))
  expect(await docText(page)).toBe(DOC)

  await page.keyboard.press(toggle)
  await expect(tables(page)).toHaveCount(2)
  expect(await docText(page)).toBe(DOC)
})
