import { expect, test } from "@playwright/test"
import { ROW_HEIGHT } from "../src/fileTreeState"

for (const theme of ["light", "dark"]) {
  test(`${theme}: 新建输入框与原行同高、与文件名对齐，Escape 不落盘`, async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("dialog", dialog => { errors.push("unexpected browser dialog"); void dialog.dismiss() })
    await page.goto(`/e2e/filetree-harness.html?theme=${theme}`)
    const row = page.getByRole("button", { name: "中文 草稿.md", exact: true })
    const nameBefore = await row.locator(".filetree-name").boundingBox()
    await row.click({ button: "right" })
    await page.getByRole("menuitem", { name: "New File", exact: true }).click()

    const input = page.getByRole("textbox", { name: "New file name", exact: true })
    await expect(input).toBeFocused()
    await expect(input).toHaveValue("untitled-2.md")
    expect(await input.evaluate(element => {
      const field = element as HTMLInputElement
      return [field.selectionStart, field.selectionEnd]
    })).toEqual([0, "untitled-2".length])

    const box = await input.boundingBox()
    expect(box!.x).toBe(nameBefore!.x)
    expect((await input.locator("..").boundingBox())?.height).toBe(ROW_HEIGHT)

    await input.fill("layout.md")
    await input.press("Escape")
    await expect(input).toHaveCount(0)
    await expect(page.getByRole("button", { name: "layout.md", exact: true })).toHaveCount(0)
    // Root creation scrolls to the list end; Escape returns focus to the tree
    // instead of leaving it on <body>, and writes nothing.
    await expect(page.getByRole("tree")).toBeFocused()
    expect(errors).toEqual([])
  })
}

test("长列表末尾新建文件：草稿滚动可见，落盘后选中并 reveal", async ({ page }) => {
  await page.goto("/e2e/filetree-harness.html")
  const tree = page.getByRole("tree")
  expect(await tree.evaluate(element => element.scrollTop)).toBe(0)

  await page.getByRole("button", { name: "中文 草稿.md", exact: true }).click({ button: "right" })
  await page.getByRole("menuitem", { name: "New File", exact: true }).click()
  const input = page.getByRole("textbox", { name: "New file name", exact: true })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("untitled-2.md")
  await expect(input).toBeInViewport()
  expect(await tree.evaluate(element => element.scrollTop)).toBeGreaterThan(0)

  await input.fill("zz-new.md")
  await input.press("Enter")
  const created = page.getByRole("button", { name: "zz-new.md", exact: true })
  await expect(created).toBeVisible()
  await expect(created).toBeInViewport()
  await expect(created).toHaveClass(/is-selected/)
  await expect(created).not.toBeFocused()
  await expect(page.getByRole("textbox")).toHaveCount(0)
})

test("折叠目录新建文件夹：先展开，草稿在子级末尾缩进渲染，落盘后选中并聚焦", async ({ page }) => {
  await page.goto("/e2e/filetree-harness.html")
  const drafts = page.getByRole("button", { name: "drafts", exact: true })
  await expect(drafts).toHaveAttribute("aria-expanded", "false")

  await drafts.click({ button: "right" })
  await page.getByRole("menuitem", { name: "New Folder", exact: true }).click()
  await expect(drafts).toHaveAttribute("aria-expanded", "true")
  await expect(page.getByRole("button", { name: "draft-b.md", exact: true })).toBeVisible()

  const input = page.getByRole("textbox", { name: "New folder name", exact: true })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("untitled-folder")
  const lastChild = page.getByRole("button", { name: "draft-b.md", exact: true })
  const childName = await lastChild.locator(".filetree-name").boundingBox()
  const draftBox = await input.boundingBox()
  expect(draftBox!.x).toBe(childName!.x)
  expect(draftBox!.y).toBeGreaterThan((await lastChild.boundingBox())!.y)

  await input.fill("ideas")
  await input.press("Enter")
  const created = page.getByRole("button", { name: "ideas", exact: true })
  await expect(created).toBeVisible()
  await expect(created).toBeFocused()
  await expect(created).toHaveClass(/is-selected/)
  await expect(created).toHaveAttribute("aria-expanded", "false")
  await expect(drafts).toHaveAttribute("aria-expanded", "true")
})

test("失焦取消新建，点击树外不产生任何行", async ({ page }) => {
  await page.goto("/e2e/filetree-harness.html")
  await page.getByRole("button", { name: "中文 草稿.md", exact: true }).click({ button: "right" })
  await page.getByRole("menuitem", { name: "New File", exact: true }).click()
  const input = page.getByRole("textbox", { name: "New file name", exact: true })
  await expect(input).toBeFocused()
  await input.fill("canceled.md")
  await page.getByRole("button", { name: "Outside the tree" }).click()
  await expect(input).toHaveCount(0)
  await expect(page.getByRole("button", { name: "canceled.md", exact: true })).toHaveCount(0)
})
