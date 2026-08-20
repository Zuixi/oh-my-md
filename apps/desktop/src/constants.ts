/**
 * Single source of truth for values that cross the TS ↔ Rust (IPC) boundary or
 * are reused across the desktop app. Keep the values in sync with the named
 * constants in `src-tauri/src/lib.rs` and `src-tauri/src/workspace.rs`; the
 * drift guard lives in `test/crossLayerConstants.test.ts`.
 */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

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
export const RELEASES_URL = "https://github.com/Zuixi/open-md/releases"

/** Editor content max width in px; must match `--omd-content-width` in styles.css. */
export const CONTENT_MAX_WIDTH = 780

/** localStorage keys used by the desktop host. */
export const STORAGE_KEY_SIDEBAR_OPEN = "omd-sidebar-open"
export const STORAGE_KEY_OUTLINE_OPEN = "omd-outline-open"
export const STORAGE_KEY_SIDEBAR_WIDTH = "omd-sidebar-width"
export const STORAGE_KEY_RECENTS = "omd.recent-files"
export const STORAGE_KEY_SETTINGS = "omd_user_settings"
export const STORAGE_KEY_SESSION = "omd_saved_session"

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
