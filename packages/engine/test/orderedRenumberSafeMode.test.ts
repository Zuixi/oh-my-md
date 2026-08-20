import { afterEach, describe, expect, it } from "vitest"
import { EditorView } from "@codemirror/view"
import { ChangeSet, EditorState } from "@codemirror/state"
import { forceParsing } from "@codemirror/language"
import { makeState } from "./helpers"
import {
  editorExtensions,
  getPendingOrderedListNormalization,
  setSafeModeRendering,
} from "../src/index"
import {
  RENUMBER_SCAN_MARGIN_CHARS,
  dedupeMarkChanges,
  orderedRenumberChanges,
} from "../src/lists/ordered"

// Task 4：orderedRenumber 的 range 参数与安全模式窗口化扫描。
// 视口用 Object.defineProperty 桩掉（happy-dom 无布局，同 safeModeWindow.test.ts），
// to 按半开 [from, to) 口径传入（与 CM 一致）。

// 单元（range 参数）：两个乱序有序列表 + 中段纯文本。listA 的乱序标记在
// [5,7)→"2."、[10,12)→"3."；listB 首项 "9." 保序，第二项 [5,7)→"10."。
const LIST_A = "1. a\n3. b\n7. c"
const MID = "filler text\n\nmore filler text"
const LIST_B = "9. x\n2. y"
const B_START = LIST_A.length + 2 + MID.length + 2

describe("orderedRenumberChanges range limiting", () => {
  const doc = `${LIST_A}\n\n${MID}\n\n${LIST_B}`

  it("defaults to the whole tree when no range is given", () => {
    expect(orderedRenumberChanges(makeState(doc))).toEqual([
      { from: 5, to: 7, insert: "2." },
      { from: 10, to: 12, insert: "3." },
      { from: B_START + 5, to: B_START + 7, insert: "10." },
    ])
  })

  it("visits only lists intersecting the range", () => {
    expect(orderedRenumberChanges(makeState(doc), { from: 0, to: LIST_A.length - 1 })).toEqual([
      { from: 5, to: 7, insert: "2." },
      { from: 10, to: 12, insert: "3." },
    ])
    expect(orderedRenumberChanges(makeState(doc), { from: B_START, to: doc.length - 1 })).toEqual([
      { from: B_START + 5, to: B_START + 7, insert: "10." },
    ])
  })

  it("renumbers a straddling list completely, not partially", () => {
    // 区间 [6, 8] 严格落在 listA 内部：iterate 对相交节点 enter 且 enter 拿到完整
    // OrderedList 节点 —— 返回该列表的全部乱序标记（含区间外的 "7."）。
    expect(orderedRenumberChanges(makeState(doc), { from: 6, to: 8 })).toEqual([
      { from: 5, to: 7, insert: "2." },
      { from: 10, to: 12, insert: "3." },
    ])
  })

  it("returns nothing for a range without lists", () => {
    expect(orderedRenumberChanges(makeState(doc), {
      from: LIST_A.length + 2,
      to: B_START - 1,
    })).toEqual([])
  })
})

// 插件级（安全模式窗口化扫描）：真实定时器 + 桩视口。填充行统一 200 字符
// （"x"×199 + "0"，行首无数字，不构成列表）：filler(n) 长 201n-1，列表起点
// filler(n).length + 2。视口桩 [0, 30) → 入场/树增长扫描窗口 [0, 100_030]。
const STALE = "1. a\n3. b\n7. c"

function fillerDoc(lines: number) {
  return Array.from({ length: lines }, () => "x".repeat(199) + "0").join("\n")
}

// 列表起点在视口 ± RENUMBER_SCAN_MARGIN_CHARS 之外（filler(760) 长 152_759，
// 列表起点 152_761 > 100_030）。
function farListDoc() {
  const filler = fillerDoc(760)
  return { doc: `${filler}\n\n${STALE}`, listStart: filler.length + 2 }
}

function mount(doc: string) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const errors: unknown[] = []
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [editorExtensions(), EditorView.exceptionSink.of(e => { errors.push(e) })],
    }),
    parent,
  })
  Object.defineProperty(view, "visibleRanges", {
    configurable: true,
    value: Object.freeze([{ from: 0, to: 30 }]),
  })
  return { view, errors, cleanup: () => { view.destroy(); parent.remove() } }
}

const tick = () => new Promise(r => setTimeout(r, 100))

describe("orderedRenumber safe-mode windowed scans", () => {
  afterEach(() => {
    setSafeModeRendering(false)
  })

  it("exports the scan margin constant", () => {
    expect(RENUMBER_SCAN_MARGIN_CHARS).toBe(100_000)
  })

  it("skips a stale list outside visible ± margin on entry and tree growth", async () => {
    setSafeModeRendering(true)
    const { doc } = farListDoc()
    const { view, errors, cleanup } = mount(doc)
    forceParsing(view, doc.length, 10000)
    await tick()
    expect(errors.map(String)).toEqual([])
    // 入场扫描与树增长触发的扫描都以可见窗口为界：远端乱序列表原样保留，也无 notice
    expect(view.state.doc.toString()).toBe(doc)
    expect(getPendingOrderedListNormalization(view.state)).toBeNull()
    cleanup()
  })

  it("renumbers a stale list inside visible ± margin and posts one notice", async () => {
    setSafeModeRendering(true)
    const filler = fillerDoc(250)                    // 列表起点 50_251 ⊂ [0, 100_030]
    const doc = `${filler}\n\n${STALE}`
    const { view, errors, cleanup } = mount(doc)
    forceParsing(view, doc.length, 10000)
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe(`${filler}\n\n1. a\n2. b\n3. c`)
    expect(getPendingOrderedListNormalization(view.state)?.markerCount).toBe(2)
    cleanup()
  })

  it("renumbers a far stale list after a doc change within the margin of it", async () => {
    setSafeModeRendering(true)
    const { doc, listStart } = farListDoc()
    const { view, errors, cleanup } = mount(doc)
    forceParsing(view, doc.length, 10000)
    await tick()
    expect(view.state.doc.toString()).toBe(doc)
    // 远端列表前 5 万字符处编辑，随后同步补全解析（文档编辑会把语法树截回变更处，
    // 解析器只保证推进到视口附近 —— forceParsing 消除该不确定性）。可见窗口
    // [0, 100030] 不含列表（152_761），变更区间 [2761, 202761] 含 —— 重编号只能
    // 来自变更区间路径。
    view.dispatch({ changes: { from: listStart - 50_000, insert: "!" } })
    forceParsing(view, view.state.doc.length, 10000)
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString().endsWith("1. a\n2. b\n3. c")).toBe(true)
    // 用户后续触发（user-followup）不建通知
    expect(getPendingOrderedListNormalization(view.state)).toBeNull()
    cleanup()
  })

  it("does not renumber a far stale list after a doc change far from it", async () => {
    setSafeModeRendering(true)
    const { doc } = farListDoc()
    const { view, errors, cleanup } = mount(doc)
    forceParsing(view, doc.length, 10000)
    await tick()
    // 视口内编辑（与上一用例唯一的变量是编辑位置）：变更区间扫描 [0, 101000]
    // 与可见窗口 [0, 100030] 都到不了 152_761 —— 即便树完整也不重编。
    view.dispatch({ changes: { from: 1000, insert: "!" } })
    forceParsing(view, view.state.doc.length, 10000)
    await tick()
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString()).toBe(`${doc.slice(0, 1000)}!${doc.slice(1000)}`)
    expect(getPendingOrderedListNormalization(view.state)).toBeNull()
    cleanup()
  })

  it("scans the whole tree on entry and tree growth once safe mode is off", async () => {
    const { doc } = farListDoc()
    const { view, errors, cleanup } = mount(doc)
    forceParsing(view, doc.length, 10000)
    await tick()
    // 与「entry/tree growth 窗口化」用例同文档同流程，唯一变量是开关关闭：
    // 树增长触发的全树扫描立即修复远端列表 —— 开关行为差异的 A/B 对照。
    expect(errors.map(String)).toEqual([])
    expect(view.state.doc.toString().endsWith("1. a\n2. b\n3. c")).toBe(true)
    expect(getPendingOrderedListNormalization(view.state)?.markerCount).toBe(2)
    cleanup()
  })

  it("deduplicates a list straddling two disjoint scan ranges", () => {
    // 一个 OrderedList 横跨两个归并后仍不相邻的扫描区间（如可见窗口与远端变更
    // 区间的间隙足够窄、列表足够长）时会被 enter 两次，两次遍历产出完全相同的
    // 变更 —— 未去重时 ChangeSet.of 会把同一改写叠加应用两遍（"2.2." 式破坏）。
    // 全栈复现需要 >100k 字符的单一列表（解析数秒且 happy-dom 树交付不稳），
    // 语义与列表大小无关，这里在单元层钉住。
    const doc = "1. a\n3. b\n7. c"
    const state = makeState(doc)
    const left = orderedRenumberChanges(state, { from: 0, to: 2 })
    const right = orderedRenumberChanges(state, { from: 8, to: 13 })
    expect(left).toEqual([
      { from: 5, to: 7, insert: "2." },
      { from: 10, to: 12, insert: "3." },
    ])
    // 两个区间都拿到该列表的完整变更集 —— 重复来源
    expect(right).toEqual(left)
    expect(dedupeMarkChanges([...left, ...right])).toEqual(left)
    // 去重后的变更经 ChangeSet.of 落盘得到正确文档
    const applied = state.update({ changes: ChangeSet.of(left, doc.length) }).state.doc.toString()
    expect(applied).toBe("1. a\n2. b\n3. c")
  })
})
