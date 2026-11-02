import { EditorSelection, EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { afterEach, describe, expect, it, vi } from "vitest"
import { pasteBookmarkExtension } from "../src/pasteBookmark"
import { pastePlainText } from "../src/pastePlainText"

const originalClipboard = navigator.clipboard
const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true })
})

function setup(doc = "abcdef", selection = EditorSelection.single(2, 4), readOnly = false) {
  let documentId = 1
  const errors: string[] = []
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection,
      extensions: [
        pasteBookmarkExtension,
        EditorState.allowMultipleSelections.of(true),
        readOnly ? EditorState.readOnly.of(true) : [],
      ],
    }),
    parent: document.body.appendChild(document.createElement("div")),
  })
  views.push(view)
  return {
    view,
    options: {
      getTabId: () => 1,
      getDocumentId: () => documentId,
      getDocPath: () => "/tmp/a.md",
      onError: (message: string) => errors.push(message),
    },
    errors,
    setDocumentId: (value: number) => { documentId = value },
  }
}

function stub(text: string | Promise<string>) {
  const readText = vi.fn(async () => await text)
  Object.defineProperty(navigator, "clipboard", { value: { readText }, configurable: true })
  return readText
}

describe("pastePlainText", () => {
  it("inserts exact bytes at the captured selection", async () => {
    stub("# title\n$x$\n**x**")
    const ctx = setup()
    await pastePlainText(ctx.view, ctx.options)
    expect(ctx.view.state.doc.toString()).toBe("ab# title\n$x$\n**x**ef")
  })

  it("maps multiple selections and dispatches once", async () => {
    stub("X")
    const ctx = setup("ab", EditorSelection.create([
      EditorSelection.cursor(0),
      EditorSelection.cursor(2),
    ]))
    const dispatch = vi.spyOn(ctx.view, "dispatch")
    await pastePlainText(ctx.view, ctx.options)
    expect(ctx.view.state.doc.toString()).toBe("XabX")
    expect(dispatch.mock.calls.filter(call => call[0]?.userEvent === "input.paste")).toHaveLength(1)
  })

  it("cancels when document identity changes while reading", async () => {
    let release!: (text: string) => void
    stub(new Promise(resolve => { release = resolve }))
    const ctx = setup()
    const job = pastePlainText(ctx.view, ctx.options)
    ctx.setDocumentId(2)
    release("X")
    await job
    expect(ctx.view.state.doc.toString()).toBe("abcdef")
  })

  it("does not read in readOnly state", async () => {
    const readText = stub("X")
    const ctx = setup("locked", EditorSelection.single(0), true)
    await pastePlainText(ctx.view, ctx.options)
    expect(readText).not.toHaveBeenCalled()
  })

  it("reports rejection and recovers for the next command", async () => {
    const ctx = setup()
    Object.defineProperty(navigator, "clipboard", {
      value: { readText: vi.fn(async () => { throw new Error("denied") }) },
      configurable: true,
    })
    await pastePlainText(ctx.view, ctx.options)
    expect(ctx.errors).toEqual(["denied"])
    stub("X")
    await pastePlainText(ctx.view, ctx.options)
    expect(ctx.view.state.doc.toString()).toBe("abXef")
  })
})
