import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { escapePathField, keyField, pathField, pathsField } from "../src/logPath"

/**
 * The field grammar is a cross-language contract: the redactor is Rust, but
 * some producers are TS. Both sides therefore read one shared fixture
 * (`fixtures/logPathCases.json`) rather than each carrying its own examples, so
 * a change to either implementation that the other does not make fails here.
 *
 * The Rust half of the pair is
 * `logging::tests::path_fields_round_trip_the_shared_fixture`.
 *
 * The decoder below is deliberately written from the grammar rather than
 * imported: decoding with the production encoder's own inverse would make the
 * round-trip assertion true by construction and unable to catch a wrong escape.
 */

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

const cases: { single: JsonValue[]; multi: JsonValue[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "logPathCases.json"), "utf8"),
) as { single: JsonValue[]; multi: JsonValue[] }

function asString(value: JsonValue, where: string): string {
  if (typeof value !== "string") throw new Error(`${where} must be a string in the fixture`)
  return value
}

function asArray(value: JsonValue, where: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array in the fixture`)
  return value
}

function asRecord(value: JsonValue, where: string): { [key: string]: JsonValue } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object in the fixture`)
  }
  return value as { [key: string]: JsonValue }
}

/** The escape table from spec §3.7, inverted. Independent of `logPath.ts`. */
const UNESCAPES: Record<string, string> = {
  "\\": "\\",
  ">": ">",
  "]": "]",
  ";": ";",
  n: "\n",
  r: "\r",
}

function decode(field: string): string {
  let out = ""
  for (let i = 0; i < field.length; i += 1) {
    const ch = field[i]
    if (ch !== "\\") {
      out += ch
      continue
    }
    const next = field[i + 1]
    if (next === undefined) {
      out += "\\"
      continue
    }
    out += UNESCAPES[next] ?? `\\${next}`
    i += 1
  }
  return out
}

/** Splits a `paths=[…]` body on unescaped `;` only, then decodes each element. */
function splitFieldList(body: string): string[] {
  const parts: string[] = []
  let current = ""
  for (let i = 0; i < body.length; i += 1) {
    // An unescaped `;` is a separator; the `;` in `/a\;semi.md` is not.
    if (body[i] === ";" && !isEscaped(body, i)) {
      parts.push(decode(current))
      current = ""
      continue
    }
    current += body[i]
  }
  parts.push(decode(current))
  return parts
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) backslashes += 1
  return backslashes % 2 === 1
}

describe("structured path fields", () => {
  it("renders every shared fixture case", () => {
    // A fixture emptied by a bad edit must not make this test vacuous.
    expect(cases.single.length).toBeGreaterThan(0)
    expect(cases.multi.length).toBeGreaterThan(0)

    cases.single.forEach((entry, index) => {
      const { raw, field } = asRecord(entry, `single[${index}]`)
      const input = asString(raw, `single[${index}].raw`)
      expect(pathField(input)).toBe(asString(field, `single[${index}].field`))
    })

    cases.multi.forEach((entry, index) => {
      const record = asRecord(entry, `multi[${index}]`)
      const inputs = asArray(record.raw, `multi[${index}].raw`).map((value, i) =>
        asString(value, `multi[${index}].raw[${i}]`),
      )
      expect(pathsField(inputs)).toBe(asString(record.field, `multi[${index}].field`))
    })
  })

  it("escapes exactly the grammar, not more", () => {
    // Exact output, so the TS regex cannot drift from the Rust match arms.
    expect(escapePathField("/Users/alice/notes/a.md")).toBe("/Users/alice/notes/a.md")
    expect(escapePathField("/Volumes/My Vault/笔记.md")).toBe("/Volumes/My Vault/笔记.md")
    expect(escapePathField("C:\\Users\\alice\\a.md")).toBe("C:\\\\Users\\\\alice\\\\a.md")
    expect(escapePathField("a>b]c;d\ne\rf\\g")).toBe("a\\>b\\]c\\;d\\ne\\rf\\\\g")
    expect(escapePathField("")).toBe("")
  })

  it("round-trips every fixture path and the full grammar", () => {
    cases.single.forEach((entry, index) => {
      const record = asRecord(entry, `single[${index}]`)
      const input = asString(record.raw, `single[${index}].raw`)
      const field = asString(record.field, `single[${index}].field`)
      expect(decode(field.slice("path=".length))).toBe(input)
    })

    // §3.7's property: arbitrary paths survive write-then-parse, including the
    // ones a Windows log actually produces.
    for (const raw of [
      "/tmp/a\\b>c]d;e\nf\rg",
      "/tmp/back\\",
      "/tmp/we\\nird.md",
      "C:\\node\\repo.md",
      "\\\\server\\share\\My Vault\\笔记.md",
    ]) {
      expect(decode(escapePathField(raw))).toBe(raw)
    }
  })

  it("escapes a backslash, because without it the encoding loses information", () => {
    // A real newline and a literal two-character `\n` are different paths. If
    // `\` were not escaped both would encode identically, so the reader could
    // not tell them apart — which is why §3.7's table escapes the backslash
    // even though it doubles the separators of every Windows path.
    expect(escapePathField("/tmp/new\nline.md")).not.toBe(escapePathField("/tmp/new\\nline.md"))
    expect(decode(escapePathField("/tmp/new\nline.md"))).toBe("/tmp/new\nline.md")
    expect(decode(escapePathField("/tmp/new\\nline.md"))).toBe("/tmp/new\\nline.md")
  })

  it("keeps a semicolon inside a path from splitting the list", () => {
    cases.multi.forEach((entry, index) => {
      const record = asRecord(entry, `multi[${index}]`)
      const inputs = asArray(record.raw, `multi[${index}].raw`).map((value, i) =>
        asString(value, `multi[${index}].raw[${i}]`),
      )
      const field = asString(record.field, `multi[${index}].field`)
      const body = field.slice("paths=[".length, -"]".length)
      expect(splitFieldList(body)).toEqual(inputs)
    })

    expect(pathsField([])).toBe("paths=[]")
  })

  it("renders a recovery key with the same escape grammar", () => {
    expect(keyField("untitled_7")).toBe("key=untitled_7")
    expect(keyField("_notes_My_Doc.md")).toBe("key=_notes_My_Doc.md")
    // A key cannot break the record: the field-closing and record-splitting
    // characters are the ones `escapePathField` owns.
    expect(keyField("a>b]c;d\\e\nf")).toBe("key=a\\>b\\]c\\;d\\\\e\\nf")
  })
})
