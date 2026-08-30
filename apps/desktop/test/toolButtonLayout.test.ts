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

describe("icon tool button sizing", () => {
  // 侧栏开关 / outline 开关 / 面板收起-关闭按钮共用一个尺寸 token ——
  // 视觉上 panel chrome 的工具按钮必须一样大（用户报告过 22 vs 26 的不一致）。
  const TOOL_BUTTONS = [
    ".topbar-sidebar-toggle",
    ".outline-toggle-btn",
    ".sidebar-collapse-btn",
  ]

  it("sizes every panel tool button from --omd-tool-btn-size", () => {
    for (const selector of TOOL_BUTTONS) {
      const rules = declarationBlocks(selector).join("\n")
      expect(rules, selector).toMatch(/width\s*:\s*var\(--omd-tool-btn-size\)/)
      expect(rules, selector).toMatch(/height\s*:\s*var\(--omd-tool-btn-size\)/)
    }
  })

  it("defines the token once with a px value", () => {
    expect(STYLES_CSS).toMatch(/--omd-tool-btn-size\s*:\s*\d+px\s*;/)
  })
})
