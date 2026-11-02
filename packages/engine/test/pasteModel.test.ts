import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type {
  PasteAsset,
  PasteBlock,
  PasteDiagnostic,
  PasteDocument,
  PasteInline,
  PasteListItem,
  PasteTable,
  PasteTableRow,
  PreparedSmartPaste,
  SerializedPaste,
  SmartPastePlan,
} from "../src/paste/model"

// ---------------------------------------------------------------------------
// 夹具契约：六个 JSON 数组是人类手写的精确字符串，不允许拿生成器回填。
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "paste")
const FIXTURE_FILES = [
  "browser-basic.json",
  "office-style-noise.json",
  "literal-markdown.json",
  "verbatim-and-code.json",
  "tables.json",
  "security.json",
] as const

const FIXTURE_KEYS = [
  "name",
  "html",
  "plainText",
  "context",
  "expectedMarkdown",
  "expectedPath",
  "expectedDiagnostics",
] as const

// 以 Record<union, true> 复述模型 union：漏项/多项都会被 tsc 抓住，夹具校验
// 因此不需要第三处字面量。
const PLAN_KINDS: Record<SmartPastePlan["kind"], true> = { plain: true, markdown: true }
const DIAGNOSTIC_KINDS: Record<PasteDiagnostic["kind"], true> = {
  strictFallback: true,
  unsupportedTable: true,
  droppedStyle: true,
  rejectedUrl: true,
  unresolvedAsset: true,
}

interface PasteFixture {
  readonly name: string
  readonly html: string
  readonly plainText: string
  readonly context: string
  readonly expectedMarkdown: string
  readonly expectedPath: SmartPastePlan["kind"]
  readonly expectedDiagnostics: readonly PasteDiagnostic[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readJsonArray(file: string): unknown[] {
  const raw: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"))
  if (!Array.isArray(raw)) throw new Error(`${file}: fixture file must be a JSON array`)
  return raw
}

function assertPositiveIntegerCount(count: unknown, where: string): asserts count is number {
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
    throw new Error(`${where}: diagnostic count must be a positive integer, got ${String(count)}`)
  }
}

function assertDiagnostics(value: unknown, where: string): readonly PasteDiagnostic[] {
  if (!Array.isArray(value)) throw new Error(`${where}: expectedDiagnostics must be an array`)
  return value.map((entry: unknown, index) => {
    const at = `${where}.expectedDiagnostics[${index}]`
    if (!isRecord(entry)) throw new Error(`${at}: diagnostic must be an object`)
    const keys = Object.keys(entry).sort()
    if (keys.join(",") !== "count,kind") throw new Error(`${at}: keys must be exactly kind,count (got ${keys.join(",")})`)
    if (typeof entry.kind !== "string" || !Object.hasOwn(DIAGNOSTIC_KINDS, entry.kind)) {
      throw new Error(`${at}: unknown diagnostic kind ${String(entry.kind)}`)
    }
    assertPositiveIntegerCount(entry.count, at)
    return { kind: entry.kind as PasteDiagnostic["kind"], count: entry.count }
  })
}

function validateFixtureCase(value: unknown, where: string): PasteFixture {
  if (!isRecord(value)) throw new Error(`${where}: fixture case must be an object`)

  const keys = Object.keys(value).sort()
  if (keys.join(",") !== [...FIXTURE_KEYS].sort().join(",")) {
    throw new Error(`${where}: keys must be exactly ${FIXTURE_KEYS.join(",")} (got ${keys.join(",")})`)
  }

  const name = value.name
  if (typeof name !== "string" || name.trim().length === 0) throw new Error(`${where}.name: must be a non-empty string`)

  const stringKeys = ["html", "plainText", "context", "expectedMarkdown"] as const
  for (const key of stringKeys) {
    if (typeof value[key] !== "string") throw new Error(`${where}.${key}: must be a string`)
  }

  const expectedPath = value.expectedPath
  if (typeof expectedPath !== "string" || !Object.hasOwn(PLAN_KINDS, expectedPath)) {
    throw new Error(`${where}.expectedPath: must be one of ${Object.keys(PLAN_KINDS).join("|")} (got ${String(expectedPath)})`)
  }

  // 空期望值只允许出现在“没有可见文本可写”的用例（例如只粘了一段 script）。
  // 其余空串一律视为漏写，避免夹具静默失去断言。
  if (value.expectedMarkdown === "" && value.plainText !== "") {
    throw new Error(`${where}.expectedMarkdown: empty expectation for a case with visible plainText`)
  }

  return {
    name,
    html: value.html as string,
    plainText: value.plainText as string,
    context: value.context as string,
    expectedMarkdown: value.expectedMarkdown as string,
    expectedPath: expectedPath as SmartPastePlan["kind"],
    expectedDiagnostics: assertDiagnostics(value.expectedDiagnostics, where),
  }
}

function loadFixtures(): readonly { readonly file: string; readonly cases: readonly PasteFixture[] }[] {
  return FIXTURE_FILES.map((file) => ({
    file,
    cases: readJsonArray(file).map((value, index) => validateFixtureCase(value, `${file}[${index}]`)),
  }))
}

describe("paste fixture corpus", () => {
  for (const file of FIXTURE_FILES) {
    it(`${file} uses only contract keys and value types`, () => {
      const cases = readJsonArray(file).map((value, index) => validateFixtureCase(value, `${file}[${index}]`))
      expect(cases.length).toBeGreaterThan(0)
    })
  }

  it("uses globally unique case names", () => {
    const names = loadFixtures().flatMap(({ cases }) => cases.map((c) => c.name))
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index)
    expect(duplicates).toEqual([])
    expect(names.length).toBeGreaterThan(0)
  })

  it("rejects malformed fixture cases instead of accepting them silently", () => {
    const good = {
      name: "sample",
      html: "<p>x</p>",
      plainText: "x",
      context: "paragraph",
      expectedMarkdown: "x",
      expectedPath: "plain",
      expectedDiagnostics: [],
    }
    const accept = (value: unknown) => () => validateFixtureCase(value, "probe")

    expect(accept(good)).not.toThrow()
    expect(accept({ ...good, extra: 1 })).toThrow(/keys must be exactly/)
    expect(accept({ ...good, name: "" })).toThrow(/name/)
    expect(accept({ ...good, html: 3 })).toThrow(/html/)
    expect(accept({ ...good, expectedPath: "semantic" })).toThrow(/expectedPath/)
    expect(accept({ ...good, expectedMarkdown: "" })).toThrow(/empty expectation/)
    expect(accept({ ...good, expectedMarkdown: undefined })).toThrow(/expectedMarkdown/)

    const withDiagnostics = (diagnostics: unknown) => accept({ ...good, expectedDiagnostics: diagnostics })
    expect(withDiagnostics([{ kind: "notAKind", count: 1 }])).toThrow(/unknown diagnostic kind/)
    expect(withDiagnostics([{ kind: "droppedStyle", count: 0 }])).toThrow(/positive integer/)
    expect(withDiagnostics([{ kind: "droppedStyle", count: 1.5 }])).toThrow(/positive integer/)
    expect(withDiagnostics([{ kind: "droppedStyle", count: 1, extra: true }])).toThrow(/kind,count/)
    expect(withDiagnostics("none")).toThrow(/must be an array/)
  })
})

// ---------------------------------------------------------------------------
// 不可变 AST：递归冻结 + 资产/诊断不变量。
// ---------------------------------------------------------------------------

/** 递归冻结（不导出：只给本文件的代表性 AST 用）。 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key))
  return value
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return
  expect(Object.isFrozen(value)).toBe(true)
  for (const key of Reflect.ownKeys(value)) expectDeepFrozen(Reflect.get(value, key))
}

interface PasteScan {
  readonly inlineTypes: readonly string[]
  readonly blockTypes: readonly string[]
  readonly embeddedAssetKeys: readonly string[]
  readonly unavailableAssetKeys: readonly string[]
}

function scanDocument(document: PasteDocument): PasteScan {
  const inlineTypes = new Set<string>()
  const blockTypes = new Set<string>()
  const embeddedAssetKeys: string[] = []
  const unavailableAssetKeys: string[] = []

  const visitInlines = (inlines: readonly PasteInline[]): void => {
    for (const inline of inlines) {
      inlineTypes.add(inline.type)
      if (inline.type === "image") {
        if (inline.source.kind === "embedded") embeddedAssetKeys.push(inline.source.key)
        else if (inline.source.kind === "unavailable") unavailableAssetKeys.push(inline.source.key)
      } else if ("children" in inline) {
        visitInlines(inline.children)
      }
    }
  }

  const visitItems = (items: readonly PasteListItem[]): void => {
    for (const item of items) visitBlocks(item.children)
  }
  const visitRows = (rows: readonly PasteTableRow[]): void => {
    for (const row of rows) for (const cell of row.cells) visitBlocks(cell.blocks)
  }
  const visitBlocks = (blocks: readonly PasteBlock[]): void => {
    for (const block of blocks) {
      blockTypes.add(block.type)
      switch (block.type) {
        case "paragraph":
        case "heading":
          visitInlines(block.children)
          break
        case "blockquote":
          visitBlocks(block.children)
          break
        case "list":
          visitItems(block.items)
          break
        case "table":
          visitRows(block.table.rows)
          break
        case "codeBlock":
        case "horizontalRule":
          break
      }
    }
  }

  visitBlocks(document.blocks)
  return {
    inlineTypes: [...inlineTypes],
    blockTypes: [...blockTypes],
    embeddedAssetKeys,
    unavailableAssetKeys,
  }
}

function assertUniqueKeys(keys: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const key of keys) {
    if (key.trim().length === 0) throw new Error(`${label}: empty key`)
    if (seen.has(key)) throw new Error(`${label}: duplicate key ${key}`)
    seen.add(key)
  }
}

/** 一份文档内的嵌入资产 key 唯一，且与 assets / unavailableImageKeys 对得上。 */
function assertPasteAssets(prepared: PreparedSmartPaste): void {
  const scan = scanDocument(prepared.document)
  const assetKeys = prepared.assets.map((asset) => asset.key)
  assertUniqueKeys(assetKeys, "PreparedSmartPaste.assets")
  assertUniqueKeys(scan.embeddedAssetKeys, "embedded image")
  assertUniqueKeys(scan.unavailableAssetKeys, "unavailable image")
  assertUniqueKeys(prepared.unavailableImageKeys, "PreparedSmartPaste.unavailableImageKeys")

  for (const key of scan.embeddedAssetKeys) {
    if (!assetKeys.includes(key)) throw new Error(`embedded image key ${key} has no matching asset`)
  }
  for (const key of scan.unavailableAssetKeys) {
    if (!prepared.unavailableImageKeys.includes(key)) throw new Error(`unavailable image key ${key} is not reported`)
  }
  if ([...prepared.unavailableImageKeys].sort().join(",") !== [...scan.unavailableAssetKeys].sort().join(",")) {
    throw new Error("unavailableImageKeys does not match the unavailable image nodes")
  }
}

function assertDiagnosticCounts(diagnostics: readonly PasteDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    if (!Object.hasOwn(DIAGNOSTIC_KINDS, diagnostic.kind)) throw new Error(`unknown diagnostic kind ${String(diagnostic.kind)}`)
    if (!Number.isInteger(diagnostic.count) || diagnostic.count <= 0) {
      throw new Error(`diagnostic ${diagnostic.kind} count must be a positive integer, got ${diagnostic.count}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 代表性 AST：覆盖每个 block/inline/source 分支，供冻结与不变量测试使用。
// ---------------------------------------------------------------------------

const SAMPLE_ASSETS: readonly PasteAsset[] = [
  { key: "asset-inline-png", mime: "image/png", base64: "iVBORw0KGgo=", alt: "chart" },
]

const SAMPLE_TABLE: PasteTable = {
  rows: [
    {
      cells: [
        { header: true, scope: "col", rowSpan: 1, colSpan: 1, align: "left", blocks: [{ type: "paragraph", children: [{ type: "text", value: "Metric" }] }] },
        { header: true, scope: null, rowSpan: 1, colSpan: 1, align: "center", blocks: [{ type: "paragraph", children: [{ type: "text", value: "Q1" }] }] },
      ],
    },
    {
      cells: [
        { header: true, scope: "row", rowSpan: 1, colSpan: 1, align: null, blocks: [{ type: "paragraph", children: [{ type: "code", value: "a|b" }] }] },
        {
          header: false,
          scope: null,
          rowSpan: 2,
          colSpan: 3,
          align: "right",
          blocks: [{ type: "paragraph", children: [{ type: "text", value: "10" }, { type: "hardBreak" }, { type: "text", value: "12" }] }],
        },
      ],
    },
  ],
  requiresComplexHtml: true,
}

const SAMPLE_INLINES: readonly PasteInline[] = [
  { type: "text", value: "plain " },
  { type: "strong", children: [{ type: "text", value: "bold" }] },
  { type: "emphasis", children: [{ type: "text", value: "italic" }] },
  { type: "strike", children: [{ type: "text", value: "gone" }] },
  { type: "highlight", children: [{ type: "text", value: "marked" }] },
  { type: "underline", children: [{ type: "text", value: "under" }] },
  { type: "kbd", children: [{ type: "text", value: "Ctrl" }] },
  { type: "subscript", children: [{ type: "text", value: "2" }] },
  { type: "superscript", children: [{ type: "text", value: "3" }] },
  { type: "code", value: "a_b" },
  { type: "link", href: "https://example.com/docs", title: null, children: [{ type: "text", value: "docs" }] },
  { type: "image", alt: "chart", title: "quarterly", source: { kind: "url", value: "https://example.com/chart.png" } },
  { type: "image", alt: "spark", title: null, source: { kind: "embedded", key: "asset-inline-png", mime: "image/png", base64: "iVBORw0KGgo=" } },
  { type: "image", alt: "movie", title: null, source: { kind: "unavailable", key: "asset-clipboard-file-1" } },
  { type: "hardBreak" },
]

const SAMPLE_BLOCKS: readonly PasteBlock[] = [
  { type: "heading", level: 1, children: [{ type: "text", value: "Title" }] },
  { type: "paragraph", children: SAMPLE_INLINES },
  { type: "blockquote", children: [{ type: "paragraph", children: [{ type: "text", value: "quoted" }] }] },
  {
    type: "list",
    ordered: true,
    start: 3,
    items: [
      { checked: true, children: [{ type: "paragraph", children: [{ type: "text", value: "shipped" }] }] },
      { checked: false, children: [{ type: "paragraph", children: [{ type: "text", value: "pending" }] }] },
      {
        checked: null,
        children: [
          { type: "paragraph", children: [{ type: "text", value: "parent" }] },
          { type: "list", ordered: false, start: null, items: [{ checked: null, children: [{ type: "paragraph", children: [{ type: "text", value: "child" }] }] }] },
        ],
      },
    ],
  },
  { type: "codeBlock", language: "ts", value: "const x: number = 1\n" },
  { type: "table", table: SAMPLE_TABLE },
  { type: "horizontalRule" },
]

const SAMPLE_PREPARED: PreparedSmartPaste = {
  policy: "semantic",
  document: { blocks: SAMPLE_BLOCKS },
  plainText: "Title\nplain bold italic gone marked under Ctrl 2 3 a_b docs",
  assets: SAMPLE_ASSETS,
  unavailableImageKeys: ["asset-clipboard-file-1"],
  isSingleImageOnly: false,
  diagnostics: [
    { kind: "droppedStyle", count: 2 },
    { kind: "unresolvedAsset", count: 1 },
  ],
}

const SAMPLE_SERIALIZED: SerializedPaste = {
  text: "# Title\n\nplain **bold**",
  boundary: { start: "block", end: "opaque" },
  diagnostics: [{ kind: "strictFallback", count: 1 }],
}

const SAMPLE_PLAN: SmartPastePlan = {
  kind: "markdown",
  text: "# Title",
  diagnostics: [{ kind: "unsupportedTable", count: 1 }],
}

const INLINE_TYPES: Record<PasteInline["type"], true> = {
  text: true,
  strong: true,
  emphasis: true,
  strike: true,
  highlight: true,
  underline: true,
  kbd: true,
  subscript: true,
  superscript: true,
  code: true,
  link: true,
  image: true,
  hardBreak: true,
}

const BLOCK_TYPES: Record<PasteBlock["type"], true> = {
  paragraph: true,
  heading: true,
  blockquote: true,
  list: true,
  codeBlock: true,
  table: true,
  horizontalRule: true,
}

const FROZEN_PREPARED = deepFreeze(SAMPLE_PREPARED)

describe("paste ast immutability", () => {
  it("covers every inline and block kind in the representative ast", () => {
    const scan = scanDocument(SAMPLE_PREPARED.document)
    expect([...scan.inlineTypes].sort()).toEqual(Object.keys(INLINE_TYPES).sort())
    expect([...scan.blockTypes].sort()).toEqual(Object.keys(BLOCK_TYPES).sort())
  })

  it("deep-freezes nested objects and arrays", () => {
    expectDeepFrozen(FROZEN_PREPARED)
    expectDeepFrozen(deepFreeze(SAMPLE_SERIALIZED))
    expectDeepFrozen(deepFreeze(SAMPLE_PLAN))
  })

  it("refuses mutation attempts at every nesting depth", () => {
    const blocks = FROZEN_PREPARED.document.blocks
    const paragraph = blocks[1]
    if (paragraph.type !== "paragraph") throw new Error("sample paragraph missing")
    const inlines = paragraph.children
    const link = inlines[10]
    if (link.type !== "link") throw new Error("sample link missing")

    expect(Reflect.set(FROZEN_PREPARED, "policy", "literalFallback")).toBe(false)
    expect(Reflect.set(blocks, 0, { type: "horizontalRule" })).toBe(false)
    expect(Reflect.set(blocks, blocks.length, { type: "horizontalRule" })).toBe(false)
    expect(Reflect.set(inlines, 0, { type: "text", value: "changed" })).toBe(false)
    expect(Reflect.set(link, "href", "javascript:alert(1)")).toBe(false)
    expect(Reflect.set(FROZEN_PREPARED.document, "blocks", [])).toBe(false)
    expect(Reflect.set(FROZEN_PREPARED.assets, "0", { key: "hijack" })).toBe(false)
    expect(Reflect.set(FROZEN_PREPARED.assets[0], "base64", "AAAA")).toBe(false)
    expect(Reflect.set(FROZEN_PREPARED.unavailableImageKeys, "0", "other")).toBe(false)
    expect(Reflect.set(FROZEN_PREPARED.diagnostics, "0", { kind: "droppedStyle", count: 9 })).toBe(false)
    expect(Reflect.set(SAMPLE_TABLE.rows[1].cells[1], "align", "left")).toBe(false)

    expect(Reflect.get(FROZEN_PREPARED, "policy")).toBe("semantic")
    expect(Reflect.get(inlines, "0")).toEqual({ type: "text", value: "plain " })
    expect(Reflect.get(link, "href")).toBe("https://example.com/docs")
    expect(Reflect.get(FROZEN_PREPARED.assets[0], "base64")).toBe("iVBORw0KGgo=")
  })

  it("keeps embedded asset keys unique within one prepared document", () => {
    expect(() => assertPasteAssets(SAMPLE_PREPARED)).not.toThrow()

    const duplicateEmbedded: PreparedSmartPaste = {
      ...SAMPLE_PREPARED,
      document: {
        blocks: [
          {
            type: "paragraph",
            children: [
              { type: "image", alt: "a", title: null, source: { kind: "embedded", key: "same", mime: "image/png", base64: "AA" } },
              { type: "image", alt: "b", title: null, source: { kind: "embedded", key: "same", mime: "image/png", base64: "BB" } },
            ],
          },
        ],
      },
      assets: [
        { key: "same", mime: "image/png", base64: "AA", alt: "a" },
        { key: "same", mime: "image/png", base64: "BB", alt: "b" },
      ],
      unavailableImageKeys: [],
      diagnostics: [],
    }
    expect(() => assertPasteAssets(duplicateEmbedded)).toThrow(/duplicate key same/)

    const missingAsset: PreparedSmartPaste = { ...SAMPLE_PREPARED, assets: [] }
    expect(() => assertPasteAssets(missingAsset)).toThrow(/has no matching asset/)

    const unreportedUnavailable: PreparedSmartPaste = { ...SAMPLE_PREPARED, unavailableImageKeys: [] }
    expect(() => assertPasteAssets(unreportedUnavailable)).toThrow(/is not reported/)
  })

  it("requires positive integer diagnostic counts", () => {
    expect(() => assertDiagnosticCounts(SAMPLE_PREPARED.diagnostics)).not.toThrow()
    expect(() => assertDiagnosticCounts(SAMPLE_SERIALIZED.diagnostics)).not.toThrow()
    expect(() => assertDiagnosticCounts(SAMPLE_PLAN.diagnostics)).not.toThrow()

    expect(() => assertDiagnosticCounts([{ kind: "droppedStyle", count: 0 }])).toThrow(/positive integer/)
    expect(() => assertDiagnosticCounts([{ kind: "droppedStyle", count: -2 }])).toThrow(/positive integer/)
    expect(() => assertDiagnosticCounts([{ kind: "droppedStyle", count: 1.25 }])).toThrow(/positive integer/)
    expect(() => assertDiagnosticCounts([{ kind: "droppedStyle", count: Number.NaN }])).toThrow(/positive integer/)
  })

  it("keeps model unions exhaustive against the fixture vocabulary", () => {
    // 夹具里出现过的 path/diagnostic 词表必须落在模型 union 内（反之不要求：
    // 夹具可以暂未覆盖某个 kind）。
    const cases = loadFixtures().flatMap(({ cases: fileCases }) => fileCases)
    expect(cases.length).toBeGreaterThan(0)
    for (const fixture of cases) {
      expect(Object.hasOwn(PLAN_KINDS, fixture.expectedPath)).toBe(true)
      expect(fixture.context.length).toBeGreaterThan(0)
      for (const diagnostic of fixture.expectedDiagnostics) {
        expect(Object.hasOwn(DIAGNOSTIC_KINDS, diagnostic.kind)).toBe(true)
        expect(Number.isInteger(diagnostic.count) && diagnostic.count > 0).toBe(true)
      }
    }
  })
})
