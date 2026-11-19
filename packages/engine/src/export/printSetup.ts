import contractJson from "./printContract.json"

/** Kept identical to `printRules.css`, which the Rust backend includes. */
const PRINT_RULES_CSS = "@media print{html,body{max-width:none;margin:0;padding:0;overflow:visible}p,li{orphans:3;widows:3}h1,h2,h3,h4,h5,h6{break-after:avoid;page-break-after:avoid;break-inside:avoid;page-break-inside:avoid}thead{display:table-header-group}pre{white-space:pre-wrap;overflow-wrap:break-word;overflow:visible}tr,figure,img,svg,.katex-display,math[display=\"block\"]{break-inside:avoid;page-break-inside:avoid}img,svg{max-width:100%;height:auto}.page-break,.pagebreak{break-after:page;page-break-after:always;height:0;margin:0;padding:0;border:0}}"

/**
 * Page contract shared with the Rust print backends
 * (`apps/desktop/src-tauri/src/export_page.rs` includes the same JSON and CSS).
 *
 * Paper sizes are integer tenths of a millimetre so A4 (210.0 × 297.0) and
 * US Letter (215.9 × 279.4, the 8.5 × 11 in size Electron and Joplin pass
 * through) do not drift through binary floats. CSS `@page { size }` is the
 * final page box (landscape swaps the numbers). WebView2/NSPrintInfo instead
 * take the portrait paper plus an orientation flag — see `native_page` in
 * Rust — because that is how those APIs are defined.
 */

interface PaperSpec {
  widthTenthMm: number
  heightTenthMm: number
}

interface PrintContract {
  papers: { a4: PaperSpec; letter: PaperSpec }
  defaultPaper: "a4" | "letter"
  defaultOrientation: "portrait" | "landscape"
  defaultHeadingBreak: HeadingPageBreak
  defaultMarginsTenthMm: { top: number; right: number; bottom: number; left: number }
  marginMinTenthMm: number
  marginMaxTenthMm: number
  printBackgrounds: boolean
  headerFooter: boolean
}

const contract = contractJson as PrintContract

export { PRINT_RULES_CSS }

export type PaperName = keyof PrintContract["papers"]
export type PageOrientation = "portrait" | "landscape"
export type HeadingPageBreak = "none" | "h1" | "h1-h2"

export interface PrintSetup {
  paper: PaperName
  orientation: PageOrientation
  headingPageBreak: HeadingPageBreak
  marginTopMm: number
  marginRightMm: number
  marginBottomMm: number
  marginLeftMm: number
  printBackgrounds: boolean
  headerFooter: boolean
  /** Document title for the native header. Never a filesystem path. */
  headerTitle: string
}

export const MARGIN_MIN_MM = contract.marginMinTenthMm / 10
export const MARGIN_MAX_MM = contract.marginMaxTenthMm / 10

function tenthToMm(tenths: number): number {
  return tenths / 10
}

export const DEFAULT_PRINT_SETUP: PrintSetup = {
  paper: contract.defaultPaper,
  orientation: contract.defaultOrientation,
  headingPageBreak: contract.defaultHeadingBreak,
  marginTopMm: tenthToMm(contract.defaultMarginsTenthMm.top),
  marginRightMm: tenthToMm(contract.defaultMarginsTenthMm.right),
  marginBottomMm: tenthToMm(contract.defaultMarginsTenthMm.bottom),
  marginLeftMm: tenthToMm(contract.defaultMarginsTenthMm.left),
  printBackgrounds: contract.printBackgrounds,
  headerFooter: contract.headerFooter,
  headerTitle: "",
}

export function formatTenthMm(tenths: number): string {
  const sign = tenths < 0 ? "-" : ""
  const abs = Math.abs(Math.trunc(tenths))
  const whole = Math.trunc(abs / 10)
  const frac = abs % 10
  return frac === 0 ? `${sign}${whole}` : `${sign}${whole}.${frac}`
}

export function formatMm(mm: number): string {
  return formatTenthMm(Math.round(mm * 10))
}

/** Final CSS page box. Landscape swaps the portrait paper, matching `@page { size }`. */
export function pageBoxTenthMm(setup: Pick<PrintSetup, "paper" | "orientation">): {
  widthTenthMm: number
  heightTenthMm: number
} {
  const paper = contract.papers[setup.paper]
  if (setup.orientation === "landscape") {
    return { widthTenthMm: paper.heightTenthMm, heightTenthMm: paper.widthTenthMm }
  }
  return { widthTenthMm: paper.widthTenthMm, heightTenthMm: paper.heightTenthMm }
}

function marginsFit(setup: PrintSetup): boolean {
  const box = pageBoxTenthMm(setup)
  const top = Math.round(setup.marginTopMm * 10)
  const right = Math.round(setup.marginRightMm * 10)
  const bottom = Math.round(setup.marginBottomMm * 10)
  const left = Math.round(setup.marginLeftMm * 10)
  return top + bottom < box.heightTenthMm && left + right < box.widthTenthMm
}

function clampMargin(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  const tenths = Math.round(value * 10)
  const clamped = Math.max(contract.marginMinTenthMm, Math.min(contract.marginMaxTenthMm, tenths))
  return clamped / 10
}

/** Drop a margin pair that would consume the whole page back to the contract default. */
export function sanitizePrintSetup(input: Partial<PrintSetup> | null | undefined): PrintSetup {
  const paper: PaperName = input?.paper === "a4" || input?.paper === "letter"
    ? input.paper
    : contract.defaultPaper
  const orientation: PageOrientation =
    input?.orientation === "landscape" ? "landscape" : contract.defaultOrientation
  const headingPageBreak: HeadingPageBreak =
    input?.headingPageBreak === "h1" || input?.headingPageBreak === "h1-h2"
      ? input.headingPageBreak
      : contract.defaultHeadingBreak
  const candidate: PrintSetup = {
    paper,
    orientation,
    headingPageBreak,
    marginTopMm: clampMargin(input?.marginTopMm, DEFAULT_PRINT_SETUP.marginTopMm),
    marginRightMm: clampMargin(input?.marginRightMm, DEFAULT_PRINT_SETUP.marginRightMm),
    marginBottomMm: clampMargin(input?.marginBottomMm, DEFAULT_PRINT_SETUP.marginBottomMm),
    marginLeftMm: clampMargin(input?.marginLeftMm, DEFAULT_PRINT_SETUP.marginLeftMm),
    printBackgrounds: input?.printBackgrounds === false ? false : contract.printBackgrounds,
    headerFooter: input?.headerFooter === true,
    headerTitle: typeof input?.headerTitle === "string" ? input.headerTitle : "",
  }
  if (marginsFit(candidate)) return candidate
  return {
    ...candidate,
    marginTopMm: DEFAULT_PRINT_SETUP.marginTopMm,
    marginRightMm: DEFAULT_PRINT_SETUP.marginRightMm,
    marginBottomMm: DEFAULT_PRINT_SETUP.marginBottomMm,
    marginLeftMm: DEFAULT_PRINT_SETUP.marginLeftMm,
  }
}

function headingBreakCss(mode: HeadingPageBreak): string {
  if (mode === "h1") {
    return "@media print{body>h1:not(:first-child){break-before:page;page-break-before:always}}"
  }
  if (mode === "h1-h2") {
    return "@media print{body>h1:not(:first-child),body>h2:not(:first-child){break-before:page;page-break-before:always}}"
  }
  return ""
}

function backgroundCss(printBackgrounds: boolean): string {
  return printBackgrounds
    ? "@media print{html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}"
    : ""
}

export function renderPrintCss(setup: PrintSetup): string {
  const box = pageBoxTenthMm(setup)
  const page =
    `@page{size:${formatTenthMm(box.widthTenthMm)}mm ${formatTenthMm(box.heightTenthMm)}mm;` +
    `margin:${formatMm(setup.marginTopMm)}mm ${formatMm(setup.marginRightMm)}mm ` +
    `${formatMm(setup.marginBottomMm)}mm ${formatMm(setup.marginLeftMm)}mm}`
  return `${page}${PRINT_RULES_CSS}${backgroundCss(setup.printBackgrounds)}${headingBreakCss(setup.headingPageBreak)}`
}

/** Normalized marker. The break rule lives in `printRules.css`, not inline. */
export const PAGE_BREAK_HTML = '<div class="page-break"></div>'

function attrValue(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs)
  if (!match) return null
  return match[1] ?? match[2] ?? ""
}

/**
 * Typora's marker is `<div style="page-break-after: always;"></div>`. Also
 * accept an empty `div`/`p`/`hr` whose class token is `page-break` or
 * `pagebreak`, or whose style has `break-after: page`. Any other attribute
 * (an event handler, for example) is rejected so the raw HTML stays escaped.
 */
export function isExplicitPageBreakHtml(raw: string): boolean {
  const trimmed = raw.trim()
  const open = /^<(div|p|hr)\b([^>]*?)\/?>/i.exec(trimmed)
  if (!open) return false
  const tag = open[1].toLowerCase()
  const attrs = open[2] ?? ""
  const rest = trimmed.slice(open[0].length).trim()
  const leftover = attrs
    .replace(/\bclass\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/\bstyle\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .trim()
  if (leftover !== "") return false
  if (tag === "hr") {
    if (rest !== "") return false
  } else if (!new RegExp(`^</${tag}\\s*>$`, "i").test(rest)) {
    return false
  }
  const className = attrValue(attrs, "class")
  if (className?.split(/\s+/).some(token => {
    const name = token.toLowerCase()
    return name === "page-break" || name === "pagebreak"
  })) {
    return true
  }
  const style = attrValue(attrs, "style")
  if (!style) return false
  return style.split(";").some(declaration => {
    const [property, value] = declaration.split(":").map(part => part.trim().toLowerCase())
    return (property === "page-break-after" && value === "always")
      || (property === "break-after" && value === "page")
  })
}
