import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// 标题字号阶梯与级别徽标是纯 styles.css 契约：六级必须单调递减（相邻差可感知，
// 修复 h4-h6 曾经的 1em 断崖），徽标必须是 overlay（position: absolute，不占行宽
// —— 行宽不抖动是路线 A 折叠的核心不变量）。守则与 listDepthStyles.test.ts 同构。
const STYLES_CSS = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8")

const FLAT_CSS = STYLES_CSS.replace(/\s+/g, " ")

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const matches = [...STYLES_CSS.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g"))]
  if (matches.length === 0) throw new Error(`missing styles.css rule for ${selector}`)
  return matches[matches.length - 1][1]
}

const EM = /font-size:\s*([\d.]+)em/
const sizeOf = (level: number): number => {
  const m = rule(`.editor-host .omd-h${level}`).match(EM)
  if (!m) throw new Error(`omd-h${level} has no em font-size`)
  return Number(m[1])
}

describe("heading level ladder", () => {
  it("keeps all six levels strictly decreasing", () => {
    const sizes = [1, 2, 3, 4, 5, 6].map(sizeOf)
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i - 1], `omd-h${i} vs omd-h${i + 1}`).toBeGreaterThan(sizes[i])
    }
  })

  it("keeps every adjacent step perceivable (>= 0.125em)", () => {
    const sizes = [1, 2, 3, 4, 5, 6].map(sizeOf)
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i - 1] - sizes[i], `omd-h${i} vs omd-h${i + 1}`).toBeGreaterThanOrEqual(0.125)
    }
  })

  it("distinguishes h4 from bold body text (h4 > 1em)", () => {
    // h4 取 1.125em 而非 Typora 的 1em：源编辑器里整行加粗的正文会与 1em 的 h4 撞脸。
    expect(sizeOf(4)).toBeGreaterThan(1)
  })

  it("keeps h1-h3 ladder stable (1.8 / 1.5 / 1.25)", () => {
    expect([sizeOf(1), sizeOf(2), sizeOf(3)]).toEqual([1.8, 1.5, 1.25])
  })
})

describe("heading level badge", () => {
  it("renders the badge text from the line's data attribute", () => {
    expect(FLAT_CSS).toMatch(/\.editor-host \.omd-h-active::before\s*\{[^}]*content:\s*"H" attr\(data-omd-h\)/)
  })

  it("overlays the badge without consuming line width", () => {
    // 徽标必须 overlay：absolute 定位不推动正文，光标进入/离开标题行时行宽不抖动。
    expect(FLAT_CSS).toMatch(/\.editor-host \.omd-h-active::before\s*\{[^}]*position:\s*absolute/)
  })

  it("never interferes with pointer editing", () => {
    expect(FLAT_CSS).toMatch(/\.editor-host \.omd-h-active::before\s*\{[^}]*pointer-events:\s*none/)
  })
})
