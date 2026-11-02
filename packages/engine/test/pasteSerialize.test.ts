import { describe, expect, it } from "vitest"
import type {
  PasteBlock,
  PasteDocument,
  PasteInline,
  PasteTable,
  PasteTableCell,
} from "../src/paste/model"
import { serializePasteDocument, type SerializePasteOptions } from "../src/paste/serialize"
import { parseCell } from "../src/parse/cell"

// serializer 契约（plan 02 Task 3）：手写的精确 Markdown 期望 + 确定性 + 边界事实。
// 期望字符串一律用 String.raw，反斜杠就是输出里的反斜杠。

const text = (value: string): PasteInline => ({ type: "text", value })
const code = (value: string): PasteInline => ({ type: "code", value })
const strong = (...children: PasteInline[]): PasteInline => ({ type: "strong", children })
const emphasis = (...children: PasteInline[]): PasteInline => ({ type: "emphasis", children })
const strike = (...children: PasteInline[]): PasteInline => ({ type: "strike", children })
const highlight = (...children: PasteInline[]): PasteInline => ({ type: "highlight", children })
const underline = (...children: PasteInline[]): PasteInline => ({ type: "underline", children })
const kbd = (...children: PasteInline[]): PasteInline => ({ type: "kbd", children })
const subscript = (...children: PasteInline[]): PasteInline => ({ type: "subscript", children })
const superscript = (...children: PasteInline[]): PasteInline => ({ type: "superscript", children })
const link = (href: string, title: string | null, ...children: PasteInline[]): PasteInline =>
  ({ type: "link", href, title, children })
const image = (
  alt: string,
  source: Extract<PasteInline, { type: "image" }>["source"],
  title: string | null = null,
): PasteInline => ({ type: "image", alt, title, source })
const hardBreak: PasteInline = { type: "hardBreak" }
const paragraph = (...children: PasteInline[]): PasteBlock => ({ type: "paragraph", children })
const doc = (...blocks: PasteBlock[]): PasteDocument => ({ blocks })

const MINIMAL: SerializePasteOptions = { mode: "minimal", resolveAsset: () => null }
const STRICT: SerializePasteOptions = { mode: "strict", resolveAsset: () => null }

function render(document: PasteDocument, options: SerializePasteOptions = MINIMAL) {
  return serializePasteDocument(document, options)
}

function markdown(document: PasteDocument, options: SerializePasteOptions = MINIMAL): string {
  return render(document, options).text
}

function cell(blocks: PasteBlock[], extra: Partial<PasteTableCell> = {}): PasteTableCell {
  return { header: false, scope: null, rowSpan: 1, colSpan: 1, align: null, blocks, ...extra }
}

/** 1 列 GFM 表：行首 `| ` 与行尾 ` |` 之间的就是 cell 源码。 */
function table(rows: PasteBlock[][][], extra: Partial<PasteTable> = {}): PasteTable {
  return {
    rows: rows.map(cells => ({ cells: cells.map(blocks => cell(blocks)) })),
    requiresComplexHtml: false,
    ...extra,
  }
}

/** cell 源码的可见文本（Escape/Entity 已解码，容器展平）。 */
function flat(nodes: readonly ReturnType<typeof parseCell>[number][]): string {
  return nodes.map(node => {
    switch (node.type) {
      case "text": case "code": case "math": case "pre": return node.text
      case "image": return node.alt
      case "br": return "<br>"
      case "hr": return "<hr>"
      default: return "children" in node ? flat(node.children) : ""
    }
  }).join("")
}

const tableCellSource = (markdownText: string, line: number): string => {
  const row = markdownText.split("\n")[line]
  return row.slice(2, -2)
}

describe("inline serialization", () => {
  it.each<[string, PasteInline[], string]>([
    ["plain text", [text("hello")], "hello"],
    ["strong", [strong(text("bold"))], "**bold**"],
    ["emphasis", [emphasis(text("soft"))], "*soft*"],
    ["strike", [strike(text("gone"))], "~~gone~~"],
    ["highlight", [highlight(text("mark"))], "==mark=="],
    ["underline", [underline(text("u"))], "<u>u</u>"],
    ["kbd", [kbd(text("Ctrl"))], "<kbd>Ctrl</kbd>"],
    ["subscript", [text("H"), subscript(text("2")), text("O")], "H~2~O"],
    ["superscript", [text("x"), superscript(text("2"))], "x^2^"],
    ["nested emphasis", [strong(emphasis(text("both")))], "***both***"],
    ["code", [code("x = 1")], "`x = 1`"],
    ["code with backticks", [code("a`b")], "``a`b``"],
    ["code edged backtick", [code("`a")], "`` `a ``"],
    ["hard break", [text("a"), hardBreak, text("b")], "a\\\nb"],
    ["literal markdown text", [text("**not bold**")], "\\*\\*not bold\\*\\*"],
  ])("serializes %s", (_name, children, expected) => {
    expect(markdown(doc(paragraph(...children)))).toBe(expected)
  })

  it("keeps the fixed HTML children literal", () => {
    expect(markdown(doc(paragraph(underline(text("a<b>c")))))).toBe(String.raw`<u>a\<b\>c</u>`)
  })

  it("escapes only the line start of a paragraph", () => {
    expect(markdown(doc(paragraph(text("# title"), text(" and #tag"))))).toBe(
      String.raw`\# title and #tag`,
    )
    expect(markdown(doc(paragraph(text("a"), hardBreak, text("- b"))))).toBe("a\\\n\\- b")
  })
})

describe("links and images", () => {
  it("serializes a titled link", () => {
    expect(markdown(doc(paragraph(link("https://x.dev/a", "note", text("docs"))))))
      .toBe(String.raw`[docs](https://x.dev/a "note")`)
  })

  it("falls back to the href when the label is empty", () => {
    // label 里的 `:` 按 linkLabel 规则转义（可见文本不变）。
    expect(markdown(doc(paragraph(link("https://x.dev/a", null)))))
      .toBe(String.raw`[https\://x.dev/a](https://x.dev/a)`)
  })

  it("uses the angle form for destinations that need it", () => {
    expect(markdown(doc(paragraph(link("./a b.md", null, text("f"))))))
      .toBe("[f](<./a b.md>)")
  })

  it("serializes url images", () => {
    expect(markdown(doc(paragraph(image("pic", { kind: "url", value: "https://x.dev/p.png" }, "t")))))
      .toBe(String.raw`![pic](https://x.dev/p.png "t")`)
  })

  it("resolves embedded assets through resolveAsset only", () => {
    const keys: string[] = []
    const options: SerializePasteOptions = {
      mode: "minimal",
      resolveAsset: key => { keys.push(key); return key === "k1" ? "asset://one.png" : null },
    }
    const embed = (key: string): Extract<PasteInline, { type: "image" }>["source"] =>
      ({ kind: "embedded", key, mime: "image/png", base64: "AAAA" })
    const document = doc(paragraph(image("one", embed("k1")), image("two", embed("k2"))))
    const result = render(document, options)
    expect(result.text).toBe("![one](asset://one.png)two")
    expect(keys).toEqual(["k1", "k2"])
    expect(result.diagnostics).toEqual([{ kind: "unresolvedAsset", count: 1 }])
  })

  it("lowers unavailable images to their alt text", () => {
    const result = render(doc(paragraph(image("gone", { kind: "unavailable", key: "k" }))))
    expect(result.text).toBe("gone")
    expect(result.diagnostics).toEqual([{ kind: "unresolvedAsset", count: 1 }])
  })

  it("aggregates unresolved assets across the document", () => {
    const result = render(doc(
      paragraph(image("a", { kind: "unavailable", key: "1" })),
      paragraph(image("b", { kind: "embedded", key: "2", mime: "image/png", base64: "" })),
    ))
    expect(result.diagnostics).toEqual([{ kind: "unresolvedAsset", count: 2 }])
  })
})

describe("block serialization", () => {
  it("serializes headings with ATX markers", () => {
    expect(markdown(doc({ type: "heading", level: 1, children: [text("t")] }))).toBe("# t")
    expect(markdown(doc({ type: "heading", level: 4, children: [text("t")] }))).toBe("#### t")
  })

  it("prefixes blockquote lines", () => {
    const document = doc({ type: "blockquote", children: [paragraph(text("a")), paragraph(text("b"))] })
    expect(markdown(document)).toBe("> a\n>\n> b")
  })

  it("serializes ordered starts, task state and nesting", () => {
    const document = doc({
      type: "list",
      ordered: true,
      start: 3,
      items: [
        { checked: null, children: [paragraph(text("third"))] },
        { checked: true, children: [paragraph(text("done"))] },
        { checked: false, children: [paragraph(text("todo"))] },
      ],
    })
    expect(markdown(document)).toBe("3. third\n4. [x] done\n5. [ ] todo")
  })

  it("indents nested list content into the marker column", () => {
    const document = doc({
      type: "list",
      ordered: false,
      start: null,
      items: [
        {
          checked: null,
          children: [
            paragraph(text("outer")),
            {
              type: "list",
              ordered: false,
              start: null,
              items: [{ checked: null, children: [paragraph(text("inner"))] }],
            },
          ],
        },
      ],
    })
    expect(markdown(document)).toBe("- outer\n\n  - inner")
  })

  it("widens the fence past the longest backtick run", () => {
    const document = doc({ type: "codeBlock", language: "md", value: "```\nx\n```" })
    expect(markdown(document)).toBe("````md\n```\nx\n```\n````")
  })

  it("drops an unsafe info string", () => {
    const document = doc({ type: "codeBlock", language: "js\ntitle", value: "x" })
    expect(markdown(document)).toBe("```\nx\n```")
  })

  it("serializes a horizontal rule", () => {
    expect(markdown(doc({ type: "horizontalRule" }))).toBe("---")
  })

  it("separates blocks with a blank line", () => {
    expect(markdown(doc(paragraph(text("a")), paragraph(text("b"))))).toBe("a\n\nb")
  })
})

describe("GFM tables", () => {
  it("serializes alignment and pads ragged rows", () => {
    const document = doc({
      type: "table",
      table: {
        requiresComplexHtml: false,
        rows: [
          { cells: [cell([paragraph(text("l"))], { align: "left" }), cell([paragraph(text("c"))], { align: "center" })] },
          { cells: [cell([paragraph(text("1"))])] },
        ],
      },
    })
    expect(markdown(document)).toBe("| l | c |\n| :-- | :-: |\n| 1 |  |")
  })

  it("escapes literal cell pipes and backslashes", () => {
    const document = doc({ type: "table", table: table([[ [paragraph(text("a \\| b"))] ]]) })
    expect(markdown(document)).toBe(String.raw`| a \\\| b |` + "\n| --- |")
  })

  it("keeps semantic mini-documents unescaped", () => {
    const document = doc({
      type: "table",
      table: table([[ [paragraph(strong(text("bold")), text(" and "), link("https://x.dev", null, text("l")))] ]]),
    })
    expect(markdown(document)).toBe(
      String.raw`| **bold** and [l](https://x.dev) |` + "\n| --- |",
    )
  })

  it("encodes inline-code pipes as the inverse of the cell shield", () => {
    const document = doc({ type: "table", table: table([[ [paragraph(code("a|b"))] ]]) })
    expect(markdown(document)).toBe("| `a\\|b` |\n| --- |")
  })

  it("lowers complex tables to canonical HTML in minimal mode and strict visible text when complex HTML is disabled", () => {
    const document = doc({
      type: "table",
      table: table(
        [[ [paragraph(text("h|1"))], [paragraph(text("h2"))] ], [ [paragraph(text("a|b"))], [paragraph(strong(text("c")))] ]],
        { requiresComplexHtml: true },
      ),
    })
    const canonical = render(document)
    expect(canonical.boundary).toEqual({ start: "block", end: "htmlBlock" })
    expect(canonical.diagnostics).toEqual([])
    expect(canonical.text).toBe([
      "<table>",
      "<tbody>",
      "<tr>",
      "<td>h|1</td>",
      "<td>h2</td>",
      "</tr>",
      "<tr>",
      "<td>a|b</td>",
      "<td><strong>c</strong></td>",
      "</tr>",
      "</tbody>",
      "</table>",
    ].join("\n"))

    const fallback = render(document, { ...MINIMAL, allowComplexTable: false })
    expect(fallback.text).toBe(String.raw`| h\|1 | h2 |` + "\n| --- | --- |\n" + String.raw`| a\|b | c |`)
    expect(fallback.diagnostics).toEqual([{ kind: "unsupportedTable", count: 1 }])
  })

  it("lowers a mid-table header cell GFM cannot express", () => {
    const document = doc({
      type: "table",
      table: {
        requiresComplexHtml: false,
        rows: [
          { cells: [cell([paragraph(text("h"))])] },
          { cells: [cell([paragraph(text("r"))], { header: true })] },
        ],
      },
    })
    const result = render(document)
    expect(result.diagnostics).toEqual([{ kind: "unsupportedTable", count: 1 }])
    expect(result.text.split("\n")[2]).toBe("| r |")
  })

  it("lowers a cell whose block is not a single paragraph", () => {
    const document = doc({
      type: "table",
      table: table([[ [{ type: "list", ordered: false, start: null, items: [{ checked: null, children: [paragraph(text("x"))] }] }] ]]),
    })
    const result = render(document)
    expect(result.diagnostics).toEqual([{ kind: "unsupportedTable", count: 1 }])
    expect(result.text.split("\n")[0]).toBe("| x |")
  })

  it("lowers a cell code value whose pipe cannot be shielded", () => {
    const document = doc({ type: "table", table: table([[ [paragraph(code("a\\|b"))] ]]) })
    const result = render(document)
    expect(result.diagnostics).toEqual([{ kind: "unsupportedTable", count: 1 }])
    expect(result.text.split("\n")[0]).toBe(String.raw`| a\\\|b |`)
  })
})

describe("boundary facts come from the AST", () => {
  it.each<[string, PasteDocument, string, string]>([
    ["empty paste", doc(), "inline", "inline"],
    ["single paragraph", doc(paragraph(text("a"))), "inline", "inline"],
    ["heading first", doc({ type: "heading", level: 1, children: [text("t")] }), "block", "block"],
    ["list", doc({ type: "list", ordered: false, start: null, items: [{ checked: null, children: [paragraph(text("a"))] }] }), "block", "block"],
    ["paragraph then list", doc(paragraph(text("a")), { type: "list", ordered: false, start: null, items: [{ checked: null, children: [paragraph(text("b"))] }] }), "block", "block"],
    ["fenced code last", doc(paragraph(text("a")), { type: "codeBlock", language: "", value: "x" }), "block", "opaque"],
    ["table last", doc(paragraph(text("a")), { type: "table", table: table([[ [paragraph(text("h"))] ]]) }), "block", "opaque"],
    ["horizontal rule last", doc(paragraph(text("a")), { type: "horizontalRule" }), "block", "opaque"],
  ])("reports %s", (_name, document, start, end) => {
    expect(render(document).boundary).toEqual({ start, end })
  })
})

describe("determinism and hygiene", () => {
  const document = doc(
    { type: "heading", level: 2, children: [text("标题 $x$")] },
    paragraph(strong(text("a")), text(" | "), link("https://x.dev/a", "n", text("[l]"))),
    { type: "table", table: table([[ [paragraph(code("a|b"))], [paragraph(text("p\\|q"))] ]]) },
    { type: "codeBlock", language: "ts", value: "const a = `x`" },
  )

  it("produces byte-identical output on repeated calls", () => {
    for (const options of [MINIMAL, STRICT]) {
      const first = render(document, options)
      const second = render(document, options)
      expect(second.text).toBe(first.text)
      expect(second.diagnostics).toEqual(first.diagnostics)
      expect(second.boundary).toEqual(first.boundary)
    }
  })

  it("never emits presentation noise", () => {
    const output = markdown(document, STRICT)
    for (const fragment of ["style=", "class=", "data-", "font-size", "color:"]) {
      expect(output).not.toContain(fragment)
    }
  })

  it("does not mutate the input document", () => {
    const frozen = doc(paragraph(strong(text("a"))))
    const before = JSON.stringify(frozen)
    render(frozen)
    expect(JSON.stringify(frozen)).toBe(before)
  })

  it("escapes strict text without changing block structure", () => {
    const output = markdown(doc(paragraph(text("**bold** and $x$"))), STRICT)
    expect(output).toBe(String.raw`\*\*bold\*\* and \$x\$`)
  })
})

describe("cell model round trips", () => {
  const GFM = { pipeEscapes: "gfm-table" as const }

  it("round-trips a code pipe", () => {
    const document = doc({ type: "table", table: table([[ [paragraph(text("h"))] ], [ [paragraph(code("a|b"))] ]]) })
    const source = tableCellSource(markdown(document), 2)
    expect(source).toBe("`a\\|b`")
    expect(parseCell(source, GFM)).toEqual([{ type: "code", text: "a|b" }])
  })

  it("round-trips two literal backslashes before a code pipe", () => {
    const document = doc({ type: "table", table: table([[ [paragraph(code("a\\\\|b"))] ]]) })
    const source = tableCellSource(markdown(document), 0)
    // 偶数 run 补一个屏蔽反斜杠 → 源码 3 个反斜杠；解码时正好去掉一个。
    expect(source).toBe("`" + String.raw`a\\\|b` + "`")
    expect(parseCell(source, GFM)).toEqual([{ type: "code", text: String.raw`a\\|b` }])
  })

  it("round-trips literal text backslashes and pipes", () => {
    const document = doc({ type: "table", table: table([[ [paragraph(text("a \\| b"))] ]]) })
    const source = tableCellSource(markdown(document), 0)
    expect(source).toBe(String.raw`a \\\| b`)
    const nodes = parseCell(source, GFM)
    expect(flat(nodes)).toBe(String.raw`a \| b`)
    expect(nodes.every(node => node.type === "text")).toBe(true)
  })

  it("round-trips a titled link", () => {
    const document = doc({
      type: "table",
      table: table([[ [paragraph(link("https://x.dev/a", "note", text("docs")))] ]]),
    })
    const source = tableCellSource(markdown(document), 0)
    expect(source).toBe(String.raw`[docs](https://x.dev/a "note")`)
    expect(parseCell(source, GFM)).toEqual([
      { type: "link", href: "https://x.dev/a", title: "note", children: [{ type: "text", text: "docs" }] },
    ])
  })

  it("round-trips a titled image", () => {
    const document = doc({
      type: "table",
      table: table([[ [paragraph(image("pic", { kind: "url", value: "https://x.dev/p.png" }, "t"))] ]]),
    })
    const source = tableCellSource(markdown(document), 0)
    expect(source).toBe(String.raw`![pic](https://x.dev/p.png "t")`)
    expect(parseCell(source, GFM)).toEqual([
      { type: "image", src: "https://x.dev/p.png", alt: "pic", title: "t" },
    ])
  })

  it("round-trips sub and superscript", () => {
    const document = doc({
      type: "table",
      table: table([[ [paragraph(text("H"), subscript(text("2")), text("O"), superscript(text("3")))] ]]),
    })
    const source = tableCellSource(markdown(document), 0)
    expect(source).toBe("H~2~O^3^")
    expect(parseCell(source, GFM)).toEqual([
      { type: "text", text: "H" },
      { type: "sub", children: [{ type: "text", text: "2" }] },
      { type: "text", text: "O" },
      { type: "sup", children: [{ type: "text", text: "3" }] },
    ])
  })

  it("keeps a cell hard break parseable", () => {
    const document = doc({ type: "table", table: table([[ [paragraph(text("a"), hardBreak, text("b"))] ]]) })
    const source = tableCellSource(markdown(document), 0)
    expect(source).toBe("a<br>b")
    expect(parseCell(source, GFM)).toEqual([
      { type: "text", text: "a" },
      { type: "br" },
      { type: "text", text: "b" },
    ])
  })
})
