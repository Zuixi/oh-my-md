import { BoundedLru } from "../../cache/boundedLru"

const CODE_HTML_CACHE_MAX_ENTRIES = 128
const CODE_HTML_CACHE_MAX_BYTES = 8 * 1024 * 1024

export function createCodeHtmlCache() {
  return new BoundedLru<string, string>({
    maxEntries: CODE_HTML_CACHE_MAX_ENTRIES,
    maxSize: CODE_HTML_CACHE_MAX_BYTES,
    sizeOf: html => html.length * 2,
  })
}
