import { describe, expect, it } from "vitest"
import {
  cssFamily,
  DEFAULT_SETTINGS,
  EXPORT_WIDTH_DEFAULT,
  EXPORT_WIDTH_MAX,
  EXPORT_WIDTH_MIN,
  familyFromCssValue,
  parseSettings,
  loggingGenerationAfterChange,
  sameAutoPair,
  sanitizeSettings,
  type UserSettings,
} from "../src/settings"
import { LOGGING_SETTINGS_KEY, VERBOSE_LOGGING_SETTINGS_KEY } from "../src/constants"

describe("settings model", () => {
  it("advances log continuity when consent changes", () => {
    expect(loggingGenerationAfterChange(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, loggingEnabled: true })).toBe(1)
    expect(loggingGenerationAfterChange({ ...DEFAULT_SETTINGS, loggingEnabled: true, loggingGeneration: 3 }, { ...DEFAULT_SETTINGS, loggingEnabled: true, loggingGeneration: 3, verboseLogging: true })).toBe(3)
    expect(loggingGenerationAfterChange({ ...DEFAULT_SETTINGS, loggingEnabled: true, loggingGeneration: 3 }, { ...DEFAULT_SETTINGS, loggingEnabled: false, loggingGeneration: 3 })).toBe(4)
  })
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
      // Retina-safe PNG export: 800 CSS px at 2x = 1600 px wide.
      exportWidth: 800,
      exportScale: 2,
      // Opt-in: a fresh install writes no log file.
      loggingEnabled: false,
      loggingGeneration: 0,
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
      exportWidth: 1200,
      exportScale: 3,
      loggingEnabled: true,
      loggingGeneration: 0,
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
      exportWidth: 1200,
      exportScale: 3,
      loggingEnabled: true,
      loggingGeneration: 0,
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

// PNG export size: the width is the CSS pixel width of the rendered preview,
// the scale is the pixel-density multiplier, so the exported bitmap is
// width × scale device pixels wide. Defaults must stay Retina-safe (1600 px).
describe("export image settings", () => {
  it("defaults to 800 CSS px wide at 2x scale", () => {
    expect(DEFAULT_SETTINGS.exportWidth).toBe(EXPORT_WIDTH_DEFAULT)
    expect(DEFAULT_SETTINGS.exportScale).toBe(2)
  })

  it("clamps and rounds the export width", () => {
    expect(sanitizeSettings({ exportWidth: 100 }).exportWidth).toBe(EXPORT_WIDTH_MIN)
    expect(sanitizeSettings({ exportWidth: 9999 }).exportWidth).toBe(EXPORT_WIDTH_MAX)
    expect(sanitizeSettings({ exportWidth: 800.6 }).exportWidth).toBe(801)
  })

  it("falls back to the default width for absent or non-finite values", () => {
    expect(sanitizeSettings({}).exportWidth).toBe(EXPORT_WIDTH_DEFAULT)
    expect(sanitizeSettings({ exportWidth: NaN }).exportWidth).toBe(EXPORT_WIDTH_DEFAULT)
    expect(sanitizeSettings({ exportWidth: Infinity }).exportWidth).toBe(EXPORT_WIDTH_DEFAULT)
    expect(sanitizeSettings({ exportWidth: "800" as never }).exportWidth).toBe(EXPORT_WIDTH_DEFAULT)
  })

  it("accepts only 1x, 2x or 3x scale", () => {
    expect(sanitizeSettings({ exportScale: 1 }).exportScale).toBe(1)
    expect(sanitizeSettings({ exportScale: 3 }).exportScale).toBe(3)
    for (const value of [0, 4, 1.5, "2", null, undefined]) {
      expect(sanitizeSettings({ exportScale: value } as never).exportScale).toBe(2)
    }
  })

  it("gives settings.json written before the fields existed the defaults", () => {
    const parsed = parseSettings(JSON.stringify({ theme: "dark" }))
    expect(parsed.exportWidth).toBe(EXPORT_WIDTH_DEFAULT)
    expect(parsed.exportScale).toBe(2)
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

// Logging is consent-gated, so the default must be "nothing is written" and only
// the exact boolean `true` — the same rule Rust applies to the same JSON blob —
// may change it.
describe("logging opt-in setting", () => {
  it("defaults to off", () => {
    expect(DEFAULT_SETTINGS.loggingEnabled).toBe(false)
    expect(LOGGING_SETTINGS_KEY).toBe("loggingEnabled")
  })

  it("accepts only the boolean true", () => {
    expect(sanitizeSettings({ loggingEnabled: true }).loggingEnabled).toBe(true)
    for (const value of [false, "true", 1, null, undefined]) {
      expect(sanitizeSettings({ loggingEnabled: value } as never).loggingEnabled).toBe(false)
    }
  })

  it("keeps the verbose opt-in independent", () => {
    const settings = sanitizeSettings({ loggingEnabled: false, verboseLogging: true })
    expect(settings.loggingEnabled).toBe(false)
    expect(settings.verboseLogging).toBe(true)
  })
})
