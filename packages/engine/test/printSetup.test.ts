import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_PRINT_SETUP,
  formatMm,
  isExplicitPageBreakHtml,
  pageBoxTenthMm,
  PRINT_RULES_CSS,
  renderPrintCss,
  sanitizePrintSetup,
} from "../src/export/printSetup"

describe("print setup", () => {
  it("matches the CSS file Rust includes", () => {
    const file = readFileSync(resolve(import.meta.dirname, "../src/export/printRules.css"), "utf8")
      .replace(/\r\n/g, "\n")
      .replace(/\n+$/, "")
    expect(PRINT_RULES_CSS).toBe(file)
  })

  it("defaults to A4 portrait with 16 mm margins", () => {
    expect(DEFAULT_PRINT_SETUP.paper).toBe("a4")
    expect(DEFAULT_PRINT_SETUP.orientation).toBe("portrait")
    expect(DEFAULT_PRINT_SETUP.headingPageBreak).toBe("none")
    expect(DEFAULT_PRINT_SETUP.marginTopMm).toBe(16)
    expect(DEFAULT_PRINT_SETUP.headerFooter).toBe(false)
    expect(DEFAULT_PRINT_SETUP.printBackgrounds).toBe(true)
  })

  it("emits heading page-break rules when opted in and rejects unknown values", () => {
    const h1 = renderPrintCss({ ...DEFAULT_PRINT_SETUP, headingPageBreak: "h1" })
    expect(h1).toContain("@media print{body>h1:not(:first-child){break-before:page;page-break-before:always}}")
    const h1h2 = renderPrintCss({ ...DEFAULT_PRINT_SETUP, headingPageBreak: "h1-h2" })
    expect(h1h2).toContain("@media print{body>h1:not(:first-child),body>h2:not(:first-child){break-before:page;page-break-before:always}}")
    expect(sanitizePrintSetup({ headingPageBreak: "h3" as "none" }).headingPageBreak).toBe("none")
    expect(sanitizePrintSetup({ headingPageBreak: "h1-h2" }).headingPageBreak).toBe("h1-h2")
  })

  it("swaps the page box for landscape and keeps Letter's tenth-millimetre size", () => {
    expect(pageBoxTenthMm({ paper: "letter", orientation: "landscape" })).toEqual({
      widthTenthMm: 2794,
      heightTenthMm: 2159,
    })
    expect(formatMm(215.9)).toBe("215.9")
    const css = renderPrintCss({
      ...DEFAULT_PRINT_SETUP,
      paper: "letter",
      orientation: "landscape",
      marginTopMm: 10,
      marginRightMm: 12.5,
      marginBottomMm: 10,
      marginLeftMm: 12.5,
    })
    expect(css.startsWith("@page{size:279.4mm 215.9mm;margin:10mm 12.5mm 10mm 12.5mm}")).toBe(true)
  })

  it("rejects an unknown paper and clamps margins to the contract range", () => {
    const sanitized = sanitizePrintSetup({
      paper: "tabloid" as "a4",
      orientation: "landscape",
      marginLeftMm: 200,
      marginTopMm: -3,
    })
    expect(sanitized.paper).toBe("a4")
    expect(sanitized.orientation).toBe("landscape")
    expect(sanitized.marginLeftMm).toBe(50)
    expect(sanitized.marginTopMm).toBe(0)
  })

  it("accepts Typora's page-break markup and refuses handlers", () => {
    expect(isExplicitPageBreakHtml('<div style="page-break-after: always;"></div>')).toBe(true)
    expect(isExplicitPageBreakHtml('<div style="page-break-after: always; color: red"></div>')).toBe(true)
    expect(isExplicitPageBreakHtml('<p style="break-after: page"></p>')).toBe(true)
    expect(isExplicitPageBreakHtml('<hr class="pagebreak" />')).toBe(true)
    expect(isExplicitPageBreakHtml('<div class="page-break" onclick="alert(1)"></div>')).toBe(false)
  })

  it("emits overflow:visible and respects printBackgrounds toggle", () => {
    const withBg = renderPrintCss({ ...DEFAULT_PRINT_SETUP, printBackgrounds: true })
    const noBg = renderPrintCss({ ...DEFAULT_PRINT_SETUP, printBackgrounds: false })
    expect(withBg).toContain("overflow:visible")
    expect(withBg).toContain("print-color-adjust:exact")
    expect(noBg).not.toContain("print-color-adjust:exact")
    expect(withBg).not.toContain("pre{white-space:pre-wrap;overflow-wrap:break-word;overflow:visible;break-inside:avoid")
  })
})
