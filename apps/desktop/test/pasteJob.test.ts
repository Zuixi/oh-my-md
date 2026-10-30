import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { afterEach, describe, expect, it, vi } from "vitest"
import { pasteBookmarkExtension } from "../src/pasteBookmark"
import { runPasteJob, type PasteJobOptions } from "../src/pasteJob"

const views: EditorView[] = []
afterEach(() => { for (const view of views.splice(0)) view.destroy() })

function setup() {
  let tabId = 1
  let documentId = 1
  let path: string | null = "/tmp/a.md"
  const errors: string[] = []
  const view = new EditorView({
    state: EditorState.create({ doc: "", extensions: [pasteBookmarkExtension] }),
    parent: document.body.appendChild(document.createElement("div")),
  })
  views.push(view)
  const options: PasteJobOptions = {
    getTabId: () => tabId,
    getDocumentId: () => documentId,
    getDocPath: () => path,
    onError: message => errors.push(message),
  }
  return {
    view, options, errors,
    setTabId: (value: number) => { tabId = value },
    setDocumentId: (value: number) => { documentId = value },
    setPath: (value: string | null) => { path = value },
  }
}

describe("paste jobs", () => {
  it("captures before await and maps through non-overlapping edits", async () => {
    const ctx = setup()
    let release!: (value: string) => void
    const read = new Promise<string>(resolve => { release = resolve })
    const applied: number[] = []
    const job = runPasteJob(ctx.view, ctx.options, () => read, async (_, current) => {
      const target = current()
      if (target.kind === "active") applied.push(target.ranges[0].from)
    })
    ctx.view.dispatch({ changes: { from: 0, insert: "x" } })
    release("payload")
    await job
    expect(applied).toEqual([1])
  })

  it("cancels stale document path and identity", async () => {
    const ctx = setup()
    let release!: (value: string) => void
    const read = new Promise<string>(resolve => { release = resolve })
    const apply = vi.fn()
    const job = runPasteJob(ctx.view, ctx.options, () => read, async (_, current) => {
      if (current().kind === "active") apply()
    })
    ctx.setPath("/tmp/b.md")
    release("x")
    await job
    expect(apply).not.toHaveBeenCalled()
  })

  it("starts acquisitions immediately but commits in invocation order", async () => {
    const ctx = setup()
    const order: string[] = []
    let releaseA!: (value: string) => void
    const a = new Promise<string>(resolve => { releaseA = resolve })
    const first = runPasteJob(ctx.view, ctx.options, () => a, async value => { order.push(value) })
    const second = runPasteJob(ctx.view, ctx.options, async () => "B", async value => { order.push(value) })
    releaseA("A")
    await Promise.all([first, second])
    expect(order).toEqual(["A", "B"])
  })

  it("contains acquisition rejection and lets the next job proceed", async () => {
    const ctx = setup()
    const order: string[] = []
    const first = runPasteJob(ctx.view, ctx.options, async () => { throw new Error("denied") }, async () => {})
    const second = runPasteJob(ctx.view, ctx.options, async () => "B", async value => { order.push(value) })
    await Promise.all([first, second])
    expect(ctx.errors).toEqual(["denied"])
    expect(order).toEqual(["B"])
  })

  it("does not acquire in readOnly state", async () => {
    const ctx = setup()
    ctx.view.setState(EditorState.create({ doc: "", extensions: [pasteBookmarkExtension, EditorState.readOnly.of(true)] }))
    const acquire = vi.fn(async () => "x")
    await runPasteJob(ctx.view, ctx.options, acquire, async () => {})
    expect(acquire).not.toHaveBeenCalled()
  })
})
