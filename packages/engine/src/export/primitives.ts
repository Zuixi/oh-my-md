/**
 * Shared HTML output primitives for every export path. The document walkers
 * and the table helpers emit links and images only through `anchorHtml` /
 * `imageHtml`, so an unsafe href/src can never bypass the URL gate.
 */

import { safeExportHref, safeExportImageSrc } from "./sanitize"

/** Host capabilities the rich image path needs (document and table cells). */
export interface RichImageOptions {
  /** Local image resolver; may return a promise (e.g. to read the file first). */
  readonly resolveImageSrc?: (src: string) => string | Promise<string>
  /** Called once per http(s) image so native hosts can warn before capture. */
  readonly onRemoteImage?: (src: string) => void
}

const REMOTE_IMAGE = /^https?:\/\//i

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Optional `title` attribute: omitted for null, escaped otherwise. */
export function titleAttr(title: string | null): string {
  return title === null ? "" : ` title="${escapeHtml(title)}"`
}

/**
 * The single link emitter. A rejected href keeps its label as plain text
 * inside a `<span>` (no host text is trusted to be HTML).
 */
export function anchorHtml(href: string, title: string | null, labelHtml: string): string {
  const safe = safeExportHref(href)
  if (safe === null) return `<span>${labelHtml || escapeHtml(href)}</span>`
  return `<a href="${escapeHtml(safe)}"${titleAttr(title)}>${labelHtml || escapeHtml(safe)}</a>`
}

/** The single image emitter: an unsafe source degrades to the escaped alt text. */
export function imageHtml(src: string, alt: string, title: string | null): string {
  const safe = safeExportImageSrc(src)
  if (safe === null) return escapeHtml(alt)
  return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}"${titleAttr(title)}>`
}

/**
 * Rich export rewrites only local relative paths: remote http/https images are
 * never inlined. The source is validated *before* the host resolver runs, so
 * `javascript:`, `file:` or an SVG data URL never reaches the file reader;
 * `""` makes `imageHtml` degrade to the escaped alt text.
 */
export async function richImageSrc(src: string, opts: RichImageOptions): Promise<string> {
  const safe = safeExportImageSrc(src)
  if (safe === null) return ""
  if (REMOTE_IMAGE.test(safe)) {
    opts.onRemoteImage?.(safe)
    return safe
  }
  if (!opts.resolveImageSrc) return safe
  return (await opts.resolveImageSrc(safe)) ?? safe
}
