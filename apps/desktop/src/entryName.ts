import { MARKDOWN_FILE_EXTENSION } from "./constants"

/** Entries the tree can create: Markdown files and folders. */
export type EntryKind = "file" | "folder"

/**
 * Why a candidate name cannot be used. The UI owns the localized copy; this
 * module stays pure and returns stable codes.
 */
export type EntryNameProblem =
  | "empty"
  | "separators"
  | "traversal"
  | "hidden"
  | "reserved"
  | "trailing"
  | "tooLong"

/** i18n key for each problem; keep in sync with i18n/messages/{en,zh}.ts. */
export const ENTRY_NAME_PROBLEM_KEYS: Readonly<Record<EntryNameProblem, string>> = {
  empty: "error.name.empty",
  separators: "error.name.separators",
  traversal: "error.name.traversal",
  hidden: "error.name.hidden",
  reserved: "error.name.reserved",
  trailing: "error.name.trailing",
  tooLong: "error.name.tooLong",
}

/**
 * Most filesystems cap a single segment at 255 bytes (APFS/ext4); Windows caps
 * at 255 UTF-16 units, which this byte bound never exceeds for ASCII names.
 */
const MAX_ENTRY_NAME_BYTES = 255

const FILE_BASE_NAME = "untitled"
const FOLDER_BASE_NAME = "untitled-folder"

/**
 * Device names Windows refuses even with an extension (`CON.md`). Creating one
 * on macOS/Linux would produce a workspace that cannot be opened on Windows,
 * which is a first-class target, so reject them on every platform.
 */
const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

/**
 * Extensions `list_dir` shows as Markdown (Rust `is_markdown`). The tree can
 * rename `.markdown`/`.mdx` files, but Rust's `create_markdown` accepts only a
 * literal `.md` and `rename_path` requires a literal `.md` target whenever the
 * source extension is `.md` in any casing. Longest first so `.markdown` is not
 * mistaken for a shorter suffix.
 */
const MARKDOWN_EXTENSIONS = ["markdown", "mdx", MARKDOWN_FILE_EXTENSION] as const

/** Index of a trailing Markdown extension in any casing, or null. */
function markdownExtensionStart(name: string): number | null {
  const lower = name.toLowerCase()
  for (const extension of MARKDOWN_EXTENSIONS) {
    if (lower.endsWith(`.${extension}`)) return lower.length - extension.length - 1
  }
  return null
}

/**
 * Index where a Markdown file's base name ends (the start of its extension),
 * so rename selection excludes `.md`, `.markdown`, and `.mdx` alike.
 */
export function markdownBaseNameEnd(name: string): number {
  return markdownExtensionStart(name) ?? name.length
}

/**
 * Ensures a file name ends in a Markdown extension; never returns an empty
 * name. A recognized extension is replaced rather than appended, so
 * `notes.markdown` becomes `notes.md` instead of `notes.markdown.md` and
 * `NOTES.MD` becomes `NOTES.md` (Rust's create check is case-sensitive).
 *
 * `keepExtension` is for renames: `.markdown`/`.mdx` stay as typed because the
 * file already exists with that spelling. `.md` variants still normalize to
 * lowercase, which is the only form Rust accepts when a `.md` file is renamed.
 */
export function normalizeMarkdownName(raw: string, keepExtension = false): string {
  const trimmed = raw.trim()
  const start = markdownExtensionStart(trimmed)
  if (start === null) return `${trimmed}.${MARKDOWN_FILE_EXTENSION}`
  const extension = trimmed.slice(start + 1).toLowerCase()
  if (keepExtension && extension !== MARKDOWN_FILE_EXTENSION) return trimmed
  return `${trimmed.slice(0, start)}.${MARKDOWN_FILE_EXTENSION}`
}

export interface PrepareEntryNameOptions {
  /** Rename keeps `.markdown`/`.mdx`; create always writes a `.md` file. */
  keepMarkdownExtension?: boolean
}

/**
 * Normalizes a user-typed name for the given kind and reports the first rule
 * it violates. For files the extension is normalized before the remaining
 * rules run, so `notes` and `notes.md` validate identically.
 */
export function prepareEntryName(
  raw: string,
  kind: EntryKind,
  options: PrepareEntryNameOptions = {},
): { name: string; problem: EntryNameProblem | null } {
  const trimmed = raw.trim()
  if (trimmed === "") return { name: "", problem: "empty" }
  if (trimmed === "." || trimmed === "..") return { name: trimmed, problem: "traversal" }
  // Check before appending the extension: `draft.` would otherwise become the
  // legal-looking `draft..md` and silently change what the user typed.
  if (/[. ]$/.test(trimmed)) return { name: trimmed, problem: "trailing" }
  const name = kind === "file"
    ? normalizeMarkdownName(trimmed, options.keepMarkdownExtension === true)
    : trimmed
  return { name, problem: validateEntryName(name) }
}

/** First rule `name` violates, or null when the name is usable. */
export function validateEntryName(name: string): EntryNameProblem | null {
  if (name === "") return "empty"
  if (name.includes("/") || name.includes("\\")) return "separators"
  if (name === "." || name === "..") return "traversal"
  // list_dir hides dotfiles, so accepting one would create an invisible file.
  if (name.startsWith(".")) return "hidden"
  if (/[. ]$/.test(name)) return "trailing"
  const base = name.split(".")[0] ?? name
  if (WINDOWS_RESERVED_NAMES.has(base.toLowerCase())) return "reserved"
  if (new TextEncoder().encode(name).length > MAX_ENTRY_NAME_BYTES) return "tooLong"
  return null
}

/**
 * First free default name of the form `untitled.md` / `untitled-2.md` (files)
 * or `untitled-folder` / `untitled-folder-2` (folders). At most `existing`
 * names can collide, so the scan always terminates on the next free slot.
 */
export function suggestEntryName(kind: EntryKind, existing: readonly string[]): string {
  const names = new Set(existing)
  let ordinal = 1
  while (names.has(suggestion(kind, ordinal)) && ordinal <= names.size) ordinal += 1
  return suggestion(kind, ordinal)
}

function suggestion(kind: EntryKind, ordinal: number): string {
  const suffix = ordinal === 1 ? "" : `-${ordinal}`
  return kind === "file"
    ? `${FILE_BASE_NAME}${suffix}.${MARKDOWN_FILE_EXTENSION}`
    : `${FOLDER_BASE_NAME}${suffix}`
}

/**
 * Whether `candidate` collides with an existing sibling. Case-insensitive on
 * case-insensitive filesystems; the Rust create command remains authoritative.
 */
export function hasDuplicateName(
  existing: readonly string[],
  candidate: string,
  caseInsensitive: boolean,
): boolean {
  return existing.some(name => caseInsensitive
    ? name.toLowerCase() === candidate.toLowerCase()
    : name === candidate)
}

/**
 * Rust's guarded create/rename commands reject an occupied target with the
 * stable message "path already exists". Only used to route the failure: a
 * duplicate stays inline in the edit row, anything else is an IO failure.
 */
export function isDuplicateNameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /already exists/i.test(message)
}
