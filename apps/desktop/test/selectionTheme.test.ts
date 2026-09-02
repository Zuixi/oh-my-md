import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { colord, extend } from "colord"
import a11yPlugin from "colord/plugins/a11y"

extend([a11yPlugin])

/**
 * Drift guard for editor caret and selection colors. Two paint systems must
 * consume the same theme tokens: CodeMirror's layers (the vendored
 * tightSelection extension — .cm-selectionLayer rectangles and the
 * .cm-cursor border-left overlay) and the browser's native ::selection /
 * caret-color (block-widget DOM, the math popup's nested CodeMirror, the
 * code-title input). CM's internal dark flag is never set anywhere, so its
 * base theme would otherwise paint light `#d7d4f0` selections plus a 1.2px
 * black caret that disappears on the dark background, and the vendored
 * `hideNativeSelection` rule falls back to `Highlight` (native blue) for
 * focused widget editors. The structural rules pin the selectors; the
 * contrast suite pins the token values so a low-contrast token can never
 * land again — the pre-fix dark selection composited to 1.13:1 on #1e1e1e,
 * i.e. invisible. If the styling changes, update styles.css and this test
 * together.
 */

const STYLES_CSS = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8")
const TIGHT_SELECTION_TS = readFileSync(resolve(process.cwd(), "src/tightSelection.ts"), "utf8")

function themeBlock(theme: "light" | "dark"): string {
  const match = new RegExp(`html\\[data-theme="${theme}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(STYLES_CSS)
  if (!match) throw new Error(`missing html[data-theme="${theme}"] block in styles.css`)
  return match[1]!
}

function themeToken(theme: "light" | "dark", token: string): string {
  const match = new RegExp(`${token}:\\s*([^;]+);`).exec(themeBlock(theme))
  if (!match) throw new Error(`missing ${token} in html[data-theme="${theme}"] block in styles.css`)
  return match[1]!.trim()
}

/** Composite a possibly translucent token over the theme background. */
function overBackground(color: string, theme: "light" | "dark"): string {
  const fg = colord(color).toRgb()
  const bg = colord(themeToken(theme, "--omd-bg")).toRgb()
  const alpha = fg.a ?? 1
  const blend = (a: number, b: number) => Math.round(a * alpha + b * (1 - alpha))
  return colord({ r: blend(fg.r, bg.r), g: blend(fg.g, bg.g), b: blend(fg.b, bg.b) }).toHex()
}

// WCAG contrast floors. A caret must be unmistakable (a 1.2px hairline earns
// its keep only at high ratio); focused selections are large color fields, so
// ~1.5-2:1 against the background reads clearly (VS Code Dark+ sits at 1.96);
// unfocused ones trade visibility for restraint; text must stay AA-legible on
// top of a selection.
const CURSOR_FLOOR = 10
const FOCUSED_SELECTION_FLOOR = { light: 1.3, dark: 1.8 } as const
const UNFOCUSED_SELECTION_FLOOR = 1.3
const TEXT_ON_SELECTION_FLOOR = 4.5

describe("editor selection theming", () => {
  it("defines the caret and selection tokens in both theme blocks", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const token of ["--omd-cursor", "--omd-selection-bg", "--omd-selection-bg-unfocused"]) {
        expect(themeBlock(theme), `${theme} ${token}`).toContain(`${token}:`)
      }
    }
  })

  it("overrides the CM selection layer with per-state tokens", () => {
    // Specificity note: the focused-variant selector must outrank CM's base
    // theme rule `.{baseLightID}.cm-focused > .cm-scroller > .cm-selectionLayer
    // .cm-selectionBackground` (5 class selectors), hence the full chain. The
    // unfocused rule must stay a separate rule — one shared block would pin
    // both states to a single token.
    expect(STYLES_CSS).toMatch(
      /\.editor-host \.cm-editor\.cm-focused > \.cm-scroller > \.cm-selectionLayer \.cm-selectionBackground\s*\{\s*background-color: var\(--omd-selection-bg\);/,
    )
    expect(STYLES_CSS).toMatch(
      /\.editor-host \.cm-selectionLayer \.cm-selectionBackground\s*\{\s*background-color: var\(--omd-selection-bg-unfocused\);/,
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

  it("restyles the overlay caret through the theme token", () => {
    // The base theme hardcodes `border-left: 1.2px solid black` and its &dark
    // #ddd variant never applies (no {dark: true} theme), so without this
    // override the caret is invisible in dark mode. -1px keeps the wider 2px
    // bar centered on the caret position (base: -0.6px for 1.2px).
    expect(STYLES_CSS).toMatch(
      /\.editor-host \.cm-editor \.cm-cursor,\s*\.editor-host \.cm-editor \.cm-dropCursor\s*\{[^}]*border-left: 2px solid var\(--omd-cursor\);[^}]*margin-left: -1px;/,
    )
  })

  it("routes nested native carets through the theme token", () => {
    // tightSelection restores `caret-color: initial` on :focus inside
    // .cm-content (the math popup's CodeMirror, the code-title input); browser
    // auto renders a near-invisible caret on dark backgrounds. The !important
    // must stay — it is what outranks the vendored !important rule.
    expect(STYLES_CSS).toMatch(
      /\.editor-host \.cm-editor \.cm-content :focus\s*\{\s*caret-color: var\(--omd-cursor\) !important;/,
    )
  })
})

describe("caret and selection contrast (WCAG, colord)", () => {
  it("keeps the caret clearly visible against the background", () => {
    for (const theme of ["light", "dark"] as const) {
      const ratio = colord(themeToken(theme, "--omd-cursor")).contrast(themeToken(theme, "--omd-bg"))
      expect(ratio, `${theme} caret vs background`).toBeGreaterThanOrEqual(CURSOR_FLOOR)
    }
  })

  it("keeps the focused selection discernible from the background", () => {
    for (const theme of ["light", "dark"] as const) {
      const ratio = colord(overBackground(themeToken(theme, "--omd-selection-bg"), theme))
        .contrast(themeToken(theme, "--omd-bg"))
      expect(ratio, `${theme} focused selection vs background`).toBeGreaterThanOrEqual(
        FOCUSED_SELECTION_FLOOR[theme],
      )
    }
  })

  it("keeps the unfocused selection subdued but still visible", () => {
    for (const theme of ["light", "dark"] as const) {
      const ratio = colord(overBackground(themeToken(theme, "--omd-selection-bg-unfocused"), theme))
        .contrast(themeToken(theme, "--omd-bg"))
      expect(ratio, `${theme} unfocused selection vs background`).toBeGreaterThanOrEqual(
        UNFOCUSED_SELECTION_FLOOR,
      )
    }
  })

  it("keeps body text legible on top of a focused selection", () => {
    for (const theme of ["light", "dark"] as const) {
      const ratio = colord(overBackground(themeToken(theme, "--omd-selection-bg"), theme))
        .contrast(themeToken(theme, "--omd-fg"))
      expect(ratio, `${theme} text on focused selection`).toBeGreaterThanOrEqual(
        TEXT_ON_SELECTION_FLOOR,
      )
    }
  })
})
