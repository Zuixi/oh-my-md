import { expect, test } from "@playwright/test"

// Rendered (mounted) code block: Shiki output, caret outside the block.
// Regression class: empty `.line` spans are display:block with no content —
// height 0 — blank lines vanish (fixed by `.line:empty::after`; this test
// proves the CSS stays).
const DOC = [
  "Intro paragraph.",
  "",
  "```js",
  "const a = 1",
  "",
  "const b = 2",
  "```",
  "",
  "Outro paragraph.",
].join("\n")

test("rendered code block keeps every blank line at full height", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  // Shiki renders async (debounce + lazy import): wait for highlight spans.
  const lines = page.locator(".omd-code-lines .line")
  await expect(lines).toHaveCount(3)
  await expect(lines.first().locator("span").first()).toBeVisible()

  const metrics = await lines.evaluateAll(nodes => nodes.map(n => ({
    height: (n as HTMLElement).getBoundingClientRect().height,
    empty: n.childElementCount === 0,
  })))
  for (const line of metrics) expect(line.height).toBeGreaterThan(5)
  const text = metrics.filter(m => !m.empty).map(m => m.height)
  const blank = metrics.filter(m => m.empty).map(m => m.height)
  expect(blank.length).toBe(1)
  expect(text.length).toBe(2)
  // A blank row must occupy (roughly) a text row, not collapse to zero.
  const ratio = blank[0] / (text[0] + text[1]) * 2
  expect(ratio).toBeGreaterThan(0.7)
  expect(ratio).toBeLessThan(1.4)
})

test("a quoted fence that starts the document still gets highlighted", async ({ page }) => {
  // 最终根因回归：文档首个块是「引用内的围栏」时，装饰重建会把同一个 widget 实例
  // 重新挂到新 tile 上（toDOM 再次调用）并乱序收到旧 tile 的 destroy()；修复前
  // destroy 把实例标记为死亡，异步渲染每一步都被 isActive 拒绝 → 永久停在同步占位。
  // data-omd-highlight 是可观测降级标记（placeholder / unknown-lang / error / shiki）。
  const doc = "> ```js\n> const a = 1\n> ```\n\noutro"
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}`)
  const body = page.locator(".omd-code-body")
  await expect(body).toBeVisible()
  await expect(body).toHaveAttribute("data-omd-highlight", "shiki")
  await expect(page.locator(".omd-code-lines .line")).toHaveCount(1)
})

test("an unknown fence language degrades with an observable marker", async ({ page }) => {
  const doc = "```not-a-real-lang\nsome text\n```\n\noutro"
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}`)
  const body = page.locator(".omd-code-body")
  await expect(body).toBeVisible()
  // 不再静默：要么命中某语言别名，要么显式标记 unknown-lang（保留纯文本兜底）。
  await expect(body).toHaveAttribute("data-omd-highlight", /shiki|unknown-lang/)
})

test("rendered chrome header sits above the code body", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  const header = page.locator(".omd-code-header")
  await expect(header).toBeVisible()
  const body = page.locator(".omd-code-lines")
  await expect(body).toBeVisible()
  const gap = await page.evaluate(() => {
    const h = document.querySelector(".omd-code-header")!.getBoundingClientRect()
    const b = document.querySelector(".omd-code-lines")!.getBoundingClientRect()
    return b.top - h.bottom
  })
  expect(gap).toBeGreaterThanOrEqual(-1)
  expect(gap).toBeLessThan(1)
  expect(await page.evaluate(() => window.__harnessErrors)).toEqual([])
})
