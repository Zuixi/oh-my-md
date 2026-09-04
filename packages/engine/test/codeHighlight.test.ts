import { beforeAll, describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { forceParsing, syntaxTree } from "@codemirror/language"
import { editorExtensions, codeHighlightStyle } from "../src/index"
import { preloadMarkdownCodeLanguages } from "../src/parse/codeLanguages"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const doc = "intro\n\n```js\nconst x = 1 // hi\n```\n\ntail"

function fullyParsedState(): EditorState {
  // makeState 同款模式：无 view 的 state 解析不完整，挂临时视图 forceParsing。
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.indexOf("const") + 2 },
    extensions: [editorExtensions()],
  })
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({ state, parent })
  forceParsing(view, doc.length, 10_000)
  const complete = view.state
  view.destroy()
  parent.remove()
  return complete
}

describe("Markdown code-language loading", () => {
  it("does not dynamically import language packages already loaded by Markdown and HTML", () => {
    const source = readFileSync(resolve(process.cwd(), "src/parse/codeLanguages.ts"), "utf8")

    for (const packageName of [
      "@codemirror/lang-css",
      "@codemirror/lang-html",
      "@codemirror/lang-javascript",
    ]) {
      expect(source).not.toContain(`import(\"${packageName}\")`)
    }
  })
})

describe("editing-state native code highlighting", () => {
  // 语言懒加载的 skipping-parser 重解析由 view 的 measure 循环驱动（浏览器正常，
  // happy-dom 不触发）。测试先 preload 单例描述 —— codeParser 闭包直接持有真实
  // parser，forceParsing 即可完成嵌套解析。
  beforeAll(() => preloadMarkdownCodeLanguages())

  it("parses js code content with the nested javascript grammar", () => {
    const state = fullyParsedState()
    // 嵌套内容以挂载树形式存在于 CodeText 内 —— Tree.iterate 不下钻挂载树，
    // resolveInner 才会进入（CM 高亮器同款路径）。
    const resolved = syntaxTree(state).resolveInner(doc.indexOf("const") + 1, 1)
    const ancestry: string[] = [resolved.name]
    for (let n = resolved.parent; n; n = n.parent) ancestry.push(n.name)
    expect(ancestry).toContain("VariableDeclaration")  // 嵌套 JS 语法生效
  })

  it("exposes a code highlight style with CSS-variable colors", () => {
    const style = codeHighlightStyle as unknown as { module: Record<string, string> | null }
    const serialized = JSON.stringify(style.module ?? style)
    expect(serialized).toContain("var(--omd-syn-keyword)")
    expect(serialized).toContain("var(--omd-syn-string)")
    expect(serialized).toContain("var(--omd-syn-comment)")
  })
})
