import { LanguageDescription } from "@codemirror/language"
import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { javascript } from "@codemirror/lang-javascript"

/**
 * lang-markdown 的嵌套代码语言表：fence info 的语言 token 命中后，代码内容由
 * 对应 Lezer 语法解析（编辑态原生高亮的来源）。大部分语言懒加载；CSS / HTML /
 * JavaScript 已由 Markdown/HTML 依赖链静态加载，直接复用以避免无效动态分块警告。
 *
 * 覆盖常用集合（Lezer 官方包）；Shiki 的 63 语言渲染态高亮不受影响 —— 两套
 * 体系各管一态：渲染态 CodeWidget 用 Shiki，编辑态原生行用这套。
 */
/** 单例：同一个描述实例的 load() 完成后，已构建的 codeParser 闭包才能读到
 * support（换成真实 parser）。测试/宿主可用 preloadMarkdownCodeLanguages 预热。 */
let cached: LanguageDescription[] | null = null

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
      name: "C++", alias: ["cpp", "c++", "cxx"], extensions: ["cpp"],
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
      name: "CSS", alias: ["scss"], extensions: [],
      load: async () => css(),
    }),
    LanguageDescription.of({
      name: "HTML", alias: ["htm"], extensions: [],
      load: async () => html(),
    }),
    LanguageDescription.of({
      name: "SQL", alias: ["mysql", "postgres"], extensions: [],
      load: async () => (await import("@codemirror/lang-sql")).sql(),
    }),
    LanguageDescription.of({
      name: "YAML", alias: ["yml"], extensions: [],
      load: async () => (await import("@codemirror/lang-yaml")).yaml(),
    }),
  ]
  return cached
}
