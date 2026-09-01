import type { SyntaxNodeRef } from "@lezer/common"
import type { EditorState } from "@codemirror/state"
import { Decoration } from "@codemirror/view"
import { cursorInside, type DecoSpec } from "./types"
import { EntityWidget, EmojiWidget } from "./widgets"
import { InlineMathWidget } from "./widgets/math"
import { imageResolver, ImageWidget } from "./widgets/image"
import { decodeHtmlEntity } from "../parse/entities"
import { resolveEmoji } from "../parse/emoji"

const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: "omd-h1", ATXHeading2: "omd-h2", ATXHeading3: "omd-h3",
  ATXHeading4: "omd-h4", ATXHeading5: "omd-h5", ATXHeading6: "omd-h6",
  SetextHeading1: "omd-h1", SetextHeading2: "omd-h2",
}

function childMarks(node: SyntaxNodeRef, name: string): { from: number; to: number }[] {
  const marks: { from: number; to: number }[] = []
  const c = node.node.cursor()
  if (c.firstChild()) do { if (c.name === name) marks.push({ from: c.from, to: c.to }) } while (c.nextSibling())
  return marks
}

// 路线 A：成对强调标记无条件折叠 —— 光标进入不显源码（不闪行），
// 增删改走 format/commands.ts 的 toggle 命令或折叠边界 Backspace。
function foldPair(node: SyntaxNodeRef, out: DecoSpec[], markName: string, markClass: string) {
  const marks = childMarks(node, markName)
  if (marks.length >= 2) {
    for (const m of [marks[0], marks[marks.length - 1]])
      out.push({ from: m.from, to: m.to, tag: `replace:${markName}`, deco: Decoration.replace({}) })
  }
  out.push({ from: node.from, to: node.to, tag: `mark:${markClass}`, deco: Decoration.mark({ class: markClass }) })
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
      out.push({ from: m.from, to: m.to, tag: "replace:LinkMark", deco: Decoration.replace({}) })
    const c = node.node.cursor()
    if (c.firstChild()) do {
      if (node.name !== "Link") continue
      if (c.name === "URL")
        out.push({ from: c.from, to: c.to, tag: "replace:URL", deco: Decoration.replace({}) })
      // 标题（含引号）与其前的 URL 之间的分隔空白是裸文本，需一并吞掉，否则漏出到预览。
      if (c.name === "LinkTitle") {
        const line = state.doc.lineAt(c.from)
        let from = c.from
        while (from > line.from && /[ \t]/.test(state.doc.sliceString(from - 1, from))) from--
        out.push({ from, to: c.to, tag: "replace:LinkTitle", deco: Decoration.replace({}) })
      }
    } while (c.nextSibling())
  }
  out.push({ from: node.from, to: node.to, tag: "mark:omd-link", deco: Decoration.mark({ class: "omd-link" }) })
}

function isAnchorTag(state: EditorState, node: SyntaxNodeRef): boolean {
  if (node.name !== "HTMLTag") return false
  const raw = state.doc.sliceString(node.from, node.to)
  return /^<a\b[^>]*\bid\s*=\s*(['"])[^'"]+\1[^>]*>$/i.test(raw) || /^<\/a\s*>$/i.test(raw)
}

export function inlineRules(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]) {
  if (isAnchorTag(state, node) && !cursorInside(state, node.from, node.to)) {
    out.push({ from: node.from, to: node.to, tag: "replace:HTMLTag", deco: Decoration.replace({}) })
    return
  }

  const headingClass = HEADING_CLASS[node.name]
  if (headingClass) {
    out.push({
      from: node.from, to: node.from, tag: `line:${headingClass}`,
      deco: Decoration.line({ class: headingClass }),
    })

    const cursor = node.node.cursor()
    if (cursor.firstChild()) {
      do {
        if (cursor.name === "HeaderMark") {
          const line = state.doc.lineAt(cursor.from)
          const end = Math.min(cursor.to + 1, line.to)  // ATX: include trailing space after '#'
          // 路线 A：标题标记无条件折叠（含 Setext 下划线行）。
          // Setext underline is its own line; include the trailing newline so the empty
          // row collapses (replace across a line break must be block: true).
          if (line.from > node.from) {
            const to = Math.min(state.doc.length, line.to + 1)
            out.push({
              from: line.from, to, tag: "replace:HeaderMark",
              deco: Decoration.replace({ block: true }),
            })
          } else {
            out.push({ from: cursor.from, to: end, tag: "replace:HeaderMark", deco: Decoration.replace({}) })
          }
        }
      } while (cursor.nextSibling())
    }
    return
  }

  switch (node.name) {
    // 链接/图片/行内公式/脚注引用保留“光标进入 span 展开”（cursorInside，节点级）：
    // 其源码（URL、src、tex、id）没有其它编辑入口，展开是刻意的，但粒度是光标
    // 进入该语法自身，不是落行 —— 见 foldLink 注释与 types.ts 的分工说明。
    case "StrongEmphasis": return foldPair(node, out, "EmphasisMark", "omd-strong")
    case "Emphasis":       return foldPair(node, out, "EmphasisMark", "omd-em")
    case "Strikethrough":  return foldPair(node, out, "StrikethroughMark", "omd-del")
    case "Highlight":      return foldPair(node, out, "HighlightMark", "omd-highlight")
    case "Underline":      return foldPair(node, out, "UnderlineMark", "omd-u")
    case "Subscript":      return foldPair(node, out, "RiseMark", "omd-sub")
    case "Superscript":    return foldPair(node, out, "RiseMark", "omd-sup")
    case "InlineCode":     return foldPair(node, out, "CodeMark", "omd-inline-code")
    case "Link":
    case "Autolink":       return foldLink(node, state, out)
    case "Image": {
      if (cursorInside(state, node.from, node.to)) return
      const urlNode = node.node.getChild("URL")
      if (!urlNode) return
      const src = state.doc.sliceString(urlNode.from, urlNode.to)
      // alt 文本 = "![" 与 "](" 之间
      const head = state.doc.sliceString(node.from, urlNode.from)
      const altEnd = head.indexOf("](")
      const alt = altEnd > 1 ? head.slice(2, altEnd) : ""
      out.push({
        from: node.from, to: node.to, tag: "widget:image",
        deco: Decoration.replace({
          widget: new ImageWidget(src, alt, state.facet(imageResolver)(src)),
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
    case "FootnoteReference": {
      if (!cursorInside(state, node.from, node.to)) {
        out.push({ from: node.from, to: node.from + 2, tag: "replace:FootnoteMark", deco: Decoration.replace({}) })
        out.push({ from: node.to - 1, to: node.to, tag: "replace:FootnoteMark", deco: Decoration.replace({}) })
      }
      out.push({ from: node.from, to: node.to, tag: "mark:omd-footnote",
                 deco: Decoration.mark({ class: "omd-footnote" }) })
      return
    }
  }
}
