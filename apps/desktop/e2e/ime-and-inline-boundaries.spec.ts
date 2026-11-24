import { expect, test, type Page } from "@playwright/test"

// Real-browser proof for the two input paths happy-dom cannot model:
//  - CJK IME composition inside live-preview marks (a composition update must
//    replace the preedit, never duplicate it or collapse the formatting), and
//  - caret geometry when walking across hidden Markdown syntax (`**bold**`,
//    `[link](url)`, `` `code` ``) plus Backspace deleting exactly the source
//    character before the caret.
const inflate = (markdown: string) => encodeURIComponent(markdown)

const open = async (page: Page, markdown: string) => {
  await page.goto(`/e2e/harness.html?doc=${inflate(markdown)}`)
  await page.waitForFunction(() => typeof window.__docText === "function")
}

const docText = (page: Page) => page.evaluate(() => window.__docText())

const caretAt = async (page: Page, anchor: number) => {
  await page.evaluate(position => {
    window.__view.dispatch({ selection: { anchor: position } })
    window.__view.focus()
  }, anchor)
}

const head = (page: Page) => page.evaluate(() => window.__view.state.selection.main.head)

const caretBox = async (page: Page) => {
  const box = await page.locator(".cm-cursor").first().boundingBox()
  expect(box).not.toBeNull()
  return box!
}

test("commits a CJK composition inside a heading exactly once", async ({ page }) => {
  await open(page, "# ")
  await caretAt(page, 2)
  const client = await page.context().newCDPSession(page)

  // Real composition events: Chromium turns imeSetComposition into
  // compositionstart/compositionupdate on the focused contenteditable.
  await client.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 })
  expect(await docText(page)).toBe("# zhong")
  // Mid-composition the heading is still a heading: no premature collapse.
  await expect(page.locator(".cm-line.omd-h1")).toHaveCount(1)

  await client.send("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 })
  expect(await docText(page)).toBe("# 中文")

  await client.send("Input.insertText", { text: "中文" })
  expect(await docText(page)).toBe("# 中文")
  await expect(page.locator(".cm-line.omd-h1")).toHaveCount(1)
  expect(await head(page)).toBe(4)
})

test("commits a CJK composition inside bold without duplicating text", async ({ page }) => {
  await open(page, "**abcd** tail")
  await caretAt(page, 2)
  const client = await page.context().newCDPSession(page)

  await client.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 })
  expect(await docText(page)).toBe("**zhongabcd** tail")

  await client.send("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 })
  // The preedit is replaced, and both delimiters survive the composition.
  expect(await docText(page)).toBe("**中文abcd** tail")

  await client.send("Input.insertText", { text: "中文" })
  expect(await docText(page)).toBe("**中文abcd** tail")
  // The caret is still inside the bold run, so the mark never folded mid-edit.
  expect(await head(page)).toBe(4)
})

test("keeps the caret visible and ordered while walking hidden syntax", async ({ page }) => {
  const doc = "**bold** [link](https://example.com) `code`"
  await open(page, doc)
  await caretAt(page, 0)

  const samples: Array<{ head: number; x: number; y: number; height: number }> = []
  for (let press = 0; press <= doc.length; press += 1) {
    const box = await caretBox(page)
    samples.push({ head: await head(page), x: box.x, y: box.y, height: box.height })
    await page.keyboard.press("ArrowRight")
  }

  // Every stop has a drawable caret on the same visual line. Compare centers:
  // inline-code padding makes the bar slightly shorter, not a different line.
  const firstCenter = samples[0]!.y + samples[0]!.height / 2
  for (const sample of samples) {
    expect(sample.height).toBeGreaterThan(0)
    expect(Math.abs(sample.y + sample.height / 2 - firstCenter)).toBeLessThanOrEqual(2)
  }

  // Head never goes backwards and the walk ends at the document end. Hidden
  // mark pairs are atomic (the closing `**` is skipped), so steps are 1 or 2.
  let previous = 0
  for (const sample of samples) {
    expect(sample.head).toBeGreaterThanOrEqual(previous)
    expect(sample.head - previous).toBeLessThanOrEqual(2)
    previous = sample.head
  }
  expect(samples.at(-1)!.head).toBe(doc.length)

  // Inside the revealed link target every press moves the caret rightwards.
  const inLink = samples.filter(sample => sample.head >= 19 && sample.head <= 34)
  expect(inLink.length).toBeGreaterThan(10)
  for (let index = 1; index < inLink.length; index += 1) {
    expect(inLink[index]!.x).toBeGreaterThanOrEqual(inLink[index - 1]!.x - 0.5)
  }

  // Walking back left keeps the caret drawable and strictly decreasing.
  let lastHead = await head(page)
  for (let press = 0; press < 6; press += 1) {
    await page.keyboard.press("ArrowLeft")
    const next = await head(page)
    expect(next).toBeLessThan(lastHead)
    expect(lastHead - next).toBeLessThanOrEqual(2)
    expect((await caretBox(page)).height).toBeGreaterThan(0)
    lastHead = next
  }
})

test("Backspace at inline boundaries deletes exactly the character before the caret", async ({ page }) => {
  const doc = "**bold** [link](https://example.com) `code`"
  const cases: Array<{ caret: number; expected: string; label: string }> = [
    { caret: 6, expected: "**bol** [link](https://example.com) `code`", label: "end of the bold word" },
    { caret: 13, expected: "**bold** [lik](https://example.com) `code`", label: "inside the link label" },
    { caret: 40, expected: "**bold** [link](https://example.com) `cde`", label: "inside inline code" },
  ]
  for (const scenario of cases) {
    await open(page, doc)
    await caretAt(page, scenario.caret)
    expect(await head(page)).toBe(scenario.caret)

    await page.keyboard.press("Backspace")

    expect(await docText(page), scenario.label).toBe(scenario.expected)
    expect(await head(page), scenario.label).toBe(scenario.caret - 1)
  }
})
