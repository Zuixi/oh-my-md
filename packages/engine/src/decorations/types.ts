import type { EditorState } from "@codemirror/state"
import type { Decoration } from "@codemirror/view"

export interface DecoSpec { from: number; to: number; tag: string; deco: Decoration }

// 分工模型（路线 A，对齐 Typora）：装饰性标记（成对强调 `**`、标题 `#`、列表符）
// 永不因光标进入而展开 —— 点击/移动光标只是定位，行宽不抖动。标记的增删改走
// format/commands.ts 的切换命令，或在折叠边界 Backspace 整体删除原子区。
// “唯一编辑入口就是源码本身”的语法（链接、图片、行内公式、脚注引用/定义）用
// cursorInside 做**节点级**展开：光标进入该语法自身的 span 才展开，落在同一行
// 的其它文本上不展开 —— 行级展开曾是点击闪烁的根源（软换行下一段=一行，点段
// 落任意文本都会把整段链接裸奔成 [text](url)）。且必须在节点整体级判定一次，
// 逐子节点判定会产出 `[text](` 半展开残缺态（光标在文字里时不在 URL span 内）。
// nearCursor 仅剩一个合法用途：空行密度（build.ts）—— 那里的判定单位本来就是
// “行”（光标自己的空行保持全高）。
export function nearCursor(state: EditorState, from: number, to: number) {
  const sel = state.selection.main
  if (!sel.empty) return false
  const cursorLine = state.doc.lineAt(sel.head)
  // The mark is on the same line as the cursor if their ranges overlap.
  return cursorLine.from <= to && cursorLine.to >= from
}

// Collapsed caret within [from, to) — start-boundary inclusive: typing the
// closing fence/mark leaves the caret exactly at `to`, which is "past" the
// mark (content side). Use this for quote markers and other marks that stay
// folded while editing the line. Non-caret selections return false: visual
// selection never reveals syntax.
export function cursorInside(state: EditorState, from: number, to: number): boolean {
  const { from: sf, to: st } = state.selection.main
  return sf === st && sf >= from && sf < to
}
