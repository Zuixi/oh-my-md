import { BlockWidget } from "../blockWidget"

// spec 性能底线：mermaid 重编译 debounce。widget 只在文本稳定后渲染；
// 若渲染前 widget 已被 CM 销毁（继续打字 → 回到源码态），直接放弃。
const RENDER_DEBOUNCE_MS = 500

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

  protected renderPlaceholder(el: HTMLElement) {
    const pre = document.createElement("pre")
    pre.className = "omd-block-placeholder"
    pre.textContent = this.src
    el.appendChild(pre)
  }

  protected async renderInto(el: HTMLElement) {
    // spec 性能底线：mermaid 重编译 debounce 500ms。widget 只在文本稳定后渲染；
    // 若渲染前 widget 已被 CM 销毁（继续打字 → 回到源码态），直接放弃。
    await new Promise(r => setTimeout(r, RENDER_DEBOUNCE_MS))
    if (!this.isActive(el)) return
    const mermaid = await getMermaid()
    if (!this.isActive(el)) return
    const { svg } = await mermaid.render(`omd-mmd-${++counter}`, this.src)
    if (this.isActive(el)) el.innerHTML = svg
  }
}
