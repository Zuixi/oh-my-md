import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const STYLES_CSS = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8")

function declarationBlocks(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const matches = [...STYLES_CSS.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g"))]
  if (matches.length === 0) throw new Error(`missing styles.css block for ${selector}`)
  return matches.map(match => match[1])
}

describe("blank-line density", () => {
  it("compresses non-caret blank lines via line-height, never display:none", () => {
    const rules = declarationBlocks(".editor-host .cm-content .cm-line.omd-empty")
    expect(rules.length).toBeGreaterThan(0)
    const joined = rules.join("\n")
    expect(joined).toMatch(/line-height\s*:\s*var\(--omd-empty-line-height/)
    // CM 的行测量与 posAtCoords 需要真实可点击的盒子；display:none/visibility
    // 会破坏选区几何与点击映射。
    expect(joined).not.toMatch(/\bdisplay\s*:\s*none\b/)
    expect(joined).not.toMatch(/\bvisibility\s*:\s*hidden\b/)
  })

  it("defines the height token as a unitless line-height multiplier", () => {
    expect(STYLES_CSS).toMatch(/--omd-empty-line-height\s*:\s*\d+(\.\d+)?\s*;/)
  })
})
