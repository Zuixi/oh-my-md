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

function expectSelectedFont(selector: string) {
  expect(declarationBlocks(selector).join("\n")).toMatch(
    /font-family\s*:\s*var\(--omd-font-family,\s*ui-monospace,\s*monospace\)\s*;/,
  )
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

  it("keeps the table cell editor visually flush without changing row geometry", () => {
    const editor = declarationBlocks(".editor-host .omd-table-edit").join("\n")
    expect(editor).toMatch(/\bdisplay\s*:\s*block\s*;/)
    expect(editor).toMatch(/\bborder\s*:\s*(?:0|none)\s*;/)
    expect(editor).toMatch(/\boutline\s*:\s*(?:0|none)\s*;/)
    expect(editor).toMatch(/\bpadding\s*:\s*0\s*;/)
    expect(editor).toMatch(/\bbackground\s*:\s*transparent\s*;/)
    expect(editor).toMatch(/\bline-height\s*:\s*inherit\s*;/)
    // A percentage width on an input participates in auto table intrinsic
    // sizing and widens the column. Zero width + a percentage min-width fills
    // the assigned cell without contributing the input's default 20ch width.
    expect(editor).toMatch(/(?:^|[;{])\s*width\s*:\s*0\s*;/m)
    expect(editor).toMatch(/\bmin-width\s*:\s*100%\s*;/)
  })

  it("uses the selected editor font in rendered code and the math popup", () => {
    expectSelectedFont(".editor-host .omd-code pre")
    expectSelectedFont(".editor-host .omd-code pre code")
    expectSelectedFont(".editor-host .omd-math-editor")
  })

  it("collapses Shiki newline text nodes so rendered line boxes match source lines", () => {
    const code = declarationBlocks(".editor-host .omd-code pre code").join("\n")
    expect(code).toMatch(/\bdisplay\s*:\s*flex\s*;/)
    expect(code).toMatch(/\bflex-direction\s*:\s*column\s*;/)
  })

  it("shows code fence chrome by default, not only on hover", () => {
    const header = declarationBlocks(".editor-host .omd-code-header").join("\n")
    expect(header).toMatch(/\bdisplay\s*:\s*flex\s*;/)
    expect(header).not.toMatch(/\bopacity\s*:\s*0\s*;/)
    expect(header).not.toMatch(/\bvisibility\s*:\s*hidden\s*;/)
    expect(() => declarationBlocks(".editor-host .omd-code:hover .omd-code-header")).toThrow()
  })

  it("keeps the code-block line background on the caret line", () => {
    const active = declarationBlocks(
      ".editor-host .cm-content .cm-line.omd-codeblock.cm-activeLine",
    ).join("\n")
    expect(active).toMatch(/background(?:-color)?\s*:\s*var\(--omd-code-bg\)/)
  })
})
