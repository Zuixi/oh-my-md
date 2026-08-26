import { BlockWidget, type BlockEmbed } from "../blockWidget"
import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { LANGUAGE_LOADERS, resolveCodeLanguage } from "../../shiki/languages"
import { EditorView } from "@codemirror/view"
import { blockWidgetRange } from "../blockSelectionOverlay"

// 渲染 debounce：快速打字时 widget 在此窗口内被销毁（回到编辑态）则放弃渲染。
const RENDER_DEBOUNCE_MS = 150

let highlighterPromise: Promise<HighlighterCore> | null = null

function getHighlighter(): Promise<HighlighterCore> {
  return highlighterPromise ??= Promise.all([
    import("shiki/themes/github-light.mjs"),
    import("shiki/themes/github-dark.mjs"),
  ]).then(([light, dark]) =>
    createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    }))
}

// 模块级渲染缓存：lang:src → HTML 字符串。
// 相同内容的代码块命中缓存后直接写入，不重跑 Shiki。
// 主要受益场景：src 未变但因文档变化 widget 被重新实例化时（eq 已移除 pos，
// 此处作为双重保险）。
const htmlCache = new Map<string, string>()

export class CodeWidget extends BlockWidget {
  private readonly contentFrom: number
  private readonly contentTo: number
  constructor(
    src: string,
    pos: number,
    readonly lang: string,
    contentFromOrEmbed: number | BlockEmbed = pos,
    contentTo = pos,
    embed?: BlockEmbed,
  ) {
    const resolvedEmbed = typeof contentFromOrEmbed === "number" ? embed : contentFromOrEmbed
    super(src, pos, resolvedEmbed)
    if (typeof contentFromOrEmbed === "number") {
      this.contentFrom = contentFromOrEmbed
      this.contentTo = contentTo
    } else {
      this.contentFrom = pos
      this.contentTo = pos
    }
  }
  eq(other: CodeWidget) { return super.eq(other) && this.lang === other.lang }

  protected get cssClass() { return "omd-code" }

  protected renderPlaceholder(el: HTMLElement) {
    const pre = document.createElement("pre")
    pre.textContent = this.src
    el.appendChild(pre)
  }

  protected clickPos(view: EditorView, event: MouseEvent, wrap: HTMLElement): number {
    const lines = lineStartOffsets(this.src)
    if (lines.length === 0) return this.contentFrom
    const range = blockWidgetRange(this, view, wrap)
    const blockFrom = range?.from ?? (typeof view.posAtDOM === "function" ? view.posAtDOM(wrap, -1) : null)
    const currentState = (view as EditorView & { state?: EditorView["state"] }).state
    const contentFrom = blockFrom === null || !currentState
      ? this.contentFrom
      : Math.min(currentState.doc.length, currentState.doc.lineAt(blockFrom).to + 1)
    const contentTo = currentState
      ? Math.min(currentState.doc.length, contentFrom + this.src.length)
      : this.contentTo
    const body = wrap.querySelector(".omd-block-body")
    if (!body) return super.clickPos(view, event, wrap)
    const line = event.target instanceof Element ? event.target.closest(".line") : null
    if (line) {
      let index = 0
      for (let cur = line.previousElementSibling; cur; cur = cur.previousElementSibling) {
        if (cur.classList.contains("line")) index++
      }
      return this.linePosition(index, lines, contentFrom, contentTo)
    }
    const rect = body.getBoundingClientRect()
    if (rect.height <= 0) return super.clickPos(view, event, wrap)
    const ratio = (event.clientY - rect.top) / rect.height
    const index = Math.floor(ratio * lines.length)
    return this.linePosition(index, lines, contentFrom, contentTo)
  }

  private linePosition(
    index: number,
    lineStarts: number[],
    contentFrom = this.contentFrom,
    contentTo = this.contentTo,
  ): number {
    const clamped = Math.max(0, Math.min(index, lineStarts.length - 1))
    const mapped = contentFrom + lineStarts[clamped]
    return Math.max(contentFrom, Math.min(mapped, contentTo))
  }

  protected async renderInto(el: HTMLElement) {
    const fallback = () => {
      el.replaceChildren()
      const pre = document.createElement("pre")
      pre.textContent = this.src
      el.appendChild(pre)
    }
    fallback()
    try {
      const lang = resolveCodeLanguage(this.lang)
      if (!lang) return

      // 命中缓存：直接写入，跳过整个 Shiki 异步链路
      const cacheKey = `${lang}:${this.src}`
      if (htmlCache.has(cacheKey)) {
        if (this.isActive(el)) el.innerHTML = htmlCache.get(cacheKey)!
        return
      }

      // 性能底线：debounce 150ms。快速打字时 widget 在此期间被销毁（回到编辑态）
      // 则直接放弃，不启动 Shiki，避免阻塞主线程。
      await new Promise(r => setTimeout(r, RENDER_DEBOUNCE_MS))
      if (!this.isActive(el)) return

      const hl = await getHighlighter()
      if (!this.isActive(el)) return
      if (!hl.getLoadedLanguages().includes(lang)) {
        const grammar = await LANGUAGE_LOADERS[lang]()
        if (!this.isActive(el)) return
        await hl.loadLanguage(grammar.default as never)
        if (!this.isActive(el)) return
      }
      // Dual theme: light colors inline, dark via --shiki-dark* CSS variables
      // (mapped by the host stylesheet / export template).
      const html = hl.codeToHtml(this.src, {
        lang,
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: "light",
      })
      htmlCache.set(cacheKey, html)
      if (this.isActive(el)) el.innerHTML = html
    } catch {
      // 已有源码 fallback，异常时保持原状
    }
  }
}

function lineStartOffsets(src: string): number[] {
  if (src.length === 0) return [0]
  const offsets = [0]
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\n") offsets.push(i + 1)
  }
  return offsets
}
