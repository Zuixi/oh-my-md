/**
 * Rich copy for the desktop editor.
 *
 * A Live Preview copy writes two flavors at once: the exact Markdown source as
 * `text/plain`, and the rendered semantic HTML as `text/html`. Pasting into
 * Notion / Google Docs / Word / Slack / Feishu / Mail therefore lands formatted
 * content, while pasting back into oh-my-md stays byte-for-byte lossless —
 * `clipboardPaste.ts` recognizes the marker div below and prefers `text/plain`.
 *
 * Source mode and verbatim blocks (fenced code, math, frontmatter) opt out:
 * there the raw text is the content, so the browser's native copy is correct.
 */

import { EditorState } from "@codemirror/state"
import type { Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { exportHtml, inVerbatim, isLivePreview } from "@omd/engine"

/** Marks the HTML flavor as an oh-my-md Markdown copy (see `isInternalMarkdownCopyHtml`). */
export const OMD_INTERNAL_COPY_ATTR = "data-omd-markdown-copy"

/**
 * Upper bound on the Markdown slice that gets a rendered HTML flavor. Rendering
 * parses the slice on the copy event, which must stay imperceptible; above this
 * the copy still carries the exact source as `text/plain` via the native path.
 */
export const MAX_RICH_COPY_CHARS = 200_000

// Built from the attribute name so the wrapper and the detector cannot drift.
const INTERNAL_COPY_HTML = new RegExp(`^<div\\s+${OMD_INTERNAL_COPY_ATTR}="1">`, "i")
const EXPORT_BODY = /<body>([\s\S]*)<\/body>/i

/** True when `html` is an oh-my-md copy wrapper, i.e. its `text/plain` is the source. */
export function isInternalMarkdownCopyHtml(html: string | null): boolean {
  return html !== null && INTERNAL_COPY_HTML.test(html.trim())
}

export function clipboardCopyExtension(): Extension {
  return EditorView.domEventHandlers({
    copy: (event, view) => writeRichCopy(event, view, false),
    cut: (event, view) => writeRichCopy(event, view, true),
  })
}

/**
 * Populates both flavors for one Live Preview range. Returns false whenever the
 * native handler should run instead: the event belongs to a nested editor, the
 * selection is multi-range or empty, the mode is Source, the selection sits in
 * verbatim content, or the slice is empty/too large to render.
 */
function writeRichCopy(event: ClipboardEvent, view: EditorView, cut: boolean): boolean {
  if (event.target instanceof Element && event.target.closest(".cm-editor") !== view.dom)
    return false
  const transfer = event.clipboardData
  if (!transfer) return false
  if (view.state.selection.ranges.length !== 1) return false
  const sel = view.state.selection.main
  if (sel.empty) return false
  if (view.state.field(isLivePreview, false) !== true) return false
  // Checked on the range, before slicing or probing syntax, so copying a
  // multi-megabyte selection never allocates its string just to reject it.
  if (sel.to - sel.from > MAX_RICH_COPY_CHARS) return false
  // Both endpoints must be verbatim; a selection that merely starts inside a
  // code fence still has Markdown worth rendering around it.
  if (inVerbatim(view.state, sel.from) && inVerbatim(view.state, Math.max(sel.from, sel.to - 1)))
    return false
  const markdown = view.state.sliceDoc(sel.from, sel.to)
  if (markdown.length === 0) return false
  const html = richCopyHtml(markdown)
  if (html === null) return false

  event.preventDefault()
  transfer.setData("text/plain", markdown)
  transfer.setData("text/html", html)
  if (cut && !view.state.readOnly)
    view.dispatch(view.state.replaceSelection(""), { scrollIntoView: true, userEvent: "delete.cut" })
  return true
}

/**
 * Renders the slice through the engine's HTML exporter. The detached state
 * carries no extensions, so `exportHtml` parses with its cached standalone
 * Markdown parser instead of a live syntax tree. Only the body is kept: the
 * document shell (CSP meta, print CSS, title) belongs to file export, and a
 * styled container would fight the destination app's own styles.
 */
function richCopyHtml(markdown: string): string | null {
  const full = exportHtml(EditorState.create({ doc: markdown }))
  const body = EXPORT_BODY.exec(full)?.[1] ?? ""
  if (body.trim() === "") return null
  return `<div ${OMD_INTERNAL_COPY_ATTR}="1">${body}</div>`
}
