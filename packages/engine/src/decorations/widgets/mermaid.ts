import { BlockWidget } from "../blockWidget"

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

  protected async renderInto(el: HTMLElement) {
    // spec 性能底线：mermaid 重编译 debounce 500ms。widget 只在文本稳定后渲染；
    // 若渲染前元素已被 CM 回收（继续打字 → 回到源码态），直接放弃。
    await new Promise(r => setTimeout(r, 500))
    if (!el.isConnected) return
    const mermaid = await getMermaid()
    if (!el.isConnected) return
    const { svg } = await mermaid.render(`omd-mmd-${++counter}`, this.src)
    if (el.isConnected) el.innerHTML = svg
  }
}
