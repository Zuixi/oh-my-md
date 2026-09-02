import { Prec, type EditorState, type TransactionSpec } from "@codemirror/state"
import { keymap, type Command } from "@codemirror/view"
import { syntaxTree } from "@codemirror/language"

// Typora 语义：在尚未闭合的围栏行（FencedCode 仅覆盖 opening 行）行尾按 Enter，
// 自动补全闭合围栏并把光标落在内容行 —— “``` / ```lang + Enter 得到完整代码块，
// 光标在块内等待编辑”。围栏字符与长度取自 CodeMark 原文（``` 与 ~~~、更长 run
// 各自闭合）。引用/列表内的围栏不劫持 Enter（known-gotchas 的嵌入坐标约束），
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
  let node = syntaxTree(state).resolveInner(line.from, 1)
  while (node && node.name !== "FencedCode") {
    if (!node.parent) return null
    node = node.parent
  }
  if (!node || node.from !== line.from) return null
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
    if (parent.name === "Blockquote" || parent.name === "ListItem") return null
  }
  const mark = node.getChild("CodeMark")
  if (!mark) return null
  return { line, closing: state.doc.sliceString(mark.from, mark.to) }
}

export function continueFenceSpec(state: EditorState): TransactionSpec | null {
  const found = unclosedFenceLine(state)
  if (!found) return null
  const at = found.line.to
  return {
    changes: { from: at, insert: `\n\n${found.closing}` },
    selection: { anchor: at + 1 },
    scrollIntoView: true,
  }
}

export const continueFence = dispatchSpec(continueFenceSpec)

// 与 listKeymap 同级（Prec.high）：desktop 的 defaultKeymap 先注册，Enter 默认
// 绑定必须显式提级才能赢（见 format/lists.ts）。fence 行不匹配列表 LINE 正则，
// 两者条件互斥，顺序无关。
export const fenceKeymap = Prec.high(keymap.of([
  { key: "Enter", run: continueFence },
]))
