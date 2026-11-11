import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  ASSETS_DIR_NAME,
  CONTENT_MAX_WIDTH,
  LARGE_DOC_LINES,
  LOG_FRONTEND_BUDGET_PER_SEC,
  LOG_ERROR_BUDGET_PER_SEC,
  LOG_MAX_BATCH_RECORDS,
  LOG_MAX_MESSAGE_CHARS,
  LOG_MAX_TARGET_CHARS,
  LOG_FRONTEND_COMMAND,
  LOG_KEEP_FILES,
  LOG_LEVEL_ENV_VAR,
  LOGGING_SETTINGS_KEY,
  LOGGING_GENERATION_SETTINGS_KEY,
  RELEASES_URL,
  REPO_SLUG,
  TROUBLESHOOTING_URL,
  ISSUES_URL,
  LOG_MAX_FILE_BYTES,
  LOG_PATH_FIELD_HELPERS,
  LOG_RATE_LIMIT_PER_SEC,
  LOG_TAIL_READ_BYTES,
  MARKDOWN_EXTENSIONS,
  MARKDOWN_FILE_EXTENSION,
  MAX_IMAGE_BYTES,
  MAX_RECENTS,
  MAX_SEARCH_HITS,
  MAX_SNAPSHOTS_PER_FILE,
  SAFE_MODE_LINES,
  SESSION_FLUSH_EVENT,
  SIDEBAR_DEFAULT_WIDTH,
  VERBOSE_LOGGING_SETTINGS_KEY,
} from "../src/constants"
import { LARGE_DOC_LINES as ENGINE_LARGE_DOC_LINES, SAFE_MODE_LINES as ENGINE_SAFE_MODE_LINES } from "@omd/engine"
import {
  DEFAULT_SETTINGS,
  EXPORT_SCALE_OPTIONS,
  EXPORT_WIDTH_MAX,
  EXPORT_WIDTH_MIN,
} from "../src/settings"

/**
 * Drift guard for constants that must agree across the TS and Rust sides of
 * the Tauri IPC boundary. TypeScript cannot see Rust source, and desktop tests
 * mock services at the TS boundary, so the only guard is asserting the two
 * definitions still match. If a value legitimately changes, update both sides
 * and this test.
 */

const LIB_RS = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8")
const PASTE_ASSETS_RS = readFileSync(resolve(process.cwd(), "src-tauri/src/paste_assets.rs"), "utf8")
const WORKSPACE_RS = readFileSync(resolve(process.cwd(), "src-tauri/src/workspace.rs"), "utf8")
const SESSION_FLUSH_RS = readFileSync(resolve(process.cwd(), "src-tauri/src/session_flush.rs"), "utf8")
const LOGGING_RS = readFileSync(resolve(process.cwd(), "src-tauri/src/logging.rs"), "utf8")
const LOG_FIELDS_RS = readFileSync(resolve(process.cwd(), "src-tauri/src/logging/fields.rs"), "utf8")
const EXPORT_RS = readFileSync(resolve(process.cwd(), "src-tauri/src/export.rs"), "utf8")
const STYLES_CSS = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8")
  .replace(/\r\n/g, "\n")

function rustConstNumber(source: string, name: string): number {
  // `u32` is here for LOG_FRONTEND_BUDGET_PER_SEC; the `*`-factor arithmetic
  // below already covers LOG_TAIL_READ_BYTES's `64 * 1024`.
  const match = new RegExp(`const ${name}: (?:usize|u64|u32) = ([^;]+);`).exec(source)
  if (!match) throw new Error(`missing Rust const ${name}`)
  return match[1]
    .split("*")
    .map(part => Number(part.trim()))
    .reduce((product, factor) => product * factor, 1)
}

function rustConstString(source: string, name: string): string {
  const match = new RegExp(`const ${name}: &str = "([^"]+)";`).exec(source)
  if (!match) throw new Error(`missing Rust const ${name}`)
  return match[1]
}

function rustConstStringList(source: string, name: string): string[] {
  const match = new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]+)\\];`).exec(source)
  if (!match) throw new Error(`missing Rust const ${name}`)
  return [...match[1].matchAll(/"([^"]+)"/g)].map(inner => inner[1])
}

describe("cross-layer constants (TS ↔ Rust)", () => {
  it("export width limits match export.rs", () => {
    expect(EXPORT_WIDTH_MIN).toBe(rustConstNumber(EXPORT_RS, "EXPORT_MIN_WIDTH_CSS"))
    expect(EXPORT_WIDTH_MAX).toBe(rustConstNumber(EXPORT_RS, "EXPORT_MAX_WIDTH_CSS"))
  })

  it("export scale steps match export.rs", () => {
    expect(EXPORT_SCALE_OPTIONS[0]).toBe(rustConstNumber(EXPORT_RS, "EXPORT_MIN_SCALE"))
    expect(EXPORT_SCALE_OPTIONS[EXPORT_SCALE_OPTIONS.length - 1]).toBe(
      rustConstNumber(EXPORT_RS, "EXPORT_MAX_SCALE"),
    )
  })

  it("image size cap matches paste_assets.rs MAX_IMAGE_BYTES", () => {
    expect(MAX_IMAGE_BYTES).toBe(rustConstNumber(PASTE_ASSETS_RS, "MAX_IMAGE_BYTES"))
  })

  it("recent-files cap matches lib.rs MAX_RECENT_FILES", () => {
    expect(MAX_RECENTS).toBe(rustConstNumber(LIB_RS, "MAX_RECENT_FILES"))
  })

  it("search hit cap matches workspace.rs MAX_SEARCH_HITS", () => {
    expect(MAX_SEARCH_HITS).toBe(rustConstNumber(WORKSPACE_RS, "MAX_SEARCH_HITS"))
  })

  it("snapshot retention cap matches workspace.rs MAX_SNAPSHOTS_PER_FILE", () => {
    expect(MAX_SNAPSHOTS_PER_FILE).toBe(
      rustConstNumber(WORKSPACE_RS, "MAX_SNAPSHOTS_PER_FILE"),
    )
  })

  it("markdown extensions match workspace.rs MARKDOWN_EXT", () => {
    expect([...MARKDOWN_EXTENSIONS]).toEqual(rustConstStringList(WORKSPACE_RS, "MARKDOWN_EXT"))
  })

  it("markdown file extension matches workspace.rs MARKDOWN_FILE_EXTENSION", () => {
    expect(MARKDOWN_FILE_EXTENSION).toBe(
      rustConstString(WORKSPACE_RS, "MARKDOWN_FILE_EXTENSION"),
    )
  })

  it("assets directory name matches paste_assets.rs ASSETS_DIR_NAME", () => {
    expect(ASSETS_DIR_NAME).toBe(rustConstString(PASTE_ASSETS_RS, "ASSETS_DIR_NAME"))
  })

  it("session flush event name matches session_flush.rs SESSION_FLUSH_EVENT", () => {
    expect(SESSION_FLUSH_EVENT).toBe(
      rustConstString(SESSION_FLUSH_RS, "SESSION_FLUSH_EVENT"),
    )
  })

  it("log rotation ceiling matches logging.rs LOG_MAX_FILE_BYTES", () => {
    expect(LOG_MAX_FILE_BYTES).toBe(rustConstNumber(LOGGING_RS, "LOG_MAX_FILE_BYTES"))
  })

  it("log archive retention matches logging.rs LOG_KEEP_FILES", () => {
    expect(LOG_KEEP_FILES).toBe(rustConstNumber(LOGGING_RS, "LOG_KEEP_FILES"))
  })

  it("log level env var matches logging.rs LOG_LEVEL_ENV_VAR", () => {
    expect(LOG_LEVEL_ENV_VAR).toBe(rustConstString(LOGGING_RS, "LOG_LEVEL_ENV_VAR"))
  })

  // The verbose toggle is a JSON key, not a typed field: Rust parses the blob
  // this side serializes, so a rename on one side leaves the checkbox writing a
  // key nothing reads and the level unchanged. Nothing else would catch it.
  // The opt-in key is the consent contract: Rust decides whether to write
  // anything from this JSON blob, so a rename on one side would silently keep
  // logging off (or on) regardless of the checkbox.
  it("logging opt-in key matches logging.rs LOGGING_SETTINGS_KEY", () => {
    expect(LOGGING_SETTINGS_KEY).toBe(rustConstString(LOGGING_RS, "LOGGING_SETTINGS_KEY"))
    expect(Object.keys(DEFAULT_SETTINGS)).toContain(LOGGING_SETTINGS_KEY)
    // And it must default to off, or a fresh install writes before consent.
    expect(DEFAULT_SETTINGS.loggingEnabled).toBe(false)
  })

  it("logging continuity key matches the native session scanner", () => {
    expect(LOGGING_GENERATION_SETTINGS_KEY).toBe(rustConstString(LOGGING_RS, "LOGGING_GENERATION_SETTINGS_KEY"))
    expect(Object.keys(DEFAULT_SETTINGS)).toContain(LOGGING_GENERATION_SETTINGS_KEY)
  })

  it("verbose-logging settings key matches logging.rs VERBOSE_LOGGING_SETTINGS_KEY", () => {
    expect(VERBOSE_LOGGING_SETTINGS_KEY).toBe(
      rustConstString(LOGGING_RS, "VERBOSE_LOGGING_SETTINGS_KEY"),
    )
    // And the key must be the name the settings shape actually serializes.
    expect(Object.keys(DEFAULT_SETTINGS)).toContain(VERBOSE_LOGGING_SETTINGS_KEY)
  })

  it("frontend log command name matches logging.rs LOG_FRONTEND_COMMAND", () => {
    expect(LOG_FRONTEND_COMMAND).toBe(rustConstString(LOGGING_RS, "LOG_FRONTEND_COMMAND"))
  })

  it("Rust frontend budget matches logging.rs LOG_FRONTEND_BUDGET_PER_SEC", () => {
    expect(LOG_FRONTEND_BUDGET_PER_SEC).toBe(
      rustConstNumber(LOGGING_RS, "LOG_FRONTEND_BUDGET_PER_SEC"),
    )
  })

  it("bounds frontend batches, individual records, and the independent error reserve on both sides", () => {
    for (const [name, value] of Object.entries({ LOG_ERROR_BUDGET_PER_SEC, LOG_MAX_BATCH_RECORDS, LOG_MAX_MESSAGE_CHARS, LOG_MAX_TARGET_CHARS })) {
      expect(rustConstNumber(LOGGING_RS, name), name).toBe(value)
    }
  })

  it("log tail read size matches logging.rs LOG_TAIL_READ_BYTES", () => {
    expect(LOG_TAIL_READ_BYTES).toBe(rustConstNumber(LOGGING_RS, "LOG_TAIL_READ_BYTES"))
  })

  it("path-field markers match the shared fixture the redactor parses", () => {
    // §3.7's grammar is one fixture consumed by the Rust and TS tests alike.
    // The constant's "no drift assertion yet" note is what this replaces: the
    // marker is now asserted against the fixture and against the literal the
    // Rust helper formats, so a rename on either side cannot pass silently.
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), "test/fixtures/logPathCases.json"), "utf8"),
    ) as { single: { field: string }[]; multi: { field: string }[] }

    const [singlePrefix, pathsPrefix] = LOG_PATH_FIELD_HELPERS
    expect(fixture.single[0].field.startsWith(singlePrefix)).toBe(true)
    expect(fixture.multi[0].field.startsWith(pathsPrefix)).toBe(true)
    expect(LOG_FIELDS_RS).toContain(`format!("${singlePrefix}{}`)
    expect(LOG_FIELDS_RS).toContain(`format!("${pathsPrefix.slice(0, -1)}`)
  })

  it("Rust frontend budget stays above the frontend rate limit", () => {
    // Otherwise layer 4 silently truncates records the facade considers legitimate.
    expect(LOG_FRONTEND_BUDGET_PER_SEC).toBeGreaterThan(LOG_RATE_LIMIT_PER_SEC)
  })

  it("uses the approved 900px readable column width", () => {
    expect(CONTENT_MAX_WIDTH).toBe(900)
    expect(STYLES_CSS.match(/--omd-content-width:\s*900px;/g)).toHaveLength(2)
  })

  it("sidebar default width matches styles.css --omd-sidebar-width fallback", () => {
    expect(STYLES_CSS).toContain(`var(--omd-sidebar-width, ${SIDEBAR_DEFAULT_WIDTH}px)`)
  })

  it("outline sidebar (sidebar-secondary) default width matches the file sidebar default", () => {
    // The outline panel has no drag resizer, so its fixed width must track the
    // file sidebar's *default* (not its live drag var).
    expect(STYLES_CSS).toMatch(
      new RegExp(`\\.sidebar-secondary\\s*\\{[^}]*width:\\s*${SIDEBAR_DEFAULT_WIDTH}px`, "m"),
    )
  })

  it("large-doc thresholds match engine constants", () => {
    expect(LARGE_DOC_LINES).toBe(ENGINE_LARGE_DOC_LINES)
    expect(SAFE_MODE_LINES).toBe(ENGINE_SAFE_MODE_LINES)
  })
})

describe("dark mode coverage (styles.css ↔ SettingsModal.tsx)", () => {
  const SETTINGS_MODAL_TSX = readFileSync(resolve(process.cwd(), "src/SettingsModal.tsx"), "utf8")

  function themeBlock(selector: string): string {
    const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(STYLES_CSS)
    if (!match) throw new Error(`missing styles.css block for ${selector}`)
    return match[1]
  }

  it("light and dark theme blocks declare matching color-scheme", () => {
    // Native scrollbars and form controls follow color-scheme, not
    // data-theme variables — omitting it leaves them light in dark mode.
    expect(themeBlock(':root,\nhtml[data-theme="light"]')).toContain("color-scheme: light")
    expect(themeBlock('html[data-theme="dark"]')).toContain("color-scheme: dark")
  })

  it("settings footer button classes used by SettingsModal exist in styles.css", () => {
    for (const cls of ["settings-btn-primary", "settings-btn-secondary"]) {
      expect(SETTINGS_MODAL_TSX).toContain(cls)
      expect(new RegExp(`\\.${cls}\\s*\\{`).test(STYLES_CSS)).toBe(true)
    }
  })
})

// The two user-facing links live in Settings, so a fork rename (or a move of the
// guide) would silently ship a 404 from inside the product. Both must be built
// from the same owner/repo as the release URLs.
describe("user-facing URLs", () => {
  it("builds every fixed URL from the same repository slug", () => {
    expect(RELEASES_URL).toContain(REPO_SLUG)
    expect(TROUBLESHOOTING_URL).toContain(REPO_SLUG)
    expect(ISSUES_URL).toContain(REPO_SLUG)
    expect(TROUBLESHOOTING_URL.endsWith("/docs/guides/troubleshooting.md")).toBe(true)
  })

  it("points the guide at a file the repository actually has", () => {
    // The URL is the shipped contract; this keeps the local path honest too.
    expect(existsSync(resolve(process.cwd(), "../../docs/guides/troubleshooting.md"))).toBe(true)
  })
})
