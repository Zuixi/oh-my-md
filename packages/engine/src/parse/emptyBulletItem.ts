import type { Line, MarkdownConfig } from "@lezer/markdown"
import { CHAR_ASTERISK, CHAR_MINUS, CHAR_PLUS, CHAR_SPACE, CHAR_TAB } from "./chars"

function isHorizontalSpace(code: number): boolean {
  return code === CHAR_SPACE || code === CHAR_TAB
}

function isEmptyBulletMarkerLine(line: Line): boolean {
  const marker = line.next
  if (marker !== CHAR_MINUS && marker !== CHAR_PLUS && marker !== CHAR_ASTERISK) return false
  const afterMarker = line.pos + 1
  if (afterMarker >= line.text.length || !isHorizontalSpace(line.text.charCodeAt(afterMarker))) {
    return false
  }
  for (let i = afterMarker + 1; i < line.text.length; i++) {
    if (!isHorizontalSpace(line.text.charCodeAt(i))) return false
  }
  return true
}

/**
 * CommonMark forbids an empty bullet item (`- `) from interrupting a tight
 * paragraph, which causes live typing (`para` -> Enter -> `- `) and list
 * backspacing (`para\n- text` -> `para\n- `) to collapse the list into the
 * paragraph (or into a Setext underline). Ending the leaf block on a bullet
 * marker followed by mandatory horizontal whitespace hands the line directly
 * to `@lezer/markdown`'s native `BulletList` block parser without affecting
 * bare `-` (needed while typing `---`), `--`/`---`, or `- - -` rules.
 */
export const EmptyBulletItem: MarkdownConfig = {
  parseBlock: [{
    name: "EmptyBulletItem",
    endLeaf(_cx, line) {
      return isEmptyBulletMarkerLine(line)
    },
  }],
}
