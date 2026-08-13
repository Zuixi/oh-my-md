import { markdown } from "@codemirror/lang-markdown"
import { GFM } from "@lezer/markdown"
import { CjkUnderscore } from "./cjkUnderscore"
import { Footnotes } from "./footnotes"
import { Highlight } from "./highlight"
import { Math } from "./math"

export function markdownLanguageSupport() {
  return markdown({ extensions: [GFM, Footnotes, Math, Highlight, CjkUnderscore] })
}
