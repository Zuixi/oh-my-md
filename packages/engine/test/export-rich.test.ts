import { describe, expect, it, vi, beforeEach } from "vitest"
import { makeState } from "./helpers"

// 同步导出（export.test.ts）同一组形状的 rich 版本：只该在 cell 数学 / 本地图片上不同。
const COMBO_TABLE = [
  "| cell |",
  "|------|",
  "| <kbd>Ctrl</kbd> H~2~O 2^10^ [ref][id] ![pic][img] `a \\| b` |",
  "",
  '[id]: https://r.example "RT"',
  '[img]: ./c.png "CT"',
].join("\n")

// Mock mermaid so valid diagrams don't stall in happy-dom.
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg>mock-mermaid</svg>" }),
  },
}))

// Import after mocks are set up.
const { exportRichHtml, exportHtml } = await import("../src/export/html")

describe("exportRichHtml", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("sets window.__omdExportReady = true in the script tag", async () => {
    const html = await exportRichHtml(makeState("hello"))
    expect(html).toContain("window.__omdExportReady = true")
  })

  it("renders inline math with KaTeX, not bare <code>$a$</code>", async () => {
    const html = await exportRichHtml(makeState("Here is $a$ inline."))
    // Must contain KaTeX-generated markup (class or style from KaTeX)
    expect(html).toMatch(/katex|<math/)
    // Must NOT be the bare code output from the plain exporter
    expect(html).not.toContain("<code>$a$</code>")
  })

  it("renders block math with KaTeX, not bare <code>", async () => {
    const html = await exportRichHtml(makeState("$$\n\\alpha\n$$"))
    expect(html).toMatch(/katex|<math/)
    expect(html).not.toMatch(/<code>\$\$/)
  })

  it("keeps repeat math exports byte-identical", async () => {
    const state = makeState("$x_1$\n\n$$\ny^2\n$$")
    const first = await exportRichHtml(state)
    const second = await exportRichHtml(state)
    expect(second).toBe(first)
    expect(second).toMatch(/katex|<math/)
  })

  it("renders js fenced code with Shiki highlighting (style attributes or span)", async () => {
    const html = await exportRichHtml(makeState("```js\nconst x = 1\n```"))
    // Shiki output has class or inline style attributes
    expect(html).toMatch(/class=|style=/)
    // tokens appear (may be split across spans)
    expect(html).toContain("const")
  })

  it("emits dual-theme code colors and a dark-scheme stylesheet", async () => {
    const html = await exportRichHtml(makeState("```js\nconst x = 1\n```"))
    expect(html).toContain("--shiki-dark")
    expect(html).toContain("prefers-color-scheme: dark")
  })

  it("renders valid mermaid as SVG", async () => {
    const html = await exportRichHtml(makeState("```mermaid\ngraph TD; A-->B\n```"))
    expect(html).toContain("<svg>")
  })

  it("falls back to escaped source for bad mermaid, does not throw", async () => {
    const { default: mermaid } = await import("mermaid")
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error("parse error"))
    const src = "```mermaid\n!!!invalid syntax!!!\n```"
    const html = await exportRichHtml(makeState(src))
    expect(html).toContain("!!!invalid syntax!!!")
  })

  it("preserves source document (does not mutate state)", async () => {
    const doc = "# Title\n\n$x^2$\n\n```js\nfoo()\n```\n"
    const state = makeState(doc)
    await exportRichHtml(state)
    expect(state.doc.toString()).toBe(doc)
  })

  it("renders $a$ inside a table cell with KaTeX, not bare <code>", async () => {
    const doc = "| math |\n|------|\n| $a$  |\n"
    const html = await exportRichHtml(makeState(doc))
    expect(html).toContain("<table>")
    expect(html).toMatch(/katex|<math/)
    expect(html).not.toContain("<code>$a$</code>")
  })

  it("agrees with sync export on inline/reference link and image semantics", async () => {
    const doc = "See [the *site*](https://e.com \"T & T\"), [ref][id], ![pic][img], www.example.com, foo@example.com, and [a &amp; b](https://x.example).\n\n[id]: https://ref.example \"R\"\n[img]: ./p.png \"P\"\n"
    const sync = exportHtml(makeState(doc))
    const rich = await exportRichHtml(makeState(doc))
    const snippets = [
      '<a href="https://e.com" title="T &amp; T">the <em>site</em></a>',
      '<a href="https://ref.example" title="R">ref</a>',
      '<img src="./p.png" alt="pic" title="P">',
      '<a href="https://www.example.com">www.example.com</a>',
      '<a href="mailto:foo@example.com">foo@example.com</a>',
      '<a href="https://x.example">a &amp; b</a>',
    ]
    for (const snippet of snippets) {
      expect(sync).toContain(snippet)
      expect(rich).toContain(snippet)
    }
  })

  it("resolves reference links and image titles inside rich table cells", async () => {
    const doc = "| [ref][id] | ![pic][img] |\n|---|---|\n\n[id]: https://r.example \"RT\"\n[img]: ./c.png \"CT\"\n"
    const html = await exportRichHtml(makeState(doc))
    expect(html).toContain('<th><a href="https://r.example" title="RT">ref</a></th>')
    expect(html).toContain('<th><img src="./c.png" alt="pic" title="CT"></th>')
  })

  it("projects every cell construct through the single cell model", async () => {
    // Plan 01 的对齐表：与同步导出同一张表，rich 只额外做 KaTeX + resolveImageSrc。
    const doc = [
      "| pipe | break | list | image | math | rise |",
      "|---|---|---|---|---|---|",
      "| a \\| b | before<br>after | - one | ![alt](x.png) | $x_1$ | H~2~O 2^10^ |",
    ].join("\n")
    const html = await exportRichHtml(makeState(doc), {
      resolveImageSrc: src => `file:///w/${src}`,
    })
    expect(html).toContain("<td>a | b</td>")
    expect(html).not.toContain("a \\| b")
    expect(html).toContain("<td>before<br>after</td>")
    expect(html).toContain("<td><ul><li>one</li></ul></td>")
    expect(html).toContain('<img src="file:///w/x.png" alt="alt">')
    // cell 数学走已有的 KaTeX 渲染器，不是同步导出的 <code> 回退。
    expect(html).toMatch(/katex/)
    expect(html).not.toContain("<code>x_1</code>")
    expect(html).toContain("<sub>2</sub>")
    expect(html).toContain("<sup>10</sup>")
  })

  it("resolves cell references defined after the table, with titles", async () => {
    const doc = [
      "| link | image |",
      "|---|---|",
      "| [ref][id] | ![pic][img] |",
      "",
      '[id]: https://r.example "RT"',
      '[img]: ./after.png "CT"',
    ].join("\n")
    const html = await exportRichHtml(makeState(doc), {
      resolveImageSrc: src => `file:///w/${src}`,
    })
    expect(html).toContain('<td><a href="https://r.example" title="RT">ref</a></td>')
    expect(html).toContain('<td><img src="file:///w/./after.png" alt="pic" title="CT"></td>')
    expect(html).not.toContain("[ref][id]")
    expect(html).not.toContain("![pic][img]")
  })

  it("rewrites local relative image src via resolveImageSrc", async () => {
    const doc = "![pic](./pic.png \"P\")"
    const html = await exportRichHtml(makeState(doc), {
      resolveImageSrc: (src) => `file:///resolved/${src}`,
    })
    expect(html).toContain('file:///resolved/./pic.png')
    expect(html).toContain('alt="pic"')
    expect(html).toContain('title="P"')
  })

  it("rewrites a reference image src without dropping alt or title", async () => {
    const doc = "![pic][img]\n\n[img]: ./ref.png \"CT\"\n"
    const html = await exportRichHtml(makeState(doc), {
      resolveImageSrc: (src) => `file:///resolved/${src}`,
    })
    expect(html).toContain('<img src="file:///resolved/./ref.png" alt="pic" title="CT">')
  })

  it("exports valid complex table HTMLBlock with resolveImageSrc and escapes invalid HTMLBlock", async () => {
    const doc = [
      "<table>",
      "<tbody>",
      "<tr>",
      '<td rowspan="2">A</td>',
      '<td><img src="./local.png" alt="local" title="LT"></td>',
      "</tr>",
      "<tr>",
      '<td><img src="https://example.com/remote.png" alt="remote"></td>',
      "</tr>",
      "</tbody>",
      "</table>",
      "",
      "<table><tbody><tr><td onclick=\"alert(1)\">bad</td></tr></tbody></table>",
    ].join("\n")
    const html = await exportRichHtml(makeState(doc), {
      resolveImageSrc: (src) => `file:///resolved/${src}`,
    })
    expect(html).toContain('<td rowspan="2">A</td>')
    expect(html).toContain('<img src="file:///resolved/./local.png" alt="local" title="LT">')
    expect(html).toContain('<img src="https://example.com/remote.png" alt="remote">')
    expect(html).toContain("&lt;table&gt;&lt;tbody&gt;&lt;tr&gt;&lt;td onclick=&quot;alert(1)&quot;&gt;bad&lt;/td&gt;&lt;/tr&gt;&lt;/tbody&gt;&lt;/table&gt;")
  })

  it("exports a fixed <kbd> pair as a kbd container", async () => {
    const html = await exportRichHtml(makeState("Press <kbd>Ctrl</kbd> now"))
    expect(html).toContain("<p>Press <kbd>Ctrl</kbd> now</p>")
  })

  it("keeps the inline semantics nested inside a kbd pair", async () => {
    const html = await exportRichHtml(makeState("<kbd>**Ctrl** + *K*</kbd>"))
    expect(html).toContain("<kbd><strong>Ctrl</strong> + <em>K</em></kbd>")
  })

  it("exports a kbd pair inside a table cell", async () => {
    const html = await exportRichHtml(makeState("| key |\n|---|\n| <kbd>Ctrl</kbd> |"))
    expect(html).toContain("<td><kbd>Ctrl</kbd></td>")
  })

  it("keeps invalid kbd forms literal", async () => {
    const cases: Array<[string, string[]]> = [
      ['<kbd class="x">Ctrl</kbd>', ["&lt;kbd class=&quot;x&quot;&gt;Ctrl&lt;/kbd&gt;"]],
      ["<kbd>Ctrl", ["&lt;kbd&gt;Ctrl"]],
      ["<kbd>a\n\nb</kbd>", ["&lt;kbd&gt;a", "b&lt;/kbd&gt;"]],
    ]
    for (const [doc, expected] of cases) {
      const html = await exportRichHtml(makeState(doc))
      for (const snippet of expected) expect(html).toContain(snippet)
      expect(html).not.toContain("<kbd>")
    }
  })

  it("projects kbd beside sub/sup, titled references and a shielded pipe without loss", async () => {
    const html = await exportRichHtml(makeState(COMBO_TABLE), {
      resolveImageSrc: src => `file:///w/${src}`,
    })
    expect(html).toContain("<kbd>Ctrl</kbd>")
    expect(html).toContain("<sub>2</sub>")
    expect(html).toContain("<sup>10</sup>")
    expect(html).toContain('<a href="https://r.example" title="RT">ref</a>')
    expect(html).toContain('<img src="file:///w/./c.png" alt="pic" title="CT">')
    expect(html).toContain("<code>a | b</code>")
  })

  it("does not rewrite remote http image src", async () => {
    const doc = "![alt](http://example.com/img.png)"
    const html = await exportRichHtml(makeState(doc), {
      resolveImageSrc: () => "should-not-be-used",
    })
    expect(html).toContain("http://example.com/img.png")
    expect(html).toContain('alt="alt"')
    expect(html).not.toContain("should-not-be-used")
  })
})
