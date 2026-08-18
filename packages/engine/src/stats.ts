const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const LATIN = /[A-Za-z0-9]+/y

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
  let words = 0
  let i = 0
  while (i < trimmed.length) {
    if (CJK.test(trimmed[i])) {
      words += 1
      i += 1
      continue
    }
    LATIN.lastIndex = i
    const match = LATIN.exec(trimmed)
    if (!match) {
      i += 1
      continue
    }
    words += 1
    i = LATIN.lastIndex
  }
  return { words, chars: trimmed.length }
}
