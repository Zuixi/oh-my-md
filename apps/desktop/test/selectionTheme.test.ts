import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Drift guard for editor selection colors. Selections are painted by two
 * systems — CodeMirror's `.cm-selectionLayer` (the vendored tightSelection
 * extension) and the browser's native `::selection` (block-widget DOM,
 * focused cell editors). Both must consume the theme token
 * `--omd-selection-bg`: CM's internal dark flag is never set anywhere, so its
 * base theme would otherwise paint light `#d7d4f0` in dark mode, and the
 * vendored `hideNativeSelection` rule falls back to `Highlight` (native blue)
 * for focused widget editors. If the styling changes, update styles.css and
 * this test together.
 */

const STYLES_CSS = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8")
const TIGHT_SELECTION_TS = readFileSync(resolve(process.cwd(), "src/tightSelection.ts"), "utf8")

function themeBlock(theme: "light" | "dark"): string {
  const match = new RegExp(`html\\[data-theme="${theme}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(STYLES_CSS)
  if (!match) throw new Error(`missing html[data-theme="${theme}"] block in styles.css`)
  return match[1]!
}

describe("editor selection theming", () => {
  it("defines --omd-selection-bg in both theme blocks", () => {
    for (const theme of ["light", "dark"] as const) {
      expect(themeBlock(theme)).toContain("--omd-selection-bg:")
    }
  })

  it("overrides the CM selection layer with the theme token", () => {
    // Specificity note: the focused-variant selector must outrank CM's base
    // theme rule `.{baseLightID}.cm-focused > .cm-scroller > .cm-selectionLayer
    // .cm-selectionBackground` (5 class selectors), hence the full chain.
    expect(STYLES_CSS).toContain(
      ".editor-host .cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground",
    )
    expect(STYLES_CSS).toContain(
      ".editor-host .cm-selectionLayer .cm-selectionBackground",
    )
  })

  it("beats the vendored Highlight fallback for focused widget editors", () => {
    // tightSelection keeps the upstream `Highlight !important` rule; the
    // higher-specificity override below must stay in place or focused table
    // cell editors paint blue native selections again.
    expect(TIGHT_SELECTION_TS).toContain("Highlight !important")
    expect(STYLES_CSS).toMatch(
      /\.editor-host \.cm-editor \.cm-content :focus ::selection,\s*\.editor-host \.cm-editor \.cm-content :focus::selection\s*\{[^}]*var\(--omd-selection-bg\)/,
    )
  })

  it("themes native selections inside block widgets", () => {
    expect(STYLES_CSS).toMatch(
      /\.editor-host \.omd-block ::selection\s*\{[^}]*var\(--omd-selection-bg\)/,
    )
  })
})
