import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { initLocale, setLocale, getLocale, subscribe, useT, resolveLocale, t } from "../src/i18n"
import { shortcutFor } from "../src/shortcuts"
import { en } from "../src/i18n/messages/en"
import { zh } from "../src/i18n/messages/zh"

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

  it("shortcut tooltip templates compose platform hints and keep mac glyphs byte-identical", () => {
    const outline = () => ({ shortcut: shortcutFor("outline") ?? "" })
    const pinUserAgent = (userAgent: string): void => {
      Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true })
    }
    const original = Object.getOwnPropertyDescriptor(window.navigator, "userAgent")

    pinUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")
    initLocale("en")
    expect(t("outline.title.toggleShow", outline())).toBe("Show outline (⇧⌘O)")
    expect(t("outline.title.toggleHide", outline())).toBe("Hide outline (⇧⌘O)")
    initLocale("zh")
    expect(t("outline.title.toggleShow", outline())).toBe("显示大纲（⇧⌘O）")
    expect(t("outline.title.toggleHide", outline())).toBe("隐藏大纲（⇧⌘O）")

    pinUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/4.0 Safari/605.1.15")
    initLocale("en")
    expect(t("outline.title.toggleShow", outline())).toBe("Show outline (Ctrl+Shift+O)")

    if (original) Object.defineProperty(window.navigator, "userAgent", original)
  })
})

// 双语文案是同一 UI 的两份投影：键集必须一致，否则一侧静默回退英文/键名。
// flat Record（dotted key），排序后逐键对照即可。
describe("i18n message parity", () => {
  it("en and zh expose the same key set", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
