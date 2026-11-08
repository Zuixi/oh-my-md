import {
  StateEffect,
  StateField,
  type ChangeSpec,
  type EditorState,
  type TransactionSpec,
} from "@codemirror/state"
import { inVerbatim } from "../parse/verbatim"
import {
  containingNode,
  directChildren,
  inlineContainer,
  intersectingNode,
  intersectsVerbatim,
  mapSelection,
  partialInlineStructure,
} from "./semantics"

interface InlineRule {
  readonly node: string
  readonly markerNode: string
}

const BOLD: InlineRule = { node: "StrongEmphasis", markerNode: "EmphasisMark" }
const ITALIC: InlineRule = { node: "Emphasis", markerNode: "EmphasisMark" }
const STRIKETHROUGH: InlineRule = { node: "Strikethrough", markerNode: "StrikethroughMark" }
const INLINE_CODE: InlineRule = { node: "InlineCode", markerNode: "CodeMark" }
const UNDERLINE: InlineRule = { node: "Underline", markerNode: "UnderlineMark" }

interface InlineRange {
  readonly from: number
  readonly to: number
}

type InlineRuleId =
  | "bold"
  | "italic"
  | "strikethrough"
  | "inline-code"
  | "underline"

interface InlineMarkers {
  readonly open: string
  readonly close: string
}

interface InlinePlan {
  readonly rule: InlineRuleId
  readonly from: number
  readonly to: number
  readonly openMarker: string
  readonly closeMarker: string
  readonly active: boolean
}

const setInlinePlan = StateEffect.define<InlinePlan>()

export const inlinePlanState = StateField.define<InlinePlan | null>({
  create: () => null,
  update: (plan, transaction) => {
    let replacement: InlinePlan | null = null
    for (const effect of transaction.effects) {
      if (effect.is(setInlinePlan)) {
        replacement = {
          ...effect.value,
          from: transaction.changes.mapPos(effect.value.from, 1),
          to: transaction.changes.mapPos(effect.value.to, -1),
        }
      }
    }
    if (replacement) return replacement
    return transaction.docChanged ? null : plan
  },
})

function rangeOfWord(state: EditorState, pos: number): InlineRange | null {
  const { from, to } = state.selection.main
  if (from !== to) return { from, to }
  const word = state.wordAt(pos)
  return word ? { from: word.from, to: word.to } : null
}

function safeInlineRange(state: EditorState, from: number, to: number): boolean {
  const container = inlineContainer(state, from, to)
  if (!container || container.from > from || container.to < to) return false
  if (from === to ? inVerbatim(state, from)
    : inVerbatim(state, from)
      || inVerbatim(state, to - 1)
      || intersectsVerbatim(state, from, to)) return false
  if (partialInlineStructure(state, from, to)) return false
  return true
}

function unwrapInline(
  state: EditorState,
  rule: InlineRule,
): TransactionSpec | null {
  const { from, to } = state.selection.main
  // Unwrapping has a stronger, local proof than a fresh wrap: the available
  // syntax fragment already resolves the requested semantic node at the caret.
  // An edit can leave a fragment hole earlier in a large document, making
  // global contiguity false even though this exact node and both delimiters are
  // present. Requiring global coverage here caused the next immediate shortcut
  // to miss the node and fall through.
  const node = containingNode(state, from, to, name => name === rule.node)
  if (!node) return null
  const markers = directChildren(node, rule.markerNode)
  if (markers.length !== 2) return null
  if (!markers.every((marker, index) => isExpectedMarker(
    state,
    rule,
    marker,
    index === 0,
  ))) return null
  const changes: ChangeSpec[] = markers.map(marker => ({
    from: marker.from,
    to: marker.to,
    insert: "",
  }))
  return {
    changes,
    selection: mapSelection(state, changes, from, to),
    effects: setInlinePlan.of({
      rule: ruleId(rule),
      from: markers[0].to,
      to: markers[1].from,
      openMarker: state.sliceDoc(markers[0].from, markers[0].to),
      closeMarker: state.sliceDoc(markers[1].from, markers[1].to),
      active: false,
    }),
  }
}

function isExpectedMarker(
  state: EditorState,
  rule: InlineRule,
  marker: { from: number; to: number },
  isOpening: boolean,
): boolean {
  const text = state.sliceDoc(marker.from, marker.to)
  if (rule === BOLD) return text === "**" || text === "__"
  if (rule === ITALIC) return text === "*" || text === "_"
  if (rule === STRIKETHROUGH) return text === "~~"
  if (rule === UNDERLINE) {
    return isOpening ? /^<u\s*>$/i.test(text) : /^<\/u\s*>$/i.test(text)
  }
  return /^`+$/.test(text)
}

function ruleId(rule: InlineRule): InlineRuleId {
  if (rule === BOLD) return "bold"
  if (rule === ITALIC) return "italic"
  if (rule === STRIKETHROUGH) return "strikethrough"
  if (rule === UNDERLINE) return "underline"
  return "inline-code"
}

function selectionOwnsPlan(state: EditorState, plan: InlinePlan): boolean {
  const selection = state.selection.main
  return selection.empty
    ? selection.from >= plan.from && selection.from <= plan.to
    : selection.from <= plan.from && selection.to >= plan.to
}

function plannedInline(state: EditorState, rule: InlineRule): TransactionSpec | null {
  const plan = state.field(inlinePlanState, false)
  if (!plan || plan.rule !== ruleId(rule) || !selectionOwnsPlan(state, plan)) return null
  const { from, to } = state.selection.main
  if (plan.active) {
    const openingFrom = plan.from - plan.openMarker.length
    const closingTo = plan.to + plan.closeMarker.length
    if (openingFrom < 0 || closingTo > state.doc.length) return null
    if (state.sliceDoc(openingFrom, plan.from) !== plan.openMarker) return null
    if (state.sliceDoc(plan.to, closingTo) !== plan.closeMarker) return null
    const changes: ChangeSpec[] = [
      { from: openingFrom, to: plan.from, insert: "" },
      { from: plan.to, to: closingTo, insert: "" },
    ]
    return {
      changes,
      selection: mapSelection(state, changes, from, to),
      effects: setInlinePlan.of({ ...plan, active: false }),
    }
  }

  if (!canWrapInline(state, rule, plan)) return null
  const markers = markersFor(state, rule, plan)
  const changes: ChangeSpec[] = [
    { from: plan.from, insert: markers.open },
    { from: plan.to, insert: markers.close },
  ]
  const selection = from === to
    ? { anchor: plan.from + markers.open.length + (from - plan.from) }
    : {
        anchor: plan.from + markers.open.length,
        head: plan.to + markers.open.length,
      }
  return {
    changes,
    selection,
    effects: setInlinePlan.of({
      ...plan,
      openMarker: markers.open,
      closeMarker: markers.close,
      active: true,
    }),
  }
}

function markersFor(
  state: EditorState,
  rule: InlineRule,
  range: InlineRange,
): InlineMarkers {
  if (rule === BOLD) return { open: "**", close: "**" }
  if (rule === ITALIC) return { open: "*", close: "*" }
  if (rule === STRIKETHROUGH) return { open: "~~", close: "~~" }
  if (rule === UNDERLINE) return { open: "<u>", close: "</u>" }
  const content = state.sliceDoc(range.from, range.to)
  let longestRun = 0
  for (const match of content.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length)
  const marker = "`".repeat(longestRun + 1)
  return { open: marker, close: marker }
}

const PUNCTUATION = /[\p{P}\p{S}]/u

function isWhitespace(char: string): boolean {
  return char === "" || /\s/.test(char)
}

function isPunctuation(char: string): boolean {
  return PUNCTUATION.test(char)
}

function adjacentChars(state: EditorState, range: InlineRange): {
  readonly before: string
  readonly after: string
  readonly first: string
  readonly last: string
} {
  return {
    before: range.from > 0 ? state.sliceDoc(range.from - 1, range.from) : "",
    after: range.to < state.doc.length ? state.sliceDoc(range.to, range.to + 1) : "",
    first: state.sliceDoc(range.from, range.from + 1),
    last: range.to > range.from ? state.sliceDoc(range.to - 1, range.to) : "",
  }
}

/**
 * Wrapping is only reversible when the result can become the target syntax.
 * CommonMark decides whether a delimiter run can open or close from the
 * characters around it, not from a word-character whitelist. Reuse that
 * flanking rule here so punctuation and emoji that produce a real target node
 * remain wrappable. Also refuse any boundary where the generated run would
 * merge with a same-character delimiter outside the selected content; the
 * resulting longer run is not the node this command is supposed to create.
 */
function canWrapInline(state: EditorState, rule: InlineRule, range: InlineRange): boolean {
  const text = state.sliceDoc(range.from, range.to)
  if (text.length === 0) return false
  const { before, after, first, last } = adjacentChars(state, range)
  if (rule === UNDERLINE) return true
  if (rule === INLINE_CODE) {
    // A code span with no visible content is easy to create but awkward to
    // discover or remove with the same shortcut. A boundary backtick would
    // turn the generated opening/closing run into a longer code delimiter.
    if (text.trim() === "") return false
    if (before === "`" || after === "`" || first === "`" || last === "`") return false
    return true
  }

  const marker = markersFor(state, rule, range).open
  const markerChar = marker[0]
  if (first === markerChar || last === markerChar) return false
  if (before === markerChar || after === markerChar) return false

  const openingBefore = before
  const openingAfter = first
  const closingBefore = last
  const closingAfter = after
  const openingPBefore = isPunctuation(openingBefore)
  const openingPAfter = isPunctuation(openingAfter)
  const openingSBefore = isWhitespace(openingBefore)
  const openingSAfter = isWhitespace(openingAfter)
  const closingPBefore = isPunctuation(closingBefore)
  const closingPAfter = isPunctuation(closingAfter)
  const closingSBefore = isWhitespace(closingBefore)
  const closingSAfter = isWhitespace(closingAfter)
  const openingCanOpen = !openingSAfter
    && (!openingPAfter || openingSBefore || openingPBefore)
  const closingCanClose = !closingSBefore
    && (!closingPBefore || closingSAfter || closingPAfter)
  return openingCanOpen && closingCanClose
}

function wrapInline(
  state: EditorState,
  rule: InlineRule,
): TransactionSpec | null {
  const { from, to } = state.selection.main
  const targetNode = intersectingNode(state, from, to, name => name === rule.node)
  // A selection that contains a target node is not the same operation as
  // toggling that node: wrapping it again would create two semantic copies.
  if (targetNode) return null

  const range = rangeOfWord(state, from)
  if (!range) return null

  if (rule !== INLINE_CODE) {
    const stacked = stackInline(state, rule, range.from, range.to)
    if (stacked) return stacked
  }

  if (!safeInlineRange(state, range.from, range.to)) return null
  if (!canWrapInline(state, rule, range)) return null

  const markers = markersFor(state, rule, range)
  const changes: ChangeSpec[] = [
    { from: range.from, insert: markers.open },
    { from: range.to, insert: markers.close },
  ]
  const selection = from === to
    ? { anchor: range.from + markers.open.length + (from - range.from) }
    : {
        anchor: range.from + markers.open.length,
        head: range.to + markers.open.length,
      }
  return {
    changes,
    // A collapsed caret at the word end must stay before the closing marker.
    // Mapping with the default right bias would place it outside the new node,
    // so the next press could no longer resolve the semantic toggle.
    selection,
    effects: setInlinePlan.of({
      rule: ruleId(rule),
      from: range.from,
      to: range.to,
      openMarker: markers.open,
      closeMarker: markers.close,
      active: true,
    }),
  }
}

const INLINE_RULES: readonly InlineRule[] = [
  BOLD,
  ITALIC,
  STRIKETHROUGH,
  INLINE_CODE,
  UNDERLINE,
]

function inlineRuleForNode(name: string): InlineRule | null {
  return INLINE_RULES.find(rule => rule.node === name) ?? null
}

function stackInline(
  state: EditorState,
  rule: InlineRule,
  from: number,
  to: number,
): TransactionSpec | null {
  // A resolved inline node is a stronger proof than fresh-marker flanking.
  // Wrap that whole node so a different dimension composes semantically instead
  // of inserting its marker into verbatim code content or delimiter runs.
  const existing = containingNode(state, from, to, name => inlineRuleForNode(name) !== null)
  if (!existing) return null
  const existingRule = inlineRuleForNode(existing.name)
  if (!existingRule || existingRule === rule) return null

  const markers = directChildren(existing, existingRule.markerNode)
  if (markers.length !== 2) return null
  if (!markers.every((marker, index) => isExpectedMarker(
    state,
    existingRule,
    marker,
    index === 0,
  ))) return null

  const contentFrom = markers[0].to
  const contentTo = markers[1].from
  const coversWholeNode = from <= existing.from && to >= existing.to
  const coversWholeContent = from === contentFrom && to === contentTo
  if (!coversWholeNode && !coversWholeContent) return null

  const markersForRule = markersFor(state, rule, { from, to })
  // HTML hosts can contain rich inline children, so a selection covering their
  // content nests the new mark inside. Other inline marks compose outward to
  // preserve delimiter-run semantics (for example `**_text_**`, not `_**text**_`).
  const wrapInside = existingRule === UNDERLINE && coversWholeContent
  const openingFrom = wrapInside ? contentFrom : existing.from
  const closingTo = wrapInside ? contentTo : existing.to
  const changes: ChangeSpec[] = [
    { from: openingFrom, insert: markersForRule.open },
    { from: closingTo, insert: markersForRule.close },
  ]
  return {
    changes,
    selection: mapSelection(state, changes, from, to),
    effects: setInlinePlan.of({
      rule: ruleId(rule),
      from: wrapInside ? contentFrom : existing.from,
      to: wrapInside ? contentTo : existing.to,
      openMarker: markersForRule.open,
      closeMarker: markersForRule.close,
      active: true,
    }),
  }
}

function toggleInline(state: EditorState, rule: InlineRule): TransactionSpec | null {
  return unwrapInline(state, rule)
    ?? wrapInline(state, rule)
    ?? plannedInline(state, rule)
}

export function toggleBoldSpec(state: EditorState): TransactionSpec | null {
  return toggleInline(state, BOLD)
}

export function toggleItalicSpec(state: EditorState): TransactionSpec | null {
  return toggleInline(state, ITALIC)
}

export function toggleStrikethroughSpec(state: EditorState): TransactionSpec | null {
  return toggleInline(state, STRIKETHROUGH)
}

export function toggleUnderlineSpec(state: EditorState): TransactionSpec | null {
  return toggleInline(state, UNDERLINE)
}

export function toggleInlineCodeSpec(state: EditorState): TransactionSpec | null {
  return toggleInline(state, INLINE_CODE)
}
