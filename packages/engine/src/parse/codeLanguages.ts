import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language"
import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { javascript } from "@codemirror/lang-javascript"

/**
 * lang-markdown 的嵌套代码语言表：fence info 的语言 token 命中后，代码内容由
 * 对应 Lezer 语法解析（编辑态原生高亮的来源）。全部懒加载；CSS / HTML /
 * JavaScript 已由 Markdown/HTML 依赖链静态加载，直接复用以避免无效动态分块警告。
 *
 * 两级来源：
 * 1. 官方 `@codemirror/lang-*` 包（首选，精确 grammar）；
 * 2. `@codemirror/legacy-modes` 的 StreamParser（`StreamLanguage.define`）——
 *    覆盖没有独立 Lezer 包的高频语言（Go / Ruby / Shell / C# / Kotlin …）。
 *
 * Shiki 的 60+ 语言渲染态高亮不受影响 —— 两套体系各管一态：渲染态 CodeWidget 用
 * Shiki，编辑态原生行用这套。两侧 token 必须尽量对齐（否则同一段代码在光标进出时
 * 一半有高亮一半没有）：`shiki/languages.ts` 的 LANGUAGE_ALIASES 里出现的写法
 * （`sh` / `cs` / `rb` / `kt` / `ps1` / `dockerfile` / `svg` …）都要能在本表命中。
 * 仍无对应实现的缺口（terraform / graphql / tex / vim）只影响编辑态：渲染态由
 * Shiki 侧负责，测试用显式缺口清单守住这份差异，见 docs/memory/gotchas-engine.md。
 */
/** 单例：同一个描述实例的 load() 完成后，已构建的 codeParser 闭包才能读到
 * support（换成真实 parser）。测试/宿主可用 preloadMarkdownCodeLanguages 预热。 */
let cached: LanguageDescription[] | null = null

/** legacy-modes 的 StreamParser 包装成 LanguageDescription 需要的懒加载器
 * （load 的契约类型是 LanguageSupport，legacy-modes 只给 StreamParser）。 */
function legacyMode(load: () => Promise<StreamParser<unknown>>) {
  return async () => new LanguageSupport(StreamLanguage.define(await load()))
}

export function preloadMarkdownCodeLanguages(): Promise<readonly unknown[]> {
  return Promise.all(markdownCodeLanguages().map(d => d.load()))
}

export function markdownCodeLanguages(): LanguageDescription[] {
  if (cached) return cached
  const js = (typescript: boolean, jsx: boolean) => async () =>
    javascript({ typescript, jsx })
  cached = [
    LanguageDescription.of({
      name: "JavaScript", alias: ["js", "jsx", "mjs", "cjs"],
      extensions: [], load: js(false, true),
    }),
    LanguageDescription.of({
      name: "TypeScript", alias: ["ts", "tsx"],
      extensions: [], load: js(true, true),
    }),
    LanguageDescription.of({
      name: "Python", alias: ["py", "python3"],
      extensions: [], load: async () => (await import("@codemirror/lang-python")).python(),
    }),
    LanguageDescription.of({
      name: "Rust", alias: ["rs"],
      extensions: [], load: async () => (await import("@codemirror/lang-rust")).rust(),
    }),
    LanguageDescription.of({
      name: "C++", alias: ["cpp", "c++", "cc", "cxx"], extensions: ["cpp"],
      load: async () => (await import("@codemirror/lang-cpp")).cpp(),
    }),
    LanguageDescription.of({
      name: "C", extensions: ["c"],
      load: async () => (await import("@codemirror/lang-cpp")).cpp(),
    }),
    LanguageDescription.of({
      name: "Java", extensions: [],
      load: async () => (await import("@codemirror/lang-java")).java(),
    }),
    LanguageDescription.of({
      name: "JSON", extensions: ["json"],
      load: async () => (await import("@codemirror/lang-json")).json(),
    }),
    LanguageDescription.of({
      name: "CSS", alias: ["scss", "less"], extensions: [],
      load: async () => css(),
    }),
    LanguageDescription.of({
      name: "HTML", alias: ["htm"], extensions: [],
      load: async () => html(),
    }),
    LanguageDescription.of({
      name: "SQL",
      alias: ["mysql", "postgres", "postgresql", "sqlite", "mariadb", "plsql", "tsql", "mssql"],
      extensions: [],
      load: async () => (await import("@codemirror/lang-sql")).sql(),
    }),
    LanguageDescription.of({
      name: "YAML", alias: ["yml"], extensions: [],
      load: async () => (await import("@codemirror/lang-yaml")).yaml(),
    }),
    LanguageDescription.of({
      name: "Markdown", alias: ["md", "mdx"], extensions: ["md"],
      load: async () => (await import("@codemirror/lang-markdown")).markdown(),
    }),

    // --- legacy-modes：没有独立 Lezer 包的高频语言 -----------------------------
    LanguageDescription.of({
      name: "Go", alias: ["golang"], extensions: ["go"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/go")).go),
    }),
    LanguageDescription.of({
      name: "Bash", alias: ["sh", "shell", "zsh", "console"], extensions: ["sh"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell),
    }),
    LanguageDescription.of({
      name: "Ruby", alias: ["rb"], extensions: ["rb"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/ruby")).ruby),
    }),
    LanguageDescription.of({
      name: "C#", alias: ["csharp", "cs", "dotnet"], extensions: ["cs"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/clike")).csharp),
    }),
    LanguageDescription.of({
      name: "Kotlin", alias: ["kt", "kts"], extensions: ["kt"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/clike")).kotlin),
    }),
    LanguageDescription.of({
      name: "Scala", extensions: ["scala"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/clike")).scala),
    }),
    LanguageDescription.of({
      name: "Dart", extensions: ["dart"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/clike")).dart),
    }),
    LanguageDescription.of({
      name: "Objective-C", alias: ["objc", "objectivec"], extensions: ["m"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/clike")).objectiveC),
    }),
    LanguageDescription.of({
      name: "Swift", extensions: ["swift"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/swift")).swift),
    }),
    LanguageDescription.of({
      name: "R", alias: ["rscript"], extensions: ["r"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/r")).r),
    }),
    LanguageDescription.of({
      name: "Perl", alias: ["pl"], extensions: ["pl"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/perl")).perl),
    }),
    LanguageDescription.of({
      name: "Lua", extensions: ["lua"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/lua")).lua),
    }),
    LanguageDescription.of({
      name: "Groovy", extensions: ["groovy"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/groovy")).groovy),
    }),
    LanguageDescription.of({
      name: "XML", alias: ["svg", "xhtml"], extensions: ["xml", "svg"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/xml")).xml),
    }),
    LanguageDescription.of({
      name: "Diff", alias: ["patch"], extensions: ["diff"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/diff")).diff),
    }),
    LanguageDescription.of({
      name: "Dockerfile", alias: ["docker", "containerfile"], extensions: ["dockerfile"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile),
    }),
    LanguageDescription.of({
      name: "PowerShell", alias: ["ps1", "pwsh"], extensions: ["ps1"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/powershell")).powerShell),
    }),
    LanguageDescription.of({
      name: "TOML", extensions: ["toml"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/toml")).toml),
    }),

    // --- legacy-modes：对齐 Shiki 侧已有、但无独立 Lezer 包的语言 --------------
    LanguageDescription.of({
      name: "Protobuf", alias: ["proto", "protocol-buffers"], extensions: ["proto"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/protobuf")).protobuf),
    }),
    LanguageDescription.of({
      name: "Julia", alias: ["jl"], extensions: ["jl"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/julia")).julia),
    }),
    LanguageDescription.of({
      name: "Haskell", alias: ["hs"], extensions: ["hs"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/haskell")).haskell),
    }),
    LanguageDescription.of({
      name: "Erlang", alias: ["erl"], extensions: ["erl"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/erlang")).erlang),
    }),
    LanguageDescription.of({
      name: "Clojure", alias: ["clj"], extensions: ["clj"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/clojure")).clojure),
    }),
    LanguageDescription.of({
      name: "F#", alias: ["fsharp", "fs", "f#"], extensions: ["fs"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/mllike")).fSharp),
    }),
    LanguageDescription.of({
      name: "OCaml", alias: ["ml"], extensions: ["ml"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/mllike")).oCaml),
    }),
    LanguageDescription.of({
      name: "Nginx", extensions: ["nginx"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/nginx")).nginx),
    }),
    LanguageDescription.of({
      name: "Assembly", alias: ["asm", "s", "gas"], extensions: ["asm", "s"],
      load: legacyMode(async () => (await import("@codemirror/legacy-modes/mode/gas")).gas),
    }),
  ]
  return cached
}
