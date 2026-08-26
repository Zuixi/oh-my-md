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

describe("block widget layout", () => {
  it("keeps vertical spacing inside CodeMirror's measured block DOM", () => {
    const blockSelectors = [
      ".editor-host .omd-block",
      ".editor-host .omd-block.omd-hr-block",
      ".editor-host .omd-table",
    ]

    for (const selector of blockSelectors) {
      for (const declarations of declarationBlocks(selector)) {
        expect(declarations).not.toMatch(
          /\b(?:margin|margin-top|margin-bottom|margin-block(?:-start|-end)?)\s*:/,
        )
      }
      expect(declarationBlocks(selector).join("\n")).toMatch(/\bpadding\s*:/)
    }

    const placeholder = declarationBlocks(".editor-host .omd-block-placeholder").join("\n")
    expect(placeholder).toMatch(/\bmargin\s*:\s*0\s*;/)
  })
})
