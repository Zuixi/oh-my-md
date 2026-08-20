import { beforeEach, describe, expect, it } from "vitest"
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, STORAGE_KEY_SIDEBAR_WIDTH } from "../src/constants"
import { clampSidebarWidth, readSidebarWidth, writeSidebarWidth } from "../src/sidebarResize"

describe("clampSidebarWidth", () => {
  it("passes through widths inside the bounds", () => {
    expect(clampSidebarWidth(230, 1024)).toBe(230)
    expect(clampSidebarWidth(400, 1024)).toBe(400)
  })

  it("clamps below the minimum", () => {
    expect(clampSidebarWidth(50, 1024)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it("clamps above 60% of the viewport", () => {
    expect(clampSidebarWidth(2000, 800)).toBe(480)
  })

  it("still reaches the minimum on windows narrower than min / fraction", () => {
    expect(clampSidebarWidth(100, 200)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it("rounds fractional widths", () => {
    expect(clampSidebarWidth(230.6, 1024)).toBe(231)
  })
})

describe("sidebar width persistence", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("round-trips a stored width", () => {
    writeSidebarWidth(260)
    expect(localStorage.getItem(STORAGE_KEY_SIDEBAR_WIDTH)).toBe("260")
    expect(readSidebarWidth()).toBe(260)
  })

  it("falls back to the default for missing or invalid values", () => {
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH)
    localStorage.setItem(STORAGE_KEY_SIDEBAR_WIDTH, "not-a-number")
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it("clamps a stored width that outgrew the current window", () => {
    localStorage.setItem(STORAGE_KEY_SIDEBAR_WIDTH, "900")
    expect(readSidebarWidth()).toBe(clampSidebarWidth(900, window.innerWidth))
  })
})
