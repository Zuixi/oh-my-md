import type { EditorState, Line } from "@codemirror/state"
import { blockPrefixOf } from "../../format/blockPrefix"
import type { BlockSourceRange } from "../blockWidget"

/** Width (px) of the selection nub painted for an empty code line spanned by a selection. */
const EMPTY_LINE_NUB_PX = 4

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

function contentStart(state: EditorState, line: Line, content: string): number {
  const start = line.to - content.length
  if (start >= line.from && line.text.slice(start - line.from) === content) return start
  const prefix = blockPrefixOf(state, line)
  return prefix ? line.from + prefix.text.length : line.from
}

function clipRect(rect: DOMRectReadOnly, clip: DOMRectReadOnly): DOMRect | null {
  const left = Math.max(rect.left, clip.left)
  const right = Math.min(rect.right, clip.right)
  const top = Math.max(rect.top, clip.top)
  const bottom = Math.min(rect.bottom, clip.bottom)
  if (right <= left || bottom <= top) return null
  return new DOMRect(left, top, right - left, bottom - top)
}

function collectTextRangeRects(
  root: HTMLElement,
  localFrom: number,
  localTo: number,
  clip: DOMRectReadOnly,
  out: DOMRect[],
): void {
  if (localFrom >= localTo) return
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let offset = 0
  let startNode: Text | null = null
  let startOffset = 0
  let endNode: Text | null = null
  let endOffset = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    const len = text.data.length
    const nodeStart = offset
    const nodeEnd = offset + len
    offset = nodeEnd
    if (len === 0) continue
    if (!startNode && nodeEnd > localFrom) {
      startNode = text
      startOffset = Math.max(0, localFrom - nodeStart)
    }
    if (nodeStart < localTo) {
      endNode = text
      endOffset = Math.min(len, localTo - nodeStart)
    }
    if (nodeEnd >= localTo) break
  }
  if (!startNode || !endNode) return
  const range = doc.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  for (const rect of range.getClientRects()) {
    const clipped = clipRect(rect, clip)
    if (clipped) out.push(clipped)
  }
}

function emptyLineNub(lineEl: HTMLElement, clip: DOMRectReadOnly): DOMRect | null {
  const rect = lineEl.getBoundingClientRect()
  if (rect.height <= 0) return null
  return clipRect(new DOMRect(rect.left, rect.top, EMPTY_LINE_NUB_PX, rect.height), clip)
}

function plainEmptyLineNub(
  pre: HTMLElement,
  lineIndex: number,
  clip: DOMRectReadOnly,
): DOMRect | null {
  const style = getComputedStyle(pre)
  const padLeft = Number.parseFloat(style.paddingLeft) || 0
  const padTop = Number.parseFloat(style.paddingTop) || 0
  const fontSize = Number.parseFloat(style.fontSize) || 16
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.4
  const preRect = pre.getBoundingClientRect()
  const top = preRect.top + padTop + lineIndex * lineHeight
  return clipRect(new DOMRect(preRect.left + padLeft, top, EMPTY_LINE_NUB_PX, lineHeight), clip)
}

/**
 * Project a partial document selection intersecting a rendered `CodeWidget` into
 * viewport-space rectangles clipped to `.omd-code-body`.
 */
export function renderedCodeSelectionRects(
  state: EditorState,
  src: string,
  dom: HTMLElement,
  blockRange: BlockSourceRange,
  selRange: BlockSourceRange,
): DOMRect[] {
  const body = dom.querySelector<HTMLElement>(".omd-code-body") ?? dom
  const clip = body.getBoundingClientRect()
  if (clip.width <= 0 || clip.height <= 0) return []

  const sourceLines = src.split("\n")
  const openingLine = state.doc.lineAt(clamp(blockRange.from, 0, state.doc.length)).number
  const shikiLines = body.querySelectorAll<HTMLElement>(".line")
  const pre = shikiLines.length === 0 ? body.querySelector<HTMLElement>("pre") : null
  const out: DOMRect[] = []
  let plainOffset = 0

  for (let i = 0; i < sourceLines.length; i++) {
    const content = sourceLines[i]
    const lineStartInPlain = plainOffset
    plainOffset += content.length + 1
    const docLineNum = openingLine + 1 + i
    if (docLineNum > state.doc.lines) break
    const docLine = state.doc.line(docLineNum)
    const lineFrom = contentStart(state, docLine, content)
    const lineTo = lineFrom + content.length

    const interFrom = Math.max(selRange.from, lineFrom)
    const interTo = Math.min(selRange.to, lineTo)
    const spansEmpty = content.length === 0 && selRange.from <= lineFrom && selRange.to > lineFrom
    if (interFrom >= interTo && !spansEmpty) continue

    if (shikiLines.length > 0) {
      const lineEl = shikiLines[i]
      if (!lineEl) continue
      const rect = lineEl.getBoundingClientRect()
      if (rect.bottom < clip.top || rect.top > clip.bottom) continue
      if (spansEmpty) {
        const nub = emptyLineNub(lineEl, clip)
        if (nub) out.push(nub)
      } else {
        collectTextRangeRects(lineEl, interFrom - lineFrom, interTo - lineFrom, clip, out)
      }
    } else if (pre) {
      if (spansEmpty) {
        const nub = plainEmptyLineNub(pre, i, clip)
        if (nub) out.push(nub)
      } else {
        collectTextRangeRects(
          pre,
          lineStartInPlain + (interFrom - lineFrom),
          lineStartInPlain + (interTo - lineFrom),
          clip,
          out,
        )
      }
    }
  }
  return out
}
