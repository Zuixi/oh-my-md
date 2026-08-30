import type { EditorState } from "@codemirror/state"
import type { Decoration } from "@codemirror/view"

export interface DecoSpec { from: number; to: number; tag: string; deco: Decoration }

// 分工模型（路线 A，对齐 Typora）：装饰性标记（成对强调 `**`、标题 `#`、列表符）
// 永不因光标进入而展开 —— 点击/移动光标只是定位，行宽不抖动。标记的增删改走
// format/commands.ts 的切换命令，或在折叠边界 Backspace 整体删除原子区。
// nearCursor 仅保留给“唯一编辑入口就是源码本身”的语法（链接 URL、图片 src、
// 行内公式、脚注引用/定义）：光标落在其行上仍会展开。
// 行级判定避免字符边界的 off-by-one（如光标在 0 位也合法地算在 `# ` 标记行上）。
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
