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

test("a block widget is rebuilt a bounded number of times and not after settling", async ({ page }) => {
  // 挂载稳定期确实会重建块 tile，且这是**设计使然**（见 gotchas「块 tile 在挂载稳定期
  // 被重建」）：种子构建 → 初始光标(0) → 文末的选择事务触发邻域重建（其 range 与块的
  // replace 区间相交）→ CM 首次布局。文档首块的引用围栏因此被插入 3 次（其它形态 1 次）。
  // 关键不变量不是"次数 = 1"，而是：① 有界（不允许无限重建）；② 稳定后不再重建；
  // ③ 最终落在高亮态（异步渲染没有被 tile 重建吞掉）。
  await page.addInitScript(() => {
    const w = window as unknown as { __widgetInserts: number }
    w.__widgetInserts = 0
    const count = (node: unknown) => {
      if (node instanceof Element && (node.matches(".omd-code") || node.querySelector?.(".omd-code"))) {
        w.__widgetInserts++
      } else if (node instanceof DocumentFragment && node.querySelector?.(".omd-code")) {
        w.__widgetInserts++
      }
    }
    for (const name of ["appendChild", "insertBefore", "replaceChildren"] as const) {
      const original = Element.prototype[name] as (...args: unknown[]) => unknown
      ;(Element.prototype as unknown as Record<string, unknown>)[name] = function (
        this: Element, ...args: unknown[]
      ) {
        for (const arg of args) count(arg)
        return original.apply(this, args)
      }
    }
  })
  const doc = "> ```js\n> const a = 1\n> ```\n\noutro"
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(doc)}`)
  const body = page.locator(".omd-code-body")
  await expect(body).toHaveAttribute("data-omd-highlight", "shiki")

  const inserts = await page.evaluate(() => (window as unknown as { __widgetInserts: number }).__widgetInserts)
  expect(inserts).toBeLessThanOrEqual(3)

  // 稳定之后不得再重建：给当前 DOM 打标记，等待若干帧后标记仍在。
  await page.evaluate(() => {
    (document.querySelector(".omd-code") as HTMLElement).dataset.settleProbe = "kept"
  })
  await page.waitForTimeout(500)
  expect(await page.evaluate(() =>
    document.querySelector(".omd-code")?.getAttribute("data-settle-probe") ?? null)).toBe("kept")
  await expect(body).toHaveAttribute("data-omd-highlight", "shiki")
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
