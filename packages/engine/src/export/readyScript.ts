/**
 * Inline readiness handshake consumed by the native exporters: they wait for
 * window.__omdExportReady and then measure window.__omdExportHeight. Fonts and
 * image decodes must settle before the height is read; a 4500 ms ceiling keeps
 * a hung decode from stalling the export and is flagged through
 * window.__omdExportIncomplete.
 *
 * Standalone `.html` files must not carry it (`includeReadyScript: false`);
 * they get the no-script `EXPORT_CSP_META` instead.
 */
export const EXPORT_READY_SCRIPT = `<script>(async () => {
  let incomplete = false
  const waits = []
  if (document.fonts && document.fonts.ready) waits.push(document.fonts.ready.catch(() => {}))
  for (const img of document.images) {
    // A failed decode means the exported image is missing content even though
    // it resolves quickly; surface it as partial instead of a clean success.
    waits.push(Promise.resolve().then(() => img.decode()).catch(() => { incomplete = true }))
  }
  const timeout = new Promise(resolve => setTimeout(() => { incomplete = true; resolve() }, 4500))
  await Promise.race([Promise.all(waits), timeout])
  const b = document.body
  let contentBottom = 0
  if (b) {
    const bodyRect = b.getBoundingClientRect()
    const style = getComputedStyle(b)
    const padBottom = parseFloat(style.paddingBottom) || 0
    for (let el = b.lastElementChild; el; el = el.previousElementSibling) {
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue
      const r = el.getBoundingClientRect()
      if (r.height > 0 || r.bottom > bodyRect.top) {
        contentBottom = Math.ceil(r.bottom - bodyRect.top + padBottom)
        break
      }
    }
  }
  const scrollH = Math.max(document.documentElement?.scrollHeight ?? 0, b?.scrollHeight ?? 0)
  window.__omdExportIncomplete = incomplete
  window.__omdExportReady = true
  window.__omdExportHeight = contentBottom > 0 ? Math.max(contentBottom, Math.min(scrollH, contentBottom + 64)) : scrollH
})()</script>`

/**
 * SHA-256 (base64) of the script body above. Every native host pins this hash
 * in its CSP instead of allowing `'unsafe-inline'`, so a `<script>` written in
 * raw Markdown can never execute inside the export page. Rust mirrors the
 * value in `export_host.rs`; `crossLayerConstants.test.ts` recomputes it from
 * this file and fails if either copy drifts.
 */
export const EXPORT_READY_SCRIPT_SHA256 =
  "sha256-MyiKteHaXRL96raOhQ75BjWJi96uGSOxEFhruB2aJPg="

/**
 * CSP meta for the native export document (WKWebView `loadHTMLString`, where
 * no HTTP response header can carry the policy). Only the readiness handshake
 * is allowed, and only by hash.
 */
export const EXPORT_NATIVE_CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; script-src '${EXPORT_READY_SCRIPT_SHA256}'; font-src data:; base-uri 'none'; form-action 'none'">`
