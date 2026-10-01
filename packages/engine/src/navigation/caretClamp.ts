import { cursorLineDown, cursorLineUp, selectLineDown, selectLineUp } from "@codemirror/commands"
import { Prec, type EditorState } from "@codemirror/state"
import { EditorView, keymap, type Command } from "@codemirror/view"
import { blockPrefixOf, clampToContentStart, lineContentStart } from "../format/blockPrefix"

// 光标不得落进折叠的行块前缀（`> ` / `> - ` / `- [ ] `）。
//
// 为什么需要：前缀被 `Decoration.replace` 折叠，但 `cursorInside` 规定「光标进入标记
// 范围就展开」（invariant 10，用于让用户能改标记）。于是点击引用行的最左侧（或 Home）
// 把光标放在 `line.from` = 前缀内部 → 标记展开 → 用户打的字插在 `>` **左边**，视觉上
// 就是「`>` 被推着一直往后跑」（实测 `abc> `）。
//
// 为什么不用 atomicRanges：仓库不变式明确禁止行首/跨行原子（会破坏跨行选择与拖选
// 端点，见 atomicRanges 三规则）。所以钳制放在事件与命令层：点击落点、Home、
// ↑/↓ 竖直移动三条入口，落进前缀就归到内容起点。
//
// 刻意不做的事：不拦截「光标已在标记内继续打字」—— 显式进入标记内部改标记是合法
// 操作（Source 模式、命令、精确导航都能到达）。这里只堵住**误入**的三条路径。

/** 把 selection 的 head 钳到内容起点（保留 anchor，兼容 Shift 选择）。 */
function clampHead(state: EditorState): { anchor: number; head: number } | null {
  const sel = state.selection.main
  const head = clampToContentStart(state, sel.head)
  return head === sel.head ? null : { anchor: sel.anchor, head }
}

function dispatchClamp(view: EditorView): boolean {
  const next = clampHead(view.state)
  if (!next) return false
  view.dispatch({ selection: { anchor: next.anchor, head: next.head } })
  return true
}

/**
 * Home / Shift-Home：行首落点归到内容起点；无前缀的行放行宿主行为。
 * `extend` 保留原锚点（折叠光标也变成选择），与宿主 selectLineBoundaryBackward 同语义。
 */
const homeToContentStart = (extend: boolean): Command => view => {
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.head)
  if (blockPrefixOf(view.state, line) === null) return false
  const start = lineContentStart(view.state, line)
  if (sel.head === start) return true
  view.dispatch(extend
    ? { selection: { anchor: sel.empty ? sel.head : sel.anchor, head: start } }
    : { selection: { anchor: start } })
  return true
}

/** ↑/↓（含 Shift 变体）：先跑宿主竖直移动，落点若进了前缀再钳回内容起点。 */
function clampAfter(run: Command): Command {
  return view => {
    if (!run(view)) return false
    dispatchClamp(view)
    return true
  }
}

export const caretClampKeymap = Prec.high(keymap.of([
  { key: "Home", run: homeToContentStart(false) },
  { key: "Shift-Home", run: homeToContentStart(true) },
  { key: "ArrowUp", run: clampAfter(cursorLineUp) },
  { key: "Shift-ArrowUp", run: clampAfter(selectLineUp) },
  { key: "ArrowDown", run: clampAfter(cursorLineDown) },
  { key: "Shift-ArrowDown", run: clampAfter(selectLineDown) },
]))

/**
 * 点击钳制。只在「命中的位置确实落在折叠前缀内」时接管（行最左端的窄条），其余
 * 点击一律返回 false 交还 CodeMirror —— 拖选、双击选词、块内点击都不受影响。
 */
export const caretClampHandlers = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || event.detail > 1) return false
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos == null) return false
    const target = clampToContentStart(view.state, pos)
    if (target === pos) return false
    event.preventDefault()
    const sel = view.state.selection.main
    view.dispatch({ selection: { anchor: event.shiftKey ? sel.anchor : target, head: target } })
    view.focus()
    return true
  },
})
