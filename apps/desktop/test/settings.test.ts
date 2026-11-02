import { describe, expect, it } from "vitest"
import {
  cssFamily,
  DEFAULT_SETTINGS,
  familyFromCssValue,
  parseSettings,
  sameAutoPair,
  sanitizeSettings,
  type UserSettings,
} from "../src/settings"
import { VERBOSE_LOGGING_SETTINGS_KEY } from "../src/constants"

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
      autoPair: { brackets: true, quotes: true, markdownSyntax: true },
      locale: "auto",
      verboseLogging: false,
    })
  })

  // Rust reads this key out of the raw settings JSON with no typed struct, so
  // the literal is the whole contract. Renaming the property without renaming
  // the key Rust looks for would leave the toggle silently inert: the checkbox
  // would save, the file would contain the value, and the level would never
  // change.
  it("names the verbose-logging key Rust reads from the JSON blob", () => {
    expect(VERBOSE_LOGGING_SETTINGS_KEY).toBe("verboseLogging")
    expect(Object.keys(DEFAULT_SETTINGS)).toContain(VERBOSE_LOGGING_SETTINGS_KEY)
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

  // The persisted flag is a boolean, but it arrives from JSON a user or an older
  // build can hand-edit, so only a real `true` may win. `"true"` is a string
  // that Rust's `as_bool()` also refuses, which keeps both sides agreeing.
  it("coerces verboseLogging to a boolean, defaulting to false", () => {
    expect(sanitizeSettings(undefined).verboseLogging).toBe(false)
    expect(sanitizeSettings(null).verboseLogging).toBe(false)
    expect(sanitizeSettings({}).verboseLogging).toBe(false)
    expect(sanitizeSettings({ verboseLogging: "true" as never }).verboseLogging).toBe(false)
    expect(sanitizeSettings({ verboseLogging: 1 as never }).verboseLogging).toBe(false)
    expect(sanitizeSettings({ verboseLogging: true }).verboseLogging).toBe(true)
    expect(sanitizeSettings({ verboseLogging: false }).verboseLogging).toBe(false)
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
      autoPair: { brackets: false, quotes: true, markdownSyntax: false },
      locale: "auto",
      verboseLogging: true,
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
      autoPair: { brackets: false, quotes: true, markdownSyntax: false },
      locale: "auto",
      verboseLogging: true,
    })
  })

  it("defaults auto pair on for settings.json written before the toggles existed", () => {
    expect(parseSettings(JSON.stringify({ theme: "dark" })).autoPair).toEqual({
      brackets: true,
      quotes: true,
      markdownSyntax: true,
    })
  })

  it("fills a partial auto pair object instead of passing undefined to the engine", () => {
    expect(parseSettings('{"autoPair":{"quotes":false}}').autoPair).toEqual({
      brackets: true,
      quotes: false,
      markdownSyntax: true,
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

describe("sameAutoPair", () => {
  const all: UserSettings["autoPair"] = { brackets: true, quotes: true, markdownSyntax: true }

  it("treats an equal toggle set as unchanged", () => {
    expect(sameAutoPair({ ...all }, { ...all })).toBe(true)
  })

  it("notices every individual toggle flip", () => {
    expect(sameAutoPair({ ...all, brackets: false }, all)).toBe(false)
    expect(sameAutoPair({ ...all, quotes: false }, all)).toBe(false)
    expect(sameAutoPair({ ...all, markdownSyntax: false }, all)).toBe(false)
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
