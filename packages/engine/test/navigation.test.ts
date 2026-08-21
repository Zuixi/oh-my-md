import { describe, expect, it } from "vitest"
import {
  classifyLink,
  footnoteAt,
  footnoteDefinitionPosition,
  footnoteReferencePosition,
} from "../src/index"
import { blockEntryPosition } from "../src/navigation/blockEntry"
import { makeState } from "./helpers"

describe("classifyLink", () => {
  it("classifies hrefs", () => {
    expect(classifyLink("https://a.com").kind).toBe("external")
    expect(classifyLink("http://a.com")).toEqual({ kind: "external", href: "http://a.com" })
    expect(classifyLink("mailto:a@b.com").kind).toBe("external")
    expect(classifyLink("notes/a.md").kind).toBe("markdown")
    expect(classifyLink("./a.markdown#x").kind).toBe("markdown")
    expect(classifyLink("pic.png").kind).toBe("other")
  })
})

describe("footnote lookups", () => {
  const doc = "Hi[^a]\n\n[^a]: note"

  it("finds footnote definition", () => {
    const s = makeState(doc)
    const ref = footnoteAt(s, 3)
    expect(ref?.kind).toBe("reference")
    expect(ref?.id).toBe("a")
    expect(footnoteDefinitionPosition(s, "a")).toBeGreaterThan(0)
  })

  it("finds a definition at the mark and the first reference by id", () => {
    const s = makeState(doc)
    const markFrom = doc.indexOf("[^a]:")
    const markTo = markFrom + "[^a]:".length
    const def = footnoteAt(s, markFrom)
    expect(def?.kind).toBe("definition")
    expect(def?.id).toBe("a")
    expect(def?.from).toBe(markFrom)
    expect(def?.to).toBe(markTo)
    expect(footnoteAt(s, markTo - 1)?.kind).toBe("definition")
    expect(footnoteReferencePosition(s, "a")).toBe(doc.indexOf("[^a]"))
  })

  it("ignores clicks in the footnote definition body", () => {
    const s = makeState(doc)
    expect(footnoteAt(s, doc.indexOf("note"))).toBeNull()
  })

  it("looks up definitions case-insensitively and returns null for missing ids", () => {
    const s = makeState(doc)
    expect(footnoteDefinitionPosition(s, "A")).toBe(footnoteDefinitionPosition(s, "a"))
    expect(footnoteDefinitionPosition(s, "missing")).toBeNull()
    expect(footnoteReferencePosition(s, "missing")).toBeNull()
    expect(footnoteAt(s, 0)).toBeNull()
  })
})

describe("blockEntryPosition", () => {
  const doc = "para\n\n```ts\nline1\nline2\n```\n\nafter\n"
  const from = doc.indexOf("```ts")
  const to = doc.indexOf("```", from + 3) + 3   // closing fence 结尾
  const state = makeState(doc)

  it("down enters the first content line", () => {
    // fence 行的行尾 +1 = "line1" 行首
    expect(blockEntryPosition(state, from, to, 1)).toBe(state.doc.lineAt(from).to + 1)
    expect(doc.slice(blockEntryPosition(state, from, to, 1))).toBe("line1\nline2\n```\n\nafter\n")
  })

  it("up enters the last content line", () => {
    const pos = blockEntryPosition(state, from, to, -1)
    expect(doc.slice(pos)).toBe("line2\n```\n\nafter\n")
  })

  it("lands on the block start for degenerate single-line blocks", () => {
    // "---" HR 块：from..to 同一行，双向都落块首（边界含端，blockSelected 判块内）
    const hr = "x\n\n---\n\ny\n"
    const hFrom = hr.indexOf("---")
    const hTo = hFrom + 3
    const s = makeState(hr)
    expect(blockEntryPosition(s, hFrom, hTo, 1)).toBe(hFrom)
    expect(blockEntryPosition(s, hFrom, hTo, -1)).toBe(hFrom)
  })

  it("skips the math fence lines entering a $$ block", () => {
    const doc = "pre\n\n$$\na^2\n$$\n\npost\n"
    const mFrom = doc.indexOf("$$")
    const mTo = doc.lastIndexOf("$$") + 2
    const s = makeState(doc)
    expect(doc.slice(blockEntryPosition(s, mFrom, mTo, 1))).toBe("a^2\n$$\n\npost\n")
    expect(doc.slice(blockEntryPosition(s, mFrom, mTo, -1))).toBe("a^2\n$$\n\npost\n")
  })

  it("keeps the header row as the entry point for tables", () => {
    const doc = "pre\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\npost\n"
    const tFrom = doc.indexOf("| a |")
    const tTo = doc.lastIndexOf("| 2 |") + "| 2 |".length
    const s = makeState(doc)
    // 表头是内容行：向下进入落在表头行首，向上进入落在末数据行行首
    expect(blockEntryPosition(s, tFrom, tTo, 1)).toBe(tFrom)
    expect(doc.slice(blockEntryPosition(s, tFrom, tTo, -1))).toBe("| 1 | 2 |\n\npost\n")
  })
})
