import { EditorView, keymap, WidgetType } from "@codemirror/view"
import { EditorState, Prec, type Extension } from "@codemirror/state"
import { HighlightStyle, StreamLanguage, syntaxHighlighting, syntaxTree } from "@codemirror/language"
import { tags } from "@lezer/highlight"
import { stex } from "@codemirror/legacy-modes/mode/stex"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import type { SyntaxNode } from "@lezer/common"
import { BlockWidget, applyBlockEmbed } from "../blockWidget"
import { MATH_BLOCK_ESTIMATE_PX } from "../widgetHeights"
import { blockWidgetRange } from "../blockSelectionOverlay"
import { mathEditorTexOf, mathTexOf, rebuildMathSrc } from "../../semantic/math"

export { mathEditorTexOf, mathTexOf, rebuildMathSrc }

// stex 流式语法把控制序列（\frac 等）标为 "tag"（StreamLanguage 映射成 tags.tagName），
// 注释/括号/字符串各有标准 tag。颜色复用桌面侧已有的 --omd-syn-* 双主题 token
// （与代码编辑态同一视觉语言，token 契约由 blockWidgetLayout.test.ts 守护）。
const LATEX_HIGHLIGHT = HighlightStyle.define([
  { tag: [tags.tagName, tags.keyword], color: "var(--omd-syn-keyword)" },
  { tag: tags.comment, color: "var(--omd-syn-comment)", fontStyle: "italic" },
  { tag: tags.bracket, color: "var(--omd-syn-punctuation)" },
  { tag: tags.string, color: "var(--omd-syn-string)" },
  { tag: tags.atom, color: "var(--omd-syn-number)" },
])

// LaTeX 源码几乎不需要制表符；不绑定 Tab 会走浏览器默认焦点导航，
// blur 导致弹窗被误关（textarea 时代就有这个坑）。
const POPUP_TAB_SPACES = "  "

function latexPopupExtensions(close: () => void, refocusOuter: () => void): Extension[] {
  return [
    StreamLanguage.define(stex),
    syntaxHighlighting(LATEX_HIGHLIGHT, { fallback: true }),
    EditorView.lineWrapping,
    // 弹窗内自带 defaultKeymap + undo/redo：事件被屏蔽后外层键映射收不到
    // 快捷键，内层独立承载光标移动、删除与 Cmd+Z。
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    Prec.highest(keymap.of([
      {
        key: "Escape",
        run: () => { close(); refocusOuter(); return true },
      },
      {
        key: "Mod-Enter",
        run: () => { close(); refocusOuter(); return true },
      },
      {
        key: "Shift-Enter",
        run: () => { close(); refocusOuter(); return true },
      },
      {
        key: "Tab",
        run: v => { v.dispatch(v.state.replaceSelection(POPUP_TAB_SPACES)); return true },
      },
    ])),
  ]
}

/**
 * 根据预览区域的点击坐标计算对应 TeX 字符串的字符偏移：
 * - 无有效布局几何（happy-dom 或 0 宽高）时默认落在末尾（方便直接追加/退格）；
 * - 多行公式先按纵向比例定位行，再按横向比例定位该行内字符；
 * - 单行公式直接按横向比例定位字符。
 */
function clickRatioOffset(
  tex: string,
  container: Element | null,
  event?: MouseEvent,
): number {
  if (!event || !container) return 0
  const inner = container.querySelector(".katex-html, .katex")
  const innerRect = inner?.getBoundingClientRect()
  const rect = innerRect && innerRect.width > 0 ? innerRect : container.getBoundingClientRect()
  if (rect.width <= 0) return 0
  const rx = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  const lines = tex.split("\n")
  if (lines.length <= 1 || rect.height <= 0) {
    return Math.round(rx * tex.length)
  }
  const ry = Math.min(0.999, Math.max(0, (event.clientY - rect.top) / rect.height))
  const lineIdx = Math.min(lines.length - 1, Math.floor(ry * lines.length))
  let offset = 0
  for (let i = 0; i < lineIdx; i++) offset += lines[i].length + 1
  return offset + Math.round(rx * lines[lineIdx].length)
}

const POPUP_STOP_EVENTS = [
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "contextmenu",
  "keydown",
  "keyup",
  "keypress",
  "input",
  "beforeinput",
  "paste",
  "copy",
  "cut",
  "drop",
  "compositionstart",
  "compositionupdate",
  "compositionend",
] as const

function isolatePopupEvents(popup: HTMLElement): void {
  const stop = (e: Event) => { e.stopPropagation() }
  for (const type of POPUP_STOP_EVENTS) {
    popup.addEventListener(type, stop)
  }
}
// widget 实例会轮换，实例字段会指向已漂移的旧 this，DOM 才是稳定的查找锚点。
// 内层编辑器实例挂在 popup DOM 上而不是 widget 实例字段里：pass-1 复用 DOM 时
// widget 实例会轮换，实例字段会指向已漂移的旧 this，DOM 才是稳定的查找锚点。
type MathPopupHost = HTMLElement & { __omdMathPopupView?: EditorView }

function popupEditorOf(root: Element | null): EditorView | undefined {
  return root?.querySelector<MathPopupHost>(".omd-math-popup")?.__omdMathPopupView
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

  // 滚动性能：display 数学通常 ~2 行，缺省一行行高估算偏小（见 widgetHeights.ts）。
  override get estimatedHeight() { return MATH_BLOCK_ESTIMATE_PX }

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

  // pass 1 的原地刷新路径（仅当 eq 失败才会到这里）：同步内层编辑器 + 重渲预览。
  // 无焦点护栏：Undo/Redo 或弹窗打开期间的外部编辑也要把草稿同步回文档现值；
  // 正常输入时回写使 mathTexOf(this.src) 等于输入值，同步是 no-op，不跳光标。
  updateDOM(dom: HTMLElement, view: EditorView, _from: MathBlockWidget): boolean {
    const body = dom.querySelector<HTMLElement>(".omd-block-body")
    if (!body) return false
    // 复用的 DOM 上还挂着上一层的嵌入类/深度：先同步成当前实例的值，
    // 再走下面的源码同步（否则块换层后缩进与引用条留在旧位置）。
    applyBlockEmbed(dom, this.embed)
    // 弹窗内的 dispatch → 回写 → 外层重入重建的时序下，this.src 可能是过期实例值，
    // 且 posAtDOM/注册表两种范围解析都可能失败。与 applyDraft 同理以实时文档为
    // 真相：解析失败且有弹窗时宁可跳过同步，也绝不拿旧值回滚内层已输入的内容。
    const range = this.liveRange(view, dom) ?? blockWidgetRange(this, view, dom)
    const tex = range
      ? mathEditorTexOf(view.state.sliceDoc(range.from, range.to))
      : mathEditorTexOf(this.src)
    const inner = popupEditorOf(dom)
    // 同步前提（满足其一）：能从实时文档解析出块范围；或 view 没有真实文档
    // （隔离单元测试语境，incoming this.src 即最新真相）。两者皆否 = 弹窗 dispatch
    // → 回写 → 外层重入重建的时序（this.src 过期、范围解析双双失败）：跳过同步，
    // 绝不回滚内层刚输入的内容；写回已在文档里，下一次正常时序的 updateDOM 会收敛。
    const syncable = range !== null || (view as { state?: unknown }).state === undefined
    // IME 组词进行中（view.composing）时跳过同步：全量替换会打断组词、冲掉预输入；
    // 写回机制自愈——组词落定后的下一次输入会以文档现值重建块文本。
    if (inner && syncable && !inner.composing && inner.state.doc.toString() !== tex) {
      // 全量替换会把光标映射到替换边界（跳到 0 或末尾），显式夹取回原偏移。
      const anchor = Math.min(inner.state.selection.main.anchor, tex.length)
      inner.dispatch({
        changes: { from: 0, to: inner.state.doc.length, insert: tex },
        selection: { anchor },
      })
    }
    this.schedulePreview(dom, body, view, tex)
    return true
  }

  override destroy(dom?: HTMLElement) {
    this.resizeObs?.disconnect()
    this.resizeObs = undefined
    // wrap 被 CM 整体丢弃（如光标进块）时 close() 不会走 focusout 路径，
    // 这里兜底销毁内层编辑器，防监听器/实例泄漏。
    popupEditorOf(dom ?? null)?.destroy()
    super.destroy(dom)
  }

  private schedulePreview(dom: HTMLElement, body: HTMLElement, view: EditorView, tex = mathTexOf(this.src)) {
    const host = dom as HTMLElement & { __omdMathRaf?: number }
    if (host.__omdMathRaf) cancelAnimationFrame(host.__omdMathRaf)
    host.__omdMathRaf = requestAnimationFrame(() => {
      host.__omdMathRaf = 0
      if (!this.isActive(body)) return
      renderMath(body, tex, true, () => this.isActive(body), false)
        .then(() => { if (this.isActive(body)) view.requestMeasure() })
        .catch(() => { /* 编辑期预览失败保留上一次渲染，不整块消失 */ })
    })
  }

  protected enterSourceOnClick() { return false }

  protected nativePointerInteraction(event: MouseEvent) {
    return event.target instanceof Element
      && event.target.closest(".omd-math-popup") !== null
  }

  override ignoreEvent(event: Event) {
    return super.ignoreEvent(event)
      || event.type === "keydown" || event.type === "keyup"
      || event.type === "keypress" || event.type === "input"
      || event.type === "click"
      || event.type === "focusin" || event.type === "focusout"
      || event.type === "focus" || event.type === "blur"
      // 内层编辑器是 contenteditable，中文输入走 composition 事件族，
      // 不屏蔽会漏进外层 CM 的输入状态机
      || event.type === "compositionstart" || event.type === "compositionupdate"
      || event.type === "compositionend"
  }

  protected onWrapClick(view: EditorView, wrap: HTMLElement, event?: MouseEvent) {
    if (view.state.readOnly) { view.focus(); return }
    const body = wrap.querySelector<HTMLElement>(".omd-block-body")
    const existing = popupEditorOf(wrap)
    if (existing) {
      const tex = existing.state.doc.toString()
      const anchor = clickRatioOffset(tex, body, event)
      existing.dispatch({ selection: { anchor } })
      existing.focus()
      return
    }
    const range = this.liveRange(view, wrap) ?? blockWidgetRange(this, view, wrap)
    const initialTex = range
      ? mathEditorTexOf(view.state.sliceDoc(range.from, range.to))
      : mathEditorTexOf(this.src)
    const initialAnchor = clickRatioOffset(initialTex, body, event)
    const popup = document.createElement("div")
    popup.className = "omd-math-popup"
    isolatePopupEvents(popup)
    const host = document.createElement("div")
    host.className = "omd-math-editor"
    popup.appendChild(host)
    wrap.appendChild(popup)
    let inner: EditorView
    let closed = false
    // close 会被 Escape 键映射（创建期闭包）调用，彼时 inner 已赋值，TDZ 安全。
    // closed 标志而非 isConnected 判断：inner.destroy() 会同步触发 focusout，
    // 那时 popup 还没 remove，按连接性判断会二次进入、双重销毁内层编辑器。
    const close = () => {
      if (closed) return
      closed = true
      this.resizeObs?.disconnect()
      this.resizeObs = undefined
      inner.destroy()
      popup.remove()
    }
    inner = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialTex,
        extensions: [
          latexPopupExtensions(close, () => view.focus()),
          EditorView.updateListener.of(u => {
            if (u.docChanged) this.applyDraft(view, wrap, u.state.doc.toString())
          }),
        ],
      }),
    })
    ;(popup as MathPopupHost).__omdMathPopupView = inner
    let pointerInPopup = false
    popup.addEventListener("mousedown", () => {
      pointerInPopup = true
      setTimeout(() => { pointerInPopup = false }, 50)
    }, true)
    popup.addEventListener("focusout", e => {
      if (e.relatedTarget instanceof Node && popup.contains(e.relatedTarget)) return
      if (pointerInPopup) {
        queueMicrotask(() => {
          if (!closed) inner.focus()
        })
        return
      }
      close()
    })
    this.resizeObs?.disconnect()
    this.resizeObs = new ResizeObserver(() => view.requestMeasure())
    this.resizeObs.observe(popup)
    inner.focus()
    if (initialAnchor > 0) {
      inner.dispatch({ selection: { anchor: initialAnchor } })
    }
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
    if (!node) return null
    // 语法树可能滞后于文档（弹窗 dispatch→回写→外层重入重建的时序）：旧节点范围
    // 切新文档会得到畸形片段（如 "$$\n  x+y"，strip+trim 后错成 "x+y" 回滚输入）。
    // 形状校验失败一律按“解析不到”处理，交给调用方的“不猜”护栏。
    const src = view.state.sliceDoc(node.from, node.to)
    if (!src.startsWith("$$") || !src.endsWith("$$")) return null
    return { from: node.from, to: node.to }
  }

  protected renderPlaceholder(el: HTMLElement) {
    const pre = document.createElement("pre")
    pre.className = "omd-block-placeholder"
    pre.textContent = this.src
    el.appendChild(pre)
    el.dataset.omdRender = "placeholder"
  }

  protected renderInto(el: HTMLElement) {
    return renderMath(el, mathTexOf(this.src), true, () => this.isActive(el))
      .then(() => { el.dataset.omdRender = "katex" })
      .catch(err => {
        el.dataset.omdRender = "error"
        console.debug(`[omd] math render failed: ${err instanceof Error ? err.message : err}`)
        throw err
      })
  }
}

export class InlineMathWidget extends WidgetType {
  private alive = true

  constructor(readonly tex: string) { super() }
  eq(other: InlineMathWidget) { return this.tex === other.tex }
  toDOM(view: EditorView) {
    const el = document.createElement("span")
    el.className = "omd-inline-math"
    el.addEventListener("mousedown", e => {
      if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      if (!view?.state || view.state.readOnly) return
      let pos: number
      try { pos = view.posAtDOM(el) } catch { return }
      let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1)
      while (node && node.name !== "InlineMath") node = node.parent
      if (!node || node.to - node.from < 2) return
      e.preventDefault()
      e.stopPropagation()
      const innerTex = view.state.sliceDoc(node.from + 1, node.to - 1)
      const offset = clickRatioOffset(innerTex, el, e)
      const anchor = Math.min(node.to - 1, Math.max(node.from + 1, node.from + 1 + offset))
      view.dispatch({ selection: { anchor }, scrollIntoView: true })
      view.focus()
    })
    renderMath(el, this.tex, false, () => this.alive).catch(() => {
      if (this.alive) el.textContent = `$${this.tex}$`
    })
    return el
  }

  override ignoreEvent(event: Event) {
    return event.type === "mousedown"
  }

  destroy(_dom?: HTMLElement) {
    this.alive = false
  }
}
