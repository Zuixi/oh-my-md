import { markdown } from "@codemirror/lang-markdown"
import { GFM } from "@lezer/markdown"
import { Footnotes } from "./footnotes"

export function markdownLanguageSupport() {
  return markdown({ extensions: [GFM, Footnotes] })
}
