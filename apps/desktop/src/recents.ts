export const MAX_RECENTS = 10
export const RECENTS_STORAGE_KEY = "omd.recent-files"

export function rememberPath(recents: readonly string[], path: string): string[] {
  return [path, ...recents.filter(item => item !== path)].slice(0, MAX_RECENTS)
}

export function parseRecents(raw: string | null): string[] {
  if (!raw) return []
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string")) {
    throw new Error("recent files are invalid")
  }
  return parsed.slice(0, MAX_RECENTS)
}
