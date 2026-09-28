// 行块前缀（缩进 + 逐级引用标记 + 列表标记 + 任务框）的树驱动抽取。
//
// 旧列表续写用一条正则 `^(\s*)((?:> )*)([-*+]|\d+[.)])...`，只能识别“先引用后
// 列表”的顺序，于是 `> text` 完全没有续写（Enter 掉出引用）、`- > text` 丢掉 `> `，
// 而引用 toggle 用 `startsWith("> ")` 判断，认不出 `>x` / `  > x` / `- > x`。
// 这里统一从 Lezer 树取段，语法知识留在解析层，`format/quotes.ts`（Enter 续写）与
// `format/commands.ts`（引用 toggle）共用同一份判定。
import type { EditorState, Line } from "@codemirror/state"
import { syntaxTree } from "@codemirror/language"

const MARK_NAMES = new Set(["QuoteMark", "ListMark", "TaskMarker"])

type MarkKind = "quote" | "list" | "task"

export interface BlockPrefixMark {
  readonly kind: MarkKind
  /** 标记原文 + 其后紧跟的空格/制表符（区间连续，拼起来即整行前缀）。 */
  readonly text: string
  readonly from: number
  /** 标记原文的绝对终点（不含其后的空白）。 */
  readonly markTo: number
  /** 段终点：标记 + 其后全部空白（续写前缀按段拼接，保持用户原有间距）。 */
  readonly to: number
}

export interface BlockPrefix {
  /** 首个标记之前的缩进（`  > x` 的两个空格；引用嵌套在列表里时为空）。 */
  readonly indent: string
  /** 行首到内容起点的原文（含每一级标记后的空格）。 */
  readonly text: string
  readonly marks: readonly BlockPrefixMark[]
  /** 最内层标记之后的内容是否为空（整行只有块前缀）。 */
  readonly blank: boolean
}

/**
 * 抽取当前行的块前缀（缩进 + 逐级引用标记 + 列表标记 + 任务框）。
 * 只认“从行首起、由标记与空白构成”的连续前缀：标记前出现正文即停止。
 * 语法树尚未覆盖该行时返回 null（调用方放行默认 Enter，不猜结构）。
 */
export function blockPrefixOf(state: EditorState, line: Line): BlockPrefix | null {
  const marks: { kind: MarkKind; from: number; to: number }[] = []
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: node => {
      if (node.from < line.from || node.to > line.to) return
      if (!MARK_NAMES.has(node.name)) return
      marks.push({
        kind: node.name === "QuoteMark" ? "quote" : node.name === "ListMark" ? "list" : "task",
        from: node.from,
        to: node.to,
      })
    },
  })
  if (marks.length === 0) return null
  marks.sort((a, b) => a.from - b.from)

  const segments: BlockPrefixMark[] = []
  let cursor = line.from
  for (const mark of marks) {
    if (mark.from < cursor) continue
    const gap = line.text.slice(cursor - line.from, mark.from - line.from)
    if (!/^[ \t]*$/.test(gap)) break
    let end = mark.to
    while (end < line.to) {
      const ch = line.text[end - line.from]
      if (ch !== " " && ch !== "\t") break
      end++
    }
    segments.push({ kind: mark.kind, text: line.text.slice(mark.from - line.from, end - line.from), from: mark.from, markTo: mark.to, to: end })
    cursor = end
  }
  if (segments.length === 0) return null
  return {
    indent: line.text.slice(0, segments[0].from - line.from),
    text: line.text.slice(0, cursor - line.from),
    marks: segments,
    blank: line.text.slice(cursor - line.from).trim() === "",
  }
}

/**
 * 删除某个标记的最小区间：标记本身 + 其后一个空格/制表符。
 * 多余的空白属于内容缩进（`  >   x` 去掉引用应为 `    x`），不能被一并吞掉。
 */
export function markRemovalRange(mark: BlockPrefixMark, line: Line): { from: number; to: number } {
  const after = line.text[mark.markTo - line.from]
  const extra = after === " " || after === "\t" ? 1 : 0
  return { from: mark.from, to: mark.markTo + extra }
}

/**
 * 续写前缀：先补回首个标记前的缩进，再逐段原样复制；只有两处按“新条目”语义
 * 改写 —— 有序列表 marker 递增（与 listKeymap 的 nextMarker 一致），任务框重置
 * 为未勾选。
 */
export function continuePrefixText(prefix: BlockPrefix): string {
  return prefix.indent + prefix.marks.map(mark => {
    if (mark.kind === "list") {
      const ordered = /^(\d+)([.)])[ \t]*$/.exec(mark.text)
      return ordered ? `${Number(ordered[1]) + 1}${ordered[2]} ` : mark.text
    }
    if (mark.kind === "task") return "[ ] "
    return mark.text
  }).join("")
}
