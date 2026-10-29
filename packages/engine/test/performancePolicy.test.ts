import { afterEach, describe, expect, it, vi } from "vitest"
import {
  EditorState,
  RangeSetBuilder,
  StateField,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state"
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view"
import { history, redoDepth, undo, undoDepth } from "@codemirror/commands"
import { forceParsing } from "@codemirror/language"
import {
  editorExtensions,
  editorPerformancePolicy,
  LIVE_PRUNE_MARGIN_CHARS,
  LIVE_WINDOW_CHARS,
  performancePolicyExtension,
  SAFE_MODE_RENDER_BUDGET_LINES,
  SAFE_PERFORMANCE_POLICY,
  samePerformancePolicy,
  setBlockRenderBudget,
  setEditorPerformancePolicy,
  setSafeModeRendering,
  STANDARD_PERFORMANCE_POLICY,
  type EditorPerformancePolicy,
} from "../src/index"
import { blockRenderBudgetFor } from "../src/decorations/renderBudget"
import { BlockWidget } from "../src/decorations/blockWidget"
import {
  drainPendingLiveBuild,
  livePreviewField,
  livePruneOutside,
} from "../src/decorations/build"
import { LIVE_BUILD_SLICE_MS } from "../src/decorations/buildDriver"
import { getPerformancePolicyDiagnostics } from "../src/performancePolicyDiagnostics"

class MarkerWidget extends BlockWidget {
  static readonly rendered: MarkerWidget[] = []
  protected get cssClass() { return "omd-marker" }
  protected renderInto(el: HTMLElement) { MarkerWidget.rendered.push(this); el.textContent = "rendered" }
}

const LIMITED_FOUR_LINES: EditorPerformancePolicy = {
  windowLiveDecorations: false,
  blockRenderBudgetLines: 4,
}

function lineStartOf(doc: string, line: number): number {
  return line === 0 ? 0 : doc.split("\n").slice(0, line).join("\n").length + 1
}

function markerDoc(prefix: string, blocks: number): string {
  const lines: string[] = []
  for (let i = 0; i < blocks; i++) lines.push(`${prefix} block ${i}`, "", "", "")
  return lines.join("\n")
}

function buildMarkers(doc: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  let from = 0
  for (const line of doc.split("\n")) {
    if (/^[A-Z] block \d+$/.test(line)) {
      builder.add(from, from + line.length, Decoration.replace({
        widget: new MarkerWidget(line, from),
        block: true,
      }))
    }
    from += line.length + 1
  }
  return builder.finish()
}

const markerField = StateField.define<DecorationSet>({
  create: state => buildMarkers(state.doc.toString()),
  update: (deco, tr) => tr.docChanged ? buildMarkers(tr.state.doc.toString()) : deco,
  provide: field => EditorView.decorations.from(field),
})

function mountView(doc: string, extensions: Extension[] = [editorExtensions()], anchor = 0): EditorView {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  return new EditorView({
    state: EditorState.create({ doc, selection: { anchor }, extensions }),
    parent,
  })
}

function mountMarkerView(
  policy: EditorPerformancePolicy | null,
  prefix: string,
  blocks: number,
  cursorLine = 0,
): EditorView {
  const view = mountView("", [editorExtensions(), markerField])
  if (policy) setEditorPerformancePolicy(view, policy)
  const doc = markerDoc(prefix, blocks)
  view.dispatch({ changes: { from: 0, insert: doc }, selection: { anchor: lineStartOf(doc, cursorLine) } })
  return view
}

function rendered(prefix: string): string[] {
  return MarkerWidget.rendered
    .filter(widget => widget.src.startsWith(`${prefix} `))
    .map(widget => widget.src)
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

const specKeys = (view: EditorView) =>
  view.state.field(livePreviewField).specs
    .map(spec => `${spec.tag}:${spec.from}:${spec.to}`)
    .sort()

const pendingOf = (view: EditorView) =>
  view.state.field(livePreviewField).pending.map(range => ({ ...range }))

const PARITY_BLOCKS = 1600
const PARITY_DOC = Array.from({ length: PARITY_BLOCKS }, (_, i) =>
  `P block ${i}\n\n\n${"x".repeat(180)} **bold ${i}**`).join("\n")

function setVisible(view: EditorView, from: number, to: number) {
  Object.defineProperty(view, "visibleRanges", {
    configurable: true,
    value: Object.freeze([{ from, to }]),
  })
}

function stepClock() {
  let now = 0
  return vi.spyOn(performance, "now").mockImplementation(() => (now += LIVE_BUILD_SLICE_MS))
}

function recordPrunes(view: EditorView) {
  const original = view.dispatch.bind(view)
  const prunes: { from: number; to: number }[][] = []
  vi.spyOn(view, "dispatch").mockImplementation((...specs: TransactionSpec[]) => {
    for (const spec of specs) {
      const effects = spec.effects ?? []
      for (const effect of Array.isArray(effects) ? effects : [effects]) {
        if (effect.is(livePruneOutside)) {
          prunes.push(effect.value.map((region: { from: number; to: number }) => ({ ...region })))
        }
      }
    }
    original(...specs)
  })
  return prunes
}

const renderedBlocks = () => MarkerWidget.rendered.map(widget => `${widget.src}@${widget.pos}`)

interface WindowCheckpoint {
  specs: string[]
  pending: { from: number; to: number }[]
  prunes: { from: number; to: number }[][]
  pendingInBuildWindow: number
  decorationSpecs: number
}

interface WindowRun {
  bytes: number
  doc: string
  policy: EditorPerformancePolicy | null
  rendered: string[]
  checkpoints: WindowCheckpoint[]
}

async function windowedRun(policy: EditorPerformancePolicy | null): Promise<WindowRun> {
  vi.useFakeTimers()
  stepClock()
  MarkerWidget.rendered.length = 0
  if (policy === null) {
    setSafeModeRendering(true)
    setBlockRenderBudget(SAFE_MODE_RENDER_BUDGET_LINES)
  } else {
    setSafeModeRendering(false)
    setBlockRenderBudget(Infinity)
  }
  const view = mountView(PARITY_DOC, [editorExtensions(), markerField])
  if (policy) setEditorPerformancePolicy(view, policy)
  const prunes = recordPrunes(view)
  const checkpoints: WindowCheckpoint[] = []
  for (const [from, to] of [[0, 30], [PARITY_DOC.length - 30, PARITY_DOC.length]]) {
    setVisible(view, from, to)
    view.dispatch({ selection: { anchor: from === 0 ? 1 : 0 } })
    await Promise.resolve()
    for (let guard = 0; guard < 6; guard++) vi.advanceTimersToNextTimer()
    const diagnostics = getPerformancePolicyDiagnostics(view)
    checkpoints.push({
      specs: specKeys(view),
      pending: pendingOf(view),
      prunes: prunes.map(regions => regions.map(region => ({ ...region }))),
      pendingInBuildWindow: diagnostics.pendingInBuildWindow,
      decorationSpecs: diagnostics.decorationSpecs,
    })
  }
  vi.useRealTimers()
  await flush()
  const run: WindowRun = {
    bytes: new TextEncoder().encode(view.state.doc.toString()).length,
    doc: view.state.doc.toString(),
    policy: editorPerformancePolicy(view.state),
    rendered: renderedBlocks(),
    checkpoints,
  }
  view.destroy()
  setSafeModeRendering(false)
  setBlockRenderBudget(Infinity)
  return run
}

interface StandardRun {
  bytes: number
  doc: string
  specs: string[]
  pending: { from: number; to: number }[]
  policy: EditorPerformancePolicy | null
  pendingInBuildWindow: number
  decorationSpecs: number
}

function standardRun(control: boolean): StandardRun {
  setSafeModeRendering(false)
  setBlockRenderBudget(Infinity)
  const view = mountView(PARITY_DOC, [editorExtensions(), markerField])
  if (!control) setEditorPerformancePolicy(view, STANDARD_PERFORMANCE_POLICY)
  forceParsing(view, PARITY_DOC.length, 60_000)
  drainPendingLiveBuild(view)
  const diagnostics = getPerformancePolicyDiagnostics(view)
  const run: StandardRun = {
    bytes: new TextEncoder().encode(view.state.doc.toString()).length,
    doc: view.state.doc.toString(),
    specs: specKeys(view),
    pending: pendingOf(view),
    policy: diagnostics.policy,
    pendingInBuildWindow: diagnostics.pendingInBuildWindow,
    decorationSpecs: diagnostics.decorationSpecs,
  }
  view.destroy()
  return run
}

describe("editor performance policy", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    setBlockRenderBudget(Infinity)
    setSafeModeRendering(false)
    MarkerWidget.rendered.length = 0
    document.body.replaceChildren()
  })

  it("exposes the exact standard and safe constants", () => {
    expect(SAFE_MODE_RENDER_BUDGET_LINES).toBe(60)
    expect(STANDARD_PERFORMANCE_POLICY).toEqual({
      windowLiveDecorations: false,
      blockRenderBudgetLines: null,
    })
    expect(SAFE_PERFORMANCE_POLICY).toEqual({
      windowLiveDecorations: true,
      blockRenderBudgetLines: 60,
    })
  })

  it("rejects negative and non-finite budgets without reconfiguring the view", () => {
    const view = mountView("stable")
    for (const budget of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const invalid = { windowLiveDecorations: false, blockRenderBudgetLines: budget }
      expect(() => setEditorPerformancePolicy(view, invalid)).toThrow(RangeError)
      expect(() => performancePolicyExtension(invalid)).toThrow(RangeError)
    }
    expect(editorPerformancePolicy(view.state)).toBe(null)
    expect(view.state.doc.toString()).toBe("stable")

    setEditorPerformancePolicy(view, { windowLiveDecorations: false, blockRenderBudgetLines: 0 })
    expect(editorPerformancePolicy(view.state)).toEqual({
      windowLiveDecorations: false,
      blockRenderBudgetLines: 0,
    })
    view.destroy()
  })

  it("holds independent policies per state and per view", () => {
    const standardState = EditorState.create({
      extensions: [performancePolicyExtension(STANDARD_PERFORMANCE_POLICY)],
    })
    const safeState = EditorState.create({
      extensions: [performancePolicyExtension(SAFE_PERFORMANCE_POLICY)],
    })
    const legacyState = EditorState.create({ extensions: [performancePolicyExtension(null)] })

    expect(editorPerformancePolicy(standardState)).toEqual(STANDARD_PERFORMANCE_POLICY)
    expect(editorPerformancePolicy(safeState)).toEqual(SAFE_PERFORMANCE_POLICY)
    expect(editorPerformancePolicy(legacyState)).toBe(null)
    expect(samePerformancePolicy(SAFE_PERFORMANCE_POLICY, SAFE_PERFORMANCE_POLICY)).toBe(true)
    expect(samePerformancePolicy(SAFE_PERFORMANCE_POLICY, STANDARD_PERFORMANCE_POLICY)).toBe(false)
    expect(samePerformancePolicy(null, null)).toBe(true)
    expect(samePerformancePolicy(null, STANDARD_PERFORMANCE_POLICY)).toBe(false)

    const viewA = mountView("a")
    const viewB = mountView("b")
    expect(editorPerformancePolicy(viewA.state)).toBe(null)
    expect(editorPerformancePolicy(viewB.state)).toBe(null)

    setEditorPerformancePolicy(viewA, STANDARD_PERFORMANCE_POLICY)
    setEditorPerformancePolicy(viewB, SAFE_PERFORMANCE_POLICY)
    expect(editorPerformancePolicy(viewA.state)).toEqual(STANDARD_PERFORMANCE_POLICY)
    expect(editorPerformancePolicy(viewB.state)).toEqual(SAFE_PERFORMANCE_POLICY)

    const stateA = viewA.state
    for (let i = 0; i < 10; i++) setEditorPerformancePolicy(viewB, i % 2 === 0 ? STANDARD_PERFORMANCE_POLICY : SAFE_PERFORMANCE_POLICY)
    expect(viewA.state).toBe(stateA)
    expect(editorPerformancePolicy(viewA.state)).toEqual(STANDARD_PERFORMANCE_POLICY)
    viewA.destroy()
    viewB.destroy()
  })

  it("preserves document, selection, and history while reconfiguring", () => {
    const view = mountView("alpha beta", [history(), editorExtensions()], 3)
    view.dispatch({ changes: { from: 0, insert: "x" } })
    const doc = view.state.doc.toString()
    const selection = view.state.selection
    const undoBefore = undoDepth(view.state)
    const redoBefore = redoDepth(view.state)
    expect(undoBefore).toBe(1)

    for (let i = 0; i < 10; i++) {
      setEditorPerformancePolicy(view, i % 2 === 0 ? SAFE_PERFORMANCE_POLICY : STANDARD_PERFORMANCE_POLICY)
    }

    expect(view.state.doc.toString()).toBe(doc)
    expect(view.state.selection.eq(selection)).toBe(true)
    expect(undoDepth(view.state)).toBe(undoBefore)
    expect(redoDepth(view.state)).toBe(redoBefore)
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe("alpha beta")
    view.destroy()
  })

  it("keeps view and DOM identity across 100 standard/safe alternations", () => {
    const view = mountView("stable document", [history(), editorExtensions()])
    const dom = view.dom
    const contentDOM = view.contentDOM
    const scrollDOM = view.scrollDOM
    const doc = view.state.doc

    for (let i = 0; i < 100; i++) {
      setEditorPerformancePolicy(view, i % 2 === 0 ? SAFE_PERFORMANCE_POLICY : STANDARD_PERFORMANCE_POLICY)
    }

    expect(view.dom).toBe(dom)
    expect(view.contentDOM).toBe(contentDOM)
    expect(view.scrollDOM).toBe(scrollDOM)
    expect(dom.isConnected).toBe(true)
    expect(view.state.doc).toBe(doc)
    expect(editorPerformancePolicy(view.state)).toEqual(STANDARD_PERFORMANCE_POLICY)
    expect(undoDepth(view.state)).toBe(0)
    view.destroy()
  })

  it("renders an unlimited local view and defers a four-line limited one", async () => {
    const unlimited = mountMarkerView(STANDARD_PERFORMANCE_POLICY, "A", 6)
    const limited = mountMarkerView(LIMITED_FOUR_LINES, "B", 6)
    await flush()

    expect(rendered("A")).toEqual([
      "A block 0", "A block 1", "A block 2", "A block 3", "A block 4", "A block 5",
    ])
    expect(rendered("B")).toEqual(["B block 0", "B block 1"])

    setEditorPerformancePolicy(limited, STANDARD_PERFORMANCE_POLICY)
    await flush()
    expect(rendered("B")).toHaveLength(6)
    expect(rendered("A")).toHaveLength(6)
    unlimited.destroy()
    limited.destroy()
  })

  it("flushes deferred renders only for the reconfigured view", async () => {
    const viewA = mountMarkerView(LIMITED_FOUR_LINES, "A", 6)
    const viewB = mountMarkerView(LIMITED_FOUR_LINES, "B", 6)
    await flush()
    expect(rendered("A")).toHaveLength(2)
    expect(rendered("B")).toHaveLength(2)
    const stateA = viewA.state

    setEditorPerformancePolicy(viewB, STANDARD_PERFORMANCE_POLICY)
    await flush()

    expect(viewA.state).toBe(stateA)
    expect(editorPerformancePolicy(viewA.state)).toEqual(LIMITED_FOUR_LINES)
    expect(rendered("A")).toHaveLength(2)
    expect(rendered("B")).toHaveLength(6)
    viewA.destroy()
    viewB.destroy()
  })

  it("matches the legacy global control and resolves the budget per state", async () => {
    setBlockRenderBudget(4)
    const control = mountMarkerView(null, "G", 6)
    await flush()
    const controlRendered = rendered("G")
    expect(controlRendered).toEqual(["G block 0", "G block 1"])
    control.destroy()

    setBlockRenderBudget(Infinity)
    MarkerWidget.rendered.length = 0
    const local = mountMarkerView(LIMITED_FOUR_LINES, "G", 6)
    await flush()
    expect(rendered("G")).toEqual(controlRendered)
    expect(blockRenderBudgetFor(local.state)).toBe(4)

    const legacyState = EditorState.create({ extensions: [performancePolicyExtension(null)] })
    expect(blockRenderBudgetFor(legacyState)).toBe(null)
    setBlockRenderBudget(7)
    expect(blockRenderBudgetFor(legacyState)).toBe(7)
    expect(blockRenderBudgetFor(local.state)).toBe(4)
    local.destroy()
  })

  it("matches the global standard control byte-for-byte after a complete drain", () => {
    const control = standardRun(true)
    const local = standardRun(false)

    expect(control.pending).toEqual([])
    expect(control.specs.length).toBeGreaterThan(0)
    expect(local.doc).toBe(control.doc)
    expect(local.bytes).toBe(control.bytes)
    expect(local.specs).toEqual(control.specs)
    expect(local.pending).toEqual(control.pending)
    expect(local.policy).toEqual(STANDARD_PERFORMANCE_POLICY)
    expect(control.policy).toBe(null)
    expect(local.decorationSpecs).toBe(control.decorationSpecs)
    expect(local.decorationSpecs).toBe(control.specs.length)
    expect(local.pendingInBuildWindow).toBe(0)
  })

  it("matches the global safe control at matched windows and scheduler checkpoints", async () => {
    expect(PARITY_DOC.length).toBeGreaterThan(LIVE_WINDOW_CHARS + LIVE_PRUNE_MARGIN_CHARS)
    const control = await windowedRun(null)
    const local = await windowedRun(SAFE_PERFORMANCE_POLICY)

    expect(control.checkpoints).toHaveLength(2)
    expect(control.checkpoints[0].specs.length).toBeGreaterThan(0)
    expect(control.checkpoints[0].pendingInBuildWindow).toBeGreaterThan(0)
    expect(control.checkpoints[0].prunes).toEqual([])
    expect(control.checkpoints[1].prunes).toHaveLength(1)
    expect(control.checkpoints[1].prunes[0].length).toBe(1)
    expect(control.checkpoints[1].prunes[0][0].from).toBeGreaterThan(0)
    expect(control.checkpoints[1].pending.length).toBeGreaterThan(0)
    expect(control.rendered.length).toBeGreaterThan(0)

    expect(local.doc).toBe(control.doc)
    expect(local.bytes).toBe(control.bytes)
    expect(local.rendered).toEqual(control.rendered)
    expect(local.checkpoints).toEqual(control.checkpoints)
    expect(local.policy).toEqual(SAFE_PERFORMANCE_POLICY)
    expect(control.policy).toBe(null)
  })
})
