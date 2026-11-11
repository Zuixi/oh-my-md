const QUOTE_PREFIX_RE = /^(?:[ \t]{0,3}>[ \t]?)+/

function splitQuotePrefix(line: string): { prefix: string; body: string } {
  const m = QUOTE_PREFIX_RE.exec(line)
  if (!m) return { prefix: "", body: line }
  return { prefix: m[0], body: line.slice(m[0].length) }
}

function stripLineQuotePrefix(line: string, count: number): string {
  if (count <= 0) return line
  let rest = line
  for (let i = 0; i < count; i++) {
    const m = /^[ \t]{0,3}>[ \t]?/.exec(rest)
    if (!m) break
    rest = rest.slice(m[0].length)
  }
  return rest
}

function countQuoteMarkers(prefix: string): number {
  let count = 0
  for (const ch of prefix) if (ch === ">") count++
  return count
}

function inferInnerQuotePrefix(lines: string[], firstPrefix: string): string {
  if (firstPrefix) return firstPrefix
  for (let i = 1; i < lines.length; i++) {
    const { prefix } = splitQuotePrefix(lines[i])
    if (prefix) return prefix
  }
  return ""
}

export function mathTexOf(src: string): string {
  return mathEditorTexOf(src).trim()
}

/** rebuildMathSrc 的严格逆运算：编辑器路径专用，不吞围栏内侧空白（渲染用 mathTexOf）。
 *  Tab/缩进产生的前后空白必须往返一致，否则同步会把内层刚输入的内容回滚。
 *  引用块内的多行公式（`> $$\n> x+y\n> $$`；Lezer 节点切片首行自 `$$` 起，后续行带 `> `）逐行剥离外层引用前缀。 */
export function mathEditorTexOf(src: string): string {
  const lines = src.split("\n")
  if (lines.length >= 2) {
    const first = splitQuotePrefix(lines[0])
    const innerPrefix = inferInnerQuotePrefix(lines, first.prefix)
    const quoteDepth = countQuoteMarkers(innerPrefix)
    const lastBody = stripLineQuotePrefix(lines[lines.length - 1], quoteDepth).trimEnd()
    if (first.body === "$$" && lastBody === "$$") {
      return lines
        .slice(1, -1)
        .map(line => stripLineQuotePrefix(line, quoteDepth))
        .join("\n")
    }
  }
  const single = src.match(/^\$\$([\s\S]*)\$\$$/)
  return single ? single[1] : src.replace(/^\$\$|\$\$\s*$/g, "")
}

/** 按原分隔符形态重建块文本：原块含换行 → 多行包裹（保留原切片首行与内层行的引用前缀形态），否则单行包裹。 */
export function rebuildMathSrc(src: string, tex: string): string {
  if (!src.includes("\n")) return `$$${tex}$$`
  const lines = src.split("\n")
  const firstLine = lines[0]
  const first = splitQuotePrefix(firstLine)
  const innerPrefix = inferInnerQuotePrefix(lines, first.prefix)
  if (!innerPrefix) return `$$\n${tex}\n$$`
  const body = tex
    .split("\n")
    .map(line => `${innerPrefix}${line}`)
    .join("\n")
  return `${firstLine}\n${body}\n${innerPrefix}$$`
}
