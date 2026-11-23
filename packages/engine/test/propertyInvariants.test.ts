import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { forceParsing, syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import type { SyntaxNode } from "@lezer/common"
import { beforeAll, describe, expect, it } from "vitest"
import { editorExtensions, exportHtml } from "../src/index"
import {
  buildLiveDecorations,
  drainPendingLiveBuild,
  livePreviewField,
  type LiveDeco,
} from "../src/decorations/build"
import { preloadMarkdownCodeLanguages } from "../src/parse/codeLanguages"
import { escapeTableCellValue, replaceTableCell } from "../src/tables/edit"
import { tableDataFromNode, type TableData } from "../src/tables/model"
import { makeState } from "./helpers"

/**
 * Deterministic property-based invariants (TEST-02). Everything is seeded with
 * `mulberry32(0x6f6d64)` so a failure is reproducible from the seed alone and CI
 * never flips red on a lucky draw; assertion messages carry the seed.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)]!

beforeAll(() => preloadMarkdownCodeLanguages())

// --- 1. Incremental live decorations == full rebuild after every random edit ---

const DOC_BLOCKS: readonly string[] = [
  "# Heading one\n\n## Heading two",
  "**bold** and *italic* and ~~strike~~",
  "`code` plus [link](https://example.com/page)",
  "bare https://example.com/path autolink",
  "1. first\n2. second\n3. third",
  "- bullet\n- bullet",
  "- [ ] todo\n- [x] done",
  "> quoted **bold** line",
  "```ts\nconst answer = 42\n```",
  "| alpha | beta |\n| --- | --- |\n| one | two |", "plain paragraph with 中文 text",
]

const INSERTIONS = [
  "x", " ", "\n", "**bold**", "*it*", "~~s~~", "`c`", "# ", "- ", "> ",
  "[l](https://example.com)", "中文", "| a | b |\n| --- | --- |\n| 1 | 2 |",
]

function randomDocument(random: () => number): string {
  const count = 1 + Math.floor(random() * 3)
  return Array.from({ length: count }, () => pick(random, DOC_BLOCKS)).join("\n\n")
}

/** Tags, ranges and both decoration sets — independent of object identity. */
function fingerprint(live: LiveDeco, span: number): string {
  const ranges = (set: LiveDeco["deco"]) => {
    const out: string[] = []
    set.between(0, span, (from, to) => { out.push(`${from}:${to}`) })
    return out
  }
  return JSON.stringify({
    specs: live.specs.map(spec => `${spec.tag}:${spec.from}:${spec.to}`).sort(),
    deco: ranges(live.deco),
    atomic: ranges(live.atomic),
    pending: live.pending.map(range => `${range.from}:${range.to}`),
  })
}

/** Parse to completion: a partial tree would compare two different inputs. */
function completeTree(view: EditorView): void {
  const length = view.state.doc.length
  for (let guard = 0; !syntaxTreeAvailable(view.state, length); guard++) {
    if (guard > 100) throw new Error("syntax tree never completed")
    forceParsing(view, length, 100_000)
  }
}

function mountView(doc: string): { view: EditorView; parent: HTMLElement } {
  const parent = document.body.appendChild(document.createElement("div"))
  const view = new EditorView({ state: EditorState.create({ doc, extensions: editorExtensions() }), parent })
  completeTree(view)
  drainPendingLiveBuild(view)
  return { view, parent }
}

describe("incremental live decorations equal a full rebuild", () => {
  it("matches buildLiveDecorations after every random insert/delete in 150 documents", () => {
    // Non-vacuity guards: an empty comparison would prove nothing.
    let specCount = 0
    let tableSteps = 0
    for (let seed = 0; seed < 150; seed++) {
      const random = mulberry32(0x6f6d64 + seed)
      const { view, parent } = mountView(randomDocument(random))
      try {
        for (let step = 0; step < 5; step++) {
          const length = view.state.doc.length
          const at = Math.floor(random() * (length + 1))
          const insert = random() < 0.5 || length === 0
          const size = 1 + Math.floor(random() * Math.min(12, length - at))
          view.dispatch(insert
            ? { changes: { from: at, insert: pick(random, INSERTIONS) }, selection: { anchor: Math.min(at + 1, length + 8) } }
            : { changes: { from: at, to: Math.min(at + size, length) }, selection: { anchor: at } })
          completeTree(view)
          drainPendingLiveBuild(view)
          const state = view.state
          const live = state.field(livePreviewField)
          specCount += live.specs.length
          if (live.specs.some(spec => spec.tag.startsWith("widget:block:table"))) tableSteps += 1
          const where = `seed ${seed} (0x${(0x6f6d64 + seed).toString(16)}) step ${step}: ${JSON.stringify(state.doc.toString())}`
          expect(fingerprint(live, state.doc.length), where)
            .toBe(fingerprint(buildLiveDecorations(state), state.doc.length))
        }
      } finally {
        view.destroy()
        parent.remove()
      }
    }
    expect(specCount).toBeGreaterThan(2_000)
    expect(tableSteps).toBeGreaterThan(10)
  }, 300_000)
})

// --- 2. Adversarial export sanitizer invariant ---

const HREF_PAYLOADS = [
  "javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)",
  "java\nscript:alert(1)", "javascript\r:alert(1)", "\u0000javascript:alert(1)",
  "vbscript:msgbox(1)", "VBScript:msgbox(1)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
  "file:///etc/passwd", "fi\tle:///etc/passwd", "//evil.example/x",
  "&#x6a;avascript:alert(1)", "%6aavascript:alert(1)",
]

const RAW_HTML_PAYLOADS = [
  '<a id="ok" onclick="x()">label</a>',
  '<a style="x" id="y">label</a>',
  '<a href="javascript:alert(1)">label</a>',
  "<script>alert(1)</script>",
  '<iframe src="https://evil.example"></iframe>',
  '<img src=x onerror="alert(1)">', '<img src="x" onload="alert(1)">',
]

/** Tokens that must never appear inside a real emitted tag or attribute value. */
const FORBIDDEN_IN_TAG = [
  "javascript:", "vbscript:", "data:text/html", "data:image/svg", "file:",
  "onclick=", "onerror=", "onload=", "<script", "<iframe",
]

describe("export sanitizer adversarial invariant", () => {
  it("never emits an active scheme, handler or script tag from 200 payloads", () => {
    const random = mulberry32(0x6f6d64)
    for (let caseIndex = 0; caseIndex < 200; caseIndex++) {
      const useHtml = random() < 0.4
      const payload = useHtml ? pick(random, RAW_HTML_PAYLOADS) : pick(random, HREF_PAYLOADS)
      const kind = Math.floor(random() * 4)
      const doc = useHtml ? `before\n\n${payload}\n\nafter`
        : kind === 0 ? `[label](${payload})`
        : kind === 1 ? `![alt](${payload})`
        : kind === 2 ? `[label](<${payload}>)`
        : `<a href="${payload}">label</a>`
      const html = exportHtml(makeState(doc))
      const where = `case ${caseIndex} doc=${JSON.stringify(doc)}`
      const lowered = html.toLowerCase()
      expect(lowered.includes("<script"), `${where} emitted a script element`).toBe(false)
      expect(lowered.includes("<iframe"), `${where} emitted an iframe element`).toBe(false)
      // Raw HTML is escaped into inert text, so payload characters may survive as
      // text; what must never survive is live markup or a resolved active URL.
      for (const tag of html.match(/<[a-z][^>]*>/gi) ?? []) {
        for (const forbidden of FORBIDDEN_IN_TAG) {
          expect(tag.toLowerCase().includes(forbidden), `${where} leaked ${forbidden} in ${tag}`).toBe(false)
        }
      }
      for (const match of html.matchAll(/\s(?:href|src)="([^"]*)"/gi)) {
        const value = match[1]!.trim().toLowerCase()
        const rasterDataUrl = /^data:image\/(?:png|jpeg|webp|gif)[;,]/.test(value)
        const active = /^(?:javascript|vbscript|file|data):/.test(value) && !rasterDataUrl
        expect(active, `${where} resolved an active attribute value: ${value}`).toBe(false)
        expect(value.startsWith("//"), `${where} resolved a protocol-relative source`).toBe(false)
      }
    }
  })
})

// --- 3. GFM table cell edit round-trip ---

const TABLE_SOURCE = [
  "| alpha | beta | gamma |",
  "| --- | :---: | ---: |",
  "| one | two | three |",
  "| four | five | six |",
].join("\n")

const CELL_VALUES = [
  "plain", "with space", "|", "\\|", "a\\b", "\\", "`a|b`", "**bold**", "*it*",
  "中文单元格", "x|y|z", "trailing\\", "\\|\\|", "a `b` c", "1. not a list",
]

function tableRecord(source: string): { data: TableData; text: string } {
  const state = makeState(source)
  let node: SyntaxNode | null = null
  const cursor = syntaxTree(state).cursor()
  do {
    if (cursor.name === "Table") node = cursor.node
  } while (!node && cursor.next())
  if (!node) throw new Error(`expected a Table node in ${JSON.stringify(source)}`)
  const data = tableDataFromNode(node, state)
  if (!data) throw new Error(`expected table data in ${JSON.stringify(source)}`)
  return { data, text: source.slice(node.from, node.to) }
}

describe("table cell edit round-trip", () => {
  it("keeps the column count and every untouched cell across random values", () => {
    const random = mulberry32(0x6f6d64)
    const before = tableRecord(TABLE_SOURCE)
    const columns = before.data.header.cells.length
    const rowsBefore = [before.data.header, ...before.data.rows]
    for (let caseIndex = 0; caseIndex < 60; caseIndex++) {
      const value = pick(random, CELL_VALUES)
      const rowIndex = Math.floor(random() * rowsBefore.length)
      const column = Math.floor(random() * columns)
      const cell = rowsBefore[rowIndex]!.cells[column]
      expect(cell, `case ${caseIndex}: generated table has no cell at ${rowIndex}/${column}`).not.toBeNull()

      const change = replaceTableCell(before.text, cell!, value)
      expect(change, `case ${caseIndex}: replaceTableCell refused a live cell`).not.toBeNull()
      const edited = before.text.slice(0, change!.from) + change!.insert + before.text.slice(change!.to)
      const after = tableRecord(edited)
      const rowsAfter = [after.data.header, ...after.data.rows]

      expect(after.data.header.cells.length, `case ${caseIndex} value=${JSON.stringify(value)}: column count changed`).toBe(columns)
      expect(rowsAfter.length, `case ${caseIndex}: row count changed`).toBe(rowsBefore.length)
      // No row split: every line keeps exactly one leading and trailing pipe.
      for (const line of edited.split("\n")) {
        expect(line.startsWith("|"), `case ${caseIndex}: row lost its leading pipe`).toBe(true)
        expect(line.endsWith("|"), `case ${caseIndex}: row lost its trailing pipe`).toBe(true)
      }
      for (const [index, rowBefore] of rowsBefore.entries()) {
        for (const [columnIndex, cellBefore] of rowBefore.cells.entries()) {
          if (index === rowIndex && columnIndex === column) continue
          expect(rowsAfter[index]!.cells[columnIndex]?.source ?? null,
            `case ${caseIndex}: untouched cell ${index}/${columnIndex} changed`).toBe(cellBefore?.source ?? null)
        }
      }
      // The edited cell round-trips through exactly one escaping pass.
      expect(rowsAfter[rowIndex]!.cells[column]?.source.trim(),
        `case ${caseIndex}: value ${JSON.stringify(value)} did not round-trip`).toBe(escapeTableCellValue(value).trim())
    }
  })
})
