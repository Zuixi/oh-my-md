/// <reference path="../types/turndown-plugin-gfm.d.ts" />
import { EditorView } from "@codemirror/view"
import type { Extension } from "@codemirror/state"

// Rich-text paste: convert clipboard text/html to Markdown with turndown +
// the GFM plugin (tables, strikethrough, task lists). Loading is lazy and
// cached, matching the KaTeX/Mermaid widget pattern.

interface ClipboardLike {
  getData(type: string): string
}

type HtmlToMarkdown = (html: string) => string

let converterPromise: Promise<HtmlToMarkdown> | null = null

function getConverter(): Promise<HtmlToMarkdown> {
  return converterPromise ??= Promise.all([
    import("turndown"),
    import("turndown-plugin-gfm"),
  ]).then(([turndown, gfmPlugin]) => {
    const service = new turndown.default({
      headingStyle: "atx",
      hr: "---",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
    })
    service.use(gfmPlugin.gfm as never)
    // GFM uses double tildes; pin it so plugin drift cannot regress the output.
    service.addRule("strikethrough", {
      filter: ["del", "s"] as never,
      replacement: (content: string) => `~~${content}~~`,
    })
    // Parse explicitly instead of handing turndown a string: its own parsing
    // path misbehaves under happy-dom, and node input is equivalent in
    // WebKit.
    return (html: string) =>
      service.turndown(new DOMParser().parseFromString(html, "text/html").body)
  })
}

/** Convert an HTML fragment to Markdown. Empty input or output yields "". */
export function convertHtmlToMarkdown(html: string): Promise<string> {
  if (!html.trim()) return Promise.resolve("")
  return getConverter().then(convert => convert(html).trim())
}

function squeezeWhitespace(text: string): string {
  return text.replace(/\s+/g, "")
}

/**
 * Decide what a rich paste should insert. Returns the Markdown to insert, or
 * null when the default plain-text paste is the better outcome:
 * - no text/html flavor at all;
 * - conversion produced nothing;
 * - the conversion is plain-text-equivalent (browsers attach minimal HTML to
 *   ordinary text copies; those must keep their exact old behavior).
 */
export async function htmlPasteToMarkdown(
  clipboard: ClipboardLike,
): Promise<string | null> {
  const html = clipboard.getData("text/html")
  if (!html || !html.trim()) return null
  const markdown = await convertHtmlToMarkdown(html)
  if (!markdown) return null
  const text = clipboard.getData("text/plain")
  if (text && squeezeWhitespace(markdown) === squeezeWhitespace(text)) return null
  return markdown
}

/** Paste hook converting rich clipboard HTML to Markdown. */
export function htmlPaste(): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const clipboard = event.clipboardData
      if (!clipboard) return false
      // An image flavor wins: the host's image-paste channel owns that case.
      if (Array.from(clipboard.items ?? []).some(item => item.type.startsWith("image/"))) {
        return false
      }
      if (!clipboard.getData("text/html").trim()) return false

      event.preventDefault()
      const selection = view.state.selection.main
      void htmlPasteToMarkdown(clipboard).then(markdown => {
        const insert = markdown ?? clipboard.getData("text/plain")
        if (!insert) return
        view.dispatch({
          changes: { from: selection.from, to: selection.to, insert },
          userEvent: "input.paste",
          scrollIntoView: true,
        })
      })
      return true
    },
  })
}
