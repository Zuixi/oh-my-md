import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view"
import { livePreviewField } from "./build"
import type { BlockWidget } from "./blockWidget"

// 存活块 widget 实例 → wrap DOM（BlockWidget.toDOM 注册 / destroy 注销）。
// 覆盖判定用 livePreviewField.specs 的 from/to（构造期 pos 会随编辑漂移，
// posAtDOM 在无布局环境不可靠）；注册表只负责按实例找 DOM。
const liveWraps = new Map<BlockWidget, HTMLElement>()
const liveRanges = new Map<HTMLElement, { from: number; to: number }>()

export function registerBlockWidget(widget: BlockWidget, dom: HTMLElement) {
  liveWraps.set(widget, dom)
}

export function unregisterBlockWidget(widget: BlockWidget) {
  const dom = liveWraps.get(widget)
  if (dom) liveRanges.delete(dom)
  liveWraps.delete(widget)
}

export function blockWidgetRange(widget: BlockWidget, view: EditorView, dom?: HTMLElement): { from: number; to: number } | null {
  if (dom) {
    const range = liveRanges.get(dom)
    if (range) return range
  }
  const state = (view as EditorView & { state?: EditorView["state"] }).state
  if (!state || typeof state.field !== "function") return null
  const specs = state.field(livePreviewField, false)?.specs ?? []
  for (const spec of specs) {
    if (!spec.tag.startsWith("widget:block:")) continue
    const candidate = (spec.deco.spec as { widget?: BlockWidget }).widget
    if (candidate && (candidate === widget || candidate.eq(widget) || widget.eq(candidate))) {
      if (dom) liveRanges.set(dom, { from: spec.from, to: spec.to })
      return { from: spec.from, to: spec.to }
    }
  }
  return null
}

const COVERED = "omd-block-covered"

// 装饰重建会产生新 widget 实例（CM 按 eq() 复用 DOM，toDOM 不再调用），
// 注册表按实例存 DOM，查找时先试精确命中、再退回 eq() 匹配（同一渲染块），
// 并以 used 集合保证一对一（两个同 src 块不能共享同一个 wrap）。
function findWrap(widget: BlockWidget, used: Set<HTMLElement>): HTMLElement | undefined {
  const exact = liveWraps.get(widget)
  if (exact && !used.has(exact) && exact.isConnected) return exact
  for (const [w, dom] of liveWraps) {
    if (used.has(dom) || !dom.isConnected) continue
    if (w.eq(widget) || widget.eq(w)) return dom
  }
  return undefined
}

function refresh(view: EditorView) {
  const sel = view.state.selection.main
  const specs = view.state.field(livePreviewField, false)?.specs ?? []
  const used = new Set<HTMLElement>()
  for (const spec of specs) {
    if (!spec.tag.startsWith("widget:block:")) continue
    // Decoration.spec 公有；replace 装饰的 widget 即构造时传入的实例
    const widget = (spec.deco.spec as { widget?: BlockWidget }).widget
    if (!widget) continue
    const dom = findWrap(widget, used)
    if (!dom) continue
    used.add(dom)
    liveRanges.set(dom, { from: spec.from, to: spec.to })
    const covered = sel.from <= spec.from && sel.to >= spec.to
    dom.classList.toggle(COVERED, covered)
  }
}

/**
 * 选区变化时给“被完整包含”的存活块 widget 切换 omd-block-covered 选中态覆盖。
 * 纯 DOM 操作、不产 decoration（块装饰只能来自 StateField 的约束不受影响）。
 */
export const blockSelectionOverlay = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) { refresh(view) }
    update(u: ViewUpdate) {
      if (u.selectionSet || u.docChanged || u.viewportChanged) refresh(u.view)
    }
  },
)
