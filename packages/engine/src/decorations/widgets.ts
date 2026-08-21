import { EditorView, WidgetType } from "@codemirror/view"
import { BlockWidget, type BlockEmbed } from "./blockWidget"

export class EntityWidget extends WidgetType {
  constructor(readonly ch: string, readonly raw: string) { super() }
  eq(other: EntityWidget) { return this.ch === other.ch && this.raw === other.raw }
  toDOM() {
    const el = document.createElement("span")
    el.className = "omd-entity"
    el.textContent = this.ch
    el.title = this.raw
    return el
  }
}

export class EmojiWidget extends WidgetType {
  constructor(readonly ch: string, readonly raw: string) { super() }
  eq(other: EmojiWidget) { return this.ch === other.ch && this.raw === other.raw }
  toDOM() {
    const el = document.createElement("span")
    el.className = "omd-emoji"
    el.textContent = this.ch
    el.title = this.raw
    return el
  }
}

export class BulletWidget extends WidgetType {
  eq() { return true }
  toDOM() {
    const el = document.createElement("span")
    el.textContent = "•"
    el.className = "omd-bullet"
    return el
  }
}

export class OrderedWidget extends WidgetType {
  constructor(readonly label: string) { super() }
  eq(other: OrderedWidget) { return this.label === other.label }
  toDOM() {
    const el = document.createElement("span")
    el.textContent = this.label
    el.className = "omd-ordered-mark"
    return el
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) { super() }
  eq(other: CheckboxWidget) {
    return this.checked === other.checked && this.pos === other.pos
  }
  toDOM(view: EditorView) {
    const el = document.createElement("input")
    el.type = "checkbox"
    el.checked = this.checked
    el.className = "omd-checkbox"
    // 只读档（HUGE Live 预览）禁用勾选 affordance；readOnly 建档时固定，无翻转路径。
    el.disabled = view.state.readOnly
    // prevent the editor from losing focus / moving the cursor on click
    el.addEventListener("mousedown", e => e.preventDefault())
    el.addEventListener("click", e => {
      e.preventDefault()
      const view = EditorView.findFromDOM(el.parentElement!)
      if (!view) return
      // readOnly 是建议性 facet：widget 点击直 dispatch 绕过输入拦截，必须显式拒绝
      // （disabled 只挡用户交互，程序化 click 仍可到达此处）。
      if (view.state.readOnly) return
      const from = view.posAtDOM(el), to = from + 3   // "[ ]" / "[x]" — TaskMarker is 3 chars
      const insert = this.checked ? "[ ]" : "[x]"
      view.dispatch({ changes: { from, to, insert } })
    })
    return el
  }
  ignoreEvent() { return false }
}

export class HrWidget extends BlockWidget {
  protected get cssClass() { return "omd-hr-block" }
  protected renderInto(el: HTMLElement) {
    el.appendChild(document.createElement("hr"))
  }
}

/** Collapsed YAML front matter chip; clicking (BlockWidget base) reveals source. */
export class FrontMatterWidget extends BlockWidget {
  private readonly lineCount: number
  constructor(src: string, pos: number, embed?: BlockEmbed) {
    super(src, pos, embed)
    this.lineCount = src.split("\n").length
  }
  protected get cssClass() { return "omd-front-matter" }
  protected renderInto(el: HTMLElement) {
    const chip = document.createElement("span")
    chip.className = "omd-front-matter-chip"
    chip.textContent = "YAML front matter"
    chip.title = `${this.lineCount} lines`
    el.appendChild(chip)
  }
}
