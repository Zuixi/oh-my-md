import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
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
// 每次翻转都会重建整块 DOM（设计使然：光标进块必须卸载 widget），且真实 Chromium 里强制 GC
// 后堆仍线性增长（100 → 1000 次翻转持续增长，`view.destroy()` 后仍留在堆上）。那条聚合增长
// **至今未解决、根因 inconclusive**：快照分析排除了 WeakMap ephemeron 边之后，采样到的
// retained island 里没有一条可证明的 OMD 强根路径。
//
// 已做过的一处修正只涉及所有权：`liveRanges` 曾是模块级 `Map`（DOM 作键，强引用每一个被
// 卸载的 wrap），现为 `WeakMap`。它**不是**内存修复 —— 改完聚合增长一点没变（实测
// afterDestroy/flips100 仍是 1.4096）。
//
// 前两条用例把“StateField 侧有界”钉死；第三条只是架构回归：缓存键必须可回收。
// 堆内存本身不适合做断言（依赖 GC 时机），需要实测时用：
//   PW_PORT=9438 pnpm --filter @omd/desktop audit:widget-memory
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

  // 架构回归：DOM 作键的缓存不能是模块级强引用。`Map` 用 DOM 作键会把每次翻转卸载掉的
  // wrap 钉在堆里（pre-change 快照：1000 个 detached 块 div 全部经由该 Map 可达），所以
  // `liveRanges` 必须是 `WeakMap`。`liveWraps` 不同：它按 widget 实例存 DOM、需要被遍历
  // 清扫，所以保持 `Map`。这条只守所有权，不守内存（聚合增长在换 WeakMap 之后仍复现）。
  it("keys the block-selection range cache weakly so it cannot pin dead widget DOM", () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/decorations/blockSelectionOverlay.ts"), "utf8")
    const rangesDecl = source.match(/const liveRanges = new [A-Za-z]+</)?.[0] ?? ""
    expect(rangesDecl).toBe("const liveRanges = new WeakMap<")
    expect(source).toContain("WeakMap<HTMLElement, { from: number; to: number }>")
    // liveWraps 仍需可遍历（清扫死 DOM 条目），不能跟着改弱。
    expect(source).toMatch(/const liveWraps = new Map<BlockWidget, HTMLElement>/)
  })
})

void makeState
