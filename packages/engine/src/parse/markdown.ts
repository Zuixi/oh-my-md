import { markdown } from "@codemirror/lang-markdown"
import { GFM } from "@lezer/markdown"

export function markdownLanguageSupport() {
  return markdown({ extensions: [GFM] })
}
