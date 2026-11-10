import { expect, test, type Page } from "@playwright/test"

declare global {
  interface Window {
    __roView?: ReturnType<typeof import("../src/Editor").createEditor>
    __roChanges?: number
    __roErrors?: string[]
  }
}

// Stage-3 acceptance gaps for table selection, kept in a focused file so the paint/geometry
// spec stays under the module-size limit. Every assertion here is about document bytes:
// what the browser copies, what `state.doc` holds, and whether the cell input is mounted.
//
// The fixtures are real Markdown shapes the engine actually renders (verified against the
// live DOM before asserting): a read-only editor, a table without outer pipes, a row with an
// extra (unrendered) cell, and a table nested in a list item. A shape that never mounts must
// fail loudly instead of asserting imagined behavior — `openTable`/`mountReadOnly` assert the
// rendered cells before any gesture runs.

type Point = { readonly x: number; readonly y: number }

/** Pointer at the first or last glyph of a rendered cell whose visible text is `text`. */
async function cellPoint(page: Page, text: string, side: "start" | "end"): Promise<Point> {
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
async function linePoint(page: Page, lineText: string, boundary: number): Promise<Point> {
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

/** Let the reveal's re-measure land before aiming at the newly laid-out source rows. */
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

interface EditorSnapshot {
  readonly from: number
  readonly to: number
  readonly anchor: number
  readonly head: number
  readonly text: string
  readonly doc: string
  readonly readOnly: boolean
  readonly changes: number
}

/** State of the harness editor (`__view`) or of the read-only editor the spec mounts. */
async function editorState(page: Page, globalName: "__view" | "__roView" = "__view"): Promise<EditorSnapshot> {
  return page.evaluate((name: string) => {
    const view = name === "__roView" ? window.__roView : window.__view
    if (!view) throw new Error(`missing ${name}`)
    const { from, to, anchor, head } = view.state.selection.main
    return {
      from,
      to,
      anchor,
      head,
      text: view.state.doc.sliceString(from, to),
      doc: view.state.doc.toString(),
      readOnly: view.state.readOnly,
      changes: name === "__roView"
        ? (window.__roChanges ?? 0)
        : window.__docChangeCount,
    }
  }, globalName)
}

async function openTable(page: Page, doc: string): Promise<void> {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}&theme=light`)
  await expect(page.locator(".omd-table td").first()).toBeVisible()
  await expect(page.locator(".omd-block-covered")).toHaveCount(0)
}

/**
 * Mount the shipped desktop editor in read-only mode (`HUGE` scale mode). The harness only
 * builds editable editors, so the spec mounts a second real `EditorView` through the same
 * Vite module the page already loaded — no fake read-only shim.
 */
async function mountReadOnly(page: Page, doc: string): Promise<void> {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}&theme=light`)
  const readOnly = await page.evaluate(async (source: string) => {
    const mod = await import("/src/Editor.ts")
    const host = document.createElement("div")
    host.className = "editor-host"
    document.body.replaceChildren(host)
    const view = mod.createEditor(host, {
      doc: source,
      tabId: 1,
      documentId: 1,
      readOnly: true,
      getDocPath: () => null,
      getDocumentId: () => 1,
      experimentalTableDirectEdit: true,
      onDocumentUpdate: () => {
        window.__roChanges = (window.__roChanges ?? 0) + 1
      },
      onError: (message: string) => {
        window.__roErrors = [...(window.__roErrors ?? []), message]
      },
    })
    window.__roView = view
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    view.focus()
    return view.state.readOnly
  }, doc)
  expect(readOnly, "read-only editor state").toBe(true)
  await expect(page.locator(".omd-table td").first()).toBeVisible()
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(0)
}

async function pressCell(page: Page, start: Point): Promise<void> {
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 8, start.y + 2, { steps: 2 })
  await settle(page)
}

async function dragTo(page: Page, target: Point): Promise<void> {
  await page.mouse.move(target.x, target.y, { steps: 10 })
  await page.mouse.up()
}

/** Browser copy must read the CodeMirror range, never a stale caret or DOM text. */
async function browserCopy(page: Page): Promise<string> {
  await page.keyboard.press("ControlOrMeta+c")
  return page.evaluate(() => navigator.clipboard.readText())
}

async function expectSelection(
  page: Page,
  expected: string,
  doc: string,
  globalName: "__view" | "__roView" = "__view",
): Promise<void> {
  const state = await editorState(page, globalName)
  expect(state.text, "selection text").toBe(expected)
  expect(state.anchor, "anchor").toBeLessThan(state.head)
  expect(state.doc, "document bytes").toBe(doc)
  expect(state.changes, "document mutations").toBe(0)
  expect(await browserCopy(page), "clipboard bytes").toBe(expected)
}

test.use({ permissions: ["clipboard-read", "clipboard-write"] })

// --- Read-only tables -------------------------------------------------------

const READ_ONLY_DOC = `Lede paragraph.

| Name | Value |
| --- | --- |
| alpha | **bold** |
| esc \\| pipe | 3 |

Tail paragraph.`

test("read-only: a drag inside a rendered cell copies exactly its source bytes", async ({ page }) => {
  await mountReadOnly(page, READ_ONLY_DOC)
  await pressCell(page, await cellPoint(page, "alpha", "start"))
  // Read-only presses have no cell session to open: the drift threshold itself promotes the
  // rendered table into Markdown rows.
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(0)
  await expect(page.locator(".omd-table-src").first()).toBeVisible()
  await dragTo(page, await linePoint(page, "| alpha | **bold** |", 7))

  const state = await editorState(page, "__roView")
  expect(state.readOnly).toBe(true)
  expect(state.text).toBe("alpha")
  expect(state.doc).toBe(READ_ONLY_DOC)
  // Promotion focuses the editor: a read-only gesture has no input to hold focus.
  await expect(page.locator(".cm-content")).toBeFocused()
  expect(state.changes, "document mutations").toBe(0)
  expect(await browserCopy(page)).toBe("alpha")
  expect(await page.evaluate(() => window.__roErrors ?? [])).toEqual([])
})

test("read-only: a press without travel opens nothing and selects nothing", async ({ page }) => {
  await mountReadOnly(page, READ_ONLY_DOC)
  const start = await cellPoint(page, "alpha", "start")
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  // Below the drift threshold this is still a click on the rendered cell.
  await page.mouse.move(start.x + 2, start.y + 1, { steps: 2 })
  await page.mouse.up()
  const state = await editorState(page, "__roView")
  expect(state.text).toBe("")
  expect(state.doc).toBe(READ_ONLY_DOC)
  await expect(page.locator(".omd-table-cell-input")).toHaveCount(0)
  // No promotion: the projection is still the rendered table, not revealed source rows.
  await expect(page.locator(".omd-table-src")).toHaveCount(0)
  await expect(page.locator(".omd-table tbody td").first()).toBeVisible()
})

// --- Noncanonical tables ----------------------------------------------------

const NO_OUTER_PIPES_DOC = `Lede paragraph.

Name | Value
--- | ---
alpha | **bold**

Tail paragraph.`

test("a table without outer pipes still maps a rendered cell onto its source", async ({ page }) => {
  await openTable(page, NO_OUTER_PIPES_DOC)
  await expect(page.locator(".omd-table th").first()).toHaveText("Name")
  await pressCell(page, await cellPoint(page, "alpha", "start"))
  await dragTo(page, await linePoint(page, "Tail paragraph.", 4))
  await expectSelection(page, "alpha | **bold**\n\nTail", NO_OUTER_PIPES_DOC)
})

const EXTRA_CELL_DOC = `Lede paragraph.

| A | B |
| --- | --- |
| 1 | 2 | 3 |

Tail paragraph.`

test("a spanning drag keeps the bytes of an unrendered extra cell", async ({ page }) => {
  await openTable(page, EXTRA_CELL_DOC)
  // The third cell has no rendered counterpart (the engine drops it from the model), so the
  // fixture only works if the table really mounted with the two visible cells.
  await expect(page.locator(".omd-table tbody td")).toHaveCount(2)
  await pressCell(page, await cellPoint(page, "1", "start"))
  await dragTo(page, await linePoint(page, "Tail paragraph.", 4))
  // Bytes between visible glyphs belong to a selection that spans them: the hidden `| 3 `
  // is real document text between the rendered `2` and the tail.
  await expectSelection(page, "1 | 2 | 3 |\n\nTail", EXTRA_CELL_DOC)
})

// --- Table nested in a list item -------------------------------------------

const LIST_TABLE_DOC = `Lede paragraph.

- item before

- | A | B |
  | --- | --- |
  | alpha | 1 |

Tail paragraph.`

test("a table inside a list item selects its nested source bytes", async ({ page }) => {
  await openTable(page, LIST_TABLE_DOC)
  // The table is genuinely nested: its cells render under the list item's line.
  await expect(page.locator(".omd-table tbody td")).toHaveCount(2)
  await pressCell(page, await cellPoint(page, "alpha", "start"))
  await expect(page.locator(".omd-table-src").first()).toBeVisible()
  await dragTo(page, await linePoint(page, "Tail paragraph.", 4))
  await expectSelection(page, "alpha | 1 |\n\nTail", LIST_TABLE_DOC)
})

// --- Typing into the cell input after a click -------------------------------

const EDIT_DOC = `Lede paragraph.

| Left | Middle | Right |
| --- | :---: | ---: |
| alpha | beta | gamma |

Tail paragraph.`

/** `EDIT_DOC` after typing ` ch` at the end of the `beta` cell. */
const TYPED_DOC = `Lede paragraph.

| Left | Middle | Right |
| --- | :---: | ---: |
| alpha | beta ch  | gamma |

Tail paragraph.`

/** `EDIT_DOC` after an IME composition replaces the `beta` cell. */
const COMPOSED_DOC = `Lede paragraph.

| Left | Middle | Right |
| --- | :---: | ---: |
| alpha | beta composed | gamma |

Tail paragraph.`

test("typing after a cell click commits the input and keeps the table toolbar live", async ({ page }) => {
  await openTable(page, EDIT_DOC)
  const beta = await cellPoint(page, "beta", "start")
  await page.mouse.click(beta.x, beta.y)
  const input = page.locator(".omd-table-cell-input")
  await expect(input).toHaveCount(1)
  await expect(input).toBeFocused()
  // The center-aligned column is the hovered one, so the toolbar targets it and is usable.
  const alignCenter = page.locator(".omd-table-toolbar [data-act='align-center']")
  await expect(alignCenter).toHaveClass(/omd-table-tool-active/)
  await expect(alignCenter).toBeEnabled()

  await page.keyboard.press("End")
  await page.keyboard.type(" ch")
  // Every keystroke commits the input value into the cell's own source bytes; the first edit
  // normalizes the row's column padding, so the exact document is the regression contract.
  const typed = await editorState(page)
  expect(typed.doc).toBe(TYPED_DOC)
  expect(typed.changes).toBeGreaterThan(0)
  await expect(page.locator(".omd-table-toolbar")).toBeVisible()
  await expect(alignCenter).toBeEnabled()

  await page.keyboard.press("Escape")
  await expect(input).toHaveCount(0)
  await expect(page.locator(".omd-table td").filter({ hasText: "beta ch" })).toHaveCount(1)
})

test("IME composition does not commit until compositionend", async ({ page }) => {
  await openTable(page, EDIT_DOC)
  const beta = await cellPoint(page, "beta", "start")
  await page.mouse.click(beta.x, beta.y)
  const input = page.locator(".omd-table-cell-input")
  await expect(input).toBeFocused()

  await input.evaluate((element: HTMLInputElement) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
    element.value = "beta composed"
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true, isComposing: true, inputType: "insertCompositionText",
    }))
  })
  const composing = await editorState(page)
  expect(composing.doc, "composition draft must stay out of the document").toBe(EDIT_DOC)
  // A structural toolbar edit is refused while the draft is uncommitted, so the composed
  // text cannot be overwritten by a rewrite based on the stale source.
  await page.locator(".omd-table-toolbar [data-act='align-left']").click()
  expect((await editorState(page)).doc, "toolbar op during composition").toBe(EDIT_DOC)

  await expect(input).toHaveValue("beta composed")
  await input.evaluate((element: HTMLInputElement) => {
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: element.value }))
  })
  const composed = await editorState(page)
  expect(composed.doc).toBe(COMPOSED_DOC)
  // The composed text survives the commit: closing the session shows it in the projection.
  await page.keyboard.press("Escape")
  await expect(page.locator(".omd-table td").filter({ hasText: "beta composed" })).toHaveCount(1)
})
