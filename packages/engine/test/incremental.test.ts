import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { EditorState, StateEffect } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { forceParsing, syntaxTree } from "@codemirror/language"
import { editorExtensions } from "../src/index"
import { buildLiveDecorations, livePreviewField } from "../src/decorations/build"
import { ImageWidget } from "../src/decorations/widgets/image"
import { livePreviewExt } from "../src/modes/livePreview"

function specKeys(state: EditorState) {
  return state.field(livePreviewField).specs
    .map(spec => `${spec.tag}:${spec.from}:${spec.to}`)
    .sort()
}

function changedSpecCount(before: EditorState, after: EditorState) {
  const prev = new Set(specKeys(before))
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

describe("incremental live decorations", () => {
  it("rebuilds only syntax-safe regions for a selection move", () => {
    const doc = makeDocument()
    const state = EditorState.create({ doc, extensions: editorExtensions() })
    const next = state.update({ selection: { anchor: doc.indexOf("line 1501") } }).state
    expect(specKeys(next)).toEqual(specKeys(EditorState.create({
      doc: next.doc,
      selection: next.selection,
      extensions: editorExtensions(),
    })))
    expect(changedSpecCount(state, next)).toBeLessThan(specKeys(state).length / 10)
  })

  it("keeps a local edit local in a widget-dense document", () => {
    const doc = makeDocument()
    const state = EditorState.create({ doc, extensions: editorExtensions() })
    const editAt = doc.indexOf("line 1501") + "line 1501".length
    const next = state.update({ changes: { from: editAt, insert: " edited" } }).state
    expect(specKeys(next)).toEqual(specKeys(EditorState.create({
      doc: next.doc,
      selection: next.selection,
      extensions: editorExtensions(),
    })))
    expect(changedSpecCount(state, next)).toBeLessThan(specKeys(state).length / 10)
  })

  it("maps unaffected decorations and rebuilds the edited syntax block", () => {
    const doc = "start\n\n| a |\n|---|\n| 1 |\n\nend with **bold**"
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: editorExtensions(),
    })
    const next = state.update({ changes: { from: 0, insert: "prefix\n" } }).state
    const live = next.field(livePreviewField)
    const ranges: Array<[number, number]> = []
    live.deco.between(0, next.doc.length, (from, to) => { ranges.push([from, to]) })

    expect(ranges.some(([from]) => from === doc.indexOf("| a |") + "prefix\n".length)).toBe(true)
    expect(specKeys(next)).toEqual(specKeys(EditorState.create({
      doc: next.doc,
      selection: next.selection,
      extensions: editorExtensions(),
    })))
  })

  it("does not duplicate enclosing block decorations during a local rebuild", () => {
    const doc = "> first\n> second\n> third\n\noutside"
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: editorExtensions(),
    })
    const next = state.update({ selection: { anchor: doc.indexOf("second") } }).state
    const specs = next.field(livePreviewField).specs
    const keys = specs.map(spec => `${spec.tag}:${spec.from}:${spec.to}`)

    expect(new Set(keys).size).toBe(keys.length)
  })

  it("matches a full rebuild when a fence edit changes following block parsing", () => {
    const doc = "```js\ncode\n```\n\n$$x$$\n\nafter"
    const state = EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: editorExtensions(),
    })
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
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: editorExtensions({ resolveImageSrc: src => `/first/${src}` }),
    })
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
    const state = EditorState.create({ doc, extensions: editorExtensions() })
    const initMs = performance.now() - started

    const selectAt = Math.min(doc.indexOf("Block 80"), doc.length - 1)
    const selectStarted = performance.now()
    const selected = state.update({ selection: { anchor: Math.max(0, selectAt) } }).state
    const selectMs = performance.now() - selectStarted
    expect(changedSpecCount(state, selected)).toBeLessThan(specKeys(state).length / 10)

    const editAt = selected.doc.lineAt(selected.selection.main.head).to
    const editStarted = performance.now()
    const edited = selected.update({ changes: { from: editAt, insert: " edited" } }).state
    const editMs = performance.now() - editStarted
    expect(changedSpecCount(selected, edited)).toBeLessThan(specKeys(selected).length / 10)

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

  it("provides block decorations from a StateField rather than a ViewPlugin", () => {
    expect(livePreviewExt()).toEqual([livePreviewField])
  })
})
