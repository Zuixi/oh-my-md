import type { InlineContext, MarkdownConfig } from "@lezer/markdown"
import { isEscaped, skipInlineCode } from "./scan"

const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u
const PUNCT = /[\p{S}\p{P}]/u

function flank(before: string, after: string, punct: (ch: string) => boolean) {
  const pBefore = punct(before), pAfter = punct(after)
  const sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after)
  const left = !sAfter && (!pAfter || sBefore || pBefore)
  const right = !sBefore && (!pBefore || sAfter || pAfter)
  return {
    canOpen: left && (!right || pBefore),
    canClose: right && (!left || pAfter),
  }
}

const isPunct = (ch: string) => ch.length > 0 && PUNCT.test(ch)
const isPunctOrCjk = (ch: string) => isPunct(ch) || CJK.test(ch)

function findCloser(cx: InlineContext, from: number, size: number): number {
  let i = from
  while (i < cx.end) {
    if (isEscaped(cx, i)) { i++; continue }
    const skipped = skipInlineCode(cx, i)
    if (skipped != i) { i = skipped; continue }
    if (cx.char(i) != 95) { i++; continue }
    let end = i + 1
    while (cx.char(end) == 95) end++
    if (end - i >= size) {
      const before = cx.slice(i - 1, i)
      const after = cx.slice(end, end + 1)
      if (flank(before, after, isPunctOrCjk).canClose) return i
    }
    i = end
  }
  return -1
}

// CommonMark treats Han/Kana/Hangul as letters, so `__粗体__` cannot open.
// Typora-like: treat those scripts as punctuation for underscore flanking only.
export const CjkUnderscore: MarkdownConfig = {
  parseInline: [{
    name: "CjkUnderscore",
    after: "InlineCode",
    before: "Emphasis",
    parse(cx, next, pos) {
      if (next != 95 || isEscaped(cx, pos)) return -1
      let runEnd = pos + 1
      while (cx.char(runEnd) == 95) runEnd++
      const size = runEnd - pos
      if (size > 2) return -1
      const before = cx.slice(pos - 1, pos)
      const after = cx.slice(runEnd, runEnd + 1)
      if (!flank(before, after, isPunctOrCjk).canOpen) return -1
      if (flank(before, after, isPunct).canOpen) return -1
      const close = findCloser(cx, runEnd, size)
      if (close < 0 || close == runEnd) return -1
      const closeEnd = close + size
      const inner = cx.parser.parseInline(cx.slice(runEnd, close), runEnd)
      return cx.addElement(cx.elt(size == 2 ? "StrongEmphasis" : "Emphasis", pos, closeEnd, [
        cx.elt("EmphasisMark", pos, runEnd),
        ...inner,
        cx.elt("EmphasisMark", close, closeEnd),
      ]))
    },
  }],
}
