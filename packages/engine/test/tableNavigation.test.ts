import { describe, expect, it } from "vitest"
import { cellAt, nextCell, tableAt } from "../src/tables/navigate"
import { makeState } from "./helpers"

const DOC = ["Intro.", "", "| A | B |", "| --- | --- |", "| a | b |", "", "Outro."].join("\n")
const at = (needle: string, from = 0) => DOC.indexOf(needle, from)

describe("tableAt", () => {
  it("finds the table node and its source slice", () => {
    const state = makeState(DOC)
    const table = tableAt(state, at("a"))
    expect(table).not.toBeNull()
    expect(table!.from).toBe(DOC.indexOf("| A"))
    expect(table!.source.startsWith("| A | B |")).toBe(true)
    expect(table!.data.rows.length).toBe(1)
  })

  it("returns null outside a table", () => {
    const state = makeState(DOC)
    expect(tableAt(state, at("Intro"))).toBeNull()
  })
})

describe("cellAt", () => {
  it("maps a caret in the header to row 0", () => {
    const state = makeState(DOC)
    const hit = cellAt(state, at("A"))
    expect(hit?.slot.row).toBe(0)
    expect(hit?.slot.col).toBe(0)
  })

  it("maps a caret in a body cell to its row and column", () => {
    const state = makeState(DOC)
    const hit = cellAt(state, at("b"))
    expect(hit?.slot.row).toBe(1)
    expect(hit?.slot.col).toBe(1)
  })

  it("maps a caret on a pipe to the cell on its left", () => {
    const state = makeState(DOC)
    const hit = cellAt(state, at("|", DOC.indexOf("| a")))
    expect(hit?.slot.row).toBe(1)
    expect(hit?.slot.col).toBe(0)
  })
})

describe("nextCell", () => {
  it("walks forward across the header into the first body row", () => {
    const state = makeState(DOC)
    const next = nextCell(state, at("B"), 1)
    expect(next?.row).toBe(1)
    expect(next?.col).toBe(0)
  })

  it("walks backward from the first body cell into the header", () => {
    const state = makeState(DOC)
    const prev = nextCell(state, at("a"), -1)
    expect(prev?.row).toBe(0)
    expect(prev?.col).toBe(1)
  })

  it("returns null past the last cell", () => {
    const state = makeState(DOC)
    expect(nextCell(state, at("b"), 1)).toBeNull()
  })
})
