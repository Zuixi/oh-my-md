import { Prec, type EditorState, type TransactionSpec } from "@codemirror/state"
import { keymap, type Command } from "@codemirror/view"
import { syntaxTree } from "@codemirror/language"

// Typora 语义：在尚未闭合的围栏行（FencedCode 仅覆盖 opening 行）行尾按 Enter，
// 自动补全闭合围栏并把光标落在内容行 —— “``` / ```lang + Enter 得到完整代码块，
// 光标在块内等待编辑”。围栏字符与长度取自 CodeMark 原文（``` 与 ~~~、更长 run
// 各自闭合）。围栏行上 CodeMark 之前的原文（引用前缀 `> ` / 缩进）原样续写到内容
// 行与闭合行，因此引用内的围栏同样补全（`> ```js` → `> ```js\n> \n> ````）；
// 列表内的围栏仍不劫持（列表缩进语义未定义：内容行该缩进几格没有正确答案）。
// 其余不满足条件的行一律放行默认 Enter。

function dispatchSpec(spec: (state: EditorState) => TransactionSpec | null): Command {
  return target => {
    if (target.state.readOnly) return false
    const result = spec(target.state)
    if (!result) return false
    target.dispatch(result)
    return true
  }
}

function unclosedFenceLine(state: EditorState) {
  const main = state.selection.main
  if (!main.empty) return null
  const { head } = main
  const line = state.doc.lineAt(head)
  if (head !== line.to) return null
  // 从行尾向前一字符解析：`> ```js` 这类行上 line.from 落在 QuoteMark 里，从那里
  // 向上只会撞到 Blockquote/文档根，永远找不到 FencedCode（引用内/缩进围栏因此
  // 一直补全不了）。行尾前一个字符必定在围栏节点内部。
  let node = syntaxTree(state).resolveInner(Math.max(line.from, line.to - 1), 1)
  while (node && node.name !== "FencedCode") {
    if (!node.parent) return null
    node = node.parent
  }
  // 围栏必须从本行开始（引用/缩进前缀不算节点内容）：内容行的行尾同样命中同一个
  // FencedCode（node.from 在更早的行上），必须排除，否则正文行尾按 Enter 会补围栏。
  if (!node || node.from < line.from || node.from > line.to) return null
  // 未闭合 ⇔ FencedCode 只有一个 CodeMark（开头）。不能用“节点不越过本行”
  // 判定：CommonMark 把未闭合围栏吞到文档末尾，文档中间输入 ```cpp 时下方
  // 文字全在节点内，旧守卫会永远拦截（用户只能裸敲源码）。闭合后下方文字
  // 自动回到块后成为普通段落；完整块的围栏行（两个 CodeMark）照旧不劫持。
  let markCount = 0
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeMark") markCount++
  }
  if (markCount !== 1) return null
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "ListItem") return null
  }
  const mark = node.getChild("CodeMark")
  if (!mark || mark.from < line.from || mark.to > line.to) return null
  return {
    line,
    closing: state.doc.sliceString(mark.from, mark.to),
    // CodeMark 之前的原文：引用前缀 / 缩进，续写时逐行照抄。
    prefix: state.doc.sliceString(line.from, mark.from),
  }
}

export function continueFenceSpec(state: EditorState): TransactionSpec | null {
  const found = unclosedFenceLine(state)
  if (!found) return null
  const at = found.line.to
  return {
    changes: { from: at, insert: `\n${found.prefix}\n${found.prefix}${found.closing}` },
    selection: { anchor: at + 1 + found.prefix.length },
    scrollIntoView: true,
  }
}

export const continueFence = dispatchSpec(continueFenceSpec)

/** 光标所在行是否是“正在输入、尚未闭合”的围栏行（quoteKeymap 用它让位）。 */
export function isUnclosedFenceLine(state: EditorState): boolean {
  return unclosedFenceLine(state) !== null
}

// 与 listKeymap/quoteKeymap 同级（Prec.high）：desktop 的 defaultKeymap 先注册，
// Enter 默认绑定必须显式提级才能赢（见 format/lists.ts）。quoteKeymap 用
// isUnclosedFenceLine 主动让位，三者条件互斥，注册顺序无关。
export const fenceKeymap = Prec.high(keymap.of([
  { key: "Enter", run: continueFence },
]))
