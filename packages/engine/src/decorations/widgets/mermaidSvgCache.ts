import { BoundedLru } from "../../cache/boundedLru"

export interface CachedMermaidSvg {
  readonly id: string
  readonly svg: string
}

const MERMAID_SVG_CACHE_MAX_ENTRIES = 64
const MERMAID_SVG_CACHE_MAX_BYTES = 8 * 1024 * 1024

export function createMermaidSvgCache() {
  return new BoundedLru<string, CachedMermaidSvg>({
    maxEntries: MERMAID_SVG_CACHE_MAX_ENTRIES,
    maxSize: MERMAID_SVG_CACHE_MAX_BYTES,
    sizeOf: entry => entry.svg.length * 2,
  })
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Rewrite the cached root SVG id to a fresh unique id so identical Mermaid
 * blocks in the same document never collide on `<style>` / `url(#...)` defs.
 * Negative lookahead on digits ensures `omd-mmd-1` never rewrites `omd-mmd-10`.
 */
export function instantiateCachedMermaidSvg(entry: CachedMermaidSvg, nextId: string): string {
  if (!entry.id || entry.id === nextId) return entry.svg
  const pattern = new RegExp(`${escapeRegExp(entry.id)}(?![0-9])`, "g")
  return entry.svg.replace(pattern, nextId)
}
