import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { forceParsing } from "@codemirror/language"
import { editorExtensions } from "../src/index"
import { buildLiveDecorations } from "../src/decorations/build"
import { setLivePreview } from "../src/modes/livePreview"
import { documentStats } from "../src/stats"

export const TYPING_P95_BUDGET_MS = 16
export const STATS_BUDGET_MS = 8

export interface TypingLatency { p50Ms: number; p95Ms: number; samples: number }

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

function baseState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: editorExtensions() })
}

/** 在文档中部连续逐键输入，度量每笔事务耗时（含增量重解析+装饰更新）。
 *
 * tree 口径（Spec 05a §10.4）：
 * - "steady"（默认）= 生产稳态：只解析到 viewport.to + 100000（镜像 CM idle worker
 *   的 Work.MaxParseAhead），大文档永远保持部分树 —— 实测 10MB/38 万行逐键 p95 1.5ms。
 * - "complete" = worst-case 上限参考：全树解析后每键的 fragment 重启随文档规模增长
 *   （1MB=23.5ms、10MB=70.6ms）。生产代码禁止制造该状态
 *   （apps/desktop/test/crossLayerNoFullTree.test.ts 护栏）。 */
export function measureTyping(
  doc: string,
  opts: { keystrokes?: number; mode?: "live" | "source"; tree?: "steady" | "complete" } = {},
): TypingLatency {
  const count = opts.keystrokes ?? 200
  const mode = opts.mode ?? "live"
  const tree = opts.tree ?? "steady"
  let state = baseState(doc)
  if (mode === "source") state = state.update(setLivePreview(false)).state
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({ state, parent })
  forceParsing(view, tree === "complete" ? doc.length : view.viewport.to + 100000, 60000)
  let pos = Math.floor(doc.length / 2)
  const samples: number[] = []
  for (let i = 0; i < count; i++) {
    const t0 = performance.now()
    view.dispatch({ changes: { from: pos, insert: "字" }, selection: { anchor: pos + 1 } })
    samples.push(performance.now() - t0)
    pos += 1
  }
  view.destroy()
  parent.remove()
  const sorted = [...samples].sort((a, b) => a - b)
  return { p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95), samples: count }
}

/** 冷启动：建 state + 挂 view + 强制整树解析的总耗时。 */
export function measureColdParseMs(doc: string): number {
  const t0 = performance.now()
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({ state: baseState(doc), parent })
  forceParsing(view, doc.length, 60000)
  const ms = performance.now() - t0
  view.destroy()
  parent.remove()
  return ms
}

/** 完整树状态下整文档装饰重建（buildLiveDecorations）耗时。 */
export function measureDecoRebuildMs(state: EditorState): number {
  const t0 = performance.now()
  buildLiveDecorations(state)
  return performance.now() - t0
}

export function measureStatsMs(doc: string): number {
  const t0 = performance.now()
  documentStats(doc)
  return performance.now() - t0
}

export function budgetLine(name: string, ms: number, budgetMs: number): string {
  const verdict = ms <= budgetMs ? "OK" : `OVER BUDGET (> ${budgetMs}ms)`
  return `${name}: ${ms.toFixed(2)}ms — ${verdict}`
}

// 供 bench 用例拿到"完整树"状态：live 模式（装饰重建在 live 下才有意义）。
export function fullyParsedLiveState(doc: string): EditorState {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({ state: baseState(doc), parent })
  forceParsing(view, doc.length, 60000)
  const state = view.state
  view.destroy()
  parent.remove()
  return state
}
