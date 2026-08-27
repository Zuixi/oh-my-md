import { BlockWidget, type BlockEmbed } from "../blockWidget"
import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { LANGUAGE_LOADERS, resolveCodeLanguage, supportedLanguages } from "../../shiki/languages"
import { createCodeLangPicker } from "./codeLangPicker"
import { replaceFenceInfo } from "../../fenceInfo"
import { EditorView } from "@codemirror/view"
import {
  deferBlockRender, dropPendingBlockRender, type PendingRender, withinRenderBudget,
} from "../renderBudget"
import { blockWidgetRange, registerBlockWidget } from "../blockSelectionOverlay"
import { measureBlockWidget } from "../widgetMeasure"

const RENDER_DEBOUNCE_MS = 150
const DEFAULT_TITLE_PLACEHOLDER = "Code block"
const COPY_RESET_MS = 1500
const EMPTY_EMBED: BlockEmbed = { quoteDepth: 0, listDepth: 0, quoteInList: false }

let highlighterPromise: Promise<HighlighterCore> | null = null
const htmlCache = new Map<string, string>()

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

export interface CodeWidgetOptions {
  src: string
  pos: number
  lang: string
  title: string
  embed?: BlockEmbed
}

function blockWidgetClass(cssClass: string, embed: BlockEmbed): string {
  const classes = ["omd-block", cssClass]
  if (embed.quoteDepth > 0) classes.push("omd-blockquote", `omd-blockquote-${embed.quoteDepth}`)
  if (embed.listDepth > 0) {
    const nest = embed.quoteInList ? "omd-quote-in-li" : "omd-li"
    classes.push(`${nest}-${embed.listDepth}`)
  }
  return classes.join(" ")
}

function copyIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", "0 0 16 16")
  svg.setAttribute("width", "14")
  svg.setAttribute("height", "14")
  svg.setAttribute("aria-hidden", "true")
  const rear = document.createElementNS("http://www.w3.org/2000/svg", "rect")
  rear.setAttribute("x", "2")
  rear.setAttribute("y", "2")
  rear.setAttribute("width", "8")
  rear.setAttribute("height", "9")
  rear.setAttribute("rx", "1.2")
  rear.setAttribute("fill", "none")
  rear.setAttribute("stroke", "currentColor")
  rear.setAttribute("stroke-width", "1.4")
  const front = document.createElementNS("http://www.w3.org/2000/svg", "rect")
  front.setAttribute("x", "5")
  front.setAttribute("y", "5")
  front.setAttribute("width", "8")
  front.setAttribute("height", "9")
  front.setAttribute("rx", "1.2")
  front.setAttribute("fill", "none")
  front.setAttribute("stroke", "currentColor")
  front.setAttribute("stroke-width", "1.4")
  svg.append(rear, front)
  return svg
}

export class CodeWidget extends BlockWidget {
  private view: EditorView | undefined
  private wrap: HTMLDivElement | undefined
  private codePending: PendingRender | null = null
  private langPickerDestroy: (() => void) | null = null
  private copyReset: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: CodeWidgetOptions) {
    super(opts.src, opts.pos, opts.embed ?? EMPTY_EMBED)
  }

  get lang() { return this.opts.lang }
  get title() { return this.opts.title }

  eq(other: BlockWidget) {
    if (!(other instanceof CodeWidget)) return false
    return super.eq(other)
      && this.lang === other.lang
      && this.title === other.title
  }

  protected get cssClass() { return "omd-code" }
  protected enterSourceOnClick(): boolean { return false }

  override toDOM(view: EditorView) {
    this.view = view
    const wrap = document.createElement("div")
    this.wrap = wrap
    wrap.className = blockWidgetClass(this.cssClass, this.embed)

    wrap.appendChild(this.buildHeader(view))
    const body = document.createElement("div")
    body.className = "omd-block-body omd-code-body omd-code-lines"
    wrap.appendChild(body)

    this.renderPlaceholder(body)
    const start = () => Promise.resolve()
      .then(() => this.renderInto(body))
      .then(() => {
        if (!this.isActive(body)) return
        view.requestMeasure()
        if (typeof view.dispatch === "function") {
          const pos = blockWidgetRange(this, view, wrap)?.from ?? this.pos
          view.dispatch({ effects: measureBlockWidget.of({ pos }) })
        }
      })
      .catch(err => this.renderError(body, err, view))

    if (withinRenderBudget(view, this.pos)) start()
    else {
      this.codePending = { widget: this, view, pos: this.pos, start }
      deferBlockRender(this.codePending)
    }
    registerBlockWidget(this, wrap)
    return wrap
  }

  private buildHeader(view: EditorView): HTMLElement {
    const header = document.createElement("div")
    header.className = "omd-code-header"
    header.addEventListener("mousedown", e => e.stopPropagation())

    const titleInput = document.createElement("input")
    titleInput.type = "text"
    titleInput.className = "omd-code-title"
    titleInput.placeholder = DEFAULT_TITLE_PLACEHOLDER
    titleInput.value = this.title
    titleInput.spellcheck = false
    titleInput.addEventListener("change", () => this.commitInfo(titleInput.value, null))
    header.appendChild(titleInput)

    const tools = document.createElement("div")
    tools.className = "omd-code-tools"

    const resolved = resolveCodeLanguage(this.lang)
    const current = resolved ?? this.lang.trim().toLowerCase()
    const langPicker = createCodeLangPicker({
      value: current || this.lang.trim(),
      languages: supportedLanguages(),
      disabled: view.state?.readOnly,
      onSelect: lang => this.commitInfo(titleInput.value, lang),
    })
    this.langPickerDestroy = langPicker.destroy
    tools.appendChild(langPicker.root)

    const copyBtn = document.createElement("button")
    copyBtn.type = "button"
    copyBtn.className = "omd-code-copy"
    copyBtn.title = "Copy"
    copyBtn.setAttribute("aria-label", "Copy")
    copyBtn.appendChild(copyIcon())
    copyBtn.addEventListener("click", e => {
      e.preventDefault()
      e.stopPropagation()
      this.copy(copyBtn)
    })
    tools.appendChild(copyBtn)
    header.appendChild(tools)

    if (view.state?.readOnly) titleInput.disabled = true
    return header
  }

  override ignoreEvent(event: Event) {
    if (event.type === "mousedown" || event.type === "dblclick") return true
    if (event.target instanceof Element && event.target.closest(".omd-code-lang-picker")) return true
    return false
  }

  override destroy(dom?: HTMLElement) {
    if (this.copyReset) clearTimeout(this.copyReset)
    this.langPickerDestroy?.()
    this.langPickerDestroy = null
    if (this.codePending) dropPendingBlockRender(this.codePending)
    super.destroy(dom)
  }

  protected renderPlaceholder(el: HTMLElement) {
    const pre = document.createElement("pre")
    pre.textContent = this.src
    el.appendChild(pre)
  }

  protected async renderInto(el: HTMLElement) {
    await this.renderShiki(el)
  }

  private commitInfo(title: string, lang: string | null) {
    const view = this.view
    const wrap = this.wrap
    if (!view || !wrap || view.state.readOnly) return
    const range = blockWidgetRange(this, view, wrap)
    if (!range) return
    const nextLang = lang ?? this.lang
    const label = title.trim() === DEFAULT_TITLE_PLACEHOLDER ? "" : title.trim()
    const spec = replaceFenceInfo(view.state, range.from, nextLang, label)
    if (spec) view.dispatch(spec)
  }

  private copy(btn: HTMLButtonElement) {
    const mark = (ok: boolean) => {
      btn.classList.toggle("omd-code-copied", ok)
      btn.title = ok ? "Copied" : "Copy"
      btn.setAttribute("aria-label", ok ? "Copied" : "Copy")
      if (this.copyReset) clearTimeout(this.copyReset)
      this.copyReset = setTimeout(() => {
        btn.classList.remove("omd-code-copied")
        btn.title = "Copy"
        btn.setAttribute("aria-label", "Copy")
      }, COPY_RESET_MS)
    }
    const write = navigator.clipboard?.writeText(this.src)
    if (!write) {
      mark(false)
      return
    }
    void write.then(() => mark(true), () => mark(false))
  }

  private async renderShiki(el: HTMLElement) {
    el.replaceChildren()
    const pre = document.createElement("pre")
    pre.textContent = this.src
    el.appendChild(pre)
    try {
      const lang = resolveCodeLanguage(this.lang)
      if (!lang) return
      const cacheKey = `${lang}:${this.src}`
      if (htmlCache.has(cacheKey)) {
        if (this.isActive(el)) el.innerHTML = htmlCache.get(cacheKey)!
        return
      }
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
      const html = hl.codeToHtml(this.src, {
        lang,
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: "light",
      })
      htmlCache.set(cacheKey, html)
      if (this.isActive(el)) el.innerHTML = html
    } catch {
      // keep plain pre fallback
    }
  }

  private renderError(el: HTMLElement, err: unknown, view: EditorView) {
    if (!this.isActive(el)) return
    el.classList.add("omd-block-error")
    el.textContent = `⚠ ${err instanceof Error ? err.message : err}\n\n${this.src}`
    view.requestMeasure()
    if (typeof view.dispatch === "function") {
      const pos = blockWidgetRange(this, view, this.wrap!)?.from ?? this.pos
      view.dispatch({ effects: measureBlockWidget.of({ pos }) })
    }
  }
}
