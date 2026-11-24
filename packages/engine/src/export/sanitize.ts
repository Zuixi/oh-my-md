import { normalizePasteUrl } from "../paste/urlPolicy"

const CONTROL = /[\u0000-\u001f\u007f]/
/** Raster data URLs only; an SVG data URL is an active-content surface. */
const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif)[;,]/i
const BARE_ANCHOR_OPEN = /^<a\s+(id|name)=(?:"([^"<>]+)"|'([^'<>]+)')\s*>$/i
const BARE_ANCHOR_CLOSE = /^<\/a\s*>$/i

/**
 * URL policy for exported documents. Scheme/entity/percent-encoding
 * obfuscation is owned by `paste/urlPolicy.ts::normalizePasteUrl`, so an
 * exported file cannot accept a link the Smart Paste gate rejects.
 *
 * Returning `null` means "emit text, never an href/src".
 */
function isRejectedValue(value: string): boolean {
  return value === "" || CONTROL.test(value) || value.startsWith("//")
}

export function safeExportHref(raw: string): string | null {
  if (isRejectedValue(raw.trim())) return null
  const normalized = normalizePasteUrl(raw, "link")
  if (normalized === null || normalized.startsWith("//")) return null
  return normalized
}

export function safeExportImageSrc(raw: string): string | null {
  const value = raw.trim()
  if (isRejectedValue(value)) return null
  if (RASTER_DATA_URL.test(value)) return value
  const normalized = normalizePasteUrl(raw, "image")
  if (normalized === null || normalized.startsWith("//")) return null
  return normalized
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
 * Both quote styles are accepted and re-emitted as canonical double quotes.
 */
export function sanitizeRawAnchorTag(raw: string): string | null {
  if (BARE_ANCHOR_CLOSE.test(raw)) return "</a>"
  const match = BARE_ANCHOR_OPEN.exec(raw)
  if (!match) return null
  const attribute = match[1]!.toLowerCase()
  const value = match[2] ?? match[3] ?? ""
  return `<a ${attribute}="${escapeAttr(value)}">`
}
