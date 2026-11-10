import { expect, test, type Page } from "@playwright/test"

// A selection that fully covers a block widget keeps it mounted and marks it
// `.omd-block-covered` (`blockSelectionOverlay.ts`), so the block must read as selected
// without losing its text. The widget paints its own opaque background, which is why a
// selection fill above it hides code/table glyphs while `state.doc` and the clipboard
// stay correct — a regression only a real paint pass can show.
const DOC = `Intro paragraph starts the drag.

\`\`\`js
const answer = 42
\`\`\`

| Name | Value |
| --- | --- |
| alpha | 1 |
| beta | 2 |

- bullet item

> quoted line

Trailing paragraph ends the drag.`

/** Summed channel distance above which a pixel reads as text rather than background. */
const INK_GAP = 24
/** Text boxes only: widget interiors and rendered line text, never bare whitespace. */
const REGIONS = [
  { label: "code line", selector: ".omd-code-lines .line" },
  { label: "table cell", selector: ".omd-table tbody td" },
  // Rendered list and quote lines stay plain `.cm-line`s.
  { label: "list item", selector: ".cm-line.omd-li" },
  { label: "quote line", selector: ".cm-line.omd-blockquote" },
]

type Rgb = readonly [number, number, number]
type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
type Region = { readonly label: string; readonly box: Box; readonly shot: Buffer }

const colorGap = (a: Rgb, b: Rgb): number =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))

/** Shoot each region's text box now, so the covered shot crops the same pixels. */
async function capture(page: Page): Promise<readonly Region[]> {
  const boxes = await page.evaluate(selectors => selectors.map(selector => {
    const element = document.querySelector(selector)
    if (!element) throw new Error(`missing ${selector}`)
    const range = document.createRange()
    range.selectNodeContents(element)
    const { x, y, width, height } = range.getBoundingClientRect()
    return { x, y, width, height }
  }), REGIONS.map(region => region.selector))
  const regions: Region[] = []
  for (const [index, { label }] of REGIONS.entries()) {
    const box = boxes[index]
    regions.push({ label, box, shot: await page.screenshot({ clip: box }) })
  }
  return regions
}

/** Decode both shots in-page; per region, treat the dominant color as background. */
async function paintStats(page: Page, before: Buffer, after: Buffer) {
  return page.evaluate(async ({ before, after, gap }) => {
    const pixels = async (base64: string): Promise<ImageData> => {
      const image = new Image()
      image.src = `data:image/png;base64,${base64}`
      await image.decode()
      const canvas = Object.assign(document.createElement("canvas"),
        { width: image.naturalWidth, height: image.naturalHeight })
      const context = canvas.getContext("2d")
      if (!context) throw new Error("canvas 2d context unavailable")
      context.drawImage(image, 0, 0)
      return context.getImageData(0, 0, canvas.width, canvas.height)
    }
    const dominant = ({ data }: ImageData): Rgb => {
      const counts = new Map<number, number>()
      for (let index = 0; index < data.length; index += 4) {
        const key = (data[index] << 16) | (data[index + 1] << 8) | data[index + 2]
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const [color] = [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best))
      return [(color >> 16) & 255, (color >> 8) & 255, color & 255]
    }
    const ink = ({ data }: ImageData, [red, green, blue]: Rgb): number => {
      let count = 0
      for (let index = 0; index < data.length; index += 4) {
        const distance = Math.abs(data[index] - red) + Math.abs(data[index + 1] - green)
          + Math.abs(data[index + 2] - blue)
        if (distance > gap) count++
      }
      return count
    }
    const unselected = await pixels(before)
    const covered = await pixels(after)
    if (unselected.width !== covered.width || unselected.height !== covered.height) {
      throw new Error("the sampled region changed size with the selection")
    }
    const backgroundBefore = dominant(unselected)
    const backgroundAfter = dominant(covered)
    return {
      backgroundBefore,
      backgroundAfter,
      inkBefore: ink(unselected, backgroundBefore),
      inkAfter: ink(covered, backgroundAfter),
    }
  }, { before: before.toString("base64"), after: after.toString("base64"), gap: INK_GAP })
}

/** The selection tint the theme promises for selected text. */
async function selectionTint(page: Page): Promise<Rgb> {
  const hex = await page.evaluate(() => getComputedStyle(document.documentElement)
    .getPropertyValue("--omd-selection-bg").trim())
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`unexpected --omd-selection-bg: ${hex}`)
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/** Every sampled region still paints its text, over the theme's selection tint. */
async function expectSelectedText(
  page: Page,
  regions: readonly Region[],
  theme: "light" | "dark",
): Promise<void> {
  const tint = await selectionTint(page)
  for (const { label, box, shot } of regions) {
    const stats = await paintStats(page, shot, await page.screenshot({ clip: box }))
    const name = `${label} (${theme})`
    expect(stats.inkBefore, `${name}: sampled region shows no text`).toBeGreaterThan(40)
    expect(stats.inkAfter, `${name}: the selection paint hid the text`).toBeGreaterThan(stats.inkBefore * 0.8)
    expect(colorGap(stats.backgroundBefore, stats.backgroundAfter), `${name}: no selection tint`)
      .toBeGreaterThan(12)
    expect(colorGap(stats.backgroundAfter, tint), `${name}: tint is not --omd-selection-bg`)
      .toBeLessThanOrEqual(24)
  }
}

/** The gesture's result: covered blocks, exact selection, untouched document bytes. */
async function editorState(page: Page) {
  return page.evaluate(() => {
    const { from, to, anchor, head } = window.__view.state.selection.main
    return {
      covered: [...document.querySelectorAll<HTMLElement>(".omd-block.omd-block-covered")].map(b => b.className),
      from,
      to,
      anchor,
      head,
      text: window.__view.state.doc.sliceString(from, to),
      doc: window.__view.state.doc.toString(),
      changes: window.__docChangeCount,
      errors: window.__harnessErrors,
    }
  })
}

async function openEditor(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}&theme=${theme}`)
  // Shiki highlights asynchronously and the table renders after its widget mounts.
  await expect(page.locator(".omd-code-lines")).toHaveAttribute("data-omd-highlight", "shiki")
  await expect(page.locator(".omd-code-lines .line")).toHaveCount(1)
  await expect(page.locator(".omd-table tbody tr")).toHaveCount(2)
  await expect(page.locator(".omd-table tbody td").first()).toBeVisible()
  await expect(page.locator(".omd-block-covered")).toHaveCount(0)
}

/** Drag from the first source line to the last, straight through both widgets. */
async function dragAcrossDocument(page: Page): Promise<void> {
  const { from, to } = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")]
    const first = lines[0].getBoundingClientRect()
    const last = lines[lines.length - 1].getBoundingClientRect()
    return {
      from: { x: first.left + 2, y: first.top + first.height / 2 },
      to: { x: last.right - 2, y: last.top + last.height / 2 },
    }
  })
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 20 })
  await page.mouse.up()
}

/** Both gestures must paint the rendered widgets and the plain lines, in both themes. */
const SELECTIONS = {
  "a drag across the document": dragAcrossDocument,
  "select-all": (page: Page) => page.keyboard.press("ControlOrMeta+a"),
}

for (const theme of ["light", "dark"] as const) {
  for (const [gesture, select] of Object.entries(SELECTIONS)) {
    test(`${gesture} keeps selected text painted (${theme})`, async ({ page }) => {
      await openEditor(page, theme)
      const regions = await capture(page)

      await select(page)
      const selected = await editorState(page)
      expect(selected.covered.filter(name => name.includes("omd-code"))).toHaveLength(1)
      expect(selected.covered.filter(name => name.includes("omd-table"))).toHaveLength(1)
      expect(selected.from).toBe(0)
      expect(selected.to).toBe(DOC.length)
      expect(selected.text).toBe(DOC)

      await expectSelectedText(page, regions, theme)

      // Selection is paint only: a click still enters code editing, bytes untouched.
      if (gesture === "a drag across the document") {
        await page.locator(".omd-code-lines .line").first().click()
        await expect(page.locator(".cm-line.omd-codeblock-num").first()).toBeVisible()
      }
      const after = await editorState(page)
      expect(after.doc).toBe(DOC)
      expect(after.changes).toBe(0)
      expect(after.errors).toEqual([])
    })
  }
}

// --- Source-backed selection inside rendered fenced code ---------------------

const CODE_DOC = `Lede paragraph before code.

\`\`\`js
const alpha = "one"
const beta = "two"

const gamma = "three"
\`\`\`

Tail paragraph after code.`

const QUOTED_CODE_DOC = `> Quote before code.
>
> \`\`\`js
> const quoted = "value"
> const second = "line"
> \`\`\`
>
> Quote after code.`

const PLAIN_CODE_DOC = `Plain lede.

\`\`\`not-a-real-language
plain alpha line
plain beta line
plain gamma line
\`\`\`

Plain tail.`

test.use({ permissions: ["clipboard-read", "clipboard-write"] })

/**
 * A pointer position on a character boundary inside the rendered code body.
 * `before` targets the left edge of the character at `column`; `after` targets
 * the right edge, so a drag between the two selects exactly `[start, end)`.
 */
async function codePoint(
  page: Page,
  lineIndex: number,
  column: number,
  side: "before" | "after",
): Promise<{ x: number; y: number }> {
  return page.evaluate(({ lineIndex, column, side }) => {
    const body = document.querySelector(".omd-code-lines")
    if (!body) throw new Error("missing rendered code body")
    const lines = [...body.querySelectorAll(".line")]
    const lineStart = lines.length > 0
      ? lines.slice(0, lineIndex).reduce((sum, line) => sum + (line.textContent?.length ?? 0) + 1, 0)
      : (body.querySelector("pre")?.textContent ?? "").split("\n")
        .slice(0, lineIndex).reduce((sum, line) => sum + line.length + 1, 0)
    const offset = lineStart + (side === "after" ? column - 1 : column)

    const pointAt = (target: number): { node: Text; offset: number } | null => {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      let remaining = target
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text
        if (remaining <= text.data.length) return { node: text, offset: remaining }
        remaining -= text.data.length
      }
      return null
    }
    const from = pointAt(offset)
    const to = pointAt(offset + 1)
    if (!from || !to) throw new Error(`no glyph at line ${lineIndex} column ${column}`)
    const range = document.createRange()
    range.setStart(from.node, from.offset)
    range.setEnd(to.node, to.offset)
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) throw new Error(`zero-sized glyph at ${lineIndex}:${column}`)
    return {
      x: side === "after" ? rect.right - 0.5 : rect.left + 0.5,
      y: rect.top + rect.height / 2,
    }
  }, { lineIndex, column, side })
}

async function openCodeEditor(
  page: Page,
  doc: string,
  highlight: "shiki" | "unknown-lang",
): Promise<void> {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}&theme=light`)
  await expect(page.locator(".omd-code-lines")).toHaveAttribute("data-omd-highlight", highlight)
  await expect(page.locator(".omd-block-covered")).toHaveCount(0)
}

async function dragCode(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
}

/** Browser copy must read the CodeMirror range, never a stale caret or DOM text. */
async function browserCopy(page: Page): Promise<string> {
  await page.keyboard.press("ControlOrMeta+c")
  return page.evaluate(() => navigator.clipboard.readText())
}

/**
 * The gesture's result: exact selection bytes, untouched document, and the drag
 * direction CodeMirror kept (`anchor` is the press, `head` follows the pointer).
 */
async function expectSelection(
  page: Page,
  expected: string,
  doc: string,
  direction: "forward" | "reverse",
): Promise<void> {
  const state = await editorState(page)
  expect(state.text, "selection text").toBe(expected)
  if (direction === "forward") expect(state.anchor, "anchor").toBeLessThan(state.head)
  else expect(state.anchor, "anchor").toBeGreaterThan(state.head)
  expect(state.doc, "document bytes").toBe(doc)
  expect(state.changes, "document mutations").toBe(0)
  expect(state.errors, "harness errors").toEqual([])
  expect(await browserCopy(page), "clipboard bytes").toBe(expected)
}

/**
 * Crop the same revealed source line twice: once over the selected glyphs and once
 * over an unselected run. Both crops share a width so the pixel comparison holds.
 */
async function sourceLineBoxes(
  page: Page,
  lineText: string,
  selected: readonly [number, number],
  unselected: readonly [number, number],
): Promise<{ selected: Box; unselected: Box }> {
  return page.evaluate(({ lineText, selected, unselected }) => {
    const line = [...document.querySelectorAll(".cm-line")]
      .find(candidate => candidate.textContent === lineText)
    if (!line) throw new Error(`missing revealed source line ${lineText}`)
    const boxOf = ([from, to]: readonly [number, number]): Box => {
      const pointAt = (target: number): { node: Text; offset: number } | null => {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
        let remaining = target
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node as Text
          if (remaining <= text.data.length) return { node: text, offset: remaining }
          remaining -= text.data.length
        }
        return null
      }
      const start = pointAt(from)
      const end = pointAt(to)
      if (!start || !end) throw new Error(`no glyphs at ${from}..${to} of ${lineText}`)
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      const { x, y, width, height } = range.getBoundingClientRect()
      return { x, y, width, height }
    }
    return { selected: boxOf(selected), unselected: boxOf(unselected) }
  }, { lineText, selected, unselected })
}

/** A partial selection tints exactly its own glyphs and leaves their neighbours alone. */
async function expectPartialSelectionPaint(
  page: Page,
  boxes: { selected: Box; unselected: Box },
): Promise<void> {
  const tint = await selectionTint(page)
  const width = Math.min(boxes.selected.width, boxes.unselected.width)
  const unselected = await page.screenshot({ clip: { ...boxes.unselected, width } })
  const selected = await page.screenshot({ clip: { ...boxes.selected, width } })
  const stats = await paintStats(page, unselected, selected)
  expect(stats.inkBefore, "unselected glyphs are painted").toBeGreaterThan(40)
  expect(stats.inkAfter, "the selection paint hid the glyphs")
    .toBeGreaterThan(stats.inkBefore * 0.8)
  expect(colorGap(stats.backgroundBefore, stats.backgroundAfter), "only one crop is tinted")
    .toBeGreaterThan(12)
  expect(colorGap(stats.backgroundAfter, tint), "selected crop shows --omd-selection-bg")
    .toBeLessThanOrEqual(24)
}

test("a forward drag inside rendered code selects source bytes", async ({ page }) => {
  await openCodeEditor(page, CODE_DOC, "shiki")
  await dragCode(page, await codePoint(page, 0, 6, "before"), await codePoint(page, 1, 10, "after"))
  await expectSelection(page, 'alpha = "one"\nconst beta', CODE_DOC, "forward")
  // Non-active revealed code lines must also show the selection tint, not hide `.cm-selectionLayer`
  // behind an opaque line background.
  await expectPartialSelectionPaint(
    page,
    await sourceLineBoxes(page, 'const alpha = "one"', [6, 11], [0, 5]),
  )
})

test("a reverse drag inside rendered code selects source bytes", async ({ page }) => {
  await openCodeEditor(page, CODE_DOC, "shiki")
  await dragCode(page, await codePoint(page, 1, 10, "after"), await codePoint(page, 0, 6, "before"))
  await expectSelection(page, 'alpha = "one"\nconst beta', CODE_DOC, "reverse")
})

test("a drag across code lines and an empty line keeps the source gaps", async ({ page }) => {
  await openCodeEditor(page, CODE_DOC, "shiki")
  await dragCode(page, await codePoint(page, 0, 0, "before"), await codePoint(page, 3, 11, "after"))
  await expectSelection(page, 'const alpha = "one"\nconst beta = "two"\n\nconst gamma', CODE_DOC, "forward")
})

test("a drag inside quoted code maps through the quote prefix", async ({ page }) => {
  await openCodeEditor(page, QUOTED_CODE_DOC, "shiki")
  await dragCode(page, await codePoint(page, 0, 6, "before"), await codePoint(page, 1, 10, "after"))
  await expectSelection(page, 'quoted = "value"\n> const seco', QUOTED_CODE_DOC, "forward")
})

test("a drag inside plaintext fallback code selects source bytes", async ({ page }) => {
  await openCodeEditor(page, PLAIN_CODE_DOC, "unknown-lang")
  await dragCode(page, await codePoint(page, 0, 6, "before"), await codePoint(page, 1, 10, "after"))
  await expectSelection(page, "alpha line\nplain beta", PLAIN_CODE_DOC, "forward")
})

// Partial selection inside one rendered code line: the reveal is source-backed, so the
// selected glyphs must be the tinted ones and the rest of the line must stay untinted.
test("a drag inside one rendered code line paints only the selected glyphs", async ({ page }) => {
  await openCodeEditor(page, CODE_DOC, "shiki")
  await dragCode(page, await codePoint(page, 1, 0, "before"), await codePoint(page, 1, 10, "after"))
  await expectSelection(page, "const beta", CODE_DOC, "forward")
  await expect(page.locator(".cm-line.omd-codeblock-num").first()).toBeVisible()
  const boxes = await sourceLineBoxes(page, 'const beta = "two"', [0, 10], [11, 17])
  await expectPartialSelectionPaint(page, boxes)
})

test("a click on rendered code still enters the source editor", async ({ page }) => {
  await openCodeEditor(page, CODE_DOC, "shiki")
  await page.locator(".omd-code-lines .line").nth(1).click()
  await expect(page.locator(".cm-line.omd-codeblock-num").first()).toBeVisible()
  const state = await editorState(page)
  expect(state.from).toBe(state.to)
  expect(state.doc).toBe(CODE_DOC)
  expect(state.changes).toBe(0)
  expect(state.errors).toEqual([])
})

test("a drag from rendered code into a paragraph keeps one source-backed range", async ({ page }) => {
  await openCodeEditor(page, CODE_DOC, "shiki")
  const start = await codePoint(page, 0, 0, "before")
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  // The first move must reveal source-backed lines without aborting the gesture.
  await page.mouse.move(start.x + 8, start.y, { steps: 2 })
  await expect(page.locator(".cm-line.omd-codeblock-num").first()).toBeVisible()
  // The source reveal re-measures the block; let the new height map land before aiming.
  await page.evaluate(() => new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const tail = await page.evaluate(() => {
    const line = [...document.querySelectorAll(".cm-line")]
      .find(candidate => candidate.textContent?.includes("Tail paragraph after code."))
    if (!line) throw new Error("missing tail paragraph")
    const text = line.firstChild
    if (!(text instanceof Text)) throw new Error("tail paragraph has no text node")
    const range = document.createRange()
    range.setStart(text, 16)
    range.setEnd(text, 17)
    const rect = range.getBoundingClientRect()
    return { x: rect.left + 0.5, y: rect.top + rect.height / 2 }
  })
  await page.mouse.move(tail.x, tail.y)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  await page.mouse.up()

  const state = await editorState(page)
  expect(state.text.startsWith("const alpha"), state.text).toBe(true)
  expect(state.text).toContain("Tail paragraph")
  expect(state.doc).toBe(CODE_DOC)
  expect(state.changes).toBe(0)
  expect(await browserCopy(page)).toBe(state.text)
})


// --- Source-backed selection inside a rendered table -------------------------
//
// `TableWidget.nativePointerInteraction` used to open the cell input on mousedown, so a
// drag over rendered cells left `EditorState.selection` on the previous caret and the
// browser copied that stale range. A press must still open the cell session (click), but a
// pointer that travels past the drift threshold has to commit a source-backed range whose
// bytes are the document's own Markdown, including `**`, escaped pipes, and quote prefixes.

const TABLE_DOC = `Lede paragraph before the table.

| Name | Value |
| --- | --- |
| alpha | **bold** |
| esc \\| pipe | 3 |

Tail paragraph after the table.`

const QUOTED_TABLE_DOC = `> Quote lede.
>
> | A | B |
> | --- | --- |
> | 1 | 2 |
>
> Quote tail.`

const RAGGED_TABLE_DOC = `Lede.

| A | B |
| --- | --- |
| 1 |

Tail.`

/** Pointer at the first or last glyph of a rendered cell whose visible text is `text`. */
async function renderedCellPoint(
  page: Page,
  text: string,
  side: "start" | "end",
): Promise<{ x: number; y: number }> {
  return page.evaluate(({ text, side }) => {
    const cell = [...document.querySelectorAll<HTMLElement>(".omd-table th, .omd-table td")]
      .find(candidate => candidate.textContent === text)
    if (!cell) throw new Error(`missing rendered cell ${text}`)
    const nodes: Text[] = []
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (!first || !last) throw new Error(`rendered cell ${text} has no text`)
    const range = document.createRange()
    if (side === "start") {
      range.setStart(first, 0)
      range.setEnd(first, 1)
    } else {
      range.setStart(last, last.data.length - 1)
      range.setEnd(last, last.data.length)
    }
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) throw new Error(`no glyph in ${text}`)
    return {
      x: side === "start" ? rect.left + 0.5 : rect.right - 0.5,
      y: rect.top + rect.height / 2,
    }
  }, { text, side })
}

/** Pointer at a UTF-16 boundary of a rendered line (revealed source or plain paragraph). */
async function linePoint(
  page: Page,
  lineText: string,
  boundary: number,
): Promise<{ x: number; y: number }> {
  return page.evaluate(({ lineText, boundary }) => {
    const line = [...document.querySelectorAll(".cm-line")]
      .find(candidate => candidate.textContent === lineText)
    if (!line) throw new Error(`missing rendered line ${lineText}`)
    const nodes: Text[] = []
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
    const locate = (index: number): { node: Text; offset: number } => {
      let remaining = index
      for (const [position, node] of nodes.entries()) {
        if (remaining < node.data.length) return { node, offset: remaining }
        remaining -= node.data.length
        if (remaining === 0 && position === nodes.length - 1) {
          return { node, offset: node.data.length }
        }
      }
      throw new Error(`line ${lineText} does not reach ${index}`)
    }
    // The boundary before glyph `boundary` is the right edge of glyph `boundary - 1`.
    const point = locate(Math.max(0, boundary - 1))
    const range = document.createRange()
    range.setStart(point.node, point.offset)
    range.setEnd(point.node, point.offset + 1)
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) throw new Error(`no glyph at ${lineText}:${boundary}`)
    return {
      x: boundary <= 0 ? rect.left + 0.5 : rect.right - 0.5,
      y: rect.top + rect.height / 2,
    }
  }, { lineText, boundary })
}

async function openTableEditor(page: Page, doc: string): Promise<void> {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}&theme=light`)
  await expect(page.locator(".omd-table td").first()).toBeVisible()
  await expect(page.locator(".omd-block-covered")).toHaveCount(0)
}

/** Let the reveal's re-measure land before aiming at the newly laid-out source rows. */
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

/**
 * Press a rendered cell and promote the gesture into a selection: the first move past the
 * drift threshold is what turns the rendered projection into visible Markdown rows.
 */
async function pressTableCell(page: Page, start: { x: number; y: number }): Promise<void> {
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 8, start.y + 2, { steps: 2 })
  await expect(page.locator(".omd-table-src").first()).toBeVisible()
  await settle(page)
}

async function finishDrag(page: Page, target: { x: number; y: number }): Promise<void> {
  await page.mouse.move(target.x, target.y, { steps: 10 })
  await page.mouse.up()
}

test("a drag inside one rendered cell selects only its source bytes", async ({ page }) => {
  await openTableEditor(page, TABLE_DOC)
  await pressTableCell(page, await renderedCellPoint(page, "alpha", "start"))
  await finishDrag(page, await linePoint(page, "| alpha | **bold** |", 7))
  await expectSelection(page, "alpha", TABLE_DOC, "forward")
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(0)
})

test("a drag across rendered cells copies markup and escaped pipes", async ({ page }) => {
  await openTableEditor(page, TABLE_DOC)
  await pressTableCell(page, await renderedCellPoint(page, "alpha", "start"))
  await finishDrag(page, await linePoint(page, "| esc \\| pipe | 3 |", 17))
  await expectSelection(page, "alpha | **bold** |\n| esc \\| pipe | 3", TABLE_DOC, "forward")
})

test("a reverse drag ends on the real source boundary of inline markup", async ({ page }) => {
  await openTableEditor(page, TABLE_DOC)
  await pressTableCell(page, await renderedCellPoint(page, "bold", "start"))
  await finishDrag(page, await linePoint(page, "| Name | Value |", 0))
  await expectSelection(page, "| Name | Value |\n| --- | --- |\n| alpha | **", TABLE_DOC, "reverse")
})

test("a drag out of a rendered table into a paragraph keeps one source range", async ({ page }) => {
  await openTableEditor(page, TABLE_DOC)
  await pressTableCell(page, await renderedCellPoint(page, "alpha", "start"))
  await finishDrag(page, await linePoint(page, "Tail paragraph after the table.", 4))
  await expectSelection(
    page,
    "alpha | **bold** |\n| esc \\| pipe | 3 |\n\nTail",
    TABLE_DOC,
    "forward",
  )
})

test("a drag from a quoted table maps through the quote prefixes", async ({ page }) => {
  await openTableEditor(page, QUOTED_TABLE_DOC)
  await pressTableCell(page, await renderedCellPoint(page, "A", "start"))
  await finishDrag(page, await linePoint(page, "Quote tail.", 5))
  await expectSelection(
    page,
    "A | B |\n> | --- | --- |\n> | 1 | 2 |\n>\n> Quote",
    QUOTED_TABLE_DOC,
    "forward",
  )
})

test("a ragged table's synthesized cell cannot invent a selection", async ({ page }) => {
  await openTableEditor(page, RAGGED_TABLE_DOC)
  const missing = await page.locator(".omd-table-cell-missing").first().boundingBox()
  if (!missing) throw new Error("missing ragged cell box")
  await page.mouse.move(missing.x + missing.width / 2, missing.y + missing.height / 2)
  await page.mouse.down()
  await page.mouse.move(missing.x + missing.width / 2 + 30, missing.y + missing.height / 2, { steps: 6 })
  await page.mouse.up()
  const state = await editorState(page)
  expect(state.text, "selection text").toBe("")
  expect(state.doc, "document bytes").toBe(RAGGED_TABLE_DOC)
  expect(state.changes, "document mutations").toBe(0)
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(0)
  await expect(page.locator(".omd-table-src")).toHaveCount(0)
})

test("a drag from a real cell across a ragged tail keeps real source bytes", async ({ page }) => {
  await openTableEditor(page, RAGGED_TABLE_DOC)
  await pressTableCell(page, await renderedCellPoint(page, "1", "start"))
  await finishDrag(page, await linePoint(page, "Tail.", 4))
  await expectSelection(page, "1 |\n\nTail", RAGGED_TABLE_DOC, "forward")
})

test("keyboard navigation extends the table's source-backed selection", async ({ page }) => {
  await openTableEditor(page, TABLE_DOC)
  await pressTableCell(page, await renderedCellPoint(page, "alpha", "start"))
  await finishDrag(page, await linePoint(page, "| alpha | **bold** |", 7))
  await expectSelection(page, "alpha", TABLE_DOC, "forward")
  await page.keyboard.press("Shift+ArrowRight")
  const state = await editorState(page)
  expect(state.text).toBe("alpha ")
  expect(state.doc).toBe(TABLE_DOC)
})

test("a click still opens the cell input without revealing source", async ({ page }) => {
  await openTableEditor(page, TABLE_DOC)
  await page.locator(".omd-table tbody td").first().click()
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(1)
  await expect(page.locator(".omd-table-src")).toHaveCount(0)
  const opened = await editorState(page)
  expect(opened.text).toBe("")
  expect(opened.doc).toBe(TABLE_DOC)
  expect(opened.changes).toBe(0)
  await page.keyboard.press("Escape")
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(0)
  await expect(page.locator(".omd-table table")).toBeVisible()
})
