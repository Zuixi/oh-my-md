import { WidgetType } from "@codemirror/view"
import { BlockWidget } from "../blockWidget"

// 块/行内共用的渲染：懒加载 katex，失败把错误交给基类/调用方兜底
async function renderMath(
  el: HTMLElement,
  tex: string,
  displayMode: boolean,
  isActive: () => boolean,
) {
  const katex = (await import("katex")).default
  if (!isActive()) return
  el.innerHTML = katex.renderToString(tex, { displayMode, throwOnError: true })
}

export class MathBlockWidget extends BlockWidget {
  protected get cssClass() { return "omd-math" }
  protected renderInto(el: HTMLElement) {
    // 剥掉首尾 $$ 标记（单行与多行通用）
    const tex = this.src.replace(/^\$\$|\$\$\s*$/g, "").trim()
    return renderMath(el, tex, true, () => this.isActive(el))
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
