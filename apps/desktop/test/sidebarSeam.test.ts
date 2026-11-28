import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const STYLES_CSS = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8")

function declarationBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const matches = [...STYLES_CSS.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g"))]
  if (matches.length === 0) throw new Error(`missing styles.css block for ${selector}`)
  return matches.map(match => match[1]).join("\n")
}

function propValue(block: string, property: string): string {
  const match = block.match(new RegExp(`${property}\\s*:\\s*([^;]+);`))
  if (!match) throw new Error(`missing ${property} declaration`)
  return match[1].trim()
}

describe("sidebar seam", () => {
  it("renders the drag sash as a zero-layout-width overlay centered on the border", () => {
    // A zero-layout-width overlay sash (width 6px with -3px horizontal margins)
    // occupies 0px in the flex row, so it never creates a white seam between
    // sidebars and never leaves a chrome overhang when the outline is hidden.
    const sash = declarationBlock(".sidebar-resizer")
    expect(propValue(sash, "width")).toBe("6px")
    expect(propValue(sash, "margin-left")).toBe("-3px")
    expect(propValue(sash, "margin-right")).toBe("-3px")
    expect(propValue(sash, "background")).toBe("transparent")
  })
})
