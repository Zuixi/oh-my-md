import { LanguageDescription } from "@codemirror/language"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { markdownCodeLanguages, preloadMarkdownCodeLanguages } from "../src/parse/codeLanguages"
import { LANGUAGE_ALIASES, resolveCodeLanguage } from "../src/shiki/languages"

const EXPECTED = [
  "JavaScript", "TypeScript", "Python", "Rust", "C++", "C", "Java", "JSON", "CSS", "HTML",
  "SQL", "YAML", "Markdown",
  "Go", "Bash", "Ruby", "C#", "Kotlin", "Scala", "Dart", "Objective-C", "Swift", "R",
  "Perl", "Lua", "Groovy", "XML", "Diff", "Dockerfile", "PowerShell", "TOML",
  "Protobuf", "Julia", "Haskell", "Erlang", "Clojure", "F#", "OCaml", "Nginx", "Assembly",
]

/** Shiki 有渲染态语法、编辑态暂无对应 CM 语言的 token（只能写纯文本源码）。 */
const EDITING_GAPS = ["tf", "gql", "latex", "lt", "vim"]

const match = (token: string) => LanguageDescription.matchLanguageName(markdownCodeLanguages(), token, true)

describe("nested code languages (editing state)", () => {
  beforeAll(() => preloadMarkdownCodeLanguages())

  it("covers the high-frequency language set", () => {
    const names = markdownCodeLanguages().map(d => d.name)
    for (const name of EXPECTED) expect(names, name).toContain(name)
    // 名字不得重复（重复会让 matchLanguageName 命中先注册的那一个）
    expect(new Set(names).size).toBe(names.length)
  })

  it("loads every entry into a real language", async () => {
    for (const description of markdownCodeLanguages()) {
      await description.load()
      expect(description.support?.language, description.name).toBeTruthy()
    }
  })

  it("resolves fence tokens that Shiki resolves, so both states agree", () => {
    // 渲染态用 Shiki、编辑态用这张表：任一 Shiki 认识的写法在编辑态也必须命中，
    // 否则同一段代码光标进出时一半有高亮一半没有（本测试即两侧对齐的漂移守卫）。
    const shikiTokens = Object.keys(LANGUAGE_ALIASES)
    expect(shikiTokens.length).toBeGreaterThan(20)
    const missing: string[] = []
    for (const token of shikiTokens) {
      if (!resolveCodeLanguage(token)) continue
      if (!match(token)) missing.push(token)
    }
    // 缺口必须与清单完全一致：Shiki 新增别名时本测试失败，提醒补齐 CM 侧。
    expect(missing.sort()).toEqual([...EDITING_GAPS].sort())
  })

  it("resolves the canonical names and extra aliases", () => {
    for (const token of ["go", "golang", "bash", "sh", "shell", "zsh", "ruby", "kotlin", "swift",
      "csharp", "scala", "dart", "perl", "lua", "groovy", "xml", "svg", "diff", "docker",
      "dockerfile", "powershell", "ps1", "pwsh", "toml", "markdown", "md", "sql", "mysql"]) {
      expect(match(token), token).toBeTruthy()
    }
  })

  it("keeps the legacy modes behind lazy loaders", () => {
    const source = readFileSync(resolve(process.cwd(), "src/parse/codeLanguages.ts"), "utf8")
    // 顶层 import 会把整套 legacy-modes 拖进主包；只允许 load() 内的动态 import。
    expect(source).not.toMatch(/^import .*legacy-modes/m)
    expect(source).toContain('import("@codemirror/legacy-modes/mode/go")')
  })
})
