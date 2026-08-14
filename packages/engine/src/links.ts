import { syntaxTree } from "@codemirror/language"
import type { EditorState } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"
import { collectOutline } from "./outline"

export interface LinkTarget {
  readonly href: string
  readonly from: number
  readonly to: number
}

function referenceKey(value: string): string {
  return value.replace(/^\[|\]$/g, "").trim().replace(/\s+/g, " ").toLowerCase()
}

function linkReferenceKey(state: EditorState, node: SyntaxNode): string | null {
  const label = node.getChild("LinkLabel")
  if (!label) return null
  const raw = state.doc.sliceString(label.from, label.to)
  if (raw !== "[]") return referenceKey(raw)

  const marks = node.getChildren("LinkMark")
  if (marks.length < 2) return null
  return referenceKey(state.doc.sliceString(marks[0].to, marks[1].from))
}

function referenceHref(state: EditorState, key: string): string | null {
  let href: string | null = null
  syntaxTree(state).iterate({
    enter(node) {
      if (href !== null || node.name !== "LinkReference") return
      const label = node.node.getChild("LinkLabel")
      const url = node.node.getChild("URL")
      if (!label || !url) return
      if (referenceKey(state.doc.sliceString(label.from, label.to)) === key)
        href = state.doc.sliceString(url.from, url.to)
    },
  })
  return href
}

export function linkHref(state: EditorState, node: SyntaxNode): string | null {
  const url = node.getChild("URL")
  if (url) return state.doc.sliceString(url.from, url.to)
  if (node.name !== "Link") return null
  const key = linkReferenceKey(state, node)
  return key ? referenceHref(state, key) : null
}

export function headingSlug(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
}

function hrefForNode(state: EditorState, node: SyntaxNode): string | null {
  const value = linkHref(state, node)
  if (!value) return null
  if (node.name === "Autolink" && /^[^:/\s]+@[^:/\s]+$/.test(value)) return `mailto:${value}`
  if (node.name === "Autolink" && value.startsWith("www.")) return `https://${value}`
  return value
}

export function linkAt(state: EditorState, pos: number): LinkTarget | null {
  let node: SyntaxNode | null = syntaxTree(state).resolve(pos, -1)
  while (node) {
    if (node.name === "Link" || node.name === "Autolink") {
      const href = hrefForNode(state, node)
      return href ? { href, from: node.from, to: node.to } : null
    }
    node = node.parent
  }
  return null
}

export function headingPositionForAnchor(state: EditorState, href: string): number | null {
  if (!href.startsWith("#")) return null
  const slug = href.slice(1).toLowerCase()
  const heading = collectOutline(state).find(item => headingSlug(item.text) === slug)
  if (heading) return heading.from

  let target: number | null = null
  syntaxTree(state).iterate({
    enter(node) {
      if (target !== null || node.name !== "HTMLTag") return
      const raw = state.doc.sliceString(node.from, node.to)
      const match = raw.match(/^<a\b[^>]*\bid\s*=\s*(['"])([^'"]+)\1[^>]*>$/i)
      if (match?.[2].toLowerCase() === slug) target = node.from
    },
  })
  return target
}
