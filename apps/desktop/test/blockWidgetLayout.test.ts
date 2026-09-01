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

  it("gives the header tools breathing room and keeps copy hover-only", () => {
    const tools = declarationBlocks(".editor-host .omd-code-tools").join("\n")
    expect(tools).toMatch(/\bgap\s*:\s*[4-9]px\s*;/)
    const copy = declarationBlocks(".editor-host .omd-code-copy").join("\n")
    expect(copy).toMatch(/\bopacity\s*:\s*0\s*;/)
    expect(copy).toMatch(/\btransition\s*:[^;]*opacity/)
    // hover 显现 + 键盘可达；copied 态保持可见（否则 check 图标立即消失）
    expect(declarationBlocks(".editor-host .omd-code-header:hover .omd-code-copy")).toHaveLength(1)
    expect(declarationBlocks(".editor-host .omd-code-copy:focus-visible")).toHaveLength(1)
    const copied = declarationBlocks(".editor-host .omd-code-copy.omd-code-copied").join("\n")
    expect(copied).toMatch(/\bopacity\s*:\s*1\s*;/)
  })

  it("rounds and elevates the code container without layout margins", () => {
    const code = declarationBlocks(".editor-host .omd-code").join("\n")
    expect(code).toMatch(/\bborder-radius\s*:\s*1[0-9]px\s*;/)
    expect(code).toMatch(/\bbox-shadow\s*:/)
    // 块 widget 铁律：垂直 margin 不进 CM 高度图（阴影/圆角不占布局，安全）
    expect(code).not.toMatch(/\bmargin(?:-top|-bottom)?\s*:/)
    const header = declarationBlocks(".editor-host .omd-code-header").join("\n")
    expect(header).toMatch(/border-radius\s*:\s*1[0-9]px\s+1[0-9]px\s+0\s+0\s*;/)
  })

  it("thins the code block scrollbar", () => {
    const bar = declarationBlocks(".editor-host .omd-code pre::-webkit-scrollbar").join("\n")
    expect(bar).toMatch(/\bheight\s*:\s*8px\s*;/)
    const thumb = declarationBlocks(".editor-host .omd-code pre::-webkit-scrollbar-thumb").join("\n")
    expect(thumb).toMatch(/\bborder-radius\s*:/)
  })
  it("assembles the editing-state code container and line numbers", () => {
    const num = declarationBlocks(".editor-host .cm-line.omd-codeblock-num").join("\n")
    expect(num).toMatch(/counter-increment:\s*omd-code-line/)
    expect(num).not.toMatch(/\bmargin/)
    const first = declarationBlocks(".editor-host .cm-line.omd-codeblock-num-first").join("\n")
    expect(first).toMatch(/counter-reset:\s*omd-code-line/)
    const last = declarationBlocks(".editor-host .cm-line.omd-codeblock-num-last").join("\n")
    expect(last).toMatch(/border-radius:\s*0 0 12px 12px/)
    const chrome = declarationBlocks(".editor-host .cm-line .omd-code-header").join("\n")
    expect(chrome).toMatch(/width:\s*100%/)
    expect(chrome).not.toMatch(/\bmargin/)
  })

  it("declares both-theme palettes for the editing-state code highlight", () => {
    for (const theme of ['light', 'dark']) {
      const block = STYLES_CSS.match(new RegExp(`html\\[data-theme="${theme}"\\]\\s*\\{([\\s\\S]*?)\\}`, ""))
      expect(block, theme).toBeTruthy()
      for (const token of ["keyword", "string", "comment", "function"]) {
        expect(block![1], `${theme}:${token}`).toMatch(new RegExp(`--omd-syn-${token}:\\s*#`))
      }
    }
  })
})
