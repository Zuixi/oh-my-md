import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import { headingPositionForAnchor, linkAt } from "../src/links"
import { makeState } from "./helpers"

// Build tags with cursor on a separate line (so marks on line 1 are folded).
function tagsOffLine(doc: string) {
  const full = doc + "\nx"
  let state = makeState(full)
  // Move cursor to last character (on the 'x' line).
  state = state.update({ selection: { anchor: full.length } }).state
  return collectDecorationSpecs(state, 0, state.doc.length).map(d => d.tag)
}

// Build tags with cursor at specific position (for cursor-inside tests).
function tagsAt(doc: string, cursor: number) {
  let state = makeState(doc)
  state = state.update({ selection: { anchor: cursor } }).state
  return collectDecorationSpecs(state, 0, state.doc.length).map(d => d.tag)
}

describe("inline marks", () => {
  it("folds strong + emphasis + strikethrough marks", () => {
    expect(tagsOffLine("**bold**").filter(x => x === "replace:EmphasisMark")).toHaveLength(2)
    expect(tagsOffLine("**bold**")).toContain("mark:omd-strong")
    expect(tagsOffLine("*it*")).toContain("mark:omd-em")
    expect(tagsOffLine("~~del~~").filter(x => x === "replace:StrikethroughMark")).toHaveLength(2)
    expect(tagsOffLine("~~del~~")).toContain("mark:omd-del")
  })

  it("folds inline code backticks", () => {
    expect(tagsOffLine("`c`").filter(x => x === "replace:CodeMark")).toHaveLength(2)
    expect(tagsOffLine("`c`")).toContain("mark:omd-inline-code")
  })

  it("folds each link mark and the URL, keeps link text marked", () => {
    const t = tagsOffLine("[text](http://x.com)")
    expect(t.filter(x => x === "replace:LinkMark")).toHaveLength(4)  // [ ] ( )
    expect(t).toContain("replace:URL")
    expect(t).toContain("mark:omd-link")
  })

  it("does not fold URL when cursor is on the same line", () => {
    const doc = "[text](http://x.com)"
    const urlInside = doc.indexOf("http") + 2
    expect(tagsAt(doc, urlInside)).not.toContain("replace:URL")
  })

  it("renders angle-bracket URL and email autolinks as links", () => {
    const tags = tagsOffLine("<https://www.runoob.com> <foo@bar.com> https://example.com foo@example.com")
    expect(tags.filter(x => x === "mark:omd-link")).toHaveLength(4)
    expect(tags.filter(x => x === "replace:URL")).toHaveLength(0)
  })

  it("folds custom HTML anchors without showing the source tag", () => {
    const tags = tagsOffLine('<a id="custom-anchor"></a>Target')
    expect(tags.filter(x => x.startsWith("replace:HTMLTag"))).toHaveLength(2)
  })

  it("resolves autolink targets and heading anchors", () => {
    const doc = "# Guide\n\nhttps://example.com foo@example.com\n\n[Back](#guide)"
    const state = makeState(doc)
    const url = linkAt(state, doc.indexOf("https://") + 2)
    const email = linkAt(state, doc.indexOf("foo@") + 2)
    expect(url?.href).toBe("https://example.com")
    expect(email?.href).toBe("mailto:foo@example.com")
    expect(headingPositionForAnchor(state, "#guide")).toBe(0)

    const custom = makeState('<a id="custom-anchor"></a>Target')
    expect(headingPositionForAnchor(custom, "#custom-anchor")).toBe(0)
  })

  it("keeps the complete reference-link and autolink document visible", () => {
    const doc = `ib

markdown 我喜欢使用 [GitHub][] 来管理代码。

[GitHub]: https://github.com

markdown# 学习资源推荐

## 在线教程

- [MDN Web Docs][mdn] - 权威的 Web 技术文档
- [RUNOOB][rnb] - 适合初学者的教程网站
- [freeCodeCamp][fcc] - 免费的编程学习平台

## 代码托管

- [GitHub][github] - 最受欢迎的代码托管服务
- [GitLab][gitlab] - 企业级的代码管理服务

[mdn]: https://developer.mozilla.org/
[rnb]: https://www.runoob.com/
[fcc]: https://www.freecodecamp.org/
[github]: https://github.com/
[gitlab]: https://gitlab.com/

markdown联系邮箱：example@email.com
或者：<example@email.com>

<https://www.runoob.com>`
    const state = makeState(doc + "\nx").update({ selection: { anchor: doc.length + 1 } }).state
    expect(linkAt(state, doc.indexOf("[GitHub][]") + 2)?.href).toBe("https://github.com")
    expect(linkAt(state, doc.indexOf("[MDN Web Docs][mdn]") + 2)?.href)
      .toBe("https://developer.mozilla.org/")
    expect(state.doc.toString()).toContain("<https://www.runoob.com>")
  })

  it("folds underscore strong/emphasis next to CJK the same way as asterisks", () => {
    expect(tagsOffLine("这是**粗体**")).toContain("mark:omd-strong")
    expect(tagsOffLine("这是__粗体__")).toContain("mark:omd-strong")
    expect(tagsOffLine("这是__粗体__").filter(x => x === "replace:EmphasisMark")).toHaveLength(2)
    expect(tagsOffLine("这是_斜体_")).toContain("mark:omd-em")
  })

  it("does not treat intra-word ASCII underscores as emphasis", () => {
    expect(tagsOffLine("foo_bar_baz")).not.toContain("mark:omd-em")
    expect(tagsOffLine("foo__bar__baz")).not.toContain("mark:omd-strong")
  })

  it("folds ==highlight== markers", () => {
    expect(tagsOffLine("这是==高亮文本==").filter(x => x === "replace:HighlightMark")).toHaveLength(2)
    expect(tagsOffLine("这是==高亮文本==")).toContain("mark:omd-highlight")
  })

  it("folds <mark> tags as highlight", () => {
    expect(tagsOffLine("这是<mark>高亮文本</mark>").filter(x => x === "replace:HighlightMark")).toHaveLength(2)
    expect(tagsOffLine("这是<mark>高亮文本</mark>")).toContain("mark:omd-highlight")
  })

  it("folds <u> tags as underline", () => {
    expect(tagsOffLine("<u>带下划线文本</u>").filter(x => x === "replace:UnderlineMark")).toHaveLength(2)
    expect(tagsOffLine("<u>带下划线文本</u>")).toContain("mark:omd-u")
  })

  it("replaces HTML entities with their characters when the cursor is away", () => {
    const doc = "see &#x1f4da; &#128218; &copy;\nx"
    const state = makeState(doc).update({ selection: { anchor: doc.length } }).state
    const chars = collectDecorationSpecs(state, 0, state.doc.length)
      .filter(d => d.tag === "widget:entity")
      .map(d => (d.deco.spec.widget as { ch: string }).ch)
    expect(chars).toEqual(["📚", "📚", "©"])
  })

  it("shows the entity source when the cursor is inside it", () => {
    const doc = "see &#x1f4da; here"
    const inside = doc.indexOf("#")
    expect(tagsAt(doc, inside)).not.toContain("widget:entity")
  })

  it("leaves unicode emoji as literal text", () => {
    expect(tagsOffLine("📚 推荐")).not.toContain("widget:entity")
  })
})