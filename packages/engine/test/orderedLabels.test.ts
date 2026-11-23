import { syntaxTree } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { describe, expect, it } from "vitest"
import { collectOrderedListLabels, orderedLabel } from "../src/lists/ordered"
import { makeState } from "./helpers"

function firstList(doc: string): { state: ReturnType<typeof makeState>; list: SyntaxNode } {
  const state = makeState(doc)
  let list: SyntaxNode | null = null
  syntaxTree(state).iterate({
    enter(node) {
      if (list === null && node.name === "OrderedList") list = node.node
    },
  })
  if (!list) throw new Error("no OrderedList")
  return { state, list }
}

describe("ordered list label collection", () => {
  it("computes every label in one pass", () => {
    const { state, list } = firstList("3) a\n9) b\n4) c")
    const labels = [...collectOrderedListLabels(list, state).values()]
    expect(labels).toEqual(["3)", "4)", "5)"])
  })

  it("keeps nested lists independent", () => {
    const { state, list } = firstList("1. outer\n   5. inner\n   9. inner2\n2. outer2")
    const labels = [...collectOrderedListLabels(list, state).values()]
    expect(labels).toEqual(["1.", "2."])
  })

  it("orderedLabel still resolves a single marker from the same table", () => {
    const { state, list } = firstList("2. a\n7. b")
    const mark = list.getChild("ListItem")?.getChild("ListMark")
    if (!mark) throw new Error("no ListMark")
    expect(orderedLabel(mark, state)).toBe("2.")
  })
})
