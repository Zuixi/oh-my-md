import { forceParsing, syntaxTreeAvailable } from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { bench, describe } from "vitest"
import { drainPendingLiveBuild, livePreviewField } from "../src/decorations/build"
import { toggleBoldSpec } from "../src/format/inlineCommands"
import { editorExtensions, toggleBold, toggleCodeBlock, toggleHeading } from "../src/index"
import { budgetLine, TYPING_P95_BUDGET_MS } from "./measure"

const INLINE_PLAN_PRESSES = 240
const INLINE_SOURCE_PRESSES = 8
const INLINE_LIVE_PRESSES = 8
const BLOCK_PRESSES = 60

function makeLines(count: number, separateParagraphs = false): string {
  const lines: string[] = []
  for (let index = 0; index < count; index++) {
    lines.push(`format line ${index} with English and 中文 content`)
    if (separateParagraphs) lines.push("")
  }
  return lines.join("\n").replace(/\n$/, "")
}

const DOC_10K_PARAGRAPHS = makeLines(10_000, true)
const DOC_10K_SOFT_PARAGRAPH = makeLines(10_000)
const DOC_100_LINES = makeLines(100)
const DOC_200_LINE_PARAGRAPH = makeLines(200)

function mountEditor(
  doc: string,
  anchor: number,
  completeTree: boolean,
  live: boolean,
): EditorView {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: editorExtensions({ defaultLivePreview: live }),
    }),
    parent,
  })
  if (completeTree) {
    forceParsing(view, view.state.doc.length, 60_000)
    if (view.state.field(livePreviewField, false)) drainPendingLiveBuild(view)
  }
  return view
}

function mountLive(doc: string, anchor: number): EditorView {
  return mountEditor(doc, anchor, true, true)
}

function destroy(view: EditorView): void {
  const parent = view.parent ?? view.dom.parentElement
  view.destroy()
  parent?.remove()
}

function percentileMs(samples: readonly number[], percentile: number): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * percentile) - 1]
}

function measureToggles(
  view: EditorView,
  command: (view: EditorView) => boolean,
  presses: number,
): { p50Ms: number; p95Ms: number } {
  const samples: number[] = []
  for (let index = 0; index < presses; index++) {
    if (!forceParsing(view, view.state.doc.length, 60_000)) {
      throw new Error("formatting benchmark could not complete parsing before a toggle")
    }
    const started = performance.now()
    if (!command(view)) {
      console.error(`formatting benchmark measured a no-op at press ${index + 1}`)
      throw new Error("formatting benchmark measured a no-op")
    }
    samples.push(performance.now() - started)
  }
  return { p50Ms: percentileMs(samples, 0.5), p95Ms: percentileMs(samples, 0.95) }
}

function measurePlannerToggles(
  state: EditorState,
  presses: number,
): { p50Ms: number; p95Ms: number } {
  const samples: number[] = []
  for (let index = 0; index < presses; index++) {
    const started = performance.now()
    const spec = toggleBoldSpec(state)
    if (!spec) throw new Error("formatting planner benchmark measured a no-op")
    samples.push(performance.now() - started)
  }
  return { p50Ms: percentileMs(samples, 0.5), p95Ms: percentileMs(samples, 0.95) }
}

function measureUnavailableBold(doc: string, presses: number): number {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: editorExtensions(),
    }),
    parent,
  })
  if (syntaxTreeAvailable(view.state, doc.length)) {
    destroy(view)
    throw new Error("fixture unexpectedly has parse coverage at the caret")
  }
  const samples: number[] = []
  for (let index = 0; index < presses; index++) {
    const started = performance.now()
    if (toggleBold(view)) throw new Error("unavailable-tree benchmark unexpectedly edited the document")
    samples.push(performance.now() - started)
  }
  destroy(view)
  return percentileMs(samples, 0.95)
}

describe("formatting benchmarks (advisory)", () => {
  bench("inline bold semantic planner on a parsed 10k-line document", () => {
    const anchor = DOC_10K_SOFT_PARAGRAPH.indexOf("content")
    const view = mountEditor(DOC_10K_SOFT_PARAGRAPH, anchor, true, false)
    const state = view.state
    view.destroy()
    const parent = view.parent ?? view.dom.parentElement
    parent?.remove()
    const result = measurePlannerToggles(state, INLINE_PLAN_PRESSES)
    console.info(
      budgetLine("inline bold planner p95 10k", result.p95Ms, TYPING_P95_BUDGET_MS),
      `p50 ${result.p50Ms.toFixed(2)}ms`,
    )
  })

  bench("inline bold toggle in source mode on a parsed 10k-line document", () => {
    const anchor = DOC_10K_SOFT_PARAGRAPH.indexOf("content")
    const view = mountEditor(DOC_10K_SOFT_PARAGRAPH, anchor, true, false)
    try {
      const result = measureToggles(view, toggleBold, INLINE_SOURCE_PRESSES)
      console.info(
        budgetLine("inline bold p95 10k source", result.p95Ms, TYPING_P95_BUDGET_MS),
        `p50 ${result.p50Ms.toFixed(2)}ms`,
      )
    } finally {
      destroy(view)
    }
  })

  bench("inline bold toggle on a parsed 10k-paragraph live document", () => {
    const anchor = DOC_10K_PARAGRAPHS.indexOf("content")
    const view = mountLive(DOC_10K_PARAGRAPHS, anchor)
    try {
      const result = measureToggles(view, toggleBold, INLINE_LIVE_PRESSES)
      console.info(
        budgetLine("inline bold p95 10k paragraphs live", result.p95Ms, TYPING_P95_BUDGET_MS),
        `p50 ${result.p50Ms.toFixed(2)}ms`,
      )
    } finally {
      destroy(view)
    }
  })

  bench("inline bold toggle in one 10k-line live soft paragraph (worst case)", () => {
    const anchor = DOC_10K_SOFT_PARAGRAPH.indexOf("content")
    const view = mountLive(DOC_10K_SOFT_PARAGRAPH, anchor)
    try {
      const result = measureToggles(view, toggleBold, INLINE_LIVE_PRESSES)
      console.info(
        budgetLine("inline bold p95 10k soft paragraph live", result.p95Ms, TYPING_P95_BUDGET_MS),
        `p50 ${result.p50Ms.toFixed(2)}ms`,
      )
    } finally {
      destroy(view)
    }
  })

  bench("heading toggle on a 100-line live selection", () => {
    const doc = DOC_100_LINES
    const view = mountLive(doc, 0)
    view.dispatch({ selection: { anchor: 0, head: doc.length } })
    try {
      const command = (target: EditorView) => toggleHeading(2)(target)
      const result = measureToggles(view, command, BLOCK_PRESSES)
      console.info(
        budgetLine("heading p95 100-line selection", result.p95Ms, TYPING_P95_BUDGET_MS),
        `p50 ${result.p50Ms.toFixed(2)}ms`,
      )
    } finally {
      destroy(view)
    }
  })

  bench("code-block toggle on a 200-line live paragraph", () => {
    const doc = DOC_200_LINE_PARAGRAPH
    const anchor = Math.floor(doc.length / 2)
    const view = mountLive(doc, anchor)
    try {
      const result = measureToggles(view, toggleCodeBlock, BLOCK_PRESSES)
      console.info(
        budgetLine("code block p95 200-line paragraph", result.p95Ms, TYPING_P95_BUDGET_MS),
        `p50 ${result.p50Ms.toFixed(2)}ms`,
      )
    } finally {
      destroy(view)
    }
  })

  bench("inline bold rejection before the parse window reaches the caret", () => {
    const p95Ms = measureUnavailableBold(DOC_10K_PARAGRAPHS, 10_000)
    console.info(budgetLine("unavailable bold p95 fail-closed", p95Ms, TYPING_P95_BUDGET_MS))
  })
})
