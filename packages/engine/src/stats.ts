const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const LATIN = /[A-Za-z0-9]+/y

export interface DocumentStats {
  readonly words: number
  readonly chars: number
}

export function documentStats(text: string): DocumentStats {
  const trimmed = text.trim()
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
