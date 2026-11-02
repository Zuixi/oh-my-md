import "../src/styles.css"
import { EditorView } from "@codemirror/view"
import { StateEffect } from "@codemirror/state"
import {
  SAFE_MODE_RENDER_BUDGET_LINES,
  SAFE_PERFORMANCE_POLICY,
  STANDARD_PERFORMANCE_POLICY,
  getPerformancePolicyDiagnostics,
  setBlockRenderBudget,
  setEditorPerformancePolicy,
  setSafeModeRendering,
  type EditorPerformancePolicy,
} from "@omd/engine"
import { createEditor } from "../src/Editor"

type SpikeView = "A" | "B"
type PolicyName = "standard" | "safe"
type AuditMode = "global" | "local"

interface PolicySpikeDiagnostics {
  readonly policy: PolicyName | null
  readonly pendingInWindow: number
  readonly pendingRanges: number
  readonly decorationSpecs: number
  readonly transactionCount: number
  readonly domFingerprint: string
}

interface PolicySpike {
  readonly viewA: EditorView
  readonly viewB: EditorView
  readonly set: (view: SpikeView, policy: PolicyName) => void
  readonly diagnostics: (view: SpikeView) => PolicySpikeDiagnostics
  readonly waitViewportReady: (view: SpikeView) => Promise<number>
}

interface PolicyAuditResult {
  readonly syncMs: readonly number[]
  readonly viewportReadyMs: readonly number[]
  readonly longTasks: readonly number[]
}

interface PolicyAudit {
  readonly run: (options: { warmups: number; samples: number }) => Promise<PolicyAuditResult>
}

declare global {
  interface Window {
    __policySpike: PolicySpike
    __policySpikeErrors: string[]
    __policyAudit?: PolicyAudit
  }
}

const SPIKE_LINE_COUNT = 10_000
const READY_FRAMES = 2
const LONG_TASK_ENTRY = "longtask"

const POLICIES: Record<PolicyName, EditorPerformancePolicy> = {
  standard: STANDARD_PERFORMANCE_POLICY,
  safe: SAFE_PERFORMANCE_POLICY,
}

const GLOBAL_RECONFIGURE = StateEffect.appendConfig.of([])

const params = new URLSearchParams(location.search)
const auditMode = params.get("audit")
const transactions: Record<SpikeView, number> = { A: 0, B: 0 }

function spikeDocument(): string {
  const lines: string[] = []
  for (let index = 0; index < SPIKE_LINE_COUNT; index += 1) {
    switch (index % 10) {
      case 0:
        lines.push(`## Section ${index}`)
        break
      case 1:
        lines.push("")
        break
      case 2:
        lines.push(`- item ${index} with **bold** and \`code\``)
        break
      case 3:
        lines.push(`> quote ${index} with a [link](https://example.com/${index})`)
        break
      default:
        lines.push(
          `Paragraph ${index} keeps **bold** words, \`inline code\`, and a [link](https://example.com/${index}) so live decorations stay dense.`,
        )
        break
    }
  }
  return lines.join("\n")
}

const SPIKE_DOC = spikeDocument()

window.__policySpikeErrors = []

function mountSpikeEditor(host: HTMLElement, tabId: number): EditorView {
  const view = createEditor(host, {
    doc: SPIKE_DOC,
    tabId,
    documentId: tabId,
    getDocPath: () => null,
    getDocumentId: () => tabId,
    onDocumentUpdate: () => {},
    onError: message => { window.__policySpikeErrors.push(message) },
  })
  view.dispatch({ selection: { anchor: 0 } })
  return view
}

function countTransactions(view: EditorView, key: SpikeView): void {
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of(() => { transactions[key] += 1 }),
    ),
  })
  transactions[key] = 0
}

function domFingerprint(view: EditorView): string {
  const content = view.contentDOM
  const markup = content.innerHTML
  let hash = 0
  for (let index = 0; index < markup.length; index += 1) {
    hash = (hash * 31 + markup.charCodeAt(index)) | 0
  }
  return `${content.childElementCount}:${hash}`
}

function policyName(policy: EditorPerformancePolicy | null): PolicyName | null {
  if (policy === null) return null
  return policy.windowLiveDecorations ? "safe" : "standard"
}

function viewOf(view: SpikeView): EditorView {
  return view === "A" ? viewA : viewB
}

function diagnostics(view: SpikeView): PolicySpikeDiagnostics {
  const editor = viewOf(view)
  const engine = getPerformancePolicyDiagnostics(editor)
  return {
    policy: policyName(engine.policy),
    pendingInWindow: engine.pendingInBuildWindow,
    pendingRanges: engine.pendingRanges,
    decorationSpecs: engine.decorationSpecs,
    transactionCount: transactions[view],
    domFingerprint: domFingerprint(editor),
  }
}

function setPolicy(view: SpikeView, policy: PolicyName): void {
  setEditorPerformancePolicy(viewOf(view), POLICIES[policy])
}

function waitViewportReady(view: SpikeView): Promise<number> {
  const started = performance.now()
  return new Promise<number>(resolve => {
    let readyFrames = 0
    const frame = () => {
      readyFrames = diagnostics(view).pendingInWindow === 0 ? readyFrames + 1 : 0
      if (readyFrames >= READY_FRAMES) {
        resolve(performance.now() - started)
        return
      }
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
}

function reconfigureForAudit(mode: AuditMode, view: EditorView, policy: PolicyName): number {
  const started = performance.now()
  if (mode === "global") {
    setSafeModeRendering(policy === "safe")
    setBlockRenderBudget(policy === "safe" ? SAFE_MODE_RENDER_BUDGET_LINES : Infinity)
    view.dispatch({ effects: GLOBAL_RECONFIGURE })
  } else {
    setEditorPerformancePolicy(view, POLICIES[policy])
  }
  return performance.now() - started
}

function createAudit(mode: AuditMode, view: EditorView): PolicyAudit {
  const longTasks: number[] = []
  const observer = typeof PerformanceObserver === "function"
    ? new PerformanceObserver(list => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration)
    })
    : null
  observer?.observe({ entryTypes: [LONG_TASK_ENTRY] })

  const switchPolicy = (policy: PolicyName) => reconfigureForAudit(mode, view, policy)

  return {
    run: async options => {
      const syncMs: number[] = []
      const viewportReadyMs: number[] = []
      for (let index = 0; index < options.warmups; index += 1) {
        switchPolicy(index % 2 === 0 ? "safe" : "standard")
        await waitViewportReady("A")
      }
      longTasks.length = 0
      for (let index = 0; index < options.samples; index += 1) {
        syncMs.push(switchPolicy(index % 2 === 0 ? "safe" : "standard"))
        viewportReadyMs.push(await waitViewportReady("A"))
      }
      return { syncMs, viewportReadyMs, longTasks: [...longTasks] }
    },
  }
}

setSafeModeRendering(false)
setBlockRenderBudget(Infinity)

const hostA = document.getElementById("host-a")
const hostB = document.getElementById("host-b")
if (!hostA || !hostB) throw new Error("policy spike hosts are missing")

const viewA = mountSpikeEditor(hostA, 1)
const viewB = mountSpikeEditor(hostB, 2)
countTransactions(viewA, "A")
countTransactions(viewB, "B")

if (auditMode === null) {
  setPolicy("A", "standard")
  setPolicy("B", "safe")
} else if (auditMode === "local") {
  setPolicy("A", "standard")
}

window.__policySpike = {
  viewA,
  viewB,
  set: setPolicy,
  diagnostics,
  waitViewportReady,
}

if (auditMode === "global" || auditMode === "local") {
  window.__policyAudit = createAudit(auditMode, viewA)
}
