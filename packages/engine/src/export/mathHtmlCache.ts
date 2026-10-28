import { BoundedLru } from "../cache/boundedLru"

export const MATH_HTML_CACHE_MAX_ENTRIES = 128
export const MATH_HTML_CACHE_MAX_BYTES = 8 * 1024 * 1024

export function createMathHtmlCache(): BoundedLru<string, string> {
  return new BoundedLru<string, string>({
    maxEntries: MATH_HTML_CACHE_MAX_ENTRIES,
    maxSize: MATH_HTML_CACHE_MAX_BYTES,
    sizeOf: html => html.length * 2,
  })
}
