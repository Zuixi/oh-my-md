/**
 * Escaped structured path fields (spec §3.7).
 *
 * File paths are what make a log diagnosable, and redaction is an export-time
 * property: the live log stays on the user's machine in full. So a path is
 * written as an identifiable `path=<…>` / `paths=[…]` field, and export
 * redacts *inside* the field where the boundaries are known, instead of
 * guessing where a path starts and ends.
 *
 * Hand-written concatenation is forbidden — a path containing the field
 * delimiters, the list separator, or a newline would silently truncate the
 * field or split the record, and leak the remainder past the redactor. Both
 * sides expose one helper and the grammar is pinned by one shared fixture
 * consumed by the Rust and TS tests alike (`test/fixtures/logPathCases.json`).
 */

/** Spec §3.7's escape table. One table, so the TS side cannot diverge. */
const ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  ">": "\\>",
  "]": "\\]",
  ";": "\\;",
  "\n": "\\n",
  "\r": "\\r",
}

/**
 * Escapes a value for use inside a `path=<…>` / `paths=[…]` field.
 *
 * The backslash is in the same single-pass table as everything else: it is the
 * escape character, so leaving it bare would make a literal two-character `\n`
 * in a path indistinguishable from an escaped newline.
 */
export function escapePathField(raw: string): string {
  return raw.replace(/[\\>\];\n\r]/g, ch => ESCAPES[ch] ?? ch)
}

/** Renders one path as a `path=<escaped>` field. */
export function pathField(path: string): string {
  return `path=${escapePathField(path)}`
}

/**
 * Renders a list as a `paths=[<escaped>;<escaped>]` field. `;` is escaped
 * inside each element, so the separator stays unambiguous for a path
 * containing one.
 */
export function pathsField(paths: readonly string[]): string {
  return `paths=[${paths.map(escapePathField).join(";")}]`
}

/**
 * Renders a recovery key as a `key=<escaped>` field.
 *
 * A recovery key is not a path: it is the tab identity (`recoveryKey` in
 * `session.ts` — an untitled tab's key is `untitled_<id>`), and it is the only
 * identity an untitled tab has, since its `path` is `null`. It shares the
 * escape grammar so a key can never break the record, but it stays out of
 * `LOG_PATH_FIELD_HELPERS` and out of the export redactor: a key is a
 * sanitized stem, not a location, so redacting it would only lose the record.
 */
export function keyField(key: string): string {
  return `key=${escapePathField(key)}`
}
