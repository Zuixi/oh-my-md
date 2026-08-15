import { describe, expect, it } from "vitest"
import {
  classifyLink,
  footnoteAt,
  footnoteDefinitionPosition,
  footnoteReferencePosition,
} from "../src/index"
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
