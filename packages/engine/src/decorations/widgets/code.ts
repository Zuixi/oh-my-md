import { BlockWidget, type BlockEmbed } from "../blockWidget"
import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { LANGUAGE_LOADERS, resolveCodeLanguage, supportedLanguages } from "../../shiki/languages"
import { createCodeLangPicker } from "./codeLangPicker"
import { formatFenceInfo } from "../../fenceInfo"
import { EditorView } from "@codemirror/view"
import {
  deferBlockRender, dropPendingBlockRender, type PendingRender, withinRenderBudget,
} from "../renderBudget"
import { blockWidgetRange, registerBlockWidget } from "../blockSelectionOverlay"
import { measureBlockWidget } from "../widgetMeasure"

const RENDER_DEBOUNCE_MS = 150
const EDIT_DISPATCH_MS = 120
const DEFAULT_TITLE_PLACEHOLDER = "Code block"
const EMPTY_EMBED: BlockEmbed = { quoteDepth: 0, listDepth: 0, quoteInList: false }

let highlighterPromise: Promise<HighlighterCore> | null = null
const htmlCache = new Map<string, string>()
const pendingEditCaret = new Map<number, number>()

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
  infoFrom: number
  infoTo: number
  contentFrom: number
  contentTo: number
  embed?: BlockEmbed
  editing: boolean
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

function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return 0
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer)) return 0
  const pre = range.cloneRange()
  pre.selectNodeContents(el)
  pre.setEnd(range.startContainer, range.startOffset)
  return pre.toString().length
}

function setCaretOffset(el: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let remaining = offset
  let node = walker.nextNode()
  while (node) {
    const len = node.textContent?.length ?? 0
    if (remaining <= len) {
      const range = document.createRange()
      range.setStart(node, remaining)
      range.collapse(true)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      return
    }
    remaining -= len
    node = walker.nextNode()
  }
}

export class CodeWidget extends BlockWidget {
  private view: EditorView | undefined
  private wrap: HTMLDivElement | undefined
  private codePending: PendingRender | null = null
  private editTimer: ReturnType<typeof setTimeout> | null = null
  private langPickerDestroy: (() => void) | null = null

  constructor(private readonly opts: CodeWidgetOptions) {
    super(opts.src, opts.pos, opts.embed ?? EMPTY_EMBED)
  }

  static fromOptions(opts: CodeWidgetOptions): CodeWidget {
    return new CodeWidget(opts)
  }

  get lang() { return this.opts.lang }
  get title() { return this.opts.title }
  get infoFrom() { return this.opts.infoFrom }
  get infoTo() { return this.opts.infoTo }
  get contentFrom() { return this.opts.contentFrom }
  get contentTo() { return this.opts.contentTo }
  get editing() { return this.opts.editing }

  eq(other: BlockWidget) {
    if (!(other instanceof CodeWidget)) return false
    return super.eq(other)
      && this.lang === other.lang
      && this.title === other.title
      && this.editing === other.editing
  }

  protected get cssClass() { return "omd-code" }
  protected enterSourceOnClick(): boolean { return false }

  override toDOM(view: EditorView) {
    this.view = view
    const wrap = document.createElement("div")
    this.wrap = wrap
    wrap.className = blockWidgetClass(this.cssClass, this.embed)
    if (this.editing) wrap.classList.add("omd-code-editing")

    wrap.appendChild(this.buildHeader(view))
    const body = document.createElement("div")
    body.className = "omd-block-body omd-code-body omd-code-lines"
    wrap.appendChild(body)

    wrap.addEventListener("mousedown", e => {
      if (e.button !== 0) return
      if (e.target instanceof Element && e.target.closest(".omd-code-header")) return
      view.focus()
      if (this.editing) {
        e.preventDefault()
        const edit = body.querySelector(".omd-code-edit-line") as HTMLElement | null
        edit?.focus()
      }
    })

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
    copyBtn.title = "Copy code"
    copyBtn.setAttribute("aria-label", "Copy code")
    copyBtn.textContent = "Copy"
    copyBtn.addEventListener("click", e => {
      e.preventDefault()
      e.stopPropagation()
      void navigator.clipboard?.writeText(this.src)
    })
    tools.appendChild(copyBtn)
    header.appendChild(tools)

    if (view.state?.readOnly) {
      titleInput.disabled = true
    }
    return header
  }

  override ignoreEvent(event: Event) {
    if (event.type === "mousedown" || event.type === "dblclick") return true
    if (event.target instanceof Element && event.target.closest(".omd-code-lang-picker")) return true
    if (this.editing && (event.type === "keydown" || event.type === "input")) return true
    return false
  }

  override destroy(dom?: HTMLElement) {
    if (this.editTimer) clearTimeout(this.editTimer)
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
    if (this.editing) {
      this.renderEditor(el)
      return
    }
    await this.renderShiki(el)
  }

  private renderEditor(el: HTMLElement) {
    el.replaceChildren()
    const lines = this.src.split("\n")
    const rowEls: HTMLElement[] = []
    for (const line of lines.length ? lines : [""]) {
      const row = document.createElement("div")
      row.className = "omd-code-edit-line"
      row.contentEditable = "true"
      row.spellcheck = false
      row.textContent = line
      row.addEventListener("mousedown", e => e.stopPropagation())
      row.addEventListener("input", () => this.scheduleContentSync(rowEls))
      row.addEventListener("blur", () => this.flushContentSync(rowEls))
      el.appendChild(row)
      rowEls.push(row)
    }
    const restore = pendingEditCaret.get(this.pos)
    const focusRow = rowEls[0]
    if (focusRow) {
      focusRow.focus()
      if (restore !== undefined) {
        pendingEditCaret.delete(this.pos)
        setCaretOffset(focusRow, restore)
      } else {
        setCaretOffset(focusRow, focusRow.textContent?.length ?? 0)
      }
    }
  }

  private readEditorText(rows: HTMLElement[]): string {
    return rows.map(row => row.textContent ?? "").join("\n")
  }

  private scheduleContentSync(rows: HTMLElement[]) {
    if (this.editTimer) clearTimeout(this.editTimer)
    this.editTimer = setTimeout(() => this.flushContentSync(rows), EDIT_DISPATCH_MS)
  }

  private flushContentSync(rows: HTMLElement[]) {
    if (this.editTimer) {
      clearTimeout(this.editTimer)
      this.editTimer = null
    }
    const view = this.view
    if (!view || view.state.readOnly) return
    const next = this.readEditorText(rows)
    if (next === this.src) return
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    pendingEditCaret.set(this.pos, active ? caretOffset(active) : 0)
    view.dispatch({
      changes: { from: this.contentFrom, to: this.contentTo, insert: next },
    })
  }

  private commitInfo(title: string, lang: string | null) {
    const view = this.view
    if (!view || view.state.readOnly) return
    const nextLang = lang ?? this.lang
    const label = title.trim() === DEFAULT_TITLE_PLACEHOLDER ? "" : title.trim()
    const info = formatFenceInfo(nextLang, label)
    view.dispatch({
      changes: { from: this.infoFrom, to: this.infoTo, insert: info },
    })
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
