const CONTROL = /[\u0000-\u001f\u007f]/
const SCHEME = /^([a-z][a-z0-9+.-]*):/i

/**
 * URL policy for exported documents. Kept in one place so links and images
 * cannot drift from the paste policy; the host controls what the document
 * renders, but an exported file must not carry executable or local schemes.
 */
export function safeExportHref(raw: string): string | null {
  const value = raw.trim()
  if (!value || CONTROL.test(value)) return null
  if (value.startsWith("#")) return value
  if (value.startsWith("//")) return null
  const scheme = value.match(SCHEME)?.[1]?.toLowerCase()
  if (scheme) return scheme === "http" || scheme === "https" || scheme === "mailto" ? value : null
  return value
}

/** Raster data URLs only; SVG in an exported file is an active-content surface. */
export function safeExportImageSrc(raw: string): string | null {
  const value = raw.trim()
  if (!value || CONTROL.test(value)) return null
  if (value.startsWith("//")) return null
  const scheme = value.match(SCHEME)?.[1]?.toLowerCase()
  if (scheme === "http" || scheme === "https") return value
  if (scheme === "data") {
    return /^data:image\/(?:png|jpeg|webp|gif)[;,]/i.test(value) ? value : null
  }
  if (scheme) return null
  return value
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * Raw HTML is escaped by default. The only exception is a bare anchor used
 * for a same-document anchor: one quoted id/name, no other attributes.
 */
export function sanitizeRawAnchorTag(raw: string): string | null {
  if (/^<\/a\s*>$/i.test(raw)) return "</a>"
  const match = raw.match(/^<a\s+(id|name)="([^"<>]+)"\s*>$/i)
  if (!match) return null
  return `<a ${match[1]!.toLowerCase()}="${escapeAttr(match[2]!)}">`
}
