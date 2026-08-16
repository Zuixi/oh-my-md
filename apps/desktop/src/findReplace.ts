export type Match = { from: number; to: number }

export function collectMatches(doc: string, query: string, caseSensitive: boolean): readonly Match[] {
  if (query === "") return []

  const haystack = caseSensitive ? doc : doc.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const matches: Match[] = []

  let index = 0
  while (index <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, index)
    if (found === -1) break
    matches.push({ from: found, to: found + needle.length })
    index = found + needle.length
  }

  return matches
}

export function nextIndex(count: number, current: number): number {
  if (count <= 0) return 0
  return (current + 1) % count
}

export function prevIndex(count: number, current: number): number {
  if (count <= 0) return 0
  return (current - 1 + count) % count
}

export function replaceAll(doc: string, query: string, replacement: string, caseSensitive: boolean): string {
  const matches = collectMatches(doc, query, caseSensitive)
  if (matches.length === 0) return doc

  let result = ""
  let lastIndex = 0

  for (const { from, to } of matches) {
    result += doc.slice(lastIndex, from) + replacement
    lastIndex = to
  }

  return result + doc.slice(lastIndex)
}
