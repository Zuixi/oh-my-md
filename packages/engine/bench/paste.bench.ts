import { bench, describe } from "vitest"
import { EditorState } from "@codemirror/state"
import { forceParsing, syntaxTree } from "@codemirror/language"
import { EditorView } from "@codemirror/view"
import { markdownLanguageSupport } from "../src/parse/markdown"
import { MAX_PASTE_DOM_NODES, MAX_PASTE_HTML_CHARS } from "../src/paste/limits"
import { serializePasteDocument } from "../src/paste/serialize"
import { planSmartPaste, prepareSmartPaste } from "../src/paste/smartPaste"
import type { PreparedSmartPaste, SmartPasteInput } from "../src/paste/model"
import { pasteValidationTestParseCalls, setPasteValidationTestSeams } from "../src/paste/validate"
import {
  editorReferenceContext,
  referenceIndexExtension,
  referenceIndexScanStats,
} from "../src/semantic/references"

/**
 * Smart Paste importer benchmark (plan 02 Task 6, advisory — no pass/fail ms budget).
 *
 * 四档剪贴板 HTML 分别测四个互不重叠的成本面，绝不能只报一个合计值：
 *   1. detached `DOMParser` 分配/解析 —— `normalizeHtml.ts` 的深度/节点护栏在
 *      `parseFromString` **之后**才生效，它约束的是遍历，不是这次分配；
 *   2. 归一化 —— 公共入口 `prepareSmartPaste` 内部自己 new DOMParser，所以这一档
 *      = 1 + 遍历 + Paste AST 构造（名字里写清楚，别把它当纯遍历）；
 *   3. 序列化 —— 纯 AST 遍历，无 DOM（`serializePasteDocument`）；
 *   4. 一次性验证/规划 —— `planSmartPaste` 最多解析一次合成文档
 *      （prefix + 候选 + suffix），超过 `MAX_PASTE_VALIDATED_INSERT_CHARS` 或
 *      `MAX_PASTE_VALIDATION_CONTEXT_CHARS` 时零解析走保守路径。
 *
 * 另测大文档引用索引（`semantic/references.ts`）：初次索引、引用图片旁的普通
 * 编辑、定义改动刷新。每档都用 `referenceIndexScanStats` 断言普通编辑只重扫
 * 受影响块 —— 用 `snapshotReferenceContext`（每 Tree 缓存）测会把整篇定义扫描
 * 藏进缓存里，那个数字不能代表逐键成本。
 *
 * 生成器确定性（无随机、无外部 I/O、无提交的 Office 样本），每档按 UTF-8 字节
 * 定尺寸；每次迭代都断言输出非空、policy/parse 计数符合契约。
 *
 * happy-dom 时序不是响应性门槛：这里只给同机前后对比的基线，真机 webview 复核
 * 见 docs/manual-qa.md。CI 抖动见 known-gotchas「Benchmark jitter is real」。
 *
 * 本机基线（macOS 26.2 arm64 · Node v26.7.0 · pnpm 11.22.0 · happy-dom 16，
 * advisory，只合同机前后对比 —— happy-dom 的 DOM 解析远慢于 WebKit/WebView2）：
 *
 * | 档位 | DOMParser | normalize（含解析） | serialize | plan |
 * |------|-----------|---------------------|-----------|------|
 * | 4 KiB | 0.41ms | 0.52ms | 0.11ms | 0.47ms（1 次验证解析） |
 * | 100 KiB | 10.6ms | 13.0ms | 2.7ms | 11.3ms（1 次验证解析） |
 * | 1 MiB | 103ms | 133ms | 34ms | 54ms（0 解析 → 整段 strict） |
 * | 5 MiB | 467ms | 676ms | 171ms | 278ms（0 解析 → 整段 strict） |
 * | 5 MiB 全表格 | — | 1,205ms | — | —（护栏溢出 → literalFallback） |
 *
 * 节点密度（实测）：混合片段 4KiB/133、100KiB/3.2k、1MiB/32.6k、5MiB/161.6k
 * 节点（≈31 节点/KiB），`MAX_PASTE_DOM_NODES = 200_000` 约在 6.4 MiB 混合片段或
 * 2.8 MiB 全表格片段上被撞到。1 MiB 起的 plan 之所以零解析，是因为候选文本
 * 超过 `MAX_PASTE_VALIDATED_INSERT_CHARS`（262,144 字符）—— 超过就整段 strict
 * 字面回退，**不再解析第二次**（不是 bug，是 Task 4 的成本闸门）。
 *
 * 引用索引（166 KiB / 4,500 顶层块的完整解析文档）：初次索引 0.98ms（只 seed 已
 * 提交前缀的 156 块，不推进解析）；引用图片旁的 1 字符编辑 1.22ms、只重扫 1 块；
 * 定义改写 1.19ms、同样只重扫 1 块。整篇覆盖由 `growIndex` 增量补齐，契约测试在
 * `test/semanticReferences.test.ts`。
 */

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[paste bench] ${message}`)
}

function utf8Bytes(value: string): number {
  let bytes = 0
  for (let i = 0; i < value.length; i++) bytes += value.charCodeAt(i) < 128 ? 1 : 3
  return bytes
}

// ------------------------------------------------------- deterministic samples

/**
 * 一段「Word / Google Docs 复制出来的正文」形态：强语义内联 + 样式噪声 +
 * 中文正文，句子够多以致标签密度接近真实文档（中文按 3 字节计）。
 * 节点密度是刻意校准过的：见 makePasteHtml 的注释与 LIMITS 说明。
 */
const BODY_SENTENCES = [
  "这是从 Word 复制过来的正文，含中文与 English mixed content",
  "第二句把段落拉到真实剪贴板的量级，避免标签密度虚高",
  "第三句带上数字 2026 与标点，模拟表格之间的说明文字",
  "第四句继续补足长度，让同一字节预算下的节点密度接近真实文档",
  "第五句收尾，真实段落通常比一行标签流长得多",
]

function paragraphBlock(index: number): { html: string; text: string } {
  const body = BODY_SENTENCES.map((sentence, k) => `${sentence}（${index}.${k}）。`).join("")
  const html = `<p style="margin:0 0 8px"><strong>段落 ${index}</strong>：${body}` +
    `含<em>斜体</em>、<a href="https://example.com/doc/${index}">链接 ${index}</a>、` +
    `<code>fn_${index}()</code> 与 <span style="color:#333">普通文本</span>。</p>`
  return { html, text: `段落 ${index}：${body}` }
}

const TABLE_ROWS = 3
const TABLE_COLS = 3

/** GFM 可表达的简单表（无 span/scope）：单元格长度为真实 Sheets 复制量级。 */
function tableBlock(index: number): { html: string; text: string } {
  const head = Array.from({ length: TABLE_COLS }, (_, c) => `<th>列${c}</th>`).join("")
  const rows: string[] = []
  const lines: string[] = []
  for (let r = 0; r < TABLE_ROWS; r++) {
    const cells = Array.from({ length: TABLE_COLS }, (_, c) => `单元格 ${index}-${r}-${c} 的说明文字`)
    rows.push(`<tr>${cells.map(cell => `<td>${cell}</td>`).join("")}</tr>`)
    lines.push(cells.join("\t"))
  }
  return {
    html: `<table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`,
    text: lines.join("\n"),
  }
}

export interface PasteSample extends SmartPasteInput {
  readonly bytes: number
}

/**
 * 约 `targetBytes` 个 UTF-8 字节的语义 HTML 片段。`tableEvery` 是表格间隔：
 * 6 = 「文档 + 表格」混合（约 31 节点/KiB）；1 = 全表格（Sheets 形态，约
 * 60 节点/KiB），用来越过 `MAX_PASTE_DOM_NODES` 观察整段字面回退。
 */
export function makePasteHtml(targetBytes: number, tableEvery = 6): PasteSample {
  const html: string[] = []
  const text: string[] = []
  let bytes = 0
  for (let i = 0; bytes < targetBytes; i++) {
    const block = i % tableEvery === tableEvery - 1 ? tableBlock(i) : paragraphBlock(i)
    html.push(block.html)
    text.push(block.text)
    bytes += utf8Bytes(block.html) + 1
  }
  return { html: html.join("\n"), plainText: text.join("\n\n"), bytes }
}

/**
 * 大文档引用索引样本：每块一段正文 + 一张引用式图片，定义集中在文末。
 * 定义放在末尾是刻意的 —— 索引覆盖到文末之前必须解不出引用。
 */
export function makeReferenceDoc(blocks: number): string {
  const parts: string[] = []
  for (let i = 0; i < blocks; i++) {
    parts.push(`段落 ${i}：正文段落，引用图片见下文。\n\n![pic ${i}][ref${i}]`)
  }
  for (let i = 0; i < blocks; i++) parts.push(`[ref${i}]: img/${i}.png "title ${i}"`)
  return parts.join("\n\n")
}

// 生成器确定性：同一参数两次生成必须逐字节相同（无随机、无时间戳）。
check(makePasteHtml(4096).html === makePasteHtml(4096).html, "HTML generator is not deterministic")
check(makePasteHtml(4096, 1).html === makePasteHtml(4096, 1).html, "table generator is not deterministic")
check(makeReferenceDoc(50) === makeReferenceDoc(50), "reference generator is not deterministic")

const KIB = 1024
const SAMPLES = [
  { name: "typical 4 KiB", sample: makePasteHtml(4 * KIB), iterations: undefined },
  { name: "100 KiB", sample: makePasteHtml(100 * KIB), iterations: { iterations: 10, warmupIterations: 1 } },
  { name: "1 MiB", sample: makePasteHtml(1024 * KIB), iterations: { iterations: 3, warmupIterations: 1 } },
  // 5 MiB 只跑一次：不重复轰炸本机，也不产生无意义的均值。
  { name: "5 MiB", sample: makePasteHtml(5 * 1024 * KIB), iterations: { iterations: 1, warmupIterations: 0 } },
]

/** Sheets 形态（全表格）5 MiB：节点数越过遍历护栏，只能整段回退字面文本。 */
const DENSE_5MIB = makePasteHtml(5 * 1024 * KIB, 1)

/** 已归一化的 AST 供序列化/规划两档复用（不计入这两个 bench 的计时）。 */
function preparedOf(sample: PasteSample): PreparedSmartPaste {
  const prepared = prepareSmartPaste(sample)
  check(prepared.document.blocks.length > 0, `${sample.bytes}B sample normalized to an empty document`)
  return prepared
}

const HOST_DOC = [
  "# 粘贴目标",
  "",
  "第一段正文，用于验证候选插入点。",
  "",
  "![图片][ref]",
  "",
  "[ref]: img/host.png",
  "",
  "第二段正文。",
].join("\n")
const HOST_STATE = EditorState.create({ doc: HOST_DOC, extensions: [markdownLanguageSupport()] })
const HOST_RANGE = { from: HOST_DOC.indexOf("第一段正文") + 3, to: HOST_DOC.indexOf("第一段正文") + 3 }
check(syntaxTree(HOST_STATE).length === HOST_DOC.length, "host doc is not fully parsed")

const noAssets = (): string | null => null

/** 每个 bench 只打印一次事实行（迭代次数对信息行没有意义）。 */
function reporter(label: string): (message: string) => void {
  let printed = false
  return message => {
    if (printed) return
    printed = true
    console.info(`[paste] ${label}: ${message}`)
  }
}

describe("smart paste importer — clipboard HTML (advisory)", () => {
  for (const { name, sample, iterations } of SAMPLES) {
    const prepared = preparedOf(sample)
    const info = {
      dom: reporter(`${name} DOMParser`),
      normalize: reporter(`${name} normalize`),
      serialize: reporter(`${name} serialize`),
      plan: reporter(`${name} plan`),
    }
    const options = iterations ?? {}

    // 1. 裸 detached 解析：护栏管不到这次分配，量的是 `parseFromString` 本身。
    bench(`DOMParser parse ${name}`, () => {
      const parsed = new DOMParser().parseFromString(sample.html, "text/html")
      const text = parsed.body.textContent ?? ""
      check(text.length > 0, `${name} DOMParser produced no body text`)
      info.dom(`${sample.bytes}B html → ${text.length} visible chars`)
    }, options)

    // 2. 公共归一化入口（含它自己那次 DOMParser）。
    bench(`normalize ${name} (prepareSmartPaste — includes DOMParser)`, () => {
      const result = prepareSmartPaste(sample)
      const expectedPolicy = sample.html.length > MAX_PASTE_HTML_CHARS ? "literalFallback" : "semantic"
      check(result.policy === expectedPolicy, `${name} normalize policy ${result.policy}, expected ${expectedPolicy}`)
      check(result.document.blocks.length > 0, `${name} normalize produced no blocks`)
      info.normalize(`${sample.bytes}B html → ${result.document.blocks.length} blocks, policy ${result.policy}`)
    }, options)

    // 3. 纯 AST 序列化（无 DOM）——每档都与归一化共用同一棵 AST。
    bench(`serialize ${name} (AST only, no DOM)`, () => {
      const out = serializePasteDocument(prepared.document, { mode: "minimal", resolveAsset: noAssets })
      check(out.text.length > 0, `${name} serialize produced no text`)
      info.serialize(`${prepared.document.blocks.length} blocks → ${out.text.length} chars`)
    }, options)

    // 4. 规划/验证：一次候选最多一次合成解析，超过护栏则零解析。
    bench(`plan ${name} (candidate planning, ≤ 1 parse)`, () => {
      setPasteValidationTestSeams(null)
      const plan = planSmartPaste(prepared, HOST_STATE, HOST_RANGE)
      const parses = pasteValidationTestParseCalls()
      check(plan.text.length > 0, `${name} plan produced no text`)
      check(parses <= 1, `${name} plan parsed ${parses} times (contract: at most once)`)
      const strict = plan.diagnostics.some(d => d.kind === "strictFallback")
      info.plan(`kind ${plan.kind}, validation parses ${parses}, text ${plan.text.length} chars` +
        `${strict ? ", strict fallback" : ""}`)
    }, options)
  }

  // 溢出档：节点数超过 `MAX_PASTE_DOM_NODES` 时 normalizer 不做切半截的处理，
  // 整个片段退回字面文本（一条 strictFallback 诊断）。DOMParser 的分配已经发生
  // —— 遍历护栏管不到它，这是 oversize 输入的唯一实测依据。
  const denseInfo = reporter("5 MiB tag-dense")
  bench("normalize 5 MiB tag-dense (Sheets shape) — guard trip → literal fallback", () => {
    const result = prepareSmartPaste(DENSE_5MIB)
    check(result.policy === "literalFallback", "tag-dense 5 MiB did not trip the traversal guard")
    check(result.document.blocks.length > 0, "literal fallback produced no blocks")
    check(result.diagnostics.some(d => d.kind === "strictFallback"), "fallback lacks strictFallback diagnostic")
    denseInfo(`${DENSE_5MIB.bytes}B html → policy ${result.policy}, guard ${MAX_PASTE_DOM_NODES} nodes`)
  }, { iterations: 1, warmupIterations: 0 })
})

// --------------------------------------------------------- reference indexing

const REFERENCE_BLOCKS = 1500
const REFERENCE_DOC = makeReferenceDoc(REFERENCE_BLOCKS)
// 普通编辑允许重扫的块数上限：宿主块 + 可能的合并邻块（删除换行）。
const EDIT_SCAN_LIMIT = 2

function topLevelBlocks(state: EditorState): number {
  let count = 0
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Document") return
      if (node.node.parent?.name === "Document") count++
      return false
    },
  })
  return count
}

/** 完整解析后的大文档状态（`forceParsing` 只在 bench/test 里用）。 */
function fullyParsedReferenceState(doc: string): EditorState {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [markdownLanguageSupport(), referenceIndexExtension] }),
    parent,
  })
  try {
    check(forceParsing(view, doc.length, 60_000), "reference doc did not fully parse")
    return view.state
  } finally {
    view.destroy()
    parent.remove()
  }
}

const FULL_STATE = fullyParsedReferenceState(REFERENCE_DOC)
const TOTAL_BLOCKS = topLevelBlocks(FULL_STATE)
const DOC_BYTES = utf8Bytes(REFERENCE_DOC)
// 「引用图片旁的普通编辑」：落在正文段落里，紧邻下一块的引用图片。
const EDIT_POS = REFERENCE_DOC.indexOf("段落 7：") + 4
const DEF_FROM = REFERENCE_DOC.indexOf("[ref10]: img/10.png") + "[ref10]: ".length
const DEF_TO = DEF_FROM + "img/10.png".length

check(syntaxTree(FULL_STATE).length === REFERENCE_DOC.length, "reference doc tree is incomplete")
check(editorReferenceContext(FULL_STATE).resolveReference("[ref10]")?.href === "img/10.png",
  "reference index did not resolve the last-block definition")

describe("smart paste — large document reference index (advisory)", () => {
  const initialInfo = reporter("reference index initial")
  const editInfo = reporter("reference index ordinary edit")
  const defInfo = reporter("reference index definition edit")

  bench("reference index: initial indexing (large doc)", () => {
    referenceIndexScanStats.reset()
    const state = EditorState.create({
      doc: REFERENCE_DOC,
      extensions: [markdownLanguageSupport(), referenceIndexExtension],
    })
    const scanned = referenceIndexScanStats.scannedBlocks
    // 初次索引只覆盖已提交的语法树前缀，不推进解析 —— 不做整篇保证。
    check(scanned > 0, "initial indexing scanned no blocks")
    check(scanned <= TOTAL_BLOCKS, `initial indexing scanned ${scanned} > ${TOTAL_BLOCKS} blocks`)
    check(state.doc.length === REFERENCE_DOC.length, "initial state lost the document")
    initialInfo(`${DOC_BYTES}B doc, ${TOTAL_BLOCKS} top-level blocks, seed scanned ${scanned}`)
  })

  bench("reference index: ordinary edit beside reference images", () => {
    referenceIndexScanStats.reset()
    const next = FULL_STATE.update({ changes: { from: EDIT_POS, insert: "X" } }).state
    const scanned = referenceIndexScanStats.scannedBlocks
    check(next.doc.length === FULL_STATE.doc.length + 1, "ordinary edit did not apply")
    check(scanned <= EDIT_SCAN_LIMIT,
      `ordinary edit rescanned ${scanned} of ${TOTAL_BLOCKS} blocks (limit ${EDIT_SCAN_LIMIT})`)
    editInfo(`1 char edit → ${scanned} block(s) rescanned of ${TOTAL_BLOCKS}`)
  })

  bench("reference index: definition edit refresh", () => {
    referenceIndexScanStats.reset()
    const next = FULL_STATE.update({ changes: { from: DEF_FROM, to: DEF_TO, insert: "img/other.png" } }).state
    const scanned = referenceIndexScanStats.scannedBlocks
    const resolved = editorReferenceContext(next).resolveReference("[ref10]")
    check(resolved?.href === "img/other.png", `definition edit did not refresh (got ${resolved?.href})`)
    check(scanned <= EDIT_SCAN_LIMIT,
      `definition edit rescanned ${scanned} of ${TOTAL_BLOCKS} blocks (limit ${EDIT_SCAN_LIMIT})`)
    defInfo(`definition replace → ${scanned} block(s) rescanned, resolver refreshed`)
  })
})
