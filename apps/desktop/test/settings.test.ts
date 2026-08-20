import { describe, expect, it } from "vitest"
import {
  cssFamily,
  DEFAULT_SETTINGS,
  familyFromCssValue,
  parseSettings,
  sanitizeSettings,
  type UserSettings,
} from "../src/settings"

describe("settings model", () => {
  it("provides sensible default settings", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      theme: "system",
      fontSize: 16,
      fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      lineHeight: 1.6,
      tabSize: 2,
      defaultMode: "live",
      spellcheck: false,
      locale: "auto",
    })
  })

  it("sanitizes invalid or out-of-bound settings", () => {
    const sanitized = sanitizeSettings({
      fontSize: 100,
      lineHeight: 0.5,
      tabSize: 8 as any,
      theme: "invalid" as any,
      fontFamily: "   ",
    })

    expect(sanitized.fontSize).toBe(32)
    expect(sanitized.lineHeight).toBe(1.2)
    expect(sanitized.tabSize).toBe(2)
    expect(sanitized.theme).toBe("system")
    expect(sanitized.fontFamily).toBe(DEFAULT_SETTINGS.fontFamily)
  })

  it("parses valid JSON into UserSettings", () => {
    const json = JSON.stringify({
      theme: "dark",
      fontSize: 18,
      fontFamily: "Menlo",
      lineHeight: 1.8,
      tabSize: 4,
      defaultMode: "source",
      spellcheck: true,
      locale: "auto",
    } satisfies UserSettings)

    const parsed = parseSettings(json)
    expect(parsed).toEqual({
      theme: "dark",
      fontSize: 18,
      fontFamily: "Menlo",
      lineHeight: 1.8,
      tabSize: 4,
      defaultMode: "source",
      spellcheck: true,
      locale: "auto",
    })
  })

  it("handles corrupted JSON gracefully", () => {
    expect(parseSettings("invalid json{")).toEqual(DEFAULT_SETTINGS)
  })

  it("defaults locale to auto", () => {
    expect(DEFAULT_SETTINGS.locale).toBe("auto")
  })

  it("sanitizes invalid locale to auto", () => {
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, locale: "fr" as never }).locale).toBe("auto")
    expect(sanitizeSettings(null).locale).toBe("auto")
  })

  it("keeps valid locale", () => {
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, locale: "zh" }).locale).toBe("zh")
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, locale: "en" }).locale).toBe("en")
  })

  it("parseSettings tolerates missing locale", () => {
    const s = parseSettings(JSON.stringify({ theme: "dark" }))
    expect(s.locale).toBe("auto")
  })
})

describe("cssFamily", () => {
  it("wraps a plain family name in single quotes", () => {
    expect(cssFamily("Microsoft YaHei")).toBe("'Microsoft YaHei'")
  })

  it("escapes internal single quotes", () => {
    expect(cssFamily("Baekmuk's Batang")).toBe("'Baekmuk\\'s Batang'")
    expect(cssFamily("a'b'c")).toBe("'a\\'b\\'c'")
  })
})

describe("familyFromCssValue", () => {
  it("returns the family whose cssFamily token equals the value", () => {
    expect(familyFromCssValue("'Menlo'", ["Arial", "Menlo", "Microsoft YaHei"])).toBe("Menlo")
    expect(familyFromCssValue("'Microsoft YaHei'", ["Arial", "Microsoft YaHei"])).toBe("Microsoft YaHei")
  })

  it("returns null on a miss", () => {
    expect(familyFromCssValue("'Helvetica'", ["Arial", "Menlo"])).toBeNull()
    expect(familyFromCssValue("Menlo", ["Menlo"])).toBeNull()
    expect(familyFromCssValue("system-ui, sans-serif", ["system-ui"])).toBeNull()
  })
})
