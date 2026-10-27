import { expect, test } from "@playwright/test"
import { ROW_HEIGHT } from "../src/fileTreeState"

for (const theme of ["light", "dark"]) {
  test(`${theme}: 文件名原地编辑，失焦保留，失败后重试不改变行高`, async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("dialog", dialog => { errors.push("unexpected browser dialog"); void dialog.dismiss() })
    await page.goto(`/e2e/filetree-harness.html?theme=${theme}`)
    const row = page.getByRole("button", { name: "中文 草稿.md", exact: true })
    const before = await row.boundingBox()
    const nameBefore = await row.locator(".filetree-name").boundingBox()
    expect(before?.height).toBe(ROW_HEIGHT)
    await row.click({ button: "right" })
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
    const input = page.getByRole("textbox", { name: "Rename", exact: true })
    await expect(input).toBeFocused()
    expect(await input.evaluate(element => {
      const field = element as HTMLInputElement
      return [field.selectionStart, field.selectionEnd]
    }))
      .toEqual([0, "中文 草稿".length])
    const box = await input.boundingBox()
    expect(box!.x).toBe(nameBefore!.x)
    expect(box!.y).toBeGreaterThanOrEqual(before!.y)
    expect(box!.y + box!.height).toBeLessThanOrEqual(before!.y + ROW_HEIGHT)
    await input.fill("taken.md")
    await page.getByRole("button", { name: "Outside the tree" }).click()
    await expect(input).toHaveValue("taken.md")
    await expect(page.getByRole("status")).not.toContainText("Name already exists.")
    await input.press("Enter")
    await expect(input).toHaveAttribute("aria-invalid", "true")
    await expect(page.getByRole("status")).toHaveText("Name already exists.")
    const editingRow = input.locator("..")
    expect((await editingRow.boundingBox())?.height).toBe(ROW_HEIGHT)
    const errorColor = await page.getByRole("status").evaluate(element => getComputedStyle(element).color)
    expect(errorColor).toBe(theme === "light" ? "rgb(170, 0, 0)" : "rgb(255, 138, 138)")
    await input.fill("renamed 中文.md")
    await input.press("Enter")
    await expect(input).toHaveCount(0)
    await expect(page.getByRole("button", { name: "renamed 中文.md", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "renamed 中文.md", exact: true })).toBeFocused()
    expect(errors).toEqual([])
  })
}

test("真实滚动卸载后恢复草稿，Escape 取消且保持原名", async ({ page }) => {
  await page.goto("/e2e/filetree-harness.html")
  await page.getByRole("button", { name: "中文 草稿.md", exact: true }).click({ button: "right" })
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
  const input = page.getByRole("textbox", { name: "Rename", exact: true })
  await input.fill("uncommitted.md")
  const tree = page.getByRole("tree")
  await tree.evaluate((element, top) => { element.scrollTop = top }, 60 * ROW_HEIGHT)
  await expect(input).toHaveCount(0)
  await tree.evaluate(element => { element.scrollTop = 0 })
  await expect(input).toHaveValue("uncommitted.md")
  await input.press("Escape")
  await expect(input).toHaveCount(0)
  await expect(page.getByRole("button", { name: "中文 草稿.md", exact: true })).toBeFocused()
})
