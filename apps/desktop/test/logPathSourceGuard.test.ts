import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Source-grep guard for spec §3.7: a path field is only ever produced by the
 * shared helpers, never by hand-written concatenation.
 *
 * `format!("path={}", p)` and `` `path=${p}` `` are the bug this guard exists
 * to prevent — a path containing the field delimiters, the list separator, or a
 * newline truncates the field and leaks its remainder past the export redactor.
 * The fixture pins what the helpers *produce*; this pins who may produce it.
 *
 * Precision matters more than reach here: a guard that trips on legitimate
 * prose ("the `path=` field") or on an unrelated `eprintln!("... path={x:?}")`
 * gets deleted by the next person. So a line is flagged only when it actually
 * renders a field prefix — a Rust `format!`/`write!` format string, or a TS
 * template literal — and doc/comment lines are skipped outright.
 */

const SOURCE_ROOT = resolve(import.meta.dirname, "..")

/** The only files that may contain the field grammar itself. */
const HELPERS = new Set(["src/logPath.ts", "src-tauri/src/logging/fields.rs"])

/** The one non-helper declaration that *names* both prefixes. */
const HELPER_CONSTANT_FILE = "src/constants.ts"
const HELPER_CONSTANT = "LOG_PATH_FIELD_HELPERS"

/** A line whose first non-space characters make it prose, not code. */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#)/

/** `path=` / `paths=` as a whole prefix, at the start of an interpolated value. */
const FIELD_PREFIX = /(^|["'`\s])path(s?)=/
const PREFIX_AT = (line: string): number => {
  const match = FIELD_PREFIX.exec(line)
  return match ? match.index + match[1].length : -1
}

/**
 * A Rust formatting-macro call — `format!`, `log::info!`, `error!`, … — with or
 * without a namespace, which is how every call site in this crate is written.
 */
const RUST_MACRO =
  /\b(format|write|writeln|print|println|eprint|eprintln|panic|assert|assert_eq|assert_ne|debug_assert|log|trace|debug|info|warn|error)(::[a-z_]+)?!\s*\(/

/**
 * True when the first interpolation after `path=` only exists to pretty-print a
 * debug value (`path={path:?}`, `path={p:#?}`).
 *
 * Those are pre-existing diagnostic lines (`eprintln!` in `documents.rs` and
 * `documents/save.rs`) that never enter a `path=` field, so flagging them would
 * be a false positive of exactly the kind that gets a guard deleted.
 */
function isDebugPrintOnly(line: string, index: number): boolean {
  const open = line.indexOf("{", index)
  if (open < 0) return false
  const close = line.indexOf("}", open)
  if (close < 0) return false
  const inner = line.slice(open + 1, close)
  return inner.includes(":?") || inner.includes(":#?")
}

function isRustFormatSite(line: string): boolean {
  const index = PREFIX_AT(line)
  if (index < 0) return false
  if (!RUST_MACRO.test(line.slice(0, index))) return false
  // The prefix must sit inside a string literal: a format string is the only
  // way a macro call renders a field. (`format!("{}", path = value)` is an
  // assignment, not a field.)
  const quote = line.lastIndexOf('"', index)
  if (quote < 0 || line.slice(quote + 1, index).includes('"')) return false
  // Pretty-`Debug` interpolation is not field rendering (see above).
  return !isDebugPrintOnly(line, index)
}

function isTemplateLiteralSite(line: string): boolean {
  const index = PREFIX_AT(line)
  if (index < 0) return false
  // Walk back to the opening backtick, across intervening `}` interpolations.
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = line[i]
    if (ch === "`") return true
    if (ch === "'" || ch === '"') return false
  }
  return false
}

function sourceFiles(root: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(root)) {
    const full = join(root, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx|rs)$/.test(name)) out.push(full)
  }
  return out
}

/** The guard's rule for one line, exported to the describe block by name only. */
function forbiddenReason(line: string): string | null {
  if (COMMENT_LINE.test(line)) return null
  if (isRustFormatSite(line)) return "a Rust format string renders a path field"
  if (isTemplateLiteralSite(line)) return "a template literal renders a path field"
  return null
}

describe("path fields are never hand-concatenated", () => {
  it("only the shared helpers render path= / paths= in src and src-tauri/src", () => {
    const offenders: string[] = []
    let scanned = 0

    for (const root of [
      join(SOURCE_ROOT, "src"),
      join(SOURCE_ROOT, "src-tauri/src"),
    ]) {
      for (const file of sourceFiles(root)) {
        const rel = relative(SOURCE_ROOT, file).split(sep).join("/")
        // Rust regression fixtures deliberately contain forged field strings.
        // These files are mounted only by #[cfg(test)] modules.
        if (rel.endsWith("_tests.rs") || rel.endsWith("/tests.rs")) continue
        const isHelper = HELPERS.has(rel)
        const isConstant = rel === HELPER_CONSTANT_FILE
        scanned += 1

        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, index) => {
            // The helpers own the grammar; the constants file only names it.
            if (isHelper) return
            if (isConstant && line.includes(HELPER_CONSTANT)) return
            const reason = forbiddenReason(line)
            if (reason) offenders.push(`${rel}:${index + 1}: ${reason} — ${line.trim()}`)
          })
      }
    }

    // A walk that found nothing must not pass vacuously.
    expect(scanned).toBeGreaterThan(20)
    expect(offenders).toEqual([])
  })

  it("flags hand-written fields and ignores prose", () => {
    // The literal is assembled at runtime so this guard's own source cannot
    // trip its walk. These are §3.7's forbidden forms.
    const prefix = "path" + "="
    const listPrefix = "paths" + "=["
    for (const line of [
      `format!("${prefix}{}", path)`,
      `format!("${prefix}{p}", p)`,
      `format!("${listPrefix}{joined}]")`,
      `log::info!("export ok ${prefix}{}", path)`,
      `debug!("save begin ${prefix}{}", path)`,
      `eprintln!("failed ${prefix}{path}")`,
    ]) {
      expect(forbiddenReason(line), `should flag: ${line}`).not.toBeNull()
    }
    for (const line of [
      "const field = `" + prefix + "${escapePathField(path)}`",
      "const list = `" + listPrefix + "${joined}]`",
    ]) {
      expect(forbiddenReason(line), `should flag: ${line}`).not.toBeNull()
    }

    // Negative controls: prose, a bare string, a JSX attribute, an unrelated
    // `filepath` word, and pretty-`Debug` diagnostics that never enter a field.
    for (const line of [
      `/// Escapes a value for use inside a \`${prefix}<…>\` field`,
      ` * written as an identifiable \`${prefix}<…>\` field`,
      `// format!("${prefix}{}", path) is forbidden`,
      `/* ${prefix} is not the same as filepath= */`,
      `const marker = "${prefix}"`,
      `const helpers = ["${prefix}", "${listPrefix}"]`,
      `<Row ${prefix}{historyState.path} />`,
      `const searchPath = "file${prefix}"`,
      `eprintln!("[documents] read io error: ${prefix}{path:?} error={error}")`,
      `eprintln!("[documents] metadata error: ${prefix}{p:#?}")`,
    ]) {
      expect(forbiddenReason(line), `should ignore: ${line}`).toBeNull()
    }
  })
})
