import type { EditorView } from "@codemirror/view"
import { BlockWidget } from "../blockWidget"
import { isInspectPointerEvent, mediaInspectHandler, trackInspectClick } from "../mediaInspect"
import { MERMAID_ESTIMATE_PX } from "../widgetHeights"
import {
  clearMermaidSvgCache,
  getCachedMermaidSvg,
  nextMermaidId,
  renderMermaidSvg,
  subscribeDocumentMermaidTheme,
  type MermaidTheme,
} from "../../mermaid/renderer"
import { instantiateCachedMermaidSvg } from "./mermaidSvgCache"

// Short settle window so rapid cursor sweeps across blocks skip redundant
// Mermaid parses, while document open and scroll render responsively.
const RENDER_DEBOUNCE_MS = 80

export function clearMermaidSvgCacheForTest(): void {
  clearMermaidSvgCache()
}

export class MermaidWidget extends BlockWidget {
  private unsubTheme: (() => void) | null = null
  private renderVersion = 0

  protected get cssClass() { return "omd-mermaid" }

  // SVG heights vary widely across diagram types; use a median estimate until
  // async rendering completes and triggers a real height measure.
  override get estimatedHeight() { return MERMAID_ESTIMATE_PX }

  protected override enterSourceOnClick(): boolean { return false }

  override toDOM(view: EditorView) {
    const wrap = super.toDOM(view)
    this.unsubTheme?.()
    this.unsubTheme = subscribeDocumentMermaidTheme(theme => {
      if (!this.isActive() || this.currentDom !== wrap || !wrap.isConnected) return
      const body = wrap.querySelector<HTMLElement>(".omd-block-body")
      if (!body) return
      void this.rerenderForTheme(view, wrap, body, theme)
    })
    return wrap
  }

  override destroy(dom?: HTMLElement) {
    super.destroy(dom)
    if (!this.isActive()) {
      this.unsubTheme?.()
      this.unsubTheme = null
    }
  }

  protected override onWrapClick(view: EditorView, wrap: HTMLElement, event: MouseEvent): void {
    const handler = view.state?.facet(mediaInspectHandler) ?? null
    const body = wrap.querySelector<HTMLElement>(".omd-block-body")
    const svgEl = body?.dataset.omdRender === "svg" ? body.querySelector("svg") : null
    if (handler && svgEl && isInspectPointerEvent(event)) {
      trackInspectClick(event, () => {
        if (!wrap.isConnected || !view.dom?.isConnected) return
        const currentSvg = body?.dataset.omdRender === "svg" ? body.querySelector("svg") : null
        if (!currentSvg) return
        const editSource = view.state.readOnly ? undefined : () => {
          if (!wrap.isConnected || !view.dom?.isConnected) return
          this.moveCaretIntoSource(view, event, wrap)
        }
        handler({
          kind: "mermaid",
          source: this.src,
          editSource,
        })
      })
      return
    }
    this.moveCaretIntoSource(view, event, wrap)
  }

  protected renderPlaceholder(el: HTMLElement): boolean | void {
    const cached = getCachedMermaidSvg(this.src)
    if (cached) {
      el.innerHTML = instantiateCachedMermaidSvg(cached, nextMermaidId())
      el.dataset.omdRender = "svg"
      return true
    }
    const pre = document.createElement("pre")
    pre.className = "omd-block-placeholder"
    pre.textContent = this.src
    el.appendChild(pre)
    el.dataset.omdRender = "placeholder"
  }

  protected async renderInto(el: HTMLElement) {
    const version = ++this.renderVersion
    await new Promise(r => setTimeout(r, RENDER_DEBOUNCE_MS))
    if (!this.isActive(el) || this.renderVersion !== version) return
    const id = nextMermaidId()
    const rendered = await renderMermaidSvg(this.src, { id, useCache: true })
    if (!this.isActive(el) || this.renderVersion !== version) return
    el.innerHTML = rendered.id === id
      ? rendered.svg
      : instantiateCachedMermaidSvg({ id: rendered.id, svg: rendered.svg }, id)
    rendered.bindFunctions?.(el)
    el.dataset.omdRender = "svg"
  }

  private async rerenderForTheme(
    view: EditorView,
    wrap: HTMLElement,
    body: HTMLElement,
    theme: MermaidTheme,
  ): Promise<void> {
    const version = ++this.renderVersion
    const cached = getCachedMermaidSvg(this.src, theme)
    if (cached) {
      body.classList.remove("omd-block-error")
      body.innerHTML = instantiateCachedMermaidSvg(cached, nextMermaidId())
      body.dataset.omdRender = "svg"
      view.requestMeasure()
      return
    }
    try {
      const id = nextMermaidId()
      const rendered = await renderMermaidSvg(this.src, { id, theme, useCache: true })
      if (!this.isActive(body) || this.currentDom !== wrap || this.renderVersion !== version) return
      body.classList.remove("omd-block-error")
      body.innerHTML = rendered.id === id
        ? rendered.svg
        : instantiateCachedMermaidSvg({ id: rendered.id, svg: rendered.svg }, id)
      rendered.bindFunctions?.(body)
      body.dataset.omdRender = "svg"
      view.requestMeasure()
    } catch {
      // Keep the existing diagram visible if a background theme re-render fails.
    }
  }
}
