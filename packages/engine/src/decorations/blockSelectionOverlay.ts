import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view"
import { livePreviewField } from "./build"
import type { BlockWidget } from "./blockWidget"

// 存活块 widget 实例 → wrap DOM（BlockWidget.toDOM 注册 / destroy 注销）。
// 覆盖判定用 livePreviewField.specs 的 from/to（构造期 pos 会随编辑漂移）。
// DOM 位置只用于在多个 eq() widget 中确认当前实例，最终范围仍来自 specs。
const liveWraps = new Map<BlockWidget, HTMLElement>()
const liveRanges = new WeakMap<HTMLElement, { from: number; to: number }>()
// Views that currently hold at least one `.omd-block-covered` element. A collapsed
// caret can never cover a block, so an uncovered view needs no spec scan at all
// (cursor moves, blinks, typing) — only a non-empty selection or a view that is
// already covered has anything to toggle.
const coveredViews = new WeakSet<EditorView>()

export function registerBlockWidget(widget: BlockWidget, dom: HTMLElement) {
  liveWraps.set(widget, dom)
}

export function unregisterBlockWidget(widget: BlockWidget) {
  const dom = liveWraps.get(widget)
  if (dom) liveRanges.delete(dom)
  liveWraps.delete(widget)
}

export function blockWidgetRange(widget: BlockWidget, view: EditorView, dom?: HTMLElement): { from: number; to: number } | null {
  const state = (view as EditorView & { state?: EditorView["state"] }).state
  if (!state || typeof state.field !== "function") return null
  const specs = state.field(livePreviewField, false)?.specs ?? []
  const candidates = specs.flatMap(spec => {
    if (!spec.tag.startsWith("widget:block:")) return []
    const candidate = (spec.deco.spec as { widget?: BlockWidget }).widget
    return candidate ? [{ spec, candidate }] : []
  })

  // Prefer identity before eq(): two blocks may intentionally have identical
  // source/embed values, but their DOM must stay bound to distinct ranges.
  const exact = candidates.find(({ candidate }) => candidate === widget)
  if (exact) {
    const range = { from: exact.spec.from, to: exact.spec.to }
    if (dom) liveRanges.set(dom, range)
    return range
  }

  const equalAt = (from: number) => candidates.find(({ spec, candidate }) =>
    spec.from === from &&
    candidate.constructor === widget.constructor &&
    (candidate.eq(widget) || widget.eq(candidate)))
  let matched = null
  if (dom && view.dom.contains(dom) && typeof view.posAtDOM === "function") {
    matched = equalAt(view.posAtDOM(dom)) ?? null
  }
  if (!matched && dom) {
    const cached = liveRanges.get(dom)
    if (cached) matched = equalAt(cached.from) ?? null
  }
  if (!matched) return null
  const range = { from: matched.spec.from, to: matched.spec.to }
  if (dom) liveRanges.set(dom, range)
  return range
}

const COVERED = "omd-block-covered"

export interface MountedBlockWidget {
  readonly widget: BlockWidget
  readonly dom: HTMLElement
  readonly from: number
  readonly to: number
}

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

/** Mounted block widgets paired with their current `livePreviewField` document ranges. */
export function mountedBlockWidgets(view: EditorView): MountedBlockWidget[] {
  const state = (view as EditorView & { state?: EditorView["state"] }).state
  if (!state || typeof state.field !== "function") return []
  const specs = state.field(livePreviewField, false)?.specs ?? []
  const used = new Set<HTMLElement>()
  const mounted: MountedBlockWidget[] = []
  for (const spec of specs) {
    if (!spec.tag.startsWith("widget:block:")) continue
    const widget = (spec.deco.spec as { widget?: BlockWidget }).widget
    if (!widget) continue
    const dom = findWrap(widget, used)
    if (!dom) continue
    used.add(dom)
    mounted.push({ widget, dom, from: spec.from, to: spec.to })
  }
  return mounted
}

function refresh(view: EditorView, docChanged: boolean) {
  const sel = view.state.selection.main
  // 清扫失效实例（防御性）：注册表按实例存 DOM，而注销只走 destroy()。CM 的
  // pass-0 复用（eq 相同、不调 updateDOM）会换掉 tile.widget 却不给旧实例 destroy，
  // 若某条路径漏了 updateDOM 里的 unregister，条目就会带着一个死键 + 活 DOM 留下来。
  // 这里只保证 liveWraps 不因任何未覆盖路径只增不减。注：以 DOM 为键的 liveRanges 曾是
  // 模块级 Map，把每个卸载掉的 wrap 强引用住（见 gotchas「块 widget 反复挂载/卸载会持续
  // 占用内存」），现已改成 WeakMap —— 那是一次**所有权**修正，不是内存问题的修复：改完后
  // 聚合 Chromium 堆增长仍可复现且根因 inconclusive（WeakMap/ephemeron/快照的“仍可见”
  // 不等于“仍被强引用”），所以本函数仍不管 DOM 生命周期。
  // Sweep first, in both paths: a collapsed caret in an uncovered view has no state to
  // toggle, so cursor moves, blinks and typing skip the O(specs) scan entirely (a large
  // doc carries 62 000+ specs). `liveWraps` holds the *mounted* block widgets only
  // (5–20 entries), and entries can only go stale behind a document change.
  if (sel.empty && !coveredViews.has(view)) {
    if (docChanged && liveWraps.size > 0)
      for (const [widget, dom] of liveWraps) if (!dom.isConnected) liveWraps.delete(widget)
    return
  }
  for (const [widget, dom] of liveWraps) if (!dom.isConnected) liveWraps.delete(widget)
  const specs = view.state.field(livePreviewField, false)?.specs ?? []
  const used = new Set<HTMLElement>()
  let anyCovered = false
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
    if (covered) anyCovered = true
    dom.classList.toggle(COVERED, covered)
  }
  if (anyCovered) coveredViews.add(view)
  else coveredViews.delete(view)
}

/**
 * 选区变化时给“被完整包含”的存活块 widget 切换 omd-block-covered 选中态覆盖。
 * 纯 DOM 操作、不产 decoration（块装饰只能来自 StateField 的约束不受影响）。
 */
export const blockSelectionOverlay = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) { refresh(view, false) }
    update(u: ViewUpdate) {
      if (u.selectionSet || u.docChanged || u.viewportChanged) refresh(u.view, u.docChanged)
    }
  },
)
