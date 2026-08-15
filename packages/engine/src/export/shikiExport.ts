// Shiki helpers for the rich-HTML exporter. Reuses resolveCodeLanguage from
// the code widget so language aliases stay in one place.
export { resolveCodeLanguage } from "../decorations/widgets/code"

import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"

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

// Dynamic language loaders – identical list to code.ts but kept local so we
// don't tightly couple the export path to the widget internals.
const LANGUAGE_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  javascript:   () => import("shiki/langs/javascript.mjs"),
  typescript:   () => import("shiki/langs/typescript.mjs"),
  jsx:          () => import("shiki/langs/jsx.mjs"),
  tsx:          () => import("shiki/langs/tsx.mjs"),
  html:         () => import("shiki/langs/html.mjs"),
  css:          () => import("shiki/langs/css.mjs"),
  scss:         () => import("shiki/langs/scss.mjs"),
  less:         () => import("shiki/langs/less.mjs"),
  vue:          () => import("shiki/langs/vue.mjs"),
  svelte:       () => import("shiki/langs/svelte.mjs"),
  graphql:      () => import("shiki/langs/graphql.mjs"),
  c:            () => import("shiki/langs/c.mjs"),
  cpp:          () => import("shiki/langs/cpp.mjs"),
  rust:         () => import("shiki/langs/rust.mjs"),
  go:           () => import("shiki/langs/go.mjs"),
  java:         () => import("shiki/langs/java.mjs"),
  kotlin:       () => import("shiki/langs/kotlin.mjs"),
  swift:        () => import("shiki/langs/swift.mjs"),
  "objective-c": () => import("shiki/langs/objective-c.mjs"),
  csharp:       () => import("shiki/langs/csharp.mjs"),
  python:       () => import("shiki/langs/python.mjs"),
  ruby:         () => import("shiki/langs/ruby.mjs"),
  php:          () => import("shiki/langs/php.mjs"),
  perl:         () => import("shiki/langs/perl.mjs"),
  lua:          () => import("shiki/langs/lua.mjs"),
  r:            () => import("shiki/langs/r.mjs"),
  julia:        () => import("shiki/langs/julia.mjs"),
  dart:         () => import("shiki/langs/dart.mjs"),
  scala:        () => import("shiki/langs/scala.mjs"),
  haskell:      () => import("shiki/langs/haskell.mjs"),
  elixir:       () => import("shiki/langs/elixir.mjs"),
  erlang:       () => import("shiki/langs/erlang.mjs"),
  clojure:      () => import("shiki/langs/clojure.mjs"),
  fsharp:       () => import("shiki/langs/fsharp.mjs"),
  ocaml:        () => import("shiki/langs/ocaml.mjs"),
  bash:         () => import("shiki/langs/bash.mjs"),
  powershell:   () => import("shiki/langs/powershell.mjs"),
  docker:       () => import("shiki/langs/docker.mjs"),
  terraform:    () => import("shiki/langs/terraform.mjs"),
  nginx:        () => import("shiki/langs/nginx.mjs"),
  apache:       () => import("shiki/langs/apache.mjs"),
  sql:          () => import("shiki/langs/sql.mjs"),
  json:         () => import("shiki/langs/json.mjs"),
  yaml:         () => import("shiki/langs/yaml.mjs"),
  toml:         () => import("shiki/langs/toml.mjs"),
  xml:          () => import("shiki/langs/xml.mjs"),
  csv:          () => import("shiki/langs/csv.mjs"),
  protobuf:     () => import("shiki/langs/protobuf.mjs"),
  markdown:     () => import("shiki/langs/markdown.mjs"),
  tex:          () => import("shiki/langs/tex.mjs"),
  diff:         () => import("shiki/langs/diff.mjs"),
  asm:          () => import("shiki/langs/asm.mjs"),
  vim:          () => import("shiki/langs/vim.mjs"),
  groovy:       () => import("shiki/langs/groovy.mjs"),
  solidity:     () => import("shiki/langs/solidity.mjs"),
  zig:          () => import("shiki/langs/zig.mjs"),
  nim:          () => import("shiki/langs/nim.mjs"),
  crystal:      () => import("shiki/langs/crystal.mjs"),
  matlab:       () => import("shiki/langs/matlab.mjs"),
  prolog:       () => import("shiki/langs/prolog.mjs"),
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
