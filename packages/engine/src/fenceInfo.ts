import type { SyntaxNode } from "@lezer/common"
import type { EditorState } from "@codemirror/state"
import { syntaxTree } from "@codemirror/language"

export interface ParsedFenceInfo {
  readonly lang: string
  readonly title: string
}

/** Opening-fence info: first token = language, remainder = block label. */
export function parseFenceInfo(raw: string): ParsedFenceInfo {
  const trimmed = raw.trim()
  if (!trimmed) return { lang: "", title: "" }
  const space = trimmed.search(/\s/)
  if (space === -1) return { lang: trimmed, title: "" }
  return {
    lang: trimmed.slice(0, space),
    title: trimmed.slice(space + 1).trim(),
  }
}

export function formatFenceInfo(lang: string, title: string): string {
  const language = lang.trim()
  const label = title.trim()
  if (!language) return ""
  if (!label) return language
  return `${language} ${label}`
}

/** Replace the CodeInfo of the fenced block containing `pos` using the live syntax tree. */
export function replaceFenceInfo(
  state: EditorState,
  pos: number,
  lang: string,
  title: string,
): { changes: { from: number; to: number; insert: string } } | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1)
  while (node) {
    if (node.name === "FencedCode") {
      const insert = formatFenceInfo(lang, title)
      const info = node.getChild("CodeInfo")
      if (info) return { changes: { from: info.from, to: info.to, insert } }
      const mark = node.getChild("CodeMark")
      if (!mark || !insert) return null
      return { changes: { from: mark.to, to: mark.to, insert: ` ${insert}` } }
    }
    node = node.parent
  }
  return null
}
