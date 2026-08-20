import { describe, expect, it } from "vitest"
import { EditorState, type TransactionSpec } from "@codemirror/state"
import { EditorView, type Command } from "@codemirror/view"
import { forceParsing } from "@codemirror/language"
import { makeState } from "./helpers"
import {
  continueList,
  editorExtensions,
  getPendingOrderedListNormalization,
  indentList,
  outdentList,
  toggleBold,
} from "../src/index"

// Task 6 修复回归：readOnly facet 是建议性的 —— typed input 被 view 层忽略，
// 但 keymap 命令与 ViewPlugin 直接 dispatch 事务。HUGE 档只读 Live 文档挂满
// 引擎扩展，引擎自己的命令/重编号入口必须拒绝一切文档改写。

function readonlyState(doc: string, head: number) {
  return makeState(doc, [EditorState.readOnly.of(true)])
    .update({ selection: { anchor: head } })
    .state
}

/** headless Command 执行器（同 format.test.ts 的 run）：dispatch 捕获为文本改写。 */
function run(command: Command, state: EditorState): { handled: boolean; doc: string } {
  let doc = state.doc.toString()
  const target = {
    state,
    dispatch: (spec: TransactionSpec) => {
      doc = state.update(spec).state.doc.toString()
    },
  }
  return { handled: command(target as unknown as EditorView), doc }
}

describe("engine keymaps refuse to mutate readonly docs", () => {
  it("continueList (Enter) returns false and leaves the doc unchanged", () => {
    const result = run(continueList, readonlyState("- hello", 7))
    expect(result.handled).toBe(false)
    expect(result.doc).toBe("- hello")
  })

  it("indentList / outdentList (Tab / Shift-Tab) return false and leave the doc unchanged", () => {
    const state = readonlyState("  - hello", 9)
    expect(run(indentList, state)).toEqual({ handled: false, doc: "  - hello" })
    expect(run(outdentList, state)).toEqual({ handled: false, doc: "  - hello" })
  })

  it("markdownKeymap formatting (toggleBold) returns false and leaves the doc unchanged", () => {
    const result = run(toggleBold, readonlyState("hello world", 6))
    expect(result.handled).toBe(false)
    expect(result.doc).toBe("hello world")
  })

  // 非只读对照：同一命令在可编辑状态照常改写（守卫只拦只读路径）。
  it("keeps list continue and inline toggle working in editable docs", () => {
    const list = makeState("- hello").update({ selection: { anchor: 7 } }).state
    expect(run(continueList, list)).toEqual({ handled: true, doc: "- hello\n- " })
    const word = makeState("hello world").update({ selection: { anchor: 6 } }).state
    expect(run(toggleBold, word)).toEqual({ handled: true, doc: "hello **world**" })
  })
})

// orderedRenumber 挂在 livePreviewExt 里（Task 6 后只读档即 Live）：视口附近的
// 乱序标记在只读状态下必须原样保留 —— 不派发规范化事务、不产出 pending 通知。
describe("orderedRenumber skips readonly docs", () => {
  const STALE = "1. a\n3. b\n7. c"

  function mount(doc: string, readonly: boolean) {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const errors: unknown[] = []
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: 0 },
        extensions: [
          ...(readonly ? [EditorState.readOnly.of(true)] : []),
          editorExtensions(),
          EditorView.exceptionSink.of(e => { errors.push(e) }),
        ],
      }),
      parent,
    })
    return { view, errors, cleanup: () => { view.destroy(); parent.remove() } }
  }

  const tick = () => new Promise(r => setTimeout(r, 100))

  it("dispatches no normalization transaction and posts no notice when readonly", async () => {
    const { view, errors, cleanup } = mount(STALE, true)
    forceParsing(view, STALE.length, 10000)
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe(STALE)
    expect(getPendingOrderedListNormalization(view.state)).toBeNull()
    cleanup()
  })

  // 非只读对照：同文档同流程唯一变量是 readOnly —— 全树扫描照常重编号。
  it("still renumbers the same stale doc when editable", async () => {
    const { view, errors, cleanup } = mount(STALE, false)
    forceParsing(view, STALE.length, 10000)
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe("1. a\n2. b\n3. c")
    expect(getPendingOrderedListNormalization(view.state)?.markerCount).toBe(2)
    cleanup()
  })
})
