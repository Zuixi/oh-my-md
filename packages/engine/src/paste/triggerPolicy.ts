/**
 * Smart Paste 的 Markdown 触发器策略（plan 02 Task 3）。
 *
 * serializer 发射 literal text 的唯一规则来源：`escapePasteText` 只回答
 * 「在这个已知输出位置，这段可见文本会不会被引擎 parser 读成语义」，它不解析
 * 任何 Markdown（不建树、不判断已有源码）。规则与 `parse/` 里注册的扩展逐条
 * 对应，drift test 枚举 `markdownLanguageSupport()` 的扩展并要求对应类别。
 *
 * 两个模式：
 * - `minimal`：只在真的会触发语义时转义（`access_token` 直通）；
 * - `strict`：转义全部 CommonMark 可转义 ASCII 标点（= 项目方言 opener），
 *   行首缩进/制表符改用实体编码，保证物理安全。
 */

import { resolveEmoji } from "../parse/emoji"

export type PasteTextContext =
  | "paragraph"
  | "lineStart"
  | "emphasis"
  | "linkLabel"
  | "linkDestination"
  | "tableCell"
  | "htmlText"
  | "htmlAttribute"

/** CommonMark 可转义 ASCII 标点；strict 模式对每个字符前置反斜杠。 */
const ESCAPABLE = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")

/** CommonMark 的空白：只有空格、制表、换行（NBSP 不是）。 */
const WHITESPACE = /[ \t\n\r]/
const PUNCT = /[\p{P}\p{S}]/u
/** 与 `parse/cjkUnderscore.ts` 同一组 CJK 脚本；flanking 时按标点算。 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const ENTITY = /&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g
const EMOJI_ALIAS = /:([a-z0-9_+-]+):/g
/** 强调家族 + 方言 delimiter：`emphasis` 上下文的边界需要额外隔离。 */
const DELIMITERS = new Set(["*", "_", "~", "^", "=", "`", "$"])
const TAG_START = /[A-Za-z/!?]/

/** escapePasteText 的唯一入口。 */
export function escapePasteText(
  value: string,
  context: PasteTextContext,
  mode: "minimal" | "strict",
): string {
  // destination / attribute 是专用编码，不是「可见文本」：两种模式一致。
  if (context === "linkDestination") return encodeDestination(value)
  if (context === "htmlAttribute") return encodeAttribute(value)
  return mode === "strict" ? strictText(value, context) : minimalText(value, context)
}

// ---------------------------------------------------------------- strict

function strictText(value: string, context: PasteTextContext): string {
  let out = ""
  for (const char of value) out += ESCAPABLE.has(char) ? "\\" + char : char
  out = protectIndentation(out)
  return context === "tableCell" ? out.replace(/\r\n|\r|\n/g, " ") : out
}

/**
 * 行首缩进/制表符会把文本变成 indented code，而空白没有反斜杠转义：
 * 用等值实体编码打断它（可见文本不变）。
 */
function protectIndentation(value: string): string {
  let out = ""
  let start = 0
  for (;;) {
    const newline = value.indexOf("\n", start)
    const end = newline < 0 ? value.length : newline
    const line = value.slice(start, end)
    const run = /^[ \t]+/.exec(line)?.[0] ?? ""
    const ambiguous = run.includes("\t") || run.length >= 4
    out += ambiguous
      ? run.replace(/ /g, "&#32;").replace(/\t/g, "&#9;") + line.slice(run.length)
      : line
    if (newline < 0) return out
    out += "\n"
    start = newline + 1
  }
}

// ---------------------------------------------------------------- minimal

function minimalText(value: string, context: PasteTextContext): string {
  const marks = new Set<number>()
  markInlineTriggers(value, marks)
  if (context === "linkLabel") markAll(value, marks, "[]")
  if (context === "htmlText") markAll(value, marks, "<>")
  if (context === "emphasis") markBoundaryDelimiters(value, marks)
  if (context === "lineStart") markLineStarts(value, marks)
  const cell = context === "tableCell"
  let out = ""
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    // cell 源码是 GFM 行切分出的一段：字面反斜杠成对、管道逐个屏蔽。
    if (cell && char === "\\") { out += "\\\\"; continue }
    if (cell && char === "|") { out += "\\|"; continue }
    out += marks.has(i) ? "\\" + char : char
  }
  // 行首缩进/制表符没有反斜杠转义：用等值实体编码打断（可见文本不变）。
  if (context === "lineStart") out = protectIndentation(out)
  return cell ? out.replace(/\r\n|\r|\n/g, " ") : out
}

function markAll(value: string, marks: Set<number>, chars: string): void {
  for (let i = 0; i < value.length; i++) if (chars.includes(value[i])) marks.add(i)
}

/** emphasis 内部：与父 marker 相邻的 delimiter 必须隔离，否则会合并。 */
function markBoundaryDelimiters(value: string, marks: Set<number>): void {
  const last = value.length - 1
  if (last < 0) return
  if (DELIMITERS.has(value[0])) marks.add(0)
  if (DELIMITERS.has(value[last])) marks.add(last)
}

function markInlineTriggers(value: string, marks: Set<number>): void {
  // 行内代码：任何反引号都可能开启 code span。
  markAll(value, marks, "`")
  const points = codePoints(value)
  markEmphasisRuns(points, marks)
  // 每个方言 opener 只认自己合法的宽度：`$$` 不是 InlineMath，`===` 不是
  // highlight，`^^` 不是 superscript，`~~`/`~` 分别是 strike/subscript。
  markPairedRuns(points, marks, "$", width => width === 1)
  markPairedRuns(points, marks, "~", () => true)
  markPairedRuns(points, marks, "^", width => width === 1)
  markPairedRuns(points, marks, "=", width => width === 2)
  markBrackets(value, marks)
  markAngles(value, marks)
  markEntities(value, marks)
  markEmoji(value, marks)
  markBareAutolinks(value, marks)
}

// 与 `parse/autolink.ts` 的 URL_PATTERN / EMAIL_PATTERN 同形：裸 autolink 由一个
// 不可转义的字符开启，所以转义它内部的一个可转义字符就足以打断（可见文本不变）。
const BARE_URL = /(?:^|[^A-Za-z0-9_])(?:https?|ftp)(:)\/\//gi
const BARE_WWW = /(?:^|[^A-Za-z0-9_])www(\.)/gi
const BARE_EMAIL = /[A-Za-z0-9._%+-]+(@)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

function markBareAutolinks(value: string, marks: Set<number>): void {
  for (const match of value.matchAll(BARE_URL)) marks.add(match.index + match[0].length - 3)
  for (const match of value.matchAll(BARE_WWW)) marks.add(match.index + match[0].length - 1)
  for (const match of value.matchAll(BARE_EMAIL)) marks.add(match.index + match[0].indexOf("@"))
}

/** 代码点视图：astral 字符（emoji 等）必须是**一个**邻居，不能按代理项算。 */
interface Points {
  readonly chars: readonly string[]
  /** 每个代码点的代码单元起点，用于把 marks 写回原字符串下标。 */
  readonly offsets: readonly number[]
  readonly length: number
}

function codePoints(value: string): Points {
  const chars: string[] = []
  const offsets: number[] = []
  let offset = 0
  for (const char of value) {
    chars.push(char)
    offsets.push(offset)
    offset += char.length
  }
  return { chars, offsets, length: offset }
}

function isSpace(char: string): boolean {
  return char === "" || WHITESPACE.test(char)
}

function isPunct(char: string): boolean {
  return char !== "" && PUNCT.test(char)
}

function isPunctOrCjk(char: string): boolean {
  return isPunct(char) || (char !== "" && CJK.test(char))
}

/**
 * `*` / `_` 的 CommonMark flanking：能开或能关的 run 都会产生语义，整段转义。
 * `_` 额外按 `parse/cjkUnderscore.ts` 处理 CJK 邻接（那里 CJK 算标点）。
 */
function markEmphasisRuns(points: Points, marks: Set<number>): void {
  const { chars } = points
  for (let index = 0; index < chars.length;) {
    const char = chars[index]
    if (char !== "*" && char !== "_") { index++; continue }
    let end = index
    while (chars[end] === char) end++
    const before = index > 0 ? chars[index - 1] : ""
    const after = end < chars.length ? chars[end] : ""
    if (emphasisActive(char, before, after)) {
      markPoints(points, marks, index, end)
    }
    index = end
  }
}

function markPoints(points: Points, marks: Set<number>, from: number, to: number): void {
  for (let index = from; index < to; index++) {
    const offset = points.offsets[index]
    for (let k = 0; k < points.chars[index].length; k++) marks.add(offset + k)
  }
}

function emphasisActive(char: string, before: string, after: string): boolean {
  const spaceBefore = isSpace(before)
  const spaceAfter = isSpace(after)
  const punct = char === "_" ? isPunctOrCjk : isPunct
  const punctBefore = !spaceBefore && punct(before)
  const punctAfter = !spaceAfter && punct(after)
  const left = !spaceAfter && (!punctAfter || spaceBefore || punctBefore)
  const right = !spaceBefore && (!punctBefore || spaceAfter || punctAfter)
  if (char === "*") return left || right
  if (left && (!right || punctBefore)) return true
  if (right && (!left || punctAfter)) return true
  // CJK 邻接的 `_` 由 cjkUnderscore 的扩展规则判定，保守转义。
  return cjkAdjacent(before) || cjkAdjacent(after)
}

function cjkAdjacent(char: string): boolean {
  return char !== "" && CJK.test(char)
}

interface DelimiterRun {
  readonly start: number
  readonly end: number
  readonly opens: boolean
  readonly closes: boolean
}

/**
 * `$` / `~` / `^` / `=` 的 opener-closer 配对：只有同一行里真的能配成一对时
 * 才转义（`$x$` 转义，`$5` 直通）。`acceptsWidth` 是各 parser 的 opener 门槛：
 * `$$` 不是 InlineMath、`^^` 不是 superscript、`===` 不是 highlight。
 */
function markPairedRuns(
  points: Points,
  marks: Set<number>,
  char: string,
  acceptsWidth: (width: number) => boolean,
): void {
  const { chars } = points
  const runs: DelimiterRun[] = []
  for (let index = 0; index < chars.length;) {
    if (chars[index] !== char) { index++; continue }
    let end = index
    while (chars[end] === char) end++
    const before = index > 0 ? chars[index - 1] : ""
    const after = end < chars.length ? chars[end] : ""
    const width = end - index
    const sizeOk = acceptsWidth(width)
    runs.push({
      start: index,
      end,
      opens: sizeOk && !isSpace(after) && after !== char,
      closes: sizeOk && !isSpace(before) && before !== char,
    })
    index = end
  }
  for (let k = 0; k < runs.length; k++) {
    if (!runs[k].opens) continue
    for (let m = k + 1; m < runs.length; m++) {
      if (!runs[m].closes) continue
      const between = chars.slice(runs[k].end, runs[m].start)
      if (between.includes("\n")) break
      markPoints(points, marks, runs[k].start, runs[k].end)
      markPoints(points, marks, runs[m].start, runs[m].end)
      k = m
      break
    }
  }
}

/** `[x](y)` / `[x][y]` / `[^n]` / 引用定义都能从 `[` 开始；落单的 `[` 不用管。 */
function markBrackets(value: string, marks: Set<number>): void {
  if (!value.includes("]")) return
  markAll(value, marks, "[")
}

/** `<tag>` / `</tag>` / `<!--` / `<https://…>` 都靠 `<` 开启，`>` 单独无义。 */
function markAngles(value: string, marks: Set<number>): void {
  for (let i = 0; i < value.length - 1; i++) {
    if (value[i] === "<" && TAG_START.test(value[i + 1])) marks.add(i)
  }
}

function markEntities(value: string, marks: Set<number>): void {
  for (const match of value.matchAll(ENTITY)) {
    if (match.index !== undefined) marks.add(match.index)
  }
}

function markEmoji(value: string, marks: Set<number>): void {
  for (const match of value.matchAll(EMOJI_ALIAS)) {
    if (match.index === undefined) continue
    if (resolveEmoji(match[1])) marks.add(match.index)
  }
}

/** 物理行首可能开启的块级结构（只转义打断它所需的最小字符）。 */
function markLineStarts(value: string, marks: Set<number>): void {
  let start = 0
  for (;;) {
    const newline = value.indexOf("\n", start)
    const end = newline < 0 ? value.length : newline
    markBlockTrigger(value.slice(start, end), start, marks)
    if (newline < 0) return
    start = newline + 1
  }
}

function markBlockTrigger(line: string, offset: number, marks: Set<number>): void {
  // CommonMark 允许 0–3 列缩进；缩进之外的注释与 `parse/*` 的块规则对应。
  const indent = /^ {0,3}/.exec(line)?.[0].length ?? 0
  const body = line.slice(indent)
  const at = (index: number) => { marks.add(offset + indent + index) }
  const leadingHashes = /^#{1,6}(?:[ \t]|$)/.exec(body)?.[0].length ?? 0
  if (leadingHashes > 0) {
    for (let i = 0; i < leadingHashes && body[i] === "#"; i++) at(i)
    return
  }
  const ordered = /^\d{1,9}([.)])(?:[ \t]|$)/.exec(body)
  if (ordered) { at(ordered[0].length - ordered[1].length - 1); return }
  if (/^>[ \t]?/.test(body) || /^[-+*](?:[ \t]|$)/.test(body)) { at(0); return }
  if (/^[-*_]{3,}[ \t]*$/.test(body)) { at(0); return }
  if (/^=+[ \t]*$/.test(body)) { at(0); return }
  if (body.startsWith("|") || body.startsWith("$$")) { at(0); return }
  if (/^(?:`{3,}|~{3,})/.test(body)) { at(0); return }
  if (/^\[[ xX]\][ \t]/.test(body)) at(0)
}

// ------------------------------------------------- destination / attribute

const RAW_DESTINATION = /^[^\s()<>\\]*$/
const ANGLE_HOSTILE = /[<>\r\n]/
const UNSAFE_DESTINATION = /[\s<>()]/g
const PERCENT: Readonly<Record<string, string>> = {
  " ": "%20", "\t": "%09", "\n": "%0A", "\r": "%0D",
  "<": "%3C", ">": "%3E", "(": "%28", ")": "%29",
}

/**
 * link destination 专用编码：能原样就原样；含空白/括号/反斜杠时用 CommonMark
 * 的 `<…>` 形式保住字节（Windows 路径、带空格的文件名）；`<`/`>` 也无法承载时
 * 才 percent-encode。反斜杠转义在 `semantic/inlineText.ts::destinationOf` 里不会
 * 被解码，所以这里从不靠反斜杠转义 destination。
 */
function encodeDestination(value: string): string {
  if (RAW_DESTINATION.test(value)) return value
  if (!ANGLE_HOSTILE.test(value)) return `<${value}>`
  return value.replace(UNSAFE_DESTINATION, char => PERCENT[char] ?? char)
}

/** HTML attribute 专用编码：entity 化，绝不让值跳出引号。 */
function encodeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n|\r|\n/g, "&#10;")
}
