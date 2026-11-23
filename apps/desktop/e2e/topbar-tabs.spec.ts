import { expect, test } from "@playwright/test"

// Real-browser proof for the tab strip rewrite (A11Y-04): a close control may
// not live inside the tab button, the strip must expose tablist/tab semantics,
// arrow keys must move the roving stop, and the close button must not sit on
// top of the tab title at any slot width.
test("exposes a tablist with sibling close buttons", async ({ page }) => {
  await page.goto("/e2e/topbar-harness.html")

  const tablist = page.getByRole("tablist", { name: "Open documents" })
  await expect(tablist).toBeVisible()
  const tabs = page.getByRole("tab")
  await expect(tabs).toHaveCount(3)
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true")
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "false")

  // No interactive element inside a tab button.
  const nestedInteractive = await page.evaluate(() =>
    [...document.querySelectorAll(".topbar-tabs .tab")].some(tab =>
      tab.querySelector('button, [role="button"], a[href], input')),
  )
  expect(nestedInteractive).toBe(false)

  // Close buttons are siblings inside the same slot.
  const closeButtons = page.getByRole("button", { name: "Close tab" })
  await expect(closeButtons).toHaveCount(3)
  expect(await page.evaluate(() =>
    [...document.querySelectorAll(".tab-slot")].every(slot =>
      slot.querySelector(":scope > .tab") !== null
      && slot.querySelector(":scope > .tab-close") !== null))).toBe(true)
})

test("keeps the title clear of the close button and the slot height stable", async ({ page }) => {
  await page.goto("/e2e/topbar-harness.html")
  await page.setViewportSize({ width: 720, height: 200 })

  const slots = await page.locator(".tab-slot").all()
  expect(slots.length).toBe(3)
  for (const slot of slots) {
    const slotBox = (await slot.boundingBox())!
    const title = (await slot.locator(".tab-title").boundingBox())!
    const close = (await slot.locator(".tab-close").boundingBox())!
    expect(slotBox.height).toBeGreaterThanOrEqual(24)
    expect(slotBox.height).toBeLessThanOrEqual(28)
    expect(close.x).toBeGreaterThanOrEqual(title.x + title.width - 1)
    expect(close.x + close.width).toBeLessThanOrEqual(slotBox.x + slotBox.width)
  }
})

test("moves the roving tab stop with the arrow keys and closes via the button", async ({ page }) => {
  await page.goto("/e2e/topbar-harness.html")

  const tabs = page.getByRole("tab")
  await tabs.nth(0).focus()
  await page.keyboard.press("ArrowRight")
  await expect(tabs.nth(1)).toBeFocused()
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true")
  expect(await page.evaluate(() => window.__focusedTabs)).toEqual([2])

  await page.keyboard.press("End")
  await expect(tabs.nth(2)).toBeFocused()

  await page.getByRole("button", { name: "Close tab" }).first().click()
  expect(await page.evaluate(() => window.__closedTabs)).toEqual([1])
  await expect(page.getByRole("tab")).toHaveCount(2)
})
