import { describe, expect, it } from "vitest"
import {
  ENTRY_NAME_PROBLEM_KEYS,
  hasDuplicateName,
  isDuplicateNameError,
  markdownBaseNameEnd,
  normalizeMarkdownName,
  prepareEntryName,
  suggestEntryName,
  validateEntryName,
  type EntryNameProblem,
} from "../src/entryName"

describe("normalizeMarkdownName", () => {
  it("trims and appends the extension once", () => {
    expect(normalizeMarkdownName("  notes  ")).toBe("notes.md")
    expect(normalizeMarkdownName("notes.md")).toBe("notes.md")
    // Rust's create check compares the extension exactly, so a `.MD` typed by
    // the user would otherwise be rejected after the row closes.
    expect(normalizeMarkdownName("NOTES.MD")).toBe("NOTES.md")
  })

  it("collapses every recognized Markdown extension to the create form", () => {
    expect(normalizeMarkdownName("notes.markdown")).toBe("notes.md")
    expect(normalizeMarkdownName("notes.mdx")).toBe("notes.md")
    expect(normalizeMarkdownName("notes.MARKDOWN")).toBe("notes.md")
  })

  it("keeps existing `.markdown`/`.mdx` spelling on rename", () => {
    expect(normalizeMarkdownName("notes.markdown", true)).toBe("notes.markdown")
    expect(normalizeMarkdownName("notes.mdx", true)).toBe("notes.mdx")
    expect(normalizeMarkdownName("notes.md", true)).toBe("notes.md")
    expect(normalizeMarkdownName("NOTES.MD", true)).toBe("NOTES.md")
    expect(normalizeMarkdownName("notes", true)).toBe("notes.md")
  })
})

describe("markdownBaseNameEnd", () => {
  it("stops before any recognized Markdown extension", () => {
    expect(markdownBaseNameEnd("notes.md")).toBe(5)
    expect(markdownBaseNameEnd("notes.markdown")).toBe(5)
    expect(markdownBaseNameEnd("notes.MDX")).toBe(5)
    expect(markdownBaseNameEnd("a.b.md")).toBe(3)
  })

  it("selects the whole name when no extension is present", () => {
    expect(markdownBaseNameEnd("notes")).toBe(5)
    expect(markdownBaseNameEnd("untitled-folder")).toBe(15)
  })
})

describe("prepareEntryName", () => {
  it.each<[string, "file" | "folder", string, EntryNameProblem | null]>([
    ["", "file", "", "empty"],
    ["   ", "folder", "", "empty"],
    [".", "folder", ".", "traversal"],
    ["..", "file", "..", "traversal"],
    ["docs/notes", "folder", "docs/notes", "separators"],
    ["docs\\notes", "file", "docs\\notes.md", "separators"],
    [".hidden", "folder", ".hidden", "hidden"],
    [".md", "file", ".md", "hidden"],
    ["draft.", "file", "draft.", "trailing"],
    ["draft.", "folder", "draft.", "trailing"],
    ["con", "folder", "con", "reserved"],
    ["CON.md", "file", "CON.md", "reserved"],
    ["com1", "folder", "com1", "reserved"],
    ["notepad", "folder", "notepad", null],
    ["v1..2", "file", "v1..2.md", null],
    ["notes", "file", "notes.md", null],
    ["  notes  ", "folder", "notes", null],
  ])("prepares %j as %s", (raw, kind, name, problem) => {
    expect(prepareEntryName(raw, kind)).toEqual({ name, problem })
  })

  it("treats `.markdown`/`.mdx` as the extension rather than part of the base", () => {
    expect(prepareEntryName("notes.markdown", "file")).toEqual({
      name: "notes.md",
      problem: null,
    })
    expect(prepareEntryName("notes.mdx", "file")).toEqual({ name: "notes.md", problem: null })
    expect(prepareEntryName("notes.markdown", "file", { keepMarkdownExtension: true })).toEqual({
      name: "notes.markdown",
      problem: null,
    })
    expect(prepareEntryName("NOTES.MDX", "file", { keepMarkdownExtension: true })).toEqual({
      name: "NOTES.MDX",
      problem: null,
    })
  })

  it("rejects names beyond the filesystem segment limit", () => {
    expect(prepareEntryName("a".repeat(255), "folder")).toEqual({
      name: "a".repeat(255),
      problem: null,
    })
    expect(prepareEntryName("a".repeat(256), "folder")).toEqual({
      name: "a".repeat(256),
      problem: "tooLong",
    })
    // Multi-byte names hit the byte cap earlier than the character count.
    expect(prepareEntryName("文".repeat(100), "folder").problem).toBe("tooLong")
  })
})

describe("validateEntryName", () => {
  it("accepts dotted names that are not traversal segments", () => {
    expect(validateEntryName("meeting..notes.md")).toBeNull()
    expect(validateEntryName("2026.11.08.md")).toBeNull()
  })

  it("has a message key for every problem", () => {
    const problems: EntryNameProblem[] = [
      "empty", "separators", "traversal", "hidden", "reserved", "trailing", "tooLong",
    ]
    expect(Object.keys(ENTRY_NAME_PROBLEM_KEYS).sort()).toEqual([...problems].sort())
  })
})

describe("suggestEntryName", () => {
  it("starts with the untitled base name", () => {
    expect(suggestEntryName("file", [])).toBe("untitled.md")
    expect(suggestEntryName("folder", [])).toBe("untitled-folder")
  })

  it("skips every taken ordinal", () => {
    expect(suggestEntryName("file", ["untitled.md"])).toBe("untitled-2.md")
    expect(suggestEntryName("file", ["untitled.md", "untitled-2.md"])).toBe("untitled-3.md")
    expect(suggestEntryName("folder", ["untitled-folder", "untitled-folder-2"]))
      .toBe("untitled-folder-3")
  })

  it("ignores unrelated sibling names and does not mutate the input", () => {
    const existing = ["doc.md", "assets"]
    expect(suggestEntryName("file", existing)).toBe("untitled.md")
    expect(existing).toEqual(["doc.md", "assets"])
  })
})

describe("hasDuplicateName", () => {
  it("compares exactly or case-insensitively", () => {
    expect(hasDuplicateName(["doc.md"], "doc.md", false)).toBe(true)
    expect(hasDuplicateName(["Doc.md"], "doc.md", false)).toBe(false)
    expect(hasDuplicateName(["Doc.md"], "doc.md", true)).toBe(true)
    expect(hasDuplicateName([], "doc.md", true)).toBe(false)
  })
})

describe("isDuplicateNameError", () => {
  it("recognizes the guarded Rust rejection for occupied targets", () => {
    expect(isDuplicateNameError(new Error("path already exists"))).toBe(true)
    expect(isDuplicateNameError("path already exists")).toBe(true)
  })

  it("does not classify other failures as duplicates", () => {
    expect(isDuplicateNameError(new Error("permission denied"))).toBe(false)
    expect(isDuplicateNameError(undefined)).toBe(false)
  })
})
