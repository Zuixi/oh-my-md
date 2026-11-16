import { describe, expect, it } from "vitest"
import { EditorSelection } from "@codemirror/state"
import { editorExtensions } from "../src/index"
import { blockSelected } from "../src/decorations/blockWidget"
import { isTableShownAsSource, revealTableSource, tableSourceRevealed } from "../src/tables/sourceReveal"
import { makeState } from "./helpers"

const DOC = ["before", "", "| A | B |", "| --- | --- |", "| a | b |", "", "after"].join("\n")
const FROM = DOC.indexOf("| A")
const TO = DOC.indexOf("\n\nafter")

function revealedWith(anchor: number, head: number) {
  const inside = DOC.indexOf("| a")
  const state = makeState(DOC, [editorExtensions()], { anchor: inside })
  const revealed = state.update({ selection: { anchor: inside + 1 }, effects: revealTableSource.of(null) }).state
  return revealed.update({ selection: EditorSelection.single(anchor, head) }).state
}

describe("isTableShownAsSource", () => {
  it("projects the revealed table as source only while the selection reaches into it", () => {
    // Caret inside, a partial selection from either side, or anchored inside: source lines.
    for (const [anchor, head] of [[FROM + 3, FROM + 3], [0, FROM + 5], [DOC.length, TO - 2], [FROM + 3, DOC.length]]) {
      expect(isTableShownAsSource(revealedWith(anchor, head), FROM, TO)).toBe(true)
    }
    // A full cover from outside keeps the reveal but renders the widget again.
    for (const [anchor, head] of [[DOC.length, FROM], [0, TO], [DOC.length, 0], [0, DOC.length]]) {
      const state = revealedWith(anchor, head)
      expect(state.field(tableSourceRevealed)).not.toBeNull()
      expect(isTableShownAsSource(state, FROM, TO)).toBe(false)
    }
    // Never for a table that is not the revealed one.
    expect(isTableShownAsSource(makeState(DOC, [editorExtensions()], { anchor: FROM + 3 }), FROM, TO)).toBe(false)
  })

  it("keeps the inlined selection rule in step with blockSelected", () => {
    const state = revealedWith(FROM + 3, FROM + 3)
    for (let anchor = 0; anchor <= DOC.length; anchor += 3) {
      for (let head = 0; head <= DOC.length; head += 3) {
        const moved = state.update({ selection: EditorSelection.single(anchor, head) }).state
        if (moved.field(tableSourceRevealed) === null) continue
        const expected = blockSelected(moved, FROM, TO) || (anchor >= FROM && anchor <= TO)
        expect(isTableShownAsSource(moved, FROM, TO)).toBe(expected)
      }
    }
  })
})
