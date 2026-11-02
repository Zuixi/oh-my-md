import type { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import type { BlockWidget } from "./blockWidget"
import { editorPerformancePolicy, samePerformancePolicy } from "../performancePolicy"

// 安全模式渲染预算（Spec 05“视口 ±1 屏”的可测映射）：块 widget 的昂贵渲染
// 只在「距光标行 ≤ 预算」或「已进入 CM 视口估算」时启动；其余挂起，由
// renderBudgetFlush 在 doc/selection/viewport/策略变化时重查。默认 Infinity 保持
// 现行为。全局值是旧控制路径与回退，按视图的显式策略优先。
let budgetLines = Infinity

export function setBlockRenderBudget(lines: number): void {
  budgetLines = lines
}

export function blockRenderBudget(): number {
  return budgetLines
}

export function blockRenderBudgetFor(state: EditorState): number | null {
  return resolvedBudget(state)
}

function resolvedBudget(state: EditorState | undefined): number | null {
  const policy = state && typeof state.facet === "function" ? editorPerformancePolicy(state) : null
  if (policy) return policy.blockRenderBudgetLines
  return Number.isFinite(budgetLines) ? budgetLines : null
}

export function withinRenderBudget(view: EditorView, pos: number): boolean {
  const budget = resolvedBudget(view.state)
  if (budget === null) return true
  const doc = view.state.doc
  const cursorLine = doc.lineAt(view.state.selection.main.head).number
  const posLine = doc.lineAt(Math.min(Math.max(pos, 0), doc.length)).number
  if (Math.abs(posLine - cursorLine) <= budget) return true
  // 视口判定仅在真实布局下生效：无布局环境（headless 测试）viewport 恒为整文档，
  // 会把预算短路成“全部立即渲染”，光标距离就成了唯一确定性信号。clientHeight 0
  // 是可靠的“无布局”信号；真实浏览器中编辑器可见时恒 > 0。
  if (view.dom?.clientHeight === 0) return false
  return view.visibleRanges.some(range => pos >= range.from && pos <= range.to)
}

export interface PendingRender {
  widget: BlockWidget
  view: EditorView
  pos: number
  start: () => void
}

const pending: Set<PendingRender> = new Set()

export function deferBlockRender(entry: PendingRender): void {
  pending.add(entry)
}

export function dropPendingBlockRender(entry: PendingRender): void {
  pending.delete(entry)
}

export function flushDeferredBlockRenders(): number {
  let started = 0
  for (const entry of [...pending]) {
    // widget 已销毁，或所属 view 已拆除（CM 不保证 destroy 回调逐 widget 触发）
    if (!entry.widget.isActive() || !entry.view.dom.isConnected) {
      pending.delete(entry)
      continue
    }
    if (withinRenderBudget(entry.view, entry.pos)) {
      pending.delete(entry)
      entry.start()
      started++
    }
  }
  return started
}

// 挂进 editorExtensions()：光标/文档/视口变化、或本视图策略被重新配置时重查挂起块。
export const renderBudgetFlush = () => EditorView.updateListener.of(update => {
  const policyChanged = !samePerformancePolicy(
    editorPerformancePolicy(update.startState),
    editorPerformancePolicy(update.state),
  )
  if (update.docChanged || update.selectionSet || update.viewportChanged || policyChanged) {
    flushDeferredBlockRenders()
  }
})
