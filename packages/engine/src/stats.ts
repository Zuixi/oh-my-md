const WORD =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[A-Za-z0-9]+/gu

// Leading YAML front matter is metadata, not prose — excluded from counts.
// Same ambiguity as any CommonMark parser: a stray hr pair at the doc start
// also matches, which is the accepted price of the heuristic.
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/

export interface DocumentStats {
  readonly words: number
  readonly chars: number
}

export function documentStats(text: string): DocumentStats {
  const trimmed = text.replace(FRONT_MATTER, "").trim()
  if (!trimmed) return { words: 0, chars: 0 }
  // Global regexes carry lastIndex across calls; reset so repeated stats on the
  // same document (or a shorter one) start from the beginning.
  WORD.lastIndex = 0
  let words = 0
  while (WORD.exec(trimmed)) words += 1
  return { words, chars: trimmed.length }
}
