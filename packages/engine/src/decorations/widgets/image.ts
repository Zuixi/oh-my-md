import { Facet } from "@codemirror/state"
import { EditorView, WidgetType } from "@codemirror/view"

// 引擎不猜路径解析规则（http/data/相对路径/convertFileSrc 都是宿主的事），
// desktop 通过 facet 注入；缺省原样返回。
export const imageResolver = Facet.define<(src: string) => string, (src: string) => string>({
  combine: values => values[values.length - 1] ?? ((s: string) => s),
})

// 缺省文案保持原样（🖼 ${src}（加载失败）），以便现有 view 测试与回归不破。
// Desktop 通过 EngineOptions.imageBrokenLabel 注入本地化文案。
export const defaultBroken = (src: string) => `🖼 ${src}（加载失败）`

export const imageBrokenLabel = Facet.define<(src: string) => string, (src: string) => string>({
  combine: values => values[values.length - 1] ?? defaultBroken,
})

export class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly resolvedSrc: string) { super() }
  eq(other: ImageWidget) {
    return this.src === other.src &&
      this.alt === other.alt &&
      this.resolvedSrc === other.resolvedSrc
  }
  toDOM(view: EditorView) {
    const img = document.createElement("img")
    img.src = this.resolvedSrc
    img.alt = this.alt
    img.className = "omd-image"
    img.onerror = () => {
      const label = view.state.facet(imageBrokenLabel)(this.src)
      img.replaceWith(Object.assign(document.createElement("span"), {
        className: "omd-image-broken", textContent: label,
      }))
    }
    return img
  }
}
