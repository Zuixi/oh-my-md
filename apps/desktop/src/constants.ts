/**
 * Single source of truth for values that cross the TS ↔ Rust (IPC) boundary or
 * are reused across the desktop app. Keep the values in sync with the named
 * constants in `src-tauri/src/lib.rs` and `src-tauri/src/workspace.rs`; the
 * drift guard lives in `test/crossLayerConstants.test.ts`.
 */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const SMART_PASTE_STATUS_CHARS = 100_000

export const MAX_RECENTS = 10

export const MAX_SEARCH_HITS = 500

/** Version-history snapshots kept per file; must match Rust MAX_SNAPSHOTS_PER_FILE. */
export const MAX_SNAPSHOTS_PER_FILE = 20

export const MARKDOWN_FILE_EXTENSION = "md"

export const MARKDOWN_EXTENSIONS: readonly string[] = [
  MARKDOWN_FILE_EXTENSION,
  "markdown",
  "mdx",
]

export const ASSETS_DIR_NAME = "assets"

/** GitHub Releases page used by update notifications; matches the release CI target repo. */
export const RELEASES_URL = "https://github.com/Zuixi/oh-my-md/releases/latest"

/** Owner/repo both user-facing links are built from, so a rename is one edit.
 *  `crossLayerConstants.test.ts` pins that every fixed URL uses it. */
export const REPO_SLUG = "Zuixi/oh-my-md"

/** The troubleshooting guide: log locations, the diagnostics bundle, and how to
 *  report a problem. Settings → Logging links here; without it the feature ends
 *  at "turn on logging" with no next step. */
export const TROUBLESHOOTING_URL = `https://github.com/${REPO_SLUG}/blob/main/docs/guides/troubleshooting.md`

/** New-issue form, so the guide's "send us the bundle" step is one click. */
export const ISSUES_URL = `https://github.com/${REPO_SLUG}/issues/new`

/** Windows CPU architectures the NSIS setup asset is published for. */
export type WindowsSetupArch = "x64" | "arm64"

/**
 * Direct download URL for the NSIS setup.exe published with a release.
 *
 * The asset name is produced by the Tauri bundler and pinned by the release
 * workflow (it fails when `oh-my-md_${version}_x64-setup.exe` is missing),
 * so this URL shape is a contract — keep it identical to
 * `immutableUrl` in scripts/update-manifest.mjs. Used by the in-app updater
 * to deep-link check-only (e.g. former MSI) installs straight to the
 * installer instead of a releases page the user must read.
 */
export function windowsSetupAssetUrl(version: string, arch: WindowsSetupArch = "x64"): string {
  return `https://github.com/Zuixi/oh-my-md/releases/download/v${version}/oh-my-md_${version}_${arch}-setup.exe`
}

/** Startup automatic-update check delay (spec §10: eight seconds after mount).
 *  Frontend-only: the check is scheduled by the desktop App, not by Rust. */
export const STARTUP_UPDATE_CHECK_MS = 8000

/** Editor content max width in px; must match `--omd-content-width` in styles.css. */
export const CONTENT_MAX_WIDTH = 900

/** localStorage keys used by the desktop host. */
export const STORAGE_KEY_SIDEBAR_OPEN = "omd-sidebar-open"
export const STORAGE_KEY_OUTLINE_OPEN = "omd-outline-open"
export const STORAGE_KEY_SIDEBAR_WIDTH = "omd-sidebar-width"
export const STORAGE_KEY_RECENTS = "omd.recent-files"
export const STORAGE_KEY_SETTINGS = "omd_user_settings"
export const STORAGE_KEY_SESSION = "omd_saved_session"

/** Quit-time session flush event emitted by the Rust FlushGate
 *  (src-tauri/src/session_flush.rs `SESSION_FLUSH_EVENT`); drift-guarded in
 *  test/crossLayerConstants.test.ts. */
export const SESSION_FLUSH_EVENT = "session-flush"

/** File-sidebar drag-resize bounds; the default must match the
 *  `--omd-sidebar-width` fallback in styles.css (drift-guarded in
 *  test/crossLayerConstants.test.ts). */
export const SIDEBAR_MIN_WIDTH = 170
export const SIDEBAR_DEFAULT_WIDTH = 230
/** The sidebar never grows past this fraction of the window width. */
export const SIDEBAR_MAX_WINDOW_FRACTION = 0.6
/** Width step for keyboard resize on the sash (ArrowLeft/ArrowRight). */
export const SIDEBAR_KEYBOARD_STEP = 10

// Mirrors @omd/engine LARGE_DOC_LINES / SAFE_MODE_LINES (drift-guarded in
// test/crossLayerConstants.test.ts).
export const LARGE_DOC_LINES = 30000
export const SAFE_MODE_LINES = 50000

/**
 * Spec 05b open tiers, by exact UTF-8 byte length (Rust stat/read stats):
 * - < OPEN_STREAM_THRESHOLD_BYTES: today's behavior, one-shot read.
 * - ≥ threshold and < OPEN_READONLY_THRESHOLD_BYTES: confirm, then safe mode
 *   by bytes — live preview renders progressively (closes the long-line blind
 *   spot where a multi-MB file under 50k lines skipped every large-doc protection).
 * - ≥ OPEN_READONLY_THRESHOLD_BYTES: confirm a read-only live-preview open.
 */
export const OPEN_STREAM_THRESHOLD_BYTES = 10 * 1024 * 1024
export const OPEN_READONLY_THRESHOLD_BYTES = 50 * 1024 * 1024
/** Byte axis of safe mode; kept equal to the confirm tier boundary. */
export const SAFE_MODE_BYTES = OPEN_STREAM_THRESHOLD_BYTES

/**
 * Ceiling on how long `runOpen` waits for the active tab's in-flight save queue
 * before opening anyway. A large save (double probe + fsync) can run for
 * minutes under Windows antivirus scanning; an unbounded await turns "reopen
 * file" into a permanent silent hang because the queue entry never settles.
 */
export const OPEN_SAVE_QUEUE_TIMEOUT_MS = 3000

/**
 * Application logging (spec
 * docs/superpowers/specs/2026-10-03-logging-and-diagnostics-design.md §3.10).
 * Cross-layer values are drift-guarded in test/crossLayerConstants.test.ts
 * against `src-tauri/src/logging.rs`.
 */

/** Application log file name stem. Rust derives this from the package name
 *  (`logging.rs::log_file_stem`), so there is no Rust const to guard against. */
export const LOG_FILE_STEM = "oh-my-md"

/** Rotation ceiling per file; must match Rust `LOG_MAX_FILE_BYTES`. */
export const LOG_MAX_FILE_BYTES = 2 * 1024 * 1024

/** Archived generations kept; must match Rust `LOG_KEEP_FILES`. */
export const LOG_KEEP_FILES = 5

/** Runtime level override; must match Rust `LOG_LEVEL_ENV_VAR`. */
export const LOG_LEVEL_ENV_VAR = "OMD_LOG"

/** Persisted Settings key that turns logging on at all; must match Rust
 *  `LOGGING_SETTINGS_KEY`. Default off: the user opts in. */
export const LOGGING_SETTINGS_KEY = "loggingEnabled"
export const LOGGING_GENERATION_SETTINGS_KEY = "loggingGeneration"

/** Persisted Settings key that turns on verbose logging; must match Rust
 *  `VERBOSE_LOGGING_SETTINGS_KEY`. Rust has no typed settings struct — it parses
 *  the raw JSON blob this TypeScript shape serializes — so the key itself is the
 *  contract, and a rename on one side would silently leave the toggle inert. */
export const VERBOSE_LOGGING_SETTINGS_KEY = "verboseLogging"

/** IPC command for frontend records; must match Rust `LOG_FRONTEND_COMMAND`. */
export const LOG_FRONTEND_COMMAND = "log_frontend"

/** Diagnostics bundle format. Task 12 adds the Rust writer, so there is no
 *  drift assertion yet — one that throws on a missing Rust const would break
 *  the suite. */
export const DIAGNOSTICS_BUNDLE_FORMAT_VERSION = 1

/** Rust-side process budget (§3.9 layer 4). Must stay above
 *  LOG_RATE_LIMIT_PER_SEC, or the Rust net silently truncates legitimate logs. */
export const LOG_FRONTEND_BUDGET_PER_SEC = 200

/** IPC safety bounds, mirrored in Rust. A separate error reserve prevents
 * warnings from starving fatal records while still bounding an error storm. */
export const LOG_ERROR_BUDGET_PER_SEC = 50
export const LOG_MAX_BATCH_RECORDS = 200
export const LOG_MAX_MESSAGE_CHARS = 8192
export const LOG_MAX_TARGET_CHARS = 128

/** Log tail the session scanner reads; must match Rust `LOG_TAIL_READ_BYTES`. */
export const LOG_TAIL_READ_BYTES = 64 * 1024

/** Structured path-field markers. Drift-guarded in `crossLayerConstants.test.ts`
 *  against the shared fixture the Rust and TS helpers both answer to
 *  (`test/fixtures/logPathCases.json`), not against a Rust const. */
export const LOG_PATH_FIELD_HELPERS = ["path=", "paths="] as const

// Frontend-only rate control (§3.9 layers 1–3): nothing on the Rust side reads
// these, so they have no drift guard.

/** Records offered to the IPC per second. */
export const LOG_RATE_LIMIT_PER_SEC = 50

/** Drops within the window that trip the breaker. */
export const LOG_BREAKER_DROPS = 1000

/** Breaker measurement window. */
export const LOG_BREAKER_WINDOW_MS = 5000

/** How long the breaker stays open. */
export const LOG_BREAKER_COOLDOWN_MS = 30000

/** Level that bypasses ordinary suppression, while obeying hard queue and native error bounds. */
export const LOG_ALWAYS_PASS_LEVEL = "error"

/** How long the facade buffers before delivering its own batch (§3.9). Long
 *  enough to coalesce a burst. Fatal capture requests an immediate flush;
 *  delivery before a webview/process crash is still best-effort.
 *  Frontend-only: no Rust const reads it, so it has no drift guard. */
export const LOG_FLUSH_INTERVAL_MS = 250
