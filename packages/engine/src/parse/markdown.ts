import { markdown } from "@codemirror/lang-markdown"
import { GFM } from "@lezer/markdown"
import { Footnotes } from "./footnotes"
import { Math } from "./math"

export function markdownLanguageSupport() {
  return markdown({ extensions: [GFM, Footnotes, Math] })
}
