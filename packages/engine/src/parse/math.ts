import type { MarkdownConfig, MarkdownParser } from "@lezer/markdown"
import { CHAR_BACKSLASH, CHAR_DOLLAR, CHAR_NEWLINE, CHAR_SPACE } from "./chars"
import { isEscaped } from "./scan"

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
    // Not when the paragraph already has an unclosed `$$` ("text $$\nx\n$$ more"):
    // that line closes the run, and opening a block there would swallow to EOF.
    endLeaf(cx, line, leaf) {
      return line.text.slice(line.pos).startsWith("$$") && !hasOpenDisplayDollars(cx.parser, leaf.content)
    },
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
      if (next != CHAR_DOLLAR || isEscaped(cx, pos)) return -1  // 被转义的 $ 是字面量
      const after = cx.char(pos + 1)
      if (after == CHAR_DOLLAR || after == CHAR_SPACE || after == CHAR_NEWLINE) return -1  // $$ 或 "$ " 或行尾
      let i = pos + 1
      while (i < cx.end) {
        const c = cx.char(i)
        if (c == CHAR_NEWLINE) return -1
        if (c == CHAR_DOLLAR && !isEscaped(cx, i)) break  // 转义的 $ 留在内容里
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

/**
 * True when `text` has an unclosed `$$`. Backslash escapes skip the next
 * character, and `$$` inside a code span does not count: the parser decides
 * where code spans are (a span may cross lines or sit inside emphasis), so
 * `` `$$` `` followed by a `$$` line still opens the block.
 */
function hasOpenDisplayDollars(parser: MarkdownParser, text: string): boolean {
  if (!text.includes("$$")) return false
  const code: { from: number; to: number }[] = []
  parser.parse(text).iterate({
    enter: node => {
      if (node.name !== "InlineCode") return
      code.push({ from: node.from, to: node.to })
      return false
    },
  })
  let open = false
  for (let i = 0; i < text.length; i++) {
    const span = code.find(range => i >= range.from && i < range.to)
    if (span) { i = span.to - 1; continue }
    const c = text.charCodeAt(i)
    if (c == CHAR_BACKSLASH) { i++; continue }
    if (c == CHAR_DOLLAR && text.charCodeAt(i + 1) == CHAR_DOLLAR) {
      open = !open
      i++
    }
  }
  return open
}
