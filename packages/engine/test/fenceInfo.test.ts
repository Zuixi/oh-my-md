import { describe, expect, it } from "vitest"
import { formatFenceInfo, parseFenceInfo } from "../src/fenceInfo"

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
    expect(formatFenceInfo("", "label")).toBe("label")
  })

  it("round-trips through format and parse", () => {
    const raw = formatFenceInfo("typescript", "My snippet")
    expect(parseFenceInfo(raw)).toEqual({ lang: "typescript", title: "My snippet" })
  })
})
