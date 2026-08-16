import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { initLocale, setLocale, getLocale, subscribe, useT, resolveLocale } from "../src/i18n"

describe("i18n store", () => {
  beforeEach(() => { initLocale("auto") })

  it("resolves auto from navigator.language", () => {
    vi.stubGlobal("navigator", { language: "zh-CN" })
    expect(resolveLocale("auto")).toBe("zh")
    vi.stubGlobal("navigator", { language: "en-US" })
    expect(resolveLocale("auto")).toBe("en")
    vi.unstubAllGlobals()
  })

  it("returns explicit locale as-is", () => {
    expect(resolveLocale("zh")).toBe("zh")
    expect(resolveLocale("en")).toBe("en")
  })

  it("initLocale sets current and calls setMenuLocale", () => {
    const setter = vi.fn()
    initLocale("zh", setter)
    expect(getLocale()).toBe("zh")
    expect(setter).toHaveBeenCalledWith("zh")
  })

  it("setLocale notifies subscribers", () => {
    const fn = vi.fn()
    const unsub = subscribe(fn)
    setLocale("en")
    expect(fn).toHaveBeenCalled()
    expect(getLocale()).toBe("en")
    unsub()
  })

  it("t resolves, interpolates, and never throws on missing key", () => {
    initLocale("en")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { result } = renderHook(() => useT())
    const t = result.current
    expect(t("image.broken", { src: "x.png" })).toBe("🖼 x.png (failed to load)")
    expect(t("nonexistent.key")).toBe("nonexistent.key")
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("useT re-renders on locale change", () => {
    initLocale("en")
    const { result } = renderHook(() => useT())
    const before = result.current("image.broken", { src: "y" })
    act(() => setLocale("zh"))
    const after = result.current("image.broken", { src: "y" })
    expect(before).not.toEqual(after)
  })
})
