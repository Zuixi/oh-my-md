import { EditorView, WidgetType } from "@codemirror/view"
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

  // 身份稳定契约：编辑期逐键回写改变 src，eq 忽略 src、由 updateDOM 原地
  // 同步预览，DOM/popup/焦点全部复用。RangeSet 只对位置匹配的装饰调 eq，
  // 不会跨块误复用。
  eq(other: MathBlockWidget) {
    // instanceof 护栏：findWrap 的 eq() 兜底跨实例扫描时，忽略 src 的 eq 不得
    // 跨 widget 类型误配（否则数学 wrap 会与同 embed 的其它块类型互相认领）。
    return other instanceof MathBlockWidget
      && this.embed.quoteDepth === other.embed.quoteDepth
      && this.embed.listDepth === other.embed.listDepth
      && this.embed.quoteInList === other.embed.quoteInList
  }

  updateDOM(dom: HTMLElement, view: EditorView, _from: MathBlockWidget): boolean {
    const body = dom.querySelector<HTMLElement>(".omd-block-body")
    if (!body) return false
    // popup 打开但焦点不在输入框时，外部改动把草稿同步到最新（自己的回写不触发，
    // 因为输入中的值与新文档一致）。
    const ta = dom.querySelector<HTMLTextAreaElement>(".omd-math-editor")
    if (ta && dom.ownerDocument.activeElement !== ta && ta.value !== mathTexOf(this.src)) {
      ta.value = mathTexOf(this.src)
    }
    this.schedulePreview(dom, body, view)
    return true
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
    ta.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); popup.remove(); view.focus() }
    })
    ta.addEventListener("blur", e => {
      if (e.relatedTarget instanceof Node && popup.contains(e.relatedTarget)) return
      popup.remove()
    })
    new ResizeObserver(() => view.requestMeasure()).observe(popup)
    ta.focus()
    view.requestMeasure()
  }

  private applyDraft(view: EditorView, wrap: HTMLElement, tex: string) {
    if (view.state.readOnly) return
    // 从文档实时取块文本：wrap 监听器属于创建它的旧实例，其 this.src 可能过期；
    // blockWidgetRange 注册的旧实例仍有效，取回范围后按文档现值重建。
    const range = blockWidgetRange(this, view, wrap)
    const src = range ? view.state.sliceDoc(range.from, range.to) : this.src
    const next = rebuildMathSrc(src, tex)
    if (next === src) return
    const from = range?.from ?? this.pos
    view.dispatch({ changes: { from, to: from + src.length, insert: next } })
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
