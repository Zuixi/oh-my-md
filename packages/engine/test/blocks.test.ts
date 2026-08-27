import { describe, expect, it } from "vitest"
import { buildLiveDecorations, collectDecorationSpecs } from "../src/decorations/build"
import { makeState } from "./helpers"

function replaceRanges(doc: string, anchor: number) {
  const state = makeState(doc).update({ selection: { anchor } }).state
  return collectDecorationSpecs(state, 0, doc.length)
    .filter(d => d.tag.startsWith("replace:") || d.tag.startsWith("widget:"))
}

function assertNoReplaceOverlap(ranges: { tag: string; from: number; to: number }[]) {
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i], b = ranges[j]
      expect(
        a.from < b.to && b.from < a.to,
        `${a.tag}@${a.from}-${a.to} overlaps ${b.tag}@${b.from}-${b.to}`,
      ).toBe(false)
    }
  }
}

const tags = (doc: string) => collectDecorationSpecs(makeState(doc), 0, doc.length).map(d => d.tag)

describe("block syntax", () => {
  it("replaces task markers with checkbox widgets", () => {
    const doc = "- [x] done\n- [ ] todo"
    const t = tags(doc)
    expect(t.filter(x => x === "widget:checkbox")).toHaveLength(2)
  })

  it("styles blockquote lines and hides the QuoteMark", () => {
    const doc = "> quoted\n\nnormal"
    let state = makeState(doc)
    state = state.update({ selection: { anchor: doc.length } }).state  // cursor on 'normal' line
    const t = collectDecorationSpecs(state, 0, state.doc.length).map(d => d.tag)
    expect(t).toContain("line:omd-blockquote-1")
    expect(t).toContain("replace:QuoteMark")
  })

  it("hides '> ' immediately while the cursor stays in the quote content", () => {
    const doc = "> quoted"
    const state = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const specs = collectDecorationSpecs(state, 0, doc.length)
    expect(specs.map(d => d.tag)).toContain("line:omd-blockquote-1")
    expect(specs.map(d => `${d.tag}@${d.from}-${d.to}`)).toContain("replace:QuoteMark@0-2")
  })

  it("hides the marker on an empty quote after typing '> '", () => {
    const doc = "> "
    const state = makeState(doc).update({ selection: { anchor: 2 } }).state
    expect(collectDecorationSpecs(state, 0, doc.length).map(d => `${d.tag}@${d.from}-${d.to}`))
      .toContain("replace:QuoteMark@0-2")
  })

  it("reveals the quote marker only when the cursor is inside '> '", () => {
    const doc = "> quoted"
    const onMark = makeState(doc).update({ selection: { anchor: 0 } }).state
    const onSpace = makeState(doc).update({ selection: { anchor: 1 } }).state
    expect(collectDecorationSpecs(onMark, 0, doc.length).map(d => d.tag))
      .not.toContain("replace:QuoteMark")
    expect(collectDecorationSpecs(onSpace, 0, doc.length).map(d => d.tag))
      .not.toContain("replace:QuoteMark")
  })

  it("keeps the quote mark folded under a non-caret selection", () => {
    const doc = "> quoted text\n"
    // 部分行选区压住 "> "（旧 cursorInside 的重叠分支曾在此显源码）
    const partial = makeState(doc).update({ selection: { anchor: 0, head: 5 } }).state
    expect(collectDecorationSpecs(partial, 0, doc.length).map(d => d.tag))
      .toContain("replace:QuoteMark")
    // caret 在引用内容上（越过 "> "）→ 仍折叠
    const inContent = makeState(doc).update({ selection: { anchor: 3 } }).state
    expect(collectDecorationSpecs(inContent, 0, doc.length).map(d => d.tag))
      .toContain("replace:QuoteMark")
    // caret 在 "> " 内部 → 展开（光标仍是编辑入口）
    const onMark = makeState(doc).update({ selection: { anchor: 0 } }).state
    expect(collectDecorationSpecs(onMark, 0, doc.length).map(d => d.tag))
      .not.toContain("replace:QuoteMark")
  })

  it("keeps nested quote and emphasis marks folded when clicking the content", () => {
    const doc = [
      "> **用户反馈**：这个功能很有用！",
      ">",
      "> > **开发团队回复**：感谢您的反馈，我们会继续优化。",
      "> >",
      "> > > **项目经理补充**：预计下个版本会有更多改进。",
    ].join("\n")
    const line = makeState(doc).doc.lineAt(doc.indexOf("感谢您的反馈"))
    const state = makeState(doc).update({ selection: { anchor: doc.indexOf("感谢您的反馈") } }).state
    const tags = collectDecorationSpecs(state, 0, doc.length)
      .filter(d => d.from >= line.from && (d.tag.startsWith("line:") ? d.from === line.from : d.to <= line.to))
      .map(d => d.tag)
    expect(tags.filter(t => t === "replace:QuoteMark")).toHaveLength(2)
    expect(tags.filter(t => t === "replace:EmphasisMark")).toHaveLength(2)
    expect(tags).toContain("line:omd-blockquote-2")
    expect(tags).not.toContain("line:omd-blockquote-1")
    expect(tags).not.toContain("line:omd-blockquote-3")
  })

  it("keeps nested quote marks folded when the whole line is selected", () => {
    const doc = "> > **开发团队回复**：感谢您的反馈"
    const line = makeState(doc).doc.lineAt(0)
    const state = makeState(doc).update({ selection: { anchor: line.from, head: line.to } }).state
    const tags = collectDecorationSpecs(state, 0, doc.length).map(d => d.tag)
    expect(tags.filter(t => t === "replace:QuoteMark")).toHaveLength(2)
    expect(tags.filter(t => t === "replace:EmphasisMark")).toHaveLength(2)
  })

  it("hides nested quote markers while editing the inner text", () => {
    const doc = "> > inner"
    const state = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const marks = collectDecorationSpecs(state, 0, doc.length)
      .filter(d => d.tag === "replace:QuoteMark")
      .map(d => `${d.from}-${d.to}`)
    expect(marks).toEqual(["0-2", "2-4"])
  })

  it("tags each nested quote line with its own depth", () => {
    const doc = "> 最外层\n> > 第一层嵌套\n> > > 第二层嵌套"
    const state = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const depths = collectDecorationSpecs(state, 0, doc.length)
      .filter(d => d.tag.startsWith("line:omd-blockquote"))
      .map(d => `${d.tag}@${d.from}`)
    expect(depths).toEqual([
      `line:omd-blockquote-1@0`,
      `line:omd-blockquote-2@${doc.indexOf("\n") + 1}`,
      `line:omd-blockquote-3@${doc.lastIndexOf("\n") + 1}`,
    ])
  })

  it("renders ordered and bullet lists inside a quote without overlapping replaces", () => {
    const doc = "> 区块中使用列表\n> 1. 第一项\n> 2. 第二项\n> + 第一项\n> + 第二项\n> + 第三项"
    const state = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const specs = collectDecorationSpecs(state, 0, doc.length)
    const tags = specs.map(d => d.tag)
    expect(tags.filter(t => t === "widget:ordered-mark")).toHaveLength(2)
    expect(tags.filter(t => t === "replace:ListMark")).toHaveLength(3)
    expect(tags).toContain("line:omd-blockquote-1")
    expect(tags).toContain("line:omd-li-1")
    expect(tags).not.toContain("line:omd-quote-in-li-1")
    assertNoReplaceOverlap(replaceRanges(doc, doc.length))
    expect(() => buildLiveDecorations(state)).not.toThrow()
  })

  it("styles a quote nested in a list item and hides its indent", () => {
    const doc = "* 第一项\n    > 菜鸟教程\n    > 学的不仅是技术更是梦想\n* 第二项"
    const quoteLine = doc.indexOf("\n") + 1
    const secondQuote = doc.indexOf("\n", quoteLine) + 1
    const state = makeState(doc).update({ selection: { anchor: 0 } }).state
    const specs = collectDecorationSpecs(state, 0, doc.length)
    const tags = specs.map(d => `${d.tag}@${d.from}-${d.to}`)
    expect(tags).toContain(`line:omd-blockquote-1@${quoteLine}-${quoteLine}`)
    expect(tags).toContain(`line:omd-quote-in-li-1@${quoteLine}-${quoteLine}`)
    expect(tags).not.toContain(`line:omd-li-1@${quoteLine}-${quoteLine}`)
    expect(tags).toContain(`line:omd-blockquote-1@${secondQuote}-${secondQuote}`)
    expect(tags).toContain(`line:omd-quote-in-li-1@${secondQuote}-${secondQuote}`)
    expect(tags).not.toContain(`line:omd-li-1@${secondQuote}-${secondQuote}`)
    expect(tags).toContain(`replace:QuoteIndent@${quoteLine}-${quoteLine + 4}`)
    expect(tags).toContain(`replace:QuoteIndent@${secondQuote}-${secondQuote + 4}`)
    expect(tags).toContain(`replace:QuoteMark@${quoteLine + 4}-${quoteLine + 6}`)
    assertNoReplaceOverlap(replaceRanges(doc, 0))
    expect(() => buildLiveDecorations(state)).not.toThrow()
  })

  it("keeps fenced code inside a quote as quote lines, not a block widget", () => {
    const doc = "intro\n\n> ```bash\n> npm install\n> npm start\n> ```\n"
    const state = makeState(doc).update({ selection: { anchor: 0 } }).state
    const tags = collectDecorationSpecs(state, 0, doc.length).map(d => d.tag)
    expect(tags).not.toContain("widget:block:code")
    expect(tags.filter(t => t === "line:omd-codeblock")).toHaveLength(4)
    expect(tags).toContain("line:omd-blockquote-1")
    expect(tags).toContain("replace:QuoteMark")
    expect(tags).toContain("replace:CodeMark")
    assertNoReplaceOverlap(replaceRanges(doc, 0))
  })

  it("keeps table widgets aligned to an enclosing quote", () => {
    const doc = "> | a |\n> |---|\n> | 1 |\n\noutside"
    const state = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const spec = collectDecorationSpecs(state, 0, doc.length)
      .find(d => d.tag === "widget:block:table")
    expect(spec).toBeTruthy()
    expect((spec!.deco.spec.widget as { embed: { quoteDepth: number } }).embed.quoteDepth).toBe(1)
  })

  it("hides heading marks inside a quote while editing the title", () => {
    const doc = "> # 标题"
    const state = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const tags = collectDecorationSpecs(state, 0, doc.length).map(d => d.tag)
    expect(tags).toContain("line:omd-blockquote-1")
    expect(tags).toContain("line:omd-h1")
    expect(tags).toContain("replace:QuoteMark")
    expect(tags).toContain("replace:HeaderMark")
  })

  it("renders emphasis, links, images, and inline code inside a quote", () => {
    const doc = [
      "> 📚 **推荐阅读**",
      ">",
      "> 详细信息请参考 [官方文档](https://example.com)",
      ">",
      "> ![示例图片](./images/example.png)",
      ">",
      "> 执行后会在 `http://localhost:3000` 看到结果。",
      "",
      "outside",
    ].join("\n")
    const state = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const tags = collectDecorationSpecs(state, 0, doc.length).map(d => d.tag)
    expect(tags).toContain("mark:omd-strong")
    expect(tags).toContain("replace:EmphasisMark")
    expect(tags).toContain("mark:omd-link")
    expect(tags).toContain("replace:URL")
    expect(tags).toContain("widget:image")
    expect(tags).toContain("mark:omd-inline-code")
    expect(tags.filter(t => t === "replace:QuoteMark").length).toBeGreaterThan(3)
  })

  it("styles horizontal rule source when the cursor is on it", () => {
    // Doc-start `---` opens front matter, so the hr variant lives mid-doc.
    const doc = "intro\n\n---"
    const state = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const t = collectDecorationSpecs(state, 0, doc.length).map(d => d.tag)
    expect(t).toContain("line:omd-hr")
    expect(t).not.toContain("widget:block:hr")
  })

  it("replaces thematic breaks with a rule widget when the cursor is away", () => {
    const variants = ["***", "* * *", "*****", "- - -", "----------"]
    for (const rule of variants) {
      const doc = `${rule}\n\ntail`
      const s = makeState(doc).update({ selection: { anchor: doc.length } }).state
      const t = collectDecorationSpecs(s, 0, s.doc.length).map(d => d.tag)
      expect(t, rule).toContain("widget:block:hr")
      expect(t, rule).not.toContain("line:omd-hr")
    }
  })

  it("replaces bullet marks, keeps ordered numbers", () => {
    const doc = "- a\n- b\n\n1. first\n"
    const state = makeState(doc)
    // cursor far away so marks fold
    const s = state.update({ selection: { anchor: doc.length } }).state
    const t = collectDecorationSpecs(s, 0, doc.length).map(d => d.tag)
    expect(t.filter(x => x === "replace:ListMark")).toHaveLength(2)
    expect(t).toContain("widget:ordered-mark")
    expect(t).not.toContain("widget:checkbox")
  })

  it("does not bullet task list items (checkbox owns the mark)", () => {
    const t = tags("- [x] done")
    expect(t).toContain("widget:checkbox")
    expect(t).not.toContain("replace:ListMark")
  })

  it("expands bullet mark when cursor is on it", () => {
    const doc = "- item"
    const state = makeState(doc).update({ selection: { anchor: 0 } }).state
    expect(collectDecorationSpecs(state, 0, doc.length).map(d => d.tag)).not.toContain("replace:ListMark")
  })

  it("tags list items with nesting depth classes", () => {
    const t = tags("- outer\n  - inner\n      - deep")
    expect(t).toContain("line:omd-li-1")
    expect(t).toContain("line:omd-li-2")
    expect(t).toContain("line:omd-li-3")
  })

  it("hides source indent spaces when cursor is off the line", () => {
    const doc = "- outer\n  - inner\n\ntail"
    const s = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const t = collectDecorationSpecs(s, 0, doc.length).map(d => `${d.tag}@${d.from}-${d.to}`)
    expect(t).toContain("replace:ListIndent@8-10")
  })

  it("reveals indent spaces on the cursor's line", () => {
    const doc = "- outer\n  - inner"
    const s = makeState(doc).update({ selection: { anchor: 12 } }).state  // cursor on inner line
    expect(collectDecorationSpecs(s, 0, doc.length).map(d => d.tag)).not.toContain("replace:ListIndent")
  })

  it("styles fenced code block lines in edit state (cursor inside)", () => {
    const doc = "```js\nconst x = **not bold**\n```"
    const s = makeState(doc).update({ selection: { anchor: 10 } }).state
    const t = collectDecorationSpecs(s, 0, doc.length).map(d => d.tag)
    expect(t).toContain("widget:block:code")
    expect(t).not.toContain("line:omd-codeblock")
  })

  it("keeps a code widget when the cursor is inside fenced content", () => {
    const doc = "```sh\npnpm install\npnpm dev\n```"
    const content = doc.indexOf("pnpm")
    const s = makeState(doc).update({ selection: { anchor: content } }).state
    const tags = collectDecorationSpecs(s, 0, doc.length).map(d => d.tag)
    expect(tags).toContain("widget:block:code")
    expect(tags).not.toContain("replace:CodeMark")
  })

  it("folds fence marks on no-language fenced code when cursor is away", () => {
    const doc = "```\nplain\n```\n\ntail"
    const s = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const tags = collectDecorationSpecs(s, 0, doc.length).map(d => d.tag)
    expect(tags.filter(t => t === "replace:CodeMark")).toHaveLength(2)
  })

  it("styles fenced code block without language with line styles, not block widget even when cursor is away", () => {
    const doc = "```\nplain text code\nmore text\n```\n\ntail"
    const s = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const t = collectDecorationSpecs(s, 0, doc.length).map(d => d.tag)
    expect(t).not.toContain("widget:block:code")
    expect(t.filter(x => x === "line:omd-codeblock")).toHaveLength(4)
  })

  it("renders fenced code block with language as block widget when cursor is away", () => {
    const doc = "```js\nconst x = 1\n```\n\ntail"
    const s = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const t = collectDecorationSpecs(s, 0, doc.length).map(d => d.tag)
    expect(t).toContain("widget:block:code")
  })

  it("displays sequential ordered numbers even when source numbers skip", () => {
    const doc = "1. 第一项\n3. 第二项\n7. 第三项\n\ntail"
    const s = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const labels = collectDecorationSpecs(s, 0, s.doc.length)
      .filter(d => d.tag === "widget:ordered-mark")
      .map(d => (d.deco.spec.widget as { label: string }).label)
    expect(labels).toEqual(["1.", "2.", "3."])
  })

  it("starts the displayed sequence from the first item's source number", () => {
    const doc = "3. a\n7. b\n\ntail"
    const s = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const labels = collectDecorationSpecs(s, 0, s.doc.length)
      .filter(d => d.tag === "widget:ordered-mark")
      .map(d => (d.deco.spec.widget as { label: string }).label)
    expect(labels).toEqual(["3.", "4."])
  })

  it("shows the source ordered number when the cursor is on that line", () => {
    const doc = "1. 第一项\n3. 第二项\n7. 第三项"
    const second = doc.indexOf("3.")
    const s = makeState(doc).update({ selection: { anchor: second } }).state
    const t = collectDecorationSpecs(s, 0, s.doc.length)
    expect(t.map(d => d.tag).filter(x => x === "widget:ordered-mark")).toHaveLength(2)
    expect(t.map(d => d.tag)).toContain("mark:omd-list-mark")
  })
})
