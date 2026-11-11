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
/** A hung network mount must not hold the export (and its single-flight lock) forever. */
export const EXPORT_IMAGE_FETCH_TIMEOUT_MS = 15_000

export type ExportImageErrorCode =
  | "no-document-path"
  | "read-failed"
  | "not-image"
  | "too-large"
  | "total-too-large"
  | "timeout"
  | "cancelled"

/**
 * A tagged image failure the export pipeline can turn into an actionable,
 * localized message. The plain `message` stays readable for logs and tests;
 * `src` is the Markdown source as written, so the user is told *which* image
 * failed even after the path was resolved.
 */
export class ExportImageError extends Error {
  readonly code: ExportImageErrorCode
  readonly src: string

  constructor(code: ExportImageErrorCode, src: string) {
    super(imageErrorDetail(code, src))
    this.name = "ExportImageError"
    this.code = code
    this.src = src
  }
}

function imageErrorDetail(code: ExportImageErrorCode, src: string): string {
  switch (code) {
    case "no-document-path":
      return `cannot resolve a relative image without a saved document: ${src}`
    case "read-failed":
      return `failed to read image: ${src}`
    case "not-image":
      return `not an image: ${src}`
    case "too-large":
      return `image is too large to embed: ${src}`
    case "total-too-large":
      return `the document's images are too large to embed in one export: ${src}`
    case "timeout":
      return `timed out reading image: ${src}`
    case "cancelled":
      return `image export cancelled: ${src}`
  }
}

export function resolveDocRelativePath(docPath: string, src: string): string {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src) || src.startsWith("\\\\")) return src
  const normalized = isWindowsPath(docPath) ? docPath.replace(/\\/g, "/") : docPath
  if (/^[A-Za-z]:\//.test(src) || src.startsWith("/")) return src
  const dir = normalized.slice(0, normalized.lastIndexOf("/") + 1)
  return dir + src
}

/** Absolute local sources resolve without a document to be relative to. */
function isAbsoluteLocalPath(src: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(src) || src.startsWith("/") || src.startsWith("\\\\")
}

function blobToDataUrl(blob: Blob, src: string): Promise<string> {
  // ES2020 lib: Promise.withResolvers is not available in this compile target.
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new ExportImageError("read-failed", src))
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
 *
 * Every failure is an `ExportImageError`: an unsaved draft with relative
 * images fails loudly instead of exporting broken relative paths.
 */
export function makeExportImageResolver(
  getDocPath: () => string | null,
  signal?: AbortSignal,
) {
  const cache = new Map<string, Promise<string>>()
  let totalBytes = 0

  return async (src: string): Promise<string> => {
    if (/^(?:data:|https?:|asset:|file:)/i.test(src)) return src
    const docPath = getDocPath()
    if (!docPath && !isAbsoluteLocalPath(src)) {
      throw new ExportImageError("no-document-path", src)
    }
    const absolute = docPath ? resolveDocRelativePath(docPath, src) : src

    const cached = cache.get(absolute)
    if (cached) return cached

    const pending = (async () => {
      if (signal?.aborted) throw new ExportImageError("cancelled", src)
      const controller = new AbortController()
      const abortFromCaller = (): void => controller.abort()
      signal?.addEventListener("abort", abortFromCaller, { once: true })
      const timer = setTimeout(
        () => controller.abort(),
        EXPORT_IMAGE_FETCH_TIMEOUT_MS,
      )
      let blob: Blob
      try {
        const response = await fetch(convertFileSrc(absolute), {
          signal: controller.signal,
        })
        if (!response.ok) throw new ExportImageError("read-failed", src)
        blob = await response.blob()
      } catch (error) {
        if (error instanceof ExportImageError) throw error
        throw new ExportImageError(
          signal?.aborted
            ? "cancelled"
            : controller.signal.aborted
              ? "timeout"
              : "read-failed",
          src,
        )
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abortFromCaller)
      }
      if (signal?.aborted) throw new ExportImageError("cancelled", src)
      if (!blob.type.startsWith("image/")) {
        throw new ExportImageError("not-image", src)
      }
      if (blob.size > EXPORT_MAX_IMAGE_BYTES) {
        throw new ExportImageError("too-large", src)
      }
      totalBytes += blob.size
      if (totalBytes > EXPORT_MAX_TOTAL_IMAGE_BYTES) {
        throw new ExportImageError("total-too-large", src)
      }
      return await blobToDataUrl(blob, src)
    })()
    cache.set(absolute, pending)
    return pending
  }
}
