import { describe, expect, it } from "vitest"
import { formatFenceInfo, parseFenceInfo, replaceFenceInfo } from "../src/fenceInfo"
import { makeState } from "./helpers"

describe("fence info", () => {
  it("parses language only", () => {
    expect(parseFenceInfo("cpp")).toEqual({ lang: "cpp", title: "" })
  })

  it("parses language and title", () => {
    expect(parseFenceInfo("cpp Code block")).toEqual({ lang: "cpp", title: "Code block" })
  })

  it("parses empty info", () => {
    expect(parseFenceInfo("   ")).toEqual({ lang: "", title: "" })
  })

  it("formats language and title", () => {
    expect(formatFenceInfo("cpp", "Code block")).toBe("cpp Code block")
    expect(formatFenceInfo("sh", "")).toBe("sh")
    expect(formatFenceInfo("", "label")).toBe("")
  })

  it("round-trips through format and parse", () => {
    const raw = formatFenceInfo("typescript", "My snippet")
    expect(parseFenceInfo(raw)).toEqual({ lang: "typescript", title: "My snippet" })
  })

  it("keeps extra info tokens as the title suffix", () => {
    expect(parseFenceInfo("js foo bar")).toEqual({ lang: "js", title: "foo bar" })
    expect(formatFenceInfo("python", "foo bar")).toBe("python foo bar")
  })

  it("replaces CodeInfo from the live fenced block, not a stale offset", () => {
    const doc = "```js Demo\nconst x = 1\n```"
    const prefixed = makeState(doc).update({ changes: { from: 0, insert: "X\n" } }).state
    const spec = replaceFenceInfo(prefixed, "```js".length + 2, "python", "Demo")
    expect(spec).toEqual({ changes: { from: 5, to: 12, insert: "python Demo" } })
    const next = prefixed.update(spec!).state.doc.toString()
    expect(next).toBe("X\n```python Demo\nconst x = 1\n```")
  })
})
