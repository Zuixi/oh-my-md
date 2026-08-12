import { BlockWidget } from "../blockWidget"
import type { Highlighter } from "shiki"

// 懒加载单例：第一次出现代码块时才下载/编译 shiki chunk，首屏不背体积
let highlighterPromise: Promise<Highlighter> | null = null
function getHighlighter(): Promise<Highlighter> {
  return highlighterPromise ??= import("shiki").then(m =>
    m.createHighlighter({
      themes: ["github-light"],
      langs: ["javascript", "typescript", "jsx", "tsx", "json", "html", "css",
              "python", "rust", "go", "java", "c", "cpp", "bash", "yaml",
              "toml", "markdown", "sql", "ruby", "php"],
    }))
}

export class CodeWidget extends BlockWidget {
  constructor(src: string, pos: number, readonly lang: string) { super(src, pos) }
  eq(other: CodeWidget) { return super.eq(other) && this.lang === other.lang }

  protected get cssClass() { return "omd-code" }

  protected async renderInto(el: HTMLElement) {
    try {
      const hl = await getHighlighter()
      const loaded = hl.getLoadedLanguages()
      const lang = loaded.includes(this.lang as never) ? this.lang : "text"
      el.innerHTML = hl.codeToHtml(this.src, { lang, theme: "github-light" })
    } catch {
      // shiki 加载失败降级为纯文本，不炸编辑器
      const pre = document.createElement("pre")
      pre.textContent = this.src
      el.appendChild(pre)
    }
  }
}
