import type { ChangeSpec, EditorState, Line, TransactionSpec } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"
import { markRemovalRange, type BlockPrefixMark } from "./blockPrefix"
import { directChildren, lineSyntax, mapSelection, treeCovers, type LineSyntax } from "./semantics"

interface LineContext {
  readonly line: Line
  readonly syntax: LineSyntax
}

interface SelectionLines {
  readonly contexts: readonly LineContext[]
  readonly from: number
  readonly to: number
}

interface SingleChange {
  readonly from: number
  readonly to?: number
  readonly insert?: string
}

function selectionLines(state: EditorState): SelectionLines | null {
  const { from, to } = state.selection.main
  if (!treeCovers(state, from, to)) return null
  const start = state.doc.lineAt(from)
  const end = state.doc.lineAt(to)
  const contexts: LineContext[] = []
  for (let number = start.number; number <= end.number; number++) {
    const line = state.doc.line(number)
    const syntax = lineSyntax(state, line)
    if (!syntax || syntax.blocked || syntax.setext) return null
    contexts.push({ line, syntax })
  }
  return { contexts, from, to }
}

function isHorizontalSpace(char: string): boolean {
  return char === " " || char === "\t"
}

function headingContentStart(line: Line, mark: SyntaxNode): number {
  let pos = mark.to
  while (pos < line.to && isHorizontalSpace(line.text[pos - line.from])) pos++
  return pos
}

function trimSpaceBefore(line: Line, pos: number, lowerBound: number): number {
  let from = pos
  while (from > lowerBound && isHorizontalSpace(line.text[from - line.from - 1])) from--
  return from
}

function pushChange(changes: ChangeSpec[], state: EditorState, change: SingleChange): void {
  const current = state.sliceDoc(change.from, change.to ?? change.from)
  if (current === (change.insert ?? "")) return
  changes.push(change)
}

function headingMarks(node: SyntaxNode): { opening: SyntaxNode; closing: readonly SyntaxNode[] } | null {
  const marks = directChildren(node, "HeaderMark")
  if (marks.length === 0) return null
  return { opening: marks[0], closing: marks.slice(1) }
}

function headingChanges(
  state: EditorState,
  line: Line,
  node: SyntaxNode,
  marker: string | null,
  changes: ChangeSpec[],
): boolean {
  const marks = headingMarks(node)
  if (!marks) return false
  const contentStart = headingContentStart(line, marks.opening)
  pushChange(changes, state, {
    from: marks.opening.from,
    to: contentStart,
    insert: marker ?? "",
  })
  for (const closing of marks.closing) {
    if (closing.from < contentStart) return false
    pushChange(changes, state, {
      from: trimSpaceBefore(line, closing.from, contentStart),
      to: closing.to,
      insert: "",
    })
  }
  return true
}

export function toggleHeadingSpec(state: EditorState, level: number): TransactionSpec | null {
  const selected = selectionLines(state)
  if (!selected) return null
  const allTarget = selected.contexts.every(({ syntax }) =>
    syntax.heading !== null && syntax.headingLevel === level)
  const marker = "#".repeat(level) + " "
  const changes: ChangeSpec[] = []
  for (const { line, syntax } of selected.contexts) {
    if (syntax.heading) {
      if (!headingChanges(state, line, syntax.heading, allTarget ? null : marker, changes)) return null
    } else if (!allTarget) {
      pushChange(changes, state, {
        from: syntax.contentStart,
        insert: marker,
      })
    }
  }
  if (changes.length === 0) return null
  return {
    changes,
    selection: mapSelection(state, changes, selected.from, selected.to),
  }
}

export type ListKind = "ordered" | "unordered"

function listMark(syntax: LineSyntax): BlockPrefixMark | null {
  if (!syntax.prefix) return null
  for (let index = syntax.prefix.marks.length - 1; index >= 0; index--) {
    if (syntax.prefix.marks[index].kind === "list") return syntax.prefix.marks[index]
  }
  return null
}

function markText(state: EditorState, mark: BlockPrefixMark): string {
  return state.sliceDoc(mark.from, mark.markTo)
}

function listKind(state: EditorState, mark: BlockPrefixMark): ListKind | null {
  const text = markText(state, mark)
  if (/^\d+[.)]$/.test(text)) return "ordered"
  if (/^[-+*]$/.test(text)) return "unordered"
  return null
}

function orderedNumber(state: EditorState, mark: BlockPrefixMark): number | null {
  const value = Number.parseInt(markText(state, mark), 10)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function contextKinds(syntax: LineSyntax, mark: BlockPrefixMark | null): string[] {
  if (!syntax.prefix) return []
  const end = mark ? syntax.prefix.marks.indexOf(mark) : syntax.prefix.marks.length
  return syntax.prefix.marks.slice(0, end).map(item => item.kind)
}

function sameListContext(
  current: LineSyntax,
  currentMark: BlockPrefixMark | null,
  previous: LineSyntax,
  previousMark: BlockPrefixMark | null,
): boolean {
  const currentKinds = contextKinds(current, currentMark)
  const previousKinds = contextKinds(previous, previousMark)
  return currentKinds.length === previousKinds.length
    && currentKinds.every((kind, index) => kind === previousKinds[index])
}

function orderedStartNumber(state: EditorState, first: LineContext): number | null {
  const mark = listMark(first.syntax)
  if (mark && listKind(state, mark) === "ordered") return orderedNumber(state, mark)
  if (first.line.number <= 1) return 1
  const previousLine = state.doc.line(first.line.number - 1)
  const previous = lineSyntax(state, previousLine)
  if (!previous) return null
  if (previous.blocked || previous.setext) return 1
  const previousMark = listMark(previous)
  if (!previousMark || listKind(state, previousMark) !== "ordered") return 1
  if (!sameListContext(first.syntax, mark, previous, previousMark)) return 1
  const number = orderedNumber(state, previousMark)
  return number === null ? null : number + 1
}

function orderedMarker(
  state: EditorState,
  mark: BlockPrefixMark | null,
  number: number,
): string {
  const delimiter = mark && listKind(state, mark) === "ordered"
    ? markText(state, mark).slice(-1)
    : "."
  return `${number}${delimiter} `
}

export function toggleListSpec(state: EditorState, target: ListKind): TransactionSpec | null {
  const selected = selectionLines(state)
  if (!selected) return null
  const kinds = selected.contexts.map(({ syntax }) => {
    const mark = listMark(syntax)
    return mark ? listKind(state, mark) : null
  })
  const allTarget = kinds.every(kind => kind === target)
  const changes: ChangeSpec[] = []
  if (allTarget) {
    for (const { line, syntax } of selected.contexts) {
      const mark = listMark(syntax)
      if (!mark) return null
      const removal = markRemovalRange(mark, line)
      pushChange(changes, state, { ...removal, insert: "" })
    }
  } else if (target === "unordered") {
    for (const { line, syntax } of selected.contexts) {
      const mark = listMark(syntax)
      if (!mark) {
        pushChange(changes, state, { from: syntax.contentStart, insert: "- " })
      } else if (listKind(state, mark) === "ordered") {
        const removal = markRemovalRange(mark, line)
        pushChange(changes, state, { ...removal, insert: "- " })
      }
    }
  } else {
    let next = orderedStartNumber(state, selected.contexts[0])
    if (next === null) return null
    for (const { line, syntax } of selected.contexts) {
      const mark = listMark(syntax)
      const marker = orderedMarker(state, mark, next)
      if (mark) {
        const removal = markRemovalRange(mark, line)
        pushChange(changes, state, { ...removal, insert: marker })
      } else {
        pushChange(changes, state, { from: syntax.contentStart, insert: marker })
      }
      next += 1
    }
  }
  if (changes.length === 0) return null
  return {
    changes,
    selection: mapSelection(state, changes, selected.from, selected.to),
  }
}

function quoteMarkOf(syntax: LineSyntax, line: Line): { from: number; to: number } | null {
  if (!syntax.prefix) return null
  const quote = syntax.prefix.marks.find(mark => mark.kind === "quote")
  return quote ? markRemovalRange(quote, line) : null
}

export function toggleQuoteSpec(state: EditorState): TransactionSpec | null {
  const { from, to } = state.selection.main
  if (!treeCovers(state, from, to)) return null
  const start = state.doc.lineAt(from)
  const end = state.doc.lineAt(to)
  const contexts: { line: Line; mark: { from: number; to: number } | null }[] = []
  for (let number = start.number; number <= end.number; number++) {
    const line = state.doc.line(number)
    const syntax = lineSyntax(state, line)
    if (!syntax || syntax.blocked) return null
    contexts.push({ line, mark: quoteMarkOf(syntax, line) })
  }
  // All quoted -> remove one level from every line; otherwise quote every
  // still-unquoted line. Per-line inversion would turn a mixed selection into
  // its opposite instead of converging on one state.
  const unquote = contexts.every(context => context.mark !== null)
  const changes: ChangeSpec[] = []
  for (const { line, mark } of contexts) {
    if (unquote && mark) changes.push({ from: mark.from, to: mark.to, insert: "" })
    else if (!unquote && !mark) changes.push({ from: line.from, to: line.from, insert: "> " })
  }
  if (changes.length === 0) return null
  return {
    changes,
    selection: mapSelection(state, changes, from, to),
  }
}
