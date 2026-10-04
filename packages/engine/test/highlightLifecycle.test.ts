import { EditorView } from "@codemirror/view"
import { describe, expect, it } from "vitest"
// 先经 helpers→build 进入模块图（既有 ESM 环，见 tableUpdateDOM.test.ts 注释）。
import { makeState } from "./helpers"
import { CodeWidget } from "../src/decorations/widgets/code"

// 「实例退役」与「tile 丢弃」必须分开 —— 这是引用内代码块在文档首块时永久停在
// 同步占位（丢 Shiki 高亮）的最终根因。
//
// 真实时序（真浏览器插桩实测）：
//   toDOM#1 → toDOM#2（同一实例被重新挂到新 tile）→ destroy(旧 tile) → 两次异步渲染
// 其中第二次渲染的 DOM 已经在文档里（elConnected=true），却因为 destroy 把 alive
// 置 false 而被 `isActive()` 拒绝 → 占位 <pre> 永久保留、无任何报错。
//
// 这些用例直接驱动生命周期（happy-dom 不会自发产生该 tile 轮换）。

const SHARED_SRC = "const lifecycleProbe = 1"

function view(doc: string) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  // makeState 同时负责把装饰层模块图按正确顺序引入（既有 ESM 环）。
  const v = new EditorView({ state: makeState(doc), parent })
  return { view: v, cleanup: () => { v.destroy(); parent.remove() } }
}

function widget(src: string, lang: string, pos: number) {
  return new CodeWidget({ src, pos, lang, title: "", embed: { quoteDepth: 0, listDepth: 0, quoteInList: false } })
}

const flush = async (ms = 30) => { await new Promise(r => setTimeout(r, ms)) }

describe("async widget render vs tile lifetime", () => {
  it("a revived instance keeps rendering after a stale tile's destroy arrives out of order", async () => {
    // 预热高亮缓存：同一 src/lang 第一次真实渲染后，后续实例走 cache-hit 快路径，
    // 断言因此只依赖生命周期判据，不依赖 Shiki 的耗时。
    const warm = view("```js\n" + SHARED_SRC + "\n```")
    const warmWidget = widget(SHARED_SRC, "js", 0)
    const warmWrap = warmWidget.toDOM(warm.view)
    await flush(400)   // debounce(150ms) + shiki 动态加载
    expect((warmWrap.querySelector(".omd-code-body") as HTMLElement).dataset.omdHighlight).toBe("shiki")
    warmWidget.destroy(warmWrap)
    warm.cleanup()

    // 目标实例：模拟 CM 的 tile 轮换 + 乱序 destroy
    const { view: v, cleanup } = view("```js\n" + SHARED_SRC + "\n```")
    const w = widget(SHARED_SRC, "js", 0)
    const wrap1 = w.toDOM(v)
    const wrap2 = w.toDOM(v)                      // 同一实例重新 toDOM（重新激活）
    w.destroy(wrap1)                              // 旧 tile 的 destroy 晚于第二次 toDOM
    expect(w.isActive()).toBe(true)               // ← 修复点：不得杀死已重新挂载的实例

    await flush()
    const body2 = wrap2.querySelector(".omd-code-body") as HTMLElement
    expect(body2.dataset.omdHighlight).toBe("shiki")
    expect(body2.querySelector("pre.shiki")).toBeTruthy()
    cleanup()
  })

  it("retires the instance when its current DOM is the one discarded", () => {
    const { view: v, cleanup } = view("```js\nconst x = 1\n```")
    const w = widget("const x = 1", "js", 0)
    const wrap = w.toDOM(v)
    expect(w.isActive()).toBe(true)
    w.destroy(wrap)                  // 当前 DOM 被丢弃 = 实例退役
    expect(w.isActive()).toBe(false)
    cleanup()
  })

  it("treats a destroy without a DOM as retirement", () => {
    const { view: v, cleanup } = view("```js\nconst y = 1\n```")
    const w = widget("const y = 1", "js", 0)
    w.toDOM(v)
    w.destroy()
    expect(w.isActive()).toBe(false)
    cleanup()
  })
})
