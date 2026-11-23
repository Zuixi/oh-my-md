/**
 * Vendor chunk routing for the desktop bundle.
 *
 * Rollup's default split put every eagerly imported dependency into one
 * ~1.4 MB `index-*.js`, which hid real regressions behind a raised warning
 * limit. These rules keep the startup graph in stable, cacheable vendor chunks
 * while deliberately leaving on-demand assets (Shiki language grammars and
 * themes, CodeMirror language packs, KaTeX's inlined export fonts) in their own
 * lazy chunks — collapsing those into one file would ship megabytes nobody
 * asked for on first paint.
 */

/** Rollup warning budget. Eager chunks must stay below this. */
export const CHUNK_SIZE_WARNING_LIMIT = 850

export interface VendorChunkRule {
  readonly name: string
  /** Matched against a normalized (forward-slash) module id. */
  readonly matches: (id: string) => boolean
}

/**
 * CodeMirror/Lezer modules the editor shell imports eagerly: the view/state
 * core plus the grammars `@codemirror/lang-markdown` pulls in for nested
 * fences. Everything else (`@codemirror/lang-python|rust|cpp|java|json|sql|
 * yaml`, `@codemirror/legacy-modes`, those languages' `@lezer/*` grammars) is
 * resolved from a fenced code block, so it stays in its own on-demand chunk.
 */
const EAGER_CODEMIRROR_MODULES: readonly string[] = [
  "@codemirror/autocomplete",
  "@codemirror/commands",
  "@codemirror/lang-css",
  "@codemirror/lang-html",
  "@codemirror/lang-javascript",
  "@codemirror/lang-markdown",
  "@codemirror/language",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/css",
  "@lezer/highlight",
  "@lezer/html",
  "@lezer/javascript",
  "@lezer/lr",
  "@lezer/markdown",
]

export const VENDOR_CHUNK_RULES: readonly VendorChunkRule[] = [
  {
    name: "vendor-katex",
    // The engine inlines KaTeX's stylesheet and 20 woff2 fonts through
    // `?inline` imports for offline export; those string modules must stay in
    // their own lazy chunks instead of bloating the math renderer.
    matches: id =>
      id.includes("/node_modules/katex/") && !id.includes("?inline") && !id.includes("/dist/fonts/"),
  },
  {
    name: "vendor-codemirror",
    matches: id => EAGER_CODEMIRROR_MODULES.some(moduleName =>
      id.includes(`/node_modules/${moduleName}/`)),
  },
  {
    name: "vendor-react",
    matches: id =>
      id.includes("/node_modules/react/") ||
      id.includes("/node_modules/react-dom/") ||
      id.includes("/node_modules/scheduler/"),
  },
  {
    // IPC bindings and the toast layer are eager but version-stable; keeping
    // them out of the entry chunk is what holds the startup graph under the
    // 700 kB eager budget.
    name: "vendor-tauri",
    matches: id => id.includes("/node_modules/@tauri-apps/"),
  },
  {
    name: "vendor-toastify",
    matches: id => id.includes("/node_modules/react-toastify/"),
  },
  {
    // Shiki's highlighter core only. Grammar and theme modules stay dynamic.
    name: "vendor-shiki-core",
    matches: id =>
      (id.includes("/node_modules/@shikijs/core") ||
        id.includes("/node_modules/@shikijs/engine-") ||
        id.includes("/node_modules/@shikijs/vscode-textmate") ||
        id.includes("/node_modules/shiki/")) &&
      !isGrammarOrThemeModule(id),
  },
]

/**
 * Per-language grammar and theme modules. `shiki/langs/*` is resolved through
 * the package's export map to `shiki/dist/langs/*`, so both spellings (and the
 * `@shikijs/langs` / `@shikijs/themes` packages) are matched.
 */
function isGrammarOrThemeModule(id: string): boolean {
  return /\/@shikijs\/(?:langs|themes)\/|\/shiki\/(?:dist\/)?(?:langs|themes)\//.test(id)
}

/** `manualChunks` target: the vendor chunk for `id`, or undefined for app code. */
export function vendorChunkFor(id: string): string | undefined {
  // Windows builds report backslash paths to Rollup.
  const normalized = id.replace(/\\/g, "/")
  return VENDOR_CHUNK_RULES.find(rule => rule.matches(normalized))?.name
}
