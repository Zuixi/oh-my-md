import type { EditorState } from "@codemirror/state"
import { Prec } from "@codemirror/state"
import { BlockType, EditorView, keymap, type Command } from "@codemirror/view"

/**
 * ↑/↓ 逐行进入渲染块。CM 的垂直移动对非文本块（block widget）是整块跳过
 * （posAtCoords 的 scanY 路径把 widget 块整体让开 —— discuss.codemirror.net/t/9491，
 * 作者建议自定义箭头命令覆盖）。进入即触发 blockSelected → widget 卸载显源码，
 * 与鼠标点击同一条路径；离开后 widget 重新挂载。
 * Shift+↑/↓ 不拦截：跨块扩展选区应“盖过”渲染块（见 blockSelectionOverlay），
 * 而不是进源码。
 */

// 首行围栏：```ts / ~~~py / $$（含 0-3 缩进；info 串不得含 ` ~）
const OPEN_FENCE = /^\s{0,3}(?:(?:`{3,}|~{3,})[^`~]*|\$\$)\s*$/
// 末行围栏：闭合 ``` / ~~~ / $$（无内容）
const CLOSE_FENCE = /^\s{0,3}(?:`{3,}|~{3,}|\${2,})\s*$/

/**
 * 块边界 → 进入落点。向下落在第一个内容行（首行是围栏则跳过；表格首行是
 * 表头内容，不跳）；向上落在最后一个内容行（末行是闭合围栏则跳过）。
 * 单行退化块（---、$$x$$）：落回块首（边界含端，blockSelected 仍判块内）。
 */
export function blockEntryPosition(
  state: EditorState,
  blockFrom: number,
  blockTo: number,
  dir: 1 | -1,
): number {
  const first = state.doc.lineAt(blockFrom)
  const last = state.doc.lineAt(blockTo - 1)
  if (dir === 1) {
    if (last.number > first.number && OPEN_FENCE.test(first.text))
      return Math.min(first.to + 1, blockTo)
    return Math.min(first.from, blockTo)
  }
  if (last.number > first.number && CLOSE_FENCE.test(last.text))
    return state.doc.lineAt(last.from - 1).from
  return last.from
}

// 光标行相邻的目标块（向下 = 光标下方第一个块；向上 = 光标上方第一个块）。
// BlockInfo.type !== Text 即 widget 块（HeightMap 的 Widget/BlockWidget 类型）。
function adjacentWidgetBlock(view: EditorView, dir: 1 | -1): { from: number; to: number } | null {
  const head = view.state.selection.main.head
  const rect = view.coordsAtPos(head)
  if (!rect) return null
  const half = view.defaultLineHeight / 2
  // elementAtHeight 的 y 相对文档顶（documentTop 是 client 坐标的文档顶）
  const y = (dir === 1 ? rect.bottom + half : rect.top - half) - view.documentTop
  if (y < 0) return null
  const block = view.elementAtHeight(y)
  if (block.type === BlockType.Text) return null
  if (dir === 1 ? block.from <= head : block.to > head) return null
  return { from: block.from, to: block.to }
}

function enterBlock(dir: 1 | -1): Command {
  return view => {
    if (!view.state.selection.main.empty) return false
    const block = adjacentWidgetBlock(view, dir)
    if (!block) return false
    const pos = blockEntryPosition(view.state, block.from, block.to, dir)
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
    return true
  }
}

/**
 * Prec.high：desktop 的 defaultKeymap 先于 editorExtensions() 注册，引擎键位
 * 必须显式提级才能赢（Enter/Tab 同例，format/lists.ts）。仅 Live 模式挂载
 * （livePreviewCompartment），Source 模式走默认逐行移动。
 */
export const blockMotionKeymap = Prec.high(keymap.of([
  { key: "ArrowDown", run: enterBlock(1) },
  { key: "ArrowUp", run: enterBlock(-1) },
]))
