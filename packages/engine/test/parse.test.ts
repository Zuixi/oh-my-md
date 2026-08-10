import { describe, expect, it } from "vitest"
import { syntaxTree } from "@codemirror/language"
import { makeState } from "./helpers"

describe("markdown parsing", () => {
  it("parses ATX heading", () => {
    const state = makeState("# Hello")
    const names: string[] = []
    syntaxTree(state).iterate({ enter: n => names.push(n.name) })
    expect(names).toContain("ATXHeading1")
  })
})