import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { syntaxTree } from "@codemirror/language"
import { describe, expect, it } from "vitest"
import { collectDecorationSpecs } from "../src/decorations/build"
import {
  codeSourceOffset, startCodeSelectionDrag, type CodeSelectionDragHandle,
  type CodeSourceRange,
} from "../src/decorations/widgets/codeSelection"
import { makeState } from "./helpers"

interface CodeBlock {
  readonly range: CodeSourceRange
  readonly src: string
  readonly doc: string
}

function codeBlock(doc: string): CodeBlock {
  const state = makeState(doc, [], { anchor: doc.length })
  const spec = collectDecorationSpecs(state, 0, state.doc.length)
    .find(candidate => candidate.tag === "widget:block:code")
  if (!spec) throw new Error("expected a rendered code widget")
  const widget = (spec.deco.spec as { widget?: { src?: string } }).widget
  if (typeof widget?.src !== "string") throw new Error("code widget has no source")
  return { range: { from: spec.from, to: spec.to }, src: widget.src, doc }
}

function offsetAt(block: CodeBlock, line: number, column: number): number {
  return codeSourceOffset(makeState(block.doc, [], { anchor: block.doc.length }), block.range, block.src, line, column)
}

describe("rendered code selection offsets", () => {
  it("maps content lines and UTF-16 columns to their source suffix", () => {
    const block = codeBlock("intro\n\n```js\nconst a = 1\nconst b = 2\n```\n\ntail")
    expect(block.src).toBe("const a = 1\nconst b = 2")
    expect(offsetAt(block, 0, 6)).toBe(block.doc.indexOf("a = 1"))
    expect(offsetAt(block, 1, 0)).toBe(block.doc.indexOf("const b = 2"))
    expect(offsetAt(block, 1, 5)).toBe(block.doc.indexOf("const b = 2") + 5)
  })

  it("maps quoted fence lines through the quote prefix", () => {
    const block = codeBlock("> quote\n>\n> ```js\n> const a = 1\n> const b = 2\n> ```\n> tail")
    expect(block.src).toBe("const a = 1\nconst b = 2")
    expect(offsetAt(block, 0, 6)).toBe(block.doc.indexOf("a = 1"))
    expect(offsetAt(block, 1, 0)).toBe(block.doc.indexOf("const b = 2"))
  })

  it("anchors repeated content at the structural content start", () => {
    // `> foo > foo` repeats the whole content string behind the quote prefix. Offsets are
    // anchored at the position the parser gives the fence's CodeText (after `> `), so no
    // occurrence inside the prefix can be mistaken for the content start.
    const block = codeBlock("> ```js\n> foo > foo\n> ```\n")
    expect(block.src).toBe("foo > foo")
    const lineFrom = block.doc.indexOf("> foo > foo")
    expect(offsetAt(block, 0, 0)).toBe(lineFrom + 2)
    expect(offsetAt(block, 0, 4)).toBe(lineFrom + 2 + 4)
    expect(offsetAt(block, 0, block.src.length)).toBe(lineFrom + 2 + 9)

    const list = codeBlock("- item\n\n  ```js\n  a a\n  ```\n")
    expect(list.src).toBe("a a")
    const listFrom = list.doc.indexOf("  a a")
    expect(offsetAt(list, 0, 0)).toBe(listFrom + 2)
    expect(offsetAt(list, 0, 2)).toBe(listFrom + 2 + 2)
  })

  it("derives every content start from the fence's own CodeText nodes", () => {
    // Drift guard for `contentStart`: the mapped start must equal the parser's CodeText
    // line start, not merely a suffix that happens to match the text.
    const docs = [
      "```js\na\nb\n```\n",
      "> ```js\n> a\n>\n> b\n> ```\n",
      "> > ```js\n> >   a  \n> > ```\n",
      "  ```js\n  indented\n  ```\n",
      "- item\n\n  ```js\n     deep\n  ```\n",
      "> ```js\n> a > a\n> ```\n",
      "> ```js\n> \t<!-- -->tab\n> ```\n",
    ]
    for (const doc of docs) {
      const block = codeBlock(doc)
      const state = makeState(doc, [], { anchor: 0 })
      const parts: { from: number; text: string }[] = []
      syntaxTree(state).iterate({
        from: block.range.from,
        to: block.range.to,
        enter: node => {
          if (node.name !== "FencedCode") return
          for (let child = node.node.firstChild; child; child = child.nextSibling) {
            if (child.name !== "CodeText") continue
            parts.push({ from: child.from, text: state.doc.sliceString(child.from, child.to) })
          }
        },
      })
      // Position of a `src` offset: children concatenate into exactly `src`.
      const positionAt = (offset: number): number => {
        let base = 0
        for (const part of parts) {
          if (offset < base + part.text.length) return part.from + (offset - base)
          base += part.text.length
        }
        const last = parts[parts.length - 1]
        return last.from + last.text.length
      }
      const starts: number[] = []
      let offset = 0
      for (const content of block.src.split("\n")) {
        starts.push(positionAt(offset))
        offset += content.length + 1
      }
      expect(parts.map(part => part.text).join("")).toBe(block.src)
      for (const [line, start] of starts.entries()) {
        expect(offsetAt(block, line, 0), `${JSON.stringify(doc)} line ${line}`).toBe(start)
      }
    }
  })

  it("keeps blank lines and leading whitespace inside the source range", () => {
    const block = codeBlock("x\n\n```js\na\n\n  b  \n```\n")
    expect(block.src).toBe("a\n\n  b  ")
    expect(offsetAt(block, 0, 0)).toBe(block.doc.indexOf("a\n"))
    const blank = offsetAt(block, 1, 0)
    expect(blank).toBe(block.doc.indexOf("\n\n  b") + 1)
    expect(offsetAt(block, 2, 0)).toBe(block.doc.indexOf("  b  "))
    expect(offsetAt(block, 2, 5)).toBe(block.doc.indexOf("  b  ") + 5)
  })

  it("counts tabs as single UTF-16 source columns", () => {
    const block = codeBlock("```js\n\tfoo\n```\n")
    expect(offsetAt(block, 0, 0)).toBe(block.doc.indexOf("\tfoo"))
    expect(offsetAt(block, 0, 1)).toBe(block.doc.indexOf("foo"))
  })

  it("clamps columns and out-of-range lines to the real content", () => {
    const block = codeBlock("```js\na\nb\n```\n")
    const last = block.doc.indexOf("b")
    expect(offsetAt(block, 9, 0)).toBe(last)
    expect(offsetAt(block, 9, 99)).toBe(last + 1)
    expect(offsetAt(block, 0, -5)).toBe(block.doc.indexOf("a"))
  })
})

// --- Gesture lifecycle -------------------------------------------------------

interface Harness {
  readonly view: EditorView
  readonly body: HTMLElement
  readonly state: EditorState
  readonly range: CodeSourceRange
  readonly selections: { anchor: number; head: number }[]
  setState(state: EditorState): void
  move(x: number, y: number): void
}

const rect = (top: number, height: number, left = 0, width = 400) =>
  ({ top, height, left, width, bottom: top + height, right: left + width, x: left, y: top,
    toJSON: () => ({}) }) as DOMRect

/**
 * Happy-dom has no layout, so the harness stubs the two rects the capture path reads
 * and a scroll viewport tall enough to keep every source line visible.
 */
function harness(doc = "```js\na\nb\n```\n"): Harness {
  // Caret outside the fence keeps it rendered (a caret inside unmounts the widget).
  const state = makeState(doc, [], { anchor: doc.length })
  const spec = collectDecorationSpecs(state, 0, state.doc.length)
    .find(candidate => candidate.tag === "widget:block:code")!
  const range = { from: spec.from, to: spec.to }
  const src = (spec.deco.spec as { widget: { src: string } }).widget.src

  const body = document.createElement("div")
  body.className = "omd-code-lines"
  const pre = document.createElement("pre")
  pre.textContent = src
  body.appendChild(pre)
  body.getBoundingClientRect = () => rect(0, 40)
  pre.getBoundingClientRect = () => rect(0, 40)
  document.body.appendChild(body)

  const scrollDOM = document.createElement("div")
  scrollDOM.getBoundingClientRect = () => rect(0, 600, 0, 800)
  const contentDOM = document.createElement("div")
  document.body.appendChild(contentDOM)

  const selections: { anchor: number; head: number }[] = []
  let current = state
  const stub = {
    state: current,
    dom: document.body.appendChild(document.createElement("div")),
    scrollDOM,
    contentDOM,
    focus: () => {},
    dispatch: (tr: { selection?: { anchor: number; head: number } }) => {
      if (tr.selection) selections.push(tr.selection)
    },
    posAtCoords: () => range.from,
    posAtDOM: () => range.from,
  }
  return {
    view: stub as unknown as EditorView,
    body,
    state,
    range,
    selections,
    setState(next) { current = next; stub.state = next },
    move(x, y) {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }))
    },
  }
}

const press = (x: number, y: number): MouseEvent =>
  new MouseEvent("mousedown", { button: 0, clientX: x, clientY: y, bubbles: true })

function start(harness: Harness, src = "a\nb"): CodeSelectionDragHandle {
  const handle = startCodeSelectionDrag({
    view: harness.view, body: harness.body, src, range: harness.range, event: press(0, 2),
  })
  if (!handle) throw new Error("drag did not start")
  return handle
}

describe("rendered code drag lifecycle", () => {
  it("commits one source-backed range per pointer move", () => {
    const h = harness()
    const handle = start(h)
    expect(handle.dragging).toBe(false)
    h.move(2, 3)
    // Drift inside the click threshold stays a click: the widget must survive it.
    expect(h.selections).toHaveLength(0)
    h.move(10, 30)
    expect(handle.dragging).toBe(true)
    expect(h.selections).toHaveLength(1)
    expect(h.selections[0].anchor).toBe(h.state.doc.line(2).from)
    expect(h.selections[0].head).toBe(h.state.doc.line(3).from)
    handle.cancel()
  })

  it("stops dispatching after a window blur cancels the gesture", () => {
    const h = harness()
    const handle = start(h)
    h.move(10, 30)
    expect(h.selections).toHaveLength(1)
    window.dispatchEvent(new Event("blur"))
    h.move(10, 2)
    expect(h.selections).toHaveLength(1)
    expect(handle.dragging).toBe(true)
  })

  it("cancels on Escape and ignores later moves", () => {
    const h = harness()
    start(h)
    h.move(10, 30)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    h.move(10, 2)
    expect(h.selections).toHaveLength(1)
  })

  it("aborts instead of retargeting when the document changes mid-gesture", () => {
    const h = harness()
    start(h)
    h.move(10, 30)
    expect(h.selections).toHaveLength(1)
    h.setState(EditorState.create({ doc: "```js\nzzz\n```\n" }))
    h.move(10, 2)
    expect(h.selections).toHaveLength(1)
  })

  it("aborts when the view's DOM is detached mid-gesture", () => {
    const h = harness()
    start(h)
    h.move(10, 30)
    expect(h.selections).toHaveLength(1)
    ;(h.view as unknown as { dom: HTMLElement }).dom.remove()
    h.move(10, 2)
    expect(h.selections).toHaveLength(1)
  })

  it("replaces the previous gesture instead of stacking window listeners", () => {
    const h = harness()
    const first = start(h)
    const second = start(h)
    h.move(10, 30)
    expect(h.selections).toHaveLength(1)
    expect(first.dragging).toBe(false)
    expect(second.dragging).toBe(true)
    second.cancel()
  })

  it("cancelling before any move keeps the old selection untouched", () => {
    const h = harness()
    const handle = start(h)
    handle.cancel()
    h.move(10, 30)
    expect(h.selections).toHaveLength(0)
    expect(handle.dragging).toBe(false)
  })
})
