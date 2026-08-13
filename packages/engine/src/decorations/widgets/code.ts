import { BlockWidget, type BlockEmbed } from "../blockWidget"
import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"

const LANGUAGE_ALIASES: Record<string, string> = {
  // 常见缩写
  js:         "javascript",
  ts:         "typescript",
  py:         "python",
  sh:         "bash",
  shell:      "bash",
  zsh:        "bash",
  yml:        "yaml",
  md:         "markdown",
  "c++":      "cpp",
  cc:         "cpp",
  cs:         "csharp",
  rb:         "ruby",
  kt:         "kotlin",
  kts:        "kotlin",
  ps1:        "powershell",
  pwsh:       "powershell",
  tf:         "terraform",
  proto:      "protobuf",
  gql:        "graphql",
  jl:         "julia",
  hs:         "haskell",
  erl:        "erlang",
  clj:        "clojure",
  fs:         "fsharp",
  "f#":       "fsharp",
  asm:        "asm",
  s:          "asm",
  rs:         "rust",
  dockerfile: "docker",
  latex:      "tex",
  lt:         "tex",
  nginx:      "nginx",
  vim:        "vim",
  diff:       "diff",
  patch:      "diff",
  objc:       "objective-c",
  scss:       "scss",
  less:       "less",
  svg:        "xml",
}

const LANGUAGE_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  // Web 前端
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
  // 系统 / 通用
  c:            () => import("shiki/langs/c.mjs"),
  cpp:          () => import("shiki/langs/cpp.mjs"),
  rust:         () => import("shiki/langs/rust.mjs"),
  go:           () => import("shiki/langs/go.mjs"),
  java:         () => import("shiki/langs/java.mjs"),
  kotlin:       () => import("shiki/langs/kotlin.mjs"),
  swift:        () => import("shiki/langs/swift.mjs"),
  "objective-c": () => import("shiki/langs/objective-c.mjs"),
  csharp:       () => import("shiki/langs/csharp.mjs"),
  // 脚本
  python:       () => import("shiki/langs/python.mjs"),
  ruby:         () => import("shiki/langs/ruby.mjs"),
  php:          () => import("shiki/langs/php.mjs"),
  perl:         () => import("shiki/langs/perl.mjs"),
  lua:          () => import("shiki/langs/lua.mjs"),
  r:            () => import("shiki/langs/r.mjs"),
  julia:        () => import("shiki/langs/julia.mjs"),
  dart:         () => import("shiki/langs/dart.mjs"),
  scala:        () => import("shiki/langs/scala.mjs"),
  // 函数式
  haskell:      () => import("shiki/langs/haskell.mjs"),
  elixir:       () => import("shiki/langs/elixir.mjs"),
  erlang:       () => import("shiki/langs/erlang.mjs"),
  clojure:      () => import("shiki/langs/clojure.mjs"),
  fsharp:       () => import("shiki/langs/fsharp.mjs"),
  ocaml:        () => import("shiki/langs/ocaml.mjs"),
  // Shell / DevOps
  bash:         () => import("shiki/langs/bash.mjs"),
  powershell:   () => import("shiki/langs/powershell.mjs"),
  docker:       () => import("shiki/langs/docker.mjs"),
  terraform:    () => import("shiki/langs/terraform.mjs"),
  nginx:        () => import("shiki/langs/nginx.mjs"),
  apache:       () => import("shiki/langs/apache.mjs"),
  // 数据 / 配置
  sql:          () => import("shiki/langs/sql.mjs"),
  json:         () => import("shiki/langs/json.mjs"),
  yaml:         () => import("shiki/langs/yaml.mjs"),
  toml:         () => import("shiki/langs/toml.mjs"),
  xml:          () => import("shiki/langs/xml.mjs"),
  csv:          () => import("shiki/langs/csv.mjs"),
  protobuf:     () => import("shiki/langs/protobuf.mjs"),
  // 标记 / 文档
  markdown:     () => import("shiki/langs/markdown.mjs"),
  tex:          () => import("shiki/langs/tex.mjs"),
  diff:         () => import("shiki/langs/diff.mjs"),
  // 其他
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

let highlighterPromise: Promise<HighlighterCore> | null = null

function getHighlighter(): Promise<HighlighterCore> {
  return highlighterPromise ??= import("shiki/themes/github-light.mjs").then(theme =>
    createHighlighterCore({
      themes: [theme.default],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    }))
}

// 模块级渲染缓存：lang:src → HTML 字符串。
// 相同内容的代码块命中缓存后直接写入，不重跑 Shiki。
// 主要受益场景：src 未变但因文档变化 widget 被重新实例化时（eq 已移除 pos，
// 此处作为双重保险）。
const htmlCache = new Map<string, string>()

export function resolveCodeLanguage(lang: string): string | null {
  const key = lang.trim().toLowerCase()
  if (!key) return null
  const canonical = LANGUAGE_ALIASES[key] ?? key
  return LANGUAGE_LOADERS[canonical] ? canonical : null
}

export class CodeWidget extends BlockWidget {
  constructor(src: string, pos: number, readonly lang: string, embed?: BlockEmbed) {
    super(src, pos, embed)
  }
  eq(other: CodeWidget) { return super.eq(other) && this.lang === other.lang }

  protected get cssClass() { return "omd-code" }

  protected async renderInto(el: HTMLElement) {
    const fallback = () => {
      const pre = document.createElement("pre")
      pre.textContent = this.src
      el.appendChild(pre)
    }
    try {
      const lang = resolveCodeLanguage(this.lang)
      if (!lang) { fallback(); return }

      // 命中缓存：直接写入，跳过整个 Shiki 异步链路
      const cacheKey = `${lang}:${this.src}`
      if (htmlCache.has(cacheKey)) {
        if (this.isActive(el)) el.innerHTML = htmlCache.get(cacheKey)!
        return
      }

      // 性能底线：debounce 150ms。快速打字时 widget 在此期间被销毁（回到编辑态）
      // 则直接放弃，不启动 Shiki，避免阻塞主线程。
      await new Promise(r => setTimeout(r, 150))
      if (!this.isActive(el)) return

      const hl = await getHighlighter()
      if (!this.isActive(el)) return
      if (!hl.getLoadedLanguages().includes(lang)) {
        const grammar = await LANGUAGE_LOADERS[lang]()
        if (!this.isActive(el)) return
        await hl.loadLanguage(grammar.default as never)
        if (!this.isActive(el)) return
      }
      const html = hl.codeToHtml(this.src, { lang, theme: "github-light" })
      htmlCache.set(cacheKey, html)
      if (this.isActive(el)) el.innerHTML = html
    } catch {
      if (this.isActive(el)) fallback()
    }
  }
}
