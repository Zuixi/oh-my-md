import { RegExpCursor, SearchCursor } from "@codemirror/search"
import { ChangeSet, Text } from "@codemirror/state"
import type { ChangeSpec, EditorState, TransactionSpec } from "@codemirror/state"

export interface SearchRequest {
  readonly query: string
  readonly caseSensitive: boolean
  readonly regexp: boolean
  readonly wholeWord: boolean
  readonly revision: number
}

export interface SearchMatch {
  readonly from: number
  readonly to: number
  readonly revision: number
}

export interface MatchCursor {
  next(): SearchMatch | null
}

export const PREVIOUS_SEARCH_INITIAL_WINDOW_CHARS = 256 * 1024

const VIEWPORT_MATCH_LIMIT = 1000
const MAX_POSITION = Number.MAX_SAFE_INTEGER

type AnyCursor = SearchCursor | RegExpCursor

function clampPosition(value: number, limit: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(0, Math.trunc(value)), limit)
}

function doubleWidth(width: number): number {
  return width >= MAX_POSITION / 2 ? MAX_POSITION : width * 2
}

function openCursor(
  doc: Text,
  request: SearchRequest,
  from: number,
  to: number,
): AnyCursor | null {
  if (request.query === "" || to <= from) return null
  if (request.regexp) {
    try {
      return new RegExpCursor(doc, request.query, { ignoreCase: !request.caseSensitive }, from, to)
    } catch {
      return null
    }
  }
  const normalize = request.caseSensitive ? undefined : (text: string) => text.toLowerCase()
  return new SearchCursor(doc, request.query, from, to, normalize)
}

function wholeWordEdgesMatch(doc: Text, from: number, to: number, query: string): boolean {
  if (/^\w/.test(query) && from > 0 && /\w/.test(doc.sliceString(from - 1, from))) return false
  if (/\w$/.test(query) && to < doc.length && /\w/.test(doc.sliceString(to, to + 1))) return false
  return true
}

function advance(cursor: AnyCursor, doc: Text, request: SearchRequest): boolean {
  for (;;) {
    cursor.next()
    if (cursor.done) return false
    const { from, to } = cursor.value
    if (to <= from) continue
    if (request.wholeWord && !request.regexp && !wholeWordEdgesMatch(doc, from, to, request.query)) {
      continue
    }
    return true
  }
}

interface LocatedMatch {
  readonly from: number
  readonly to: number
  readonly groups: RegExpExecArray | null
}

function locateMatch(
  doc: Text,
  request: SearchRequest,
  from: number,
  to: number,
): LocatedMatch | null {
  const cursor = openCursor(
    doc,
    request,
    clampPosition(from, doc.length),
    clampPosition(to, doc.length),
  )
  if (!cursor || !advance(cursor, doc, request)) return null
  return {
    from: cursor.value.from,
    to: cursor.value.to,
    groups: "match" in cursor.value ? cursor.value.match : null,
  }
}

export function validateSearchRequest(request: SearchRequest): string | null {
  if (!request.regexp || request.query === "") return null
  try {
    new RegExp(request.query)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function createMatchCursor(
  doc: Text,
  request: SearchRequest,
  from: number,
  to: number,
): MatchCursor {
  const cursor = openCursor(
    doc,
    request,
    clampPosition(from, doc.length),
    clampPosition(to, doc.length),
  )
  return {
    next(): SearchMatch | null {
      if (!cursor) return null
      if (!advance(cursor, doc, request)) return null
      return { from: cursor.value.from, to: cursor.value.to, revision: request.revision }
    },
  }
}

function firstMatch(
  doc: Text,
  request: SearchRequest,
  from: number,
  to: number,
): SearchMatch | null {
  const located = locateMatch(doc, request, from, to)
  return located ? { from: located.from, to: located.to, revision: request.revision } : null
}

function lastMatch(
  doc: Text,
  request: SearchRequest,
  from: number,
  to: number,
): SearchMatch | null {
  const cursor = createMatchCursor(doc, request, from, to)
  let latest: SearchMatch | null = null
  for (;;) {
    const match = cursor.next()
    if (!match) return latest
    latest = match
  }
}

export function findNextMatch(
  doc: Text,
  request: SearchRequest,
  anchor: number,
): SearchMatch | null {
  const start = clampPosition(anchor, doc.length)
  const direct = firstMatch(doc, request, start, doc.length)
  if (direct || start === 0) return direct
  return firstMatch(doc, request, 0, start)
}

// 向左逐窗回溯的扫描：`edge` 是固定右边界，`limit` 是允许触达的最左位置。
// 字面量传非负的 overlap，每轮只扫「新暴露的左区间 + 右重叠」——左边界翻倍推进，
// 已扫过的整段不再重扫，只重扫 overlap 个字符以覆盖跨界匹配。overlap 可以为 0
// （单字符 query），此时窗口依然只覆盖新暴露的左区间。
// 正则传 null，退回累计窗口 [edge - reach, edge)：任意长度的正则没有有限重叠量可以
// 保证不漏匹配，只能每轮从左边界一路扫到 edge。
function scanBackward(
  doc: Text,
  request: SearchRequest,
  edge: number,
  limit: number,
  overlap: number | null,
): SearchMatch | null {
  let reach = PREVIOUS_SEARCH_INITIAL_WINDOW_CHARS
  let right = edge
  for (;;) {
    const from = Math.max(limit, edge - reach)
    const to = overlap === null ? edge : Math.min(edge, right + overlap)
    const match = lastMatch(doc, request, from, to)
    if (match) return match
    if (from === limit) return null
    right = from
    reach = doubleWidth(reach)
  }
}

// 重叠量必须按 SearchCursor 自己的归一化契约算（NFKD，非区分大小写时再 toLowerCase），
// 而不是原始 query.length：预组合 `é` 归一化后是 `e` + U+0301 两个码元，按 1 算的
// query.length - 1 = 0 会让跨窗口边界的分解式匹配被切掉。
export function literalOverlap(request: SearchRequest): number {
  const normalized = request.caseSensitive
    ? request.query.normalize("NFKD")
    : request.query.normalize("NFKD").toLowerCase()
  return Math.max(0, normalized.length - 1)
}

export function findPreviousMatch(
  doc: Text,
  request: SearchRequest,
  anchor: number,
): SearchMatch | null {
  const stop = clampPosition(anchor, doc.length)
  const overlap = request.regexp ? null : literalOverlap(request)
  const backward = scanBackward(doc, request, stop, 0, overlap)
  if (backward || doc.length <= stop) return backward
  return scanBackward(doc, request, doc.length, stop, overlap)
}

export function matchStillValid(doc: Text, request: SearchRequest, match: SearchMatch): boolean {
  if (match.revision !== request.revision) return false
  if (match.from < 0 || match.to > doc.length || match.to <= match.from) return false
  const current = createMatchCursor(doc, request, match.from, match.to).next()
  return current !== null && current.from === match.from && current.to === match.to
}

export function collectViewportMatches(
  doc: Text,
  request: SearchRequest,
  ranges: readonly { readonly from: number; readonly to: number }[],
  limit: number = VIEWPORT_MATCH_LIMIT,
): readonly SearchMatch[] {
  const cap = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : VIEWPORT_MATCH_LIMIT
  const matches: SearchMatch[] = []
  for (const range of ranges) {
    if (matches.length >= cap) break
    const cursor = createMatchCursor(doc, request, range.from, range.to)
    for (;;) {
      if (matches.length >= cap) return matches
      const match = cursor.next()
      if (!match) break
      matches.push(match)
    }
  }
  return matches
}

// 只认 $$ / $& / $1…$99。$`、$'、$<name> 一律保持字面量 —— 前缀/后缀替换会切片
// 整篇文档，replace-all 时每处替换都要重扫一遍，且与「保持源文本」相悖。
const REPLACEMENT_REFERENCE = /\$(?:\$|&|(\d{1,2}))/g

function captureValue(groups: RegExpExecArray, digits: string): string | null {
  const index = Number(digits)
  if (index === 0) return null
  if (index < groups.length) return groups[index] ?? ""
  if (digits.length < 2) return null
  const single = captureValue(groups, digits[0])
  return single === null ? null : single + digits[1]
}

function expandReplacement(groups: RegExpExecArray, replacement: string): string {
  return replacement.replace(REPLACEMENT_REFERENCE, (token: string, digits?: string) => {
    if (token === "$$") return "$"
    if (token === "$&") return groups[0]
    const value = digits === undefined ? null : captureValue(groups, digits)
    return value === null ? token : value
  })
}

function replacementText(
  request: SearchRequest,
  groups: RegExpExecArray | null,
  replacement: string,
): string {
  if (!request.regexp || !groups) return replacement
  return expandReplacement(groups, replacement)
}

export function replaceCurrentSpec(
  state: EditorState,
  request: SearchRequest,
  active: SearchMatch | null,
  replacement: string,
): TransactionSpec | null {
  const doc = state.doc
  const located = active && active.revision === request.revision
    ? locateMatch(doc, request, active.from, active.to)
    : null
  let target = located && active && located.from === active.from && located.to === active.to
    ? located
    : null
  if (!target) {
    const next = findNextMatch(doc, request, state.selection.main.head)
    if (!next) return null
    const fallback = locateMatch(doc, request, next.from, next.to)
    if (!fallback || fallback.from !== next.from || fallback.to !== next.to) return null
    target = fallback
  }
  const insert = replacementText(request, target.groups, replacement)
  return {
    changes: { from: target.from, to: target.to, insert },
    selection: { anchor: target.from, head: target.from + insert.length },
    scrollIntoView: true,
  }
}

export interface ReplaceAllResult {
  readonly changes: ChangeSet
  readonly replacements: number
  readonly revision: number
}

export function buildReplaceAll(
  doc: Text,
  request: SearchRequest,
  replacement: string,
): ReplaceAllResult | null {
  const cursor = openCursor(doc, request, 0, doc.length)
  if (!cursor) return null
  const changes: ChangeSpec[] = []
  while (advance(cursor, doc, request)) {
    const groups = "match" in cursor.value ? cursor.value.match : null
    changes.push({
      from: cursor.value.from,
      to: cursor.value.to,
      insert: replacementText(request, groups, replacement),
    })
  }
  if (changes.length === 0) return null
  return {
    changes: ChangeSet.of(changes, doc.length),
    replacements: changes.length,
    revision: request.revision,
  }
}
