import { convertFileSrc } from "@tauri-apps/api/core"
import { isWindowsPath } from "./workspace"

/** Per-image cap for inlining; the native HTML cap is 32 MiB. */
export const EXPORT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
/**
 * Total raw image bytes embedded into one export document. Base64 expands by
 * ~4/3, so this leaves headroom under the native 32 MiB HTML cap for markup
 * and KaTeX CSS.
 */
export const EXPORT_MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024

export function resolveDocRelativePath(docPath: string, src: string): string {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) return src
  const normalized = isWindowsPath(docPath) ? docPath.replace(/\\/g, "/") : docPath
  if (/^[A-Za-z]:\//.test(src) || src.startsWith("/")) return src
  const dir = normalized.slice(0, normalized.lastIndexOf("/") + 1)
  return dir + src
}

function blobToDataUrl(blob: Blob): Promise<string> {
  // ES2020 lib: Promise.withResolvers is not available in this compile target.
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error("failed to read image data"))
    reader.readAsDataURL(blob)
  })
}

/**
 * Export-only image resolver: local relative images become data URLs so the
 * exported HTML/PDF/PNG is self-contained and identical on every platform.
 * Remote URLs stay remote (the UI already warns about them).
 *
 * The resolver is intentionally export-scoped: the editor preview keeps using
 * the Tauri asset protocol, which is faster and does not inflate the DOM.
 */
export function makeExportImageResolver(getDocPath: () => string | null) {
  const cache = new Map<string, Promise<string>>()
  let totalBytes = 0

  return async (src: string): Promise<string> => {
    if (/^(?:data:|https?:)/i.test(src)) return src
    const docPath = getDocPath()
    if (!docPath) return src
    const absolute = resolveDocRelativePath(docPath, src)
    if (/^(?:asset:|file:)/i.test(absolute)) return absolute

    const cached = cache.get(absolute)
    if (cached) return cached

    const pending = (async () => {
      const response = await fetch(convertFileSrc(absolute))
      if (!response.ok) throw new Error(`failed to read image: ${src}`)
      const blob = await response.blob()
      if (!blob.type.startsWith("image/")) {
        throw new Error(`not an image: ${src}`)
      }
      if (blob.size > EXPORT_MAX_IMAGE_BYTES) {
        throw new Error(`image is too large to embed: ${src}`)
      }
      totalBytes += blob.size
      if (totalBytes > EXPORT_MAX_TOTAL_IMAGE_BYTES) {
        throw new Error("the document's images are too large to embed in one export")
      }
      return await blobToDataUrl(blob)
    })()
    cache.set(absolute, pending)
    return pending
  }
}
