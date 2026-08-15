const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u
const LATIN = /[A-Za-z0-9]+/g

export interface DocumentStats {
  readonly words: number
  readonly chars: number
}

export function documentStats(text: string): DocumentStats {
  const trimmed = text.trim()
  if (!trimmed) return { words: 0, chars: 0 }
  let words = 0
  for (const ch of trimmed) {
    if (CJK.test(ch)) words += 1
  }
  const withoutCjk = trimmed.replace(/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/gu, " ")
  const latin = withoutCjk.match(LATIN)
  words += latin?.length ?? 0
  return { words, chars: trimmed.length }
}
