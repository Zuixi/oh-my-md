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

function backgroundDeclaration(selector: string): string {
  const blocks = declarationBlocks(selector).join("\n")
  const match = blocks.match(/background\s*:\s*([^;]+);/)
  if (!match) throw new Error(`${selector} declares no background`)
  return match[1].trim()
}

describe("sidebar seam", () => {
  it("paints the drag sash with the sidebar chrome color so it never shows the page background", () => {
    // resizer 是两个 chrome 侧栏之间的透明拖拽条：不写背景就会露出
    // --omd-bg（浅色主题下是纯白），形成一条亮缝（2026-08-30 截图确认）。
    const sash = backgroundDeclaration(".sidebar-resizer")
    expect(sash).toBe(backgroundDeclaration(".sidebar-primary"))
    expect(sash).toBe(backgroundDeclaration(".sidebar-secondary"))
  })
})
