import { describe, expect, it, vi } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { forceParsing } from "@codemirror/language"
import { editorExtensions } from "../src/index"
import {
  collectDecorationSpecs,
  drainPendingLiveBuild,
  livePreviewField,
} from "../src/decorations/build"
import { LIVE_BUILD_SLICE_MS } from "../src/decorations/buildDriver"
import type { DecoSpec } from "../src/decorations/types"
import { isTableShownAsSource, revealTableSource } from "../src/tables/sourceReveal"
import { tableAt } from "../src/tables/navigate"
import { getTableEditSession } from "../src/tables/directEdit"
import { makeState } from "./helpers"

// Hot-path regressions (Wave 2A): per-keystroke allocations and O(N) scans across
// the Live Preview decoration pipeline. Assertions target observable contracts —
// shared Decoration instances, bounded source slices, covered DOM classes, and
// table edit sessions — rather than private implementation details.

const SPECS_OF = (state: EditorState): DecoSpec[] =>
  collectDecorationSpecs(state, 0, state.doc.length)

const tagged = (specs: DecoSpec[], tag: string): DecoSpec[] =>
  specs.filter(spec => spec.tag === tag)

const classOf = (spec: DecoSpec): string | undefined =>
  (spec.deco.spec as { class?: string }).class

// `sliceString` probe: `Text` implements slicing per concrete subclass, so spy on
// the state's own `doc` instance (decoration collection reads from that `doc`).
interface SliceSpy { mock: { calls: [number, (number | undefined)?, (string | undefined)?][] } }

function slicesWithin(spy: SliceSpy, from: number, to: number): number {
  return spy.mock.calls.filter(([rawStart, end]) => {
    const start = rawStart ?? 0
    return start >= from && end !== undefined && end <= to && end > start
  }).length
}

function longestSlice(spy: SliceSpy): number {
  return spy.mock.calls.reduce((longest, [rawStart, end]) => {
    const start = rawStart ?? 0
    return Math.max(longest, (end ?? start) - start)
  }, 0)
}

describe("hoisted static decorations", () => {
  it("shares one decoration per mark class and one for every plain replace", () => {
    const doc = "**a** and **b**, *c*, ~~d~~, ==e==, `f`\n\nbody"
    const specs = SPECS_OF(makeState(doc, [], { anchor: doc.length }))

    const strong = tagged(specs, "mark:omd-strong")
    expect(strong).toHaveLength(2)
    expect(strong[0].deco).toBe(strong[1].deco)
    expect(tagged(specs, "mark:omd-em")[0].deco).not.toBe(strong[0].deco)
    expect(tagged(specs, "mark:omd-del")[0].deco).not.toBe(strong[0].deco)
    expect(tagged(specs, "mark:omd-highlight")[0].deco).not.toBe(strong[0].deco)

    // `**`, `*`, `~~`, `==`, `` ` `` all fold through the generic replace instance.
    const folded = specs.filter(spec => spec.tag.startsWith("replace:") && spec.to - spec.from <= 2)
    expect(folded.length).toBeGreaterThanOrEqual(4)
    expect(new Set(folded.map(spec => spec.deco)).size).toBe(1)
  })

  it("shares one line decoration per class across every line of a block", () => {
    const doc = "intro\n\n```\na\nb\n```\n"
    const specs = SPECS_OF(makeState(doc))
    const lines = tagged(specs, "line:omd-codeblock")
    expect(lines.length).toBeGreaterThan(2)
    expect(new Set(lines.map(spec => spec.deco)).size).toBe(1)
  })

  it("keeps the heading badge on the active line decoration only", () => {
    const doc = "## a\n\n## b\n\nbody"
    const plain = tagged(SPECS_OF(makeState(doc, [], { anchor: doc.length })), "line:omd-h2")
    expect(plain).toHaveLength(2)
    expect(plain[0].deco).toBe(plain[1].deco)
    expect(classOf(plain[0])).toBe("omd-h2")

    const active = tagged(
      SPECS_OF(makeState(doc, [], { anchor: 3 })), "line:omd-h2 omd-h-active")[0]
    expect(classOf(active)).toBe("omd-h2 omd-h-active")
    expect((active.deco.spec as { attributes?: Record<string, string> }).attributes)
      .toEqual({ "data-omd-h": "2" })
    expect(active.deco).not.toBe(plain[0].deco)
  })
})

describe("fenced code source slicing", () => {
  const BODY = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i}`).join("\n")
  const DOC = `\`\`\`js\n${BODY}\n\`\`\`\n\ntail`
  const BODY_FROM = DOC.indexOf("const v0")
  const BODY_TO = DOC.indexOf("\n```\n")

  it("does not slice the code body while the caret edits inside the fence", () => {
    const state = makeState(DOC, [], { anchor: BODY_FROM + 6 })
    const spy = vi.spyOn(state.doc, "sliceString")
    try {
      const specs = SPECS_OF(state)
      expect(specs.some(spec => spec.tag === "widget:block:code")).toBe(false)
      expect(specs.some(spec => spec.tag === "widget:block:code-chrome")).toBe(true)
      expect(slicesWithin(spy, BODY_FROM, BODY_TO)).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it("slices the code body when the widget actually renders", () => {
    const state = makeState(DOC, [], { anchor: DOC.length })
    const spy = vi.spyOn(state.doc, "sliceString")
    try {
      const specs = SPECS_OF(state)
      expect(specs.some(spec => spec.tag === "widget:block:code")).toBe(true)
      expect(slicesWithin(spy, BODY_FROM, BODY_TO)).toBeGreaterThan(0)
    } finally {
      spy.mockRestore()
    }
  })
})

describe("HTMLBlock complex-table gate", () => {
  const HTML = `<div>\n${"x".repeat(4_000)}\n</div>`
  const DOC = `intro\n\n${HTML}\n\nbody`

  it("never slices a whole non-table HTML block", () => {
    const state = makeState(DOC, [], { anchor: DOC.length })
    const spy = vi.spyOn(state.doc, "sliceString")
    try {
      const specs = SPECS_OF(state)
      expect(specs.some(spec => spec.tag === "widget:block:complex-table")).toBe(false)
      expect(longestSlice(spy)).toBeLessThan(HTML.length)
    } finally {
      spy.mockRestore()
    }
  })

  it("does not emit table source rows for a non-table HTML block in the selection", () => {
    const htmlFrom = DOC.indexOf("<div>")
    const specs = SPECS_OF(makeState(DOC, [], { anchor: htmlFrom + 6 }))
    expect(specs.some(spec => spec.tag === "line:omd-table-src")).toBe(false)
  })

  it("emits one shared source row per line for a selected complex table", () => {
    const tableDoc = ["before", "", "<table>", "<tr><th>A</th></tr>", "</table>", "", "after"].join("\n")
    const from = tableDoc.indexOf("<table>")
    const to = tableDoc.indexOf("</table>") + "</table>".length
    const specs = SPECS_OF(makeState(tableDoc, [], { anchor: from + 8 }))

    expect(specs.some(spec => spec.tag === "widget:block:complex-table")).toBe(false)
    const rows = tagged(specs, "line:omd-table-src")
    expect(rows).toHaveLength(tableDoc.slice(from, to).split("\n").length)
    expect(new Set(rows.map(spec => spec.deco)).size).toBe(1)
  })
})

describe("block selection overlay", () => {
  const DOC = "before\n\n---\n\nafter"

  function mount() {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc: DOC,
        selection: { anchor: DOC.length },
        extensions: editorExtensions(),
      }),
      parent,
    })
    forceParsing(view, DOC.length, 10000)
    drainPendingLiveBuild(view)
    return { view, parent }
  }

  it("applies and clears the covered overlay across selection changes", async () => {
    const { view, parent } = mount()
    try {
      const from = DOC.indexOf("---")
      expect(view.state.field(livePreviewField).specs.some(spec => spec.tag === "widget:block:hr"))
        .toBe(true)

      view.dispatch({ selection: { anchor: from, head: from + 3 } })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(view.dom.querySelector(".omd-hr-block.omd-block-covered")).toBeTruthy()

      // Collapsing the caret away must clear the class even though the fast path
      // (collapsed caret + uncovered view) would otherwise skip the spec scan.
      view.dispatch({ selection: { anchor: 0 } })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(view.dom.querySelector(".omd-hr-block")).toBeTruthy()
      expect(view.dom.querySelector(".omd-hr-block.omd-block-covered")).toBeNull()

      // A second collapsed move has nothing to toggle and must not resurrect it.
      view.dispatch({ selection: { anchor: 1 } })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(view.dom.querySelector(".omd-block-covered")).toBeNull()
    } finally {
      view.destroy()
      parent.remove()
    }
  })
})

describe("table caret probe", () => {
  const DOC = "before\n\n| h |\n|---|\n| x y |\n\nafter"
  const TABLE_FROM = DOC.indexOf("| h |")

  function mount() {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc: DOC,
        selection: { anchor: 0 },
        extensions: editorExtensions(),
      }),
      parent,
    })
    forceParsing(view, DOC.length, 10000)
    drainPendingLiveBuild(view)
    return { view, parent }
  }

  const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))

  async function settledSession(view: EditorView) {
    for (let i = 0; i < 8 && getTableEditSession(view.state) === null; i++) await frame()
    return getTableEditSession(view.state)
  }

  it("still opens a session for a caret landing on the table's end boundary", async () => {
    const { view, parent } = mount()
    try {
      const table = tableAt(view.state, TABLE_FROM)
      expect(table).toBeTruthy()
      view.dispatch({ selection: { anchor: table!.to } })
      expect(await settledSession(view)).toBeTruthy()
    } finally {
      view.destroy()
      parent.remove()
    }
  })

  it("does not open a session for a caret inside a source-revealed table", async () => {
    const { view, parent } = mount()
    try {
      const table = tableAt(view.state, TABLE_FROM)
      expect(table).toBeTruthy()
      view.dispatch({
        selection: { anchor: TABLE_FROM + 2 },
        effects: revealTableSource.of(null),
      })
      expect(isTableShownAsSource(view.state, table!.from, table!.to)).toBe(true)
      for (let i = 0; i < 4; i++) await frame()
      expect(getTableEditSession(view.state)).toBeNull()
    } finally {
      view.destroy()
      parent.remove()
    }
  })
})

describe("live build slice budget", () => {
  it("fits one idle slice inside a 120 Hz frame", () => {
    expect(LIVE_BUILD_SLICE_MS).toBe(8)
    expect(LIVE_BUILD_SLICE_MS).toBeLessThan(1000 / 120)
  })
})
