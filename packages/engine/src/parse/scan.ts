import type { InlineContext } from "@lezer/markdown"

export function isEscaped(cx: InlineContext, pos: number): boolean {
  let n = 0
  for (let i = pos - 1; i >= cx.offset && cx.char(i) == 92; i--) n++
  return n % 2 === 1
}

// Advance past a backtick code span starting at pos; if unclosed, skip the opener ticks.
export function skipInlineCode(cx: InlineContext, pos: number): number {
  if (cx.char(pos) != 96) return pos
  let ticks = 0
  while (cx.char(pos + ticks) == 96) ticks++
  let i = pos + ticks
  while (i < cx.end) {
    if (cx.char(i) != 96) { i++; continue }
    let n = 0
    while (cx.char(i + n) == 96) n++
    if (n === ticks) return i + n
    i += n
  }
  return pos + ticks
}
