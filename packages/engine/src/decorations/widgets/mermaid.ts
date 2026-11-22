import type { EditorView } from "@codemirror/view"
import { BlockWidget } from "../blockWidget"
import { isInspectPointerEvent, mediaInspectHandler, trackInspectClick } from "../mediaInspect"
import { MERMAID_ESTIMATE_PX } from "../widgetHeights"
import { createMermaidSvgCache, instantiateCachedMermaidSvg } from "./mermaidSvgCache"

// spec 性能底线：mermaid 重编译 debounce。widget 只在文本稳定后渲染；
// 若渲染前 widget 已被 CM 销毁（继续打字 → 回到源码态），直接放弃。
const RENDER_DEBOUNCE_MS = 500

const svgCache = createMermaidSvgCache()

export function clearMermaidSvgCacheForTest(): void {
  svgCache.clear()
}

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null
function getMermaid() {
  return mermaidPromise ??= import("mermaid").then(m => {
    m.default.initialize({ startOnLoad: false, securityLevel: "strict" })
    return m.default
  })
}

let counter = 0

export class MermaidWidget extends BlockWidget {
  protected get cssClass() { return "omd-mermaid" }

  // 滚动性能：SVG 高度差异极大，取中位量级压过绘冲击；异步渲染完成后实测修正
  //（见 widgetHeights.ts 头注）。
  override get estimatedHeight() { return MERMAID_ESTIMATE_PX }

  protected override enterSourceOnClick(): boolean { return false }

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
          svg: currentSvg.outerHTML,
          source: this.src,
          editSource,
        })
      })
      return
    }
    this.moveCaretIntoSource(view, event, wrap)
  }

  protected renderPlaceholder(el: HTMLElement): boolean | void {
    const cached = svgCache.get(this.src)
    if (cached) {
      el.innerHTML = instantiateCachedMermaidSvg(cached, `omd-mmd-${++counter}`)
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
    // spec 性能底线：mermaid 重编译 debounce 500ms。widget 只在文本稳定后渲染；
    // 若渲染前 widget 已被 CM 销毁（继续打字 → 回到源码态），直接放弃。
    await new Promise(r => setTimeout(r, RENDER_DEBOUNCE_MS))
    if (!this.isActive(el)) return
    const mermaid = await getMermaid()
    if (!this.isActive(el)) return
    const id = `omd-mmd-${++counter}`
    const { svg } = await mermaid.render(id, this.src)
    svgCache.set(this.src, { id, svg })
    if (this.isActive(el)) {
      el.innerHTML = svg
      el.dataset.omdRender = "svg"
    }
  }
}
