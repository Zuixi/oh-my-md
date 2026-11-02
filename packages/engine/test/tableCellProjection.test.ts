import { syntaxTree } from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import type { SyntaxNode } from "@lezer/common"
import { describe, expect, it } from "vitest"
import { livePreviewField } from "../src/decorations/build"
import { editorExtensions } from "../src/index"
import { referenceIndexScanStats } from "../src/semantic/references"
import { parseCell, type CellNode, type CellParseOptions } from "../src/parse/cell"
import { renderTableCellContent } from "../src/decorations/widgets/tableCell"
import { replaceTableCell } from "../src/tables/edit"
import { tableDataFromNode, type TableData } from "../src/tables/model"
import { editorReferenceContext } from "../src/semantic/references"
// 经 helpers 先进模块图（见 tableUpdateDOM.test.ts 的 ESM 环说明），再取 TableWidget。
import { makeState } from "./helpers"
import { TableWidget } from "../src/decorations/widgets/table"

// parseCell 是唯一的 cell parser：Preview、表格 widget、两个导出器都消费它的 AST。
// 这里钉住它新增的两条契约：GFM 表格管道屏蔽反斜杠（`pipeEscapes: "gfm-table"`）
// 与 sub/sup 容器。管道切分（行/单元格边界）属于表格层，不属于本模块。

const GFM: CellParseOptions = { pipeEscapes: "gfm-table" }

/** 让 CellNode 的每个 kind 都必须被这条访问器覆盖（编译期穷尽检查）。 */
function assertNever(node: never): never {
  throw new Error(`unhandled CellNode: ${JSON.stringify(node)}`)
}

/** CellNode 的可见文本；结构容器展平，`br` 写作其元素，图片取 alt。 */
function flat(nodes: readonly CellNode[]): string {
  return nodes.map(flatNode).join("")
}

function flatNode(node: CellNode): string {
  switch (node.type) {
    case "text": case "code": case "math": case "pre": return node.text
    case "image": return node.alt
    case "br": return "<br>"
    case "hr": return "<hr>"
    case "em": case "strong": case "del": case "mark": case "underline":
    case "link": case "ul": case "ol": case "li": case "blockquote":
    case "sub": case "sup": case "kbd":
      return flat(node.children)
    default: return assertNever(node)
  }
}

/** 代码块（行内代码）可见值；用于只关心不透明值解码的用例。 */
function codeText(source: string, options?: CellParseOptions): string {
  const nodes = parseCell(source, options)
  expect(nodes).toHaveLength(1)
  expect(nodes[0].type).toBe("code")
  return (nodes[0] as { text: string }).text
}

const bs = (count: number): string => "\\".repeat(count)

function tableNodes(doc: string): SyntaxNode[] {
  const state = makeState(doc)
  const nodes: SyntaxNode[] = []
  const cursor = syntaxTree(state).cursor()
  do {
    if (cursor.name === "Table") nodes.push(cursor.node)
  } while (cursor.next())
  return nodes
}

/** 唯一一张表的数据 + 它的源码切片（表格层偏移都相对于这个切片）。 */
function tableModel(doc: string): { data: TableData; tableSource: string } {
  const nodes = tableNodes(doc)
  expect(nodes).toHaveLength(1)
  const state = makeState(doc)
  const node = nodes[0]
  const data = tableDataFromNode(node, state)
  if (!data) throw new Error("expected table data")
  return { data, tableSource: doc.slice(node.from, node.to) }
}

describe("backslash runs before a pipe outside inline code", () => {
  // Standalone Markdown semantics: Lezer 的 Escape 节点已经把每一对反斜杠解码完，
  // 两个模式在代码外必须完全一致（gfm-table 不得再做第二次替换）。
  const standalone: [number, string][] = [
    [1, "a | b"],
    [2, "a \\| b"],
    [3, "a \\| b"],
    [4, "a \\\\| b"],
  ]

  it.each(standalone)("decode %i backslash(es) with default markdown semantics", (count, expected) => {
    expect(flat(parseCell(`a ${bs(count)}| b`))).toBe(expected)
    expect(parseCell(`a ${bs(count)}| b`)).toEqual(parseCell(`a ${bs(count)}| b`, { pipeEscapes: "markdown" }))
  })

  it.each(standalone)("decode %i backslash(es) identically in gfm-table mode", (count, expected) => {
    expect(flat(parseCell(`a ${bs(count)}| b`, GFM))).toBe(expected)
  })

  it("never leaks the escape marker for one backslash", () => {
    for (const options of [undefined, GFM]) {
      expect(flat(parseCell("a \\| b", options))).not.toContain("\\")
    }
  })

  it("keeps a raw unescaped pipe untouched (no delimiter logic here)", () => {
    expect(parseCell("a | b")).toEqual([{ type: "text", text: "a | b" }])
    expect(parseCell("a | b", GFM)).toEqual([{ type: "text", text: "a | b" }])
  })
})

describe("backslash runs before a pipe inside opaque inline code", () => {
  // 行内代码没有 Escape 子节点：GFM 行切分吃掉的「一个屏蔽反斜杠」只能在这里补。
  const shieldRemoved: [number, number][] = [
    [1, 0],
    [2, 2],
    [3, 2],
    [4, 4],
  ]

  it.each(shieldRemoved)("keeps all %i backslash(es) under default markdown semantics", (count) => {
    for (const options of [undefined, { pipeEscapes: "markdown" } as CellParseOptions]) {
      expect(codeText(`\`a ${bs(count)}| b\``, options)).toBe(`a ${bs(count)}| b`)
    }
  })

  it.each(shieldRemoved)("removes exactly one shielding backslash from %i backslash(es) in gfm-table mode", (count, kept) => {
    expect(codeText(`\`a ${bs(count)}| b\``, GFM)).toBe(`a ${bs(kept)}| b`)
  })

  it("renders the pinned raw cell source as the decoded code value", () => {
    expect(codeText("`a \\| b`", GFM)).toBe("a | b")
    // 默认模式下同一份源码保持 Markdown 的字面值。
    expect(codeText("`a \\| b`")).toBe("a \\| b")
  })

  it("preserves every other literal backslash inside the code value", () => {
    expect(codeText("`a\\*b \\| c`", GFM)).toBe("a\\*b | c")
    expect(codeText("`C:\\path\\|dir`", GFM)).toBe("C:\\path|dir")
    expect(codeText("`\\n \\t`", GFM)).toBe("\\n \\t")
    expect(codeText("`x \\| y \\| z`", GFM)).toBe("x | y | z")
  })

  it("does not decode pipes outside inline code twice", () => {
    const nodes = parseCell("`a \\| b` and c \\| d", GFM)
    expect(flat(nodes)).toBe("a | b and c | d")
  })

  it("leaves the raw cell source untouched and stays pure", () => {
    const source = "`a \\| b` \\| c"
    const before = source
    const first = parseCell(source, GFM)
    const second = parseCell(source, GFM)
    expect(source).toBe(before)
    expect(second).toEqual(first)
    // 解码后的代码值与源码切片是不同字符串：没有就地改写，也没有二次替换。
    expect((first[0] as { text: string }).text).not.toBe("a \\| b")
    expect((first[0] as { text: string }).text).toBe("a | b")
  })
})

describe("table model keeps raw Markdown in `text`", () => {
  // 表格层只切分边界；解码 `\\|` 是 cell parser 的事。模型里的 `text` 必须仍是
  // 原始 Markdown，否则 parseCell 会再解一次（gfm-table 屏蔽反斜杠被吃掉两层）。
  it.each([1, 3])("keeps %i backslash(es) before a pipe byte-identical", count => {
    const raw = `a${bs(count)}|b`
    const { data } = tableModel(`| ${raw} | c |\n| --- | --- |\n| 1 | 2 |`)
    const cell = data.header.cells[0]!
    expect(cell.source).toBe(raw)
    expect(cell.text).toBe(raw)
    expect(cell.text.length).toBe(cell.source.length)
  })

  it.each([2, 4])("never hides an unshielded pipe behind %i backslashes", count => {
    // 偶数个反斜杠没有屏蔽管道，Lezer 看到的是真分隔符：不构成表格，模型也就不伪造单元格。
    expect(tableNodes(`| a${bs(count)}|b | c |\n| --- | --- |\n| 1 | 2 |`)).toHaveLength(0)
  })

  it("keeps inline-code pipes raw and leaves decoding to parseCell", () => {
    const { data } = tableModel("| `a \\| b` | c |\n| --- | --- |\n| 1 | 2 |")
    const cell = data.header.cells[0]!
    expect(cell.source).toBe("`a \\| b`")
    expect(cell.text).toBe("`a \\| b`")
    // 渲染路径（widget / 导出）拿到原始字节后，只经过这一层解码。
    expect(flat(parseCell(cell.text, GFM))).toBe("a | b")
  })

  it("projects `text` as `source.trim()` for padded, empty, and escaped cells", () => {
    const docs = [
      "|    spaced   | c |\n| --- | --- |\n|   | 2 |",
      "| a \\| b | `c \\| d` |\n| --- | --- |\n| \\\\| e | 2 |",
    ]
    for (const doc of docs) {
      const { data } = tableModel(doc)
      for (const row of [data.header, ...data.rows]) {
        for (const cell of row.cells) {
          if (!cell) continue
          expect(cell.text).toBe(cell.source.trim())
        }
      }
    }
    const { data } = tableModel(docs[0])
    expect(data.header.cells[0]).toMatchObject({ source: "spaced", text: "spaced" })
    expect(data.rows[0].cells[0]).toMatchObject({ source: "", text: "" })
  })

  it("keeps empty-cell insertion offsets on the canonical `| <content> |` slot", () => {
    const { data, tableSource } = tableModel("| A | B |\n| --- | --- |\n|  | 2 |")
    const empty = data.rows[0].cells[0]!
    expect(empty).toEqual({ source: "", text: "", from: 26, to: 26 })
    const change = replaceTableCell(tableSource, empty, "9")!
    const patched = tableSource.slice(0, change.from) + change.insert + tableSource.slice(change.to)
    expect(patched).toBe("| A | B |\n| --- | --- |\n| 9 | 2 |")
  })

  it("keeps table range-edit offsets addressing the live document and leaves it untouched", () => {
    const doc = "| a \\| b | `c \\| d` |\n| --- | --- |\n| \\\\| e | 2 |"
    const { data, tableSource } = tableModel(doc)
    const before = makeState(doc).doc.toString()
    expect(before).toBe(doc)
    for (const row of [data.header, ...data.rows]) {
      for (const cell of row.cells) {
        if (!cell) continue
        expect(tableSource.slice(cell.from, cell.to)).toBe(cell.source)
        // 原始字节回写是逐字节相同的：`replaceTableCell` 只补真分隔符需要的反斜杠。
        expect(replaceTableCell(tableSource, cell, cell.text)?.insert).toBe(cell.source)
      }
    }
    expect(data.header.cells.map(cell => cell?.source)).toEqual(["a \\| b", "`c \\| d`"])
  })
})

describe("subscript and superscript containers", () => {
  it("projects `~x~` as a sub container without its marker", () => {
    expect(parseCell("H~2~O")).toEqual([
      { type: "text", text: "H" },
      { type: "sub", children: [{ type: "text", text: "2" }] },
      { type: "text", text: "O" },
    ])
    expect(flat(parseCell("H~2~O"))).toBe("H2O")
    expect(flat(parseCell("H~2~O"))).not.toContain("~")
  })

  it("projects `^x^` as a sup container without its marker", () => {
    expect(parseCell("2^10^")).toEqual([
      { type: "text", text: "2" },
      { type: "sup", children: [{ type: "text", text: "10" }] },
    ])
    expect(flat(parseCell("2^10^"))).toBe("210")
  })

  it("keeps inline formatting inside sub and sup", () => {
    const sub = parseCell("~a *b*~")[0]
    expect(sub.type).toBe("sub")
    expect(sub.type === "sub" && sub.children.some(node => node.type === "em")).toBe(true)
    const sup = parseCell("^a `c`^")[0]
    expect(sup.type).toBe("sup")
    expect(sup.type === "sup" && sup.children.some(node => node.type === "code")).toBe(true)
  })

  it("keeps strikethrough and escaped markers out of the rise containers", () => {
    expect(parseCell("~~del~~")[0].type).toBe("del")
    expect(flat(parseCell("\\~x~"))).toBe("~x~")
    expect(flat(parseCell("\\^x^"))).toBe("^x^")
  })
})

describe("existing cell semantics stay on the sole parser", () => {
  it("keeps link and image titles from Task 1", () => {
    expect(parseCell('[text](https://x.example "T")')).toEqual([{
      type: "link",
      href: "https://x.example",
      title: "T",
      children: [{ type: "text", text: "text" }],
    }])
    expect(parseCell('![alt](a.png "C")')).toEqual([
      { type: "image", src: "a.png", alt: "alt", title: "C" },
    ])
  })

  it("resolves references through the supplied resolver and keeps unresolved ones literal", () => {
    const resolveReference = (label: string) =>
      label.replace(/^\[|\]$/g, "").toLowerCase() === "id"
        ? { href: "https://r.example", title: "RT" }
        : null
    expect(parseCell("[ref][id]", { resolveReference, ...GFM })).toEqual([{
      type: "link",
      href: "https://r.example",
      title: "RT",
      children: [{ type: "text", text: "ref" }],
    }])
    expect(parseCell("[ref][missing]", GFM)).toEqual([{ type: "text", text: "[ref][missing]" }])
  })

  it("keeps Escape values and HardBreak elements in both modes", () => {
    expect(flat(parseCell("a\\_b", GFM))).toBe("a_b")
    expect(flat(parseCell("a\\_b"))).toBe("a_b")
    for (const source of ["a\\\nb", "a  \nb"]) {
      expect(parseCell(source, GFM)).toEqual([
        { type: "text", text: "a" },
        { type: "br" },
        { type: "text", text: "b" },
      ])
    }
  })

  it("keeps a single flat AST per cell for mixed content", () => {
    const nodes = parseCell("~s~ **b** `c \\| d` [l](u \"t\") ![i](p.png)", GFM)
    expect(nodes.map(node => node.type)).toEqual([
      "sub", "text", "strong", "text", "code", "text", "link", "text", "image",
    ])
    expect(flat(nodes)).toBe("s b c | d l i")
  })
})

// DOM 投影：widgets/tableCell.ts 是 Preview 与表格 widget 共用的唯一渲染器，
// 这里钉住它扩展后的契约（title、引用解析、上下标、硬换行、GFM 管道、未解析字面量）。
describe("cell DOM projection", () => {
  const render = (
    source: string,
    resolveSrc?: (src: string) => string,
    options?: CellParseOptions,
  ): HTMLElement => {
    const div = document.createElement("div")
    renderTableCellContent(div, source, resolveSrc, options)
    return div
  }

  it("renders link and image titles only when the source has one", () => {
    const titled = render('[t](https://x.example "T") ![a](p.png "C")')
    expect(titled.querySelector("a")?.title).toBe("T")
    expect(titled.querySelector("img")?.title).toBe("C")

    const plain = render("[t](https://x.example) ![a](p.png)")
    expect(plain.querySelector("a")?.hasAttribute("title")).toBe(false)
    expect(plain.querySelector("img")?.hasAttribute("title")).toBe(false)
  })

  it("resolves reference links and images through the supplied resolver", () => {
    const resolveReference = (label: string) =>
      label.replace(/^\[|\]$/g, "").toLowerCase() === "id"
        ? { href: "https://r.example", title: "RT" }
        : null
    const div = render("[ref][id]", undefined, { resolveReference, ...GFM })
    const link = div.querySelector("a")
    expect(link?.textContent).toBe("ref")
    expect(link?.href).toBe("https://r.example/")
    expect(link?.title).toBe("RT")
    expect(div.textContent).not.toContain("[id]")

    const image = render("![alt][id]", undefined, { resolveReference, ...GFM })
    expect(image.querySelector("img")?.getAttribute("src")).toBe("https://r.example")
    expect(image.querySelector("img")?.title).toBe("RT")
  })

  it("renders subscript and superscript containers without their markers", () => {
    const div = render("H~2~O 2^10^ ~a *b*~")
    expect(div.querySelector("sub")?.textContent).toBe("2")
    expect(div.querySelector("sup")?.textContent).toBe("10")
    expect(div.textContent).toBe("H2O 210 a b")
    expect(div.textContent).not.toContain("~")
    expect(div.textContent).not.toContain("^")
    expect(div.querySelector("sub em")?.textContent).toBe("b")
  })

  it("renders a hard break as a <br> element", () => {
    for (const source of ["a  \nb", "a\\\nb"]) {
      const div = render(source)
      expect(div.querySelector("br")).toBeTruthy()
      expect(div.textContent).toBe("ab")
    }
  })

  it("removes the outer-table pipe shield from inline code in gfm-table mode only", () => {
    expect(render("`a \\| b`", undefined, GFM).querySelector("code")?.textContent).toBe("a | b")
    expect(render("`a \\| b`").querySelector("code")?.textContent).toBe("a \\| b")
  })

  it("keeps unresolved references as literal text instead of dropping them", () => {
    expect(render("[ref][missing]", undefined, GFM).textContent).toBe("[ref][missing]")
    expect(render("[ref][missing]", undefined, GFM).querySelector("a")).toBeNull()
    expect(render("![ref][missing]", undefined, GFM).textContent).toBe("![ref][missing]")
    expect(render("![ref][missing]", undefined, GFM).querySelector("img")).toBeNull()
  })

  it("routes image sources through the resolver and keeps the broken fallback", () => {
    const div = render("![a](p.png)", src => `app://${src}`)
    const img = div.querySelector("img")!
    expect(img.getAttribute("src")).toBe("app://p.png")
    expect(img.className).toBe("omd-image")
    expect(img.alt).toBe("a")
    img.dispatchEvent(new Event("error"))
    const broken = div.querySelector(".omd-image-broken")
    expect(broken?.textContent).toBe("p.png")
    expect(div.querySelector("img")).toBeNull()
  })
})

describe("keyboard key containers", () => {
  it("projects `<kbd>Ctrl</kbd>` as a kbd container without its tag markers", () => {
    expect(parseCell("<kbd>Ctrl</kbd>")).toEqual([
      { type: "kbd", children: [{ type: "text", text: "Ctrl" }] },
    ])
    expect(flat(parseCell("<kbd>Ctrl</kbd>"))).toBe("Ctrl")
    expect(flat(parseCell("<kbd>Ctrl</kbd>"))).not.toContain("<kbd>")
  })

  it("keeps nested inline formatting inside the container", () => {
    expect(parseCell("<kbd>*b* `c`</kbd>")).toEqual([{
      type: "kbd",
      children: [
        { type: "em", children: [{ type: "text", text: "b" }] },
        { type: "text", text: " " },
        { type: "code", text: "c" },
      ],
    }])
    // 相邻容器（sub/sup/kbd）互不互相吞掉。
    expect(parseCell("~a~ ^b^ <kbd>K</kbd>").map(node => node.type))
      .toEqual(["sub", "text", "sup", "text", "kbd"])
  })

  it("keeps invalid forms as visible literal text", () => {
    for (const source of ["<kbd class=\"x\">Ctrl</kbd>", "<kbd>Ctrl"]) {
      const nodes = parseCell(source)
      expect(nodes.some(node => node.type === "kbd")).toBe(false)
      expect(nodes.map(node => (node.type === "text" ? node.text : "")).join("")).toBe(source)
    }
  })

  it("skips a same-name closing tag inside inline code", () => {
    expect(parseCell("<kbd>`</kbd>`x</kbd>")).toEqual([{
      type: "kbd",
      children: [{ type: "code", text: "</kbd>" }, { type: "text", text: "x" }],
    }])
  })
})

// 挂载态：TableWidget 的每个 cell 都必须按 GFM 表格语义解析，并且拿得到表格外的
// 引用定义（resolver 来自 EditorState 的 reference context，不是 cell 自枚举）。
describe("mounted table widget cell projection", () => {
  /** 只实现 toDOM/renderInto 用到的 view 表面。 */
  const view = () => ({ requestMeasure: () => {}, state: { readOnly: false } }) as never

  function mount(doc: string, index = 0) {
    const state = makeState(doc)
    const nodes = tableNodes(doc)
    const node = nodes[index]
    if (!node) throw new Error(`expected table #${index}`)
    const data = tableDataFromNode(node, state)
    if (!data) throw new Error("expected table data")
    const resolveReference = editorReferenceContext(state).resolveReference
    const widget = new TableWidget(doc.slice(node.from, node.to), node.from, data, undefined, undefined, false, resolveReference)
    return { widget, dom: widget.toDOM(view()), resolveReference }
  }

  it("decodes the outer-table pipe shield inside a cell code span", async () => {
    const { dom } = mount("| a | b |\n|---|---|\n| `x \\| y` | 2 |")
    await Promise.resolve()
    expect(dom.querySelector("td code")?.textContent).toBe("x | y")
  })

  it("resolves reference links and images defined after the table", async () => {
    const { dom } = mount([
      "| link | image |",
      "| --- | --- |",
      "| [ref][id] | ![alt][id] |",
      "",
      '[id]: https://r.example "RT"',
    ].join("\n"))
    await Promise.resolve()
    const link = dom.querySelector<HTMLAnchorElement>("td a")
    expect(link?.textContent).toBe("ref")
    expect(link?.getAttribute("href")).toBe("https://r.example")
    expect(link?.title).toBe("RT")
    const img = dom.querySelector<HTMLImageElement>("td img")
    expect(img?.getAttribute("src")).toBe("https://r.example")
    expect(img?.title).toBe("RT")
    expect(dom.textContent).not.toContain("[id]")
  })

  it("renders sub and sup containers in mounted cells", async () => {
    const { dom } = mount("| s | t |\n|---|---|\n| H~2~O | 2^10^ |")
    await Promise.resolve()
    expect(dom.querySelector("td sub")?.textContent).toBe("2")
    expect(dom.querySelector("td sup")?.textContent).toBe("10")
    expect(dom.querySelector("td")?.textContent).toBe("H2O")
  })

  it("resolves references in two identical table instances", async () => {
    const table = "| link |\n|---|\n| [ref][id] |"
    const doc = `${table}\n\n${table}\n\n[id]: https://r.example`
    const first = mount(doc, 0)
    const second = mount(doc, 1)
    await Promise.resolve()
    for (const { dom } of [first, second]) {
      expect(dom.querySelector("td a")?.getAttribute("href")).toBe("https://r.example")
    }
  })

  it("rerenders unchanged cells when the reference resolver identity changes", async () => {
    const doc = "| link |\n|---|\n| [ref][id] |"
    const { widget, dom, resolveReference } = mount(doc)
    await Promise.resolve()
    // 无定义时保持字面文本；换成能解出定义的 resolver 后，源码没变也要重渲。
    expect(dom.querySelector("td a")).toBeNull()
    const nextResolve = (label: string) =>
      label.replace(/^\[|\]$/g, "").toLowerCase() === "id"
        ? { href: "https://r.example", title: null }
        : null
    const next = new TableWidget(widget.src, widget.pos, widget.table, undefined, undefined, false, nextResolve)
    expect(next.eq(widget)).toBe(false)
    expect(next.updateDOM(dom, view(), widget)).toBe(true)
    expect(dom.querySelector("td a")?.getAttribute("href")).toBe("https://r.example")
    expect(resolveReference).not.toBe(nextResolve)
  })
})

// 挂载态语义失效：表格 cell 的引用定义在表格外，定义增删改只换 resolver 身份，
// 表格源码一字不动。所以 `widget:block:table` 必须和 `widget:image` 一样进入
// semanticProjections —— 否则已挂载的表格永远停在旧定义上。
const TABLE = "| link | image |\n| --- | --- |\n| [ref][id] | ![alt][id] |"

function mountLive(doc: string) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [editorExtensions({})],
    }),
    parent,
  })
  return { view, parent }
}

function tableSpecs(view: EditorView) {
  return view.state.field(livePreviewField).specs
    .filter(spec => spec.tag === "widget:block:table")
}

function tableWidgets(view: EditorView) {
  return tableSpecs(view).map(spec => spec.deco.spec.widget as TableWidget)
}

function tableDoms(view: EditorView) {
  return Array.from(view.dom.querySelectorAll<HTMLElement>(".omd-table"))
}

function replaceIn(view: EditorView, needle: string, insert: string) {
  const from = view.state.doc.toString().indexOf(needle)
  expect(from).toBeGreaterThanOrEqual(0)
  view.dispatch({ changes: { from, to: from + needle.length, insert } })
}

describe("mounted table widget reference invalidation", () => {
  it("refreshes a mounted table when a definition after it changes", async () => {
    const doc = `${TABLE}\n\n[id]: https://a.example "one"\n# heading`
    const { view, parent } = mountLive(doc)
    await Promise.resolve()
    const [before] = tableWidgets(view)
    const beforeDom = tableDoms(view)[0]
    expect(before.src).toBe(TABLE)
    expect(beforeDom.querySelector("a")?.getAttribute("href")).toBe("https://a.example")
    expect(beforeDom.querySelector("a")?.title).toBe("one")
    expect(beforeDom.querySelector("img")?.getAttribute("src")).toBe("https://a.example")
    expect(beforeDom.querySelector("img")?.title).toBe("one")

    replaceIn(view, "https://a.example", "https://b.example")

    const [after] = tableWidgets(view)
    const spec = tableSpecs(view)[0]
    // 表格源码字节没变：只有语义依赖（resolver 身份）变了。
    expect(view.state.doc.sliceString(spec.from, spec.to)).toBe(TABLE)
    expect(after.src).toBe(TABLE)
    expect(after).not.toBe(before)
    expect(tableDoms(view)[0]).toBe(beforeDom)
    expect(beforeDom.querySelector("a")?.getAttribute("href")).toBe("https://b.example")
    expect(beforeDom.querySelector("img")?.getAttribute("src")).toBe("https://b.example")

    replaceIn(view, '"one"', '"two"')

    expect(tableDoms(view)[0].querySelector("a")?.title).toBe("two")
    expect(tableDoms(view)[0].querySelector("img")?.title).toBe("two")
    view.destroy()
    parent.remove()
  })

  it("falls back to literal unresolved source when the definition is removed", async () => {
    const def = '[id]: https://a.example "one"'
    const doc = `${TABLE}\n\n${def}\n# heading`
    const { view, parent } = mountLive(doc)
    await Promise.resolve()
    expect(tableDoms(view)[0].querySelector("a")).not.toBeNull()

    const from = view.state.doc.toString().indexOf(def)
    view.dispatch({ changes: { from, to: from + def.length + 1 } })

    const dom = tableDoms(view)[0]
    expect(dom.querySelector("a")).toBeNull()
    expect(dom.querySelector("img")).toBeNull()
    expect(dom.querySelector("td")?.textContent).toBe("[ref][id]")
    expect(dom.textContent).toContain("![alt][id]")
    view.destroy()
    parent.remove()
  })

  it("refreshes two identical tables at their own distinct ranges", async () => {
    const doc = `${TABLE}\n\n${TABLE}\n\n[id]: https://a.example "one"\n# heading`
    const { view, parent } = mountLive(doc)
    await Promise.resolve()
    const specs = tableSpecs(view)
    expect(specs).toHaveLength(2)
    expect(specs[0].from).not.toBe(specs[1].from)
    for (const spec of specs) expect(view.state.doc.sliceString(spec.from, spec.to)).toBe(TABLE)
    expect(tableWidgets(view).map(widget => widget.pos)).toEqual(specs.map(spec => spec.from))
    const doms = tableDoms(view)
    expect(doms).toHaveLength(2)
    for (const dom of doms) expect(dom.querySelector("a")?.getAttribute("href")).toBe("https://a.example")

    replaceIn(view, "https://a.example", "https://b.example")

    const afterSpecs = tableSpecs(view)
    expect(afterSpecs.map(spec => spec.from)).toEqual(specs.map(spec => spec.from))
    expect(tableDoms(view)).toHaveLength(2)
    for (const dom of tableDoms(view)) {
      expect(dom.querySelector("a")?.getAttribute("href")).toBe("https://b.example")
    }
    view.destroy()
    parent.remove()
  })

  it("keeps the mounted table projection on an unrelated edit", async () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `paragraph ${i}`).join("\n\n")
    const doc = `${TABLE}\n\n${paragraphs}\n\n[id]: https://a.example "one"\n# heading`
    const { view, parent } = mountLive(doc)
    await Promise.resolve()
    const before = tableWidgets(view)[0]
    expect(before).toBeInstanceOf(TableWidget)

    referenceIndexScanStats.reset()
    const pos = view.state.doc.toString().indexOf("paragraph 7") + 3
    view.dispatch({ changes: { from: pos, insert: "X" } })

    // widget 对象复用 = 定义集未变，表格投影没有被无谓重组。
    expect(tableWidgets(view)[0]).toBe(before)
    // 只有被编辑的块被重新扫描（整篇 15 个顶层块），不是全文档扫描。
    expect(referenceIndexScanStats.scannedBlocks).toBeLessThanOrEqual(2)
    view.destroy()
    parent.remove()
  })
})
