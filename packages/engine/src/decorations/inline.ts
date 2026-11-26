import type { SyntaxNodeRef } from "@lezer/common"
import type { EditorState } from "@codemirror/state"
import { Decoration } from "@codemirror/view"
import { cursorInside, type DecoSpec } from "./types"
import { EntityWidget, EmojiWidget } from "./widgets"
import { InlineMathWidget } from "./widgets/math"
import { imageResolver, ImageWidget } from "./widgets/image"
import { isEffectiveHeading } from "../semantic/heading"
import { imageParts } from "../semantic/image"
import { editorReferenceContext } from "../semantic/references"
import { escapeParts, hardBreakParts } from "../semantic/breaks"
import { decodeHtmlEntity } from "../parse/entities"
import { resolveEmoji } from "../parse/emoji"

const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: "omd-h1", ATXHeading2: "omd-h2", ATXHeading3: "omd-h3",
  ATXHeading4: "omd-h4", ATXHeading5: "omd-h5", ATXHeading6: "omd-h6",
  SetextHeading1: "omd-h1", SetextHeading2: "omd-h2",
}

// Hoisted stateless decorations: a dirty-range rebuild pushes one spec per folded
// mark / styled line, so building a fresh `Decoration.replace` / `mark` / `line` for
// each of them is pure allocation churn. The values are immutable — the generic
// no-options replace and one instance per class are safe to share across ranges.
const DECO_REPLACE_EMPTY = Decoration.replace({})
// Setext underlines are folded across their line break; a replace spanning a line
// break has to be block-level.
const DECO_REPLACE_BLOCK = Decoration.replace({ block: true })

interface HeadingLineDecos { readonly plain: Decoration; readonly active: Decoration }

const MARK_DECOS = new Map<string, Decoration>()
const HEADING_LINE_DECOS = new Map<string, HeadingLineDecos>()

/** One `Decoration.mark` per CSS class. */
function markDeco(cssClass: string): Decoration {
  const cached = MARK_DECOS.get(cssClass)
  if (cached) return cached
  const created = Decoration.mark({ class: cssClass })
  MARK_DECOS.set(cssClass, created)
  return created
}

/** One pair of heading line styles per level; the active one carries the level badge. */
function headingLineDecos(cssClass: string): HeadingLineDecos {
  const cached = HEADING_LINE_DECOS.get(cssClass)
  if (cached) return cached
  const created: HeadingLineDecos = {
    plain: Decoration.line({ class: cssClass }),
    active: Decoration.line({
      class: `${cssClass} omd-h-active`,
      attributes: { "data-omd-h": cssClass.slice(-1) },
    }),
  }
  HEADING_LINE_DECOS.set(cssClass, created)
  return created
}

function childMarks(node: SyntaxNodeRef, name: string): { from: number; to: number }[] {
  const marks: { from: number; to: number }[] = []
  const c = node.node.cursor()
  if (c.firstChild()) do { if (c.name === name) marks.push({ from: c.from, to: c.to }) } while (c.nextSibling())
  return marks
}

// 路线 A：成对强调标记无条件折叠 —— 光标进入不显源码（不闪行），
// 增删改走 format/commands.ts 导出的 toggle 命令或折叠边界 Backspace。
function foldPair(node: SyntaxNodeRef, out: DecoSpec[], markName: string, markClass: string) {
  const marks = childMarks(node, markName)
  if (marks.length >= 2) {
    for (const m of [marks[0], marks[marks.length - 1]])
      out.push({ from: m.from, to: m.to, tag: `replace:${markName}`, deco: DECO_REPLACE_EMPTY })
  }
  out.push({ from: node.from, to: node.to, tag: `mark:${markClass}`, deco: markDeco(markClass) })
}

// 展开/折叠的粒度必须是**语法节点整体**，绝不能逐子节点判定：光标在链接文字里时
// 在 LinkMark span 内但不在 URL span 内，逐子判定会产出 `[text](` 半展开残缺态。
// 链接 URL/图片 src/行内公式/脚注 id 的源码没有其它编辑入口，展开是刻意的；
// 粒度对齐 Typora/Obsidian：光标进入 span 才展开，落在同一行的其它文本上不展开
//（行级展开会让软换行段落里任意点击把整段链接裸奔成 [text](url)，即点击闪烁）。
function foldLink(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]) {
  const active = cursorInside(state, node.from, node.to)
  if (!active) {
    for (const m of childMarks(node, "LinkMark"))
      out.push({ from: m.from, to: m.to, tag: "replace:LinkMark", deco: DECO_REPLACE_EMPTY })
    const c = node.node.cursor()
    if (c.firstChild()) do {
      if (node.name !== "Link") continue
      if (c.name === "URL")
        out.push({ from: c.from, to: c.to, tag: "replace:URL", deco: DECO_REPLACE_EMPTY })
      // 标题（含引号）与其前的 URL 之间的分隔空白是裸文本，需一并吞掉，否则漏出到预览。
      if (c.name === "LinkTitle") {
        const line = state.doc.lineAt(c.from)
        let from = c.from
        while (from > line.from && /[ \t]/.test(state.doc.sliceString(from - 1, from))) from--
        out.push({ from, to: c.to, tag: "replace:LinkTitle", deco: DECO_REPLACE_EMPTY })
      }
    } while (c.nextSibling())
  }
  out.push({ from: node.from, to: node.to, tag: "mark:omd-link", deco: markDeco("omd-link") })
}

function isAnchorTag(state: EditorState, node: SyntaxNodeRef): boolean {
  if (node.name !== "HTMLTag") return false
  const raw = state.doc.sliceString(node.from, node.to)
  return /^<a\b[^>]*\bid\s*=\s*(['"])[^'"]+\1[^>]*>$/i.test(raw) || /^<\/a\s*>$/i.test(raw)
}

export function inlineRules(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]) {
  if (isAnchorTag(state, node) && !cursorInside(state, node.from, node.to)) {
    out.push({ from: node.from, to: node.to, tag: "replace:HTMLTag", deco: DECO_REPLACE_EMPTY })
    return
  }

  const headingClass = HEADING_CLASS[node.name]
  if (headingClass && isEffectiveHeading(node.node)) {
    // Overlay an H1..H6 level badge in the left gutter while the cursor is inside
    // the heading (`.omd-h-active::before` in styles.css); folded `#` marks leave
    // no other level cue, so the badge answers "which level?" only during editing.
    // Inclusive end (`node.to + 1`): clicking at the end of a heading (`head === node.to`)
    // still edits that heading.
    const active = cursorInside(state, node.from, node.to + 1)
    const classes = active ? `${headingClass} omd-h-active` : headingClass
    const lineDecos = headingLineDecos(headingClass)
    out.push({
      from: node.from, to: node.from, tag: `line:${classes}`,
      deco: active ? lineDecos.active : lineDecos.plain,
    })

    const cursor = node.node.cursor()
    if (cursor.firstChild()) {
      do {
        if (cursor.name === "HeaderMark") {
          const line = state.doc.lineAt(cursor.from)
          const end = Math.min(cursor.to + 1, line.to)  // ATX: include trailing space after '#'
          // ATX heading marks stay unconditionally folded; Setext underlines fold as a
          // block (including trailing newline) only when no selection overlaps the
          // underline line — block-replacing an active line collapses its DOM height to
          // 0px and forces CodeMirror's `inlineDOMNearPos` onto the title line.
          if (line.from > node.from) {
            const overlapsUnderline = state.selection.ranges.some(
              r => r.from <= line.to && r.to >= line.from,
            )
            if (!overlapsUnderline) {
              const to = Math.min(state.doc.length, line.to + 1)
              out.push({
                from: line.from, to, tag: "replace:HeaderMark", deco: DECO_REPLACE_BLOCK,
              })
            }
          } else {
            out.push({ from: cursor.from, to: end, tag: "replace:HeaderMark", deco: DECO_REPLACE_EMPTY })
          }
        }
      } while (cursor.nextSibling())
    }
    return
  }
  if (headingClass) return

  switch (node.name) {
    // 链接/图片/行内公式/脚注引用保留“光标进入 span 展开”（cursorInside，节点级）：
    // 其源码（URL、src、tex、id）没有其它编辑入口，展开是刻意的，但粒度是光标
    // 进入该语法自身，不是落行 —— 见 foldLink 注释与 types.ts 的分工说明。
    case "StrongEmphasis": return foldPair(node, out, "EmphasisMark", "omd-strong")
    case "Emphasis":       return foldPair(node, out, "EmphasisMark", "omd-em")
    case "Strikethrough":  return foldPair(node, out, "StrikethroughMark", "omd-del")
    case "Highlight":      return foldPair(node, out, "HighlightMark", "omd-highlight")
    case "Underline":      return foldPair(node, out, "UnderlineMark", "omd-u")
    case "Kbd":            return foldPair(node, out, "KbdMark", "omd-kbd")
    case "Subscript":      return foldPair(node, out, "RiseMark", "omd-sub")
    case "Superscript":    return foldPair(node, out, "RiseMark", "omd-sup")
    case "InlineCode":     return foldPair(node, out, "CodeMark", "omd-inline-code")
    case "Link":
    case "Autolink":       return foldLink(node, state, out)
    case "Image": {
      if (cursorInside(state, node.from, node.to)) return
      // 语义走 imageParts：inline 与引用式图片、格式化/实体 alt、title 同一个 accessor 给出。
      // 未解析的引用（没有定义）没有可用目标 —— 保留源码可见，绝不渲染空 widget。
      const parts = imageParts(node.node, editorReferenceContext(state))
      if (!parts) return
      out.push({
        from: node.from, to: node.to, tag: "widget:image",
        deco: Decoration.replace({
          widget: new ImageWidget(
            parts.src,
            parts.alt,
            state.facet(imageResolver)(parts.src),
            parts.title,
          ),
        }),
      })
      return
    }
    case "InlineMath": {
      if (cursorInside(state, node.from, node.to)) return
      // 剥掉两侧 $，内容为 node.from+1 .. node.to-1
      const tex = state.doc.sliceString(node.from + 1, node.to - 1)
      out.push({
        from: node.from, to: node.to, tag: "widget:inline-math",
        deco: Decoration.replace({ widget: new InlineMathWidget(tex) }),
      })
      return
    }
    case "Entity": {
      if (cursorInside(state, node.from, node.to)) return
      const raw = state.doc.sliceString(node.from, node.to)
      const ch = decodeHtmlEntity(raw)
      if (!ch) return
      out.push({
        from: node.from, to: node.to, tag: "widget:entity",
        deco: Decoration.replace({ widget: new EntityWidget(ch, raw) }),
      })
      return
    }
    case "Emoji": {
      if (cursorInside(state, node.from, node.to)) return
      const raw = state.doc.sliceString(node.from, node.to)
      const ch = resolveEmoji(raw.slice(1, -1))
      if (!ch) return
      out.push({
        from: node.from, to: node.to, tag: "widget:emoji",
        deco: Decoration.replace({ widget: new EmojiWidget(ch, raw) }),
      })
      return
    }
    // Escape/HardBreak 是「marker + 真实字符」的双段语义：只藏 marker（`\` / 行末
    // `\` / 行末空格），保留被转义字符与换行本身 —— 换行不是可折叠的语法标记，
    // 替换它会让两行在预览里并成一行。行末空格必须整段替换，否则预览行尾留空白。
    // 光标落在节点内（含行末换行符之前的空光标位）才展开 marker，供直接编辑；
    // 非空选区不算光标编辑（cursorInside 的约定）。
    case "Escape": {
      const parts = escapeParts(node.node)
      if (!parts || cursorInside(state, node.from, node.to)) return
      out.push({
        from: parts.markerFrom, to: parts.markerTo, tag: "replace:EscapeMark", deco: DECO_REPLACE_EMPTY,
      })
      return
    }
    case "HardBreak": {
      const parts = hardBreakParts(node.node, state.doc)
      if (!parts || cursorInside(state, node.from, node.to)) return
      // HardBreak 站点（marker + 换行）见 build.ts isAtomicSpec：该 tag 永不原子化。
      out.push({
        from: parts.markerFrom, to: parts.markerTo, tag: "replace:HardBreakMark", deco: DECO_REPLACE_EMPTY,
      })
      return
    }
    case "FootnoteReference": {
      if (!cursorInside(state, node.from, node.to)) {
        out.push({ from: node.from, to: node.from + 2, tag: "replace:FootnoteMark", deco: DECO_REPLACE_EMPTY })
        out.push({ from: node.to - 1, to: node.to, tag: "replace:FootnoteMark", deco: DECO_REPLACE_EMPTY })
      }
      out.push({ from: node.from, to: node.to, tag: "mark:omd-footnote",
                 deco: markDeco("omd-footnote") })
      return
    }
  }
}
