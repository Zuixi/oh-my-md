import { describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import type { SyntaxNode } from "@lezer/common"
import { editorExtensions } from "../src/index"
import { buildLiveDecorations, livePreviewField } from "../src/decorations/build"
import { markdownLanguageSupport } from "../src/parse/markdown"
import { parseCell, type CellNode } from "../src/parse/cell"
import { exportHtml, exportRichHtml } from "../src/export/html"
import { escapeParts, hardBreakParts } from "../src/semantic/breaks"
import type { MarkdownSlice } from "../src/semantic/references"
import { makeState } from "./helpers"

// Real configured parser (same inline parsers as the editor): accessors are
// always handed genuine Lezer nodes, never fixtures or mocks.
const parser = markdownLanguageSupport().language.parser

/** The exact source the plan pins for Task 2. */
const EXACT = "access\\_token before\\\nafter before  \nafter"

function nodes(source: string, name: string): SyntaxNode[] {
  const found: SyntaxNode[] = []
  parser.parse(source).iterate({
    enter(ref) {
      if (ref.name === name) found.push(ref.node)
    },
  })
  return found
}

function requireNode(source: string, name: string, index = 0): SyntaxNode {
  const node = nodes(source, name)[index]
  if (!node) throw new Error(`no ${name} #${index} in ${JSON.stringify(source)}`)
  return node
}

/** A node shape the parser cannot produce (CRLF, malformed) for defense tests. */
function stubNode(name: string, from: number, to: number): SyntaxNode {
  return { name, from, to } as unknown as SyntaxNode
}

/** Source reader that fails if the accessor reads outside the node it got. */
function nodeSlice(source: string, node: SyntaxNode): MarkdownSlice {
  return {
    sliceString(from, to) {
      if (from < node.from || to > node.to)
        throw new Error(`read [${from},${to}) outside node [${node.from},${node.to})`)
      return source.slice(from, to)
    },
  }
}

/** The flattened visible text of a cell AST; `br` is spelled as its element. */
function flat(nodes: CellNode[]): string {
  return nodes
    .map(node => {
      if (node.type === "br") return "<br>"
      if ("text" in node) return node.text
      if ("children" in node) return flat(node.children)
      return "alt" in node ? node.alt : ""
    })
    .join("")
}

// Cross-projection: the same two parses must reach the cell AST and both HTML
// exporters, so Preview, cell widgets and export never disagree.
describe("breaks across cell AST and exporters", () => {
  it("projects an escape as its value only, never the backslash marker", () => {
    const nodes = parseCell(String.raw`a \| b`)
    expect(flat(nodes)).toBe("a | b")
    // The escaped character survives as text; the marker disappears.
    expect(nodes.some(node => node.type === "text" && node.text === "|")).toBe(true)
    expect(flat(nodes)).not.toContain("\\")
  })

  it("keeps one backslash plus the pipe for a double backslash before a pipe", () => {
    // `\\` escapes the backslash, so Markdown decoding leaves `\` then the raw `|`.
    expect(flat(parseCell(String.raw`a \\| b`))).toBe(String.raw`a \| b`)
  })

  it("projects both hard-break kinds onto the same br node as <br>", () => {
    for (const source of ["a\\\nb", "a  \nb"]) {
      expect(parseCell(source)).toEqual([
        { type: "text", text: "a" },
        { type: "br" },
        { type: "text", text: "b" },
      ])
    }
    // The `br` node is exactly what `<br>` already produced before this task.
    expect(parseCell("a<br>b")).toEqual(parseCell("a  \nb"))
  })

  it("exports the pinned source with escape values and br elements", () => {
    const html = exportHtml(makeState(EXACT))
    expect(html).toContain("access_token before<br>after before<br>after")
    // Neither the escape marker nor the hard-break markers leak into the export.
    expect(html).not.toContain("\\_")
    expect(html).not.toContain("before\\")
  })

  it("exports the pinned source identically through the rich exporter", async () => {
    const html = await exportRichHtml(makeState(EXACT))
    expect(html).toContain("access_token before<br>after before<br>after")
    expect(html).not.toContain("\\_")
  })

  it("reaches a table cell in the cell AST and in both exporters", async () => {
    // Preview and export both consume this same AST, so pinning it pins both.
    expect(flat(parseCell(String.raw`a \| b`))).toBe("a | b")
    const doc = "| a \\| b | c |\n|---|---|\n| d | e |\n"
    expect(exportHtml(makeState(doc))).toContain("<th>a | b</th>")
    expect(await exportRichHtml(makeState(doc))).toContain("<th>a | b</th>")
  })
})

describe("escapeParts", () => {
  it("splits the escape in the pinned source into marker and value", () => {
    const node = requireNode(EXACT, "Escape")
    expect([node.from, node.to]).toEqual([6, 8])
    expect(escapeParts(node)).toEqual({ markerFrom: 6, markerTo: 7, valueFrom: 7, valueTo: 8 })
    // The marker is the backslash byte; the value is the escaped character.
    expect(EXACT.slice(6, 7)).toBe("\\")
    expect(EXACT.slice(7, 8)).toBe("_")
  })

  it("keeps the escaped character rather than the backslash", () => {
    const source = "x\\*y"
    const node = requireNode(source, "Escape")
    const parts = escapeParts(node)
    expect(parts).not.toBeNull()
    expect(source.slice(parts!.valueFrom, parts!.valueTo)).toBe("*")
  })

  it("covers an escaped backslash", () => {
    const source = "a\\\\b"
    const node = requireNode(source, "Escape")
    expect(escapeParts(node)).toEqual({ markerFrom: 1, markerTo: 2, valueFrom: 2, valueTo: 3 })
    expect(source.slice(2, 3)).toBe("\\")
  })

  it("returns null for any node that is not an Escape", () => {
    expect(escapeParts(requireNode(EXACT, "Paragraph"))).toBeNull()
    expect(escapeParts(requireNode(EXACT, "HardBreak"))).toBeNull()
    expect(escapeParts(stubNode("Text", 0, 2))).toBeNull()
  })

  it("returns null for a malformed range with no escaped character", () => {
    expect(escapeParts(stubNode("Escape", 3, 3))).toBeNull()
    expect(escapeParts(stubNode("Escape", 3, 4))).toBeNull()
    expect(escapeParts(stubNode("Escape", 4, 3))).toBeNull()
  })
})

describe("hardBreakParts", () => {
  it("finds the backslash hard break in the pinned source", () => {
    const node = requireNode(EXACT, "HardBreak", 0)
    expect([node.from, node.to]).toEqual([20, 22])
    expect(hardBreakParts(node, nodeSlice(EXACT, node))).toEqual({
      markerFrom: 20,
      markerTo: 21,
      newlineFrom: 21,
      newlineTo: 22,
      kind: "backslash",
    })
    // The marker range stops before the newline, which the newline range covers.
    expect(EXACT.slice(20, 21)).toBe("\\")
    expect(EXACT.slice(21, 22)).toBe("\n")
  })

  it("finds the two-space hard break in the pinned source", () => {
    const node = requireNode(EXACT, "HardBreak", 1)
    expect([node.from, node.to]).toEqual([34, 37])
    expect(hardBreakParts(node, nodeSlice(EXACT, node))).toEqual({
      markerFrom: 34,
      markerTo: 36,
      newlineFrom: 36,
      newlineTo: 37,
      kind: "spaces",
    })
    expect(EXACT.slice(34, 36)).toBe("  ")
    expect(EXACT.slice(36, 37)).toBe("\n")
  })

  it("handles an isolated backslash break", () => {
    const source = "a\\\nb"
    const node = requireNode(source, "HardBreak")
    expect(hardBreakParts(node, nodeSlice(source, node))).toEqual({
      markerFrom: 1,
      markerTo: 2,
      newlineFrom: 2,
      newlineTo: 3,
      kind: "backslash",
    })
  })

  it("handles isolated space breaks of two and more spaces", () => {
    for (const source of ["a  \nb", "a   \nb"]) {
      const node = requireNode(source, "HardBreak")
      const parts = hardBreakParts(node, nodeSlice(source, node))
      expect(parts).not.toBeNull()
      expect(source.slice(parts!.markerFrom, parts!.markerTo)).toBe(source.slice(1, node.to - 1))
      expect(parts!.markerTo).toBe(node.to - 1)
      expect(parts!.newlineTo).toBe(node.to)
      expect(parts!.kind).toBe("spaces")
    }
  })

  it("covers a CRLF line break when the node spans one", () => {
    const source = "a  \r\nb"
    const node = stubNode("HardBreak", 1, 5)
    expect(hardBreakParts(node, nodeSlice(source, node))).toEqual({
      markerFrom: 1,
      markerTo: 3,
      newlineFrom: 3,
      newlineTo: 5,
      kind: "spaces",
    })
    const backslashSource = "a\\\r\nb"
    const backslashNode = stubNode("HardBreak", 1, 4)
    expect(hardBreakParts(backslashNode, nodeSlice(backslashSource, backslashNode))).toEqual({
      markerFrom: 1,
      markerTo: 2,
      newlineFrom: 2,
      newlineTo: 4,
      kind: "backslash",
    })
  })

  it("returns null for a node that does not end in a line break", () => {
    expect(hardBreakParts(stubNode("HardBreak", 0, 2), { sliceString: (f, t) => "\\x".slice(f, t) })).toBeNull()
  })

  it("returns null for a non-HardBreak node", () => {
    expect(hardBreakParts(requireNode(EXACT, "Paragraph"), nodeSlice(EXACT, requireNode(EXACT, "Paragraph")))).toBeNull()
    expect(hardBreakParts(requireNode(EXACT, "Escape"), nodeSlice(EXACT, requireNode(EXACT, "Escape")))).toBeNull()
  })

  it("returns null for malformed marker ranges", () => {
    // A single space is not a hard break.
    expect(hardBreakParts(stubNode("HardBreak", 0, 2), { sliceString: (f, t) => " \n".slice(f, t) })).toBeNull()
    // An empty marker range.
    expect(hardBreakParts(stubNode("HardBreak", 0, 1), { sliceString: (f, t) => "\n".slice(f, t) })).toBeNull()
    // An inverted range.
    expect(hardBreakParts(stubNode("HardBreak", 2, 1), { sliceString: (f, t) => "x\n".slice(f, t) })).toBeNull()
  })

  it("reads only inside the node it was given", () => {
    const node = requireNode(EXACT, "HardBreak", 1)
    // nodeSlice throws on any out-of-node read, so this passing proves bounds.
    expect(hardBreakParts(node, nodeSlice(EXACT, node))?.kind).toBe("spaces")
  })
})

function makeLiveView(doc: string, anchor = 0) {
  const errors: unknown[] = []
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [
      editorExtensions(),
      EditorView.exceptionSink.of(err => errors.push(err)),
    ],
  })
  const view = new EditorView({ state, parent })
  return {
    view,
    errors,
    destroy() {
      view.destroy()
      parent.remove()
    },
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe("escape and hard break live preview projection", () => {
  const SRC = "access\\_token before\\\nafter before  \nafter"
  const lineTexts = (view: EditorView) =>
    [...view.dom.querySelectorAll(".cm-line")].map(el => el.textContent)
  const specKeys = (state: EditorState) => state.field(livePreviewField).specs
    .map(spec => `${spec.tag}:${spec.from}:${spec.to}`)
    .sort()

  it("projects the markers out of the rendered text", async () => {
    const { view, errors, destroy } = makeLiveView(SRC, SRC.length)
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(lineTexts(view)).toEqual(["access_token before", "after before", "after"])
    destroy()
  })

  it("reveals the escape marker only for a collapsed caret inside the node", async () => {
    const { view, errors, destroy } = makeLiveView(SRC, 6)
    await tick()
    expect(lineTexts(view)[0]).toBe("access\\_token before")
    view.dispatch({ selection: { anchor: SRC.length } })
    await tick()
    expect(lineTexts(view)[0]).toBe("access_token before")
    view.dispatch({ selection: { anchor: 6, head: 8 } })
    await tick()
    expect(lineTexts(view)[0]).toBe("access_token before")
    expect(errors.map(String)).toEqual([])
    destroy()
  })

  it("reveals a hard-break marker only for a collapsed caret inside the node", async () => {
    const { view, errors, destroy } = makeLiveView(SRC, 20)
    await tick()
    expect(lineTexts(view)[0]).toBe("access_token before\\")
    view.dispatch({ selection: { anchor: 21 } })
    await tick()
    expect(lineTexts(view)[0]).toBe("access_token before\\")
    view.dispatch({ selection: { anchor: 22 } })
    await tick()
    expect(lineTexts(view)).toEqual(["access_token before", "after before", "after"])
    view.dispatch({ selection: { anchor: 34, head: 37 } })
    await tick()
    expect(lineTexts(view)[1]).toBe("after before")
    expect(errors.map(String)).toEqual([])
    destroy()
  })

  it("keeps hard-break markers out of atomic ranges so the caret crosses the line end", async () => {
    const { cursorCharLeft, cursorCharRight } = await import("@codemirror/commands")
    const state = EditorState.create({ doc: SRC, selection: { anchor: 0 }, extensions: editorExtensions() })
    const ranges: [number, number][] = []
    state.field(livePreviewField).atomic.between(0, SRC.length, (from, to) => {
      ranges.push([from, to])
    })
    for (const site of [[20, 22], [34, 37]] as const) {
      for (const [from, to] of ranges) {
        expect(to <= site[0] || from >= site[1]).toBe(true)
      }
    }
    expect(ranges).toContainEqual([6, 7])

    const { view, errors, destroy } = makeLiveView(SRC, 21)
    await tick()
    expect(cursorCharRight(view)).toBe(true)
    expect(view.state.selection.main.head).toBe(22)
    expect(cursorCharLeft(view)).toBe(true)
    expect(view.state.selection.main.head).toBe(21)
    expect(errors.map(String)).toEqual([])
    destroy()
  })

  it("keeps incremental specs equal to a fresh build after an edit elsewhere", async () => {
    const { view, errors, destroy } = makeLiveView(SRC, SRC.length)
    await tick()
    view.dispatch({ changes: { from: 0, insert: "x" }, selection: { anchor: SRC.length + 1 } })
    await tick()
    expect(specKeys(view.state)).toEqual(
      buildLiveDecorations(view.state).specs.map(spec => `${spec.tag}:${spec.from}:${spec.to}`).sort(),
    )
    expect(errors.map(String)).toEqual([])
    destroy()
  })
})

