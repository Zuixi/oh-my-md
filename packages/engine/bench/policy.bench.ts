import { bench, describe } from "vitest"
import { EditorState, StateEffect } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { forceParsing } from "@codemirror/language"
import {
  editorExtensions,
  SAFE_MODE_RENDER_BUDGET_LINES,
  SAFE_PERFORMANCE_POLICY,
  setBlockRenderBudget,
  setEditorPerformancePolicy,
  setSafeModeRendering,
  STANDARD_PERFORMANCE_POLICY,
} from "../src/index"
import { drainPendingLiveBuild, livePreviewField } from "../src/decorations/build"
import { getPerformancePolicyDiagnostics } from "../src/performancePolicyDiagnostics"
import { budgetLine } from "./measure"
import { makeBenchmarkDoc } from "./generate"

export const POLICY_RECONFIG_P95_BUDGET_MS = 16
export const POLICY_RECONFIG_SAMPLES = 100
export const POLICY_RECONFIG_WARMUP = 10

const RECONFIGURE = StateEffect.appendConfig.of([])
const DOC = makeBenchmarkDoc(10_000)

interface ReconfigLatency {
  p50Ms: number
  p95Ms: number
  peakMs: number
  samples: number
}

interface ParitySummary {
  bytes: number
  decorations: number
  pending: number
  specs: string[]
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

function latency(samples: number[]): ReconfigLatency {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    peakMs: sorted[sorted.length - 1],
    samples: samples.length,
  }
}

function latencyLine(name: string, r: ReconfigLatency): string {
  return `${name}: p50 ${r.p50Ms.toFixed(2)}ms / p95 ${r.p95Ms.toFixed(2)}ms / peak ${r.peakMs.toFixed(2)}ms (${r.samples} samples)`
}

function mountDocument(): { view: EditorView; cleanup: () => void } {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({ doc: DOC, extensions: editorExtensions() }),
    parent,
  })
  forceParsing(view, view.viewport.to + 100_000, 60_000)
  drainPendingLiveBuild(view)
  return {
    view,
    cleanup: () => {
      view.destroy()
      parent.remove()
    },
  }
}

function applyLegacyPolicy(windowed: boolean): void {
  setSafeModeRendering(windowed)
  setBlockRenderBudget(windowed ? SAFE_MODE_RENDER_BUDGET_LINES : Infinity)
}

function measureLocalReconfiguration(view: EditorView): ReconfigLatency {
  const samples: number[] = []
  for (let i = 0; i < POLICY_RECONFIG_WARMUP + POLICY_RECONFIG_SAMPLES; i++) {
    const started = performance.now()
    setEditorPerformancePolicy(
      view,
      i % 2 === 0 ? SAFE_PERFORMANCE_POLICY : STANDARD_PERFORMANCE_POLICY,
    )
    const elapsed = performance.now() - started
    if (i >= POLICY_RECONFIG_WARMUP) samples.push(elapsed)
  }
  return latency(samples)
}

function measureLegacyReconfiguration(view: EditorView): ReconfigLatency {
  const samples: number[] = []
  for (let i = 0; i < POLICY_RECONFIG_WARMUP + POLICY_RECONFIG_SAMPLES; i++) {
    const started = performance.now()
    applyLegacyPolicy(i % 2 === 0)
    view.dispatch({ effects: RECONFIGURE })
    const elapsed = performance.now() - started
    if (i >= POLICY_RECONFIG_WARMUP) samples.push(elapsed)
  }
  return latency(samples)
}

function summarize(view: EditorView): ParitySummary {
  const live = view.state.field(livePreviewField)
  return {
    bytes: new TextEncoder().encode(view.state.doc.toString()).length,
    decorations: live.specs.length,
    pending: live.pending.length,
    specs: live.specs.map(spec => `${spec.tag}:${spec.from}:${spec.to}`).sort(),
  }
}

function paritySummary(control: boolean): ParitySummary {
  setSafeModeRendering(false)
  setBlockRenderBudget(Infinity)
  const { view, cleanup } = mountDocument()
  if (!control) setEditorPerformancePolicy(view, STANDARD_PERFORMANCE_POLICY)
  drainPendingLiveBuild(view)
  const summary = summarize(view)
  const diagnostics = getPerformancePolicyDiagnostics(view)
  cleanup()
  if (diagnostics.pendingRanges !== summary.pending) {
    throw new Error("diagnostics pending mismatch: " + String(diagnostics))
  }
  if (diagnostics.decorationSpecs !== summary.decorations) {
    throw new Error("diagnostics spec mismatch: " + String(diagnostics))
  }
  return summary
}

function expectParity(control: ParitySummary, local: ParitySummary): void {
  if (control.bytes !== local.bytes) {
    throw new Error(`source bytes diverged: control ${control.bytes} vs local ${local.bytes}`)
  }
  if (control.specs.length !== local.specs.length) {
    throw new Error(
      `decoration count diverged: control ${control.specs.length} vs local ${local.specs.length}`,
    )
  }
  for (let i = 0; i < control.specs.length; i++) {
    if (control.specs[i] !== local.specs[i]) {
      throw new Error(`decoration key ${i} diverged: ${control.specs[i]} vs ${local.specs[i]}`)
    }
  }
}

describe("per-editor performance policy reconfiguration (10k lines)", () => {
  bench("local standard<->safe reconfiguration", () => {
    setSafeModeRendering(false)
    setBlockRenderBudget(Infinity)
    const { view, cleanup } = mountDocument()
    const result = measureLocalReconfiguration(view)
    cleanup()
    console.info(budgetLine("policy reconfig local", result.p95Ms, POLICY_RECONFIG_P95_BUDGET_MS))
    console.info(latencyLine("policy reconfig local", result))
    if (result.p95Ms > POLICY_RECONFIG_P95_BUDGET_MS) {
      throw new Error(
        `local policy reconfiguration p95 ${result.p95Ms.toFixed(2)}ms exceeds ${POLICY_RECONFIG_P95_BUDGET_MS}ms`,
      )
    }
  })

  bench("legacy global control reconfiguration", () => {
    const { view, cleanup } = mountDocument()
    const result = measureLegacyReconfiguration(view)
    cleanup()
    applyLegacyPolicy(false)
    console.info(budgetLine("policy reconfig legacy", result.p95Ms, POLICY_RECONFIG_P95_BUDGET_MS))
    console.info(latencyLine("policy reconfig legacy", result))
  })

  bench("standard parity after drain (source bytes + decoration keys)", () => {
    const control = paritySummary(true)
    const local = paritySummary(false)
    expectParity(control, local)
    console.info(
      `standard parity: ${control.bytes} bytes, ${control.decorations} decorations, ${control.pending} pending — exact match`,
    )
  })
})
