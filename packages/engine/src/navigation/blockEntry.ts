import type { EditorState, Line } from "@codemirror/state"
import { Prec } from "@codemirror/state"
import { BlockType, EditorView, keymap, type Command } from "@codemirror/view"
import { openRenderedTableCell } from "../decorations/widgets/tableCellEdit"
import { tableDirectEditEnabled } from "../decorations/widgets/table"
import { blockPrefixOf } from "../format/blockPrefix"
import { beginTableEdit } from "../tables/directEdit"
import { cellAt, tableAt } from "../tables/navigate"
import { isTableSourceRevealed } from "../tables/sourceReveal"

/**
 * ↑/↓ 逐行进入渲染块。CM 的垂直移动对非文本块（block widget）是整块跳过
 * （posAtCoords 的 scanY 路径把 widget 块整体让开 —— discuss.codemirror.net/t/9491，
 * 作者建议自定义箭头命令覆盖）。非表格块进入即触发 blockSelected → widget
 * 卸载显源码，与鼠标点击同一条路径；离开后 widget 重新挂载。未展开源码的表格
 * 改为打开格子会话，文档选区停在 `table.from`。
 * Shift+↑/↓ 不拦截：跨块扩展选区应“盖过”渲染块（见 blockSelectionOverlay），
 * 而不是进源码。
 */

// 首行围栏：```ts / ~~~py / $$（含 0-3 缩进；info 串不得含 ` ~）
const OPEN_FENCE = /^\s{0,3}(?:(?:`{3,}|~{3,})[^`~]*|\$\$)\s*$/
// 末行围栏：闭合 ``` / ~~~ / $$（无内容）
const CLOSE_FENCE = /^\s{0,3}(?:`{3,}|~{3,}|\${2,})\s*$/

/** 行块前缀（引用/列表标记 + 后随空白）宽度；无前缀的行是 0。引用内的围栏行
 * 文本要先去掉它才认得出围栏，落点也要落在内容起点 —— 落在行首等于落进
 * QuoteMark 里，标记会因此展开、光标行露出裸 `> `（见 format/blockPrefix.ts）。 */
function prefixWidth(state: EditorState, line: Line): number {
  return blockPrefixOf(state, line)?.text.length ?? 0
}

/** 行内块边界 → 进入落点。向下落在第一个内容行（首行是围栏则跳过；表格首行是
 * 表头内容，不跳）；向上落在最后一个内容行（末行是闭合围栏则跳过）。
 * 单行退化块（---、$$x$$）：落回块首（边界含端，blockSelected 仍判块内）。
 * 引用/列表内的块与外部完全同构：围栏判定去掉行块前缀，落点再归到内容起点。 */
export function blockEntryPosition(
  state: EditorState,
  blockFrom: number,
  blockTo: number,
  dir: 1 | -1,
): number {
  const first = state.doc.lineAt(blockFrom)
  const last = state.doc.lineAt(blockTo - 1)
  const firstText = first.text.slice(prefixWidth(state, first))
  const lastText = last.text.slice(prefixWidth(state, last))
  let pos: number
  if (dir === 1) {
    if (last.number > first.number && OPEN_FENCE.test(firstText)) {
      pos = Math.min(first.to + 1, blockTo)
    } else {
      pos = Math.min(first.from, blockTo)
    }
  } else if (last.number > first.number && CLOSE_FENCE.test(lastText)) {
    pos = state.doc.lineAt(last.from - 1).from
  } else {
    pos = last.from
  }
  const line = state.doc.lineAt(pos)
  return line.from + prefixWidth(state, line)
}

// 段落和渲染块之间通常隔一个空行。空行本身不是目标，继续探到下一块；
// 探到有内容的文本行就停，交给普通逐行移动。
const BLANK_LINE_PROBES = 4

// 光标行相邻的目标块（向下 = 光标下方第一个块；向上 = 光标上方第一个块）。
// BlockInfo.type !== Text 即 widget 块（HeightMap 的 Widget/BlockWidget 类型）。
function adjacentWidgetBlock(view: EditorView, dir: 1 | -1): { from: number; to: number } | null {
  const head = view.state.selection.main.head
  const here = view.lineBlockAt(head)
  const rect = view.coordsAtPos(head)
  const line = view.defaultLineHeight
  const half = line / 2
  // elementAtHeight 的 y 相对文档顶。无布局宿主会给出不落在当前行上的坐标，
  // 那种结果改用高度图：半行越过当前行，和 rect.bottom + 半行 同一落点。
  const edge = rect ? (dir === 1 ? rect.bottom : rect.top) - view.documentTop : null
  const rectOnThisLine = edge !== null && edge >= here.top && edge <= here.top + here.height
  let y = rectOnThisLine
    ? edge + dir * half
    : dir === 1 ? here.top + here.height + half : here.top - half
  for (let probe = 0; probe < BLANK_LINE_PROBES && y >= 0; probe++) {
    const block = view.elementAtHeight(y)
    if (block.type !== BlockType.Text) {
      if (dir === 1 ? block.from <= head : block.to > head) return null
      return { from: block.from, to: block.to }
    }
    if (block.from !== block.to) return null
    y += dir * line
  }
  return null
}

/** GFM `Table` that is still rendered: open the entry cell instead of source. */
function enterRenderedTable(
  view: EditorView,
  block: { from: number; to: number },
  dir: 1 | -1,
): boolean {
  if (view.state.readOnly || !view.state.facet(tableDirectEditEnabled)) return false
  if (isTableSourceRevealed(view.state)) return false
  const probe = Math.min(block.from + 1, block.to)
  const table = tableAt(view.state, probe)
  if (!table || table.from !== block.from || table.to !== block.to) return false
  const hit = cellAt(view.state, blockEntryPosition(view.state, block.from, block.to, dir))
  if (!hit || hit.table.from !== table.from) return false
  view.dispatch({
    effects: beginTableEdit({
      tableFrom: table.from,
      tableTo: table.to,
      row: hit.slot.row,
      column: hit.slot.col,
      source: table.source,
    }),
    selection: { anchor: table.from },
    scrollIntoView: true,
  })
  openRenderedTableCell(view, table, hit.slot.row, hit.slot.col)
  return true
}

function enterBlock(dir: 1 | -1): Command {
  return view => {
    if (!view.state.selection.main.empty) return false
    const block = adjacentWidgetBlock(view, dir)
    if (!block) return false
    if (enterRenderedTable(view, block, dir)) return true
    const pos = blockEntryPosition(view.state, block.from, block.to, dir)
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
    return true
  }
}

/**
 * Prec.highest：与 caretClamp 的 ↑/↓ 同为 Prec.high 时，先注册的 caretClamp 会先跑
 * `cursorLineDown` 并整块跳过 widget。提到 highest 后，进入命令先决定是否进块；
 * 返回 false 时钳制命令仍然逐行移动。仅 Live 模式挂载（livePreviewCompartment）。
 */
export const blockMotionKeymap = Prec.highest(keymap.of([
  { key: "ArrowDown", run: enterBlock(1) },
  { key: "ArrowUp", run: enterBlock(-1) },
]))
