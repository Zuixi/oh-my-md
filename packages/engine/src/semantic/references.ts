import {
  type EditorState,
  type Extension,
  StateField,
  type Transaction,
} from "@codemirror/state"
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language"
import type { Parser, SyntaxNode, Tree } from "@lezer/common"
import { markdownLanguageSupport } from "../parse/markdown"

/** The bounded text reader a semantic accessor is given. */
export interface MarkdownSlice {
  sliceString(from: number, to: number): string
}

/**
 * Read-only Markdown view for link/image semantics: text slices plus one
 * normalized-label reference lookup. Never a second AST — the resolver only
 * holds definition facts (`label → href/title`).
 */
export interface MarkdownReferenceContext extends MarkdownSlice {
  resolveReference(label: string): { readonly href: string; readonly title: string | null } | null
}

interface ReferenceTarget {
  readonly href: string
  readonly title: string | null
}

type ReferenceResolver = (label: string) => ReferenceTarget | null

interface Range {
  readonly from: number
  readonly to: number
}

/** One `[label]: destination "title"` definition, kept as ranges + facts. */
interface DefinitionFact extends Range, ReferenceTarget {
  readonly label: string
}

interface ReferenceIndex {
  readonly defs: readonly DefinitionFact[]
  /** Document intervals already scanned for definitions; sorted, disjoint. */
  readonly scanned: readonly Range[]
  readonly targets: ReadonlyMap<string, ReferenceTarget>
  readonly resolve: ReferenceResolver
}

/**
 * Test/diagnostic counter: how many top-level blocks the index has scanned.
 * A concrete change/edit must not rescan the whole document, and a tree that
 * merely advances must only add the newly covered blocks.
 */
export const referenceIndexScanStats = {
  scannedBlocks: 0,
  reset() {
    this.scannedBlocks = 0
  },
}

type SliceFn = (from: number, to: number) => string

// CommonMark label normalization: strip the surrounding brackets a LinkLabel
// slice carries, trim, collapse internal whitespace, case-fold.
function normalizeLabel(raw: string): string {
  let label = raw.trim()
  if (label.startsWith("[") && label.endsWith("]")) label = label.slice(1, -1)
  return label.trim().replace(/\s+/g, " ").toLowerCase()
}

function destinationOf(raw: string): string {
  const text = raw.trim()
  return text.length >= 2 && text.startsWith("<") && text.endsWith(">") ? text.slice(1, -1) : text
}

function titleOf(node: SyntaxNode, slice: SliceFn): string | null {
  const title = node.getChild("LinkTitle")
  if (!title) return null
  const raw = slice(title.from, title.to).trim()
  if (raw.length < 2) return raw || null
  const open = raw[0]
  const close = open === "(" ? ")" : open
  if ((open === '"' || open === "'" || open === "(") && raw.endsWith(close)) return raw.slice(1, -1)
  return raw
}

/**
 * The extent we may read without forcing the parser: the committed tree is a
 * prefix of the document, and pulling the parser forward here would make every
 * keystroke pay for the rest of the document.
 */
function treeExtent(state: EditorState): number {
  return Math.min(syntaxTree(state).length, state.doc.length)
}

/**
 * Expand a missing interval to the top-level blocks that overlap it, so a
 * rescan always re-reads whole definition blocks instead of half of one.
 */
function blockRange(tree: Tree, gap: Range): Range | null {
  const cursor = tree.cursor()
  if (!cursor.childAfter(gap.from)) return null
  const from = cursor.from
  let to = cursor.to
  while (to < gap.to && cursor.nextSibling()) to = cursor.to
  return { from, to }
}

function collectDefinitions(tree: Tree, range: Range, slice: SliceFn): DefinitionFact[] {
  const out: DefinitionFact[] = []
  if (range.to <= range.from) return out
  tree.iterate({
    from: range.from,
    to: range.to,
    enter(node) {
      if (node.node.parent?.name === "Document") referenceIndexScanStats.scannedBlocks++
      if (node.name !== "LinkReference") return
      const label = node.node.getChild("LinkLabel")
      const url = node.node.getChild("URL")
      if (!label || !url) return false
      const key = normalizeLabel(slice(label.from, label.to))
      if (!key) return false
      out.push({
        from: node.from,
        to: node.to,
        label: key,
        href: destinationOf(slice(url.from, url.to)),
        title: titleOf(node.node, slice),
      })
      return false
    },
  })
  return out
}

/** Sorted, merged, clamped to `[0, extent)`. */
function normalizeRanges(ranges: readonly Range[], extent: number): Range[] {
  const clamped = ranges
    .map(range => ({ from: Math.max(0, Math.min(range.from, extent)), to: Math.min(range.to, extent) }))
    .filter(range => range.to > range.from)
    .sort((a, b) => a.from - b.from)
  const merged: Range[] = []
  for (const range of clamped) {
    const last = merged[merged.length - 1]
    if (last && range.from <= last.to) merged[merged.length - 1] = { from: last.from, to: Math.max(last.to, range.to) }
    else merged.push(range)
  }
  return merged
}

function gapsBetween(scanned: readonly Range[], extent: number): Range[] {
  const gaps: Range[] = []
  let pos = 0
  for (const range of scanned) {
    if (range.from > pos) gaps.push({ from: pos, to: range.from })
    pos = Math.max(pos, range.to)
    if (pos >= extent) return gaps
  }
  if (pos < extent) gaps.push({ from: pos, to: extent })
  return gaps
}

function subtractRanges(ranges: readonly Range[], holes: readonly Range[]): Range[] {
  let out = [...ranges]
  for (const hole of holes) {
    const next: Range[] = []
    for (const range of out) {
      if (hole.to <= range.from || hole.from >= range.to) next.push(range)
      else {
        if (hole.from > range.from) next.push({ from: range.from, to: hole.from })
        if (hole.to < range.to) next.push({ from: hole.to, to: range.to })
      }
    }
    out = next
  }
  return out
}

function buildTargets(defs: readonly DefinitionFact[]): Map<string, ReferenceTarget> {
  const targets = new Map<string, ReferenceTarget>()
  // `defs` is document-ordered, so the first definition of a label wins.
  for (const def of defs) {
    if (!targets.has(def.label)) targets.set(def.label, { href: def.href, title: def.title })
  }
  return targets
}

function sameTargets(
  a: ReadonlyMap<string, ReferenceTarget>,
  b: ReadonlyMap<string, ReferenceTarget>,
): boolean {
  if (a.size !== b.size) return false
  for (const [label, target] of a) {
    const other = b.get(label)
    if (!other || other.href !== target.href || other.title !== target.title) return false
  }
  return true
}

function makeResolver(targets: ReadonlyMap<string, ReferenceTarget>): ReferenceResolver {
  return label => {
    const key = normalizeLabel(label)
    return (key && targets.get(key)) || null
  }
}

function finishIndex(
  defs: readonly DefinitionFact[],
  scanned: readonly Range[],
  previous: ReferenceIndex | null,
): ReferenceIndex {
  const targets = buildTargets(defs)
  const resolve =
    previous && sameTargets(previous.targets, targets) ? previous.resolve : makeResolver(targets)
  return { defs, scanned, targets, resolve }
}

function scanGaps(
  state: EditorState,
  defs: readonly DefinitionFact[],
  scanned: readonly Range[],
  gaps: readonly Range[],
  previous: ReferenceIndex | null,
): ReferenceIndex {
  const tree = syntaxTree(state)
  const slice: SliceFn = (from, to) => state.doc.sliceString(from, to)
  const nextDefs = [...defs]
  const covered = [...scanned]
  for (const gap of gaps) {
    const block = blockRange(tree, gap)
    if (block) {
      // A rescan owns its blocks: drop stale facts inside them before re-reading.
      for (let i = nextDefs.length - 1; i >= 0; i--) {
        const fact = nextDefs[i]
        if (fact.from < block.to && fact.to > block.from) nextDefs.splice(i, 1)
      }
      nextDefs.push(...collectDefinitions(tree, block, slice))
      covered.push(block)
    }
    // The whole gap counts as scanned, including blank lines and trailing
    // newlines no node covers — otherwise every later update rescans them.
    covered.push(gap)
  }
  nextDefs.sort((a, b) => a.from - b.from)
  return finishIndex(nextDefs, normalizeRanges(covered, treeExtent(state)), previous)
}

function createIndex(state: EditorState): ReferenceIndex {
  return scanGaps(state, [], [], gapsBetween([], treeExtent(state)), null)
}

function growIndex(tr: Transaction, value: ReferenceIndex): ReferenceIndex {
  // No language, or nothing committed yet — the tree cannot have grown.
  if (!syntaxTreeAvailable(tr.state, 0)) return value
  const extent = treeExtent(tr.state)
  const scanned = normalizeRanges(value.scanned, extent)
  const gaps = gapsBetween(scanned, extent)
  if (!gaps.length) return value
  return scanGaps(tr.state, value.defs, scanned, gaps, value)
}

function mapChangedIndex(tr: Transaction, value: ReferenceIndex): ReferenceIndex {
  const previous: Range[] = []
  const holes: Range[] = []
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    previous.push({ from: fromA, to: toA })
    // A pure deletion joins its neighbours, so the join point itself needs a
    // rescan (deleting a newline can turn two lines into one definition).
    holes.push(
      toB > fromB
        ? { from: fromB, to: toB }
        : {
            from: Math.max(0, fromB - 1),
            to: Math.min(tr.state.doc.length, fromB + 1),
          },
    )
  })
  const defs = value.defs
    .filter(fact => !previous.some(range => range.from <= fact.to && range.to >= fact.from))
    .map(fact => ({
      from: tr.changes.mapPos(fact.from, -1),
      to: tr.changes.mapPos(fact.to, 1),
      label: fact.label,
      href: fact.href,
      title: fact.title,
    }))
  const extent = treeExtent(tr.state)
  const scanned = normalizeRanges(
    subtractRanges(
      value.scanned.map(range => ({
        from: tr.changes.mapPos(range.from, -1),
        to: tr.changes.mapPos(range.to, 1),
      })),
      holes,
    ),
    extent,
  )
  return scanGaps(tr.state, defs, scanned, gapsBetween(scanned, extent), value)
}

const referenceIndexField = StateField.define<ReferenceIndex>({
  create: createIndex,
  update(value, tr) {
    return tr.docChanged ? mapChangedIndex(tr, value) : growIndex(tr, value)
  },
})

/**
 * Live-Preview reference index: one immutable definition index seeded from the
 * available tree, grown and patched incrementally. Mount it outside the
 * live/source compartment so toggling modes never re-seeds it.
 */
export const referenceIndexExtension: Extension = referenceIndexField

function contextFor(state: EditorState, resolve: ReferenceResolver): MarkdownReferenceContext {
  return {
    sliceString: (from, to) => state.doc.sliceString(from, to),
    resolveReference: resolve,
  }
}

/**
 * Live-Preview context. Uses the incremental index when the extension is
 * installed; standalone callers without it get a read-only snapshot instead.
 */
export function editorReferenceContext(state: EditorState): MarkdownReferenceContext {
  const index = state.field(referenceIndexField, false)
  return index ? contextFor(state, index.resolve) : snapshotReferenceContext(state)
}

const snapshotResolvers = new WeakMap<Tree, ReferenceResolver>()

/**
 * Read-only snapshot context for export and one-off queries. Definitions are
 * collected once per tree and reused, but slices always read the given state.
 */
export function snapshotReferenceContext(state: EditorState): MarkdownReferenceContext {
  const tree = syntaxTree(state)
  let resolve = snapshotResolvers.get(tree)
  if (!resolve) {
    const slice: SliceFn = (from, to) => state.doc.sliceString(from, to)
    const defs = collectDefinitions(tree, { from: 0, to: treeExtent(state) }, slice)
    resolve = makeResolver(buildTargets(defs))
    snapshotResolvers.set(tree, resolve)
  }
  return contextFor(state, resolve)
}

let fragmentParser: Parser | null = null

/**
 * Context for a standalone Markdown fragment (tests, pasted snippets): parsed
 * with the same Lezer Markdown configuration and bounded to the fragment.
 */
export function stringReferenceContext(source: string): MarkdownReferenceContext {
  fragmentParser ??= markdownLanguageSupport().language.parser
  const tree = fragmentParser.parse(source)
  const slice: SliceFn = (from, to) => source.slice(from, to)
  const defs = collectDefinitions(tree, { from: 0, to: source.length }, slice)
  return { sliceString: slice, resolveReference: makeResolver(buildTargets(defs)) }
}
