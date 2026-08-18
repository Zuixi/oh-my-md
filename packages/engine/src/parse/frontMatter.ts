import type { MarkdownConfig } from "@lezer/markdown"

// 文档顶部的 `---\n…\n---\n` YAML front matter，按不透明块处理：
// 不校验 YAML 语法、不引入 YAML 依赖（规格 2026-08-18-25）。
// 只在文档第一行生效；thematic break 解析不会吃掉它（before: "HorizontalRule"）。
export const FrontMatter: MarkdownConfig = {
  defineNodes: [
    { name: "FrontMatter", block: true },
    "FrontMatterMark",
  ],
  parseBlock: [{
    name: "FrontMatter",
    before: "HorizontalRule",
    parse(cx, line) {
      // 仅文档开头（offset 0）识别；行内其他位置的 --- 仍是分隔线。
      if (cx.lineStart !== 0) return false
      if (line.text.slice(line.pos).trimEnd() !== "---") return false
      const start = cx.lineStart + line.pos
      const marks = [cx.elt("FrontMatterMark", start, start + 3)]

      // 吞到下一个 --- 行（含）；未闭合则整个块吞到 EOF（与 math 的容错一致）。
      while (cx.nextLine() && (line as unknown as { depth: number }).depth >= cx.depth) {
        const to = cx.lineStart + line.text.length
        if (line.text.trimEnd() === "---") {
          marks.push(cx.elt("FrontMatterMark", cx.lineStart, to))
          cx.nextLine()
          cx.addElement(cx.elt("FrontMatter", start, to, marks))
          return true
        }
      }
      const end = cx.lineStart + line.text.length
      cx.addElement(cx.elt("FrontMatter", start, end, marks))
      return true
    },
  }],
}
