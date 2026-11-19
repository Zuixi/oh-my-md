import { syntaxTree } from "@codemirror/language"
import type { EditorState } from "@codemirror/state"
import type { Parser, SyntaxNode } from "@lezer/common"
import { headingSlug } from "../links"
import { markdownLanguageSupport } from "../parse/markdown"
import {
  referenceContextForTree,
  snapshotReferenceContext,
  type MarkdownReferenceContext,
} from "../semantic/references"

export interface ExportContext {
  readonly topNode: SyntaxNode
  readonly refs: MarkdownReferenceContext
  readonly nextHeadingId: (plainText: string) => string
}

let detachedParser: Parser | null = null

export function prepareExportDocument(state: EditorState): ExportContext {
  const liveTree = syntaxTree(state)
  const nextHeadingId = createHeadingIdGenerator()
  if (liveTree.length >= state.doc.length) {
    return {
      topNode: liveTree.topNode,
      refs: snapshotReferenceContext(state),
      nextHeadingId,
    }
  }
  detachedParser ??= markdownLanguageSupport().language.parser
  const source = state.doc.toString()
  const fullTree = detachedParser.parse(source)
  return {
    topNode: fullTree.topNode,
    refs: referenceContextForTree(fullTree, source.length, (from, to) => state.doc.sliceString(from, to)),
    nextHeadingId,
  }
}

function createHeadingIdGenerator(): (plainText: string) => string {
  const seen = new Map<string, number>()
  return (plainText: string): string => {
    const base = headingSlug(plainText)
    if (!base) return ""
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}-${count}`
  }
}

export function headingPlainText(node: SyntaxNode, state: EditorState): string {
  const parts: string[] = []
  let pos = node.from
  for (let child = node.firstChild; child && child.from < node.to; child = child.nextSibling) {
    if (child.from > pos) parts.push(state.doc.sliceString(pos, child.from))
    if (child.name !== "HeaderMark") {
      parts.push(state.doc.sliceString(child.from, child.to))
    }
    pos = Math.min(child.to, node.to)
  }
  if (pos < node.to) parts.push(state.doc.sliceString(pos, node.to))
  return parts.join("").trim()
}

export function taskCheckboxHtml(raw: string): string {
  const checked = /^\[[xX]\]$/.test(raw.trim())
  return checked
    ? '<input type="checkbox" class="omd-task-checkbox" disabled checked> '
    : '<input type="checkbox" class="omd-task-checkbox" disabled> '
}

export function footnoteIdFromRef(raw: string): string {
  return raw.slice(2, -1).trim()
}

export function footnoteIdFromDef(node: SyntaxNode, state: EditorState): string {
  const mark = node.getChild("FootnoteMark")
  if (!mark) return ""
  const raw = state.doc.sliceString(mark.from, mark.to).trim()
  const match = /^\[\^([^\]]+)\]:?$/.exec(raw)
  return match?.[1]?.trim() ?? ""
}

export function footnoteSlug(id: string): string {
  return encodeURIComponent(id.toLowerCase())
}
