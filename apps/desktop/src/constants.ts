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
export const STORAGE_KEY_RECENTS = "omd.recent-files"
export const STORAGE_KEY_SETTINGS = "omd_user_settings"
export const STORAGE_KEY_SESSION = "omd_saved_session"

// Mirrors @omd/engine LARGE_DOC_LINES / SAFE_MODE_LINES (drift-guarded in
// test/crossLayerConstants.test.ts).
export const LARGE_DOC_LINES = 30000
export const SAFE_MODE_LINES = 50000
