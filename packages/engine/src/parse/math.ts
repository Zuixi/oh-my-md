import type { MarkdownConfig } from "@lezer/markdown"
import { CHAR_DOLLAR, CHAR_NEWLINE, CHAR_SPACE } from "./chars"

// ponytail: 只支持 $$...$$ 与 $...$（不支持 \[...\] / \(...\)）；未闭合的 $$
// 块吞到 EOF（katex widget 会显示错误+原文）。行间规则仿 footnotes.ts。
export const Math: MarkdownConfig = {
  defineNodes: [
    { name: "MathBlock", block: true },
    "MathMark",
    "InlineMath",
  ],
  parseBlock: [{
    name: "MathBlock",
    before: "FencedCode",   // $$ 行没有其他主人，尽早接管
    parse(cx, line) {
      const rest = line.text.slice(line.pos)
      if (!rest.startsWith("$$")) return false
      const start = cx.lineStart + line.pos
      const marks = [cx.elt("MathMark", start, start + 2)]
      let to = cx.lineStart + line.text.length

      const after = rest.slice(2)
      const closeIdx = after.indexOf("$$")
      if (closeIdx >= 0) {
        // 单行形式 $$...$$
        marks.push(cx.elt("MathMark", start + 2 + closeIdx, start + 2 + closeIdx + 2))
        cx.addElement(cx.elt("MathBlock", start, to, marks))
        cx.nextLine()
        return true
      }
      // 多行：吞到以 $$ 结尾的行（含该行）
      // Line.depth 运行时存在但类型缺失（同 footnotes.ts 的 cast）
      while (cx.nextLine() && (line as unknown as { depth: number }).depth >= cx.depth) {
        to = cx.lineStart + line.text.length
        const trimmed = line.text.trimEnd()
        if (trimmed.endsWith("$$")) {
          marks.push(cx.elt("MathMark", cx.lineStart + trimmed.length - 2, cx.lineStart + trimmed.length))
          cx.nextLine()
          break
        }
      }
      cx.addElement(cx.elt("MathBlock", start, to, marks))
      return true
    },
  }],
  parseInline: [{
    name: "InlineMath",
    before: "Link",
    parse(cx, next, pos) {
      if (next != CHAR_DOLLAR) return -1
      const after = cx.char(pos + 1)
      if (after == CHAR_DOLLAR || after == CHAR_SPACE || after == CHAR_NEWLINE) return -1  // $$ 或 "$ " 或行尾
      let i = pos + 1
      while (i < cx.end && cx.char(i) != CHAR_DOLLAR) {
        if (cx.char(i) == CHAR_NEWLINE) return -1
        i++
      }
      if (i == pos + 1 || i >= cx.end || cx.char(i - 1) == CHAR_SPACE) return -1  // 空/未闭合/"x $"
      return cx.addElement(cx.elt("InlineMath", pos, i + 1, [
        cx.elt("MathMark", pos, pos + 1),
        cx.elt("MathMark", i, i + 1),
      ]))
    },
  }],
}
