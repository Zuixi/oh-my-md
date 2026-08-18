export type Match = { from: number; to: number }

export interface FindQuery {
  readonly query: string
  readonly caseSensitive: boolean
  readonly regex: boolean
  readonly wholeWord: boolean
}

/** Escapes literal text for use inside a RegExp body. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// \b only exists next to ASCII word characters; CJK text never forms one, so
// boundaries are added only where the query edge is an ASCII word character —
// otherwise every Chinese query would stop matching entirely.
function wholeWordPattern(body: string): string {
  const lead = /^\w/.test(body) ? "\\b" : ""
  const trail = /\w$/.test(body) ? "\\b" : ""
  return `${lead}${body}${trail}`
}

/** Returns the invalid-regex error text, or null for a usable pattern. */
export function validateFindPattern(q: FindQuery): string | null {
  if (!q.regex || q.query === "") return null
  try {
    new RegExp(q.query)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function compile(q: FindQuery): RegExp | null {
  if (q.query === "") return null
  const flags = q.caseSensitive ? "g" : "gi"
  if (q.regex) {
    // Invalid patterns are surfaced by validateFindPattern; matching treats
    // them as no matches instead of throwing.
    try {
      return new RegExp(q.query, flags)
    } catch {
      return null
    }
  }
  const body = escapeRegExp(q.query)
  return new RegExp(q.wholeWord ? wholeWordPattern(body) : body, flags)
}

export function collectMatches(doc: string, q: FindQuery): readonly Match[] {
  const re = compile(q)
  if (!re) return []
  const matches: Match[] = []
  for (const match of doc.matchAll(re)) {
    if (match[0] === "") continue
    matches.push({ from: match.index, to: match.index + match[0].length })
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

export function replaceAll(doc: string, q: FindQuery, replacement: string): string {
  const re = compile(q)
  if (!re) return doc
  if (q.regex) {
    // Regex mode honors $1-style capture references in the replacement.
    return doc.replace(re, replacement)
  }
  // Text mode keeps the replacement literal; "$&" must not be interpreted.
  return doc.replace(re, () => replacement)
}
