import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { type ChangeDesc, EditorState, StateEffect } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { forceParsing, syntaxTree } from "@codemirror/language"
import { editorExtensions } from "../src/index"
import { buildLiveDecorations, livePreviewField } from "../src/decorations/build"
import { ImageWidget } from "../src/decorations/widgets/image"
import { livePreviewExt } from "../src/modes/livePreview"
import { orderedRenumber } from "../src/lists/ordered"

function specKeys(state: EditorState) {
  return state.field(livePreviewField).specs
    .map(spec => `${spec.tag}:${spec.from}:${spec.to}`)
    .sort()
}

// Decoration keys from a full rebuild on the same state — the ground truth the
// incremental field should match after an update.
function freshKeys(state: EditorState) {
  return buildLiveDecorations(state).specs
    .map(spec => `${spec.tag}:${spec.from}:${spec.to}`)
    .sort()
}

// Count specs that truly changed between before and after, ignoring specs that
// merely shifted position due to a document change. When `changes` is provided
// (the edit's ChangeDesc), before-specs are mapped through it before comparing,
// so a spec that moved by the edit delta counts as unchanged. Without `changes`
// (selection-only updates), all positions are stable and the comparison is
// exact.
function changedSpecCount(before: EditorState, after: EditorState, changes?: ChangeDesc) {
  const prev = new Set(
    changes
      ? before.field(livePreviewField).specs
          .map(spec => {
            const from = changes.mapPos(spec.from, 1)
            const to = spec.from === spec.to
              ? from
              : changes.mapPos(spec.to, -1)
            return `${spec.tag}:${from}:${to}`
          })
      : specKeys(before),
  )
  const next = new Set(specKeys(after))
  let changed = 0
  for (const key of prev) if (!next.has(key)) changed++
  for (const key of next) if (!prev.has(key)) changed++
  return changed
}

function fixture(name: string) {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8")
}

function makeDocument(lines = 2000) {
  return Array.from({ length: lines }, (_, i) =>
    i % 100 === 0 ? `| h${i} |\n|---|\n| v${i} |` : `line ${i} with **bold** text`
  ).join("\n\n")
}

// Create an EditorState with a complete syntax tree. Without an EditorView,
// @codemirror/language's ParseWorker never schedules background parsing, so
// syntaxTree(state) returns whatever partial tree (near zero for large docs)
// was produced during EditorState.create. The livePreviewField StateField
// captures that partial treeLength at creation and only incrementally adds
// decorations for newly-parsed regions on update — so the field's specs
// diverge from a full rebuild under CPU load. By mounting a temporary view and
// calling forceParsing we get a complete tree; the tree survives view.destroy()
// so the detached state stays fully parsed.
function liveState(
  doc: string,
  selection?: { anchor: number },
  extensions = editorExtensions(),
): EditorState {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions,
      ...(selection ? { selection } : {}),
    }),
    parent,
  })
  forceParsing(view, doc.length, 10000)
  const state = view.state
  view.destroy()
  parent.remove()
  return state
}

describe("incremental live decorations", () => {
  it("rebuilds only syntax-safe regions for a selection move", () => {
    const doc = makeDocument()
    const state = liveState(doc)
    const next = state.update({ selection: { anchor: doc.indexOf("line 1501") } }).state
    expect(specKeys(next)).toEqual(freshKeys(next))
    expect(changedSpecCount(state, next)).toBeLessThan(specKeys(state).length / 10)
  })

  it("keeps a local edit local in a widget-dense document", () => {
    const doc = makeDocument()
    const state = liveState(doc)
    const editAt = doc.indexOf("line 1501") + "line 1501".length
    const tr = state.update({ changes: { from: editAt, insert: " edited" } })
    const next = tr.state
    expect(specKeys(next)).toEqual(freshKeys(next))
    expect(changedSpecCount(state, next, tr.changes)).toBeLessThan(specKeys(state).length / 10)
  })

  it("maps unaffected decorations and rebuilds the edited syntax block", () => {
    const doc = "start\n\n| a |\n|---|\n| 1 |\n\nend with **bold**"
    const state = liveState(doc, { anchor: doc.length })
    const next = state.update({ changes: { from: 0, insert: "prefix\n" } }).state
    const live = next.field(livePreviewField)
    const ranges: Array<[number, number]> = []
    live.deco.between(0, next.doc.length, (from, to) => { ranges.push([from, to]) })

    expect(ranges.some(([from]) => from === doc.indexOf("| a |") + "prefix\n".length)).toBe(true)
    expect(specKeys(next)).toEqual(freshKeys(next))
  })

  it("keeps nested quote marks after moving onto an empty quote line", () => {
    const doc = "> 最外层\n>\n> > 第一层嵌套\n>\n> > > 第二层嵌套\n\noutside"
    const emptyQuote = doc.indexOf("\n>\n> > >") + 1
    const nested = doc.indexOf("第二层嵌套")
    const state = liveState(doc, { anchor: doc.length })
    const next = state.update({ selection: { anchor: emptyQuote } }).state
    expect(specKeys(next)).toEqual(freshKeys(next))
    const nestedLine = next.doc.lineAt(nested)
    const marks = next.field(livePreviewField).specs
      .filter(spec => spec.tag === "replace:QuoteMark" && spec.from >= nestedLine.from && spec.to <= nestedLine.to)
    const depths = next.field(livePreviewField).specs
      .filter(spec => spec.tag.startsWith("line:omd-blockquote") && spec.from === nestedLine.from)
      .map(spec => spec.tag)
    expect(depths).toEqual(["line:omd-blockquote-3"])
    expect(marks).toHaveLength(3)
  })

  it("keeps quote depth after moving onto a blank line before a nested quote", () => {
    const doc = "最外层\n\n> 第一层嵌套\n>\n> > 第二层嵌套"
    const state = liveState(doc, { anchor: doc.length })
    const next = state.update({ selection: { anchor: doc.indexOf("\n\n>") + 1 } }).state
    expect(specKeys(next)).toEqual(freshKeys(next))
    const first = next.doc.lineAt(doc.indexOf("第一层嵌套"))
    const nested = next.doc.lineAt(doc.indexOf("第二层嵌套"))
    const depths = next.field(livePreviewField).specs
      .filter(spec => spec.tag.startsWith("line:omd-blockquote") &&
        (spec.from === first.from || spec.from === nested.from))
      .map(spec => spec.tag)
    expect(depths).toEqual(["line:omd-blockquote-1", "line:omd-blockquote-2"])
  })

  it("keeps the first nested quote after moving onto the leading empty quote line", () => {
    const doc = "> 最外层\n>\n> > 第一层嵌套\n>\n> > > 第二层嵌套\n\noutside"
    const emptyQuote = doc.indexOf("\n>\n> > ") + 1
    const nested = doc.indexOf("第一层嵌套")
    const state = liveState(doc, { anchor: doc.length })
    const next = state.update({ selection: { anchor: emptyQuote } }).state
    expect(specKeys(next)).toEqual(freshKeys(next))
    const nestedLine = next.doc.lineAt(nested)
    const depths = next.field(livePreviewField).specs
      .filter(spec => spec.tag.startsWith("line:omd-blockquote") && spec.from === nestedLine.from)
      .map(spec => spec.tag)
    expect(depths).toEqual(["line:omd-blockquote-2"])
  })

  it("does not duplicate enclosing block decorations during a local rebuild", () => {
    const doc = "> first\n> second\n> third\n\noutside"
    const state = liveState(doc, { anchor: doc.length })
    const next = state.update({ selection: { anchor: doc.indexOf("second") } }).state
    const specs = next.field(livePreviewField).specs
    const keys = specs.map(spec => `${spec.tag}:${spec.from}:${spec.to}`)

    expect(new Set(keys).size).toBe(keys.length)
  })

  it("matches a full rebuild when a fence edit changes following block parsing", () => {
    const doc = "```js\ncode\n```\n\n$$x$$\n\nafter"
    const state = liveState(doc, { anchor: 0 })
    const next = state.update({
      changes: { from: 0, insert: "x" },
      selection: { anchor: 1 },
    }).state
    const incremental = next.field(livePreviewField).specs
      .map(spec => `${spec.tag}:${spec.from}:${spec.to}`)
    const full = buildLiveDecorations(next).specs
      .map(spec => `${spec.tag}:${spec.from}:${spec.to}`)

    expect(incremental).toEqual(full)
  })

  it("refreshes resolver-dependent widgets after reconfiguration", () => {
    const doc = "![alt](pic.png)\n\noutside"
    const state = liveState(
      doc,
      { anchor: doc.length },
      editorExtensions({ resolveImageSrc: src => `/first/${src}` }),
    )
    const imageSrc = (current: EditorState) => {
      const spec = current.field(livePreviewField).specs
        .find(item => item.tag === "widget:image")
      return (spec?.deco.spec.widget as ImageWidget | undefined)?.resolvedSrc
    }
    expect(imageSrc(state)).toBe("/first/pic.png")

    const next = state.update({
      effects: StateEffect.reconfigure.of(editorExtensions({
        resolveImageSrc: src => `/second/${src}`,
      })),
    }).state
    expect(imageSrc(next)).toBe("/second/pic.png")
  })

  it("keeps large.md selection and local edits cheaper than a full-document rebuild", () => {
    const doc = fixture("large.md")
    const started = performance.now()
    const state = liveState(doc)
    const initMs = performance.now() - started

    const selectAt = Math.min(doc.indexOf("Block 80"), doc.length - 1)
    const selectStarted = performance.now()
    const selected = state.update({ selection: { anchor: Math.max(0, selectAt) } }).state
    const selectMs = performance.now() - selectStarted
    expect(changedSpecCount(state, selected)).toBeLessThan(specKeys(state).length / 10)

    const editAt = selected.doc.lineAt(selected.selection.main.head).to
    const editStarted = performance.now()
    const editTr = selected.update({ changes: { from: editAt, insert: " edited" } })
    const edited = editTr.state
    const editMs = performance.now() - editStarted
    expect(changedSpecCount(selected, edited, editTr.changes)).toBeLessThan(specKeys(selected).length / 10)

    // Lenient wall-clock gate: selection/edit must not approach a full rebuild.
    expect(selectMs).toBeLessThan(Math.max(initMs, 250))
    expect(editMs).toBeLessThan(Math.max(initMs, 250))
  })

  it("rebuilds newly available syntax after the tree advances", () => {
    const doc = makeDocument(4000)
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: editorExtensions(),
      }),
      parent,
    })
    const before = view.state.field(livePreviewField).treeLength
    forceParsing(view, doc.length, 5000)
    const after = view.state.field(livePreviewField).treeLength
    expect(after).toBeGreaterThanOrEqual(before)
    expect(syntaxTree(view.state).length).toBe(doc.length)
    expect(view.state.field(livePreviewField).treeLength).toBe(doc.length)
    view.destroy()
    parent.remove()
  })

  it("keeps block decorations on a StateField and ordered renumbering on a ViewPlugin", () => {
    expect(livePreviewExt()).toEqual([livePreviewField, orderedRenumber])
  })
})
