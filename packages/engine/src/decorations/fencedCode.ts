import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common"
import type { EditorState } from "@codemirror/state"
import { Decoration } from "@codemirror/view"
import {
  cursorInside,
  lineDeco,
  REPLACE_BLOCK,
  REPLACE_MARK,
  styleLines,
  type DecoSpec,
} from "./types"
import { blockSelected, type BlockEmbed } from "./blockWidget"
import { CodeChromeWidget, CodeWidget } from "./widgets/code"
import { MermaidWidget } from "./widgets/mermaid"
import { parseFenceInfo } from "../fenceInfo"
import { blockPrefixOf } from "../format/blockPrefix"

function fencedCodeSource(node: SyntaxNode, state: EditorState): string {
  const parts: string[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeText") parts.push(state.doc.sliceString(child.from, child.to))
  }
  return parts.join("")
}

export function styleCodeblockLines(node: SyntaxNodeRef, state: EditorState, out: DecoSpec[]): void {
  styleLines(state, out, node.from, node.to, "line:omd-codeblock", "omd-codeblock")
}

// Active code-block decoration: replace the opening fence line with `CodeChromeWidget`
// (editable language/title header), add line numbers and container classes to content
// lines, and collapse the closing fence line across its trailing newline. If the caret
// overlaps either fence line, leave that fence line as plain editable source text.
function styleEditingCodeblock(
  node: SyntaxNodeRef,
  state: EditorState,
  out: DecoSpec[],
  langToken: string,
  title: string,
  embed: BlockEmbed,
): void {
  const doc = state.doc
  const sel = state.selection.main
  const overlaps = (from: number, to: number) => sel.from <= to && sel.to >= from
  const openLine = doc.lineAt(node.from)
  // Locate the real closing `CodeMark`: unclosed fences extend to EOF (CommonMark),
  // so treating `lineAt(node.to)` as the closing fence would swallow the last code line.
  let closeMark: SyntaxNode | null = null
  for (let child = node.node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeMark" && child.from > openLine.to) closeMark = child
  }
  const closeLine = closeMark ? doc.lineAt(closeMark.from) : null
  const firstContent = openLine.number + 1
  const lastContent = closeLine ? closeLine.number - 1 : doc.lineAt(node.to).number

  // Block-replace the opening fence line (excluding its newline): inline replace leaves
  // the body line-height strut and creates an unstyled gap above the first code line,
  // whereas including the newline would absorb the first content line's line decorations.
  if ((closeLine || firstContent <= lastContent) && !overlaps(openLine.from, openLine.to)) {
    out.push({
      from: openLine.from,
      to: openLine.to,
      tag: "widget:block:code-chrome",
      deco: Decoration.replace({ widget: new CodeChromeWidget(langToken, title, undefined, embed), block: true }),
    })
  }
  for (let number = firstContent; number <= lastContent; number++) {
    const line = doc.line(number)
    // Inside blockquotes, `> ` marks on content lines are children of `FencedCode`.
    // Because returning `true` skips the `FencedCode` subtree, fold quote marks here
    // using the same Route A `cursorInside` rule as `foldQuoteMark`. Outside quotes,
    // skip `blockPrefixOf` (`syntaxTree.iterate`) on the typing hot path.
    if (embed.quoteDepth > 0) {
      const prefix = blockPrefixOf(state, line)
      for (const mark of prefix?.marks ?? []) {
        if (mark.kind !== "quote" || cursorInside(state, mark.from, mark.to)) continue
        out.push({ from: mark.from, to: mark.to, tag: "replace:QuoteMark", deco: REPLACE_MARK })
      }
    }
    out.push({
      from: line.from, to: line.from, tag: "line:omd-codeblock", deco: lineDeco("omd-codeblock"),
    })
    out.push({
      from: line.from, to: line.from, tag: "line:omd-codeblock-num", deco: lineDeco("omd-codeblock-num"),
    })
    if (number === firstContent) {
      out.push({
        from: line.from,
        to: line.from,
        tag: "line:omd-codeblock-num-first",
        deco: lineDeco("omd-codeblock-num-first"),
      })
    }
    if (number === lastContent) {
      out.push({
        from: line.from,
        to: line.from,
        tag: "line:omd-codeblock-num-last",
        deco: lineDeco("omd-codeblock-num-last"),
      })
    }
  }
  if (closeLine && !overlaps(closeLine.from, closeLine.to)) {
    out.push({
      from: closeLine.from,
      to: Math.min(doc.length, closeLine.to + 1),
      tag: "replace:CloseFence",
      deco: REPLACE_BLOCK,
    })
  }
}

export function foldFenceMark(
  node: SyntaxNodeRef,
  state: EditorState,
  out: DecoSpec[],
  name: string,
): void {
  if (cursorInside(state, node.from, node.to)) return
  out.push({
    from: node.from, to: node.to, tag: `replace:${name}`, deco: REPLACE_MARK,
  })
}

export function styleFencedCode(
  node: SyntaxNodeRef,
  state: EditorState,
  out: DecoSpec[],
  embed: BlockEmbed,
): boolean {
  const infoNode = node.node.getChild("CodeInfo")
  const infoRaw = infoNode ? state.doc.sliceString(infoNode.from, infoNode.to) : ""
  const { lang: langToken, title } = parseFenceInfo(infoRaw)
  // Fence info preserves the author's case; language resolution (Shiki, export)
  // is case-insensitive, so `Mermaid` must match export and render as a diagram.
  const isMermaid = langToken.toLowerCase() === "mermaid"

  // Single-line unclosed opening fence with the caret still on it: keep plain text
  // until Enter completes the block (`format/fences.ts`), matching Typora.
  const singleLine = state.doc.lineAt(node.from).number === state.doc.lineAt(node.to).number
  const selected = blockSelected(state, node.from, node.to)
  if (singleLine && selected) {
    return true
  }

  // `fencedCodeSource` runs only on widget branches so editing inside a large code
  // block never slices the entire body on each keystroke.
  if (isMermaid && !selected) {
    out.push({
      from: node.from,
      to: node.to,
      tag: "widget:block:mermaid",
      deco: Decoration.replace({
        widget: new MermaidWidget(fencedCodeSource(node.node, state), node.from, embed),
        block: true,
      }),
    })
    return true
  }
  // Keep `selected` ahead of `!langToken` so language-less blocks also get `CodeChromeWidget`
  // while editing (allowing the user to pick a language without hand-editing raw fences).
  if (selected) {
    if (!isMermaid) {
      styleEditingCodeblock(node, state, out, langToken, title, embed)
    } else {
      styleCodeblockLines(node, state, out)
    }
    return true
  }
  if (!langToken) {
    styleCodeblockLines(node, state, out)
    return false
  }
  out.push({
    from: node.from,
    to: node.to,
    tag: "widget:block:code",
    deco: Decoration.replace({
      widget: new CodeWidget({
        src: fencedCodeSource(node.node, state),
        pos: node.from,
        lang: langToken,
        title,
        embed,
      }),
      block: true,
    }),
  })
  return true
}
