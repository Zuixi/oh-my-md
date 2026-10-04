import { expect, test, type Page } from "@playwright/test"

// Real-browser coverage for the engine-owned Markdown-aware auto pair
// (`packages/engine/src/format/autoPair.ts`; spec 2026-10-02-auto-pair-design §4, §6).
//
// The unit suite (`test/autoPair.test.ts`) owns the per-character × gating × context
// matrix and `test/autoPairView.test.ts` owns the input-handler facet wiring. What only
// a real Chromium can add, and what these specs assert:
//   - the real DOM input pipeline (`inputHandler` + keymap precedence) for a typed key,
//   - caret geometry through the Route-A folded-marker decorations,
//   - the block-structure consequences (list mark, MathBlock) on a parsed document,
//   - the `EditorView.inputHandler` facet chain as Chromium actually calls it.
//
// Deliberately NO multi-cursor case: nothing enables `EditorState.allowMultipleSelections`,
// so CM6 collapses multi-range selections and an Alt+Click scenario would test nothing
// (controller ruling R6); the D10 semantics stay with the engine view tests.

const MOD = process.platform === "darwin" ? "Meta" : "Control"

async function open(page: Page, doc: string, extra = ""): Promise<void> {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}${extra}`)
}

function docOf(page: Page): Promise<string> {
  return page.evaluate(() => window.__view.state.doc.toString())
}

function caretOf(page: Page): Promise<number> {
  return page.evaluate(() => window.__view.state.selection.main.head)
}

function placeCaret(page: Page, pos: number): Promise<void> {
  return page.evaluate(p => {
    window.__view.dispatch({ selection: { anchor: p } })
    window.__view.focus()
  }, pos)
}

/**
 * Live decorations are seeded and drained from an idle-sliced driver (engine AGENTS
 * invariant 3a), so structural negatives need the pending build flushed first.
 * The `$$` control test below runs the same settle and asserts the widget DID mount,
 * which is what keeps this window honest.
 */
function settle(page: Page): Promise<void> {
  return page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80)))
  }))
}

test("prose: each pair opens with the caret between and keeps typing in place", async ({ page }) => {
  const cases = [
    { open: "(", close: ")", typed: "(x)" },
    { open: "*", close: "*", typed: "*x*" },
    { open: "`", close: "`", typed: "`x`" },
    { open: '"', close: '"', typed: '"x"' },
  ]
  for (const pair of cases) {
    await open(page, "hello ")
    await page.keyboard.type(pair.open)
    expect(await docOf(page), `${pair.open} should insert its closer`).toBe(`hello ${pair.open}${pair.close}`)
    expect(await caretOf(page), `${pair.open} caret between the halves`).toBe(7)
    // The next character lands inside the pair, not after the closer.
    await page.keyboard.type("x")
    expect(await docOf(page)).toBe(`hello ${pair.typed}`)
    expect(await caretOf(page)).toBe(8)
    expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
  }
})

test("prose: the closer typed before an auto-inserted one skips instead of inserting", async ({ page }) => {
  await open(page, "hello ")
  await page.keyboard.type("(")
  expect(await docOf(page)).toBe("hello ()")
  await page.keyboard.type(")")
  expect(await docOf(page), "the auto-inserted ) must be skipped, not doubled").toBe("hello ()")
  expect(await caretOf(page)).toBe(8)
  await page.keyboard.type("x")
  expect(await docOf(page), "typing continues after the skipped closer").toBe("hello ()x")
})

test("prose: Backspace between a fresh pair empties it in one keystroke", async ({ page }) => {
  await open(page, "")
  await page.keyboard.type("(")
  expect(await docOf(page)).toBe("()")
  await page.keyboard.press("Backspace")
  expect(await docOf(page)).toBe("")
  expect(await caretOf(page)).toBe(0)
})

test("prose: one Undo after a paired insert leaves the document empty", async ({ page }) => {
  await open(page, "")
  await page.keyboard.type("(")
  expect(await docOf(page)).toBe("()")
  await page.keyboard.press(`${MOD}+z`)
  expect(await docOf(page), "the pair is one transaction, so one Undo clears both halves").toBe("")
})

test("prose: typing *x* keeps the caret visible and can continue (folded-marker regression)", async ({ page }) => {
  await open(page, "hello ")
  // Caret at document position 8 = the left edge of the folding closing `*` at [8,9).
  await page.keyboard.type("*x")
  expect(await docOf(page)).toBe("hello *x*")
  expect(await caretOf(page)).toBe(8)
  // Route A folds the paired emphasis marks unconditionally, so the line renders as
  // the text alone — the state where the reported caret became invisible.
  await expect.poll(() => page.locator(".cm-line").first().innerText()).toBe("hello x")
  const atFoldBoundary = await page.evaluate(() => {
    const head = window.__view.state.selection.main.head
    const rect = document.querySelector(".cm-cursor-primary")?.getBoundingClientRect()
    return { head, coords: window.__view.coordsAtPos(head), width: rect?.width ?? 0, height: rect?.height ?? 0 }
  })
  expect(atFoldBoundary.head).toBe(8)
  expect(atFoldBoundary.coords, "no caret coordinates at the fold boundary").not.toBeNull()
  expect(atFoldBoundary.width, "zero-width caret at the fold boundary").toBeGreaterThan(0)
  expect(atFoldBoundary.height).toBeGreaterThan(4)

  // Closing the emphasis type-overs the auto-inserted marker, then typing appends in
  // place and the caret stays on screen.
  await page.keyboard.type("*!")
  expect(await docOf(page)).toBe("hello *x*!")
  const afterClosing = await page.evaluate(() => {
    const head = window.__view.state.selection.main.head
    const rect = document.querySelector(".cm-cursor-primary")?.getBoundingClientRect()
    return { head, coords: window.__view.coordsAtPos(head), width: rect?.width ?? 0 }
  })
  expect(afterClosing.head).toBe(10)
  expect(afterClosing.coords).not.toBeNull()
  expect(afterClosing.width).toBeGreaterThan(0)
})

test("fence: foo({a: \"b\"}) types with zero manual closers, and markers stay literal", async ({ page }) => {
  await open(page, "```\n\n```")
  await placeCaret(page, 4) // the empty content line
  // Brackets and quotes pair inside a fence (T1 keeps its context, D5); `}`, `"` and `)`
  // are each skipped over the auto-inserted closer, so the exact text arrives with no
  // hand-typed closer at all.
  await page.keyboard.type('foo({a: "b"})')
  expect(await docOf(page)).toBe('```\nfoo({a: "b"})\n```')
  // §6.2 / D12 in a fence: the marker tier is suppressed (inVerbatim), so `*` is one
  // literal character — no `**` pair.
  await page.keyboard.type("*")
  expect(await docOf(page)).toBe('```\nfoo({a: "b"})*\n```')
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("fence: a marker before an existing closing marker inserts instead of skipping (D12)", async ({ page }) => {
  await open(page, "```\n`x`\n```")
  await placeCaret(page, 6) // right before the existing closing backtick
  await page.keyboard.type("`")
  expect(await docOf(page), "D12: inside a fence ` is a literal, never a type-over candidate")
    .toBe("```\n`x``\n```")
  expect(await caretOf(page)).toBe(7)

  // `$` is the same shape of trap.
  await open(page, "```\n$x$\n```")
  await placeCaret(page, 6)
  await page.keyboard.type("$")
  expect(await docOf(page)).toBe("```\n$x$$\n```")
  expect(await caretOf(page)).toBe(7)

  // Control: the same keystroke in prose *does* pair, so the fence result comes from
  // the verbatim context and not from a handler that was never reached.
  await open(page, "hello ")
  await page.keyboard.type("`")
  expect(await docOf(page)).toBe("hello ``")
})

test("empty line: * does not become a list item marker and $ does not open a MathBlock", async ({ page }) => {
  await open(page, "Intro.\n\nOutro.")
  await placeCaret(page, 7) // the empty line
  await page.keyboard.type("*")
  expect(await docOf(page), "rule 2b: no auto closer on an empty line").toBe("Intro.\n*\nOutro.")
  await page.keyboard.type(" ")
  expect(await docOf(page), "must never grow into a `* *` list item").toBe("Intro.\n* \nOutro.")
  // The paragraph below is still its own rendered line, not swallowed by a block.
  await expect(page.locator(".cm-line", { hasText: "Outro." })).toHaveCount(1)
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])

  // `$` on an empty line: pairing here would produce `$$` and parse/math.ts would take it
  // as a MathBlock that swallows to EOF.
  await open(page, "Intro.\n\nOutro.")
  await placeCaret(page, 7)
  await page.keyboard.type("$")
  expect(await docOf(page)).toBe("Intro.\n$\nOutro.")
  // Move the caret out of the line: while the caret is inside a MathBlock the engine keeps
  // it in source (blockSelected), so an out-of-block caret is what would force a widget.
  await placeCaret(page, 0)
  await settle(page)
  expect(await page.locator(".omd-math").count(), "a MathBlock swallowed the rest of the document").toBe(0)
  await expect(page.locator(".cm-line", { hasText: "Outro." })).toHaveCount(1)
})

test("empty line: a real $$ block does mount the MathBlock widget the assertion above looks for", async ({ page }) => {
  await open(page, "Intro.\n\n$$\nE = mc^2\n$$\n\nOutro.")
  // The harness caret rests at the document end, i.e. outside the block.
  await settle(page)
  expect(await page.locator(".omd-math").count(), "control: the .omd-math locator never matches").toBe(1)
  await expect(page.locator(".omd-math")).toBeVisible()
})

test("empty line: ` still pairs at the line start (D11)", async ({ page }) => {
  await open(page, "Intro.\n\nOutro.")
  await placeCaret(page, 7)
  await page.keyboard.type("`")
  expect(await docOf(page), "the line-start inline-code path is not suppressed").toBe("Intro.\n``\nOutro.")
  expect(await caretOf(page)).toBe(8)
})

test("CJK: ( before an existing ，pairs and the text lands between the halves (D8)", async ({ page }) => {
  await open(page, "这是测试，")
  await placeCaret(page, 4) // before `，`
  await page.keyboard.type("(")
  expect(await docOf(page)).toBe("这是测试()，")
  expect(await caretOf(page)).toBe(5)
  await page.keyboard.type("x")
  expect(await docOf(page)).toBe("这是测试(x)，")
})

test("CJK: an IME composition inserts a paired key literally and commits with no stray closer", async ({ page }) => {
  await open(page, "")
  // No real IME exists in headless Chromium, so the composition itself is driven through
  // CDP; the keystroke and the commit below go through the normal input pipeline.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Input.imeSetComposition", { text: "zhe shi ce shi", selectionStart: 14, selectionEnd: 14 })
  // §4.5 guards on `view.composing || view.compositionStarted`. Assert both, otherwise
  // "no stray closer" would prove nothing about the composition path.
  await expect.poll(() => page.evaluate(() => window.__view.compositionStarted && window.__view.composing))
    .toBe(true)
  await page.keyboard.type("(")
  const during = await docOf(page)
  expect(during.endsWith("("), "the paired key must be inserted literally while composing").toBe(true)
  expect(during, "§4.5: a composition must never pair").not.toContain(")")
  // Committing the candidate replaces the preedit with the chosen text.
  await cdp.send("Input.insertText", { text: "这是测试" })
  await expect.poll(() => page.evaluate(() => window.__view.composing)).toBe(false)
  const committed = await docOf(page)
  expect(committed, "the committed candidate replaces the preedit").toContain("这是测试")
  expect(committed.endsWith("(")).toBe(true)
  expect(committed, "no stray closer after the commit either").not.toContain(")")
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})

test("toggles: each switch disables only its own characters", async ({ page }) => {
  // quotes off: `"` is literal, brackets still pair.
  await open(page, "hello ", "&apQuotes=0")
  await page.keyboard.type('"')
  expect(await docOf(page)).toBe('hello "')
  await page.keyboard.type("(")
  expect(await docOf(page)).toBe('hello "()')

  // brackets off: `(` is literal, markers still pair.
  await open(page, "hello ", "&apBrackets=0")
  await page.keyboard.type("(")
  expect(await docOf(page)).toBe("hello (")
  await page.keyboard.type("*")
  expect(await docOf(page)).toBe("hello (**")

  // markdown syntax off: the markers are literal, brackets still pair.
  await open(page, "hello ", "&apMarkdown=0")
  await page.keyboard.type("*")
  expect(await docOf(page)).toBe("hello *")
  await page.keyboard.type("`")
  expect(await docOf(page)).toBe("hello *`")
  await page.keyboard.type("$")
  expect(await docOf(page)).toBe("hello *`$")
  await page.keyboard.type("(")
  expect(await docOf(page)).toBe("hello *`$()")
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})
