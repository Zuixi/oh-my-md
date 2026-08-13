import { EditorView, WidgetType } from "@codemirror/view"
import type { EditorState } from "@codemirror/state"

export interface BlockEmbed {
  quoteDepth: number
  listDepth: number
  quoteInList: boolean
}

const EMPTY_EMBED: BlockEmbed = { quoteDepth: 0, listDepth: 0, quoteInList: false }

function blockWidgetClass(cssClass: string, embed: BlockEmbed): string {
  const classes = ["omd-block", cssClass]
  if (embed.quoteDepth > 0) {
    classes.push("omd-blockquote", `omd-blockquote-${embed.quoteDepth}`)
  }
  if (embed.listDepth > 0) {
    const nest = embed.quoteInList ? "omd-quote-in-li" : "omd-li"
    classes.push(`${nest}-${embed.listDepth}`)
  }
  return classes.join(" ")
}

// 光标/选区与 [from, to] 重叠（含边界）→ 块处于编辑态（显示源码）。
// 边界算块内（root cause C）：敲完 closing fence 光标恰停在 node.to，
// 若算块外，widget 会在打字中途吞掉整块、光标被卡死在边界。
// 光标彻底离开块后才渲染 widget（Typora 行为）。
export function blockSelected(state: EditorState, from: number, to: number) {
  const { from: sf, to: st } = state.selection.main
  return sf <= to && st >= from
}

// 统一块 widget 生命周期：创建(src) → toDOM/renderInto(可异步)
// → eq 按 src/embed 比较（文本和嵌套位置均未变时不重渲染） → 点击任意处把光标放进
// 块内 → 装饰重建、widget 消失（销毁态由 CM 回收）。渲染失败显示错误+原文。
export abstract class BlockWidget extends WidgetType {
  private alive = true

  constructor(
    readonly src: string,
    readonly pos: number,
    readonly embed: BlockEmbed = EMPTY_EMBED,
  ) { super() }

  eq(other: BlockWidget) {
    // pos 不参与相等性：click handler 已改用 posAtCoords（实时坐标）定位，
    // 此处只需 src/embed 相同即可复用 DOM，避免在块前插入文字（pos 变但内容不变）时
    // 触发不必要的 Shiki/KaTeX/Mermaid 重渲。ImageWidget 同样不含 pos in eq。
    return this.src === other.src
      && this.embed.quoteDepth === other.embed.quoteDepth
      && this.embed.listDepth === other.embed.listDepth
      && this.embed.quoteInList === other.embed.quoteInList
  }

  protected abstract get cssClass(): string
  protected abstract renderInto(el: HTMLElement): void | Promise<void>
  protected isActive(_el?: HTMLElement) { return this.alive }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div")
    wrap.className = blockWidgetClass(this.cssClass, this.embed)
    wrap.title = "Click to edit source"
    // 整块点击即回源码（root cause D：只放行 ✎ 时块是砖，用户进不去）
    wrap.addEventListener("mousedown", e => {
      e.preventDefault()
      // 用鼠标实际坐标定位，比 posAtDOM(wrap) 更精确，单击和双击均落到正确位置。
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.posAtDOM(wrap)
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
      view.focus()
    })

    const editBtn = document.createElement("button")
    editBtn.className = "omd-block-edit"
    editBtn.textContent = "✎"
    editBtn.tabIndex = -1
    wrap.appendChild(editBtn)

    const body = document.createElement("div")
    body.className = "omd-block-body"
    wrap.appendChild(body)

    Promise.resolve()
      .then(() => this.renderInto(body))
      .then(() => {
        if (this.isActive(body)) view.requestMeasure()
      })
      .catch(err => {
        if (!this.isActive(body)) return
        body.classList.add("omd-block-error")
        body.textContent = `⚠ ${err instanceof Error ? err.message : err}\n\n${this.src}`
        view.requestMeasure()
      })
    return wrap
  }

  // mousedown 由 widget 自己处理（进编辑态）；dblclick 也屏蔽，防止 widget DOM 上
  // 的双击冒泡给 CM 产生跨 replace 装饰的异常选区；其余事件交给 CM。
  ignoreEvent(event: Event) {
    return event.type === "mousedown" || event.type === "dblclick"
  }

  destroy(_dom?: HTMLElement) {
    this.alive = false
  }
}
