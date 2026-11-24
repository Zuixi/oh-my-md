import { expect, test, type Page } from "@playwright/test"

// Real-browser proof of the overlay ergonomics that happy-dom cannot see:
//  - Tab / Shift+Tab cycle inside the dialog instead of escaping to the shell,
//  - the shell is genuinely `inert` (not just aria-hidden),
//  - Escape closes and returns focus to the opener,
//  - an Enter that commits an IME composition never runs the active command.
const HARNESS = "/e2e/overlay-harness.html"

const openPalette = async (page: Page) => {
  await page.goto(HARNESS)
  await page.getByRole("button", { name: "Open palette" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  return dialog
}

test("traps Tab inside the dialog and marks the shell inert", async ({ page }) => {
  await openPalette(page)

  const input = page.getByRole("combobox")
  await expect(input).toBeFocused()
  // The shell is inert, not merely dimmed: Chromium refuses to focus it.
  await expect(page.locator(".workspace-body")).toHaveAttribute("inert", "")
  await expect(page.locator(".topbar")).toHaveAttribute("inert", "")

  // Palette rows are tabindex="-1", so the only stop is the combobox itself.
  await page.keyboard.press("Tab")
  await expect(input).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  await expect(input).toBeFocused()

  const outsideReachable = await page.evaluate(() => {
    const outside = [...document.querySelectorAll("button")].find(b => b.textContent === "Outside action")
    outside?.focus()
    return document.activeElement === outside
  })
  expect(outsideReachable).toBe(false)
})

test("closes on Escape and hands focus back to the opener", async ({ page }) => {
  await openPalette(page)

  await page.keyboard.press("Escape")

  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.locator(".workspace-body")).not.toHaveAttribute("inert", "")
  await expect(page.getByRole("button", { name: "Open palette" })).toBeFocused()
})

test("an IME-composing Enter does not execute the active command", async ({ page }) => {
  await openPalette(page)
  const input = page.getByRole("combobox")
  await expect(input).toBeFocused()

  const client = await page.context().newCDPSession(page)
  // Real composition: Chromium fires compositionstart/update for this text.
  await client.send("Input.imeSetComposition", { text: "阿", selectionStart: 1, selectionEnd: 1 })
  await expect(input).toHaveValue("阿")
  // Key events that commit a composition report keyCode 229.
  await client.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
    key: "Enter",
    code: "Enter",
  })
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
    key: "Enter",
    code: "Enter",
  })

  expect(await page.evaluate(() => window.__ranCommands)).toEqual([])
  await expect(page.getByRole("dialog")).toBeVisible()

  // Committing the composition and pressing Enter does run the active row.
  await client.send("Input.insertText", { text: "" })
  await page.keyboard.press("Enter")
  expect(await page.evaluate(() => window.__ranCommands)).toEqual(["alpha"])
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

// --------------------------------------------------------------------------
// File tree: WAI-ARIA tree navigation and the viewport-clamped context menu.
// --------------------------------------------------------------------------

const FILES_HARNESS = "/e2e/filetree-harness.html"

test("walks the file tree with the arrow keys", async ({ page }) => {
  await page.goto(FILES_HARNESS)
  const drafts = page.getByRole("treeitem", { name: "drafts", exact: true })
  await expect(drafts).toHaveAttribute("aria-level", "1")
  await expect(drafts).toHaveAttribute("aria-selected", "false")
  // One roving tab stop: the first row owns it.
  expect(await drafts.evaluate(row => row.tabIndex)).toBe(0)

  await drafts.focus()
  await page.keyboard.press("ArrowRight")
  await expect(drafts).toHaveAttribute("aria-expanded", "true")

  const draftA = page.getByRole("treeitem", { name: "draft-a.md", exact: true })
  await expect(draftA).toHaveAttribute("aria-level", "2")
  await page.keyboard.press("ArrowDown")
  await expect(draftA).toBeFocused()
  expect(await draftA.evaluate(row => row.tabIndex)).toBe(0)
  expect(await drafts.evaluate(row => row.tabIndex)).toBe(-1)

  // Left on a child moves to its parent without collapsing it.
  await page.keyboard.press("ArrowLeft")
  await expect(drafts).toBeFocused()
  await expect(drafts).toHaveAttribute("aria-expanded", "true")

  // Left again collapses, and the hidden child leaves the DOM.
  await page.keyboard.press("ArrowLeft")
  await expect(drafts).toHaveAttribute("aria-expanded", "false")
  await expect(draftA).toHaveCount(0)

  await page.keyboard.press("ArrowDown")
  const second = page.getByRole("treeitem", { name: "中文 草稿.md", exact: true })
  await expect(second).toBeFocused()
  await page.keyboard.press("Home")
  await expect(drafts).toBeFocused()
  await page.keyboard.press("End")
  await expect(page.getByRole("treeitem", { name: /long-file-name-99-/ })).toBeFocused()
})

test("keeps the keyboard-opened context menu inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 300 })
  await page.goto(FILES_HARNESS)
  const drafts = page.getByRole("treeitem", { name: "drafts", exact: true })
  await drafts.focus()
  await page.keyboard.press("Shift+F10")

  const menu = page.getByRole("menu")
  await expect(menu).toBeVisible()
  // Roving focus starts on the first enabled item (create file/folder).
  await expect(page.getByRole("menuitem", { name: "New File" })).toBeFocused()

  const box = await menu.boundingBox()
  const viewport = page.viewportSize()!
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)

  // Arrow keys move between items; Escape closes and returns to the row.
  await page.keyboard.press("ArrowDown")
  await expect(page.getByRole("menuitem", { name: "New Folder" })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)
  await expect(drafts).toBeFocused()
})

test("clamps a pointer-opened menu at the bottom-right corner", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 300 })
  await page.goto(FILES_HARNESS)

  // Right-click inside the tree near the viewport's bottom-right corner: the
  // raw pointer position would push the menu off-screen.
  await page.mouse.click(268, 288, { button: "right" })
  const menu = page.getByRole("menu")
  await expect(menu).toBeVisible()

  const box = await menu.boundingBox()
  const viewport = page.viewportSize()!
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
})
