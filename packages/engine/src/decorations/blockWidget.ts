import { EditorView, WidgetType } from "@codemirror/view"
import type { EditorState } from "@codemirror/state"
import {
  deferBlockRender, dropPendingBlockRender, type PendingRender, withinRenderBudget,
} from "./renderBudget"
import { blockWidgetRange, registerBlockWidget, unregisterBlockWidget } from "./blockSelectionOverlay"
import { measureBlockWidget } from "./widgetMeasure"
import { icon } from "./icons"

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

// 光标/选区与 [from, to] 重叠（含边界）且**未完整包含**→ 块处于编辑态（显示源码）。
// 完整包含（sel.from <= from && sel.to >= to，Cmd+A / 跨块拖选 / Shift+↓ 跨块）
// 保持渲染 + omd-block-covered 选中态覆盖（Typora 语义：选区是视觉的，光标才是编辑）。
// 边界算块内（root cause C）：敲完 closing fence 光标恰停在 node.to，
// 若算块外，widget 会在打字中途吞掉整块、光标被卡死在边界。
// 光标彻底离开块后才渲染 widget（Typora 行为）。
export function blockSelected(state: EditorState, from: number, to: number) {
  const { from: sf, to: st } = state.selection.main
  return sf <= to && st >= from && !(sf <= from && st >= to)
}

// 统一块 widget 生命周期：创建(src) → toDOM/renderInto(可异步)
// → eq 按 src/embed 比较（文本和嵌套位置均未变时不重渲染） → 点击任意处把光标放进
// 块内 → 装饰重建、widget 消失（销毁态由 CM 回收）。渲染失败显示错误+原文。
export abstract class BlockWidget extends WidgetType {
  private alive = true
  private pendingEntry: PendingRender | null = null
  /**
   * 本实例当前挂载的 DOM（toDOM 的产物）。异步渲染写回前用它判断"这块 DOM 还归我吗"。
   * 存在的理由：`alive` 记的是**实例**生命期，而 CM/装饰重建产生的是 **tile** 级事件 ——
   * 同一个实例会被重新 toDOM 到新 tile 上，并可能乱序收到旧 tile 的 destroy()
   * （实测时序：toDOM#1 → toDOM#2 → destroy(#1)）；只按 alive 判断会让新 DOM 永远
   * 停在同步占位（引用内代码块在文档首块时丢失 Shiki 高亮，见 docs/memory/gotchas-engine.md）。
   */
  protected currentDom: HTMLElement | undefined

  constructor(
    readonly src: string,
    readonly pos: number,
    readonly embed: BlockEmbed = EMPTY_EMBED,
  ) { super() }

  eq(other: BlockWidget) {
    // pos 不参与相等性：click handler 使用实时 DOM 边界或坐标定位，
    // 此处只需 src/embed 相同即可复用 DOM，避免在块前插入文字（pos 变但内容不变）时
    // 触发不必要的 Shiki/KaTeX/Mermaid 重渲。ImageWidget 同样不含 pos in eq。
    return this.src === other.src
      && this.embed.quoteDepth === other.embed.quoteDepth
      && this.embed.listDepth === other.embed.listDepth
      && this.embed.quoteInList === other.embed.quoteInList
  }

  protected abstract get cssClass(): string
  protected renderPlaceholder(_el: HTMLElement): void {}
  protected abstract renderInto(el: HTMLElement): void | Promise<void>
  protected clickPos(view: EditorView, _event: MouseEvent, wrap: HTMLElement): number {
    const range = blockWidgetRange(this, view, wrap)
    return range?.from ?? view.posAtDOM(wrap)
  }
  /** Live 预览代码块保持渲染以便复制；其它块仍单击进源码编辑。 */
  protected enterSourceOnClick(): boolean { return true }
  protected nativePointerInteraction(_event: MouseEvent): boolean { return false }
  /** 点击不进源码的块（代码块、数学弹窗）由此钩子接管后续交互；默认保持聚焦编辑器。 */
  protected onWrapClick(view: EditorView, _wrap: HTMLElement): void { view.focus() }
  // public：renderBudget 的 flush 需要检查挂起块是否已被销毁。
  isActive(_el?: HTMLElement) { return this.alive }

  /**
   * 登记本实例当前 DOM 并重新激活：**每个 toDOM 都必须调用**。同一个实例被重新挂到
   * 新 tile 上是正常路径（装饰重建会复用同一 Decoration/实例），toDOM 即"重新激活"。
   */
  protected activateDom(dom: HTMLElement): void {
    this.alive = true
    this.currentDom = dom
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div")
    wrap.className = blockWidgetClass(this.cssClass, this.embed)
    wrap.title = this.enterSourceOnClick() ? "Click to edit source" : ""
    wrap.addEventListener("mousedown", e => {
      if (e.button !== 0) return
      if (this.nativePointerInteraction(e)) return
      if (!this.enterSourceOnClick()) {
        e.preventDefault()
        this.onWrapClick(view, wrap)
        return
      }
      e.preventDefault()
      const pos = this.clickPos(view, e, wrap)
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
      view.focus()
    })

    const editBtn = document.createElement("button")
    editBtn.className = "omd-block-edit"
    // 语义反转：`</>`（code 图标）= 显式看源码；铅笔保留给未来的“就地编辑”
    // 入口（math popup 模式），避免再出现“铅笔=翻源码”的方向歧义。
    editBtn.appendChild(icon("code"))
    editBtn.title = "View source"
    editBtn.setAttribute("aria-label", "View source")
    editBtn.tabIndex = -1
    // `</>` 按钮是显式的“进源码”控件：自带处理器（不依赖冒泡到 wrap），wrap
    // 点击不进源码的块（表格：enterSourceOnClick=false）仍能经它进入源码编辑。
    editBtn.addEventListener("mousedown", e => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const pos = this.clickPos(view, e, wrap)
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
      view.focus()
    })
    wrap.appendChild(editBtn)

    const body = document.createElement("div")
    body.className = "omd-block-body"
    wrap.appendChild(body)
    this.activateDom(wrap)
    this.renderPlaceholder(body)

    const start = () => Promise.resolve()
      .then(() => this.renderInto(body))
      .then(() => {
        if (this.isActive(body)) {
          view.requestMeasure()
          if (typeof view.dispatch === "function") {
            const pos = blockWidgetRange(this, view, wrap)?.from ?? this.pos
            view.dispatch({ effects: measureBlockWidget.of({ pos }) })
          }
        }
      })
      .catch(err => {
        if (!this.isActive(body)) return
        body.classList.add("omd-block-error")
        body.replaceChildren(
          icon("triangle-alert"),
          document.createTextNode(` ${err instanceof Error ? err.message : err}\n\n${this.src}`),
        )
        view.requestMeasure()
        if (typeof view.dispatch === "function") {
          const pos = blockWidgetRange(this, view, wrap)?.from ?? this.pos
          view.dispatch({ effects: measureBlockWidget.of({ pos }) })
        }
      })
    // 预算外（距光标远且不在视口）挂起，由 renderBudgetFlush 在光标/视口接近时补渲。
    if (withinRenderBudget(view, this.pos)) start()
    else {
      this.pendingEntry = { widget: this, view, pos: this.pos, start }
      deferBlockRender(this.pendingEntry)
    }
    registerBlockWidget(this, wrap)
    return wrap
  }

  // mousedown 由 widget 自己处理（进编辑态）；dblclick 也屏蔽，防止 widget DOM 上
  // 的双击冒泡给 CM 产生跨 replace 装饰的异常选区；其余事件交给 CM。
  ignoreEvent(event: Event) {
    return event.type === "mousedown" || event.type === "dblclick"
  }

  destroy(dom?: HTMLElement) {
    // tile 级事件，不是实例级：只有"当前 DOM 被丢弃"才退役实例。乱序到达的旧 tile
    // destroy（toDOM#2 之后才收到 destroy(#1)）不得杀死已重新挂载的实例；
    // 不传 dom 视为"这个实例不再使用"（测试与显式回收路径）。
    if (!dom || dom === this.currentDom) {
      this.alive = false
      this.currentDom = undefined
    }
    unregisterBlockWidget(this)
    if (this.pendingEntry) dropPendingBlockRender(this.pendingEntry)
  }
}
