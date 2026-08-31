import type { HighlighterCore } from "shiki/core"

let highlighterPromise: Promise<HighlighterCore> | null = null

async function createCodeHighlighter(): Promise<HighlighterCore> {
  const [core, engine, light, dark] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-light.mjs"),
    import("shiki/themes/github-dark.mjs"),
  ])

  return core.createHighlighterCore({
    themes: [light.default, dark.default],
    langs: [],
    engine: engine.createJavaScriptRegexEngine(),
  })
}

export function getCodeHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createCodeHighlighter().catch(error => {
      highlighterPromise = null
      throw error
    })
  }

  return highlighterPromise
}
