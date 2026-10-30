/**
 * 行内归一（plan 02 Task 2 拆分）：文本/空白折叠、语义 wrapper 合并与 trim，
 * 以及三个强语义 CSS 事实（font-weight / font-style / text-decoration）。
 *
 * 纯函数：不接触 writer、不读 DOM 树结构，只吃 `Element` 的 style/class 事实
 * 与 `PasteInline` 数组。遍历状态机在 `./normalizeHtml`。
 */
import type { PasteInline } from "./model"

/** 可折叠空白（HTML 空白集，不含 NBSP）。 */
export const COLLAPSIBLE_WHITESPACE = /[ \t\n\r\f]+/g
export const LEADING_SPACE = /^ +/
export const TRAILING_SPACE = / +$/
const DECLARATION = /(?:^|;)\s*([-a-zA-Z][-a-zA-Z0-9]*)\s*:/g

/** class / text-decoration 的 token 分隔符。 */
export const DECORATION_TOKENS = /[\s,]+/

/** 表格 cell 的可见对齐（`text-align` 语义）。 */
export type Align = "left" | "center" | "right"

/** 由 model 的 inline union 推导，避免这里再抄一份 wrapper 字面量。 */
export type WrapperType = Exclude<Extract<PasteInline, { readonly children: readonly PasteInline[] }>["type"], "link">

export interface WrapperInline {
  readonly type: WrapperType
  readonly children: readonly PasteInline[]
}

/** 标签名 → 语义 wrapper（`em` 与 `emphasis` 不是同一个词表，别混用）。 */
const TAG_WRAPPERS: ReadonlyMap<string, readonly WrapperType[]> = new Map<string, readonly WrapperType[]>([
  ["strong", ["strong"]], ["b", ["strong"]],
  ["em", ["emphasis"]], ["i", ["emphasis"]],
  ["u", ["underline"]],
  ["s", ["strike"]], ["del", ["strike"]], ["strike", ["strike"]],
  ["mark", ["highlight"]],
  ["kbd", ["kbd"]],
  ["sub", ["subscript"]], ["sup", ["superscript"]],
])

/** Paste AST 的语义 wrapper 类型名；漏项/多项都会被 tsc 抓住。 */
const WRAPPER_TYPES: Record<WrapperType, true> = {
  strong: true,
  emphasis: true,
  underline: true,
  strike: true,
  highlight: true,
  kbd: true,
  subscript: true,
  superscript: true,
}

export function collapseWhitespace(value: string): string {
  return value.replace(COLLAPSIBLE_WHITESPACE, " ")
}

function isWrapper(node: PasteInline): node is WrapperInline {
  return Object.prototype.hasOwnProperty.call(WRAPPER_TYPES, node.type)
}

function withChildren(node: PasteInline, children: readonly PasteInline[]): PasteInline | null {
  if (node.type === "link") return { type: "link", href: node.href, title: node.title, children }
  return isWrapper(node) ? { type: node.type, children } : null
}

/**
 * 合并相邻 Text / 相同语义，折叠重复嵌套，丢掉空 wrapper。
 * 只在 run 边界调用，不做全局 trim/squeeze heuristic。
 */
function normalizeInlines(raw: readonly PasteInline[]): PasteInline[] {
  const out: PasteInline[] = []
  for (const inline of raw) {
    if (inline.type === "text") {
      if (inline.value === "") continue
      const last = out[out.length - 1]
      const value = collapseWhitespace(inline.value)
      if (last?.type === "text") out[out.length - 1] = { type: "text", value: collapseWhitespace(last.value + value) }
      else out.push({ type: "text", value })
      continue
    }
    if (inline.type !== "link" && !isWrapper(inline)) {
      out.push(inline)
      continue
    }
    let children = normalizeInlines(inline.children)
    let only: PasteInline | null = children.length === 1 ? children[0] : null
    while (only && only.type === inline.type && isWrapper(only)) {
      children = normalizeInlines(only.children)
      only = children.length === 1 ? children[0] : null
    }
    const node = children.length > 0 ? withChildren(inline, children) : null
    if (!node) continue
    const last = out[out.length - 1]
    // 只有同类型 wrapper 合并；两个 link 即使相邻也可能是不同的 href。
    if (isWrapper(node) && last && isWrapper(last) && last.type === node.type) {
      out[out.length - 1] = { type: node.type, children: normalizeInlines([...last.children, ...node.children]) }
    } else {
      out.push(node)
    }
  }
  return out
}

/** 去掉一个 run 两端可折叠的空白、空 wrapper 与贴边 hardBreak。 */
function trimEdge(inlines: readonly PasteInline[], edge: "start" | "end"): PasteInline[] {
  const list = [...inlines]
  while (list.length > 0) {
    const index = edge === "start" ? 0 : list.length - 1
    const node = list[index]
    if (node.type === "text") {
      const trimmed = edge === "start" ? node.value.replace(LEADING_SPACE, "") : node.value.replace(TRAILING_SPACE, "")
      if (trimmed !== "") {
        list[index] = { type: "text", value: trimmed }
        return list
      }
      list.splice(index, 1)
      continue
    }
    if (node.type === "hardBreak") {
      list.splice(index, 1)
      continue
    }
    if (node.type === "code" || node.type === "image") return list
    const children = trimEdge(node.children, edge)
    const rebuilt = children.length > 0 ? withChildren(node, children) : null
    if (!rebuilt) {
      list.splice(index, 1)
      continue
    }
    list[index] = rebuilt
    return list
  }
  return list
}

export function buildRun(run: readonly PasteInline[]): PasteInline[] {
  return normalizeInlines(trimEdge(trimEdge(normalizeInlines(run), "start"), "end"))
}

export function normalizePreformatted(value: string): string {
  const lf = value.replace(/\r\n?/g, "\n")
  return lf.endsWith("\n") ? lf.slice(0, -1) : lf
}

export function normalizeInlineCode(value: string): string {
  return collapseWhitespace(value.replace(/\r\n?/g, "\n")).replace(LEADING_SPACE, "").replace(TRAILING_SPACE, "")
}

// --- 强语义 CSS -------------------------------------------------------------

export interface StyleFacts { strong: boolean; emphasis: boolean; underline: boolean; strike: boolean; align: Align | null }

export interface StyleReading { readonly facts: StyleFacts; readonly droppedStyle: number }

function cssStyleOf(el: Element): CSSStyleDeclaration | null {
  const style = (el as Element & { readonly style?: CSSStyleDeclaration }).style
  return style && typeof style.getPropertyValue === "function" ? style : null
}

/**
 * 读三个强语义声明并统计其余被丢弃的声明。计数用原始 style 声明而不是
 * CSSOM 的 length：浏览器会把 `background` 展开成多条 longhand
 * （happy-dom 报 11 条），照 `length` 计数会跨引擎漂移。
 */
export function readStyleFacts(el: Element, consumeAlign: boolean): StyleReading {
  const facts: StyleFacts = { strong: false, emphasis: false, underline: false, strike: false, align: null }
  let droppedStyle = 0
  const style = cssStyleOf(el)
  if (style) {
    const weight = style.getPropertyValue("font-weight").trim().toLowerCase()
    if (weight === "bold" || weight === "bolder" || (/^\d+$/.test(weight) && Number(weight) >= 600)) facts.strong = true
    const fontStyle = style.getPropertyValue("font-style").trim().toLowerCase()
    if (fontStyle === "italic" || fontStyle === "oblique") facts.emphasis = true
    for (const property of ["text-decoration-line", "text-decoration"] as const) {
      for (const token of style.getPropertyValue(property).toLowerCase().split(DECORATION_TOKENS)) {
        if (token === "underline") facts.underline = true
        else if (token === "line-through") facts.strike = true
      }
    }
    const align = consumeAlign ? style.getPropertyValue("text-align").trim().toLowerCase() : ""
    if (align === "left" || align === "center" || align === "right") facts.align = align
  }
  const declared = el.getAttribute("style")?.matchAll(DECLARATION)
  if (declared) {
    for (const match of declared) {
      const name = match[1].toLowerCase()
      if (name === "font-weight" && facts.strong) continue
      if (name === "font-style" && facts.emphasis) continue
      if ((name === "text-decoration" || name === "text-decoration-line") && (facts.underline || facts.strike)) continue
      if (name === "text-align" && facts.align !== null) continue
      droppedStyle += 1
    }
  }
  return { facts, droppedStyle }
}

/** 标签自带语义在前，CSS 语义按固定顺序追加，保证嵌套顺序确定。 */
export function wrapperKinds(tag: string, facts: StyleFacts): WrapperType[] {
  const kinds: WrapperType[] = [...(TAG_WRAPPERS.get(tag) ?? [])]
  const add = (kind: WrapperType): void => {
    if (!kinds.includes(kind)) kinds.push(kind)
  }
  if (facts.strong) add("strong")
  if (facts.emphasis) add("emphasis")
  if (facts.underline) add("underline")
  if (facts.strike) add("strike")
  return kinds
}
