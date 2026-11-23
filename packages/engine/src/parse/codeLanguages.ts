import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language"
import { css } from "@codemirror/lang-css"
import { markdown } from "@codemirror/lang-markdown"
import { html } from "@codemirror/lang-html"
import { javascript } from "@codemirror/lang-javascript"

/**
 * Fenced-code language table for `lang-markdown`: when a fence's info token
 * matches, its content is parsed by that Lezer grammar (the source of native
 * highlighting while editing). Entries load on demand. CSS / HTML / JavaScript
 * are imported statically because `@codemirror/lang-markdown` already pulls
 * them in for nested fences, so a dynamic import here would only produce a
 * "dynamically imported but also statically imported" warning.
 *
 * Two sources:
 * 1. the official `@codemirror/lang-*` packages (preferred: exact grammar);
 * 2. `@codemirror/legacy-modes` StreamParsers (`StreamLanguage.define`) for the
 *    frequent languages without their own Lezer package (Go / Ruby / Shell /
 *    C# / Kotlin …).
 *
 * Shiki's 60+ language rendered-state highlighting is unaffected — the two
 * systems own one state each: rendered `CodeWidget`s use Shiki, the editing
 * line uses this table. Tokens must stay aligned on both sides (otherwise the
 * same code is highlighted half the time as the caret enters and leaves):
 * every spelling in `shiki/languages.ts`'s LANGUAGE_ALIASES (`sh` / `cs` / `rb`
 * / `kt` / `ps1` / `dockerfile` / `svg` …) must resolve here. Gaps with no
 * implementation (terraform / graphql / tex / vim) only affect the editing
 * state — the rendered state is Shiki's job, and a test keeps that difference
 * honest with an explicit gap list; see docs/memory/gotchas-engine.md.
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
      load: async () => markdown(),
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
