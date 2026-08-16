import { BlockWidget, type BlockEmbed } from "../blockWidget"
import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { LANGUAGE_LOADERS, resolveCodeLanguage } from "../../shiki/languages"

// 渲染 debounce：快速打字时 widget 在此窗口内被销毁（回到编辑态）则放弃渲染。
const RENDER_DEBOUNCE_MS = 150

let highlighterPromise: Promise<HighlighterCore> | null = null

function getHighlighter(): Promise<HighlighterCore> {
  return highlighterPromise ??= import("shiki/themes/github-light.mjs").then(theme =>
    createHighlighterCore({
      themes: [theme.default],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    }))
}

// 模块级渲染缓存：lang:src → HTML 字符串。
// 相同内容的代码块命中缓存后直接写入，不重跑 Shiki。
// 主要受益场景：src 未变但因文档变化 widget 被重新实例化时（eq 已移除 pos，
// 此处作为双重保险）。
const htmlCache = new Map<string, string>()

export class CodeWidget extends BlockWidget {
  constructor(src: string, pos: number, readonly lang: string, embed?: BlockEmbed) {
    super(src, pos, embed)
  }
  eq(other: CodeWidget) { return super.eq(other) && this.lang === other.lang }

  protected get cssClass() { return "omd-code" }

  protected async renderInto(el: HTMLElement) {
    const fallback = () => {
      const pre = document.createElement("pre")
      pre.textContent = this.src
      el.appendChild(pre)
    }
    try {
      const lang = resolveCodeLanguage(this.lang)
      if (!lang) { fallback(); return }

      // 命中缓存：直接写入，跳过整个 Shiki 异步链路
      const cacheKey = `${lang}:${this.src}`
      if (htmlCache.has(cacheKey)) {
        if (this.isActive(el)) el.innerHTML = htmlCache.get(cacheKey)!
        return
      }

      // 性能底线：debounce 150ms。快速打字时 widget 在此期间被销毁（回到编辑态）
      // 则直接放弃，不启动 Shiki，避免阻塞主线程。
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
      const html = hl.codeToHtml(this.src, { lang, theme: "github-light" })
      htmlCache.set(cacheKey, html)
      if (this.isActive(el)) el.innerHTML = html
    } catch {
      if (this.isActive(el)) fallback()
    }
  }
}
