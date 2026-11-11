import { DEFAULT_AUTO_PAIR, type AutoPairOptions } from "@omd/engine"
import type { StoredLocale } from "./i18n"

export type AppTheme = "system" | "light" | "dark"
export type DefaultEditorMode = "live" | "source"
export type TabSize = 2 | 4

export const FONT_SIZE_MIN = 12
export const FONT_SIZE_MAX = 32

export const LINE_HEIGHT_MIN = 1.2
export const LINE_HEIGHT_MAX = 2.4

export type ExportScale = 1 | 2 | 3

export const EXPORT_WIDTH_DEFAULT = 800
export const EXPORT_WIDTH_MIN = 320
export const EXPORT_WIDTH_MAX = 1920

export const EXPORT_WIDTH_PRESETS = [
  { value: 640, labelKey: "settings.export.width.640" },
  { value: EXPORT_WIDTH_DEFAULT, labelKey: "settings.export.width.800" },
  { value: 1200, labelKey: "settings.export.width.1200" },
  { value: EXPORT_WIDTH_MAX, labelKey: "settings.export.width.1920" },
] as const

/** The pixel-density multipliers the PNG exporter accepts. */
export const EXPORT_SCALE_OPTIONS = [1, 2, 3] as const

export const LINE_HEIGHT_PRESETS = [
  { value: 1.4, labelKey: "settings.lineHeight.compact" },
  { value: 1.6, labelKey: "settings.lineHeight.default" },
  { value: 1.8, labelKey: "settings.lineHeight.spacious" },
  { value: 2.0, labelKey: "settings.lineHeight.double" },
] as const

export const FONT_FAMILY_PRESETS = [
  { labelKey: "settings.font.systemDefault", value: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
  { labelKey: "settings.font.monospace", value: "ui-monospace, Menlo, Monaco, 'Cascadia Mono', Consolas, monospace" },
  { labelKey: "settings.font.serif", value: "Georgia, 'Times New Roman', serif" },
] as const

export interface UserSettings {
  theme: AppTheme
  fontSize: number
  fontFamily: string
  lineHeight: number
  tabSize: TabSize
  defaultMode: DefaultEditorMode
  spellcheck: boolean
  /** Engine-owned auto pairing toggles; persisted as one nested settings field. */
  autoPair: AutoPairOptions
  locale: StoredLocale
  /** CSS pixel width the PNG exporter renders at (see `EXPORT_WIDTH_MIN/MAX`). */
  exportWidth: number
  /** Pixel-density multiplier applied to `exportWidth` (1x/2x/3x). */
  exportScale: ExportScale
  /**
   * Persisted opt-in for logging at all. Default `false`: a fresh install
   * writes no log file until the user turns logging on (Rust reads the key out
   * of this JSON blob; see `constants.ts` `LOGGING_SETTINGS_KEY`).
   */
  loggingEnabled: boolean
  /** Changes whenever logging consent changes, so old session markers cannot
   * be mistaken for the immediately preceding run after an unlogged interval. */
  loggingGeneration: number
  /**
   * Persisted flag that raises the log level to `debug` on the next launch
   * (Rust reads the key out of this JSON blob; see `constants.ts`
   * `VERBOSE_LOGGING_SETTINGS_KEY`). The `OMD_LOG` env var still wins.
   */
  verboseLogging: boolean
}

export const DEFAULT_SETTINGS: UserSettings = {
  theme: "system",
  fontSize: 16,
  fontFamily: FONT_FAMILY_PRESETS[0].value,
  lineHeight: 1.6,
  tabSize: 2,
  defaultMode: "live",
  spellcheck: false,
  // 引擎默认值的单一来源（packages/engine/src/format/autoPair.ts）；此处只做浅拷贝，
  // 避免 desktop 侧再维护一份必须与引擎一致的字面量。
  autoPair: { ...DEFAULT_AUTO_PAIR },
  locale: "auto",
  // A 4K/Retina-safe PNG: 800 CSS px at 2x yields 1600 px wide.
  exportWidth: EXPORT_WIDTH_DEFAULT,
  exportScale: 2,
  loggingEnabled: false,
  loggingGeneration: 0,
  verboseLogging: false,
}

export function sanitizeSettings(raw: Partial<UserSettings> | null | undefined): UserSettings {
  if (!raw || typeof raw !== "object") return DEFAULT_SETTINGS
  const theme: AppTheme =
    raw.theme === "light" || raw.theme === "dark" || raw.theme === "system"
      ? raw.theme
      : DEFAULT_SETTINGS.theme

  const fontSize = typeof raw.fontSize === "number" && !Number.isNaN(raw.fontSize)
    ? Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(raw.fontSize)))
    : DEFAULT_SETTINGS.fontSize

  const fontFamily = typeof raw.fontFamily === "string" && raw.fontFamily.trim().length > 0
    ? raw.fontFamily.trim()
    : DEFAULT_SETTINGS.fontFamily

  const lineHeight = typeof raw.lineHeight === "number" && !Number.isNaN(raw.lineHeight)
    ? Math.max(LINE_HEIGHT_MIN, Math.min(LINE_HEIGHT_MAX, Math.round(raw.lineHeight * 10) / 10))
    : DEFAULT_SETTINGS.lineHeight

  const tabSize: TabSize = raw.tabSize === 4 ? 4 : 2

  const defaultMode: DefaultEditorMode =
    raw.defaultMode === "source" ? "source" : "live"

  const spellcheck = Boolean(raw.spellcheck)

  // settings.json written before the toggles existed has no `autoPair` (and a
  // hand-edited file may carry only some of the three): booleanize every flag
  // so `undefined` never reaches the engine's compartment. The fallback for each
  // flag is the engine constant — one source of truth for the defaults.
  const storedAutoPair: Partial<AutoPairOptions> = raw.autoPair ?? {}
  const flag = (value: boolean | undefined, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback
  const autoPair: AutoPairOptions = {
    brackets: flag(storedAutoPair.brackets, DEFAULT_AUTO_PAIR.brackets),
    quotes: flag(storedAutoPair.quotes, DEFAULT_AUTO_PAIR.quotes),
    markdownSyntax: flag(storedAutoPair.markdownSyntax, DEFAULT_AUTO_PAIR.markdownSyntax),
  }

  const locale: StoredLocale =
    raw.locale === "auto" || raw.locale === "en" || raw.locale === "zh" ? raw.locale : "auto"

  const exportWidth = typeof raw.exportWidth === "number" && Number.isFinite(raw.exportWidth)
    ? Math.max(EXPORT_WIDTH_MIN, Math.min(EXPORT_WIDTH_MAX, Math.round(raw.exportWidth)))
    : EXPORT_WIDTH_DEFAULT

  // Only the three density steps the native exporter understands; anything else
  // (hand-edited JSON, older builds) falls back to the Retina-safe default.
  const exportScale: ExportScale =
    raw.exportScale === 1 || raw.exportScale === 2 || raw.exportScale === 3
      ? raw.exportScale
      : 2

  // Strictly `=== true`: the value can arrive from hand-edited JSON or an older
  // build, and Rust's `as_bool()` rejects the string "true" the same way. A
  // truthy coercion here would let TS and Rust disagree about the same file.
  const loggingEnabled = raw.loggingEnabled === true
  const loggingGeneration = typeof raw.loggingGeneration === "number"
    && Number.isSafeInteger(raw.loggingGeneration) && raw.loggingGeneration >= 0
    ? raw.loggingGeneration
    : 0
  const verboseLogging = raw.verboseLogging === true

  return {
    theme,
    fontSize,
    fontFamily,
    lineHeight,
    tabSize,
    defaultMode,
    spellcheck,
    autoPair,
    locale,
    exportWidth,
    exportScale,
    loggingEnabled,
    loggingGeneration,
    verboseLogging,
  }
}

export function loggingGenerationAfterChange(current: UserSettings, next: UserSettings): number {
  return current.loggingEnabled === next.loggingEnabled
    ? current.loggingGeneration
    : current.loggingGeneration + 1
}

/** Change detection for the hot-apply path: a settings save only reconfigures
 * mounted views when a toggle actually flipped. Derived from the engine
 * constant's declared keys, so a fourth toggle cannot silently skip the hot
 * apply (it would still need a UI field, but it can no longer be forgotten here). */
const AUTO_PAIR_KEYS = Object.keys(DEFAULT_AUTO_PAIR) as ReadonlyArray<keyof AutoPairOptions>

export function sameAutoPair(a: AutoPairOptions, b: AutoPairOptions): boolean {
  return AUTO_PAIR_KEYS.every(key => a[key] === b[key])
}

export function parseSettings(json: string): UserSettings {
  try {
    const parsed = JSON.parse(json)
    return sanitizeSettings(parsed)
  } catch {
    return DEFAULT_SETTINGS
  }
}

/** Wraps a font family name as a single quoted CSS font-family token. */
export function cssFamily(name: string): string {
  return `'${name.replace(/'/g, "\\'")}'`
}

/** Returns the family whose cssFamily(name) equals value, else null. */
export function familyFromCssValue(
  value: string,
  families: readonly string[],
): string | null {
  return families.find(family => cssFamily(family) === value) ?? null
}
