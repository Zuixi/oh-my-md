import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { forceParsing, syntaxTree } from "@codemirror/language"
import { editorExtensions, setLivePreview } from "../src/index"
import {
  LIVE_BUILD_CHUNK_CHARS,
  LIVE_SEED_RADIUS_CHARS,
  LIVE_SEED_RADIUS_LINES,
  buildLiveDecorations,
  drainPendingLiveBuild,
  liveBuildChunk,
  livePreviewField,
  seedLiveDecorations,
} from "../src/decorations/build"
import { makeState } from "./helpers"

function fixture(name: string) {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8")
}

// 每行都带 **bold**，任何区间构建都应产出 mark 装饰。
function boldDoc(lines: number) {
  return Array.from({ length: lines }, (_, i) => `line ${i} with **bold** text`).join("\n")
}

// 表格 + 加粗混合文档：块 widget 与行内装饰交错，对排空/全量对拍更严格。
function mixedDoc(lines = 1000) {
  return Array.from({ length: lines }, (_, i) =>
    i % 100 === 0 ? `| h${i} |\n|---|\n| v${i} |` : `line ${i} with **bold** text`
  ).join("\n\n")
}

function covers(pending: { from: number; to: number }[], pos: number) {
  return pending.some(range => range.from <= pos && pos <= range.to)
}

function pendingChars(pending: { from: number; to: number }[]) {
  return pending.reduce((sum, range) => sum + range.to - range.from + 1, 0)
}

const specKeys = (state: EditorState) =>
  state.field(livePreviewField).specs
    .map(spec => `${spec.tag}:${spec.from}:${spec.to}`)
    .sort()

// 挂真实视图并强制完整解析，但“不”排空 pending —— 种子/pending 语义测试的起点。
function seededView(doc: string, anchor?: number) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc,
      ...(anchor === undefined ? {} : { selection: { anchor } }),
      extensions: editorExtensions(),
    }),
    parent,
  })
  forceParsing(view, doc.length, 10000)
  return {
    view,
    cleanup: () => {
      view.destroy()
      parent.remove()
    },
  }
}

describe("progressive live decoration build", () => {
  it("exports the seed radius constants from build.ts", () => {
    expect(LIVE_SEED_RADIUS_LINES).toBe(300)
    expect(LIVE_SEED_RADIUS_CHARS).toBe(120_000)
  })

  it("seedLiveDecorations leaves exactly the complement of the seed range pending", () => {
    const doc = boldDoc(800)
    const state = EditorState.create({ doc, extensions: editorExtensions() })
    const seedTo = state.doc.line(1 + LIVE_SEED_RADIUS_LINES).to
    expect(seedLiveDecorations(state).pending).toEqual([{ from: seedTo + 1, to: doc.length }])

    const mid = state.doc.line(400).from + 2
    const middle = EditorState.create({
      doc,
      selection: { anchor: mid },
      extensions: editorExtensions(),
    })
    const from = middle.doc.line(400 - LIVE_SEED_RADIUS_LINES).from
    const to = middle.doc.line(400 + LIVE_SEED_RADIUS_LINES).to
    expect(seedLiveDecorations(middle).pending).toEqual([
      { from: 0, to: from - 1 },
      { from: to + 1, to: doc.length },
    ])
  })

  it("caps the seed span by the character radius on long-line documents", () => {
    const line = "x".repeat(700)
    const doc = Array.from({ length: 400 }, () => line).join("\n")
    const head = doc.indexOf(line, doc.length / 2) + 10   // ≈ 文档中部
    const state = EditorState.create({ doc, selection: { anchor: head }, extensions: editorExtensions() })
    const seeded = seedLiveDecorations(state)
    // 行数半径覆盖全文（400 行 < 2×300），只有字符半径生效：
    // pending 总量 = 全文 − 双向 120k 截断
    expect(seeded.pending).toHaveLength(2)
    expect(pendingChars(seeded.pending)).toBe(doc.length - 2 * LIVE_SEED_RADIUS_CHARS)
  })

  it("builds decorations only around the cursor and keeps the far region pending", () => {
    const doc = boldDoc(1000)
    const { view, cleanup } = seededView(doc)
    const field = view.state.field(livePreviewField)
    const seedTo = view.state.doc.line(1 + LIVE_SEED_RADIUS_LINES).to

    expect(field.specs.length).toBeGreaterThan(0)
    // 种子内（按 create 时的树）有 bold 装饰；种子外一个都没有
    expect(field.specs.some(spec => spec.tag === "mark:omd-strong")).toBe(true)
    expect(field.specs.every(spec => spec.from <= seedTo)).toBe(true)
    // 远端无装饰，且被 pending 覆盖
    const far = view.state.doc.line(700).from
    expect(field.specs.some(spec => spec.from >= far)).toBe(false)
    expect(covers(field.pending, far)).toBe(true)
    expect(field.pending[field.pending.length - 1].to).toBe(doc.length)
    cleanup()
  })

  it("consumes a liveBuildChunk: decorations appear, pending shrinks, no duplicates", () => {
    const doc = boldDoc(1000)
    const { view, cleanup } = seededView(doc)
    const before = view.state.field(livePreviewField)
    const target = view.state.doc.line(700)
    const end = view.state.doc.line(720).to
    expect(before.specs.some(spec => spec.from >= target.from)).toBe(false)

    view.dispatch({ effects: liveBuildChunk.of({ from: target.from, to: end }) })
    const after = view.state.field(livePreviewField)

    // 区间内出现装饰，pending 精确扣掉该区间
    expect(after.specs.some(spec => spec.from >= target.from)).toBe(true)
    expect(pendingChars(after.pending)).toBe(pendingChars(before.pending) - (end - target.from + 1))
    // 与既有装饰合并不产生重复键
    const keys = after.specs.map(spec => `${spec.tag}:${spec.from}:${spec.to}`)
    expect(new Set(keys).size).toBe(keys.length)
    cleanup()
  })

  it("composes a liveBuildChunk with a doc change in the same transaction", () => {
    const doc = boldDoc(1000)
    const { view, cleanup } = seededView(doc)
    const line700 = view.state.doc.line(700)

    // chunk 坐标是新文档坐标：插入 10 字符后区间从 line700.from+10 开始
    view.dispatch({
      changes: { from: 0, insert: "0123456789" },
      effects: liveBuildChunk.of({ from: line700.from + 10, to: line700.from + 40 }),
    })
    const field = view.state.field(livePreviewField)
    expect(field.specs.some(spec => spec.from >= line700.from + 10)).toBe(true)
    // pending 先映射（+10）再扣除：chunk 区间移除，chunk 左侧仍在 pending
    expect(covers(field.pending, line700.from + 10)).toBe(false)
    expect(covers(field.pending, line700.from + 9)).toBe(true)
    cleanup()
  })

  it("maps pending ranges through insertions and deletions", () => {
    const doc = boldDoc(1000)
    const { view, cleanup } = seededView(doc)
    const before = view.state.field(livePreviewField).pending

    // 文首插入 10 字符：pending 整体右移
    view.dispatch({ changes: { from: 0, insert: "0123456789" } })
    const shifted = view.state.field(livePreviewField).pending
    expect(shifted).toEqual(before.map(range => ({ from: range.from + 10, to: range.to + 10 })))

    // pending 内部删除 10 字符：区间缩短，不分裂
    const last = shifted[shifted.length - 1]
    view.dispatch({ changes: { from: last.from + 5, to: last.from + 15 } })
    const shrunk = view.state.field(livePreviewField).pending
    expect(shrunk[shrunk.length - 1]).toEqual({ from: last.from, to: last.to - 10 })

    // 整段删除（多删 pending 前一字符）：pending 塌缩为删除点上的单点区间
    const tail = shrunk[shrunk.length - 1]
    view.dispatch({ changes: { from: tail.from - 1, to: tail.to } })
    const collapsed = view.state.field(livePreviewField).pending
    expect(collapsed.every(range => range.from <= range.to)).toBe(true)
    expect(collapsed[collapsed.length - 1]).toEqual({ from: tail.from - 1, to: tail.from - 1 })
    cleanup()
  })

  it("keeps pending sorted and disjoint when a deletion collapses two ranges together", () => {
    // docChanged 映射的回归守卫：删除「head 尾字符 + 种子区」会把左右两段 pending
    // 压到同一点（重叠），必须归一化合并回有序不相交 —— 分片驱动据此假设挑区间。
    const doc = boldDoc(1000)
    const mid = Math.floor(doc.length / 2)
    const { view, cleanup } = seededView(doc, mid)     // 种子居中 → 头尾两段 pending
    const [head, tail] = view.state.field(livePreviewField).pending
    expect(head.to).toBeLessThan(mid)
    expect(tail.from).toBeGreaterThan(mid)

    view.dispatch({ changes: { from: head.to, to: tail.from - 1 } })
    const pending = view.state.field(livePreviewField).pending
    expect(pending).toHaveLength(1)
    expect(pending[0].from).toBe(head.from)
    expect(pending[0].to).toBeGreaterThan(head.to)
    for (let i = 1; i < pending.length; i++) {
      expect(pending[i - 1].from).toBeLessThanOrEqual(pending[i - 1].to)
      expect(pending[i - 1].to).toBeLessThan(pending[i].from)
    }
    cleanup()
  })

  it("keeps tree advances (when they occur) inside pending instead of building synchronously", () => {
    // 树增长分支的守护：forceParsing 推进树（若 create 时未解析完）后，
    // pending 非空 → 增长区间并入 pending，绝不同步产出远端装饰。
    // 注：当前依赖版本下 EditorState.create 会同步解析完整棵树，增长分支
    // 在 vitest 中通常无增长可触发；断言仍锁定“远端不因树推进而同步构建”。
    const doc = boldDoc(1000)
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: editorExtensions() }),
      parent,
    })
    forceParsing(view, doc.length, 10000)
    const field = view.state.field(livePreviewField)
    expect(syntaxTree(view.state).length).toBe(doc.length)
    expect(field.treeLength).toBe(doc.length)
    const far = view.state.doc.line(700).from
    expect(field.specs.some(spec => spec.from >= far)).toBe(false)
    expect(covers(field.pending, far)).toBe(true)
    view.destroy()
    parent.remove()
  })

  it("reseeds (not full-builds) when the live compartment is re-enabled", () => {
    const doc = boldDoc(800)
    const state = makeState(doc, [editorExtensions()])
    expect(state.field(livePreviewField).pending).toEqual([])   // makeState 已排空

    const source = state.update(setLivePreview(false)).state
    expect(source.field(livePreviewField, false)).toBeUndefined()
    const live = source.update(setLivePreview(true)).state
    const seedTo = live.doc.line(1 + LIVE_SEED_RADIUS_LINES).to
    expect(live.field(livePreviewField).pending).toEqual([{ from: seedTo + 1, to: live.doc.length }])
  })

  it("makeState drains pending so a drained state matches a full build (mixed doc)", () => {
    const doc = mixedDoc(1000)
    const state = makeState(doc, [editorExtensions()])
    expect(state.field(livePreviewField).pending).toEqual([])
    expect(specKeys(state)).toEqual(
      buildLiveDecorations(state).specs
        .map(spec => `${spec.tag}:${spec.from}:${spec.to}`)
        .sort(),
    )
  })

  it("drainPendingLiveBuild reaches full-build parity on large.md", () => {
    const doc = fixture("large.md")
    const state = makeState(doc, [editorExtensions()])
    expect(state.field(livePreviewField).pending).toEqual([])
    expect(specKeys(state)).toEqual(
      buildLiveDecorations(state).specs
        .map(spec => `${spec.tag}:${spec.from}:${spec.to}`)
        .sort(),
    )
  })

  it("slices drain chunks at LIVE_BUILD_CHUNK_CHARS", () => {
    // 只验证切片口径（pending 总量 > 单片上限时按上限切），不依赖完整树：
    // 树未覆盖的 pending 区间构建不出 specs，但 pending 扣除照常进行。
    // 不挂真实视图 —— happy-dom 无布局，万行级文档的 view 挂载是纯 DOM 开销，
    // 与 drainPendingLiveBuild 相同的切片循环用 state.update 即可驱动。
    const doc = boldDoc(12000)   // ≈ 350k 字符，pending > 单片上限，需至少两片
    let state: EditorState = EditorState.create({ doc, extensions: editorExtensions() })
    let chunks = 0
    const sizes: number[] = []
    for (;;) {
      const pending = state.field(livePreviewField).pending
      if (pending.length === 0) break
      const first = pending[0]
      const to = Math.min(first.to, first.from + LIVE_BUILD_CHUNK_CHARS - 1)
      sizes.push(to - first.from + 1)
      state = state.update({ effects: liveBuildChunk.of({ from: first.from, to }) }).state
      chunks++
      if (chunks > doc.length) throw new Error("no progress")
    }
    expect(chunks).toBeGreaterThan(1)
    expect(sizes.slice(0, -1).every(size => size === LIVE_BUILD_CHUNK_CHARS)).toBe(true)
    expect(state.field(livePreviewField).pending).toEqual([])
  }, 20_000)   // EditorState.create 对 350k 文档的同步初始解析本身约 6-7s（与 live 无关）

  it("dispatching a chunk outside pending is a harmless no-op rebuild", () => {
    const doc = boldDoc(1000)
    const { view, cleanup } = seededView(doc)
    const line20 = view.state.doc.line(20)
    const before = view.state.field(livePreviewField)
    // 种子内区域再次构建：结果与之前等价（键集合一致），pending 不变
    view.dispatch({ effects: liveBuildChunk.of({ from: line20.from, to: line20.to }) })
    const after = view.state.field(livePreviewField)
    expect(after.pending).toEqual(before.pending)
    const keys = after.specs.map(spec => `${spec.tag}:${spec.from}:${spec.to}`)
    expect(new Set(keys).size).toBe(keys.length)
    cleanup()
  })
})
