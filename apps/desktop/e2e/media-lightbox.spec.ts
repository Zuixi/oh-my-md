import { expect, test } from "@playwright/test"

test.describe("Image Lightbox & Mermaid Zoom/Pan", () => {
  test("clicking an image opens the full-screen lightbox with wheel zoom, drag pan, and Escape close", async ({ page }) => {
    await page.goto("/e2e/media-lightbox-harness.html")

    const img = page.locator(".editor-host img.omd-image")
    await expect(img).toBeVisible()
    await expect(img).toHaveCSS("cursor", "zoom-in")

    await img.click()

    const dialog = page.locator("dialog.media-lightbox")
    await expect(dialog).toBeVisible()
    await expect(dialog.locator(".media-lightbox-caption")).toHaveText("Sample caption")
    await expect(dialog.locator(".media-lightbox-img")).toBeVisible()

    // Image stays rendered in the editor behind the dialog
    await expect(img).toHaveCount(1)

    // Zoom in via toolbar button
    const readout = dialog.locator(".media-lightbox-zoom-readout")
    const beforeZoom = await readout.textContent()
    await dialog.getByRole("button", { name: "Zoom in (+)" }).click()
    const afterZoom = await readout.textContent()
    expect(afterZoom).not.toBe(beforeZoom)

    // Drag to pan changes transform translation without closing the dialog
    const stage = dialog.locator(".media-lightbox-stage")
    const content = dialog.locator(".media-lightbox-content")
    const box = await stage.boundingBox()
    expect(box).toBeTruthy()
    const cx = box!.x + box!.width / 2
    const cy = box!.y + box!.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 80, cy + 40, { steps: 5 })
    await page.mouse.up()

    await expect(dialog).toBeVisible()
    const transform = await content.evaluate(el => el.style.transform)
    expect(transform).toContain("translate3d(80px, 40px, 0px)")

    // Escape closes the lightbox
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
  })

  test("clicking a rendered Mermaid diagram opens zoom/pan lightbox, and Edit Source enters source mode", async ({ page }) => {
    await page.goto("/e2e/media-lightbox-harness.html")

    const mermaidBody = page.locator(".editor-host .omd-mermaid .omd-block-body[data-omd-render='svg']")
    await expect(mermaidBody).toBeVisible({ timeout: 5000 })
    await expect(mermaidBody).toHaveCSS("cursor", "zoom-in")

    await mermaidBody.click()

    const dialog = page.locator("dialog.media-lightbox")
    await expect(dialog).toBeVisible()
    const modalSvg = dialog.locator(".media-lightbox-svg-frame svg")
    await expect(modalSvg).toBeVisible({ timeout: 5000 })
    await expect(dialog.locator(".media-lightbox-broken")).toHaveCount(0)
    const svgBox = await modalSvg.boundingBox()
    expect(svgBox).toBeTruthy()
    expect(svgBox!.width).toBeGreaterThan(100)
    expect(svgBox!.height).toBeGreaterThan(40)

    // Wheel zoom changes scale
    const readout = dialog.locator(".media-lightbox-zoom-readout")
    const initialPct = await readout.textContent()
    const stageBox = await dialog.locator(".media-lightbox-stage").boundingBox()
    expect(stageBox).toBeTruthy()
    await page.mouse.move(stageBox!.x + stageBox!.width / 2, stageBox!.y + stageBox!.height / 2)
    await page.mouse.wheel(0, -240)
    await expect(readout).not.toHaveText(initialPct!)

    // Copy SVG button is available for Mermaid diagrams
    await expect(dialog.getByRole("button", { name: "Copy SVG" })).toBeVisible()

    // Edit source button closes lightbox and unfolds Mermaid markdown source
    await dialog.getByRole("button", { name: "Edit source" }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator(".editor-host .omd-mermaid")).toHaveCount(0)
  })
})
