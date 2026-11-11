// Self-contained KaTeX stylesheet for exported documents.
//
// The CSS and all 20 woff2 font files are inlined through Vite's `?inline`
// asset query (base64 data URLs for the fonts, the CSS text itself for the
// stylesheet), so exported math renders without any network access. Every
// `url(fonts/NAME.woff2|woff|ttf)` reference in the stylesheet is rewritten to
// the data URL of `NAME.woff2` before it is inserted into the export document.
//
// Engine Vitest stubs `*.css` modules to an empty string (CSS processing is
// disabled there); export-rich.test.ts re-supplies the real stylesheet through
// vi.mock, so the rewriting pipeline below runs against real CSS in tests too.
// The desktop Vite build inlines the CSS normally.

// One static import specifier per font: Vite must see literal paths to inline
// them, so the specifiers are written out rather than templated.
const FONT_IMPORTS: Readonly<Record<string, () => Promise<string>>> = {
  "KaTeX_AMS-Regular": () => import("katex/dist/fonts/KaTeX_AMS-Regular.woff2?inline").then(m => m.default),
  "KaTeX_Caligraphic-Bold": () => import("katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?inline").then(m => m.default),
  "KaTeX_Caligraphic-Regular": () => import("katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?inline").then(m => m.default),
  "KaTeX_Fraktur-Bold": () => import("katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?inline").then(m => m.default),
  "KaTeX_Fraktur-Regular": () => import("katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?inline").then(m => m.default),
  "KaTeX_Main-Bold": () => import("katex/dist/fonts/KaTeX_Main-Bold.woff2?inline").then(m => m.default),
  "KaTeX_Main-BoldItalic": () => import("katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?inline").then(m => m.default),
  "KaTeX_Main-Italic": () => import("katex/dist/fonts/KaTeX_Main-Italic.woff2?inline").then(m => m.default),
  "KaTeX_Main-Regular": () => import("katex/dist/fonts/KaTeX_Main-Regular.woff2?inline").then(m => m.default),
  "KaTeX_Math-BoldItalic": () => import("katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?inline").then(m => m.default),
  "KaTeX_Math-Italic": () => import("katex/dist/fonts/KaTeX_Math-Italic.woff2?inline").then(m => m.default),
  "KaTeX_SansSerif-Bold": () => import("katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?inline").then(m => m.default),
  "KaTeX_SansSerif-Italic": () => import("katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?inline").then(m => m.default),
  "KaTeX_SansSerif-Regular": () => import("katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?inline").then(m => m.default),
  "KaTeX_Script-Regular": () => import("katex/dist/fonts/KaTeX_Script-Regular.woff2?inline").then(m => m.default),
  "KaTeX_Size1-Regular": () => import("katex/dist/fonts/KaTeX_Size1-Regular.woff2?inline").then(m => m.default),
  "KaTeX_Size2-Regular": () => import("katex/dist/fonts/KaTeX_Size2-Regular.woff2?inline").then(m => m.default),
  "KaTeX_Size3-Regular": () => import("katex/dist/fonts/KaTeX_Size3-Regular.woff2?inline").then(m => m.default),
  "KaTeX_Size4-Regular": () => import("katex/dist/fonts/KaTeX_Size4-Regular.woff2?inline").then(m => m.default),
  "KaTeX_Typewriter-Regular": () => import("katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?inline").then(m => m.default),
}

// Matches url(fonts/NAME.ext), url(./fonts/NAME.ext), and quoted variants.
// NAME is letters/digits/_/-, ext is one of the three formats KaTeX ships.
const FONT_URL_RE = /url\((['"]?)(?:\.\/)?fonts\/([A-Za-z0-9_-]+)\.(?:woff2|woff|ttf)\1\)/g

let cached: Promise<string> | null = null

/** Resolves to the KaTeX stylesheet with every font reference inlined. */
export function loadKatexExportCss(): Promise<string> {
  if (cached === null) {
    cached = buildKatexExportCss().catch((error: unknown) => {
      // Failure must not poison the cache: the next caller retries.
      cached = null
      throw error
    })
  }
  return cached
}

async function buildKatexExportCss(): Promise<string> {
  const cssModule = await import("katex/dist/katex.min.css?inline")
  const css: string = cssModule.default
  // Vitest stubs CSS modules to "" when test CSS processing is disabled;
  // there is nothing to inline (export-rich.test.ts mocks real CSS in).
  if (!css) return ""
  const dataUrls = new Map(await Promise.all(
    Object.entries(FONT_IMPORTS).map(async ([name, load]): Promise<[string, string]> => [name, await load()]),
  ))
  const rewritten = css.replace(FONT_URL_RE, (_match, quote: string, name: string) => {
    const dataUrl = dataUrls.get(name)
    if (dataUrl === undefined) throw new Error(`KaTeX export CSS references unknown font "${name}"`)
    return `url(${quote}${dataUrl}${quote})`
  })
  // Self-containment invariant: no relative fonts/ URL may survive rewriting.
  if (FONT_URL_RE.test(rewritten)) {
    throw new Error("KaTeX export CSS still contains relative fonts/ URLs after inlining")
  }
  return rewritten
}
