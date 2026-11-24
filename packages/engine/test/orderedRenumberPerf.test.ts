/**
 * Deterministic unit tests for `orderedRenumber`'s scan plan.
 *
 * They replace the timing probe that used to live here (`forceParsing` over a
 * 3k-paragraph CJK document plus `expect(true).toBe(true)`): a probe measured
 * nothing the parser suites do not already pin and took seconds per run. These
 * tests mount real views but assert observable document state in milliseconds.
 *
 * Two guarantees are pinned:
 * 1. A synchronous burst of document edits is scanned once, not once per edit
 *    (`microtaskScheduled` in `lists/ordered.ts`).
 * 2. A steady-state edit scans `changed ± STEADY_EDIT_SCAN_MARGIN_CHARS` only:
 *    a stale list outside that neighborhood survives the keystroke, while an
 *    edit at the list renumbers it on the next microtask.
 */
import { EditorState, Transaction, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { forceParsing, syntaxTree } from "@codemirror/language"
import { afterEach, describe, expect, it, vi } from "vitest"
import { editorExtensions } from "../src/index"
import {
  STANDARD_PERFORMANCE_POLICY,
  WINDOWED_PERFORMANCE_POLICY,
  type EditorPerformancePolicy,
} from "../src/performancePolicy"
import { STEADY_EDIT_SCAN_MARGIN_CHARS } from "../src/lists/ordered"

// ~8k chars of prose: long enough that the list at the end stays beyond both the
// edit and the initial synchronous parse (which stops near the 3000-char
// `Work.InitViewport` bound of @codemirror/language).
const PARAGRAPH = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.\n\n"
const PROSE = PARAGRAPH.repeat(96)
const BROKEN_LIST = "1. first\n5. second"
const USER_TYPING = Transaction.userEvent.of("input.type")

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
})

/** Mounts a real view in a detached host, like `Editor.ts` does. */
function mountEditor(doc: string, policy: EditorPerformancePolicy, extra: Extension[] = []) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [editorExtensions({ performancePolicy: policy }), ...extra],
    }),
    parent,
  })
  cleanups.push(() => { view.destroy(); parent.remove() })
  return view
}

/** Lets the queued renumber microtask and the update it may dispatch run. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** Lets pending timers/idle channels settle, so the next burst starts a fresh tick. */
function flushMacrotask(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

/**
 * Forces the syntax tree to cover the whole document and lets the resulting
 * parse-progress pass run. `forceParsing` dispatches an empty transaction when
 * the parser advanced, so the plugin sees the tree grow (entry/parse-progress
 * path) — the caller uses this only after the steady-state assertions.
 */
async function completeParsing(view: EditorView): Promise<void> {
  forceParsing(view, view.state.doc.length, 10_000)
  await flushMicrotasks()
}

function text(view: EditorView): string {
  return view.state.doc.toString()
}

describe.each<[string, EditorPerformancePolicy]>([
  ["standard", STANDARD_PERFORMANCE_POLICY],
  ["windowed", WINDOWED_PERFORMANCE_POLICY],
])("ordered renumber steady scans (%s policy)", (_name, policy) => {
  it("leaves a stale list beyond the steady margin untouched while typing prose", async () => {
    const doc = `${PROSE}${BROKEN_LIST}`
    const listStart = PROSE.length
    const view = mountEditor(doc, policy)
    // Precondition: the list is farther away than a steady pass reaches, and the
    // initial parse has not reached it either, so only the steady range paths
    // could have touched it after the edit below.
    expect(listStart).toBeGreaterThan(STEADY_EDIT_SCAN_MARGIN_CHARS)
    expect(syntaxTree(view.state).length).toBeLessThan(listStart)
    await flushMicrotasks()

    view.dispatch({ changes: { from: 0, insert: "x" }, annotations: [USER_TYPING] })
    await flushMicrotasks()

    expect(text(view).endsWith(BROKEN_LIST)).toBe(true)
    // The list is real and reachable: once parsing covers it, the entry/progress
    // pass renumbers it. The keystroke above simply never scanned that far.
    await completeParsing(view)
    expect(text(view).endsWith("1. first\n2. second")).toBe(true)
  })

  it("renumbers a marker typed inside an ordered list on the next microtask", async () => {
    const doc = `${PROSE}1. first\n2. second`
    const view = mountEditor(doc, policy)
    await flushMicrotasks()
    // Settle the tree first: with the whole document parsed there is no pending
    // parse-progress scan, so the renumber below comes from the steady range.
    await completeParsing(view)
    expect(text(view)).toBe(doc)

    const marker = doc.lastIndexOf("2.")
    view.dispatch({
      changes: { from: marker, to: marker + 1, insert: "5" },
      annotations: [USER_TYPING],
    })
    expect(text(view).endsWith("1. first\n5. second")).toBe(true)

    await flushMicrotasks()
    expect(text(view).endsWith("1. first\n2. second")).toBe(true)
  })

  it("renumbers an item typed at the list edge on the next microtask", async () => {
    const doc = `${PROSE}1. first\n2. second`
    const view = mountEditor(doc, policy)
    await flushMicrotasks()
    await completeParsing(view)

    view.dispatch({
      changes: { from: text(view).length, insert: "\n5. third" },
      annotations: [USER_TYPING],
    })
    await flushMicrotasks()

    expect(text(view).endsWith("1. first\n2. second\n3. third")).toBe(true)
  })
})

describe("ordered renumber microtask coalescing", () => {
  it("scans a burst of five synchronous edits once", async () => {
    let renumberTransactions = 0
    const view = mountEditor("1. a\n2. b", STANDARD_PERFORMANCE_POLICY, [
      EditorView.updateListener.of(update => {
        // The renumber transaction carries no user event; the edits below do.
        for (const tr of update.transactions) {
          if (tr.docChanged && tr.annotation(Transaction.userEvent) === undefined) {
            renumberTransactions++
          }
        }
      }),
    ])
    await flushMicrotasks()
    await flushMacrotask()
    const queueMicrotaskSpy = vi.spyOn(globalThis, "queueMicrotask")
    queueMicrotaskSpy.mockClear()

    for (let index = 0; index < 5; index++) {
      // Each insertion appends a wrongly numbered item: five stale markers in
      // five separate changed ranges, all recorded before the queued pass runs.
      view.dispatch({
        changes: { from: text(view).length, insert: `\n5. item${index}` },
        annotations: [USER_TYPING],
      })
    }
    // One queued pass for the whole burst, not one per dispatch.
    expect(queueMicrotaskSpy.mock.calls.length).toBe(1)

    await flushMicrotasks()
    expect(renumberTransactions).toBe(1)
    expect(text(view)).toBe("1. a\n2. b\n3. item0\n4. item1\n5. item2\n6. item3\n7. item4")
  })
})
