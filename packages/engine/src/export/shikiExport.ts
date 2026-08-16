// Shiki helpers for the rich-HTML exporter. Shares the language alias + loader
// map with the code widget so both paths resolve the same languages.
import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { LANGUAGE_LOADERS, resolveCodeLanguage } from "../shiki/languages"

export { resolveCodeLanguage }

// Separate highlighter instance for export (avoids sharing lazy-loaded langs
// with the live-preview widget, which has a 150 ms debounce).
let exportHighlighterPromise: Promise<HighlighterCore> | null = null

function getExportHighlighter(): Promise<HighlighterCore> {
  return exportHighlighterPromise ??= import("shiki/themes/github-light.mjs").then(theme =>
    createHighlighterCore({
      themes: [theme.default],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    }))
}

export async function getHighlighterForExport(lang: string): Promise<HighlighterCore> {
  const hl = await getExportHighlighter()
  if (!hl.getLoadedLanguages().includes(lang)) {
    const loader = LANGUAGE_LOADERS[lang]
    if (loader) {
      const grammar = await loader()
      await hl.loadLanguage(grammar.default as never)
    }
  }
  return hl
}
