import { describe, expect, it } from "vitest"
import { ICON_NAMES, icon } from "../src/decorations/icons"

describe("inline svg icons", () => {
  it("vendors the nine open-source icons by name", () => {
    expect([...ICON_NAMES].sort()).toEqual([
      "check", "code", "column-insert-right", "column-remove", "copy",
      "pencil", "row-insert-bottom", "row-remove", "triangle-alert",
    ])
  })

  it("builds currentColor stroke svgs sized by font (1em)", () => {
    for (const name of ICON_NAMES) {
      const svg = icon(name)
      expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg")
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24")
      expect(svg.getAttribute("width")).toBe("1em")
      expect(svg.getAttribute("height")).toBe("1em")
      expect(svg.getAttribute("stroke")).toBe("currentColor")
      expect(svg.getAttribute("aria-hidden")).toBe("true")
      expect(svg.querySelectorAll("path").length).toBeGreaterThan(0)
    }
  })

  it("clones per call so callers can mount the same icon many times", () => {
    const a = icon("code")
    const b = icon("code")
    expect(a).not.toBe(b)
    document.body.append(a, b)
    expect(document.body.contains(a)).toBe(true)
    expect(document.body.contains(b)).toBe(true)
    a.remove()
    b.remove()
  })
})
