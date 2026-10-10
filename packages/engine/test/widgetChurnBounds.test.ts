import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { describe, expect, it } from "vitest"
// 先经 helpers→build 进入模块图（既有 ESM 环，见 tableUpdateDOM.test.ts 注释）。
import { makeState } from "./helpers"
import { editorExtensions } from "../src/index"
import { livePreviewField } from "../src/decorations/build"
import { BlockWidget } from "../src/decorations/blockWidget"
import { CodeWidget } from "../src/decorations/widgets/code"

// 块 widget 在"渲染态 ↔ 选中态"之间反复翻转时，**引擎自己的状态必须有界**。
//
// 背景（见 docs/memory/gotchas-engine.md「块 widget 反复挂载/卸载会持续占用内存」）：
// 每次翻转都会重建整块 DOM（设计使然：光标进块必须卸载 widget），但强制 GC 后堆仍线性
// 增长（实测 2000 次翻转 ≈ +1.8GB，且 view.destroy() 后不回收）—— 保留者不在引擎侧：
// specs/deco/pending/atomic 与 blockSelectionOverlay 注册表全程有界。
//
// 这条用例把"引擎侧有界"钉死：无论保留者在哪，先保证不是我们的状态在涨。堆内存本身
// 不适合做断言（依赖 GC 时机），需要实测时用：
//   NODE_OPTIONS=--expose-gc pnpm --filter @omd/engine exec vitest run <复现脚本>
// 复现文档见本文件注释与 gotcha 条目。

const rows = Array.from({ length: 12 }, (_, i) => `> | r${i}a | r${i}b |`).join("\n")
const QUOTED_TABLE = `> | a | b |\n> |---|---|\n${rows}\n\npara`
const FENCE = "> ```js\n> const a = 1\n> ```\n\npara"

describe("block widget churn keeps engine state bounded", () => {
  it("does not grow specs / deco / pending across repeated render-source flips", () => {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({ doc: QUOTED_TABLE, selection: { anchor: 0 }, extensions: [editorExtensions()] }),
      parent,
    })
    const sizes = () => {
      const field = view.state.field(livePreviewField, false)
      return {
        specs: field?.specs.length ?? -1,
        deco: field?.deco.size ?? -1,
        pending: field?.pending.length ?? -1,
        atomic: field?.atomic.size ?? -1,
      }
    }
    const before = sizes()
    for (let i = 0; i < 400; i++) {
      view.dispatch({ selection: { anchor: i % 2 === 0 ? QUOTED_TABLE.length : 0 } })
    }
    expect(sizes()).toEqual(before)
    view.destroy()
    parent.remove()
  })

  it("rebuilds the widget DOM once per flip (churn is expected, not a leak in state)", () => {
    let toDOM = 0
    // CodeWidget 自建 wrap（不走 super.toDOM），因此拦它自己的原型。
    const originalToDOM = CodeWidget.prototype.toDOM
    CodeWidget.prototype.toDOM = function (this: CodeWidget, view) { toDOM++; return originalToDOM.call(this, view) }

    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({ doc: FENCE, selection: { anchor: FENCE.length }, extensions: [editorExtensions()] }),
      parent,
    })
    toDOM = 0
    // 在块外（渲染态）与块内（编辑态）之间来回：每次翻转都会重建一次 DOM
    const inside = FENCE.indexOf("const a") + 2
    for (let i = 0; i < 50; i++) {
      view.dispatch({ selection: { anchor: i % 2 === 0 ? FENCE.length : inside } })
    }
    expect(toDOM).toBeGreaterThanOrEqual(20)
    expect(toDOM).toBeLessThanOrEqual(60)
    view.destroy()
    parent.remove()
    CodeWidget.prototype.toDOM = originalToDOM
  })
})

void makeState
