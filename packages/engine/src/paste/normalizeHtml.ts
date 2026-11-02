/**
 * Inert clipboard HTML → Paste AST（plan 02 Task 2）。
 *
 * 只读一棵 detached 文档：节点从不挂载、不 clone 到 `document`、不执行
 * 脚本/事件/CSS，也不回放 attribute、class 或 style 字符串 —— 输出是 Paste
 * AST，不是“清洗后的 HTML”。遍历是迭代的（显式 task/frame 栈），深度与节点
 * 数由 `./limits` 兜底；只有 font-weight / font-style / text-decoration 三个
 * 强语义 CSS 事实被读取，其余声明只计入 `droppedStyle`。URL 唯一闸门是
 * `./urlPolicy`，`data:image/(png|jpeg|webp)` 在进闸门之前提取成 PasteAsset。
 * 超限或任何意外失败都退回 `preparePlainTextFallback`。
 *
 * 本文件只留遍历状态机与公共入口：行内空白/wrapper/CSS 事实在
 * `./normalizeHtmlInline`，attribute 与资产解析、表格复杂度、诊断在
 * `./normalizeHtmlData`。
 */
import { MAX_PASTE_DOM_DEPTH, MAX_PASTE_DOM_NODES, MAX_PASTE_HTML_CHARS } from "./limits"
import type {
  PasteAsset, PasteBlock, PasteDocument, PasteInline, PasteListItem,
  PasteTableCell, PasteTableRow, PreparedSmartPaste, SmartPasteInput,
} from "./model"
import {
  buildRun, collapseWhitespace, LEADING_SPACE, normalizeInlineCode, normalizePreformatted,
  readStyleFacts, TRAILING_SPACE, wrapperKinds, type WrapperType,
} from "./normalizeHtmlInline"
import {
  collectDiagnostics, isSingleImageDocument, isUnavailableImageSrc, languageOf, leadingCheckbox,
  orderedStart, parseEmbeddedImage, preparePlainTextFallback, readCellMeta, tableRequiresComplexHtml,
  type CellMeta,
} from "./normalizeHtmlData"
import { normalizePasteUrl } from "./urlPolicy"

/** 测试专用护栏：生产入口固定使用 `./limits` 的默认值。 */
export interface PasteDomLimits { readonly maxDepth: number; readonly maxNodes: number }

const DEFAULT_LIMITS: PasteDomLimits = { maxDepth: MAX_PASTE_DOM_DEPTH, maxNodes: MAX_PASTE_DOM_NODES }

// --- 标签分类 ---------------------------------------------------------------

/** 子树整棵不读（连文本也不要）：不可见或会驱动行为的内容。 */
const SKIP_SUBTREE = new Set([
  "script", "style", "template", "noscript", "head", "title", "base", "meta", "link", "source", "track", "param",
])

/** 只是块级容器：内部按段落/块继续归一。 */
const BLOCK_CONTAINERS = new Set([
  "address", "article", "aside", "body", "center", "dd", "details", "dialog", "dir", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "header", "hgroup", "main", "menu", "nav", "p",
  "section", "summary",
])

const TABLE_SECTIONS = new Set(["thead", "tbody", "tfoot", "colgroup", "col"])
const HEADING_TAG = /^h([1-6])$/
// --- Frame / task 状态机 ----------------------------------------------------

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6
type ContainerRole = "root" | "generic" | "blockquote"

interface RunFields { items: PasteBlock[]; run: PasteInline[] }

type Frame =
  | ({ readonly kind: "container"; readonly role: ContainerRole } & RunFields)
  | ({ readonly kind: "li"; readonly checked: boolean | null } & RunFields)
  | ({ readonly kind: "cell"; readonly meta: CellMeta } & RunFields)
  | { readonly kind: "heading"; readonly level: HeadingLevel; run: PasteInline[] }
  | { readonly kind: "inline"; readonly wrap: WrapperType; children: PasteInline[] }
  | { readonly kind: "link"; readonly href: string; readonly title: string | null; children: PasteInline[] }
  | { readonly kind: "list"; readonly ordered: boolean; readonly start: number | null; items: PasteListItem[]; run: PasteInline[] }
  | { readonly kind: "table"; rows: PasteTableRow[]; stray: PasteBlock[]; run: PasteInline[] }
  | { readonly kind: "row"; cells: PasteTableCell[] }

type RunContainer = Extract<Frame, { kind: "container" | "li" }> | Extract<Frame, { kind: "cell" }>

type Task =
  | { readonly kind: "enter"; readonly node: Node; readonly depth: number }
  | { readonly kind: "leave"; readonly frame: Frame }

interface Writer {
  readonly frames: Frame[]
  readonly tasks: Task[]
  readonly limits: PasteDomLimits
  readonly ledger: { droppedStyle: number; rejectedUrl: number; unsupportedTable: number }
  readonly assets: PasteAsset[]
  readonly unavailableImageKeys: string[]
  readonly consumed: Set<Node>
  embeddedCount: number
  unavailableCount: number
  nodes: number
}

class PasteLimitError extends Error {
  constructor() {
    super("paste DOM limit exceeded")
    this.name = "PasteLimitError"
  }
}

function isRunContainer(frame: Frame): frame is RunContainer {
  return frame.kind === "container" || frame.kind === "li" || frame.kind === "cell"
}

function inlineTarget(frame: Frame | undefined): PasteInline[] | null {
  if (!frame) return null
  if (frame.kind === "inline" || frame.kind === "link") return frame.children
  if (isRunContainer(frame) || frame.kind === "heading" || frame.kind === "list") return frame.run
  return null
}

function appendInline(parent: Frame | undefined, node: PasteInline): void {
  const target = inlineTarget(parent)
  if (target) target.push(node)
}

function appendBlock(parent: Frame | undefined, block: PasteBlock): void {
  if (!parent) return
  if (isRunContainer(parent)) parent.items.push(block)
  else if (parent.kind === "table") parent.stray.push(block)
}

function flushRun(frame: Frame | undefined): void {
  if (!frame || !isRunContainer(frame) || frame.run.length === 0) return
  const children = buildRun(frame.run)
  frame.run = []
  if (children.length > 0) frame.items.push({ type: "paragraph", children })
}

function nearestFrame<K extends Frame["kind"]>(writer: Writer, kind: K): Extract<Frame, { kind: K }> | null {
  for (let index = writer.frames.length - 1; index >= 0; index -= 1) {
    if (writer.frames[index].kind === kind) return writer.frames[index] as Extract<Frame, { kind: K }>
  }
  return null
}

function topFrame(writer: Writer): Frame | undefined {
  return writer.frames[writer.frames.length - 1]
}

// --- 行内写入 ---------------------------------------------------------------

function pushInlineText(writer: Writer, value: string): void {
  const text = collapseWhitespace(value)
  if (text.trim() !== "") appendInline(topFrame(writer), { type: "text", value: text })
}

function pushInlineNode(writer: Writer, node: PasteInline): void {
  appendInline(topFrame(writer), node)
}

function pushText(writer: Writer, raw: string): void {
  const target = inlineTarget(topFrame(writer))
  if (!target) return
  const last = target[target.length - 1]
  let value = collapseWhitespace(raw)
  if (last?.type === "hardBreak") value = value.replace(LEADING_SPACE, "")
  if (value === "") return
  if (last?.type === "text") target[target.length - 1] = { type: "text", value: collapseWhitespace(last.value + value) }
  else target.push({ type: "text", value })
}

function pushHardBreak(writer: Writer): void {
  const target = inlineTarget(topFrame(writer))
  if (!target) return
  const last = target[target.length - 1]
  if (last?.type === "text") {
    const value = last.value.replace(TRAILING_SPACE, "")
    if (value === "") target.pop()
    else target[target.length - 1] = { type: "text", value }
  }
  target.push({ type: "hardBreak" })
}

function descend(writer: Writer, el: Element, depth: number): void {
  const children = el.childNodes
  for (let index = children.length - 1; index >= 0; index -= 1) writer.tasks.push({ kind: "enter", node: children[index], depth: depth + 1 })
}

/** 跳过的子树也要计入预算，否则一个 `<script>` 就能藏住整棵巨树。 */
function countSubtree(writer: Writer, root: Element): void {
  const stack: Node[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as Node
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if ((writer.nodes += 1) > writer.limits.maxNodes) throw new PasteLimitError()
      stack.push(child)
    }
  }
}

// --- frame 开合 -------------------------------------------------------------

function unwindToContainer(writer: Writer): void {
  while (writer.frames.length > 1) {
    const top = topFrame(writer) as Frame
    if (isRunContainer(top)) return
    closeFrame(writer, top)
  }
}

/**
 * 打开一个块级 frame。结构性子元素（li/tr/td）在父容器正好是它的宿主时
 * 不再回退，否则先回到最近的 run 容器并 flush 当前 run。
 */
function pushBlockFrame(writer: Writer, frame: Frame, el: Element, depth: number,
  wrappers: readonly WrapperType[], structuralParent?: Frame["kind"]): void {
  const top = topFrame(writer)
  if (!structuralParent || top?.kind !== structuralParent) {
    unwindToContainer(writer)
    flushRun(topFrame(writer))
  }
  writer.frames.push(frame)
  writer.tasks.push({ kind: "leave", frame })
  if (wrappers.length > 0 && inlineTarget(frame)) pushWrappers(writer, el, depth, wrappers)
  else descend(writer, el, depth)
}

/** 不承载子内容的块（hr、代码块）直接落到当前容器。 */
function pushStandaloneBlock(writer: Writer, block: PasteBlock): void {
  unwindToContainer(writer)
  const parent = topFrame(writer)
  flushRun(parent)
  appendBlock(parent, block)
}

function pushWrappers(writer: Writer, el: Element, depth: number, wrappers: readonly WrapperType[]): void {
  for (const wrap of wrappers) {
    const frame: Frame = { kind: "inline", wrap, children: [] }
    writer.frames.push(frame)
    writer.tasks.push({ kind: "leave", frame })
  }
  descend(writer, el, depth)
}

function closeFrame(writer: Writer, frame: Frame): void {
  // 提前展开（块级元素打断了 inline frame）的 frame 已经被关过，这里空转。
  if (topFrame(writer) !== frame) return
  writer.frames.pop()
  const parent = topFrame(writer)

  switch (frame.kind) {
    case "inline":
      if (frame.children.length > 0) appendInline(parent, { type: frame.wrap, children: frame.children })
      return
    case "link":
      if (frame.children.length > 0) {
        appendInline(parent, { type: "link", href: frame.href, title: frame.title, children: frame.children })
      }
      return
    case "heading": {
      const children = buildRun(frame.run)
      if (children.length > 0) appendBlock(parent, { type: "heading", level: frame.level, children })
      return
    }
    case "container":
      flushRun(frame)
      if (frame.role === "root") return
      if (frame.role === "blockquote") {
        if (frame.items.length > 0) appendBlock(parent, { type: "blockquote", children: frame.items })
        return
      }
      for (const block of frame.items) appendBlock(parent, block)
      return
    case "li": {
      flushRun(frame)
      const listFrame = nearestFrame(writer, "list")
      if (listFrame) listFrame.items.push({ checked: frame.checked, children: frame.items })
      else for (const block of frame.items) appendBlock(parent, block)
      return
    }
    case "cell": {
      flushRun(frame)
      const rowFrame = nearestFrame(writer, "row")
      if (rowFrame) rowFrame.cells.push({ ...frame.meta, blocks: frame.items })
      else for (const block of frame.items) appendBlock(parent, block)
      return
    }
    case "row": {
      const tableFrame = nearestFrame(writer, "table")
      if (tableFrame && frame.cells.length > 0) tableFrame.rows.push({ cells: frame.cells })
      return
    }
    case "list":
      if (frame.run.length > 0) {
        // `<ul>` 里的游离文本仍然可见：包成一个 item，别丢。
        const children = buildRun(frame.run)
        frame.run = []
        if (children.length > 0) frame.items.push({ checked: null, children: [{ type: "paragraph", children }] })
      }
      if (frame.items.length > 0) {
        appendBlock(parent, { type: "list", ordered: frame.ordered, start: frame.start, items: frame.items })
      }
      return
    case "table": {
      flushRun(frame)
      for (const block of frame.stray) appendBlock(parent, block)
      if (frame.rows.length === 0) return
      const requiresComplexHtml = frame.stray.length > 0 || tableRequiresComplexHtml(frame.rows)
      appendBlock(parent, { type: "table", table: { rows: frame.rows, requiresComplexHtml } })
      return
    }
  }
}

// --- 块级元素 ---------------------------------------------------------------

function openPreformatted(writer: Writer, el: Element): void {
  countSubtree(writer, el)
  const first = el.firstElementChild
  const code = first && first.tagName.toLowerCase() === "code" ? first : null
  const value = normalizePreformatted((code ?? el).textContent ?? "")
  if (value !== "") pushStandaloneBlock(writer, { type: "codeBlock", language: code ? languageOf(code) : "", value })
}

// --- 链接与图片 -------------------------------------------------------------

function openLink(writer: Writer, el: Element, depth: number, wrappers: readonly WrapperType[]): void {
  const href = el.getAttribute("href")
  const safe = href === null ? null : normalizePasteUrl(href, "link")
  if (safe === null) {
    // 没有 href 的 `<a>` 是普通文本；被拒的 href 是可见文本 + rejectedUrl。
    if (href !== null) writer.ledger.rejectedUrl += 1
    descend(writer, el, depth)
    return
  }
  const title = el.getAttribute("title")
  const frame: Frame = { kind: "link", href: safe, title: title ? title : null, children: [] }
  writer.frames.push(frame)
  writer.tasks.push({ kind: "leave", frame })
  if (wrappers.length > 0) pushWrappers(writer, el, depth, wrappers)
  else descend(writer, el, depth)
}

function openImage(writer: Writer, el: Element): void {
  const alt = el.getAttribute("alt") ?? ""
  const titleSource = el.getAttribute("title")
  const title = titleSource ? titleSource : null
  const src = el.getAttribute("src")
  if (src === null || src.trim() === "") {
    pushInlineText(writer, alt)
    return
  }

  // data:image/* 必须在 URL 闸门之前提取：闸门对任何 data: 一律拒绝。
  const embedded = parseEmbeddedImage(src)
  if (embedded) {
    const key = `paste-embedded-${(writer.embeddedCount += 1)}`
    writer.assets.push({ key, mime: embedded.mime, base64: embedded.base64, alt })
    const source = { kind: "embedded" as const, key, mime: embedded.mime, base64: embedded.base64 }
    pushInlineNode(writer, { type: "image", alt, title, source })
    return
  }
  // blob:/file: 的字节拿不到：只留一个确定的占位 key，绝不暗示它与剪贴板
  // File 数组的位置对应关系。
  if (isUnavailableImageSrc(src)) {
    const key = `paste-unavailable-${(writer.unavailableCount += 1)}`
    writer.unavailableImageKeys.push(key)
    pushInlineNode(writer, { type: "image", alt, title, source: { kind: "unavailable", key } })
    return
  }

  const safe = normalizePasteUrl(src, "image")
  if (safe === null) {
    writer.ledger.rejectedUrl += 1
    pushInlineText(writer, alt)
    return
  }
  pushInlineNode(writer, { type: "image", alt, title, source: { kind: "url", value: safe } })
}

// --- 元素分发 ---------------------------------------------------------------

function enterElement(writer: Writer, el: Element, depth: number): void {
  if (writer.consumed.has(el)) return
  const tag = el.tagName.toLowerCase()
  if (SKIP_SUBTREE.has(tag)) {
    countSubtree(writer, el)
    return
  }

  const { facts, droppedStyle } = readStyleFacts(el, tag === "td" || tag === "th")
  writer.ledger.droppedStyle += droppedStyle
  const wrappers = wrapperKinds(tag, facts)
  const block = (frame: Frame, structuralParent?: Frame["kind"]): void =>
    pushBlockFrame(writer, frame, el, depth, wrappers, structuralParent)

  switch (tag) {
    case "pre": return openPreformatted(writer, el)
    case "br": return pushHardBreak(writer)
    case "img": return openImage(writer, el)
    case "hr": return pushStandaloneBlock(writer, { type: "horizontalRule" })
    case "a": return openLink(writer, el, depth, wrappers)
    case "blockquote": return block({ kind: "container", role: "blockquote", items: [], run: [] })
    case "table": return pushBlockFrame(writer, { kind: "table", rows: [], stray: [], run: [] }, el, depth, [])
    case "tr": return pushBlockFrame(writer, { kind: "row", cells: [] }, el, depth, [], "table")
    case "code":
      countSubtree(writer, el)
      return pushInlineNode(writer, { type: "code", value: normalizeInlineCode(el.textContent ?? "") })
    case "ul": case "ol": {
      const ordered = tag === "ol"
      return block({ kind: "list", ordered, start: ordered ? orderedStart(el) : null, items: [], run: [] })
    }
    case "li": {
      if (topFrame(writer)?.kind !== "list") return block({ kind: "container", role: "generic", items: [], run: [] })
      const checkbox = leadingCheckbox(el)
      if (checkbox) writer.consumed.add(checkbox)
      const checked = checkbox ? checkbox.hasAttribute("checked") : null
      return block({ kind: "li", checked, items: [], run: [] }, "list")
    }
    case "th": case "td": return block({ kind: "cell", meta: readCellMeta(el, facts), items: [], run: [] }, "row")
    default: break
  }

  const heading = HEADING_TAG.exec(tag)
  if (heading) return block({ kind: "heading", level: Number(heading[1]) as HeadingLevel, run: [] })
  if (TABLE_SECTIONS.has(tag)) return descend(writer, el, depth)
  if (BLOCK_CONTAINERS.has(tag)) return block({ kind: "container", role: "generic", items: [], run: [] })
  // 未知/危险/媒体/表单控件：删标签、保留可见后代（以及强语义 CSS）。
  if (wrappers.length > 0) return pushWrappers(writer, el, depth, wrappers)
  return descend(writer, el, depth)
}

// --- 遍历 -------------------------------------------------------------------

function run(writer: Writer, body: Element): void {
  writer.frames.push({ kind: "container", role: "root", items: [], run: [] })
  descend(writer, body, 0)
  while (writer.tasks.length > 0) {
    const task = writer.tasks.pop() as Task
    if (task.kind === "leave") {
      closeFrame(writer, task.frame)
      continue
    }
    const { node, depth } = task
    writer.nodes += 1
    if (writer.nodes > writer.limits.maxNodes) throw new PasteLimitError()
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(writer, node.nodeValue ?? "")
      continue
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue
    if (depth > writer.limits.maxDepth) throw new PasteLimitError()
    enterElement(writer, node as Element, depth)
  }
  while (writer.frames.length > 1) closeFrame(writer, topFrame(writer) as Frame)
  flushRun(writer.frames[0])
}

// --- 公共 API ---------------------------------------------------------

/** 归一化剪贴板 HTML；任何失败（含护栏超限）都退回字面文本 fallback。 */
export function normalizeHtmlPaste(input: SmartPasteInput): PreparedSmartPaste {
  if (input.html.length > MAX_PASTE_HTML_CHARS) return preparePlainTextFallback(input.plainText)
  return normalizeWithinLimits(input, DEFAULT_LIMITS)
}

/** 测试专用入口：让边界用例不必构造 200k 节点夹具。生产不得调用。 */
export function normalizeHtmlPasteWithinLimits(input: SmartPasteInput, limits: PasteDomLimits): PreparedSmartPaste {
  return normalizeWithinLimits(input, limits)
}

function normalizeWithinLimits(input: SmartPasteInput, limits: PasteDomLimits): PreparedSmartPaste {
  const writer: Writer = {
    frames: [],
    tasks: [],
    limits,
    ledger: { droppedStyle: 0, rejectedUrl: 0, unsupportedTable: 0 },
    assets: [],
    unavailableImageKeys: [],
    consumed: new Set<Node>(),
    embeddedCount: 0,
    unavailableCount: 0,
    nodes: 0,
  }
  try {
    const body = new DOMParser().parseFromString(input.html, "text/html").body
    if (!body) return preparePlainTextFallback(input.plainText)
    run(writer, body)
  } catch {
    // 不可信输入不拥有异常通道：任何失败都降级为可见字面文本。
    return preparePlainTextFallback(input.plainText)
  }

  const blocks = (writer.frames[0] as Extract<Frame, { kind: "container" }>).items
  const document: PasteDocument = { blocks }
  return {
    policy: "semantic",
    document,
    plainText: input.plainText,
    assets: writer.assets,
    unavailableImageKeys: writer.unavailableImageKeys,
    isSingleImageOnly: isSingleImageDocument(blocks),
    diagnostics: collectDiagnostics(writer.ledger),
  }
}

/** 不使用 DOM 的字面文本 fallback：空行分段，行内换行变 hardBreak（纯降级构造在 `./normalizeHtmlData`）。 */
export { preparePlainTextFallback }
