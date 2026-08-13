import { Facet } from "@codemirror/state"
import { WidgetType } from "@codemirror/view"

// 引擎不猜路径解析规则（http/data/相对路径/convertFileSrc 都是宿主的事），
// desktop 通过 facet 注入；缺省原样返回。
export const imageResolver = Facet.define<(src: string) => string, (src: string) => string>({
  combine: values => values[values.length - 1] ?? ((s: string) => s),
})

export class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly resolvedSrc: string) { super() }
  eq(other: ImageWidget) {
    return this.src === other.src &&
      this.alt === other.alt &&
      this.resolvedSrc === other.resolvedSrc
  }
  toDOM() {
    const img = document.createElement("img")
    img.src = this.resolvedSrc
    img.alt = this.alt
    img.className = "omd-image"
    img.onerror = () => {
      img.replaceWith(Object.assign(document.createElement("span"), {
        className: "omd-image-broken", textContent: `🖼 ${this.src}（加载失败）`,
      }))
    }
    return img
  }
}
