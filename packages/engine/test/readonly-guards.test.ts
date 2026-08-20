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

// Round 2：widget/paste 改写路径不经过 DOM 输入层（view 层的 readOnly 拦截只覆盖
// typed input / drop / paste 内建处理器），checkbox 点击、表格编辑、富文本粘贴都
// 直 dispatch 事务 —— 只读档必须逐一拒绝。
describe("widget and paste mutation paths refuse readonly docs", () => {
  // makeState 挂临时视图排空渐进装饰，拿到的 state 已含全部 widget 装饰，
  // 再用真实 EditorView 挂载让 widget DOM 真正渲染（htmlPaste 也随 editorExtensions 装配）。
  function mountDecorated(doc: string, readonly: boolean) {
    const state = makeState(doc, [
      ...(readonly ? [EditorState.readOnly.of(true)] : []),
      editorExtensions(),
    ])
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({ state, parent })
    return { view, cleanup: () => { view.destroy(); parent.remove() } }
  }

  const settle = () => new Promise(r => setTimeout(r, 20))

  it("checkbox widget renders disabled and its click never toggles the marker", () => {
    const doc = "intro\n\n- [x] done"
    const { view, cleanup } = mountDecorated(doc, true)
    const box = view.contentDOM.querySelector("input.omd-checkbox") as HTMLInputElement | null
    expect(box).toBeTruthy()
    expect(box!.disabled).toBe(true)
    // 程序化 click 绕过 disabled 的用户交互语义，直接验证 dispatch 守卫
    box!.dispatchEvent(new MouseEvent("click", { cancelable: true, bubbles: true }))
    expect(view.state.doc.toString()).toBe(doc)
    cleanup()
  })

  it("checkbox widget still toggles the marker when editable", () => {
    const { view, cleanup } = mountDecorated("intro\n\n- [x] done", false)
    const box = view.contentDOM.querySelector("input.omd-checkbox") as HTMLInputElement
    expect(box.disabled).toBe(false)
    box.dispatchEvent(new MouseEvent("click", { cancelable: true, bubbles: true }))
    expect(view.state.doc.toString()).toBe("intro\n\n- [ ] done")
    cleanup()
  })

  it("table widget disables edit affordances and toolbar clicks never dispatch", async () => {
    const doc = "intro\n\n| a | b |\n|---|---|\n| 1 | 2 |"
    const { view, cleanup } = mountDecorated(doc, true)
    await settle()  // renderInto 走微任务
    const wrap = view.contentDOM.querySelector(".omd-table")
    expect(wrap).toBeTruthy()
    expect(Array.from(wrap!.querySelectorAll<HTMLButtonElement>(".omd-table-toolbar button"))
      .every(btn => btn.disabled)).toBe(true)
    // 单元格 mousedown 不开行内编辑器
    wrap!.querySelector("td")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    expect(wrap!.querySelector("input.omd-table-edit")).toBeNull()
    // 程序化触发工具栏（disabled 只挡用户交互），源码不被改写
    const insertRow = wrap!.querySelector<HTMLButtonElement>("[data-act='insert-row']")!
    insertRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    insertRow.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    expect(view.state.doc.toString()).toBe(doc)
    cleanup()
  })

  // htmlPaste 的 domEventHandlers 先于 @codemirror/view 内建 paste 处理器运行，
  // 内建的 readOnly 分支到不了 —— 扩展自身必须消费事件并拒绝插入。
  function pasteEvent(html: string) {
    const data = new Map([
      ["text/html", html],
      ["text/plain", "plain"],
    ])
    const event = new Event("paste", { cancelable: true, bubbles: true })
    Object.defineProperty(event, "clipboardData", {
      value: { getData: (type: string) => data.get(type) ?? "" },
    })
    return event
  }

  it("rich paste is consumed but inserts nothing when readonly", async () => {
    const { view, cleanup } = mountDecorated("intro", true)
    const event = pasteEvent("<p><strong>bold</strong></p>")
    view.contentDOM.dispatchEvent(event)
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(view.state.doc.toString()).toBe("intro")
    cleanup()
  })

  it("rich paste still inserts markdown when editable", async () => {
    const { view, cleanup } = mountDecorated("intro", false)
    view.contentDOM.dispatchEvent(pasteEvent("<p><strong>bold</strong></p>"))
    await settle()
    expect(view.state.doc.toString()).toContain("**bold**")
    cleanup()
  })
})
