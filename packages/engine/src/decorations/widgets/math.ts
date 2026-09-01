import { EditorView, WidgetType } from "@codemirror/view"
import { syntaxTree } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { BlockWidget } from "../blockWidget"
import { blockWidgetRange } from "../blockSelectionOverlay"

export function mathTexOf(src: string): string {
  return src.replace(/^\$\$|\$\$\s*$/g, "").trim()
}

/** 按原分隔符形态重建块文本：原块含换行 → 多行包裹，否则单行包裹。 */
export function rebuildMathSrc(src: string, tex: string): string {
  return src.includes("\n") ? `$$\n${tex}\n$$` : `$$${tex}$$`
}

// 块/行内共用的渲染：懒加载 katex，失败把错误交给基类/调用方兜底
async function renderMath(
  el: HTMLElement,
  tex: string,
  displayMode: boolean,
  isActive: () => boolean,
  throwOnError = true,
) {
  const katex = (await import("katex")).default
  if (!isActive()) return
  el.innerHTML = katex.renderToString(tex, { displayMode, throwOnError })
}

export class MathBlockWidget extends BlockWidget {
  protected get cssClass() { return "omd-math" }

  private resizeObs?: ResizeObserver

  eq(other: MathBlockWidget) {
    // CM reuse contract: pass-0 uses eq and reuses DOM WITHOUT calling updateDOM.
    // updateDOM only runs when eq FAILS. So eq must compare src — returning true
    // for changed content would reuse the stale DOM and skip the preview refresh.
    return other instanceof MathBlockWidget
      && this.src === other.src
      && this.embed.quoteDepth === other.embed.quoteDepth
      && this.embed.listDepth === other.embed.listDepth
      && this.embed.quoteInList === other.embed.quoteInList
  }

  // pass 1 的原地刷新路径（仅当 eq 失败才会到这里）：同步草稿框 + 重渲预览。
  // 无焦点护栏：Undo/Redo 或弹窗打开期间的外部编辑也要把草稿同步回文档现值；
  // 正常输入时回写使 mathTexOf(this.src) 等于输入值，同步是 no-op，不跳光标。
  updateDOM(dom: HTMLElement, view: EditorView, _from: MathBlockWidget): boolean {
    const body = dom.querySelector<HTMLElement>(".omd-block-body")
    if (!body) return false
    const ta = dom.querySelector<HTMLTextAreaElement>(".omd-math-editor")
    if (ta && ta.value !== mathTexOf(this.src)) ta.value = mathTexOf(this.src)
    this.schedulePreview(dom, body, view)
    return true
  }

  override destroy(dom?: HTMLElement) {
    this.resizeObs?.disconnect()
    this.resizeObs = undefined
    super.destroy(dom)
  }

  private schedulePreview(dom: HTMLElement, body: HTMLElement, view: EditorView) {
    const host = dom as HTMLElement & { __omdMathRaf?: number }
    if (host.__omdMathRaf) cancelAnimationFrame(host.__omdMathRaf)
    const tex = mathTexOf(this.src)
    host.__omdMathRaf = requestAnimationFrame(() => {
      host.__omdMathRaf = 0
      if (!this.isActive(body)) return
      renderMath(body, tex, true, () => this.isActive(body), false)
        .then(() => { if (this.isActive(body)) view.requestMeasure() })
        .catch(() => { /* 编辑期预览失败保留上一次渲染，不整块消失 */ })
    })
  }

  protected enterSourceOnClick() { return false }

  override ignoreEvent(event: Event) {
    return super.ignoreEvent(event)
      || event.type === "keydown" || event.type === "keyup"
      || event.type === "keypress" || event.type === "input"
      || event.type === "click"
  }

  protected onWrapClick(view: EditorView, wrap: HTMLElement) {
    if (view.state.readOnly) { view.focus(); return }
    const existing = wrap.querySelector<HTMLTextAreaElement>(".omd-math-editor")
    if (existing) { existing.focus(); return }
    const popup = document.createElement("div")
    popup.className = "omd-math-popup"
    const ta = document.createElement("textarea")
    ta.className = "omd-math-editor"
    ta.value = mathTexOf(this.src)
    ta.spellcheck = false
    ta.rows = Math.max(1, ta.value.split("\n").length)
    popup.appendChild(ta)
    wrap.appendChild(popup)
    ta.addEventListener("input", () => this.applyDraft(view, wrap, ta.value))
    const close = () => {
      this.resizeObs?.disconnect()
      this.resizeObs = undefined
      popup.remove()
    }
    ta.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); close(); view.focus() }
    })
    ta.addEventListener("blur", e => {
      if (e.relatedTarget instanceof Node && popup.contains(e.relatedTarget)) return
      close()
    })
    this.resizeObs?.disconnect()
    this.resizeObs = new ResizeObserver(() => view.requestMeasure())
    this.resizeObs.observe(popup)
    ta.focus()
    view.requestMeasure()
  }

  private applyDraft(view: EditorView, wrap: HTMLElement, tex: string) {
    if (view.state.readOnly) return
    // wrap 的 input 监听器属于创建它的旧实例：回写触发重建后，livePreviewField
    // 持有的是新实例，旧实例的 this.pos/this.src 已漂移。必须从实时文档解析块范围，
    // 绝不能用构造期偏移量兜底。
    const range = this.liveRange(view, wrap) ?? blockWidgetRange(this, view, wrap)
    if (!range) return   // 解析不到实时范围就不猜，宁可丢一次回写也不破坏文档
    const src = view.state.sliceDoc(range.from, range.to)
    const next = rebuildMathSrc(src, tex)
    if (next === src) return
    view.dispatch({ changes: { from: range.from, to: range.to, insert: next } })
  }

  private liveRange(view: EditorView, wrap: HTMLElement): { from: number; to: number } | null {
    let pos: number
    try { pos = view.posAtDOM(wrap) } catch { return null }
    let node: SyntaxNode | null = syntaxTree(view.state).resolve(pos, 1)
    while (node && node.name !== "MathBlock") node = node.parent
    return node ? { from: node.from, to: node.to } : null
  }

  protected renderPlaceholder(el: HTMLElement) {
    const pre = document.createElement("pre")
    pre.className = "omd-block-placeholder"
    pre.textContent = this.src
    el.appendChild(pre)
  }

  protected renderInto(el: HTMLElement) {
    return renderMath(el, mathTexOf(this.src), true, () => this.isActive(el))
  }
}

export class InlineMathWidget extends WidgetType {
  private alive = true

  constructor(readonly tex: string) { super() }
  eq(other: InlineMathWidget) { return this.tex === other.tex }
  toDOM() {
    const el = document.createElement("span")
    el.className = "omd-inline-math"
    renderMath(el, this.tex, false, () => this.alive).catch(() => {
      if (this.alive) el.textContent = `$${this.tex}$`
    })
    return el
  }

  destroy(_dom?: HTMLElement) {
    this.alive = false
  }
}
