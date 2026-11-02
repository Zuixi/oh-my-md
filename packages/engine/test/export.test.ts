import { describe, expect, it } from "vitest"
import { exportHtml, exportRichHtml } from "../src/export/html"
import { EXPORT_BODY_CSS } from "../src/export/styles"
import { makeState } from "./helpers"

// 一格同时含有 kbd、sub/sup、带 title 的引用式链接/图片与行内代码里的屏蔽管道：
// 导出与预览都只能丢标记、不能丢任何一个语义容器。
const COMBO_TABLE = [
  "| cell |",
  "|------|",
  "| <kbd>Ctrl</kbd> H~2~O 2^10^ [ref][id] ![pic][img] `a \\| b` |",
  "",
  '[id]: https://r.example "RT"',
  '[img]: ./c.png "CT"',
].join("\n")

describe("html export", () => {
  it("projects headings, emphasis, and lists without rewriting the source", () => {
    const doc = "# Hello\n\nThis is **bold** and `code`.\n\n- one\n- two\n"
    const html = exportHtml(makeState(doc))
    expect(html).toContain("<h1>Hello</h1>")
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain("<code>code</code>")
    expect(html).toContain("<li>")
    expect(html).toContain("one")
    expect(makeState(doc).doc.toString()).toBe(doc)
  })

  it("projects fenced code and tables", () => {
    const doc = "```js\nconst x = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"
    const html = exportHtml(makeState(doc))
    expect(html).toContain("<pre><code")
    expect(html).toContain("const x = 1")
    expect(html).toContain("<table>")
    expect(html).toContain("<th>a</th>")
    expect(html).toContain("<td>1</td>")
  })

  it("exports autolinks and same-document anchors as links", () => {
    const html = exportHtml(makeState("# Guide\n\n[GitHub][]\n\n[GitHub]: https://github.com\n\n<a id=\"custom-anchor\"></a>\n\n<https://www.runoob.com> <foo@bar.com> https://example.com foo@example.com\n\n[Back](#guide)"))
    expect(html).toContain('<a href="https://github.com">GitHub</a>')
    expect(html).toContain('<a id="custom-anchor"></a>')
    expect(html).toContain('<a href="https://www.runoob.com">https://www.runoob.com</a>')
    expect(html).toContain('<a href="mailto:foo@bar.com">foo@bar.com</a>')
    expect(html).toContain('<a href="https://example.com">https://example.com</a>')
    expect(html).toContain('<a href="mailto:foo@example.com">foo@example.com</a>')
    expect(html).toContain('<a href="#guide">Back</a>')
  })

  it("exports rich markdown inside table cells", () => {
    const doc = "| **a** | [x](https://e.com) | ~~del~~ |\n|---|---|---|\n| - one | `code` | > q |\n"
    const html = exportHtml(makeState(doc))
    expect(html).toContain("<th><strong>a</strong></th>")
    expect(html).toContain('<th><a href="https://e.com">x</a></th>')
    expect(html).toContain("<th><del>del</del></th>")
    expect(html).toContain("<td><ul><li>one</li></ul></td>")
    expect(html).toContain("<td><code>code</code></td>")
    expect(html).toContain("<td><blockquote>q</blockquote></td>")
  })

  it("resolves inline and reference link/image semantics with titles", () => {
    const doc = "See [the *site*](https://e.com \"T & T\"), [ref][id], and ![pic][img].\n\n[id]: https://ref.example \"R\"\n[img]: ./p.png \"P\"\n"
    const html = exportHtml(makeState(doc))
    expect(html).toContain('<a href="https://e.com" title="T &amp; T">the <em>site</em></a>')
    expect(html).toContain('<a href="https://ref.example" title="R">ref</a>')
    expect(html).toContain('<img src="./p.png" alt="pic" title="P">')
  })

  it("escapes titles, entity labels and image alt text", () => {
    const doc = "[q](https://q.example 'has \"quotes\"')\n\n[a &amp; b](https://x.example)\n\n![a *b* &amp; c](a.png)\n"
    const html = exportHtml(makeState(doc))
    expect(html).toContain('<a href="https://q.example" title="has &quot;quotes&quot;">q</a>')
    expect(html).toContain('<a href="https://x.example">a &amp; b</a>')
    expect(html).toContain('<img src="a.png" alt="a b &amp; c">')
  })

  it("normalizes www and bare-email autolinks", () => {
    const html = exportHtml(makeState("www.example.com and foo@example.com\n"))
    expect(html).toContain('<a href="https://www.example.com">www.example.com</a>')
    expect(html).toContain('<a href="mailto:foo@example.com">foo@example.com</a>')
  })

  it("resolves reference links and image titles inside table cells", () => {
    const doc = "| [ref][id] | ![pic][img] |\n|---|---|\n\n[id]: https://r.example \"RT\"\n[img]: ./c.png \"CT\"\n"
    const html = exportHtml(makeState(doc))
    expect(html).toContain('<th><a href="https://r.example" title="RT">ref</a></th>')
    expect(html).toContain('<th><img src="./c.png" alt="pic" title="CT"></th>')
  })

  it("projects every cell construct through the single cell model", () => {
    // Plan 01 的对齐表：GFM 管道屏蔽、<br>、列表、图片、行内数学、上下标。
    const doc = [
      "| pipe | break | list | image | math | rise |",
      "|---|---|---|---|---|---|",
      "| a \\| b | before<br>after | - one | ![alt](x.png) | $x_1$ | H~2~O 2^10^ |",
    ].join("\n")
    const html = exportHtml(makeState(doc))
    expect(html).toContain("<td>a | b</td>")
    expect(html).not.toContain("a \\| b")
    expect(html).toContain("<td>before<br>after</td>")
    expect(html).toContain("<td><ul><li>one</li></ul></td>")
    expect(html).toContain('<img src="x.png" alt="alt">')
    // 同步导出没有 KaTeX：cell 数学回退成不带 `$` 标记的 <code>tex</code>
    // （rich 导出渲染 KaTeX），这是 cell 模型丢失数学 mark 后的既定回退。
    expect(html).toContain("<td><code>x_1</code></td>")
    expect(html).toContain("<sub>2</sub>")
    expect(html).toContain("<sup>10</sup>")
  })

  it("resolves cell references defined after the table, with titles", () => {
    const doc = [
      "| link | image |",
      "|---|---|",
      "| [ref][id] | ![pic][img] |",
      "",
      '[id]: https://r.example "RT"',
      '[img]: ./after.png "CT"',
    ].join("\n")
    const html = exportHtml(makeState(doc))
    expect(html).toContain('<th>link</th>')
    expect(html).toContain('<td><a href="https://r.example" title="RT">ref</a></td>')
    expect(html).toContain('<td><img src="./after.png" alt="pic" title="CT"></td>')
    expect(html).not.toContain("[ref][id]")
    expect(html).not.toContain("![pic][img]")
  })

  // `<kbd>` 是固定 HTML 对（不是通用 HTML 栈）：有效对导出真实 <kbd> 容器，
  // 带属性/未闭合/跨块的形状退回字面源码，一个字节都不丢。
  it("exports a fixed <kbd> pair as a kbd container", () => {
    const html = exportHtml(makeState("Press <kbd>Ctrl</kbd> now"))
    expect(html).toContain("<p>Press <kbd>Ctrl</kbd> now</p>")
  })

  it("keeps the inline semantics nested inside a kbd pair", () => {
    const html = exportHtml(makeState("<kbd>**Ctrl** + *K*</kbd>"))
    expect(html).toContain("<kbd><strong>Ctrl</strong> + <em>K</em></kbd>")
  })

  it("exports a kbd pair inside a table cell", () => {
    const html = exportHtml(makeState("| key |\n|---|\n| <kbd>Ctrl</kbd> |"))
    expect(html).toContain("<td><kbd>Ctrl</kbd></td>")
  })

  it("keeps invalid kbd forms literal", () => {
    const cases: Array<[string, string[]]> = [
      ['<kbd class="x">Ctrl</kbd>', ["&lt;kbd class=&quot;x&quot;&gt;Ctrl&lt;/kbd&gt;"]],
      ["<kbd>Ctrl", ["&lt;kbd&gt;Ctrl"]],
      ["<kbd>a\n\nb</kbd>", ["&lt;kbd&gt;a", "b&lt;/kbd&gt;"]],
    ]
    for (const [doc, expected] of cases) {
      const html = exportHtml(makeState(doc))
      for (const snippet of expected) expect(html).toContain(snippet)
      expect(html).not.toContain("<kbd>")
    }
  })

  it("projects kbd beside sub/sup, titled references and a shielded pipe without loss", () => {
    const html = exportHtml(makeState(COMBO_TABLE))
    expect(html).toContain("<kbd>Ctrl</kbd>")
    expect(html).toContain("<sub>2</sub>")
    expect(html).toContain("<sup>10</sup>")
    expect(html).toContain('<a href="https://r.example" title="RT">ref</a>')
    expect(html).toContain('<img src="./c.png" alt="pic" title="CT">')
    expect(html).toContain("<code>a | b</code>")
  })

  it("includes base typography CSS in sync export", () => {
    const html = exportHtml(makeState("# Hi\n\nbody\n"))
    expect(html).toContain(`<style>${EXPORT_BODY_CSS}</style>`)
  })

  it("exports valid complex table HTMLBlock as semantic table and escapes invalid HTMLBlock", () => {
    const doc = [
      "<table>",
      "<thead>",
      "<tr>",
      '<th scope="col" colspan="2" align="center">Header</th>',
      "</tr>",
      "</thead>",
      "<tbody>",
      "<tr>",
      '<td rowspan="2">Span</td>',
      '<td><a href="https://example.com" title="Ex">Link</a><br><img src="./pic.png" alt="pic"></td>',
      "</tr>",
      "<tr>",
      "<td><strong>Cell</strong></td>",
      "</tr>",
      "</tbody>",
      "</table>",
      "",
      "<div>arbitrary html</div>",
    ].join("\n")
    const html = exportHtml(makeState(doc))
    expect(html).toContain('<th colspan="2" scope="col" align="center">Header</th>')
    expect(html).toContain('<td rowspan="2">Span</td>')
    expect(html).toContain('<a href="https://example.com" title="Ex">Link</a><br><img src="./pic.png" alt="pic">')
    expect(html).toContain("<td><strong>Cell</strong></td>")
    expect(html).toContain("&lt;div&gt;arbitrary html&lt;/div&gt;")
  })
})

describe("rich html export", () => {
  it("includes base typography CSS and preserves Shiki dark CSS", async () => {
    const html = await exportRichHtml(makeState("# Hi\n\nbody\n"))
    expect(html).toContain(`<style>${EXPORT_BODY_CSS}</style>`)
    expect(html).toContain("prefers-color-scheme: dark")
  })

  it("injects customCss after the base CSS so user rules win", async () => {
    const custom = ".foo{color:red}"
    const html = await exportRichHtml(makeState("# Hi\n"), { customCss: custom })
    expect(html).toContain(`<style>${EXPORT_BODY_CSS}</style>`)
    expect(html).toContain(`<style>${custom}</style>`)
    expect(html.indexOf(custom)).toBeGreaterThan(html.indexOf(EXPORT_BODY_CSS))
  })

  it("omits customCss style block when not provided", async () => {
    const html = await exportRichHtml(makeState("# Hi\n"))
    expect(html).not.toContain("<style></style>")
  })
})
