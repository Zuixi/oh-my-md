import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { afterEach, describe, expect, it } from "vitest"
import {
  pasteBookmarkExtension,
  readPasteBookmark,
  startPasteBookmark,
} from "../src/pasteBookmark"

const views: EditorView[] = []
afterEach(() => { for (const view of views.splice(0)) view.destroy() })

function view(doc = "abcdef", from = 3, to = from) {
  const next = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: from, head: to }, extensions: [pasteBookmarkExtension] }),
    parent: document.body.appendChild(document.createElement("div")),
  })
  views.push(next)
  return next
}

describe("paste bookmarks", () => {
  it("maps collapsed bookmarks after earlier insertions with forward association", () => {
    const editor = view()
    const mark = startPasteBookmark(editor, 3, 3)
    editor.dispatch({ changes: { from: 1, insert: "XY" } })
    expect(readPasteBookmark(editor.state, mark)).toEqual({ kind: "active", from: 5, to: 5 })
  })

  it("keeps selection-only transactions from redirecting a bookmark", () => {
    const editor = view()
    const mark = startPasteBookmark(editor, 3, 3)
    editor.dispatch({ selection: { anchor: 0 } })
    expect(readPasteBookmark(editor.state, mark)).toEqual({ kind: "active", from: 3, to: 3 })
  })

  it("invalidates selected ranges touched by another transaction", () => {
    const editor = view("abcdef", 2, 4)
    const mark = startPasteBookmark(editor, 2, 4)
    editor.dispatch({ changes: { from: 3, to: 3, insert: "X" } })
    expect(readPasteBookmark(editor.state, mark)).toEqual({ kind: "invalid" })
  })

  it("maps two queued collapsed bookmarks independently in invocation order", () => {
    const editor = view()
    const a = startPasteBookmark(editor, 3, 3)
    const b = startPasteBookmark(editor, 3, 3)
    editor.dispatch({ changes: { from: 3, insert: "A" } })
    expect(readPasteBookmark(editor.state, a)).toEqual({ kind: "active", from: 4, to: 4 })
    expect(readPasteBookmark(editor.state, b)).toEqual({ kind: "active", from: 4, to: 4 })
  })

  it("clears bookmarks on reconfiguration", () => {
    const editor = view()
    const mark = startPasteBookmark(editor, 3, 3)
    editor.setState(EditorState.create({ doc: editor.state.doc, extensions: [pasteBookmarkExtension] }))
    expect(readPasteBookmark(editor.state, mark)).toBeNull()
  })
})
