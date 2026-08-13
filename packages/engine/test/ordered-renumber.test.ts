import { describe, expect, it } from "vitest"
import { EditorView } from "@codemirror/view"
import { ChangeSet, EditorState } from "@codemirror/state"
import { syntaxTree } from "@codemirror/language"
import { makeState } from "./helpers"
import {
  acceptOrderedListNormalization,
  editorExtensions,
  getPendingOrderedListNormalization,
  rejectOrderedListNormalization,
} from "../src/index"
import { applyToggle } from "../src/modes/livePreview"
import {
  buildOrderedNormalizationTransaction,
  mapReversibleMarkerRange,
  mergeReversibleOrderedMarkers,
  normalizationTrigger,
  orderedRenumberChanges,
  type OrderedMarkChange,
} from "../src/lists/ordered"

function apply(doc: string) {
  const state = makeState(doc)
  const changes = orderedRenumberChanges(state)
  return state.update({ changes }).state.doc.toString()
}

describe("orderedRenumberChanges", () => {
  it("rewrites skipped numbers to a consecutive sequence from the first item", () => {
    expect(apply("1. 第一项\n3. 第二项\n7. 第三项")).toBe("1. 第一项\n2. 第二项\n3. 第三项")
  })

  it("keeps the first item's number as the start", () => {
    expect(apply("3. a\n7. b")).toBe("3. a\n4. b")
  })

  it("returns no changes when numbers are already consecutive", () => {
    const doc = "1. a\n2. b\n3. c"
    expect(orderedRenumberChanges(makeState(doc))).toEqual([])
  })

  it("renumbers nested ordered lists independently", () => {
    const doc = "1. outer\n   1. inner a\n   3. inner b\n2. second"
    expect(apply(doc)).toBe("1. outer\n   1. inner a\n   2. inner b\n2. second")
  })

  it("does not rewrite unordered lists", () => {
    const doc = "- a\n- b\n1. x\n3. y"
    expect(apply(doc)).toBe("- a\n- b\n1. x\n2. y")
  })

  it("preserves parenthesis delimiters", () => {
    expect(apply("1) a\n3) b")).toBe("1) a\n2) b")
  })
})

describe("ordered list normalization batch bookkeeping", () => {
  it("keeps first original and latest normalized for a repeated marker", () => {
    const first = [{ from: 5, to: 7, original: "3.", normalized: "2." }]
    const second = [{ from: 5, to: 7, original: "2.", normalized: "4." }]
    expect(mergeReversibleOrderedMarkers(first, second)).toEqual([
      { from: 5, to: 7, original: "3.", normalized: "4." },
    ])
  })

  it.each<[string, { from: number; insert: string }, { from: number; to: number }]>([
    ["before", { from: 5, insert: "x" }, { from: 6, to: 8 }],
    ["inside", { from: 6, insert: "x" }, { from: 5, to: 8 }],
    ["after", { from: 7, insert: "x" }, { from: 5, to: 7 }],
  ])("maps %s insertion without widening the wrong boundary", (_name, change, expected) => {
    expect(mapReversibleMarkerRange(
      { from: 5, to: 7, original: "3.", normalized: "2." },
      ChangeSet.of([change], 12),
    )).toMatchObject(expected)
  })

  it("keeps tree-progress batches in preview-entry until the syntax tree covers the document", () => {
    expect(normalizationTrigger(true, 10, 20)).toBe("preview-entry")
    expect(normalizationTrigger(false, 10, 20)).toBe("preview-entry")
    expect(normalizationTrigger(false, 20, 20)).toBe("preview-entry")
    expect(normalizationTrigger(true, 20, 20)).toBe("user-followup")
  })
})

describe("ordered list source rewrite in the editor", () => {
  function makeView(doc: string) {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const errors: unknown[] = []
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [editorExtensions(), EditorView.exceptionSink.of(e => { errors.push(e) })],
      }),
      parent,
    })
    return { view, errors }
  }

  const tick = () => new Promise(r => setTimeout(r, 100))

  function dispatchPreviewBatch(view: EditorView, changes: readonly OrderedMarkChange[]) {
    view.dispatch(buildOrderedNormalizationTransaction(view.state, "preview-entry", changes))
  }

  it("writes consecutive numbers back into the document in live preview", async () => {
    const { view, errors } = makeView("1. 第一项\n3. 第二项\n7. 第三项\n\ntail")
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. 第一项\n2. 第二项\n3. 第三项\n\ntail")
    view.destroy()
  })

  it("shows the rewritten source when the cursor enters a list line", async () => {
    const { view, errors } = makeView("1. 第一项\n3. 第二项\n7. 第三项")
    await tick()
    const line2 = view.state.doc.line(2)
    view.dispatch({ selection: { anchor: line2.from } })
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.line(2).text.startsWith("2.")).toBe(true)
    expect(view.dom.textContent).toContain("2. 第二项")
    view.destroy()
  })

  it("does not rewrite source while in source mode", async () => {
    const { view, errors } = makeView("1. a\n3. b")
    view.dispatch(applyToggle(view.state))
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n3. b")
    view.destroy()
  })

  it("creates one pending notice for preview-entry normalization", async () => {
    const { view, errors } = makeView("1. a\n3. b\n7. c")
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(getPendingOrderedListNormalization(view.state)?.markerCount).toBe(2)
    view.destroy()
  })

  it("rejects stale command ids without changing the document", async () => {
    const { view, errors } = makeView("1. a\n3. b")
    await tick()
    const notice = getPendingOrderedListNormalization(view.state)!
    const stale = (Number(notice.id) + 1) as typeof notice.id
    expect(acceptOrderedListNormalization(view.state, stale).kind).toBe("stale")
    expect(rejectOrderedListNormalization(view.state, stale).kind).toBe("stale")
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n2. b")
    view.destroy()
  })

  it("accepts the matching pending id without changing source", async () => {
    const { view, errors } = makeView("1. a\n3. b")
    await tick()
    const notice = getPendingOrderedListNormalization(view.state)!
    const before = view.state.doc.toString()
    const result = acceptOrderedListNormalization(view.state, notice.id)
    expect(result.kind).toBe("accepted")
    if (result.kind === "accepted") view.dispatch(result.transaction)
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe(before)
    expect(getPendingOrderedListNormalization(view.state)).toBeNull()
    view.destroy()
  })

  it("does not create a notice for normalization that follows a user edit", async () => {
    const { view, errors } = makeView("1. a\n2. b")
    await tick()
    const line2 = view.state.doc.line(2)
    view.dispatch({ changes: { from: line2.from, to: line2.from + 2, insert: "5." } })
    // The rule is about the trigger, not the pass count: the tree already covers the document, so
    // this rewrite can only come from the user's own edit.
    expect(syntaxTree(view.state).length).toBe(view.state.doc.length)
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n2. b")
    expect(getPendingOrderedListNormalization(view.state)).toBeNull()
    view.destroy()
  })

  it("does not create pending for already-consecutive numbers", async () => {
    const { view, errors } = makeView("1. a\n2. b")
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n2. b")
    expect(getPendingOrderedListNormalization(view.state)).toBeNull()
    view.destroy()
  })

  it("does not create pending in source mode", async () => {
    const { view, errors } = makeView("1. a\n3. b")
    view.dispatch(applyToggle(view.state))
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n3. b")
    expect(getPendingOrderedListNormalization(view.state)).toBeNull()
    view.destroy()
  })

  it("does not normalize while the view is composing", async () => {
    const { view, errors } = makeView("1. a\n3. b")
    Object.defineProperty(view, "composing", { configurable: true, value: true })
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n3. b")
    expect(getPendingOrderedListNormalization(view.state)).toBeNull()
    view.destroy()
  })

  it("rejects normalization without losing later body edits", async () => {
    const { view, errors } = makeView("1. a\n3. b\n\nbody")
    await tick()
    view.dispatch({ changes: { from: view.state.doc.length, insert: " edited" } })
    const notice = getPendingOrderedListNormalization(view.state)!
    const result = rejectOrderedListNormalization(view.state, notice.id)
    if (result.kind === "reverted") view.dispatch(result.transaction)
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n3. b\n\nbody edited")
    view.destroy()
  })

  it("maps variable-length markers in new coordinates", async () => {
    const { view, errors } = makeView("1. a\n10. beta\n11. gamma")
    await tick()
    expect(view.state.doc.toString()).toBe("1. a\n2. beta\n3. gamma")
    view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } })
    const notice = getPendingOrderedListNormalization(view.state)!
    const result = rejectOrderedListNormalization(view.state, notice.id)
    expect(result.kind === "reverted" && result.restoredMarkers).toBe(2)
    if (result.kind === "reverted") view.dispatch(result.transaction)
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n10. beta\n11. gamma!")
    view.destroy()
  })

  it("skips a pending marker edited in source mode", async () => {
    const { view, errors } = makeView("1. a\n3. b")
    await tick()
    const notice = getPendingOrderedListNormalization(view.state)!
    view.dispatch(applyToggle(view.state))
    const line = view.state.doc.line(2)
    view.dispatch({ changes: { from: line.from, to: line.from + 2, insert: "9." } })
    const result = rejectOrderedListNormalization(view.state, notice.id)
    expect(result.kind === "reverted" && result.skippedMarkers).toBe(1)
    if (result.kind === "reverted") view.dispatch(result.transaction)
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.line(2).text).toBe("9. b")
    view.destroy()
  })

  it("keeps pending and suppression across source/live toggles", async () => {
    const { view, errors } = makeView("1. a\n3. b")
    await tick()
    const notice = getPendingOrderedListNormalization(view.state)!
    view.dispatch(applyToggle(view.state))
    expect(getPendingOrderedListNormalization(view.state)?.id).toBe(notice.id)
    expect(getPendingOrderedListNormalization(view.state)?.markerCount).toBe(notice.markerCount)
    const rejected = rejectOrderedListNormalization(view.state, notice.id)
    if (rejected.kind === "reverted") view.dispatch(rejected.transaction)
    view.dispatch(applyToggle(view.state))
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n3. b")
    expect(getPendingOrderedListNormalization(view.state)).toBeNull()
    view.destroy()
  })

  it("merges two preview batches under one id and restores every marker", async () => {
    const { view, errors } = makeView("1. a\n3. b\n7. c")
    // Source mode removes the renumber plugin, and the tick drains the pass its constructor
    // queued, so the only batches the field sees are the two dispatched below.
    view.dispatch(applyToggle(view.state))
    await tick()
    expect(getPendingOrderedListNormalization(view.state)).toBeNull()
    dispatchPreviewBatch(view, [{ from: 5, to: 7, insert: "2." }])
    const first = getPendingOrderedListNormalization(view.state)!
    expect(first.markerCount).toBe(1)
    // A marker the first batch never touched: the second batch must extend the same pending id.
    dispatchPreviewBatch(view, [{ from: 10, to: 12, insert: "3." }])
    const second = getPendingOrderedListNormalization(view.state)!
    expect(second.id).toBe(first.id)
    expect(second.markerCount).toBe(2)
    expect(view.state.doc.toString()).toBe("1. a\n2. b\n3. c")
    const result = rejectOrderedListNormalization(view.state, second.id)
    expect(result.kind === "reverted" && result.restoredMarkers).toBe(2)
    expect(result.kind === "reverted" && result.skippedMarkers).toBe(0)
    if (result.kind === "reverted") view.dispatch(result.transaction)
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n3. b\n7. c")
    expect(getPendingOrderedListNormalization(view.state)).toBeNull()
    view.destroy()
  })

  it("reports a partial restore when one pending marker was edited", async () => {
    const { view, errors } = makeView("1. a\n3. b\n7. c")
    await tick()
    expect(view.state.doc.toString()).toBe("1. a\n2. b\n3. c")
    const notice = getPendingOrderedListNormalization(view.state)!
    expect(notice.markerCount).toBe(2)
    view.dispatch(applyToggle(view.state))
    const line3 = view.state.doc.line(3)
    view.dispatch({ changes: { from: line3.from, to: line3.from + 2, insert: "9." } })
    const result = rejectOrderedListNormalization(view.state, notice.id)
    expect(result.kind === "reverted" && result.restoredMarkers).toBe(1)
    expect(result.kind === "reverted" && result.skippedMarkers).toBe(1)
    if (result.kind === "reverted") view.dispatch(result.transaction)
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n3. b\n9. c")
    view.destroy()
  })

  it("does not extend pending with new user-followup markers", async () => {
    const { view, errors } = makeView("1. a\n3. b")
    await tick()
    expect(getPendingOrderedListNormalization(view.state)?.markerCount).toBe(1)
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n\ntail\n\n1. x\n7. y" } })
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n2. b\n\ntail\n\n1. x\n2. y")
    expect(getPendingOrderedListNormalization(view.state)?.markerCount).toBe(1)
    view.destroy()
  })

  it("updates latest normalized for a user-followup rewrite of an existing pending marker", async () => {
    const { view, errors } = makeView("1. a\n5. b")
    await tick()
    expect(view.state.doc.toString()).toBe("1. a\n2. b")
    view.dispatch({ changes: { from: 0, insert: "1. z\n" } })
    await tick()
    expect(view.state.doc.toString()).toBe("1. z\n2. a\n3. b")
    const notice = getPendingOrderedListNormalization(view.state)!
    expect(notice.markerCount).toBe(1)
    const result = rejectOrderedListNormalization(view.state, notice.id)
    expect(result.kind === "reverted" && result.restoredMarkers).toBe(1)
    expect(result.kind === "reverted" && result.skippedMarkers).toBe(0)
    if (result.kind === "reverted") view.dispatch(result.transaction)
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. z\n2. a\n5. b")
    view.destroy()
  })

  it("restores markers whose width changed during normalization", async () => {
    const { view, errors } = makeView("1. a\n10. b\n11. c")
    await tick()
    expect(view.state.doc.toString()).toBe("1. a\n2. b\n3. c")
    const notice = getPendingOrderedListNormalization(view.state)!
    expect(notice.markerCount).toBe(2)
    const result = rejectOrderedListNormalization(view.state, notice.id)
    expect(result.kind === "reverted" && result.restoredMarkers).toBe(2)
    expect(result.kind === "reverted" && result.skippedMarkers).toBe(0)
    if (result.kind === "reverted") view.dispatch(result.transaction)
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n10. b\n11. c")
    view.destroy()
  })

  it("restores the original markers on reject and stops renumbering again", async () => {
    const { view, errors } = makeView("1. a\n3. b\n7. c")
    await tick()
    const notice = getPendingOrderedListNormalization(view.state)!
    const result = rejectOrderedListNormalization(view.state, notice.id)
    expect(result.kind === "reverted" && result.restoredMarkers).toBe(2)
    expect(result.kind === "reverted" && result.skippedMarkers).toBe(0)
    if (result.kind === "reverted") view.dispatch(result.transaction)
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n3. b\n7. c")
    expect(getPendingOrderedListNormalization(view.state)).toBeNull()
    view.destroy()
  })
})
