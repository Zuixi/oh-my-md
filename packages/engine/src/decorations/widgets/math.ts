import { EditorView, WidgetType } from "@codemirror/view"
import { BlockWidget } from "../blockWidget"

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
    return this.embed.quoteDepth === other.embed.quoteDepth
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
