export interface ParsedFenceInfo {
  readonly lang: string
  readonly title: string
}

/** Opening-fence info: first token = language, remainder = block label. */
export function parseFenceInfo(raw: string): ParsedFenceInfo {
  const trimmed = raw.trim()
  if (!trimmed) return { lang: "", title: "" }
  const space = trimmed.search(/\s/)
  if (space === -1) return { lang: trimmed, title: "" }
  return {
    lang: trimmed.slice(0, space),
    title: trimmed.slice(space + 1).trim(),
  }
}

export function formatFenceInfo(lang: string, title: string): string {
  const language = lang.trim()
  const label = title.trim()
  if (!language) return label
  if (!label) return language
  return `${language} ${label}`
}
