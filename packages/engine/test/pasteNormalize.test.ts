import { afterEach, describe, expect, it } from "vitest"
import { MAX_PASTE_DOM_DEPTH, MAX_PASTE_DOM_NODES } from "../src/paste/limits"
import type { PasteBlock, PasteInline, PasteTable, PreparedSmartPaste } from "../src/paste/model"
import {
  normalizeHtmlPaste,
  normalizeHtmlPasteWithinLimits,
  preparePlainTextFallback,
} from "../src/paste/normalizeHtml"

// Inert HTML normalizer contract (plan 02 Task 2). Every expectation below is a
// human-authored literal AST: normalizer output is compared whole, so a stray
// attribute, style string or wrapper cannot sneak through unnoticed.

type Wrapper = "strong" | "emphasis" | "strike" | "highlight" | "underline" | "kbd" | "subscript" | "superscript"

function text(value: string): PasteInline {
  return { type: "text", value }
}
function wrap(type: Wrapper, ...children: PasteInline[]): PasteInline {
  return { type, children }
}
function code(value: string): PasteInline {
  return { type: "code", value }
}
function hardBreak(): PasteInline {
  return { type: "hardBreak" }
}
function paragraph(...children: PasteInline[]): PasteBlock {
  return { type: "paragraph", children }
}
function heading(level: 1 | 2 | 3 | 4 | 5 | 6, ...children: PasteInline[]): PasteBlock {
  return { type: "heading", level, children }
}
function list(ordered: boolean, start: number | null, ...children: readonly PasteBlock[][]): PasteBlock {
  return { type: "list", ordered, start, items: children.map(blocks => ({ checked: null, children: blocks })) }
}
function checkedList(checks: readonly (boolean | null)[], ...children: readonly PasteBlock[][]): PasteBlock {
  return {
    type: "list",
    ordered: false,
    start: null,
    items: children.map((blocks, index) => ({ checked: checks[index] ?? null, children: blocks })),
  }
}
function blockquote(...children: PasteBlock[]): PasteBlock {
  return { type: "blockquote", children }
}
function codeBlock(value: string, language = ""): PasteBlock {
  return { type: "codeBlock", language, value }
}
function table(rows: PasteTable["rows"], requiresComplexHtml = false): PasteBlock {
  return { type: "table", table: { rows, requiresComplexHtml } }
}
function semantic(
  blocks: readonly PasteBlock[],
  extra: Partial<PreparedSmartPaste> = {},
): PreparedSmartPaste {
  return {
    policy: "semantic",
    document: { blocks },
    plainText: "",
    assets: [],
    unavailableImageKeys: [],
    isSingleImageOnly: false,
    diagnostics: [],
    ...extra,
  }
}

function paste(html: string, plainText = ""): PreparedSmartPaste {
  return normalizeHtmlPaste({ html, plainText })
}

/** 没有可见文本可以写时，浏览器给的最小 HTML 也必须产出空文档。 */
function emptyDocument(): PasteBlock[] {
  return []
}

describe("normalizeHtmlPaste — semantic tags", () => {
  it("maps every supported semantic inline tag to its typed node", () => {
    const html = [
      "<p><strong>b</strong> <em>i</em> <u>u</u> <s>s</s> <del>d</del> <strike>t</strike>",
      "<mark>m</mark> <kbd>k</kbd> <sub>2</sub><sup>3</sup> <code>c_q</code></p>",
    ].join(" ")
    expect(paste(html)).toEqual(
      semantic([
        paragraph(
          wrap("strong", text("b")),
          text(" "),
          wrap("emphasis", text("i")),
          text(" "),
          wrap("underline", text("u")),
          text(" "),
          wrap("strike", text("s")),
          text(" "),
          wrap("strike", text("d")),
          text(" "),
          wrap("strike", text("t")),
          text(" "),
          wrap("highlight", text("m")),
          text(" "),
          wrap("kbd", text("k")),
          text(" "),
          wrap("subscript", text("2")),
          wrap("superscript", text("3")),
          text(" "),
          code("c_q"),
        ),
      ]),
    )
  })

  it("collapses repeated nesting and adjacent identical semantics", () => {
    expect(paste("<p><strong><strong>deep</strong></strong> <em>a</em><em>b</em></p>")).toEqual(
      semantic([paragraph(wrap("strong", text("deep")), text(" "), wrap("emphasis", text("ab")))]),
    )
  })

  it("drops empty semantic wrappers", () => {
    expect(paste("<p>before<strong></strong>after</p>")).toEqual(
      semantic([paragraph(text("beforeafter"))]),
    )
  })
})

describe("normalizeHtmlPaste — inline style input", () => {
  // Exact input from plan 02 Task 2 Step 1: only semantic CSS survives.
  const STYLE_INPUT = [
    "<p>",
    '  <span style="color:#111;background:#fff;font-size:15px">plain</span>',
    '  <span style="font-weight:700">bold</span>',
    '  <span style="font-style:italic;text-decoration-line:underline line-through">mixed</span>',
    "</p>",
  ].join("\n")

  it("keeps only strong/emphasis/underline/strike from CSS", () => {
    expect(paste(STYLE_INPUT)).toEqual(
      semantic(
        [paragraph(text("plain "), wrap("strong", text("bold")), text(" "), wrap("emphasis", wrap("underline", wrap("strike", text("mixed")))))],
        { diagnostics: [{ kind: "droppedStyle", count: 3 }] },
      ),
    )
  })

  it("never leaks style strings, classes, colours or font sizes into the AST", () => {
    const payload = JSON.stringify(paste(STYLE_INPUT))
    for (const forbidden of ["style", "color", "#111", "class", "font-size", "15px", "background"]) {
      expect(payload).not.toContain(forbidden)
    }
  })

  it("recognises bold/bolder/numeric weights, oblique and text-decoration shorthand", () => {
    expect(paste('<p><span style="font-weight:bold">a</span> <span style="font-weight:600">b</span> <span style="font-weight:bolder">c</span></p>')).toEqual(
      semantic([
        paragraph(
          wrap("strong", text("a")),
          text(" "),
          wrap("strong", text("b")),
          text(" "),
          wrap("strong", text("c")),
        ),
      ]),
    )
    expect(paste('<p><span style="font-style:oblique">o</span><span style="text-decoration:underline">u</span></p>')).toEqual(
      semantic([paragraph(wrap("emphasis", text("o")), wrap("underline", text("u")))]),
    )
  })

  it("counts presentation-only declarations as droppedStyle and leaves non-bold weights as text", () => {
    expect(
      paste('<p><span style="font-weight:300;color:red;margin:0">thin</span></p>'),
    ).toEqual(semantic([paragraph(text("thin"))], { diagnostics: [{ kind: "droppedStyle", count: 3 }] }))
  })

  it("ignores class, data-* and Office attributes entirely", () => {
    expect(paste('<div class=WordSection1><p class=MsoNormal data-x="1" style="margin:0 0 8pt">Word body text</p></div>')).toEqual(
      semantic([paragraph(text("Word body text"))], { diagnostics: [{ kind: "droppedStyle", count: 1 }] }),
    )
  })
})

describe("normalizeHtmlPaste — whitespace, NBSP, pre and br", () => {
  it("collapses HTML whitespace once and trims block edges", () => {
    expect(paste("<p>  a   b\t c  </p>")).toEqual(semantic([paragraph(text("a b c"))]))
  })

  it("preserves NBSP as visible content", () => {
    expect(paste("<p>keep&nbsp;together</p>")).toEqual(semantic([paragraph(text("keep\u00A0together"))]))
  })

  it("converts br to hardBreak and drops the spaces around it", () => {
    expect(paste("<p>first line<br>second line</p>")).toEqual(
      semantic([paragraph(text("first line"), hardBreak(), text("second line"))]),
    )
    expect(paste("<p>a <br> b</p>")).toEqual(semantic([paragraph(text("a"), hardBreak(), text("b"))]))
  })

  it("keeps separate paragraphs apart", () => {
    expect(paste("<p>a</p>\n<p>b</p>")).toEqual(semantic([paragraph(text("a")), paragraph(text("b"))]))
  })

  it("keeps pre bytes verbatim and reads the code language from the class", () => {
    expect(paste('<pre><code class="language-ts">const x = 1\r\n</code></pre>')).toEqual(
      semantic([codeBlock("const x = 1", "ts")]),
    )
    expect(paste("<pre>plain   spacing\n\ttabbed</pre>")).toEqual(
      semantic([codeBlock("plain   spacing\n\ttabbed")]),
    )
  })
})

describe("normalizeHtmlPaste — headings, blockquote, lists", () => {
  it("maps h1..h6 to heading levels", () => {
    expect(paste("<h1>Title</h1><h3>Read <em>this</em></h3>")).toEqual(
      semantic([heading(1, text("Title")), heading(3, text("Read "), wrap("emphasis", text("this")))]),
    )
  })

  it("keeps multi-paragraph blockquotes", () => {
    expect(paste("<blockquote><p>quoted line</p><p>second paragraph</p></blockquote>")).toEqual(
      semantic([blockquote(paragraph(text("quoted line")), paragraph(text("second paragraph")))]),
    )
  })

  it("retains ordered start and nested list structure", () => {
    expect(paste('<ol start="3"><li>third</li><li>fourth</li></ol>')).toEqual(
      semantic([list(true, 3, [paragraph(text("third"))], [paragraph(text("fourth"))])]),
    )
    expect(paste("<ol><li>only</li></ol>")).toEqual(semantic([list(true, null, [paragraph(text("only"))])]))
  })

  it("nests lists inside their list item", () => {
    expect(
      paste("<ul><li>parent<ul><li>child</li><li>second child</li></ul></li><li>sibling</li></ul>"),
    ).toEqual(
      semantic([
        list(false, null, [paragraph(text("parent")), list(false, null, [paragraph(text("child"))], [paragraph(text("second child"))])], [paragraph(text("sibling"))]),
      ]),
    )
  })

  it("reads only a leading direct-child checkbox into checked state", () => {
    expect(
      paste('<ul><li><input type="checkbox" checked> shipped</li><li><input type="checkbox"> pending</li><li>plain</li></ul>'),
    ).toEqual(
      semantic([
        checkedList(
          [true, false, null],
          [paragraph(text("shipped"))],
          [paragraph(text("pending"))],
          [paragraph(text("plain"))],
        ),
      ]),
    )
  })

  it("ignores checkboxes that are not the leading direct child", () => {
    const result = paste('<ul><li>before <input type="checkbox" checked> after</li></ul>')
    expect(result).toEqual(semantic([checkedList([null], [paragraph(text("before after"))])]))
  })
})

describe("normalizeHtmlPaste — links, images and URLs", () => {
  it("keeps https links with title and label children", () => {
    expect(paste('<p>See <a href="https://example.com/docs" title="Docs">the docs</a> now</p>')).toEqual(
      semantic([
        paragraph(
          text("See "),
          { type: "link", href: "https://example.com/docs", title: "Docs", children: [text("the docs")] },
          text(" now"),
        ),
      ]),
    )
  })

  it("keeps adjacent links with different targets separate", () => {
    expect(paste('<p><a href="https://a.example">one</a><a href="https://b.example">two</a></p>')).toEqual(
      semantic([
        paragraph(
          { type: "link", href: "https://a.example", title: null, children: [text("one")] },
          { type: "link", href: "https://b.example", title: null, children: [text("two")] },
        ),
      ]),
    )
  })

  it("turns a rejected link URL into safe visible text plus rejectedUrl", () => {
    expect(paste('<p><a href="javascript:alert(1)">click</a></p>')).toEqual(
      semantic([paragraph(text("click"))], { diagnostics: [{ kind: "rejectedUrl", count: 1 }] }),
    )
    expect(paste('<p><a href="vbscript:msgbox(1)">run</a> <a href="JaVaScRiPt:alert(1)">mixed</a></p>')).toEqual(
      semantic([paragraph(text("run mixed"))], { diagnostics: [{ kind: "rejectedUrl", count: 2 }] }),
    )
  })

  it("keeps http image sources and flags a single image clipboard", () => {
    expect(paste('<p><img src="https://example.com/chart.png" alt="chart"></p>')).toEqual(
      semantic(
        [
          paragraph({
            type: "image",
            alt: "chart",
            title: null,
            source: { kind: "url", value: "https://example.com/chart.png" },
          }),
        ],
        { isSingleImageOnly: true },
      ),
    )
  })

  it("extracts data:image payloads into a PasteAsset before URL policy runs", () => {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    const result = paste(`<p><img src="data:image/png;base64,${base64}" alt="pixel"></p>`)
    expect(result).toEqual(
      semantic(
        [
          paragraph({
            type: "image",
            alt: "pixel",
            title: null,
            source: { kind: "embedded", key: "paste-embedded-1", mime: "image/png", base64 },
          }),
        ],
        { assets: [{ key: "paste-embedded-1", mime: "image/png", base64, alt: "pixel" }], isSingleImageOnly: true },
      ),
    )
  })

  it("rejects non-image and malformed data payloads through the URL policy", () => {
    for (const src of [
      "data:text/html;base64,PHNjcmlwdD4=",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:image/png;base64,",
      "data:image/png;base64,@@not base64@@",
    ]) {
      expect(paste(`<p><img src="${src}" alt="payload"></p>`)).toEqual(
        semantic([paragraph(text("payload"))], { diagnostics: [{ kind: "rejectedUrl", count: 1 }] }),
      )
    }
  })

  it("marks blob and file images unavailable and keeps the alt text", () => {
    const result = paste('<p><img src="blob:https://example.com/x" alt="shot"></p><p><img src="file:///tmp/a.png" alt="local"></p>')
    expect(result).toEqual(
      semantic(
        [
          paragraph({ type: "image", alt: "shot", title: null, source: { kind: "unavailable", key: "paste-unavailable-1" } }),
          paragraph({ type: "image", alt: "local", title: null, source: { kind: "unavailable", key: "paste-unavailable-2" } }),
        ],
        { unavailableImageKeys: ["paste-unavailable-1", "paste-unavailable-2"] },
      ),
    )
  })

  it("keeps a title on images and marks mixed documents as not single-image", () => {
    const result = paste('<p><img src="a.png" alt="a" title="T"> plus text</p>')
    expect(result.isSingleImageOnly).toBe(false)
    expect(result.document.blocks).toEqual([
      paragraph(
        { type: "image", alt: "a", title: "T", source: { kind: "url", value: "a.png" } },
        text(" plus text"),
      ),
    ])
  })
})

describe("normalizeHtmlPaste — tables", () => {
  const simple = "<table><thead><tr><th>name</th><th>role</th></tr></thead><tbody><tr><td>Ada</td><td>engineer</td></tr></tbody></table>"

  it("builds simple GFM-representable rows with header flags", () => {
    expect(paste(simple)).toEqual(
      semantic([
        table([
          {
            cells: [
              { header: true, scope: null, rowSpan: 1, colSpan: 1, align: null, blocks: [paragraph(text("name"))] },
              { header: true, scope: null, rowSpan: 1, colSpan: 1, align: null, blocks: [paragraph(text("role"))] },
            ],
          },
          {
            cells: [
              { header: false, scope: null, rowSpan: 1, colSpan: 1, align: null, blocks: [paragraph(text("Ada"))] },
              { header: false, scope: null, rowSpan: 1, colSpan: 1, align: null, blocks: [paragraph(text("engineer"))] },
            ],
          },
        ]),
      ]),
    )
  })

  it("keeps align, spans and th scope as semantic cell facts", () => {
    const html = '<table><thead><tr><th scope="col" align="left">Left</th><th scope="col" align="center">Mid</th><th scope="col" align="right">Right</th></tr></thead><tbody><tr><th scope="row">Row</th><td>a</td><td>b</td></tr></tbody></table>'
    const parsed = paste(html).document.blocks[0]
    if (parsed.type !== "table") throw new Error("expected a table block")
    expect(parsed.table.requiresComplexHtml).toBe(false)
    expect(parsed.table.rows[0].cells.map(cell => cell.align)).toEqual(["left", "center", "right"])
    expect(parsed.table.rows[0].cells.map(cell => cell.scope)).toEqual(["col", "col", "col"])
    expect(parsed.table.rows[1].cells.map(cell => [cell.header, cell.scope])).toEqual([
      [true, "row"],
      [false, null],
      [false, null],
    ])
  })

  it("keeps bounded paragraph, list and break structure inside cells", () => {
    const html = "<table><thead><tr><th>Para</th><th>List</th><th>Break</th></tr></thead><tbody><tr><td><p>note</p></td><td><ul><li>one</li></ul></td><td>first<br>second</td></tr></tbody></table>"
    expect(paste(html)).toEqual(
      semantic([
        table([
          {
            cells: [
              { header: true, scope: null, rowSpan: 1, colSpan: 1, align: null, blocks: [paragraph(text("Para"))] },
              { header: true, scope: null, rowSpan: 1, colSpan: 1, align: null, blocks: [paragraph(text("List"))] },
              { header: true, scope: null, rowSpan: 1, colSpan: 1, align: null, blocks: [paragraph(text("Break"))] },
            ],
          },
          {
            cells: [
              { header: false, scope: null, rowSpan: 1, colSpan: 1, align: null, blocks: [paragraph(text("note"))] },
              {
                header: false,
                scope: null,
                rowSpan: 1,
                colSpan: 1,
                align: null,
                blocks: [list(false, null, [paragraph(text("one"))])],
              },
              {
                header: false,
                scope: null,
                rowSpan: 1,
                colSpan: 1,
                align: null,
                blocks: [paragraph(text("first"), hardBreak(), text("second"))],
              },
            ],
          },
        ]),
      ]),
    )
  })

  it("flags rowspan/colspan tables with requiresComplexHtml without premature downgrade diagnostics", () => {
    for (const html of [
      '<table><thead><tr><th scope="col">Stage</th><th scope="col">Owner</th></tr></thead><tbody><tr><td rowspan="2">Review</td><td>Ada</td></tr><tr><td>Lin</td></tr></tbody></table>',
      '<table><thead><tr><th scope="col" colspan="2">Totals</th></tr></thead><tbody><tr><td>North</td><td>10</td></tr></tbody></table>',
    ]) {
      const result = paste(html)
      const block = result.document.blocks[0]
      if (block.type !== "table") throw new Error("expected a table block")
      expect(block.table.requiresComplexHtml).toBe(true)
      expect(block.table.rows[0].cells[0].colSpan + block.table.rows[0].cells[0].rowSpan).toBeGreaterThan(1)
      expect(result.diagnostics).toEqual([])
    }
  })

  it("flags header rows that GFM cannot express and unsupported cell blocks", () => {
    const lateHeader = "<table><tbody><tr><td>a</td></tr><tr><th>b</th></tr></tbody></table>"
    const quotedCell = "<table><tbody><tr><td><blockquote><p>q</p></blockquote></td></tr></tbody></table>"
    for (const html of [lateHeader, quotedCell]) {
      const block = paste(html).document.blocks[0]
      if (block.type !== "table") throw new Error("expected a table block")
      expect(block.table.requiresComplexHtml).toBe(true)
    }
  })

  it("drops a table that holds no rows", () => {
    expect(paste("<table></table>")).toEqual(semantic(emptyDocument()))
  })
})

describe("normalizeHtmlPaste — dangerous and unknown containers", () => {
  it("drops script/style but keeps surrounding paragraphs", () => {
    expect(paste('<p>before</p><script>alert("x")</script><style>p{color:red}</style><p>after</p>')).toEqual(
      semantic([paragraph(text("before")), paragraph(text("after"))]),
    )
  })

  it("keeps safe descendant text from svg, math, media and unknown elements", () => {
    // happy-dom 的 HTML parser 不实现 SVG foreign content，`<svg>` 的子节点在
    // normalizer 之前就已消失；因此 svg 用例只断言“脚本不落地、无原始标记”，
    // 后代可见文本的保留由 math / video / 未知元素覆盖。
    const svg = paste('<p><svg viewBox="0 0 10 10"><script>alert(1)</script><text>chart label</text></svg></p>')
    const svgPayload = JSON.stringify(svg)
    expect(svgPayload).not.toContain("alert(1)")
    expect(svgPayload).not.toContain("<svg")
    expect(svgPayload).not.toContain("viewBox")

    expect(paste("<p><math><mi>x</mi></math></p>")).toEqual(semantic([paragraph(text("x"))]))
    expect(paste('<video controls src="https://example.com/m.mp4">download failed</video>')).toEqual(
      semantic([paragraph(text("download failed"))]),
    )
    expect(paste('<p><custom-widget data-x="1">widget text</custom-widget></p>')).toEqual(
      semantic([paragraph(text("widget text"))]),
    )
  })

  it("drops form markup and control values but keeps visible control text", () => {
    expect(
      paste('<form action="https://evil.example"><input type="text" value="secret"><button type="submit">Send</button></form>'),
    ).toEqual(semantic([paragraph(text("Send"))]))
    const result = paste('<form><input type="text" value="secret"><textarea>tarea</textarea> <select><option>opt</option></select></form>')
    expect(JSON.stringify(result)).not.toContain("secret")
    expect(result).toEqual(semantic([paragraph(text("tarea opt"))]))
  })

  it("never retains event handlers or raw markup", () => {
    const result = paste('<p onclick="steal()">safe <strong onmouseover="x()">bold</strong></p>')
    expect(result).toEqual(semantic([paragraph(text("safe "), wrap("strong", text("bold")))]))
    const payload = JSON.stringify(result)
    for (const forbidden of ["onclick", "onmouseover", "<p", "<strong", "steal"]) {
      expect(payload).not.toContain(forbidden)
    }
  })

  it("recovers visible text from unknown block containers", () => {
    expect(paste("<section><article><h2>deep</h2><p>body</p></article></section>")).toEqual(
      semantic([heading(2, text("deep")), paragraph(text("body"))]),
    )
  })

  it("returns an empty semantic document for empty or invisible input", () => {
    expect(paste("")).toEqual(semantic(emptyDocument()))
    expect(paste("   \n\t ")).toEqual(semantic(emptyDocument()))
    expect(paste("<style>x{}</style><script>y()</script>")).toEqual(semantic(emptyDocument()))
  })
})

describe("normalizeHtmlPaste — deterministic and bounded", () => {
  const hostile = [
    '<div data-x="1"><custom-widget><svg><math><mi>m</mi></math></svg></custom-widget>',
    '<p style="color:red;font-size:9px">alpha &amp; beta</p>',
    '<table><tr><td colspan="3">wide</td></tr></table>',
    '<a href="java&#9;script:alert(1)">tabbed</a>',
    '<img src="data:image/webp;base64,UklGRg==" alt="w">',
    '<ul><li><input type="checkbox" checked>task</li></ul>',
    '<p>中文 <em>שלום</em> 🚀</p></div>',
  ].join("")

  it("is byte-identical across repeated runs", () => {
    const first = paste(hostile, "plain")
    const second = paste(hostile, "plain")
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it("never throws on malformed nesting", () => {
    expect(() => paste("<p><em>a<p>b</p></em><div><span></div></span></p>")).not.toThrow()
  })

  it("exposes the conservative default guards", () => {
    expect(MAX_PASTE_DOM_DEPTH).toBe(256)
    expect(MAX_PASTE_DOM_NODES).toBe(200_000)
  })

  it("accepts input exactly at the depth limit and falls back one level beyond it", () => {
    const within = normalizeHtmlPasteWithinLimits(
      { html: "<div><div><div>x</div></div></div>", plainText: "x" },
      { maxDepth: 3, maxNodes: 100 },
    )
    expect(within).toEqual(semantic([paragraph(text("x"))], { plainText: "x" }))
    expect(
      normalizeHtmlPasteWithinLimits(
        { html: "<div><div><div><div>x</div></div></div></div>", plainText: "x" },
        { maxDepth: 3, maxNodes: 100 },
      ),
    ).toEqual(preparePlainTextFallback("x"))
  })

  it("accepts input exactly at the node limit and falls back one node beyond it", () => {
    expect(
      normalizeHtmlPasteWithinLimits({ html: "<p>a</p>", plainText: "a" }, { maxDepth: 8, maxNodes: 2 }),
    ).toEqual(semantic([paragraph(text("a"))], { plainText: "a" }))
    expect(
      normalizeHtmlPasteWithinLimits({ html: "<p>a</p>", plainText: "a" }, { maxDepth: 8, maxNodes: 1 }),
    ).toEqual(preparePlainTextFallback("a"))
  })

  it("counts nodes inside skipped subtrees so a hostile payload cannot hide behind script", () => {
    expect(
      normalizeHtmlPasteWithinLimits(
        { html: `<p>a</p><script>${"x".repeat(10)}</script>`, plainText: "a" },
        { maxDepth: 8, maxNodes: 3 },
      ),
    ).toEqual(preparePlainTextFallback("a"))
  })

  it("falls back instead of returning a partial rich AST past the default depth guard", () => {
    const deep = "<div>".repeat(MAX_PASTE_DOM_DEPTH + 1) + "x" + "</div>".repeat(MAX_PASTE_DOM_DEPTH + 1)
    expect(paste(deep, "x")).toEqual(preparePlainTextFallback("x"))
  })
})

describe("preparePlainTextFallback", () => {
  afterEach(() => {
    delete (globalThis as { DOMParser?: unknown }).DOMParser
  })

  it("builds literal paragraphs and hard breaks without a DOM", () => {
    const original = globalThis.DOMParser
    ;(globalThis as { DOMParser?: unknown }).DOMParser = class {
      constructor() {
        throw new Error("preparePlainTextFallback must not parse HTML")
      }
    }
    try {
      expect(preparePlainTextFallback("# title\n$x$\n**bold**\n\nsecond paragraph")).toEqual({
        policy: "literalFallback",
        document: {
          blocks: [
            paragraph(text("# title"), hardBreak(), text("$x$"), hardBreak(), text("**bold**")),
            paragraph(text("second paragraph")),
          ],
        },
        plainText: "# title\n$x$\n**bold**\n\nsecond paragraph",
        assets: [],
        unavailableImageKeys: [],
        isSingleImageOnly: false,
        diagnostics: [{ kind: "strictFallback", count: 1 }],
      })
    } finally {
      ;(globalThis as { DOMParser?: unknown }).DOMParser = original
    }
  })

  it("normalises CRLF transport but keeps the original plain text field", () => {
    const result = preparePlainTextFallback("a\r\nb")
    expect(result.document.blocks).toEqual([paragraph(text("a"), hardBreak(), text("b"))])
    expect(result.plainText).toBe("a\r\nb")
  })

  it("yields an empty document for empty text", () => {
    expect(preparePlainTextFallback("")).toEqual({
      policy: "literalFallback",
      document: { blocks: [] },
      plainText: "",
      assets: [],
      unavailableImageKeys: [],
      isSingleImageOnly: false,
      diagnostics: [{ kind: "strictFallback", count: 1 }],
    })
  })
})
