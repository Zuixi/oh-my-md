import { EditorView, WidgetType } from "@codemirror/view"
import type { EditorState } from "@codemirror/state"

// 光标/选区与 [from, to) 严格重叠 → 块处于编辑态（显示源码）
export function blockSelected(state: EditorState, from: number, to: number) {
  const { from: sf, to: st } = state.selection.main
  return sf < to && st > from
}

// 统一块 widget 生命周期：创建(src) → toDOM/renderInto(可异步)
// → eq 按 src 比较（块文本 hash 缓存，未变不重渲染） → 点击 ✎ 把光标放进块内
// → 装饰重建、widget 消失（销毁态由 CM 回收）。渲染失败显示错误+原文。
export abstract class BlockWidget extends WidgetType {
  constructor(readonly src: string, readonly pos: number) { super() }

  eq(other: BlockWidget) { return this.src === other.src }

  protected abstract get cssClass(): string
  protected abstract renderInto(el: HTMLElement): void | Promise<void>

  toDOM(view: EditorView) {
    const wrap = document.createElement("div")
    wrap.className = `omd-block ${this.cssClass}`

    const editBtn = document.createElement("button")
    editBtn.className = "omd-block-edit"
    editBtn.textContent = "✎"
    editBtn.title = "Edit source"
    editBtn.addEventListener("mousedown", e => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.pos + 1 }, scrollIntoView: true })
      view.focus()
    })
    wrap.appendChild(editBtn)

    const body = document.createElement("div")
    body.className = "omd-block-body"
    wrap.appendChild(body)

    Promise.resolve()
      .then(() => this.renderInto(body))
      .catch(err => {
        body.classList.add("omd-block-error")
        body.textContent = `⚠ ${err instanceof Error ? err.message : err}\n\n${this.src}`
      })
    return wrap
  }

  // ✎ 按钮的事件由 widget 自己处理，其余事件交给 CM（点 body 不进入编辑，避免误触）
  ignoreEvent(event: Event) {
    return event.target instanceof HTMLElement && event.target.classList.contains("omd-block-edit")
  }
}
